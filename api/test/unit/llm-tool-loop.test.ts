/**
 * runToolLoop（エージェントループ = レビュー R1 MINOR-6）の制御フロー検証。
 * 外部 HTTP は行わない（global fetch をスタブし、リクエスト形状と応答駆動のループ挙動を検証する）。
 * ここで検証する形状は本番障害に直結する: 引数なしツールの parameters 省略（R1 MAJOR-1 =
 * 空 properties は Vertex が 400）・contents の先頭 user / 交互制約（R1 MAJOR-2）・
 * functionCall と functionResponse の 1:1 対応。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { type AgentMessage, normalizeAgentMessages, runToolLoop } from '../../src/lib/llm'

const env = {
  vertexProjectId: 'test-project', vertexLocation: 'global', vertexModel: 'gemini-test', corsOrigins: [],
} as unknown as Env

/** 記録付き fetch スタブ（メタデータサーバーはトークンを返し、Vertex へのリクエスト body を蓄積） */
let vertexRequests: Record<string, any>[] = []
let vertexResponses: { status?: number; json: unknown }[] = []

function stubFetch(): void {
  vertexRequests = []
  vertexResponses = []
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes('metadata.google.internal')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 })
    }
    vertexRequests.push(JSON.parse(init?.body ?? '{}'))
    const next = vertexResponses.shift() ?? { json: {} }
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 })
  })
}

const textResponse = (text: string) => ({ json: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] } })
const callResponse = (calls: { name: string; args?: Record<string, unknown> }[]) => ({
  json: { candidates: [{ content: { role: 'model', parts: calls.map(c => ({ functionCall: c })) } }] },
})

