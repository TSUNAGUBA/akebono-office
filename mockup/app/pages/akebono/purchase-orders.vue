<script setup lang="ts">
/**
 * 発注管理（F-23）
 * 仕入先への発注一覧・作成と状態遷移。状態機械 draft→ordered→partially_received→closed / canceled。
 * 消込率は入荷実績（poId 紐付け）から導出。情報サービス業では外注費に読み替える（ラベル注記）。
 */
import { Plus } from 'lucide-vue-next'
import type { PoStatus, PurchaseOrder } from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { PO_STATUS_LABELS, hasPartnerRole, poStatusTone } from '~/utils/akebono'
import { fmtDate, fmtInt, fmtYen } from '~/utils/format'

const po = usePurchaseOrders()
const products = useProducts()
const { segmentOptions, segmentName } = useAkebonoMasters()
const { tbl } = useMockDb()
const toast = useToast()
const confirm = useConfirm()

// ---------- 仕入先・SKU 選択肢 ----------
const companies = tbl('companies')
const supplierOptions = computed(() =>
  (companies.value as Company[])
    .filter(c => c.active !== false && hasPartnerRole(c, 'supplier'))
    .map(c => ({ value: c.id, label: c.name })))
function companyName(id: string): string {
  return (companies.value as Company[]).find(c => c.id === id)?.name ?? '—'
}

const skuOptions = computed(() => products.activeSkus().map(s => ({ value: s.id, label: products.skuLabel(s) })))
function skuLabelOf(skuId: string): string {
  const s = products.skuById(skuId)
  return s ? products.skuLabel(s) : skuId
}

// ---------- 一覧 ----------
const columns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'supplier', label: '仕入先', primary: true },
  { key: 'segment', label: 'セグメント' },
  { key: 'orderDate', label: '発注日' },
  { key: 'dueDate', label: '納期', primary: true },
  { key: 'total', label: '金額', align: 'right', primary: true },
  { key: 'consumed', label: '消込', align: 'right' },
  { key: 'status', label: '状態', primary: true },
]

const tableRows = computed(() =>
  po.activeOrders.value.map(o => ({
    id: o.id,
    code: o.code,
    supplier: companyName(o.companyId),
    segment: segmentName(o.segmentId),
    orderDate: fmtDate(o.orderDate),
    dueDate: fmtDate(o.dueDate),
    total: fmtYen(po.orderTotal(o)),
    consumed: `${fmtInt(po.receivedQtyOf(o.id))} / ${fmtInt(po.orderedQtyOf(o))}`,
    status: o.status,
  })) as unknown as Record<string, unknown>[],
)

// ---------- 詳細ドロワー ----------
const drawerOpen = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed<PurchaseOrder | undefined>(() =>
  selectedId.value ? po.orderById(selectedId.value) : undefined)

const detailLines = computed(() => {
  const o = selected.value
  if (!o) return []
  return o.lines.map(l => ({
    id: l.id,
    label: skuLabelOf(l.skuId),
    qty: l.qty,
    unitPrice: l.unitPrice,
    subtotal: l.qty * l.unitPrice,
  }))
})

