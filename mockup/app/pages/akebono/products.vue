<script setup lang="ts">
/**
 * 商品マスタ管理（F-21）
 * 商品（親）+ SKU（バリアント 2 軸）+ 画像（セクション別）を一覧・詳細ドロワーで管理する。
 * 展開なし商品は既定 SKU 1 件（SKU 数 1 表示）。バリアント商品はマトリクス生成で SKU 展開。
 * 画像は data URI 実体を持たない色プレースホルダで描画（実アップロードはモック対象外）。
 */
import { Image as ImageIcon, Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { BillingType, Product, ProductSku } from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'
import { BILLING_TYPE_LABELS, hasPartnerRole } from '~/utils/akebono'
import { fmtYen } from '~/utils/format'

const p = useProducts()
const masters = useAkebonoMasters()
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
const search = ref('')
const segmentFilter = ref('')
const statusFilter = ref('active')

const segmentFilterOptions = computed(() => masters.segmentOptions.value)

const filtered = computed(() =>
  (p.products.value as Product[])
    .filter((prod) => {
      if (!matchesActiveFilter(prod, statusFilter.value)) return false
      if (segmentFilter.value && prod.segmentId !== segmentFilter.value) return false
      const q = search.value.trim().toLowerCase()
      return !q || prod.code.toLowerCase().includes(q) || prod.name.toLowerCase().includes(q)
    })
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, 'ja')),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'thumb', label: '', width: '48px' },
  { key: 'code', label: '商品コード', primary: true },
  { key: 'name', label: '商品名', primary: true },
  { key: 'segment', label: 'セグメント' },
  { key: 'listPrice', label: '標準売価', align: 'right', primary: true },
  { key: 'skuCount', label: 'SKU数', align: 'right' },
  { key: 'active', label: '状態', primary: true },
]

function asProduct(row: Record<string, unknown>): Product {
  return row as unknown as Product
}

// ---------- 色プレースホルダ（画像・サムネイル。静的クラスで Tailwind 保持） ----------
const BOX_CLASSES = [
  'bg-brand-soft text-brand',
  'bg-ok-soft text-ok',
  'bg-info-soft text-info',
  'bg-warn-soft text-warn',
  'bg-serious-soft text-serious',
]
function boxClass(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return BOX_CLASSES[h % BOX_CLASSES.length]!
}
function firstChar(s: string): string {
  return (s.trim()[0] ?? '?').toUpperCase()
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

const formFields = computed<FieldDef[]>(() => [
  { key: 'code', label: '商品コード', type: 'text', required: true, placeholder: '例）AB-1001' },
  { key: 'name', label: '商品名', type: 'text', required: true },
  { key: 'segmentId', label: '事業セグメント', type: 'select', required: true, options: masters.segmentOptions.value },
  { key: 'categoryId', label: '商品カテゴリ', type: 'select', options: masters.categoryOptions.value, emptyLabel: '（未分類）' },
  { key: 'defaultSupplierCompanyId', label: '仕入先', type: 'select', options: supplierOptions.value, emptyLabel: '（未指定）' },
  { key: 'listPrice', label: '標準売価（円）', type: 'number', min: 0, step: 1 },
  { key: 'standardCost', label: '標準原価（円）', type: 'number', min: 0, step: 1 },
  { key: 'taxRateId', label: '税区分', type: 'select', options: masters.taxRateOptions.value, emptyLabel: '（未指定）' },
  { key: 'unitId', label: '単位', type: 'select', options: masters.unitOptions.value, emptyLabel: '（未指定）' },
  { key: 'billingType', label: '課金区分', type: 'select', options: billingTypeOptions, emptyLabel: '（物販）' },
  { key: 'variantAxis1Label', label: 'バリアント軸1ラベル', type: 'text', placeholder: '例）カラー', hint: '入力すると SKU 展開商品になります' },
  { key: 'variantAxis2Label', label: 'バリアント軸2ラベル', type: 'text', placeholder: '例）サイズ（任意）' },
  { key: 'description', label: '説明', type: 'textarea' },
])

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
  form.value = {
    code: '', name: '', segmentId: segmentFilter.value || '', categoryId: '',
    defaultSupplierCompanyId: '', listPrice: '', standardCost: '', taxRateId: '',
    unitId: '', billingType: '', variantAxis1Label: '', variantAxis2Label: '', description: '',
  }
  errors.value = {}
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
  }
  errors.value = {}
  mode.value = 'edit'
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

