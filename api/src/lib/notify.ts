/**
 * 通知の発行（補助処理・非ブロッキング: 失敗しても主フローを止めない。開発原則4）
 * mockup useNotifications.notify / notifyAdmins の API 版。
 *
 * 個人別マルチチャネル通知連携（改修依頼 2026-08-20）で配信エンジンを拡張。シグネチャは不変:
 * - チャネル判定: 宛先ユーザーの通知マトリクス（user_preferences 'notificationChannels'。
 *   純ロジックは shared/domain/notification-channels.ts が SoT）を参照する。
 *   in_app が OFF の種別はアプリ内通知（INSERT）をスキップ。
 *   **fail-open / fail-closed の設計判断:** マトリクス取得に失敗した場合、アプリ内通知は送る
 *   （fail-open。承認依頼等の取りこぼしによる業務遅延の方が実害が大きい）。外部チャネルは
 *   送らない（fail-closed。設定不明のまま外部サービスへ送る誤送信を作らない）。
 * - 外部配信（Slack / Google Chat の DM）は fire-and-forget（void + catch）。外部 API の失敗・
 *   遅延・リトライは主フロー（INSERT・呼び出し元のレスポンス）へ一切影響しない。
 *   Slack = chat.postMessage（channel = 連携ユーザー id = 本人宛 DM）/
 *   Google Chat = spaces.findDirectMessage → messages.create。外部 HTTP は全て 15 秒タイムアウト。
 * - リトライ: HTTP 5xx / 429（Slack の ratelimited 含む）は指数バックオフ（1s→2s→4s・計 3 回)。
 * - 失効処理: 401 / invalid_auth / token_expired 等は user_chat_links.status='reauth_required' へ
 *   更新し、アプリ内通知で再連携を催促する（status='connected' の行のみ更新 = 初回検知時だけ催促する
 *   冪等ガード。催促通知自体は外部配信しない = 再帰ループ防止）。
 * - 有効化: 外部配信は configureExternalDispatch(pool, env)（routes/notification-channels.ts の
 *   ルートファクトリがマウント時に登録）後に動く。fire-and-forget は呼び出し元の db ハンドル
 *   （トランザクション中の PoolClient = 応答後に解放され得る）を使わず、登録された Pool を使う。
 * - リアルタイム配信（SSE/WebSocket）は導入しない設計判断: クライアントは既存の 60 秒ポーリング
 *   （mockup useNotifications）を維持し、即時性は外部チャネル（Slack / Google Chat の DM）が担う。
 */
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import type { NotificationKind } from '../../../shared/domain/types'
import {
  CHANNEL_META, channelEnabled, type ChatService, enabledExternalServices,
  NOTIFICATION_CHANNELS_PREF_KEY, type NotificationMatrix, parseNotificationMatrix,
} from '../../../shared/domain/notification-channels'
import type { Env } from '../env'
import { decryptSecret, encryptSecret } from './crypto'
import { newId } from './ids'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_CHAT_BASE = 'https://chat.googleapis.com/v1'
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'
/** 外部 HTTP の共通タイムアウト */
const EXTERNAL_TIMEOUT_MS = 15_000

// ---------- 外部配信コンテキスト（notification-channels ルートのマウント時に登録） ----------

let dispatchCtx: { pool: pg.Pool; env: Env } | null = null

/**
 * 外部チャット配信を有効化する（routes/notification-channels.ts のルートファクトリが呼ぶ）。
 * 未登録の間は従来どおりアプリ内通知のみ（マトリクスの in_app 判定は登録前でも有効）。
 */
export function configureExternalDispatch(pool: pg.Pool, env: Env): void {
  dispatchCtx = { pool, env }
}

export async function notify(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  await notifyInternal(db, memberId, kind, title, body, link, true)
}

