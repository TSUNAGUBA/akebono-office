/**
 * 全員のタイムカードの参照権限（shared/domain/permissions.ts canViewAllTimecards）。
 * 既定 = 管理者/人事のみ参照可（従来ロールガードと同値 = 下位互換）・権限表の明示ルールで変更可
 */
import { describe, expect, it } from 'vitest'
import {
  canViewAllTimecards, TIMECARD_ALL_FIELD, timecardAllDefault,
} from '../../shared/domain/permissions'
import type { PermissionRule } from '../../shared/domain/types'

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: 'pm-test', subjectKind: 'role', subjectId: 'member',
    resource: 'attendance', field: TIMECARD_ALL_FIELD, effect: 'allow', active: true,
    ...p,
  }
}

const admin = { memberId: 'm-01', title: '', role: 'admin' as const }
const hr = { memberId: 'm-02', title: '', role: 'hr' as const }
const member = { memberId: 'm-03', title: 'コンサルタント', role: 'member' as const }

describe('canViewAllTimecards', () => {
  it('ルール未設定の既定は管理者/人事のみ参照可（下位互換）', () => {
    expect(canViewAllTimecards([], admin)).toBe(true)
    expect(canViewAllTimecards([], hr)).toBe(true)
    expect(canViewAllTimecards([], member)).toBe(false)
    expect(timecardAllDefault('admin')).toBe(true)
    expect(timecardAllDefault('hr')).toBe(true)
    expect(timecardAllDefault('member')).toBe(false)
  })

  it('ロールへの allow で一般メンバーに参照を付与できる', () => {
    const rules = [rule({ subjectKind: 'role', subjectId: 'member', effect: 'allow' })]
    expect(canViewAllTimecards(rules, member)).toBe(true)
  })

  it('個人への allow は対象者のみに効く', () => {
    const rules = [rule({ subjectKind: 'member', subjectId: 'm-03', effect: 'allow' })]
    expect(canViewAllTimecards(rules, member)).toBe(true)
    expect(canViewAllTimecards(rules, { ...member, memberId: 'm-99' })).toBe(false)
  })

  it('人事ロールへの deny で既定の参照を剥奪できる', () => {
    const rules = [rule({ subjectKind: 'role', subjectId: 'hr', effect: 'deny' })]
    expect(canViewAllTimecards(rules, hr)).toBe(false)
    expect(canViewAllTimecards(rules, admin)).toBe(true) // 他ロールへは波及しない
  })

  it('レイヤ優先: 個人の allow はロールの deny を上書きする', () => {
    const rules = [
      rule({ id: 'pm-1', subjectKind: 'role', subjectId: 'member', effect: 'deny' }),
      rule({ id: 'pm-2', subjectKind: 'member', subjectId: 'm-03', effect: 'allow' }),
    ]
    expect(canViewAllTimecards(rules, member)).toBe(true)
  })

  it('無効化（論理削除）されたルールは判定に影響しない', () => {
    const rules = [rule({ subjectKind: 'role', subjectId: 'member', effect: 'allow', active: false })]
    expect(canViewAllTimecards(rules, member)).toBe(false)
  })

  it('別フィールド（機能全体等）のルールは timecard-all の判定に影響しない', () => {
    const rules = [rule({ field: null, effect: 'deny' })]
    expect(canViewAllTimecards(rules, admin)).toBe(true)
  })
})
