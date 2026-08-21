<script setup lang="ts">
/**
 * 顧客別ダッシュボード（改善要望 2026-08-21・F-54。ダッシュボード「営業管理」セクション）
 * 顧客マスタ・顧客ログを軸に、基本情報・属性・顧客コンテキスト・AI 分析を顧客ごとに可視化する。
 * 実体は WidgetsCustomerDashboardPanel（?company= ディープリンク対応）。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="顧客別ダッシュボード"
      description="顧客ごとに基本情報・顧客コンテキスト・活動実績と AI 分析を 1 画面で確認し、詳細へドリルダウンできます"
    />
    <WidgetsCustomerDashboardPanel />
  </div>
</template>
