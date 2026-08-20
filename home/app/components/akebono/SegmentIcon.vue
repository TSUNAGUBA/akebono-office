<script setup lang="ts">
/**
 * 業態アプリのアイコン（F-20 拡張。2026-07-28）。
 * - appIconImage（data URI）があれば実画像、無ければ appIcon（lucide キー・業種既定へフォールバック）。
 * - トップの業態アプリカード・業態アプリ設定のプレビューで共有（原則3）。
 */
import * as icons from 'lucide-vue-next'
import type { BusinessSegment } from '~/types/akebono'
import { segmentIconKey } from '~/utils/akebono'

const props = withDefaults(defineProps<{
  segment: Pick<BusinessSegment, 'industryType' | 'appIcon' | 'appIconImage' | 'name' | 'appName'>
  /** 一辺の px（アイコン枠） */
  size?: number
}>(), { size: 36 })

const image = computed(() => props.segment.appIconImage?.trim() || null)
function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Sunrise
}
const iconComp = computed(() => iconOf(segmentIconKey(props.segment)))
const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <img
    v-if="image"
    :src="image"
    :alt="segment.appName || segment.name"
    class="shrink-0 rounded-lg border border-line object-cover"
    :style="boxStyle"
  >
  <span
    v-else
    class="flex shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"
    :style="boxStyle"
    aria-hidden="true"
  >
    <component :is="iconComp" :size="Math.round(size * 0.55)" />
  </span>
</template>
