/**
 * セグメント別 / 会社全体ダッシュボードの AI レポート・インサイト（F-41。2026-07-28）。
 *
 * Akebono 業務の各業態（セグメント）について、業務（売上・受注）× メディア（GA 流入・CV）を統合し、
 * - loadSegment/generateSegment: 業態単位のサマリー + AI レポート + AI インサイト
 * - loadCompany/generateCompany: 全業態横断（会社全体）のサマリー + AI レポート + AI インサイト
 * を提供する。週次インサイト（useWeeklyInsight）・メディアインサイト（useMediaInsight）と同思想:
 * 一度生成したら保管し、再生成されるまで保存済みを表示する（導出キャッシュ = 再生成で上書き）。
 *
 * - サマリー（SegmentSummary/CompanySummary）の常時ライブ集計は shared/domain/portfolio-insight が SoT・決定的。
 *   材料は useMediaAnalytics.integratedMetricsFor（API モードはサーバー組み立ての /v1/media/integrated）を再利用。
 * - 保管（生成 → 保管 → 再生成で上書き）はデュアルモード（Phase D = 0036。localStorage 依存の解消 = 最終フェーズ）:
 *   - モック: dashboardInsights コレクション + 決定的ヒューリスティックのみ（llm=false）
 *   - API: SoT はサーバー（dashboard_insights。GET/POST /v1/akebono/dashboard-insights）。集計材料は
 *     サーバー組み立て（Phase C）・洞察は Vertex AI → 失敗時サーバー側で同一ヒューリスティックへ
 *     フォールバック（原則4。llm フラグで区別）。scope='segment'/'company' で 1 レコード（upsert）。
 *     GA 連携済みで月次が取れない場合は生成しない（AKO-MEDIA-004 = M1 のサーバー側強制）。
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

// ---------- API モードの保管キャッシュ（`${scope}:${segmentId||''}` → 保管済み or null） ----------

interface ApiDashboardRow {
  id: string
  periodKey: string
  metrics: unknown
  insight: unknown
  llm: boolean
  generatedAt: string
  generatedByName: string | null
}

const apiDashboards = ref<Record<string, ApiDashboardRow | null>>({})

function apiKey(scope: 'segment' | 'company', segmentId: string | null): string {
  return `${scope}:${segmentId ?? ''}`
}

function loadApiDashboard(scope: 'segment' | 'company', segmentId: string | null, force = false): Promise<void> {
  return apiLoadOnce(`akebono:dashboard:${apiKey(scope, segmentId)}`, async () => {
    const query: Record<string, string> = scope === 'segment' ? { scope, segmentId: segmentId ?? '' } : { scope }
    const row = await apiFetch<ApiDashboardRow | null>('/v1/akebono/dashboard-insights', { query })
    apiDashboards.value = { ...apiDashboards.value, [apiKey(scope, segmentId)]: row }
  }, force)
}

onApiReset(() => { apiDashboards.value = {} })

export function useDashboardInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('dashboardInsights')
  const { currentUser } = useCurrentUser()
  const { activeSegments, segmentById } = useCurrentSegment()
  // 連携済みチャンネルは id = 連携先 segmentId のため、業態 id をチャンネル id として解決できる（下位互換）
  const { settingFor } = useMediaChannels()
  const { integratedMetricsFor, articleInputsFor, ensureIntegratedLoaded } = useMediaAnalytics()
  const { isEnabled } = useAppSettings()
  const membersTbl = tbl('members')
  const isApi = useApiMode()

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
    // メディア機能トグルが無効ならダッシュボードのメディア軸も無効化（指標・レポート・全社ロールアップを一貫させる）
    const connected = isEnabled('media') && settingFor(segmentId)?.gaConnected === true
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
    return { periodMonth, mediaAvailable: isEnabled('media'), snapshot, trend }
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
      mediaAvailable: isEnabled('media'),
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

  function apiViewOf<T>(row: ApiDashboardRow | null): T | null {
    if (!row) return null
    return {
      metrics: row.metrics,
      insight: row.insight,
      llm: row.llm,
      generatedAt: row.generatedAt,
      generatedByName: row.generatedByName,
      periodKey: row.periodKey,
    } as T
  }

  // ---------- 業態単位 ----------

  async function loadSegment(segmentId: string): Promise<SegmentDashboardView | null> {
    if (isApi) {
      await loadApiDashboard('segment', segmentId)
      return apiViewOf<SegmentDashboardView>(apiDashboards.value[apiKey('segment', segmentId)] ?? null)
    }
    const rec = findRecord('segment', segmentId)
    if (!rec) return null
    return {
      metrics: rec.metrics as SegmentSummary,
      insight: rec.insight as DashboardInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateSegment(segmentId: string): Promise<SegmentDashboardView> {
    if (isApi) {
      // サーバーが集計を組み立て（Phase C）、LLM → ヒューリスティックで洞察を生成・保管する。
      // GA 連携済みで月次が取れない場合はサーバーが AKO-MEDIA-004 で拒否する（M1）
      const row = await apiFetch<ApiDashboardRow>('/v1/akebono/dashboard-insights/generate', {
        method: 'POST', body: { scope: 'segment', segmentId },
      })
      apiDashboards.value = { ...apiDashboards.value, [apiKey('segment', segmentId)]: row }
      return apiViewOf<SegmentDashboardView>(row)!
    }
    // モック: GA 月次（メディア軸）を await でそろえてから集計する。取得失敗時は生成しない
    // （「流入ゼロ」という虚偽データ由来のレポートを保管させない。M1）
    const ready = await ensureIntegratedLoaded(segmentId, MONTHS)
    if (!ready) {
      throw Object.assign(
        new Error('GA の月次トレンドを取得できていないため、レポートを生成できません。時間をおいて再試行してください'),
        { code: 'AKO-MEDIA-004' })
    }
    const metrics = buildSegmentSummary(segmentId)
    const insight = heuristicSegmentInsight(metrics)
    upsert('segment', segmentId, metrics.periodMonth, metrics, insight)
    return (await loadSegment(segmentId))!
  }

  // ---------- 会社全体 ----------

  async function loadCompany(): Promise<CompanyDashboardView | null> {
    if (isApi) {
      await loadApiDashboard('company', null)
      return apiViewOf<CompanyDashboardView>(apiDashboards.value[apiKey('company', null)] ?? null)
    }
    const rec = findRecord('company', null)
    if (!rec) return null
    return {
      metrics: rec.metrics as CompanySummary,
      insight: rec.insight as DashboardInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateCompany(): Promise<CompanyDashboardView> {
    if (isApi) {
      // サーバーが全業態をロールアップして生成・保管する（1 業態でも GA 取得失敗なら 004 で拒否 = M1）
      const row = await apiFetch<ApiDashboardRow>('/v1/akebono/dashboard-insights/generate', {
        method: 'POST', body: { scope: 'company' },
      })
      apiDashboards.value = { ...apiDashboards.value, [apiKey('company', null)]: row }
      return apiViewOf<CompanyDashboardView>(row)!
    }
    // モック: 全業態の GA 月次を await でそろえてから集計する。1 業態でも取得失敗があれば生成しない
    const results = await Promise.all(
      (activeSegments.value as BusinessSegment[]).map(s => ensureIntegratedLoaded(s.id, MONTHS)))
    if (results.some(ready => !ready)) {
      throw Object.assign(
        new Error('一部の業態で GA の月次トレンドを取得できていないため、レポートを生成できません。時間をおいて再試行してください'),
        { code: 'AKO-MEDIA-004' })
    }
    const metrics = buildCompanySummary()
    const insight = heuristicCompanyInsight(metrics)
    upsert('company', null, metrics.periodMonth, metrics, insight)
    return (await loadCompany())!
  }

  return {
    buildSegmentSummary, buildCompanySummary,
    loadSegment, generateSegment, loadCompany, generateCompany,
  }
}
