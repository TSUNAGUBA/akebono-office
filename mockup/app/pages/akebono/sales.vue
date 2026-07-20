<script setup lang="ts">
/**
 * 売上管理（F-28。F-15 の明細型・セグメント別）
 * SoT = salesRecords（useAkebonoSales）。月次・セグメント別サマリは導出。
 * 訂正は赤黒（記録系）= 誤登録の取消フロー（原則 9.5）。ルート /akebono/sales。管理者ゲート不要。
 */
import { ArrowRight, Plus } from 'lucide-vue-next'
import type { Company } from '~/types/domain'
import { fmtDate, fmtPct, fmtYen, fmtYenCompact, todayJst } from '~/utils/format'

const sales = useAkebonoSales()
const products = useProducts()
const { tbl } = useMockDb()
const { show } = useToast()
const { ask } = useConfirm()

const {
  filteredRecords, activeSegments, segmentFilter, selectedFy,
  fiscalYearOptions, fiscalMonthLabels, currentFySeries, previousFySeries,
  currentMonthSales, currentMonthYoY, currentMonthMargin,
  segmentBreakdown, customerBreakdown, segmentComparison,
  segmentName, companyName, create, correct,
} = sales

// ---------- 発生源ラベル（画面固有の固定 enum） ----------
const SOURCE_KIND_LABELS: Record<string, string> = {
  manual: '手入力', shipment: '出荷実績', import: '取込', monthly_bulk: '月次一括',
}
function sourceKindLabel(k: string): string {
  return SOURCE_KIND_LABELS[k] ?? k
}

// ---------- 表示年度セレクタ（UiSelect は string モデル） ----------
const fyModel = computed({
  get: () => String(selectedFy.value),
  set: (v: string) => { selectedFy.value = Number(v) },
})
const fyOptions = computed(() =>
  fiscalYearOptions.value.map(fy => ({ value: String(fy), label: `${fy}年度` })))

// ---------- KPI ----------
const kpiSales = computed(() => fmtYenCompact(currentMonthSales.value))
const kpiMargin = computed(() =>
  currentMonthMargin.value === null ? '—' : fmtPct(currentMonthMargin.value))

// ---------- セグメント切替 ----------
const segmentTabs = computed(() => [
  { value: '', label: '全セグメント' },
  ...activeSegments.value.map(s => ({ value: s.id, label: s.name })),
])
const isAllSegments = computed(() => segmentFilter.value === '')

// ---------- チャート ----------
const salesSeries = computed(() => [
  { label: `${selectedFy.value}年度`, data: currentFySeries.value },
  { label: `${selectedFy.value - 1}年度`, data: previousFySeries.value },
])
const customerLabels = computed(() => customerBreakdown.value.map(c => c.label))
const customerSeries = computed(() => [
  { label: '売上', data: customerBreakdown.value.map(c => c.value) },
])

// ---------- 明細一覧 ----------
const columns = [
  { key: 'salesDate', label: '売上日', primary: true },
  { key: 'companyId', label: '得意先', primary: true },
  { key: 'segmentId', label: 'セグメント' },
  { key: 'skuId', label: 'SKU' },
  { key: 'qty', label: '数量', align: 'right' as const },
  { key: 'amount', label: '金額', align: 'right' as const, primary: true },
  { key: 'sourceKind', label: '発生源' },
]
const tableRows = computed(() => filteredRecords.value as unknown as Record<string, unknown>[])
function skuLabelOf(skuId: string): string {
  const sku = products.skuById(skuId)
  return sku ? products.skuLabel(sku) : skuId
}

async function onRowClick(row: Record<string, unknown>): Promise<void> {
  const id = String(row.id)
  const code = String(row.code ?? '')
  const isCorrection = row.correctionOf != null
  const isInvoiced = row.invoiceId != null
  if (isCorrection) {
    show('訂正明細は再訂正できません', 'warn')
    return
  }
  if (isInvoiced) {
    show('請求済みの明細は訂正できません（請求側で赤伝を発行してください）', 'warn')
    return
  }
  const ok = await ask(
    '売上明細の訂正（赤黒）',
    `明細「${code}」のマイナス（赤黒）明細を追加して取り消します。元の明細は記録として残ります。実行しますか？`,
    { danger: true, confirmLabel: '訂正する' },
  )
  if (!ok) return
  const res = correct(id)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('赤黒訂正を登録しました', 'ok')
}

