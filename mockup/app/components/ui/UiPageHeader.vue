<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()

// API モード時、モック実装のページには自動でバッジを付ける（判定は utils/mock-status.ts）
const route = useRoute()
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <div>
      <h1 class="flex flex-wrap items-center gap-2 text-lg font-bold leading-tight">
        {{ title }}
        <UiMockBadge v-if="isMockPage(route.path)" label="モックアップ（デモデータ）" />
      </h1>
      <p v-if="description" class="mt-0.5 text-xs text-sub">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