/** 管理者全員へ通知する（mockup と同一: role='admin' の在籍者） */
export async function notifyAdmins(
  db: pg.Pool | pg.PoolClient,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM members WHERE active = true AND role = 'admin'`)
    for (const m of rows) {
      await notify(db, m.id, kind, title, body, link)
    }
  } catch (e) {
    console.warn('notifyAdmins failed (non-blocking):', (e as Error).message)
  }
}

/**
 * 本体（external=false は「再連携のお願い」等の内部通知 = 外部配信しない。再帰ループ防止ガード）。
 * マトリクス参照 → in_app 判定 → INSERT → 外部配信の fire-and-forget、の順。
 */
async function notifyInternal(
  db: pg.Pool | pg.PoolClient,
  memberId: string,
  kind: NotificationKind,
  title: string,
  body: string,
  link: string,
  external: boolean,
): Promise<void> {
  // 宛先ユーザーの通知マトリクス（取得失敗 = null → in_app へ送る fail-open / 外部へは送らない fail-closed）
  let matrix: NotificationMatrix | null = null
  try {
    const { rows } = await db.query<{ value: unknown }>(
      `SELECT value FROM user_preferences WHERE member_id = $1 AND key = $2`,
      [memberId, NOTIFICATION_CHANNELS_PREF_KEY])
    matrix = parseNotificationMatrix(rows[0]?.value) // 行なし = {} = 全セル既定値（in_app のみ ON）
  } catch (e) {
    console.warn('notify: matrix load failed (fail-open to in_app):', (e as Error).message)
  }
  if (!matrix || channelEnabled(matrix, kind, 'in_app')) {
    try {
      await db.query(
        `INSERT INTO notifications (id, member_id, kind, title, body, link, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('nt'), memberId, kind, title, body, link, nowJstIso()],
      )
    } catch (e) {
      console.warn('notify failed (non-blocking):', (e as Error).message)
    }
  }
  // 外部配信は fire-and-forget（登録済み Pool を使用。呼び出し元の db が PoolClient でも安全）
  const ctx = dispatchCtx
  if (external && matrix && ctx) {
    const services = enabledExternalServices(matrix, kind)
    if (services.length > 0) {
      void dispatchExternal(ctx, memberId, services, title, body, link)
        .catch(e => console.warn('notify external dispatch failed (non-blocking):', (e as Error).message))
    }
  }
}

// ---------- 外部配信エンジン ----------

interface ChatLinkRow {
  service: ChatService
  externalUserId: string
  accessTokenEnc: string
  refreshTokenEnc: string
  status: string
  expiresAt: string | null
}

const LINK_COLS = `service, external_user_id AS "externalUserId", access_token_enc AS "accessTokenEnc",
  refresh_token_enc AS "refreshTokenEnc", status, expires_at AS "expiresAt"`

/** 1 回の送信試行の結果。retry = 一時障害（5xx/429/タイムアウト）/ auth = 失効（要再認証へ） */
type DeliveryResult = 'ok' | 'auth' | 'retry' | 'fail'

/**
 * 失敗詳細の受け皿（テスト送信の診断用 = デプロイ障害対応 2026-08-20）。
 * どのステップが何の応答で失敗したかを 1 行で記録し、テスト送信のエラーメッセージへ併記して
 * オペレーターが自己診断できるようにする（バックグラウンド配信では未使用 = 挙動不変）
 */
export interface FailureDetailSink { detail?: string }

/**
 * 指数バックオフの待ち時間列（1s→2s→4s。既定 3 回）。純関数（単体テスト対象）。
 */
export function backoffDelays(retries = 3): number[] {
  return Array.from({ length: retries }, (_, i) => 1000 * 2 ** i)
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 外部 API のエラー応答から診断用の要約（先頭 160 字）を安全に取り出す（失敗は空文字 = 非ブロッキング）。
 * Google API はエラー詳細を JSON body で返すため、有効化未済（SERVICE_DISABLED）等の一次切り分けに使う
 */
async function safeErrorSnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, ' ').trim()
    return text ? ` ${text.slice(0, 160)}` : ''
  } catch {
    return ''
  }
}

/** 有効チャネルへ順次配信する（1 チャネルの失敗が他チャネルを止めないよう結果は個別処理） */
async function dispatchExternal(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  services: ChatService[],
  title: string,
  body: string,
  link: string,
): Promise<void> {
  const text = externalMessageText(ctx.env, title, body, link)
  const { rows } = await ctx.pool.query<ChatLinkRow>(
    `SELECT ${LINK_COLS} FROM user_chat_links WHERE member_id = $1`, [memberId])
  for (const service of services) {
    const linkRow = rows.find(r => r.service === service)
    // 未連携・要再認証はスキップ（再連携催促は失効検知時に済んでいる = 通知スパム防止）
    if (!linkRow || linkRow.status !== 'connected') continue
    await deliverViaLink(ctx, memberId, linkRow, text)
  }
}

/** 外部チャットへ送る本文（リンクはフロントのハッシュルートを絶対 URL 化して添える） */
function externalMessageText(env: Env, title: string, body: string, link: string): string {
  const frontOrigin = env.corsOrigins[0] ?? ''
  const url = link && frontOrigin ? `\n${frontOrigin}/#${link}` : ''
  return `【${title}】\n${body}${url}`
}

