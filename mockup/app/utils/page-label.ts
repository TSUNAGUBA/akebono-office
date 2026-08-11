/**
 * ページパス → 人間可読なページ名の解決（改善要望 F-42 の表示用。パスだけでなく名称も出す）。
 * SoT はナビ定義（NAV_GROUPS）+ カードメニュー定義（MENU_CARDS）。前方一致（最長）でサブページも解決する。
 * 例: '/inbox' → '通知・エスカレーション' / '/masters/members' → 'メンバー' / '/akebono/sales' → 'AKEBONO'。
 */
import { MENU_CARDS } from './menu-registry'
import { NAV_GROUPS } from './navigation'

let cache: Map<string, string> | null = null

function buildMap(): Map<string, string> {
  const m = new Map<string, string>()
  // ナビ（トップ機能）
  for (const g of NAV_GROUPS) {
    for (const i of g.items) if (i.path && !m.has(i.path)) m.set(i.path, i.label)
  }
  // カードメニュー（ダッシュボード + マスタ。クエリは除去）
  for (const cards of Object.values(MENU_CARDS)) {
    for (const c of cards) {
      const path = (c.to.split('?')[0] ?? c.to).trim()
      if (path && !m.has(path)) m.set(path, c.title)
    }
  }
  return m
}

/** パスに対応するページ名（無ければ最長前方一致・それも無ければパスそのもの） */
export function resolvePageLabel(path: string): string {
  const p = (path ?? '').trim()
  if (!p) return ''
  cache ??= buildMap()
  const exact = cache.get(p)
  if (exact) return exact
  let best = ''
  let bestLen = 0
  for (const [key, label] of cache) {
    if ((p === key || p.startsWith(`${key}/`)) && key.length > bestLen) {
      best = label
      bestLen = key.length
    }
  }
  return best || p
}

/** 表示用「名称（パス）」。名称が解決できない（= パスと同じ）ときはパスのみ */
export function pageDisplay(path: string): string {
  const p = (path ?? '').trim()
  if (!p) return ''
  const label = resolvePageLabel(p)
  return label && label !== p ? `${label}（${p}）` : p
}
