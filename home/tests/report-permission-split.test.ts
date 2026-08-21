/**
 * 週報・月報の機能キー独立（改修依頼 2026-08-20 第2バッチ → 旧キー継承の撤去 2026-08-21）。
 * shared/domain/permissions.ts の resolveFeatureResource / resolveTabPermission が SoT
 * （フロント usePermissions.can / canTab と API featureGuard の両方が同じ関数を通る）。
 *
 * 当初あった「新キーの明示ルールが無い間は旧 'reports' 設定を継承する」動的フォールバックは、
 * 旧キーの deny が権限管理画面に見えず解除もできない実バグ（権限表は ✓ なのに週報のタブが出ない）
 * の原因となったため撤去した。旧ルールはマイグレーション 0078 で新キーへ物理移行される。
 * 本テストは「旧 'reports' ルールが新キーの判定へ漏れ出さない = 権限表に見えるものが実効」を固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  canUseFeature, canUseTab, featureKeyOfPath, resolveFeatureResource, resolveTabPermission,
} from '../../shared/domain/permissions'
import type { PermissionRule } from '../../shared/domain/types'

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

/** フロント usePermissions.can / API featureGuard と同じ合成（解決 → canUseFeature） */
function canFeature(rules: PermissionRule[], resource: string): boolean {
  return canUseFeature(rules, subject, resolveFeatureResource(rules, resource))
}

/** フロント usePermissions.canTab と同じ合成（解決 → canUseTab） */
function canTab(rules: PermissionRule[], resource: string, tabKey: string): boolean {
  const eff = resolveTabPermission(rules, resource, tabKey)
  return canUseTab(rules, subject, eff.resource, eff.tabKey)
}

describe('featureKeyOfPath: 週報・月報の独立パス', () => {
  it('新パスは独立キーへ解決する', () => {
    expect(featureKeyOfPath('/weekly-report')).toBe('weekly-report')
    expect(featureKeyOfPath('/monthly-report')).toBe('monthly-report')
    expect(featureKeyOfPath('/weekly-report?tab=all')).toBe('weekly-report')
  })

  it('日報は従来どおり reports（旧クエリ付きも同じ）', () => {
    expect(featureKeyOfPath('/reports')).toBe('reports')
    expect(featureKeyOfPath('/reports?kind=weekly')).toBe('reports') // 旧 URL はページ側でリダイレクト
  })
})

describe('resolveFeatureResource / resolveTabPermission: 旧キー継承の撤去（素通し）', () => {
  it('ルールの有無にかかわらずキーをそのまま返す（0078 で物理移行済みの前提）', () => {
    expect(resolveFeatureResource([], 'weekly-report')).toBe('weekly-report')
    expect(resolveFeatureResource([], 'monthly-report')).toBe('monthly-report')
    expect(resolveFeatureResource([rule({ resource: 'reports' })], 'weekly-report')).toBe('weekly-report')
    expect(resolveFeatureResource([], 'reports')).toBe('reports')
    expect(resolveFeatureResource([], 'attendance')).toBe('attendance')
    expect(resolveTabPermission([], 'weekly-report', 'mine'))
      .toEqual({ resource: 'weekly-report', tabKey: 'mine' })
    expect(resolveTabPermission([rule({ resource: 'reports', field: 'tab:weekly-mine' })], 'weekly-report', 'mine'))
      .toEqual({ resource: 'weekly-report', tabKey: 'mine' })
  })
})

describe('機能利用可否: 週報・月報は独立制御（旧 reports ルールは漏れ出さない）', () => {
  it('旧 reports の機能 deny は日報のみに効く（週報・月報へは 0078 が複製済みの前提）', () => {
    const rules = [rule({ resource: 'reports', effect: 'deny' })]
    expect(canFeature(rules, 'reports')).toBe(false)
    expect(canFeature(rules, 'weekly-report')).toBe(true)
    expect(canFeature(rules, 'monthly-report')).toBe(true)
  })

  it('新キーの deny で週報だけを止められる（日報は従来どおり）', () => {
    const rules = [rule({ resource: 'weekly-report', effect: 'deny' })]
    expect(canFeature(rules, 'weekly-report')).toBe(false)
    expect(canFeature(rules, 'reports')).toBe(true)
    expect(canFeature(rules, 'monthly-report')).toBe(true)
  })

  it('ルールが無ければ既定 allow', () => {
    expect(canFeature([], 'weekly-report')).toBe(true)
    expect(canFeature([], 'monthly-report')).toBe(true)
  })
})

describe('タブ権限: 週報・月報のタブは新キーのルールだけで決まる', () => {
  it('旧 reports の tab:weekly-* deny が残っていても週報のタブには効かない（バグの再発防止）', () => {
    // 権限表に表示されない旧形式ルール。0078 移行後は存在しないが、万一残っていても判定を汚さない
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: 'tab:weekly-all', effect: 'deny' }),
      rule({ id: 'r2', resource: 'reports', field: 'tab:monthly-team', effect: 'deny' }),
    ]
    expect(canTab(rules, 'weekly-report', 'all')).toBe(true)
    expect(canTab(rules, 'monthly-report', 'team')).toBe(true)
    // 日報側のタブキーは別キーのため従来どおり影響なし
    expect(canTab(rules, 'reports', 'mine')).toBe(true)
  })

  it('新キーのタブ deny が効く（権限表で見える・解除できるルールと実効が一致）', () => {
    const rules = [rule({ resource: 'weekly-report', field: 'tab:team', effect: 'deny' })]
    expect(canTab(rules, 'weekly-report', 'team')).toBe(false)
    expect(canTab(rules, 'weekly-report', 'mine')).toBe(true)
    expect(canTab(rules, 'weekly-report', 'all')).toBe(true)
  })

  it('新キーの機能全体 deny はタブにも効く（field=null フォールバックは機能キー内で維持）', () => {
    const rules = [rule({ resource: 'monthly-report', field: null, effect: 'deny' })]
    expect(canTab(rules, 'monthly-report', 'mine')).toBe(false)
    expect(canTab(rules, 'monthly-report', 'all')).toBe(false)
  })
})
