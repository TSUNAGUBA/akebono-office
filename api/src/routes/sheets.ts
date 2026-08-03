/**
 * Google スプレッドシート取込の連携 API（データ取込・連携 F-32 の取込元方式 sheets_pull。オペレーター指示 2026-08-03）。
 * カレンダー（calendar.ts）/ GA（media.ts）と同型の OAuth 2.0 認可コードフロー。トークンは AES-256-GCM 暗号化保管。
 * - 接続はテナント（全社）単位の**単一接続**（sheets_tokens id='default'）。取込は管理者運用のため per-user ではない。
 * - スコープ: spreadsheets.readonly（値の読取）+ drive.readonly（ブック一覧）。Google クライアントは共用。
 * - 未設定（GOOGLE_OAUTH_* / TOKEN_ENCRYPTION_KEY 空）は enabled=false でフロントが連携 UI を隠す。
 * エラー: AKO-SHEETS-001 未連携 / AKO-SHEETS-002 API 失敗 / AKO-SHEETS-003 対象未指定。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type pg from 'pg'
import { a1ColToIndex } from '../../../shared/domain/import-parse'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { err } from '../lib/errors'
import { emailFromIdToken, googleOauthEnabled } from './calendar'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
// カレンダー/GA とは別の同意・別トークン系。読取のみ（spreadsheets.readonly + ブック一覧 drive.readonly）
const SCOPES = 'openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly'
/** シート取得の上限行数（メモリ暴走防止）。実取込の受理上限は別途 MAX_IMPORT_ROWS(=5000) で、
 *  これを超える行数は取込実行時に AKO-IMP-006 で弾かれる（本値はフェッチ段の安全弁） */
const MAX_SHEET_ROWS = 50_000

function requireEnabled(env: Env): void {
  if (!googleOauthEnabled(env)) {
    throw err('AKO-SHEETS-001', 'Google スプレッドシート連携が未設定です（GOOGLE_OAUTH_* を設定してください）', 409)
  }
}

function redirectUri(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${url.host}/v1/akebono/sheets/oauth/callback`
}

// ---------- OAuth state（一回性 + 10 分 TTL。calendar と同型） ----------

async function issueState(pool: pg.Pool, memberId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url')
  await pool.query(`DELETE FROM sheets_oauth_states WHERE created_at < now() - interval '10 minutes'`)
  await pool.query(`INSERT INTO sheets_oauth_states (nonce, member_id) VALUES ($1, $2)`, [nonce, memberId])
  return nonce
}

async function consumeState(pool: pg.Pool, state: string): Promise<string | null> {
  if (!state || state.length > 128) return null
  const { rows } = await pool.query<{ memberId: string }>(
    `DELETE FROM sheets_oauth_states
     WHERE nonce = $1 AND created_at >= now() - interval '10 minutes'
     RETURNING member_id AS "memberId"`, [state])
  return rows[0]?.memberId ?? null
}

// ---------- トークン（単一接続 id='default'。calendar accessTokenFor と同型） ----------

/** 有効なアクセストークンを返す（期限切れは refresh。取得不可 = null）。akebono-imports の実取込からも使う */
export async function sheetsAccess(pool: pg.Pool, env: Env): Promise<string | null> {
  const { rows } = await pool.query<{ accessTokenEnc: string; refreshTokenEnc: string | null; expiresAt: string | null }>(
    `SELECT access_token_enc AS "accessTokenEnc", refresh_token_enc AS "refreshTokenEnc", expires_at AS "expiresAt"
     FROM sheets_tokens WHERE id = 'default'`)
  const row = rows[0]
  if (!row) return null
  const notExpired = !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now() + 60_000
  if (notExpired) return decryptSecret(row.accessTokenEnc, env.tokenEncryptionKey)
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
      `UPDATE sheets_tokens SET access_token_enc = $1, expires_at = $2, updated_at = now() WHERE id = 'default'`,
      [encryptSecret(body.access_token, env.tokenEncryptionKey), new Date(Date.now() + body.expires_in * 1000).toISOString()])
    return body.access_token
  } catch {
    return null
  }
}

/** 認可トークンで Google API を GET（JSON）。失敗は AKO-SHEETS-002。 */
async function googleGet<T>(url: string, token: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw err('AKO-SHEETS-002', `Google への接続に失敗しました: ${(e as Error).message}`, 502)
  }
  if (!res.ok) {
    throw err('AKO-SHEETS-002', `Google API エラー（HTTP ${res.status}）。連携の再接続や対象の共有設定をご確認ください`, 502)
  }
  return res.json() as Promise<T>
}

/**
 * 取込対象シートの値を読み取り、ヘッダ行（headerRow・1 始まり）以降・開始列（startColumn）以降で切り出す（2 次元配列）。
 * シート全体を取得してからスライスする（末尾列を事前に知る必要がなく確実）。行数は MAX_SHEET_ROWS で打ち切る。
 * akebono-imports の実取込（sheets_pull）から呼ばれる。
 */
export async function fetchSheetRows(
  pool: pg.Pool, env: Env,
  config: { spreadsheetId?: string; sheetName?: string; headerRow?: number; startColumn?: string },
): Promise<string[][]> {
  const token = await sheetsAccess(pool, env)
  if (!token) throw err('AKO-SHEETS-001', 'Google スプレッドシートが未連携です（連携してから実行してください）', 409)
  const spreadsheetId = String(config.spreadsheetId ?? '').trim()
  const sheetName = String(config.sheetName ?? '').trim()
  if (!spreadsheetId || !sheetName) throw err('AKO-SHEETS-003', '対象のスプレッドシート・シートが未設定です', 409)
  const headerRow = Number.isInteger(config.headerRow) && config.headerRow! >= 1 ? config.headerRow! : 1
  const colStart = a1ColToIndex(config.startColumn ?? 'A')
  // range = シート名全体。'A1' 記法のシート名はシングルクォート必須（内部 ' は '' へ）
  const range = `'${sheetName.replace(/'/g, "''")}'`
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
  const body = await googleGet<{ values?: string[][] }>(url, token)
  const values = body.values ?? []
  const sliced = values.slice(headerRow - 1, headerRow - 1 + MAX_SHEET_ROWS)
  return sliced.map(row => row.slice(colStart))
}

