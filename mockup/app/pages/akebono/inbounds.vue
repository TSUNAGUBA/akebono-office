<script setup lang="ts">
/**
 * 入荷管理（F-25）
 * 入荷予定（設定系）の一覧・作成。予定に対する入荷実績（記録系・追記・部分実績可）の登録。
 * 予定行ごとに 予定数 / 入荷済 / 残 を表示し、残数プリフィルで実績登録する。
 * pending の予定は取消可能（実績があると取消不可 = composable 側でガード）。
 */
import { PackagePlus, PlusCircle } from 'lucide-vue-next'
import type { InboundPlan } from '~/types/akebono'
import { PLAN_STATUS_LABELS, planStatusTone } from '~/utils/akebono'
import { fmtDate, fmtInt } from '~/utils/format'
import type { TableColumn } from '~/types/ui'

const inbound = useInbound()
const products = useProducts()
const { warehouseOptions, warehouseName } = useAkebonoMasters()
const { activePlans } = inbound
const toast = useToast()
const confirm = useConfirm()

// ---------- SKU 選択肢 ----------
const skuOptions = computed(() => products.activeSkus().map(s => ({ value: s.id, label: products.skuLabel(s) })))
function skuLabelOf(skuId: string): string {
  const s = products.skuById(skuId)
  return s ? products.skuLabel(s) : skuId
}

// ---------- 一覧 ----------
const columns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'warehouse', label: '入荷先', primary: true },
  { key: 'dueDate', label: '予定日', primary: true },
  { key: 'lineCount', label: '明細数', align: 'right', width: '90px' },
  { key: 'status', label: '状態', primary: true },
]

const tableRows = computed(() =>
  activePlans.value.map(p => ({
    id: p.id,
    code: p.code,
    warehouse: warehouseName(p.warehouseId),
    dueDate: fmtDate(p.dueDate),
    lineCount: p.lines.length,
    status: p.status,
  })) as unknown as Record<string, unknown>[],
)

// ---------- 詳細ドロワー ----------
const drawerOpen = ref(false)
const selectedId = ref<string | null>(null)
const selectedPlan = computed<InboundPlan | undefined>(() =>
  selectedId.value ? inbound.planById(selectedId.value) : undefined)

