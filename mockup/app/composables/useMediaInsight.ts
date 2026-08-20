/**
 * メディア AI インサイト（生成・保管・読込）。メディアチャンネル単位（channelId で keying）。
 * 週次インサイト（useWeeklyInsight）と同じ思想: 一度生成したら保管し、再生成されるまで保存済みを表示する。
 *
 * デュアルモード:
 * - モック: mediaInsights コレクション + 決定的ヒューリスティックのみ（llm=false）。
 *   保管レコード（shared MediaInsightRecord）の segmentId フィールドは **channelId を opaque キーとして格納**する
 *   （shared/domain は変更しない方針のためフィールド名は据え置き。値はチャンネル id）。
 * - API: SoT はサーバー（media_insights。GET/POST /v1/media/insights）。生成は Vertex AI →
 *   失敗時サーバー側で同一ヒューリスティックへフォールバック（原則4。llm フラグで区別）。
 *   scope='media' は GA 集計 + 外部投稿記事の原文を材料に、scope='integrated' は連携済みチャンネルの
 *   売上軸 = sales_records + メディア軸 = GA のサーバー組み立てで生成する。
 * - チャンネル × scope で 1 レコード（upsert）。
 */
import {
  applyExternalMaterial, externalMaterialOf,
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

// ---------- API モードのキャッシュ（`${channelId}:${scope}` → 保管済み or null） ----------

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

function loadApiInsight(channelId: string, scope: 'media' | 'integrated', force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:insight:${channelId}:${scope}`, async () => {
    const row = await apiFetch<ApiInsightRow | null>('/v1/media/insights', { query: { channelId, scope } })
    apiInsights.value = { ...apiInsights.value, [`${channelId}:${scope}`]: row }
  }, force)
}

onApiReset(() => { apiInsights.value = {} })

export function useMediaInsight() {
  const { tbl, commit, nextId } = useMockDb()
  const records = tbl('mediaInsights')
  const { currentUser } = useCurrentUser()
  const analytics = useMediaAnalytics()
  const externalArticles = useMediaExternalArticles()
  const membersTbl = tbl('members')
  const isApi = useApiMode()

  function nameOf(id: string): string | null {
    return (membersTbl.value as { id: string; name: string }[]).find(m => m.id === id)?.name ?? null
  }

  // NOTE: MediaInsightRecord.segmentId フィールドには channelId を opaque キーとして格納する（shared 不変方針）
  function findRecord(channelId: string, scope: 'media' | 'integrated'): MediaInsightRecord | undefined {
    return (records.value as MediaInsightRecord[]).find(r => r.segmentId === channelId && r.scope === scope)
  }

  /** 保管レコードの参照（モック専用。記事生成のヒント抽出は API モードではサーバーが担う） */
  function getById(id: string): MediaInsightRecord | null {
    return (records.value as MediaInsightRecord[]).find(r => r.id === id) ?? null
  }

  /**
   * 保管済みメディアインサイトの id + 本文（記事生成の「分析からお題を提案」用。両モード同期参照）。
   * API モードは遅延ロードキャッシュから返す（未ロード時は null → 到着後にリアクティブ反映）
   */
  function storedMedia(channelId: string): { id: string; insight: MediaInsight } | null {
    if (isApi) {
      void loadApiInsight(channelId, 'media')
      const row = apiInsights.value[`${channelId}:media`]
      return row ? { id: row.id, insight: row.insight as MediaInsight } : null
    }
    const rec = findRecord(channelId, 'media')
    return rec ? { id: rec.id, insight: rec.insight as MediaInsight } : null
  }

  function upsert(channelId: string, scope: 'media' | 'integrated', periodKey: string, metrics: unknown, insight: unknown): MediaInsightRecord {
    const existing = findRecord(channelId, scope)
    const rec: MediaInsightRecord = {
      id: existing?.id ?? nextId('mediaInsights', 'mi'),
      segmentId: channelId, // opaque key = channelId（shared 型のフィールド名は据え置き）
      scope, periodKey, metrics, insight,
      llm: false,
      generatedBy: currentUser.value.id,
      generatedAt: nowJstIso(),
    }
    records.value = [
      ...(records.value as MediaInsightRecord[]).filter(r => !(r.segmentId === channelId && r.scope === scope)),
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

  async function loadMedia(channelId: string): Promise<MediaInsightView | null> {
    if (isApi) {
      await loadApiInsight(channelId, 'media')
      return apiViewOf<MediaInsightView>(apiInsights.value[`${channelId}:media`] ?? null)
    }
    const rec = findRecord(channelId, 'media')
    if (!rec) return null
    return {
      metrics: rec.metrics as MediaMetrics,
      insight: rec.insight as MediaInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateMedia(channelId: string): Promise<MediaInsightView | null> {
    if (isApi) {
      // サーバーが GA からメトリクスを組み立て、外部投稿記事を材料に、LLM → ヒューリスティックで洞察を生成・保管する
      const row = await apiFetch<ApiInsightRow>('/v1/media/insights/generate', {
        method: 'POST', body: { channelId, scope: 'media' }, timeoutMs: 60_000,
      })
      apiInsights.value = { ...apiInsights.value, [`${channelId}:media`]: row }
      return apiViewOf<MediaInsightView>(row)
    }
    const metrics = analytics.metricsFor(channelId, 28)
    if (!metrics) return null
    // 外部投稿記事の原文を材料に反映する（API と同一の shared ロジック = 両モードパリティ。要件(d)の「AI活用」）
    const materials = externalMaterialOf(
      externalArticles.listFor(channelId).map(e => ({ title: e.title, source: e.source, body: e.body })))
    const insight = applyExternalMaterial(heuristicMediaInsight(metrics), materials)
    const periodKey = `${metrics.periodFrom}_${metrics.periodTo}`
    upsert(channelId, 'media', periodKey, metrics, insight)
    return loadMedia(channelId)
  }

  // ---------- 業務 × メディア（統合 PDCA。連携済みチャンネルのみ） ----------

  async function loadIntegrated(channelId: string): Promise<IntegratedInsightView | null> {
    if (isApi) {
      await loadApiInsight(channelId, 'integrated')
      return apiViewOf<IntegratedInsightView>(apiInsights.value[`${channelId}:integrated`] ?? null)
    }
    const rec = findRecord(channelId, 'integrated')
    if (!rec) return null
    return {
      metrics: rec.metrics as IntegratedMetrics,
      insight: rec.insight as IntegratedInsight,
      llm: rec.llm, generatedAt: rec.generatedAt, generatedByName: nameOf(rec.generatedBy), periodKey: rec.periodKey,
    }
  }

  async function generateIntegrated(channelId: string): Promise<IntegratedInsightView | null> {
    if (isApi) {
      // 統合メトリクスはサーバー組み立て（Phase C）。生成前に表示側の統合キャッシュを await でそろえ、
      // **取得失敗時は生成しない**（M1。サーバー側でも未連携は AKO-MEDIA-022 / mediaFailed は 004 で拒否）
      const ready = await analytics.ensureIntegratedLoaded(channelId, 6)
      if (!ready) {
        throw Object.assign(
          new Error('GA の月次トレンドを取得できていないため、統合インサイトを生成できません。再試行してから生成してください'),
          { code: 'AKO-MEDIA-004' })
      }
      const row = await apiFetch<ApiInsightRow>('/v1/media/insights/generate', {
        method: 'POST', body: { channelId, scope: 'integrated', months: 6 }, timeoutMs: 60_000,
      })
      apiInsights.value = { ...apiInsights.value, [`${channelId}:integrated`]: row }
      return apiViewOf<IntegratedInsightView>(row)
    }
    const metrics = analytics.integratedMetricsFor(channelId, 6)
    const insight = heuristicIntegratedInsight(metrics)
    upsert(channelId, 'integrated', metrics.periodMonth, metrics, insight)
    return loadIntegrated(channelId)
  }

  return { loadMedia, generateMedia, loadIntegrated, generateIntegrated, getById, storedMedia }
}
