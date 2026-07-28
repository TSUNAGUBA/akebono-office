/**
 * 業務 × メディア統合インサイト（決定的ヒューリスティック）の回帰テスト。
 * 相関の分類（強い/弱い/逆行）と PDCA・アクションの生成を検証する。
 */
import { describe, expect, it } from 'vitest'
import { heuristicIntegratedInsight, type IntegratedMetrics } from '../../shared/domain/media-integrated'

function mk(over: Partial<IntegratedMetrics> = {}): IntegratedMetrics {
  const trend = over.trend ?? [
    { month: '2026-02', sessions: 1000, conversions: 20, salesAmount: 1_000_000, orders: 10 },
    { month: '2026-03', sessions: 1200, conversions: 26, salesAmount: 1_300_000, orders: 12 },
    { month: '2026-04', sessions: 1500, conversions: 33, salesAmount: 1_600_000, orders: 15 },
    { month: '2026-05', sessions: 1800, conversions: 40, salesAmount: 1_950_000, orders: 18 },
  ]
  const cur = trend[trend.length - 1]!
  const prev = trend[trend.length - 2]!
  return {
    segmentId: 'seg-01', segmentName: '陶磁器委託販売', siteName: 'テストメディア',
    periodMonth: cur.month,
    sessions: cur.sessions, conversions: cur.conversions,
    conversionRate: Math.round(cur.conversions / cur.sessions * 10000) / 10000,
    prevSessions: prev.sessions, prevConversions: prev.conversions,
    salesAmount: cur.salesAmount, orders: cur.orders, prevSalesAmount: prev.salesAmount,
    aov: Math.round(cur.salesAmount / cur.orders),
    salesPerSession: Math.round(cur.salesAmount / cur.sessions),
    funnel: { sessions: cur.sessions, engaged: Math.round(cur.sessions * 0.55), conversions: cur.conversions, orders: cur.orders },
    trend,
    ...over,
  }
}

describe('heuristicIntegratedInsight', () => {
  it('決定的', () => {
    const m = mk()
    expect(heuristicIntegratedInsight(m)).toEqual(heuristicIntegratedInsight(m))
  })

  it('流入と売上が連動して伸びていれば「相関が強い」', () => {
    const r = heuristicIntegratedInsight(mk())
    expect(r.correlation.some(c => c.includes('相関が強い'))).toBe(true)
  })

  it('PDCA の 4 象限がすべて非空', () => {
    const r = heuristicIntegratedInsight(mk())
    expect(r.pdca.plan.length).toBeGreaterThan(0)
    expect(r.pdca.do.length).toBeGreaterThan(0)
    expect(r.pdca.check.length).toBeGreaterThan(0)
    expect(r.pdca.act.length).toBeGreaterThan(0)
  })

  it('CVR が低ければ CVR 改善の高優先度アクションを出す', () => {
    const r = heuristicIntegratedInsight(mk({ conversions: 5, conversionRate: 0.003 }))
    expect(r.actions.some(a => a.title.includes('CVR') && a.priority === 'high')).toBe(true)
  })

  it('データ点が 3 未満なら相関は判定不能の注記を出す', () => {
    const r = heuristicIntegratedInsight(mk({
      trend: [
        { month: '2026-04', sessions: 1000, conversions: 20, salesAmount: 1_000_000, orders: 10 },
        { month: '2026-05', sessions: 1200, conversions: 24, salesAmount: 1_200_000, orders: 12 },
      ],
    }))
    expect(r.correlation.some(c => c.includes('不足'))).toBe(true)
  })

  it('流入増でも売上が伸びなければ転換の課題を指摘する', () => {
    const r = heuristicIntegratedInsight(mk({
      sessions: 2000, prevSessions: 1500, salesAmount: 900_000, prevSalesAmount: 1_000_000,
    }))
    expect(r.correlation.some(c => c.includes('転換'))).toBe(true)
  })

  it('エグゼクティブサマリーにセグメント名を含む', () => {
    expect(heuristicIntegratedInsight(mk()).executiveSummary).toContain('陶磁器委託販売')
  })
})
