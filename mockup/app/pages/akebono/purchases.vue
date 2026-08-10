<script setup lang="ts">
/**
 * 仕入管理（F-24）
 * 仕入計上（買取 / 委託）の一覧・計上・赤黒訂正。記録系のため訂正は元不変のマイナス伝票で行う。
 * 入荷管理 ON（既定）のときは入荷実績で入庫済みのため倉庫指定は任意。
 * 委託は販売時精算（請求管理 F-29-4）で債務確定する旨を注記。
 */
import { Plus } from 'lucide-vue-next'
import type { PurchaseRecord, PurchaseType } from '~/types/akebono'
import type { Company, CustomValues } from '~/types/domain'
import { hasPartnerRole, partnerRolesOf } from '~/utils/akebono'
import { fmtDate, fmtInt, fmtYen } from '~/utils/format'

const purchases = usePurchases()
const products = useProducts()
const { missingRequiredCustom } = useAppFields()
const { segmentOptions, segmentName, warehouseOptions } = useAkebonoMasters()
const { effectiveSegmentId } = useCurrentSegment()
const { tbl } = useMockDb()
const toast = useToast()
// 二重送信ガード(Phase C: API 書込の重複作成防止。§34 の実行中フィードバック)
const busy = ref(false)
const confirm = useConfirm()

// ---------- 区分ラベル・トーン（ドメイン固有・固定 enum） ----------
const PURCHASE_TYPE_LABELS: Record<PurchaseType, string> = {
  outright: '買取',
  consignment: '委託',
}
const purchaseTypeOptions = (Object.keys(PURCHASE_TYPE_LABELS) as PurchaseType[])
  .map(v => ({ value: v, label: PURCHASE_TYPE_LABELS[v] }))
function purchaseTypeTone(t: PurchaseType): 'brand' | 'info' {
  return t === 'outright' ? 'brand' : 'info'
}

// ---------- 仕入先・SKU 選択肢 ----------
const companies = tbl('companies')
const supplierOptions = computed(() =>
  (companies.value as Company[])
    .filter(c => c.active !== false && (hasPartnerRole(c, 'supplier') || partnerRolesOf(c).includes('consignor_artist')))
    .map(c => ({ value: c.id, label: c.name })))
function companyName(id: string): string {
  return (companies.value as Company[]).find(c => c.id === id)?.name ?? '—'
}

const skuOptions = computed(() => products.activeSkus().map(s => ({ value: s.id, label: products.skuLabel(s) })))
function skuLabelOf(skuId: string): string {
  const s = products.skuById(skuId)
  return s ? products.skuLabel(s) : skuId
}

// ---------- 一覧（検索 + ページング。モック=クライアント / API=サーバー） ----------
const {
  fields: filterFields, optionsFor: filterOptionsFor, model: filterModel,
  matchRow: filterMatchRow, queryParams: filterQueryParams, activeCount: filterActiveCount, clear: filterClear,
} = useAppFilter('purchase_record')
const { page, pageSize, rows: pageRows, total, refresh } = useListView<PurchaseRecord>({
  source: purchases.activeRecords,
  filterPredicate: computed(() => (r: PurchaseRecord) => filterMatchRow(r as unknown as Record<string, unknown>)),
  filterParams: filterQueryParams,
  fetch: p => apiListPage<PurchaseRecord>('purchaseRecords', p),
})

const { listColumns, decorateRows } = useAppListView()
// 一覧列は項目設定（表示 ON/OFF・表示名）で解決＋カスタム項目列を付加。派生列（金額・訂正状態）は itemKey 無し＝常時表示
const columns = computed(() => listColumns('purchase_record', [
  { key: 'code', label: 'コード', primary: true, itemKey: 'code' },
  { key: 'supplier', label: '仕入先', primary: true, itemKey: 'companyId' },
  { key: 'segment', label: 'セグメント', itemKey: 'segmentId' },
  { key: 'purchaseDate', label: '仕入日', itemKey: 'purchaseDate' },
  { key: 'purchaseType', label: '区分', primary: true, itemKey: 'purchaseType' },
  { key: 'total', label: '金額', align: 'right', primary: true },
]))

const tableRows = computed(() =>
  decorateRows('purchase_record', pageRows.value.map(r => ({
    id: r.id,
    code: r.code,
    supplier: companyName(r.companyId),
    segment: segmentName(r.segmentId),
    purchaseDate: fmtDate(r.purchaseDate),
    purchaseType: r.purchaseType,
    total: fmtYen(purchases.recordTotal(r)),
    isCorrection: !!r.correctionOf,
    custom: r.custom ?? {},
  }))) as unknown as Record<string, unknown>[],
)

// ---------- 詳細ドロワー ----------
const drawerOpen = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed<PurchaseRecord | undefined>(() =>
  selectedId.value ? purchases.recordById(selectedId.value) : undefined)

