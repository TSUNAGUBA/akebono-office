<script setup lang="ts">
import { Bot } from 'lucide-vue-next'
import { hashStr } from '~/utils/rng'

const props = withDefaults(defineProps<{
  name: string
  kind?: 'human' | 'ai'
  size?: 'sm' | 'md' | 'lg'
}>(), { kind: 'human', size: 'md' })

const AVATAR_BG = ['#dbe7f6', '#dcf1e7', '#faeeda', '#e8e3fa', '#fae3ea', '#dff0f4'] as const

const bg = computed(() => AVATAR_BG[hashStr(props.name) % AVATAR_BG.length])
const initial = computed(() => props.name.slice(0, 1))
const sizeClass = computed(() => ({
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-11 w-11 text-base',
}[props.size]))
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-ink"
    :class="sizeClass"
    :style="{ backgroundColor: bg }"
    :title="name"
  >
    <Bot v-if="kind === 'ai'" class="h-[60%] w-[60%] text-brand" aria-hidden="true" />
    <template v-else>{{ initial }}</template>
  </span>
</template>
