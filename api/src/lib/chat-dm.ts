/**
 * 外部チャット DM のプリミティブ（通知の AKEBONO Home 名義化 2026-08-20）。
 * 連携（宛先解決 = routes/notification-channels.ts）と配信（lib/notify.ts）で共用する（原則3）。
 *
 * 送信名義はテナント単位の資格情報が決める:
 * - Slack: Bot Token（xoxb-…）。アプリの表示名/アイコン（AKEBONO Home）は Slack アプリ設定側。
 *   必要な Bot Token Scopes: chat:write（送信）/ im:write（DM オープン）/
 *   users:read + users:read.email（メールでの宛先解決）
 * - Google Chat: Chat アプリ（サービスアカウント・scope = chat.bot）。表示名/アバターは
 *   GCP の Chat API 構成側。ユーザー参照は users/{email}（新規連携）と users/{sub}（旧行）の両形式が有効
 *
 * 各ステップは StepResult を返す（retry = 一時障害 / auth = テナント資格情報の不備 /
 * fail = 恒久失敗 + 診断詳細）。リトライ・結果集約は呼び出し側（notify.ts の deliverViaLink）の責務。
 * 公式ドキュメントの注記: 本環境からは api.slack.com / developers.google.com が egress 制限で
 * 参照不能のため、安定 API（Slack Web API / Chat REST v1 / RFC 7523）に基づき実装し、
 * 想定外の応答は detail にステップ名 + 上流応答を残して本番で自己診断できるようにしている（§94-2 と同じ判断）。
 */

const SLACK_API_BASE = 'https://slack.com/api'
const GOOGLE_CHAT_BASE = 'https://chat.googleapis.com/v1'
/** Google Chat のアプリ認証スコープ */
export const GOOGLE_CHAT_APP_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
/** 外部 HTTP の共通タイムアウト */
const EXTERNAL_TIMEOUT_MS = 15_000

/**
 * 1 ステップの結果。
 * retry = 5xx / 429 / タイムアウト（呼び出し側が指数バックオフ）
 * auth  = テナント資格情報の不備（Bot Token 失効・SA 鍵無効など。管理者側の問題 = ユーザー操作では直らない。
 *         detail は診断用の失効コード等 = 任意）
 * fail  = 恒久失敗（宛先が見つからない・スコープ不足・API 未有効化など。detail に診断情報）
 */
export type StepResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'retry' }
  | { kind: 'auth'; detail?: string }
  | { kind: 'fail'; detail: string }

/** Slack Web API の資格情報不備エラーコード（Bot Token の失効・無効） */
const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed'])

/** 上流エラー応答の診断用要約（先頭 160 字。失敗は空文字 = 非ブロッキング） */
export async function safeErrorSnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, ' ').trim()
    return text ? ` ${text.slice(0, 160)}` : ''
  } catch {
    return ''
  }
}

/**
 * Slack Web API 呼び出しの共通処理（HTTP / ok=false の判定を StepResult へ写像）。
 * ボディは form エンコード固定: Slack の JSON ボディ受理は書込系メソッドに限られ、
 * users.lookupByEmail 等の読取系は application/x-www-form-urlencoded のみ受理するため
 * （公式クライアント @slack/web-api も全リクエストを form で送る。監査 R1 MAJOR-1）
 */
async function slackCall<T>(
  botToken: string,
  method: string,
  body: Record<string, string>,
  pick: (json: Record<string, unknown>) => T | null,
): Promise<StepResult<T>> {
  try {
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      body: new URLSearchParams(body),
    })
    if (res.status === 429 || res.status >= 500) return { kind: 'retry' }
    if (res.status === 401) return { kind: 'auth', detail: `${method}: HTTP 401` }
    // 非 JSON 応答（プロキシの HTML エラー等）は真因を残して恒久失敗にする（リトライで原因をぼかさない）
    const json = await res.json().catch(() => null) as (Record<string, unknown> & { ok?: boolean; error?: string }) | null
    if (!json) return { kind: 'fail', detail: `${method}: 応答が JSON ではありません（HTTP ${res.status}）` }
    if (!json.ok) {
      const error = json.error ?? '不明なエラー'
      if (SLACK_AUTH_ERRORS.has(error)) return { kind: 'auth', detail: `${method}: ${error}` }
      if (error === 'ratelimited') return { kind: 'retry' }
      return { kind: 'fail', detail: `${method}: ${error}` }
    }
    const value = pick(json)
    if (value === null) return { kind: 'fail', detail: `${method}: 応答に必要なフィールドがありません` }
    return { kind: 'ok', value }
  } catch {
    return { kind: 'retry' } // タイムアウト・接続断は一時障害
  }
}

/**
 * メールアドレスで Slack ユーザーを解決する（users.lookupByEmail）。
 * users_not_found = ワークスペースに該当メールのユーザーがいない（detail で案内）。
 */
export async function slackLookupUserByEmail(
  botToken: string,
  email: string,
): Promise<StepResult<{ userId: string; displayName: string }>> {
  const result = await slackCall(botToken, 'users.lookupByEmail', { email }, (json) => {
    const user = json.user as { id?: string; name?: string; profile?: { real_name?: string } } | undefined
    if (!user?.id) return null
    return { userId: user.id, displayName: user.profile?.real_name || user.name || user.id }
  })
  if (result.kind === 'fail' && result.detail.includes('users_not_found')) {
    return { kind: 'fail', detail: `users.lookupByEmail: Slack ワークスペースに ${email} のユーザーが見つかりません（Slack 登録メールと一致しているか確認してください）` }
  }
  return result
}