/**
 * 1 リンクへの配信（リトライ + 失効処理込み）。deliverToService（テスト送信）とも共用（原則3）。
 * 戻り値は最終結果（retry を使い切った場合は 'fail'）。
 */
async function deliverViaLink(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<Exclude<DeliveryResult, 'retry'>> {
  const attempt = (): Promise<DeliveryResult> => link.service === 'slack'
    ? sendSlackDm(ctx, link, text, sink)
    : sendGoogleChatDm(ctx, memberId, link, text, sink)
  let result = await attempt()
  for (const delay of backoffDelays()) {
    if (result !== 'retry') break
    await wait(delay)
    result = await attempt()
  }
  const final: Exclude<DeliveryResult, 'retry'> = result === 'retry' ? 'fail' : result
  // 再試行上限で fail に確定した場合も診断詳細を残す（レビュー R1。即時 fail は各送信関数が記録済み）
  if (result === 'retry' && sink && !sink.detail) sink.detail = '再試行上限に到達（持続的な 5xx / 429 / タイムアウト）'
  if (final === 'auth') await markReauthRequired(ctx, memberId, link.service)
  if (final === 'fail') console.warn(`notify: external delivery failed: ${link.service} member=${memberId}`)
  return final
}

/**
 * テスト送信等の単発配信（POST /v1/notification-channels/:service/test が利用）。
 * not_connected = 行なし・要再認証（送信は行わない）。
 */
export async function deliverToService(
  pool: pg.Pool,
  env: Env,
  memberId: string,
  service: ChatService,
  text: string,
  sink?: FailureDetailSink,
): Promise<'ok' | 'auth' | 'fail' | 'not_connected'> {
  const { rows } = await pool.query<ChatLinkRow>(
    `SELECT ${LINK_COLS} FROM user_chat_links WHERE member_id = $1 AND service = $2`, [memberId, service])
  const link = rows[0]
  if (!link || link.status !== 'connected') return 'not_connected'
  return deliverViaLink({ pool, env }, memberId, link, text, sink)
}

/**
 * トークン失効の記録 + 再連携催促（アプリ内通知のみ = 外部配信しないので再帰しない）。
 * status='connected' の行だけ更新する WHERE ガードにより、連続失敗しても催促は初回の 1 回だけ（冪等）。
 */
async function markReauthRequired(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  service: ChatService,
): Promise<void> {
  try {
    const { rowCount } = await ctx.pool.query(
      `UPDATE user_chat_links SET status = 'reauth_required', updated_at = now()
       WHERE member_id = $1 AND service = $2 AND status = 'connected'`, [memberId, service])
    if ((rowCount ?? 0) > 0) {
      await notifyInternal(ctx.pool, memberId, 'system', '再連携のお願い',
        `${CHANNEL_META[service].label} の連携が無効になりました。プロフィール・個人設定から再連携してください`,
        '/profile', false)
    }
  } catch (e) {
    console.warn('notify: mark reauth failed (non-blocking):', (e as Error).message)
  }
}

// ---------- Slack（user token 方式: chat.postMessage で本人宛 DM） ----------

/** Slack Web API の失効系エラーコード（→ reauth_required） */
const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed', 'missing_scope', 'no_permission',
])

async function sendSlackDm(
  ctx: { pool: pg.Pool; env: Env },
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<DeliveryResult> {
  const token = decryptSecret(link.accessTokenEnc, ctx.env.tokenEncryptionKey)
  if (!token) return 'auth' // 鍵ローテーション等で復号不可 = 再連携で回復（crypto.ts の設計と同じ）
  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      // channel にユーザー id を渡すと本人との DM へ投稿される（user token = 自分宛の通知 DM）
      body: JSON.stringify({ channel: link.externalUserId, text }),
    })
    if (res.status === 429 || res.status >= 500) return 'retry'
    if (res.status === 401) return 'auth'
    const body = await res.json() as { ok?: boolean; error?: string }
    if (body.ok) return 'ok'
    if (body.error && SLACK_AUTH_ERRORS.has(body.error)) return 'auth'
    if (body.error === 'ratelimited') return 'retry'
    console.warn('slack chat.postMessage failed:', body.error)
    if (sink) sink.detail = `chat.postMessage: ${body.error ?? '不明なエラー'}`
    return 'fail'
  } catch {
    return 'retry' // タイムアウト・接続断は一時障害として再試行
  }
}

