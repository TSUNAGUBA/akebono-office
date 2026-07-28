/**
 * メディア AI インサイト（生成・保管・読込）。週次インサイト（useWeeklyInsight）と同じ思想:
 * 一度生成したら保管し、再生成されるまで保存済みを表示する（導出キャッシュ = 再生成で上書き）。
 *
 * - scope='media': GA メトリクス → サイト構成・記事インサイト + 次アクション（heuristicMediaInsight）
 * - scope='integrated': 業務 × メディア → 相関・PDCA + アクション（heuristicIntegratedInsight）
 * - モックは決定的ヒューリスティックのみ（llm=false）。本実装は Vertex AI → 失敗時ヒューリスティック（原則4）
 * - セグメント × scope で 1 レコード（upsert）。再生成で上書きし、進捗・記録は持たない（原則2 に抵触しない導出系）
 */
import {
  heuristicMediaInsight, type MediaInsight, type MediaInsightRecord,
} from '../../../shared/domain/media-insight'
import type { MediaMetrics } from '../../../shared/domain/media-metrics'
import {
  heuristicIntegratedInsight, type IntegratedInsight, type IntegratedMetrics,
} from '../../../shared/domain/media-integrated'

export interface MediaInsightView {
  metrics: MediaMetrics
  insight: MediaInsight
  llm: boolean
  generatedAt: string
  generatedByName: string | null
  periodKey: string
}
export interface IntegratedInsightView {
  metrics: IntegratedMetrics
  insight: IntegratedInsight
  llm: boolean
  generatedAt: string
  generatedByName: string | null
  periodKey: string
}

export function useMediaInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('mediaInsights')
  const { currentUser } = useCurrentUser()
  const analytics = useMediaAnalytics()
  const membersTbl = tbl('members')

  function nameOf(id: string): string | null {
    return (membersTbl.value as { id: string; name: string }[]).find(m => m.id === id)?.name ?? null
  }

  function findRecord(segmentId: string, scope: 'media' | 'integrated'): MediaInsightRecord | undefined {
    return (records.value as MediaInsightRecord[]).find(r => r.segmentId === segmentId && r.scope === scope)
  }

  function getById(id: string): MediaInsightRecord | null {
    return (records.value as MediaInsightRecord[]).find(r => r.id === id) ?? null
  }

  function upsert(segmentId: string, scope: 'media' | 'integrated', periodKey: string, metrics: unknown, insight: unknown): MediaInsightRecord {
    const existing = findRecord(segmentId, scope)
    const rec: MediaInsightRecord = {
      id: existing?.id ?? nextId('mediaInsights', 'mi'),
      segmentId, scope, periodKey, metrics, insight,
      llm: false,
      generatedBy: currentUser.value.id,
      generatedAt: nowJstIso(),
    }
    records.value = [
      ...(records.value as MediaInsightRecord[]).filter(r => !(r.segmentId === segmentId && r.scope === scope)),
      rec,
    ]
    commit()
    return rec
  }

  // ---------- メディア単体 ----------

  function loadMedia(segmentId: string): MediaInsightView | null {
    const rec = findRecord(segmentId, 'media')
    if (!rec) return null
    return {
      metrics: rec.metrics as MediaMetrics,
      insight: rec.insight as MediaInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  function generateMedia(segmentId: string): MediaInsightView {
    const metrics = analytics.metricsFor(segmentId, 28)
    const insight = heuristicMediaInsight(metrics)
    const periodKey = `${metrics.periodFrom}_${metrics.periodTo}`
    upsert(segmentId, 'media', periodKey, metrics, insight)
    return loadMedia(segmentId)!
  }

  // ---------- 業務 × メディア（統合 PDCA） ----------

  function loadIntegrated(segmentId: string): IntegratedInsightView | null {
    const rec = findRecord(segmentId, 'integrated')
    if (!rec) return null
    return {
      metrics: rec.metrics as IntegratedMetrics,
      insight: rec.insight as IntegratedInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  function generateIntegrated(segmentId: string): IntegratedInsightView {
    const metrics = analytics.integratedMetricsFor(segmentId, 6)
    const insight = heuristicIntegratedInsight(metrics)
    upsert(segmentId, 'integrated', metrics.periodMonth, metrics, insight)
    return loadIntegrated(segmentId)!
  }

  return { loadMedia, generateMedia, loadIntegrated, generateIntegrated, getById }
}
