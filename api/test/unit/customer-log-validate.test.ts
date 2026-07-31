/**
 * 顧客ログ入力検証（shared/domain/customer-log）の単体テスト。
 * この共有モジュールは API（api/src/routes/customer-logs.ts）とモック（mockup useCustomerLogs）の
 * **パリティの SoT**（レビュー指摘 2026-07-31 で重複実装から集約）。ここでの検証が両者の挙動を同時に固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  capCodePoints, cleanCustomerLogTags, customerLogCompanyError, customerLogDateError,
  customerLogMemoError, customerLogTagsError, customerLogTimeError, customerLogTimeRangeError,
  isRealDateKey,
} from '../../../shared/domain/customer-log'
import { CUSTOMER_LOG_TAG_CAP, CUSTOMER_LOG_TAGS_MAX } from '../../../shared/domain/types'

describe('customerLogDateError（日付・実在日）', () => {
  it('正常な日付は null', () => {
    expect(customerLogDateError('2026-07-31')).toBeNull()
  })
  it('書式不正・空は「選択してください」', () => {
    expect(customerLogDateError('')).toBe('日付（何月何日）を選択してください')
    expect(customerLogDateError('2026/07/31')).toBe('日付（何月何日）を選択してください')
  })
  it('実在しない日（2026-13-40 / 2026-02-30）は「正しくありません」（::date の 22007→500 を防ぐ）', () => {
    expect(customerLogDateError('2026-13-40')).toBe('日付が正しくありません')
    expect(customerLogDateError('2026-02-30')).toBe('日付が正しくありません')
    expect(isRealDateKey('2026-02-30')).toBe(false)
    expect(isRealDateKey('2028-02-29')).toBe(true) // うるう年は実在
  })
})

describe('customerLogTimeError / customerLogTimeRangeError（開始・終了時刻）', () => {
  it('HH:MM は許容（15 分単位は UI の選択肢制約 = 旧データ互換で API は分単位を拒否しない）', () => {
    expect(customerLogTimeError('14:30', '開始')).toBeNull()
    expect(customerLogTimeError('14:37', '開始')).toBeNull()
    expect(customerLogTimeError('', '開始')).toBeNull() // 空 = 未設定
  })
  it('書式不正はラベル付きメッセージ', () => {
    expect(customerLogTimeError('25:99', '開始')).toBe('開始時間は HH:MM 形式で入力してください')
    expect(customerLogTimeError('9:00', '終了')).toBe('終了時間は HH:MM 形式で入力してください')
  })
  it('終了のみは不可・終了は開始より後（同時刻も不可）', () => {
    expect(customerLogTimeRangeError(null, '15:00')).toBe('終了時間を入力する場合は開始時間も入力してください')
    expect(customerLogTimeRangeError('15:00', '15:00')).toBe('終了時間は開始時間より後にしてください')
    expect(customerLogTimeRangeError('15:00', '14:45')).toBe('終了時間は開始時間より後にしてください')
    expect(customerLogTimeRangeError('15:00', '15:15')).toBeNull()
    expect(customerLogTimeRangeError('15:00', null)).toBeNull()
    expect(customerLogTimeRangeError(null, null)).toBeNull()
  })
})

describe('cleanCustomerLogTags / customerLogTagsError（属性タグ）', () => {
  it('trim・重複除去・空要素の除去', () => {
    expect(cleanCustomerLogTags(['商談', '商談', ' 取材 ', '', '  '])).toEqual(['商談', '取材'])
  })
  it('1 タグはコードポイント上限で切り詰め（絵文字を境界で壊さない）', () => {
    const long = 'あ'.repeat(CUSTOMER_LOG_TAG_CAP + 5)
    expect(cleanCustomerLogTags([long])).toEqual(['あ'.repeat(CUSTOMER_LOG_TAG_CAP)])
    expect(capCodePoints('👍'.repeat(3), 2)).toBe('👍👍')
  })
  it('未指定は許容・配列以外は形式エラー・正規化後の件数上限', () => {
    expect(customerLogTagsError(undefined)).toBeNull()
    expect(customerLogTagsError(null)).toBeNull()
    expect(customerLogTagsError('商談')).toBe('属性タグの形式が正しくありません')
    expect(customerLogTagsError(Array.from({ length: CUSTOMER_LOG_TAGS_MAX + 1 }, (_, i) => `t${i}`)))
      .toBe(`属性タグは ${CUSTOMER_LOG_TAGS_MAX} 件までです`)
    // 重複除去後に上限内へ収まる場合はエラーにしない
    expect(customerLogTagsError(Array.from({ length: CUSTOMER_LOG_TAGS_MAX + 1 }, () => '商談'))).toBeNull()
  })
})

describe('customerLogMemoError（担当者メモ / 議事録メモ = どちらか必須）', () => {
  it('両方空（空白のみ含む）はエラー・どちらか一方があれば null', () => {
    expect(customerLogMemoError('', '')).toBe('担当者メモまたは議事録メモを入力してください')
    expect(customerLogMemoError('  ', '\n')).toBe('担当者メモまたは議事録メモを入力してください')
    expect(customerLogMemoError('担当者メモ', '')).toBeNull()
    expect(customerLogMemoError('', '議事録メモ')).toBeNull()
  })
})

describe('customerLogCompanyError（会社 = id or 新規名のどちらか必須）', () => {
  it('id 指定・意味のある新規名は null', () => {
    expect(customerLogCompanyError('c-01', '')).toBeNull()
    expect(customerLogCompanyError('', '新規コンボ商事')).toBeNull()
  })
  it('両方未指定・空白のみはエラー', () => {
    expect(customerLogCompanyError('', '')).toBe('顧客(会社)を選択してください')
    expect(customerLogCompanyError('', '   ')).toBe('顧客(会社)を選択してください')
  })
  it('法人格のみ（正規化で空になる名前）はエラー（意味のないマスタ新規登録を防ぐ = レビュー指摘 m-2）', () => {
    expect(customerLogCompanyError('', '株式会社')).toBe('顧客(会社)を選択してください')
    expect(customerLogCompanyError('', '(株)')).toBe('顧客(会社)を選択してください')
    expect(customerLogCompanyError('', '株式会社 つなぐば')).toBeNull() // 法人格 + 実名は OK
  })
})
