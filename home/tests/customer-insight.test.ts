/**
 * 顧客別ダッシュボードの AI 分析（改善要望 2026-08-21・F-54）。
 * shared/domain/customer-insight は API を持たない**常時ライブ導出**の SoT（保存しない = 原則6）。
 * - buildCustomerInsight: 決定性（同一入力 = 同一出力）・エンゲージメント傾向・リスク/アクションの閾値
 * - customerActivityMonthly: 月次集計の月キー・件数
 * - hasContextInfo: 定性情報の有無判定
 */
import { describe, expect, it } from 'vitest'
import {
  CONTACT_STALE_DAYS,
  buildCustomerInsight, customerActivityMonthly, hasContextInfo,
  type CustomerInsightInput,
} from '../../shared/domain/customer-insight'

const ASOF = '2026-08-21'

function baseInput(over: Partial<CustomerInsightInput> = {}): CustomerInsightInput {
  return {
    companyName: 'テスト商事',
    asOf: ASOF,
    logs: [],
    deals: [],
    supports: [],
    context: null,
    ...over,
  }
}

describe('buildCustomerInsight', () => {
  it('決定的（同一入力 → 同一出力）', () => {
    const input = baseInput({
      logs: [
        { logDate: '2026-08-01', tags: ['商談'] },
        { logDate: '2026-07-10', tags: ['商談', '定例'] },
        { logDate: '2026-03-01', tags: ['取材'] },
      ],
      deals: [{ phase: '提案', amount: 1_000_000 }],
      supports: [{ status: '対応中' }],
    })
    expect(buildCustomerInsight(input)).toEqual(buildCustomerInsight(input))
  })

  it('接点の増減: 直近 90 日 > 前の 90 日で up・逆で down・双方 0 件で none', () => {
    const up = buildCustomerInsight(baseInput({
      logs: [
        { logDate: '2026-08-01', tags: [] }, { logDate: '2026-07-01', tags: [] },
        { logDate: '2026-04-01', tags: [] },
      ],
    }))
    expect(up.engagement.recentCount).toBe(2)
    expect(up.engagement.prevCount).toBe(1)
    expect(up.engagement.trend).toBe('up')

    const down = buildCustomerInsight(baseInput({
      logs: [
        { logDate: '2026-04-01', tags: [] }, { logDate: '2026-03-20', tags: [] },
        { logDate: '2026-08-01', tags: [] },
      ],
    }))
    expect(down.engagement.trend).toBe('down')

    const none = buildCustomerInsight(baseInput())
    expect(none.engagement.trend).toBe('none')
    expect(none.engagement.lastContact).toBeNull()
    expect(none.engagement.daysSinceContact).toBeNull()
    // 接点なし → 最初の接点づくりを推奨
    expect(none.actions.some(a => a.includes('最初の接点'))).toBe(true)
  })

  it('基準日より未来の活動日は集計に入れない（先日付の誤登録に頑健）', () => {
    const r = buildCustomerInsight(baseInput({
      logs: [{ logDate: '2026-09-01', tags: [] }],
    }))
    expect(r.engagement.recentCount).toBe(0)
    expect(r.engagement.lastContact).toBeNull()
  })

  it(`最終接点から ${CONTACT_STALE_DAYS} 日以上でフォロー切れリスク + フォローアップ推奨`, () => {
    const stale = buildCustomerInsight(baseInput({
      logs: [{ logDate: '2026-05-01', tags: [] }],
    }))
    expect(stale.engagement.daysSinceContact).toBeGreaterThanOrEqual(CONTACT_STALE_DAYS)
    expect(stale.risks.some(r => r.includes('日が経過'))).toBe(true)
    expect(stale.actions.some(a => a.includes('フォローアップ'))).toBe(true)

    const fresh = buildCustomerInsight(baseInput({
      logs: [{ logDate: '2026-08-20', tags: [] }],
    }))
    expect(fresh.risks.some(r => r.includes('日が経過'))).toBe(false)
  })

  it('進行中の商談（受注・失注以外）と未解決サポートを集計・リスク化する', () => {
    const r = buildCustomerInsight(baseInput({
      logs: [{ logDate: '2026-08-10', tags: [] }],
      deals: [
        { phase: '提案', amount: 500_000 },
        { phase: '受注', amount: 300_000 },
        { phase: '失注', amount: null },
      ],
      supports: [{ status: '未対応' }, { status: '解決' }],
    }))
    expect(r.summary.some(s => s.includes('進行中の商談は 1 件'))).toBe(true)
    expect(r.summary.some(s => s.includes('受注済みの商談が 1 件'))).toBe(true)
    expect(r.risks.some(x => x.includes('未解決のサポート対応が 1 件'))).toBe(true)
    expect(r.actions.some(a => a.includes('サポート対応を先に解消'))).toBe(true)
  })

  it('活動目的の上位は件数降順 → タグ名昇順で最大 3 件（決定的）', () => {
    const r = buildCustomerInsight(baseInput({
      logs: [
        { logDate: '2026-08-01', tags: ['商談', '定例'] },
        { logDate: '2026-08-05', tags: ['商談'] },
        { logDate: '2026-08-10', tags: ['取材', '定例'] },
        { logDate: '2026-08-12', tags: ['会食'] },
      ],
    }))
    expect(r.topTags).toEqual([
      { tag: '商談', count: 2 },
      { tag: '定例', count: 2 },
      { tag: '会食', count: 1 },
    ])
  })

  it('コンテキスト未整備は整備を推奨し、整備済みはサマリーに出る', () => {
    const without = buildCustomerInsight(baseInput({ logs: [{ logDate: '2026-08-20', tags: [] }] }))
    expect(without.actions.some(a => a.includes('定性情報'))).toBe(true)

    const withCtx = buildCustomerInsight(baseInput({
      logs: [{ logDate: '2026-08-20', tags: [] }],
      context: { vision: '地域一番店', challenges: '', strategyNotes: '' },
    }))
    expect(withCtx.actions.some(a => a.includes('定性情報'))).toBe(false)
    expect(withCtx.summary.some(s => s.includes('定性情報'))).toBe(true)
  })

  it('接点はあるが商談ゼロなら案件立ち上げを推奨する', () => {
    const r = buildCustomerInsight(baseInput({ logs: [{ logDate: '2026-08-15', tags: [] }] }))
    expect(r.actions.some(a => a.includes('立ち上げ'))).toBe(true)
  })
})

