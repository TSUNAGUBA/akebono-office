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

export interface GroundedTextRequest {
  system: string
  prompt: string
  maxTokens?: number
}

/**
 * Google Search グラウンディング付きテキスト生成（バッチ7i・オペレーター指示 2026-07-19 #11）。
 * AI カンパニーのステップ遂行前の Web 調査に使う。構造化出力（responseSchema）とグラウンディングの
 * 併用は Vertex 側で保証されないため、調査（本関数 = テキスト）→ 遂行（generateJson）の 2 段に分ける。
 * 失敗（未設定・認証不可・API エラー）は null（呼び出し側は調査なしで続行 = 原則4）。
 * 出典は response の groundingMetadata.groundingChunks（web.uri / web.title）から抽出して返す
 */
export async function generateGroundedText(
  env: Env,
  req: GroundedTextRequest,
): Promise<{ text: string; sources: { uri: string; title: string }[] } | null> {
  if (!env.vertexProjectId) return null
  const token = await accessToken()
  if (!token) return null
  try {
    const res = await fetch(endpoint(env), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 2048,
          temperature: 0.3,
        },
      }),
    })
    if (!res.ok) {
      console.warn(`vertex grounded generateContent failed (non-blocking): ${res.status} ${(await res.text()).slice(0, 300)}`)
      return null
    }
    const body = await res.json() as {
      candidates?: {
        content?: { parts?: { text?: string }[] }
        groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] }
      }[]
    }
    const cand = body.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? ''
    if (!text) return null
    const seen = new Set<string>()
    const sources: { uri: string; title: string }[] = []
    for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
      const uri = chunk.web?.uri ?? ''
      if (!uri || seen.has(uri)) continue
      seen.add(uri)
      sources.push({ uri, title: chunk.web?.title ?? uri })
      if (sources.length >= 8) break
    }
    return { text, sources }
  } catch (e) {
    console.warn('vertex grounded generateContent failed (non-blocking):', (e as Error).message)
    return null
  }
}

// ---------- function calling（エージェント型チャット = 改修依頼 2026-08-20） ----------

/**
 * ツール宣言（Vertex functionDeclarations の 1 件。parameters は OpenAPI 形式）。
 * 引数なしツールは parameters を**省略**する（`{type:'object', properties:{}}` は Gemini/Vertex の
 * スキーマ検証が「OBJECT は non-empty properties」を要求して 400 になる報告が多数 = レビュー R1 MAJOR-1。
 * 省略は Google 公式の推奨ワークアラウンドと一致）
 */
export interface ToolDeclaration {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** 会話コンテンツ（Vertex contents の 1 件。パーツはループ内部で組み立てる） */
export interface AgentMessage {
  role: 'user' | 'model'
  text: string
}

export interface ToolLoopRequest {
  system: string
  /** 事前の会話（履歴）。最後のユーザー発言まで含める */
  messages: AgentMessage[]
  tools: ToolDeclaration[]
  /** ツールの実行（戻り値はモデルへ渡すテキスト。呼び出し側で権限ガード・サイズ上限を担う） */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
  /** ツール呼び出しの最大ラウンド数（超過時はツール禁止で最終回答を強制） */
  maxRounds?: number
  /** ループ全体の予算（ms）。超過時もツール禁止で最終回答へ */
  deadlineMs?: number
  maxTokens?: number
}

export type ToolLoopResult =
  | { kind: 'ok'; text: string; toolCalls: { name: string; args: Record<string, unknown>; result: string }[] }
  | { kind: 'disabled' } // LLM 無効環境（未設定・メタデータサーバーなし）
  | { kind: 'error' }    // 設定済みだが API エラー（呼び出し側は正直なエラー応答へ）

interface VertexPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface VertexContent { role: string; parts: VertexPart[] }

/** 応答候補から functionCall パーツを取り出す（純関数・単体テスト対象） */
export function functionCallsOf(parts: VertexPart[] | undefined): { name: string; args: Record<string, unknown> }[] {
  return (parts ?? [])
    .map(p => p.functionCall)
    .filter((fc): fc is { name?: string; args?: Record<string, unknown> } => !!fc)
    .filter(fc => typeof fc.name === 'string' && fc.name.length > 0)
    .map(fc => ({ name: fc.name as string, args: (fc.args && typeof fc.args === 'object' ? fc.args : {}) }))
}

/**
 * 会話履歴の正規化（純関数・単体テスト対象。レビュー R1 MAJOR-2）。
 * Gemini は「contents の先頭は user」「user/model の交互」を検証するモデル/バージョンがあり、
 * 履歴ウィンドウの切詰め（LIMIT 12）や通信断補償の質問二重追記で崩れると 400 →
 * セッションが恒久的にエラー化する。先頭の model ターンを捨て、同ロール連続は結合して防御する
 */
export function normalizeAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of messages) {
    if (out.length === 0 && m.role !== 'user') continue // 先頭は user から
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      prev.text = `${prev.text}\n${m.text}` // 同ロール連続は 1 ターンへ結合（交互制約の維持）
    } else {
      out.push({ ...m })
    }
  }
  return out
}

