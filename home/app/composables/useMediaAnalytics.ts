/**
 * メディア分析メトリクス（GA 由来の集計）。メディアチャンネル単位（任意で業態と連携）。
 * - モック: サイトの記事インベントリ（mediaArticles）から決定的に GA 風メトリクスを導出
 *   （shared/domain/media-metrics = モック/デモ環境の SoT として維持。channelId を opaque seed に渡す）
 * - API: GA4 Data API（batchRunReports）の実データをサーバー（GET /v1/media/metrics・/monthly）が
 *   同じ MediaMetrics 型へ整形して返す。channelId × days キーの遅延ロードキャッシュ
 * - 統合分析（業務 × メディア）: **連携済みチャンネル（channel.segmentId あり）でのみ**利用可能。
 *   API モードは GET /v1/media/integrated（メディア月次 = GA + 売上月次 = sales_records をサーバーで突合）を
 *   遅延ロードして表示する。モックモードは shared/domain/media-integrated の同一純関数で合成する。
 *   売上の書込（useAkebonoSales.create/correct）は invalidateIntegratedFor で本キャッシュを無効化する
 *   （連携済みチャンネルの id = 連携先 segmentId のため segmentId でのキー突合が成立する）。
 *
 * 集計基準日は「前日（asOf）」（週次インサイトと同じ思想 = 当日を未確定として悲観評価しない）。
 */
import type { SalesRecord } from '~/types/akebono'
import type { MediaArticle } from '~/types/media'
import {
  deriveMediaMetrics, deriveMonthlyMediaTrend,
  type MediaArticleInput, type MediaMetrics,
} from '../../../shared/domain/media-metrics'
import {
  composeIntegratedMetrics, foldBusinessMonthly, recentMonthKeys, type IntegratedMetrics,
} from '../../../shared/domain/media-integrated'

/** 直近 N ヶ月の月キー（古い順・最終月 = 直前の完了月。共有純関数 recentMonthKeys に today を注入） */
function recentMonths(n: number, endBackMonths = 0): string[] {
  return recentMonthKeys(todayJst().slice(0, 7), n, endBackMonths)
}

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一。channelId キー） ----------

/** 記事インベントリ（channelId → 取消済み含む全件。表示側でフィルタ） */
const apiMediaArticles = ref<Record<string, MediaArticle[]>>({})
/** GA 集計（`${channelId}:${days}` → メトリクス。null = 取得失敗（未連携・GA エラー）） */
const apiMetrics = ref<Record<string, MediaMetrics | null>>({})
/** GA 集計の部分失敗警告（原則4 の「報告」。キーは apiMetrics と同じ） */
const apiMetricsWarning = ref<Record<string, string | null>>({})
/** 取得できなかった内訳キー（ゼロ描画せず「取得できませんでした」表示に置き換える。P1） */
const apiMetricsUnavailable = ref<Record<string, string[]>>({})
/**
 * 統合メトリクス（`${channelId}:${months}` → サーバー組み立ての結果。null = 取得失敗）。
 * mediaFailed = 売上軸は組み立て済みだが GA 月次の取得に失敗（0 表示せず失敗表示 + 再試行 = M1）
 */
interface ApiIntegratedRow {
  metrics: IntegratedMetrics
  mediaConnected: boolean
  mediaFailed: boolean
}
const apiIntegrated = ref<Record<string, ApiIntegratedRow | null>>({})

/** 記事インベントリの遅延ロード（useMediaArticles の採用・取消後の再取得でも使う） */
export function loadMediaArticles(channelId: string, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  return apiLoadOnce(`media:articles:${channelId}`, async () => {
    const rows = await apiFetch<MediaArticle[]>('/v1/media/articles', {
      query: { channelId, includeInactive: '1' },
    })
    apiMediaArticles.value = { ...apiMediaArticles.value, [channelId]: rows }
  }, force)
}

