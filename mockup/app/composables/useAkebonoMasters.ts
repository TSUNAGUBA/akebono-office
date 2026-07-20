/**
 * Akebonoメニュー 共通マスタ基盤（F-30）
 * 9 マスタ（事業セグメント・倉庫・単位・税区分・回収支払条件・委託条件・軸テンプレート・
 * 商品カテゴリ・画像セクション）の CRUD・選択肢・名称解決・汎用フォーム定義を集約する。
 * 汎用マスタページ（/akebono/masters）はここを参照して薄く保つ（原則3）。
 * 取引先ロール（Company.partnerRoles）は既存の顧客(会社)マスタで編集する想定のため本 UI では扱わない。
 */
import type {
  BusinessSegment, ConsignmentTerm, ProductCategory, TaxRate, Warehouse,
} from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'
import {
  INDUSTRY_TYPES, INDUSTRY_TYPE_LABELS, PARTNER_ROLE_LABELS, PAYOUT_METHOD_LABELS,
  hasPartnerRole,
} from '~/utils/akebono'

export type AkebonoMasterKey =
  | 'businessSegments' | 'warehouses' | 'units' | 'taxRates' | 'paymentTerms'
  | 'consignmentTerms' | 'variantAxisTemplates' | 'productCategories' | 'productImageSections'

interface MasterMeta {
  key: AkebonoMasterKey
  label: string
  prefix: string
  description: string
}

export const AKEBONO_MASTER_META: MasterMeta[] = [
  { key: 'businessSegments', label: '事業セグメント', prefix: 'seg', description: '扱う業態（業種タイプ）。使用アプリのプリセット・売上の区分軸' },
  { key: 'warehouses', label: '倉庫・保管場所', prefix: 'wh', description: '自社倉庫・店舗預け・外部委託' },
  { key: 'productCategories', label: '商品カテゴリ', prefix: 'pcat', description: '商品の階層分類' },
  { key: 'productImageSections', label: '画像セクション', prefix: 'pis', description: '商品画像の区分（既定: 製品/サンプル。追加可）' },
  { key: 'variantAxisTemplates', label: 'バリアント軸テンプレート', prefix: 'vat', description: 'SKU 展開の軸ラベルの組（カラー×サイズ 等）' },
  { key: 'units', label: '単位', prefix: 'unit', description: '個・点・式・人日・ライセンス 等' },
  { key: 'taxRates', label: '税区分', prefix: 'tax', description: '税率と適用' },
  { key: 'paymentTerms', label: '回収・支払条件', prefix: 'pt', description: '締め日・支払サイト' },
  { key: 'consignmentTerms', label: '委託条件', prefix: 'ct', description: '取引先×セグメント×ロールの精算設定（店舗=マージン請求/作家=支払）' },
]

