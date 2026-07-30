import { describe, expect, it } from 'vitest'
import { normalizeApproverStep, pickApprover, type ApproverCandidate } from '../../../shared/domain/approver'

// 代表的な在籍メンバー（id 昇順で first-match を確認できる構成）
const MEMBERS: ApproverCandidate[] = [
  { id: 'm-01', role: 'admin', title: '代表取締役', active: true },
  { id: 'm-02', role: 'admin', title: '取締役', active: true },
  { id: 'm-03', role: 'admin', title: 'マネージャー', active: true },
  { id: 'm-06', role: 'member', title: 'メンバー', active: true },
  { id: 'm-10', role: 'hr', title: '人事・労務', active: true },
]

describe('pickApprover（役職/ロール/個人の承認者解決）', () => {
  it('title: 役職ラベル一致の在籍者を返す', () => {
    expect(pickApprover(MEMBERS, { approverType: 'title', approverTitle: '取締役' })?.id).toBe('m-02')
  })
  it('role: ロール一致の在籍者を id 昇順の先頭で返す', () => {
    expect(pickApprover(MEMBERS, { approverType: 'role', approverRole: 'hr' })?.id).toBe('m-10')
    expect(pickApprover(MEMBERS, { approverType: 'role', approverRole: 'admin' })?.id).toBe('m-01')
  })
  it('member: 個人指定を尊重する', () => {
    expect(pickApprover(MEMBERS, { approverType: 'member', approverMemberId: 'm-03' })?.id).toBe('m-03')
  })
  it('該当なしは任意の管理者へフォールバック（承認の行き止まりを避ける）', () => {
    expect(pickApprover(MEMBERS, { approverType: 'title', approverTitle: '存在しない役職' })?.id).toBe('m-01')
  })
  it('不在メンバーの個人指定も管理者へフォールバック', () => {
    const withInactive: ApproverCandidate[] = [...MEMBERS, { id: 'm-99', role: 'member', title: 'x', active: false }]
    expect(pickApprover(withInactive, { approverType: 'member', approverMemberId: 'm-99' })?.id).toBe('m-01')
  })
})

describe('normalizeApproverStep（旧形式 → 新形式の行動保存的マッピング）', () => {
  it('旧 approverRole を役職/ロールへ移す', () => {
    expect(normalizeApproverStep({ approverRole: 'president' })).toMatchObject({ type: 'title', title: '代表取締役' })
    expect(normalizeApproverStep({ approverRole: 'director' })).toMatchObject({ type: 'title', title: '取締役' })
    expect(normalizeApproverStep({ approverRole: 'manager' })).toMatchObject({ type: 'title', title: 'マネージャー' })
    expect(normalizeApproverStep({ approverRole: 'hr' })).toMatchObject({ type: 'role', role: 'hr' })
  })
  it('旧 approverMemberId 指定は個人扱い', () => {
    expect(normalizeApproverStep({ approverRole: 'manager', approverMemberId: 'm-05' })).toMatchObject({ type: 'member', memberId: 'm-05' })
  })
  it('旧形式でも pickApprover が同じ承認者を解決する（下位互換）', () => {
    expect(pickApprover(MEMBERS, { approverRole: 'manager' })?.id).toBe('m-03') // = 役職マネージャー
    expect(pickApprover(MEMBERS, { approverRole: 'president' })?.id).toBe('m-01')
    expect(pickApprover(MEMBERS, { approverRole: 'hr' })?.id).toBe('m-10')
  })
})
