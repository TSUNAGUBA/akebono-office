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

/** トークン実測（Vertex usageMetadata。観測基盤 = オペレーター指示 2026-08-05） */
export interface LlmUsage {
  promptTokens: number
  outputTokens: number
  totalTokens: number
}

/** ツール（function calling）の宣言。parameters は OpenAPI 形式 */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolLoopRequest {
  system: string
  prompt: string
  /** 最終回答（final_answer）の構造化スキーマ（OpenAPI 形式の parameters） */
  finalSchema: Record<string, unknown>
  tools: ToolDef[]
  /** ツール実行（権限チェックは実装側 = コードで enforcement。失敗は {error} を返すこと） */
  execute: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  maxTokens?: number
  /** LLM 呼び出しの最大ラウンド数（最終ラウンドは final_answer を強制）。既定 5 */
  maxRounds?: number
}

export interface ToolLoopResult<T> {
  /** final_answer の引数（構造化回答）。取得できなかった場合は null = フォールバック契機 */
  data: T | null
  usage: LlmUsage
  toolCalls: { name: string; ok: boolean }[]
  rounds: number
}

const FINAL_TOOL = 'final_answer'

interface VertexPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
}

interface VertexToolResponse {
  candidates?: { content?: { role?: string; parts?: VertexPart[] } }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
}

/**
 * ツールユース付き構造化生成（エージェンティック RAG = オペレーター指示 2026-08-05）。
 * モデルにツール群 + final_answer を渡し、必要な社内データをモデル自身が取得してから
 * final_answer で回答を確定するループ。functionCallingConfig.mode = ANY でテキスト直返しを防ぎ、
 * 最終ラウンドは allowedFunctionNames で final_answer を強制する。
 * - グラウンディング同様、responseSchema とツールは併用不可のため、構造化は final_answer の
 *   parameters（OpenAPI）で担保する（llm.ts 冒頭の 2 段構成の設計判断と同型）
 * - 失敗（未設定・認証不可・初回 API エラー）は null（呼び出し側がフォールバック = 原則4）。
 *   途中ラウンドの失敗は、それまでの usage を保った data: null で返す
 */
export async function generateJsonWithTools<T>(
  env: Env,
  req: ToolLoopRequest,
): Promise<ToolLoopResult<T> | null> {
  if (!env.vertexProjectId) return null
  const token = await accessToken()
  if (!token) return null
  const maxRounds = req.maxRounds ?? 5
  const usage: LlmUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 }
  const toolCalls: { name: string; ok: boolean }[] = []
  const declarations = [
    ...req.tools,
    {
      name: FINAL_TOOL,
      description: '最終回答を確定する。必要な社内データが揃ったら（または追加取得が不要なら）必ずこの関数を呼ぶ。',
      parameters: req.finalSchema,
    },
  ]
  const contents: Record<string, unknown>[] = [{ role: 'user', parts: [{ text: req.prompt }] }]
  let rounds = 0
  const result = (data: T | null): ToolLoopResult<T> => ({ data, usage, toolCalls, rounds })
  for (; rounds < maxRounds;) {
    rounds++
    const isLast = rounds >= maxRounds
    let body: VertexToolResponse
    try {
      const res = await fetch(endpoint(env), {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          tools: [{ functionDeclarations: declarations }],
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY',
              ...(isLast ? { allowedFunctionNames: [FINAL_TOOL] } : {}),
            },
          },
          generationConfig: { maxOutputTokens: req.maxTokens ?? 2048, temperature: 0.3 },
        }),
      })
      if (!res.ok) {
        console.warn(`vertex tool loop failed (non-blocking): ${res.status} ${(await res.text()).slice(0, 300)}`)
        return rounds === 1 ? null : result(null)
      }
      body = await res.json() as VertexToolResponse
    } catch (e) {
      console.warn('vertex tool loop failed (non-blocking):', (e as Error).message)
      return rounds === 1 ? null : result(null)
    }
    const u = body.usageMetadata
    usage.promptTokens += u?.promptTokenCount ?? 0
    usage.outputTokens += u?.candidatesTokenCount ?? 0
    usage.totalTokens += u?.totalTokenCount ?? 0
    const parts = body.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter((p): p is Required<Pick<VertexPart, 'functionCall'>> => !!p.functionCall)
    const final = calls.find(p => p.functionCall.name === FINAL_TOOL)
    if (final) return result((final.functionCall.args ?? {}) as T)
    if (calls.length === 0) return result(null) // mode=ANY では想定外（安全側 = フォールバック）
    // ツールを順次実行し、モデルターン + functionResponse ターンを積んで次ラウンドへ。
    // 個別のツール失敗は {error} としてモデルへ返し、ループ全体は止めない（原則4）
    const responses: Record<string, unknown>[] = []
    // 1 ラウンドの並列呼び出しは 4 件まで（functionCall と functionResponse の件数は一致させる）
    const executed = calls.slice(0, 4)
    for (const call of executed) {
      const name = call.functionCall.name
      let response: Record<string, unknown>
      try {
        response = await req.execute(name, call.functionCall.args ?? {})
        toolCalls.push({ name, ok: !('error' in response) })
      } catch (e) {
        response = { error: `ツールの実行に失敗しました: ${(e as Error).message}` }
        toolCalls.push({ name, ok: false })
      }
      responses.push({ functionResponse: { name, response } })
    }
    contents.push({ role: 'model', parts: executed.map(p => ({ functionCall: p.functionCall })) })
    contents.push({ role: 'user', parts: responses })
  }
  return result(null)
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