// ---------- OAuth コールバック（認証前登録。calendar と同型・単一接続 default） ----------

export function sheetsOauthCallback(pool: pg.Pool, env: Env) {
  return async (c: Context) => {
    const frontOrigin = env.corsOrigins[0] ?? ''
    const fail = (reason: string) =>
      c.redirect(`${frontOrigin}/#/akebono/imports?sheets=error&reason=${encodeURIComponent(reason)}`, 302)
    if (!googleOauthEnabled(env)) return fail('not-configured')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    const memberId = await consumeState(pool, state)
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
        console.warn('sheets oauth exchange failed:', res.status, (await res.text()).slice(0, 200))
        return fail('token-exchange')
      }
      const body = await res.json() as {
        access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string
      }
      // 同意した Google アカウントが接続実行者本人（members.email）であることを検証（誤リンク防止）
      const googleEmail = emailFromIdToken(body.id_token)
      const { rows: memberRows } = await pool.query<{ email: string }>(
        `SELECT email FROM members WHERE id = $1 AND active = true`, [memberId])
      const memberEmail = memberRows[0]?.email?.toLowerCase() ?? null
      if (!googleEmail || !memberEmail || googleEmail !== memberEmail) {
        console.warn('sheets oauth account mismatch:', memberId)
        return fail('account-mismatch')
      }
      // 単一接続（id='default'）。再連携で refresh_token が返らない場合は既存を保持
      await pool.query(
        `INSERT INTO sheets_tokens (id, access_token_enc, refresh_token_enc, expires_at, scope, connected_by)
         VALUES ('default', $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, sheets_tokens.refresh_token_enc),
           expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
           connected_by = EXCLUDED.connected_by, updated_at = now()`,
        [encryptSecret(body.access_token, env.tokenEncryptionKey),
          body.refresh_token ? encryptSecret(body.refresh_token, env.tokenEncryptionKey) : null,
          new Date(Date.now() + body.expires_in * 1000).toISOString(), body.scope ?? '', memberId])
      return c.redirect(`${frontOrigin}/#/akebono/imports?sheets=connected`, 302)
    } catch (e) {
      console.warn('sheets oauth callback failed:', (e as Error).message)
      return fail('exchange-error')
    }
  }
}