const sourceRecord = computed<PurchaseRecord | undefined>(() =>
  selected.value?.correctionOf ? purchases.recordById(selected.value.correctionOf) : undefined)

const detailLines = computed(() => {
  const r = selected.value
  if (!r) return []
  return r.lines.map(l => ({
    id: l.id,
    skuId: l.skuId,
    label: skuLabelOf(l.skuId),
    qty: l.qty,
    costPrice: l.costPrice,
    subtotal: l.qty * l.costPrice,
  }))
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  drawerOpen.value = true
}

async function correctSelected(): Promise<void> {
  const r = selected.value
  if (!r) return
  const ok = await confirm.ask(
    '赤黒訂正',
    `「${r.code}」を赤黒訂正しますか？（元伝票は不変のまま、マイナス明細の訂正伝票を追加します）`,
    { danger: true, confirmLabel: '訂正する' },
  )
  if (!ok) return
  const res = await purchases.correct(r.id)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('赤黒訂正の伝票を追加しました', 'warn')
  if (res.id) selectedId.value = res.id
  refresh() // サーバーページング時は現在ページを取り直す（クライアントは自動追従）
}

// ---------- 仕入を計上 ----------
const createOpen = ref(false)
const createForm = ref<{
  companyId: string
  segmentId: string
  purchaseDate: string
  purchaseType: PurchaseType
  warehouseId: string
  custom: CustomValues
  lines: { skuId: string; qty: number; price?: number }[]
}>({ companyId: '', segmentId: '', purchaseDate: '', purchaseType: 'outright', warehouseId: '', custom: {}, lines: [] })

function openCreate(): void {
  createForm.value = {
    companyId: supplierOptions.value[0]?.value ?? '',
    segmentId: effectiveSegmentId.value || (segmentOptions.value[0]?.value ?? ''),
    purchaseDate: todayJst(),
    purchaseType: 'outright',
    warehouseId: '',
    custom: {},
    lines: [{ skuId: '', qty: 1, price: 0 }],
  }
  createOpen.value = true
}

async function submitCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try { await submitCreateInner() } finally { busy.value = false }
}

