/**
 * AKEBONO 業態アプリをカードメニュー（MenuCard）へ写像する（オペレーター指示 2026-08-03 #24）。
 * 外部リンク（useExternalLinkCards）と同型で、ダッシュボードのメニューカテゴリに、基本メニュー・
 * 外部リンクと同じようにセクション配置できるよう、active な各業態を割当可能カードとして供給する。
 * - 表示・割当とも active な業態のみ（無効化・削除された業態はカードにも選択肢にも出さない）
 * - id は安定 id `akebono-seg:<segmentId>`（セクション定義の cardIds はこの id を保持する）
 * - to = /akebono?seg=<segmentId>（入場時に現在業態を切り替える。AkebonoSegmentApps と同じ導線）
 * - 写像自体は純関数 utils/akebono.akebonoSegmentCard が SoT（単体テスト対象。原則3）
 */
import type { MenuCard } from '~/types/ui'
import { akebonoSegmentCard } from '~/utils/akebono'

export function useAkebonoAppCards() {
  const { activeSegments } = useCurrentSegment()
  const { enabledAppsOf } = useAkebonoApps()

  const akebonoCards = computed<MenuCard[]>(() =>
    activeSegments.value.map(s => akebonoSegmentCard(s, enabledAppsOf(s.id).length)))

  return { akebonoCards }
}
