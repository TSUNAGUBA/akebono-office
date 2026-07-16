<script setup lang="ts">
import type { Tone } from '~/types/ui'

const props = withDefaults(defineProps<{
  tone?: Tone
  label: string
  /** 状態を示す点を付ける */
  dot?: boolean
}>(), { tone: 'neutral', dot: false })

const toneClass = computed(() => ({
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  serious: 'bg-serious-soft text-serious',
  crit: 'bg-crit-soft text-crit',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand',
  neutral: 'bg-[#eef0f2] text-sub',
}[props.tone]))
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
    :class="toneClass"
  >
    <span v-if="dot" class="inline-block h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
    {{ label }}
  </span>
</template>
