<script setup lang="ts">
/**
 * ダッシュボード（F-01）
 * カード型メニュー + 通知フィードを配置する（2026-07-16 オペレーター指示）。
 * 表示・配置（セクション構成・メニュー要素の配置・通知欄の位置）はテンプレートから選択でき、
 * ユーザー設定 > テナント設定 > デフォルト の順で解決する（useDashboardLayout。2026-08-03）。
 * - モバイル/PC でシーンを分離（2026-08-10）: 通知欄の配置（options.notifications）は PC 専用。
 *   モバイルはメニュー最優先で通知欄をトップに出さず、通知はヘッダーのベル（未読バッジ）/下部ナビ「通知」から開く。
 * - 打刻はヘッダーの「タイムカード」ボタン → モーダル（layouts/default.vue）
 * - 売上サマリは 売上管理（/sales）、稼働状況サマリは 提供システム稼働状況（/status）へ独立
 */
import { Clock3, LayoutTemplate } from 'lucide-vue-next'
import type { MenuCard } from '~/types/ui'
import { categorizeCards, planDashboardCards } from '~/utils/dashboard-layout'
import { fmtDateLong } from '~/utils/format'
import { MENU_CARDS } from '~/utils/menu-registry'

const { currentUser, currentUserId, isAdmin } = useCurrentUser()
const { unreadCount } = useNotifications()
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

const { canPath, can } = usePermissions()
const canCompanyDashboard = computed(() => can('sales'))

// ---------- レイアウト（表示・配置カスタマイズ。ユーザー > テナント > デフォルトで解決） ----------
const { effectiveLayout } = useDashboardLayout()
const layoutOpen = ref(false)
// タイムカード（ヘッダーの「タイムカード」と同一挙動 = 打刻モーダル。ダッシュボードにも配置。オペレーター指示 2026-08-12）。
// ヘッダーのモーダル状態はレイアウト側にありページから参照できないため、ここでローカルに同じモーダルを持つ（挙動は同一）
const punchOpen = ref(false)
/** 通知欄の位置（side=右カラム / bottom=メニュー下 / hidden=非表示） */
const notifPlacement = computed(() => effectiveLayout.value.options.notifications)
/** カード密度（compact = 余白を詰める） */
const dense = computed(() => effectiveLayout.value.options.density === 'compact')

// ---------- AKEBONO 業務（業態別アプリをトップに配置。2026-07-28 / カテゴリ配置対応 2026-08-03 #24） ----------
// akebonoAccessible = そもそも AKEBONO が使えるか（機能トグル + 権限 + 業態 1 件以上）。
// これが false のときは業態カードをどこにも出さない（プールにも入れない）。
const { activeSegments } = useCurrentSegment()
const akebonoAccessible = computed(() =>
  isEnabled('akebono') && canPath('/akebono') && activeSegments.value.length > 0)
// showAkebono = 専用「AKEBONO 業務（業態別）」セクションを出すか（利用可能 AND レイアウトで表示 ON）。
// false（focus テンプレート等）のときは業態カードを通常メニューのプールへ混ぜる（未割当は「その他」へ）。
const showAkebono = computed(() =>
  akebonoAccessible.value && effectiveLayout.value.options.showAkebono)

// ---------- 承認待ち件数（useWorkflow.pendingFor が SoT。代理承認・個人指定も考慮済み） ----------
const pendingApprovals = computed(() => pendingFor(currentUserId.value).length)

// ---------- カード型メニュー（定義 = utils/menu-registry.ts・配置 = effectiveLayout.sections） ----------
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

// 外部リンク（設定 > 外部リンク）・AKEBONO 業態アプリも基本メニューと同じくセクション配置対象にする
// （オペレーター指示 2026-08-03 #24）。未割当は categorize が「その他」へ入れる = 基本メニューと同じ挙動（消えない）
const { externalCards } = useExternalLinkCards()
const { akebonoCards } = useAkebonoAppCards()

// カードプールと専用 AKEBONO セクションの振り分け（二重表示防止 = planDashboardCards）。
// AKEBONO 利用不可時は akebonoCards を空で渡す（= どこにも出さない）。
const cardPlan = computed(() => planDashboardCards({
  internalCards: internalCards.value,
  externalCards: externalCards.value,
  akebonoCards: akebonoAccessible.value ? akebonoCards.value : [],
  sections: effectiveLayout.value.sections,
  showAkebono: showAkebono.value,
}))
const visibleCards = computed<MenuCard[]>(() => cardPlan.value.pool)
// 専用「AKEBONO 業務（業態別）」セクションが担当する未割当業態 id（割当済み業態はセクション配置側で表示）
const unassignedAkebonoIds = computed(() => cardPlan.value.unassignedAkebonoSegmentIds)

// レイアウトのセクション構成でグループ化（未割当カードは「その他」・空セクションは除去）
const menuSections = computed(() => categorizeCards(visibleCards.value, effectiveLayout.value.sections))

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
</script>