// ---------- 売上登録 ----------
const companies = tbl('companies')
const customerOptions = computed(() =>
  (companies.value as Company[])
    .filter(c => c.kind === 'customer' && c.active !== false)
    .map(c => ({ value: c.id, label: c.name })))
const segmentOptions = computed(() =>
  activeSegments.value.map(s => ({ value: s.id, label: s.name })))
const skuOptions = computed(() =>
  products.activeSkus().map(s => ({ value: s.id, label: products.skuLabel(s) })))

const entryOpen = ref(false)
const entryForm = ref({
  salesDate: todayJst(), companyId: '', segmentId: '', skuId: '', qty: '', unitPrice: '',
})

function openEntry(): void {
  entryForm.value = {
    salesDate: todayJst(),
    companyId: customerOptions.value[0]?.value ?? '',
    segmentId: segmentFilter.value || (segmentOptions.value[0]?.value ?? ''),
    skuId: skuOptions.value[0]?.value ?? '',
    qty: '',
    unitPrice: '',
  }
  entryOpen.value = true
}

// SKU 選択時に既定売価を補完（未入力のときのみ。上書きしない）
function onSkuChange(): void {
  if (entryForm.value.unitPrice !== '') return
  const sku = products.skuById(entryForm.value.skuId)
  if (sku) entryForm.value.unitPrice = String(products.sellPriceOf(sku))
}

function saveEntry(): void {
  const f = entryForm.value
  const qty = Number(f.qty)
  const unitPrice = Number(f.unitPrice)
  if (!f.companyId || !f.segmentId || !f.skuId) {
    show('得意先・セグメント・SKU を選択してください', 'crit')
    return
  }
  if (f.qty === '' || !Number.isFinite(qty) || qty <= 0) {
    show('数量は 1 以上で入力してください', 'crit')
    return
  }
  if (f.unitPrice === '' || !Number.isFinite(unitPrice) || unitPrice < 0) {
    show('単価は 0 以上の数値で入力してください', 'crit')
    return
  }
  const res = create({
    salesDate: f.salesDate, companyId: f.companyId, segmentId: f.segmentId,
    skuId: f.skuId, qty, unitPrice,
  })
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('売上を登録しました（訂正は明細行から取消できます）', 'ok')
  entryOpen.value = false
}

const entryAmount = computed(() => {
  const qty = Number(entryForm.value.qty)
  const unitPrice = Number(entryForm.value.unitPrice)
  if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return null
  return Math.round(qty * unitPrice)
})
</script>

