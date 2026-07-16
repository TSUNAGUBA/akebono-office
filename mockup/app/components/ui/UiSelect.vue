<script setup lang="ts">
withDefaults(defineProps<{
  modelValue: string
  options: { value: string; label: string }[]
  /** 先頭に置く「すべて」等の空選択肢ラベル。空文字で非表示 */
  emptyLabel?: string
  ariaLabel?: string
}>(), { emptyLabel: '', ariaLabel: '選択' })

const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <select
    :value="modelValue"
    class="select w-auto"
    :aria-label="ariaLabel"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="emptyLabel" value="">{{ emptyLabel }}</option>
    <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
  </select>
</template>
