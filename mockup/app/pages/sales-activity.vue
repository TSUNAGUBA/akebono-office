<script setup lang="ts">
/**
 * 営業活動（改修依頼 2026-08-18・F-44）。
 * 商談の履歴と進捗（フェーズ・金額・確度・Next Action）を管理する。
 * チーム共有の記録系 = 全員が閲覧・登録・編集できる。実体は WidgetsSalesActivityPanel。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="営業活動"
      description="商談の履歴と進捗を管理します。商談フェーズ・金額・受注確度・Next Action をチームで共有できます"
    />
    <WidgetsSalesActivityPanel />
  </div>
</template>