export function useAkebonoMasters() {
  const { tbl } = useMockDb()
  const companies = tbl('companies')

  const cruds = {
    businessSegments: useMasterCrud('businessSegments', 'seg'),
    warehouses: useMasterCrud('warehouses', 'wh'),
    units: useMasterCrud('units', 'unit'),
    taxRates: useMasterCrud('taxRates', 'tax'),
    paymentTerms: useMasterCrud('paymentTerms', 'pt'),
    consignmentTerms: useMasterCrud('consignmentTerms', 'ct'),
    variantAxisTemplates: useMasterCrud('variantAxisTemplates', 'vat'),
    productCategories: useMasterCrud('productCategories', 'pcat'),
    productImageSections: useMasterCrud('productImageSections', 'pis'),
  } as const

  // ---------- 選択肢 ----------
  const segments = computed(() => tbl('businessSegments').value.filter(s => s.active !== false))
  const warehouses = computed(() => tbl('warehouses').value.filter(w => w.active !== false))
  const taxRates = computed(() => tbl('taxRates').value.filter(t => t.active !== false))
  const units = computed(() => tbl('units').value.filter(u => u.active !== false))
  const paymentTerms = computed(() => tbl('paymentTerms').value.filter(p => p.active !== false))
  const categories = computed(() => tbl('productCategories').value.filter(c => c.active !== false))
  const imageSections = computed(() => tbl('productImageSections').value.filter(s => s.active !== false))
  const variantTemplates = computed(() => tbl('variantAxisTemplates').value.filter(v => v.active !== false))
  const consignmentTerms = computed(() => tbl('consignmentTerms').value.filter(c => c.active !== false))

  const segmentOptions = computed(() => segments.value.map(s => ({ value: s.id, label: s.name })))
  const warehouseOptions = computed(() => warehouses.value.map(w => ({ value: w.id, label: w.name })))
  const taxRateOptions = computed(() => taxRates.value.map(t => ({ value: t.id, label: t.name })))
  const unitOptions = computed(() => units.value.map(u => ({ value: u.id, label: u.name })))
  const categoryOptions = computed(() => categories.value.map(c => ({ value: c.id, label: c.name })))
  const paymentTermOptions = computed(() => paymentTerms.value.map(p => ({ value: p.id, label: p.name })))

  /** 店舗（partnerRoles に store）の会社 */
  const storeCompanyOptions = computed(() =>
    (companies.value as Company[]).filter(c => c.active !== false && hasPartnerRole(c, 'store'))
      .map(c => ({ value: c.id, label: c.name })))
  /** 全取引先（active） */
  const partnerCompanyOptions = computed(() =>
    (companies.value as Company[]).filter(c => c.active !== false && c.kind === 'customer')
      .map(c => ({ value: c.id, label: c.name })))

  // ---------- 名称解決 ----------
  function segmentName(id: string | null | undefined): string {
    return tbl('businessSegments').value.find(s => s.id === id)?.name ?? '—'
  }
  function warehouseName(id: string | null | undefined): string {
    return tbl('warehouses').value.find(w => w.id === id)?.name ?? '—'
  }
  function taxRateOf(id: string | null | undefined): TaxRate | undefined {
    return tbl('taxRates').value.find(t => t.id === id)
  }
  function unitName(id: string | null | undefined): string {
    return tbl('units').value.find(u => u.id === id)?.name ?? ''
  }
  function categoryName(id: string | null | undefined): string {
    return tbl('productCategories').value.find(c => c.id === id)?.name ?? '—'
  }
  function companyName(id: string | null | undefined): string {
    return (companies.value as Company[]).find(c => c.id === id)?.name ?? '—'
  }

  // ---------- 汎用フォーム定義（マスタページが使用） ----------
  const industryOptions = INDUSTRY_TYPES.map(v => ({ value: v, label: INDUSTRY_TYPE_LABELS[v] }))
  const warehouseKindOptions = [
    { value: 'own', label: '自社倉庫' },
    { value: 'store_deposit', label: '店舗預け' },
    { value: 'external', label: '外部委託' },
  ]
  const roundingOptions = [
    { value: 'floor', label: '切り捨て' },
    { value: 'ceil', label: '切り上げ' },
    { value: 'round', label: '四捨五入' },
  ]
  const payoutMethodOptions = Object.entries(PAYOUT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
  const liabilityOptions = [
    { value: 'on_sale', label: '販売時確定' },
    { value: 'on_receipt', label: '仕入計上時確定' },
  ]
  const consignmentRoleOptions = [
    { value: 'store', label: `店舗（${PARTNER_ROLE_LABELS.store} = マージン請求設定）` },
    { value: 'consignor_artist', label: `作家（${PARTNER_ROLE_LABELS.consignor_artist} = 支払設定）` },
  ]

  function fieldsFor(key: AkebonoMasterKey): FieldDef[] {
    switch (key) {
      case 'businessSegments':
        return [
          { key: 'name', label: 'セグメント名', type: 'text', required: true, placeholder: '例）陶磁器委託販売' },
          { key: 'industryType', label: '業種タイプ', type: 'select', required: true, options: industryOptions },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'warehouses':
        return [
          { key: 'name', label: '倉庫・保管場所名', type: 'text', required: true },
          { key: 'kind', label: '種別', type: 'select', required: true, options: warehouseKindOptions },
          { key: 'companyId', label: '紐付く店舗', type: 'select', options: storeCompanyOptions.value, emptyLabel: '（店舗預けのとき指定）' },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'units':
        return [
          { key: 'name', label: '単位名', type: 'text', required: true, placeholder: '例）個・式・人日' },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'taxRates':
        return [
          { key: 'name', label: '名称', type: 'text', required: true, placeholder: '例）標準税率（10%）' },
          { key: 'rate', label: '税率（0.10 = 10%）', type: 'number', required: true, min: 0, max: 1, step: 0.01 },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'paymentTerms':
        return [
          { key: 'name', label: '名称', type: 'text', required: true, placeholder: '例）月末締め翌月末払い' },
          { key: 'closingDay', label: '締め日（31=末日）', type: 'number', required: true, min: 1, max: 31, step: 1 },
          { key: 'payMonthOffset', label: '支払月（0=当月/1=翌月）', type: 'number', min: 0, max: 3, step: 1 },
          { key: 'payDay', label: '支払日（31=末日）', type: 'number', min: 1, max: 31, step: 1 },
        ]
      case 'consignmentTerms':
        return [
          { key: 'companyId', label: '取引先', type: 'select', required: true, options: partnerCompanyOptions.value },
          { key: 'segmentId', label: '事業セグメント', type: 'select', required: true, options: segmentOptions.value },
          { key: 'role', label: '適用ロール', type: 'select', required: true, options: consignmentRoleOptions },
          { key: 'marginRate', label: 'マージン率（店舗行。0.30=30%）', type: 'number', min: 0, max: 1, step: 0.01, hint: '店舗行のとき指定' },
          { key: 'payoutMethod', label: '支払算定方式（作家行）', type: 'select', options: payoutMethodOptions, emptyLabel: '（作家行のとき指定）' },
          { key: 'payoutRate', label: '作家率（売上連動。0.60=60%）', type: 'number', min: 0, max: 1, step: 0.01 },
          { key: 'liabilityTiming', label: '債務確定タイミング（作家行）', type: 'select', options: liabilityOptions, emptyLabel: '（作家行のとき指定）' },
          { key: 'taxRateId', label: '税区分', type: 'select', options: taxRateOptions.value, emptyLabel: '（未指定）' },
          { key: 'taxIncluded', label: '内税', type: 'boolean' },
          { key: 'rounding', label: '端数処理', type: 'select', options: roundingOptions },
          { key: 'validFrom', label: '適用開始日', type: 'date', required: true },
        ]
      case 'variantAxisTemplates':
        return [
          { key: 'name', label: 'テンプレート名', type: 'text', required: true },
          { key: 'axis1Label', label: '軸1ラベル', type: 'text', required: true, placeholder: '例）カラー' },
          { key: 'axis2Label', label: '軸2ラベル', type: 'text', required: true, placeholder: '例）サイズ' },
          { key: 'industryTypes', label: '対象業種', type: 'multiselect', options: industryOptions },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'productCategories':
        return [
          { key: 'name', label: 'カテゴリ名', type: 'text', required: true },
          { key: 'parentId', label: '親カテゴリ', type: 'select', options: categoryOptions.value, emptyLabel: '（トップレベル）' },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
      case 'productImageSections':
        return [
          { key: 'name', label: 'セクション名', type: 'text', required: true, placeholder: '例）着用画像' },
          { key: 'isThumbnailPriority', label: 'サムネイル優先（1件のみ）', type: 'boolean' },
          { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
        ]
    }
  }

  const numberKeys = new Set(['displayOrder', 'rate', 'closingDay', 'payMonthOffset', 'payDay', 'marginRate', 'payoutRate'])
  const boolKeys = new Set(['taxIncluded', 'isThumbnailPriority'])

  /** フォーム値を型付きペイロードへ整形（数値/真偽/空→null の変換） */
  function coerce(key: AkebonoMasterKey, form: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of fieldsFor(key)) {
      const raw = form[f.key]
      if (f.type === 'multiselect') {
        out[f.key] = Array.isArray(raw) ? raw : []
      } else if (numberKeys.has(f.key)) {
        out[f.key] = raw === '' || raw == null ? null : Number(raw)
      } else if (boolKeys.has(f.key)) {
        out[f.key] = raw === true || raw === 'true'
      } else if (f.type === 'select' && (raw === '' || raw == null)) {
        out[f.key] = null
      } else {
        out[f.key] = raw ?? ''
      }
    }
    // 表示順の既定
    if (out.displayOrder == null) out.displayOrder = 1
    return out
  }

  return {
    meta: AKEBONO_MASTER_META,
    cruds,
    // 選択肢
    segments, warehouses, taxRates, units, categories, imageSections, variantTemplates, consignmentTerms,
    segmentOptions, warehouseOptions, taxRateOptions, unitOptions, categoryOptions, paymentTermOptions,
    storeCompanyOptions, partnerCompanyOptions,
    // 解決
    segmentName, warehouseName, taxRateOf, unitName, categoryName, companyName,
    // フォーム
    fieldsFor, coerce,
  }
}

// ---------- 一覧カラム（マスタページ共通。純データ） ----------

export const AKEBONO_MASTER_COLUMNS: Record<AkebonoMasterKey, TableColumn[]> = {
  businessSegments: [
    { key: 'name', label: 'セグメント名', primary: true },
    { key: 'industryType', label: '業種タイプ', primary: true },
    { key: 'active', label: '状態', primary: true },
  ],
  warehouses: [
    { key: 'name', label: '名称', primary: true },
    { key: 'kind', label: '種別', primary: true },
    { key: 'active', label: '状態' },
  ],
  units: [{ key: 'name', label: '単位名', primary: true }, { key: 'displayOrder', label: '表示順', align: 'right' }, { key: 'active', label: '状態' }],
  taxRates: [{ key: 'name', label: '名称', primary: true }, { key: 'rate', label: '税率', align: 'right', primary: true }, { key: 'active', label: '状態' }],
  paymentTerms: [{ key: 'name', label: '名称', primary: true }, { key: 'active', label: '状態' }],
  consignmentTerms: [
    { key: 'companyId', label: '取引先', primary: true },
    { key: 'role', label: 'ロール', primary: true },
    { key: 'detail', label: '設定' },
    { key: 'active', label: '状態' },
  ],
  variantAxisTemplates: [{ key: 'name', label: 'テンプレート名', primary: true }, { key: 'axes', label: '軸', primary: true }, { key: 'active', label: '状態' }],
  productCategories: [{ key: 'name', label: 'カテゴリ名', primary: true }, { key: 'parentId', label: '親カテゴリ' }, { key: 'active', label: '状態' }],
  productImageSections: [{ key: 'name', label: 'セクション名', primary: true }, { key: 'isThumbnailPriority', label: 'サムネ優先' }, { key: 'active', label: '状態' }],
}

/** 委託条件の設定サマリ（一覧セル表示） */
export function consignmentSummary(t: ConsignmentTerm): string {
  if (t.role === 'store') return `マージン率 ${((t.marginRate ?? 0) * 100).toFixed(0)}%`
  const method = t.payoutMethod === 'purchase_cost' ? '仕入単価×数量' : `売上×${((t.payoutRate ?? 0) * 100).toFixed(0)}%`
  const timing = t.liabilityTiming === 'on_receipt' ? '仕入時確定' : '販売時確定'
  return `${method} / ${timing}`
}
