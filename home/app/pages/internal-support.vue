<script setup lang="ts">
/**
 * 社内サポート活動（改善要望 2026-08-22・F-57）
 * 社内メンバーどうしのフォローアップ（業務支援・技術支援・教育等）を時系列で記録する。
 * 実体は WidgetsInternalSupportPanel（一覧・登録/編集・詳細ドロワー・取消/復元）。
 * 記録は AKEBONO Intelligence の AI 分析（ナレッジカテゴリ「社内サポート」）の材料になる。
 */
</script>

<template>
  <div>
    <UiPageHeader
      title="社内サポート活動"
      description="メンバーへのフォローアップ（業務支援・技術支援・教育など）を記録し、チームで共有します。記録は AKEBONO Intelligence の AI 分析に活用されます"
    />
    <WidgetsInternalSupportPanel />
  </div>
</template>
