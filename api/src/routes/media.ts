/**
 * メディア分析 API（F-40）。mockup useMediaSettings / useMediaAnalytics / useMediaInsight /
 * useMediaArticles の API 版。calendar.ts の Google OAuth 設計（state ノンス・email 突合・
 * AES-256-GCM トークン暗号化・非ブロッキング revoke）を踏襲する。
 *
 * - GA 連携は **segment（業態）単位**（メディアは業態の資産。calendar の per-member と異なる設計判断。
 *   connected_by で連携者を記録する）。スコープは analytics.readonly のみ = カレンダーとは別の同意・別トークン
 * - GA 集計（GA4 Data API batchRunReports）→ MediaMetrics 整形は lib/ga.ts の純粋関数。
 *   GA クォータ対策に 30 分の導出キャッシュ（media_metrics_cache）を持つ（SoT は GA = 記録系ではない）
 * - AI インサイト・記事生成は Vertex AI（generateJson）→ 失敗時は shared/domain の決定的
 *   ヒューリスティックへフォールバック（原則4。weekly_insights と同じ「生成 → 保管 → 再生成で上書き」）
 * - 認可: GA 連携・設定・インベントリの書込は admin のみ（/media/settings 画面の管理者ゲートと一致）。
 *   参照・記事生成・採用・インサイト生成は全ロール可（mockup の画面ゲートと一致）
 * - segment の存在検証は行わない: business_segments は Phase B（0031）でテーブル化済みだが、
 *   FK・参照整合の引き上げは Phase C（記録系移行）の判断まで保留（data-design §1.4/§1.5 参照）
 *
 * エラー: AKO-MEDIA-003 GA 未連携 / 004 GA 集計取得失敗 / 005 連携未設定（GOOGLE_OAUTH_*）/
 *         006 プロパティ一覧取得失敗 / 007 対象記事なし / 008 記事パスの重複 / 011 お題未入力 /
 *         012 生成記事なし / 014 未採用 / 016 統合メトリクス不正（001・002・010・013 はモック専用。
 *         013 の二重採用は API では no-op + warning = 冪等。009・015 は欠番）
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, todayJst } from '../../../shared/domain/jst'
import type { MediaMetrics, MediaMonthlyPoint } from '../../../shared/domain/media-metrics'
import {
  heuristicMediaInsight, type MediaAction, type MediaFinding, type MediaInsight,
} from '../../../shared/domain/media-insight'
import {
  heuristicIntegratedInsight, type IntegratedInsight, type IntegratedMetrics,
} from '../../../shared/domain/media-integrated'
import {
  ARTICLE_PURPOSES, ARTICLE_QUALITIES, ARTICLE_TONES, articleQualityScore, generateArticleDraft,
  type ArticleGenInput, type ArticlePurpose, type ArticleQuality, type ArticleTone,
  type ArticleSectionDraft, type GeneratedArticleDraft,
} from '../../../shared/domain/media-article'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { ApiError, err } from '../lib/errors'
import {
  buildMediaMetrics, buildMonthlyTrend, monthEndOf, recentMonthKeys, type GaReport,
} from '../lib/ga'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { capCp } from '../lib/text'
import { emailFromIdToken, googleOauthEnabled } from './calendar'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GA_DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'
const GA_ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
// カレンダー（calendar/drive）とは別の同意・別のトークン行（ライフサイクル独立）。クライアントは共用
const SCOPES = 'openid email https://www.googleapis.com/auth/analytics.readonly'

/** GA 集計キャッシュの TTL（クォータ対策の短期キャッシュ。force=1 で再取得可） */
const CACHE_TTL = '30 minutes'
/** 分析目的の区分値（SoT はモックの MediaSetting（mockup/app/types/media.ts）。0030 の CHECK と一致させる） */
const MEDIA_GOALS = ['awareness', 'leadgen', 'nurturing', 'conversion', 'branding', 'retention']

function requireEnabled(env: Env): void {
  if (!googleOauthEnabled(env)) {
    throw err('AKO-MEDIA-005', 'Google Analytics 連携が未設定です（GOOGLE_OAUTH_* を設定してください）', 409)
  }
}

/** segmentId クエリ/ボディの検証（形式のみ。存在検証は Phase C の参照整合判断まで保留 = business_segments はテーブル化済み） */
function segmentIdOf(v: unknown): string {
  const id = String(v ?? '').trim()
  if (!id || id.length > 64) throw err('AKO-GEN-001', 'segmentId を指定してください', 400)
  return id
}

