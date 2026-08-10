<script setup lang="ts">
/**
 * 出荷管理（F-26）
 * 出荷指示（OutboundPlan・設定系・取消はステータス）と出荷実績（OutboundResult・記録系・追記）を扱う。
 * 一覧 → 行クリックで指示ドロワー（明細・出荷済/残・店舗預け注記）→ 実績登録 / 取消。
 * 「出荷指示を作成」「直接出荷登録」はモーダルから composable の createPlan / registerResult を呼ぶ。
 */
import { PackagePlus, Truck } from 'lucide-vue-next'
import type { OutboundPlan } from '~/types/akebono'
import { PLAN_STATUS_LABELS, planStatusTone } from '~/utils/akebono'
import { fmtDate, fmtInt } from '~/utils/format'
import type { TableColumn } from '~/types/ui'
import type { LineRow } from '~/components/widgets/AkebonoLineItems.vue'

const out = useOutbound()
const p = useProducts()
const masters = useAkebonoMasters()
const { effectiveSegmentId } = useCurrentSegment()
const { tbl } = useMockDb()
const toast = useToast()
// 二重送信ガード(Phase C: API 書込の重複作成防止。§34 の実行中フィードバック)
const busy = ref(false)
const confirm = useConfirm()

// ---------- 選択肢 ----------
const companies = tbl('companies')
const customerOptions = computed(() =>
  companies.value.filter(c => c.kind === 'customer' && c.active !== false)
    .map(c => ({ value: c.id, label: c.name })))
const warehouseOptions = masters.warehouseOptions
const segmentOptions = masters.segmentOptions
const skuOptions = computed(() =>
  p.activeSkus().map(s => ({ value: s.id, label: p.skuLabel(s) })))

function companyName(id: string | null | undefined): string {
  return masters.companyName(id)
}
function skuName(skuId: string): string {
  const sku = p.skuById(skuId)
  return sku ? p.skuLabel(sku) : skuId
}

// ---------- 一覧（検索 + ページング。モック=クライアント / API=サーバー） ----------
const { query, page, pageSize, rows: pageRows, total, refresh } = useListView<OutboundPlan>({
  source: out.activePlans,
  match: (pl, q) => pl.code.toLowerCase().includes(q) || pl.dueDate.includes(q),
  fetch: params => apiListPage<OutboundPlan>('outboundPlans', params),
})

const columns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'company', label: '出荷先', primary: true },
  { key: 'warehouse', label: '出荷元' },
  { key: 'dueDate', label: '予定日', primary: true },
  { key: 'status', label: '状態', primary: true },
]
const rows = computed(() => pageRows.value as unknown as Record<string, unknown>[])
function asPlan(row: Record<string, unknown>): OutboundPlan {
  return row as unknown as OutboundPlan
}

// ---------- 指示ドロワー ----------
const drawerOpen = ref(false)
const selectedId = ref<string | null>(null)
const selected = computed<OutboundPlan | null>(() =>
  selectedId.value ? (out.planById(selectedId.value) ?? null) : null)

const depositWarehouse = computed(() =>
  selected.value ? out.storeDepositWarehouseOf(selected.value.companyId) : null)

const planLineRows = computed(() => {
  const plan = selected.value
  if (!plan) return []
  return plan.lines.map((l) => {
    const shipped = out.shippedQtyOf(plan.id, l.id)
    return { id: l.id, skuId: l.skuId, name: skuName(l.skuId), planned: l.qty, shipped, remaining: Math.max(0, l.qty - shipped) }
  })
})

function openDrawer(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  drawerOpen.value = true
}

