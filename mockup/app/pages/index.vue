<script setup lang="ts">
/**
 * ダッシュボード = コックピット（F-01 改訂「夜明けの管制塔」。2026-07-29 オペレーター承認）
 * 設計 SoT: .ai-native/outputs/phase5/cockpit-design.md
 * 構成（§3）: ① CockpitStrip（挨拶・フェーズ・完了メーター・予報 1 行）→ ② CockpitMoves（次の一手）
 * → ③ CockpitInstruments（役割と文脈の計器）→ ④ CockpitForecast（滑走路ボード。既定閉・①から開閉）
 * → ⑤ AKEBONO 業務 → ⑥ すべての機能（カード型メニュー = 格下げ配置。ロジックは従来どおり）
 * → ⑦ 通知フィード（従来どおり）
 * - 打刻はヘッダーの「タイムカード」ボタン → モーダル（layouts/default.vue）+ ②の punch 埋込
 * - 開いた時に AI 生成・重い再取得を発生させない（週次インサイト・予報は保存値・既存キャッシュのみ）
 */
import type { AppNotification } from '~/types/domain'
import type { MenuCard, TabItem } from '~/types/ui'
import { fmtDateTime } from '~/utils/format'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'
import { MENU_CARDS } from '~/utils/menu-registry'

const { currentUserId, isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead } = useNotifications()
const { isEnabled } = useAppSettings()
const { pendingFor } = useWorkflow()

const { canPath, can } = usePermissions()
const canCompanyDashboard = computed(() => can('sales'))

// ---------- コックピット（①〜④ の材料。useCockpit が権限ゲート・フォールバックを解決） ----------
const cockpit = useCockpit()

