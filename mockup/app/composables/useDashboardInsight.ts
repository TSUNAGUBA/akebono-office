/**
 * セグメント別 / 会社全体ダッシュボードの AI レポート・インサイト（F-41。2026-07-28）。
 *
 * Akebono 業務の各業態（セグメント）について、業務（売上・受注）× メディア（GA 流入・CV）を統合し、
 * - loadSegment/generateSegment: 業態単位のサマリー + AI レポート + AI インサイト
 * - loadCompany/generateCompany: 全業態横断（会社全体）のサマリー + AI レポート + AI インサイト
 * を提供する。週次インサイト（useWeeklyInsight）・メディアインサイト（useMediaInsight）と同思想:
 * 一度生成したら保管し、再生成されるまで保存済みを表示する（導出キャッシュ = 再生成で上書き）。
 *
 * - 集計（SegmentSummary/CompanySummary）は shared/domain/portfolio-insight が SoT・決定的
 * - 集計の材料は既存の useMediaAnalytics.integratedMetricsFor（業務 × メディアの月次統合）を再利用する（原則3）
 * - モックは決定的ヒューリスティックのみ（llm=false）。本実装は Vertex AI → 失敗時ヒューリスティック（原則4）
 */
import type { BusinessSegment } from '~/types/akebono'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import {
  heuristicCompanyInsight, heuristicSegmentInsight,
  type CompanySummary, type DashboardInsight, type DashboardInsightRecord,
  type DashboardMonthPoint, type SegmentSnapshot, type SegmentSummary,
} from '../../../shared/domain/portfolio-insight'

export interface SegmentDashboardView {
  metrics: SegmentSummary
  insight: DashboardInsight
  llm: boolean
  generatedAt: string
  generatedByName: string | null
  periodKey: string
}
// CompanyInsightView は useWeeklyInsight でも使われる名称のため、ダッシュボード用は別名で衝突を避ける（原則5）
export interface CompanyDashboardView {
  metrics: CompanySummary
  insight: DashboardInsight
  llm: boolean
  generatedAt: string
  generatedByName: string | null
  periodKey: string
}

/** トレンド・集計の対象月数（統合分析と揃える） */
const MONTHS = 6

