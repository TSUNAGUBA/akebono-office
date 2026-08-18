<script setup lang="ts">
/**
 * ビジネスパートナー活動（改修依頼 2026-08-18・F-45）。
 * パートナー連携のテーマ（紹介/共創/案件支援/情報交換）と進捗を記録・管理する。
 * チーム共有の記録系 = 全員が閲覧・登録・編集できる。実体は WidgetsPartnerActivityPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="ビジネスパートナー活動"
      description="ビジネスパートナーとの連携活動（紹介・共創・案件支援など）を記録します。案件化したら関連商談（営業活動）へリンクできます"
    />
    <WidgetsPartnerActivityPanel />
  </div>
</template>
