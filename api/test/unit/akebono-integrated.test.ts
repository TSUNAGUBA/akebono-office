/**
 * 統合メトリクスの共有純関数（shared/domain/media-integrated。Phase C = サーバー組み立て化）の単体テスト。
 * フロント（モック合成）と API（buildIntegratedMetrics）が同一関数を使う = 両モードの計算一致を守る。
 * - recentMonthKeys: 月キー窓（年跨ぎ・最終月 = 直前の完了月）
 * - foldBusinessMonthly: 赤黒訂正の**元月帰属**（発生日ではなく元明細の計上月で相殺 = 原則6）
 * - composeIntegratedMetrics: 派生値（CVR・AOV・セッションあたり売上・ファネル）の決定的導出
 */
import { describe, expect, it } from 'vitest'
import {
  composeIntegratedMetrics, foldBusinessMonthly, recentMonthKeys,
} from '../../../shared/domain/media-integrated'

describe('recentMonthKeys（月キー窓）', () => {
  it('endBackMonths=1 は「直前の完了月」で終わる（年跨ぎも正しい）', () => {
    expect(recentMonthKeys('2026-07', 3, 1)).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(recentMonthKeys('2026-01', 3, 1)).toEqual(['2025-10', '2025-11', '2025-12'])
  })
  it('endBackMonths=0 は当月で終わる', () => {
    expect(recentMonthKeys('2026-03', 2, 0)).toEqual(['2026-02', '2026-03'])
  })
})

describe('foldBusinessMonthly（売上月次の畳み込み）', () => {
  const months = ['2026-05', '2026-06']

  it('通常明細は自身の月へ・赤黒訂正は元明細の計上月へ帰属して相殺する', () => {
    const rows = [
      { id: 'a', salesDate: '2026-05-10', amount: 5000, correctionOf: null },
      { id: 'b', salesDate: '2026-06-01', amount: 3000, correctionOf: null },
      // a の訂正（訂正日 = 6 月だが 5 月へ帰属して相殺）
      { id: 'c', salesDate: '2026-06-15', amount: -5000, correctionOf: 'a' },
    ]
    const map = foldBusinessMonthly(rows, months)
    expect(map.get('2026-05')).toEqual({ amount: 0, orders: 0 })
    expect(map.get('2026-06')).toEqual({ amount: 3000, orders: 1 })
  })

  it('元明細が見つからない訂正は自身の月へ・窓外の月は無視・件数は 0 でクランプ', () => {
    const rows = [
      { id: 'x', salesDate: '2026-06-10', amount: -800, correctionOf: 'gone' },
      { id: 'y', salesDate: '2026-01-01', amount: 99999, correctionOf: null }, // 窓外
    ]
    const map = foldBusinessMonthly(rows, months)
    expect(map.get('2026-06')).toEqual({ amount: -800, orders: 0 }) // −1 件 → 0 クランプ
    expect(map.get('2026-05')).toEqual({ amount: 0, orders: 0 })
  })
})

describe('composeIntegratedMetrics（統合メトリクスの組み立て）', () => {
  const months = ['2026-04', '2026-05', '2026-06']

  it('対象月 = 最終月・前月比較・派生値（CVR / AOV / セッションあたり売上）を決定的に導出する', () => {
    const m = composeIntegratedMetrics({
      segmentId: 'seg-01', segmentName: '陶磁器', siteName: '器マガジン', months,
      mediaBy: new Map([
        ['2026-05', { sessions: 1000, conversions: 18 }],
        ['2026-06', { sessions: 1200, conversions: 24, engagedSessions: 700 }],
      ]),
      biz: new Map([
        ['2026-05', { amount: 280000, orders: 14 }],
        ['2026-06', { amount: 320000, orders: 16 }],
      ]),
    })
    expect(m.periodMonth).toBe('2026-06')
    expect(m.sessions).toBe(1200)
    expect(m.prevSessions).toBe(1000)
    expect(m.conversionRate).toBe(0.02)
    expect(m.salesAmount).toBe(320000)
    expect(m.prevSalesAmount).toBe(280000)
    expect(m.aov).toBe(20000)
    expect(m.salesPerSession).toBe(267)
    // ファネルの主体的関与は engagedSessions 実測を優先（m4）
    expect(m.funnel).toEqual({ sessions: 1200, engaged: 700, conversions: 24, orders: 16 })
    expect(m.trend.map(t => t.month)).toEqual(months)
    // メディア月次が無い月は 0（2026-04）
    expect(m.trend[0]).toEqual({ month: '2026-04', sessions: 0, conversions: 0, salesAmount: 0, orders: 0 })
  })

  it('engagedSessions 実測が無い月は 0.55 係数で近似・空の器（GA 未連携・売上なし）でも安全', () => {
    const m = composeIntegratedMetrics({
      segmentId: 's', segmentName: 'n', siteName: 'x', months,
      mediaBy: new Map([['2026-06', { sessions: 100, conversions: 5 }]]),
      biz: new Map(),
    })
    expect(m.funnel.engaged).toBe(55)
    const empty = composeIntegratedMetrics({
      segmentId: 's', segmentName: 'n', siteName: 'x', months, mediaBy: new Map(), biz: new Map(),
    })
    expect(empty.sessions).toBe(0)
    expect(empty.conversionRate).toBe(0)
    expect(empty.aov).toBe(0)
    expect(empty.salesPerSession).toBe(0)
  })
})
