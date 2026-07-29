/**
 * GA4 レスポンス → MediaMetrics 整形（lib/ga.ts）の単体テスト。
 * 空 rows・NaN・ゼロ除算・チャネル日本語マッピング・yearMonth/date の形式変換・
 * 前期比の pagePath 突合・セクション解決（インベントリ優先 → 第 1 階層）を網羅する。
 */
import { describe, expect, it } from 'vitest'
import {
  buildMediaMetrics, buildMonthlyTrend, channelLabelJa, deviceLabelJa, gaDateKey, gaMonthKey,
  gaNum, gaRows, inventorySectionMap, monthEndOf, recentMonthKeys, sectionOfPath, type GaReport,
} from '../../src/lib/ga'

const report = (dims: string[], mets: string[], rows: (string | number)[][][]): GaReport => ({
  dimensionHeaders: dims.map(name => ({ name })),
  metricHeaders: mets.map(name => ({ name })),
  rows: rows.map(([dimVals, metVals]) => ({
    dimensionValues: (dimVals as (string | number)[]).map(v => ({ value: String(v) })),
    metricValues: (metVals as (string | number)[]).map(v => ({ value: String(v) })),
  })),
})

const TOTAL_METS = ['sessions', 'totalUsers', 'newUsers', 'screenPageViews',
  'userEngagementDuration', 'engagementRate', 'bounceRate', 'keyEvents']

const opts = {
  segmentId: 'seg-01',
  siteName: 'テスト',
  periodFrom: '2026-07-01',
  periodTo: '2026-07-28',
  days: 28,
  articles: [
    { path: '/blog/hello', section: 'ブログ' },
    { path: '/service/', section: 'サービス' },
  ],
}

describe('形式変換・数値防御', () => {
  it('date（YYYYMMDD）→ YYYY-MM-DD / yearMonth（YYYYMM）→ YYYY-MM', () => {
    expect(gaDateKey('20260728')).toBe('2026-07-28')
    expect(gaMonthKey('202607')).toBe('2026-07')
  })

  it('形式外の日付キーはそのまま返す（情報を落とさない）', () => {
    expect(gaDateKey('(other)')).toBe('(other)')
    expect(gaMonthKey('')).toBe('')
  })

  it('非数値・欠落は 0 に倒す（NaN を伝播させない）', () => {
    expect(gaNum('12.5')).toBe(12.5)
    expect(gaNum('abc')).toBe(0)
    expect(gaNum(undefined)).toBe(0)
  })

  it('rows 欠落のレポートは空配列（?? [] 防御）', () => {
    expect(gaRows({ dimensionHeaders: [], metricHeaders: [] })).toEqual([])
    expect(gaRows(null)).toEqual([])
  })
})

describe('チャネル・デバイスの日本語マッピング', () => {
  it('既知チャネルは日本語ラベルへ（有料系は「有料広告」へ集約）', () => {
    expect(channelLabelJa('Organic Search')).toBe('オーガニック検索')
    expect(channelLabelJa('Direct')).toBe('直接')
    expect(channelLabelJa('Organic Social')).toBe('ソーシャル')
    expect(channelLabelJa('Referral')).toBe('リファラル')
    expect(channelLabelJa('Email')).toBe('メール')
    expect(channelLabelJa('Paid Search')).toBe('有料広告')
    expect(channelLabelJa('Paid Social')).toBe('有料広告')
    expect(channelLabelJa('Display')).toBe('有料広告')
  })

  it('未知チャネルはそのまま表示する', () => {
    expect(channelLabelJa('Affiliates')).toBe('Affiliates')
  })

  it('デバイスは大文字小文字を無視してマッピング', () => {
    expect(deviceLabelJa('mobile')).toBe('モバイル')
    expect(deviceLabelJa('Desktop')).toBe('デスクトップ')
    expect(deviceLabelJa('tablet')).toBe('タブレット')
    expect(deviceLabelJa('smart tv')).toBe('smart tv')
  })
})

