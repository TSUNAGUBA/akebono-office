/**
 * 顧客ログの参照対象（shared/domain/permissions.canViewMemberCustomerLog）。
 * resource='customer-log' + field='member:<対象者>' の allow でその対象者のログを readonly 参照可にする。
 * AI業務アシスタント（canViewMemberTaskPlans）と同型 = **既定は参照不可（許可制）**・自分は常に参照可・
 * レイヤ解決（個人 > 役職 > ロール・同一レイヤ deny 優先）は canViewField と同一
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_LOG_MEMBER_FIELD_PREFIX, MEMBER_VIEW_ALL_FIELD, canViewMemberCustomerLog,
} from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'customer-log',
    field: p.field ?? `${CUSTOMER_LOG_MEMBER_FIELD_PREFIX}m-2`,
    effect: p.effect ?? 'allow',
    active: p.active ?? true,
  } as PermissionRule
}

describe('canViewMemberCustomerLog', () => {
  it('既定 = 参照不可（許可制）・自分は常に参照可', () => {
    expect(canViewMemberCustomerLog([], subject, 'm-2')).toBe(false)
    expect(canViewMemberCustomerLog([], subject, 'm-1')).toBe(true)
  })

  it('allow ルールで対象者のログを参照可にできる（別対象者は既定どおり参照不可）', () => {
    const rules = [rule({ effect: 'allow' })]
    expect(canViewMemberCustomerLog(rules, subject, 'm-2')).toBe(true)
    expect(canViewMemberCustomerLog(rules, subject, 'm-3')).toBe(false)
  })

  it('自分への deny ルールがあっても自分のログは常に参照可', () => {
    const rules = [rule({ field: `${CUSTOMER_LOG_MEMBER_FIELD_PREFIX}m-1`, effect: 'deny' })]
    expect(canViewMemberCustomerLog(rules, subject, 'm-1')).toBe(true)
  })

  it('全メンバー一括（member:*）allow で個別指定なしの対象者も参照可になる', () => {
    const rules = [rule({ field: MEMBER_VIEW_ALL_FIELD, effect: 'allow' })]
    expect(canViewMemberCustomerLog(rules, subject, 'm-2')).toBe(true)
    // 個別 deny は一括 allow より優先（明示キー → 一括キーの順で確定）
    const withOverride = [...rules, rule({ id: 'r2', field: `${CUSTOMER_LOG_MEMBER_FIELD_PREFIX}m-2`, effect: 'deny' })]
    expect(canViewMemberCustomerLog(withOverride, subject, 'm-2')).toBe(false)
    expect(canViewMemberCustomerLog(withOverride, subject, 'm-3')).toBe(true)
  })

  it('レイヤ優先: 個人の deny が役職/ロールの allow を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', effect: 'deny' }),
    ]
    expect(canViewMemberCustomerLog(rules, subject, 'm-2')).toBe(false)
  })

  it('同一レイヤは deny 優先（allow と deny が併存すると参照不可）', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'role', subjectId: 'member', effect: 'deny' }),
    ]
    expect(canViewMemberCustomerLog(rules, subject, 'm-2')).toBe(false)
  })

  it('機能ルール（field=null）・別リソース・無効ルールは参照可否に影響しない（既定 = 参照不可のまま）', () => {
    const rules = [
      { ...rule({ id: 'r1' }), field: null } as PermissionRule,
      rule({ id: 'r2', resource: 'ai-assistant' }),
      rule({ id: 'r3', active: false }),
    ]
    expect(canViewMemberCustomerLog(rules, subject, 'm-2')).toBe(false)
  })
})
