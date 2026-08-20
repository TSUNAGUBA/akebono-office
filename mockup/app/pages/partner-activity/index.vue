<script setup lang="ts">
/**
 * ビジネスパートナー活動 案件一覧（改修依頼 2026-08-18・F-45 → 2026-08-20 改修で
 * 「案件ヘッダー + 活動ログ」構造へ再編）。
 * 案件（連携テーマ）の基本情報を一覧し、行クリックで案件詳細（/partner-activity/<id>）へ遷移する。
 * チーム共有の記録系 = 全員が閲覧・登録・編集できる。実体は WidgetsPartnerActivityPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="ビジネスパートナー活動"
      description="パートナー連携のテーマを案件として登録し、活動ログを積み上げて進捗を管理します。案件を選ぶと基本情報・AI集約・活動ログを確認できます"
    />
    <WidgetsPartnerActivityPanel />
  </div>
</template>
