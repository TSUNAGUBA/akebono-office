/**
 * メディア分析メトリクス（GA 由来の集計）。
 * - モック: サイトの記事インベントリ（mediaArticles）から決定的に GA 風メトリクスを導出
 *   （shared/domain/media-metrics = モック/デモ環境の SoT として維持）
 * - API: GA4 Data API（batchRunReports）の実データをサーバー（GET /v1/media/metrics・/monthly）が
 *   同じ MediaMetrics 型へ整形して返す（インサイト生成は共通）。segmentId × days キーの遅延ロードキャッシュ
 * - 統合分析（業務 × メディア）の SoT 宣言: 売上明細（salesRecords）は**未移行のモック側コレクション**のため、
 *   API モードでも売上月次はモック側集計・メディア月次のみ /v1/media/monthly（GA 実データ）を突合する
 *   （businessSegments/salesRecords の API 移行時にサーバー側組み立て（/v1/media/integrated 相当）へ引き上げる）
 *
 * 集計基準日は「前日（asOf）」（週次インサイトと同じ思想 = 当日を未確定として悲観評価しない）。
 */
import type { SalesRecord } from '~/types/akebono'
import type { MediaArticle } from '~/types/media'
import {
  deriveMediaMetrics, deriveMonthlyMediaTrend,
  type MediaArticleInput, type MediaMetrics, type MediaMonthlyPoint,
} from '../../../shared/domain/media-metrics'
import type { IntegratedMetrics } from '../../../shared/domain/media-integrated'

/**
 * 直近 N ヶ月の月キー（古い順）。
 * endBackMonths=0 は今日の月で終わる。統合分析は「最終月 = 直前の完了月」（endBackMonths=1）を基準にする
 * （進行中の当月を締めていない売上で悲観評価しないため。前日基準と同じ思想）。
 */
function recentMonths(n: number, endBackMonths = 0): string[] {
  const cur = todayJst().slice(0, 7)
  const y = Number(cur.slice(0, 4))
  const m0 = Number(cur.slice(5, 7))
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const m = m0 - 1 - endBackMonths - i
    const ny = y + Math.floor(m / 12)
    const nm = ((m % 12) + 12) % 12
    out.push(`${ny}-${String(nm + 1).padStart(2, '0')}`)
  }
  return out
}

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

/** 記事インベントリ（segmentId → 取消済み含む全件。表示側でフィルタ） */
const apiMediaArticles = ref<Record<string, MediaArticle[]>>({})
/** GA 集計（`${segmentId}:${days}` → メトリクス。null = 取得失敗（未連携・GA エラー）） */
const apiMetrics = ref<Record<string, MediaMetrics | null>>({})
/** GA 集計の部分失敗警告（原則4 の「報告」。キーは apiMetrics と同じ） */
const apiMetricsWarning = ref<Record<string, string | null>>({})
/** 月次トレンド（`${segmentId}:${months}`） */
const apiMonthly = ref<Record<string, MediaMonthlyPoint[] | null>>({})

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
      const r = await apiFetch<{ metrics: MediaMetrics; warning?: string }>('/v1/media/metrics', {
        query: { segmentId, days: String(days), ...(force ? { force: '1' } : {}) },
      })
      apiMetrics.value = { ...apiMetrics.value, [key]: r.metrics }
      apiMetricsWarning.value = { ...apiMetricsWarning.value, [key]: r.warning ?? null }
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

export function loadMediaMonthly(segmentId: string, months: number, force = false): Promise<void> {
  if (!segmentId) return Promise.resolve()
  const key = `${segmentId}:${months}`
  return apiLoadOnce(`media:monthly:${key}`, async () => {
    try {
      const points = await apiFetch<MediaMonthlyPoint[]>('/v1/media/monthly', {
        query: { segmentId, months: String(months) },
      })
      apiMonthly.value = { ...apiMonthly.value, [key]: points }
    } catch {
      // rethrow しない（上の loadMediaMetrics と同じ無限リトライ防止。失敗 = ロード済み・結果 null）
      apiMonthly.value = { ...apiMonthly.value, [key]: null }
    }
  }, force)
}

