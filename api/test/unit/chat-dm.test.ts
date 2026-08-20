/**
 * 外部チャット DM プリミティブ + 配信エンジンの制御フロー（AKEBONO Home 名義化 2026-08-20。レビュー R1 m-4）。
 * 実 HTTP は行わず fetch をスタブして決定的にテストする（「外部 HTTP はテストしない」方針の対象は
 * 実ネットワークであり、エラー分類・自己修復分岐はスタブで検証可能なロジックとして扱う）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import {
  googleChatFindOrCreateDm, slackLookupUserByEmail, slackPostDm, slackResolveDm,
} from '../../src/lib/chat-dm'
import { deliverToService, type FailureDetailSink } from '../../src/lib/notify'

interface StubResponse { status?: number; json?: unknown; text?: string }
interface RecordedCall { url: string; init: RequestInit }

/** fetch を応答列でスタブし、呼び出し記録を返す（応答列を使い切ったら最後の応答を繰り返す） */
function stubFetch(...responses: StubResponse[]): RecordedCall[] {
  const calls: RecordedCall[] = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[Math.min(i++, responses.length - 1)] ?? {}
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (r.json === undefined) throw new Error('not json')
        return r.json
      },
      text: async () => r.text ?? JSON.stringify(r.json ?? ''),
    } as Response
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Slack プリミティブ（エラー分類 = StepResult 写像）', () => {
  it('リクエストは form エンコード（JSON ボディは読取系メソッドが受理しないため。監査 R1 MAJOR-1）', async () => {
    const calls = stubFetch({ json: { ok: true } })
    await slackPostDm('xoxb-test', 'D1', 'hello')
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(String(calls[0]!.init.body)).toBe('channel=D1&text=hello')
  })

  it('HTTP 429 / 5xx / ratelimited は retry・HTTP 401 と invalid_auth は auth（詳細つき）', async () => {
    stubFetch({ status: 429 })
    expect((await slackPostDm('t', 'D1', 'x')).kind).toBe('retry')
    stubFetch({ status: 503 })
    expect((await slackPostDm('t', 'D1', 'x')).kind).toBe('retry')
    stubFetch({ json: { ok: false, error: 'ratelimited' } })
    expect((await slackPostDm('t', 'D1', 'x')).kind).toBe('retry')
    stubFetch({ status: 401 })
    expect(await slackPostDm('t', 'D1', 'x')).toEqual({ kind: 'auth', detail: 'chat.postMessage: HTTP 401' })
    stubFetch({ json: { ok: false, error: 'invalid_auth' } })
    expect(await slackPostDm('t', 'D1', 'x')).toEqual({ kind: 'auth', detail: 'chat.postMessage: invalid_auth' })
  })

  it('恒久エラー（channel_not_found 等）は fail + 診断詳細・非 JSON 応答も fail（リトライで真因をぼかさない）', async () => {
    stubFetch({ json: { ok: false, error: 'channel_not_found' } })
    expect(await slackPostDm('t', 'D1', 'x')).toEqual({ kind: 'fail', detail: 'chat.postMessage: channel_not_found' })
    stubFetch({ status: 403, text: '<html>proxy error</html>' })
    const r = await slackPostDm('t', 'D1', 'x')
    expect(r.kind).toBe('fail')
    expect((r as { detail: string }).detail).toContain('JSON ではありません')
  })

  it('users.lookupByEmail: users_not_found はメール不一致の案内へ・成功は表示名つきで解決する', async () => {
    stubFetch({ json: { ok: false, error: 'users_not_found' } })
    const notFound = await slackLookupUserByEmail('t', 'a@example.com')
    expect(notFound.kind).toBe('fail')
    expect((notFound as { detail: string }).detail).toContain('a@example.com のユーザーが見つかりません')
    stubFetch({ json: { ok: true, user: { id: 'U9', name: 'taro', profile: { real_name: '曙 太郎' } } } })
    expect(await slackLookupUserByEmail('t', 'a@example.com'))
      .toEqual({ kind: 'ok', value: { userId: 'U9', displayName: '曙 太郎' } })
  })

  it('slackResolveDm: userId 指定時は lookupByEmail を省略して conversations.open だけを呼ぶ', async () => {
    const calls = stubFetch({ json: { ok: true, channel: { id: 'D5' } } })
    const r = await slackResolveDm('t', { email: 'a@b', userId: 'U1' })
    expect(r).toEqual({ kind: 'ok', value: { userId: 'U1', dmChannel: 'D5', displayName: '' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('conversations.open')
  })
})

describe('Google Chat の DM スペース解決（find → 404 で setup → 409 は再検索）', () => {
  it('既存 DM があれば findDirectMessage だけで解決する', async () => {
    const calls = stubFetch({ json: { name: 'spaces/AAA' } })
    expect(await googleChatFindOrCreateDm('tok', 'users/a@b')).toEqual({ kind: 'ok', value: 'spaces/AAA' })
    expect(calls).toHaveLength(1)
  })

  it('find 404 → setup で作成する', async () => {
    const calls = stubFetch(
      { status: 404, json: { error: { code: 404 } } },
      { json: { name: 'spaces/NEW' } },
    )
    expect(await googleChatFindOrCreateDm('tok', 'users/a@b')).toEqual({ kind: 'ok', value: 'spaces/NEW' })
    expect(calls[1]!.url).toContain('spaces:setup')
  })

  it('find 404 → setup 409（並行作成）→ 再検索で回収する（冪等）', async () => {
    stubFetch(
      { status: 404, json: { error: { code: 404 } } },
      { status: 409, json: { error: { code: 409, status: 'ALREADY_EXISTS' } } },
      { json: { name: 'spaces/EXISTING' } },
    )
    expect(await googleChatFindOrCreateDm('tok', 'users/a@b')).toEqual({ kind: 'ok', value: 'spaces/EXISTING' })
  })

  it('find 403（API 未有効化・アプリ未構成）は診断詳細つきの fail（setup へ進まない）', async () => {
    const calls = stubFetch({ status: 403, json: { error: { status: 'PERMISSION_DENIED' } } })
    const r = await googleChatFindOrCreateDm('tok', 'users/a@b')
    expect(r.kind).toBe('fail')
    expect((r as { detail: string }).detail).toContain('spaces.findDirectMessage: HTTP 403')
    expect(calls).toHaveLength(1)
  })
})

describe('配信エンジンの自己修復（deliverToService 経由）', () => {
  const env = { slackBotToken: 'xoxb-test', corsOrigins: [] } as unknown as Env

  function stubPool(row: Record<string, unknown> | null) {
    const queries: { text: string; params: unknown[] }[] = []
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] })
        if (text.trimStart().startsWith('SELECT')) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
        return { rows: [], rowCount: 1 }
      },
    }
    return { pool: pool as never, queries }
  }

  const slackRow = {
    service: 'slack', externalUserId: 'U1', dmTarget: 'D_OLD', status: 'connected', email: 'a@example.com',
  }

  it('宛先の陳腐化（channel_not_found）は一度だけ再解決して再送し、解決結果を保存する', async () => {
    const { pool, queries } = stubPool(slackRow)
    const calls = stubFetch(
      { json: { ok: false, error: 'channel_not_found' } }, // ① D_OLD へ送信 → 陳腐化
      { json: { ok: true, channel: { id: 'D_NEW' } } },    // ② conversations.open（userId ありで lookup 省略）
      { json: { ok: true } },                              // ③ D_NEW へ再送 → 成功
    )
    const sink: FailureDetailSink = {}
    expect(await deliverToService(pool, env, 'm-1', 'slack', 'hello', sink)).toBe('ok')
    expect(calls).toHaveLength(3)
    expect(calls[1]!.url).toContain('conversations.open')
    expect(String(calls[2]!.init.body)).toContain('channel=D_NEW')
    // 解決した宛先が UPDATE で保存される（自己修復の永続化）
    const update = queries.find(q => q.text.includes('UPDATE user_chat_links') && q.text.includes('dm_target'))
    expect(update?.params).toContain('D_NEW')
    expect(sink.detail).toBeUndefined() // 最終成功なので診断詳細は残らない
  })

  it('恒久失敗は診断詳細を sink へ残す（テスト送信の AKO-NCH-004 併記の経路）', async () => {
    const { pool } = stubPool(slackRow)
    stubFetch({ json: { ok: false, error: 'missing_scope' } })
    const sink: FailureDetailSink = {}
    expect(await deliverToService(pool, env, 'm-1', 'slack', 'hello', sink)).toBe('fail')
    expect(sink.detail).toBe('chat.postMessage: missing_scope')
  })

  it('行なしは not_connected（外部 HTTP を呼ばない）', async () => {
    const { pool } = stubPool(null)
    const calls = stubFetch({ json: { ok: true } })
    expect(await deliverToService(pool, env, 'm-1', 'slack', 'hello')).toBe('not_connected')
    expect(calls).toHaveLength(0)
  })
})
