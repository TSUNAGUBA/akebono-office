<script setup lang="ts">
/**
 * 説明付き単一選択カード（少数の選択肢を、全件の説明文を見ながら選ぶ用途。
 * 稟議「区分」= 改修依頼 2026-08-18。トーンは DashboardLayoutPicker / UiChipTabs と同系）
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
</script>

<template>
  <div class="grid gap-1.5 sm:grid-cols-2" role="radiogroup" :aria-label="ariaLabel">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      class="min-h-11 rounded-xl border px-2.5 py-1.5 text-left transition-colors"
      :class="modelValue === o.value
        ? 'border-brand bg-brand-soft text-brand'
        : 'border-line-strong bg-surface hover:border-muted'"
      @click="select(o.value)"
    >
      <span class="block text-[13px] font-bold">{{ o.label }}</span>
      <span v-if="o.description" class="mt-0.5 block text-[11px] leading-relaxed text-muted">{{ o.description }}</span>
    </button>
  </div>
</template>
