/**
 * メディア AI インサイト（生成・保管・読込）。週次インサイト（useWeeklyInsight）と同じ思想:
 * 一度生成したら保管し、再生成されるまで保存済みを表示する（導出キャッシュ = 再生成で上書き）。
 *
 * デュアルモード:
 * - モック: mediaInsights コレクション + 決定的ヒューリスティックのみ（llm=false）
 * - API: SoT はサーバー（media_insights。GET/POST /v1/media/insights）。生成は Vertex AI →
 *   失敗時サーバー側で同一ヒューリスティックへフォールバック（原則4。llm フラグで区別）。
 *   scope='media' はサーバーが GA からメトリクスを組み立てる。scope='integrated' は
 *   売上明細（salesRecords）が未移行のモック側 SoT のため、クライアントが統合メトリクスを
 *   組み立てて渡す（useMediaAnalytics の SoT 宣言参照）
 * - セグメント × scope で 1 レコード（upsert）。進捗・記録は持たない（原則2 に抵触しない導出系）
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
  /** 劣化データ由来の告知（API モードのみ。GA 内訳の部分失敗等。null/未設定 = 完全な集計から生成） */
  warning?: string | null
}
export interface IntegratedInsightView {
  metrics: IntegratedMetrics
  insight: IntegratedInsight
  llm: boolean
  generatedAt: string
  generatedByName: string | null
  periodKey: string
  /** 劣化データ由来の告知（API モードのみ。GA 突合の失敗等。null/未設定 = 完全な集計から生成） */
  warning?: string | null
}

// ---------- API モードのキャッシュ（`${segmentId}:${scope}` → 保管済み or null） ----------

interface ApiInsightRow {
  id: string
  periodKey: string
  metrics: unknown
  insight: unknown
  llm: boolean
  warning: string | null
  generatedAt: string
  generatedByName: string | null
}

const apiInsights = ref<Record<string, ApiInsightRow | null>>({})

function loadApiInsight(segmentId: string, scope: 'media' | 'integrated', force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  return apiLoadOnce(`media:insight:${segmentId}:${scope}`, async () => {
    const row = await apiFetch<ApiInsightRow | null>('/v1/media/insights', { query: { segmentId, scope } })
    apiInsights.value = { ...apiInsights.value, [`${segmentId}:${scope}`]: row }
  }, force)
}

onApiReset(() => { apiInsights.value = {} })

export function useMediaInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('mediaInsights')
  const { currentUser } = useCurrentUser()
  const analytics = useMediaAnalytics()
  const membersTbl = tbl('members')
  const isApi = useApiMode()

  function nameOf(id: string): string | null {
    return (membersTbl.value as { id: string; name: string }[]).find(m => m.id === id)?.name ?? null
  }

  function findRecord(segmentId: string, scope: 'media' | 'integrated'): MediaInsightRecord | undefined {
    return (records.value as MediaInsightRecord[]).find(r => r.segmentId === segmentId && r.scope === scope)
  }

  /** 保管レコードの参照（モック専用。記事生成のヒント抽出は API モードではサーバーが担う） */
  function getById(id: string): MediaInsightRecord | null {
    return (records.value as MediaInsightRecord[]).find(r => r.id === id) ?? null
  }

  /**
   * 保管済みメディアインサイトの id + 本文（記事生成の「分析からお題を提案」用。両モード同期参照）。
   * API モードは遅延ロードキャッシュから返す（未ロード時は null → 到着後にリアクティブ反映）
   */
  function storedMedia(segmentId: string): { id: string; insight: MediaInsight } | null {
    if (isApi) {
      void loadApiInsight(segmentId, 'media')
      const row = apiInsights.value[`${segmentId}:media`]
      return row ? { id: row.id, insight: row.insight as MediaInsight } : null
    }
    const rec = findRecord(segmentId, 'media')
    return rec ? { id: rec.id, insight: rec.insight as MediaInsight } : null
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

  function apiViewOf<T>(row: ApiInsightRow | null): T | null {
    if (!row) return null
    return {
      metrics: row.metrics,
      insight: row.insight,
      llm: row.llm,
      generatedAt: row.generatedAt,
      generatedByName: row.generatedByName,
      periodKey: row.periodKey,
      warning: row.warning ?? null,
    } as T
  }

  // ---------- メディア単体 ----------

  async function loadMedia(segmentId: string): Promise<MediaInsightView | null> {
    if (isApi) {
      await loadApiInsight(segmentId, 'media')
      return apiViewOf<MediaInsightView>(apiInsights.value[`${segmentId}:media`] ?? null)
    }
    const rec = findRecord(segmentId, 'media')
    if (!rec) return null
    return {
      metrics: rec.metrics as MediaMetrics,
      insight: rec.insight as MediaInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateMedia(segmentId: string): Promise<MediaInsightView | null> {
    if (isApi) {
      // サーバーが GA からメトリクスを組み立て、LLM → ヒューリスティックで洞察を生成・保管する
      const row = await apiFetch<ApiInsightRow>('/v1/media/insights/generate', {
        method: 'POST', body: { segmentId, scope: 'media' },
      })
      apiInsights.value = { ...apiInsights.value, [`${segmentId}:media`]: row }
      return apiViewOf<MediaInsightView>(row)
    }
    const metrics = analytics.metricsFor(segmentId, 28)
    if (!metrics) return null
    const insight = heuristicMediaInsight(metrics)
    const periodKey = `${metrics.periodFrom}_${metrics.periodTo}`
    upsert(segmentId, 'media', periodKey, metrics, insight)
    return loadMedia(segmentId)
  }

  // ---------- 業務 × メディア（統合 PDCA） ----------

  async function loadIntegrated(segmentId: string): Promise<IntegratedInsightView | null> {
    if (isApi) {
      await loadApiInsight(segmentId, 'integrated')
      return apiViewOf<IntegratedInsightView>(apiInsights.value[`${segmentId}:integrated`] ?? null)
    }
    const rec = findRecord(segmentId, 'integrated')
    if (!rec) return null
    return {
      metrics: rec.metrics as IntegratedMetrics,
      insight: rec.insight as IntegratedInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateIntegrated(segmentId: string): Promise<IntegratedInsightView | null> {
    if (isApi) {
      // 統合メトリクスはクライアント合成（メディア月次 = GA 実データ / 売上月次 = 未移行のモック側集計）。
      // 生成前に GA 月次を await でそろえ、**取得失敗時は生成しない**
      // （「流入ゼロ」という虚偽データ由来のインサイトを保管させない。M1）
      const ready = await analytics.ensureIntegratedLoaded(segmentId, 6)
      if (!ready) {
        throw Object.assign(
          new Error('GA の月次トレンドを取得できていないため、統合インサイトを生成できません。再試行してから生成してください'),
          { code: 'AKO-MEDIA-004' })
      }
      const metrics = analytics.integratedMetricsFor(segmentId, 6)
      const row = await apiFetch<ApiInsightRow>('/v1/media/insights/generate', {
        method: 'POST', body: { segmentId, scope: 'integrated', metrics },
      })
      apiInsights.value = { ...apiInsights.value, [`${segmentId}:integrated`]: row }
      return apiViewOf<IntegratedInsightView>(row)
    }
    const metrics = analytics.integratedMetricsFor(segmentId, 6)
    const insight = heuristicIntegratedInsight(metrics)
    upsert(segmentId, 'integrated', metrics.periodMonth, metrics, insight)
    return loadIntegrated(segmentId)
  }

  return { loadMedia, generateMedia, loadIntegrated, generateIntegrated, getById, storedMedia }
}
