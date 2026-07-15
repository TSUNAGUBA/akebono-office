<script setup lang="ts">
/**
 * ダッシュボード（F-01）
 * 挨拶+打刻 / KPI / 売上サマリ / 稼働状況サマリ / カード型メニュー / 通知フィード。
 * モバイル（<768px）は 打刻 → KPI(2列) → メニュー → 通知 の縦積み順（order 制御）。
 */
import { ArrowRight, ChevronRight } from 'lucide-vue-next'
import type { AppNotification, Member, WorkflowRouteStep } from '~/types/domain'
import type { MenuCard } from '~/types/ui'
import { fmtDateLong, fmtDateTime, fmtPct, fmtYenCompact } from '~/utils/format'
import {
  NOTIFICATION_KIND_LABELS, SERVICE_STATE_LABELS, SERVICE_STATE_TONES,
} from '~/utils/labels'

const { currentUser, isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead } = useNotifications()
const { isEnabled } = useAppSettings()
const { tbl } = useMockDb()
const workflowRequests = tbl('workflowRequests')

const {
  currentFiscalYear, fiscalMonthLabels, currentFySeries, previousFySeries,
  currentMonthSales, currentMonthYoY, currentMonthMarginRate, marginYoYDiff, typeBreakdown,
} = useSales()

const { services, stateOf, uptimePctOf, openIncidentsOf } = useSystemStatus()

// ---------- 挨拶 ----------
const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 5) return 'お疲れさまです'
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'こんにちは'
  return 'こんばんは'
})
const todayLong = computed(() => fmtDateLong(new Date().toISOString()))

// ---------- 承認待ち件数（自分が承認者の申請） ----------
function isApproverOf(step: WorkflowRouteStep, m: Member): boolean {
  if (step.approverMemberId) return step.approverMemberId === m.id
  if (step.approverRole === 'president') return m.title === '代表取締役'
  if (step.approverRole === 'director') return m.title === '取締役'
  return m.title === 'マネージャー'
}

const pendingApprovals = computed(() =>
  workflowRequests.value.filter((r) => {
    if (r.status !== 'submitted' && r.status !== 'in_review') return false
    const step = r.routeSnapshot.find(s => s.order === r.currentStep)
    return step ? isApproverOf(step, currentUser.value) : false
  }).length)

// ---------- KPI ----------
const kpiSales = computed(() => fmtYenCompact(currentMonthSales.value))
const kpiMargin = computed(() =>
  currentMonthMarginRate.value === null ? '—' : fmtPct(currentMonthMarginRate.value))

// ---------- 売上チャート ----------
const salesSeries = computed(() => [
  { label: `${currentFiscalYear.value}年度`, data: currentFySeries.value },
  { label: `${currentFiscalYear.value - 1}年度`, data: previousFySeries.value },
])

// ---------- 提供システム稼働状況 ----------
const serviceRows = computed(() => services.value.map((s) => {
  const state = stateOf(s.id)
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    state,
    stateLabel: SERVICE_STATE_LABELS[state] ?? state,
    stateTone: SERVICE_STATE_TONES[state] ?? 'neutral',
    uptime: fmtPct(uptimePctOf(s.id), 2),
    openIncident: openIncidentsOf(s.id)[0]?.title ?? '',
  }
}))

// ---------- カード型メニュー（要件の 6 カテゴリ） ----------
interface MenuSection { id: string; label: string; cards: MenuCard[] }

const menuSections = computed<MenuSection[]>(() => {
  const sections: MenuSection[] = []
  if (isEnabled('decision')) {
    sections.push({
      id: 'decision', label: '意思決定支援',
      cards: [{ id: 'decision', title: '意思決定支援', description: 'AI が意味・関係・制約を整理し、選択肢と根拠を提示', icon: 'Scale', to: '/decision' }],
    })
  }
  if (isEnabled('akebono')) {
    sections.push({
      id: 'akebono', label: 'AKEBONO',
      cards: [{ id: 'akebono', title: 'AKEBONO', description: 'あなた専属の AI アシスタント。要望も受付中', icon: 'Sunrise', to: '/akebono' }],
    })
  }
  const work: MenuCard[] = [
    { id: 'attendance', title: '勤怠管理', description: '打刻・月次集計・36 協定アラート・有給', icon: 'Clock', to: '/attendance' },
  ]
  if (isEnabled('shift')) {
    work.push({ id: 'shift', title: 'シフト表', description: '希望提出・調整・確定シフトの確認', icon: 'CalendarRange', to: '/shift' })
  }
  work.push(
    { id: 'reports', title: '日報・週報', description: '日々の報告とチームの提出状況', icon: 'NotebookPen', to: '/reports' },
    { id: 'workflow', title: 'ワークフロー', description: '稟議の申請・承認（職務権限マトリクス準拠）', icon: 'GitPullRequestArrow', to: '/workflow', badge: pendingApprovals.value },
  )
  sections.push({ id: 'work', label: '業務ツール', cards: work })
  if (isEnabled('aiCompany')) {
    sections.push({
      id: 'ai-company', label: 'AIネイティブカンパニー',
      cards: [{ id: 'ai-company', title: 'AIネイティブカンパニー', description: 'AI 社員の執務室。タスク依頼と活動モニタリング', icon: 'Building2', to: '/ai-company' }],
    })
  }
  sections.push({
    id: 'support', label: '業務支援ツール',
    cards: [{ id: 'support', title: '業務支援ツール', description: 'AI チャットボット・ドキュメント管理・外部ツール', icon: 'Wrench', to: '/support' }],
  })
  if (isAdmin.value) {
    sections.push({
      id: 'masters', label: 'マスタメンテナンス',
      cards: [{ id: 'masters', title: 'マスタメンテナンス', description: 'メンバー・顧客・案件・ナレッジ等の基礎データ管理', icon: 'Database', to: '/masters' }],
    })
  }
  return sections
})