/** リクエスト URL からコールバック URI を組み立てる（calendar.ts と同型。Cloud Run の x-forwarded-proto 対応） */
function redirectUri(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${url.host}/v1/media/oauth/callback`
}

// ---------- OAuth state（一回性 + 10 分 TTL。calendar と同型 + segment_id） ----------

async function issueState(pool: pg.Pool, memberId: string, segmentId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await pool.query(`DELETE FROM media_oauth_states WHERE created_at < now() - interval '10 minutes'`)
  await pool.query(
    `INSERT INTO media_oauth_states (nonce, member_id, segment_id) VALUES ($1, $2, $3)`,
    [nonce, memberId, segmentId])
  return nonce
}

async function consumeState(pool: pg.Pool, state: string): Promise<{ memberId: string; segmentId: string } | null> {
  if (!state || state.length > 128) return null
  const { rows } = await pool.query<{ memberId: string; segmentId: string }>(
    `DELETE FROM media_oauth_states
     WHERE nonce = $1 AND created_at >= now() - interval '10 minutes'
     RETURNING member_id AS "memberId", segment_id AS "segmentId"`, [state])
  return rows[0] ?? null
}

// ---------- GA トークン（segment 単位。calendar accessTokenFor と同型） ----------

interface GaTokenRow {
  propertyId: string | null
  propertyName: string | null
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: string | null
}

async function gaTokenRow(pool: pg.Pool, segmentId: string): Promise<GaTokenRow | null> {
  const { rows } = await pool.query<GaTokenRow>(
    `SELECT property_id AS "propertyId", property_name AS "propertyName",
            access_token_enc AS "accessTokenEnc", refresh_token_enc AS "refreshTokenEnc",
            expires_at AS "expiresAt"
     FROM media_ga_tokens WHERE segment_id = $1`, [segmentId])
  return rows[0] ?? null
}

/**
 * 有効なアクセストークン + 選択済みプロパティ（期限切れは refresh。取得不可 = null → AKO-MEDIA-003）。
 * calendar.ts の accessTokenFor / issueState と同型だが**共通化しない設計判断**（原則3 の例外）:
 * キー（member_id vs segment_id）・テーブル・回復導線（再連携の単位が本人 vs 業態）が異なり、
 * 抽象化すると障害切り分け時にどちらのフローか読みにくくなる。refresh 手順を変更する際は
 * calendar.ts 側と併せて確認すること
 */
async function gaAccess(
  pool: pg.Pool, env: Env, segmentId: string,
): Promise<{ token: string; propertyId: string | null } | null> {
  const row = await gaTokenRow(pool, segmentId)
  if (!row) return null
  const notExpired = !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now() + 60_000
  if (notExpired) {
    const token = decryptSecret(row.accessTokenEnc, env.tokenEncryptionKey)
    return token ? { token, propertyId: row.propertyId } : null
  }
  const refreshToken = row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc, env.tokenEncryptionKey) : null
  if (!refreshToken) return null
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        client_id: env.googleOauthClientId,
        client_secret: env.googleOauthClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) return null
    const body = await res.json() as { access_token: string; expires_in: number }
    await pool.query(
      `UPDATE media_ga_tokens SET access_token_enc = $2, expires_at = $3, updated_at = now() WHERE segment_id = $1`,
      [segmentId, encryptSecret(body.access_token, env.tokenEncryptionKey),
        new Date(Date.now() + body.expires_in * 1000).toISOString()])
    return { token: body.access_token, propertyId: row.propertyId }
  } catch {
    return null
  }
}

// ---------- GA 集計キャッシュ ----------

async function cachedPayload<T>(pool: pg.Pool, segmentId: string, cacheKey: string): Promise<T | null> {
  const { rows } = await pool.query<{ payload: T }>(
    `SELECT payload FROM media_metrics_cache
     WHERE segment_id = $1 AND cache_key = $2 AND fetched_at > now() - interval '${CACHE_TTL}'`,
    [segmentId, cacheKey])
  return rows[0]?.payload ?? null
}

async function putCache(pool: pg.Pool, segmentId: string, cacheKey: string, payload: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO media_metrics_cache (segment_id, cache_key, payload, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (segment_id, cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [segmentId, cacheKey, JSON.stringify(payload)])
}

/** インベントリ変更・連携変更時のキャッシュ破棄（SoT の変化 → 依存する導出キャッシュを無効化 = 原則6） */
async function clearMetricsCache(pool: pg.Pool, segmentId: string): Promise<void> {
  await pool.query(`DELETE FROM media_metrics_cache WHERE segment_id = $1`, [segmentId])
}

// ---------- GA4 Data API 呼び出し ----------

/** GA 呼び出し失敗の分類（ステータス + 理由コードで判別。原因により利用者への案内・リトライ可否が異なる） */
export type GaFailReason = 'api-disabled' | 'permission' | 'quota' | 'other'
/** detail = GA の実エラー理由（利用者向け報告に付加。本番障害 2026-07-29 で原因が画面から見えなかった対策） */
type BatchResult = { ok: true; reports: GaReport[] } | { ok: false; reason: GaFailReason; detail: string }

/**
 * 失敗理由の分類（純粋関数・単体テスト対象）。
 * - quota（429 / RESOURCE_EXHAUSTED）: リトライしても悪化するだけ → per-report ファンアウトを抑止する（P2）
 * - api-disabled / permission: 確定的失敗 → 同じくファンアウト無意味
 * - other（タイムアウト・5xx・バッチ固有の 400 等）: レポート単位で切り分け可能 → ファンアウト対象
 */
export function gaFailReasonOf(status: number, bodyTxt: string): GaFailReason {
  if (status === 429 || /RESOURCE_EXHAUSTED|Quota exceeded|quota/i.test(bodyTxt)) return 'quota'
  if (status !== 403) return 'other'
  if (/accessNotConfigured|SERVICE_DISABLED/.test(bodyTxt)) return 'api-disabled'
  if (/PERMISSION_DENIED|does not have sufficient permissions|insufficientPermissions/i.test(bodyTxt)) return 'permission'
  return 'other'
}

/** バッチ失敗後に per-report リトライ（ファンアウト）してよいか（P2: クォータ枯渇・確定的失敗では追い打ちしない） */
export function shouldFanOut(reason: GaFailReason): boolean {
  return reason === 'other'
}

/**
 * GA エラーボディから利用者に見せる実エラー理由を抽出する（純粋関数・単体テスト対象）。
 * 本番障害 2026-07-29: 生エラーがサーバーログにしか出ず、オペレーターが画面から原因診断できなかったため、
 * warning / エラーメッセージへ先頭 150 字を付加する（トークン等の機密は GA エラー本文に含まれない）
 */
export function gaErrorDetailOf(bodyTxt: string): string {
  let msg = bodyTxt
  try {
    const parsed = JSON.parse(bodyTxt) as { error?: { message?: string } }
    if (parsed.error?.message) msg = parsed.error.message
  } catch { /* JSON でない（HTML エラーページ等）は生テキストの先頭を使う */ }
  return capCp(msg.replace(/\s+/g, ' ').trim(), 150)
}

/** 集計取得失敗（AKO-MEDIA-004）の利用者向けメッセージ（理由別。detail = GA の実エラー理由） */
function gaFetchError(reason: GaFailReason, detail = ''): ApiError {
  if (reason === 'api-disabled') {
    return err('AKO-MEDIA-004',
      'Google Analytics Data API が利用できません。管理者は GCP プロジェクトで Google Analytics Data API を有効化してください', 502)
  }
  if (reason === 'permission') {
    return err('AKO-MEDIA-004',
      '連携した Google アカウントに GA4 プロパティへのアクセス権がありません。GA 側の権限を確認するか、メディア設定からプロパティを選び直してください', 502)
  }
  if (reason === 'quota') {
    return err('AKO-MEDIA-004',
      `Google Analytics のクォータ上限に達しました${detail ? `（GA 応答: ${detail}）` : ''}。時間をおいて再試行してください`, 502)
  }
  return err('AKO-MEDIA-004',
    `Google Analytics からの集計取得に失敗しました${detail ? `（GA 応答: ${detail}）` : ''}。時間をおいて再試行してください`, 502)
}

/** batchRunReports（最大 5 リクエスト/バッチ）。失敗は例外にせず結果型で返す（呼び出し側がグレースフルに扱う） */
async function runBatch(
  token: string, propertyId: string, requests: unknown[], timeoutMs = 15_000,
): Promise<BatchResult> {
  try {
    const res = await fetch(`${GA_DATA_BASE}/${propertyId}:batchRunReports`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ requests }),
    })
    if (!res.ok) {
      const bodyTxt = await res.text()
      console.warn('ga batchRunReports failed:', res.status, bodyTxt.slice(0, 300))
      return { ok: false, reason: gaFailReasonOf(res.status, bodyTxt), detail: gaErrorDetailOf(bodyTxt) }
    }
    const body = await res.json() as { reports?: GaReport[] }
    return { ok: true, reports: body.reports ?? [] }
  } catch (e) {
    console.warn('ga batchRunReports failed:', (e as Error).message)
    return { ok: false, reason: 'other', detail: capCp((e as Error).message, 150) }
  }
}

/** 単発 runReport（バッチ全滅時の per-report リトライ用。本番障害 2026-07-29 の自己回復経路） */
async function runReport(
  token: string, propertyId: string, request: unknown, timeoutMs: number,
): Promise<{ ok: true; report: GaReport } | { ok: false; reason: GaFailReason; detail: string }> {
  try {
    const res = await fetch(`${GA_DATA_BASE}/${propertyId}:runReport`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      const bodyTxt = await res.text()
      console.warn('ga runReport failed:', res.status, bodyTxt.slice(0, 300))
      return { ok: false, reason: gaFailReasonOf(res.status, bodyTxt), detail: gaErrorDetailOf(bodyTxt) }
    }
    return { ok: true, report: await res.json() as GaReport }
  } catch (e) {
    console.warn('ga runReport failed:', (e as Error).message)
    return { ok: false, reason: 'other', detail: capCp((e as Error).message, 150) }
  }
}

const dateRange = (from: string, to: string): { startDate: string; endDate: string } => ({ startDate: from, endDate: to })
const metric = (name: string): { name: string } => ({ name })
const dimension = (name: string): { name: string } => ({ name })

/** 内訳レポートのキー（利用不能マーカー unavailable の語彙。フロントは該当ビジュアライゼーションを隠す = P1） */
export type DetailKey = 'daily' | 'channels' | 'devices' | 'topPages' | 'prevPages'

export interface MetricsResult {
  metrics: MediaMetrics
  warning?: string
  /**
   * 取得できなかった内訳（P1）。buildMediaMetrics の null 防御は欠落を「ゼロ埋め・空配列」へ正規化するため、
   * そのまま描画すると一過性の失敗が「実トラフィック = ゼロ」の顔で表示される。フロントはこのマーカーで
   * 該当ビジュアライゼーションを「取得できませんでした」表示に置き換える（ゼロデータとして描画しない）。
   * 空 = 全内訳が有効（キャッシュされるのはこの状態のみ）
   */
  unavailable?: DetailKey[]
}

/**
 * GA4 から MediaMetrics を組み立てる（30 分キャッシュ利用）。
 * - 集計基準日は JST の前日（asOf。週次インサイトと同じ「当日を未確定として悲観評価しない」思想）。
 *   GA プロパティのタイムゾーンが JST 以外の場合、日単位のずれは許容する（設計判断。lib/ga.ts 冒頭）
 * - 総計（当期/前期）が取れなければ全滅 = AKO-MEDIA-004。内訳バッチの失敗は空配列 + warning（原則4）
 */
// export はモック fetch による回帰テスト用（429 でファンアウトしない・unavailable の貫通 = P1/P2）
export async function fetchMediaMetrics(
  pool: pg.Pool, env: Env, segmentId: string, days: number, force: boolean,
): Promise<MetricsResult> {
  requireEnabled(env)
  const access = await gaAccess(pool, env, segmentId)
  if (!access?.token || !access.propertyId) {
    throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。メディア設定から連携してください', 409)
  }
  const cacheKey = `metrics:${days}`
  if (!force) {
    const cached = await cachedPayload<MetricsResult>(pool, segmentId, cacheKey)
    if (cached) return cached
  }

  const asOf = addDays(todayJst(), -1)
  const periodTo = asOf
  const periodFrom = addDays(periodTo, -(days - 1))
  const prevTo = addDays(periodFrom, -1)
  const prevFrom = addDays(prevTo, -(days - 1))

  // インベントリ（セクション対応 + articleCount の SoT はアプリ。集計値は GA が SoT）
  const { rows: articles } = await pool.query<{ path: string; section: string }>(
    `SELECT path, section FROM media_articles
     WHERE segment_id = $1 AND active = true AND status = 'published' AND published_at <= $2::date`,
    [segmentId, periodTo])
  const { rows: settingRows } = await pool.query<{ siteName: string }>(
    `SELECT site_name AS "siteName" FROM media_settings WHERE segment_id = $1`, [segmentId])
  const siteName = settingRows[0]?.siteName || 'メディア'

  // 総計メトリクス。GA4 の conversions は廃止済み → keyEvents を使う（lib/ga.ts 冒頭の注記参照）
  const TOTAL_METRICS = ['sessions', 'totalUsers', 'newUsers', 'screenPageViews',
    'userEngagementDuration', 'engagementRate', 'bounceRate', 'keyEvents'].map(metric)
  // dateRanges を 2 本渡すと rows に dateRange 次元が自動追加されるため、当期/前期は別リクエストにする
  const totalsBatch = await runBatch(access.token, access.propertyId, [
    { dateRanges: [dateRange(periodFrom, periodTo)], metrics: TOTAL_METRICS },
    { dateRanges: [dateRange(prevFrom, prevTo)], metrics: TOTAL_METRICS },
  ])
  if (!totalsBatch.ok) throw gaFetchError(totalsBatch.reason, totalsBatch.detail)

  // 内訳（日別・チャネル・デバイス・記事別 + 前期の記事別 PV）。失敗しても総計は返す（原則4）。
  // 内訳は limit 10000 のページ別 × 2 を含み総計より重いため、タイムアウトを長めに取る
  // （本番障害 2026-07-29: 15 秒では内訳バッチのみタイムアウトし「総計のみ表示」が常態化した疑い）
  const DETAIL_TIMEOUT_MS = 25_000
  const detailDefs: { key: DetailKey; label: string; request: unknown }[] = [
    {
      key: 'daily',
      label: '日別',
      request: {
        dateRanges: [dateRange(periodFrom, periodTo)],
        dimensions: [dimension('date')],
        metrics: ['sessions', 'totalUsers', 'keyEvents'].map(metric),
        limit: '400',
      },
    },
    {
      key: 'channels',
      label: 'チャネル別',
      request: {
        dateRanges: [dateRange(periodFrom, periodTo)],
        dimensions: [dimension('sessionDefaultChannelGroup')],
        metrics: ['sessions', 'keyEvents'].map(metric),
        limit: '50',
      },
    },
    {
      key: 'devices',
      label: 'デバイス別',
      request: {
        dateRanges: [dateRange(periodFrom, periodTo)],
        dimensions: [dimension('deviceCategory')],
        metrics: ['sessions'].map(metric),
        limit: '10',
      },
    },
    {
      key: 'topPages',
      label: '記事別',
      request: {
        dateRanges: [dateRange(periodFrom, periodTo)],
        dimensions: ['pagePath', 'pageTitle'].map(dimension),
        // 注意: `entrances` は GA4 Data API の**無効メトリクス**（本番 GA 応答「Field entrances is not a
        // valid metric」で確定 = 記事別レポート単体失敗の根本原因。2026-07-29）。UA 時代の名前で GA4 UI には
        // 表示があるが Data API には存在しない。UI・インサイトの消費実績もないため型ごと削除した
        metrics: ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'].map(metric),
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        // セクション集計は「サイト全体の内訳」として表示するため全ページ母集団が必要（Codex 指摘 3）。
        // 表示上限（topPages 12 件）は整形側の slice が担い、レスポンス/キャッシュには整形後の
        // MediaMetrics のみが載るため limit を上げてもキャッシュサイズへの影響は軽微。
        // 10000 (path,title) 組超の超ロングテールは打ち切りを許容（PV 降順のため影響は極小）
        limit: '10000',
      },
    },
    {
      key: 'prevPages',
      label: '前期比（記事別）',
      request: {
        dateRanges: [dateRange(prevFrom, prevTo)],
        dimensions: [dimension('pagePath')],
        metrics: ['screenPageViews'].map(metric),
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        // 前期比の突合先も同じ母集団を確保する（打ち切りによる prevPageviews=0 の誤判定を防ぐ）
        limit: '10000',
      },
    },
  ]
  const detailBatch = await runBatch(access.token, access.propertyId, detailDefs.map(d => d.request), DETAIL_TIMEOUT_MS)
  let detailReports: (GaReport | null)[]
  const failedLabels: string[] = []
  const unavailable: DetailKey[] = []
  let gaDetail = ''
  let reasonNote = ''
  if (detailBatch.ok) {
    detailReports = detailDefs.map((_, i) => detailBatch.reports[i] ?? null)
  } else if (shouldFanOut(detailBatch.reason)) {
    // バッチは all-or-nothing のため、1 レポートの問題（互換性 400・タイムアウト・5xx）が
    // 5 つ全部を道連れにする。個別 runReport で**並行リトライ**し、取れた内訳だけ表示 +
    // 失敗した内訳名と GA の実エラー理由を warning で報告する（原則4 の粒度を per-report へ。
    // 原因が事前に確定できなくても本番で自己診断・自己回復できる設計。本番障害 2026-07-29）
    console.warn('ga detail batch failed → per-report retry:', detailBatch.detail)
    const token = access.token
    const propertyId = access.propertyId
    const singles = await Promise.all(
      detailDefs.map(d => runReport(token, propertyId, d.request, DETAIL_TIMEOUT_MS)))
    detailReports = singles.map(s => (s.ok ? s.report : null))
    singles.forEach((s, i) => {
      if (!s.ok) {
        failedLabels.push(detailDefs[i]!.label)
        unavailable.push(detailDefs[i]!.key)
        if (!gaDetail) gaDetail = s.detail
      }
    })
  } else {
    // クォータ枯渇（429）・確定的失敗（API 無効・権限なし）ではファンアウトしない（P2:
    // 枯渇したプロパティへ 5 本の追い打ちはクォータ消費を倍増させ、他ユーザーの障害を長引かせる）
    console.warn(`ga detail batch failed (${detailBatch.reason}) → per-report retry skipped:`, detailBatch.detail)
    detailReports = detailDefs.map(() => null)
    failedLabels.push(...detailDefs.map(d => d.label))
    unavailable.push(...detailDefs.map(d => d.key))
    gaDetail = detailBatch.detail
    reasonNote = detailBatch.reason === 'quota'
      ? 'Google Analytics のクォータ上限。'
      : detailBatch.reason === 'api-disabled' ? 'Data API が無効。' : 'プロパティへのアクセス権なし。'
  }

  const metrics = buildMediaMetrics({
    totals: totalsBatch.reports[0] ?? null,
    prevTotals: totalsBatch.reports[1] ?? null,
    daily: detailReports[0] ?? null,
    channels: detailReports[1] ?? null,
    devices: detailReports[2] ?? null,
    topPages: detailReports[3] ?? null,
    prevPages: detailReports[4] ?? null,
  }, { segmentId, siteName, periodFrom, periodTo, days, articles })

  // 失敗した内訳のみを名指しで報告（全滅は「総計のみ」・一部なら取れた内訳は表示している旨が伝わる文言）
  const detailSuffix = `${reasonNote || gaDetail ? `（${reasonNote}${gaDetail ? `GA 応答: ${gaDetail}` : ''}）` : ''}。時間をおいて再試行してください`
  const warning = failedLabels.length === 0
    ? undefined
    : failedLabels.length === detailDefs.length
      ? `内訳（日別・チャネル・デバイス・記事別）の取得に失敗したため、総計のみ表示しています${detailSuffix}`
      : `一部の内訳（${failedLabels.join('・')}）の取得に失敗しました${detailSuffix}`
  const result: MetricsResult = { metrics, warning, unavailable }
  // 部分失敗の結果は 30 分固定化しない（次回リクエストで再試行させる）
  if (!result.warning) await putCache(pool, segmentId, cacheKey, result)
  return result
}

/** 月次トレンド（統合 PDCA 用。最終月 = 直前の完了月。30 分キャッシュ） */
async function fetchMonthlyTrend(
  pool: pg.Pool, env: Env, segmentId: string, months: number, force: boolean,
): Promise<MediaMonthlyPoint[]> {
  requireEnabled(env)
  const access = await gaAccess(pool, env, segmentId)
  if (!access?.token || !access.propertyId) {
    throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。メディア設定から連携してください', 409)
  }
  const cacheKey = `monthly:${months}`
  if (!force) {
    const cached = await cachedPayload<MediaMonthlyPoint[]>(pool, segmentId, cacheKey)
    if (cached) return cached
  }
  const monthKeys = recentMonthKeys(months, 1, todayJst())
  const first = monthKeys[0]!
  const last = monthKeys[monthKeys.length - 1]!
  // engagedSessions = 統合ファネルの「主体的関与」の実測（擬似係数 0.55 の置換。m4）。
  // タイムアウトは内訳と同じ 25 秒 + 失敗時は GA の実エラー理由をメッセージへ付加（本番障害 2026-07-29）
  const batch = await runBatch(access.token, access.propertyId, [{
    dateRanges: [dateRange(`${first}-01`, monthEndOf(last))],
    dimensions: [dimension('yearMonth')],
    metrics: ['sessions', 'totalUsers', 'keyEvents', 'engagedSessions'].map(metric),
    limit: '100',
  }], 25_000)
  if (!batch.ok) throw gaFetchError(batch.reason, batch.detail)
  const points = buildMonthlyTrend(batch.reports[0] ?? null, monthKeys)
  await putCache(pool, segmentId, cacheKey, points)
  return points
}

// ---------- メディア設定の部分更新（純粋関数・単体テスト対象） ----------

export interface MediaSettingsPatch {
  siteName?: string
  siteUrl?: string
  analysisGoal?: string
  targetAudience?: string
  defaultTone?: string
  keywords?: string[]
  active?: boolean
}

/**
 * リクエスト body に**実在するキーのみ**を更新対象にする（Object.hasOwn）。
 * CLAUDE.md の Zod v4 注意（.partial() が default 値を注入して未指定列を上書きする実障害）を踏まえ、
 * zod を使わず手動フィルタで「送っていないフィールドの保持」を構造的に保証する。
 */
export function settingsPatchOf(body: Record<string, unknown>): MediaSettingsPatch {
  const out: MediaSettingsPatch = {}
  if (Object.hasOwn(body, 'siteName')) out.siteName = capCp(String(body.siteName ?? '').trim(), 100)
  if (Object.hasOwn(body, 'siteUrl')) out.siteUrl = capCp(String(body.siteUrl ?? '').trim(), 500)
  if (Object.hasOwn(body, 'targetAudience')) out.targetAudience = capCp(String(body.targetAudience ?? '').trim(), 500)
  if (Object.hasOwn(body, 'analysisGoal')) {
    const v = String(body.analysisGoal ?? '')
    if (!MEDIA_GOALS.includes(v)) throw err('AKO-GEN-001', `analysisGoal が不正です: ${capCp(v, 30)}`, 400)
    out.analysisGoal = v
  }
  if (Object.hasOwn(body, 'defaultTone')) {
    const v = String(body.defaultTone ?? '')
    if (!(ARTICLE_TONES as string[]).includes(v)) throw err('AKO-GEN-001', `defaultTone が不正です: ${capCp(v, 30)}`, 400)
    out.defaultTone = v
  }
  if (Object.hasOwn(body, 'keywords')) {
    if (!Array.isArray(body.keywords)) throw err('AKO-GEN-001', 'keywords は配列で指定してください', 400)
    out.keywords = body.keywords.map(k => capCp(String(k).trim(), 40)).filter(Boolean).slice(0, 20)
  }
  if (Object.hasOwn(body, 'active')) out.active = body.active === true
  return out
}

const SETTING_COLS = `id, segment_id AS "segmentId", site_name AS "siteName", site_url AS "siteUrl",
  analysis_goal AS "analysisGoal", target_audience AS "targetAudience", default_tone AS "defaultTone",
  keywords, active`

// ---------- インサイトのヒント抽出・LLM 出力の正規化（純粋関数・単体テスト対象） ----------

/** 保管済みメディアインサイトから記事生成のヒント文を取り出す（mockup hintsFromInsight と同一ロジック） */
export function insightHintsOf(insight: unknown): string[] {
  const rec = insight as { articles?: unknown; siteStructure?: unknown } | null
  const findings = [
    ...(Array.isArray(rec?.articles) ? rec.articles : []),
    ...(Array.isArray(rec?.siteStructure) ? rec.siteStructure : []),
  ] as { kind?: string; title?: string }[]
  return findings
    .filter(f => f && (f.kind === 'opportunity' || f.kind === 'issue'))
    .map(f => capCp(String(f.title ?? ''), 80))
    .filter(Boolean)
    .slice(0, 3)
}

const strArr = (v: unknown, max: number, cap: number): string[] =>
  (Array.isArray(v) ? v : []).slice(0, max).map(x => capCp(String(x), cap))

function findings(v: unknown): MediaFinding[] {
  return (Array.isArray(v) ? v : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .slice(0, 6)
    .map(f => ({
      kind: (f.kind === 'win' || f.kind === 'issue' ? f.kind : 'opportunity') as MediaFinding['kind'],
      title: capCp(String(f.title ?? ''), 80),
      detail: capCp(String(f.detail ?? ''), 300),
    }))
    .filter(f => f.title.length > 0)
}

function mediaActions(v: unknown): MediaAction[] {
  return (Array.isArray(v) ? v : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .slice(0, 6)
    .map(a => ({
      title: capCp(String(a.title ?? ''), 80),
      detail: capCp(String(a.detail ?? ''), 300),
      priority: (a.priority === 'high' || a.priority === 'low' ? a.priority : 'mid') as 'high' | 'mid' | 'low',
    }))
    .filter(a => a.title.length > 0)
}

/** LLM 出力 → MediaInsight（欠落・型崩れは null = ヒューリスティックへフォールバック） */
export function normalizeMediaInsight(res: unknown): MediaInsight | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !String(r.executiveSummary ?? '').trim()) return null
  return {
    executiveSummary: capCp(String(r.executiveSummary), 1200),
    siteStructure: findings(r.siteStructure),
    articles: findings(r.articles),
    actions: mediaActions(r.actions),
  }
}

/** LLM 出力 → IntegratedInsight（欠落・型崩れは null） */
export function normalizeIntegratedInsight(res: unknown): IntegratedInsight | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !String(r.executiveSummary ?? '').trim()) return null
  const pdca = (r.pdca ?? {}) as Record<string, unknown>
  return {
    executiveSummary: capCp(String(r.executiveSummary), 1200),
    correlation: strArr(r.correlation, 5, 300),
    pdca: {
      plan: strArr(pdca.plan, 5, 200),
      do: strArr(pdca.do, 5, 200),
      check: strArr(pdca.check, 6, 300),
      act: strArr(pdca.act, 5, 200),
    },
    actions: mediaActions(r.actions),
    risks: (Array.isArray(r.risks) ? r.risks : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .slice(0, 4)
      .map(x => ({
        title: capCp(String(x.title ?? ''), 80),
        severity: (x.severity === 'high' || x.severity === 'low' ? x.severity : 'mid') as 'high' | 'mid' | 'low',
        mitigation: capCp(String(x.mitigation ?? ''), 200),
      }))
      .filter(x => x.title.length > 0),
  }
}

// ---------- 統合メトリクスの受領検証・サーバー突合（M2。純粋関数・単体テスト対象） ----------

/** 有限・非負・上限内の数値のみ通す（それ以外は null = 全体を 400 で拒否） */
function boundedNum(v: unknown, max: number): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null
}
const COUNT_MAX = 1e9 // 件数系（セッション・CV・受注）の上限
const YEN_MAX = 1e12 // 金額系（円）の上限

/**
 * クライアント合成の統合メトリクスを**既知キーのみの whitelist へ正規化**する。
 * 欠落・型崩れ・非有限・負数・範囲外は null（呼び出し側が AKO-MEDIA-016 の 400 = 想定エラーで拒否し、
 * heuristic の TypeError → 500 や、型崩れ jsonb の保管・LLM プロンプトへの逐語挿入を経路ごと塞ぐ）。
 * 文字列は cap（プロンプトインジェクション面の縮小）。unknown キーは捨てる
 */
export function normalizeIntegratedMetrics(raw: unknown): IntegratedMetrics | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const periodMonth = String(r.periodMonth ?? '')
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return null
  if (!Array.isArray(r.trend) || r.trend.length === 0 || r.trend.length > 24) return null
  const trend: IntegratedMetrics['trend'] = []
  for (const t of r.trend) {
    const o = t as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || !/^\d{4}-\d{2}$/.test(String(o.month ?? ''))) return null
    const sessions = boundedNum(o.sessions, COUNT_MAX)
    const conversions = boundedNum(o.conversions, COUNT_MAX)
    const salesAmount = boundedNum(o.salesAmount, YEN_MAX)
    const orders = boundedNum(o.orders, COUNT_MAX)
    if (sessions === null || conversions === null || salesAmount === null || orders === null) return null
    trend.push({
      month: String(o.month),
      sessions: Math.round(sessions),
      conversions: Math.round(conversions),
      salesAmount: Math.round(salesAmount),
      orders: Math.round(orders),
    })
  }
  const f = (r.funnel ?? {}) as Record<string, unknown>
  const n = {
    sessions: boundedNum(r.sessions, COUNT_MAX),
    conversions: boundedNum(r.conversions, COUNT_MAX),
    prevSessions: boundedNum(r.prevSessions, COUNT_MAX),
    prevConversions: boundedNum(r.prevConversions, COUNT_MAX),
    salesAmount: boundedNum(r.salesAmount, YEN_MAX),
    orders: boundedNum(r.orders, COUNT_MAX),
    prevSalesAmount: boundedNum(r.prevSalesAmount, YEN_MAX),
    fSessions: boundedNum(f.sessions, COUNT_MAX),
    fEngaged: boundedNum(f.engaged, COUNT_MAX),
    fConversions: boundedNum(f.conversions, COUNT_MAX),
    fOrders: boundedNum(f.orders, COUNT_MAX),
  }
  if (Object.values(n).some(v => v === null)) return null
  const sessions = Math.round(n.sessions!)
  const conversions = Math.round(n.conversions!)
  const salesAmount = Math.round(n.salesAmount!)
  const orders = Math.round(n.orders!)
  return {
    segmentId: capCp(String(r.segmentId ?? ''), 64),
    segmentName: capCp(String(r.segmentName ?? 'セグメント'), 100),
    siteName: capCp(String(r.siteName ?? 'メディア'), 100),
    periodMonth,
    sessions,
    conversions,
    // 派生値（CVR・平均受注額・セッションあたり売上）は申告値を使わず検証済みの元値から再計算する
    // （申告値の捏造余地をなくす + GA の keyEvents はセッション数を超えうるため CVR に上限検証を課さない）
    conversionRate: sessions > 0 ? Math.round(conversions / sessions * 10000) / 10000 : 0,
    prevSessions: Math.round(n.prevSessions!),
    prevConversions: Math.round(n.prevConversions!),
    salesAmount,
    orders,
    prevSalesAmount: Math.round(n.prevSalesAmount!),
    aov: orders > 0 ? Math.round(salesAmount / orders) : 0,
    salesPerSession: sessions > 0 ? Math.round(salesAmount / sessions) : 0,
    funnel: {
      sessions: Math.round(n.fSessions!),
      engaged: Math.round(n.fEngaged!),
      conversions: Math.round(n.fConversions!),
      orders: Math.round(n.fOrders!),
    },
    trend,
  }
}

/**
 * メディア軸（sessions / conversions / engaged）を**サーバーが GA から導出した月次で上書き**する（M2）。
 * クライアント申告値を信頼せず、GA 連携済みならメディア軸はサーバー導出が正。
 * サーバー窓に無い月は 0（GA にデータなし = 捏造月の持ち込みを防ぐ）。売上軸（salesAmount / orders / aov）は
 * モック側 SoT のため上書きしない。派生値（CVR・セッションあたり売上・ファネル）は上書き後に再計算する
 */
export function applyServerMediaAxis(m: IntegratedMetrics, points: MediaMonthlyPoint[]): IntegratedMetrics {
  const by = new Map(points.map(p => [p.month, p]))
  const trend = m.trend.map(t => ({
    ...t,
    sessions: by.get(t.month)?.sessions ?? 0,
    conversions: by.get(t.month)?.conversions ?? 0,
  }))
  const cur = trend[trend.length - 1]
  const prev = trend.length > 1 ? trend[trend.length - 2] : undefined
  const sessions = cur?.sessions ?? 0
  const conversions = cur?.conversions ?? 0
  const curPoint = cur ? by.get(cur.month) : undefined
  return {
    ...m,
    trend,
    sessions,
    conversions,
    conversionRate: sessions > 0 ? Math.round(conversions / sessions * 10000) / 10000 : 0,
    prevSessions: prev?.sessions ?? 0,
    prevConversions: prev?.conversions ?? 0,
    salesPerSession: sessions > 0 ? Math.round((cur?.salesAmount ?? 0) / sessions) : 0,
    funnel: {
      sessions,
      // 主体的関与は GA の engagedSessions 実測。旧キャッシュ等で無い場合のみ従来係数で近似（m4）
      engaged: curPoint?.engagedSessions ?? Math.round(sessions * 0.55),
      conversions,
      orders: m.funnel.orders,
    },
  }
}

/**
 * LLM 出力 → GeneratedArticleDraft（title / body 欠落は null = 決定的生成へフォールバック）。
 * purpose/quality/tone/qualityScore は入力から決定的に付与する（LLM の自己申告に依存しない）
 */
export function normalizeArticleDraft(res: unknown, input: ArticleGenInput): GeneratedArticleDraft | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const title = capCp(String(r.title ?? '').trim(), 120)
  const body = capCp(String(r.body ?? '').trim(), 20000)
  if (!title || !body) return null
  const outline: ArticleSectionDraft[] = (Array.isArray(r.outline) ? r.outline : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .slice(0, 8)
    .map(s => ({ heading: capCp(String(s.heading ?? ''), 80), points: strArr(s.points, 5, 200) }))
    .filter(s => s.heading.length > 0)
  const est = Number(r.estWordCount)
  return {
    title,
    metaDescription: capCp(String(r.metaDescription ?? '').trim(), 300),
    outline,
    body,
    suggestedKeywords: strArr(r.suggestedKeywords, 8, 40).filter(Boolean),
    estWordCount: Number.isFinite(est) && est > 0 ? Math.round(est) : [...body].length,
    qualityScore: articleQualityScore(input),
    purpose: input.purpose,
    quality: input.quality,
    tone: input.tone,
  }
}

// ---------- Vertex AI 呼び出し（失敗・無効環境は null → 決定的フォールバック。原則4） ----------

const FINDING_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { kind: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
    required: ['kind', 'title', 'detail'],
  },
}
const ACTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { title: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string' } },
    required: ['title', 'detail', 'priority'],
  },
}

async function llmMediaInsight(env: Env, metrics: MediaMetrics): Promise<MediaInsight | null> {
  if (!env.vertexProjectId) return null
  const res = await generateJson<MediaInsight>(env, {
    system: 'あなたはオウンドメディアのアクセス解析コンサルタント AI です。Google Analytics の集計から、'
      + 'サイト構成・記事へのインサイトと「次に起こすべきアクション」を日本語で出力します。'
      + '集計値にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'executiveSummary は 3〜5 文（マークダウン可）。kind は win / issue / opportunity、'
      + 'priority は high / mid / low。各 title は 40 字以内・detail は具体的かつ簡潔に（最大 各 5 件）。',
    prompt: `# メディア集計（${metrics.periodFrom}〜${metrics.periodTo}・${metrics.days} 日間）\n${JSON.stringify(metrics, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        siteStructure: FINDING_SCHEMA,
        articles: FINDING_SCHEMA,
        actions: ACTION_SCHEMA,
      },
      required: ['executiveSummary', 'siteStructure', 'articles', 'actions'],
    },
    maxTokens: 3000,
  })
  return normalizeMediaInsight(res)
}