async function submitCreateInner(): Promise<void> {
  const f = createForm.value
  if (!f.companyId) {
    toast.show('仕入先を選択してください', 'crit')
    return
  }
  if (!f.segmentId) {
    toast.show('事業セグメントを選択してください', 'crit')
    return
  }
  if (!f.purchaseDate) {
    toast.show('仕入日を入力してください', 'crit')
    return
  }
  const missCustom = missingRequiredCustom('purchase_record', f.custom)
  if (missCustom) {
    toast.show(`${missCustom}は必須です`, 'crit')
    return
  }
  const res = await purchases.create({
    companyId: f.companyId,
    segmentId: f.segmentId,
    purchaseDate: f.purchaseDate,
    purchaseType: f.purchaseType,
    warehouseId: f.warehouseId || null,
    custom: f.custom,
    lines: f.lines.map(l => ({ skuId: l.skuId, qty: Number(l.qty), costPrice: Number(l.price ?? 0) })),
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('仕入を計上しました', 'ok')
  createOpen.value = false
  refresh() // サーバーページング時は現在ページを取り直す（クライアントは自動追従）
}
</script>

<template>
  <div>
    <UiPageHeader title="仕入管理" description="仕入計上（買取 / 委託）の記帳と赤黒訂正">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 仕入を計上
        </button>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiSectionCard :title="`仕入一覧（${total}件）`" flush>
        <AkebonoAppFilterBar
          :fields="filterFields" :model="filterModel" :options-for="filterOptionsFor"
          :active-count="filterActiveCount" @clear="filterClear"
        />
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="仕入がありません"
          empty-hint="「仕入を計上」から登録できます"
          @row-click="openDetail"
        >
          <template #cell-code="{ row }">
            <span class="font-medium">{{ row.code }}</span>
            <UiStatusBadge v-if="row.isCorrection" class="ml-1" label="訂正" tone="neutral" />
          </template>
          <template #cell-purchaseType="{ row }">
            <UiStatusBadge
              :label="PURCHASE_TYPE_LABELS[row.purchaseType as PurchaseType]"
              :tone="purchaseTypeTone(row.purchaseType as PurchaseType)"
              dot
            />
          </template>
          <template #cell-total="{ row }">
            <span class="num tabular-nums">{{ row.total }}</span>
          </template>
        </UiDataTable>
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </UiSectionCard>
    </div>

    <!-- 仕入詳細ドロワー -->
    <UiDrawer :open="drawerOpen" :title="selected ? `仕入 ${selected.code}` : '仕入'" width="560px" @close="drawerOpen = false">
      <div v-if="selected" class="grid gap-3">
        <dl class="grid gap-2 text-[13px]">
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">仕入先</dt>
            <dd>{{ companyName(selected.companyId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">セグメント</dt>
            <dd>{{ segmentName(selected.segmentId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">仕入日</dt>
            <dd>{{ fmtDate(selected.purchaseDate) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">区分</dt>
            <dd>
              <UiStatusBadge
                :label="PURCHASE_TYPE_LABELS[selected.purchaseType]"
                :tone="purchaseTypeTone(selected.purchaseType)"
                dot
              />
            </dd>
          </div>
        </dl>

        <div
          v-if="selected.correctionOf"
          class="rounded-md border border-line bg-page px-3 py-2 text-[12px] text-sub"
        >
          この伝票は
          <span class="font-semibold">{{ sourceRecord?.code ?? '元伝票' }}</span>
          の赤黒訂正です（マイナス明細。元伝票は変更されません）。
        </div>
        <div
          v-else-if="selected.purchaseType === 'consignment'"
          class="rounded-md border border-line bg-page px-3 py-2 text-[12px] text-sub"
        >
          委託仕入は販売時に精算されます（債務確定は請求管理 F-29-4 の委託精算で行います）。
        </div>

        <div>
          <div class="mb-1.5 text-[11px] font-semibold text-muted">明細</div>
          <div class="grid gap-1.5">
            <div class="grid grid-cols-[1fr_56px_88px_96px] gap-2 border-b border-line pb-1 text-[11px] font-semibold text-muted">
              <span>SKU</span>
              <span class="text-right">数量</span>
              <span class="text-right">原価</span>
              <span class="text-right">小計</span>
            </div>
            <div
              v-for="l in detailLines"
              :key="l.id"
              class="grid grid-cols-[1fr_56px_88px_96px] items-center gap-2 border-b border-line pb-1.5 text-[13px] last:border-0"
            >
              <span class="flex min-w-0 items-center gap-2">
                <AkebonoProductThumb :sku-id="l.skuId" :size="20" />
                <span class="truncate">{{ l.label }}</span>
              </span>
              <span class="num text-right tabular-nums">{{ fmtInt(l.qty) }}</span>
              <span class="num text-right tabular-nums">{{ fmtYen(l.costPrice) }}</span>
              <span class="num text-right tabular-nums">{{ fmtYen(l.subtotal) }}</span>
            </div>
            <div class="grid grid-cols-[1fr_auto] items-center gap-2 pt-1 text-[13px]">
              <span class="text-[11px] font-semibold text-muted">合計</span>
              <span class="num tabular-nums text-base font-bold">{{ fmtYen(purchases.recordTotal(selected)) }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div v-if="selected" class="flex items-center justify-end gap-2">
          <button
            v-if="!selected.correctionOf"
            type="button"
            class="btn btn-danger btn-sm"
            @click="correctSelected"
          >
            赤黒訂正
          </button>
          <span v-else class="text-[12px] text-muted">訂正伝票は再訂正できません</span>
        </div>
      </template>
    </UiDrawer>

    <!-- 仕入を計上 -->
    <UiModal :open="createOpen" title="仕入を計上" width="600px" @close="createOpen = false">
      <div class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <UiFormField label="仕入先" required>
            <AkebonoAppRefSelect v-model="createForm.companyId" :options="supplierOptions" aria-label="仕入先" placeholder="仕入先を検索して選択" />
          </UiFormField>
          <UiFormField label="事業セグメント" required>
            <UiSelect v-model="createForm.segmentId" :options="segmentOptions" aria-label="事業セグメント" />
          </UiFormField>
          <UiFormField label="仕入日" required>
            <input v-model="createForm.purchaseDate" type="date" class="input" aria-label="仕入日">
          </UiFormField>
          <UiFormField label="区分" required>
            <UiSelect v-model="createForm.purchaseType" :options="purchaseTypeOptions" aria-label="区分" />
          </UiFormField>
          <UiFormField label="入庫倉庫" hint="入荷管理 ON のときは入荷実績で入庫済み（任意）">
            <UiSelect v-model="createForm.warehouseId" :options="warehouseOptions" empty-label="（指定しない）" aria-label="入庫倉庫" />
          </UiFormField>
        </div>
        <UiFormField label="仕入明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="createForm.lines" :sku-options="skuOptions" price-label="原価" />
        </UiFormField>
        <WidgetsCustomFields entity="purchase_record" v-model="createForm" />
        <p v-if="createForm.purchaseType === 'consignment'" class="text-[11px] text-muted">
          委託仕入は販売時に精算されます（債務確定は請求管理 F-29-4 の委託精算で行います）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="submitCreate">計上する</button>
      </template>
    </UiModal>
  </div>
</template>
