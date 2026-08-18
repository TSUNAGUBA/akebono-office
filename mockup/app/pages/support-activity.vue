<script setup lang="ts">
/**
 * サポート活動（改修依頼 2026-08-18・F-43）。
 * 顧客サポートの受付〜解決（問い合わせ内容・対応・原因・解決・改善ナレッジのタネ）を記録・管理する。
 * チーム共有の記録系 = 全員が閲覧・登録・編集できる。実体は WidgetsSupportActivityPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="サポート活動"
      description="顧客サポートの受付から解決までを記録します。対応内容・原因・解決内容と、改善・ナレッジのタネをチームで共有できます"
    />
    <WidgetsSupportActivityPanel />
  </div>
</template>
