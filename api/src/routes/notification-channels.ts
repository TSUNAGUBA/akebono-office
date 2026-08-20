/**
 * 個人別マルチチャネル通知連携 API（Slack / Google Chat。改修依頼 2026-08-20）。mockup useNotificationChannels の API 版。
 *
 * - OAuth 2.0 認可コードフロー（サーバーサイド）でユーザーごとに外部チャットを連携する。
 *   トークンは AES-256-GCM で暗号化保管しクライアントへ出さない（C3 相当。calendar.ts と同型 = 原則3）。
 * - Slack は **user token 方式**（authorize URL の `user_scope=chat:write`）を採用する。
 *   bot token（scope=chat:write）は Bot をワークスペースへ常駐させ conversations.open が必要になるが、
 *   user token は本人の権限で自分宛 DM（chat.postMessage channel=自分の user id）へ直接投稿でき、
 *   「本人にしか届かない個人通知」という要件に最小権限で一致するため（設計判断）。
 *   Slack のユーザートークンは既定で無期限（refresh なし・expires_at NULL）。
 * - Google Chat は既存の Google OAuth クライアント（GOOGLE_OAUTH_CLIENT_ID/SECRET）を再利用し、
 *   scope = openid email + chat.spaces.readonly（DM スペース解決）+ chat.messages.create（送信）。
 *   コールバックで id_token の email と members.email を突合する（他人アカウントの誤リンク防止 =
 *   calendar.ts のアカウントリンク CSRF 対策と同型）。Slack は email 突合に users:read.email 等の
 *   追加スコープが必要なため行わず、一回性 state ノンス（本人セッションで発行・10 分 TTL）で担保する。
 *   誤リンク時も DM はトークン所有者本人の Slack にしか届かない（宛先 = authed_user.id）ため、
 *   第三者への情報流出経路にはならない（設計判断として注記）。
 * - 通知マトリクスは user_preferences キー 'notificationChannels'（0039 基盤）へ保存（新テーブル不要）。
 * - 連携解除は行の物理削除（取消フロー = 原則9.5。再連携でいつでも復元できるため論理削除にしない）。
 * - 配信エンジン（lib/notify.ts）の外部配信は本ルートのマウント時に configureExternalDispatch で有効化。
 *
 * app.ts へのマウント（本ユニットでは行わない。コールバックは認証ヘッダなしのブラウザリダイレクトで
 * 届くため authMiddleware より**前**に登録する = calendar と同じ流儀）:
 *   app.get('/v1/notification-channels/:service/oauth/callback', notificationChannelOauthCallbackRoutes(pool, env))
 *   …（app.use('/v1/*', authMiddleware) の後）…
 *   app.route('/v1/notification-channels', notificationChannelsRoutes(pool, env))
 *
 * エラー: AKO-NCH-001 連携未設定 / 002 不正なサービス指定 / 003 未連携 /
 *         004 テスト送信失敗 / 005 マトリクス不正
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import {
  CHANNEL_META, CHAT_SERVICES, type ChatLinkStatus, type ChatService,
  NOTIFICATION_CHANNELS_PREF_KEY, parseNotificationMatrix, serializeNotificationMatrix,
} from '../../../shared/domain/notification-channels'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { err } from '../lib/errors'
import { configureExternalDispatch, deliverToService } from '../lib/notify'
import { emailFromIdToken } from './calendar'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Google Chat の DM 送信に必要な最小スコープ（+ email 突合用の openid email） */
const GOOGLE_CHAT_SCOPES = 'openid email https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages.create'
const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize'
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access'
/** user token 方式（本人の権限で自分宛 DM へ投稿）。docblock の設計判断を参照 */
const SLACK_USER_SCOPE = 'chat:write'

/** :service パラメータの検証（allowlist 外は 400） */
function serviceOf(v: string): ChatService {
  if (v === 'slack' || v === 'google_chat') return v
  throw err('AKO-NCH-002', '連携先サービスの指定が不正です（slack / google_chat）', 400)
}

