<script setup lang="ts">
/**
 * 顧客コンテキスト（改修依頼 2026-08-20: トップ層メニュー）。
 * 顧客(会社)を選ぶと、マスタの基本情報・関係に加えて定性情報（ビジョン・経営課題・補足メモ・事業メモ）・
 * 定量情報（案件・活動のライブ集計）・時系列メモを 1 画面で確認・編集できる。
 * AI の Web 調査（リサーチ）で定性情報を更新でき、反映はいつでも取り消せる。実体は WidgetsCustomerContextPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="顧客コンテキスト"
      description="顧客の基本情報・関係・定性/定量情報・メモを 1 画面で確認し、この画面から登録・修正できます。AI の Web 調査で定性情報を更新することもできます"
    />
    <WidgetsCustomerContextPanel />
  </div>
</template>