export function loadMediaMetrics(channelId: string, days: number, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  const key = `${channelId}:${days}`
  return apiLoadOnce(`media:metrics:${key}`, async () => {
    try {
      const r = await apiFetch<{ metrics: MediaMetrics; warning?: string; unavailable?: string[] }>('/v1/media/metrics', {
        query: { channelId, days: String(days), ...(force ? { force: '1' } : {}) },
      })
      apiMetrics.value = { ...apiMetrics.value, [key]: r.metrics }
      apiMetricsWarning.value = { ...apiMetricsWarning.value, [key]: r.warning ?? null }
      apiMetricsUnavailable.value = { ...apiMetricsUnavailable.value, [key]: r.unavailable ?? [] }
    } catch (e) {
      // 未連携（AKO-MEDIA-003）・GA 障害（004）は null を記録 = 画面が再試行導線を出す（握りつぶさない）。
      // rethrow はしない（apiLoadOnce のキー巻き戻し → 無限リトライを避ける。再試行は明示操作のみ）
      apiMetrics.value = { ...apiMetrics.value, [key]: null }
      apiMetricsWarning.value = { ...apiMetricsWarning.value, [key]: apiErrorOf(e).message }
    }
  }, force)
}

export function loadMediaIntegrated(channelId: string, months: number, force = false): Promise<void> {
  if (!channelId) return Promise.resolve()
  const key = `${channelId}:${months}`
  return apiLoadOnce(`media:integrated:${key}`, async () => {
    try {
      const row = await apiFetch<ApiIntegratedRow>('/v1/media/integrated', {
        query: { channelId, months: String(months), ...(force ? { force: '1' } : {}) },
      })
      apiIntegrated.value = { ...apiIntegrated.value, [key]: row }
    } catch {
      // rethrow しない（無限リトライ防止。失敗 = ロード済み・結果 null = integratedFailed が失敗表示を出す。M1）
      apiIntegrated.value = { ...apiIntegrated.value, [key]: null }
    }
  }, force)
}

/**
 * 統合メトリクスのキャッシュ無効化（売上の計上・赤黒訂正後に useAkebonoSales / useOutbound が呼ぶ）。
 * 引数は連携先 segmentId。対象チャンネルは「その id 自身（下位互換 = channel.id === segmentId）」に加え、
 * **その segmentId に連携する全チャンネル id**（UI 作成で id が mc-xxxx の連携チャンネル）も含める（レビュー M-1・原則6）。
 * 統合キャッシュのキーは `${channelId}:${months}` なので、キーからチャンネル id を復元して突合する。
 */
export function invalidateIntegratedFor(idOrSegmentId: string): void {
  const targets = new Set<string>([idOrSegmentId, ...channelIdsForSegment(idOrSegmentId)])
  for (const key of Object.keys(apiIntegrated.value)) {
    const sep = key.lastIndexOf(':')
    if (sep < 0) continue
    const channelId = key.slice(0, sep)
    if (!targets.has(channelId)) continue
    const months = Number(key.slice(sep + 1))
    if (Number.isFinite(months)) void loadMediaIntegrated(channelId, months, true)
  }
}

/**
 * GA 連携の再構成（プロパティ確定・連携解除）時のクライアント側キャッシュ無効化（m7。原則6）。
 * ロード済みキーのみ force 再取得する（未ロードは次アクセスで取得）
 */
export function invalidateMediaAnalytics(channelId: string): void {
  for (const key of Object.keys(apiMetrics.value)) {
    if (!key.startsWith(`${channelId}:`)) continue
    const days = Number(key.slice(channelId.length + 1))
    if (Number.isFinite(days)) void loadMediaMetrics(channelId, days, true)
  }
  invalidateIntegratedFor(channelId)
}

onApiReset(() => {
  apiMediaArticles.value = {}
  apiMetrics.value = {}
  apiMetricsWarning.value = {}
  apiMetricsUnavailable.value = {}
  apiIntegrated.value = {}
})