const detailLines = computed(() => {
  const plan = selectedPlan.value
  if (!plan) return []
  return plan.lines.map((l) => {
    const received = inbound.receivedQtyOf(plan.id, l.id)
    return {
      id: l.id,
      skuId: l.skuId,
      label: skuLabelOf(l.skuId),
      planned: l.qty,
      received,
      remaining: Math.max(0, l.qty - received),
    }
  })
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  drawerOpen.value = true
}

async function cancelSelected(): Promise<void> {
  const plan = selectedPlan.value
  if (!plan) return
  const ok = await confirm.ask(
    '入荷予定の取消',
    `「${plan.code}」を取消しますか？（実績がある予定は取消できません）`,
    { danger: true, confirmLabel: '取消する' },
  )
  if (!ok) return
  const res = inbound.cancelPlan(plan.id)
  if (res.ok) toast.show('入荷予定を取消しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 入荷予定を作成 ----------
const createOpen = ref(false)
const createForm = ref<{ warehouseId: string; dueDate: string; lines: { skuId: string; qty: number }[] }>({
  warehouseId: '', dueDate: '', lines: [],
})

function openCreate(): void {
  createForm.value = {
    warehouseId: warehouseOptions.value[0]?.value ?? '',
    dueDate: '',
    lines: [{ skuId: '', qty: 1 }],
  }
  createOpen.value = true
}

function submitCreate(): void {
  const f = createForm.value
  if (!f.warehouseId) {
    toast.show('入荷先倉庫を選択してください', 'crit')
    return
  }
  if (!f.dueDate) {
    toast.show('予定日を入力してください', 'crit')
    return
  }
  const res = inbound.createPlan({
    warehouseId: f.warehouseId,
    dueDate: f.dueDate,
    lines: f.lines,
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('入荷予定を作成しました', 'ok')
  createOpen.value = false
}

// ---------- 直接入荷登録 ----------
const directOpen = ref(false)
const directForm = ref<{ warehouseId: string; lines: { skuId: string; qty: number }[] }>({
  warehouseId: '', lines: [],
})

function openDirect(): void {
  directForm.value = {
    warehouseId: warehouseOptions.value[0]?.value ?? '',
    lines: [{ skuId: '', qty: 1 }],
  }
  directOpen.value = true
}

function submitDirect(): void {
  const f = directForm.value
  if (!f.warehouseId) {
    toast.show('入荷先倉庫を選択してください', 'crit')
    return
  }
  const res = inbound.registerResult({ warehouseId: f.warehouseId, lines: f.lines })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('入荷実績を登録しました（在庫へ入庫）', 'ok')
  directOpen.value = false
}

// ---------- 予定に対する入荷実績登録（残数プリフィル） ----------
const resultOpen = ref(false)
const resultLines = ref<{ planLineId: string; skuId: string; label: string; qty: number }[]>([])

function openResult(): void {
  if (!selectedPlan.value) return
  resultLines.value = detailLines.value.map(l => ({
    planLineId: l.id,
    skuId: l.skuId,
    label: l.label,
    qty: l.remaining,
  }))
  resultOpen.value = true
}

function submitResult(): void {
  const plan = selectedPlan.value
  if (!plan) return
  const res = inbound.registerResult({
    planId: plan.id,
    lines: resultLines.value.map(l => ({ planLineId: l.planLineId, skuId: l.skuId, qty: Number(l.qty) })),
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('入荷実績を登録しました（在庫へ入庫）', 'ok')
  resultOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader title="入荷管理" description="入荷予定の作成と、予定・直接の入荷実績登録（在庫へ入庫）">
      <template #actions>
        <div class="flex items-center gap-2">
          <button type="button" class="btn btn-sm" @click="openDirect">
            <PlusCircle class="h-3.5 w-3.5" aria-hidden="true" /> 直接入荷登録
          </button>
          <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
            <PackagePlus class="h-3.5 w-3.5" aria-hidden="true" /> 入荷予定を作成
          </button>
        </div>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiSectionCard :title="`入荷予定（${activePlans.length}件）`" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="入荷予定がありません"
          @row-click="openDetail"
        >
          <template #cell-code="{ row }">
            <span class="font-medium">{{ row.code }}</span>
          </template>
          <template #cell-lineCount="{ row }">
            <span class="num tabular-nums">{{ fmtInt(Number(row.lineCount)) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="PLAN_STATUS_LABELS[row.status as keyof typeof PLAN_STATUS_LABELS]"
              :tone="planStatusTone(row.status as any)"
              dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- 予定詳細ドロワー -->
    <UiDrawer :open="drawerOpen" :title="selectedPlan ? `入荷予定 ${selectedPlan.code}` : '入荷予定'" width="520px" @close="drawerOpen = false">
      <div v-if="selectedPlan" class="grid gap-3">
        <dl class="grid gap-2 text-[13px]">
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">入荷先</dt>
            <dd>{{ warehouseName(selectedPlan.warehouseId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">予定日</dt>
            <dd>{{ fmtDate(selectedPlan.dueDate) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">状態</dt>
            <dd>
              <UiStatusBadge :label="PLAN_STATUS_LABELS[selectedPlan.status]" :tone="planStatusTone(selectedPlan.status)" dot />
            </dd>
          </div>
        </dl>

        <div>
          <div class="mb-1.5 text-[11px] font-semibold text-muted">予定明細</div>
          <div class="grid gap-1.5">
            <div class="grid grid-cols-[1fr_60px_60px_60px] gap-2 border-b border-line pb-1 text-[11px] font-semibold text-muted">
              <span>SKU</span>
              <span class="text-right">予定数</span>
              <span class="text-right">入荷済</span>
              <span class="text-right">残</span>
            </div>
            <div
              v-for="l in detailLines"
              :key="l.id"
              class="grid grid-cols-[1fr_60px_60px_60px] items-center gap-2 border-b border-line pb-1.5 text-[13px] last:border-0"
            >
              <span>{{ l.label }}</span>
              <span class="num text-right tabular-nums">{{ fmtInt(l.planned) }}</span>
              <span class="num text-right tabular-nums">{{ fmtInt(l.received) }}</span>
              <span class="num text-right tabular-nums" :class="l.remaining > 0 ? 'text-warn font-semibold' : 'text-muted'">{{ fmtInt(l.remaining) }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div v-if="selectedPlan" class="flex items-center justify-between gap-2">
          <button
            v-if="selectedPlan.status === 'pending'"
            type="button" class="btn btn-danger btn-sm"
            @click="cancelSelected"
          >
            取消
          </button>
          <span v-else />
          <button
            v-if="selectedPlan.status !== 'canceled' && selectedPlan.status !== 'completed'"
            type="button" class="btn btn-primary btn-sm"
            @click="openResult"
          >
            入荷実績を登録
          </button>
        </div>
      </template>
    </UiDrawer>

    <!-- 入荷予定を作成 -->
    <UiModal :open="createOpen" title="入荷予定を作成" width="560px" @close="createOpen = false">
      <div class="grid gap-3">
        <UiFormField label="入荷先倉庫" required>
          <UiSelect v-model="createForm.warehouseId" :options="warehouseOptions" aria-label="入荷先倉庫" />
        </UiFormField>
        <UiFormField label="予定日" required>
          <input v-model="createForm.dueDate" type="date" class="input" aria-label="予定日">
        </UiFormField>
        <UiFormField label="入荷明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="createForm.lines" :sku-options="skuOptions" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitCreate">作成する</button>
      </template>
    </UiModal>

    <!-- 直接入荷登録 -->
    <UiModal :open="directOpen" title="直接入荷登録" width="560px" @close="directOpen = false">
      <div class="grid gap-3">
        <p class="text-[11px] text-muted">予定を介さずに入荷実績を登録します（在庫へ入庫）。</p>
        <UiFormField label="入荷先倉庫" required>
          <UiSelect v-model="directForm.warehouseId" :options="warehouseOptions" aria-label="入荷先倉庫" />
        </UiFormField>
        <UiFormField label="入荷明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="directForm.lines" :sku-options="skuOptions" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="directOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitDirect">登録する</button>
      </template>
    </UiModal>

    <!-- 予定に対する入荷実績登録（残数プリフィル） -->
    <UiModal :open="resultOpen" :title="selectedPlan ? `入荷実績を登録（${selectedPlan.code}）` : '入荷実績を登録'" width="560px" topmost @close="resultOpen = false">
      <div class="grid gap-2">
        <p class="text-[11px] text-muted">残数をプリフィルしています。実際に入荷した数量に調整してください（0 の行は登録されません）。</p>
        <div class="grid grid-cols-[1fr_100px] gap-2 border-b border-line pb-1 text-[11px] font-semibold text-muted">
          <span>SKU</span>
          <span class="text-right">入荷数</span>
        </div>
        <div
          v-for="(l, idx) in resultLines"
          :key="l.planLineId"
          class="grid grid-cols-[1fr_100px] items-center gap-2"
        >
          <span class="text-[13px]">{{ l.label }}</span>
          <input
            v-model.number="resultLines[idx].qty"
            type="number" min="0" step="1" class="input text-right"
            :aria-label="`${l.label} の入荷数`"
          >
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="resultOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitResult">登録する</button>
      </template>
    </UiModal>
  </div>
</template>