export function useDashboardInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('dashboardInsights')
  const { currentUser } = useCurrentUser()
  const { activeSegments, segmentById } = useCurrentSegment()
  const { settingFor } = useMediaSettings()
  const { integratedMetricsFor, articleInputsFor } = useMediaAnalytics()
  const membersTbl = tbl('members')

  function nameOf(id: string): string | null {
    return (membersTbl.value as { id: string; name: string }[]).find(m => m.id === id)?.name ?? null
  }

  // ---------- 集計（サマリー = 常時ライブ・決定的） ----------

  /**
   * セグメント 1 件のスナップショット + トレンド（業務 × メディア）。
   * GA 未連携の業態はメディア指標（セッション/CV）を 0 にする（連携するまで推測値を出さない = 事実を作らない）。
   */
  function snapshotFor(segmentId: string): { snapshot: SegmentSnapshot; trend: DashboardMonthPoint[]; periodMonth: string } {
    const seg = segmentById(segmentId)
    const connected = settingFor(segmentId)?.gaConnected === true
    const im = integratedMetricsFor(segmentId, MONTHS)
    const snapshot: SegmentSnapshot = {
      segmentId,
      segmentName: seg?.name ?? 'セグメント',
      industryLabel: seg ? INDUSTRY_TYPE_LABELS[seg.industryType] : '',
      mediaConnected: connected,
      salesAmount: im.salesAmount,
      prevSalesAmount: im.prevSalesAmount,
      orders: im.orders,
      aov: im.aov,
      sessions: connected ? im.sessions : 0,
      prevSessions: connected ? im.prevSessions : 0,
      conversions: connected ? im.conversions : 0,
      conversionRate: connected ? im.conversionRate : 0,
      articleCount: articleInputsFor(segmentId).length,
    }
    const trend: DashboardMonthPoint[] = im.trend.map(t => ({
      month: t.month,
      salesAmount: t.salesAmount,
      orders: t.orders,
      sessions: connected ? t.sessions : 0,
      conversions: connected ? t.conversions : 0,
    }))
    return { snapshot, trend, periodMonth: im.periodMonth }
  }

  /** 業態単位のダッシュボード集計 */
  function buildSegmentSummary(segmentId: string): SegmentSummary {
    const { snapshot, trend, periodMonth } = snapshotFor(segmentId)
    return { periodMonth, snapshot, trend }
  }

  /** 会社全体（全業態横断）のダッシュボード集計。全業態は同じ月ウィンドウなので月インデックスで合算する */
  function buildCompanySummary(): CompanySummary {
    const segs = activeSegments.value as BusinessSegment[]
    const per = segs.map(s => snapshotFor(s.id))
    const snapshots = per.map(p => p.snapshot)
    const periodMonth = per[0]?.periodMonth ?? todayJst().slice(0, 7)
    const monthKeys = per[0]?.trend.map(t => t.month) ?? []
    const trend: DashboardMonthPoint[] = monthKeys.map((month, i) => {
      let salesAmount = 0; let orders = 0; let sessions = 0; let conversions = 0
      for (const p of per) {
        const pt = p.trend[i]
        if (!pt) continue
        salesAmount += pt.salesAmount
        orders += pt.orders
        sessions += pt.sessions
        conversions += pt.conversions
      }
      return { month, salesAmount, orders, sessions, conversions }
    })
    const sum = (fn: (s: SegmentSnapshot) => number): number => snapshots.reduce((a, s) => a + fn(s), 0)
    return {
      periodMonth,
      segmentCount: snapshots.length,
      connectedCount: snapshots.filter(s => s.mediaConnected).length,
      totalSales: sum(s => s.salesAmount),
      prevTotalSales: sum(s => s.prevSalesAmount),
      totalOrders: sum(s => s.orders),
      totalSessions: sum(s => s.sessions),
      prevTotalSessions: sum(s => s.prevSessions),
      totalConversions: sum(s => s.conversions),
      snapshots,
      trend,
    }
  }

  // ---------- 保管（生成 → 保管 → 再生成で上書き = upsert） ----------

  function findRecord(scope: 'segment' | 'company', segmentId: string | null): DashboardInsightRecord | undefined {
    return (records.value as DashboardInsightRecord[])
      .find(r => r.scope === scope && (r.segmentId ?? null) === (segmentId ?? null))
  }

  function upsert(
    scope: 'segment' | 'company', segmentId: string | null,
    periodKey: string, metrics: unknown, insight: unknown,
  ): DashboardInsightRecord {
    const existing = findRecord(scope, segmentId)
    const rec: DashboardInsightRecord = {
      id: existing?.id ?? nextId('dashboardInsights', 'di'),
      scope, segmentId, periodKey, metrics, insight,
      llm: false,
      generatedBy: currentUser.value.id,
      generatedAt: nowJstIso(),
    }
    records.value = [
      ...(records.value as DashboardInsightRecord[])
        .filter(r => !(r.scope === scope && (r.segmentId ?? null) === (segmentId ?? null))),
      rec,
    ]
    commit()
    return rec
  }

  // ---------- 業態単位 ----------

  function loadSegment(segmentId: string): SegmentDashboardView | null {
    const rec = findRecord('segment', segmentId)
    if (!rec) return null
    return {
      metrics: rec.metrics as SegmentSummary,
      insight: rec.insight as DashboardInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  function generateSegment(segmentId: string): SegmentDashboardView {
    const metrics = buildSegmentSummary(segmentId)
    const insight = heuristicSegmentInsight(metrics)
    upsert('segment', segmentId, metrics.periodMonth, metrics, insight)
    return loadSegment(segmentId)!
  }

  // ---------- 会社全体 ----------

  function loadCompany(): CompanyDashboardView | null {
    const rec = findRecord('company', null)
    if (!rec) return null
    return {
      metrics: rec.metrics as CompanySummary,
      insight: rec.insight as DashboardInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  function generateCompany(): CompanyDashboardView {
    const metrics = buildCompanySummary()
    const insight = heuristicCompanyInsight(metrics)
    upsert('company', null, metrics.periodMonth, metrics, insight)
    return loadCompany()!
  }

  return {
    buildSegmentSummary, buildCompanySummary,
    loadSegment, generateSegment, loadCompany, generateCompany,
  }
}
