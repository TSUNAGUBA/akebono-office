/**
 * 一覧の項目カスタマイズ（F-31 汎用化。全業務アプリ展開 2026-08-10）。
 * 各ページがハードコードする列定義（TableColumn[]）を、項目設定（useItemSettings 差分）と
 * カスタム項目（useCustomFields）に従わせる共通ヘルパー。
 *
 * - listColumns(entity, base): base 列のうち itemKey を持つものを builtinResolved(entity) で解決し、
 *   listVisible=false は除外・labelDisplay でラベル上書き。itemKey を持たない派生列（サムネイル・
 *   金額集計・ステータス・操作等）は常に温存。末尾にカスタム項目の列（custom.<key>）を付加する。
 * - decorateRows(entity, rows): カスタム項目値（row.custom[key]）を row['custom.<key>'] へ型別整形して
 *   平坦化する。UiDataTable の既定セルは row[col.key] を描くため、これでカスタム列が既存描画に載る。
 *
 * 既存の #cell-* スロット・行 id・派生列は不変（下位互換 = 原則7）。カスタム項目が 0 件のエンティティは
 * 実質ノーオペ（列も付かず decorate も素通し）。
 */
import type { TableColumn } from '~/types/ui'
import type { CustomFieldDef } from '~/types/domain'
import { fmtDate } from '~/utils/format'

/** itemKey = カタログ項目キー（builtinResolved の解決に使う）。派生・操作列は itemKey を付けない */
export interface AppColumn extends TableColumn {
  itemKey?: string
}

/** カスタム項目値の一覧表示整形（型別）。空値は「—」 */
export function fmtCustomValue(def: CustomFieldDef, v: unknown): string {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return '—'
  switch (def.fieldType) {
    case 'boolean':
      return v === true || v === 'true' ? 'はい' : 'いいえ'
    case 'date':
      return fmtDate(String(v))
    case 'multiselect':
      return Array.isArray(v) ? v.join('・') : String(v)
    default:
      return String(v)
  }
}

export function useAppListView() {
  const { builtinResolved, customDefs } = useAppFields()

  /**
   * 一覧列を項目設定で解決（表示 ON/OFF・表示名）＋カスタム項目列を末尾付加。
   * opts.appendCustom=false でカスタム列を付けない（入力フォームが無く常に空になる請求 = invoice 用）。
   */
  function listColumns(entity: string, base: AppColumn[], opts: { appendCustom?: boolean } = {}): TableColumn[] {
    const resolved = new Map(builtinResolved(entity).map(r => [r.itemKey, r]))
    const cols: TableColumn[] = []
    for (const c of base) {
      const { itemKey, ...col } = c
      if (itemKey) {
        const r = resolved.get(itemKey)
        // 項目設定で一覧非表示なら列を落とす。表示名は labelDisplay を優先（未解決の項目はそのまま温存）
        if (r && !r.listVisible) continue
        if (r) col.label = r.labelDisplay
      }
      cols.push(col)
    }
    if (opts.appendCustom !== false) {
      for (const d of customDefs(entity)) {
        cols.push({ key: `custom.${d.key}`, label: d.label, align: d.fieldType === 'number' ? 'right' : 'left' })
      }
    }
    return cols
  }

  /** カスタム項目値を row['custom.<key>'] へ整形平坦化（カスタム項目が無ければ素通し） */
  function decorateRows<T extends Record<string, unknown>>(entity: string, rows: T[]): T[] {
    const defs = customDefs(entity)
    if (defs.length === 0) return rows
    return rows.map((row) => {
      const custom = (row.custom ?? {}) as Record<string, unknown>
      const extra: Record<string, string> = {}
      for (const d of defs) extra[`custom.${d.key}`] = fmtCustomValue(d, custom[d.key])
      return { ...row, ...extra }
    })
  }

  return { listColumns, decorateRows }
}
