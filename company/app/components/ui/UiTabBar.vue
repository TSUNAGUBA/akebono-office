<script setup lang="ts">
import type { TabItem } from '~/types/ui'

const props = defineProps<{
  tabs: TabItem[]
  modelValue: string
}>()
const emit = defineEmits<{ 'update:modelValue': [key: string] }>()

const tabRefs = ref<(HTMLButtonElement | null)[]>([])

function onKeydown(e: KeyboardEvent, idx: number): void {
  let next = -1
  if (e.key === 'ArrowRight') next = (idx + 1) % props.tabs.length
  else if (e.key === 'ArrowLeft') next = (idx - 1 + props.tabs.length) % props.tabs.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = props.tabs.length - 1
  if (next >= 0) {
    e.preventDefault()
    const t = props.tabs[next]
    if (t) {
      emit('update:modelValue', t.key)
      tabRefs.value[next]?.focus()
    }
  }
}
</script>

<template>
  <div role="tablist" class="flex gap-0.5 overflow-x-auto border-b border-line scroll-slim" aria-label="タブ">
    <button
      v-for="(t, i) in tabs"
      :key="t.key"
      :ref="el => { tabRefs[i] = el as HTMLButtonElement | null }"
      role="tab"
      type="button"
      :aria-selected="modelValue === t.key"
      :tabindex="modelValue === t.key ? 0 : -1"
      class="relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-[13px] font-medium transition-colors"
      :class="modelValue === t.key ? 'text-brand' : 'text-sub hover:text-ink'"
      @click="emit('update:modelValue', t.key)"
      @keydown="onKeydown($event, i)"
    >
      {{ t.label }}
      <span
        v-if="t.badge !== undefined && t.badge > 0"
        class="num rounded-full bg-crit px-1.5 text-[10px] font-bold leading-4 text-white"
      >{{ t.badge }}</span>
      <span
        v-if="modelValue === t.key"
        class="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
