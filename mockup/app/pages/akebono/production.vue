<script setup lang="ts">
/**
 * 生産管理（F-22。薄い実装）
 * 生産指示（instructed→in_progress→completed / canceled）+ 実績登録（追記・完成分は在庫入庫）。
 * 情報サービス業では「案件/開発タスク × 開発工数」に読み替える（在庫連動なし）。
 */
import { Plus } from 'lucide-vue-next'
import type { ProductionOrder, ProductionStatus } from '~/types/akebono'
import type { TableColumn } from '~/types/ui'
import { PRODUCTION_STATUS_LABELS, productionStatusTone } from '~/utils/akebono'
import { fmtDate, fmtDateTime, fmtInt } from '~/utils/format'

const prod = useProduction()
const p = useProducts()
const masters = useAkebonoMasters()
const { show } = useToast()
const confirm = useConfirm()

// ---------- 選択肢 ----------
const skuOptions = computed(() => p.activeSkus().map(s => ({ value: s.id, label: p.skuLabel(s) })))

function skuLabelOf(skuId: string): string {
  const s = p.skuById(skuId)
  return s ? p.skuLabel(s) : '—'
}

// ---------- 一覧 ----------
const columns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'sku', label: '対象 SKU', primary: true },
  { key: 'qty', label: '指示数', align: 'right' },
  { key: 'completed', label: '完成', align: 'right' },
  { key: 'dueDate', label: '納期' },
  { key: 'warehouse', label: '入庫先' },
  { key: 'status', label: '状態', primary: true },
]

const rows = computed(() => prod.activeOrders.value as unknown as Record<string, unknown>[])
function asOrder(row: Record<string, unknown>): ProductionOrder {
  return row as unknown as ProductionOrder
}

// ---------- ドロワー（詳細・状態遷移・実績登録） ----------
const drawerOpen = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed<ProductionOrder | null>(() =>
  selectedId.value ? (prod.orderById(selectedId.value) ?? null) : null)

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  resetResultForm()
  drawerOpen.value = true
}

const nextStatuses = computed<ProductionStatus[]>(() =>
  selected.value ? prod.NEXT[selected.value.status] : [])

async function transition(status: ProductionStatus): Promise<void> {
  if (!selected.value) return
  // 取消は終端状態（取り消せない）のため確認を挟む（他の入出荷・発注と同じ導線・原則9.5）
  if (status === 'canceled') {
    const ok = await confirm.ask('生産指示の取消', `「${selected.value.code}」を取消にしますか？（取消後は元に戻せません）`, { danger: true, confirmLabel: '取消にする' })
    if (!ok) return
  }
  const res = prod.setStatus(selected.value.id, status)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  const tone = status === 'canceled' ? 'warn' : 'ok'
  show(`状態を「${PRODUCTION_STATUS_LABELS[status]}」に更新しました`, tone)
}

// ---------- 実績登録 ----------
const canRegister = computed(() =>
  selected.value != null && (selected.value.status === 'in_progress' || selected.value.status === 'instructed'))
const resultForm = ref({ completedQty: '', defectQty: '' })
function resetResultForm(): void {
  resultForm.value = { completedQty: '', defectQty: '' }
}

function registerResult(): void {
  if (!selected.value) return
  const completedQty = Number(resultForm.value.completedQty)
  const defectQty = resultForm.value.defectQty === '' ? 0 : Number(resultForm.value.defectQty)
  if (resultForm.value.completedQty === '' || !Number.isFinite(completedQty) || completedQty <= 0) {
    show('完成数は 1 以上の数値で入力してください', 'crit')
    return
  }
  if (!Number.isFinite(defectQty) || defectQty < 0) {
    show('不良数は 0 以上の数値で入力してください', 'crit')
    return
  }
  const res = prod.registerResult(selected.value.id, { completedQty, defectQty })
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('実績を登録しました（完成分を在庫へ入庫）', 'ok')
  resetResultForm()
}

// ---------- 指示作成 ----------
const createOpen = ref(false)
const createForm = ref({ skuId: '', qty: '', warehouseId: '', dueDate: '' })

function openCreate(): void {
  createForm.value = {
    skuId: skuOptions.value[0]?.value ?? '',
    qty: '',
    warehouseId: masters.warehouseOptions.value[0]?.value ?? '',
    dueDate: '',
  }
  createOpen.value = true
}