const USER_MSG: AgentMessage[] = [{ role: 'user', text: '質問です' }]
const TOOLS = [
  { name: 'no_arg_tool', description: '引数なしツール' }, // parameters 省略（空 properties を送らない）
  { name: 'arg_tool', description: '引数ありツール', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
]

beforeEach(stubFetch)
afterEach(() => vi.unstubAllGlobals())

describe('normalizeAgentMessages（contents の先頭 user / 交互制約の防御 = R1 MAJOR-2）', () => {
  it('先頭の model ターンを捨て、同ロール連続は結合する', () => {
    expect(normalizeAgentMessages([
      { role: 'model', text: '迷子の回答' },
      { role: 'user', text: 'A' },
      { role: 'user', text: 'B' }, // 通信断補償の質問二重追記で起きる形
      { role: 'model', text: 'C' },
      { role: 'user', text: 'D' },
    ])).toEqual([
      { role: 'user', text: 'A\nB' },
      { role: 'model', text: 'C' },
      { role: 'user', text: 'D' },
    ])
  })

  it('正常な交互列はそのまま（元配列は破壊しない）', () => {
    const src: AgentMessage[] = [{ role: 'user', text: 'A' }, { role: 'model', text: 'B' }, { role: 'user', text: 'C' }]
    expect(normalizeAgentMessages(src)).toEqual(src)
    expect(src[0]?.text).toBe('A')
  })
})

describe('runToolLoop（ツール実行ループ）', () => {
  it('functionCall → 実行 → functionResponse → テキスト回答（リクエスト形状も検証）', async () => {
    vertexResponses = [callResponse([{ name: 'arg_tool', args: { q: '検索語' } }]), textResponse('回答です')]
    const executed: string[] = []
    const result = await runToolLoop(env, {
      system: 'sys',
      messages: USER_MSG,
      tools: TOOLS,
      execute: async (name, args) => {
        executed.push(`${name}:${String(args.q ?? '')}`)
        return 'ツール結果'
      },
    })
    expect(result).toEqual({
      kind: 'ok', text: '回答です',
      toolCalls: [{ name: 'arg_tool', args: { q: '検索語' }, result: 'ツール結果' }],
    })
    expect(executed).toEqual(['arg_tool:検索語'])
    // 1 リクエスト目: 引数なしツールは parameters キー自体を持たない（空 properties は Vertex が 400 = R1 MAJOR-1）
    const first = vertexRequests[0]!
    const decls = first.tools[0].functionDeclarations as Record<string, unknown>[]
    expect('parameters' in decls[0]!).toBe(false)
    expect(decls[1]!.parameters).toBeTruthy()
    expect(first.contents[0].role).toBe('user')
    expect(first.toolConfig.functionCallingConfig.mode).toBe('AUTO')
    // 2 リクエスト目: model の functionCall ターン + user の functionResponse ターン（1:1 対応）
    const second = vertexRequests[1]!
    expect(second.contents.at(-2).role).toBe('model')
    expect(second.contents.at(-1).role).toBe('user')
    expect(second.contents.at(-1).parts[0].functionResponse).toEqual(
      { name: 'arg_tool', response: { result: 'ツール結果' } })
  })

  it('maxRounds 到達で toolConfig NONE を送り回答を強制する（無限ループ防止）', async () => {
    vertexResponses = [textResponse('強制回答')]
    const result = await runToolLoop(env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS, maxRounds: 0,
      execute: async () => 'unused',
    })
    expect(result.kind).toBe('ok')
    expect(vertexRequests[0]!.toolConfig.functionCallingConfig.mode).toBe('NONE')
  })

  it('並列 functionCall は 1 つの user ターンに同数の functionResponse で返す', async () => {
    vertexResponses = [
      callResponse([{ name: 'arg_tool', args: { q: 'a' } }, { name: 'no_arg_tool', args: {} }]),
      textResponse('回答'),
    ]
    const result = await runToolLoop(env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS,
      execute: async name => `${name} の結果`,
    })
    expect(result.kind).toBe('ok')
    const responses = vertexRequests[1]!.contents.at(-1)
    expect(responses.role).toBe('user')
    expect(responses.parts).toHaveLength(2)
    expect(responses.parts.map((p: any) => p.functionResponse.name)).toEqual(['arg_tool', 'no_arg_tool'])
  })

  it('1 ラウンドの呼び出し上限（5 件）超過分は実行せずエラー応答（1:1 対応は維持）', async () => {
    const calls = Array.from({ length: 7 }, (_, i) => ({ name: 'arg_tool', args: { q: `q${i}` } }))
    vertexResponses = [callResponse(calls), textResponse('回答')]
    let executed = 0
    const result = await runToolLoop(env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS,
      execute: async () => {
        executed++
        return 'ok'
      },
    })
    expect(result.kind).toBe('ok')
    expect(executed).toBe(5)
    const parts = vertexRequests[1]!.contents.at(-1).parts as any[]
    expect(parts).toHaveLength(7)
    expect(parts[6].functionResponse.response.result).toContain('多すぎます')
  })

  it('ツール実行の例外はエラーテキストとしてモデルへ返し、ループは継続する（原則4）', async () => {
    vertexResponses = [callResponse([{ name: 'arg_tool', args: { q: 'x' } }]), textResponse('回答')]
    const result = await runToolLoop(env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS,
      execute: async () => {
        throw new Error('DB 断')
      },
    })
    expect(result.kind).toBe('ok')
    expect(vertexRequests[1]!.contents.at(-1).parts[0].functionResponse.response.result).toContain('エラー')
  })

  it('API エラー（非 2xx）は error・LLM 無効環境は disabled', async () => {
    vertexResponses = [{ status: 500, json: { error: 'boom' } }]
    const errored = await runToolLoop(env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS, execute: async () => 'x',
    })
    expect(errored.kind).toBe('error')
    const disabled = await runToolLoop({ ...env, vertexProjectId: '' } as Env, {
      system: 'sys', messages: USER_MSG, tools: TOOLS, execute: async () => 'x',
    })
    expect(disabled.kind).toBe('disabled')
  })
})
