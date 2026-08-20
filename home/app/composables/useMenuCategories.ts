/**
 * カードメニューのカテゴリ解決・カスタマイズ（バッチ7h・オペレーター指示 2026-07-19 #10）
 * - SoT = configs（`menu-categories-<area>`。API モード = /v1/configs・モック = appConfigs）
 * - 未設定（空文字）= menu-registry の既定カテゴリ = 下位互換（原則7）
 * - どのカテゴリにも属さないカードは自動的に「その他」へ（新機能のカードが消えない）
 * - 取消フロー（原則 9.5）: reset() で既定へ戻せる + 全操作が再編集で上書き可能
 */
import type { MenuCard } from '~/types/ui'
import {
  categorizeCards, type CategorizedCards, parseMenuSections,
} from '~/utils/dashboard-layout'
import { DEFAULT_MENU_CATEGORIES, type MenuArea, type MenuCategoryDef } from '~/utils/menu-registry'

// カテゴリ解決・グルーピングの純ロジック・型（CategorizedCards）は dashboard-layout.ts に集約し共有する（原則3）

function configKeyOf(area: MenuArea): string {
  return `menu-categories-${area}`
}

export function useMenuCategories(area: MenuArea) {
  const { getConfig, setConfig } = useAppSettings()
  const key = configKeyOf(area)

  /** 有効なカテゴリ定義（カスタマイズ済みならそれ・なければ既定） */
  const categories = computed<MenuCategoryDef[]>(() =>
    parseMenuSections(getConfig(key, '')) ?? DEFAULT_MENU_CATEGORIES[area])

  const isCustomized = computed(() => parseMenuSections(getConfig(key, '')) !== null)

  /**
   * カード一覧をカテゴリごとにグループ化する（カード側のフィルタ = 権限・トグルは呼び出し側で適用済み）。
   * 未割当カードは「その他」へ。空カテゴリは落とす（実装は dashboard-layout.categorizeCards を共有）
   */
  function categorize(cards: MenuCard[]): CategorizedCards[] {
    return categorizeCards(cards, categories.value)
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
