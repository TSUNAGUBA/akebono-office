<script setup lang="ts">
import * as icons from 'lucide-vue-next'
import { ArrowLeft, Bell, ChevronDown, Layers, Link2, LogOut, Sunrise, UserCog } from 'lucide-vue-next'
import { signOutFirebase } from '~/utils/firebase-auth'
import { EMPLOYMENT_TYPE_LABELS } from '~/utils/labels'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { navEntryOf } from '~/utils/nav-map'
import { isActivePath, MOBILE_NAV, NAV_GROUPS } from '~/utils/navigation'
import { resolvePageLabel } from '~/utils/page-label'
import { type QuickAccessItem, quickAccessItemOf, quickAccessPermPath } from '~/utils/header-quick-access'

const route = useRoute()
const { currentUser, isAdmin, switchableUsers, switchUser } = useCurrentUser()
const { unreadCount } = useNotifications()
const { isEnabled } = useAppSettings()
const { show: showToast } = useToast()

// ---------- 業態（事業セグメント）スイッチャ（マルチ業態。F-20 拡張） ----------
// AKEBONO 業務配下でのみ表示し、選んだ業態を配下アプリの既定として使う（毎回選ばせない導線）。
const { activeSegments, currentSegment, effectiveSegmentId, switchSegment } = useCurrentSegment()
const segmentMenuOpen = ref(false)
const showSegmentSwitcher = computed(() =>
  route.path.startsWith('/akebono') && activeSegments.value.length > 0)

function onSwitchSegment(id: string): void {
  segmentMenuOpen.value = false
  if (id === effectiveSegmentId.value) return
  switchSegment(id)
  const name = activeSegments.value.find(s => s.id === id)?.name ?? ''
  if (name) showToast(`業態を「${name}」に切り替えました`, 'ok')
}
/** API モードは実認証のためデモユーザー切替を出さない（バッチ5e: モックの名残の除去）*/
const isApi = useApiMode()
/** dev 認証（E2E・ローカル検証）はセッションを持たないためログアウトを出さない */
const devMode = computed(() => !!apiPublicConfig().devMemberId)

async function logout(): Promise<void> {
  userMenuOpen.value = false
  await signOutFirebase()
  clearMe()
  // 前ユーザーのキャッシュ（マスタ・日報・通知等）を値ごと破棄する（深層防御）。
  // 再取得はしない = サインアウト後に未認証リクエストを発生させない（次のログインで取り直す）
  clearApiData()
  await navigateTo('/login')
}

const userMenuOpen = ref(false)
/** タイムカードモーダル（ヘッダーからどの画面でも打刻できる） */
const punchModalOpen = ref(false)

// モーダル内のリンク（勤怠管理へ等）で遷移したら閉じる（開いたまま画面を覆わない）
watch(() => route.path, () => {
  punchModalOpen.value = false
  userMenuOpen.value = false
  relatedOpen.value = false
  segmentMenuOpen.value = false
})

// ページ間導線（バッチ7h）: 親ページへ戻る + 関連ページ・設定（nav-map.ts が SoT）
const relatedOpen = ref(false)
const navEntry = computed(() => navEntryOf(route.path))
const parentLink = computed(() => (route.path === '/' ? null : navEntry.value?.parent ?? null))
const relatedLinks = computed(() => (navEntry.value?.related ?? []).filter((l) => {
  const bare = l.to.split('?')[0] ?? l.to
  return (!l.adminOnly || isAdmin.value) && canPath(bare) && bare !== route.path
}))

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Circle
}

const pageTitle = computed(() => {
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (isActivePath(route.fullPath, i)) return i.label
    }
  }
  return '' // ナビ定義にないルート（404 等）はタイトル非表示
})

// ---------- ヘッダーのパス表示（パンくず。改善要望 2026-08-17） ----------

/**
 * 現在ページの祖先チェーン（nav-map の parent 連鎖）。ホームはブランドリンクが担うため除外。
 * 各階層は押下でその場所へ遷移できる。循環ガード付き（related の横リンクと違い parent は木構造の想定）。
 */
const breadcrumbs = computed<{ to: string; label: string }[]>(() => {
  if (route.path === '/') return []
  const chain: { to: string; label: string }[] = []
  const seen = new Set<string>([route.path])
  let entry = navEntryOf(route.path)
  while (entry?.parent && entry.parent.to !== '/' && !seen.has(entry.parent.to)) {
    seen.add(entry.parent.to)
    chain.unshift({ to: entry.parent.to, label: entry.parent.label })
    entry = navEntryOf(entry.parent.to)
  }
  return chain
})

