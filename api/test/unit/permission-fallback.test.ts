/**
 * 階層一括設定のフォールバック（バッチ7m: shared/domain/permissions の resolve）。
 * 同一レイヤ内で 明示キー → 一括キー（マスタ全体 = field null / 全メンバー = member:*）→ 既定値 の順に解決する。
 * - canViewField: field=null の「マスタ全体」ルールが全項目の一括既定として機能する（従来は不使用だった）
 * - canViewMemberReports / canViewMemberTaskPlans: member:* の全メンバー一括既定
 * - stripDeniedFields: マスタ全体 deny でカタログ全項目が剥がれる（id 等のカタログ外キーは対象外）
 * - レイヤ優先（個人 > 役職 > ロール）は従来どおり: 上位レイヤの一括設定は下位レイヤの明示設定より優先
 */
import { describe, expect, it } from 'vitest'
import {
  canViewField, canViewMemberReports, canViewMemberTaskPlans,
  MEMBER_VIEW_ALL_FIELD, stripDeniedFields,
} from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'members',
    field: p.field === undefined ? null : p.field,
    effect: p.effect ?? 'deny',
    active: p.active ?? true,
  } as PermissionRule
}

describe('canViewField のマスタ全体（field=null）フォールバック', () => {
  it('マスタ全体 deny で全項目が不可になる（別リソースは影響なし）', () => {
    const rules = [rule({ field: null, effect: 'deny' })]
    expect(canViewField(rules, subject, 'members', 'email')).toBe(false)
    expect(canViewField(rules, subject, 'members', 'birthDate')).toBe(false)
    expect(canViewField(rules, subject, 'contacts', 'email')).toBe(true)
  })

  it('個別項目の明示ルールがマスタ全体の一括設定より優先される（同一レイヤ）', () => {
    const rules = [
      rule({ id: 'r1', field: null, effect: 'deny' }),
      rule({ id: 'r2', field: 'name', effect: 'allow' }),
    ]
    expect(canViewField(rules, subject, 'members', 'name')).toBe(true)
    expect(canViewField(rules, subject, 'members', 'email')).toBe(false)
  })

  it('レイヤ優先は従来どおり: 個人のマスタ全体 allow がロールの個別項目 deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', field: 'email', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', field: null, effect: 'allow' }),
    ]
    expect(canViewField(rules, subject, 'members', 'email')).toBe(true)
  })

  it('ルールが無ければ既定 = 許可（下位互換）', () => {
    expect(canViewField([], subject, 'members', 'email')).toBe(true)
  })
})

describe('stripDeniedFields のマスタ全体 deny', () => {
  const rows = [{ id: 'm-9', name: '田中', email: 'a@example.com', custom: { memo: 'x' } }]

  it('マスタ全体 deny でカタログ全項目が剥がれる（id・カスタム項目 = カタログ外キーは残る）', () => {
    const rules = [rule({ field: null, effect: 'deny' })]
    const [row] = stripDeniedFields(rules, subject, 'members', rows)
    expect(row).toEqual({ id: 'm-9', custom: { memo: 'x' } })
  })

  it('個別項目の allow がマスタ全体 deny の例外になる', () => {
    const rules = [
      rule({ id: 'r1', field: null, effect: 'deny' }),
      rule({ id: 'r2', field: 'name', effect: 'allow' }),
    ]
    const [row] = stripDeniedFields(rules, subject, 'members', rows)
    expect(row).toEqual({ id: 'm-9', name: '田中', custom: { memo: 'x' } })
  })

  it('ルールが無ければ剥がさない（既定 = 許可）', () => {
    expect(stripDeniedFields([], subject, 'members', rows)).toEqual(rows)
  })
})

describe('参照対象の全メンバー一括（member:*）フォールバック', () => {
  it('日報: member:* deny で全対象者が参照不可・個別 allow が例外になる（自分は常に可）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: MEMBER_VIEW_ALL_FIELD, effect: 'deny' }),
      rule({ id: 'r2', resource: 'reports', field: 'member:m-3', effect: 'allow' }),
    ]
    expect(canViewMemberReports(rules, subject, 'm-2')).toBe(false)
    expect(canViewMemberReports(rules, subject, 'm-3')).toBe(true)
    expect(canViewMemberReports(rules, subject, 'm-1')).toBe(true)
  })

  it('AIアシスタント: member:* allow で全対象者が参照可・個別 deny が例外になる', () => {
    const rules = [
      rule({ id: 'r1', resource: 'ai-assistant', field: MEMBER_VIEW_ALL_FIELD, effect: 'allow' }),
      rule({ id: 'r2', resource: 'ai-assistant', field: 'member:m-3', effect: 'deny' }),
    ]
    expect(canViewMemberTaskPlans(rules, subject, 'm-2')).toBe(true)
    expect(canViewMemberTaskPlans(rules, subject, 'm-3')).toBe(false)
  })

  it('レイヤ優先: 個人レイヤの member:* が ロールレイヤの個別明示ルールより優先される', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', resource: 'reports', field: 'member:m-2', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', resource: 'reports', field: MEMBER_VIEW_ALL_FIELD, effect: 'deny' }),
    ]
    expect(canViewMemberReports(rules, subject, 'm-2')).toBe(false)
  })

  it('member:* が無ければ従来どおりの既定（日報 = 参照可 / AIアシスタント = 参照不可）', () => {
    expect(canViewMemberReports([], subject, 'm-2')).toBe(true)
    expect(canViewMemberTaskPlans([], subject, 'm-2')).toBe(false)
  })
})
