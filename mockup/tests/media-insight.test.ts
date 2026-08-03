/**
 * メディア AI インサイト（決定的ヒューリスティック）の回帰テスト。
 * しきい値（セクション集中 55%・CVR 1%）と構造（サイト構成/記事/アクションが非空）を検証する。
 */
import { describe, expect, it } from 'vitest'
import { applyExternalMaterial, externalMaterialOf, heuristicMediaInsight } from '../../shared/domain/media-insight'
import type { MediaMetrics } from '../../shared/domain/media-metrics'

function mk(over: Partial<MediaMetrics> = {}): MediaMetrics {
  return {
    segmentId: 'seg-01', siteName: 'テストメディア',
    periodFrom: '2026-07-01', periodTo: '2026-07-28', days: 28,
    sessions: 1000, users: 800, newUsers: 400, pageviews: 1000,
    avgEngagementSec: 80, engagementRate: 0.5, bounceRate: 0.5,
    conversions: 30, conversionRate: 0.03,
    prevSessions: 900, prevUsers: 720, prevPageviews: 950, prevConversions: 27,
    channels: [
      { channel: 'オーガニック検索', sessions: 500, conversions: 15 },
      { channel: '直接', sessions: 300, conversions: 10 },
      { channel: '有料広告', sessions: 200, conversions: 5 },
    ],
    devices: [{ device: 'モバイル', sessions: 600 }, { device: 'デスクトップ', sessions: 400 }],
    daily: [],
    topPages: [
      { id: 'p1', title: '主力記事', path: '/blog/1', section: 'ブログ', pageviews: 500, users: 400, avgEngagementSec: 120, bounceRate: 0.4, convRate: 0.02, conversions: 8, prevPageviews: 400 },
      { id: 'p2', title: 'サービス', path: '/service', section: 'サービス', pageviews: 200, users: 160, avgEngagementSec: 90, bounceRate: 0.35, convRate: 0.06, conversions: 10, prevPageviews: 210 },
    ],
    sections: [
      { section: 'ブログ', pages: 5, pageviews: 800, avgEngagementSec: 100, convRate: 0.02 },
      { section: 'サービス', pages: 2, pageviews: 200, avgEngagementSec: 90, convRate: 0.06 },
    ],
    articleCount: 7,
    ...over,
  }
}

describe('heuristicMediaInsight', () => {
  it('決定的（同じ metrics なら同じ insight）', () => {
    const m = mk()
    expect(heuristicMediaInsight(m)).toEqual(heuristicMediaInsight(m))
  })

  it('サイト構成・記事・アクションが非空で返る', () => {
    const r = heuristicMediaInsight(mk())
    expect(r.siteStructure.length).toBeGreaterThan(0)
    expect(r.articles.length).toBeGreaterThan(0)
    expect(r.actions.length).toBeGreaterThan(0)
    expect(r.executiveSummary).toContain('テストメディア')
  })

  it('PV が単一セクションに集中（>=55%）なら構成の課題（issue）を出す', () => {
    // ブログ 800 / 総 1000 = 80%
    const r = heuristicMediaInsight(mk())
    expect(r.siteStructure.some(f => f.kind === 'issue' && f.title.includes('集中'))).toBe(true)
  })

  it('分散していれば構成は好調（win）', () => {
    const m = mk({
      pageviews: 1000,
      sections: [
        { section: 'ブログ', pages: 4, pageviews: 450, avgEngagementSec: 100, convRate: 0.02 },
        { section: 'サービス', pages: 3, pageviews: 350, avgEngagementSec: 90, convRate: 0.05 },
        { section: '導入事例', pages: 2, pageviews: 200, avgEngagementSec: 110, convRate: 0.06 },
      ],
    })
    const r = heuristicMediaInsight(m)
    expect(r.siteStructure.some(f => f.kind === 'win')).toBe(true)
  })

  it('全体 CVR が 1% 未満なら CVR 改善アクションを出す', () => {
    const r = heuristicMediaInsight(mk({ conversions: 5, conversionRate: 0.005 }))
    expect(r.actions.some(a => a.title.includes('CVR'))).toBe(true)
  })

  it('セッションが前期比 -10% 以下なら流入減の高優先度アクションを出す', () => {
    const r = heuristicMediaInsight(mk({ sessions: 700, prevSessions: 1000 }))
    expect(r.actions.some(a => a.priority === 'high' && a.title.includes('流入'))).toBe(true)
  })

  it('アクションは優先度順（high → mid → low）', () => {
    const r = heuristicMediaInsight(mk({ conversions: 5, conversionRate: 0.005, sessions: 700, prevSessions: 1000 }))
    const rank = { high: 0, mid: 1, low: 2 }
    const seq = r.actions.map(a => rank[a.priority])
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
  })
})

describe('外部投稿記事のインサイト材料反映（両モード共有 = useMediaInsight モック経路と同一。オペレーター指示 2026-08-03）', () => {
  it('externalMaterialOf: 原文を 400 字で抜粋・入力を先頭 20 件で cap', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ title: `t${i}`, source: '', body: 'x'.repeat(500) }))
    const mats = externalMaterialOf(rows)
    expect(mats.length).toBe(20) // 先頭 20 件で cap
    expect(mats[0]!.bodyExcerpt.length).toBe(400) // 原文は 400 字抜粋
  })

  it('externalMaterialOf: 空タイトルは除外する', () => {
    const mats = externalMaterialOf([
      { title: 'A', source: 'note', body: 'y' },
      { title: '  ', source: 'X', body: 'y' }, // 空白のみ = 除外
    ])
    expect(mats.length).toBe(1)
    expect(mats.every(m => m.title.length > 0)).toBe(true)
  })

  it('applyExternalMaterial: 材料ありは articles 先頭に opportunity を追加（最大 7 件）・0 件は素通し', () => {
    const base = heuristicMediaInsight(mk())
    expect(applyExternalMaterial(base, [])).toBe(base) // 0 件は同一参照で素通し
    const out = applyExternalMaterial(base, externalMaterialOf([
      { title: '外部寄稿1', source: 'note', body: '本文' },
      { title: '外部寄稿2', source: 'PR TIMES', body: '本文' },
    ]))
    expect(out.articles[0]!.kind).toBe('opportunity')
    expect(out.articles[0]!.title).toContain('外部投稿 2 件')
    expect(out.articles.length).toBeLessThanOrEqual(7)
  })
})