/** サービスごとの連携可否（OAuth クライアント + 暗号化鍵が投入済みか） */
function serviceEnabled(env: Env, service: ChatService): boolean {
  if (!env.tokenEncryptionKey) return false
  return service === 'slack'
    ? Boolean(env.slackClientId && env.slackClientSecret)
    : Boolean(env.googleOauthClientId && env.googleOauthClientSecret)
}

function requireEnabled(env: Env, service: ChatService): void {
  if (!serviceEnabled(env, service)) {
    throw err('AKO-NCH-001',
      `${CHANNEL_META[service].label} 連携が未設定です（管理者が OAuth クライアントを設定すると利用できます）`, 400)
  }
}

/** リクエスト URL からコールバック URI を組み立てる（Cloud Run / ローカル両対応 = calendar と同型） */
function redirectUri(c: Context, service: ChatService): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${url.host}/v1/notification-channels/${service}/oauth/callback`
}

/** state ノンスの発行（一回性 + 10 分 TTL。アカウントリンク CSRF 対策 = calendar issueState と同型） */
async function issueState(pool: pg.Pool, memberId: string, service: ChatService): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await pool.query(`DELETE FROM chat_oauth_states WHERE created_at < now() - interval '10 minutes'`)
  await pool.query(
    `INSERT INTO chat_oauth_states (state, member_id, service) VALUES ($1, $2, $3)`,
    [nonce, memberId, service])
  return nonce
}

/** state の消費（一回限り・10 分以内・サービス一致のみ有効。無効は null） */
async function consumeState(pool: pg.Pool, state: string, service: ChatService): Promise<string | null> {
  if (!state || state.length > 128) return null
  const { rows } = await pool.query<{ memberId: string }>(
    `DELETE FROM chat_oauth_states
     WHERE state = $1 AND service = $2 AND created_at >= now() - interval '10 minutes'
     RETURNING member_id AS "memberId"`, [state, service])
  return rows[0]?.memberId ?? null
}

/** id_token（Google 発行）の sub クレーム = Google ユーザー id（DM スペース解決に使用） */
function subFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1] ?? ''
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }
    return claims.sub ?? null
  } catch {
    return null
  }
}

/** 連携行の upsert（再連携 = 上書き + status を connected へ戻す。冪等 = 原則2） */
async function upsertLink(
  pool: pg.Pool,
  env: Env,
  memberId: string,
  service: ChatService,
  t: { externalUserId: string; displayName: string; accessToken: string; refreshToken: string | null; expiresAt: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO user_chat_links
       (member_id, service, external_user_id, display_name, access_token_enc, refresh_token_enc, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7)
     ON CONFLICT (member_id, service) DO UPDATE SET
       external_user_id = EXCLUDED.external_user_id,
       display_name = EXCLUDED.display_name,
       access_token_enc = EXCLUDED.access_token_enc,
       -- 再連携時に refresh_token が返らないことがある（既存を保持 = calendar と同型）
       refresh_token_enc = CASE WHEN EXCLUDED.refresh_token_enc <> ''
         THEN EXCLUDED.refresh_token_enc ELSE user_chat_links.refresh_token_enc END,
       status = 'connected', expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [memberId, service, t.externalUserId, t.displayName,
      encryptSecret(t.accessToken, env.tokenEncryptionKey),
      t.refreshToken ? encryptSecret(t.refreshToken, env.tokenEncryptionKey) : '',
      t.expiresAt])
}

type ExchangeResult = { ok: true; displayName: string } | { ok: false; reason: string }

/** Slack のトークン交換（oauth.v2.access）→ user token を保存。表示名の取得（auth.test）は補助処理 */
async function exchangeSlack(
  c: Context, pool: pg.Pool, env: Env, memberId: string, code: string,
): Promise<ExchangeResult> {
  const res = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      client_id: env.slackClientId ?? '',
      client_secret: env.slackClientSecret ?? '',
      code,
      redirect_uri: redirectUri(c, 'slack'),
    }),
  })
  if (!res.ok) {
    console.warn('slack oauth exchange failed:', res.status)
    return { ok: false, reason: 'token-exchange' }
  }
  const body = await res.json() as {
    ok?: boolean
    error?: string
    authed_user?: { id?: string; access_token?: string }
    team?: { name?: string }
  }
  const userToken = body.authed_user?.access_token
  const externalUserId = body.authed_user?.id
  if (!body.ok || !userToken || !externalUserId) {
    console.warn('slack oauth exchange failed:', body.error)
    return { ok: false, reason: 'token-exchange' }
  }
  // 連携済みアカウント名（ワークスペース / ユーザー名）。取得失敗でも連携は成立させる（原則4）
  let displayName = body.team?.name ?? externalUserId
  try {
    const at = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    const atBody = await at.json() as { ok?: boolean; user?: string; team?: string }
    if (atBody.ok && (atBody.team || atBody.user)) {
      displayName = [atBody.team, atBody.user].filter(Boolean).join(' / ')
    }
  } catch { /* 表示名なしでも連携は成立（非ブロッキング） */ }
  await upsertLink(pool, env, memberId, 'slack',
    { externalUserId, displayName, accessToken: userToken, refreshToken: null, expiresAt: null })
  return { ok: true, displayName }
}

/** Google のトークン交換 → id_token の email を members.email と突合してから保存 */
async function exchangeGoogle(
  c: Context, pool: pg.Pool, env: Env, memberId: string, code: string,
): Promise<ExchangeResult> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      client_id: env.googleOauthClientId,
      client_secret: env.googleOauthClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(c, 'google_chat'),
    }),
  })
  if (!res.ok) {
    console.warn('google chat oauth exchange failed:', res.status, (await res.text()).slice(0, 200))
    return { ok: false, reason: 'token-exchange' }
  }
  const body = await res.json() as {
    access_token: string; refresh_token?: string; expires_in: number; id_token?: string
  }
  // 同意した Google アカウントが本人（members.email）であることを検証（他人アカウントの誤リンク防止）
  const googleEmail = emailFromIdToken(body.id_token)
  const sub = subFromIdToken(body.id_token)
  const { rows: memberRows } = await pool.query<{ email: string }>(
    `SELECT email FROM members WHERE id = $1 AND active = true`, [memberId])
  const memberEmail = memberRows[0]?.email?.toLowerCase() ?? null
  if (!googleEmail || !memberEmail || googleEmail !== memberEmail) {
    console.warn('google chat oauth account mismatch:', memberId)
    return { ok: false, reason: 'account-mismatch' }
  }
  if (!sub) return { ok: false, reason: 'token-exchange' }
  await upsertLink(pool, env, memberId, 'google_chat', {
    externalUserId: sub,
    displayName: googleEmail,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  })
  return { ok: true, displayName: googleEmail }
}

/**
 * OAuth コールバック（認証ヘッダなしのブラウザリダイレクトで届くため authMiddleware より前に登録する）。
 * 本人性は ①一回性・10 分 TTL の state ノンス（DB 消費・サービス一致）②Google は id_token email と
 * members.email の突合、の 2 段で担保する（calendar callback と同じ流儀）。復帰先は /#/profile。
 */
export function notificationChannelOauthCallbackRoutes(pool: pg.Pool, env: Env) {
  configureExternalDispatch(pool, env)
  return async (c: Context) => {
    const frontOrigin = env.corsOrigins[0] ?? ''
    const rawService = c.req.param('service') ?? ''
    const service: ChatService | null = rawService === 'slack' || rawService === 'google_chat' ? rawService : null
    const fail = (reason: string) => c.redirect(
      `${frontOrigin}/#/profile?chat=error&service=${encodeURIComponent(rawService)}&reason=${encodeURIComponent(reason)}`, 302)
    if (!service || !serviceEnabled(env, service)) return fail('not-configured')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    const memberId = await consumeState(pool, state, service)
    // 同意画面でキャンセル = error=access_denied（code なし）。それ以外の error はキャンセル文言にしない
    const oauthError = c.req.query('error')
    if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'oauth-error')
    if (!memberId || !code) return fail('invalid-state')
    try {
      const result = service === 'slack'
        ? await exchangeSlack(c, pool, env, memberId, code)
        : await exchangeGoogle(c, pool, env, memberId, code)
      if (!result.ok) return fail(result.reason)
      await audit(pool, {
        actorId: memberId, action: 'connect', entity: 'user_chat_links', entityId: `${memberId}:${service}`,
        detail: `${CHANNEL_META[service].label} 連携（${result.displayName}）`,
      })
      return c.redirect(`${frontOrigin}/#/profile?chat=connected&service=${service}`, 302)
    } catch (e) {
      console.warn('chat oauth callback failed:', (e as Error).message)
      return fail('exchange-error')
    }
  }
}

