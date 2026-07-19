/**
 * LLM 呼び出し（Vertex AI generateContent。オペレーター決定 2026-07-17: AI 機能は Vertex AI を使用）
 * - 認証: Cloud Run のサービスアカウント（ADC）。メタデータサーバーからアクセストークンを取得する
 *   ため、鍵や API キーの Secrets は不要（SA へ roles/aiplatform.user を付与するだけ）
 * - VERTEX_PROJECT_ID 未設定・ローカル/CI（メタデータサーバーなし）・API エラー時は null を返し、
 *   呼び出し側が決定的ヒューリスティックへフォールバックする（グレースフルデグラデーション = 原則4）
 * - 構造化出力は responseSchema（responseMimeType: application/json）で強制する
 */
import type { Env } from '../env'

const METADATA_TOKEN_URL
  = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

let cachedToken: { token: string; expiresAt: number } | null = null

/** ADC アクセストークン（メタデータサーバー）。取得不可 = LLM 無効環境として null（embeddings.ts でも再利用） */
export async function accessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { access_token: string; expires_in: number }
    cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return body.access_token
  } catch {
    return null
  }
}

function endpoint(env: Env): string {
  const host = env.vertexLocation === 'global'
    ? 'aiplatform.googleapis.com'
    : `${env.vertexLocation}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${env.vertexProjectId}/locations/${env.vertexLocation}`
    + `/publishers/google/models/${env.vertexModel}:generateContent`
}

export interface LlmJsonRequest {
  /** システム指示（役割・制約） */
  system: string
  /** ユーザープロンプト（文脈 + 依頼） */
  prompt: string
  /** OpenAPI 形式の responseSchema（構造化出力を強制） */
  schema: Record<string, unknown>
  /** 生成上限トークン（既定 2048） */
  maxTokens?: number
  /** 添付画像（マルチモーダル入力。AI タスクの依頼・回答添付 = バッチ7f。プロンプトの前に並べる） */
  images?: { mime: string; dataBase64: string }[]
}

/**
 * 構造化 JSON 生成。失敗（未設定・認証不可・API エラー・パース不能）は null を返す（例外は投げない）。
 * 呼び出し側は null をヒューリスティックへのフォールバック契機として扱うこと
 */
export async function generateJson<T>(env: Env, req: LlmJsonRequest): Promise<T | null> {
  if (!env.vertexProjectId) return null
  const token = await accessToken()
  if (!token) return null
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{
          role: 'user',
          parts: [
            ...(req.images ?? []).map(img => ({ inlineData: { mimeType: img.mime, data: img.dataBase64 } })),
            { text: req.prompt },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: req.schema,
          maxOutputTokens: req.maxTokens ?? 2048,
          temperature: 0.4,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`vertex generateContent failed (non-blocking): ${res.status} ${(await res.text()).slice(0, 300)}`)
      return null
    }
    const body = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
    if (!text) return null
    return JSON.parse(text) as T
  } catch (e) {
    console.warn('vertex generateContent failed (non-blocking):', (e as Error).message)
    return null
  }
}
