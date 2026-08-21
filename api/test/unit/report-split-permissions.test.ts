/**
 * 週報・月報の機能キー独立（改修依頼 2026-08-20 第2バッチ → 旧キー継承の撤去 2026-08-21）。
 * API 側の観点: featureGuard は PATH_FEATURES（/v1/reports/weekly → weekly-report 等）で機能キーを
 * 引いたあと、resolveFeatureResource（shared/domain/permissions.ts = フロント usePermissions と共通）を
 * 通してから canUseFeature を評価する。旧 'reports' の動的継承は権限管理画面から見えない deny を
 * 生む実バグの原因だったため撤去され、旧ルールはマイグレーション 0078 で新キーへ物理移行された。
 * 本テストは「旧 'reports' ルールが週報・月報の API 判定へ漏れ出さない」ことを固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  canUseFeature, canUseTab, reportReadsFeatureKey, resolveFeatureResource, resolveTabPermission,
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

/** featureGuard と同じ合成（resolveFeatureResource → canUseFeature） */
function guardAllows(rules: PermissionRule[], featureKey: string): boolean {
  return canUseFeature(rules, subject, resolveFeatureResource(rules, featureKey))
}

describe('featureGuard の実効リソース解決（週報・月報の独立制御）', () => {
  it('旧 reports の deny は日報 API のみに効く（週報・月報へは 0078 が複製済みの前提）', () => {
    const rules = [rule({ resource: 'reports', effect: 'deny' })]
    expect(guardAllows(rules, 'reports')).toBe(false) // /v1/reports/daily・reads・remind
    expect(guardAllows(rules, 'weekly-report')).toBe(true) // GET/PUT /v1/reports/weekly・weekly-insight
    expect(guardAllows(rules, 'monthly-report')).toBe(true) // GET/PUT /v1/reports/monthly
  })

  it('新キーの deny で週報 API だけを止められる（日報 API は従来どおり）', () => {
    const rules = [rule({ resource: 'weekly-report', effect: 'deny' })]
    expect(guardAllows(rules, 'weekly-report')).toBe(false)
    expect(guardAllows(rules, 'reports')).toBe(true)
    expect(guardAllows(rules, 'monthly-report')).toBe(true)
  })

  it('ルールが無ければ既定 allow（featureGuard は rules.length === 0 で素通し = 同値）', () => {
    expect(guardAllows([], 'weekly-report')).toBe(true)
    expect(guardAllows([], 'monthly-report')).toBe(true)
  })
})

describe('タブ権限（resolveTabPermission = 素通し）', () => {
  it('旧 reports の tab:weekly-* / tab:monthly-* は週報・月報のタブ判定に影響しない', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: 'tab:weekly-all', effect: 'deny' }),
      rule({ id: 'r2', resource: 'reports', field: 'tab:monthly-mine', effect: 'deny' }),
    ]
    const wk = resolveTabPermission(rules, 'weekly-report', 'all')
    expect(wk).toEqual({ resource: 'weekly-report', tabKey: 'all' })
    expect(canUseTab(rules, subject, wk.resource, wk.tabKey)).toBe(true)
    const mo = resolveTabPermission(rules, 'monthly-report', 'mine')
    expect(canUseTab(rules, subject, mo.resource, mo.tabKey)).toBe(true)
  })

  it('新キーのタブ deny が効く（権限表に見えるルール = 実効ルール）', () => {
    const rules = [rule({ resource: 'weekly-report', field: 'tab:mine', effect: 'deny' })]
    const eff = resolveTabPermission(rules, 'weekly-report', 'mine')
    expect(eff).toEqual({ resource: 'weekly-report', tabKey: 'mine' })
    expect(canUseTab(rules, subject, eff.resource, eff.tabKey)).toBe(false)
  })
})

// reads（既読管理）の kind 別機能キー（レビュー R1: /v1/reports/reads はパスガード対象外にし
// ハンドラ内で kind 単位に判定する）
describe('reportReadsFeatureKey', () => {
  it('kind 別に独立後の機能キーへ写像する', () => {
    expect(reportReadsFeatureKey('daily')).toBe('reports')
    expect(reportReadsFeatureKey('weekly')).toBe('weekly-report')
    expect(reportReadsFeatureKey('monthly')).toBe('monthly-report')
  })

  it('旧 reports の deny は weekly/monthly の reads を止めない（独立制御）', () => {
    const legacyOnly = [rule({ resource: 'reports', effect: 'deny' })]
    expect(resolveFeatureResource(legacyOnly, reportReadsFeatureKey('weekly'))).toBe('weekly-report')
    expect(guardAllows(legacyOnly, reportReadsFeatureKey('weekly'))).toBe(true)
    expect(guardAllows(legacyOnly, reportReadsFeatureKey('daily'))).toBe(false)
  })
})