// ---------- Google Chat（spaces.findDirectMessage → messages.create で本人宛 DM） ----------

/** 有効なアクセストークン（期限切れは refresh_token で更新 = calendar.ts accessTokenFor と同型） */
async function googleChatAccessToken(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
): Promise<string | null> {
  const notExpired = !link.expiresAt || new Date(link.expiresAt).getTime() > Date.now() + 60_000
  if (notExpired) {
    return decryptSecret(link.accessTokenEnc, ctx.env.tokenEncryptionKey)
  }
  const refreshToken = link.refreshTokenEnc
    ? decryptSecret(link.refreshTokenEnc, ctx.env.tokenEncryptionKey)
    : null
  if (!refreshToken) return null
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        client_id: ctx.env.googleOauthClientId,
        client_secret: ctx.env.googleOauthClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) return null
    const body = await res.json() as { access_token: string; expires_in: number }
    const accessTokenEnc = encryptSecret(body.access_token, ctx.env.tokenEncryptionKey)
    const expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString()
    await ctx.pool.query(
      `UPDATE user_chat_links SET access_token_enc = $2, expires_at = $3, updated_at = now()
       WHERE member_id = $1 AND service = 'google_chat'`,
      [memberId, accessTokenEnc, expiresAt])
    // リトライ時に再 refresh しないよう、手元の行にも反映しておく
    link.accessTokenEnc = accessTokenEnc
    link.expiresAt = expiresAt
    return body.access_token
  } catch {
    return null
  }
}

async function sendGoogleChatDm(
  ctx: { pool: pg.Pool; env: Env },
  memberId: string,
  link: ChatLinkRow,
  text: string,
  sink?: FailureDetailSink,
): Promise<DeliveryResult> {
  const token = await googleChatAccessToken(ctx, memberId, link)
  if (!token) return 'auth' // 更新不能（refresh 失効・復号不可）= 再連携で回復
  try {
    // ① 本人との DM スペースを解決（external_user_id = id_token の sub）
    const findRes = await fetch(
      `${GOOGLE_CHAT_BASE}/spaces:findDirectMessage?name=${encodeURIComponent(`users/${link.externalUserId}`)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) })
    if (findRes.status === 429 || findRes.status >= 500) return 'retry'
    if (findRes.status === 401) return 'auth'
    let space: string | undefined
    if (findRes.ok) {
      space = ((await findRes.json()) as { name?: string }).name
    } else if (findRes.status === 404) {
      // DM スペース未作成（本人が Google Chat で自分宛 DM を一度も開いていない）= spaces.setup で作成を試みる
      // （レビュー R1: 見つからない → 全通知が黙って失われる、への対処。setup も失敗したら fail = 非ブロッキング）
      const setupRes = await fetch(`${GOOGLE_CHAT_BASE}/spaces:setup`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        body: JSON.stringify({
          space: { spaceType: 'DIRECT_MESSAGE', singleUserBotDm: false },
          memberships: [{ member: { name: `users/${link.externalUserId}`, type: 'HUMAN' } }],
        }),
      })
      if (setupRes.status === 429 || setupRes.status >= 500) return 'retry'
      if (setupRes.status === 401) return 'auth'
      if (setupRes.ok) space = ((await setupRes.json()) as { name?: string }).name
      else {
        console.warn('google chat spaces.setup failed:', setupRes.status)
        if (sink) sink.detail = `spaces.setup: HTTP ${setupRes.status}${await safeErrorSnippet(setupRes)}`
      }
    } else {
      console.warn('google chat findDirectMessage failed:', findRes.status)
      if (sink) sink.detail = `spaces.findDirectMessage: HTTP ${findRes.status}${await safeErrorSnippet(findRes)}`
      return 'fail' // 403 等は設定不備の可能性（API 未有効化）= 失効扱いにしない
    }
    if (!space) return 'fail'
    // ② メッセージ作成
    const res = await fetch(`${GOOGLE_CHAT_BASE}/${space}/messages`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      body: JSON.stringify({ text }),
    })
    if (res.status === 429 || res.status >= 500) return 'retry'
    if (res.status === 401) return 'auth'
    if (!res.ok) {
      console.warn('google chat messages.create failed:', res.status)
      if (sink) sink.detail = `messages.create: HTTP ${res.status}${await safeErrorSnippet(res)}`
      return 'fail'
    }
    return 'ok'
  } catch {
    return 'retry' // タイムアウト・接続断は一時障害として再試行
  }
}
