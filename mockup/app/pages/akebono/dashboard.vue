<script setup lang="ts">
/**
 * 業態ダッシュボード（F-41-1。2026-07-28 オペレーター指示）。
 * AKEBONO 業務の各セグメント（業態）について、業務（売上・受注）× メディア（GA 流入・CV）を統合した
 * 「サマリー・AI レポート・AI インサイト」を 1 画面で提供する。対象業態はヘッダの業態スイッチャ / 本画面のチップで切替。
 *
 * - サマリー（KPI・チャート）は常時ライブ集計（前日/前月基準）。
 * - AI レポート・インサイトは「生成 → 保管 → 再生成で上書き」（週次/メディアインサイトと同思想）。
 */
import { Layers, RefreshCw, Sparkles, Target } from 'lucide-vue-next'
import { fmtDateTime, fmtInt, fmtPct, fmtYenCompact } from '~/utils/format'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { FINDING_KIND_LABELS, PRIORITY_LABELS, findingTone, priorityTone } from '~/utils/media'
import type { MenuCard } from '~/types/ui'
import type { SegmentDashboardView } from '~/composables/useDashboardInsight'

const { activeSegments, effectiveSegmentId, currentSegment, switchSegment } = useCurrentSegment()
const { settingFor } = useMediaSettings()
const { buildSegmentSummary, loadSegment, generateSegment } = useDashboardInsight()
const { isEnabled } = useAppSettings()
const { can } = usePermissions()
const apps = useAkebonoApps()
const { show } = useToast()

// メディア軸はメディア機能トグルが有効なときのみ表示（無効時は業務サマリーのみ）
const mediaEnabled = computed(() => isEnabled('media'))
const connected = computed(() => mediaEnabled.value && settingFor(effectiveSegmentId.value)?.gaConnected === true)
// 会社全体ダッシュボードは売上権限が必要（導線もゲート = 他の入口と一貫）
const canCompanyDashboard = computed(() => can('sales'))

// ---------- サマリー（常時ライブ） ----------
const summary = computed(() => buildSegmentSummary(effectiveSegmentId.value))
const snap = computed(() => summary.value.snapshot)

const salesTrendChart = computed(() => ({
  labels: summary.value.trend.map(t => t.month.slice(2)),
  series: [{ label: '売上(万円)', data: summary.value.trend.map(t => Math.round(t.salesAmount / 10000)) }],
}))
const mediaTrendChart = computed(() => ({
  labels: summary.value.trend.map(t => t.month.slice(2)),
  series: [
    { label: 'セッション', data: summary.value.trend.map(t => t.sessions) },
    { label: 'コンバージョン', data: summary.value.trend.map(t => t.conversions) },
  ],
}))

// ---------- 保管済み AI レポート・インサイト（生成 → 保管 → 再生成で上書き） ----------
const view = ref<SegmentDashboardView | null>(null)
const generating = ref(false)

function reload(): void {
  view.value = loadSegment(effectiveSegmentId.value)
}
watch(effectiveSegmentId, reload, { immediate: true })

function regenerate(): void {
  if (generating.value) return
  generating.value = true
  try {
    view.value = generateSegment(effectiveSegmentId.value)
    show('AI レポート・インサイトを生成し、保存しました', 'ok')
  } finally { generating.value = false }
}