describe('customerActivityMonthly', () => {
  it('直近 N か月の月キー（昇順・右端 = 基準月）と件数を返す', () => {
    const points = customerActivityMonthly([
      { logDate: '2026-08-01', tags: [] },
      { logDate: '2026-08-20', tags: [] },
      { logDate: '2026-06-15', tags: [] },
      { logDate: '2026-01-01', tags: [] }, // 範囲外
    ], ASOF, 3)
    expect(points).toEqual([
      { month: '2026-06', count: 1 },
      { month: '2026-07', count: 0 },
      { month: '2026-08', count: 2 },
    ])
  })

  it('年またぎの月キーも正しい', () => {
    const points = customerActivityMonthly([], '2026-01-15', 3)
    expect(points.map(p => p.month)).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('hasContextInfo', () => {
  it('null・全項目空は false / どれか 1 つでも非空は true', () => {
    expect(hasContextInfo(null)).toBe(false)
    expect(hasContextInfo({ vision: '', challenges: '  ', strategyNotes: '' })).toBe(false)
    expect(hasContextInfo({ vision: '', challenges: '', strategyNotes: '', businessNotes: '売上 10 億' })).toBe(true)
    expect(hasContextInfo({ vision: 'ビジョン', challenges: '', strategyNotes: '' })).toBe(true)
  })
})
