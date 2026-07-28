<script setup lang="ts">
/**
 * 会社全体ダッシュボード（F-41-2。2026-07-28 オペレーター指示）。
 * セグメント（業態）を超えた会社全体の「サマリー・AI レポート・AI インサイト」を提供する。
 * 全業態の業務（売上・受注）× メディア（GA 流入・CV）をロールアップし、経営レポートと横断インサイトを出す。
 *
 * 会社全体の売上ロールアップを扱うため、閲覧は売上権限（can('sales')）を必要とする（トップの売上管理と同基準）。
 * サマリーは常時ライブ、AI レポート・インサイトは「生成 → 保管 → 再生成で上書き」。
 */
import { RefreshCw, Sparkles, Target } from 'lucide-vue-next'
import { fmtInt, fmtPct, fmtYenCompact, fmtDateTime } from '~/utils/format'
import { FINDING_KIND_LABELS, PRIORITY_LABELS, findingTone, priorityTone } from '~/utils/media'
import type { TableColumn } from '~/types/ui'
import type { CompanyDashboardView } from '~/composables/useDashboardInsight'

const { can } = usePermissions()
const { activeSegments, switchSegment } = useCurrentSegment()
const { buildCompanySummary, loadCompany, generateCompany } = useDashboardInsight()
const { show } = useToast()
const router = useRouter()

const canView = computed(() => can('sales'))

// ---------- サマリー（常時ライブ） ----------
const summary = computed(() => buildCompanySummary())

const salesTrendChart = computed(() => ({
  labels: summary.value.trend.map(t => t.month.slice(2)),
  series: [{ label: '売上(万円)', data: summary.value.trend.map(t => Math.round(t.salesAmount / 10000)) }],
}))
const segmentDonut = computed(() =>
  [...summary.value.snapshots]
    .filter(s => s.salesAmount > 0)
    .sort((a, b) => b.salesAmount - a.salesAmount)
    .map(s => ({ label: s.segmentName, value: s.salesAmount })))

const salesDelta = computed(() =>
  summary.value.prevTotalSales > 0 ? (summary.value.totalSales - summary.value.prevTotalSales) / summary.value.prevTotalSales : null)
const sessionDelta = computed(() =>
  summary.value.prevTotalSessions > 0 ? (summary.value.totalSessions - summary.value.prevTotalSessions) / summary.value.prevTotalSessions : null)

// ---------- セグメント別内訳テーブル ----------
const segCols: TableColumn[] = [
  { key: 'name', label: '業態', primary: true },
  { key: 'salesAmount', label: '売上', align: 'right', primary: true },
  { key: 'orders', label: '受注', align: 'right' },
  { key: 'sessions', label: 'セッション', align: 'right', primary: true },
  { key: 'conversionRate', label: 'CVR', align: 'right', primary: true },
]
const segRows = computed(() =>
  [...summary.value.snapshots]
    .sort((a, b) => b.salesAmount - a.salesAmount)
    .map(s => ({
      id: s.segmentId,
      name: s.segmentName,
      salesAmount: s.salesAmount,
      orders: s.orders,
      sessions: s.mediaConnected ? s.sessions : null,
      conversionRate: s.mediaConnected ? s.conversionRate : null,
      connected: s.mediaConnected,
    })))

function openSegment(segmentId: string): void {
  switchSegment(segmentId)
  void router.push('/akebono/dashboard')
}

// ---------- 保管済み AI レポート・インサイト ----------
const view = ref<CompanyDashboardView | null>(null)
const generating = ref(false)

onMounted(() => { if (canView.value) view.value = loadCompany() })