/** Bot とユーザーの DM チャンネルを開く（conversations.open。既存 DM はそのまま返る = 冪等） */
export function slackOpenDm(botToken: string, userId: string): Promise<StepResult<string>> {
  return slackCall(botToken, 'conversations.open', { users: userId },
    json => (json.channel as { id?: string } | undefined)?.id ?? null)
}

/**
 * Slack の DM 宛先解決（連携時 = email から / 送信時の自己修復 = 解決済み userId から。共用 = 原則3）。
 * userId 指定時は lookupByEmail を省略する（displayName は空 = 既存表示名を維持する合図）。
 */
export async function slackResolveDm(
  botToken: string,
  opts: { email: string; userId?: string },
): Promise<StepResult<{ userId: string; dmChannel: string; displayName: string }>> {
  let userId = opts.userId ?? ''
  let displayName = ''
  if (!userId) {
    const lookedUp = await slackLookupUserByEmail(botToken, opts.email)
    if (lookedUp.kind !== 'ok') return lookedUp
    userId = lookedUp.value.userId
    displayName = lookedUp.value.displayName
  }
  const opened = await slackOpenDm(botToken, userId)
  if (opened.kind !== 'ok') return opened
  return { kind: 'ok', value: { userId, dmChannel: opened.value, displayName } }
}

/** DM チャンネルへ Bot 名義（AKEBONO Home）で送信する（chat.postMessage） */
export function slackPostDm(botToken: string, channel: string, text: string): Promise<StepResult<true>> {
  return slackCall(botToken, 'chat.postMessage', { channel, text }, () => true)
}

/** Google Chat API 呼び出しの共通処理（アプリ認証トークン前提） */
async function chatCall(
  token: string,
  step: string,
  url: string,
  init: RequestInit,
): Promise<StepResult<Record<string, unknown>>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    })
    if (res.status === 429 || res.status >= 500) return { kind: 'retry' }
    if (res.status === 401) return { kind: 'auth', detail: `${step}: HTTP 401` }
    if (!res.ok) return { kind: 'fail', detail: `${step}: HTTP ${res.status}${await safeErrorSnippet(res)}` }
    return { kind: 'ok', value: await res.json() as Record<string, unknown> }
  } catch {
    return { kind: 'retry' }
  }
}

/**
 * Chat アプリとユーザーの DM スペースを解決する。
 * spaces.findDirectMessage（既存 DM）→ 404 なら spaces.setup（新規作成。既存があれば 409 を経て再検索）。
 * userRef は users/{email}（新規連携）または users/{sub}（0075 時代の旧行）のどちらでもよい。
 */
export async function googleChatFindOrCreateDm(token: string, userRef: string): Promise<StepResult<string>> {
  const find = await chatCall(token, 'spaces.findDirectMessage',
    `${GOOGLE_CHAT_BASE}/spaces:findDirectMessage?name=${encodeURIComponent(userRef)}`, { method: 'GET' })
  if (find.kind === 'ok') {
    const name = (find.value as { name?: string }).name
    return name ? { kind: 'ok', value: name } : { kind: 'fail', detail: 'spaces.findDirectMessage: 応答に name がありません' }
  }
  // 404 = DM 未作成 → setup で作成。それ以外の fail（403 = API 未有効化・アプリ未構成等）はそのまま診断へ
  if (find.kind !== 'fail' || !find.detail.includes('HTTP 404')) return find
  const setup = await chatCall(token, 'spaces.setup', `${GOOGLE_CHAT_BASE}/spaces:setup`, {
    method: 'POST',
    body: JSON.stringify({
      space: { spaceType: 'DIRECT_MESSAGE' },
      memberships: [{ member: { name: userRef, type: 'HUMAN' } }],
    }),
  })
  if (setup.kind === 'ok') {
    const name = (setup.value as { name?: string }).name
    return name ? { kind: 'ok', value: name } : { kind: 'fail', detail: 'spaces.setup: 応答に name がありません' }
  }
  // 409（並行作成等で既に存在）は再検索で回収する（冪等 = 原則2）
  if (setup.kind === 'fail' && setup.detail.includes('HTTP 409')) {
    const retryFind = await chatCall(token, 'spaces.findDirectMessage',
      `${GOOGLE_CHAT_BASE}/spaces:findDirectMessage?name=${encodeURIComponent(userRef)}`, { method: 'GET' })
    if (retryFind.kind === 'ok') {
      const name = (retryFind.value as { name?: string }).name
      if (name) return { kind: 'ok', value: name }
    }
    return setup
  }
  return setup
}

/** DM スペースへアプリ名義（AKEBONO Home）で送信する（messages.create） */
export async function googleChatPostDm(token: string, space: string, text: string): Promise<StepResult<true>> {
  const result = await chatCall(token, 'messages.create',
    `${GOOGLE_CHAT_BASE}/${space}/messages`, { method: 'POST', body: JSON.stringify({ text }) })
  return result.kind === 'ok' ? { kind: 'ok', value: true } : result
}