/**
 * 現在ページの表示名。下ったページも固有名で表現する（resolvePageLabel = ナビ + カードメニュー +
 * nav-map 導線ラベルの合併）。解決できないルート（404 等）は従来どおり非表示（pageTitle フォールバック）。
 */
const currentPageLabel = computed(() => {
  if (route.path === '/') return ''
  const label = resolvePageLabel(route.path)
  return label !== route.path ? label : pageTitle.value
})

// 権限ルールで deny された機能はモバイル下部ナビ・ヘッダー導線（打刻/通知）からも隠す（F-16）
const { canPath } = usePermissions()
const visibleMobileNav = computed(() => MOBILE_NAV.filter(i => canPath(i.path)))

// ヘッダーのクイックアクセス（ヘッダーカスタマイズ。ユーザー > 組織 > 既定。ユーザー優先）。
// 権限・機能トグルで利用不可の項目は表示しない（F-16 と同じ絞り込み）。
// 「通知（inbox）」はベルアイコン（未読バッジ付き）として特別描画するため一般ループから除外する
const { effectiveIds: quickAccessIds } = useHeaderQuickAccess()
const quickAccessItems = computed<QuickAccessItem[]>(() =>
  quickAccessIds.value
    .filter(id => id !== 'inbox')
    .map(id => quickAccessItemOf(id))
    .filter((i): i is QuickAccessItem => !!i)
    .filter((i) => {
      if (i.featureKey && !isEnabled(i.featureKey)) return false
      const p = quickAccessPermPath(i)
      return !p || canPath(p)
    }))

