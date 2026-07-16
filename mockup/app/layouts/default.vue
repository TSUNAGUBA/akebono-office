<script setup lang="ts">
import * as icons from 'lucide-vue-next'
import { Bell, ChevronDown, Sunrise } from 'lucide-vue-next'
import { EMPLOYMENT_TYPE_LABELS } from '~/utils/labels'
import { isActivePath, MOBILE_NAV, NAV_GROUPS } from '~/utils/navigation'

const route = useRoute()
const { currentUser, isAdmin, switchableUsers, switchUser } = useCurrentUser()
const { unreadCount } = useNotifications()
const { isEnabled } = useAppSettings()

const userMenuOpen = ref(false)

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

const visibleGroups = computed(() =>
  NAV_GROUPS
    .map(g => ({
      ...g,
      items: g.items.filter(i =>
        (!i.adminOnly || isAdmin.value) && (!i.featureKey || isEnabled(i.featureKey)),
      ),
    }))
    .filter(g => g.items.length > 0),
)

const pageTitle = computed(() => {
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (isActivePath(route.path, i)) return i.label
    }
  }
  return 'AKEBONO Office'
})

function onSwitchUser(id: string): void {
  switchUser(id)
  userMenuOpen.value = false
}
</script>

<template>
  <div class="flex min-h-dvh">
    <!-- サイドバー（PC） -->
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] flex-col border-r border-line bg-surface md:flex">
      <NuxtLink to="/" class="flex h-[var(--header-h)] items-center gap-2 border-b border-line px-4">
        <Sunrise class="h-5 w-5 text-brand" aria-hidden="true" />
        <span class="text-[15px] font-bold tracking-tight">AKEBONO Office</span>
      </NuxtLink>
      <nav class="flex-1 overflow-y-auto px-2 py-3 scroll-slim" aria-label="メインナビゲーション">
        <div v-for="g in visibleGroups" :key="g.id" class="mb-3">
          <p class="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted">{{ g.label }}</p>
          <NuxtLink
            v-for="item in g.items"
            :key="item.path"
            :to="item.path"
            class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors"
            :class="isActivePath(route.path, item)
              ? 'bg-brand-soft text-brand'
              : 'text-sub hover:bg-surface-soft hover:text-ink'"
          >
            <component :is="iconOf(item.icon)" class="h-4 w-4 shrink-0" aria-hidden="true" />
            <span class="flex-1">{{ item.label }}</span>
            <span
              v-if="item.path === '/inbox' && unreadCount > 0"
              class="num rounded-full bg-crit px-1.5 text-[10px] font-bold leading-4 text-white"
            >{{ unreadCount }}</span>
          </NuxtLink>
        </div>
      </nav>
      <div class="border-t border-line px-3 py-2 text-[10px] text-muted">
        モックアップ v0.1 / データはブラウザ内のみ
      </div>
    </aside>

    <!-- メイン -->
    <div class="flex min-w-0 flex-1 flex-col md:pl-[var(--sidebar-w)]">
      <!-- ヘッダー -->
      <header class="sticky top-0 z-20 flex h-[var(--header-h)] items-center gap-3 border-b border-line bg-surface px-3 md:px-5">
        <NuxtLink to="/" class="flex items-center gap-1.5 md:hidden">
          <Sunrise class="h-5 w-5 text-brand" aria-hidden="true" />
        </NuxtLink>
        <h1 class="min-w-0 flex-1 truncate text-[15px] font-bold">{{ pageTitle }}</h1>

        <NuxtLink to="/inbox" class="btn btn-ghost btn-sm relative" aria-label="通知">
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
                  :label="`${EMPLOYMENT_TYPE_LABELS[u.employmentType]}${u.role === 'admin' ? '・管理' : ''}`"
                  :tone="u.role === 'admin' ? 'brand' : 'neutral'"
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
        v-for="item in MOBILE_NAV"
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

    <UiToastHost />
    <UiConfirmHost />
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.12s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
