<script setup lang="ts">
/**
 * マスタ参照の単一選択オートコンプリート（UiSelect のドロップイン置換。オペレーター指示 2026-08-10）。
 * UiCombobox（自由入力あり）を「選択専用（allowCreate=false）」で包み、**単一 v-model（id）** に集約する。
 * 入力欄の表示テキストは内部管理し、選択 id が外部変更されたらラベルへ同期する（入力中は上書きしない）。
 * 絞り込みは UiCombobox 側で normalizeSearch（大文字小文字・全角半角を吸収）。
 */
const props = withDefaults(defineProps<{
  modelValue: string
  options: { value: string; label: string }[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}>(), { placeholder: '入力して選択', ariaLabel: '項目を選択', disabled: false })

const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

const text = ref('')
// 選択 id が外部で変わったらラベルへ同期。id が空のときは入力中テキストを消さない（自由入力の途中を保護）
watch(() => props.modelValue, (id) => {
  if (id) text.value = props.options.find(o => o.value === id)?.label ?? text.value
  else if (!text.value) text.value = ''
}, { immediate: true })
// オプションが後から届く（マスタ読込）ケースで、選択済み id のラベルを解決し直す
watch(() => props.options, () => {
  if (props.modelValue) text.value = props.options.find(o => o.value === props.modelValue)?.label ?? text.value
})
</script>

<template>
  <UiCombobox
    :model-value="modelValue"
    :text="text"
    :options="options"
    :allow-create="false"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @update:model-value="v => emit('update:modelValue', v)"
    @update:text="v => text = v"
  />
</template>
