<script setup lang="ts">
/**
 * メディア分析（F-40-2）。現在のメディアチャンネルについて、GA 由来の指標を可視化し、
 * AI がサイト構成・記事のインサイトと次アクションを提示する。
 * 業務 × メディアの統合 PDCA タブは **連携済みチャンネル（業態連携あり）でのみ**利用できる
 * （未連携チャンネルは「連携すると使える」案内を表示）。
 *
 * 指標・チャート: モック = 常時ライブの決定的導出（前日基準）/ API = GA4 実データの遅延ロード。
 * AI インサイトは「生成 → 保管 → 再生成で上書き」（週次インサイトと同思想。media インサイトは外部投稿記事も材料）。
 */
import { RefreshCw, Sparkles, Target, TriangleAlert } from 'lucide-vue-next'
import { fmtDate, fmtDateTime, fmtInt, fmtPct, fmtYenCompact } from '~/utils/format'
import { FINDING_KIND_LABELS, PRIORITY_LABELS, findingTone, priorityTone } from '~/utils/media'
import type { TabItem, TableColumn } from '~/types/ui'
import type { MediaInsightView, IntegratedInsightView } from '~/composables/useMediaInsight'

const route = useRoute()
const router = useRouter()
const { effectiveChannelId, currentChannel } = useCurrentChannel()
const { settingFor } = useMediaChannels()
const {
  metricsFor, integratedMetricsFor, metricsReady, metricsWarningFor, metricsUnavailableFor, refreshMetrics,
  integratedReady, integratedFailed, refreshMonthly,
} = useMediaAnalytics()
const { loadMedia, generateMedia, loadIntegrated, generateIntegrated } = useMediaInsight()
const { show } = useToast()
const isApi = useApiMode()

const TABS: TabItem[] = [
  { key: 'media', label: 'メディア分析' },
  { key: 'pdca', label: '業務 × メディア PDCA' },
]
const activeTab = ref(route.query.tab === 'pdca' ? 'pdca' : 'media')
watch(activeTab, (t) => { void router.replace({ query: { ...route.query, tab: t === 'media' ? undefined : t } }) })

const setting = computed(() => settingFor(effectiveChannelId.value))
const connected = computed(() => setting.value?.gaConnected === true)
/** 連携済みチャンネルか（統合 PDCA の利用可否） */
const linked = computed(() => currentChannel.value?.segmentId != null)
const metrics = computed(() => (connected.value ? metricsFor(effectiveChannelId.value, 28) : null))
const integrated = computed(() => (connected.value && linked.value ? integratedMetricsFor(effectiveChannelId.value, 6) : null))

// API モードのロード状態（モックは常にロード済み）。null かつロード完了 = 取得失敗（再試行導線を出す）
const metricsLoading = computed(() => isApi && connected.value && !metricsReady(effectiveChannelId.value, 28))
const metricsFailed = computed(() =>
  isApi && connected.value && metricsReady(effectiveChannelId.value, 28) && metrics.value === null)
const metricsWarning = computed(() => (metrics.value ? metricsWarningFor(effectiveChannelId.value, 28) : null))
// PDCA タブ（GA 月次）: ロード中と取得失敗を区別する（失敗を 0 表示にしない = M1）
const integratedIsFailed = computed(() => linked.value && integratedFailed(effectiveChannelId.value, 6))
const integratedLoading = computed(() =>
  isApi && connected.value && linked.value && !integratedReady(effectiveChannelId.value, 6) && !integratedIsFailed.value)

async function retryMonthly(): Promise<void> {
  await refreshMonthly(effectiveChannelId.value, 6)
}
/**
 * 空状態の判定: モック = 記事インベントリが空 / API = GA 実データが空（インベントリ非依存）
 */
const metricsEmpty = computed(() => {
  const m = metrics.value
  if (!m) return false
  return isApi
    ? m.sessions === 0 && m.pageviews === 0 && m.topPages.length === 0
    : m.articleCount === 0
})

