<script setup lang="ts">
/**
 * 在庫管理（F-27）
 * SoT = inventoryTransactions（台帳・追記のみ）。残高は台帳から導出（useInventory）。
 * 在庫照会 / 受払（台帳）/ 棚卸 の 3 ビュー。調整・移動・棚卸は台帳へ追記する。
 */
import { ArrowLeftRight, SlidersHorizontal, ClipboardCheck } from 'lucide-vue-next'
import type { TableColumn, TabItem } from '~/types/ui'
import type { InventoryAdjustReason } from '~/types/akebono'
import { INVENTORY_KIND_LABELS, ADJUST_REASON_LABELS } from '~/utils/akebono'
import { fmtDateTime, fmtInt } from '~/utils/format'

const inv = useInventory()
const p = useProducts()
const masters = useAkebonoMasters()
const toast = useToast()
const confirm = useConfirm()

// ---------- 共通選択肢 ----------
const skuOptions = computed(() => p.activeSkus().map(s => ({ value: s.id, label: p.skuLabel(s) })))
const warehouseOptions = computed(() => masters.warehouseOptions.value)
const reasonOptions = Object.entries(ADJUST_REASON_LABELS).map(([value, label]) => ({ value, label }))

function skuLabelOf(id: string): string {
  const s = p.skuById(id)
  return s ? p.skuLabel(s) : id
}

// ---------- タブ ----------
const tabs: TabItem[] = [
  { key: 'browse', label: '在庫照会' },
  { key: 'ledger', label: '受払（台帳）' },
  { key: 'stocktake', label: '棚卸' },
]
const tab = ref('browse')

// ========== 在庫照会 ==========
const browseWh = ref('')
const browseSearch = ref('')

const browseRows = computed(() => {
  const q = browseSearch.value.trim().toLowerCase()
  const rows: Record<string, unknown>[] = []
  for (const sku of p.activeSkus()) {
    const label = p.skuLabel(sku)
    if (q && !label.toLowerCase().includes(q)) continue
    for (const wh of masters.warehouses.value) {
      if (browseWh.value && wh.id !== browseWh.value) continue
      const qty = inv.balanceOf(sku.id, wh.id)
      if (qty === 0) continue
      rows.push({
        id: `${sku.id}::${wh.id}`,
        skuLabel: label,
        warehouseName: masters.warehouseName(wh.id),
        qty,
      })
    }
  }
  return rows
})

const browseColumns: TableColumn[] = [
  { key: 'skuLabel', label: 'SKU', primary: true },
  { key: 'warehouseName', label: '倉庫', primary: true },
  { key: 'qty', label: '数量', align: 'right', primary: true },
]

// ---------- 在庫調整モーダル ----------
const adjustOpen = ref(false)
const adjustForm = ref({ skuId: '', warehouseId: '', qty: '', reason: 'defective' })

function openAdjust(): void {
  adjustForm.value = {
    skuId: skuOptions.value[0]?.value ?? '',
    warehouseId: warehouseOptions.value[0]?.value ?? '',
    qty: '',
    reason: 'defective',
  }
  adjustOpen.value = true
}

async function submitAdjust(): Promise<void> {
  const f = adjustForm.value
  const qty = Number(f.qty)
  if (!f.skuId || !f.warehouseId) {
    toast.show('SKU と倉庫を選択してください', 'crit')
    return
  }
  if (f.qty === '' || !Number.isFinite(qty) || qty === 0) {
    toast.show('調整数量は 0 以外で入力してください（+ 増 / − 減）', 'crit')
    return
  }
  const ok = await confirm.ask(
    '在庫調整の確定',
    `${skuLabelOf(f.skuId)} / ${masters.warehouseName(f.warehouseId)} を ${qty > 0 ? '+' : ''}${fmtInt(qty)} 調整します（理由: ${ADJUST_REASON_LABELS[f.reason]}）。台帳へ追記されます。`,
    { confirmLabel: '調整する' },
  )
  if (!ok) return
  const res = inv.adjust({ skuId: f.skuId, warehouseId: f.warehouseId, qty, reason: f.reason as InventoryAdjustReason })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('在庫を調整しました（台帳へ追記）', 'ok')
  adjustOpen.value = false
}

