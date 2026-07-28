/**
 * セグメント別/会社全体ダッシュボードの決定的ヒューリスティック（AI レポート・インサイト）の回帰テスト。
 * 業務 × メディアの現状から、好調/課題/機会の分類・次アクション・集中リスクの検出を検証する。
 */
import { describe, expect, it } from 'vitest'
import {
  heuristicCompanyInsight, heuristicSegmentInsight,
  type CompanySummary, type SegmentSnapshot, type SegmentSummary,
} from '../../shared/domain/portfolio-insight'

function snap(over: Partial<SegmentSnapshot> = {}): SegmentSnapshot {
  return {
    segmentId: 'seg-01', segmentName: '陶磁器委託販売', industryLabel: '小売業',
    mediaConnected: true,
    salesAmount: 1_600_000, prevSalesAmount: 1_300_000, orders: 15, aov: 106_667,
    sessions: 1800, prevSessions: 1500, conversions: 40, conversionRate: 0.022, articleCount: 12,
    ...over,
  }
}

function segSummary(over: Partial<SegmentSnapshot> = {}): SegmentSummary {
  const s = snap(over)
  return {
    periodMonth: '2026-06',
    snapshot: s,
    trend: [
      { month: '2026-05', salesAmount: s.prevSalesAmount, orders: 12, sessions: s.prevSessions, conversions: 33 },
      { month: '2026-06', salesAmount: s.salesAmount, orders: s.orders, sessions: s.sessions, conversions: s.conversions },
    ],
  }
}

describe('heuristicSegmentInsight', () => {
  it('決定的（同入力 → 同出力）', () => {
    const m = segSummary()
    expect(heuristicSegmentInsight(m)).toEqual(heuristicSegmentInsight(m))
  })

  it('売上が前月比 +10% 以上なら「好調」の所見を出す', () => {
    const r = heuristicSegmentInsight(segSummary({ salesAmount: 1_600_000, prevSalesAmount: 1_300_000 }))
    expect(r.findings.some(f => f.kind === 'win' && f.title.includes('売上'))).toBe(true)
  })

  it('売上が前月比 −10% 以下なら課題 + 高優先度の要因分解アクション', () => {
    const r = heuristicSegmentInsight(segSummary({ salesAmount: 1_000_000, prevSalesAmount: 1_300_000 }))
    expect(r.findings.some(f => f.kind === 'issue' && f.title.includes('売上'))).toBe(true)
    expect(r.actions.some(a => a.priority === 'high' && a.title.includes('要因分解'))).toBe(true)
  })

  it('GA 未連携なら「機会」＋連携アクションを出す', () => {
    const r = heuristicSegmentInsight(segSummary({ mediaConnected: false, sessions: 0, prevSessions: 0, conversions: 0, conversionRate: 0 }))
    expect(r.findings.some(f => f.kind === 'opportunity' && f.title.includes('未接続'))).toBe(true)
    expect(r.actions.some(a => a.title.includes('メディア分析を接続'))).toBe(true)
  })

  it('CVR が 1% 未満なら CVR 改善の高優先度アクション', () => {
    const r = heuristicSegmentInsight(segSummary({ conversions: 5, conversionRate: 0.003 }))
    expect(r.actions.some(a => a.title.includes('CVR') && a.priority === 'high')).toBe(true)
  })

  it('アクションは必ず 1 件以上（空にしない）', () => {
    const r = heuristicSegmentInsight(segSummary({ salesAmount: 1_300_000, prevSalesAmount: 1_300_000, conversionRate: 0.03 }))
    expect(r.actions.length).toBeGreaterThan(0)
    expect(r.executiveSummary.length).toBeGreaterThan(0)
  })
})

