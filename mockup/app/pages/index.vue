<script setup lang="ts">
/**
 * ダッシュボード（F-01）
 * カード型メニュー + 通知フィードのみを配置する（2026-07-16 オペレーター指示）。
 * - 打刻はヘッダーの「タイムカード」ボタン → モーダル（layouts/default.vue）
 * - 売上サマリは 売上管理（/sales）、稼働状況サマリは 提供システム稼働状況（/status）へ独立
 */
import { CheckCheck } from 'lucide-vue-next'
import type { AppNotification } from '~/types/domain'
import type { MenuCard, TabItem } from '~/types/ui'
import { fmtDateLong, fmtDateTime } from '~/utils/format'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'
import { MENU_CARDS } from '~/utils/menu-registry'

const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead, markAllRead } = useNotifications()
const { isEnabled } = useAppSettings()
const { pendingFor } = useWorkflow()
const { show } = useToast()

// ---------- 挨拶 ----------
const greeting = computed(() => {
  const h = Number(jstClock().h)
  if (h < 5) return 'お疲れさまです'
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'こんにちは'
  return 'こんばんは'
})
const todayLong = computed(() => fmtDateLong(nowJstIso()))

const { canPath, can } = usePermissions()
const canCompanyDashboard = computed(() => can('sales'))

// ---------- AKEBONO 業務（業態別アプリをトップに配置。2026-07-28） ----------
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
const internalCards = computed<MenuCard[]>(() =>
  MENU_CARDS.dashboard
    .filter(d =>
      (!d.featureToggle || isEnabled(d.featureToggle))
      && (!d.adminOnly || isAdmin.value)
      && canPath(d.to))
    .map(d => ({ id: d.id, title: d.title, description: d.description, icon: d.icon, to: d.to, badge: badgeOf(d.id) })))

// 外部リンク（設定 > 外部リンク）も基本メニューと同じくカテゴリ配置対象にする（オペレーター指示 2026-08-03）。
// 未割当の外部リンクは categorize が「その他」へ入れる = 基本メニューと同じ挙動（消えない）
const { externalCards } = useExternalLinkCards()
const visibleCards = computed<MenuCard[]>(() => [...internalCards.value, ...externalCards.value])

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

/** 未読のみ表示（オペレーター指示 2026-08-03）。ダッシュボードのサイド通知欄でも既読を隠して確認できる */
const unreadOnly = ref(false)

/** カテゴリタブ ∩ 未読フィルタを適用した通知（サイド欄は件数に余裕があるため 8 件まで） */
const filteredNotifications = computed(() =>
  mine.value
    .filter(n => notifTab.value === 'all' || categoryOf(n) === notifTab.value)
    .filter(n => !unreadOnly.value || !n.read))
const recentNotifications = computed(() => filteredNotifications.value.slice(0, 8))

function openNotification(n: AppNotification): void {
  markRead(n.id)
  if (n.link) navigateTo(n.link)
}

function onMarkAllRead(): void {
  markAllRead()
  show('すべての通知を既読にしました', 'ok')
}
</script>

<template>
  <div>
    <UiPageHeader
      :title="`${greeting}、${currentUser.name} さん`"
      :description="todayLong"
    />

    <!-- 2 カラム: 左 = メニュー / 右 = 通知欄（ダッシュボードを開いた時点で見える = オペレーター指示 2026-08-03）。
         モバイルは縦積みで通知欄を先頭に置き、開いてすぐ通知が見えるようにする -->
    <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <!-- メイン: メニュー -->
      <div class="order-2 grid gap-3 lg:order-1">
        <!-- AKEBONO 業務（業態別アプリ。押下でその業態の業務へ入る = ヘッダ切替に依存しない導線） -->
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

        <!-- カード型メニュー（カテゴリチップで絞り込み。バッチ7h） -->
        <section class="grid gap-3" aria-label="メニュー">
          <UiChipTabs v-model="selectedCategory" :options="categoryChips" aria-label="メニューカテゴリ" />
          <div v-for="sec in shownSections" :key="sec.id">
            <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
            <UiCardMenu :items="sec.cards" />
          </div>
        </section>
      </div>

      <!-- 通知欄（ページ側。lg では上部に張り付く。エスカレーション / 承認依頼 / 稟議 のタブ + 未読のみフィルタ） -->
      <aside class="order-1 lg:sticky lg:top-3 lg:order-2" aria-label="通知">
        <UiSectionCard
          title="通知"
          :description="`未読 ${unreadCount} 件${unreadOnly ? '（未読のみ表示中）' : ''}`"
          flush
        >
          <template #actions>
            <NuxtLink to="/inbox" class="link text-xs font-semibold">すべて見る</NuxtLink>
          </template>
          <div class="grid gap-2 px-3 pt-1">
            <UiTabBar v-model="notifTab" :tabs="notifTabs" aria-label="通知カテゴリ" />
            <div class="flex items-center justify-between gap-2">
              <button
                type="button"
                class="btn btn-sm"
                :class="unreadOnly ? 'btn-primary' : ''"
                :aria-pressed="unreadOnly"
                @click="unreadOnly = !unreadOnly"
              >
                未読のみ
              </button>
              <button type="button" class="btn btn-sm" :disabled="unreadCount === 0" @click="onMarkAllRead">
                <CheckCheck class="h-3.5 w-3.5" aria-hidden="true" />
                すべて既読
              </button>
            </div>
          </div>
          <UiEmptyState
            v-if="recentNotifications.length === 0"
            icon="BellOff"
            :title="unreadOnly ? '未読の通知はありません' : '通知はありません'"
            :hint="unreadOnly ? '「未読のみ」を解除すると既読も表示されます' : undefined"
          />
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
      </aside>
    </div>
  </div>
</template>