async function llmIntegratedInsight(env: Env, metrics: IntegratedMetrics): Promise<IntegratedInsight | null> {
  if (!env.vertexProjectId) return null
  const res = await generateJson<IntegratedInsight>(env, {
    system: 'あなたは事業会社の経営参謀 AI です。オウンドメディアの流入（GA）と業務の売上・受注を突き合わせ、'
      + '相関の読み・PDCA・次アクション・リスクを日本語で出力します。'
      + '集計値にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'executiveSummary は 3〜4 文。pdca の各象限・correlation は簡潔に（各 5 件以内）。'
      + 'priority / severity は high / mid / low。',
    prompt: `# 業務 × メディア統合集計（対象月 ${metrics.periodMonth}）\n${JSON.stringify(metrics, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        correlation: { type: 'array', items: { type: 'string' } },
        pdca: {
          type: 'object',
          properties: {
            plan: { type: 'array', items: { type: 'string' } },
            do: { type: 'array', items: { type: 'string' } },
            check: { type: 'array', items: { type: 'string' } },
            act: { type: 'array', items: { type: 'string' } },
          },
          required: ['plan', 'do', 'check', 'act'],
        },
        actions: ACTION_SCHEMA,
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, severity: { type: 'string' }, mitigation: { type: 'string' } },
            required: ['title', 'severity', 'mitigation'],
          },
        },
      },
      required: ['executiveSummary', 'correlation', 'pdca', 'actions', 'risks'],
    },
    maxTokens: 3000,
  })
  return normalizeIntegratedInsight(res)
}

async function llmArticleDraft(env: Env, input: ArticleGenInput): Promise<GeneratedArticleDraft | null> {
  if (!env.vertexProjectId) return null
  const spec = { draft: 900, standard: 1800, premium: 3200 }[input.quality]
  const res = await generateJson<Record<string, unknown>>(env, {
    system: 'あなたはオウンドメディアの編集者 AI です。指定の目的・質・トーンで日本語のブログ記事を執筆します。'
      + 'body はマークダウン（# タイトル・## 見出し・箇条書き・引用・**強調** のみのサブセット。'
      + '表・画像・HTML は使わない）。読者が次に取るべき行動を明確に示し、'
      + `本文はおよそ ${spec} 文字を目安にする。事実の捏造（存在しない統計・事例）はしないこと。`,
    prompt: [
      `# 記事の依頼`,
      `- メディア: ${input.siteName}（${input.segmentName}）`,
      `- お題: ${input.topic || '（キーワードから設定）'}`,
      `- 重点キーワード: ${input.keyword || 'なし'}`,
      `- 目的: ${input.purpose} / 質: ${input.quality} / トーン: ${input.tone}`,
      `- ターゲット読者: ${input.audience}`,
      ...(input.insightHints && input.insightHints.length > 0
        ? [`- 直近のアクセス分析からの示唆: ${input.insightHints.join(' / ')}`]
        : []),
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        metaDescription: { type: 'string' },
        outline: {
          type: 'array',
          items: {
            type: 'object',
            properties: { heading: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
            required: ['heading', 'points'],
          },
        },
        body: { type: 'string' },
        suggestedKeywords: { type: 'array', items: { type: 'string' } },
        estWordCount: { type: 'number' },
      },
      required: ['title', 'metaDescription', 'outline', 'body', 'suggestedKeywords', 'estWordCount'],
    },
    maxTokens: 8192,
  })
  return normalizeArticleDraft(res, input)
}

