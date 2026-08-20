<script setup lang="ts">
/**
 * モック実装マーク。API モード（実データ運用）時のみ表示し、
 * 「この画面・機能はまだデモデータで動いている」ことを利用者へ明示する。
 * モックモード（デモ配信）では全機能がモックのため表示しない。
 */
withDefaults(defineProps<{ label?: string }>(), { label: 'モックアップ' })

const isApi = useApiMode()
</script>

<template>
  <UiStatusBadge v-if="isApi" :label="label" tone="warn" />
</template>