describe('セクション解決', () => {
  const map = inventorySectionMap(opts.articles)

  it('インベントリの path 一致を優先（末尾スラッシュを同一視）', () => {
    expect(sectionOfPath('/blog/hello', map)).toBe('ブログ')
    expect(sectionOfPath('/service', map)).toBe('サービス')
    expect(sectionOfPath('/service/', map)).toBe('サービス')
  })

  it('インベントリに無い path は第 1 階層。ルートはトップ', () => {
    expect(sectionOfPath('/news/2026', map)).toBe('news')
    expect(sectionOfPath('/', map)).toBe('トップ')
    expect(sectionOfPath('', map)).toBe('トップ')
  })
})

describe('buildMediaMetrics', () => {
  it('総計 + 内訳を MediaMetrics へ整形する（avgEngagementSec = 滞在合計 ÷ PV）', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [1000, 800, 300, 2500, 125000, '0.62', '0.38', 40]]]),
      prevTotals: report([], ['sessions', 'totalUsers', 'screenPageViews', 'keyEvents'], [[[], [900, 700, 2200, 30]]]),
      daily: report(['date'], ['sessions', 'totalUsers', 'keyEvents'], [
        [['20260701'], [100, 80, 4]],
        [['20260702'], [120, 90, 5]],
      ]),
      channels: report(['sessionDefaultChannelGroup'], ['sessions', 'keyEvents'], [
        [['Organic Search'], [500, 20]],
        [['Paid Search'], [100, 8]],
        [['Paid Social'], [50, 2]],
        [['Unassigned'], [10, 0]],
      ]),
      devices: report(['deviceCategory'], ['sessions'], [
        [['mobile'], [600]], [['desktop'], [350]], [['tablet'], [50]],
      ]),
      topPages: report(['pagePath', 'pageTitle'],
        ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'], [
          [['/blog/hello', 'こんにちは'], [800, 600, 48000, '0.42', 12]],
          [['/service/', 'サービス'], [400, 350, 20000, '0.3', 20]],
          [['/news/x', ''], [100, 90, 3000, '0.5', 0]],
        ]),
      prevPages: report(['pagePath'], ['screenPageViews'], [
        [['/blog/hello'], [700]],
        [['/service'], [380]],
      ]),
    }, opts)

    expect(m.sessions).toBe(1000)
    expect(m.users).toBe(800)
    expect(m.pageviews).toBe(2500)
    expect(m.avgEngagementSec).toBe(Math.round(125000 / 2500))
    expect(m.engagementRate).toBe(0.62)
    expect(m.bounceRate).toBe(0.38)
    expect(m.conversions).toBe(40)
    expect(m.conversionRate).toBe(0.04)
    expect(m.prevSessions).toBe(900)
    expect(m.prevConversions).toBe(30)
    expect(m.articleCount).toBe(2)
  })

  it('日別は期間の全日を 0 埋めして days 分の点を返す', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [10, 8, 3, 25, 500, '0.6', '0.4', 1]]]),
      prevTotals: null,
      daily: report(['date'], ['sessions', 'totalUsers', 'keyEvents'], [[['20260715'], [10, 8, 1]]]),
      channels: null,
      devices: null,
      topPages: null,
      prevPages: null,
    }, opts)
    expect(m.daily).toHaveLength(28)
    expect(m.daily[0]).toEqual({ date: '2026-07-01', sessions: 0, users: 0, conversions: 0 })
    expect(m.daily.find(d => d.date === '2026-07-15')).toEqual({ date: '2026-07-15', sessions: 10, users: 8, conversions: 1 })
  })

  it('有料系チャネルは「有料広告」へ合算され、未知チャネルは後置される', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [660, 500, 100, 1000, 10000, '0.6', '0.4', 30]]]),
      prevTotals: null,
      daily: null,
      channels: report(['sessionDefaultChannelGroup'], ['sessions', 'keyEvents'], [
        [['Organic Search'], [500, 20]],
        [['Paid Search'], [100, 8]],
        [['Paid Social'], [50, 2]],
        [['Unassigned'], [10, 0]],
      ]),
      devices: null,
      topPages: null,
      prevPages: null,
    }, opts)
    const paid = m.channels.find(ch => ch.channel === '有料広告')
    expect(paid).toEqual({ channel: '有料広告', sessions: 150, conversions: 10 })
    // 既知ラベル（固定順）→ 未知ラベルの順
    expect(m.channels[m.channels.length - 1]!.channel).toBe('Unassigned')
    expect(m.channels[0]!.channel).toBe('オーガニック検索')
  })

  it('前期比は pagePath で突合する（末尾スラッシュの揺れは正規化 path へ集約されて一致）', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [100, 80, 10, 300, 6000, '0.6', '0.4', 5]]]),
      prevTotals: null,
      daily: null,
      channels: null,
      devices: null,
      topPages: report(['pagePath', 'pageTitle'],
        ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'], [
          [['/service/', 'サービス'], [200, 150, 8000, '0.3', 6]],
          [['/blog/new', '新記事'], [100, 90, 2000, '0.5', 1]],
        ]),
      prevPages: report(['pagePath'], ['screenPageViews'], [[['/service'], [180]]]),
    }, opts)
    expect(m.topPages.find(p => p.path === '/service')?.prevPageviews).toBe(180)
    expect(m.topPages.find(p => p.path === '/blog/new')?.prevPageviews).toBe(0)
  })

  it('同一 path・異なる pageTitle の複数行は 1 エントリへ集約する（GA は全ディメンションでグループ化して返す）', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [500, 400, 50, 900, 27000, '0.6', '0.4', 21]]]),
      prevTotals: null,
      daily: null,
      channels: null,
      devices: null,
      topPages: report(['pagePath', 'pageTitle'],
        ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'], [
          // タイトル改題で同一 URL が 2 行 + 末尾スラッシュ揺れで 1 行（= 3 行が 1 エントリに集約されるべき）
          [['/blog/hello', '旧タイトル'], [300, 200, 9000, '0.4', 6]],
          [['/blog/hello', '新タイトル（改題後）'], [500, 250, 20000, '0.3', 12]],
          [['/blog/hello/', '旧タイトル'], [100, 50, 3000, '0.5', 3]],
          [['/news/x', 'お知らせ'], [100, 90, 2000, '0.5', 0]],
        ]),
      prevPages: report(['pagePath'], ['screenPageViews'], [[['/blog/hello'], [700]]]),
    }, opts)
    // 集約後は path 一意（重複エントリなし）
    expect(m.topPages.map(p => p.path)).toEqual(['/blog/hello', '/news/x'])
    const hello = m.topPages.find(p => p.path === '/blog/hello')!
    expect(hello.pageviews).toBe(900) // 300 + 500 + 100
    expect(hello.conversions).toBe(21)
    expect(hello.title).toBe('新タイトル（改題後）') // 代表タイトル = PV 最大の行
    expect(hello.avgEngagementSec).toBe(Math.round((9000 + 20000 + 3000) / 900))
    expect(hello.bounceRate).toBe(Math.round((0.4 * 300 + 0.3 * 500 + 0.5 * 100) / 900 * 1000) / 1000)
    // prevPageviews は集約後の path に 1 回だけ割当（各重複行への全額割当 = 二重計上をしない）
    expect(hello.prevPageviews).toBe(700)
    expect(m.topPages.reduce((s, p) => s + p.prevPageviews, 0)).toBe(700)
    // セクションの記事数も水増しされない（ブログ = 1 ページ）
    expect(m.sections.find(s => s.section === 'ブログ')?.pages).toBe(1)
  })

  it('ページの CVR はユーザー 0 のとき 0（ゼロ除算しない）。タイトル欠落は path で補う', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [10, 0, 0, 10, 0, '0', '0', 0]]]),
      prevTotals: null,
      daily: null,
      channels: null,
      devices: null,
      topPages: report(['pagePath', 'pageTitle'],
        ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'], [
          [['/x', ''], [10, 0, 0, '0', 0]],
        ]),
      prevPages: null,
    }, opts)
    expect(m.topPages[0]!.convRate).toBe(0)
    expect(m.topPages[0]!.title).toBe('/x')
    expect(Number.isNaN(m.conversionRate)).toBe(false)
  })

  it('全レポート欠落（rows なし）でも NaN なしのゼロ集計を返す', () => {
    const m = buildMediaMetrics({
      totals: null, prevTotals: null, daily: null, channels: null, devices: null, topPages: null, prevPages: null,
    }, opts)
    expect(m.sessions).toBe(0)
    expect(m.conversionRate).toBe(0)
    expect(m.avgEngagementSec).toBe(0)
    expect(m.daily).toHaveLength(28)
    expect(m.topPages).toEqual([])
    expect(m.sections).toEqual([])
    expect(Object.values(m).some(v => typeof v === 'number' && Number.isNaN(v))).toBe(false)
  })

  it('セクションはインベントリ優先 + PV 降順で集約される', () => {
    const m = buildMediaMetrics({
      totals: report([], TOTAL_METS, [[[], [300, 240, 30, 700, 14000, '0.6', '0.4', 26]]]),
      prevTotals: null,
      daily: null,
      channels: null,
      devices: null,
      topPages: report(['pagePath', 'pageTitle'],
        ['screenPageViews', 'totalUsers', 'userEngagementDuration', 'bounceRate', 'keyEvents'], [
          [['/blog/hello', 'A'], [400, 300, 16000, '0.4', 6]],
          [['/service/', 'B'], [200, 150, 8000, '0.3', 20]],
          [['/news/x', 'C'], [100, 90, 2000, 30, '0.5', 0]],
        ]),
      prevPages: null,
    }, opts)
    expect(m.sections.map(s => s.section)).toEqual(['ブログ', 'サービス', 'news'])
    const svc = m.sections.find(s => s.section === 'サービス')!
    expect(svc.convRate).toBe(Math.round(20 / 150 * 10000) / 10000)
  })
})

