/**
 * AI 参照範囲の解決（バッチ7g: shared/domain/permissions.aiReferenceScope）。
 * レイヤ優先（個人 > 役職 > ロール）・同一レイヤ deny（自分のみ）優先・未設定は区分ごとの既定値
 */
import { describe, expect, it } from 'vitest'
import { aiReferenceScope, AI_SCOPE_FIELD } from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'poipoi',
    field: AI_SCOPE_FIELD,
    effect: p.effect ?? 'deny',
    active: p.active ?? true,
  } as PermissionRule
}

describe('aiReferenceScope', () => {
  it('未設定の既定: poipoi = all / attendance・ai-assistant = own / 未知の区分 = own（安全側）', () => {
    expect(aiReferenceScope([], subject, 'poipoi')).toBe('all')
    expect(aiReferenceScope([], subject, 'attendance')).toBe('own')
    expect(aiReferenceScope([], subject, 'ai-assistant')).toBe('own')
    expect(aiReferenceScope([], subject, 'unknown-domain')).toBe('own')
  })

  it('ロールの deny（自分のみ）で既定 all を制限できる', () => {
    expect(aiReferenceScope([rule({ effect: 'deny' })], subject, 'poipoi')).toBe('own')
  })

  it('レイヤ優先: 個人の allow がロールの deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', effect: 'allow' }),
    ]
    expect(aiReferenceScope(rules, subject, 'poipoi')).toBe('all')
  })

  it('同一レイヤに allow と deny が併存する場合は deny（自分のみ）優先', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'title', subjectId: '主任', effect: 'allow' }),
      rule({ id: 'r2', subjectKind: 'title', subjectId: '主任', effect: 'deny' }),
    ]
    expect(aiReferenceScope(rules, subject, 'attendance')).toBe('own')
  })

  it('無効ルール・別フィールド（機能 deny）・別対象は影響しない', () => {
    const rules = [
      rule({ id: 'r1', effect: 'deny', active: false }),
      { ...rule({ id: 'r2', effect: 'deny' }), field: null } as PermissionRule, // 機能ルール
      rule({ id: 'r3', subjectId: 'hr', effect: 'deny' }),
    ]
    expect(aiReferenceScope(rules, subject, 'poipoi')).toBe('all')
  })
})