async function cancelSelected(): Promise<void> {
  const plan = selected.value
  if (!plan) return
  const ok = await confirm.ask(
    '出荷指示の取消',
    `「${plan.code}」を取消しますか？（取消後は出荷対象から外れます）`,
    { danger: true, confirmLabel: '取消する' },
  )
  if (!ok) return
  const res = await out.cancelPlan(plan.id)
  if (res.ok) { toast.show('出荷指示を取消しました', 'warn'); refresh() }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 指示作成モーダル ----------
const planOpen = ref(false)
const planForm = ref<{ companyId: string; warehouseId: string; segmentId: string; dueDate: string; lines: LineRow[] }>({
  companyId: '', warehouseId: '', segmentId: '', dueDate: '', lines: [],
})

function openPlanCreate(): void {
  planForm.value = {
    companyId: customerOptions.value[0]?.value ?? '',
    warehouseId: warehouseOptions.value[0]?.value ?? '',
    segmentId: effectiveSegmentId.value || (segmentOptions.value[0]?.value ?? ''),
    dueDate: '',
    lines: [{ skuId: '', qty: 1 }],
  }
  planOpen.value = true
}

async function savePlan(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try { await savePlanInner() } finally { busy.value = false }
}

async function savePlanInner(): Promise<void> {
  const f = planForm.value
  const res = await out.createPlan({
    companyId: f.companyId,
    warehouseId: f.warehouseId,
    segmentId: f.segmentId,
    dueDate: f.dueDate,
    lines: f.lines.map(l => ({ skuId: l.skuId, qty: l.qty })),
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('出荷指示を作成しました', 'ok')
  planOpen.value = false
  refresh() // サーバーページング時は現在ページを取り直す（クライアントは自動追従）
}

// ---------- 出荷実績登録モーダル（指示参照 / 直接） ----------
const resultOpen = ref(false)
const resultPlanId = ref<string | null>(null)
const resultForm = ref<{ warehouseId: string; companyId: string; segmentId: string; lines: LineRow[]; postSales: boolean }>({
  warehouseId: '', companyId: '', segmentId: '', lines: [], postSales: false,
})
const resultPlan = computed<OutboundPlan | null>(() =>
  resultPlanId.value ? (out.planById(resultPlanId.value) ?? null) : null)

/** 指示から実績登録（残数をプリセット） */
function openResultForPlan(): void {
  const plan = selected.value
  if (!plan) return
  resultPlanId.value = plan.id
  const lines = plan.lines
    .map(l => ({ skuId: l.skuId, qty: Math.max(0, l.qty - out.shippedQtyOf(plan.id, l.id)) }))
    .filter(l => l.qty > 0)
  resultForm.value = {
    warehouseId: plan.warehouseId,
    companyId: plan.companyId,
    segmentId: plan.segmentId,
    lines: lines.length > 0 ? lines : [{ skuId: '', qty: 1 }],
    postSales: false,
  }
  resultOpen.value = true
}

/** 直接出荷登録（指示なし） */
function openResultDirect(): void {
  resultPlanId.value = null
  resultForm.value = {
    warehouseId: warehouseOptions.value[0]?.value ?? '',
    companyId: customerOptions.value[0]?.value ?? '',
    segmentId: effectiveSegmentId.value || (segmentOptions.value[0]?.value ?? ''),
    lines: [{ skuId: '', qty: 1 }],
    postSales: false,
  }
  resultOpen.value = true
}

const resultDepositWarehouse = computed(() =>
  out.storeDepositWarehouseOf(resultForm.value.companyId || null))
// 店舗預けの出荷は「販売」ではないため売上計上できない（店舗販売時に別途計上）。UI で無効化 + 自動解除
const canPostSales = computed(() => !resultDepositWarehouse.value && !!resultForm.value.companyId)
watch(resultDepositWarehouse, (dep) => { if (dep) resultForm.value.postSales = false })

async function saveResult(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try { await saveResultInner() } finally { busy.value = false }
}

async function saveResultInner(): Promise<void> {
  const f = resultForm.value
  const plan = resultPlan.value
  const res = await out.registerResult({
    planId: resultPlanId.value,
    warehouseId: f.warehouseId,
    companyId: f.companyId || null,
    segmentId: f.segmentId || null,
    postSales: f.postSales && canPostSales.value,
    lines: f.lines.map(l => ({
      planLineId: plan ? (plan.lines.find(pl => pl.skuId === l.skuId)?.id ?? null) : null,
      skuId: l.skuId,
      qty: l.qty,
    })),
  })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(f.postSales && canPostSales.value ? '出荷実績を登録し、売上を計上しました' : '出荷実績を登録しました', 'ok')
  resultOpen.value = false
  refresh() // サーバーページング時は現在ページを取り直す（実績で指示ステータスが変わるため）
}
</script>

<template>
  <div>
    <UiPageHeader title="出荷管理" description="出荷指示の作成と出荷実績の登録（自社倉庫から出庫・店舗は預け在庫へ移動）">
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-sm" @click="openResultDirect">
            <Truck class="h-3.5 w-3.5" aria-hidden="true" /> 直接出荷登録
          </button>
          <button type="button" class="btn btn-primary btn-sm" @click="openPlanCreate">
            <PackagePlus class="h-3.5 w-3.5" aria-hidden="true" /> 出荷指示を作成
          </button>
        </div>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiSectionCard :title="`出荷指示（${total}件）`" flush>
        <UiFilterBar>
          <UiSearchInput v-model="query" placeholder="コード・予定日で検索" />
        </UiFilterBar>
        <UiDataTable
          :columns="columns"
          :rows="rows"
          clickable
          empty-title="出荷指示がありません"
          empty-hint="「出荷指示を作成」または「直接出荷登録」から始められます"
          @row-click="openDrawer"
        >
          <template #cell-code="{ row }">
            <span class="font-medium">{{ asPlan(row).code }}</span>
          </template>
          <template #cell-company="{ row }">
            {{ companyName(asPlan(row).companyId) }}
          </template>
          <template #cell-warehouse="{ row }">
            {{ masters.warehouseName(asPlan(row).warehouseId) }}
          </template>
          <template #cell-dueDate="{ row }">
            <span class="num">{{ fmtDate(asPlan(row).dueDate) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="PLAN_STATUS_LABELS[asPlan(row).status]"
              :tone="planStatusTone(asPlan(row).status)"
              dot
            />
          </template>
        </UiDataTable>
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </UiSectionCard>
    </div>

    <!-- 指示ドロワー -->
    <UiDrawer :open="drawerOpen" :title="selected ? `出荷指示 ${selected.code}` : '出荷指示'" width="520px" @close="drawerOpen = false">
      <div v-if="selected" class="grid gap-4">
        <dl class="grid gap-2 text-[13px]">
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="text-[11px] font-semibold text-muted">出荷先</dt>
            <dd>{{ companyName(selected.companyId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="text-[11px] font-semibold text-muted">出荷元倉庫</dt>
            <dd>{{ masters.warehouseName(selected.warehouseId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="text-[11px] font-semibold text-muted">事業セグメント</dt>
            <dd>{{ masters.segmentName(selected.segmentId) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2">
            <dt class="text-[11px] font-semibold text-muted">予定日</dt>
            <dd class="num">{{ fmtDate(selected.dueDate) }}</dd>
          </div>
          <div class="grid grid-cols-[110px_1fr] gap-2">
            <dt class="text-[11px] font-semibold text-muted">状態</dt>
            <dd>
              <UiStatusBadge :label="PLAN_STATUS_LABELS[selected.status]" :tone="planStatusTone(selected.status)" dot />
            </dd>
          </div>
        </dl>

        <div
          v-if="depositWarehouse"
          class="rounded-[8px] border border-brand bg-brand-soft px-3 py-2 text-[12px] text-ink"
        >
          出荷先は店舗です。実績登録時、出庫分は店舗預け在庫「{{ depositWarehouse.name }}」へ移動されます。
        </div>

        <div class="grid gap-2">
          <div class="text-[11px] font-semibold text-muted">明細</div>
          <div class="overflow-x-auto">
            <table class="tbl w-full text-[13px]">
              <thead>
                <tr>
                  <th class="text-left">SKU</th>
                  <th class="text-right">指示数</th>
                  <th class="text-right">出荷済</th>
                  <th class="text-right">残</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in planLineRows" :key="l.id">
                  <td>
                    <div class="flex items-center gap-2">
                      <AkebonoProductThumb :sku-id="l.skuId" :size="22" />
                      <span>{{ l.name }}</span>
                    </div>
                  </td>
                  <td class="num text-right">{{ fmtInt(l.planned) }}</td>
                  <td class="num text-right">{{ fmtInt(l.shipped) }}</td>
                  <td class="num text-right" :class="l.remaining > 0 ? 'text-warn font-semibold' : 'text-muted'">
                    {{ fmtInt(l.remaining) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <UiEmptyState v-else icon="Package" title="指示が選択されていません" />

      <template #footer>
        <div v-if="selected" class="flex items-center justify-between gap-2">
          <button
            v-if="selected.status === 'pending'"
            type="button"
            class="btn btn-danger btn-sm"
            @click="cancelSelected"
          >
            取消
          </button>
          <span v-else />
          <button
            v-if="selected.status !== 'canceled' && selected.status !== 'completed'"
            type="button"
            class="btn btn-primary btn-sm"
            @click="openResultForPlan"
          >
            出荷実績を登録
          </button>
        </div>
      </template>
    </UiDrawer>

    <!-- 指示作成モーダル -->
    <UiModal :open="planOpen" title="出荷指示を作成" width="560px" @close="planOpen = false">
      <div class="grid gap-3">
        <UiFormField label="出荷先（得意先）" required>
          <UiSelect v-model="planForm.companyId" :options="customerOptions" aria-label="出荷先" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="出荷元倉庫" required>
            <UiSelect v-model="planForm.warehouseId" :options="warehouseOptions" aria-label="出荷元倉庫" />
          </UiFormField>
          <UiFormField label="事業セグメント" required>
            <UiSelect v-model="planForm.segmentId" :options="segmentOptions" aria-label="事業セグメント" />
          </UiFormField>
        </div>
        <UiFormField label="予定日" required>
          <input v-model="planForm.dueDate" type="date" class="input" aria-label="予定日">
        </UiFormField>
        <UiFormField label="出荷明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="planForm.lines" :sku-options="skuOptions" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="planOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="savePlan">作成する</button>
      </template>
    </UiModal>

    <!-- 出荷実績登録モーダル（指示参照 / 直接） -->
    <UiModal
      :open="resultOpen"
      :title="resultPlan ? `出荷実績を登録（${resultPlan.code}）` : '直接出荷登録'"
      width="560px"
      @close="resultOpen = false"
    >
      <div class="grid gap-3">
        <template v-if="resultPlan">
          <div class="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <div class="text-[11px] font-semibold text-muted">出荷先</div>
              <div>{{ companyName(resultForm.companyId) }}</div>
            </div>
            <div>
              <div class="text-[11px] font-semibold text-muted">出荷元倉庫</div>
              <div>{{ masters.warehouseName(resultForm.warehouseId) }}</div>
            </div>
          </div>
        </template>
        <template v-else>
          <UiFormField label="出荷先（得意先）">
            <UiSelect v-model="resultForm.companyId" :options="customerOptions" aria-label="出荷先" />
          </UiFormField>
          <UiFormField label="出荷元倉庫" required>
            <UiSelect v-model="resultForm.warehouseId" :options="warehouseOptions" aria-label="出荷元倉庫" />
          </UiFormField>
          <UiFormField v-if="resultForm.postSales" label="事業セグメント（売上計上先）" required>
            <UiSelect v-model="resultForm.segmentId" :options="segmentOptions" aria-label="事業セグメント" />
          </UiFormField>
        </template>

        <div
          v-if="resultDepositWarehouse"
          class="rounded-[8px] border border-brand bg-brand-soft px-3 py-2 text-[12px] text-ink"
        >
          出荷先は店舗です。出庫分は店舗預け在庫「{{ resultDepositWarehouse.name }}」へ移動されます（店舗での販売時に売上を計上します）。
        </div>

        <UiFormField label="出荷明細" required>
          <WidgetsAkebonoLineItems v-model:model-value="resultForm.lines" :sku-options="skuOptions" />
        </UiFormField>

        <!-- 出荷実績 → 売上自動計上（F-28 連携。店舗預けの出荷は対象外 = 無効化） -->
        <label class="flex items-start gap-2 rounded-[8px] border border-line px-3 py-2 text-[12px]" :class="canPostSales ? 'text-ink' : 'text-muted'">
          <input v-model="resultForm.postSales" type="checkbox" class="mt-0.5" :disabled="!canPostSales">
          <span>
            <span class="font-semibold">この出荷を売上として計上する</span>
            <span class="mt-0.5 block text-[11px] text-sub">
              出荷明細から売上（発生源 = 出荷実績）を自動生成します。単価は商品/SKU の販売単価から解決します。
              <template v-if="resultDepositWarehouse">店舗預けの出荷は計上できません。</template>
              <template v-else-if="!resultForm.companyId">出荷先（得意先）を指定すると計上できます。</template>
            </span>
          </span>
        </label>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="resultOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="saveResult">登録する</button>
      </template>
    </UiModal>
  </div>
</template>
