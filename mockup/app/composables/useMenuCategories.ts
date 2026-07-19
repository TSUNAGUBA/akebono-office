/**
 * カードメニューのカテゴリ解決・カスタマイズ（バッチ7h・オペレーター指示 2026-07-19 #10）
 * - SoT = configs（`menu-categories-<area>`。API モード = /v1/configs・モック = appConfigs）
 * - 未設定（空文字）= menu-registry の既定カテゴリ = 下位互換（原則7）
 * - どのカテゴリにも属さないカードは自動的に「その他」へ（新機能のカードが消えない）
 * - 取消フロー（原則 9.5）: reset() で既定へ戻せる + 全操作が再編集で上書き可能
 */
import type { MenuCard } from '~/types/ui'
import {
  DEFAULT_MENU_CATEGORIES, type MenuArea, type MenuCategoryDef,
  OTHER_CATEGORY_ID, OTHER_CATEGORY_LABEL,
} from '~/utils/menu-registry'

export interface CategorizedCards {
  id: string
  label: string
  cards: MenuCard[]
}

function configKeyOf(area: MenuArea): string {
  return `menu-categories-${area}`
}

/** 保存値の妥当性検証（壊れた JSON・型不一致は既定へフォールバック = 表示を壊さない） */
function parseCategories(raw: string): MenuCategoryDef[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const defs: MenuCategoryDef[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null
      const { id, label, cardIds } = item as Record<string, unknown>
      if (typeof id !== 'string' || id === '' || typeof label !== 'string' || !Array.isArray(cardIds)) return null
      defs.push({ id, label, cardIds: cardIds.filter((c): c is string => typeof c === 'string') })
    }
    return defs
  } catch {
    return null
  }
}

export function useMenuCategories(area: MenuArea) {
  const { getConfig, setConfig } = useAppSettings()
  const key = configKeyOf(area)

  /** 有効なカテゴリ定義（カスタマイズ済みならそれ・なければ既定） */
  const categories = computed<MenuCategoryDef[]>(() =>
    parseCategories(getConfig(key, '')) ?? DEFAULT_MENU_CATEGORIES[area])

  const isCustomized = computed(() => parseCategories(getConfig(key, '')) !== null)

  /**
   * カード一覧をカテゴリごとにグループ化する（カード側のフィルタ = 権限・トグルは呼び出し側で適用済み）。
   * 未割当カードは「その他」へ。空カテゴリは落とす
   */
  function categorize(cards: MenuCard[]): CategorizedCards[] {
    const byId = new Map(cards.map(c => [String(c.id), c]))
    const assigned = new Set<string>()
    const groups: CategorizedCards[] = []
    for (const cat of categories.value) {
      const catCards = cat.cardIds.map(id => byId.get(id)).filter((c): c is MenuCard => !!c)
      for (const c of catCards) assigned.add(String(c.id))
      if (catCards.length > 0) groups.push({ id: cat.id, label: cat.label, cards: catCards })
    }
    const rest = cards.filter(c => !assigned.has(String(c.id)))
    if (rest.length > 0) groups.push({ id: OTHER_CATEGORY_ID, label: OTHER_CATEGORY_LABEL, cards: rest })
    return groups
  }

  async function save(defs: MenuCategoryDef[]): Promise<{ ok: boolean }> {
    const res = await setConfig(key, JSON.stringify(defs))
    return { ok: res?.ok !== false }
  }

  /** 既定に戻す（保存値を空へ = 取消フロー。原則 9.5） */
  async function reset(): Promise<{ ok: boolean }> {
    const res = await setConfig(key, '')
    return { ok: res?.ok !== false }
  }

  return { categories, isCustomized, categorize, save, reset }
}
