<script setup lang="ts">
/**
 * 共通ボタン（実行中フィードバック対応。オペレーター指示 2026-07-21 #3）。
 * - `.btn` 系デザイントークン（main.css）をそのまま踏襲。variant / size をプロパティで指定
 * - `loading` でプログレスサークル（Loader2 の回転）を先頭アイコン位置へ表示し、押下を無効化
 * - 先頭アイコンは #icon スロットで渡す（loading 中はスピナーへ差し替わる）。ラベルは既定スロット
 * - class 属性は素の <button> へフォールスルーで合流する（w-full・ml-auto・text-crit 等をそのまま付与可）
 */
import { Loader2 } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  /** 実行中（プログレスサークル表示 + 押下無効化）。useAsyncAction の isRunning を束ねる */
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit'
  /** 横幅いっぱい + 中央寄せ（w-full justify-center のショートカット） */
  block?: boolean
}>(), { variant: 'default', size: 'md', loading: false, disabled: false, type: 'button', block: false })

const emit = defineEmits<{ click: [ev: MouseEvent] }>()

const classes = computed(() => [
  'btn',
  {
    'btn-primary': props.variant === 'primary',
    'btn-danger': props.variant === 'danger',
    'btn-ghost': props.variant === 'ghost',
    'btn-sm': props.size === 'sm',
    'btn-lg': props.size === 'lg',
    'w-full justify-center': props.block,
  },
])

/** スピナー寸法は小サイズだけ一段小さくして既存アイコン（h-3.5）と揃える */
const spinnerClass = computed(() => (props.size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'))

function onClick(ev: MouseEvent): void {
  if (props.loading || props.disabled) return
  emit('click', ev)
}
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <Loader2 v-if="loading" :class="spinnerClass" class="animate-spin" aria-hidden="true" />
    <slot v-else name="icon" />
    <slot />
  </button>
</template>