// ---------- この業態のアプリ導線 ----------
const appCards = computed<MenuCard[]>(() =>
  apps.enabledApps.value.map(a => ({ id: a.key, title: apps.labelOf(a), description: a.description, icon: a.icon, to: a.to })))
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader title="業態ダッシュボード" :description="currentSegment ? `${currentSegment.name}・対象月 ${summary.periodMonth}` : ''">
      <template #actions>
        <UiMockBadge />
      </template>
    </UiPageHeader>

    <div v-if="!currentSegment">
      <UiEmptyState icon="Layers" title="業態が登録されていません" hint="共通マスタ管理から事業セグメント（業態）を登録してください" />
    </div>

    <div v-else class="grid gap-4">
      <!-- 業態スイッチャ -->
      <div class="grid gap-2 rounded-[10px] border border-line bg-surface-soft p-3">
        <div class="flex flex-wrap items-center gap-2">
          <Layers class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
          <span class="text-[12px] text-sub">対象業態</span>
          <span class="text-[13px] font-bold">{{ currentSegment.name }}</span>
          <UiStatusBadge :label="INDUSTRY_TYPE_LABELS[currentSegment.industryType]" tone="info" />
          <UiStatusBadge v-if="mediaEnabled" :label="connected ? 'メディア連携済み' : 'メディア未連携'" :tone="connected ? 'ok' : 'neutral'" dot />
          <NuxtLink v-if="canCompanyDashboard" to="/akebono/company" class="btn btn-ghost btn-sm ml-auto">
            <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> 会社全体
          </NuxtLink>
        </div>
        <div v-if="activeSegments.length > 1" class="flex flex-wrap gap-1.5">
          <button
            v-for="s in activeSegments"
            :key="s.id"
            type="button"
            class="rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors"
            :class="s.id === effectiveSegmentId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
            :aria-pressed="s.id === effectiveSegmentId"
            @click="switchSegment(s.id)"
          >
            {{ s.name }}<span class="ml-1 text-[10px] text-muted">{{ INDUSTRY_TYPE_LABELS[s.industryType] }}</span>
          </button>
        </div>
      </div>

      <!-- ① サマリー（KPI）。メディア軸は機能トグル有効時のみ -->
      <div class="grid grid-cols-2 gap-3" :class="mediaEnabled ? 'md:grid-cols-4' : 'md:grid-cols-2'">
        <UiKpiCard
          label="売上（対象月）" :value="fmtYenCompact(snap.salesAmount)"
          :delta="snap.prevSalesAmount > 0 ? (snap.salesAmount - snap.prevSalesAmount) / snap.prevSalesAmount : null"
          sub="前月比" icon="TrendingUp" to="/akebono/sales"
        />
        <UiKpiCard label="受注件数" :value="fmtInt(snap.orders)" :sub="`平均 ${snap.aov > 0 ? fmtYenCompact(snap.aov) : '—'}`" icon="Receipt" />
        <template v-if="mediaEnabled">
          <UiKpiCard
            label="メディア流入" :value="connected ? fmtInt(snap.sessions) : '—'"
            :delta="connected && snap.prevSessions > 0 ? (snap.sessions - snap.prevSessions) / snap.prevSessions : null"
            sub="前月比・セッション" icon="MousePointerClick" to="/media"
          />
          <UiKpiCard
            label="コンバージョン" :value="connected ? fmtInt(snap.conversions) : '—'"
            :sub="connected ? `CVR ${fmtPct(snap.conversionRate)}` : 'GA 未連携'" icon="Target" to="/media"
          />
        </template>
      </div>

      <!-- チャート -->
      <div class="grid gap-3" :class="mediaEnabled ? 'lg:grid-cols-2' : ''">
        <ChartsBarChartCard title="売上推移（月次）" :labels="salesTrendChart.labels" :series="salesTrendChart.series" :y-formatter="v => `${fmtInt(v)}万`" />
        <template v-if="mediaEnabled">
          <ChartsLineChartCard v-if="connected" title="流入・コンバージョン（月次）" :labels="mediaTrendChart.labels" :series="mediaTrendChart.series" />
          <UiSectionCard v-else title="メディア分析" description="この業態はまだ Google Analytics 未連携です">
            <UiEmptyState icon="LineChart" title="GA を連携するとメディア指標が表示されます" hint="流入・CV と売上を突き合わせた PDCA、記事別インサイトが本ダッシュボードに加わります">
              <template #action>
                <NuxtLink to="/media/settings" class="btn btn-primary btn-sm">メディアを連携する</NuxtLink>
              </template>
            </UiEmptyState>
          </UiSectionCard>
        </template>
      </div>

      <!-- ②③ AI レポート・AI インサイト（生成/再生成） -->
      <UiSectionCard
        title="AI レポート・インサイト"
        :description="view ? `生成 ${fmtDateTime(view.generatedAt)}${view.generatedByName ? `（${view.generatedByName}）` : ''}・${view.llm ? 'Vertex AI' : '集計値からの自動生成'}` : '業務 × メディアの現状から、この業態のレポートとインサイト・次アクションを生成します'"
      >
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" :disabled="generating" @click="regenerate">
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
            {{ generating ? '生成中…' : view ? '再生成' : 'レポートを生成' }}
          </button>
        </template>

        <UiEmptyState
          v-if="!view"
          icon="Sparkles"
          title="レポートはまだ生成されていません"
          hint="「レポートを生成」を押すと、現在の集計からこの業態のレポート・インサイト・次アクションを生成・保存します"
        />
        <div v-else class="grid gap-4">
          <!-- AI レポート -->
          <div class="rounded-lg border border-line bg-surface-soft p-3">
            <UiMarkdown :source="view.insight.executiveSummary" />
          </div>

          <!-- AI インサイト（好調/課題/機会） -->
          <div>
            <p class="label mb-1">インサイト（好調・課題・機会）</p>
            <ul class="grid gap-2 sm:grid-cols-2">
              <li v-for="(f, i) in view.insight.findings" :key="i" class="rounded-lg border border-line p-2.5">
                <span class="flex flex-wrap items-center gap-2">
                  <UiStatusBadge :label="FINDING_KIND_LABELS[f.kind]" :tone="findingTone(f.kind)" />
                  <span class="text-[13px] font-bold">{{ f.title }}</span>
                </span>
                <p class="mt-1 text-[12px] text-sub">{{ f.detail }}</p>
              </li>
            </ul>
          </div>

          <!-- 次アクション -->
          <div>
            <p class="label mb-1">次に起こすべきアクション</p>
            <ul class="grid gap-2">
              <li v-for="(a, i) in view.insight.actions" :key="i" class="flex items-start gap-2 rounded-lg border border-line p-2.5">
                <Target class="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="text-[13px] font-bold">{{ a.title }}</span>
                    <UiStatusBadge :label="`優先度 ${PRIORITY_LABELS[a.priority]}`" :tone="priorityTone(a.priority)" />
                  </span>
                  <span class="mt-0.5 block text-[12px] text-sub">{{ a.detail }}</span>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </UiSectionCard>

      <!-- この業態のアプリ導線 -->
      <UiSectionCard v-if="appCards.length > 0" title="この業態の業務アプリ" description="メディア分析・売上・在庫など、この業態で使用中のアプリへ" flush>
        <div class="p-3">
          <UiCardMenu :items="appCards" />
        </div>
      </UiSectionCard>
    </div>
  </div>
</template>