export function useMediaAnalytics() {
  const { tbl } = useMockDb()
  const articlesTbl = tbl('mediaArticles')
  const salesTbl = tbl('salesRecords')
  const { segmentById } = useCurrentSegment()
  const { settingFor } = useMediaChannels()
  const isApi = useApiMode()

  /** 集計基準日（前日） */
  const asOf = computed(() => addDays(todayJst(), -1))

  /** チャンネルの記事インベントリ（取消済み含む生データ。API はサーバーが SoT） */
  function rawArticlesFor(channelId: string): MediaArticle[] {
    if (isApi) {
      void loadMediaArticles(channelId)
      return apiMediaArticles.value[channelId] ?? []
    }
    return (articlesTbl.value as MediaArticle[]).filter(a => a.channelId === channelId)
  }

  /** チャンネルの記事インベントリ（公開・有効のみ。モックの GA 導出の入力 / 記事数の表示） */
  function articleInputsFor(channelId: string): MediaArticleInput[] {
    return rawArticlesFor(channelId)
      .filter(a => a.active !== false && a.status === 'published')
      .map(a => ({
        id: a.id, title: a.title, path: a.path, section: a.section,
        publishedAt: a.publishedAt, wordCount: a.wordCount, origin: a.origin,
      }))
  }

  /**
   * GA メトリクス（既定 28 日）。
   * - モック: 決定的導出（常に非 null）/ API: 遅延ロードキャッシュ（ロード中・失敗は null）
   */
  function metricsFor(channelId: string, days = 28): MediaMetrics | null {
    if (isApi) {
      void loadMediaMetrics(channelId, days)
      return apiMetrics.value[`${channelId}:${days}`] ?? null
    }
    const setting = settingFor(channelId)
    return deriveMediaMetrics(articleInputsFor(channelId), {
      segmentId: channelId, // opaque seed（決定的導出のシード。チャンネル単位）
      siteName: setting?.siteName || setting?.name || 'メディア',
      asOf: asOf.value,
      days,
    })
  }

  /** API: メトリクスのロードが完了したか（null 格納 = 失敗も「完了」。判定もロードを起動する = 遅延ロードのイディオム） */
  function metricsReady(channelId: string, days = 28): boolean {
    if (!isApi) return true
    void loadMediaMetrics(channelId, days)
    return `${channelId}:${days}` in apiMetrics.value
  }

  /** API: 部分失敗の警告・取得失敗の理由（原則4 の「報告」。なければ null） */
  function metricsWarningFor(channelId: string, days = 28): string | null {
    if (!isApi) return null
    return apiMetricsWarning.value[`${channelId}:${days}`] ?? null
  }

  /** API: 取得できなかった内訳キー（P1。モックは常に空 = 全表示） */
  function metricsUnavailableFor(channelId: string, days = 28): string[] {
    if (!isApi) return []
    return apiMetricsUnavailable.value[`${channelId}:${days}`] ?? []
  }

  /** API: GA 集計の再取得（サーバーキャッシュも force で飛ばす） */
  async function refreshMetrics(channelId: string, days = 28): Promise<void> {
    if (!isApi) return
    await loadMediaMetrics(channelId, days, true).catch(() => { /* 失敗は metricsWarningFor が報告 */ })
  }

  /** 当該セグメントの売上を月次集計（モックモードの表示射影。実装 = shared foldBusinessMonthly） */
  function businessMonthly(segmentId: string, months: string[]): Map<string, { amount: number; orders: number }> {
    const rows = (salesTbl.value as SalesRecord[]).filter(r => r.segmentId === segmentId && r.active !== false)
    return foldBusinessMonthly(rows, months)
  }

  /**
   * 業務 × メディアの統合メトリクスを組み立てる（直近 monthsCount ヶ月・最終月 = 直前の完了月）。
   * 連携済みチャンネル（channel.segmentId あり）で売上軸が入る。未連携チャンネルは売上軸 0（連携案内は画面側）。
   * - モック: shared composeIntegratedMetrics でクライアント合成（メディア = 決定的導出 / 売上 = モック集計）
   * - API: サーバー組み立て（GET /v1/media/integrated）の遅延ロードキャッシュ。ロード中・失敗は 0 の器を返す
   */
  function integratedMetricsFor(channelId: string, monthsCount = 6): IntegratedMetrics {
    const months = recentMonths(monthsCount, 1)
    const setting = settingFor(channelId)
    const linkedSegmentId = setting?.segmentId ?? null
    const seg = linkedSegmentId ? segmentById(linkedSegmentId) : null
    const segmentName = seg?.name ?? setting?.name ?? 'セグメント'
    const siteName = setting?.siteName || setting?.name || 'メディア'
    if (isApi) {
      void loadMediaIntegrated(channelId, monthsCount)
      const row = apiIntegrated.value[`${channelId}:${monthsCount}`]
      if (row) return row.metrics
      // 未ロード・取得失敗時のプレースホルダ（0 の器。描画ゲートは integratedReady が担う）
      return composeIntegratedMetrics({
        segmentId: linkedSegmentId ?? channelId,
        segmentName, siteName, months, mediaBy: new Map(), biz: new Map(),
      })
    }
    const trend = deriveMonthlyMediaTrend(articleInputsFor(channelId), months, channelId)
    return composeIntegratedMetrics({
      segmentId: linkedSegmentId ?? channelId,
      segmentName,
      siteName,
      months,
      mediaBy: new Map(trend.map(p => [p.month, p])),
      biz: linkedSegmentId ? businessMonthly(linkedSegmentId, months) : new Map(),
    })
  }

  /** API: 統合メトリクスが取得成功して確定しているか（GA 未連携は mediaFailed=false = 確定・0 が正） */
  function integratedReady(channelId: string, monthsCount = 6): boolean {
    if (!isApi) return true
    void loadMediaIntegrated(channelId, monthsCount)
    const row = apiIntegrated.value[`${channelId}:${monthsCount}`]
    return row !== undefined && row !== null && !row.mediaFailed
  }

  /** API: 統合メトリクスの取得が失敗した状態か（リクエスト失敗 or GA 月次の組み立て失敗。M1） */
  function integratedFailed(channelId: string, monthsCount = 6): boolean {
    if (!isApi) return false
    const key = `${channelId}:${monthsCount}`
    if (!(key in apiIntegrated.value)) return false
    const row = apiIntegrated.value[key]
    return !row || row.mediaFailed === true
  }

  /** API: 統合メトリクスの再取得（サーバーの GA 月次キャッシュも force で飛ばす。失敗表示からの再試行導線） */
  async function refreshMonthly(channelId: string, monthsCount = 6): Promise<void> {
    if (!isApi) return
    await loadMediaIntegrated(channelId, monthsCount, true)
  }

  /**
   * API: 統合メトリクス（サーバー組み立て）を await でそろえる（インサイト生成前に呼ぶ）。
   * 戻り値 = 確定したか（false = 取得失敗。呼び出し側は生成を実行しない = M1）。
   */
  async function ensureIntegratedLoaded(channelId: string, monthsCount = 6): Promise<boolean> {
    if (!isApi) return true
    await loadMediaIntegrated(channelId, monthsCount)
    // 失敗確定時は呼び出しごとに 1 回だけ force 再試行して GA 復旧後の回復手段を確保する（N1）
    if (integratedFailed(channelId, monthsCount)) {
      await loadMediaIntegrated(channelId, monthsCount, true)
    }
    return integratedReady(channelId, monthsCount)
  }

  return {
    asOf, articleInputsFor, rawArticlesFor, metricsFor, integratedMetricsFor, businessMonthly,
    metricsReady, metricsWarningFor, metricsUnavailableFor, refreshMetrics,
    integratedReady, integratedFailed, refreshMonthly, ensureIntegratedLoaded,
  }
}