function submitCreate(): void {
  const f = createForm.value
  const qty = Number(f.qty)
  if (!f.skuId) {
    show('対象 SKU を選択してください', 'crit')
    return
  }
  if (f.qty === '' || !Number.isFinite(qty) || qty <= 0) {
    show('指示数は 1 以上の数値で入力してください', 'crit')
    return
  }
  if (!f.warehouseId) {
    show('入庫先の倉庫を選択してください', 'crit')
    return
  }
  if (!f.dueDate) {
    show('納期を入力してください', 'crit')
    return
  }
  const res = prod.createOrder({ skuId: f.skuId, qty, warehouseId: f.warehouseId, dueDate: f.dueDate })
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('生産指示を作成しました', 'ok')
  createOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader title="生産管理" description="生産指示と実績登録（完成分は自動で在庫入庫）。情報サービス業では「案件/開発タスク × 開発工数」に読み替えます">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 生産指示を作成
        </button>
      </template>
    </UiPageHeader>

    <UiSectionCard :title="`生産指示（${rows.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="rows"
        clickable
        empty-title="生産指示がありません"
        empty-hint="「生産指示を作成」から登録できます"
        @row-click="openDetail"
      >
        <template #cell-code="{ row }">
          <span class="font-medium">{{ asOrder(row).code }}</span>
        </template>
        <template #cell-sku="{ row }">
          {{ skuLabelOf(asOrder(row).skuId) }}
        </template>
        <template #cell-qty="{ row }">
          <span class="num tabular-nums">{{ fmtInt(asOrder(row).qty) }}</span>
        </template>
        <template #cell-completed="{ row }">
          <span class="num tabular-nums">{{ fmtInt(prod.completedQtyOf(asOrder(row))) }}</span>
        </template>
        <template #cell-dueDate="{ row }">
          {{ fmtDate(asOrder(row).dueDate) }}
        </template>
        <template #cell-warehouse="{ row }">
          {{ masters.warehouseName(asOrder(row).warehouseId) }}
        </template>
        <template #cell-status="{ row }">
          <UiStatusBadge
            :label="PRODUCTION_STATUS_LABELS[asOrder(row).status]"
            :tone="productionStatusTone(asOrder(row).status)"
            dot
          />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <!-- 詳細ドロワー -->
    <UiDrawer :open="drawerOpen" :title="selected ? selected.code : '生産指示'" @close="drawerOpen = false">
      <div v-if="selected" class="grid gap-4">
        <!-- 指示内容 -->
        <dl class="grid gap-2 text-[13px]">
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">状態</dt>
            <dd>
              <UiStatusBadge
                :label="PRODUCTION_STATUS_LABELS[selected.status]"
                :tone="productionStatusTone(selected.status)"
                dot
              />
            </dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">対象 SKU</dt>
            <dd>{{ skuLabelOf(selected.skuId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">指示数 / 完成</dt>
            <dd>
              <span class="num tabular-nums">{{ fmtInt(prod.completedQtyOf(selected)) }}</span>
              <span class="text-muted"> / {{ fmtInt(selected.qty) }}</span>
            </dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">入庫先</dt>
            <dd>{{ masters.warehouseName(selected.warehouseId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">納期</dt>
            <dd>{{ fmtDate(selected.dueDate) }}</dd>
          </div>
        </dl>

        <!-- 状態遷移 -->
        <div v-if="nextStatuses.length > 0" class="grid gap-1.5">
          <span class="text-[11px] font-semibold text-muted">状態を進める</span>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="s in nextStatuses"
              :key="s"
              type="button"
              class="btn btn-sm"
              :class="s === 'canceled' ? 'btn-danger' : 'btn-primary'"
              @click="transition(s)"
            >
              {{ PRODUCTION_STATUS_LABELS[s] }}へ
            </button>
          </div>
        </div>

        <!-- 実績登録 -->
        <div v-if="canRegister" class="card grid gap-2 p-3">
          <span class="text-[12px] font-semibold text-ink">実績を登録</span>
          <div class="grid grid-cols-2 gap-3">
            <UiFormField label="完成数" required>
              <input
                v-model="resultForm.completedQty" type="number" min="1" step="1"
                class="input" placeholder="例: 5" aria-label="完成数"
              >
            </UiFormField>
            <UiFormField label="不良数">
              <input
                v-model="resultForm.defectQty" type="number" min="0" step="1"
                class="input" placeholder="例: 0" aria-label="不良数"
              >
            </UiFormField>
          </div>
          <p class="text-[11px] text-muted">完成分は入庫先倉庫へ自動入庫します。指示数に達すると自動で完了になります。</p>
          <div class="flex justify-end">
            <button type="button" class="btn btn-primary btn-sm" @click="registerResult">登録する</button>
          </div>
        </div>

        <!-- 実績履歴 -->
        <div class="grid gap-1.5">
          <span class="text-[11px] font-semibold text-muted">実績履歴（{{ selected.results.length }}件）</span>
          <UiEmptyState
            v-if="selected.results.length === 0"
            icon="Factory"
            title="まだ実績がありません"
          />
          <ul v-else class="grid gap-1.5">
            <li
              v-for="r in selected.results"
              :key="r.id"
              class="flex items-center justify-between gap-2 rounded border border-line px-2.5 py-1.5 text-[13px]"
            >
              <span>
                完成 <span class="num tabular-nums font-medium">{{ fmtInt(r.completedQty) }}</span>
                <span class="text-muted"> / 不良 </span>
                <span class="num tabular-nums">{{ fmtInt(r.defectQty) }}</span>
              </span>
              <span class="text-[11px] text-muted">{{ fmtDateTime(r.completedAt) }}</span>
            </li>
          </ul>
        </div>
      </div>
    </UiDrawer>

    <!-- 指示作成モーダル -->
    <UiModal :open="createOpen" title="生産指示を作成" @close="createOpen = false">
      <div class="grid gap-3">
        <UiFormField label="対象 SKU" required>
          <UiSelect v-model="createForm.skuId" :options="skuOptions" aria-label="対象 SKU" />
        </UiFormField>
        <UiFormField label="指示数" required>
          <input
            v-model="createForm.qty" type="number" min="1" step="1"
            class="input" placeholder="例: 10" aria-label="指示数"
          >
        </UiFormField>
        <UiFormField label="入庫先倉庫" required>
          <UiSelect v-model="createForm.warehouseId" :options="masters.warehouseOptions.value" aria-label="入庫先倉庫" />
        </UiFormField>
        <UiFormField label="納期" required>
          <input v-model="createForm.dueDate" type="date" class="input" aria-label="納期">
        </UiFormField>
        <p class="text-[11px] text-muted">
          情報サービス業では「案件/開発タスク × 開発工数」に読み替えて運用します（在庫連動なし）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitCreate">作成する</button>
      </template>
    </UiModal>
  </div>
</template>