export function notificationChannelsRoutes(pool: pg.Pool, env: Env): Hono {
  // 配信エンジン（lib/notify.ts）の外部配信をマウント時に有効化する
  configureExternalDispatch(pool, env)
  const app = new Hono()

  // 自分の連携状態 + 通知マトリクス（トークンは返さない。connected = 行があること・
  // 復号できない行（鍵ローテーション後）は要再認証扱い → 再連携導線へ）
  app.get('/', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{
      service: ChatService; displayName: string; status: ChatLinkStatus
      hasExternalId: boolean; accessTokenEnc: string
    }>(
      `SELECT service, display_name AS "displayName", status,
              external_user_id <> '' AS "hasExternalId", access_token_enc AS "accessTokenEnc"
       FROM user_chat_links WHERE member_id = $1`, [user.id])
    const { rows: prefRows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM user_preferences WHERE member_id = $1 AND key = $2`,
      [user.id, NOTIFICATION_CHANNELS_PREF_KEY])
    const services = Object.fromEntries(CHAT_SERVICES.map((service) => {
      const row = rows.find(r => r.service === service)
      const decryptable = row ? decryptSecret(row.accessTokenEnc, env.tokenEncryptionKey) !== null : false
      return [service, {
        enabled: serviceEnabled(env, service),
        connected: Boolean(row),
        status: row ? (decryptable ? row.status : 'reauth_required' as ChatLinkStatus) : null,
        displayName: row?.displayName ?? '',
        hasExternalId: row?.hasExternalId ?? false,
      }]
    }))
    return c.json({ data: { services, matrix: parseNotificationMatrix(prefRows[0]?.value) } })
  })

  // 通知マトリクスの保存（parse → 最小形へ正規化して user_preferences へ upsert。
  // 0039 の per-user 設定基盤と同一の upsert SQL = 4KB / 100 キー制限も同一（原則3））
  app.put('/matrix', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { matrix?: unknown }
    if (!body.matrix || typeof body.matrix !== 'object' || Array.isArray(body.matrix)) {
      throw err('AKO-NCH-005', '通知マトリクス（matrix）をオブジェクトで指定してください', 400)
    }
    const matrix = serializeNotificationMatrix(parseNotificationMatrix(body.matrix))
    const serialized = JSON.stringify(matrix)
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      throw err('AKO-NCH-005', '設定値が大きすぎます', 400)
    }
    const { rowCount } = await pool.query(
      `INSERT INTO user_preferences (member_id, key, value)
       SELECT $1, $2, $3
       WHERE (SELECT count(*) FROM user_preferences WHERE member_id = $1) < 100
          OR EXISTS (SELECT 1 FROM user_preferences WHERE member_id = $1 AND key = $2)
       ON CONFLICT (member_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [user.id, NOTIFICATION_CHANNELS_PREF_KEY, serialized])
    if (rowCount === 0) throw err('AKO-NCH-005', '設定項目が多すぎます', 400)
    return c.json({ data: { matrix } })
  })

  // 同意画面 URL（フロントはこの URL へフルリダイレクトする）
  app.post('/:service/oauth/url', async (c) => {
    const service = serviceOf(c.req.param('service'))
    requireEnabled(env, service)
    const user = c.get('user')
    const state = await issueState(pool, user.id, service)
    const redirect = redirectUri(c, service)
    const url = service === 'slack'
      ? `${SLACK_AUTH_URL}?${new URLSearchParams({
          client_id: env.slackClientId ?? '',
          user_scope: SLACK_USER_SCOPE,
          redirect_uri: redirect,
          state,
        }).toString()}`
      : `${GOOGLE_AUTH_URL}?${new URLSearchParams({
          client_id: env.googleOauthClientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: GOOGLE_CHAT_SCOPES,
          access_type: 'offline',
          prompt: 'consent',
          state,
        }).toString()}`
    return c.json({ data: { url } })
  })

  // 連携解除（取消フロー = 原則9.5: 行の物理削除。再連携でいつでも復元できる。
  // 外部側の revoke は補助処理・非ブロッキング = 失効済みでも解除は成立）
  app.post('/:service/disconnect', async (c) => {
    const service = serviceOf(c.req.param('service'))
    const user = c.get('user')
    const { rows } = await pool.query<{ accessTokenEnc: string }>(
      `SELECT access_token_enc AS "accessTokenEnc" FROM user_chat_links
       WHERE member_id = $1 AND service = $2`, [user.id, service])
    const token = rows[0] && env.tokenEncryptionKey
      ? decryptSecret(rows[0].accessTokenEnc, env.tokenEncryptionKey)
      : null
    await pool.query(
      `DELETE FROM user_chat_links WHERE member_id = $1 AND service = $2`, [user.id, service])
    if (token) {
      try {
        if (service === 'slack') {
          await fetch('https://slack.com/api/auth.revoke', {
            method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
          })
        } else {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
            method: 'POST', signal: AbortSignal.timeout(5_000),
          })
        }
      } catch { /* 非ブロッキング（外部側で失効済みでも解除は成立） */ }
    }
    await audit(pool, {
      actorId: user.id, action: 'disconnect', entity: 'user_chat_links', entityId: `${user.id}:${service}`,
      detail: `${CHANNEL_META[service].label} 連携を解除`,
    })
    return c.json({ data: { ok: true } })
  })

  // テスト送信（自分宛に実送信。連携カードの「テスト送信」= 主要操作のフィードバック）
  app.post('/:service/test', async (c) => {
    const service = serviceOf(c.req.param('service'))
    const user = c.get('user')
    const label = CHANNEL_META[service].label
    const result = await deliverToService(pool, env, user.id, service,
      `【テスト送信】AKEBONO Office の通知連携テストです（${user.name}）。この通知が届いていれば設定は完了です。`)
    if (result === 'not_connected') {
      throw err('AKO-NCH-003', `${label} が未連携です。連携してからテスト送信してください`, 400)
    }
    if (result === 'auth') {
      throw err('AKO-NCH-004', `${label} の認証が無効になっています。再連携してからお試しください`, 502)
    }
    if (result === 'fail') {
      throw err('AKO-NCH-004', service === 'google_chat'
        ? `${label} へのテスト送信に失敗しました。Google Chat API の有効化と、Chat で自分宛の DM が利用できるかを確認のうえ再試行してください`
        : `${label} へのテスト送信に失敗しました。時間をおいて再試行してください`, 502)
    }
    return c.json({ data: { ok: true } })
  })

  return app
}
