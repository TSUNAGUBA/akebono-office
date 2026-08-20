/**
 * Google サービスアカウント（SA）認証: SA 鍵 JSON から OAuth 2.0 アクセストークンを取得する
 * （JWT Bearer フロー = RFC 7523。通知の AKEBONO Home 名義化 2026-08-20）。
 *
 * Google Chat の「アプリ名義」送信（scope = chat.bot）が利用する。個人 OAuth と異なり
 * ユーザー同意・refresh token が存在せず、SA の秘密鍵で署名した JWT を都度アクセストークンへ
 * 交換する。トークンはプロセス内で鍵 JSON + scope ごとにキャッシュし、期限 60 秒前に破棄する
 * （Chat API 呼び出しのたびの交換を避ける。Cloud Run の複数インスタンス間で共有しないのは
 * 設計判断: トークンは何度でも再発行でき、共有ストアはむしろ漏えい面を増やす）。
 *
 * 失敗は SaTokenResult（retry = 一時障害 = 呼び出し側のバックオフ対象 / auth = 鍵不備 + 診断詳細。
 * 例外は投げない = 非ブロッキング。原則4）。
 */
import { createSign } from 'node:crypto'

/** SA 鍵 JSON の必要フィールド（parse 失敗・欠落は null = 設定不備として扱う） */
export interface SaKey {
  clientEmail: string
  privateKey: string
  tokenUri: string
}

/** SA 鍵 JSON のパース（純関数・単体テスト対象）。不正な JSON・必須欠落・SA 以外の鍵は null */
export function parseSaKey(raw: string): SaKey | null {
  try {
    const obj = JSON.parse(raw) as {
      type?: string; client_email?: string; private_key?: string; token_uri?: string
    }
    if (obj.type !== 'service_account' || !obj.client_email || !obj.private_key) return null
    return {
      clientEmail: obj.client_email,
      privateKey: obj.private_key,
      tokenUri: obj.token_uri || 'https://oauth2.googleapis.com/token',
    }
  } catch {
    return null
  }
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

/**
 * JWT Bearer アサーションの構築（RS256。nowSec を注入可能にして単体テスト対象）。
 * claims: iss = SA メール / scope / aud = トークンエンドポイント / exp = iat + 3600
 */
export function buildSaAssertion(key: SaKey, scope: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: key.clientEmail,
    scope,
    aud: key.tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  }))
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.privateKey, 'base64url')
  return `${header}.${claims}.${signature}`
}

/** プロセス内トークンキャッシュ（鍵 JSON + scope ごと。期限 60 秒前に失効扱い） */
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>()

/**
 * トークン取得の結果（レビュー R1: 一時障害と鍵不備を区別し、一時障害は呼び出し側の
 * 指数バックオフ対象にする）。
 * retry = トークンエンドポイントの 5xx / 429 / タイムアウト / auth = 鍵不備・交換拒否（detail = 診断）
 */
export type SaTokenResult =
  | { kind: 'ok'; token: string }
  | { kind: 'retry' }
  | { kind: 'auth'; detail: string }

/** SA のアクセストークンを取得する（キャッシュ命中時は交換なし） */
export async function saAccessToken(saKeyJson: string, scope: string): Promise<SaTokenResult> {
  const cacheKey = `${scope}\n${saKeyJson}`
  const hit = tokenCache.get(cacheKey)
  if (hit && hit.expiresAtMs > Date.now()) return { kind: 'ok', token: hit.token }
  const key = parseSaKey(saKeyJson)
  if (!key) return { kind: 'auth', detail: 'サービスアカウント鍵 JSON を解析できません（GOOGLE_CHAT_SA_KEY の内容を確認）' }
  let assertion: string
  try {
    assertion = buildSaAssertion(key, scope)
  } catch {
    return { kind: 'auth', detail: 'サービスアカウント鍵で署名できません（private_key が不正）' }
  }
  try {
    const res = await fetch(key.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })
    if (res.status === 429 || res.status >= 500) return { kind: 'retry' }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
      console.warn('google sa token exchange failed:', res.status, snippet)
      return { kind: 'auth', detail: `トークン交換に失敗（HTTP ${res.status}${snippet ? ` ${snippet}` : ''}）` }
    }
    const body = await res.json() as { access_token?: string; expires_in?: number }
    if (!body.access_token) return { kind: 'auth', detail: 'トークン交換の応答に access_token がありません' }
    tokenCache.set(cacheKey, {
      token: body.access_token,
      expiresAtMs: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
    })
    return { kind: 'ok', token: body.access_token }
  } catch {
    return { kind: 'retry' } // タイムアウト・接続断（一時障害 = バックオフ対象）
  }
}
