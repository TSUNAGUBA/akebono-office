/**
 * 権限設定の拡張（改修依頼 2026-08-18: メニュー＞タブ＞項目＞参照/更新 の階層制御 + AIの参照範囲）。
 * - canUseTab: タブ利用可否（`tab:<key>` 擬似フィールド。既定 allow・機能全体〔field=null〕へフォールバック）
 * - canEditField / stripDeniedWriteKeys: 項目の更新権限（`<項目>:write`。参照＞更新の階層）
 * - canAiReferenceOwner / aiAllowedOwnerIds: 登録者単位の AI 参照対象（`ai-scope:<対象>`。
 *   既定 = 権限表の参照権限・レガシー二値 'ai-scope' との解決順）
 */
import { describe, expect, it } from 'vitest'
import {
  aiAllowedOwnerIds, canAiReferenceOwner, canEditField, canUseTab,
  canViewField, stripDeniedWriteKeys,
} from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'

const subject = { memberId: 'm-1', title: '主任', role: 'member' as const }

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r1',
    subjectKind: p.subjectKind ?? 'role',
    subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'reports',
    field: p.field === undefined ? null : p.field,
    effect: p.effect ?? 'deny',
    active: p.active ?? true,
  } as PermissionRule
}

describe('canUseTab（タブ利用可否）', () => {
  it('ルール未設定は既定 allow（下位互換 = 全タブ表示）', () => {
    expect(canUseTab([], subject, 'reports', 'all')).toBe(true)
  })

  it('tab:<key> の deny で当該タブのみ利用不可になる', () => {
    const rules = [rule({ resource: 'reports', field: 'tab:all', effect: 'deny' })]
    expect(canUseTab(rules, subject, 'reports', 'all')).toBe(false)
    expect(canUseTab(rules, subject, 'reports', 'mine')).toBe(true)
    expect(canUseTab(rules, subject, 'workflow', 'all')).toBe(true) // 別機能は影響なし
  })

  it('機能全体（field=null）の deny がタブへフォールバックする（項目と同型）', () => {
    const rules = [rule({ resource: 'reports', field: null, effect: 'deny' })]
    expect(canUseTab(rules, subject, 'reports', 'team')).toBe(false)
  })

  it('明示の tab allow が機能全体 deny より優先される（同一レイヤ内の明示 → 一括の順）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: null, effect: 'deny' }),
      rule({ id: 'r2', resource: 'reports', field: 'tab:mine', effect: 'allow' }),
    ]
    expect(canUseTab(rules, subject, 'reports', 'mine')).toBe(true)
    expect(canUseTab(rules, subject, 'reports', 'all')).toBe(false)
  })

  it('レイヤ優先: 個人の allow がロールの deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', resource: 'shift', field: 'tab:wish', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', resource: 'shift', field: 'tab:wish', effect: 'allow' }),
    ]
    expect(canUseTab(rules, subject, 'shift', 'wish')).toBe(true)
  })

  it('無効化済みルールは判定から除外される（取消フロー）', () => {
    const rules = [rule({ resource: 'reports', field: 'tab:all', effect: 'deny', active: false })]
    expect(canUseTab(rules, subject, 'reports', 'all')).toBe(true)
  })
})

