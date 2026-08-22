<script setup lang="ts">
/**
 * 営業アプローチリスト（改善要望 2026-08-21・F-53。ダッシュボード「営業管理」セクション）
 * 顧客基本情報・顧客属性・顧客コンテキストを基に、アプローチする顧客を 1社1行で管理する。
 * 実体は WidgetsSalesApproachPanel（一覧・登録/編集・詳細ドロワー・取消/復元）。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="営業アプローチリスト"
      description="顧客基本情報・属性・顧客コンテキストと合わせて、アプローチ状況（状態・優先度・担当・次のアクション）をチームで管理します"
    />
    <WidgetsSalesApproachPanel />
  </div>
</template>