// ---------- 倉庫間移動モーダル ----------
const transferOpen = ref(false)
const transferForm = ref({ skuId: '', fromWarehouseId: '', toWarehouseId: '', qty: '' })

function openTransfer(): void {
  transferForm.value = {
    skuId: skuOptions.value[0]?.value ?? '',
    fromWarehouseId: warehouseOptions.value[0]?.value ?? '',
    toWarehouseId: warehouseOptions.value[1]?.value ?? warehouseOptions.value[0]?.value ?? '',
    qty: '',
  }
  transferOpen.value = true
}

const transferAvail = computed(() => {
  const f = transferForm.value
  if (!f.skuId || !f.fromWarehouseId) return 0
  return inv.balanceOf(f.skuId, f.fromWarehouseId)
})

async function submitTransfer(): Promise<void> {
  const f = transferForm.value
  const qty = Number(f.qty)
  if (!f.skuId || !f.fromWarehouseId || !f.toWarehouseId) {
    toast.show('SKU・移動元・移動先を選択してください', 'crit')
    return
  }
  if (f.qty === '' || !Number.isFinite(qty) || qty <= 0) {
    toast.show('移動数量は 1 以上で入力してください', 'crit')
    return
  }
  const ok = await confirm.ask(
    '倉庫間移動の確定',
    `${skuLabelOf(f.skuId)} を ${masters.warehouseName(f.fromWarehouseId)} → ${masters.warehouseName(f.toWarehouseId)} へ ${fmtInt(qty)} 移動します。`,
    { confirmLabel: '移動する' },
  )
  if (!ok) return
  const res = inv.transfer({
    skuId: f.skuId,
    fromWarehouseId: f.fromWarehouseId,
    toWarehouseId: f.toWarehouseId,
    qty,
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('倉庫間移動を記録しました', 'ok')
  transferOpen.value = false
}

// ========== 受払（台帳） ==========
const ledgerSku = ref('')
const ledgerWh = ref('')

const ledgerRows = computed(() =>
  inv.ledgerOf({
    skuId: ledgerSku.value || undefined,
    warehouseId: ledgerWh.value || undefined,
  }).map(t => ({
    id: t.id,
    occurredAt: fmtDateTime(t.occurredAt),
    skuLabel: skuLabelOf(t.skuId),
    warehouseName: masters.warehouseName(t.warehouseId),
    kindLabel: INVENTORY_KIND_LABELS[t.kind],
    qty: t.qty,
    refType: t.refType,
  })),
)

const ledgerColumns: TableColumn[] = [
  { key: 'occurredAt', label: '日時', primary: true },
  { key: 'skuLabel', label: 'SKU', primary: true },
  { key: 'warehouseName', label: '倉庫' },
  { key: 'kindLabel', label: '区分', primary: true },
  { key: 'qty', label: '数量', align: 'right', primary: true },
  { key: 'refType', label: '参照' },
]

// ========== 棚卸 ==========
const stWh = ref('')
const stCounts = ref<Record<string, string>>({})

watch([() => masters.warehouses.value, tab], () => {
  if (tab.value !== 'stocktake') return
  if (!stWh.value) stWh.value = warehouseOptions.value[0]?.value ?? ''
}, { immediate: true })

const stItems = computed(() => {
  if (!stWh.value) return []
  return inv.balancesOfWarehouse(stWh.value)
    .map(b => ({ skuId: b.skuId, skuLabel: skuLabelOf(b.skuId), theory: b.qty }))
    .sort((a, b) => a.skuLabel.localeCompare(b.skuLabel, 'ja'))
})

// 倉庫切替時に実棚入力を理論値で初期化
watch(stWh, () => {
  const next: Record<string, string> = {}
  for (const it of stItems.value) next[it.skuId] = String(it.theory)
  stCounts.value = next
}, { immediate: true })

function diffOf(skuId: string, theory: number): number | null {
  const raw = stCounts.value[skuId]
  if (raw === undefined || raw === '') return null
  const actual = Number(raw)
  if (!Number.isFinite(actual)) return null
  return actual - theory
}

const stChangedCount = computed(() =>
  stItems.value.filter(it => {
    const d = diffOf(it.skuId, it.theory)
    return d !== null && d !== 0
  }).length,
)

async function submitStocktake(): Promise<void> {
  if (!stWh.value) {
    toast.show('倉庫を選択してください', 'crit')
    return
  }
  const counts = stItems.value
    .filter(it => {
      const raw = stCounts.value[it.skuId]
      return raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
    })
    .map(it => ({ skuId: it.skuId, actualQty: Number(stCounts.value[it.skuId]) }))
  if (counts.length === 0) {
    toast.show('実棚数を入力してください', 'crit')
    return
  }
  const ok = await confirm.ask(
    '棚卸の確定',
    `${masters.warehouseName(stWh.value)} の棚卸を確定します。差分のある ${stChangedCount.value} 件を棚卸調整として台帳へ追記します。`,
    { confirmLabel: '棚卸を確定' },
  )
  if (!ok) return
  const res = inv.stocktake(stWh.value, counts)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(`棚卸を確定しました（調整 ${res.adjusted ?? 0} 件）`, 'ok')
}
</script>

<template>
  <div>
    <UiPageHeader title="在庫管理" description="SKU × 倉庫の在庫残高・受払台帳・棚卸（台帳は追記のみが SoT）">
      <template #actions>
        <div v-if="tab === 'browse'" class="flex items-center gap-2">
          <button type="button" class="btn btn-sm" @click="openAdjust">
            <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" /> 在庫調整
          </button>
          <button type="button" class="btn btn-sm" @click="openTransfer">
            <ArrowLeftRight class="h-3.5 w-3.5" aria-hidden="true" /> 倉庫間移動
          </button>
        </div>
      </template>
    </UiPageHeader>

    <div class="mb-3">
      <UiTabBar v-model="tab" :tabs="tabs" />
    </div>

    <!-- ===== 在庫照会 ===== -->
    <div v-if="tab === 'browse'" class="grid gap-3">
      <UiFilterBar>
        <div class="w-48">
          <UiSelect v-model="browseWh" :options="warehouseOptions" empty-label="すべての倉庫" aria-label="倉庫で絞り込み" />
        </div>
        <UiSearchInput v-model="browseSearch" placeholder="SKU 名で検索" />
      </UiFilterBar>

      <UiSectionCard :title="`在庫一覧（${browseRows.length}件）`" flush>
        <UiDataTable
          :columns="browseColumns"
          :rows="browseRows"
          empty-title="在庫のある SKU × 倉庫がありません"
        >
          <template #cell-qty="{ row }">
            <span class="num tabular-nums font-medium">{{ fmtInt(Number(row.qty)) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ===== 受払（台帳） ===== -->
    <div v-else-if="tab === 'ledger'" class="grid gap-3">
      <UiFilterBar>
        <div class="w-56">
          <UiSelect v-model="ledgerSku" :options="skuOptions" empty-label="すべての SKU" aria-label="SKU で絞り込み" />
        </div>
        <div class="w-48">
          <UiSelect v-model="ledgerWh" :options="warehouseOptions" empty-label="すべての倉庫" aria-label="倉庫で絞り込み" />
        </div>
      </UiFilterBar>

      <UiSectionCard :title="`受払明細（${ledgerRows.length}件）`" flush>
        <UiDataTable
          :columns="ledgerColumns"
          :rows="ledgerRows"
          empty-title="該当する受払明細がありません"
        >
          <template #cell-qty="{ row }">
            <span
              class="num tabular-nums font-medium"
              :class="Number(row.qty) > 0 ? 'text-ok' : Number(row.qty) < 0 ? 'text-crit' : ''"
            >{{ Number(row.qty) > 0 ? '+' : '' }}{{ fmtInt(Number(row.qty)) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ===== 棚卸 ===== -->
    <div v-else class="grid gap-3">
      <UiFilterBar>
        <div class="w-48">
          <UiSelect v-model="stWh" :options="warehouseOptions" aria-label="棚卸対象の倉庫" />
        </div>
        <template #trailing>
          <span class="text-[12px] text-muted">差分あり <span class="num font-semibold text-ink">{{ stChangedCount }}</span> 件</span>
          <button type="button" class="btn btn-primary btn-sm" @click="submitStocktake">
            <ClipboardCheck class="h-3.5 w-3.5" aria-hidden="true" /> 棚卸を確定
          </button>
        </template>
      </UiFilterBar>

      <UiSectionCard
        :title="`実棚入力（${stItems.length}件）`"
        description="実棚数を入力すると理論在庫との差分をプレビューします。確定で差分のみ棚卸調整として台帳へ追記します。"
        flush
      >
        <UiEmptyState
          v-if="stItems.length === 0"
          icon="PackageOpen"
          title="この倉庫に在庫がありません"
          hint="別の倉庫を選択してください"
        />
        <div v-else class="grid gap-2 p-3">
          <div
            v-for="it in stItems"
            :key="it.skuId"
            class="grid grid-cols-1 items-center gap-2 border-b border-line pb-2 last:border-0 sm:grid-cols-[1fr_auto_auto_auto]"
          >
            <div class="text-[13px] font-medium">{{ it.skuLabel }}</div>
            <div class="text-[12px] text-muted">
              理論 <span class="num tabular-nums">{{ fmtInt(it.theory) }}</span>
            </div>
            <div class="flex items-center gap-1">
              <label :for="`st-${it.skuId}`" class="text-[11px] text-muted">実棚</label>
              <input
                :id="`st-${it.skuId}`"
                v-model="stCounts[it.skuId]"
                type="number"
                step="1"
                class="input num w-24"
                :aria-label="`${it.skuLabel} の実棚数`"
              >
            </div>
            <div class="text-[12px] sm:text-right">
              <span
                v-if="diffOf(it.skuId, it.theory) !== null"
                class="num tabular-nums font-semibold"
                :class="(diffOf(it.skuId, it.theory) ?? 0) > 0 ? 'text-ok' : (diffOf(it.skuId, it.theory) ?? 0) < 0 ? 'text-crit' : 'text-muted'"
              >
                差分 {{ (diffOf(it.skuId, it.theory) ?? 0) > 0 ? '+' : '' }}{{ fmtInt(diffOf(it.skuId, it.theory) ?? 0) }}
              </span>
              <span v-else class="text-[12px] text-muted">—</span>
            </div>
          </div>
        </div>
      </UiSectionCard>
    </div>

    <!-- ===== 在庫調整モーダル ===== -->
    <UiModal :open="adjustOpen" title="在庫調整" @close="adjustOpen = false">
      <div class="grid gap-3">
        <UiFormField label="SKU" required>
          <UiSelect v-model="adjustForm.skuId" :options="skuOptions" aria-label="SKU" />
        </UiFormField>
        <UiFormField label="倉庫" required>
          <UiSelect v-model="adjustForm.warehouseId" :options="warehouseOptions" aria-label="倉庫" />
        </UiFormField>
        <UiFormField label="調整数量（+ 増 / − 減）" required hint="0 以外の整数。破損・紛失は − 、発見は + 等">
          <input v-model="adjustForm.qty" type="number" step="1" class="input num" placeholder="例: -3" aria-label="調整数量">
        </UiFormField>
        <UiFormField label="理由" required>
          <UiSelect v-model="adjustForm.reason" :options="reasonOptions" aria-label="調整理由" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="adjustOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitAdjust">調整する</button>
      </template>
    </UiModal>

    <!-- ===== 倉庫間移動モーダル ===== -->
    <UiModal :open="transferOpen" title="倉庫間移動" @close="transferOpen = false">
      <div class="grid gap-3">
        <UiFormField label="SKU" required>
          <UiSelect v-model="transferForm.skuId" :options="skuOptions" aria-label="SKU" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="移動元" required>
            <UiSelect v-model="transferForm.fromWarehouseId" :options="warehouseOptions" aria-label="移動元倉庫" />
          </UiFormField>
          <UiFormField label="移動先" required>
            <UiSelect v-model="transferForm.toWarehouseId" :options="warehouseOptions" aria-label="移動先倉庫" />
          </UiFormField>
        </div>
        <UiFormField label="移動数量" required :hint="`移動元の在庫: ${fmtInt(transferAvail)}`">
          <input v-model="transferForm.qty" type="number" min="1" step="1" class="input num" placeholder="例: 5" aria-label="移動数量">
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="transferOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitTransfer">移動する</button>
      </template>
    </UiModal>
  </div>
</template>