describe('canEditField（項目の更新権限 = 参照＞更新の階層）', () => {
  it('ルール未設定は既定 allow（参照できる項目は更新もできる = 下位互換）', () => {
    expect(canEditField([], subject, 'members', 'email')).toBe(true)
  })

  it('<項目>:write の deny で更新のみ不可になる（参照は可のまま）', () => {
    const rules = [rule({ resource: 'members', field: 'email:write', effect: 'deny' })]
    expect(canEditField(rules, subject, 'members', 'email')).toBe(false)
    expect(canViewField(rules, subject, 'members', 'email')).toBe(true)
    expect(canEditField(rules, subject, 'members', 'name')).toBe(true) // 他項目は影響なし
  })

  it('参照 deny の項目は :write の allow があっても更新不可（参照＞更新）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'members', field: 'email', effect: 'deny' }),
      rule({ id: 'r2', resource: 'members', field: 'email:write', effect: 'allow' }),
    ]
    expect(canEditField(rules, subject, 'members', 'email')).toBe(false)
  })

  it('マスタ全体（field=null）の deny は参照経由で更新も閉じる', () => {
    const rules = [rule({ resource: 'members', field: null, effect: 'deny' })]
    expect(canEditField(rules, subject, 'members', 'email')).toBe(false)
  })

  it('レイヤ優先: 個人の :write allow がロールの :write deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', resource: 'members', field: 'email:write', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', resource: 'members', field: 'email:write', effect: 'allow' }),
    ]
    expect(canEditField(rules, subject, 'members', 'email')).toBe(true)
  })
})

describe('stripDeniedWriteKeys（更新 body の剥がし）', () => {
  it('更新不可の項目キーのみ取り除く（他キーは保持 = 部分更新の回帰）', () => {
    const rules = [rule({ resource: 'members', field: 'email:write', effect: 'deny' })]
    const body = { email: 'x@example.com', name: '山田', departmentId: 'd-1' }
    expect(stripDeniedWriteKeys(rules, subject, 'members', body))
      .toEqual({ name: '山田', departmentId: 'd-1' })
  })

  it('ルール未設定なら body をそのまま返す（既存データ・既存 I/F へ影響なし）', () => {
    const body = { email: 'x@example.com' }
    expect(stripDeniedWriteKeys([], subject, 'members', body)).toBe(body)
  })

  it('カタログ外キー（id 等）は制御対象外 = マスタ全体 deny でも剥がれない', () => {
    const rules = [rule({ resource: 'members', field: null, effect: 'deny' })]
    const body = { id: 'm-9', email: 'x@example.com' }
    expect(stripDeniedWriteKeys(rules, subject, 'members', body)).toEqual({ id: 'm-9' })
  })

  it('ルールで名指しされたカタログ外キーは制御対象になる', () => {
    const rules = [rule({ resource: 'members', field: 'customNote:write', effect: 'deny' })]
    const body = { customNote: 'x', name: '山田' }
    expect(stripDeniedWriteKeys(rules, subject, 'members', body)).toEqual({ name: '山田' })
  })

  it('全キーが更新不可なら空オブジェクトになる（403 の判定は呼び出し側）', () => {
    const rules = [rule({ resource: 'members', field: null, effect: 'deny' })]
    expect(stripDeniedWriteKeys(rules, subject, 'members', { email: 'x', name: 'y' })).toEqual({})
  })
})