// 通知ベル（アプリヘッダー設定の「通知」で表示を制御。既定 = 表示。改修依頼 2026-08-18）。
// モバイル下部ナビの「通知」は本設定と独立（MOBILE_NAV 由来のまま）
const showInboxBell = computed(() => quickAccessIds.value.includes('inbox') && canPath('/inbox'))
/** 未読バッジ表示（100 件以上は 99+ に丸め、ヘッダー/下部ナビの幅崩れを防ぐ） */
const unreadBadge = computed(() => unreadCount.value > 99 ? '99+' : String(unreadCount.value))

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
      <!-- gap はモバイルで詰める（gap-1.5）: AKEBONO 業務配下は業態スイッチャ + 戻る + 関連 + タイムカード + 通知 +
           アカウントの固定幅コントロールが並び、gap-3 のままだとタイトルを 0 まで truncate しても右にはみ出す。
           md 以上は余白があるため gap-3 に戻す -->
      <header class="sticky top-0 z-20 flex h-[var(--header-h)] items-center gap-1.5 border-b border-line bg-surface px-3 md:gap-3 md:px-5">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-2" aria-label="ダッシュボードへ戻る">
          <Sunrise class="h-5 w-5 text-brand" aria-hidden="true" />
          <span class="hidden text-[15px] font-bold tracking-tight sm:block">AKEBONO Office</span>
        </NuxtLink>
        <!-- パス表示（パンくず）: 全階層を表現し、各階層は押下でその場所へ遷移できる（改善要望 2026-08-17）。
             中間階層はモバイルでは幅の都合で隠す（sm+）。現在ページ名は常に表示（truncate） -->
        <template v-if="route.path !== '/' && currentPageLabel">
          <nav class="flex min-w-0 flex-1 items-center gap-1.5 md:gap-3" aria-label="パンくず">
            <template v-for="c in breadcrumbs" :key="c.to">
              <span class="hidden text-line-strong sm:block" aria-hidden="true">/</span>
              <NuxtLink
                :to="c.to"
                class="hidden max-w-40 shrink-0 truncate text-[15px] font-bold text-sub hover:text-brand hover:underline sm:block"
              >{{ c.label }}</NuxtLink>
            </template>
            <span class="hidden text-line-strong sm:block" aria-hidden="true">/</span>
            <h1 class="min-w-0 flex-1 truncate text-[15px] font-bold">{{ currentPageLabel }}</h1>
          </nav>
        </template>
        <div v-else class="flex-1" />

        <!-- 業態スイッチャ（マルチ業態。AKEBONO 業務配下でのみ表示。選択業態が配下アプリの既定になる） -->
        <div v-if="showSegmentSwitcher" class="relative shrink-0">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 hover:border-brand"
            :aria-expanded="segmentMenuOpen"
            aria-haspopup="menu"
            :aria-label="`業態の切り替え（現在: ${currentSegment?.name ?? '未設定'}）`"
            @click="segmentMenuOpen = !segmentMenuOpen"
          >
            <Layers class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <span class="hidden max-w-[9rem] truncate text-xs font-semibold sm:block">{{ currentSegment?.name ?? '業態を選択' }}</span>
            <ChevronDown class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          </button>
          <Transition name="fade">
            <div
              v-if="segmentMenuOpen"
              class="card absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden shadow-lg"
              role="menu"
              aria-label="業態の切り替え"
            >
              <p class="border-b border-line bg-surface-soft px-3 py-1.5 text-[10px] font-bold text-muted">
                業態（この業態の設定・データが既定になります）
              </p>
              <button
                v-for="s in activeSegments"
                :key="s.id"
                type="button"
                role="menuitemradio"
                :aria-checked="s.id === effectiveSegmentId"
                class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-brand-soft"
                :class="s.id === effectiveSegmentId ? 'bg-brand-soft' : ''"
                @click="onSwitchSegment(s.id)"
              >
                <span class="flex-1 truncate text-[13px] font-semibold">{{ s.name }}</span>
                <UiStatusBadge :label="INDUSTRY_TYPE_LABELS[s.industryType]" tone="info" />
              </button>
            </div>
          </Transition>
        </div>

        <!-- 親ページへ戻る（nav-map.ts。モバイルでもアイコンで常時表示 = 迷子にならない） -->
        <NuxtLink
          v-if="parentLink"
          :to="parentLink.to"
          class="btn btn-ghost btn-sm"
          :aria-label="`${parentLink.label}へ戻る`"
        >
          <ArrowLeft class="h-4 w-4" aria-hidden="true" />
          <span class="hidden md:inline">{{ parentLink.label }}</span>
        </NuxtLink>

        <!-- 関連ページ・関連設定（nav-map.ts。権限・管理者フィルタ後に空なら非表示）。
             モバイルはヘッダー過密回避のため非表示 = 下部ナビ「メニュー」から辿る（オペレーター指示） -->
        <div v-if="relatedLinks.length > 0" class="relative hidden md:block">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :aria-expanded="relatedOpen"
            aria-haspopup="menu"
            aria-label="関連ページ・設定"
            @click="relatedOpen = !relatedOpen"
          >
            <Link2 class="h-4 w-4" aria-hidden="true" />
            <span class="hidden md:inline">関連</span>
            <ChevronDown class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          </button>
          <Transition name="fade">
            <div
              v-if="relatedOpen"
              class="card absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden shadow-lg"
              role="menu"
              aria-label="関連ページ・設定"
            >
              <p class="border-b border-line bg-surface-soft px-3 py-1.5 text-[10px] font-bold text-muted">
                関連ページ・設定
              </p>
              <NuxtLink
                v-for="l in relatedLinks"
                :key="l.to"
                :to="l.to"
                role="menuitem"
                class="block px-3 py-2 text-[13px] font-semibold hover:bg-brand-soft"
                @click="relatedOpen = false"
              >
                {{ l.label }}
              </NuxtLink>
            </div>
          </Transition>
        </div>

        <!-- クイックアクセス（ヘッダーカスタマイズ。ユーザー > 組織 > 既定）。
             タイムカード等の打刻アクションは従来どおり全幅表示・ページ導線は PC のみ（モバイル過密回避）。
             設定 UI はヘッダーから撤去し、ダッシュボード → レイアウト → アプリヘッダー に集約（2026-08-12） -->
        <template v-for="q in quickAccessItems" :key="q.id">
          <button
            v-if="q.action === 'punch'"
            type="button"
            class="btn btn-ghost btn-sm"
            @click="punchModalOpen = true"
          >
            <component :is="iconOf(q.icon)" class="h-4 w-4" aria-hidden="true" />
            <span class="hidden sm:inline">{{ q.label }}</span>
          </button>
          <NuxtLink
            v-else-if="q.to"
            :to="q.to"
            class="btn btn-ghost btn-sm hidden md:inline-flex"
          >
            <component :is="iconOf(q.icon)" class="h-4 w-4" aria-hidden="true" />
            <span class="hidden lg:inline">{{ q.label }}</span>
          </NuxtLink>
        </template>

        <!-- 通知ベル（未読総数バッジ付き）。表示はレイアウト → アプリヘッダー の「通知」で制御（既定 = 表示） -->
        <NuxtLink
          v-if="showInboxBell"
          to="/inbox"
          class="btn btn-ghost btn-sm relative"
          :aria-label="unreadCount > 0 ? `通知（未読 ${unreadCount} 件）` : '通知'"
        >
          <Bell class="h-4 w-4" />
          <span
            v-if="unreadCount > 0"
            class="num absolute -right-0.5 -top-0.5 rounded-full bg-crit px-1 text-[9px] font-bold leading-3.5 text-white"
          >{{ unreadBadge }}</span>
        </NuxtLink>

        <!-- 改善要望の投稿（全ページ共通・F-42）。どの画面からでもこのページの要望を送れる -->
        <WidgetsImprovementSubmit />

        <!-- アカウントメニュー（API モード: プロフィール・ログアウト / モックモード: 加えてデモユーザー切替） -->
        <div class="relative">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border border-line px-1.5 py-1 hover:border-muted"
            :aria-expanded="userMenuOpen"
            aria-haspopup="menu"
            aria-label="アカウントメニュー"
            @click="userMenuOpen = !userMenuOpen"
          >
            <UiAvatar :name="currentUser.name" :src="currentUser.avatar" size="sm" />
            <span class="hidden text-xs font-semibold sm:block">{{ currentUser.name }}</span>
            <ChevronDown class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          </button>
          <Transition name="fade">
            <div
              v-if="userMenuOpen"
              class="card absolute right-0 top-full z-40 mt-1 w-64 overflow-hidden shadow-lg"
              role="menu"
              aria-label="アカウントメニュー"
            >
              <!-- モバイルでは非表示（フッターの「メニュー」からアクセス）。ヘッダー過密回避（オペレーター指示） -->
              <NuxtLink
                to="/profile"
                role="menuitem"
                class="hidden w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold hover:bg-brand-soft md:flex"
                @click="userMenuOpen = false"
              >
                <UserCog class="h-4 w-4 text-muted" aria-hidden="true" />
                プロフィール・個人設定
              </NuxtLink>
              <button
                v-if="isApi && !devMode"
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[13px] font-semibold text-crit hover:bg-brand-soft"
                @click="logout"
              >
                <LogOut class="h-4 w-4" aria-hidden="true" />
                ログアウト
              </button>
              <!-- デモユーザー切替はモックモード専用（API モードは dev 認証でも出さない） -->
              <template v-if="!isApi">
                <p class="border-y border-line bg-surface-soft px-3 py-1.5 text-[10px] font-bold text-muted">
                  デモユーザー切替（権限別の見え方を体感）
                </p>
                <button
                  v-for="u in switchableUsers"
                  :key="u.id"
                  type="button"
                  role="menuitemradio"
                  :aria-checked="u.id === currentUser.id"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-brand-soft"
                  :class="u.id === currentUser.id ? 'bg-brand-soft' : ''"
                  @click="onSwitchUser(u.id)"
                >
                  <UiAvatar :name="u.name" :src="u.avatar" size="sm" />
                  <span class="flex-1 text-[13px]">{{ u.name }}</span>
                  <UiStatusBadge
                    :label="`${EMPLOYMENT_TYPE_LABELS[u.employmentType]}${u.role === 'admin' ? '・管理' : u.role === 'hr' ? '・人事' : ''}`"
                    :tone="u.role === 'admin' ? 'brand' : u.role === 'hr' ? 'info' : 'neutral'"
                  />
                </button>
              </template>
            </div>
          </Transition>
        </div>
      </header>

      <!-- ページ本体 -->
      <main class="flex-1 p-3 pb-[calc(var(--bottomnav-h)+16px)] md:p-5 md:pb-8" @click="userMenuOpen = false; relatedOpen = false; segmentMenuOpen = false">
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
        :class="isActivePath(route.fullPath, item) ? 'text-brand' : 'text-muted'"
      >
        <component :is="iconOf(item.icon)" class="h-5 w-5" aria-hidden="true" />
        {{ item.label }}
        <span
          v-if="item.path === '/inbox' && unreadCount > 0"
          class="num absolute right-[22%] top-1 rounded-full bg-crit px-1 text-[9px] font-bold leading-3.5 text-white"
        >{{ unreadBadge }}</span>
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
