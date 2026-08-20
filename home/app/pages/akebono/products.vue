<script setup lang="ts">
/**
 * 商品マスタ管理（F-21）
 * 商品（親）+ SKU（バリアント 2 軸）+ 画像（セクション別）を一覧・詳細ドロワーで管理する。
 * 展開なし商品は既定 SKU 1 件（SKU 数 1 表示）。バリアント商品はマトリクス生成で SKU 展開。
 * 画像は実ファイルを縮小して data URI 登録（未登録は色プレースホルダ）。新規登録フォームでも
 * 添付でき、商品保存時にまとめて登録する。
 * 事業セグメント・単位・課金区分・バリアント軸ラベルは業態設定の既定を自動適用し、通常フォームからは
 * 外す（入力コスト最小化。F-20-8）。個別変更は「カスタマイズ」フォームでのみ行う。
 */
import { Layers, Plus, SlidersHorizontal } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { BillingType, Product, ProductSku } from '~/types/akebono'
import type { Company, CustomValues } from '~/types/domain'
import type { FieldDef } from '~/types/ui'
import { BILLING_TYPE_LABELS, hasPartnerRole } from '~/utils/akebono'
import { IMAGE_MAX_CHARS, imageToDataUri, thumbBoxClass, thumbFirstChar } from '~/utils/thumb'
import { fmtYen } from '~/utils/format'

const p = useProducts()
const { customDefs } = useAppFields()
const masters = useAkebonoMasters()
const { effectiveSegmentId, defaultsFor } = useCurrentSegment()
const { tbl } = useMockDb()
const toast = useToast()
const confirm = useConfirm()

// ---------- 仕入先（取引先ロール supplier） ----------
const companies = tbl('companies')
const supplierOptions = computed(() =>
  (companies.value as Company[])
    .filter(c => c.active !== false && hasPartnerRole(c, 'supplier'))
    .map(c => ({ value: c.id, label: c.name })))

const billingTypeOptions = Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => ({ value, label }))

// ---------- 一覧・フィルタ ----------
// 既定は現在の業態（毎回選ばせない導線）。ヘッダの業態スイッチャ切替に追随するが、
// ユーザーが明示的に別の絞り込みへ変更していれば尊重する（非破壊 = 原則2）。
const segmentFilter = ref(effectiveSegmentId.value)
watch(effectiveSegmentId, (id, prev) => { if (segmentFilter.value === prev) segmentFilter.value = id })
const statusFilter = ref('active')

const segmentFilterOptions = computed(() => masters.segmentOptions.value)

const filtered = computed(() =>
  (p.products.value as Product[])
    .filter((prod) => {
      if (!matchesActiveFilter(prod, statusFilter.value)) return false
      if (segmentFilter.value && prod.segmentId !== segmentFilter.value) return false
      return true
    })
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, 'ja')),
)

// 構造化フィルタ（項目別。フリーテキスト検索の置換）＋ クライアントページング（状態・業態は本ページの filtered が担う）
const {
  fields: filterFields, optionsFor: filterOptionsFor, model: filterModel,
  matchRow: filterMatchRow, queryParams: filterQueryParams, activeCount: filterActiveCount, clear: filterClear,
} = useAppFilter('product')
const { page, pageSize, rows: pagedRows, total } = useListView<Product>({
  source: filtered,
  filterPredicate: computed(() => (prod: Product) => filterMatchRow(prod as unknown as Record<string, unknown>)),
  filterParams: filterQueryParams,
})
watch([segmentFilter, statusFilter], () => { page.value = 1 })
const { listColumns, decorateRows } = useAppListView()
// 一覧列は項目設定（表示 ON/OFF・表示名）で解決＋カスタム項目列を付加。派生列（サムネイル・SKU数・状態）は itemKey 無し＝常時表示
const columns = computed(() => listColumns('product', [
  { key: 'thumb', label: '', width: '48px' },
  { key: 'code', label: '商品コード', primary: true, itemKey: 'code' },
  { key: 'name', label: '商品名', primary: true, itemKey: 'name' },
  { key: 'segment', label: 'セグメント', itemKey: 'segmentId' },
  { key: 'listPrice', label: '標準売価', align: 'right', primary: true, itemKey: 'listPrice' },
  { key: 'skuCount', label: 'SKU数', align: 'right' },
  { key: 'active', label: '状態', primary: true },
]))

