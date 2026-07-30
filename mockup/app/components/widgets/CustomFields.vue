<script setup lang="ts">
/**
 * アプリの追加カスタム項目セクション（F-31 汎用化）。
 * entity のカスタム項目（useAppFields）を UiSchemaForm で描画し、値をレコードの custom 配下に読み書きする。
 * 各 Akebono アプリのフォームへ 1 行で差し込める（既定項目の下に配置）。カスタム項目が無ければ何も描画しない。
 */
import type { FieldDef } from '~/types/ui'

const props = defineProps<{
  entity: string
  modelValue: Record<string, unknown>
  errors?: Record<string, string>
}>()
const emit = defineEmits<{ 'update:modelValue': [v: Record<string, unknown>] }>()

const { customFormSchema } = useAppFields()
const fields = computed<FieldDef[]>(() => customFormSchema(props.entity))
</script>

<template>
  <div v-if="fields.length" class="grid gap-3">
    <p class="text-[12px] font-semibold text-sub">追加項目</p>
    <UiSchemaForm
      :fields="fields"
      :model-value="modelValue"
      :errors="errors"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
