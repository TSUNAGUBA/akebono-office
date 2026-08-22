<script setup lang="ts">
/**
 * データソース（FI-02 → 改善要望 2026-08-22 で 3 カテゴリのデータ基盤へ再編）。
 * 「自社コンテキスト / ナレッジ / ログ」のカテゴリごとにデータ項目カードを並べ、
 * 全項目に共通 UI 構造「データ項目 → 一覧（/data/<item>） → 詳細（ドロワー）」でドリルダウンする。
 * 件数・期間は API モードは共通 API の実データ（権限フィルタ済み）、モックモードは決定的シード。
 */
import { ChevronRight, RefreshCw } from 'lucide-vue-next'
import { addMonths } from '~/utils/insight-engine'
import { FOUNDATION_CATEGORIES, foundationItemsOf } from '~/utils/data-foundation'
import { fmtDate, fmtInt, fmtYenCompact } from '~/utils/format'

const {
  daily, weekly, monthly, support, sales, partner, customerLogs, salesMonthly,
  companies, projects, members, loading, refresh,
} = useIntelligenceData()
const foundation = useFoundationData()
const { show } = useToast()
const isApi = useApiMode()

function activeOf<T extends { active?: boolean }>(rows: T[]): T[] {
  return rows.filter(r => r.active !== false)
}

function latestOf(dates: string[]): string {
  if (dates.length === 0) return ''
  return [...dates].sort()[dates.length - 1] ?? ''
}

/** データ項目カードの件数・最新日（key = FOUNDATION_ITEMS.key） */
const itemStats = computed<Record<string, { count: number; latest: string }>>(() => {
  const dailyRows = daily.value.filter(r => r.status === 'submitted')
  const weeklyRows = weekly.value.filter(r => r.status === 'submitted')
  const monthlyRows = monthly.value.filter(r => r.status === 'submitted')
  const minutesRows = activeOf(foundation.minutes.value)
  const ispRows = activeOf(foundation.internalSupports.value)
  const pnRows = foundation.consignmentReports.value.filter(r => !r.voidedAt)
  return {
    'company': { count: companies.value.filter(c => c.kind === 'self').length, latest: '' },
    'projects': { count: projects.value.filter(p => p.active).length, latest: '' },
    'members': { count: members.value.filter(m => m.active !== false).length, latest: '' },
    'media-reports': {
      count: foundation.mediaReports.value.length,
      latest: latestOf(foundation.mediaReports.value.map(r => r.weekStart)),
    },
    'ec-reports': {
      count: foundation.ecReports.value.length,
      latest: latestOf(foundation.ecReports.value.map(r => r.generatedAt.slice(0, 10))),
    },
    'consignment-reports': { count: pnRows.length, latest: latestOf(pnRows.map(r => r.periodTo)) },
    'internal-supports': { count: ispRows.length, latest: latestOf(ispRows.map(r => r.activityDate)) },
    'monthly-reports': { count: monthlyRows.length, latest: latestOf(monthlyRows.map(r => r.monthStart)) },
    'minutes': { count: minutesRows.length, latest: latestOf(minutesRows.map(r => r.createdAt.slice(0, 10))) },
    'daily-reports': { count: dailyRows.length, latest: latestOf(dailyRows.map(r => r.date)) },
    'weekly-reports': { count: weeklyRows.length, latest: latestOf(weeklyRows.map(r => r.weekStart)) },
  }
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

const anyLoading = computed(() => loading.value || foundation.loading.value)

async function onRefresh(): Promise<void> {
  await Promise.all([refresh(), foundation.refresh()])
  show(isApi ? 'データを再読込しました' : 'モックモードのため再読込は不要です（決定的シード）', isApi ? 'ok' : 'info')
}
</script>

<template>
  <div>
    <UiPageHeader
      title="データソース"
      description="分析が参照する共通基盤データを 3 カテゴリで整理しています。項目を押すと一覧 → 詳細へドリルダウンできます"
    >
      <template #actions>
        <button type="button" class="btn btn-sm" :disabled="anyLoading" @click="onRefresh">
          <RefreshCw class="h-3.5 w-3.5" :class="anyLoading ? 'animate-spin' : ''" aria-hidden="true" />
          {{ anyLoading ? '読込中…' : '再読込' }}
        </button>
      </template>
    </UiPageHeader>

    <!-- 3 カテゴリ（自社コンテキスト / ナレッジ / ログ）のデータ項目カード -->
    <div class="grid gap-3">
      <UiSectionCard
        v-for="cat in FOUNDATION_CATEGORIES"
        :key="cat.id"
        :title="cat.label"
        :description="cat.description"
      >
        <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="item in foundationItemsOf(cat.id)" :key="item.key">
            <NuxtLink
              :to="`/data/${item.key}`"
              class="card flex h-full items-center gap-3 px-3 py-2.5 transition-colors hover:border-brand"
            >
              <IconGlyph :icon="item.icon" :size="34" />
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline gap-2">
                  <span class="text-[13px] font-semibold">{{ item.label }}</span>
                  <span class="num text-[12px] text-muted">{{ fmtInt(itemStats[item.key]?.count ?? 0) }}件</span>
                </span>
                <!-- 説明は折返して全文表示（truncate は 375px で内容が読めなくなる = truncate プローブ検出） -->
                <span class="block text-[11px] leading-snug text-muted">{{ item.description }}</span>
                <span v-if="itemStats[item.key]?.latest" class="num block text-[11px] text-muted">
                  最新 {{ fmtDate(itemStats[item.key]!.latest) }}
                </span>
              </span>
              <ChevronRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            </NuxtLink>
          </li>
        </ul>
        <p v-if="cat.note" class="mt-2 text-[11px] text-muted">{{ cat.note }}</p>
      </UiSectionCard>
    </div>

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