const tableRows = computed(() =>
  decorateRows('product', pagedRows.value.map(r => ({ ...r, custom: r.custom ?? {} }))) as unknown as Record<string, unknown>[],
)

function asProduct(row: Record<string, unknown>): Product {
  return row as unknown as Product
}

// ---------- 詳細ドロワー ----------
const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Product | null>(() =>
  selectedId.value ? (p.productById(selectedId.value) ?? null) : null,
)
const isVariant = computed(() => {
  const s = selected.value
  return !!s && !!s.variantAxis1Label && s.variantAxis1Label.trim() !== ''
})
const detailSkus = computed<ProductSku[]>(() => selectedId.value ? p.skusOf(selectedId.value) : [])

const drawerTitle = computed(() =>
  mode.value === 'create' ? '商品を追加' : mode.value === 'edit' ? '商品を編集' : '商品詳細',
)

const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})
// カスタマイズ（業態・単位・課金区分・バリアント軸）を開いているか。既定は閉（業態の既定値を自動適用）
const customizeOpen = ref(false)

/**
 * 通常フォーム項目（入力コスト最小化）。
 * 事業セグメント・単位・課金区分・バリアント軸1/2ラベルは業態設定の既定を自動適用するため、
 * ここには出さない（変更は「カスタマイズ」フォームでのみ）。
 */
const baseFields = computed<FieldDef[]>(() => [
  { key: 'code', label: '商品コード', type: 'text', required: true, placeholder: '例）AB-1001' },
  { key: 'name', label: '商品名', type: 'text', required: true },
  { key: 'categoryId', label: '商品カテゴリ', type: 'select', options: masters.categoryOptions.value, emptyLabel: '（未分類）' },
  { key: 'defaultSupplierCompanyId', label: '仕入先', type: 'select', options: supplierOptions.value, emptyLabel: '（未指定）' },
  { key: 'listPrice', label: '標準売価（円）', type: 'number', min: 0, step: 1 },
  { key: 'standardCost', label: '標準原価（円）', type: 'number', min: 0, step: 1 },
  { key: 'taxRateId', label: '税区分', type: 'select', options: masters.taxRateOptions.value, emptyLabel: '（未指定）' },
  { key: 'description', label: '説明', type: 'textarea' },
])

/** カスタマイズフォーム項目（業態設定の既定を個別に上書きしたいときだけ開く） */
const customFields = computed<FieldDef[]>(() => [
  { key: 'segmentId', label: '事業セグメント', type: 'select', required: true, options: masters.segmentOptions.value, hint: '通常は入場した業態が入ります' },
  { key: 'unitId', label: '単位', type: 'select', options: masters.unitOptions.value, emptyLabel: '（未指定）' },
  { key: 'billingType', label: '課金区分', type: 'select', options: billingTypeOptions, emptyLabel: '（物販）' },
  { key: 'variantAxis1Label', label: 'バリアント軸1ラベル', type: 'text', placeholder: '例）カラー', hint: '入力すると SKU 展開商品になります' },
  { key: 'variantAxis2Label', label: 'バリアント軸2ラベル', type: 'text', placeholder: '例）サイズ' },
])

