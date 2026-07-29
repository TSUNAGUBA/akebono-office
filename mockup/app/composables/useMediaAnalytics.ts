/**
 * メディア分析メトリクス（GA 由来の集計）。
 * - モック: サイトの記事インベントリ（mediaArticles）から決定的に GA 風メトリクスを導出
 *   （shared/domain/media-metrics = モック/デモ環境の SoT として維持）
 * - API: GA4 Data API（batchRunReports）の実データをサーバー（GET /v1/media/metrics・/monthly）が
 *   同じ MediaMetrics 型へ整形して返す（インサイト生成は共通）。segmentId × days キーの遅延ロードキャッシュ
 * - 統合分析（業務 × メディア）: **Phase C でサーバー組み立てへ引き上げ済み**。API モードは
 *   GET /v1/media/integrated（メディア月次 = GA + 売上月次 = sales_records をサーバーで突合）を
 *   遅延ロードして表示する（クライアント合成は廃止 = M2 の改ざん耐性限界も解消）。モックモードは
 *   shared/domain/media-integrated の同一純関数（composeIntegratedMetrics）でクライアント合成する。
 *   売上の書込（useAkebonoSales.create/correct）は invalidateIntegratedFor で本キャッシュを無効化する。
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

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

/** 記事インベントリ（segmentId → 取消済み含む全件。表示側でフィルタ） */
const apiMediaArticles = ref<Record<string, MediaArticle[]>>({})
/** GA 集計（`${segmentId}:${days}` → メトリクス。null = 取得失敗（未連携・GA エラー）） */
const apiMetrics = ref<Record<string, MediaMetrics | null>>({})
/** GA 集計の部分失敗警告（原則4 の「報告」。キーは apiMetrics と同じ） */
const apiMetricsWarning = ref<Record<string, string | null>>({})
/** 取得できなかった内訳キー（'daily'|'channels'|'devices'|'topPages'|'prevPages'。
 * サーバーの null 防御はゼロ埋めへ正規化するため、該当ビジュアライゼーションはゼロ描画せず
 * 「取得できませんでした」表示に置き換える（P1 = 失敗を 0 表示にしない原則の内訳への適用） */
const apiMetricsUnavailable = ref<Record<string, string[]>>({})
/**
 * 統合メトリクス（`${segmentId}:${months}` → サーバー組み立ての結果。null = 取得失敗）。
 * mediaFailed = 売上軸は組み立て済みだが GA 月次の取得に失敗（0 表示せず失敗表示 + 再試行 = M1）
 */
interface ApiIntegratedRow {
  metrics: IntegratedMetrics
  mediaConnected: boolean
  mediaFailed: boolean
}
const apiIntegrated = ref<Record<string, ApiIntegratedRow | null>>({})

/** 記事インベントリの遅延ロード（useMediaArticles の採用・取消後の再取得でも使う） */
export function loadMediaArticles(segmentId: string, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  return apiLoadOnce(`media:articles:${segmentId}`, async () => {
    const rows = await apiFetch<MediaArticle[]>('/v1/media/articles', {
      query: { segmentId, includeInactive: '1' },
    })
    apiMediaArticles.value = { ...apiMediaArticles.value, [segmentId]: rows }
  }, force)
}

export function loadMediaMetrics(segmentId: string, days: number, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  const key = `${segmentId}:${days}`
  return apiLoadOnce(`media:metrics:${key}`, async () => {
    try {
      const r = await apiFetch<{ metrics: MediaMetrics; warning?: string; unavailable?: string[] }>('/v1/media/metrics', {
        query: { segmentId, days: String(days), ...(force ? { force: '1' } : {}) },
      })
      apiMetrics.value = { ...apiMetrics.value, [key]: r.metrics }
      apiMetricsWarning.value = { ...apiMetricsWarning.value, [key]: r.warning ?? null }
      apiMetricsUnavailable.value = { ...apiMetricsUnavailable.value, [key]: r.unavailable ?? [] }
    } catch (e) {
      // 未連携（AKO-MEDIA-003）・GA 障害（004）は null を記録 = 画面が再試行導線を出す（握りつぶさない）。
      // rethrow はしない: 失敗を「ロード済み（結果 null）」として確定させる。rethrow すると apiLoadOnce が
      // キーを未ロードへ戻し、null 記録のリアクティブ更新 → computed 再評価 → 再ロードの無限リトライになる。
      // 再試行は明示操作（refreshMetrics = force）とログイン切替時の resetApiData のみ
      apiMetrics.value = { ...apiMetrics.value, [key]: null }
      apiMetricsWarning.value = { ...apiMetricsWarning.value, [key]: apiErrorOf(e).message }
    }
  }, force)
}

