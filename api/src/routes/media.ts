/**
 * メディア分析 API（F-40）。home useMediaChannels / useMediaAnalytics / useMediaInsight /
 * useMediaArticles / useMediaExternalArticles の API 版。calendar.ts の Google OAuth 設計
 * （state ノンス・email 突合・AES-256-GCM トークン暗号化・非ブロッキング revoke）を踏襲する。
 *
 * メディア分析は **独立したメディアチャンネル（media_channels）** を単位に動く（オペレーター指示 2026-08-03）。
 * 任意で「どの Akebono 業務アプリ（= 業態 business_segment）と連携するか」を設定できる（連携は必須でない）:
 * - 未連携（channel.segment_id = NULL）: メディア単体で分析・記事生成・単体 AI インサイトが動く
 * - 連携済み（channel.segment_id あり）: 加えて業務 × メディアの統合 PDCA（売上 × 流入）が利用できる
 *   （integrated は連携必須。未連携チャンネルで integrated を要求すると AKO-MEDIA-022）
 *
 * - GA 連携は **channel 単位**（0048 で segment 単位から移行。旧 segment_id 値は channel_id へ列名変更のみ =
 *   値不変で下位互換。connected_by で連携者を記録する）。スコープは analytics.readonly のみ
 * - GA 集計（GA4 Data API batchRunReports）→ MediaMetrics 整形は lib/ga.ts の純粋関数。
 *   GA クォータ対策に 30 分の導出キャッシュ（media_metrics_cache）を持つ（SoT は GA = 記録系ではない）
 * - AI インサイト・記事生成は Vertex AI（generateJson）→ 失敗時は shared/domain の決定的
 *   ヒューリスティックへフォールバック（原則4。weekly_insights と同じ「生成 → 保管 → 再生成で上書き」）
 * - media インサイト生成は **外部投稿記事（media_external_articles）の原文を材料**に取り込む（新機能）
 * - 認可: GA 連携・チャンネル/設定・インベントリ・外部記事の書込は admin のみ。
 *   参照・記事生成・採用・インサイト生成は全ロール可（home の画面ゲートと一致）
 * - segment（連携先業態）の存在検証は行わない: business_segments はテーブル化済みだが FK・参照整合の
 *   引き上げは記録系移行の判断まで保留（data-design 参照。channel.segment_id は text 保持）
 *
 * エラー: AKO-MEDIA-003 GA 未連携 / 004 GA 集計取得失敗 / 005 連携未設定（GOOGLE_OAUTH_*）/
 *         006 プロパティ一覧取得失敗 / 007 対象記事なし / 008 記事パスの重複 / 011 お題未入力 /
 *         012 生成記事なし / 014 未採用 / 020 チャンネル名必須 / 021 対象チャンネルなし /
 *         022 統合分析には連携業態が必要 / 023 外部記事の入力不正 / 024 対象の外部記事なし
 *         （001・002・010・013・016 はモック専用/欠番。013 の二重採用は API では no-op + warning = 冪等。
 *          009・015 は欠番）
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, todayJst } from '../../../shared/domain/jst'
import type { MediaMetrics, MediaMonthlyPoint } from '../../../shared/domain/media-metrics'
import {
  applyExternalMaterial, type ExternalArticleMaterial, externalMaterialOf,
  heuristicMediaInsight, type MediaAction, type MediaFinding, type MediaInsight,
} from '../../../shared/domain/media-insight'
import {
  composeIntegratedMetrics, foldBusinessMonthly, heuristicIntegratedInsight,
  type IntegratedInsight, type IntegratedMetrics,
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
/** 分析目的の区分値（SoT はモックの MediaChannel（home/app/types/media.ts）。0048 の CHECK と一致させる） */
const MEDIA_GOALS = ['awareness', 'leadgen', 'nurturing', 'conversion', 'branding', 'retention']

function requireEnabled(env: Env): void {
  if (!googleOauthEnabled(env)) {
    throw err('AKO-MEDIA-005', 'Google Analytics 連携が未設定です（GOOGLE_OAUTH_* を設定してください）', 409)
  }
}

/** channelId クエリ/ボディの検証（形式のみ。存在検証は各ハンドラの行取得で行う） */
function channelIdOf(v: unknown): string {
  const id = String(v ?? '').trim()
  if (!id || id.length > 64) throw err('AKO-GEN-001', 'channelId を指定してください', 400)
  return id
}

