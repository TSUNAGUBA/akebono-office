/**
 * 活動記録（サポート/営業/ビジネスパートナー = 改修依頼 2026-08-18）入力検証の単体テスト。
 * shared/domain/activity は API（api/src/routes/activities.ts）とモック（mockup use*Activities）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  activityDateError, activityEnumError, activityTimeError,
  partnerActivityError, type PartnerActivityInput,
  salesActivityError, salesAmountError, salesProbabilityError, type SalesActivityInput,
  SALES_AMOUNT_MAX,
  supportActivityError, type SupportActivityInput,
} from '../../../shared/domain/activity'
import { SUPPORT_ACTIVITY_CATEGORIES } from '../../../shared/domain/types'

const supportBase: SupportActivityInput = {
  receivedDate: '2026-08-18',
  receivedTime: '10:30',
  companyId: 'c-01',
  newCompanyName: '',
  inquirerName: '山田様',
  targetSystem: '在庫管理システム',
  category: 'データ',
  title: 'CSVが取り込めない',
  body: 'アップロードするとエラーになる',
  priority: '高',
  status: '対応中',
  staffMemberId: 'm-04',
  response: '',
  cause: '',
  resolution: '',
  completedDate: null,
  completedTime: null,
  knowledgeNote: '',
}

const salesBase: SalesActivityInput = {
  companyId: 'c-01',
  newCompanyName: '',
  title: '在庫管理DXプロジェクト',
  dealType: '新規',
  staffMemberId: 'm-03',
  phase: '提案',
  amount: 1_500_000,
  probability: 60,
  expectedCloseDate: '2026-09-30',
  customerIssue: '',
  proposal: '',
  nextAction: 'デモ実施',
  nextActionDate: '2026-08-25',
}

const partnerBase: PartnerActivityInput = {
  partnerName: '川上さん',
  theme: 'フローラ社との協業検討',
  relatedCompany: 'フローラ',
  activityType: '共創',
  status: '進行中',
  summary: '',
  currentState: '',
  nextAction: '3者MTG',
  nextActionDate: '2026-09-07',
  staffMemberId: 'm-03',
  relatedMeeting: '',
  relatedSalesActivityId: null,
  memo: '',
}

describe('共通ヘルパー', () => {
  it('activityDateError: 必須/任意・実在日', () => {
    expect(activityDateError('2026-08-18', '受付日', true)).toBeNull()
    expect(activityDateError('', '受付日', true)).toBe('受付日を選択してください')
    expect(activityDateError(null, '完了日', false)).toBeNull()
    expect(activityDateError('2026-02-30', '完了日', false)).toBe('完了日が正しくありません')
  })
  it('activityTimeError: HH:MM・空 = 未設定', () => {
    expect(activityTimeError(null, '受付時刻')).toBeNull()
    expect(activityTimeError('10:30', '受付時刻')).toBeNull()
    expect(activityTimeError('25:99', '受付時刻')).toBe('受付時刻は HH:MM 形式で入力してください')
  })
  it('activityEnumError: プリセット集合・必須/任意', () => {
    expect(activityEnumError('操作', SUPPORT_ACTIVITY_CATEGORIES, '問い合わせ種別')).toBeNull()
    expect(activityEnumError('', SUPPORT_ACTIVITY_CATEGORIES, '問い合わせ種別')).toBe('問い合わせ種別を選択してください')
    expect(activityEnumError('未知', SUPPORT_ACTIVITY_CATEGORIES, '問い合わせ種別')).toBe('問い合わせ種別の値が正しくありません')
    expect(activityEnumError('', SUPPORT_ACTIVITY_CATEGORIES, '問い合わせ種別', false)).toBeNull()
  })
  it('salesAmountError / salesProbabilityError: 範囲と整数', () => {
    expect(salesAmountError(null)).toBeNull()
    expect(salesAmountError(0)).toBeNull()
    expect(salesAmountError(-1)).toBe('商談金額は 0 以上の整数（円）で入力してください')
    expect(salesAmountError(1.5)).toBe('商談金額は 0 以上の整数（円）で入力してください')
    expect(salesAmountError(Number.NaN)).toBe('商談金額は 0 以上の整数（円）で入力してください')
    expect(salesAmountError(SALES_AMOUNT_MAX + 1)).toBe('商談金額が大きすぎます')
    expect(salesProbabilityError(null)).toBeNull()
    expect(salesProbabilityError(0)).toBeNull()
    expect(salesProbabilityError(100)).toBeNull()
    expect(salesProbabilityError(101)).toBe('受注確度は 0〜100 の整数（%）で入力してください')
    expect(salesProbabilityError(59.5)).toBe('受注確度は 0〜100 の整数（%）で入力してください')
  })
})

describe('supportActivityError（サポート活動）', () => {
  it('正常入力は null（時刻・完了未設定も可）', () => {
    expect(supportActivityError(supportBase)).toBeNull()
    expect(supportActivityError({ ...supportBase, receivedTime: null })).toBeNull()
  })
  it('必須項目（受付日・種別・件名・内容・優先度・ステータス・会社）', () => {
    expect(supportActivityError({ ...supportBase, receivedDate: '' })).toBe('受付日を選択してください')
    expect(supportActivityError({ ...supportBase, category: '' })).toBe('問い合わせ種別を選択してください')
    expect(supportActivityError({ ...supportBase, title: '  ' })).toBe('件名を入力してください')
    expect(supportActivityError({ ...supportBase, body: ' ' })).toBe('問い合わせ内容を入力してください')
    expect(supportActivityError({ ...supportBase, priority: '爆速' })).toBe('優先度の値が正しくありません')
    expect(supportActivityError({ ...supportBase, status: '' })).toBe('ステータスを選択してください')
    expect(supportActivityError({ ...supportBase, companyId: '', newCompanyName: '' })).toBe('顧客(会社)を選択してください')
  })
  it('完了時刻のみ（完了日なし）は不可', () => {
    expect(supportActivityError({ ...supportBase, completedTime: '12:00' }))
      .toBe('完了時刻を入力する場合は完了日も入力してください')
    expect(supportActivityError({ ...supportBase, completedDate: '2026-08-18', completedTime: '12:00' })).toBeNull()
  })
  it('会社は新規名（コンボボックス自由入力）でも可', () => {
    expect(supportActivityError({ ...supportBase, companyId: '', newCompanyName: '株式会社サンプル' })).toBeNull()
  })
})

describe('salesActivityError（営業活動）', () => {
  it('正常入力は null（金額・確度・日付未設定も可）', () => {
    expect(salesActivityError(salesBase)).toBeNull()
    expect(salesActivityError({
      ...salesBase, amount: null, probability: null, expectedCloseDate: null, nextActionDate: null,
    })).toBeNull()
  })
  it('必須項目（商談名・種別・フェーズ・会社）と範囲', () => {
    expect(salesActivityError({ ...salesBase, title: '' })).toBe('商談名を入力してください')
    expect(salesActivityError({ ...salesBase, dealType: '継続' })).toBe('商談種別の値が正しくありません')
    expect(salesActivityError({ ...salesBase, phase: '' })).toBe('商談フェーズを選択してください')
    expect(salesActivityError({ ...salesBase, probability: 150 })).toBe('受注確度は 0〜100 の整数（%）で入力してください')
    expect(salesActivityError({ ...salesBase, expectedCloseDate: '2026-13-01' })).toBe('受注予定日が正しくありません')
    expect(salesActivityError({ ...salesBase, companyId: '', newCompanyName: ' ' })).toBe('顧客(会社)を選択してください')
  })
})

describe('partnerActivityError（ビジネスパートナー活動）', () => {
  it('正常入力は null（関連企業・関連商談は任意）', () => {
    expect(partnerActivityError(partnerBase)).toBeNull()
    expect(partnerActivityError({ ...partnerBase, relatedCompany: '', nextActionDate: null })).toBeNull()
  })
  it('必須項目（パートナー・テーマ名・活動区分・ステータス）', () => {
    expect(partnerActivityError({ ...partnerBase, partnerName: '  ' })).toBe('パートナーを入力してください')
    expect(partnerActivityError({ ...partnerBase, theme: '' })).toBe('テーマ名を入力してください')
    expect(partnerActivityError({ ...partnerBase, activityType: '' })).toBe('活動区分を選択してください')
    expect(partnerActivityError({ ...partnerBase, status: '爆進中' })).toBe('ステータスの値が正しくありません')
  })
  it('Next Action日は実在日', () => {
    expect(partnerActivityError({ ...partnerBase, nextActionDate: '2026-02-30' })).toBe('Next Action日が正しくありません')
  })
})
