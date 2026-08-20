<script setup lang="ts">
/**
 * 共通レイアウト: ヘッダー（ブランド・PC ナビ・アカウント）+ モバイルボトムナビ。
 * AKEBONO Office のレイアウト構成を本アプリのメニューへ簡素化して踏襲。
 */
import * as icons from 'lucide-vue-next'
import { Check, ChevronDown, LineChart, LogOut, RotateCcw } from 'lucide-vue-next'
import { signOutFirebase } from '~/utils/firebase-auth'
import { MOBILE_NAV, NAV_ITEMS, isActivePath } from '~/utils/navigation'

const route = useRoute()
const isApi = useApiMode()
const { currentUser, switchableUsers, switchUser } = useCurrentUser()
const { resetDemo } = useMockDb()
const { show } = useToast()
const { ask } = useConfirm()

/** ナビアイコンの解決（lucide キー → コンポーネント。未検出は Circle） */
function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

const accountOpen = ref(false)

watch(() => route.fullPath, () => { accountOpen.value = false })

async function onSwitchUser(id: string): Promise<void> {
  switchUser(id)
  accountOpen.value = false
  show('デモユーザーを切り替えました', 'info')
}

async function onResetDemo(): Promise<void> {
  accountOpen.value = false
  const ok = await ask('デモデータのリセット', 'モックデータをシード状態へ戻します。編集内容は失われます。', { confirmLabel: 'リセット', danger: true })
  if (!ok) return
  resetDemo()
  show('デモデータをリセットしました', 'ok')
}

async function logout(): Promise<void> {
  accountOpen.value = false
  await signOutFirebase()
  clearMe()
  clearApiData()
  await navigateTo('/login')
}
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <header class="sticky top-0 z-20 border-b border-line bg-surface" :style="{ height: 'var(--header-h)' }">
      <div class="mx-auto flex h-full max-w-6xl items-center gap-1.5 px-3 md:gap-3 md:px-4">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-1.5 font-bold">
          <LineChart class="h-5 w-5 text-brand" aria-hidden="true" />
          <span class="text-[15px]">AKEBONO Intelligence</span>
        </NuxtLink>

        <nav class="ml-2 hidden min-w-0 items-center gap-0.5 overflow-x-auto md:flex" aria-label="メイン">
          <NuxtLink
            v-for="n in NAV_ITEMS"
            :key="n.to"
            :to="n.to"
            class="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px]"
            :class="isActivePath(route.path, n.to) ? 'bg-brand-soft font-semibold text-brand' : 'text-sub hover:bg-surface-soft hover:text-ink'"
            :aria-current="isActivePath(route.path, n.to) ? 'page' : undefined"
          >
            {{ n.label }}
          </NuxtLink>
        </nav>

        <div class="ml-auto flex items-center gap-1">
          <!-- アカウント -->
          <div class="relative">
            <button
              type="button"
              class="btn btn-ghost h-8 gap-1.5 px-1.5"
              :aria-expanded="accountOpen"
              aria-haspopup="true"
              aria-label="アカウントメニュー"
              @click="accountOpen = !accountOpen"
            >
              <UiAvatar :name="currentUser?.name ?? ''" :src="currentUser?.avatar" size="sm" />
              <span class="hidden max-w-28 truncate text-[12px] md:inline">{{ currentUser?.name }}</span>
              <ChevronDown class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            </button>
            <div
              v-if="accountOpen"
              class="card absolute right-0 top-10 z-30 w-64 p-2 shadow-lg"
              role="menu"
              aria-label="アカウントメニュー"
            >
              <div class="px-2 py-1.5">
                <p class="text-[13px] font-semibold">{{ currentUser?.name }}</p>
                <p class="truncate text-[11px] text-muted">{{ currentUser?.email }}</p>
              </div>
              <template v-if="!isApi">
                <p class="border-t border-line px-2 pb-1 pt-2 text-[11px] font-semibold text-muted">デモユーザー切替</p>
                <ul class="scroll-slim max-h-56 overflow-y-auto">
                  <li v-for="m in switchableUsers" :key="m.id">
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-surface-soft"
                      @click="onSwitchUser(m.id)"
                    >
                      <UiAvatar :name="m.name" :src="m.avatar" size="sm" />
                      <span class="min-w-0 flex-1 truncate">{{ m.name }}<span class="ml-1 text-[10px] text-muted">{{ m.title }}</span></span>
                      <Check v-if="m.id === currentUser?.id" class="h-3.5 w-3.5 text-brand" aria-hidden="true" />
                    </button>
                  </li>
                </ul>
                <div class="mt-1 border-t border-line pt-1">
                  <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-sub hover:bg-surface-soft" @click="onResetDemo">
                    <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> デモデータをリセット
                  </button>
                </div>
              </template>
              <div v-else class="mt-1 border-t border-line pt-1">
                <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-sub hover:bg-surface-soft" @click="logout">
                  <LogOut class="h-3.5 w-3.5" aria-hidden="true" /> ログアウト
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- メニュー外クリックで閉じる透明レイヤ -->
    <div v-if="accountOpen" class="fixed inset-0 z-10" aria-hidden="true" @click="accountOpen = false" />

    <main class="mx-auto w-full max-w-6xl flex-1 px-3 py-4 pb-[calc(var(--bottomnav-h)+16px)] md:px-4 md:pb-6">
      <slot />
    </main>

    <!-- モバイルボトムナビ -->
    <nav
      class="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface md:hidden"
      :style="{ height: 'var(--bottomnav-h)' }"
      aria-label="モバイルナビ"
    >
      <NuxtLink
        v-for="n in MOBILE_NAV"
        :key="n.to"
        :to="n.to"
        class="flex flex-col items-center justify-center gap-0.5 text-[10px]"
        :class="isActivePath(route.path, n.to) ? 'font-semibold text-brand' : 'text-sub'"
        :aria-current="isActivePath(route.path, n.to) ? 'page' : undefined"
      >
        <component :is="iconOf(n.icon)" class="h-5 w-5" aria-hidden="true" />
        {{ n.label }}
      </NuxtLink>
    </nav>

    <UiToastHost />
    <UiConfirmHost />
  </div>
</template>
