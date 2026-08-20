<script setup lang="ts">
/**
 * アイコングリフ（画像 or lucide アイコン）。
 * - image（data URI）があれば実画像、無ければ icon（lucide キー・fallback へフォールバック）。
 * - 外部リンク（設定リスト・カードメニュー・アイコンピッカーのプレビュー）で共有（原則3・重複排除）。
 *   AkebonoSegmentIcon の汎用版（業態レコードに依存しない）。
 */
import * as icons from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** lucide アイコンキー（image 未設定時に使用） */
  icon?: string
  /** アイコン画像（data URI。設定時は icon より優先） */
  image?: string | null
  /** 枠の一辺（px） */
  size?: number
  /** 画像の alt（読み上げ用。未指定なら装飾扱い） */
  alt?: string
  /** icon が未検出のときのフォールバックキー */
  fallback?: string
}>(), { icon: '', image: null, size: 36, alt: '', fallback: 'LayoutGrid' })

const image = computed(() => props.image?.trim() || null)
const iconComp = computed(() => {
  const map = icons as Record<string, unknown>
  return map[props.icon] ?? map[props.fallback] ?? icons.LayoutGrid
})
const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <img
    v-if="image"
    :src="image"
    :alt="alt"
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
