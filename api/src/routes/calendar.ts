/**
 * Google カレンダー連携 API（F-06-8）。mockup useCalendar の API 版。
 * - OAuth 2.0 認可コードフロー（サーバーサイド）。トークンは AES-256-GCM で暗号化保管し
 *   クライアントへ出さない（C3 相当）。喪失時は再連携で再取得できる（設計判断）
 * - source='google' の予定は Google が SoT（同期で対象日の google 発のみ置換 upsert。app 発に触れない）
 * - source='app' の予定は本アプリが SoT。Google への反映・削除は補助処理（失敗しても主フローは成立 = 原則4）
 * - GOOGLE_OAUTH_CLIENT_ID / SECRET / TOKEN_ENCRYPTION_KEY 未設定 = 連携無効（AKO-CAL-007）
 * エラー: AKO-CAL-001 同期失敗 / 002 タスク名 / 003 時刻 / 004 app 以外の反映 /
 *         006 google 由来の削除不可 / 007 未連携（005 は欠番 = 反映済み再実行は no-op + warning）
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import type { CalendarEvent } from '../../../shared/domain/types'

/** DB 行（共有型 + Google イベント id。フロントへは共有型のフィールドのみ意味を持つ） */
type CalendarEventRow = CalendarEvent & { googleEventId: string | null }
import type { Env } from '../env'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { ApiError, err } from '../lib/errors'
import { newId } from '../lib/ids'

const EVENT_COLS = `id, member_id AS "memberId", date::text AS date, from_time AS "from", to_time AS "to",
  title, source, synced_to_google AS "syncedToGoogle", project_id AS "projectId",
  google_event_id AS "googleEventId"`

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events'

function calendarEnabled(env: Env): boolean {
  return Boolean(env.googleOauthClientId && env.googleOauthClientSecret && env.tokenEncryptionKey)
}

/** HH:MM（値域含む検証。24:30 等を弾く） */
function isHhmm(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

function requireEnabled(env: Env): void {
  if (!calendarEnabled(env)) {
    throw err('AKO-CAL-007', 'カレンダー連携が未設定です（GOOGLE_OAUTH_* を設定してください）', 409)
  }
}

/**
 * state ノンスの発行（DB 保存 = 一回性 + 有効期限。レビュー指摘: アカウントリンク CSRF 対策）。
 * さらにコールバックで Google アカウントの email と members.email を突合し、
 * 「他人に踏ませた同意 URL で被害者のトークンが攻撃者の口座へ入る」経路を遮断する
 */
async function issueState(pool: pg.Pool, memberId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await pool.query(`DELETE FROM calendar_oauth_states WHERE created_at < now() - interval '10 minutes'`)
  await pool.query(`INSERT INTO calendar_oauth_states (nonce, member_id) VALUES ($1, $2)`, [nonce, memberId])
  return nonce
}

/** state の消費（一回限り・10 分以内のみ有効。無効は null） */
async function consumeState(pool: pg.Pool, state: string): Promise<string | null> {
  if (!state || state.length > 128) return null
  const { rows } = await pool.query<{ memberId: string }>(
    `DELETE FROM calendar_oauth_states
     WHERE nonce = $1 AND created_at >= now() - interval '10 minutes'
     RETURNING member_id AS "memberId"`, [state])
  return rows[0]?.memberId ?? null
}

/** id_token（Google 発行・TLS 経由で直接受領）から email クレームを取り出す */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1] ?? ''
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string }
    return claims.email?.toLowerCase() ?? null
  } catch {
    return null
  }
}