onApiReset(() => {
  apiMediaArticles.value = {}
  apiMetrics.value = {}
  apiMetricsWarning.value = {}
  apiMonthly.value = {}
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

  /** API: メトリクスのロードが完了したか（null 格納 = 失敗も「完了」。ローディング表示の判定用） */
  function metricsReady(segmentId: string, days = 28): boolean {
    if (!isApi) return true
    return `${segmentId}:${days}` in apiMetrics.value
  }

  /** API: 部分失敗の警告・取得失敗の理由（原則4 の「報告」。なければ null） */
  function metricsWarningFor(segmentId: string, days = 28): string | null {
    if (!isApi) return null
    return apiMetricsWarning.value[`${segmentId}:${days}`] ?? null
  }

  /** API: GA 集計の再取得（サーバーキャッシュも force で飛ばす） */
  async function refreshMetrics(segmentId: string, days = 28): Promise<void> {
    if (!isApi) return
    await loadMediaMetrics(segmentId, days, true).catch(() => { /* 失敗は metricsWarningFor が報告 */ })
  }

  /**
   * 当該セグメントの売上を月次集計（active な売上明細）。
   * 赤黒訂正（correctionOf 付きの相殺行）は「元明細の計上月」へ振り替えて金額・件数を相殺する。
   * 訂正行自身の日付（発生日 = 訂正した日）ではなく元の売上月で相殺しないと、集計月が食い違って
   * 元の売上が過大計上されたままになる（原則6: データフロー整合性）。
   */
  function businessMonthly(segmentId: string, months: string[]): Map<string, { amount: number; orders: number }> {
    const map = new Map<string, { amount: number; orders: number }>()
    for (const m of months) map.set(m, { amount: 0, orders: 0 })
    const all = salesTbl.value as SalesRecord[]
    const byId = new Map(all.map(r => [r.id, r]))
    for (const r of all) {
      if (r.segmentId !== segmentId || r.active === false) continue
      // 訂正行は元明細の計上月へ帰属させる（元が見つからなければ自身の月）
      const originMonth = (r.correctionOf ? byId.get(r.correctionOf)?.salesDate : r.salesDate)?.slice(0, 7)
        ?? r.salesDate.slice(0, 7)
      const cur = map.get(originMonth)
      if (!cur) continue
      cur.amount += r.amount
      // 件数は純額: 訂正（相殺行）は元の受注を 1 件取り消す / 通常の正の明細は 1 件
      if (r.correctionOf) cur.orders -= 1
      else if (r.amount > 0) cur.orders += 1
    }
    // 相殺で負になった件数は 0 でクランプ（表示の健全性）
    for (const v of map.values()) v.orders = Math.max(0, v.orders)
    return map
  }

  /** メディア月次（モック: 決定的導出 / API: GA 実データ。未連携・未ロードは 0 埋め） */
  function mediaMonthlyFor(segmentId: string, months: string[], monthsCount: number): Map<string, MediaMonthlyPoint> {
    if (isApi) {
      const connected = settingFor(segmentId)?.gaConnected === true
      const map = new Map<string, MediaMonthlyPoint>()
      if (connected) {
        void loadMediaMonthly(segmentId, monthsCount)
        // 月キーで突合する（サーバーも「直前の完了月まで」の同じ窓を返すが、境界の日跨ぎに備えてキー一致で読む）
        for (const p of apiMonthly.value[`${segmentId}:${monthsCount}`] ?? []) map.set(p.month, p)
      }
      return map
    }
    const trend = deriveMonthlyMediaTrend(articleInputsFor(segmentId), months, segmentId)
    return new Map(trend.map(p => [p.month, p]))
  }

  /**
   * 業務 × メディアの統合メトリクスを組み立てる（直近 monthsCount ヶ月）。
   * API モードでもメディア未連携・月次ロード中はメディア側 0 で返す（売上側は常に集計 =
   * ダッシュボードの業務軸を止めない。ロード完了の判定は integratedReady）
   */
  function integratedMetricsFor(segmentId: string, monthsCount = 6): IntegratedMetrics {
    // 最終月は直前の完了月（進行中の当月は締め前のため対象外）
    const months = recentMonths(monthsCount, 1)
    const setting = settingFor(segmentId)
    const seg = segmentById(segmentId)
    const mediaBy = mediaMonthlyFor(segmentId, months, monthsCount)
    const biz = businessMonthly(segmentId, months)
    const trend = months.map((month) => {
      const mt = mediaBy.get(month) ?? { month, sessions: 0, users: 0, conversions: 0 }
      const b = biz.get(month) ?? { amount: 0, orders: 0 }
      return { month, sessions: mt.sessions, conversions: mt.conversions, salesAmount: b.amount, orders: b.orders }
    })
    const cur = trend[trend.length - 1]!
    const prev = trend[trend.length - 2] ?? { sessions: 0, conversions: 0, salesAmount: 0, orders: 0 }
    const aov = cur.orders > 0 ? Math.round(cur.salesAmount / cur.orders) : 0
    const salesPerSession = cur.sessions > 0 ? Math.round(cur.salesAmount / cur.sessions) : 0
    return {
      segmentId,
      segmentName: seg?.name ?? 'セグメント',
      siteName: setting?.siteName ?? 'メディア',
      periodMonth: cur.month,
      sessions: cur.sessions,
      conversions: cur.conversions,
      conversionRate: cur.sessions > 0 ? Math.round(cur.conversions / cur.sessions * 10000) / 10000 : 0,
      prevSessions: prev.sessions,
      prevConversions: prev.conversions,
      salesAmount: cur.salesAmount,
      orders: cur.orders,
      prevSalesAmount: prev.salesAmount,
      aov,
      salesPerSession,
      funnel: {
        sessions: cur.sessions,
        engaged: Math.round(cur.sessions * 0.55),
        conversions: cur.conversions,
        orders: cur.orders,
      },
      trend,
    }
  }

  /** API: 統合メトリクスのメディア側（GA 月次）が確定しているか（未連携は「確定」扱い = 0 が正） */
  function integratedReady(segmentId: string, monthsCount = 6): boolean {
    if (!isApi) return true
    const status = settingFor(segmentId)
    if (status?.gaConnected !== true) return true
    return `${segmentId}:${monthsCount}` in apiMonthly.value
  }

  /** API: 統合メトリクスの材料（GA 接続状態 + 月次）を await でそろえる（インサイト生成前に呼ぶ） */
  async function ensureIntegratedLoaded(segmentId: string, monthsCount = 6): Promise<void> {
    if (!isApi) return
    await loadMediaGaStatus(segmentId)
    if (settingFor(segmentId)?.gaConnected !== true) return
    await loadMediaMonthly(segmentId, monthsCount).catch(() => { /* GA 障害時はメディア 0 で続行（原則4） */ })
  }

  return {
    asOf, articleInputsFor, rawArticlesFor, metricsFor, integratedMetricsFor, businessMonthly,
    metricsReady, metricsWarningFor, refreshMetrics, integratedReady, ensureIntegratedLoaded,
  }
}
