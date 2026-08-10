/**
 * 構造化フィルタのエンジン（オペレーター指示 2026-08-10）。
 * 項目カスタマイズ（ITEM_CATALOG + item_settings.filter_visible）で「検索対象」に設定された項目を、
 * 種別（ref=マスタ参照 autocomplete / text=正規化部分一致 / enum=固定選択 / date=範囲 / number=範囲）ごとに
 * フィルタ入力させ、① mock 用の行述語（clientMatch）② API 用のクエリパラメータ（queryParams）を提供する。
 * text の部分一致・オプション絞り込みは normalizeSearch（NFKC + 小文字 = PG akebono_norm と一致）で
 * 大文字小文字・全角半角を吸収する（両モードで同じヒット挙動）。
 */
import type { ResolvedItem, FilterRefKind } from '~/composables/useItemSettings'
import { BILLING_TYPE_LABELS, INVENTORY_KIND_LABELS } from '~/utils/akebono'
import { normalizeSearch } from '~/utils/search'

export interface FilterOption { value: string; label: string }
export interface DateRange { from: string; to: string }
export interface NumberRange { min: string; max: string }
export type FilterValue = string | DateRange | NumberRange

const labelsToOptions = (m: Record<string, string>): FilterOption[] =>
  Object.entries(m).map(([value, label]) => ({ value, label }))

/** enum 項目の選択肢（entity × itemKey。値域は DB CHECK / 型 union と一致） */
const ENUM_OPTIONS: Record<string, Record<string, FilterOption[]>> = {
  product: { billingType: labelsToOptions(BILLING_TYPE_LABELS) },
  purchase_record: { purchaseType: [{ value: 'outright', label: '買取' }, { value: 'consignment', label: '委託' }] },
  inventory: {
    kind: labelsToOptions(INVENTORY_KIND_LABELS),
    reason: [
      { value: 'defective', label: '不良' }, { value: 'lost', label: '紛失' }, { value: 'found', label: '発見' },
      { value: 'sample', label: 'サンプル' }, { value: 'stocktake', label: '棚卸' }, { value: 'other', label: 'その他' },
    ],
  },
  invoice: { invoiceType: [{ value: 'sales', label: '通常請求' }, { value: 'consignment_margin', label: '委託マージン請求' }] },
}

export function useAppFilter(entity: string) {
  const items = useItemSettings()
  const masters = useAkebonoMasters()
  const products = useProducts()

  /** 検索対象に設定された項目（settings/items の filterVisible）。表示順はカタログ順 */
  const fields = computed<ResolvedItem[]>(() => items.filterableItems(entity))

  const skuOptions = computed<FilterOption[]>(() =>
    products.activeSkus().map(s => ({ value: s.id, label: products.skuFullLabel(s) })))

  function refOptions(ref: FilterRefKind): FilterOption[] {
    switch (ref) {
      case 'company': return masters.partnerCompanyOptions.value
      case 'segment': return masters.segmentOptions.value
      case 'sku': return skuOptions.value
      case 'warehouse': return masters.warehouseOptions.value
      case 'category': return masters.categoryOptions.value
      case 'taxRate': return masters.taxRateOptions.value
      case 'unit': return masters.unitOptions.value
    }
  }

  /** 項目のフィルタ選択肢（ref = マスタ / enum = 固定。text/date/number は空） */
  function optionsFor(item: ResolvedItem): FilterOption[] {
    if (item.filterKind === 'ref' && item.filterRef) return refOptions(item.filterRef)
    if (item.filterKind === 'enum') return ENUM_OPTIONS[entity]?.[item.itemKey] ?? []
    return []
  }

  // ---- フィルタ状態（項目キー → 値。date/number は範囲オブジェクト） ----
  const model = reactive<Record<string, FilterValue>>({})
  function defaultFor(item: ResolvedItem): FilterValue {
    if (item.filterKind === 'date') return { from: '', to: '' }
    if (item.filterKind === 'number') return { min: '', max: '' }
    return ''
  }
  // 検索対象項目が変わったら未初期化キーを補完（既存入力は保持 = 非破壊）
  watchEffect(() => {
    for (const f of fields.value) if (!(f.itemKey in model)) model[f.itemKey] = defaultFor(f)
  })

  // ---- mock 用の行述語（項目別 AND。custom 項目は今回対象外 = builtin のみ） ----
  function rowValue(row: Record<string, unknown>, key: string): unknown {
    return row[key]
  }
  function matchRow(row: Record<string, unknown>): boolean {
    for (const f of fields.value) {
      const v = model[f.itemKey]
      const cell = rowValue(row, f.itemKey)
      if (f.filterKind === 'date') {
        const r = v as DateRange
        const d = String(cell ?? '').slice(0, 10)
        if (r.from && (!d || d < r.from)) return false
        if (r.to && (!d || d > r.to)) return false
      } else if (f.filterKind === 'number') {
        const r = v as NumberRange
        const n = Number(cell)
        if (r.min !== '' && Number.isFinite(Number(r.min)) && !(Number.isFinite(n) && n >= Number(r.min))) return false
        if (r.max !== '' && Number.isFinite(Number(r.max)) && !(Number.isFinite(n) && n <= Number(r.max))) return false
      } else if (typeof v === 'string' && v.trim()) {
        if (f.filterKind === 'text') {
          if (!normalizeSearch(String(cell ?? '')).includes(normalizeSearch(v.trim()))) return false
        } else { // ref / enum = 完全一致
          if (String(cell ?? '') !== v) return false
        }
      }
    }
    return true
  }

  // ---- API 用クエリパラメータ（f.<key> 系。list-query.ts applyFilters と対応） ----
  const queryParams = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const f of fields.value) {
      const v = model[f.itemKey]
      if (f.filterKind === 'date') {
        const r = v as DateRange
        if (r.from) out[`f.${f.itemKey}.from`] = r.from
        if (r.to) out[`f.${f.itemKey}.to`] = r.to
      } else if (f.filterKind === 'number') {
        const r = v as NumberRange
        if (r.min !== '') out[`f.${f.itemKey}.min`] = String(r.min)
        if (r.max !== '') out[`f.${f.itemKey}.max`] = String(r.max)
      } else if (typeof v === 'string' && v.trim()) {
        out[`f.${f.itemKey}`] = v.trim()
      }
    }
    return out
  })

  const activeCount = computed(() => {
    // 入力済みフィルタの数（date/number は from/to・min/max をまとめて 1 項目と数える）
    const keys = new Set<string>()
    for (const k of Object.keys(queryParams.value)) keys.add(k.replace(/\.(from|to|min|max)$/, ''))
    return keys.size
  })

  function clear(): void {
    for (const f of fields.value) model[f.itemKey] = defaultFor(f)
  }

  return { fields, optionsFor, model, matchRow, queryParams, activeCount, clear }
}