<template>
  <div>
    <UiPageHeader
      :title="`${greeting}、${currentUser.name} さん`"
      :description="todayLong"
    >
      <template #actions>
        <!-- タイムカード（ヘッダーの「タイムカード」と同一挙動。レイアウトボタンの左に配置） -->
        <button v-if="canPath('/attendance')" type="button" class="btn btn-sm" @click="punchOpen = true">
          <Clock3 class="h-3.5 w-3.5" aria-hidden="true" />
          タイムカード
        </button>
        <button type="button" class="btn btn-sm" @click="layoutOpen = true">
          <LayoutTemplate class="h-3.5 w-3.5" aria-hidden="true" />
          レイアウト
        </button>
      </template>
    </UiPageHeader>

    <!-- 通知欄の配置は「PC シーン」専用。モバイルはメニュー最優先で、通知はヘッダーのベル（未読バッジ付き）/
         下部ナビ「通知」から開く（= トップに通知欄を出さない。毎回スクロールしてメニューへ辿り着く問題を解消）。
         PC: side = 2 カラム（左メニュー / 右通知欄。lg+）・bottom = メニュー下（md+）・hidden = 通知欄なし。 -->
    <!-- grid-cols-[minmax(0,1fr)] を基底に置く: 暗黙 auto トラックだと通知の truncate（nowrap）が max-content で
         トラックを押し広げ、モバイルで横はみ出しする。minmax(0,1fr) で 0 まで縮小可にし truncate を効かせる -->
    <div class="grid grid-cols-[minmax(0,1fr)] items-start gap-4" :class="notifPlacement === 'side' ? 'lg:grid-cols-[minmax(0,1fr)_340px]' : ''">
      <!-- メイン: メニュー（モバイル・PC 共通で最上部 = メニュー最優先。順序反転はしない） -->
      <div class="grid gap-3">
        <!-- AKEBONO 業務（業態別アプリ。押下でその業態の業務へ入る = ヘッダ切替に依存しない導線）。
             メニューカテゴリへ割り当てた業態はセクション配置側に出るため、ここは未割当業態のみを表示する
             （= 二重表示を防ぐ。全業態が割当済みなら専用セクションごと出さない。2026-08-03 #24） -->
        <section v-if="showAkebono && unassignedAkebonoIds.length > 0" class="grid gap-1.5" aria-label="AKEBONO 業務">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] font-bold text-muted">AKEBONO 業務（業態別）</p>
            <span class="flex items-center gap-3">
              <NuxtLink v-if="canCompanyDashboard" to="/akebono/company" class="link text-[11px] font-semibold">会社全体ダッシュボード</NuxtLink>
              <NuxtLink to="/akebono" class="link text-[11px] font-semibold">ハブを開く</NuxtLink>
            </span>
          </div>
          <AkebonoSegmentApps :segment-ids="unassignedAkebonoIds" />
        </section>

        <!-- カード型メニュー（カテゴリチップで絞り込み） -->
        <section class="grid gap-3" aria-label="メニュー">
          <UiChipTabs v-model="selectedCategory" :options="categoryChips" aria-label="メニューカテゴリ" />
          <div v-for="sec in shownSections" :key="sec.id">
            <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
            <UiCardMenu :items="sec.cards" :dense="dense" />
          </div>
        </section>

        <!-- 通知欄（bottom = PC のみメニュー下に全幅配置。モバイルはベル/下部ナビ「通知」が導線） -->
        <div v-if="notifPlacement === 'bottom'" class="hidden md:block">
          <OfficeDashboardNotifications />
        </div>
      </div>

      <!-- 通知欄（side = PC〔lg+〕のみ右カラムに固定。モバイル/タブレットはベル/下部ナビ「通知」が導線）。
           sticky はアプリヘッダー（sticky top-0・高さ --header-h）の下へ配置し背後に潜り込ませない。
           高さ上限 = ヘッダーを除いた有効高さいっぱい。超過分はカード内（通知リスト）で内部スクロール -->
      <aside
        v-if="notifPlacement === 'side'"
        class="hidden lg:sticky lg:flex lg:flex-col"
        :style="{ top: 'calc(var(--header-h) + 0.75rem)', maxHeight: 'calc(100dvh - var(--header-h) - 1.5rem)' }"
        aria-label="通知"
      >
        <OfficeDashboardNotifications class="min-h-0" />
      </aside>
    </div>

    <!-- タイムカードモーダル（ヘッダーの「タイムカード」と同一 = PunchClock を flat 表示・操作） -->
    <UiModal :open="punchOpen" title="タイムカード" @close="punchOpen = false">
      <WidgetsPunchClock flat />
    </UiModal>

    <!-- レイアウト選択（テンプレート + プレビュー + 適用スコープ） -->
    <UiModal :open="layoutOpen" title="ダッシュボードのレイアウト" width="780px" @close="layoutOpen = false">
      <OfficeDashboardLayoutPicker />
    </UiModal>
  </div>
</template>
