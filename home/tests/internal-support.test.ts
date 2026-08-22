/**
 * 社内サポート活動（改善要望 2026-08-22・F-57）の入力検証。
 * shared/domain/internal-support は API（routes/internal-supports.ts）とモック（useInternalSupports）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 */
import { describe, expect, it } from 'vitest'
import { internalSupportError, type InternalSupportInput } from '../../shared/domain/internal-support'

function input(over: Partial<InternalSupportInput> = {}): InternalSupportInput {
  return {
    activityDate: '2026-08-22',
    activityTime: null,
    performerMemberId: 'm-01',
    targetMemberId: 'm-02',
    taskDescription: '月次請求処理の締め作業のフォロー',
    method: '対面',
    feedback: '',
    ...over,
  }
}

describe('internalSupportError', () => {
  it('妥当な入力は null', () => {
    expect(internalSupportError(input())).toBeNull()
    expect(internalSupportError(input({ activityTime: '15:30', method: '勉強会', feedback: '手順書を整備した' }))).toBeNull()
  })

  it('活動日は必須・実在日のみ（時刻は任意だが HH:MM のみ）', () => {
    expect(internalSupportError(input({ activityDate: '' }))).toContain('活動日')
    expect(internalSupportError(input({ activityDate: '2026-02-30' }))).toContain('活動日')
    expect(internalSupportError(input({ activityTime: '25:00' }))).toContain('活動時刻')
    expect(internalSupportError(input({ activityTime: null }))).toBeNull()
  })

  it('実施者・対象者は必須（空白のみも不可）', () => {
    expect(internalSupportError(input({ performerMemberId: '' }))).toContain('実施者')
    expect(internalSupportError(input({ performerMemberId: '  ' }))).toContain('実施者')
    expect(internalSupportError(input({ targetMemberId: '' }))).toContain('対象者')
  })

  it('実施者と対象者の同一メンバーは拒否', () => {
    expect(internalSupportError(input({ performerMemberId: 'm-01', targetMemberId: 'm-01' })))
      .toContain('別のメンバー')
  })

  it('対象業務内容は必須（空白のみも不可）・方法はプリセット外を拒否', () => {
    expect(internalSupportError(input({ taskDescription: '' }))).toContain('対象業務内容')
    expect(internalSupportError(input({ taskDescription: '   ' }))).toContain('対象業務内容')
    expect(internalSupportError(input({ method: 'テレパシー' }))).toContain('フォローアップ方法')
    expect(internalSupportError(input({ method: '' }))).toContain('フォローアップ方法')
  })

  it('検証順: 活動日 → 時刻 → 実施者 → 対象者 → 同一チェック → 業務内容 → 方法（最初のエラーを返す)', () => {
    const r = internalSupportError(input({ activityDate: '', performerMemberId: '', taskDescription: '', method: 'x' }))
    expect(r).toContain('活動日')
  })
})
