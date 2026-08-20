/**
 * 週報・月報の機能キー独立と旧 'reports' キー互換フォールバック（改修依頼 2026-08-20 第2バッチ）。
 * shared/domain/permissions.ts の resolveFeatureResource / resolveTabPermission が SoT
 * （フロント usePermissions.can / canTab と API featureGuard の両方が同じ関数を通る）。
 * - 新キー（weekly-report / monthly-report）の明示ルールが 1 件も無い間は旧 'reports' 設定を継承
 * - 新キーのルールを設定した時点で独立制御（旧 reports ルールは以後参照しない）
 * - タブ権限も同様（旧 reports の tab:weekly-mine 等 → 新リソース/tab:mine へ写像）
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

describe('resolveFeatureResource: 機能キーのフォールバック', () => {
  it('新キーのルールが無ければ旧 reports へフォールバックする', () => {
    expect(resolveFeatureResource([], 'weekly-report')).toBe('reports')
    expect(resolveFeatureResource([], 'monthly-report')).toBe('reports')
  })

  it('新キーの active なルールが 1 件でもあれば独立制御（タブルールでも切り替わる）', () => {
    const rules = [rule({ resource: 'weekly-report', field: 'tab:mine', effect: 'deny' })]
    expect(resolveFeatureResource(rules, 'weekly-report')).toBe('weekly-report')
    // monthly は別リソース = 引き続き旧 reports を継承
    expect(resolveFeatureResource(rules, 'monthly-report')).toBe('reports')
  })

  it('inactive なルールは切替条件に数えない', () => {
    const rules = [rule({ resource: 'weekly-report', active: false })]
    expect(resolveFeatureResource(rules, 'weekly-report')).toBe('reports')
  })

  it('対象外のキーはそのまま返す', () => {
    expect(resolveFeatureResource([], 'reports')).toBe('reports')
    expect(resolveFeatureResource([], 'attendance')).toBe('attendance')
  })
})

describe('機能利用可否: 旧 reports 設定の継承と独立', () => {
  it('旧 reports の deny が新キー未設定の間は週報・月報にも効く（下位互換）', () => {
    const rules = [rule({ resource: 'reports', effect: 'deny' })]
    expect(canFeature(rules, 'reports')).toBe(false)
    expect(canFeature(rules, 'weekly-report')).toBe(false)
    expect(canFeature(rules, 'monthly-report')).toBe(false)
  })

  it('新キーの allow を設定すると独立制御になる（旧 reports の deny を引き継がない）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', effect: 'deny' }),
      rule({ id: 'r2', resource: 'weekly-report', effect: 'allow' }),
    ]
    expect(canFeature(rules, 'weekly-report')).toBe(true)
    expect(canFeature(rules, 'reports')).toBe(false)
    expect(canFeature(rules, 'monthly-report')).toBe(false) // monthly は継承のまま
  })

  it('新キーの deny で週報だけを止められる（日報は従来どおり）', () => {
    const rules = [rule({ resource: 'weekly-report', effect: 'deny' })]
    expect(canFeature(rules, 'weekly-report')).toBe(false)
    expect(canFeature(rules, 'reports')).toBe(true)
    expect(canFeature(rules, 'monthly-report')).toBe(true)
  })

  it('ルールが無ければ既定 allow（下位互換）', () => {
    expect(canFeature([], 'weekly-report')).toBe(true)
    expect(canFeature([], 'monthly-report')).toBe(true)
  })
})

describe('タブ権限: 旧 reports の tab:weekly-* / tab:monthly-* の継承と独立', () => {
  it('旧 reports の tab:weekly-mine deny が新 weekly-report/tab:mine として効く', () => {
    const rules = [rule({ resource: 'reports', field: 'tab:weekly-mine', effect: 'deny' })]
    expect(resolveTabPermission(rules, 'weekly-report', 'mine'))
      .toEqual({ resource: 'reports', tabKey: 'weekly-mine' })
    expect(canTab(rules, 'weekly-report', 'mine')).toBe(false)
    expect(canTab(rules, 'weekly-report', 'all')).toBe(true)
    // 日報側のタブキーは衝突しない（reports/tab:mine は別キー）
    expect(canTab(rules, 'reports', 'mine')).toBe(true)
  })

  it('旧 reports の tab:monthly-team deny が新 monthly-report/tab:team として効く', () => {
    const rules = [rule({ resource: 'reports', field: 'tab:monthly-team', effect: 'deny' })]
    expect(canTab(rules, 'monthly-report', 'team')).toBe(false)
    expect(canTab(rules, 'monthly-report', 'mine')).toBe(true)
  })

  it('新キーのルールを設定した時点でタブも独立制御（旧 reports のタブ deny は引き継がない）', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: 'tab:weekly-mine', effect: 'deny' }),
      rule({ id: 'r2', resource: 'weekly-report', field: 'tab:team', effect: 'deny' }),
    ]
    expect(resolveTabPermission(rules, 'weekly-report', 'mine'))
      .toEqual({ resource: 'weekly-report', tabKey: 'mine' })
    expect(canTab(rules, 'weekly-report', 'mine')).toBe(true) // 旧 deny は参照しない
    expect(canTab(rules, 'weekly-report', 'team')).toBe(false) // 新キーの deny が効く
  })

  it('旧 reports の機能全体 deny は新キー未設定の間タブにも効く（field=null フォールバック）', () => {
    const rules = [rule({ resource: 'reports', field: null, effect: 'deny' })]
    expect(canTab(rules, 'weekly-report', 'mine')).toBe(false)
    expect(canTab(rules, 'monthly-report', 'all')).toBe(false)
  })
})
