<script setup lang="ts">
/**
 * ダッシュボードの通知欄（F-01。「すべて」+ 設定されたカテゴリタブ + 未読のみフィルタ）。
 * index.vue から分離し、レイアウト設定（通知欄の位置 = side / bottom）で配置を切り替えられるようにした
 * （オペレーター指示 2026-08-03）。表示するカテゴリタブ（エスカレーション/承認依頼/稟議/日報/顧客活動/議事録）は
 * useNotificationTabs 駆動（ユーザー > 全社 > 既定。設定はレイアウト → 通知タブ。2026-08-12）。「すべて」は常時先頭固定。
 */
import { CheckCheck } from 'lucide-vue-next'
import type { AppNotification } from '~/types/domain'
import type { TabItem } from '~/types/ui'
import { fmtDateTime } from '~/utils/format'
import { NOTIFICATION_KIND_LABELS } from '~/utils/labels'
import { type NotificationCategory, notificationCategoryOf as categoryOf } from '~/utils/notification-category'
import { notificationTabViews } from '~/utils/notification-tabs'

const { mine, unreadCount, markRead, markAllRead } = useNotifications()
const { effectiveIds: tabIds } = useNotificationTabs()
const { show } = useToast()

// 表示するカテゴリタブは設定駆動（ユーザー > 全社 > 既定。ダッシュボード → レイアウト → 通知タブ で設定）。
// タブの並びは共有の notificationTabViews で組み立て、/inbox と順序を一致させる（原則3）。「すべて」は常に先頭固定。
const notifTab = ref('all')
const notifTabs = computed<TabItem[]>(() => {
  const unreadOf = (c: NotificationCategory): number =>
    mine.value.filter(n => !n.read && categoryOf(n) === c).length
  return notificationTabViews(tabIds.value).map(v => ({
    ...v,
    badge: v.key === 'all' ? unreadCount.value : unreadOf(v.key as NotificationCategory),
  }))
})

// 選択中タブが設定変更で消えた場合は「すべて」へ戻す（index.vue のカテゴリチップと同じ防御）
watchEffect(() => {
  if (notifTab.value !== 'all' && !notifTabs.value.some(t => t.key === notifTab.value)) {
    notifTab.value = 'all'
  }
})

/** 未読のみ表示（既定 = 未読のみに統一。オペレーター指示。解除で既読も表示できる） */
const unreadOnly = ref(true)

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
  <UiSectionCard
    title="通知"
    :description="`未読 ${unreadCount} 件${unreadOnly ? '（未読のみ表示中）' : ''}`"
    flush
    fill
  >
    <template #actions>
      <NuxtLink to="/inbox" class="link text-xs font-semibold">すべて見る</NuxtLink>
    </template>
    <div class="grid shrink-0 gap-2 px-3 pt-1">
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
    <!-- 高さ上限を超えた分はここ（本文リスト）を内部スクロール（タブ・ヘッダーは固定） -->
    <ul v-else class="min-h-0 flex-1 divide-y divide-[var(--c-line)] overflow-y-auto">
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
</template>
