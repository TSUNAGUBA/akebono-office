<script setup lang="ts">
/**
 * 月報（F-06。改修依頼 2026-08-20 第2バッチ）
 * 日報（/reports）配下の ?kind=monthly から独立したトップレベルページ。
 * - タブ: 自分の月報（mine）/ 全員の月報（all）/ チーム（team）。各ビューは ReportsPeriodPanel（週報と同型）
 * - タブ権限 = 権限表の機能キー 'monthly-report' × `tab:<key>`（旧 'reports' からの動的継承は撤去 =
 *   改善要望 2026-08-21。旧ルールは migration 0078 で新キーへ物理移行済み = 権限表に見えるルールが実効ルール）
 * - 旧 URL（/reports?kind=monthly・?tab=monthly-*）は reports.vue が本ページへ replace リダイレクトする
 * - パンくずの親はホーム（nav-map。日報を親に出さない = 本改修の眼目）
 */
const TABS = [
  { key: 'mine', label: '自分の月報' },
  { key: 'all', label: '全員の月報' },
  { key: 'team', label: 'チーム' },
]

// タブ利用可否（権限表の `tab:<key>` 擬似フィールド = 改修依頼 2026-08-18。既定 = 全タブ利用可）
const { canTab } = usePermissions()
const tabs = computed(() => TABS.filter(t => canTab('monthly-report', t.key)))
const tab = ref<string>(tabs.value[0]?.key ?? '')
useRouteTabSync(tab, { valid: TABS.map(t => t.key) })
watchEffect(() => {
  // 権限で消えたタブ・無効キーは先頭の利用可能タブへ退避。
  // 全タブ deny の場合は空値にしてどのタブ内容も描画しない（フェイルクローズ = 現行踏襲）
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = tabs.value[0]?.key ?? ''
})
</script>

<template>
  <div>
    <UiPageHeader title="月報" description="月次のふりかえり。今月の成果・課題・来月の最重要テーマを記録します" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />
    <!-- 全タブ deny 時の空状態（タブ内容は tab='' のためどれも描画されない = フェイルクローズ） -->
    <p v-if="tabs.length === 0" class="card p-6 text-center text-[13px] text-sub">利用できるタブがありません（権限設定で制限されています。管理者にお問い合わせください）</p>

    <ReportsPeriodPanel v-if="tab === 'mine'" kind="monthly" view="mine" />
    <ReportsPeriodPanel v-else-if="tab === 'all'" kind="monthly" view="all" />
    <ReportsPeriodPanel v-else-if="tab === 'team'" kind="monthly" view="team" />
  </div>
</template>