async function retryMetrics(): Promise<void> {
  await refreshMetrics(effectiveChannelId.value, 28)
}

const unavailableSet = computed(() => new Set(metricsUnavailableFor(effectiveChannelId.value, 28)))
function na(key: string): boolean {
  return unavailableSet.value.has(key)
}

// ---------- 保管済みインサイト（生成 → 保管 → 再生成で上書き） ----------
const mediaView = ref<MediaInsightView | null>(null)
const integratedView = ref<IntegratedInsightView | null>(null)
const genMedia = ref(false)
const genIntegrated = ref(false)

async function reloadInsights(): Promise<void> {
  mediaView.value = await loadMedia(effectiveChannelId.value)
  integratedView.value = linked.value ? await loadIntegrated(effectiveChannelId.value) : null
}
watch(effectiveChannelId, () => { void reloadInsights() }, { immediate: true })

async function regenerateMedia(): Promise<void> {
  if (genMedia.value || !connected.value) return
  genMedia.value = true
  try {
    mediaView.value = await generateMedia(effectiveChannelId.value)
    if (mediaView.value?.warning) show(`メディアインサイトを生成しました（${mediaView.value.warning}）`, 'warn')
    else show('メディアインサイトを生成し、保存しました', 'ok')
  } catch (e) {
    const er = apiErrorOf(e)
    show(`${er.code}: ${er.message}`, 'crit')
  } finally { genMedia.value = false }
}
async function regenerateIntegrated(): Promise<void> {
  if (genIntegrated.value || !connected.value || !linked.value) return
  genIntegrated.value = true
  try {
    integratedView.value = await generateIntegrated(effectiveChannelId.value)
    if (integratedView.value?.warning) show(`統合インサイトを生成しました（${integratedView.value.warning}）`, 'warn')
    else show('業務 × メディアの統合インサイトを生成し、保存しました', 'ok')
  } catch (e) {
    const er = apiErrorOf(e)
    show(`${er.code}: ${er.message}`, 'crit')
  } finally { genIntegrated.value = false }
}

// ---------- チャートデータ（メディアタブ） ----------
const dailyChart = computed(() => {
  const m = metrics.value
  if (!m) return { labels: [] as string[], series: [] as { label: string; data: number[] }[] }
  return {
    labels: m.daily.map(d => d.date.slice(5)),
    series: [
      { label: 'セッション', data: m.daily.map(d => d.sessions) },
      { label: 'ユーザー', data: m.daily.map(d => d.users) },
    ],
  }
})
const channelItems = computed(() => (metrics.value?.channels ?? []).map(c => ({ label: c.channel, value: c.sessions })))
const deviceItems = computed(() => (metrics.value?.devices ?? []).map(d => ({ label: d.device, value: d.sessions })))
const topPagesBar = computed(() => {
  const pages = (metrics.value?.topPages ?? []).slice(0, 8)
  return { labels: pages.map(p => p.title), series: [{ label: 'PV', data: pages.map(p => p.pageviews) }] }
})

const sectionCols: TableColumn[] = [
  { key: 'section', label: 'セクション', primary: true },
  { key: 'pages', label: '記事数', align: 'right' },
  { key: 'pageviews', label: 'PV', align: 'right', primary: true },
  { key: 'avgEngagementSec', label: '平均滞在(s)', align: 'right' },
  { key: 'convRate', label: 'CVR', align: 'right', primary: true },
]
const sectionRows = computed(() => (metrics.value?.sections ?? []).map(s => ({
  section: s.section, pages: s.pages, pageviews: s.pageviews,
  avgEngagementSec: s.avgEngagementSec, convRate: s.convRate,
})))