<template>
  <div>
    <UiPageHeader title="売上管理" description="売上明細・月次推移・セグメント別内訳（F-28）">
      <template #actions>
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-muted">表示年度</span>
          <div class="w-32">
            <UiSelect v-model="fyModel" :options="fyOptions" aria-label="表示年度" />
          </div>
          <button type="button" class="btn btn-primary btn-sm" @click="openEntry">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 売上を登録
          </button>
        </div>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <!-- KPI -->
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        <UiKpiCard
          label="今月売上" :value="kpiSales" :delta="currentMonthYoY" sub="前年同月比"
          icon="TrendingUp"
        />
        <UiKpiCard
          label="粗利率（今月）" :value="kpiMargin" sub="原価計上ベース"
          icon="Percent"
        />
      </div>

      <!-- セグメント切替 -->
      <UiChipTabs v-model="segmentFilter" :options="segmentTabs" />

      <!-- チャート -->
      <div class="grid gap-3 lg:grid-cols-5">
        <ChartsLineChartCard
          :class="isAllSegments ? 'lg:col-span-3' : 'lg:col-span-5'"
          :title="`月次売上（${selectedFy}年度 vs ${selectedFy - 1}年度）`"
          :labels="fiscalMonthLabels"
          :series="salesSeries"
          :y-formatter="fmtYenCompact"
        />
        <ChartsDonutChartCard
          v-if="isAllSegments"
          class="lg:col-span-2"
          :title="`セグメント別内訳（${selectedFy}年度）`"
          :items="segmentBreakdown"
          :value-formatter="fmtYenCompact"
        />
        <ChartsBarChartCard
          class="lg:col-span-5"
          :title="`得意先別内訳（${selectedFy}年度）`"
          :labels="customerLabels"
          :series="customerSeries"
          horizontal
          :height="200"
          :y-formatter="fmtYenCompact"
        />
      </div>

      <!-- セグメント並列比較 -->
      <UiSectionCard :title="`セグメント別売上（${selectedFy}年度・期初〜当月）`" flush>
        <div class="grid grid-cols-2 gap-2 p-3 md:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="c in segmentComparison"
            :key="c.segment.id"
            class="card p-3"
          >
            <div class="text-[11px] font-semibold text-muted truncate">{{ c.segment.name }}</div>
            <div class="num mt-1 text-base font-bold tabular-nums text-ink">{{ fmtYen(c.amount) }}</div>
          </div>
        </div>
      </UiSectionCard>

      <!-- 明細一覧 -->
      <UiSectionCard :title="`売上明細（${filteredRecords.length}件）`" description="行をクリックで赤黒訂正（取消）" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="該当する売上明細がありません"
          @row-click="onRowClick"
        >
          <template #cell-salesDate="{ row }">
            {{ fmtDate(String(row.salesDate)) }}
          </template>
          <template #cell-companyId="{ row }">
            {{ companyName(String(row.companyId)) }}
          </template>
          <template #cell-segmentId="{ row }">
            {{ segmentName(String(row.segmentId)) }}
          </template>
          <template #cell-skuId="{ row }">
            {{ skuLabelOf(String(row.skuId)) }}
          </template>
          <template #cell-qty="{ row }">
            <span class="num tabular-nums" :class="Number(row.qty) < 0 ? 'text-crit' : ''">{{ row.qty }}</span>
          </template>
          <template #cell-amount="{ row }">
            <span class="num tabular-nums" :class="Number(row.amount) < 0 ? 'text-crit font-semibold' : ''">
              {{ fmtYen(Number(row.amount)) }}
            </span>
          </template>
          <template #cell-sourceKind="{ row }">
            <UiStatusBadge
              :label="row.correctionOf != null ? '赤黒訂正' : sourceKindLabel(String(row.sourceKind))"
              :tone="row.correctionOf != null ? 'crit' : 'neutral'"
              dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>

      <!-- 下部導線 -->
      <div class="flex flex-wrap justify-end gap-2">
        <NuxtLink to="/akebono/billing" class="btn btn-sm">
          請求管理へ <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink to="/decision" class="btn btn-sm">
          意思決定支援で深掘る <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>

    <!-- 売上登録モーダル -->
    <UiModal :open="entryOpen" title="売上を登録" @close="entryOpen = false">
      <div class="grid gap-3">
        <UiFormField label="売上日" required>
          <input v-model="entryForm.salesDate" type="date" class="input" aria-label="売上日">
        </UiFormField>
        <UiFormField label="得意先" required>
          <UiSelect v-model="entryForm.companyId" :options="customerOptions" aria-label="得意先" />
        </UiFormField>
        <UiFormField label="事業セグメント" required>
          <UiSelect v-model="entryForm.segmentId" :options="segmentOptions" aria-label="事業セグメント" />
        </UiFormField>
        <UiFormField label="SKU" required>
          <UiSelect v-model="entryForm.skuId" :options="skuOptions" aria-label="SKU" @update:model-value="onSkuChange" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="数量" required>
            <input v-model="entryForm.qty" type="number" min="1" step="1" class="input" placeholder="例: 10" aria-label="数量">
          </UiFormField>
          <UiFormField label="単価（円）" required>
            <input v-model="entryForm.unitPrice" type="number" min="0" step="1" class="input" placeholder="例: 3000" aria-label="単価">
          </UiFormField>
        </div>
        <p v-if="entryAmount !== null" class="text-[13px] text-sub">
          金額（税抜）: <span class="num font-semibold tabular-nums text-ink">{{ fmtYen(entryAmount) }}</span>
        </p>
        <p class="text-[11px] text-muted">
          登録後の取消は、明細一覧の該当行をクリックして赤黒訂正で行えます（記録系のため物理削除しません）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="entryOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="saveEntry">登録する</button>
      </template>
    </UiModal>
  </div>
</template>