/** フォームで採用中の既定値サマリ（カスタマイズ未使用時の透明性表示） */
const appliedDefaultsSummary = computed(() => {
  const unitId = str(form.value.unitId)
  const billing = str(form.value.billingType)
  const v1 = str(form.value.variantAxis1Label).trim()
  const v2 = str(form.value.variantAxis2Label).trim()
  const unit = unitId ? masters.unitName(unitId) || '未設定' : '未設定'
  const billingLabel = billing ? BILLING_TYPE_LABELS[billing as BillingType] : '物販'
  const variant = v1 ? (v2 ? `${v1}×${v2}` : v1) : 'バリアントなし'
  return `単位: ${unit} ／ 課金: ${billingLabel} ／ ${variant}`
})

const detailRows = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: '商品コード', value: s.code },
    { label: '商品名', value: s.name },
    { label: 'セグメント', value: masters.segmentName(s.segmentId) },
    { label: 'カテゴリ', value: masters.categoryName(s.categoryId) },
    { label: '仕入先', value: p.supplierName(s) },
    { label: '標準売価', value: fmtYen(s.listPrice) },
    { label: '標準原価', value: fmtYen(s.standardCost) },
    { label: '課金区分', value: s.billingType ? BILLING_TYPE_LABELS[s.billingType] : '物販（買い切り明細）' },
    { label: '状態', value: s.active ? '有効' : '無効' },
  ]
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  // 登録先の業態（入場した業態が既定）。その業態の既定値を単位・課金区分・バリアント軸へ自動適用する。
  const sid = segmentFilter.value || effectiveSegmentId.value || ''
  const d = defaultsFor(sid)
  form.value = {
    code: '', name: '', segmentId: sid, categoryId: '',
    defaultSupplierCompanyId: '', listPrice: '', standardCost: '', taxRateId: '',
    unitId: d.unitId ?? '', billingType: d.billingType ?? '',
    variantAxis1Label: d.variantAxis1Label ?? '', variantAxis2Label: d.variantAxis2Label ?? '',
    description: '',
    custom: {},
  }
  errors.value = {}
  customizeOpen.value = false
  pendingImages.value = []
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const s = selected.value
  if (!s) return
  form.value = {
    code: s.code, name: s.name, segmentId: s.segmentId,
    categoryId: s.categoryId ?? '', defaultSupplierCompanyId: s.defaultSupplierCompanyId ?? '',
    listPrice: s.listPrice, standardCost: s.standardCost,
    taxRateId: s.taxRateId ?? '', unitId: s.unitId ?? '', billingType: s.billingType ?? '',
    variantAxis1Label: s.variantAxis1Label ?? '', variantAxis2Label: s.variantAxis2Label ?? '',
    description: s.description,
    custom: { ...(s.custom ?? {}) },
  }
  errors.value = {}
  customizeOpen.value = false
  mode.value = 'edit'
}

