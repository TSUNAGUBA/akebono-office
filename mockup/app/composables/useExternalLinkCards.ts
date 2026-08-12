/**
 * 外部リンクをカードメニュー（MenuCard）へ写像する（オペレーター指示 2026-08-03）。
 * ダッシュボードのメニューカテゴリで、基本メニューと同じようにセクション配置できるようにするため、
 * 外部リンク（設定 > 外部リンク）を dashboard 領域の割当可能カードとして供給する。
 * - 表示・割当とも active な外部リンクのみ（無効化した外部リンクはカードにも選択肢にも出さない）
 * - href を持つ = 別タブで開く（UiCardMenu が target=_blank を付与）
 * - id は外部リンクの id（`el-xxxx`）。メニューカテゴリの cardIds はこの id を保持する
 */
import type { ExternalLink } from '~/types/domain'
import type { MenuCard } from '~/types/ui'

export function useExternalLinkCards() {
  const { activeList } = useMasterCrud('externalLinks', 'el')

  const externalCards = computed<MenuCard[]>(() =>
    [...(activeList.value as ExternalLink[])]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(el => ({
        id: el.id,
        title: el.title,
        description: el.description,
        icon: el.icon,
        iconImage: el.iconImage ?? null,
        href: el.url,
      })))

  return { externalCards }
}