/** リクエスト URL からコールバック URI を組み立てる（Cloud Run / ローカルの両対応） */
function redirectUri(c: Context): string {
  const url = new URL(c.req.url)
  // Cloud Run は TLS 終端後に http で届くため x-forwarded-proto を優先する
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${url.host}/v1/calendar/oauth/callback`
}

interface TokenRow {
  accessTokenEnc: string
  refreshTokenEnc: string | null
  expiresAt: string | null
}

/** 有効なアクセストークンを返す（期限切れは refresh。取得不可 = null → AKO-CAL-007） */
async function accessTokenFor(pool: pg.Pool, env: Env, memberId: string): Promise<string | null> {
  const { rows } = await pool.query<TokenRow>(
    `SELECT access_token_enc AS "accessTokenEnc", refresh_token_enc AS "refreshTokenEnc",
            expires_at AS "expiresAt"
     FROM calendar_tokens WHERE member_id = $1`, [memberId])
  const row = rows[0]
  if (!row) return null
  const notExpired = !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now() + 60_000
  if (notExpired) {
    return decryptSecret(row.accessTokenEnc, env.tokenEncryptionKey)
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
      `UPDATE calendar_tokens SET access_token_enc = $2, expires_at = $3, updated_at = now() WHERE member_id = $1`,
      [memberId, encryptSecret(body.access_token, env.tokenEncryptionKey),
        new Date(Date.now() + body.expires_in * 1000).toISOString()])
    return body.access_token
  } catch {
    return null
  }
}

/** Google の dateTime（RFC3339）→ JST の HH:MM（実行環境 TZ 非依存） */
function jstHhmm(dateTime: string): string {
  return new Date(new Date(dateTime).getTime() + 9 * 3600_000).toISOString().slice(11, 16)
}

/**
 * OAuth コールバック（認証ヘッダなしのブラウザリダイレクトで届くため、/v1/* の認証より前に登録する。
 * 本人性は ①一回性・10 分 TTL の state ノンス（DB 消費）②Google アカウント email と members.email の
 * 突合の 2 段で担保する（レビュー指摘: アカウントリンク CSRF 対策）
 */
export function calendarOauthCallback(pool: pg.Pool, env: Env) {
  return async (c: Context) => {
    const frontOrigin = env.corsOrigins[0] ?? ''
    const fail = (reason: string) =>
      c.redirect(`${frontOrigin}/#/ai-assistant?calendar=error&reason=${encodeURIComponent(reason)}`, 302)
    if (!calendarEnabled(env)) return fail('not-configured')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    const memberId = await consumeState(pool, state)
    // 同意画面でキャンセルした場合は error=access_denied で戻る（code なし）。
    // それ以外の error（server_error・admin_policy_enforced 等）はキャンセル文言にしない
    const oauthError = c.req.query('error')
    if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'oauth-error')
    if (!memberId || !code) return fail('invalid-state')
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
        console.warn('calendar oauth exchange failed:', res.status, (await res.text()).slice(0, 200))
        return fail('token-exchange')
      }
      const body = await res.json() as {
        access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string
      }
      // 同意した Google アカウントが本人（members.email）であることを検証（他人アカウントの誤リンク防止）
      const googleEmail = emailFromIdToken(body.id_token)
      const { rows: memberRows } = await pool.query<{ email: string }>(
        `SELECT email FROM members WHERE id = $1 AND active = true`, [memberId])
      const memberEmail = memberRows[0]?.email?.toLowerCase() ?? null
      if (!googleEmail || !memberEmail || googleEmail !== memberEmail) {
        console.warn('calendar oauth account mismatch:', memberId)
        return fail('account-mismatch')
      }
      // 再連携時に refresh_token が返らないことがある（既存を保持する）
      await pool.query(
        `INSERT INTO calendar_tokens (member_id, access_token_enc, refresh_token_enc, expires_at, scope)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, calendar_tokens.refresh_token_enc),
           expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope, updated_at = now()`,
        [memberId, encryptSecret(body.access_token, env.tokenEncryptionKey),
          body.refresh_token ? encryptSecret(body.refresh_token, env.tokenEncryptionKey) : null,
          new Date(Date.now() + body.expires_in * 1000).toISOString(), body.scope ?? ''])
      return c.redirect(`${frontOrigin}/#/ai-assistant?calendar=connected`, 302)
    } catch (e) {
      console.warn('calendar oauth callback failed:', (e as Error).message)
      return fail('exchange-error')
    }
  }
}

