/**
 * ページパス → 人間可読なページ名の解決（改善要望 F-42 の表示用。パスだけでなく名称も出す）。
 * SoT はナビ定義（NAV_GROUPS）+ カードメニュー定義（MENU_CARDS）。前方一致（最長）でサブページも解決する。
 * 例: '/inbox' → '通知・エスカレーション' / '/masters/members' → 'メンバー' / '/akebono/sales' → 'AKEBONO'。
 */
import { MENU_CARDS } from './menu-registry'
import { NAV_MAP } from './nav-map'
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
  // nav-map の導線ラベル（親リンク → 関連リンクの順に採用。2 階層目のサブページも固有名で解決できるようにする
  // = パンくず・対象ページ選択の表示名。改善要望 2026-08-17。既存の解決を上書きしない = 最低優先）
  const parents: { to: string; label: string }[] = []
  const related: { to: string; label: string }[] = []
  for (const entry of Object.values(NAV_MAP)) {
    if (entry.parent) parents.push(entry.parent)
    for (const r of entry.related ?? []) related.push(r)
  }
  for (const l of [...parents, ...related]) {
    const path = (l.to.split('?')[0] ?? l.to).trim()
    if (path && !m.has(path)) m.set(path, l.label)
  }
  return m
}

/**
 * 既知ページの一覧（改善要望の対象ページ選択などの選択肢用 = 改善要望 2026-08-17）。
 * ナビ + カードメニュー + nav-map（2 階層目のサブページ含む）の合併。パス昇順。
 * nav-map 由来のラベルは resolvePageLabel（前方一致）で解決する（prefix エントリは除く）。
 */
export function listKnownPages(): { path: string; label: string }[] {
  cache ??= buildMap()
  const paths = new Set<string>(cache.keys())
  for (const [key, entry] of Object.entries(NAV_MAP)) {
    if (!entry.prefix) paths.add(key)
  }
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map(path => ({ path, label: resolvePageLabel(path) }))
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