const nextStatuses = computed<PoStatus[]>(() => {
  const o = selected.value
  return o ? po.NEXT[o.status] : []
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  drawerOpen.value = true
}

async function transition(status: PoStatus): Promise<void> {
  const o = selected.value
  if (!o) return
  if (status === 'canceled') {
    const ok = await confirm.ask(
      '発注の取消',
      `「${o.code}」を取消にしますか？`,
      { danger: true, confirmLabel: '取消にする' },
    )
    if (!ok) return
  }
  const res = po.setStatus(o.id, status)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(`「${PO_STATUS_LABELS[status]}」にしました`, status === 'canceled' ? 'warn' : 'ok')
}

// ---------- 発注を作成 ----------
const createOpen = ref(false)
const createForm = ref<{
  companyId: string
  segmentId: string
  orderDate: string
  dueDate: string
  note: string
  lines: { skuId: string; qty: number; price?: number }[]
}>({ companyId: '', segmentId: '', orderDate: '', dueDate: '', note: '', lines: [] })

function openCreate(): void {
  createForm.value = {
    companyId: supplierOptions.value[0]?.value ?? '',
    segmentId: segmentOptions.value[0]?.value ?? '',
    orderDate: '',
    dueDate: '',
    note: '',
    lines: [{ skuId: '', qty: 1, price: 0 }],
  }
  createOpen.value = true
}

function submitCreate(): void {
  const f = createForm.value
  if (!f.companyId) {
    toast.show('仕入先を選択してください', 'crit')
    return
  }
  if (!f.segmentId) {
    toast.show('事業セグメントを選択してください', 'crit')
    return
  }
  if (!f.orderDate) {
    toast.show('発注日を入力してください', 'crit')
    return
  }
  if (!f.dueDate) {
    toast.show('納期を入力してください', 'crit')
    return
  }
  const res = po.createOrder({
    companyId: f.companyId,
    segmentId: f.segmentId,
    orderDate: f.orderDate,
    dueDate: f.dueDate,
    note: f.note,
    lines: f.lines.map(l => ({ skuId: l.skuId, qty: Number(l.qty), unitPrice: Number(l.price ?? 0) })),
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('発注を作成しました（発注済み）', 'ok')
  createOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader title="発注管理" description="仕入先への発注の作成・状態管理と入荷消込の確認">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 発注を作成
        </button>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiSectionCard :title="`発注一覧（${po.activeOrders.value.length}件）`" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="発注がありません"
          @row-click="openDetail"
        >
          <template #cell-code="{ row }">
            <span class="font-medium">{{ row.code }}</span>
          </template>
          <template #cell-total="{ row }">
            <span class="num tabular-nums">{{ row.total }}</span>
          </template>
          <template #cell-consumed="{ row }">
            <span class="num tabular-nums text-sub">{{ row.consumed }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="PO_STATUS_LABELS[row.status as PoStatus]"
              :tone="poStatusTone(row.status as PoStatus)"
              dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- 発注詳細ドロワー -->
    <UiDrawer :open="drawerOpen" :title="selected ? `発注 ${selected.code}` : '発注'" width="560px" @close="drawerOpen = false">
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
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">発注日 / 納期</dt>
            <dd>{{ fmtDate(selected.orderDate) }} 〜 {{ fmtDate(selected.dueDate) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">状態</dt>
            <dd>
              <UiStatusBadge :label="PO_STATUS_LABELS[selected.status]" :tone="poStatusTone(selected.status)" dot />
            </dd>
          </div>
          <div v-if="selected.note" class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">備考</dt>
            <dd class="whitespace-pre-wrap">{{ selected.note }}</dd>
          </div>
        </dl>

        <div>
          <div class="mb-1.5 text-[11px] font-semibold text-muted">明細</div>
          <div class="grid gap-1.5">
            <div class="grid grid-cols-[1fr_56px_88px_96px] gap-2 border-b border-line pb-1 text-[11px] font-semibold text-muted">
              <span>SKU</span>
              <span class="text-right">数量</span>
              <span class="text-right">単価</span>
              <span class="text-right">小計</span>
            </div>
            <div
              v-for="l in detailLines"
              :key="l.id"
              class="grid grid-cols-[1fr_56px_88px_96px] items-center gap-2 border-b border-line pb-1.5 text-[13px] last:border-0"
            >
              <span>{{ l.label }}</span>
              <span class="num text-right tabular-nums">{{ fmtInt(l.qty) }}</span>
              <span class="num text-right tabular-nums">{{ fmtYen(l.unitPrice) }}</span>
              <span class="num text-right tabular-nums">{{ fmtYen(l.subtotal) }}</span>
            </div>
            <div class="grid grid-cols-[1fr_auto] items-center gap-2 pt-1 text-[13px]">
              <span class="text-[11px] font-semibold text-muted">合計</span>
              <span class="num tabular-nums text-base font-bold">{{ fmtYen(po.orderTotal(selected)) }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div v-if="selected" class="flex flex-wrap items-center justify-end gap-2">
          <span v-if="nextStatuses.length === 0" class="text-[12px] text-muted">この状態からの遷移はありません</span>
          <button
            v-for="ns in nextStatuses"
            :key="ns"
            type="button"
            class="btn btn-sm"
            :class="ns === 'canceled' ? 'btn-danger' : 'btn-primary'"
            @click="transition(ns)"
          >
            {{ PO_STATUS_LABELS[ns] }}にする
          </button>
        </div>
      </template>
    </UiDrawer>

    <!-- 発注を作成 -->
    <UiModal :open="createOpen" title="発注を作成" width="600px" @close="createOpen = false">
      <div class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <UiFormField label="仕入先" required>
            <UiSelect v-model="createForm.companyId" :options="supplierOptions" aria-label="仕入先" />
          </UiFormField>
          <UiFormField label="事業セグメント" required>
            <UiSelect v-model="createForm.segmentId" :options="segmentOptions" aria-label="事業セグメント" />
          </UiFormField>
          <UiFormField label="発注日" required>
            <input v-model="createForm.orderDate" type="date" class="input" aria-label="発注日">
          </UiFormField>
          <UiFormField label="納期" required>
            <input v-model="createForm.dueDate" type="date" class="input" aria-label="納期">
          </UiFormField>
        </div>
        <UiFormField label="備考">
          <textarea v-model="createForm.note" class="textarea" rows="2" placeholder="任意" aria-label="備考" />
        </UiFormField>
        <UiFormField label="発注明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="createForm.lines" :sku-options="skuOptions" price-label="単価" />
        </UiFormField>
        <p class="text-[11px] text-muted">
          情報サービス業のセグメントでは、この発注は外注費（外注先への委託）として読み替えて計上されます。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitCreate">作成する</button>
      </template>
    </UiModal>
  </div>
</template>
