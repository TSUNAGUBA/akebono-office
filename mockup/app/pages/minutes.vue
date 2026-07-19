<script setup lang="ts">
/**
 * 議事録（登録メニュー。バッチ7c・オペレーター指示 2026-07-19 #4)
 * 任意でプロジェクト・顧客・業務種別を紐付けられる。全員参照（C2）。
 * AI（チャットボット・業務アシスタント）の参照対象
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="議事録"
      description="会議の記録を蓄積します。全員が参照でき、AI の参照対象になります"
    />
    <WidgetsNotesPanel kind="minutes" show-author />
  </div>
</template>
