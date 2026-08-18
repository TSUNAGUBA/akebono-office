<script setup lang="ts">
/**
 * 説明付き単一選択カード（少数の選択肢を、全件の説明文を見ながら選ぶ用途。
 * 稟議「区分」= 改修依頼 2026-08-18。トーンは DashboardLayoutPicker / UiChipTabs と同系）。
 * WAI-ARIA ラジオグループの作法に従い、Tab はグループへ 1 ストップ（roving tabindex =
 * 選択中のみ tabindex 0）・矢印キーで選択を移動する（R1 レビュー反映）。
 */
const props = withDefaults(defineProps<{
  modelValue: string
  options: { value: string; label: string; description?: string }[]
  ariaLabel?: string
}>(), { ariaLabel: '選択肢' })

const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

function select(value: string): void {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

/** roving tabindex: 選択中（未選択時は先頭）のみ Tab ストップにする */
function tabindexOf(value: string, index: number): number {
  const hasChecked = props.options.some(o => o.value === props.modelValue)
  return (hasChecked ? value === props.modelValue : index === 0) ? 0 : -1
}

const groupEl = ref<HTMLElement | null>(null)

/** 矢印キーで前後の選択肢へ移動して選択 + フォーカス（radiogroup の標準操作） */
function onKeydown(e: KeyboardEvent, index: number): void {
  const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (delta === 0) return
  e.preventDefault()
  const n = props.options.length
  if (n === 0) return
  const next = props.options[(index + delta + n) % n]!
  select(next.value)
  const btns = groupEl.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  btns?.[(index + delta + n) % n]?.focus()
}
</script>

<template>
  <div ref="groupEl" class="grid gap-1.5 sm:grid-cols-2" role="radiogroup" :aria-label="ariaLabel">
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      :tabindex="tabindexOf(o.value, i)"
      class="min-h-11 rounded-xl border px-2.5 py-1.5 text-left transition-colors"
      :class="modelValue === o.value
        ? 'border-brand bg-brand-soft text-brand'
        : 'border-line-strong bg-surface hover:border-muted'"
      @click="select(o.value)"
      @keydown="onKeydown($event, i)"
    >
      <span class="block text-[13px] font-bold">{{ o.label }}</span>
      <span v-if="o.description" class="mt-0.5 block text-[11px] leading-relaxed text-muted">{{ o.description }}</span>
    </button>
  </div>
</template>