function save(): void {
  const e: Record<string, string> = {}
  if (!str(form.value.code).trim()) e.code = '商品コードは必須です'
  if (!str(form.value.name).trim()) e.name = '商品名は必須です'
  if (!str(form.value.segmentId)) e.segmentId = '事業セグメントは必須です'
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<Product> & { id?: string } = {
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
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = p.saveProduct(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '商品を追加しました' : '商品を更新しました', 'ok')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
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
  const res = p.archiveProduct(s.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

function restoreSelected(): void {
  const s = selected.value
  if (!s) return
  const res = p.restoreProduct(s.id)
  if (res.ok) toast.show('復元しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 画像ギャラリー ----------
function imagesInSection(sectionId: string) {
  if (!selectedId.value) return []
  return p.imagesOf(selectedId.value).filter(i => i.sectionId === sectionId)
}

function onChangeImageSection(imageId: string, sectionId: string): void {
  const res = p.setImageSection(imageId, sectionId)
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
  const res = p.archiveImage(imageId)
  if (res.ok) toast.show('画像を削除しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// 画像追加モーダル
const imageModalOpen = ref(false)
const imageForm = ref<{ sectionId: string; filename: string }>({ sectionId: '', filename: '' })

function openImageModal(): void {
  imageForm.value = {
    sectionId: p.activeSections.value[0]?.id ?? '',
    filename: '',
  }
  imageModalOpen.value = true
}

function mimeOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

function saveImage(): void {
  if (!selectedId.value) return
  const filename = imageForm.value.filename.trim()
  if (!imageForm.value.sectionId) {
    toast.show('セクションを選択してください', 'crit')
    return
  }
  if (!filename) {
    toast.show('ファイル名を入力してください', 'crit')
    return
  }
  const res = p.addImage(selectedId.value, {
    sectionId: imageForm.value.sectionId,
    filename,
    mime: mimeOf(filename),
    dataUrl: null,
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('画像プレースホルダを追加しました', 'ok')
  imageModalOpen.value = false
}

// ---------- SKU マトリクス生成モーダル ----------
const matrixModalOpen = ref(false)
const matrixForm = ref<{ axis1: string; axis2: string }>({ axis1: '', axis2: '' })

function openMatrixModal(): void {
  matrixForm.value = { axis1: '', axis2: '' }
  matrixModalOpen.value = true
}

function saveMatrix(): void {
  const s = selected.value
  if (!s) return
  const a1 = matrixForm.value.axis1.split(',').map(v => v.trim()).filter(Boolean)
  const a2 = matrixForm.value.axis2.split(',').map(v => v.trim()).filter(Boolean)
  if (a1.length === 0) {
    toast.show('軸1の値をカンマ区切りで 1 つ以上入力してください', 'crit')
    return
  }
  const res = p.saveMatrix(s.id, a1, a2)
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
        <UiSearchInput v-model="search" placeholder="商品コード・商品名で検索" />
        <UiSelect
          v-model="segmentFilter"
          :options="segmentFilterOptions"
          empty-label="すべてのセグメント"
          aria-label="事業セグメントで絞り込み"
        />
        <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
      </UiFilterBar>

      <UiSectionCard :title="`商品一覧（${filtered.length}件）`" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="該当する商品がありません"
          @row-click="openDetail"
        >
          <template #cell-thumb="{ row }">
            <div
              v-if="p.thumbnailOf(asProduct(row).id)"
              class="flex h-8 w-8 items-center justify-center rounded text-[13px] font-bold"
              :class="boxClass(asProduct(row).id)"
              aria-hidden="true"
            >
              {{ firstChar(asProduct(row).name) }}
            </div>
            <div
              v-else
              class="flex h-8 w-8 items-center justify-center rounded border border-line bg-page text-muted"
              aria-hidden="true"
            >
              <ImageIcon class="h-3.5 w-3.5" />
            </div>
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
                  <div
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded text-[14px] font-bold"
                    :class="boxClass(img.id)"
                    aria-hidden="true"
                  >
                    {{ firstChar(img.filename) }}
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
            画像は色プレースホルダで表示しています。実ファイルのアップロードはモック対象外です。
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
      <UiSchemaForm v-else v-model="form" :fields="formFields" :errors="errors" />

      <template #footer>
        <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
          <button v-if="selected.active" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
          <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
          <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
        </div>
        <div v-else class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="save">保存</button>
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
        <UiFormField label="ファイル名" required>
          <input v-model="imageForm.filename" type="text" class="input" placeholder="例）front.png" aria-label="ファイル名">
        </UiFormField>
        <p class="text-[11px] text-muted">
          実ファイルは保存せず、色プレースホルダを追加します（モック）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="imageModalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="saveImage">追加する</button>
      </template>
    </UiModal>

    <!-- SKU マトリクス生成モーダル -->
    <UiModal :open="matrixModalOpen" title="SKU をマトリクス生成" width="480px" topmost @close="matrixModalOpen = false">
      <div class="grid gap-3">
        <UiFormField :label="`${selected?.variantAxis1Label || '軸1'} の値（カンマ区切り）`" required hint="例）赤, 青, 白">
          <input v-model="matrixForm.axis1" type="text" class="input" placeholder="赤, 青, 白" aria-label="軸1の値">
        </UiFormField>
        <UiFormField :label="`${selected?.variantAxis2Label || '軸2'} の値（カンマ区切り・任意）`" hint="例）S, M, L">
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