// ---------- OAuth コールバック ----------

/**
 * OAuth コールバック（認証ヘッダなしのブラウザリダイレクトで届くため、/v1/* の認証より前に登録する。
 * 本人性は ①一回性・10 分 TTL の state ノンス ②Google アカウント email と members.email の突合の
 * 2 段で担保する（calendar と同型のアカウントリンク CSRF 対策）。復帰先は /media/settings
 */
export function mediaOauthCallback(pool: pg.Pool, env: Env) {
  return async (c: Context) => {
    const frontOrigin = env.corsOrigins[0] ?? ''
    const back = (q: string) => c.redirect(`${frontOrigin}/#/media/settings?${q}`, 302)
    const fail = (reason: string, segmentId = '') =>
      back(`ga=error&reason=${encodeURIComponent(reason)}${segmentId ? `&segment=${encodeURIComponent(segmentId)}` : ''}`)
    if (!googleOauthEnabled(env)) return fail('not-configured')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    const st = await consumeState(pool, state)
    const oauthError = c.req.query('error')
    if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'oauth-error', st?.segmentId ?? '')
    if (!st || !code) return fail('invalid-state')
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          client_id: env.googleOauthClientId,
          client_secret: env.googleOauthClientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri(c),
        }),
      })
      if (!res.ok) {
        console.warn('media oauth exchange failed:', res.status, (await res.text()).slice(0, 200))
        return fail('token-exchange', st.segmentId)
      }
      const body = await res.json() as {
        access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string
      }
      // 同意した Google アカウントが本人（members.email）であることを検証（他人アカウントの誤リンク防止）
      const googleEmail = emailFromIdToken(body.id_token)
      const { rows: memberRows } = await pool.query<{ email: string }>(
        `SELECT email FROM members WHERE id = $1 AND active = true`, [st.memberId])
      const memberEmail = memberRows[0]?.email?.toLowerCase() ?? null
      if (!googleEmail || !memberEmail || googleEmail !== memberEmail) {
        console.warn('media oauth account mismatch:', st.memberId)
        return fail('account-mismatch', st.segmentId)
      }
      // 再連携時に refresh_token が返らないことがある（既存を保持）。選択済みプロパティも保持する
      // （再連携 = トークン更新であり、プロパティ選択のやり直しを強制しない = 冪等）
      await pool.query(
        `INSERT INTO media_ga_tokens
           (segment_id, access_token_enc, refresh_token_enc, expires_at, scope, connected_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (segment_id) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, media_ga_tokens.refresh_token_enc),
           expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
           connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
        [st.segmentId, encryptSecret(body.access_token, env.tokenEncryptionKey),
          body.refresh_token ? encryptSecret(body.refresh_token, env.tokenEncryptionKey) : null,
          new Date(Date.now() + body.expires_in * 1000).toISOString(), body.scope ?? '', st.memberId])
      await clearMetricsCache(pool, st.segmentId)
      return back(`ga=connected&segment=${encodeURIComponent(st.segmentId)}`)
    } catch (e) {
      console.warn('media oauth callback failed:', (e as Error).message)
      return fail('exchange-error', st.segmentId)
    }
  }
}

// ---------- ルート ----------

const GENERATED_COLS = `g.id, g.segment_id AS "segmentId", g.brief_id AS "briefId", g.payload, g.llm,
  g.adopted_article_id AS "adoptedArticleId", g.active,
  g.created_by AS "createdBy",
  to_char(g.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

const ARTICLE_COLS = `id, segment_id AS "segmentId", path, title, section,
  published_at::text AS "publishedAt", word_count AS "wordCount", status, origin,
  generated_article_id AS "generatedArticleId", active`

interface GeneratedRow {
  id: string
  segmentId: string
  briefId: string
  payload: GeneratedArticleDraft
  llm: boolean
  adoptedArticleId: string | null
  active: boolean
  createdBy: string
  createdAt: string
}

/** 生成記事行 → フロントの GeneratedArticle 形（payload を平坦化） */
function flattenGenerated(row: GeneratedRow): Record<string, unknown> {
  const { payload, ...rest } = row
  return { ...payload, ...rest }
}

export function mediaRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---- GA 連携状態（設定未投入なら enabled=false でフロントは連携 UI を隠す）----
  app.get('/status', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    if (!googleOauthEnabled(env)) {
      return c.json({ data: { enabled: false, connected: false, needsProperty: false, propertyId: null, propertyName: null, connectedAt: null } })
    }
    const { rows } = await pool.query<{
      propertyId: string | null
      propertyName: string | null
      accessTokenEnc: string
      connectedAt: string
    }>(
      `SELECT property_id AS "propertyId", property_name AS "propertyName",
              access_token_enc AS "accessTokenEnc",
              to_char(connected_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "connectedAt"
       FROM media_ga_tokens WHERE segment_id = $1`, [segmentId])
    const row = rows[0]
    // connected は「トークン行があり復号でき、プロパティ選択済み」。復号不能（鍵ローテーション後）は再連携導線へ
    const decryptable = row ? decryptSecret(row.accessTokenEnc, env.tokenEncryptionKey) !== null : false
    const connected = decryptable && Boolean(row?.propertyId)
    const needsProperty = decryptable && !row?.propertyId
    return c.json({
      data: {
        enabled: true,
        connected,
        needsProperty,
        propertyId: connected ? row!.propertyId : null,
        propertyName: connected ? row!.propertyName : null,
        connectedAt: decryptable ? row!.connectedAt : null,
      },
    })
  })

  // ---- 同意画面 URL（管理者のみ。フロントはこの URL へフルリダイレクト）----
  app.get('/oauth/url', async (c) => {
    requireEnabled(env)
    const user = requireAdmin(c)
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const params = new URLSearchParams({
      client_id: env.googleOauthClientId,
      redirect_uri: redirectUri(c),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state: await issueState(pool, user.id, segmentId),
    })
    return c.json({ data: { url: `${GOOGLE_AUTH_URL}?${params.toString()}` } })
  })

  // ---- GA4 プロパティ一覧（管理者のみ。OAuth 後の選択肢。Admin API accountSummaries を平坦化）----
  app.get('/properties', async (c) => {
    requireEnabled(env)
    requireAdmin(c)
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const access = await gaAccess(pool, env, segmentId)
    if (!access?.token) {
      throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。先に Google アカウントを連携してください', 409)
    }
    interface Summary {
      displayName?: string
      propertySummaries?: { property?: string; displayName?: string }[]
    }
    const out: { id: string; name: string; account: string }[] = []
    let pageToken = ''
    try {
      // pageSize 上限 200。異常系で無限ループしないようページ数は最大 5（= 1000 件）で打ち切る
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ pageSize: '200' })
        if (pageToken) q.set('pageToken', pageToken)
        const res = await fetch(`${GA_ADMIN_BASE}/accountSummaries?${q.toString()}`, {
          headers: { authorization: `Bearer ${access.token}` },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          const bodyTxt = await res.text()
          console.warn('ga accountSummaries failed:', res.status, bodyTxt.slice(0, 300))
          // API 未有効化と権限不足を区別して案内する（m6。誤って API 有効化へ誘導しない）
          const reason = gaFailReasonOf(res.status, bodyTxt)
          if (reason === 'api-disabled') {
            throw err('AKO-MEDIA-006',
              'Google Analytics Admin API が利用できません。管理者は GCP プロジェクトで Google Analytics Admin API を有効化してください', 502)
          }
          if (reason === 'permission') {
            throw err('AKO-MEDIA-006',
              '連携した Google アカウントで GA4 プロパティ一覧を取得できません。Google Analytics 側でアカウントの閲覧権限を確認してください', 502)
          }
          throw new Error(`accountSummaries ${res.status}`)
        }
        const body = await res.json() as { accountSummaries?: Summary[]; nextPageToken?: string }
        for (const s of body.accountSummaries ?? []) {
          for (const p of s.propertySummaries ?? []) {
            if (!p.property) continue
            out.push({ id: p.property, name: p.displayName ?? p.property, account: s.displayName ?? '' })
          }
        }
        pageToken = body.nextPageToken ?? ''
        if (!pageToken) break
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      console.warn('ga properties failed:', (e as Error).message)
      throw err('AKO-MEDIA-006', 'GA4 プロパティ一覧の取得に失敗しました。時間をおいて再試行してください', 502)
    }
    return c.json({ data: out })
  })

  // ---- プロパティ確定（管理者のみ。ここで connected が完成する）----
  app.put('/property', async (c) => {
    requireEnabled(env)
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const propertyId = String(body.propertyId ?? '').trim()
    if (!/^properties\/\d+$/.test(propertyId)) {
      throw err('AKO-GEN-001', 'propertyId は properties/<数値> 形式で指定してください', 400)
    }
    const propertyName = capCp(String(body.propertyName ?? '').trim(), 200) || propertyId
    const { rowCount } = await pool.query(
      `UPDATE media_ga_tokens SET property_id = $2, property_name = $3, updated_at = now() WHERE segment_id = $1`,
      [segmentId, propertyId, propertyName])
    if (rowCount === 0) {
      throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。先に Google アカウントを連携してください', 409)
    }
    await clearMetricsCache(pool, segmentId)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_ga_tokens', entityId: segmentId,
      detail: `GA4 プロパティを設定: ${propertyName}`,
    })
    return c.json({ data: { segmentId, propertyId, propertyName } })
  })

  // ---- 連携解除（管理者のみ。revoke は補助処理・トークンは物理削除。設定・記事は残す = 非破壊。原則9.5）----
  app.post('/disconnect', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const access = googleOauthEnabled(env) ? await gaAccess(pool, env, segmentId) : null
    await pool.query(`DELETE FROM media_ga_tokens WHERE segment_id = $1`, [segmentId])
    await clearMetricsCache(pool, segmentId)
    if (access?.token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(access.token)}`, {
          method: 'POST', signal: AbortSignal.timeout(5_000),
        })
      } catch { /* 非ブロッキング（Google 側で失効済みでも解除は成立） */ }
    }
    await audit(pool, {
      actorId: user.id, action: 'delete', entity: 'media_ga_tokens', entityId: segmentId,
      detail: 'GA 連携を解除',
    })
    return c.json({ data: { ok: true } })
  })

  // ---- GA 集計（全ロール参照可）----
  app.get('/metrics', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const days = Math.min(90, Math.max(7, Math.round(Number(c.req.query('days') ?? 28)) || 28))
    const force = c.req.query('force') === '1'
    const result = await fetchMediaMetrics(pool, env, segmentId, days, force)
    return c.json({ data: result })
  })

  // ---- 月次トレンド（統合 PDCA 用）----
  app.get('/monthly', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const months = Math.min(12, Math.max(2, Math.round(Number(c.req.query('months') ?? 6)) || 6))
    const force = c.req.query('force') === '1'
    const points = await fetchMonthlyTrend(pool, env, segmentId, months, force)
    return c.json({ data: points })
  })

  // ---- メディア設定（AI 分析設定。GA 接続状態は /status が SoT）----
  app.get('/settings', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const { rows } = await pool.query(
      `SELECT ${SETTING_COLS} FROM media_settings WHERE segment_id = $1`, [segmentId])
    // 未設定は null（フロントが表示既定 defaultMediaSetting で補い、初回保存で materialize する）
    return c.json({ data: rows[0] ?? null })
  })

  app.put('/settings', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const patch = settingsPatchOf(body)
    // 部分更新: body に実在するキーのみ EXCLUDED から反映し、送っていない列は既存値を保持する。
    // 行が無ければ既定値 + patch で materialize（upsert = 冪等）
    const setCols: string[] = ['updated_at = now()']
    if (patch.siteName !== undefined) setCols.push('site_name = EXCLUDED.site_name')
    if (patch.siteUrl !== undefined) setCols.push('site_url = EXCLUDED.site_url')
    if (patch.analysisGoal !== undefined) setCols.push('analysis_goal = EXCLUDED.analysis_goal')
    if (patch.targetAudience !== undefined) setCols.push('target_audience = EXCLUDED.target_audience')
    if (patch.defaultTone !== undefined) setCols.push('default_tone = EXCLUDED.default_tone')
    if (patch.keywords !== undefined) setCols.push('keywords = EXCLUDED.keywords')
    if (patch.active !== undefined) setCols.push('active = EXCLUDED.active')
    const { rows } = await pool.query(
      `INSERT INTO media_settings (id, segment_id, site_name, site_url, analysis_goal, target_audience, default_tone, keywords, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (segment_id) DO UPDATE SET ${setCols.join(', ')}
       RETURNING ${SETTING_COLS}`,
      [newId('ms'), segmentId,
        patch.siteName ?? '', patch.siteUrl ?? '', patch.analysisGoal ?? 'awareness',
        patch.targetAudience ?? '', patch.defaultTone ?? 'formal',
        JSON.stringify(patch.keywords ?? []), patch.active ?? true])
    // siteName は metrics ペイロードに含まれるため、設定変更 = SoT の変化として導出キャッシュを破棄（m8）
    await clearMetricsCache(pool, segmentId)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_settings', entityId: segmentId,
      detail: 'メディア設定を更新',
    })
    return c.json({ data: rows[0] })
  })

  // ---- 記事インベントリ ----
  app.get('/articles', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const includeInactive = c.req.query('includeInactive') === '1'
    const { rows } = await pool.query(
      `SELECT ${ARTICLE_COLS} FROM media_articles
       WHERE segment_id = $1 ${includeInactive ? '' : 'AND active = true'}
       ORDER BY published_at DESC, id LIMIT 1000`, [segmentId])
    return c.json({ data: rows })
  })

  // 手動登録（管理者のみ）。実データはシードしないため、既存サイトの記事を分析対象へ加える回復パス（原則6）。
  // GA だけでも topPages/sections は表示されるが、インベントリ登録でセクション対応と記事数が正確になる
  app.post('/articles', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const path = String(body.path ?? '').trim()
    const title = capCp(String(body.title ?? '').trim(), 200)
    const section = capCp(String(body.section ?? '').trim(), 40)
    const publishedAt = String(body.publishedAt ?? '')
    if (!path.startsWith('/') || path.length > 500) throw err('AKO-GEN-001', 'path は / 始まりで指定してください', 400)
    if (!title) throw err('AKO-GEN-001', 'title を指定してください', 400)
    if (!section) throw err('AKO-GEN-001', 'section を指定してください', 400)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) throw err('AKO-GEN-001', 'publishedAt は YYYY-MM-DD 形式で指定してください', 400)
    const wordCount = Math.max(0, Math.round(Number(body.wordCount ?? 0)) || 0)
    const status = body.status === 'draft' ? 'draft' : 'published'
    const id = newId('ma')
    let rows: unknown[]
    try {
      const result = await pool.query(
        `INSERT INTO media_articles (id, segment_id, path, title, section, published_at, word_count, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'seed')
         RETURNING ${ARTICLE_COLS}`,
        [id, segmentId, path, title, section, publishedAt, wordCount, status])
      rows = result.rows
    } catch (e) {
      // 部分一意 INDEX（segment_id, path WHERE active）違反 = 再送・二重クリックの重複登録（m5。冪等の案内）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-MEDIA-008', '同じパスの記事が既に登録されています', 409)
      }
      throw e
    }
    await clearMetricsCache(pool, segmentId)
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'media_articles', entityId: id,
      detail: `記事を登録: ${title}`,
    })
    return c.json({ data: rows[0] }, 201)
  })

  // 記事の取消（論理削除）・復元（原則9.5。管理者のみ）
  app.post('/articles/:id/deactivate', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rows } = await pool.query<{ segmentId: string }>(
      `UPDATE media_articles SET active = false, updated_at = now() WHERE id = $1 RETURNING segment_id AS "segmentId"`, [id])
    if (!rows[0]) throw err('AKO-MEDIA-007', '対象の記事が見つかりません', 404)
    await clearMetricsCache(pool, rows[0].segmentId)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_articles', entityId: id, detail: '記事を取消（論理削除）' })
    return c.json({ data: { id } })
  })

  app.post('/articles/:id/restore', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    let rows: { segmentId: string }[]
    try {
      const result = await pool.query<{ segmentId: string }>(
        `UPDATE media_articles SET active = true, updated_at = now() WHERE id = $1 RETURNING segment_id AS "segmentId"`, [id])
      rows = result.rows
    } catch (e) {
      // 同一パスの有効な記事が既に存在する場合（取消後に再登録された等）は復元できない（部分一意 INDEX との整合）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-MEDIA-008', '同じパスの有効な記事が存在するため復元できません（既存の記事を取り消してから復元してください）', 409)
      }
      throw e
    }
    if (!rows[0]) throw err('AKO-MEDIA-007', '対象の記事が見つかりません', 404)
    await clearMetricsCache(pool, rows[0].segmentId)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_articles', entityId: id, detail: '記事を復元' })
    return c.json({ data: { id } })
  })

  // ---- AI 記事生成（全ロール可 = mockup の記事生成スタジオと同じ可視性）----
  app.post('/articles/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const topic = capCp(String(body.topic ?? '').trim(), 100)
    const keyword = capCp(String(body.keyword ?? '').trim(), 100)
    if (!topic && !keyword) throw err('AKO-MEDIA-011', 'お題またはキーワードを入力してください', 400)
    const purpose = String(body.purpose ?? '')
    const quality = String(body.quality ?? '')
    const tone = String(body.tone ?? '')
    if (!(ARTICLE_PURPOSES as string[]).includes(purpose)) throw err('AKO-GEN-001', 'purpose が不正です', 400)
    if (!(ARTICLE_QUALITIES as string[]).includes(quality)) throw err('AKO-GEN-001', 'quality が不正です', 400)
    if (!(ARTICLE_TONES as string[]).includes(tone)) throw err('AKO-GEN-001', 'tone が不正です', 400)
    const fromInsightId = typeof body.fromInsightId === 'string' && body.fromInsightId ? body.fromInsightId : null
    // セグメント名はクライアントから受ける（表示・文面用途のみ。business_segments はテーブル化済みだが
    // サーバー解決への引き上げは Phase C の参照整合判断と併せて行う = 挙動維持）
    const segmentName = capCp(String(body.segmentName ?? '').trim(), 100)

    const { rows: settingRows } = await pool.query<{ siteName: string; targetAudience: string }>(
      `SELECT site_name AS "siteName", target_audience AS "targetAudience" FROM media_settings WHERE segment_id = $1`,
      [segmentId])
    const setting = settingRows[0]
    const audience = capCp(String(body.audience ?? '').trim(), 200) || setting?.targetAudience || '読者'

    // 過去分析からの生成: 保管済みメディアインサイトのヒント文を生成の前提に添える
    let insightHints: string[] = []
    if (fromInsightId) {
      const { rows } = await pool.query<{ insight: unknown }>(
        `SELECT insight FROM media_insights WHERE id = $1 AND segment_id = $2 AND scope = 'media'`,
        [fromInsightId, segmentId])
      insightHints = rows[0] ? insightHintsOf(rows[0].insight) : []
    }

    const genInput: ArticleGenInput = {
      topic, keyword,
      purpose: purpose as ArticlePurpose, quality: quality as ArticleQuality, tone: tone as ArticleTone,
      audience,
      siteName: setting?.siteName || segmentName || 'メディア',
      segmentName: segmentName || setting?.siteName || 'メディア',
      insightHints,
    }
    // Vertex AI → 失敗・無効環境は決定的テンプレート合成へフォールバック（原則4。llm フラグで区別）
    const llmDraft = await llmArticleDraft(env, genInput)
    const draft = llmDraft ?? generateArticleDraft(genInput)

    const briefId = newId('ab')
    const genId = newId('ga')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO media_article_briefs (id, segment_id, topic, keyword, purpose, quality, tone, audience, from_insight_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [briefId, segmentId, topic, keyword, purpose, quality, tone, audience, fromInsightId, user.id])
      await client.query(
        `INSERT INTO media_generated_articles (id, segment_id, brief_id, payload, llm, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [genId, segmentId, briefId, JSON.stringify(draft), !!llmDraft, user.id])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    const { rows } = await pool.query<GeneratedRow>(
      `SELECT ${GENERATED_COLS} FROM media_generated_articles g WHERE g.id = $1`, [genId])
    return c.json({ data: flattenGenerated(rows[0]!) }, 201)
  })

  // ---- 生成記事の一覧（取消済み含む全件。表示側でフィルタ）----
  app.get('/generated', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const { rows } = await pool.query<GeneratedRow>(
      `SELECT ${GENERATED_COLS} FROM media_generated_articles g
       WHERE g.segment_id = $1 ORDER BY g.created_at DESC, g.id LIMIT 500`, [segmentId])
    return c.json({ data: rows.map(flattenGenerated) })
  })

  // ---- 採用（サイトのコンテンツ資産へ登録）。二重採用は no-op + warning = 冪等 ----
  app.post('/generated/:id/adopt', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const section = capCp(String(body.section ?? '').trim(), 40) || 'ブログ'
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<GeneratedRow>(
        `SELECT ${GENERATED_COLS} FROM media_generated_articles g WHERE g.id = $1 FOR UPDATE`, [id])
      const g = rows[0]
      if (!g || !g.active) throw err('AKO-MEDIA-012', '対象の生成記事が見つかりません', 404)
      if (g.adoptedArticleId) {
        await client.query('COMMIT')
        return c.json({ data: { id, articleId: g.adoptedArticleId, warning: 'すでに採用済みです（変更はありません）' } })
      }
      const articleId = newId('ma')
      // 分析の集計基準は前日（asOf）。採用直後に期間へ入るよう公開日を前日にする（mockup adopt と同じ判断）
      await client.query(
        `INSERT INTO media_articles (id, segment_id, path, title, section, published_at, word_count, status, origin, generated_article_id)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'published', 'generated', $8)`,
        [articleId, g.segmentId, `/blog/gen-${articleId}`, capCp(g.payload.title, 200), section,
          addDays(todayJst(), -1), g.payload.estWordCount, g.id])
      await client.query(
        `UPDATE media_generated_articles SET adopted_article_id = $2, updated_at = now() WHERE id = $1`,
        [id, articleId])
      await client.query('COMMIT')
      await clearMetricsCache(pool, g.segmentId)
      await audit(pool, { actorId: user.id, action: 'create', entity: 'media_articles', entityId: articleId, detail: `生成記事を採用: ${g.payload.title}` })
      return c.json({ data: { id, articleId } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // ---- 採用の取消（原則9.5。採用で作った資産を論理削除し、採用リンクを解除）----
  app.post('/generated/:id/unadopt', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<GeneratedRow>(
        `SELECT ${GENERATED_COLS} FROM media_generated_articles g WHERE g.id = $1 FOR UPDATE`, [id])
      const g = rows[0]
      if (!g) throw err('AKO-MEDIA-012', '対象の生成記事が見つかりません', 404)
      if (!g.adoptedArticleId) throw err('AKO-MEDIA-014', '採用されていません', 400)
      await client.query(`UPDATE media_articles SET active = false, updated_at = now() WHERE id = $1`, [g.adoptedArticleId])
      await client.query(`UPDATE media_generated_articles SET adopted_article_id = NULL, updated_at = now() WHERE id = $1`, [id])
      await client.query('COMMIT')
      await clearMetricsCache(pool, g.segmentId)
      await audit(pool, { actorId: user.id, action: 'update', entity: 'media_articles', entityId: g.adoptedArticleId, detail: '生成記事の採用を取消' })
      return c.json({ data: { id } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // ---- 生成記事の取消（論理削除。採用済みなら採用も取り消してから。再実行は no-op = 冪等）----
  app.post('/generated/:id/remove', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<GeneratedRow>(
        `SELECT ${GENERATED_COLS} FROM media_generated_articles g WHERE g.id = $1 FOR UPDATE`, [id])
      const g = rows[0]
      if (!g) throw err('AKO-MEDIA-012', '対象の生成記事が見つかりません', 404)
      if (g.adoptedArticleId) {
        await client.query(`UPDATE media_articles SET active = false, updated_at = now() WHERE id = $1`, [g.adoptedArticleId])
      }
      await client.query(
        `UPDATE media_generated_articles SET active = false, adopted_article_id = NULL, updated_at = now() WHERE id = $1`, [id])
      await client.query('COMMIT')
      await clearMetricsCache(pool, g.segmentId)
      await audit(pool, { actorId: user.id, action: 'update', entity: 'media_generated_articles', entityId: id, detail: '生成記事を取消（論理削除）' })
      return c.json({ data: { id } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // ---- 生成記事の復元（取消フローの対。採用状態は復元しない = 採用は明示操作で）----
  app.post('/generated/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE media_generated_articles SET active = true, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-012', '対象の生成記事が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_generated_articles', entityId: id, detail: '生成記事を復元' })
    return c.json({ data: { id } })
  })

  // 保管済みインサイトの参照列（warning = 劣化データ由来の告知。閲覧者にも生成時の集計状態を明示する）
  const INSIGHT_COLS = `mi.id, mi.period_key AS "periodKey", mi.metrics, mi.insight, mi.llm, mi.warning,
              to_char(mi.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt",
              m.name AS "generatedByName"`

  // ---- AI インサイト（保管済みの取得。未生成は null）----
  app.get('/insights', async (c) => {
    const segmentId = segmentIdOf(c.req.query('segmentId'))
    const scope = c.req.query('scope')
    if (scope !== 'media' && scope !== 'integrated') throw err('AKO-GEN-001', 'scope は media / integrated を指定してください', 400)
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM media_insights mi LEFT JOIN members m ON m.id = mi.generated_by
       WHERE mi.segment_id = $1 AND mi.scope = $2`, [segmentId, scope])
    return c.json({ data: rows[0] ?? null })
  })

  // ---- AI インサイトの生成・再生成（生成 → 保管 → 再生成で upsert 上書き = weekly_insights と同型）----
  // 認可の設計判断: 生成は全ロール可（mockup の分析ページと同じ可視性。generated_by を保存 = 誰の操作か追跡可能）。
  // scope=integrated のメディア軸は **GA 連携済みセグメントなら**サーバーが GA 導出値で上書きするため、
  // クライアント申告での改ざんは効かない。**GA 未連携セグメントでは上書きできず**、範囲検証済みの申告値が
  // そのまま保管される = 売上軸と同じ受容クラス（認証済み社内ユーザーの脅威モデル + generated_by の監査可能性で
  // 緩和して受容）。売上軸はモック側 SoT（未移行）でサーバー検証不能 = 同様に受容する
  // （salesRecords の API 移行時にサーバー組み立てへ引き上げて両方解消。原則7 の文書化）
  app.post('/insights/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const segmentId = segmentIdOf(body.segmentId)
    const scope = body.scope
    if (scope !== 'media' && scope !== 'integrated') throw err('AKO-GEN-001', 'scope は media / integrated を指定してください', 400)

    let metrics: unknown
    let insight: unknown
    let llm = false
    let periodKey = ''
    let warning: string | null = null
    if (scope === 'media') {
      // メディア単体: サーバーが GA から集計を組み立てる（キャッシュ利用）。
      // 内訳の部分失敗（warning）は捨てずに保管・返却する（劣化データ由来の告知 = 原則4。m11）
      const result = await fetchMediaMetrics(pool, env, segmentId, 28, false)
      metrics = result.metrics
      warning = result.warning ? `部分的な集計から生成: ${result.warning}` : null
      const llmRes = await llmMediaInsight(env, result.metrics)
      insight = llmRes ?? heuristicMediaInsight(result.metrics)
      llm = !!llmRes
      periodKey = `${result.metrics.periodFrom}_${result.metrics.periodTo}`
    } else {
      // 統合（業務 × メディア）: 売上明細（salesRecords）は未移行のモック側 SoT のため、
      // 統合メトリクスは**クライアントが**「メディア月次 = 本 API(/monthly) + 売上月次 = モック側集計」を
      // 突合して組み立てて渡す（設計判断の文書化 = 原則6。salesRecords の API 移行 = Phase C で
      // サーバー側組み立てへ引き上げる。businessSegments は Phase B = 0031 で移行済み）。サーバーの責務（M2）:
      //   ① whitelist 正規化 + 全数値の有限・非負・範囲検証（不正は 400 = 500 を出さない・型崩れを保管しない）
      //   ② メディア軸（sessions/conversions/engaged）は GA 連携済みならサーバー導出値で上書き（申告値を信頼しない）
      //   ③ 売上軸はサーバー検証不能（モック SoT）= 範囲検証のみの限界を受容（上の認可コメント参照)
      const normalized = normalizeIntegratedMetrics(body.metrics)
      if (!normalized) throw err('AKO-MEDIA-016', '統合メトリクス（metrics）が不正です', 400)
      let im: IntegratedMetrics = { ...normalized, segmentId }
      const access = googleOauthEnabled(env) ? await gaAccess(pool, env, segmentId) : null
      if (access?.token && access.propertyId) {
        try {
          const monthsCount = Math.min(12, Math.max(2, im.trend.length))
          const points = await fetchMonthlyTrend(pool, env, segmentId, monthsCount, false)
          im = applyServerMediaAxis(im, points)
        } catch (e) {
          // GA 一時障害時はクライアント値のまま続行し、突合できなかった事実を告知する（原則4）
          console.warn('media integrated: server-side GA verify skipped:', (e as Error).message)
          warning = 'メディア軸の GA 突合ができなかったため、送信された集計値のまま生成しています'
        }
      }
      metrics = im
      const llmRes = await llmIntegratedInsight(env, im)
      insight = llmRes ?? heuristicIntegratedInsight(im)
      llm = !!llmRes
      periodKey = im.periodMonth
    }

    await pool.query(
      `INSERT INTO media_insights (id, segment_id, scope, period_key, metrics, insight, llm, warning, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (segment_id, scope) DO UPDATE SET
         period_key = EXCLUDED.period_key, metrics = EXCLUDED.metrics, insight = EXCLUDED.insight,
         llm = EXCLUDED.llm, warning = EXCLUDED.warning, generated_by = EXCLUDED.generated_by, generated_at = now()`,
      [newId('mi'), segmentId, scope, periodKey, JSON.stringify(metrics), JSON.stringify(insight), llm, warning, user.id])
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM media_insights mi LEFT JOIN members m ON m.id = mi.generated_by
       WHERE mi.segment_id = $1 AND mi.scope = $2`, [segmentId, scope])
    return c.json({ data: rows[0] })
  })

  return app
}