function regenerate(): void {
  if (generating.value || !canView.value) return
  generating.value = true
  try {
    view.value = generateCompany()
    show('会社全体の AI レポート・インサイトを生成し、保存しました', 'ok')
  } finally { generating.value = false }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader title="会社全体ダッシュボード" :description="`セグメントを超えた全社の統合ビュー・対象月 ${summary.periodMonth}`">
      <template #actions>
        <UiMockBadge />
      </template>
    </UiPageHeader>

    <!-- 売上権限ゲート -->
    <UiEmptyState
      v-if="!canView"
      icon="Lock"
      title="この画面には売上の閲覧権限が必要です"
      hint="会社全体ダッシュボードは全業態の売上ロールアップを含みます。閲覧権限は管理者にご相談ください"
    />

    <div v-else-if="activeSegments.length === 0">
      <UiEmptyState icon="Layers" title="業態が登録されていません" hint="共通マスタ管理から事業セグメント（業態）を登録してください" />
    </div>

    <div v-else class="grid gap-4">
      <!-- ① サマリー（全社 KPI） -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UiKpiCard
          label="全社売上（対象月）" :value="fmtYenCompact(summary.totalSales)"
          :delta="salesDelta" sub="前月比" icon="TrendingUp"
        />
        <UiKpiCard label="受注件数（全社）" :value="fmtInt(summary.totalOrders)" :sub="`${summary.segmentCount} 業態`" icon="Receipt" />
        <UiKpiCard
          label="メディア流入（全社）" :value="fmtInt(summary.totalSessions)"
          :delta="sessionDelta" sub="前月比・連携業態合算" icon="MousePointerClick"
        />
        <UiKpiCard
          label="コンバージョン（全社）" :value="fmtInt(summary.totalConversions)"
          :sub="`メディア接続 ${summary.connectedCount}/${summary.segmentCount} 業態`" icon="Target"
        />
      </div>

      <!-- チャート -->
      <div class="grid gap-3 lg:grid-cols-2">
        <ChartsBarChartCard title="全社売上推移（月次）" :labels="salesTrendChart.labels" :series="salesTrendChart.series" :y-formatter="v => `${fmtInt(v)}万`" />
        <ChartsDonutChartCard title="業態別売上構成（対象月）" :items="segmentDonut" :value-formatter="v => fmtYenCompact(v)" />
      </div>

      <!-- セグメント別内訳（行クリックでその業態のダッシュボードへ。モバイルはカード型） -->
      <UiSectionCard title="業態別サマリー" description="各業態の売上・受注・メディア指標。クリックで業態ダッシュボードへ">
        <UiDataTable :columns="segCols" :rows="segRows" row-key="id" clickable @row-click="openSegment(String($event.id))">
          <template #cell-salesAmount="{ value }">{{ fmtYenCompact(Number(value)) }}</template>
          <template #cell-sessions="{ value }">
            <span v-if="value === null" class="text-muted">未連携</span>
            <span v-else class="num">{{ fmtInt(Number(value)) }}</span>
          </template>
          <template #cell-conversionRate="{ value }">
            <span v-if="value === null" class="text-muted">—</span>
            <span v-else class="num">{{ fmtPct(Number(value)) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>

      <!-- ②③ AI レポート・AI インサイト -->
      <UiSectionCard
        title="全社 AI レポート・インサイト"
        :description="view ? `生成 ${fmtDateTime(view.generatedAt)}${view.generatedByName ? `（${view.generatedByName}）` : ''}・${view.llm ? 'Vertex AI' : '集計値からの自動生成'}` : '全業態のロールアップから、経営レポートと横断インサイト・全社アクションを生成します'"
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
          title="全社レポートはまだ生成されていません"
          hint="「レポートを生成」を押すと、全業態のロールアップから経営レポート・横断インサイト・全社アクションを生成・保存します"
        />
        <div v-else class="grid gap-4">
          <div class="rounded-lg border border-line bg-surface-soft p-3">
            <UiMarkdown :source="view.insight.executiveSummary" />
          </div>

          <div>
            <p class="label mb-1">全社インサイト（好調・課題・機会）</p>
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

          <div>
            <p class="label mb-1">全社アクション</p>
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
    </div>
  </div>
</template>