describe('buildMonthlyTrend / 月キー', () => {
  it('yearMonth を月キーへ変換し、GA に無い月は 0 埋めする（engagedSessions 実測込み）', () => {
    const trend = buildMonthlyTrend(
      report(['yearMonth'], ['sessions', 'totalUsers', 'keyEvents', 'engagedSessions'], [
        [['202605'], [100, 80, 4, 55]],
        [['202607'], [140, 100, 6, 80]],
      ]),
      ['2026-05', '2026-06', '2026-07'])
    expect(trend).toEqual([
      { month: '2026-05', sessions: 100, users: 80, conversions: 4, engagedSessions: 55 },
      { month: '2026-06', sessions: 0, users: 0, conversions: 0, engagedSessions: 0 },
      { month: '2026-07', sessions: 140, users: 100, conversions: 6, engagedSessions: 80 },
    ])
  })

  it('recentMonthKeys は endBack=1 で直前の完了月まで（年跨ぎも正しい）', () => {
    expect(recentMonthKeys(3, 1, '2026-07-28')).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(recentMonthKeys(3, 1, '2026-01-15')).toEqual(['2025-10', '2025-11', '2025-12'])
  })

  it('monthEndOf は月末日（うるう年も正しい）', () => {
    expect(monthEndOf('2026-07')).toBe('2026-07-31')
    expect(monthEndOf('2026-02')).toBe('2026-02-28')
    expect(monthEndOf('2028-02')).toBe('2028-02-29')
    expect(monthEndOf('2026-04')).toBe('2026-04-30')
  })
})
