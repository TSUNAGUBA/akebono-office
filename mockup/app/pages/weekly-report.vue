<script setup lang="ts">
/**
 * 週報（F-06。改修依頼 2026-08-20 第2バッチ）
 * 日報（/reports）配下の ?kind=weekly から独立したトップレベルページ。
 * - タブ: 自分の週報（mine）/ 全員の週報（all）/ チーム（team）
 * - タブ権限 = 権限表の機能キー 'weekly-report' × `tab:<key>`（新キーのルール未設定の間は
 *   旧 'reports' の `tab:weekly-*` ルールを継承 = usePermissions.canTab のフォールバック。原則7）
 * - 旧 URL（/reports?kind=weekly・?tab=weekly-*）は reports.vue が本ページへ replace リダイレクトする
 * - パンくずの親はホーム（nav-map。日報を親に出さない = 本改修の眼目）
 */
const TABS = [
  { key: 'mine', label: '自分の週報' },
  { key: 'all', label: '全員の週報' },
  { key: 'team', label: 'チーム' },
]

// タブ利用可否（権限表の `tab:<key>` 擬似フィールド = 改修依頼 2026-08-18。既定 = 全タブ利用可）
const { canTab } = usePermissions()
const tabs = computed(() => TABS.filter(t => canTab('weekly-report', t.key)))
const tab = ref<string>(tabs.value[0]?.key ?? '')
useRouteTabSync(tab, { valid: TABS.map(t => t.key) })
watchEffect(() => {
  // 権限で消えたタブ・無効キーは先頭の利用可能タブへ退避。
  // 全タブ deny の場合は空値にしてどのタブ内容も描画しない（フェイルクローズ = 現行踏襲）
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = tabs.value[0]?.key ?? ''
})

// チームタブの表示形式（複数週マトリクス / 単週。改修要望: 直近 4/8/12 週をまとめて確認）
// 既定 = 複数週マトリクス（要望が「まとめて確認したい」のため）。単週は従来の PeriodPanel（詳細 + ドロワー）
const weeklyTeamView = ref('matrix')
const WEEKLY_TEAM_VIEW_TABS = [
  { value: 'matrix', label: '複数週まとめて' },
  { value: 'single', label: '単週の詳細' },
]
</script>

<template>
  <div>
    <UiPageHeader title="週報" description="週次のふりかえり。今週の成果・課題・来週の最重要テーマを記録します" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />
    <!-- 全タブ deny 時の空状態（タブ内容は tab='' のためどれも描画されない = フェイルクローズ） -->
    <p v-if="tabs.length === 0" class="card p-6 text-center text-[13px] text-sub">利用できるタブがありません（権限設定で制限されています。管理者にお問い合わせください）</p>

    <ReportsWeeklyMinePanel v-if="tab === 'mine'" />
    <ReportsWeeklyAllPanel v-else-if="tab === 'all'" />
    <div v-else-if="tab === 'team'" class="grid gap-3">
      <UiChipTabs v-model="weeklyTeamView" :options="WEEKLY_TEAM_VIEW_TABS" aria-label="チーム週報の表示形式" />
      <ReportsWeeklySubmissionMatrix v-if="weeklyTeamView === 'matrix'" />
      <ReportsPeriodPanel v-else kind="weekly" view="team" />
    </div>
  </div>
</template>
