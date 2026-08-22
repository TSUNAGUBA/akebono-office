/**
 * 営業アプローチリスト（改善要望 2026-08-21・F-53）の入力検証。
 * shared/domain/sales-approach は API（routes/sales-approaches.ts）とモック（useSalesApproaches）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 */
import { describe, expect, it } from 'vitest'
import { salesApproachError, type SalesApproachInput } from '../../shared/domain/sales-approach'

function input(over: Partial<SalesApproachInput> = {}): SalesApproachInput {
  return {
    companyId: 'c-01',
    status: '候補',
    priority: '中',
    assigneeMemberId: 'm-01',
    nextAction: '',
    nextActionDate: null,
    note: '',
    ...over,
  }
}

describe('salesApproachError', () => {
  it('妥当な入力は null', () => {
    expect(salesApproachError(input())).toBeNull()
    expect(salesApproachError(input({ status: '受注', priority: '高', nextActionDate: '2026-09-01' }))).toBeNull()
  })

  it('顧客(会社)は必須（空白のみも不可）', () => {
    expect(salesApproachError(input({ companyId: '' }))).toContain('顧客')
    expect(salesApproachError(input({ companyId: '  ' }))).toContain('顧客')
  })

  it('アプローチ状態・優先度はプリセット外を拒否', () => {
    expect(salesApproachError(input({ status: '検討中' }))).toContain('アプローチ状態')
    expect(salesApproachError(input({ status: '' }))).toContain('アプローチ状態')
    expect(salesApproachError(input({ priority: '最高' }))).toContain('優先度')
  })

  it('次のアクション日は任意（空 = OK）だが不正日付は拒否', () => {
    expect(salesApproachError(input({ nextActionDate: null }))).toBeNull()
    expect(salesApproachError(input({ nextActionDate: '2026-02-30' }))).toContain('次のアクション日')
    expect(salesApproachError(input({ nextActionDate: 'not-a-date' }))).toContain('次のアクション日')
  })

  it('検証順: 顧客 → 状態 → 優先度 → 日付（最初のエラーを返す）', () => {
    const r = salesApproachError(input({ companyId: '', status: 'x', priority: 'y', nextActionDate: 'z' }))
    expect(r).toContain('顧客')
  })
})
