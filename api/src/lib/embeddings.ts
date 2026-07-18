/**
 * テキスト埋め込み（Vertex AI text embeddings。AI 検索最適化基盤 = search_docs 用）。
 * - 認証・無効判定は llm.ts と同一（VERTEX_PROJECT_ID 空・ADC 不可・API エラーは null =
 *   呼び出し側が字句検索のみへ縮退する。グレースフルデグラデーション = 原則4）
 * - RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY のタスク種別を使い分ける（検索向けの推奨設定）
 */
import type { Env } from '../env'
import { accessToken } from './llm'

const BATCH_SIZE = 20
/** 埋め込み入力の上限（コードポイント。モデル入力上限より十分小さく = 文書は先頭要約で代表させる） */
const INPUT_CAP = 6000

function endpoint(env: Env): string {
  const host = env.vertexLocation === 'global'
    ? 'aiplatform.googleapis.com'
    : `${env.vertexLocation}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${env.vertexProjectId}/locations/${env.vertexLocation}`
    + `/publishers/google/models/${env.vertexEmbeddingModel}:predict`
}

async function predictBatch(
  env: Env,
  token: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
): Promise<(number[] | null)[] | null> {
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        instances: texts.map(t => ({ content: [...t].slice(0, INPUT_CAP).join(''), task_type: taskType })),
      }),
    })
    if (!res.ok) {
      console.warn(`vertex embeddings failed (non-blocking): ${res.status} ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const body = await res.json() as { predictions?: { embeddings?: { values?: number[] } }[] }
    return texts.map((_, i) => body.predictions?.[i]?.embeddings?.values ?? null)
  } catch (e) {
    console.warn('vertex embeddings failed (non-blocking):', (e as Error).message)
    return null
  }
}

/**
 * 複数テキストの埋め込み（文書側）。無効環境・失敗は null（= 埋め込みなしで続行）。
 * 部分失敗はそのバッチのみ null 埋め（他バッチは活かす）
 */
export async function embedDocuments(env: Env, texts: string[]): Promise<(number[] | null)[] | null> {
  if (!env.vertexProjectId || texts.length === 0) return null
  const token = await accessToken()
  if (!token) return null
  const out: (number[] | null)[] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = await predictBatch(env, token, texts.slice(i, i + BATCH_SIZE), 'RETRIEVAL_DOCUMENT')
    out.push(...(batch ?? texts.slice(i, i + BATCH_SIZE).map(() => null)))
  }
  return out
}

/** 検索クエリの埋め込み（1 件）。無効環境・失敗は null = 字句検索のみ */
export async function embedQuery(env: Env, text: string): Promise<number[] | null> {
  if (!env.vertexProjectId || !text) return null
  const token = await accessToken()
  if (!token) return null
  const batch = await predictBatch(env, token, [text], 'RETRIEVAL_QUERY')
  return batch?.[0] ?? null
}

/** コサイン類似度（次元不一致・ゼロベクトルは 0） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