function company(over: Partial<CompanySummary> = {}): CompanySummary {
  const snapshots = over.snapshots ?? [
    snap({ segmentId: 'seg-01', segmentName: 'A', salesAmount: 1_000_000, prevSalesAmount: 900_000 }),
    snap({ segmentId: 'seg-02', segmentName: 'B', salesAmount: 600_000, prevSalesAmount: 550_000 }),
    snap({ segmentId: 'seg-03', segmentName: 'C', salesAmount: 400_000, prevSalesAmount: 380_000 }),
  ]
  const sum = (fn: (s: SegmentSnapshot) => number): number => snapshots.reduce((a, s) => a + fn(s), 0)
  return {
    periodMonth: '2026-06',
    segmentCount: snapshots.length,
    connectedCount: snapshots.filter(s => s.mediaConnected).length,
    totalSales: sum(s => s.salesAmount),
    prevTotalSales: sum(s => s.prevSalesAmount),
    totalOrders: sum(s => s.orders),
    totalSessions: sum(s => (s.mediaConnected ? s.sessions : 0)),
    prevTotalSessions: sum(s => (s.mediaConnected ? s.prevSessions : 0)),
    totalConversions: sum(s => (s.mediaConnected ? s.conversions : 0)),
    snapshots,
    trend: [
      { month: '2026-05', salesAmount: sum(s => s.prevSalesAmount), orders: 30, sessions: 4000, conversions: 90 },
      { month: '2026-06', salesAmount: sum(s => s.salesAmount), orders: sum(s => s.orders), sessions: sum(s => s.sessions), conversions: sum(s => s.conversions) },
    ],
    ...over,
  }
}

describe('heuristicCompanyInsight', () => {
  it('決定的（同入力 → 同出力）', () => {
    const c = company()
    expect(heuristicCompanyInsight(c)).toEqual(heuristicCompanyInsight(c))
  })

  it('1 業態が売上の 50% 以上を占めると集中リスクの課題 + 高優先度アクション', () => {
    const c = company({
      snapshots: [
        snap({ segmentId: 'seg-01', segmentName: '主力', salesAmount: 8_000_000, prevSalesAmount: 7_000_000 }),
        snap({ segmentId: 'seg-02', segmentName: '副', salesAmount: 1_000_000, prevSalesAmount: 900_000 }),
      ],
    })
    const r = heuristicCompanyInsight(c)
    expect(r.findings.some(f => f.kind === 'issue' && f.title.includes('集中'))).toBe(true)
    expect(r.actions.some(a => a.priority === 'high' && a.title.includes('第 2 の柱'))).toBe(true)
  })

  it('未接続業態があればメディア接続の機会 + アクションを出す', () => {
    const c = company({
      snapshots: [
        snap({ segmentId: 'seg-01', segmentName: 'A', salesAmount: 1_000_000, prevSalesAmount: 950_000, mediaConnected: true }),
        snap({ segmentId: 'seg-02', segmentName: 'B', salesAmount: 800_000, prevSalesAmount: 780_000, mediaConnected: false, sessions: 0, conversions: 0 }),
      ],
    })
    const r = heuristicCompanyInsight(c)
    expect(r.findings.some(f => f.kind === 'opportunity' && f.title.includes('メディア分析の接続'))).toBe(true)
    expect(r.actions.some(a => a.title.includes('未接続業態'))).toBe(true)
  })

  it('全社売上が前月比 −10% 以下なら課題', () => {
    const c = company({ totalSales: 1_000_000, prevTotalSales: 1_300_000 })
    const r = heuristicCompanyInsight(c)
    expect(r.findings.some(f => f.kind === 'issue' && f.title.includes('全社売上'))).toBe(true)
  })

  it('減速業態があれば高優先度のてこ入れアクション', () => {
    const c = company({
      snapshots: [
        snap({ segmentId: 'seg-01', segmentName: 'A', salesAmount: 1_000_000, prevSalesAmount: 950_000 }),
        snap({ segmentId: 'seg-02', segmentName: '減速', salesAmount: 500_000, prevSalesAmount: 800_000 }),
      ],
    })
    const r = heuristicCompanyInsight(c)
    expect(r.actions.some(a => a.priority === 'high' && a.title.includes('てこ入れ'))).toBe(true)
  })

  it('アクションは必ず 1 件以上（空にしない）', () => {
    const r = heuristicCompanyInsight(company())
    expect(r.actions.length).toBeGreaterThan(0)
    expect(r.executiveSummary.length).toBeGreaterThan(0)
  })
})
