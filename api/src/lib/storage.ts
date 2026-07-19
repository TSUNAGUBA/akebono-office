/**
 * ドキュメント実体の保管（バッチ7l・F-09-3）。
 * - GCS モード（STORAGE_BUCKET 設定時）: Firebase の Cloud Storage バケットを JSON API + ADC
 *   （メタデータサーバー = llm.ts の accessToken 再利用）で直接操作。SDK 依存を増やさない
 *   （カレンダー・Vertex と同じ raw fetch パターン = 原則3）
 * - DB フォールバック（未設定時）: document_blobs（bytea）。ローカル/CI/未設定環境でも
 *   全機能が動作する（原則1・4。署名 URL のみ GCS 専用 = null を返しクライアントは base64 経路へ）
 * - 署名 URL: V4 署名を IAM Credentials signBlob で生成（実行 SA 自身への
 *   roles/iam.serviceAccountTokenCreator が必要 = deploy.yml が付与）。失敗は null（非ブロッキング）
 */
import { createHash } from 'node:crypto'
import type { Env } from '../env'
import { accessToken } from './llm'

const GCS_BASE = 'https://storage.googleapis.com'
const METADATA_EMAIL_URL
  = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email'

export function gcsEnabled(env: Env): boolean {
  return Boolean(env.storageBucket)
}

/**
 * RFC 3986 厳格版パーセントエンコード（V4 署名の正規化と等価にするため
 * encodeURIComponent が素通しする ! ' ( ) * も %XX 化する。R1 M-1）
 */
export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * 保存ファイル名のサニタイズ（R1 M-1）。パス区切り・制御文字を除去し、
 * `.`/`..`/空になった名前は無害なフォールバック名にする（storage_path とダウンロード名の両方に使う）
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file'
  return cleaned
}

/** オブジェクトパスの URL エンコード（スラッシュはパス区切りとして保持。厳格版 = 署名と等価） */
function encodePath(path: string): string {
  return path.split('/').map(strictEncode).join('/')
}

export async function putObject(env: Env, path: string, bytes: Buffer, mime: string): Promise<boolean> {
  const token = await accessToken()
  if (!token) return false
  try {
    const res = await fetch(
      `${GCS_BASE}/upload/storage/v1/b/${encodeURIComponent(env.storageBucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': mime || 'application/octet-stream' },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(30_000),
      })
    return res.ok
  } catch {
    return false
  }
}

export async function getObject(env: Env, path: string): Promise<Buffer | null> {
  const token = await accessToken()
  if (!token) return null
  try {
    const res = await fetch(
      `${GCS_BASE}/storage/v1/b/${encodeURIComponent(env.storageBucket)}/o/${encodeURIComponent(path)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

/** 削除（アーカイブ後の実体整理等の補助処理用。失敗しても呼び出し側の主フローは止めない） */
export async function deleteObject(env: Env, path: string): Promise<boolean> {
  const token = await accessToken()
  if (!token) return false
  try {
    const res = await fetch(
      `${GCS_BASE}/storage/v1/b/${encodeURIComponent(env.storageBucket)}/o/${encodeURIComponent(path)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

let cachedSaEmail: string | null = null

/** 実行サービスアカウントの email（メタデータサーバー。ローカル等は null） */
async function serviceAccountEmail(): Promise<string | null> {
  if (cachedSaEmail) return cachedSaEmail
  try {
    const res = await fetch(METADATA_EMAIL_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    cachedSaEmail = (await res.text()).trim()
    return cachedSaEmail
  } catch {
    return null
  }
}

export interface SignedUrlParts {
  canonicalUri: string
  canonicalQuery: string
  canonicalRequest: string
  stringToSign: string
  timestamp: string
}

/**
 * V4 署名の正規リクエスト・署名対象文字列の構築（純粋関数 = 単体テスト対象）。
 * 仕様: https://cloud.google.com/storage/docs/authentication/signatures
 */
export function buildV4SignParts(input: {
  bucket: string
  path: string
  saEmail: string
  now: Date
  expiresSeconds: number
  responseDisposition?: string
}): SignedUrlParts {
  const timestamp = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const datestamp = timestamp.slice(0, 8)
  const scope = `${datestamp}/auto/storage/goog4_request`
  const canonicalUri = `/${encodeURIComponent(input.bucket)}/${encodePath(input.path)}`
  const params: [string, string][] = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${input.saEmail}/${scope}`],
    ['X-Goog-Date', timestamp],
    ['X-Goog-Expires', String(input.expiresSeconds)],
    ['X-Goog-SignedHeaders', 'host'],
  ]
  if (input.responseDisposition) params.push(['response-content-disposition', input.responseDisposition])
  // V4 仕様の並び順はコードポイント順（localeCompare はロケール順で大文字/小文字の順序が変わるため不可）。
  // エンコードは厳格版（! ' ( ) * も %XX）= GCS 側の正規化と等価にする
  const canonicalQuery = params
    .map(([k, v]) => [strictEncode(k), strictEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery,
    'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'GOOG4-RSA-SHA256', timestamp, scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  return { canonicalUri, canonicalQuery, canonicalRequest, stringToSign, timestamp }
}

/**
 * 期限付きダウンロード URL（V4 署名。GCS モードのみ）。
 * 失敗（ローカル環境・signBlob 権限なし等）は null = クライアントは base64 ダウンロード経路へ縮退
 */
export async function signedDownloadUrl(
  env: Env, path: string, filename: string, expiresSeconds = 15 * 60,
): Promise<string | null> {
  if (!gcsEnabled(env)) return null
  const [token, saEmail] = await Promise.all([accessToken(), serviceAccountEmail()])
  if (!token || !saEmail) return null
  // RFC 5987 の ext-value は ' を区切りに使うため厳格エンコード（' を %27 化）が必須
  const disposition = `attachment; filename*=UTF-8''${strictEncode(filename)}`
  const parts = buildV4SignParts({
    bucket: env.storageBucket, path, saEmail, now: new Date(), expiresSeconds,
    responseDisposition: disposition,
  })
  try {
    const res = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:signBlob`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: Buffer.from(parts.stringToSign).toString('base64') }),
        signal: AbortSignal.timeout(10_000),
      })
    if (!res.ok) return null
    const body = await res.json() as { signedBlob?: string }
    if (!body.signedBlob) return null
    const signature = Buffer.from(body.signedBlob, 'base64').toString('hex')
    return `${GCS_BASE}${parts.canonicalUri}?${parts.canonicalQuery}&X-Goog-Signature=${signature}`
  } catch {
    return null
  }
}
