<script setup lang="ts">
/**
 * 営業活動 案件一覧（改修依頼 2026-08-18・F-44 → 2026-08-20 改修で「案件ヘッダー + 活動ログ」構造へ再編）。
 * 案件（商談）の基本情報を一覧し、行クリックで案件詳細（/sales-activity/<id>）へ遷移する。
 * チーム共有の記録系 = 全員が閲覧・登録・編集できる。実体は WidgetsSalesActivityPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="営業活動"
      description="商談を案件として登録し、活動ログを積み上げて進捗を管理します。案件を選ぶと基本情報・AI集約・活動ログを確認できます"
    />
    <WidgetsSalesActivityPanel />
  </div>
</template>
