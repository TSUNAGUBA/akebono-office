<script setup lang="ts">
/**
 * 売上管理（F-01-1 をダッシュボードから独立させたページ。2026-07-16 オペレーター指示）
 * 集計は useSales が SoT。年度切替・月次推移・事業種別/顧客別内訳・意思決定支援への導線。
 */
import { ArrowRight } from 'lucide-vue-next'
import { fmtPct, fmtYenCompact } from '~/utils/format'

const {
  fiscalMonthLabels, currentFySeries, previousFySeries,
  currentMonthSales, currentMonthYoY, currentMonthMarginRate, marginYoYDiff,
  typeBreakdown, customerBreakdown, selectedFy, fiscalYearOptions,
} = useSales()

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
</script>

<template>
  <div>
    <UiPageHeader title="売上管理" description="月次売上の推移・前年比・内訳（モック集計）">
      <template #actions>
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-bold text-muted">表示年度</span>
          <div class="w-32">
            <UiSelect v-model="fyModel" :options="fyOptions" aria-label="売上の表示年度" />
          </div>
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
  </div>
</template>
