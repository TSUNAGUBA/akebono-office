<script setup lang="ts">
import * as icons from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  icon?: string
  title: string
  hint?: string
}>(), { icon: 'Inbox', hint: '' })

const iconComp = computed(() => (icons as Record<string, unknown>)[props.icon] ?? icons.Inbox)
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
    <component :is="iconComp" class="h-8 w-8 text-line-strong" aria-hidden="true" />
    <p class="text-[13px] font-semibold text-sub">{{ title }}</p>
    <p v-if="hint" class="text-xs text-muted">{{ hint }}</p>
    <div v-if="$slots.action" class="mt-1.5">
      <slot name="action" />
    </div>
  </div>
</template>
