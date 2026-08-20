<script setup lang="ts">
/**
 * 商品サムネイル（F-21-3）。商品/SKU からサムネイル画像を解決して表示する共有部品。
 * - dataUrl があれば実画像、無ければ色プレースホルダ（頭文字）、商品未解決なら画像アイコン。
 * - 各トランザクション画面（売上・在庫・出荷・入荷・発注・仕入・生産）の SKU/商品セルで再利用（原則3）。
 */
import { Image as ImageIcon } from 'lucide-vue-next'
import { thumbBoxClass, thumbFirstChar } from '~/utils/thumb'

const props = withDefaults(defineProps<{
  productId?: string | null
  skuId?: string | null
  /** 一辺の px */
  size?: number
}>(), { productId: null, skuId: null, size: 28 })

const p = useProducts()

const product = computed(() => {
  if (props.productId) return p.productById(props.productId) ?? null
  if (props.skuId) return p.productOfSku(props.skuId) ?? null
  return null
})
const dataUrl = computed(() => (product.value ? p.thumbnailOf(product.value.id)?.dataUrl ?? null : null))
const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <img
    v-if="dataUrl"
    :src="dataUrl"
    :alt="product?.name ?? ''"
    class="shrink-0 rounded border border-line object-cover"
    :style="boxStyle"
  >
  <div
    v-else-if="product"
    class="flex shrink-0 items-center justify-center rounded font-bold leading-none"
    :class="thumbBoxClass(product.id)"
    :style="{ ...boxStyle, fontSize: `${Math.round(size * 0.42)}px` }"
    aria-hidden="true"
  >
    {{ thumbFirstChar(product.name) }}
  </div>
  <div
    v-else
    class="flex shrink-0 items-center justify-center rounded border border-line bg-page text-muted"
    :style="boxStyle"
    aria-hidden="true"
  >
    <ImageIcon :size="Math.round(size * 0.5)" />
  </div>
</template>