/** この業態の既定値をフォームへ再適用（カスタマイズを既定に戻す取消導線・原則9.5） */
function reapplySegmentDefaults(): void {
  const d = defaultsFor(str(form.value.segmentId))
  form.value = {
    ...form.value,
    unitId: d.unitId ?? '', billingType: d.billingType ?? '',
    variantAxis1Label: d.variantAxis1Label ?? '', variantAxis2Label: d.variantAxis2Label ?? '',
  }
  toast.show('この業態の既定値を再適用しました', 'ok')
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}
function emptyToNull(v: unknown): string | null {
  const s = str(v).trim()
  return s === '' ? null : s
}
function numOrZero(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const saving = ref(false)

async function save(): Promise<void> {
  if (saving.value) return
  const e: Record<string, string> = {}
  if (!str(form.value.code).trim()) e.code = '商品コードは必須です'
  if (!str(form.value.name).trim()) e.name = '商品名は必須です'
  if (!str(form.value.segmentId)) e.segmentId = '事業セグメントは必須です'
  // 必須カスタム項目（F-31）
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of customDefs('product')) {
    if (!d.required) continue
    const v = custom[d.key]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) e[`custom.${d.key}`] = `${d.label}は必須です`
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<Product> & { id?: string } = {
    custom,
    code: str(form.value.code).trim(),
    name: str(form.value.name).trim(),
    segmentId: str(form.value.segmentId),
    categoryId: emptyToNull(form.value.categoryId),
    defaultSupplierCompanyId: emptyToNull(form.value.defaultSupplierCompanyId),
    listPrice: numOrZero(form.value.listPrice),
    standardCost: numOrZero(form.value.standardCost),
    taxRateId: emptyToNull(form.value.taxRateId),
    unitId: emptyToNull(form.value.unitId),
    billingType: emptyToNull(form.value.billingType) as BillingType | null,
    variantAxis1Label: emptyToNull(form.value.variantAxis1Label),
    variantAxis2Label: emptyToNull(form.value.variantAxis2Label),
    description: str(form.value.description),
  }
  const wasCreate = mode.value === 'create'
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  saving.value = true
  try {
    const res = await p.saveProduct(payload)
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    // 新規登録フォームで添付した画像を、作成された商品へまとめて登録する（feature: 登録フォームの画像）
    let imageCapacityWarned = false
    if (wasCreate && res.id && pendingImages.value.length > 0) {
      for (const img of pendingImages.value) {
        const r = await p.addImage(res.id, img)
        if (r.ok && r.persisted === false) imageCapacityWarned = true
      }
      pendingImages.value = []
    }
    toast.show(wasCreate ? '商品を追加しました' : '商品を更新しました', 'ok')
    if (imageCapacityWarned) {
      toast.show('一部の画像は保存容量の上限により再読込時に失われる可能性があります。不要な画像を削除してください', 'warn')
    }
    if (res.id) selectedId.value = res.id
    mode.value = 'view'
  } finally { saving.value = false }
}

