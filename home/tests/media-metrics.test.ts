/**
 * メディアメトリクスの決定的導出（shared/domain/media-metrics）の回帰テスト。
 * - 同じ入力 → 常に同じ出力（Math.random 非依存）
 * - 内訳（チャネル/デバイス/日別）の合計がセッション総数と一致する不変条件
 * - 基準日より後に公開された記事は集計対象外
 */
import { describe, expect, it } from 'vitest'
import { deriveMediaMetrics, deriveMonthlyMediaTrend, type MediaArticleInput } from '../../shared/domain/media-metrics'

const articles: MediaArticleInput[] = [
  { id: 'a1', title: '記事1', path: '/blog/1', section: 'ブログ', publishedAt: '2026-01-10', wordCount: 2000, origin: 'seed' },
  { id: 'a2', title: '記事2', path: '/blog/2', section: 'ブログ', publishedAt: '2026-03-01', wordCount: 1500, origin: 'seed' },
  { id: 'a3', title: 'サービス', path: '/service', section: 'サービス', publishedAt: '2026-02-01', wordCount: 1200, origin: 'seed' },
  { id: 'a4', title: '事例', path: '/case/1', section: '導入事例', publishedAt: '2026-05-01', wordCount: 1800, origin: 'seed' },
  { id: 'a5', title: '未来記事', path: '/blog/future', section: 'ブログ', publishedAt: '2026-12-31', wordCount: 900, origin: 'seed' },
]

const opts = { segmentId: 'seg-01', siteName: 'テスト', asOf: '2026-07-27', days: 28 }

describe('deriveMediaMetrics', () => {
  it('決定的（同じ入力なら同じ出力）', () => {
    expect(deriveMediaMetrics(articles, opts)).toEqual(deriveMediaMetrics(articles, opts))
  })

  it('チャネル別セッションの合計が総セッションと一致する', () => {
    const m = deriveMediaMetrics(articles, opts)
    expect(m.channels.reduce((s, c) => s + c.sessions, 0)).toBe(m.sessions)
  })

  it('デバイス別セッションの合計が総セッションと一致する', () => {
    const m = deriveMediaMetrics(articles, opts)
    expect(m.devices.reduce((s, d) => s + d.sessions, 0)).toBe(m.sessions)
  })

  it('日別セッションの合計が総セッションと一致し、日数分の点がある', () => {
    const m = deriveMediaMetrics(articles, opts)
    expect(m.daily).toHaveLength(28)
    expect(m.daily.reduce((s, d) => s + d.sessions, 0)).toBe(m.sessions)
  })

  it('基準日より後に公開された記事は集計対象外（articleCount / topPages に含めない）', () => {
    const m = deriveMediaMetrics(articles, opts)
    expect(m.articleCount).toBe(4) // a5 は 2026-12-31 公開 = 対象外
    expect(m.topPages.some(p => p.id === 'a5')).toBe(false)
  })

  it('topPages は PV 降順', () => {
    const pv = deriveMediaMetrics(articles, opts).topPages.map(p => p.pageviews)
    expect(pv).toEqual([...pv].sort((a, b) => b - a))
  })

  it('セクション別の記事数の合計 = 対象記事数', () => {
    const m = deriveMediaMetrics(articles, opts)
    expect(m.sections.reduce((s, x) => s + x.pages, 0)).toBe(m.articleCount)
  })

  it('CVR = コンバージョン / セッション', () => {
    const m = deriveMediaMetrics(articles, opts)
    const expected = m.sessions > 0 ? Math.round(m.conversions / m.sessions * 10000) / 10000 : 0
    expect(m.conversionRate).toBe(expected)
  })

  it('低トラフィック（単一・低ウェイト記事）でも日別合計 = 総セッションで全て非負（丸め破綻なし）', () => {
    const tiny: MediaArticleInput[] = [
      { id: 't1', title: 'お知らせ', path: '/news/1', section: 'お知らせ', publishedAt: '2024-01-01', wordCount: 200, origin: 'seed' },
    ]
    const m = deriveMediaMetrics(tiny, { segmentId: 'seg-x', siteName: 't', asOf: '2026-07-27', days: 28 })
    expect(m.daily.reduce((s, d) => s + d.sessions, 0)).toBe(m.sessions)
    expect(m.daily.reduce((s, d) => s + d.users, 0)).toBe(m.users)
    expect(m.daily.reduce((s, d) => s + d.conversions, 0)).toBe(m.conversions)
    expect(m.daily.every(d => d.sessions >= 0 && d.users >= 0 && d.conversions >= 0)).toBe(true)
  })

  it('空の記事インベントリでも NaN/クラッシュせず 0 集計を返す', () => {
    const m = deriveMediaMetrics([], opts)
    expect(m.sessions).toBe(0)
    expect(m.articleCount).toBe(0)
    expect(m.channels.reduce((s, c) => s + c.sessions, 0)).toBe(0)
    expect(m.daily).toHaveLength(28)
    expect(Number.isNaN(m.conversionRate)).toBe(false)
  })
})

describe('deriveMonthlyMediaTrend', () => {
  it('月数分の点を返す', () => {
    const trend = deriveMonthlyMediaTrend(articles, ['2026-01', '2026-02', '2026-03'], 'seg-01')
    expect(trend.map(t => t.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('最初の記事公開より前の月はセッション 0（公開前は流入なし）', () => {
    const trend = deriveMonthlyMediaTrend(articles, ['2025-12'], 'seg-01')
    expect(trend[0]!.sessions).toBe(0)
    expect(trend[0]!.conversions).toBe(0)
  })

  it('決定的', () => {
    const months = ['2026-04', '2026-05']
    expect(deriveMonthlyMediaTrend(articles, months, 'seg-01'))
      .toEqual(deriveMonthlyMediaTrend(articles, months, 'seg-01'))
  })
})
