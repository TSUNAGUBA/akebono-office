<script setup lang="ts">
import * as icons from 'lucide-vue-next'
import type { Tone } from '~/types/ui'

const props = withDefaults(defineProps<{
  label: string
  value: string
  sub?: string
  /** 前期比等。正負で色分け（inverse で反転） */
  delta?: number | null
  inverse?: boolean
  icon?: string
  tone?: Tone
  to?: string
}>(), { sub: '', delta: null, inverse: false, icon: '', tone: 'neutral', to: '' })

const iconComp = computed(() => {
  if (!props.icon) return null
  return (icons as Record<string, unknown>)[props.icon] ?? null
})

const deltaTone = computed(() => {
  if (props.delta === null) return ''
  const positive = props.inverse ? props.delta < 0 : props.delta > 0
  if (props.delta === 0) return 'text-sub'
  return positive ? 'text-ok' : 'text-crit'
})

const deltaText = computed(() => {
  if (props.delta === null) return ''
  const sign = props.delta > 0 ? '+' : ''
  return `${sign}${(props.delta * 100).toFixed(1)}%`
})
</script>

<template>
  <component
    :is="to ? resolveComponent('NuxtLink') : 'div'"
    :to="to || undefined"
    class="card block px-3 py-2.5"
    :class="to ? 'transition-colors hover:border-brand cursor-pointer' : ''"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] font-semibold text-muted">{{ label }}</p>
      <component :is="iconComp" v-if="iconComp" class="h-4 w-4 text-muted" aria-hidden="true" />
    </div>
    <p class="num mt-0.5 text-xl font-bold leading-tight">{{ value }}</p>
    <p v-if="sub || delta !== null" class="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
      <span v-if="delta !== null" class="num font-semibold" :class="deltaTone">{{ deltaText }}</span>
      <span class="text-muted">{{ sub }}</span>
    </p>
  </component>
</template>
