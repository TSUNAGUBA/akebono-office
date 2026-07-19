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

  it('related の to は必ず bare パス + 任意クエリの形式（canPath 判定を壊さない）', () => {
    for (const entry of Object.values(NAV_MAP)) {
      for (const l of entry.related ?? []) {
        expect(l.to.startsWith('/')).toBe(true)
        expect(l.label.length).toBeGreaterThan(0)
      }
    }
  })
})
