<script setup lang="ts">
defineProps<{
  title?: string
  description?: string
  /** カード内 padding をなくす（テーブル直置き用） */
  flush?: boolean
}>()
</script>

<template>
  <section class="card overflow-hidden">
    <header v-if="title || $slots.actions" class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div>
        <h2 class="text-[13px] font-bold">{{ title }}</h2>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="flex items-center gap-1.5">
        <slot name="actions" />
      </div>
    </header>
    <div :class="flush ? '' : 'p-3'">
      <slot />
    </div>
  </section>
</template>