/** リクエスト URL からコールバック URI を組み立てる（calendar.ts と同型。Cloud Run の x-forwarded-proto 対応） */
function redirectUri(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${url.host}/v1/media/oauth/callback`
}

// ---------- OAuth state（一回性 + 10 分 TTL。calendar と同型 + channel_id） ----------

async function issueState(pool: pg.Pool, memberId: string, channelId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await pool.query(`DELETE FROM media_oauth_states WHERE created_at < now() - interval '10 minutes'`)
  await pool.query(
    `INSERT INTO media_oauth_states (nonce, member_id, channel_id) VALUES ($1, $2, $3)`,
    [nonce, memberId, channelId])
  return nonce
}

async function consumeState(pool: pg.Pool, state: string): Promise<{ memberId: string; channelId: string } | null> {
  if (!state || state.length > 128) return null
  const { rows } = await pool.query<{ memberId: string; channelId: string }>(
    `DELETE FROM media_oauth_states
     WHERE nonce = $1 AND created_at >= now() - interval '10 minutes'
     RETURNING member_id AS "memberId", channel_id AS "channelId"`, [state])
  return rows[0] ?? null
}

// ---------- GA トークン（channel 単位。calendar accessTokenFor と同型） ----------

interface GaTokenRow {
  propertyId: string | null
  propertyName: string | null
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: string | null
}

async function gaTokenRow(pool: pg.Pool, channelId: string): Promise<GaTokenRow | null> {
  const { rows } = await pool.query<GaTokenRow>(
    `SELECT property_id AS "propertyId", property_name AS "propertyName",
            access_token_enc AS "accessTokenEnc", refresh_token_enc AS "refreshTokenEnc",
            expires_at AS "expiresAt"
     FROM media_ga_tokens WHERE channel_id = $1`, [channelId])
  return rows[0] ?? null
}

/**
 * 有効なアクセストークン + 選択済みプロパティ（期限切れは refresh。取得不可 = null → AKO-MEDIA-003）。
 * calendar.ts の accessTokenFor / issueState と同型だが**共通化しない設計判断**（原則3 の例外）:
 * キー（member_id vs channel_id）・テーブル・回復導線（再連携の単位が本人 vs チャンネル）が異なり、
 * 抽象化すると障害切り分け時にどちらのフローか読みにくくなる。refresh 手順を変更する際は
 * calendar.ts 側と併せて確認すること
 */
async function gaAccess(
  pool: pg.Pool, env: Env, channelId: string,
): Promise<{ token: string; propertyId: string | null } | null> {
  const row = await gaTokenRow(pool, channelId)
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
      `UPDATE media_ga_tokens SET access_token_enc = $2, expires_at = $3, updated_at = now() WHERE channel_id = $1`,
      [channelId, encryptSecret(body.access_token, env.tokenEncryptionKey),
        new Date(Date.now() + body.expires_in * 1000).toISOString()])
    return { token: body.access_token, propertyId: row.propertyId }
  } catch {
    return null
  }
}

// ---------- GA 集計キャッシュ ----------

async function cachedPayload<T>(pool: pg.Pool, channelId: string, cacheKey: string): Promise<T | null> {
  const { rows } = await pool.query<{ payload: T }>(
    `SELECT payload FROM media_metrics_cache
     WHERE channel_id = $1 AND cache_key = $2 AND fetched_at > now() - interval '${CACHE_TTL}'`,
    [channelId, cacheKey])
  return rows[0]?.payload ?? null
}

async function putCache(pool: pg.Pool, channelId: string, cacheKey: string, payload: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO media_metrics_cache (channel_id, cache_key, payload, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (channel_id, cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [channelId, cacheKey, JSON.stringify(payload)])
}

/** インベントリ変更・連携変更時のキャッシュ破棄（SoT の変化 → 依存する導出キャッシュを無効化 = 原則6） */
async function clearMetricsCache(pool: pg.Pool, channelId: string): Promise<void> {
  await pool.query(`DELETE FROM media_metrics_cache WHERE channel_id = $1`, [channelId])
}

// ---------- チャンネル行（設定 + 連携先） ----------

interface ChannelRow {
  id: string
  name: string
  segmentId: string | null
  siteName: string
  siteUrl: string
  analysisGoal: string
  targetAudience: string
  defaultTone: string
  keywords: string[]
  active: boolean
}

const CHANNEL_COLS = `id, name, segment_id AS "segmentId", site_name AS "siteName", site_url AS "siteUrl",
  analysis_goal AS "analysisGoal", target_audience AS "targetAudience", default_tone AS "defaultTone",
  keywords, active`

async function channelRow(pool: pg.Pool, channelId: string): Promise<ChannelRow | null> {
  const { rows } = await pool.query<ChannelRow>(
    `SELECT ${CHANNEL_COLS} FROM media_channels WHERE id = $1`, [channelId])
  return rows[0] ?? null
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
  pool: pg.Pool, env: Env, channelId: string, days: number, force: boolean,
  asOfOverride?: string,
): Promise<MetricsResult> {
  requireEnabled(env)
  const access = await gaAccess(pool, env, channelId)
  if (!access?.token || !access.propertyId) {
    throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。メディア設定から連携してください', 409)
  }
  // asOfOverride = 基準日の指定（AI 週次レポート = 週の終了日基準。改善要望 2026-08-21）。
  // 既定は従来どおり前日基準。キャッシュキーへ基準日を含め、既定キー（metrics:N）と混線させない
  const cacheKey = asOfOverride ? `metrics:${days}:${asOfOverride}` : `metrics:${days}`
  if (!force) {
    const cached = await cachedPayload<MetricsResult>(pool, channelId, cacheKey)
    if (cached) return cached
  }

  const asOf = asOfOverride ?? addDays(todayJst(), -1)
  const periodTo = asOf
  const periodFrom = addDays(periodTo, -(days - 1))
  const prevTo = addDays(periodFrom, -1)
  const prevFrom = addDays(prevTo, -(days - 1))

  // インベントリ（セクション対応 + articleCount の SoT はアプリ。集計値は GA が SoT）
  const { rows: articles } = await pool.query<{ path: string; section: string }>(
    `SELECT path, section FROM media_articles
     WHERE channel_id = $1 AND active = true AND status = 'published' AND published_at <= $2::date`,
    [channelId, periodTo])
  const { rows: channelRows } = await pool.query<{ siteName: string }>(
    `SELECT site_name AS "siteName" FROM media_channels WHERE id = $1`, [channelId])
  const siteName = channelRows[0]?.siteName || 'メディア'

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
  // 前年同期（直近 7 日の 52 週〔364 日〕前 = 前年の同じ曜日並びの 7 日間。改善要望 2026-08-21 =
  // サマリーの前年同期比。365 日固定は閏年跨ぎで 1 日ずれ・曜日不整合のため 52 週で取る = モックと同一規則）。
  // batchRunReports は最大 5 リクエスト/バッチのため単独 runReport で取得する。
  // 日別次元で取得し合算する（当年側の週合計 = daily の合算〔延べユーザー〕と同じ尺度で比較するため）。
  // 取得失敗は yoyWeek 未設定 = 「—」表示のグレースフルデグラデーション（原則4・警告には載せない =
  // 補助指標の失敗で本体の集計表示を警告色にしない設計判断）
  const yoyRequest = {
    dateRanges: [dateRange(addDays(periodTo, -370), addDays(periodTo, -364))],
    dimensions: [dimension('date')],
    metrics: ['sessions', 'totalUsers', 'keyEvents'].map(metric),
    limit: '10',
  }
  const [detailBatch, yoySingle] = await Promise.all([
    runBatch(access.token, access.propertyId, detailDefs.map(d => d.request), DETAIL_TIMEOUT_MS),
    runReport(access.token, access.propertyId, yoyRequest, DETAIL_TIMEOUT_MS),
  ])
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
    yoyWeekDaily: yoySingle.ok ? yoySingle.report : null,
  }, { segmentId: channelId, siteName, periodFrom, periodTo, days, articles })

  // 失敗した内訳のみを名指しで報告（全滅は「総計のみ」・一部なら取れた内訳は表示している旨が伝わる文言）
  const detailSuffix = `${reasonNote || gaDetail ? `（${reasonNote}${gaDetail ? `GA 応答: ${gaDetail}` : ''}）` : ''}。時間をおいて再試行してください`
  const warning = failedLabels.length === 0
    ? undefined
    : failedLabels.length === detailDefs.length
      ? `内訳（日別・チャネル・デバイス・記事別）の取得に失敗したため、総計のみ表示しています${detailSuffix}`
      : `一部の内訳（${failedLabels.join('・')}）の取得に失敗しました${detailSuffix}`
  // 日別内訳が取得できなかったとき（unavailable に 'daily'）は前年同期（yoyWeek）を付けない:
  // daily はゼロ埋めで全長生成されるため、yoyWeek だけ実値が載ると「直近 7 日 0 vs 前年実値 = -100%」の
  // 誤比較が成立してしまう（レビュー R2 MAJOR。フロントも daily 欠落時は比較カードを出さない = 二重防御）
  if (unavailable.includes('daily')) metrics.yoyWeek = undefined
  const result: MetricsResult = { metrics, warning, unavailable }
  // 部分失敗の結果は 30 分固定化しない（次回リクエストで再試行させる）
  if (!result.warning) {
    await putCache(pool, channelId, cacheKey, result)
    // 基準日つきキー（metrics:{days}:{asOf} = 週次レポート生成用）は使い捨てのため、
    // 古い行を機会的に掃除する（無期限蓄積の防止 = レビュー R1 N-7。失敗しても主フローは止めない = 原則4）
    if (asOfOverride) {
      await pool.query(
        `DELETE FROM media_metrics_cache
         WHERE channel_id = $1 AND cache_key LIKE 'metrics:%:____-__-__' AND fetched_at < now() - interval '7 days'`,
        [channelId]).catch((e: unknown) => console.warn('metrics cache cleanup failed (non-blocking):', (e as Error).message))
    }
  }
  return result
}

/** 月次トレンド（統合 PDCA 用。最終月 = 直前の完了月。30 分キャッシュ） */
async function fetchMonthlyTrend(
  pool: pg.Pool, env: Env, channelId: string, months: number, force: boolean,
): Promise<MediaMonthlyPoint[]> {
  requireEnabled(env)
  const access = await gaAccess(pool, env, channelId)
  if (!access?.token || !access.propertyId) {
    throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。メディア設定から連携してください', 409)
  }
  const cacheKey = `monthly:${months}`
  if (!force) {
    const cached = await cachedPayload<MediaMonthlyPoint[]>(pool, channelId, cacheKey)
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
  await putCache(pool, channelId, cacheKey, points)
  return points
}

// ---------- チャンネル設定の部分更新（純粋関数・単体テスト対象） ----------

export interface MediaSettingsPatch {
  name?: string
  /** 連携先業態。'' / null = 連携解除（単体チャンネル） */
  segmentId?: string | null
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
 * チャンネル PATCH（/channels/:id）と設定 PUT（/settings）で共用する。
 */
export function settingsPatchOf(body: Record<string, unknown>): MediaSettingsPatch {
  const out: MediaSettingsPatch = {}
  if (Object.hasOwn(body, 'name')) out.name = capCp(String(body.name ?? '').trim(), 100)
  if (Object.hasOwn(body, 'segmentId')) {
    const v = String(body.segmentId ?? '').trim()
    // '' = 連携解除（単体化）。非空は連携先 id（存在検証はしない = FK 未設定の設計判断）
    out.segmentId = v ? capCp(v, 64) : null
  }
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

/**
 * patch から UPDATE の SET 句・値を組み立てる（送ったキーのみ = 未指定は保持 = Zod v4 注意への構造的対応）。
 * id は WHERE の $1 に予約するため、値は $2 以降へ割り当てる。
 */
function channelUpdateParts(patch: MediaSettingsPatch): { assigns: string[]; values: unknown[] } {
  const assigns: string[] = ['updated_at = now()']
  const values: unknown[] = []
  const add = (col: string, val: unknown, cast = '') => {
    values.push(val)
    assigns.push(`${col} = $${values.length + 1}${cast}`)
  }
  if (patch.name !== undefined) add('name', patch.name)
  if (patch.segmentId !== undefined) add('segment_id', patch.segmentId)
  if (patch.siteName !== undefined) add('site_name', patch.siteName)
  if (patch.siteUrl !== undefined) add('site_url', patch.siteUrl)
  if (patch.analysisGoal !== undefined) add('analysis_goal', patch.analysisGoal)
  if (patch.targetAudience !== undefined) add('target_audience', patch.targetAudience)
  if (patch.defaultTone !== undefined) add('default_tone', patch.defaultTone)
  if (patch.keywords !== undefined) add('keywords', JSON.stringify(patch.keywords), '::jsonb')
  if (patch.active !== undefined) add('active', patch.active)
  return { assigns, values }
}

// ---------- インサイトのヒント抽出・LLM 出力の正規化（純粋関数・単体テスト対象） ----------

/** 保管済みメディアインサイトから記事生成のヒント文を取り出す（home hintsFromInsight と同一ロジック） */
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

// ---------- 外部投稿記事のインサイト材料化 ----------
// externalMaterialOf / applyExternalMaterial は shared/domain/media-insight へ移設し、
// API とモック（useMediaInsight）で同一ロジックを共有する（原則3・両モードパリティ）。
// 既存の import 経路（api/test/unit/media-routes.test.ts が routes/media から参照）を保つため再エクスポートする。
export { applyExternalMaterial, type ExternalArticleMaterial, externalMaterialOf }

// ---------- 統合メトリクスの受領検証・サーバー突合（M2。純粋関数・単体テスト対象） ----------

/**
 * 統合メトリクス（業務 × メディア）の**サーバー組み立て**（Phase C = salesRecords の API 移行で
 * クライアント合成を廃止）。連携済みチャンネル（channel.segment_id あり）でのみ利用可能:
 * - 売上月次 = sales_records（SoT。連携先 segmentId で絞る）を foldBusinessMonthly で集計
 * - メディア月次 = GA（fetchMonthlyTrend = channelId keying・30 分キャッシュ・force 対応）。
 *   未連携は 0（mediaConnected=false）。取得失敗は mediaFailed=true で返し、0 を実データの顔で
 *   描画・保管させない（M1。生成側は 004 で拒否）
 */
export interface IntegratedBuildResult {
  metrics: IntegratedMetrics
  mediaConnected: boolean
  mediaFailed: boolean
}

/**
 * 統合メトリクスの内部組み立て（売上軸 = segmentId で sales_records / メディア軸 = channelId で GA）。
 * channelId が null（連携チャンネルなし）ならメディア軸 0（mediaConnected=false）。
 */
async function composeSalesAndGa(
  pool: pg.Pool, env: Env,
  args: { segmentId: string; channelId: string | null; segmentName: string; siteName: string; monthsCount: number; force: boolean },
): Promise<IntegratedBuildResult> {
  const months = recentMonthKeys(args.monthsCount, 1, todayJst())
  // 売上月次。**対象月窓に絞って取得**する（無順序 LIMIT では明細超過セグメントで誤集計 = Codex P1-3）。
  // 窓の判定は foldBusinessMonthly の帰属月と一致させる（通常明細は自身の売上月・赤黒訂正は元伝票の計上月）。
  const periodFrom = `${months[0]!}-01`
  const periodTo = monthEndOf(months[months.length - 1]!)
  const { rows: salesRows } = await pool.query<{ id: string; salesDate: string; amount: number; correctionOf: string | null }>(
    `SELECT r.id, r.sales_date AS "salesDate", r.amount, r.correction_of AS "correctionOf"
     FROM sales_records r
     LEFT JOIN sales_records o ON o.id = r.correction_of
     WHERE r.segment_id = $1 AND r.active
       AND COALESCE(o.sales_date, r.sales_date) >= $2
       AND COALESCE(o.sales_date, r.sales_date) <= $3`,
    [args.segmentId, periodFrom, periodTo])
  const biz = foldBusinessMonthly(salesRows, months)
  let mediaBy = new Map<string, MediaMonthlyPoint>()
  let mediaConnected = false
  let mediaFailed = false
  if (args.channelId && googleOauthEnabled(env)) {
    const access = await gaAccess(pool, env, args.channelId)
    if (access?.token && access.propertyId) {
      mediaConnected = true
      try {
        const points = await fetchMonthlyTrend(pool, env, args.channelId, args.monthsCount, args.force)
        mediaBy = new Map(points.map(p => [p.month, p]))
      } catch (e) {
        // GA 一時障害はメディア軸 0 の組み立て + mediaFailed で報告（原則4。呼び出し側が描画・生成を判断）
        console.warn('media integrated: monthly fetch failed:', (e as Error).message)
        mediaFailed = true
      }
    }
  }
  const metrics = composeIntegratedMetrics({
    segmentId: args.segmentId, segmentName: args.segmentName, siteName: args.siteName, months, mediaBy, biz,
  })
  return { metrics, mediaConnected, mediaFailed }
}

/**
 * チャンネル基点の統合メトリクス（/v1/media/integrated・integrated インサイト生成）。
 * 連携済みチャンネル（channel.segment_id あり）でのみ利用可能。未連携は AKO-MEDIA-022。
 */
export async function buildIntegratedMetrics(
  pool: pg.Pool, env: Env, channelId: string, monthsCount: number, force: boolean,
): Promise<IntegratedBuildResult> {
  const channel = await channelRow(pool, channelId)
  if (!channel) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
  const segmentId = channel.segmentId
  if (!segmentId) {
    throw err('AKO-MEDIA-022', '業務 × メディアの統合分析には、連携する Akebono 業務アプリ（業態）が必要です。メディア設定で連携してください', 400)
  }
  const { rows: segRows } = await pool.query<{ name: string }>(
    `SELECT name FROM business_segments WHERE id = $1`, [segmentId])
  return composeSalesAndGa(pool, env, {
    segmentId, channelId,
    segmentName: segRows[0]?.name ?? channel.name ?? 'セグメント',
    siteName: channel.siteName || channel.name || 'メディア',
    monthsCount, force,
  })
}

/**
 * 業態基点の統合メトリクス（F-41 ポートフォリオダッシュボード用）。業態に連携したメディアチャンネルを
 * 解決し（複数あれば id = segmentId の下位互換チャンネルを優先・無ければ先頭・連携なしは売上軸のみ）、
 * メディア軸をそのチャンネルの GA から組み立てる。**未連携でも売上軸を返す**（例外を投げない）。
 */
export async function buildSegmentIntegratedMetrics(
  pool: pg.Pool, env: Env, segmentId: string, monthsCount: number, force: boolean,
): Promise<IntegratedBuildResult> {
  const { rows: segRows } = await pool.query<{ name: string }>(
    `SELECT name FROM business_segments WHERE id = $1`, [segmentId])
  const { rows: chRows } = await pool.query<{ id: string; siteName: string; name: string }>(
    `SELECT id, site_name AS "siteName", name FROM media_channels
     WHERE segment_id = $1 AND active = true
     ORDER BY (id = $1) DESC, id LIMIT 1`, [segmentId])
  const channel = chRows[0] ?? null
  return composeSalesAndGa(pool, env, {
    segmentId, channelId: channel?.id ?? null,
    segmentName: segRows[0]?.name ?? 'セグメント',
    siteName: channel?.siteName || channel?.name || 'メディア',
    monthsCount, force,
  })
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

async function llmMediaInsight(env: Env, metrics: MediaMetrics, materials: ExternalArticleMaterial[]): Promise<MediaInsight | null> {
  if (!env.vertexProjectId) return null
  // 外部投稿記事の原文抜粋をプロンプト材料に添える（自社サイト GA には現れない露出を洞察へ反映。新機能）
  const externalBlock = materials.length === 0
    ? ''
    : `\n\n# 外部媒体への投稿記事（${materials.length} 件・自社サイト外の露出。原文抜粋）\n`
      + materials.map((m, i) => `## ${i + 1}. ${m.title}${m.source ? `（${m.source}）` : ''}\n${m.bodyExcerpt}`).join('\n\n')
  const res = await generateJson<MediaInsight>(env, {
    system: 'あなたはオウンドメディアのアクセス解析コンサルタント AI です。Google Analytics の集計から、'
      + 'サイト構成・記事へのインサイトと「次に起こすべきアクション」を日本語で出力します。'
      + '外部媒体への投稿記事が提供された場合は、その内容を自社サイトへ再掲・内部リンクで流入資産化する観点も加味します。'
      + '集計値・提供された原文にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'executiveSummary は 3〜5 文（マークダウン可）。kind は win / issue / opportunity、'
      + 'priority は high / mid / low。各 title は 40 字以内・detail は具体的かつ簡潔に（最大 各 5 件）。',
    prompt: `# メディア集計（${metrics.periodFrom}〜${metrics.periodTo}・${metrics.days} 日間）\n${JSON.stringify(metrics, null, 1)}${externalBlock}`,
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
 * 2 段で担保する（calendar と同型のアカウントリンク CSRF 対策）。復帰先は /media/settings?...&channel=
 */
export function mediaOauthCallback(pool: pg.Pool, env: Env) {
  return async (c: Context) => {
    const frontOrigin = env.corsOrigins[0] ?? ''
    const back = (q: string) => c.redirect(`${frontOrigin}/#/media/settings?${q}`, 302)
    const fail = (reason: string, channelId = '') =>
      back(`ga=error&reason=${encodeURIComponent(reason)}${channelId ? `&channel=${encodeURIComponent(channelId)}` : ''}`)
    if (!googleOauthEnabled(env)) return fail('not-configured')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    const st = await consumeState(pool, state)
    const oauthError = c.req.query('error')
    if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'oauth-error', st?.channelId ?? '')
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
        return fail('token-exchange', st.channelId)
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
        return fail('account-mismatch', st.channelId)
      }
      // 再連携時に refresh_token が返らないことがある（既存を保持）。選択済みプロパティも保持する
      // （再連携 = トークン更新であり、プロパティ選択のやり直しを強制しない = 冪等）
      await pool.query(
        `INSERT INTO media_ga_tokens
           (channel_id, access_token_enc, refresh_token_enc, expires_at, scope, connected_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, media_ga_tokens.refresh_token_enc),
           expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
           connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
        [st.channelId, encryptSecret(body.access_token, env.tokenEncryptionKey),
          body.refresh_token ? encryptSecret(body.refresh_token, env.tokenEncryptionKey) : null,
          new Date(Date.now() + body.expires_in * 1000).toISOString(), body.scope ?? '', st.memberId])
      await clearMetricsCache(pool, st.channelId)
      return back(`ga=connected&channel=${encodeURIComponent(st.channelId)}`)
    } catch (e) {
      console.warn('media oauth callback failed:', (e as Error).message)
      return fail('exchange-error', st.channelId)
    }
  }
}

// ---------- ルート ----------

const GENERATED_COLS = `g.id, g.channel_id AS "channelId", g.brief_id AS "briefId", g.payload, g.llm,
  g.adopted_article_id AS "adoptedArticleId", g.active,
  g.created_by AS "createdBy",
  to_char(g.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

const ARTICLE_COLS = `id, channel_id AS "channelId", path, title, section,
  published_at::text AS "publishedAt", word_count AS "wordCount", status, origin,
  generated_article_id AS "generatedArticleId", active`

const EXTERNAL_COLS = `id, channel_id AS "channelId", title, url, source,
  published_at::text AS "publishedAt", body, notes, active,
  created_by AS "createdBy",
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

interface GeneratedRow {
  id: string
  channelId: string
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

/** 外部記事の入力検証（純粋関数・単体テスト対象。title/body 必須・publishedAt は空可） */
export interface ExternalArticleInput {
  title: string
  url: string
  source: string
  publishedAt: string | null
  body: string
  notes: string
}
export function externalArticleInputOf(body: Record<string, unknown>): ExternalArticleInput {
  const title = capCp(String(body.title ?? '').trim(), 200)
  const content = capCp(String(body.body ?? '').trim(), 50000)
  if (!title) throw err('AKO-MEDIA-023', 'タイトルを入力してください', 400)
  if (!content) throw err('AKO-MEDIA-023', '記事の原文（本文）を入力してください', 400)
  const publishedAtRaw = String(body.publishedAt ?? '').trim()
  if (publishedAtRaw && !/^\d{4}-\d{2}-\d{2}$/.test(publishedAtRaw)) {
    throw err('AKO-MEDIA-023', 'publishedAt は YYYY-MM-DD 形式で指定してください', 400)
  }
  return {
    title,
    url: capCp(String(body.url ?? '').trim(), 500),
    source: capCp(String(body.source ?? '').trim(), 100),
    publishedAt: publishedAtRaw || null,
    body: content,
    notes: capCp(String(body.notes ?? '').trim(), 2000),
  }
}

export function mediaRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---- チャンネル一覧（全ロール参照可。GA 接続状態を各行へ合成する）----
  app.get('/channels', async (c) => {
    const includeInactive = c.req.query('includeInactive') === '1'
    const { rows } = await pool.query<ChannelRow & { propertyId: string | null; propertyName: string | null; accessTokenEnc: string | null; connectedAt: string | null }>(
      `SELECT ${CHANNEL_COLS},
              t.property_id AS "propertyId", t.property_name AS "propertyName",
              t.access_token_enc AS "accessTokenEnc",
              to_char(t.connected_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "connectedAt"
       FROM media_channels ch LEFT JOIN media_ga_tokens t ON t.channel_id = ch.id
       ${includeInactive ? '' : 'WHERE ch.active = true'}
       ORDER BY ch.active DESC, ch.name, ch.id`)
    const data = rows.map((r) => {
      const decryptable = r.accessTokenEnc ? decryptSecret(r.accessTokenEnc, env.tokenEncryptionKey) !== null : false
      const gaEnabled = googleOauthEnabled(env)
      const connected = gaEnabled && decryptable && Boolean(r.propertyId)
      return {
        id: r.id, name: r.name, segmentId: r.segmentId, siteName: r.siteName, siteUrl: r.siteUrl,
        analysisGoal: r.analysisGoal, targetAudience: r.targetAudience, defaultTone: r.defaultTone,
        keywords: r.keywords, active: r.active,
        gaConnected: connected,
        gaPropertyId: connected ? r.propertyId : null,
        gaPropertyName: connected ? r.propertyName : null,
        gaConnectedAt: connected ? r.connectedAt : null,
      }
    })
    return c.json({ data })
  })

  // ---- チャンネル作成（管理者のみ。name 必須・segmentId 任意）----
  app.post('/channels', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const patch = settingsPatchOf(body)
    if (!patch.name) throw err('AKO-MEDIA-020', 'チャンネル名を入力してください', 400)
    const id = newId('mc')
    const { rows } = await pool.query(
      `INSERT INTO media_channels (id, name, segment_id, site_name, site_url, analysis_goal, target_audience, default_tone, keywords, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${CHANNEL_COLS}`,
      [id, patch.name, patch.segmentId ?? null,
        patch.siteName ?? '', patch.siteUrl ?? '', patch.analysisGoal ?? 'awareness',
        patch.targetAudience ?? '', patch.defaultTone ?? 'formal',
        JSON.stringify(patch.keywords ?? []), patch.active ?? true])
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'media_channels', entityId: id,
      detail: `メディアチャンネルを作成: ${patch.name}`,
    })
    return c.json({ data: rows[0] }, 201)
  })

  // ---- チャンネル編集（管理者のみ。送ったキーのみ上書き = 未指定は保持）----
  const updateChannel = async (c: Context) => {
    const user = requireAdmin(c)
    const id = c.req.param('id') ?? ''
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const patch = settingsPatchOf(body)
    if (Object.hasOwn(patch, 'name') && !patch.name) throw err('AKO-MEDIA-020', 'チャンネル名を入力してください', 400)
    const { assigns, values } = channelUpdateParts(patch)
    const { rows } = await pool.query(
      `UPDATE media_channels SET ${assigns.join(', ')} WHERE id = $1 RETURNING ${CHANNEL_COLS}`,
      [id, ...values])
    if (!rows[0]) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
    // site_name / segment 連携は metrics・統合の SoT に影響 → 導出キャッシュを破棄（原則6）
    await clearMetricsCache(pool, id)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_channels', entityId: id, detail: 'メディアチャンネルを更新',
    })
    return c.json({ data: rows[0] })
  }
  app.put('/channels/:id', updateChannel)
  app.patch('/channels/:id', updateChannel)

  // ---- チャンネルの取消（論理削除）・復元（原則9.5。管理者のみ）----
  app.post('/channels/:id/archive', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE media_channels SET active = false, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_channels', entityId: id, detail: 'メディアチャンネルを取消（論理削除）' })
    return c.json({ data: { id } })
  })

  app.post('/channels/:id/restore', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE media_channels SET active = true, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_channels', entityId: id, detail: 'メディアチャンネルを復元' })
    return c.json({ data: { id } })
  })

  // ---- GA 連携状態（設定未投入なら enabled=false でフロントは連携 UI を隠す）----
  app.get('/status', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
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
       FROM media_ga_tokens WHERE channel_id = $1`, [channelId])
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
    const channelId = channelIdOf(c.req.query('channelId'))
    const params = new URLSearchParams({
      client_id: env.googleOauthClientId,
      redirect_uri: redirectUri(c),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state: await issueState(pool, user.id, channelId),
    })
    return c.json({ data: { url: `${GOOGLE_AUTH_URL}?${params.toString()}` } })
  })

  // ---- GA4 プロパティ一覧（管理者のみ。OAuth 後の選択肢。Admin API accountSummaries を平坦化）----
  app.get('/properties', async (c) => {
    requireEnabled(env)
    requireAdmin(c)
    const channelId = channelIdOf(c.req.query('channelId'))
    const access = await gaAccess(pool, env, channelId)
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
    const channelId = channelIdOf(body.channelId)
    const propertyId = String(body.propertyId ?? '').trim()
    if (!/^properties\/\d+$/.test(propertyId)) {
      throw err('AKO-GEN-001', 'propertyId は properties/<数値> 形式で指定してください', 400)
    }
    const propertyName = capCp(String(body.propertyName ?? '').trim(), 200) || propertyId
    const { rowCount } = await pool.query(
      `UPDATE media_ga_tokens SET property_id = $2, property_name = $3, updated_at = now() WHERE channel_id = $1`,
      [channelId, propertyId, propertyName])
    if (rowCount === 0) {
      throw err('AKO-MEDIA-003', 'Google Analytics が未連携です。先に Google アカウントを連携してください', 409)
    }
    await clearMetricsCache(pool, channelId)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_ga_tokens', entityId: channelId,
      detail: `GA4 プロパティを設定: ${propertyName}`,
    })
    return c.json({ data: { channelId, propertyId, propertyName } })
  })

  // ---- 連携解除（管理者のみ。revoke は補助処理・トークンは物理削除。設定・記事は残す = 非破壊。原則9.5）----
  app.post('/disconnect', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const access = googleOauthEnabled(env) ? await gaAccess(pool, env, channelId) : null
    await pool.query(`DELETE FROM media_ga_tokens WHERE channel_id = $1`, [channelId])
    await clearMetricsCache(pool, channelId)
    if (access?.token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(access.token)}`, {
          method: 'POST', signal: AbortSignal.timeout(5_000),
        })
      } catch { /* 非ブロッキング（Google 側で失効済みでも解除は成立） */ }
    }
    await audit(pool, {
      actorId: user.id, action: 'delete', entity: 'media_ga_tokens', entityId: channelId,
      detail: 'GA 連携を解除',
    })
    return c.json({ data: { ok: true } })
  })

  // ---- GA 集計（全ロール参照可）----
  app.get('/metrics', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const days = Math.min(90, Math.max(7, Math.round(Number(c.req.query('days') ?? 28)) || 28))
    const force = c.req.query('force') === '1'
    const result = await fetchMediaMetrics(pool, env, channelId, days, force)
    return c.json({ data: result })
  })

  // ---- 月次トレンド（統合 PDCA 用）----
  app.get('/monthly', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const months = Math.min(12, Math.max(2, Math.round(Number(c.req.query('months') ?? 6)) || 6))
    const force = c.req.query('force') === '1'
    const points = await fetchMonthlyTrend(pool, env, channelId, months, force)
    return c.json({ data: points })
  })

  // ---- 統合メトリクス（業務 × メディア。Phase C = サーバー組み立て）----
  // 連携済みチャンネル（channel.segment_id あり）でのみ利用可能（未連携は AKO-MEDIA-022）。
  // GA 未連携でも売上軸は返す（mediaConnected=false = メディア軸 0 が正）。
  // GA 一時障害は mediaFailed=true（フロントは 0 描画せず失敗表示 + 再試行導線 = M1）
  app.get('/integrated', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const months = Math.min(12, Math.max(2, Math.round(Number(c.req.query('months') ?? 6)) || 6))
    const force = c.req.query('force') === '1'
    const result = await buildIntegratedMetrics(pool, env, channelId, months, force)
    return c.json({ data: result })
  })

  // ---- メディア設定（AI 分析設定・連携先。GA 接続状態は /status が SoT）----
  app.get('/settings', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const row = await channelRow(pool, channelId)
    // 未作成は null（フロントが表示既定 defaultMediaChannel で補う）
    return c.json({ data: row })
  })

  // 設定 PUT = 既存チャンネル行の部分更新（送ったキーのみ上書き）。チャンネル未作成は 404（作成は POST /channels）
  app.put('/settings', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const patch = settingsPatchOf(body)
    if (Object.hasOwn(patch, 'name') && !patch.name) throw err('AKO-MEDIA-020', 'チャンネル名を入力してください', 400)
    const { assigns, values } = channelUpdateParts(patch)
    const { rows } = await pool.query(
      `UPDATE media_channels SET ${assigns.join(', ')} WHERE id = $1 RETURNING ${CHANNEL_COLS}`,
      [channelId, ...values])
    if (!rows[0]) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
    // siteName / 連携は metrics・統合の SoT に影響するため導出キャッシュを破棄（m8・原則6）
    await clearMetricsCache(pool, channelId)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_channels', entityId: channelId,
      detail: 'メディア設定を更新',
    })
    return c.json({ data: rows[0] })
  })

  // ---- 記事インベントリ ----
  app.get('/articles', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const includeInactive = c.req.query('includeInactive') === '1'
    const { rows } = await pool.query(
      `SELECT ${ARTICLE_COLS} FROM media_articles
       WHERE channel_id = $1 ${includeInactive ? '' : 'AND active = true'}
       ORDER BY published_at DESC, id LIMIT 1000`, [channelId])
    return c.json({ data: rows })
  })

  // 手動登録（管理者のみ）。実データはシードしないため、既存サイトの記事を分析対象へ加える回復パス（原則6）。
  // GA だけでも topPages/sections は表示されるが、インベントリ登録でセクション対応と記事数が正確になる
  app.post('/articles', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
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
        `INSERT INTO media_articles (id, channel_id, path, title, section, published_at, word_count, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'seed')
         RETURNING ${ARTICLE_COLS}`,
        [id, channelId, path, title, section, publishedAt, wordCount, status])
      rows = result.rows
    } catch (e) {
      // 部分一意 INDEX（channel_id, path WHERE active）違反 = 再送・二重クリックの重複登録（m5。冪等の案内）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-MEDIA-008', '同じパスの記事が既に登録されています', 409)
      }
      throw e
    }
    await clearMetricsCache(pool, channelId)
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
    const { rows } = await pool.query<{ channelId: string }>(
      `UPDATE media_articles SET active = false, updated_at = now() WHERE id = $1 RETURNING channel_id AS "channelId"`, [id])
    if (!rows[0]) throw err('AKO-MEDIA-007', '対象の記事が見つかりません', 404)
    await clearMetricsCache(pool, rows[0].channelId)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_articles', entityId: id, detail: '記事を取消（論理削除）' })
    return c.json({ data: { id } })
  })

  app.post('/articles/:id/restore', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    let rows: { channelId: string }[]
    try {
      const result = await pool.query<{ channelId: string }>(
        `UPDATE media_articles SET active = true, updated_at = now() WHERE id = $1 RETURNING channel_id AS "channelId"`, [id])
      rows = result.rows
    } catch (e) {
      // 同一パスの有効な記事が既に存在する場合（取消後に再登録された等）は復元できない（部分一意 INDEX との整合）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-MEDIA-008', '同じパスの有効な記事が存在するため復元できません（既存の記事を取り消してから復元してください）', 409)
      }
      throw e
    }
    if (!rows[0]) throw err('AKO-MEDIA-007', '対象の記事が見つかりません', 404)
    await clearMetricsCache(pool, rows[0].channelId)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_articles', entityId: id, detail: '記事を復元' })
    return c.json({ data: { id } })
  })

  // ---- AI 記事生成（全ロール可 = home の記事生成スタジオと同じ可視性）----
  app.post('/articles/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
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
    // チャンネル名/連携業態名はクライアントから受ける（表示・文面用途のみ）
    const segmentName = capCp(String(body.segmentName ?? '').trim(), 100)

    const { rows: channelRows } = await pool.query<{ siteName: string; targetAudience: string; name: string }>(
      `SELECT site_name AS "siteName", target_audience AS "targetAudience", name FROM media_channels WHERE id = $1`,
      [channelId])
    const setting = channelRows[0]
    const audience = capCp(String(body.audience ?? '').trim(), 200) || setting?.targetAudience || '読者'

    // 過去分析からの生成: 保管済みメディアインサイトのヒント文を生成の前提に添える
    let insightHints: string[] = []
    if (fromInsightId) {
      const { rows } = await pool.query<{ insight: unknown }>(
        `SELECT insight FROM media_insights WHERE id = $1 AND channel_id = $2 AND scope = 'media'`,
        [fromInsightId, channelId])
      insightHints = rows[0] ? insightHintsOf(rows[0].insight) : []
    }

    const genInput: ArticleGenInput = {
      topic, keyword,
      purpose: purpose as ArticlePurpose, quality: quality as ArticleQuality, tone: tone as ArticleTone,
      audience,
      siteName: setting?.siteName || setting?.name || segmentName || 'メディア',
      segmentName: segmentName || setting?.name || setting?.siteName || 'メディア',
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
        `INSERT INTO media_article_briefs (id, channel_id, topic, keyword, purpose, quality, tone, audience, from_insight_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [briefId, channelId, topic, keyword, purpose, quality, tone, audience, fromInsightId, user.id])
      await client.query(
        `INSERT INTO media_generated_articles (id, channel_id, brief_id, payload, llm, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [genId, channelId, briefId, JSON.stringify(draft), !!llmDraft, user.id])
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
    const channelId = channelIdOf(c.req.query('channelId'))
    const { rows } = await pool.query<GeneratedRow>(
      `SELECT ${GENERATED_COLS} FROM media_generated_articles g
       WHERE g.channel_id = $1 ORDER BY g.created_at DESC, g.id LIMIT 500`, [channelId])
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
      // 分析の集計基準は前日（asOf）。採用直後に期間へ入るよう公開日を前日にする（home adopt と同じ判断）
      await client.query(
        `INSERT INTO media_articles (id, channel_id, path, title, section, published_at, word_count, status, origin, generated_article_id)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, 'published', 'generated', $8)`,
        [articleId, g.channelId, `/blog/gen-${articleId}`, capCp(g.payload.title, 200), section,
          addDays(todayJst(), -1), g.payload.estWordCount, g.id])
      await client.query(
        `UPDATE media_generated_articles SET adopted_article_id = $2, updated_at = now() WHERE id = $1`,
        [id, articleId])
      await client.query('COMMIT')
      await clearMetricsCache(pool, g.channelId)
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
      await clearMetricsCache(pool, g.channelId)
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
      await clearMetricsCache(pool, g.channelId)
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

  // ---- 外部投稿記事（media インサイト生成の材料。取消/復元 = 原則9.5）----
  app.get('/external-articles', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const includeInactive = c.req.query('includeInactive') === '1'
    const { rows } = await pool.query(
      `SELECT ${EXTERNAL_COLS} FROM media_external_articles
       WHERE channel_id = $1 ${includeInactive ? '' : 'AND active = true'}
       ORDER BY COALESCE(published_at, created_at::date) DESC, created_at DESC, id LIMIT 500`, [channelId])
    return c.json({ data: rows })
  })

  app.post('/external-articles', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const input = externalArticleInputOf(body)
    const id = newId('mx')
    const { rows } = await pool.query(
      `INSERT INTO media_external_articles (id, channel_id, title, url, source, published_at, body, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9)
       RETURNING ${EXTERNAL_COLS}`,
      [id, channelId, input.title, input.url, input.source, input.publishedAt || null, input.body, input.notes, user.id])
    // 外部記事は media インサイト生成の材料 → 導出キャッシュ（インサイト側は再生成で更新）に影響しないが
    // 一貫性のため audit を残す
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'media_external_articles', entityId: id,
      detail: `外部投稿記事を登録: ${input.title}`,
    })
    return c.json({ data: rows[0] }, 201)
  })

  app.patch('/external-articles/:id', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = externalArticleInputOf(body)
    const { rows } = await pool.query(
      `UPDATE media_external_articles
       SET title = $2, url = $3, source = $4, published_at = $5::date, body = $6, notes = $7, updated_at = now()
       WHERE id = $1 RETURNING ${EXTERNAL_COLS}`,
      [id, input.title, input.url, input.source, input.publishedAt || null, input.body, input.notes])
    if (!rows[0]) throw err('AKO-MEDIA-024', '対象の外部投稿記事が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_external_articles', entityId: id, detail: '外部投稿記事を更新' })
    return c.json({ data: rows[0] })
  })

  app.post('/external-articles/:id/archive', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE media_external_articles SET active = false, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-024', '対象の外部投稿記事が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_external_articles', entityId: id, detail: '外部投稿記事を取消（論理削除）' })
    return c.json({ data: { id } })
  })

  app.post('/external-articles/:id/restore', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE media_external_articles SET active = true, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-024', '対象の外部投稿記事が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'media_external_articles', entityId: id, detail: '外部投稿記事を復元' })
    return c.json({ data: { id } })
  })

  // 保管済みインサイトの参照列（warning = 劣化データ由来の告知。閲覧者にも生成時の集計状態を明示する）
  const INSIGHT_COLS = `mi.id, mi.period_key AS "periodKey", mi.metrics, mi.insight, mi.llm, mi.warning,
              to_char(mi.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt",
              m.name AS "generatedByName"`

  // ---- AI インサイト（保管済みの取得。未生成は null）----
  app.get('/insights', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const scope = c.req.query('scope')
    if (scope !== 'media' && scope !== 'integrated') throw err('AKO-GEN-001', 'scope は media / integrated を指定してください', 400)
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM media_insights mi LEFT JOIN members m ON m.id = mi.generated_by
       WHERE mi.channel_id = $1 AND mi.scope = $2`, [channelId, scope])
    return c.json({ data: rows[0] ?? null })
  })

  // ---- AI インサイトの生成・再生成（生成 → 保管 → 再生成で upsert 上書き = weekly_insights と同型）----
  // 認可の設計判断: 生成は全ロール可（home の分析ページと同じ可視性。generated_by を保存 = 誰の操作か追跡可能）。
  // scope=media は GA 集計 + 外部投稿記事の原文を材料に生成する。
  // scope=integrated は連携済みチャンネルでのみ（buildIntegratedMetrics が未連携を AKO-MEDIA-022 で拒否）。
  app.post('/insights/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
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
      const result = await fetchMediaMetrics(pool, env, channelId, 28, false)
      // 外部投稿記事の原文を材料に取り込む（active のみ。新機能。原則4: heuristic/LLM の両経路へ反映）
      const { rows: extRows } = await pool.query<{ title: string; source: string; body: string }>(
        `SELECT title, source, body FROM media_external_articles
         WHERE channel_id = $1 AND active = true ORDER BY COALESCE(published_at, created_at::date) DESC LIMIT 20`,
        [channelId])
      const materials = externalMaterialOf(extRows)
      metrics = result.metrics
      warning = result.warning ? `部分的な集計から生成: ${result.warning}` : null
      const llmRes = await llmMediaInsight(env, result.metrics, materials)
      insight = applyExternalMaterial(llmRes ?? heuristicMediaInsight(result.metrics), materials)
      llm = !!llmRes
      periodKey = `${result.metrics.periodFrom}_${result.metrics.periodTo}`
    } else {
      // 統合（業務 × メディア）: サーバー組み立て（Phase C）。連携済みチャンネルのみ（buildIntegratedMetrics が
      // 未連携を AKO-MEDIA-022 で拒否）。GA 連携済みで月次が取れない場合は生成しない（メディア軸 0 の
      // 虚偽データ由来インサイトを保管させない = M1 をサーバー側でも強制）
      const monthsRaw = Number(body.months ?? 6)
      const monthsCount = Math.min(12, Math.max(2, Number.isFinite(monthsRaw) ? Math.round(monthsRaw) : 6))
      const built = await buildIntegratedMetrics(pool, env, channelId, monthsCount, false)
      if (built.mediaFailed) {
        throw err('AKO-MEDIA-004', 'Google Analytics の月次トレンドを取得できないため、統合インサイトを生成できません。時間をおいて再試行してください', 502)
      }
      metrics = built.metrics
      const llmRes = await llmIntegratedInsight(env, built.metrics)
      insight = llmRes ?? heuristicIntegratedInsight(built.metrics)
      llm = !!llmRes
      periodKey = built.metrics.periodMonth
    }

    await pool.query(
      `INSERT INTO media_insights (id, channel_id, scope, period_key, metrics, insight, llm, warning, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (channel_id, scope) DO UPDATE SET
         period_key = EXCLUDED.period_key, metrics = EXCLUDED.metrics, insight = EXCLUDED.insight,
         llm = EXCLUDED.llm, warning = EXCLUDED.warning, generated_by = EXCLUDED.generated_by, generated_at = now()`,
      [newId('mi'), channelId, scope, periodKey, JSON.stringify(metrics), JSON.stringify(insight), llm, warning, user.id])
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM media_insights mi LEFT JOIN members m ON m.id = mi.generated_by
       WHERE mi.channel_id = $1 AND mi.scope = $2`, [channelId, scope])
    return c.json({ data: rows[0] })
  })

  return app
}
