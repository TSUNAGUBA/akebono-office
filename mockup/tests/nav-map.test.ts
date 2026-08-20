/**
 * ページ間導線マップ（バッチ7h: utils/nav-map.ts）。
 * 完全一致 → prefix 最長一致の解決と、主要ページの親リンク宣言を検証する
 */
import { describe, expect, it } from 'vitest'
import { NAV_MAP, navEntryOf } from '../app/utils/nav-map'

describe('navEntryOf', () => {
  it('完全一致のエントリを返す', () => {
    expect(navEntryOf('/attendance')?.parent?.to).toBe('/')
    expect(navEntryOf('/masters/members')?.parent?.to).toBe('/masters')
    expect(navEntryOf('/support/chatbot')?.parent?.to).toBe('/support')
  })

  it('動的ルートは prefix の最長一致で解決する', () => {
    expect(navEntryOf('/decision/dt-1')?.parent?.to).toBe('/decision')
    expect(navEntryOf('/status/svc-1')?.parent?.to).toBe('/status')
  })

  it('マップ外のパスは null（親リンク・関連リンクなし）', () => {
    expect(navEntryOf('/login')).toBeNull()
    expect(navEntryOf('/unknown')).toBeNull()
  })

  it('週報・月報はトップレベル（親 = ホーム。日報を親に出さない = 改修依頼 2026-08-20）', () => {
    expect(navEntryOf('/weekly-report')?.parent?.to).toBe('/')
    expect(navEntryOf('/monthly-report')?.parent?.to).toBe('/')
    // パンくずの親リンクに日報（/reports）が出ないこと（本改修の眼目）
    expect(navEntryOf('/weekly-report')?.parent?.to).not.toBe('/reports')
    expect(navEntryOf('/monthly-report')?.parent?.to).not.toBe('/reports')
  })

  it('週報・月報・日報は関連リンクで相互に行き来できる', () => {
    const weeklyRelated = (navEntryOf('/weekly-report')?.related ?? []).map(l => l.to)
    expect(weeklyRelated).toContain('/monthly-report')
    expect(weeklyRelated).toContain('/reports')
    const monthlyRelated = (navEntryOf('/monthly-report')?.related ?? []).map(l => l.to)
    expect(monthlyRelated).toContain('/weekly-report')
    expect(monthlyRelated).toContain('/reports')
    const reportsRelated = (navEntryOf('/reports')?.related ?? []).map(l => l.to)
    expect(reportsRelated).toContain('/weekly-report')
    expect(reportsRelated).toContain('/monthly-report')
  })

  it('related の to は必ず bare パス + 任意クエリの形式（canPath 判定を壊さない）', () => {
    for (const entry of Object.values(NAV_MAP)) {
      for (const l of entry.related ?? []) {
        expect(l.to.startsWith('/')).toBe(true)
        expect(l.label.length).toBeGreaterThan(0)
      }
    }
  })
})
