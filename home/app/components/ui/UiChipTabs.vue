<script setup lang="ts">
/** 単一選択のチップ行（カードメニューのカテゴリ切替等。UiChipSelect の単一選択版。バッチ7h） */
const props = withDefaults(defineProps<{
  modelValue: string
  options: { value: string; label: string }[]
  ariaLabel?: string
}>(), { ariaLabel: 'カテゴリ選択' })

const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

function select(value: string): void {
  if (value !== props.modelValue) emit('update:modelValue', value)
}
</script>

<template>
  <div class="flex flex-wrap gap-1.5" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="tab"
      class="min-h-8 rounded-full border px-3 py-1 text-xs font-semibold transition-colors"
      :class="modelValue === o.value
        ? 'border-brand bg-brand-soft text-brand'
        : 'border-line-strong bg-surface text-sub hover:border-muted'"
      :aria-selected="modelValue === o.value"
      @click="select(o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
