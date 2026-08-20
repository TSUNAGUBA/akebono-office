/**
 * ドロップダウン候補リストの開閉方向・最大高の実測（UiMultiCombobox / UiCombobox 共通。原則3）。
 * オペレーター報告 2026-07-20: モバイルのボトムシート型モーダルでは入力欄が画面下端近くにあり、
 * 下方向のリストが画面外・フッターに隠れて選択できない。開くたびに実測し、
 * 下に収まらず上の方が広ければ上方向に開く。空間の基準はビューポートではなく
 * **最近傍のクリップ祖先（overflow 要素）との交差**（PR #63 R1 M-1）。
 * 開く側に収まらない場合は max-height を残り空間へ縮める。
 */
import type { Ref } from 'vue'

const LIST_MAX_PX = 224 // 既定の最大高（旧 max-h-56 相当）
const LIST_MARGIN_PX = 12 // リストと境界の余白（mt-1/mb-1 + 視認マージン）

export function useDropdownDirection(root: Ref<HTMLElement | null>) {
  const openUp = ref(false)
  const listMaxHeight = ref(LIST_MAX_PX)

  /** クリップ祖先（overflow が visible でない要素）とビューポートの交差から可視境界を求める */
  function clipBounds(el: HTMLElement): { top: number; bottom: number } {
    let top = 0
    let bottom = window.innerHeight
    let node = el.parentElement
    while (node) {
      const style = getComputedStyle(node)
      if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
        const r = node.getBoundingClientRect()
        top = Math.max(top, r.top)
        bottom = Math.min(bottom, r.bottom)
      }
      node = node.parentElement
    }
    return { top, bottom }
  }

  function updateDirection(): void {
    const el = root.value
    const rect = el?.getBoundingClientRect()
    if (!el || !rect) return
    const bounds = clipBounds(el)
    const below = bounds.bottom - rect.bottom
    const above = rect.top - bounds.top
    openUp.value = below < LIST_MAX_PX + LIST_MARGIN_PX && above > below
    const room = (openUp.value ? above : below) - LIST_MARGIN_PX
    // 両側とも狭い場合でも操作不能にしない下限（1〜2 行分は常に見せ、リスト内スクロールで到達可能にする）
    listMaxHeight.value = Math.max(80, Math.min(LIST_MAX_PX, Math.floor(room)))
  }

  return { openUp, listMaxHeight, updateDirection }
}