export function loadMediaIntegrated(segmentId: string, months: number, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  const key = `${segmentId}:${months}`
  return apiLoadOnce(`media:integrated:${key}`, async () => {
    try {
      const row = await apiFetch<ApiIntegratedRow>('/v1/media/integrated', {
        // force はサーバーの GA 月次 30 分キャッシュも飛ばす（m9。metrics と同じ再試行の意味論）
        query: { segmentId, months: String(months), ...(force ? { force: '1' } : {}) },
      })
      apiIntegrated.value = { ...apiIntegrated.value, [key]: row }
    } catch {
      // rethrow しない（上の loadMediaMetrics と同じ無限リトライ防止。失敗 = ロード済み・結果 null =
      // integratedFailed が検知して「0 表示」でなく失敗表示 + 再試行導線を出す。M1）
      apiIntegrated.value = { ...apiIntegrated.value, [key]: null }
    }
  }, force)
}

/**
 * 統合メトリクスのキャッシュ無効化（売上の計上・赤黒訂正後に useAkebonoSales が呼ぶ =
 * SoT（sales_records）の変化を PDCA タブ・ダッシュボードへ追随させる。原則6）。
 * ロード済みキーのみ force 再取得する（未ロードは次アクセスで最新を取得）
 */
export function invalidateIntegratedFor(segmentId: string): void {
  for (const key of Object.keys(apiIntegrated.value)) {
    if (!key.startsWith(`${segmentId}:`)) continue
    const months = Number(key.slice(segmentId.length + 1))
    if (Number.isFinite(months)) void loadMediaIntegrated(segmentId, months, true)
  }
}

/**
 * GA 連携の再構成（プロパティ確定・連携解除）時のクライアント側キャッシュ無効化（m7。原則6:
 * SoT の変化 → 依存キャッシュの追随）。ロード済みキーのみ force 再取得する（未ロードは次アクセスで取得）
 */
