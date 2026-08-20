<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string[]
  options: { value: string; label: string }[]
  ariaLabel?: string
}>(), { ariaLabel: '複数選択' })

const emit = defineEmits<{ 'update:modelValue': [v: string[]] }>()

function toggle(value: string): void {
  const set = new Set(props.modelValue)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  emit('update:modelValue', [...set])
}
</script>

<template>
  <div class="flex flex-wrap gap-1" role="group" :aria-label="ariaLabel">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
      :class="modelValue.includes(o.value)
        ? 'border-brand bg-brand-soft text-brand'
        : 'border-line-strong bg-surface text-sub hover:border-muted'"
      :aria-pressed="modelValue.includes(o.value)"
      @click="toggle(o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
