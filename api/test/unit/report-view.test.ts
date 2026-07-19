/**
 * 日報の参照対象（バッチ7h: shared/domain/permissions.canViewMemberReports・F-16-6）。
 * resource='reports' + field='member:<対象者>' の deny で対象者の日報を参照不可にする。
 * 未設定 = 参照可（下位互換）・自分は常に参照可・レイヤ解決は canViewField と同一
 */
import { describe, expect, it } from 'vitest'
import { canViewMemberReports, REPORT_MEMBER_FIELD_PREFIX } from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'reports',
    field: p.field ?? `${REPORT_MEMBER_FIELD_PREFIX}m-2`,
    effect: p.effect ?? 'deny',
    active: p.active ?? true,
  } as PermissionRule
}

describe('canViewMemberReports', () => {
  it('未設定 = 参照可（下位互換）・自分は常に参照可', () => {
    expect(canViewMemberReports([], subject, 'm-2')).toBe(true)
    expect(canViewMemberReports([], subject, 'm-1')).toBe(true)
  })

  it('ロールの deny で対象者の日報を参照不可にできる（別対象者は不変）', () => {
    const rules = [rule({ effect: 'deny' })]
    expect(canViewMemberReports(rules, subject, 'm-2')).toBe(false)
    expect(canViewMemberReports(rules, subject, 'm-3')).toBe(true)
  })

  it('自分への deny ルールがあっても自分の日報は常に参照可', () => {
    const rules = [rule({ field: `${REPORT_MEMBER_FIELD_PREFIX}m-1`, effect: 'deny' })]
    expect(canViewMemberReports(rules, subject, 'm-1')).toBe(true)
  })

  it('レイヤ優先: 個人の allow がロールの deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', effect: 'allow' }),
    ]
    expect(canViewMemberReports(rules, subject, 'm-2')).toBe(true)
  })

  it('機能ルール（field=null）や別リソースの deny は影響しない', () => {
    const rules = [
      { ...rule({ id: 'r1' }), field: null } as PermissionRule,
      rule({ id: 'r2', resource: 'attendance' }),
      rule({ id: 'r3', active: false }),
    ]
    expect(canViewMemberReports(rules, subject, 'm-2')).toBe(true)
  })
})
