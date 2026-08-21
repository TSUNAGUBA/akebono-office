/**
 * fetchMediaMetrics の GA 障害時挙動の回帰テスト（fetch をモック・PR #81 Codex P1/P2）。
 * - P2: クォータ枯渇（429）でバッチが失敗した場合、per-report ファンアウトを**しない**
 *   （枯渇したプロパティへ 5 本の追い打ちをかけない）
 * - P1: ファンアウトで一部レポートのみ失敗した場合、unavailable マーカーがレスポンスへ貫通する
 *   （フロントが該当ビジュアライゼーションをゼロデータとして描画しないための契約）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { fetchMediaMetrics } from '../../src/routes/media'
import { encryptSecret } from '../../src/lib/crypto'
import type { Env } from '../../src/env'

const env: Env = {
  databaseUrl: 'postgresql://unused',
  dbSsl: 'disable',
  dbSslCa: '',
  port: 0,
  authMode: 'dev',
  firebaseProjectId: '',
  corsOrigins: [],
  migrateOnStart: false,
  vertexProjectId: '',
  vertexLocation: 'global',
  vertexModel: 'gemini-2.5-flash',
  vertexEmbeddingModel: 'text-multilingual-embedding-002',
  googleOauthClientId: 'client-id',
  googleOauthClientSecret: 'client-secret',
  tokenEncryptionKey: 'test-key',
  storageBucket: '',
}

/** DB を使わない疑似プール（トークン行あり・キャッシュミス・インベントリ/設定なし） */
function fakePool(): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM media_ga_tokens')) {
        return {
          rows: [{
            propertyId: 'properties/1',
            propertyName: 'テスト GA4',
            accessTokenEnc: encryptSecret('token', env.tokenEncryptionKey),
            refreshTokenEnc: null,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }],
          rowCount: 1,
        }
      }
      // media_metrics_cache（ミス）・media_articles・media_settings・putCache の INSERT
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
}

const TOTAL_HEADERS = ['sessions', 'totalUsers', 'newUsers', 'screenPageViews',
  'userEngagementDuration', 'engagementRate', 'bounceRate', 'keyEvents']

const totalsReport = {
  metricHeaders: TOTAL_HEADERS.map(name => ({ name })),
  rows: [{ metricValues: ['100', '80', '20', '300', '6000', '0.6', '0.4', '5'].map(value => ({ value })) }],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchMediaMetrics の GA 障害時挙動（P1/P2）', () => {
  it('P2: 内訳バッチが 429（クォータ）で失敗したら per-report リトライをせず、クォータの旨を warning に出す', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? '{}')) as { requests?: { dimensions?: unknown }[] }
      const isTotals = String(url).includes(':batchRunReports') && !req.requests?.[0]?.dimensions
      if (isTotals) return json({ reports: [totalsReport, totalsReport] })
      // 内訳バッチ = クォータ枯渇
      return json({ error: { code: 429, message: 'Exhausted property tokens. Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } }, 429)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMediaMetrics(fakePool(), env, 'seg-x', 28, false)
    // 総計は生きている・内訳は全滅マーカー
    expect(result.metrics.sessions).toBe(100)
    expect(result.unavailable).toEqual(['daily', 'channels', 'devices', 'topPages', 'prevPages'])
    expect(result.warning).toContain('総計のみ表示')
    expect(result.warning).toContain('クォータ上限')
    expect(result.warning).toContain('GA 応答:')
    // fetch は 総計バッチ + 内訳バッチ + 前年同期 runReport（改善要望 2026-08-21）の 3 回のみ
    // （枯渇プロパティへの 5 本ファンアウトをしない。前年同期の失敗は yoyWeek 未設定に倒れるだけ = 原則4）
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.metrics.yoyWeek).toBeUndefined()
  })

  it('P1: バッチ失敗 → per-report リトライで一部のみ失敗した場合、失敗キーだけが unavailable としてレスポンスへ貫通する', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        requests?: { dimensions?: { name: string }[] }[]
        dimensions?: { name: string }[]
      }
      if (u.includes(':batchRunReports')) {
        if (!body.requests?.[0]?.dimensions) return json({ reports: [totalsReport, totalsReport] })
        // 内訳バッチは一時障害（500）→ 呼び出し側が per-report で切り分ける
        return json({ error: { code: 500, message: 'Internal error encountered.' } }, 500)
      }
      // 個別 runReport: 日別だけ失敗・他は成功（チャネルは 1 行返して「取れた内訳が描画される」ことを確認）
      const dim = body.dimensions?.[0]?.name
      if (dim === 'date') return json({ error: { code: 500, message: 'daily boom' } }, 500)
      if (dim === 'sessionDefaultChannelGroup') {
        return json({
          dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
          metricHeaders: [{ name: 'sessions' }, { name: 'keyEvents' }],
          rows: [{ dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '42' }, { value: '2' }] }],
        })
      }
      return json({ rows: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchMediaMetrics(fakePool(), env, 'seg-x', 28, false)
    // 失敗した内訳だけがマーカー化され、取れた内訳は整形される
    expect(result.unavailable).toEqual(['daily'])
    expect(result.warning).toContain('一部の内訳（日別）')
    expect(result.warning).toContain('GA 応答:')
    expect(result.metrics.channels).toEqual([{ channel: '直接', sessions: 42, conversions: 2 }])
    // 総計バッチ + 内訳バッチ + 前年同期 runReport + 個別リトライ 5 本 = 8 回（切り分け可能な失敗ではファンアウトする）
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })
})