async function archiveSelected(): Promise<void> {
  const s = selected.value
  if (!s) return
  const ok = await confirm.ask(
    '商品の無効化',
    `「${s.name}」を無効化しますか？（論理削除。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = await p.archiveProduct(s.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function restoreSelected(): Promise<void> {
  const s = selected.value
  if (!s) return
  const res = await p.restoreProduct(s.id)
  if (res.ok) toast.show('復元しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 画像ギャラリー ----------
function imagesInSection(sectionId: string) {
  if (!selectedId.value) return []
  return p.imagesOf(selectedId.value).filter(i => i.sectionId === sectionId)
}

async function onChangeImageSection(imageId: string, sectionId: string): Promise<void> {
  const res = await p.setImageSection(imageId, sectionId)
  if (res.ok) toast.show('画像のセクションを変更しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function deleteImage(imageId: string, filename: string): Promise<void> {
  const ok = await confirm.ask(
    '画像の削除',
    `「${filename}」を削除しますか？（論理削除）`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const res = await p.archiveImage(imageId)
  if (res.ok) toast.show('画像を削除しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// 画像追加モーダル（実ファイルを縮小して data URI 化して登録）
const imageModalOpen = ref(false)
const imageBusy = ref(false)
const imageForm = ref<{ sectionId: string; filename: string; mime: string; dataUrl: string | null }>({
  sectionId: '', filename: '', mime: '', dataUrl: null,
})
// 新規登録フォームで先に選んだ画像（商品未作成のため保存を保留し、保存時に一括登録する）
interface StagedImage { sectionId: string; filename: string; mime: string; dataUrl: string }
const pendingImages = ref<StagedImage[]>([])

/** 保留画像のセクション名（表示用） */
function sectionNameOf(id: string): string {
  return masters.imageSections.value.find(s => s.id === id)?.name ?? id
}
function removePendingImage(idx: number): void {
  pendingImages.value = pendingImages.value.filter((_, i) => i !== idx)
}

function openImageModal(): void {
  imageForm.value = {
    sectionId: p.activeSections.value[0]?.id ?? '',
    filename: '', mime: '', dataUrl: null,
  }
  imageModalOpen.value = true
}

async function onImageFileChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同じファイルの再選択でも change を発火させる
  // 新しい選択で前回のプレビュー/選択を破棄（却下時に古い画像が残って誤登録されるのを防ぐ）
  imageForm.value.dataUrl = null
  imageForm.value.filename = ''
  imageForm.value.mime = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    toast.show('画像ファイルを選択してください', 'warn')
    return
  }
  imageBusy.value = true
  try {
    const uri = await imageToDataUri(file)
    if (uri.length > IMAGE_MAX_CHARS) {
      toast.show('画像を縮小しても大きすぎます。別の画像をお試しください', 'warn')
      return
    }
    imageForm.value.dataUrl = uri
    imageForm.value.filename = file.name
    imageForm.value.mime = file.type
  } catch (e) {
    toast.show((e as Error).message, 'crit')
  } finally {
    imageBusy.value = false
  }
}

async function saveImage(): Promise<void> {
  if (!imageForm.value.sectionId) {
    toast.show('セクションを選択してください', 'crit')
    return
  }
  if (!imageForm.value.dataUrl) {
    toast.show('画像ファイルを選択してください', 'crit')
    return
  }
  // 新規登録フォーム（商品未作成）では保存を保留し、商品保存時に一括登録する
  if (mode.value === 'create') {
    pendingImages.value = [...pendingImages.value, {
      sectionId: imageForm.value.sectionId,
      filename: imageForm.value.filename || 'image',
      mime: imageForm.value.mime || 'image/*',
      dataUrl: imageForm.value.dataUrl,
    }]
    imageModalOpen.value = false
    toast.show('画像を追加しました（商品の保存時に登録されます）', 'ok')
    return
  }
  if (!selectedId.value) return
  const res = await p.addImage(selectedId.value, {
    sectionId: imageForm.value.sectionId,
    filename: imageForm.value.filename || 'image',
    mime: imageForm.value.mime || 'image/*',
    dataUrl: imageForm.value.dataUrl,
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  if (res.persisted === false) {
    // 追加自体は成功（当セッションでは表示）だが、保存容量超過で永続化できず再読込で失われる可能性
    toast.show('画像を追加しましたが、保存容量が上限に達したため再読込時に失われる可能性があります。不要な画像を削除してください', 'warn')
  } else {
    toast.show('画像を登録しました（「削除」で取り消せます）', 'ok')
  }
  imageModalOpen.value = false
}

// ---------- SKU マトリクス生成モーダル ----------
const matrixModalOpen = ref(false)
const matrixForm = ref<{ axis1: string; axis2: string }>({ axis1: '', axis2: '' })

function openMatrixModal(): void {
  matrixForm.value = { axis1: '', axis2: '' }
  matrixModalOpen.value = true
}

async function saveMatrix(): Promise<void> {
  const s = selected.value
  if (!s) return
  const a1 = matrixForm.value.axis1.split(',').map(v => v.trim()).filter(Boolean)
  const a2 = matrixForm.value.axis2.split(',').map(v => v.trim()).filter(Boolean)
  if (a1.length === 0) {
    toast.show('軸1の値をカンマ区切りで 1 つ以上入力してください', 'crit')
    return
  }
  const res = await p.saveMatrix(s.id, a1, a2)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(`SKU を ${res.id ?? 0} 件生成しました`, 'ok')
  matrixModalOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader title="商品マスタ" description="商品（親）・SKU（バリアント）・画像セクションを管理します">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 商品を追加
        </button>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiFilterBar>
        <UiSelect
          v-model="segmentFilter"
          :options="segmentFilterOptions"
          empty-label="すべてのセグメント"
          aria-label="事業セグメントで絞り込み"
        />
        <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
      </UiFilterBar>

      <AkebonoAppFilterBar
        :fields="filterFields" :model="filterModel" :options-for="filterOptionsFor"
        :active-count="filterActiveCount" :exclude="['segmentId']" @clear="filterClear"
      />

      <UiSectionCard :title="`商品一覧（${total}件）`" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="該当する商品がありません"
          empty-hint="「商品を追加」から登録します（実データ運用は空から始まります）"
          @row-click="openDetail"
        >
          <template #cell-thumb="{ row }">
            <AkebonoProductThumb :product-id="asProduct(row).id" :size="32" />
          </template>
          <template #cell-code="{ row }">
            <span class="num font-medium">{{ asProduct(row).code }}</span>
          </template>
          <template #cell-name="{ row }">
            <span class="font-medium">{{ asProduct(row).name }}</span>
          </template>
          <template #cell-segment="{ row }">
            {{ masters.segmentName(asProduct(row).segmentId) }}
          </template>
          <template #cell-listPrice="{ row }">
            <span class="num tabular-nums">{{ fmtYen(asProduct(row).listPrice) }}</span>
          </template>
          <template #cell-skuCount="{ row }">
            <span class="num tabular-nums">{{ p.skusOf(asProduct(row).id).length }}</span>
          </template>
          <template #cell-active="{ row }">
            <UiStatusBadge
              :label="asProduct(row).active ? '有効' : '無効'"
              :tone="asProduct(row).active ? 'ok' : 'neutral'"
              dot
            />
          </template>
        </UiDataTable>
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </UiSectionCard>
    </div>

    <!-- 詳細・編集ドロワー -->
    <UiDrawer :open="drawerOpen" :title="drawerTitle" width="560px" @close="drawerOpen = false">
      <!-- 閲覧 -->
      <div v-if="mode === 'view' && selected" class="grid gap-4">
        <!-- 商品情報 -->
        <section>
          <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">商品情報</h3>
          <dl class="grid gap-2 text-[13px]">
            <div
              v-for="r in detailRows"
              :key="r.label"
              class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
            >
              <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
              <dd>{{ r.value }}</dd>
            </div>
          </dl>
        </section>

        <!-- 画像ギャラリー -->
        <section>
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">画像</h3>
            <button type="button" class="btn btn-sm" @click="openImageModal">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 画像を追加
            </button>
          </div>
          <div class="grid gap-3">
            <div v-for="sec in p.activeSections.value" :key="sec.id">
              <div class="mb-1 flex items-center gap-1 text-[12px] font-semibold text-sub">
                {{ sec.name }}
                <span v-if="sec.isThumbnailPriority" class="text-[10px] font-normal text-brand">（サムネイル優先）</span>
              </div>
              <div v-if="imagesInSection(sec.id).length === 0" class="text-[12px] text-muted">画像なし</div>
              <ul v-else class="grid gap-2">
                <li
                  v-for="img in imagesInSection(sec.id)"
                  :key="img.id"
                  class="flex items-center gap-2 rounded border border-line p-2"
                >
                  <img
                    v-if="img.dataUrl"
                    :src="img.dataUrl"
                    :alt="img.filename"
                    class="h-10 w-10 shrink-0 rounded border border-line object-cover"
                  >
                  <div
                    v-else
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded text-[14px] font-bold"
                    :class="thumbBoxClass(img.id)"
                    aria-hidden="true"
                  >
                    {{ thumbFirstChar(img.filename) }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[12px] font-medium">{{ img.filename }}</div>
                    <div class="text-[11px] text-muted">{{ img.mime }}</div>
                  </div>
                  <div class="w-32 shrink-0">
                    <UiSelect
                      :model-value="img.sectionId"
                      :options="masters.imageSections.value.map(s => ({ value: s.id, label: s.name }))"
                      aria-label="画像のセクション変更"
                      @update:model-value="onChangeImageSection(img.id, $event)"
                    />
                  </div>
                  <button type="button" class="btn btn-danger btn-sm shrink-0" @click="deleteImage(img.id, img.filename)">削除</button>
                </li>
              </ul>
            </div>
          </div>
          <p class="mt-2 text-[11px] text-muted">
            画像ファイルを登録できます（縮小して保存）。未登録の画像は色プレースホルダで表示します。
          </p>
        </section>

        <!-- SKU -->
        <section>
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">SKU</h3>
            <button v-if="isVariant" type="button" class="btn btn-sm" @click="openMatrixModal">SKU をマトリクス生成</button>
          </div>
          <div v-if="!isVariant" class="rounded border border-line bg-page p-3 text-[12px] text-sub">
            SKU 展開なしの商品です（既定 SKU 1 件）。バリアント軸ラベルを設定すると SKU 展開できます。
          </div>
          <div v-else-if="detailSkus.length === 0" class="rounded border border-line bg-page p-3 text-[12px] text-sub">
            まだ SKU がありません。「SKU をマトリクス生成」で作成してください。
          </div>
          <div v-else class="overflow-x-auto scroll-slim">
            <table class="tbl">
              <thead>
                <tr>
                  <th>{{ selected.variantAxis1Label || '軸1' }}</th>
                  <th>{{ selected.variantAxis2Label || '軸2' }}</th>
                  <th>コード</th>
                  <th>JAN</th>
                  <th class="!text-right">売価</th>
                  <th class="!text-right">原価</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="sku in detailSkus" :key="sku.id">
                  <td>{{ sku.axis1Value ?? '—' }}</td>
                  <td>{{ sku.axis2Value ?? '—' }}</td>
                  <td class="num">{{ sku.code }}</td>
                  <td class="num">{{ sku.janCode ?? '—' }}</td>
                  <td class="text-right num">{{ fmtYen(p.sellPriceOf(sku)) }}</td>
                  <td class="text-right num">{{ fmtYen(p.costOf(sku)) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <!-- 追加・編集フォーム -->
      <div v-else class="grid gap-4">
        <!-- 登録先の業態（既定は入場した業態）+ カスタマイズ切替 -->
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-line bg-surface-soft px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <Layers class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span class="text-[11px] text-muted">登録先の業態</span>
            <span class="truncate text-[12px] font-bold">{{ masters.segmentName(str(form.segmentId)) || '未設定' }}</span>
          </div>
          <button
            type="button"
            class="btn btn-sm shrink-0"
            :aria-expanded="customizeOpen"
            @click="customizeOpen = !customizeOpen"
          >
            <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" /> カスタマイズ
          </button>
        </div>

        <!-- 通常フォーム（入力コスト最小化） -->
        <UiSchemaForm v-model="form" :fields="baseFields" :errors="errors" />

        <!-- 追加カスタム項目（F-31。項目カスタマイズ画面で定義した商品の項目を描画） -->
        <WidgetsCustomFields entity="product" v-model="form" :errors="errors" />

        <!-- カスタマイズ未使用時: 適用中の値を明示（透明性）。create は業態既定・edit は現在値 -->
        <p v-if="!customizeOpen" class="text-[11px] text-muted">
          {{ mode === 'create' ? '業態の既定を適用中' : '現在の設定' }} — {{ appliedDefaultsSummary }}。変更は「カスタマイズ」から。
        </p>

        <!-- カスタマイズフォーム（別フォーム。通常ルートでは編集不可の 5 項目） -->
        <section v-if="customizeOpen" class="rounded-[10px] border border-line p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">カスタマイズ</h3>
            <button type="button" class="btn btn-sm" @click="reapplySegmentDefaults">業態の既定に戻す</button>
          </div>
          <UiSchemaForm v-model="form" :fields="customFields" :errors="errors" />
        </section>

        <!-- 画像（新規登録フォームで添付。保存時に商品へ登録） -->
        <section v-if="mode === 'create'">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">画像</h3>
            <button type="button" class="btn btn-sm" @click="openImageModal">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 画像を追加
            </button>
          </div>
          <div v-if="pendingImages.length === 0" class="rounded border border-line bg-page p-3 text-[12px] text-sub">
            画像を添付できます。商品の保存時にまとめて登録します（未登録の画像は色プレースホルダで表示）。
          </div>
          <ul v-else class="grid gap-2">
            <li
              v-for="(img, idx) in pendingImages"
              :key="idx"
              class="flex items-center gap-2 rounded border border-line p-2"
            >
              <img :src="img.dataUrl" :alt="img.filename" class="h-10 w-10 shrink-0 rounded border border-line object-cover">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] font-medium">{{ img.filename }}</div>
                <div class="text-[11px] text-muted">{{ sectionNameOf(img.sectionId) }}</div>
              </div>
              <button type="button" class="btn btn-danger btn-sm shrink-0" @click="removePendingImage(idx)">削除</button>
            </li>
          </ul>
        </section>
      </div>

      <template #footer>
        <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
          <button v-if="selected.active" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
          <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
          <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
        </div>
        <div v-else class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </template>
    </UiDrawer>

    <!-- 画像追加モーダル -->
    <UiModal :open="imageModalOpen" title="画像を追加" width="420px" topmost @close="imageModalOpen = false">
      <div class="grid gap-3">
        <UiFormField label="セクション" required>
          <UiSelect
            v-model="imageForm.sectionId"
            :options="masters.imageSections.value.map(s => ({ value: s.id, label: s.name }))"
            aria-label="画像セクション"
          />
        </UiFormField>
        <UiFormField label="画像ファイル" required>
          <input
            type="file"
            accept="image/*"
            class="block w-full text-[12px] file:mr-3 file:rounded file:border file:border-line file:bg-surface-soft file:px-2 file:py-1 file:text-[12px]"
            aria-label="画像ファイル"
            @change="onImageFileChange"
          >
        </UiFormField>
        <div v-if="imageBusy" class="text-[12px] text-muted">画像を処理しています…</div>
        <div v-else-if="imageForm.dataUrl" class="flex items-center gap-2">
          <img :src="imageForm.dataUrl" :alt="imageForm.filename" class="h-16 w-16 rounded border border-line object-cover">
          <div class="min-w-0">
            <div class="truncate text-[12px] font-medium">{{ imageForm.filename }}</div>
            <div class="text-[11px] text-muted">{{ imageForm.mime }}</div>
          </div>
        </div>
        <p class="text-[11px] text-muted">
          選択した画像を縮小して保存します（JPEG/PNG。最大 {{ Math.round(IMAGE_MAX_CHARS / 1000) }}KB 相当）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="imageModalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="imageBusy || !imageForm.dataUrl" @click="saveImage">追加する</button>
      </template>
    </UiModal>

    <!-- SKU マトリクス生成モーダル -->
    <UiModal :open="matrixModalOpen" title="SKU をマトリクス生成" width="480px" topmost @close="matrixModalOpen = false">
      <div class="grid gap-3">
        <UiFormField :label="`${selected?.variantAxis1Label || '軸1'} の値（カンマ区切り）`" required hint="例）赤, 青, 白">
          <input v-model="matrixForm.axis1" type="text" class="input" placeholder="赤, 青, 白" aria-label="軸1の値">
        </UiFormField>
        <UiFormField :label="`${selected?.variantAxis2Label || '軸2'} の値（カンマ区切り）`" hint="例）S, M, L">
          <input v-model="matrixForm.axis2" type="text" class="input" placeholder="S, M, L" aria-label="軸2の値">
        </UiFormField>
        <p class="text-[11px] text-muted">
          軸1 × 軸2 の全組合せで SKU を生成します（既存の組合せはスキップ = 冪等）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="matrixModalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="saveMatrix">生成する</button>
      </template>
    </UiModal>
  </div>
</template>