// ---------- 通知フィード ----------
const recentNotifications = computed(() => mine.value.slice(0, 5))

function openNotification(n: AppNotification): void {
  markRead(n.id)
  if (n.link) navigateTo(n.link)
}
</script>

<template>
  <div>
    <UiPageHeader
      :title="`${greeting}、${currentUser.name} さん`"
      :description="todayLong"
    />

    <div class="grid gap-3 lg:grid-cols-12">
      <!-- 打刻（左カラム / モバイル 1 番目） -->
      <div class="order-1 self-start lg:col-span-4 lg:row-span-2 xl:col-span-3">
        <WidgetsPunchClock />
      </div>

      <!-- KPI 行（モバイル 2 番目・2 列） -->
      <div class="order-2 grid grid-cols-2 gap-2 md:grid-cols-4 lg:col-span-8 xl:col-span-9">
        <UiKpiCard
          label="今月売上" :value="kpiSales" :delta="currentMonthYoY" sub="前年同月比"
          icon="TrendingUp" to="/decision"
        />
        <UiKpiCard
          label="粗利率（今月）" :value="kpiMargin" :delta="marginYoYDiff" sub="前年同月差"
          icon="Percent" to="/decision"
        />
        <UiKpiCard
          label="承認待ち" :value="`${pendingApprovals}件`" sub="あなたの承認待ち"
          icon="GitPullRequestArrow" to="/workflow"
        />
        <UiKpiCard
          label="未読通知" :value="`${unreadCount}件`" sub="通知センターへ"
          icon="Bell" to="/inbox"
        />
      </div>

      <!-- 売上サマリ（モバイルでは通知の後ろ） -->
      <section class="order-5 grid gap-2 lg:order-3 lg:col-span-8 xl:col-span-9" aria-label="売上サマリ">
        <div class="grid gap-3 lg:grid-cols-5">
          <ChartsLineChartCard
            class="lg:col-span-3"
            :title="`月次売上（${currentFiscalYear}年度 vs ${currentFiscalYear - 1}年度）`"
            :labels="fiscalMonthLabels"
            :series="salesSeries"
            :y-formatter="fmtYenCompact"
          />
          <ChartsDonutChartCard
            class="lg:col-span-2"
            title="事業種別内訳（今年度）"
            :items="typeBreakdown"
            :value-formatter="fmtYenCompact"
          />
        </div>
        <div class="flex justify-end">
          <NuxtLink to="/decision" class="btn btn-sm">
            意思決定支援で深掘る <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
          </NuxtLink>
        </div>
      </section>

      <!-- 提供システム稼働状況 -->
      <UiSectionCard
        v-if="isEnabled('status')"
        class="order-6 lg:order-4 lg:col-span-12"
        title="提供システム稼働状況"
        description="現在状態のサマリ。クリックで詳細へ"
        flush
      >
        <template #actions>
          <NuxtLink to="/status" class="link text-xs font-semibold">稼働状況ページへ</NuxtLink>
        </template>
        <ul class="divide-y divide-[var(--c-line)]">
          <li v-for="s in serviceRows" :key="s.id">
            <NuxtLink
              :to="`/status/${s.id}`"
              class="flex min-h-11 items-center gap-3 px-3 py-2 transition-colors hover:bg-brand-soft"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-semibold">{{ s.name }}</span>
                <span class="block truncate text-[11px] text-muted">
                  {{ s.openIncident || s.description }}
                </span>
              </span>
              <span class="num hidden text-[11px] text-muted sm:block">90日 {{ s.uptime }}</span>
              <UiStatusBadge :label="s.stateLabel" :tone="s.stateTone" dot />
              <ChevronRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            </NuxtLink>
          </li>
        </ul>
      </UiSectionCard>

      <!-- カード型メニュー（モバイル 3 番目） -->
      <section class="order-3 grid gap-3 lg:order-5 lg:col-span-12" aria-label="メニュー">
        <div v-for="sec in menuSections" :key="sec.id">
          <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
          <UiCardMenu :items="sec.cards" />
        </div>
      </section>

      <!-- 通知フィード（モバイル 4 番目） -->
      <UiSectionCard
        class="order-4 lg:order-6 lg:col-span-12"
        title="通知"
        description="直近 5 件。クリックで既読にしてリンク先へ"
        flush
      >
        <template #actions>
          <NuxtLink to="/inbox" class="link text-xs font-semibold">すべて見る</NuxtLink>
        </template>
        <UiEmptyState v-if="recentNotifications.length === 0" icon="BellOff" title="通知はありません" />
        <ul v-else class="divide-y divide-[var(--c-line)]">
          <li v-for="n in recentNotifications" :key="n.id">
            <button
              type="button"
              class="flex w-full min-h-11 items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-brand-soft"
              :class="n.read ? '' : 'bg-brand-soft/50'"
              @click="openNotification(n)"
            >
              <span
                class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                :class="n.read ? 'bg-transparent' : 'bg-brand'"
                :aria-label="n.read ? undefined : '未読'"
              />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-1.5">
                  <UiStatusBadge :label="NOTIFICATION_KIND_LABELS[n.kind]" tone="neutral" />
                  <span class="truncate text-[13px]" :class="n.read ? 'text-sub' : 'font-bold'">{{ n.title }}</span>
                </span>
                <span class="mt-0.5 block truncate text-xs text-muted">{{ n.body }}</span>
              </span>
              <span class="num shrink-0 pt-0.5 text-[11px] text-muted">{{ fmtDateTime(n.at) }}</span>
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>
  </div>
</template>
