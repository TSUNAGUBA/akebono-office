<script setup lang="ts">
/**
 * データソース状況（FI-02）: 参照データの件数・期間・月別推移の可視化と再読込。
 * API モードは共通 API の実データ（権限フィルタ済み）、モックモードは決定的シード。
 */
import { RefreshCw } from 'lucide-vue-next'
import { addMonths } from '~/utils/insight-engine'
import { fmtDate, fmtInt, fmtYenCompact } from '~/utils/format'

const {
  daily, weekly, monthly, support, sales, partner, customerLogs, salesMonthly,
  companies, projects, loading, refresh,
} = useIntelligenceData()
const { show } = useToast()
const isApi = useApiMode()

function activeOf<T extends { active?: boolean }>(rows: T[]): T[] {
  return rows.filter(r => r.active !== false)
}

/** ソース一覧（件数・期間） */
const sources = computed(() => {
  const dailyRows = daily.value.filter(r => r.status === 'submitted')
  const range = (dates: string[]): string => {
    if (dates.length === 0) return '—'
    const sorted = [...dates].sort()
    return `${fmtDate(sorted[0]!)} 〜 ${fmtDate(sorted[sorted.length - 1]!)}`
  }
  return [
    { key: 'daily', label: '日報', count: dailyRows.length, range: range(dailyRows.map(r => r.date)), note: '提出済みのみ（API モードは直近 3 ヶ月）' },
    { key: 'weekly', label: '週報', count: weekly.value.length, range: range(weekly.value.map(r => r.weekStart)), note: '' },
    { key: 'monthly', label: '月報', count: monthly.value.length, range: range(monthly.value.map(r => r.monthStart)), note: '' },
    { key: 'support', label: 'サポート活動', count: activeOf(support.value).length, range: range(activeOf(support.value).map(r => r.receivedDate)), note: '' },
    { key: 'sales', label: '営業活動', count: activeOf(sales.value).length, range: range(activeOf(sales.value).map(r => r.createdAt.slice(0, 10))), note: '' },
    { key: 'partner', label: 'ビジネスパートナー活動', count: activeOf(partner.value).length, range: range(activeOf(partner.value).map(r => r.createdAt.slice(0, 10))), note: '' },
    { key: 'customerLog', label: '顧客活動', count: activeOf(customerLogs.value).length, range: range(activeOf(customerLogs.value).map(r => r.logDate)), note: '' },
    { key: 'salesMonthly', label: '月次売上', count: salesMonthly.value.length, range: salesMonthly.value.length > 0 ? `${[...salesMonthly.value.map(s => s.month)].sort()[0]} 〜 ${[...salesMonthly.value.map(s => s.month)].sort().pop()}` : '—', note: '売上分析マート' },
    { key: 'masters', label: 'マスタ（顧客・案件）', count: activeOf(companies.value).length + activeOf(projects.value).length, range: '—', note: '分析の対象選択に使用' },
  ]
})

/** 月別活動件数（直近 6 ヶ月・種類別） */
const MONTHS_BACK = 5
const monthLabels = computed(() => {
  const current = todayJst().slice(0, 7)
  return Array.from({ length: MONTHS_BACK + 1 }, (_, i) => addMonths(current, i - MONTHS_BACK))
})

function countByMonth(dates: string[]): number[] {
  return monthLabels.value.map(m => dates.filter(d => d.slice(0, 7) === m).length)
}

const activitySeries = computed(() => [
  { label: 'サポート', data: countByMonth(activeOf(support.value).map(r => r.receivedDate)) },
  { label: '営業', data: countByMonth(activeOf(sales.value).map(r => r.createdAt.slice(0, 10))) },
  { label: 'BP', data: countByMonth(activeOf(partner.value).map(r => r.createdAt.slice(0, 10))) },
  { label: '顧客活動', data: countByMonth(activeOf(customerLogs.value).map(r => r.logDate)) },
])

const reportSeries = computed(() => [
  { label: '日報', data: countByMonth(daily.value.filter(r => r.status === 'submitted').map(r => r.date)) },
])

/** 月次売上の直近 12 ヶ月合計 */
const salesTrend = computed(() => {
  const months = [...new Set(salesMonthly.value.map(s => s.month))].sort().slice(-12)
  return {
    labels: months,
    series: [{
      label: '売上',
      data: months.map(m => salesMonthly.value.filter(s => s.month === m).reduce((sum, s) => sum + s.amount, 0)),
    }],
  }
})

async function onRefresh(): Promise<void> {
  await refresh()
  show(isApi ? 'データを再読込しました' : 'モックモードのため再読込は不要です（決定的シード）', isApi ? 'ok' : 'info')
}
</script>

<template>
  <div>
    <UiPageHeader title="データソース" description="分析が参照する共通基盤データの状況です">
      <template #actions>
        <button type="button" class="btn btn-sm" :disabled="loading" @click="onRefresh">
          <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
          {{ loading ? '読込中…' : '再読込' }}
        </button>
      </template>
    </UiPageHeader>

    <UiSectionCard title="ソース一覧" description="件数・期間はアクセス権の範囲で取得したデータに基づきます" flush>
      <!-- scroll-slim: モバイルで末尾列が切れたときにスクロール可能と分かる手掛かり（UnitI） -->
      <div class="overflow-x-auto pb-1 scroll-slim">
        <table class="tbl min-w-[560px]">
          <thead>
            <tr>
              <th>データソース</th>
              <th class="text-right">件数</th>
              <th>期間</th>
              <th>備考</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sources" :key="s.key">
              <td class="font-medium">{{ s.label }}</td>
              <td class="num text-right">{{ fmtInt(s.count) }}</td>
              <td class="num text-[12px]">{{ s.range }}</td>
              <td class="text-[12px] text-muted">{{ s.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiSectionCard>

    <div class="mt-3 grid gap-3 lg:grid-cols-3">
      <ChartsBarChartCard
        title="月別 活動件数（直近 6 ヶ月）"
        :labels="monthLabels"
        :series="activitySeries"
      />
      <ChartsBarChartCard
        title="月別 日報提出（直近 6 ヶ月）"
        :labels="monthLabels"
        :series="reportSeries"
      />
      <ChartsLineChartCard
        title="月次売上（直近 12 ヶ月）"
        :labels="salesTrend.labels"
        :series="salesTrend.series"
        :y-formatter="fmtYenCompact"
      />
    </div>
  </div>
</template>
