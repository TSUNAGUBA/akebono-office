<script setup lang="ts">
import * as icons from 'lucide-vue-next'
import { Bell, ChevronDown, Clock3, House, Sunrise } from 'lucide-vue-next'
import { EMPLOYMENT_TYPE_LABELS } from '~/utils/labels'
import { isActivePath, MOBILE_NAV, NAV_GROUPS } from '~/utils/navigation'

const route = useRoute()
const { currentUser, switchableUsers, switchUser } = useCurrentUser()
const { unreadCount } = useNotifications()

const userMenuOpen = ref(false)
/** タイムカードモーダル（ヘッダーからどの画面でも打刻できる） */
const punchModalOpen = ref(false)

// モーダル内のリンク（勤怠管理へ等）で遷移したら閉じる（開いたまま画面を覆わない）
watch(() => route.path, () => {
  punchModalOpen.value = false
  userMenuOpen.value = false
})

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

const pageTitle = computed(() => {
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (isActivePath(route.path, i)) return i.label
    }
  }
  return '' // ナビ定義にないルート（404 等）はタイトル非表示
})

// 権限ルールで deny された機能はモバイル下部ナビ・ヘッダー導線（打刻/通知）からも隠す（F-16）
const { canPath } = usePermissions()
const visibleMobileNav = computed(() => MOBILE_NAV.filter(i => canPath(i.path)))

// 遷移時のガードは permissions.global.ts。ここは「滞在中に deny になった」場合の補完:
// API モードのルール非同期ハイドレーション完了時・モックモードのユーザー切替時に現在ページを再判定する
watchEffect(() => {
  if (route.path !== '/' && route.path !== '/login' && !canPath(route.path)) {
    navigateTo('/')
  }
})

function onSwitchUser(id: string): void {
  switchUser(id)
  userMenuOpen.value = false
}
</script>

<template>
  <div class="flex min-h-dvh">
    <!-- メイン（サイドメニューは廃止: 遷移はダッシュボードのカード型メニュー起点） -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- ヘッダー -->
      <header class="sticky top-0 z-20 flex h-[var(--header-h)] items-center gap-3 border-b border-line bg-surface px-3 md:px-5">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-2" aria-label="ダッシュボードへ戻る">
          <Sunrise class="h-5 w-5 text-brand" aria-hidden="true" />
          <span class="hidden text-[15px] font-bold tracking-tight sm:block">AKEBONO Office</span>
        </NuxtLink>
        <template v-if="route.path !== '/' && pageTitle">
          <span class="hidden text-line-strong sm:block" aria-hidden="true">/</span>
          <h1 class="min-w-0 flex-1 truncate text-[15px] font-bold">{{ pageTitle }}</h1>
        </template>
        <div v-else class="flex-1" />

        <NuxtLink
          v-if="route.path !== '/'"
          to="/"
          class="btn btn-ghost btn-sm hidden md:inline-flex"
        >
          <House class="h-4 w-4" aria-hidden="true" /> ホーム
        </NuxtLink>

        <button v-if="canPath('/attendance')" type="button" class="btn btn-ghost btn-sm" @click="punchModalOpen = true">
          <Clock3 class="h-4 w-4" aria-hidden="true" />
          <span class="hidden sm:inline">タイムカード</span>
        </button>

        <NuxtLink v-if="canPath('/inbox')" to="/inbox" class="btn btn-ghost btn-sm relative" aria-label="通知">
          <Bell class="h-4 w-4" />
          <span
            v-if="unreadCount > 0"
            class="num absolute -right-0.5 -top-0.5 rounded-full bg-crit px-1 text-[9px] font-bold leading-3.5 text-white"
          >{{ unreadCount }}</span>
        </NuxtLink>

        <!-- デモユーザー切替 -->
        <div class="relative">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border border-line px-1.5 py-1 hover:border-muted"
            :aria-expanded="userMenuOpen"
            aria-haspopup="listbox"
            @click="userMenuOpen = !userMenuOpen"
          >
            <UiAvatar :name="currentUser.name" size="sm" />
            <span class="hidden text-xs font-semibold sm:block">{{ currentUser.name }}</span>
            <ChevronDown class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          </button>
          <Transition name="fade">
            <div
              v-if="userMenuOpen"
              class="card absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden shadow-lg"
              role="listbox"
              aria-label="デモユーザー切替"
            >
              <p class="border-b border-line bg-surface-soft px-3 py-1.5 text-[10px] font-bold text-muted">
                デモユーザー切替（権限別の見え方を体感）
              </p>
              <button
                v-for="u in switchableUsers"
                :key="u.id"
                type="button"
                role="option"
                :aria-selected="u.id === currentUser.id"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-brand-soft"
                :class="u.id === currentUser.id ? 'bg-brand-soft' : ''"
                @click="onSwitchUser(u.id)"
              >
                <UiAvatar :name="u.name" size="sm" />
                <span class="flex-1 text-[13px]">{{ u.name }}</span>
                <UiStatusBadge
                  :label="`${EMPLOYMENT_TYPE_LABELS[u.employmentType]}${u.role === 'admin' ? '・管理' : u.role === 'hr' ? '・人事' : ''}`"
                  :tone="u.role === 'admin' ? 'brand' : u.role === 'hr' ? 'info' : 'neutral'"
                />
              </button>
            </div>
          </Transition>
        </div>
      </header>

      <!-- ページ本体 -->
      <main class="flex-1 p-3 pb-[calc(var(--bottomnav-h)+16px)] md:p-5 md:pb-8" @click="userMenuOpen = false">
        <slot />
      </main>
    </div>

    <!-- モバイル下部ナビ -->
    <nav
      class="fixed inset-x-0 bottom-0 z-30 flex h-[var(--bottomnav-h)] items-stretch border-t border-line bg-surface md:hidden"
      aria-label="モバイルナビゲーション"
    >
      <NuxtLink
        v-for="item in visibleMobileNav"
        :key="item.path"
        :to="item.path"
        class="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold"
        :class="isActivePath(route.path, item) ? 'text-brand' : 'text-muted'"
      >
        <component :is="iconOf(item.icon)" class="h-5 w-5" aria-hidden="true" />
        {{ item.label }}
        <span
          v-if="item.path === '/inbox' && unreadCount > 0"
          class="num absolute right-[22%] top-1 rounded-full bg-crit px-1 text-[9px] font-bold leading-3.5 text-white"
        >{{ unreadCount }}</span>
      </NuxtLink>
    </nav>

    <!-- タイムカードモーダル（打刻カードをそのまま表示・操作） -->
    <UiModal :open="punchModalOpen" title="タイムカード" @close="punchModalOpen = false">
      <WidgetsPunchClock flat />
    </UiModal>

    <UiToastHost />
    <UiConfirmHost />
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
