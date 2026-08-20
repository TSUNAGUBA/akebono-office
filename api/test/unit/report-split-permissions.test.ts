/**
 * 週報・月報の機能キー独立と旧 'reports' キー互換フォールバック（改修依頼 2026-08-20 第2バッチ）。
 * API 側の観点: featureGuard は PATH_FEATURES（/v1/reports/weekly → weekly-report 等）で機能キーを
 * 引いたあと、resolveFeatureResource（shared/domain/permissions.ts = フロント usePermissions と共通）で
 * 実効リソースへ解決してから canUseFeature を評価する。
 * - 新キーの明示ルールが 1 件も無い間は旧 'reports' 設定を継承（既存テナントの下位互換）
 * - 新キーのルールを設定した時点で独立制御
 */
import { describe, expect, it } from 'vitest'
import {
  canUseFeature, canUseTab, resolveFeatureResource, resolveTabPermission,
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

describe('featureGuard の実効リソース解決（週報・月報 → 旧 reports 互換）', () => {
  it('新キーのルールが無ければ旧 reports の deny を継承する（既存テナント互換）', () => {
    const rules = [rule({ resource: 'reports', effect: 'deny' })]
    expect(guardAllows(rules, 'weekly-report')).toBe(false) // GET/PUT /v1/reports/weekly・weekly-insight
    expect(guardAllows(rules, 'monthly-report')).toBe(false) // GET/PUT /v1/reports/monthly
    expect(guardAllows(rules, 'reports')).toBe(false) // /v1/reports/daily・reads・remind
  })

  it('新キーの明示ルールを設定した時点で独立制御になる', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', effect: 'deny' }),
      rule({ id: 'r2', resource: 'monthly-report', effect: 'allow' }),
    ]
    expect(guardAllows(rules, 'monthly-report')).toBe(true) // 独立（旧 deny を引き継がない）
    expect(guardAllows(rules, 'weekly-report')).toBe(false) // weekly は継承のまま
    expect(guardAllows(rules, 'reports')).toBe(false)
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

describe('タブ権限のフォールバック（resolveTabPermission）', () => {
  it('旧 reports の tab:weekly-* / tab:monthly-* を新リソース/tab:* へ写像して継承する', () => {
    const rules = [
      rule({ id: 'r1', resource: 'reports', field: 'tab:weekly-all', effect: 'deny' }),
      rule({ id: 'r2', resource: 'reports', field: 'tab:monthly-mine', effect: 'deny' }),
    ]
    const wk = resolveTabPermission(rules, 'weekly-report', 'all')
    expect(wk).toEqual({ resource: 'reports', tabKey: 'weekly-all' })
    expect(canUseTab(rules, subject, wk.resource, wk.tabKey)).toBe(false)
    const mo = resolveTabPermission(rules, 'monthly-report', 'mine')
    expect(canUseTab(rules, subject, mo.resource, mo.tabKey)).toBe(false)
    // 写像されないタブは既定 allow
    const ok = resolveTabPermission(rules, 'weekly-report', 'mine')
    expect(canUseTab(rules, subject, ok.resource, ok.tabKey)).toBe(true)
  })

  it('新キーのルールがあれば写像しない（独立制御）', () => {
    const rules = [rule({ resource: 'weekly-report', field: 'tab:mine', effect: 'deny' })]
    expect(resolveTabPermission(rules, 'weekly-report', 'mine'))
      .toEqual({ resource: 'weekly-report', tabKey: 'mine' })
    expect(resolveTabPermission(rules, 'monthly-report', 'mine'))
      .toEqual({ resource: 'reports', tabKey: 'monthly-mine' }) // monthly は継承のまま
  })
})