export function sheetsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 連携状態（未設定なら enabled=false）。connected = トークン行があり復号できる
  app.get('/sheets/status', async (c) => {
    if (!googleOauthEnabled(env)) return c.json({ data: { enabled: false, connected: false } })
    const { rows } = await pool.query<{ accessTokenEnc: string }>(
      `SELECT access_token_enc AS "accessTokenEnc" FROM sheets_tokens WHERE id = 'default'`)
    const connected = rows[0] ? decryptSecret(rows[0].accessTokenEnc, env.tokenEncryptionKey) !== null : false
    return c.json({ data: { enabled: true, connected } })
  })

  // 同意画面 URL（管理者のみ = 取込設定は管理者運用）
  app.get('/sheets/oauth/url', async (c) => {
    requireEnabled(env)
    const user = requireAdmin(c)
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

  // 連携解除（トークン物理削除 + revoke は非ブロッキング）
  app.post('/sheets/disconnect', async (c) => {
    requireAdmin(c)
    const token = googleOauthEnabled(env) ? await sheetsAccess(pool, env) : null
    await pool.query(`DELETE FROM sheets_tokens WHERE id = 'default'`)
    if (token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: 'POST', signal: AbortSignal.timeout(5_000),
        })
      } catch { /* 非ブロッキング */ }
    }
    return c.json({ data: { ok: true } })
  })

  // 対象スプレッドシートの検索・一覧（Drive files.list。管理者のみ。q = 名前部分一致・任意）
  app.get('/sheets/spreadsheets', async (c) => {
    requireEnabled(env)
    requireAdmin(c)
    const token = await sheetsAccess(pool, env)
    if (!token) throw err('AKO-SHEETS-001', 'Google スプレッドシートが未連携です', 409)
    const q = (c.req.query('q') ?? '').trim().replace(/['\\]/g, ' ')
    const query = [`mimeType='application/vnd.google-apps.spreadsheet'`, 'trashed=false',
      q ? `name contains '${q}'` : ''].filter(Boolean).join(' and ')
    const params = new URLSearchParams({
      q: query, fields: 'files(id,name)', pageSize: '50', orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    })
    const body = await googleGet<{ files?: { id: string; name: string }[] }>(`${DRIVE_FILES_URL}?${params.toString()}`, token)
    return c.json({ data: (body.files ?? []).map(f => ({ id: f.id, name: f.name })) })
  })

  // 選択ブックのシート（タブ）一覧
  app.get('/sheets/spreadsheets/:id/tabs', async (c) => {
    requireEnabled(env)
    requireAdmin(c)
    const token = await sheetsAccess(pool, env)
    if (!token) throw err('AKO-SHEETS-001', 'Google スプレッドシートが未連携です', 409)
    const id = c.req.param('id')
    const body = await googleGet<{ sheets?: { properties?: { title?: string } }[] }>(
      `${SHEETS_BASE}/${encodeURIComponent(id)}?fields=${encodeURIComponent('sheets.properties(title)')}`, token)
    return c.json({ data: (body.sheets ?? []).map(s => s.properties?.title ?? '').filter(Boolean) })
  })

  // 列定義の取得（ヘッダ行 = headerRow の各セル）。開始行/列を指定して列名を検出する
  app.get('/sheets/spreadsheets/:id/columns', async (c) => {
    requireEnabled(env)
    requireAdmin(c)
    const spreadsheetId = c.req.param('id')
    const sheetName = c.req.query('sheet') ?? ''
    const headerRow = Number(c.req.query('headerRow') ?? '1')
    const startColumn = c.req.query('startColumn') ?? 'A'
    const rows = await fetchSheetRows(pool, env, { spreadsheetId, sheetName, headerRow, startColumn })
    const header = rows[0] ?? []
    // 空ヘッダセルも「列N」として残す（.filter で落とすと columnIndex が実取込の unfiltered index と
    // ずれ、ヘッダに空セルがある表で誤った列を取り込む = レビュー MAJOR。parseCsvColumns と同じ規約）
    return c.json({ data: header.map((h, i) => String(h ?? '').trim() || `列${i + 1}`) })
  })

  return app
}