describe('canAiReferenceOwner（登録者単位の AI 参照対象）', () => {
  const owner = { memberId: 'm-2', title: '部長', role: 'member' as const }

  it('自分の登録データは常に参照可（設定ミス保護）', () => {
    const rules = [rule({ resource: 'poipoi', field: 'ai-scope:*', effect: 'deny' })]
    expect(canAiReferenceOwner(rules, subject, 'poipoi', subject)).toBe(true)
  })

  it('既定（ルールなし）: poipoi = 参照可 / attendance = 本人のみ（レガシー既定と同値）', () => {
    expect(canAiReferenceOwner([], subject, 'poipoi', owner)).toBe(true)
    expect(canAiReferenceOwner([], subject, 'attendance', owner)).toBe(false)
  })

  it('既定（ルールなし）: reports = 日報参照権限（既定 参照可・member deny で不可）に揃う', () => {
    expect(canAiReferenceOwner([], subject, 'reports', owner)).toBe(true)
    const denyView = [rule({ resource: 'reports', field: 'member:m-2', effect: 'deny' })]
    expect(canAiReferenceOwner(denyView, subject, 'reports', owner)).toBe(false)
  })

  it('既定（ルールなし）: ai-assistant = タスク計画の参照権限（許可制）に揃う', () => {
    expect(canAiReferenceOwner([], subject, 'ai-assistant', owner)).toBe(false)
    const allowView = [rule({ resource: 'ai-assistant', field: 'member:m-2', effect: 'allow' })]
    expect(canAiReferenceOwner(allowView, subject, 'ai-assistant', owner)).toBe(true)
  })

  it('個人指定 > 役職指定 > ロール指定 > 全メンバー一括 の順で解決する（同一レイヤ内）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'poipoi', field: 'ai-scope:*', effect: 'allow' }),
      rule({ id: 'r2', resource: 'poipoi', field: 'ai-scope:role:member', effect: 'allow' }),
      rule({ id: 'r3', resource: 'poipoi', field: 'ai-scope:title:部長', effect: 'allow' }),
      rule({ id: 'r4', resource: 'poipoi', field: 'ai-scope:member:m-2', effect: 'deny' }),
    ]
    expect(canAiReferenceOwner(rules, subject, 'poipoi', owner)).toBe(false) // 個人指定 deny が最優先
    const titleOnly = rules.slice(0, 3)
    expect(canAiReferenceOwner(titleOnly, subject, 'poipoi', owner)).toBe(true)
  })

  it('役職なし（title 空）の登録者には役職指定ルールが効かない', () => {
    const noTitleOwner = { memberId: 'm-3', title: '', role: 'member' as const }
    const rules = [rule({ resource: 'attendance', field: 'ai-scope:title:', effect: 'allow' })]
    expect(canAiReferenceOwner(rules, subject, 'attendance', noTitleOwner)).toBe(false) // 既定 own のまま
  })

  it('レガシー二値（ai-scope）は明示対象キーが無い場合のフォールバックとして働く', () => {
    const legacyAllow = [rule({ resource: 'attendance', field: 'ai-scope', effect: 'allow' })]
    expect(canAiReferenceOwner(legacyAllow, subject, 'attendance', owner)).toBe(true)
    const rules = [
      rule({ id: 'r1', resource: 'attendance', field: 'ai-scope', effect: 'allow' }),
      rule({ id: 'r2', resource: 'attendance', field: 'ai-scope:member:m-2', effect: 'deny' }),
    ]
    expect(canAiReferenceOwner(rules, subject, 'attendance', owner)).toBe(false) // 対象指定が優先
  })

  it('レイヤ優先: 個人（参照者）の allow がロールの deny を上書きする', () => {
    const rules = [
      rule({ id: 'r1', subjectKind: 'role', subjectId: 'member', resource: 'poipoi', field: 'ai-scope:*', effect: 'deny' }),
      rule({ id: 'r2', subjectKind: 'member', subjectId: 'm-1', resource: 'poipoi', field: 'ai-scope:member:m-2', effect: 'allow' }),
    ]
    expect(canAiReferenceOwner(rules, subject, 'poipoi', owner)).toBe(true)
  })
})

describe('aiAllowedOwnerIds（参照可能な登録者の一覧）', () => {
  const owners = [
    { memberId: 'm-1', title: '主任', role: 'member' as const },
    { memberId: 'm-2', title: '部長', role: 'member' as const },
    { memberId: 'm-3', title: '', role: 'hr' as const },
  ]

  it('既定: poipoi は全員・attendance は本人のみ', () => {
    expect(aiAllowedOwnerIds([], subject, 'poipoi', owners)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(aiAllowedOwnerIds([], subject, 'attendance', owners)).toEqual(['m-1'])
  })

  it('ロール指定 allow で該当登録者だけ広がる（本人は常に含む）', () => {
    const rules = [rule({ resource: 'attendance', field: 'ai-scope:role:hr', effect: 'allow' })]
    expect(aiAllowedOwnerIds(rules, subject, 'attendance', owners)).toEqual(['m-1', 'm-3'])
  })

  it('owners に本人が居なくても結果へ本人を補完する', () => {
    expect(aiAllowedOwnerIds([], subject, 'attendance', owners.slice(1))).toEqual(['m-1'])
  })
})
