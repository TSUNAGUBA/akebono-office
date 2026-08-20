<script setup lang="ts">
import { Search } from 'lucide-vue-next'

withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), { placeholder: '検索' })

const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <div class="relative">
    <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
    <input
      :value="modelValue"
      type="search"
      class="input !pl-8 w-52 max-w-full"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >
  </div>
</template>
