<script setup lang="ts">
/**
 * ぽいぽいメモ（独立メニュー。バッチ7c・オペレーター指示 2026-07-19 #4）
 * AI業務アシスタントの入力機能から独立。任意でプロジェクト・顧客・業務種別を紐付けられる。
 * 本人のみ参照（C3）。日報ドラフトの材料 + AI（チャットボット・業務アシスタント）の参照対象
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="ぽいぽいメモ"
      description="思いついたことを投げ込むメモ。日報ドラフトの材料になり、AI の参照対象（自分のみ）になります"
    />
    <WidgetsNotesPanel kind="poipoi" />
  </div>
</template>