export function invalidateMediaAnalytics(segmentId: string): void {
  for (const key of Object.keys(apiMetrics.value)) {
    if (!key.startsWith(`${segmentId}:`)) continue
    const days = Number(key.slice(segmentId.length + 1))
    if (Number.isFinite(days)) void loadMediaMetrics(segmentId, days, true)
  }
  invalidateIntegratedFor(segmentId)
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
  const { settingFor } = useMediaSettings()
  const isApi = useApiMode()

  /** 集計基準日（前日） */
  const asOf = computed(() => addDays(todayJst(), -1))

  /** セグメントの記事インベントリ（取消済み含む生データ。API はサーバーが SoT） */
  function rawArticlesFor(segmentId: string): MediaArticle[] {
    if (isApi) {
      void loadMediaArticles(segmentId)
      return apiMediaArticles.value[segmentId] ?? []
    }
    return (articlesTbl.value as MediaArticle[]).filter(a => a.segmentId === segmentId)
  }

  /** セグメントの記事インベントリ（公開・有効のみ。モックの GA 導出の入力 / 記事数の表示） */
  function articleInputsFor(segmentId: string): MediaArticleInput[] {
    return rawArticlesFor(segmentId)
      .filter(a => a.active !== false && a.status === 'published')
      .map(a => ({
        id: a.id, title: a.title, path: a.path, section: a.section,
        publishedAt: a.publishedAt, wordCount: a.wordCount, origin: a.origin,
      }))
  }

  /**
   * GA メトリクス（既定 28 日）。
   * - モック: 決定的導出（常に非 null）
   * - API: 遅延ロードキャッシュ（ロード中は null。取得失敗も null = metricsErrorFor で理由を出す）
   */
  function metricsFor(segmentId: string, days = 28): MediaMetrics | null {
    if (isApi) {
      void loadMediaMetrics(segmentId, days)
      return apiMetrics.value[`${segmentId}:${days}`] ?? null
    }
    const setting = settingFor(segmentId)
    return deriveMediaMetrics(articleInputsFor(segmentId), {
      segmentId,
      siteName: setting?.siteName ?? 'メディア',
      asOf: asOf.value,
      days,
    })
  }

  /** API: メトリクスのロードが完了したか（null 格納 = 失敗も「完了」。ローディング表示の判定用）。
   * 状態判定もロードを**起動**する（読取り = 遅延ロードのイディオム）: analytics.vue の v-else-if 連鎖は
   * ローディング分岐で短絡し、コンテンツ分岐（metricsFor 評価 = 従来唯一の起動点）に到達しないため、
   * 判定だけ読んでロードが始まらない「スピナー永続」のデッドロックになる（本番障害 2026-07-29）。
   * apiLoadOnce の一度きりセマンティクスは維持（失敗確定後の自動再試行はしない = M1 の封止不変） */
  function metricsReady(segmentId: string, days = 28): boolean {
    if (!isApi) return true
    void loadMediaMetrics(segmentId, days)
    return `${segmentId}:${days}` in apiMetrics.value
  }

  /** API: 部分失敗の警告・取得失敗の理由（原則4 の「報告」。なければ null） */
  function metricsWarningFor(segmentId: string, days = 28): string | null {
    if (!isApi) return null
    return apiMetricsWarning.value[`${segmentId}:${days}`] ?? null
  }

  /** API: 取得できなかった内訳キー（P1。モックは常に空 = 全表示。該当ビジュアライゼーションはゼロ描画しない） */
  function metricsUnavailableFor(segmentId: string, days = 28): string[] {
    if (!isApi) return []
    return apiMetricsUnavailable.value[`${segmentId}:${days}`] ?? []
  }

  /** API: GA 集計の再取得（サーバーキャッシュも force で飛ばす） */
  async function refreshMetrics(segmentId: string, days = 28): Promise<void> {
    if (!isApi) return
    await loadMediaMetrics(segmentId, days, true).catch(() => { /* 失敗は metricsWarningFor が報告 */ })
  }

  /**
   * 当該セグメントの売上を月次集計（モックモードの表示射影。実装 = shared foldBusinessMonthly =
   * API サーバーの組み立てと同一純関数。赤黒訂正は元明細の計上月へ帰属して相殺する）
   */
  function businessMonthly(segmentId: string, months: string[]): Map<string, { amount: number; orders: number }> {
    const rows = (salesTbl.value as SalesRecord[]).filter(r => r.segmentId === segmentId && r.active !== false)
    return foldBusinessMonthly(rows, months)
  }

  /**
   * 業務 × メディアの統合メトリクスを組み立てる（直近 monthsCount ヶ月・最終月 = 直前の完了月）。
   * - モック: shared composeIntegratedMetrics でクライアント合成（メディア = 決定的導出 / 売上 = モック集計）
   * - API: **サーバー組み立て**（GET /v1/media/integrated）の遅延ロードキャッシュ。ロード中・失敗は
   *   メディア/売上とも 0 の器を返す（表示側は integratedReady / integratedFailed で状態を区別 = M1。
   *   Phase C でクライアント合成を廃止 = 売上軸も GA 軸もサーバーが SoT から組み立てる）
   */
  function integratedMetricsFor(segmentId: string, monthsCount = 6): IntegratedMetrics {
    const months = recentMonths(monthsCount, 1)
    const setting = settingFor(segmentId)
    const seg = segmentById(segmentId)
    if (isApi) {
      void loadMediaIntegrated(segmentId, monthsCount)
      const row = apiIntegrated.value[`${segmentId}:${monthsCount}`]
      if (row) return row.metrics
      // 未ロード・取得失敗時のプレースホルダ（0 の器。描画ゲートは integratedReady が担う）
      return composeIntegratedMetrics({
        segmentId,
        segmentName: seg?.name ?? 'セグメント',
        siteName: setting?.siteName ?? 'メディア',
        months, mediaBy: new Map(), biz: new Map(),
      })
    }
    const trend = deriveMonthlyMediaTrend(articleInputsFor(segmentId), months, segmentId)
    return composeIntegratedMetrics({
      segmentId,
      segmentName: seg?.name ?? 'セグメント',
      siteName: setting?.siteName ?? 'メディア',
      months,
      mediaBy: new Map(trend.map(p => [p.month, p])),
      biz: businessMonthly(segmentId, months),
    })
  }

  /** API: 統合メトリクス（サーバー組み立て）が**取得成功して**確定しているか（GA 未連携は
   * mediaFailed=false で返る = 「確定」扱い・0 が正。取得失敗・GA 月次失敗は ready にしない =
   * 0 表示・0 由来のインサイト生成を防ぐ。M1）。
   * metricsReady と同じく状態判定がロードを起動する（PDCA タブのローディング分岐は本関数しか読まず、
   * integrated computed（従来唯一の起動点）が評価されないため。本番障害 2026-07-29） */
  function integratedReady(segmentId: string, monthsCount = 6): boolean {
    if (!isApi) return true
    void loadMediaIntegrated(segmentId, monthsCount)
    const row = apiIntegrated.value[`${segmentId}:${monthsCount}`]
    return row !== undefined && row !== null && !row.mediaFailed
  }

  /** API: 統合メトリクスの取得が失敗した状態か（リクエスト失敗 or GA 月次の組み立て失敗 =
   * PDCA タブの失敗表示 + 再試行導線の判定。M1） */
  function integratedFailed(segmentId: string, monthsCount = 6): boolean {
    if (!isApi) return false
    const key = `${segmentId}:${monthsCount}`
    if (!(key in apiIntegrated.value)) return false
    const row = apiIntegrated.value[key]
    return !row || row.mediaFailed === true
  }

  /** API: 統合メトリクスの再取得（サーバーの GA 月次キャッシュも force で飛ばす。失敗表示からの再試行導線） */
  async function refreshMonthly(segmentId: string, monthsCount = 6): Promise<void> {
    if (!isApi) return
    await loadMediaIntegrated(segmentId, monthsCount, true)
  }

  /**
   * API: 統合メトリクス（サーバー組み立て）を await でそろえる（インサイト生成・ダッシュボード集計前に呼ぶ）。
   * 戻り値 = 確定したか（false = 取得失敗。**呼び出し側は生成を実行しないこと** =
   * 「流入ゼロ」という虚偽データ由来のインサイトを保管させない。M1）
   */
  async function ensureIntegratedLoaded(segmentId: string, monthsCount = 6): Promise<boolean> {
    if (!isApi) return true
    await loadMediaIntegrated(segmentId, monthsCount)
    // 過去の失敗は「ロード済み（結果 null / mediaFailed）」で確定しており、force なしでは二度とサーバーへ
    // 行かない。本関数はユーザーの明示操作（再生成ボタン等）起点の await 経路なので、**呼び出しごとに
    // 1 回だけ** force 再試行して GA 復旧後の回復手段を確保する（N1。リアクティブ再評価による無限リトライ
    // （M1 で封止）はここでは起きない = computed からは呼ばれない）。失敗が続けば false のまま =
    // 生成遮断（M1）は維持
    if (integratedFailed(segmentId, monthsCount)) {
      await loadMediaIntegrated(segmentId, monthsCount, true)
    }
    return integratedReady(segmentId, monthsCount)
  }

  return {
    asOf, articleInputsFor, rawArticlesFor, metricsFor, integratedMetricsFor, businessMonthly,
    metricsReady, metricsWarningFor, metricsUnavailableFor, refreshMetrics,
    integratedReady, integratedFailed, refreshMonthly, ensureIntegratedLoaded,
  }
}
