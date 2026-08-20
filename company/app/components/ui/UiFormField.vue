<script setup lang="ts">
defineProps<{
  label: string
  required?: boolean
  error?: string
  hint?: string
}>()
</script>

<template>
  <div>
    <label class="label">
      {{ label }}
      <span v-if="required" class="ml-0.5 text-crit" aria-label="必須">*</span>
    </label>
    <slot />
    <p v-if="error" class="mt-1 text-[11px] font-medium text-crit" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="mt-1 text-[11px] text-muted">{{ hint }}</p>
  </div>
</template>