export function calendarRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 連携状態（設定未投入なら enabled=false でフロントは連携 UI を隠す。
  // connected は「トークン行があり復号できる」こと = 鍵ローテーション後は false → 再連携導線へ）
  app.get('/status', async (c) => {
    const user = c.get('user')
    if (!calendarEnabled(env)) return c.json({ data: { enabled: false, connected: false } })
    const { rows } = await pool.query<{ accessTokenEnc: string }>(
      `SELECT access_token_enc AS "accessTokenEnc" FROM calendar_tokens WHERE member_id = $1`, [user.id])
    const connected = rows[0] ? decryptSecret(rows[0].accessTokenEnc, env.tokenEncryptionKey) !== null : false
    return c.json({ data: { enabled: true, connected } })
  })

  // 同意画面 URL（フロントはこの URL へフルリダイレクトする）
  app.get('/oauth/url', async (c) => {
    requireEnabled(env)
    const user = c.get('user')
    const params = new URLSearchParams({
      client_id: env.googleOauthClientId,
      redirect_uri: redirectUri(c),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state: await issueState(pool, user.id),
    })
    return c.json({ data: { url: `${GOOGLE_AUTH_URL}?${params.toString()}` } })
  })

  // 連携解除（revoke は補助処理・トークンは物理削除。同期済みキャッシュは保持 = mockup と同一）
  app.post('/disconnect', async (c) => {
    const user = c.get('user')
    const token = calendarEnabled(env) ? await accessTokenFor(pool, env, user.id) : null
    await pool.query(`DELETE FROM calendar_tokens WHERE member_id = $1`, [user.id])
    if (token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: 'POST', signal: AbortSignal.timeout(5_000),
        })
      } catch { /* 非ブロッキング（Google 側で失効済みでも解除は成立） */ }
    }
    return c.json({ data: { ok: true } })
  })

  // 予定の参照（本人・日付指定）
  app.get('/events', async (c) => {
    const user = c.get('user')
    const date = c.req.query('date') ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('AKO-GEN-001', 'date を指定してください', 400)
    const { rows } = await pool.query(
      `SELECT ${EVENT_COLS} FROM calendar_events
       WHERE member_id = $1 AND date = $2::date ORDER BY from_time LIMIT 200`,
      [user.id, date])
    return c.json({ data: rows })
  })

  // Google からの同期（対象日の google 発のみ置換 upsert。app 発は不変 = SoT 分離）
  app.post('/sync', async (c) => {
    requireEnabled(env)
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { date?: string }
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null
    if (!date) throw err('AKO-GEN-001', 'date を指定してください', 400)
    const token = await accessTokenFor(pool, env, user.id)
    if (!token) {
      throw err('AKO-CAL-007', 'Google カレンダーが未連携です。連携してから同期してください', 409)
    }
    let items: { id: string; summary?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }[]
    let truncated = false
    try {
      const q = new URLSearchParams({
        timeMin: `${date}T00:00:00+09:00`,
        timeMax: `${date}T23:59:59+09:00`,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      })
      const res = await fetch(`${GOOGLE_EVENTS_URL}?${q.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn('calendar sync failed:', res.status, (await res.text()).slice(0, 300))
        // 403 は一過性ではなく設定不備（GCP プロジェクトで Calendar API 未有効化 or スコープ不足）
        if (res.status === 403) {
          throw err('AKO-CAL-001',
            'Google Calendar API が利用できません。管理者は GCP プロジェクトで Google Calendar API を有効化してください', 502)
        }
        throw new Error(`google events ${res.status}`)
      }
      const data = await res.json() as { items?: typeof items; nextPageToken?: string }
      items = data.items ?? []
      // 打ち切り（次ページあり）の場合、見えていない予定を誤削除しないよう削除フェーズを抑止する
      if (data.nextPageToken) {
        console.warn('calendar sync truncated (>250 events/day): skip delete phase')
        truncated = true
      }
    } catch (e) {
      if (e instanceof ApiError) throw e
      console.warn('calendar sync failed:', (e as Error).message)
      throw err('AKO-CAL-001', 'カレンダー同期に失敗しました。時間をおいて再試行してください', 502)
    }
    // 終日予定（dateTime なし）は工数材料にならないため対象外
    const timed = items.filter(i => i.start?.dateTime && i.end?.dateTime)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const keepIds = timed.map(i => i.id)
      if (!truncated) {
        await client.query(
          `DELETE FROM calendar_events
           WHERE member_id = $1 AND date = $2::date AND source = 'google'
             AND NOT (google_event_id = ANY($3::text[]))`,
          [user.id, date, keepIds])
      }
      for (const i of timed) {
        await client.query(
          `INSERT INTO calendar_events
             (id, member_id, date, from_time, to_time, title, source, google_event_id, synced_to_google)
           VALUES ($1, $2, $3, $4, $5, $6, 'google', $7, true)
           ON CONFLICT (member_id, google_event_id) WHERE google_event_id IS NOT NULL
           DO UPDATE SET date = EXCLUDED.date, from_time = EXCLUDED.from_time,
             to_time = EXCLUDED.to_time, title = EXCLUDED.title, updated_at = now()
           WHERE calendar_events.source = 'google'`,
          [newId('cal'), user.id, date, jstHhmm(i.start!.dateTime!), jstHhmm(i.end!.dateTime!),
            i.summary ?? '（無題の予定）', i.id])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return c.json({ data: { synced: timed.length } })
  })

  // タスク（アプリ発予定）の追加。pushToGoogle は補助処理（未連携・失敗でも作成は成立 + warning）
  app.post('/events', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const title = String(body.title ?? '').trim()
    if (!title) throw err('AKO-CAL-002', 'タスク名を入力してください', 400)
    const date = String(body.date ?? '')
    const from = String(body.from ?? '')
    const to = String(body.to ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isHhmm(from) || !isHhmm(to) || from >= to) {
      throw err('AKO-CAL-003', '開始・終了時刻を正しく入力してください', 400)
    }
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null
    const wantPush = body.pushToGoogle === true

    // SoT（本アプリの DB）へ先に書き、Google 反映は後段の補助処理（原則6。
    // 逆順だと DB 失敗時に Google へ孤児イベントが残り、次回同期で削除不能な予定として再取込される）
    const id = newId('cal')
    await pool.query(
      `INSERT INTO calendar_events
         (id, member_id, date, from_time, to_time, title, source, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'app', $7)`,
      [id, user.id, date, from, to, title, projectId])

    let warning: string | undefined
    if (wantPush) {
      const token = calendarEnabled(env) ? await accessTokenFor(pool, env, user.id) : null
      if (!token) {
        warning = 'Google カレンダーが未連携のため、タスクはアプリ内のみに登録しました'
      } else {
        const googleEventId = await insertGoogleEvent(token, { date, from, to, title })
        if (googleEventId) {
          await pool.query(
            `UPDATE calendar_events SET google_event_id = $2, synced_to_google = true, updated_at = now() WHERE id = $1`,
            [id, googleEventId])
        } else {
          warning = 'Google への反映に失敗したため、タスクはアプリ内のみに登録しました'
        }
      }
    }
    return c.json({ data: { id, warning } }, 201)
  })

  // アプリ発予定を後から Google へ反映（反映済みは no-op + warning = 冪等。
  // FOR UPDATE クレームで並行 push による Google 二重作成を防ぐ）
  app.post('/events/:id/push', async (c) => {
    requireEnabled(env)
    const user = c.get('user')
    const eventId = c.req.param('id')
    const token = await accessTokenFor(pool, env, user.id)
    if (!token) {
      throw err('AKO-CAL-007', 'Google カレンダーが未連携です。連携してから反映してください', 409)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<CalendarEventRow>(
        `SELECT ${EVENT_COLS} FROM calendar_events WHERE id = $1 AND member_id = $2 FOR UPDATE`,
        [eventId, user.id])
      const ev = rows[0]
      if (!ev || ev.source !== 'app') {
        throw err('AKO-CAL-004', 'アプリで登録したタスクのみ Google へ反映できます', 400)
      }
      if (ev.syncedToGoogle) {
        await client.query('COMMIT')
        return c.json({ data: { id: eventId, warning: 'すでに Google へ反映済みです（変更はありません）' } })
      }
      const googleEventId = await insertGoogleEvent(token, ev)
      if (!googleEventId) throw err('AKO-CAL-001', 'Google への反映に失敗しました。時間をおいて再試行してください', 502)
      await client.query(
        `UPDATE calendar_events SET google_event_id = $2, synced_to_google = true, updated_at = now() WHERE id = $1`,
        [eventId, googleEventId])
      await client.query('COMMIT')
      return c.json({ data: { id: eventId } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })

  // アプリ発予定の削除（google 発は Google が SoT のため削除不可。Google 側の削除は補助処理）
  app.post('/events/:id/remove', async (c) => {
    const user = c.get('user')
    const eventId = c.req.param('id')
    const { rows } = await pool.query<CalendarEventRow>(
      `SELECT ${EVENT_COLS} FROM calendar_events WHERE id = $1 AND member_id = $2`, [eventId, user.id])
    const ev = rows[0]
    if (!ev || ev.source !== 'app') {
      throw err('AKO-CAL-006', 'Google 由来の予定は本アプリから削除できません（Google 側で変更→同期）', 400)
    }
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [eventId])
    if (ev.syncedToGoogle && ev.googleEventId && calendarEnabled(env)) {
      const token = await accessTokenFor(pool, env, user.id)
      if (token) {
        try {
          await fetch(`${GOOGLE_EVENTS_URL}/${encodeURIComponent(ev.googleEventId)}`, {
            method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
          })
        } catch { /* 非ブロッキング（Google 側に残っても次回同期対象外 = app 発） */ }
      }
    }
    return c.json({ data: { id: eventId } })
  })

  return app
}

/** Google へ予定を作成し、イベント id を返す（失敗は null = 呼び出し側が warning 化） */
async function insertGoogleEvent(
  token: string,
  ev: { date: string; from: string; to: string; title: string },
): Promise<string | null> {
  try {
    const res = await fetch(GOOGLE_EVENTS_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        summary: ev.title,
        start: { dateTime: `${ev.date}T${ev.from}:00+09:00` },
        end: { dateTime: `${ev.date}T${ev.to}:00+09:00` },
      }),
    })
    if (!res.ok) {
      console.warn('google event insert failed:', res.status)
      return null
    }
    const body = await res.json() as { id?: string }
    return body.id ?? null
  } catch (e) {
    console.warn('google event insert failed:', (e as Error).message)
    return null
  }
}
