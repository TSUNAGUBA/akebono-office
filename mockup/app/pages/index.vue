<script setup lang="ts">
/**
 * ダッシュボード（F-01）
 * カード型メニュー + 通知フィードのみを配置する（2026-07-16 オペレーター指示）。
 * - 打刻はヘッダーの「タイムカード」ボタン → モーダル（layouts/default.vue）
 * - 売上サマリは 売上管理（/sales）、稼働状況サマリは 提供システム稼働状況（/status）へ独立
 */
import type { AppNotification } from '~/types/domain'
import type { MenuCard } from '~/types/ui'
import { fmtDateLong, fmtDateTime } from '~/utils/format'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'
import { MENU_CARDS } from '~/utils/menu-registry'

const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const { mine, unreadCount, markRead } = useNotifications()
const { isEnabled } = useAppSettings()
const { pendingFor } = useWorkflow()

// ---------- 挨拶 ----------
const greeting = computed(() => {
  const h = Number(jstClock().h)
  if (h < 5) return 'お疲れさまです'
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'こんにちは'
  return 'こんばんは'
})
const todayLong = computed(() => fmtDateLong(nowJstIso()))

const { canPath } = usePermissions()

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

    <div class="grid gap-3">
      <!-- カード型メニュー（カテゴリチップで絞り込み。バッチ7h） -->
      <section class="grid gap-3" aria-label="メニュー">
        <UiChipTabs v-model="selectedCategory" :options="categoryChips" aria-label="メニューカテゴリ" />
        <div v-for="sec in shownSections" :key="sec.id">
          <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
          <UiCardMenu :items="sec.cards" />
        </div>
      </section>

      <!-- 通知フィード -->
      <UiSectionCard
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
