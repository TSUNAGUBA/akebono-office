/**
 * AI業務アシスタントの参照対象（F-16-7: shared/domain/permissions.canViewMemberTaskPlans）。
 * resource='ai-assistant' + field='member:<対象者>' の allow でその対象者のページを readonly 参照可にする。
 * 日報（canViewMemberReports）との違い = **既定は参照不可（許可制）**・自分は常に参照可・
 * レイヤ解決（個人 > 役職 > ロール・同一レイヤ deny 優先）は canViewField と同一
 */
import { describe, expect, it } from 'vitest'
import { ASSIST_MEMBER_FIELD_PREFIX, canViewMemberTaskPlans } from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'ai-assistant',
    field: p.field ?? `${ASSIST_MEMBER_FIELD_PREFIX}m-2`,
    effect: p.effect ?? 'allow',
    active: p.active ?? true,
  } as PermissionRule
}

describe('canViewMemberTaskPlans', () => {
  it('既定 = 参照不可（許可制）・自分は常に参照可', () => {
    expect(canViewMemberTaskPlans([], subject, 'm-2')).toBe(false)
    expect(canViewMemberTaskPlans([], subject, 'm-1')).toBe(true)
  })

  it('allow ルールで対象者のページを参照可にできる（別対象者は既定どおり参照不可）', () => {
    const rules = [rule({ effect: 'allow' })]
    expect(canViewMemberTaskPlans(rules, subject, 'm-2')).toBe(true)
    expect(canViewMemberTaskPlans(rules, subject, 'm-3')).toBe(false)
  })

  it('自分への deny ルールがあっても自分のページは常に参照可', () => {
    const rules = [rule({ field: `${ASSIST_MEMBER_FIELD_PREFIX}m-1`, effect: 'deny' })]
    expect(canViewMemberTaskPlans(rules, subject, 'm-1')).toBe(true)
  })

  it('レイヤ優先: 個人の deny が役職/ロールの allow を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', effect: 'deny' }),
    ]
    expect(canViewMemberTaskPlans(rules, subject, 'm-2')).toBe(false)
  })

  it('同一レイヤは deny 優先（allow と deny が併存すると参照不可）', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'role', subjectId: 'member', effect: 'deny' }),
    ]
    expect(canViewMemberTaskPlans(rules, subject, 'm-2')).toBe(false)
  })

  it('機能ルール（field=null）・別リソース・無効ルールは参照可否に影響しない（既定 = 参照不可のまま）', () => {
    const rules = [
      { ...rule({ id: 'r1' }), field: null } as PermissionRule,
      rule({ id: 'r2', resource: 'reports' }),
      rule({ id: 'r3', active: false }),
    ]
    expect(canViewMemberTaskPlans(rules, subject, 'm-2')).toBe(false)
  })
})
