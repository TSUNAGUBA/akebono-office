<script setup lang="ts">
/**
 * 売上管理（F-15。F-01-1 をダッシュボードから独立させたページ。2026-07-16 オペレーター指示）
 * 集計は useSales が SoT（API モードは /v1/sales）。年度切替・月次推移・事業種別/顧客別内訳・
 * 意思決定支援への導線。実績の登録/更新（月次 upsert）は管理者のみ（バッチ6b）。
 */
import { ArrowRight, Plus } from 'lucide-vue-next'
import type { ProjectType } from '~/types/domain'
import { fmtPct, fmtYenCompact } from '~/utils/format'
import { PROJECT_TYPE_LABELS } from '~/utils/labels'

const {
  fiscalMonthLabels, currentFySeries, previousFySeries,
  currentMonthSales, currentMonthYoY, currentMonthMarginRate, marginYoYDiff,
  typeBreakdown, customerBreakdown, selectedFy, fiscalYearOptions,
  currentMonth, refresh, upsert,
} = useSales()
const { isAdmin } = useCurrentUser()
const { tbl } = useMockDb()
const { show } = useToast()

// 表示時に最新実績を取り込む（API モード。他管理者の登録の反映）
onMounted(() => { void refresh() })

// ---------- KPI ----------
const kpiSales = computed(() => fmtYenCompact(currentMonthSales.value))
const kpiMargin = computed(() =>
  currentMonthMarginRate.value === null ? '—' : fmtPct(currentMonthMarginRate.value))

// ---------- チャート ----------
const salesSeries = computed(() => [
  { label: `${selectedFy.value}年度`, data: currentFySeries.value },
  { label: `${selectedFy.value - 1}年度`, data: previousFySeries.value },
])

// 年度セレクタ（UiSelect は string モデルのため変換）
const fyModel = computed({
  get: () => String(selectedFy.value),
  set: (v: string) => { selectedFy.value = Number(v) },
})
const fyOptions = computed(() =>
  fiscalYearOptions.value.map(fy => ({ value: String(fy), label: `${fy}年度` })))

// 顧客別内訳（Top5 + その他。横棒チャート用の射影）
const customerLabels = computed(() => customerBreakdown.value.map(c => c.label))
const customerSeries = computed(() => [
  { label: '売上', data: customerBreakdown.value.map(c => c.value) },
])

// ---------- 実績登録（管理者のみ・月次 upsert = 同一キーは上書き） ----------
const companies = tbl('companies')
const customerOptions = computed(() =>
  companies.value.filter(c => c.kind === 'customer' && c.active !== false)
    .map(c => ({ value: c.id, label: c.name })))
const typeOptions = Object.entries(PROJECT_TYPE_LABELS).map(([value, label]) => ({ value, label }))

const entryOpen = ref(false)
const entrySaving = ref(false)
const entryForm = ref({ month: currentMonth, companyId: '', projectType: 'development', amount: '', cost: '' })

function openEntry(): void {
  entryForm.value = {
    month: currentMonth,
    companyId: customerOptions.value[0]?.value ?? '',
    projectType: 'development',
    amount: '',
    cost: '',
  }
  entryOpen.value = true
}

async function saveEntry(): Promise<void> {
  if (entrySaving.value) return
  const f = entryForm.value
  const amount = Number(f.amount)
  const cost = Number(f.cost)
  if (!f.companyId) {
    show('顧客(会社)を選択してください', 'crit')
    return
  }
  if (f.amount === '' || f.cost === '' || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(cost) || cost < 0) {
    show('売上・原価は 0 以上の数値で入力してください', 'crit')
    return
  }
  entrySaving.value = true
  try {
    const res = await upsert({
      month: f.month,
      companyId: f.companyId,
      projectType: f.projectType as ProjectType,
      amount,
      cost,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show('月次実績を登録しました（同一キーは上書き）')
    entryOpen.value = false
  } finally {
    entrySaving.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="売上管理" description="月次売上の推移・前年比・内訳">
      <template #actions>
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-muted">表示年度</span>
          <div class="w-32">
            <UiSelect v-model="fyModel" :options="fyOptions" aria-label="売上の表示年度" />
          </div>
          <button v-if="isAdmin" type="button" class="btn btn-primary btn-sm" @click="openEntry">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 実績登録
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
          label="粗利率（今月）" :value="kpiMargin" :delta="marginYoYDiff" sub="前年同月差"
          icon="Percent"
        />
      </div>

      <!-- チャート -->
      <div class="grid gap-3 lg:grid-cols-5">
        <ChartsLineChartCard
          class="lg:col-span-3"
          :title="`月次売上（${selectedFy}年度 vs ${selectedFy - 1}年度）`"
          :labels="fiscalMonthLabels"
          :series="salesSeries"
          :y-formatter="fmtYenCompact"
        />
        <ChartsDonutChartCard
          class="lg:col-span-2"
          :title="`事業種別内訳（${selectedFy}年度）`"
          :items="typeBreakdown"
          :value-formatter="fmtYenCompact"
        />
        <ChartsBarChartCard
          class="lg:col-span-5"
          :title="`顧客別内訳（${selectedFy}年度）`"
          :labels="customerLabels"
          :series="customerSeries"
          horizontal
          :height="200"
          :y-formatter="fmtYenCompact"
        />
      </div>

      <div class="flex justify-end">
        <NuxtLink to="/decision" class="btn btn-sm">
          意思決定支援で深掘る <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>

    <!-- 実績登録（管理者のみ。月 × 顧客 × 事業種別の月次 upsert） -->
    <UiModal :open="entryOpen" title="月次実績の登録" @close="entryOpen = false">
      <div class="grid gap-3">
        <UiFormField label="対象月" required>
          <input v-model="entryForm.month" type="month" class="input" aria-label="対象月">
        </UiFormField>
        <UiFormField label="顧客(会社)" required>
          <UiSelect v-model="entryForm.companyId" :options="customerOptions" aria-label="顧客(会社)" />
        </UiFormField>
        <UiFormField label="事業種別" required>
          <UiSelect v-model="entryForm.projectType" :options="typeOptions" aria-label="事業種別" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="売上（円）" required>
            <input v-model="entryForm.amount" type="number" min="0" step="1" class="input" placeholder="例: 1200000" aria-label="売上（円）">
          </UiFormField>
          <UiFormField label="原価（円）" required>
            <input v-model="entryForm.cost" type="number" min="0" step="1" class="input" placeholder="例: 700000" aria-label="原価（円）">
          </UiFormField>
        </div>
        <p class="text-[11px] text-muted">
          同じ「月 × 顧客 × 事業種別」の登録は上書き（更新）になります。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="entryOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="entrySaving" @click="saveEntry">
          {{ entrySaving ? '保存中…' : '登録する' }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