const pageCols: TableColumn[] = [
  { key: 'title', label: '記事', primary: true },
  { key: 'section', label: 'セクション' },
  { key: 'pageviews', label: 'PV', align: 'right', primary: true },
  { key: 'avgEngagementSec', label: '滞在(s)', align: 'right' },
  { key: 'bounceRate', label: '直帰率', align: 'right' },
  { key: 'convRate', label: 'CVR', align: 'right', primary: true },
  { key: 'trend', label: '前期比', align: 'right' },
]
const pageRows = computed(() => (metrics.value?.topPages ?? []).map(p => ({
  title: p.title, section: p.section, pageviews: p.pageviews,
  avgEngagementSec: p.avgEngagementSec, bounceRate: p.bounceRate, convRate: p.convRate,
  trend: p.prevPageviews > 0 ? (p.pageviews - p.prevPageviews) / p.prevPageviews : null,
})))

// ---------- PDCA タブ ----------
const trendChart = computed(() => {
  const m = integrated.value
  if (!m) return { labels: [] as string[], series: [] as { label: string; data: number[] }[] }
  return {
    labels: m.trend.map(t => t.month.slice(2)),
    series: [
      { label: 'セッション', data: m.trend.map(t => t.sessions) },
      { label: 'コンバージョン', data: m.trend.map(t => t.conversions) },
    ],
  }
})
const salesTrendChart = computed(() => {
  const m = integrated.value
  if (!m) return { labels: [] as string[], series: [] as { label: string; data: number[] }[] }
  return {
    labels: m.trend.map(t => t.month.slice(2)),
    series: [{ label: '売上(万円)', data: m.trend.map(t => Math.round(t.salesAmount / 10000)) }],
  }
})
const funnelStages = computed(() => {
  const f = integrated.value?.funnel
  if (!f) return []
  return [
    { label: 'セッション', value: f.sessions },
    { label: '主体的関与', value: f.engaged },
    { label: 'コンバージョン', value: f.conversions },
    { label: '受注', value: f.orders },
  ]
})

