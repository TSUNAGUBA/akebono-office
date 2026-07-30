<script setup lang="ts">
/**
 * 顧客ログ（独立メニュー。オペレーター指示 2026-07-30）。
 * いつ・どの顧客（会社/人）と・どんな会話をしたかを記録する。AI（チャットボット・日報アシスト）の参照対象。
 * 本人の記録は常に閲覧可・他メンバーの記録は権限で許可された対象者のみ readonly 参照可。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="顧客ログ"
      description="顧客（会社・担当者）とのやり取りを記録します。AI の参照対象（自分の記録のみ）になり、他メンバーの記録は権限で許可された場合に閲覧できます"
    />
    <WidgetsCustomerLogPanel />
  </div>
</template>
