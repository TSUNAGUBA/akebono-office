<script setup lang="ts">
// 未定義ルートのセーフティネット（リンク切れを「無反応」で終わらせない）
import { House } from 'lucide-vue-next'

const route = useRoute()
</script>

<template>
  <div class="mx-auto max-w-md py-12">
    <UiEmptyState
      icon="MapPinOff"
      title="ページが見つかりません"
      :hint="`「${route.path}」に対応する画面はまだありません。`"
    >
      <template #action>
        <NuxtLink to="/" class="btn btn-primary">
          <House class="h-4 w-4" aria-hidden="true" /> ダッシュボードへ戻る
        </NuxtLink>
      </template>
    </UiEmptyState>
  </div>
</template>