const PDCA_QUADRANTS = [
  { key: 'check', label: 'Check（現状分析）', cls: 'border-info/40 bg-info-soft' },
  { key: 'act', label: 'Act（改善アクション）', cls: 'border-ok/40 bg-ok-soft' },
  { key: 'plan', label: 'Plan（次サイクルの計画）', cls: 'border-brand/40 bg-brand-soft' },
  { key: 'do', label: 'Do（実行・実験）', cls: 'border-warn/40 bg-warn-soft' },
] as const
const SEVERITY_META: Record<string, { label: string; tone: 'crit' | 'warn' | 'info' }> = {
  high: { label: '高', tone: 'crit' }, mid: { label: '中', tone: 'warn' }, low: { label: '低', tone: 'info' },
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <!-- メディア分析は API 接続済み（GA 実データ）のためモックバッジは付けない -->
    <UiPageHeader title="メディア分析" :description="setting ? setting.siteName || setting.name : ''" />

    <div class="grid gap-4">
      <MediaChannelBar />
      <UiTabBar v-model="activeTab" :tabs="TABS" />

      <!-- 未連携ゲート -->
      <template v-if="!connected">
        <MediaGaConnect variant="gate" />
        <p class="text-center text-[11px] text-muted">
          「{{ currentChannel?.name }}」を分析するには Google Analytics の連携が必要です。
        </p>
      </template>

      <!-- 28 日メトリクス系のゲート（ロード中・失敗・空）は**メディア分析タブ限定** -->
      <template v-else-if="activeTab === 'media' && metricsLoading">
        <p class="py-10 text-center text-[13px] text-muted" aria-live="polite" aria-busy="true">
          Google Analytics から集計を取得中…
        </p>
      </template>

      <template v-else-if="activeTab === 'media' && metricsFailed">
        <UiEmptyState
          icon="TriangleAlert"
          title="Google Analytics から集計を取得できませんでした"
          :hint="metricsWarningFor(effectiveChannelId, 28) ?? '時間をおいて再試行してください'"
        >
          <template #action>
            <button type="button" class="btn btn-primary btn-sm" @click="retryMetrics">再試行</button>
          </template>
        </UiEmptyState>
      </template>

      <template v-else-if="activeTab === 'media' && metricsEmpty">
        <UiEmptyState
          icon="FileText"
          :title="isApi ? 'Google Analytics にまだ計測データがありません' : 'このメディアにはまだ記事データがありません'"
          :hint="isApi
            ? '連携した GA4 プロパティに計測データが届くと、アクセス指標と AI インサイトが表示されます'
            : '記事生成スタジオで記事を生成・採用すると、アクセス指標と AI インサイトが表示されます'"
        >
          <template #action>
            <NuxtLink to="/media/articles" class="btn btn-primary btn-sm">記事生成スタジオへ</NuxtLink>
          </template>
        </UiEmptyState>
      </template>

      <!-- ============ メディア分析タブ ============ -->
      <template v-else-if="activeTab === 'media' && metrics">
        <p
          v-if="metricsWarning"
          class="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-1.5 text-[12px] text-sub"
        >
          <TriangleAlert class="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
          {{ metricsWarning }}
          <button type="button" class="link ml-auto text-[11px]" @click="retryMetrics">再試行</button>
        </p>

        <!-- KPI -->
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <UiKpiCard
            label="セッション" :value="fmtInt(metrics.sessions)"
            :delta="metrics.prevSessions > 0 ? (metrics.sessions - metrics.prevSessions) / metrics.prevSessions : null"
            sub="前期比" icon="MousePointerClick"
          />
          <UiKpiCard
            label="ユーザー" :value="fmtInt(metrics.users)"
            :delta="metrics.prevUsers > 0 ? (metrics.users - metrics.prevUsers) / metrics.prevUsers : null"
            :sub="`新規 ${fmtInt(metrics.newUsers)}`" icon="Users"
          />
          <UiKpiCard label="ページビュー" :value="fmtInt(metrics.pageviews)" :sub="`記事 ${metrics.articleCount} 本`" icon="FileText" />
          <UiKpiCard
            label="コンバージョン" :value="fmtInt(metrics.conversions)"
            :delta="metrics.prevConversions > 0 ? (metrics.conversions - metrics.prevConversions) / metrics.prevConversions : null"
            sub="前期比" icon="Target"
          />
          <UiKpiCard label="CVR" :value="fmtPct(metrics.conversionRate)" sub="コンバージョン率" icon="Percent" />
          <UiKpiCard label="平均エンゲージ時間" :value="`${metrics.avgEngagementSec}s`" sub="1 ページあたり" icon="Clock" />
          <UiKpiCard label="直帰率" :value="fmtPct(metrics.bounceRate)" :delta="null" :inverse="true" sub="低いほど良い" icon="LogOut" />
          <UiKpiCard label="エンゲージ率" :value="fmtPct(metrics.engagementRate)" sub="関与セッション率" icon="Activity" />
        </div>

        <p class="text-[11px] text-muted">
          集計期間 {{ fmtDate(metrics.periodFrom) }}〜{{ fmtDate(metrics.periodTo) }}（前日基準・{{ metrics.days }} 日間）。前期比は直前の同日数期間との比較です。
        </p>

        <ChartsLineChartCard v-if="!na('daily')" title="日別セッション・ユーザー" :labels="dailyChart.labels" :series="dailyChart.series" />
        <UiSectionCard v-else title="日別セッション・ユーザー">
          <p class="py-6 text-center text-[12px] text-muted">この内訳は取得できませんでした（上部の警告参照。再試行で回復します）</p>
        </UiSectionCard>
        <div class="grid gap-3 lg:grid-cols-2">
          <ChartsDonutChartCard v-if="!na('channels')" title="チャネル別セッション" :items="channelItems" :value-formatter="v => fmtInt(v)" />
          <UiSectionCard v-else title="チャネル別セッション">
            <p class="py-6 text-center text-[12px] text-muted">この内訳は取得できませんでした（再試行で回復します）</p>
          </UiSectionCard>
          <ChartsDonutChartCard v-if="!na('devices')" title="デバイス別セッション" :items="deviceItems" :value-formatter="v => fmtInt(v)" />
          <UiSectionCard v-else title="デバイス別セッション">
            <p class="py-6 text-center text-[12px] text-muted">この内訳は取得できませんでした（再試行で回復します）</p>
          </UiSectionCard>
        </div>
        <ChartsBarChartCard v-if="!na('topPages')" title="記事別 PV（上位）" :labels="topPagesBar.labels" :series="topPagesBar.series" horizontal :height="300" :y-formatter="v => fmtInt(v)" />

        <UiSectionCard v-if="!na('topPages')" title="サイト構成（セクション別）" description="第 1 階層のセクションごとの PV・滞在・CVR">
          <UiDataTable :columns="sectionCols" :rows="sectionRows" row-key="section">
            <template #cell-convRate="{ value }">{{ fmtPct(Number(value)) }}</template>
          </UiDataTable>
        </UiSectionCard>
        <UiSectionCard v-else title="記事別・セクション別の内訳">
          <p class="py-6 text-center text-[12px] text-muted">この内訳は取得できませんでした（上部の警告参照。再試行で回復します）</p>
        </UiSectionCard>

        <!-- AI インサイト（生成/再生成。media インサイトは外部投稿記事も材料に取り込む） -->
        <UiSectionCard title="AI インサイト" :description="mediaView ? `生成 ${fmtDateTime(mediaView.generatedAt)}${mediaView.generatedByName ? `（${mediaView.generatedByName}）` : ''}・${mediaView.llm ? 'Vertex AI' : '集計値からの自動生成'}${mediaView.warning ? `・${mediaView.warning}` : ''}` : 'GA 集計と外部投稿記事からサイト構成・記事のインサイトと次アクションを生成します'">
          <template #actions>
            <button type="button" class="btn btn-primary btn-sm" :disabled="genMedia" @click="regenerateMedia">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              {{ genMedia ? '生成中…' : mediaView ? '再生成' : 'インサイトを生成' }}
            </button>
          </template>

          <UiEmptyState
            v-if="!mediaView"
            icon="Sparkles"
            title="この期間のインサイトはまだ生成されていません"
            hint="「インサイトを生成」を押すと、現在の集計と外部投稿記事からサイト構成・記事のインサイトと次アクションを生成・保存します"
          />
          <div v-else class="grid gap-4">
            <UiMarkdown :source="mediaView.insight.executiveSummary" />

            <div class="grid gap-3 lg:grid-cols-2">
              <div>
                <p class="label mb-1">サイト構成へのインサイト</p>
                <ul class="grid gap-2">
                  <li v-for="(f, i) in mediaView.insight.siteStructure" :key="i" class="rounded-lg border border-line p-2.5">
                    <span class="flex flex-wrap items-center gap-2">
                      <UiStatusBadge :label="FINDING_KIND_LABELS[f.kind]" :tone="findingTone(f.kind)" />
                      <span class="text-[13px] font-bold">{{ f.title }}</span>
                    </span>
                    <p class="mt-1 text-[12px] text-sub">{{ f.detail }}</p>
                  </li>
                </ul>
              </div>
              <div>
                <p class="label mb-1">記事へのインサイト</p>
                <ul class="grid gap-2">
                  <li v-for="(f, i) in mediaView.insight.articles" :key="i" class="rounded-lg border border-line p-2.5">
                    <span class="flex flex-wrap items-center gap-2">
                      <UiStatusBadge :label="FINDING_KIND_LABELS[f.kind]" :tone="findingTone(f.kind)" />
                      <span class="text-[13px] font-bold">{{ f.title }}</span>
                    </span>
                    <p class="mt-1 text-[12px] text-sub">{{ f.detail }}</p>
                  </li>
                </ul>
              </div>
            </div>

            <div>
              <p class="label mb-1">次に起こすべきアクション</p>
              <ul class="grid gap-2">
                <li v-for="(a, i) in mediaView.insight.actions" :key="i" class="flex items-start gap-2 rounded-lg border border-line p-2.5">
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
              <div class="mt-2 flex justify-end">
                <NuxtLink to="/media/articles" class="btn btn-sm">
                  <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> この分析から記事を生成
                </NuxtLink>
              </div>
            </div>
          </div>
        </UiSectionCard>

        <UiSectionCard v-if="!na('topPages')" title="記事別パフォーマンス" :description="na('prevPages') ? 'PV 上位の記事の滞在・直帰率・CVR（前期比は取得できませんでした）' : 'PV 上位の記事の滞在・直帰率・CVR・前期比'">
          <UiDataTable :columns="pageCols" :rows="pageRows" row-key="title">
            <template #cell-bounceRate="{ value }">{{ fmtPct(Number(value)) }}</template>
            <template #cell-convRate="{ value }">{{ fmtPct(Number(value)) }}</template>
            <template #cell-trend="{ value }">
              <span v-if="value === null" class="text-muted">—</span>
              <span v-else class="num" :class="Number(value) >= 0 ? 'text-ok' : 'text-crit'">
                {{ Number(value) >= 0 ? '+' : '' }}{{ fmtPct(Number(value)) }}
              </span>
            </template>
          </UiDataTable>
        </UiSectionCard>
      </template>

      <!-- ============ 業務 × メディア PDCA タブ ============ -->
      <!-- 未連携チャンネル: 「連携すると使える」案内（統合 PDCA は業態連携が前提） -->
      <template v-else-if="activeTab === 'pdca' && !linked">
        <UiEmptyState
          icon="Link2"
          title="業務 × メディア PDCA は業態と連携すると利用できます"
          hint="このチャンネルはまだ Akebono 業務アプリ（業態）と連携していません。連携すると、売上と流入を突き合わせた統合分析・PDCA・AI インサイトが使えます"
        >
          <template #action>
            <NuxtLink to="/media/settings" class="btn btn-primary btn-sm">連携する（チャンネル設定）</NuxtLink>
          </template>
        </UiEmptyState>
      </template>
      <!-- API: GA 月次のロード中は 0 埋めの統合値を出さない（誤読防止） -->
      <template v-else-if="activeTab === 'pdca' && integratedLoading">
        <p class="py-10 text-center text-[13px] text-muted" aria-live="polite" aria-busy="true">
          Google Analytics から月次トレンドを取得中…
        </p>
      </template>
      <!-- API: GA 月次の取得失敗は「流入 0」として表示せず、失敗の事実 + 再試行導線を出す（M1・原則4） -->
      <template v-else-if="activeTab === 'pdca' && integratedIsFailed">
        <UiEmptyState
          icon="TriangleAlert"
          title="Google Analytics から月次トレンドを取得できませんでした"
          hint="取得できるまで統合指標・インサイト生成は利用できません。時間をおいて再試行してください"
        >
          <template #action>
            <button type="button" class="btn btn-primary btn-sm" @click="retryMonthly">再試行</button>
          </template>
        </UiEmptyState>
      </template>
      <template v-else-if="activeTab === 'pdca' && integrated">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <UiKpiCard
            label="セッション（対象月）" :value="fmtInt(integrated.sessions)"
            :delta="integrated.prevSessions > 0 ? (integrated.sessions - integrated.prevSessions) / integrated.prevSessions : null"
            sub="前月比" icon="MousePointerClick"
          />
          <UiKpiCard label="コンバージョン" :value="fmtInt(integrated.conversions)" :sub="`CVR ${fmtPct(integrated.conversionRate)}`" icon="Target" />
          <UiKpiCard
            label="売上（対象月）" :value="`${fmtYenCompact(integrated.salesAmount)}`"
            :delta="integrated.prevSalesAmount > 0 ? (integrated.salesAmount - integrated.prevSalesAmount) / integrated.prevSalesAmount : null"
            sub="前月比" icon="TrendingUp"
          />
          <UiKpiCard label="平均受注額" :value="integrated.aov > 0 ? fmtYenCompact(integrated.aov) : '—'" :sub="`受注 ${integrated.orders} 件`" icon="Receipt" />
        </div>
        <p class="text-[11px] text-muted">
          対象月 {{ integrated.periodMonth }}。セッションあたり売上 {{ fmtYenCompact(integrated.salesPerSession) }}。メディア流入（GA）と連携業態の売上明細を突き合わせています。
        </p>

        <div class="grid gap-3 lg:grid-cols-2">
          <ChartsLineChartCard title="流入・コンバージョン（月次）" :labels="trendChart.labels" :series="trendChart.series" />
          <ChartsBarChartCard title="売上推移（月次）" :labels="salesTrendChart.labels" :series="salesTrendChart.series" :y-formatter="v => `${fmtInt(v)}万`" />
        </div>

        <UiSectionCard title="ファネル（当月）" description="流入から受注までの各段階と遷移率">
          <MediaFunnel :stages="funnelStages" />
        </UiSectionCard>

        <UiSectionCard title="AI 統合インサイト（業務 × メディア）" :description="integratedView ? `生成 ${fmtDateTime(integratedView.generatedAt)}${integratedView.generatedByName ? `（${integratedView.generatedByName}）` : ''}・${integratedView.llm ? 'Vertex AI' : '集計値からの自動生成'}${integratedView.warning ? `・${integratedView.warning}` : ''}` : '売上と流入を突き合わせ、相関・PDCA・アクションを生成します'">
          <template #actions>
            <button type="button" class="btn btn-primary btn-sm" :disabled="genIntegrated" @click="regenerateIntegrated">
              <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
              {{ genIntegrated ? '生成中…' : integratedView ? '再生成' : '統合インサイトを生成' }}
            </button>
          </template>

          <UiEmptyState
            v-if="!integratedView"
            icon="RefreshCw"
            title="統合インサイトはまだ生成されていません"
            hint="「統合インサイトを生成」を押すと、売上と流入の相関・PDCA・次アクションを生成・保存します"
          />
          <div v-else class="grid gap-4">
            <UiMarkdown :source="integratedView.insight.executiveSummary" />

            <div>
              <p class="label mb-1">メディア → 業務の関連</p>
              <ul class="grid list-disc gap-1 pl-4 text-[13px]">
                <li v-for="(c, i) in integratedView.insight.correlation" :key="i">{{ c }}</li>
              </ul>
            </div>

            <div>
              <p class="label mb-1">PDCA</p>
              <div class="grid gap-2 sm:grid-cols-2">
                <div v-for="q in PDCA_QUADRANTS" :key="q.key" class="rounded-lg border p-3" :class="q.cls">
                  <p class="mb-1 text-[11px] font-bold">{{ q.label }}</p>
                  <ul class="grid list-disc gap-0.5 pl-4 text-[12px]">
                    <li v-for="(item, i) in integratedView.insight.pdca[q.key]" :key="i">{{ item }}</li>
                  </ul>
                </div>
              </div>
            </div>

            <div class="grid gap-3 lg:grid-cols-2">
              <div>
                <p class="label mb-1">推奨アクション</p>
                <ul class="grid gap-2">
                  <li v-for="(a, i) in integratedView.insight.actions" :key="i" class="flex items-start gap-2 rounded-lg border border-line p-2.5">
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
              <div>
                <p class="label mb-1">リスク</p>
                <p v-if="integratedView.insight.risks.length === 0" class="text-[12px] text-muted">検知されたリスクはありません</p>
                <ul v-else class="grid gap-2">
                  <li v-for="(r, i) in integratedView.insight.risks" :key="i" class="flex items-start gap-2 rounded-lg border border-line p-2.5">
                    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" :class="`text-${SEVERITY_META[r.severity]?.tone ?? 'warn'}`" aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="flex flex-wrap items-center gap-2">
                        <span class="text-[13px] font-bold">{{ r.title }}</span>
                        <UiStatusBadge :label="`重要度 ${SEVERITY_META[r.severity]?.label ?? '中'}`" :tone="SEVERITY_META[r.severity]?.tone ?? 'warn'" />
                      </span>
                      <span class="mt-0.5 block text-[12px] text-sub">対応: {{ r.mitigation }}</span>
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </UiSectionCard>
      </template>
    </div>
  </div>
</template>