/** 滑走路ボード（④）の開閉。既定は閉・①の予報 1 行でトグル */
const forecastOpen = ref(false)
function toggleForecast(): void {
  forecastOpen.value = !forecastOpen.value
  if (forecastOpen.value && import.meta.client) {
    void nextTick(() => {
      document.getElementById('cockpit-forecast')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }
}

/** ①の予報 1 行（予報あり = サマリー / goals 未設定は admin にのみ設定導線として表示） */
const stripForecast = computed(() => {
  if (cockpit.forecasts.value.length > 0) {
    const s = cockpit.forecastSummary.value
    return { headline: s.headline, tone: s.tone, badge: s.tone === 'warn' ? '注意' : '順調', available: true }
  }
  if (cockpit.goalsEmpty.value && isAdmin.value) {
    return { headline: '着地予報: 目標が未設定です', tone: 'warn' as const, badge: '未設定', available: true }
  }
  return { headline: '', tone: 'ok' as const, badge: '', available: false }
})

// ---------- AKEBONO 業務（業態別アプリ。2026-07-28 のセクションを維持） ----------
// 機能トグル + 権限を満たし、かつ業態が 1 件以上あるときのみ専用セクションを表示する
// （業態未登録時はセクションごと出さない = ダッシュボードに空状態を出さない）。
const { activeSegments } = useCurrentSegment()
const showAkebono = computed(() =>
  isEnabled('akebono') && canPath('/akebono') && activeSegments.value.length > 0)

// ---------- 承認待ち件数（useWorkflow.pendingFor が SoT。代理承認・個人指定も考慮済み） ----------
const pendingApprovals = computed(() => pendingFor(currentUserId.value).length)

// ---------- カード型メニュー（定義 = utils/menu-registry.ts・カテゴリ = useMenuCategories。バッチ7h） ----------
const { categorize } = useMenuCategories('dashboard')

/** カードのランタイムバッジ（レジストリは静的定義のみ） */
function badgeOf(id: string): number | undefined {
  if (id === 'workflow') return pendingApprovals.value
  if (id === 'inbox') return unreadCount.value
  return undefined
}

// 機能トグル・管理者限定・権限（F-16）でフィルタした表示カード
const visibleCards = computed<MenuCard[]>(() =>
  MENU_CARDS.dashboard
    .filter(d =>
      (!d.featureToggle || isEnabled(d.featureToggle))
      && (!d.adminOnly || isAdmin.value)
      && canPath(d.to))
    .map(d => ({ id: d.id, title: d.title, description: d.description, icon: d.icon, to: d.to, badge: badgeOf(d.id) })))

const menuSections = computed(() => categorize(visibleCards.value))

// カテゴリチップ（選択はページごとに sessionStorage 記憶 = 軽い状態。アカウント設定ではない）
const selectedCategory = ref('all')
onMounted(() => {
  const saved = sessionStorage.getItem('menu-cat-dashboard')
  if (saved) selectedCategory.value = saved
})
watch(selectedCategory, v => sessionStorage.setItem('menu-cat-dashboard', v))
// 選択中カテゴリが消えた（削除・空になった）場合は「すべて」へ
watchEffect(() => {
  if (selectedCategory.value !== 'all' && !menuSections.value.some(s => s.id === selectedCategory.value)) {
    selectedCategory.value = 'all'
  }
})
const categoryChips = computed(() => [
  { value: 'all', label: 'すべて' },
  ...menuSections.value.map(s => ({ value: s.id, label: s.label })),
])
const shownSections = computed(() =>
  selectedCategory.value === 'all'
    ? menuSections.value
    : menuSections.value.filter(s => s.id === selectedCategory.value))

// ---------- 通知フィード（エスカレーション / 承認依頼 / 稟議 のタブ分け = オペレーター指示 2026-07-22） ----------

type NotificationCategory = 'escalation' | 'approval' | 'workflow' | 'other'

/**
 * 通知のカテゴリ判定。稟議 = リンク先が /workflow の通知（承認依頼・決裁・却下・差戻し）、
 * 承認依頼 = それ以外の approval 通知（打刻修正・休暇など）、エスカレーション = kind そのまま
 */
function categoryOf(n: AppNotification): NotificationCategory {
  if (n.kind === 'escalation') return 'escalation'
  const bare = (n.link || '').split('?')[0] ?? ''
  if (bare === '/workflow' || bare.startsWith('/workflow/')) return 'workflow'
  if (n.kind === 'approval') return 'approval'
  return 'other'
}

const notifTab = ref('all')
const notifTabs = computed<TabItem[]>(() => {
  const unreadOf = (c: NotificationCategory): number =>
    mine.value.filter(n => !n.read && categoryOf(n) === c).length
  return [
    { key: 'all', label: 'すべて', badge: unreadCount.value },
    { key: 'escalation', label: 'エスカレーション', badge: unreadOf('escalation') },
    { key: 'approval', label: '承認依頼', badge: unreadOf('approval') },
    { key: 'workflow', label: '稟議', badge: unreadOf('workflow') },
  ]
})

const recentNotifications = computed(() =>
  (notifTab.value === 'all'
    ? mine.value
    : mine.value.filter(n => categoryOf(n) === notifTab.value)
  ).slice(0, 5))

function openNotification(n: AppNotification): void {
  markRead(n.id)
  if (n.link) navigateTo(n.link)
}
</script>

<template>
  <div class="grid gap-3">
    <!-- ① ストリップ（挨拶・フェーズ・完了メーター・予報 1 行） -->
    <WidgetsCockpitStrip
      :phase="cockpit.phase.value"
      :meter="cockpit.meter.value"
      :forecast="stripForecast"
      :expanded="forecastOpen"
      @toggle-forecast="toggleForecast"
    />

    <!-- ② 次の一手 -->
    <WidgetsCockpitMoves :moves="cockpit.moves.value" />

    <!-- ③ 役割と文脈の計器 -->
    <WidgetsCockpitInstruments :groups="cockpit.instruments.value" :weekly="cockpit.weeklyLine.value" />

    <!-- ④ 着地予報（滑走路ボード。既定閉・①から開閉） -->
    <WidgetsCockpitForecast
      v-if="forecastOpen && stripForecast.available"
      :forecasts="cockpit.forecasts.value"
      :correction="cockpit.courseCorrection.value"
      :goals-empty="cockpit.goalsEmpty.value"
      :is-admin="isAdmin"
    />

    <!-- ⑤ AKEBONO 業務（業態別アプリ。押下でその業態の業務へ入る = ヘッダ切替に依存しない導線） -->
    <section v-if="showAkebono" class="grid gap-1.5" aria-label="AKEBONO 業務">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] font-bold text-muted">AKEBONO 業務（業態別）</p>
        <span class="flex items-center gap-3">
          <NuxtLink v-if="canCompanyDashboard" to="/akebono/company" class="link text-[11px] font-semibold">会社全体ダッシュボード</NuxtLink>
          <NuxtLink to="/akebono" class="link text-[11px] font-semibold">ハブを開く</NuxtLink>
        </span>
      </div>
      <AkebonoSegmentApps />
    </section>

    <!-- ⑥ すべての機能（カード型メニュー = 格下げ配置。カテゴリチップで絞り込み。バッチ7h） -->
    <section class="grid gap-3" aria-label="すべての機能">
      <p class="text-[11px] font-bold text-muted">すべての機能</p>
      <UiChipTabs v-model="selectedCategory" :options="categoryChips" aria-label="メニューカテゴリ" />
      <div v-for="sec in shownSections" :key="sec.id">
        <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
        <UiCardMenu :items="sec.cards" />
      </div>
    </section>

    <!-- ⑦ 通知フィード（エスカレーション / 承認依頼 / 稟議 のタブ分け） -->
    <UiSectionCard
      title="通知"
      description="直近 5 件。クリックで既読にしてリンク先へ"
      flush
    >
      <template #actions>
        <NuxtLink to="/inbox" class="link text-xs font-semibold">すべて見る</NuxtLink>
      </template>
      <div class="px-3 pt-1">
        <UiTabBar v-model="notifTab" :tabs="notifTabs" aria-label="通知カテゴリ" />
      </div>
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
</template>
