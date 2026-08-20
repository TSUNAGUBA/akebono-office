<script setup lang="ts">
/**
 * ダッシュボード: データカバレッジ KPI + フィードバックループ概況 + 最新インサイト + 未完了アクション。
 */
import { ArrowRight, Database, Lightbulb, ListChecks, RefreshCw } from 'lucide-vue-next'
import {
  ACTION_STATUS_LABELS, ACTION_STATUS_TONES, CONFIDENCE_LABELS, CONFIDENCE_TONES,
  INSIGHT_THEME_LABELS, INSIGHT_THEME_TONES,
} from '~/utils/labels'
import { fmtDate, fmtDateTime, fmtInt } from '~/utils/format'

const { daily, support, sales, partner, customerLogs, loading } = useIntelligenceData()
const { insights, actions, cycles } = useIntelStore()

const month = computed(() => todayJst().slice(0, 7))
const dailyThisMonth = computed(() =>
  daily.value.filter(r => r.status === 'submitted' && r.date.slice(0, 7) === month.value).length)
const activityTotal = computed(() =>
  support.value.filter(s => s.active !== false).length
  + sales.value.filter(s => s.active !== false).length
  + partner.value.filter(s => s.active !== false).length
  + customerLogs.value.filter(s => s.active !== false).length)

const activeInsights = computed(() =>
  insights.value.filter(i => i.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const openActions = computed(() =>
  actions.value
    .filter(a => a.active && (a.status === 'planned' || a.status === 'in_progress'))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')))
const doneWithFeedback = computed(() =>
  actions.value.filter(a => a.active && a.status === 'done' && a.feedbackRating !== null).length)
const latestCycle = computed(() =>
  [...cycles.value].filter(c => c.active).sort((a, b) => b.at.localeCompare(a.at))[0])

/** ループの 4 ステップ概況（件数付き） */
const loopSteps = computed(() => [
  { key: 'data', icon: Database, label: 'データ', note: `${fmtInt(activityTotal.value)} 件の活動 + 日報ほか`, to: '/data' },
  { key: 'insight', icon: Lightbulb, label: '分析・インサイト', note: `${activeInsights.value.length} 件`, to: '/insights' },
  { key: 'action', icon: ListChecks, label: 'アクション', note: `実行中 ${openActions.value.length} 件`, to: '/actions' },
  { key: 'feedback', icon: RefreshCw, label: 'フィードバック', note: `記録済み ${doneWithFeedback.value} 件`, to: '/cycles' },
])
</script>

<template>
  <div>
    <UiPageHeader
      title="ダッシュボード"
      description="共通基盤のデータから分析・インサイト・提案を得て、アクションと結果を次の分析へ還流します"
    />

    <!-- KPI -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <UiKpiCard label="当月の日報" :value="fmtInt(dailyThisMonth)" icon="FileText" to="/data" :sub="loading ? '読込中…' : ''" />
      <UiKpiCard label="活動ログ累計" :value="fmtInt(activityTotal)" sub="サポート/営業/BP/顧客" icon="Activity" to="/data" />
      <UiKpiCard label="インサイト" :value="fmtInt(activeInsights.length)" icon="Lightbulb" to="/insights" />
      <UiKpiCard label="未完了アクション" :value="fmtInt(openActions.length)" icon="ListChecks" to="/actions" />
    </div>

    <!-- フィードバックループ概況 -->
    <UiSectionCard
      class="mt-3"
      title="フィードバックループ"
      :description="latestCycle ? `直近の分析サイクル: ${fmtDateTime(latestCycle.at)}（${INSIGHT_THEME_LABELS[latestCycle.theme]} / ${latestCycle.targetName}）` : 'まだ分析サイクルがありません。インサイトから分析を実行してください'"
    >
      <!-- モバイルは 1 列: 2 列だと見出しが「分析・インサイ/ト」と語中折返しする（UnitI 検出） -->
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
        <template v-for="(s, i) in loopSteps" :key="s.key">
          <NuxtLink
            :to="s.to"
            class="card relative flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:border-brand"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <component :is="s.icon" class="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <span class="min-w-0">
              <span class="block text-[13px] font-semibold">{{ s.label }}</span>
              <span class="block truncate text-[11px] text-muted">{{ s.note }}</span>
            </span>
            <ArrowRight
              v-if="i < loopSteps.length - 1"
              class="absolute -right-2 top-1/2 hidden h-3.5 w-3.5 -translate-y-1/2 text-muted md:block"
              aria-hidden="true"
            />
          </NuxtLink>
        </template>
      </div>
      <p class="mt-2 text-[11px] text-muted">
        フィードバックは次回の分析に反映されます（高評価 → 継続強化 / 低評価 → 代替案 / 実行中 → 重複提案の抑制）。
      </p>
    </UiSectionCard>

    <div class="mt-3 grid gap-3 lg:grid-cols-2">
      <!-- 最新インサイト -->
      <UiSectionCard title="最新のインサイト">
        <template #actions>
          <NuxtLink to="/insights" class="link text-xs">すべて見る →</NuxtLink>
        </template>
        <UiEmptyState
          v-if="activeInsights.length === 0"
          icon="Lightbulb"
          title="インサイトがまだありません"
          hint="「インサイト」から分析を実行してください"
        />
        <ul v-else class="grid gap-2">
          <li v-for="ins in activeInsights.slice(0, 3)" :key="ins.id" class="rounded-lg border border-line p-2.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <UiStatusBadge :label="INSIGHT_THEME_LABELS[ins.theme]" :tone="INSIGHT_THEME_TONES[ins.theme]" />
              <UiStatusBadge :label="CONFIDENCE_LABELS[ins.confidence]" :tone="CONFIDENCE_TONES[ins.confidence]" />
              <span class="num ml-auto text-[11px] text-muted">{{ fmtDate(ins.createdAt) }}</span>
            </div>
            <p class="mt-1 text-[13px] font-semibold">{{ ins.title }}</p>
            <p class="mt-0.5 line-clamp-2 text-[12px] text-sub">{{ ins.summary }}</p>
          </li>
        </ul>
      </UiSectionCard>

      <!-- 未完了アクション -->
      <UiSectionCard title="未完了のアクション">
        <template #actions>
          <NuxtLink to="/actions" class="link text-xs">すべて見る →</NuxtLink>
        </template>
        <UiEmptyState
          v-if="openActions.length === 0"
          icon="ListChecks"
          title="未完了のアクションはありません"
          hint="インサイトの提案からアクション化できます"
        />
        <ul v-else class="grid gap-2">
          <li v-for="a in openActions.slice(0, 5)" :key="a.id" class="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
            <UiStatusBadge :label="ACTION_STATUS_LABELS[a.status]" :tone="ACTION_STATUS_TONES[a.status]" dot />
            <span class="min-w-0 flex-1 truncate text-[13px]">{{ a.title }}</span>
            <span v-if="a.dueDate" class="num shrink-0 text-[11px]" :class="a.dueDate < todayJst() ? 'font-semibold text-crit' : 'text-muted'">
              期日 {{ fmtDate(a.dueDate) }}
            </span>
          </li>
        </ul>
      </UiSectionCard>
    </div>
  </div>
</template>
