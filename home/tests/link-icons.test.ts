/**
 * 外部リンクのアイコン選択肢（設定 > 外部リンク。改善要望: プレビュー選択式）。
 * - LINK_ICON_CHOICES は lucide-vue-next に実在するキーであること（typo は無地の
 *   フォールバック表示になり、プレビュー選択の意味が壊れるため実在性を回帰で守る）。
 * - 重複がないこと（同じアイコンが 2 個並ぶのを防ぐ）。
 */
import { describe, expect, it } from 'vitest'
import * as icons from 'lucide-vue-next'
import { LINK_ICON_CHOICES, LINK_ICON_FALLBACK } from '~/utils/link-icons'

describe('LINK_ICON_CHOICES', () => {
  it('すべて lucide-vue-next に実在するアイコンキー', () => {
    const registry = icons as Record<string, unknown>
    const missing = LINK_ICON_CHOICES.filter(k => registry[k] === undefined)
    expect(missing).toEqual([])
  })

  it('重複がない', () => {
    expect(new Set(LINK_ICON_CHOICES).size).toBe(LINK_ICON_CHOICES.length)
  })

  it('フォールバックアイコンも実在し、選択肢に含まれる', () => {
    expect((icons as Record<string, unknown>)[LINK_ICON_FALLBACK]).toBeDefined()
    expect(LINK_ICON_CHOICES).toContain(LINK_ICON_FALLBACK)
  })
})