/** 1 ラウンドで実行するツール呼び出しの上限（超過分は実行せずエラー応答を返す = 1:1 の応答対応は維持） */
const MAX_CALLS_PER_ROUND = 5

/**
 * function calling のエージェントループ（エージェント型チャット = 改修依頼 2026-08-20）。
 * モデルが必要と判断したツールを実行して functionResponse で返し、テキスト回答が出るまで繰り返す。
 * - ラウンド上限・時間予算の超過時は toolConfig: NONE でツールを禁止し、収集済みの情報で最終回答させる
 * - ツール実行の例外は「エラー: ...」テキストとしてモデルへ返す（1 ツールの失敗が会話を止めない = 原則4）
 * - 'disabled' = LLM 無効環境（呼び出し側は従来のフォールバックへ）/ 'error' = API 障害（正直なエラー応答へ）
 */
export async function runToolLoop(env: Env, req: ToolLoopRequest): Promise<ToolLoopResult> {
  if (!env.vertexProjectId) return { kind: 'disabled' }
  const token = await accessToken()
  if (!token) return { kind: 'disabled' }
  const maxRounds = req.maxRounds ?? 6
  const deadline = Date.now() + (req.deadlineMs ?? 55_000)
  const contents: VertexContent[] = normalizeAgentMessages(req.messages)
    .map(m => ({ role: m.role, parts: [{ text: m.text }] }))
  const toolCalls: { name: string; args: Record<string, unknown>; result: string }[] = []
  for (let round = 0; ; round++) {
    const finalForced = round >= maxRounds || Date.now() > deadline
    let body: { candidates?: { content?: { role?: string; parts?: VertexPart[] } }[] }
    try {
      const res = await fetch(endpoint(env), {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          tools: [{ functionDeclarations: req.tools }],
          // 最終ラウンドはツールを禁止して回答を強制する（無限ループ防止）
          toolConfig: { functionCallingConfig: { mode: finalForced ? 'NONE' : 'AUTO' } },
          generationConfig: { maxOutputTokens: req.maxTokens ?? 2048, temperature: 0.3 },
        }),
      })
      if (!res.ok) {
        console.warn(`vertex tool loop failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
        return { kind: 'error' }
      }
      body = await res.json() as typeof body
    } catch (e) {
      console.warn('vertex tool loop failed:', (e as Error).message)
      return { kind: 'error' }
    }
    const parts = body.candidates?.[0]?.content?.parts ?? []
    const calls = finalForced ? [] : functionCallsOf(parts)
    if (calls.length === 0) {
      const text = parts.map(p => p.text ?? '').join('').trim()
      if (!text) return { kind: 'error' }
      return { kind: 'ok', text, toolCalls }
    }
    // モデルのターン（functionCall）を履歴へ → 各ツールを実行して functionResponse を返す。
    // 上限超過分は実行せずエラー応答（functionCall と functionResponse の 1:1 対応は維持）
    contents.push({ role: 'model', parts })
    const responses: VertexPart[] = []
    for (const [i, call] of calls.entries()) {
      let result: string
      if (i >= MAX_CALLS_PER_ROUND) {
        result = `エラー: 1 回のツール呼び出しが多すぎます（最大 ${MAX_CALLS_PER_ROUND} 件。必要なら次のラウンドで呼んでください）`
      } else {
        try {
          result = await req.execute(call.name, call.args)
        } catch (e) {
          result = `エラー: ツールの実行に失敗しました（${(e as Error).message}）`
        }
      }
      toolCalls.push({ ...call, result })
      responses.push({ functionResponse: { name: call.name, response: { result } } })
    }
    contents.push({ role: 'user', parts: responses })
  }
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
