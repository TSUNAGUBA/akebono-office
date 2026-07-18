<script setup lang="ts">
/**
 * スキーマ駆動フォーム（カスタム項目 F-13-1 の描画基盤）
 * FieldDef[] からフォームを動的生成する。値は `custom.xxx` のようなドット表記キーに対応。
 */
import type { FieldDef } from '~/types/ui'

const props = defineProps<{
  fields: FieldDef[]
  modelValue: Record<string, unknown>
  errors?: Record<string, string>
}>()
const emit = defineEmits<{ 'update:modelValue': [v: Record<string, unknown>] }>()

function getValue(key: string): unknown {
  const parts = key.split('.')
  let cur: unknown = props.modelValue
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function setValue(key: string, value: unknown): void {
  const next = structuredClone(toRaw(props.modelValue)) as Record<string, unknown>
  const parts = key.split('.')
  let cur = next
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
  emit('update:modelValue', next)
}

function strValue(key: string): string {
  const v = getValue(key)
  return v == null ? '' : String(v)
}

function arrValue(key: string): string[] {
  const v = getValue(key)
  return Array.isArray(v) ? v.map(String) : []
}
</script>

<template>
  <div class="grid gap-3">
    <UiFormField
      v-for="f in fields"
      :key="f.key"
      :label="f.label"
      :required="f.required"
      :error="errors?.[f.key]"
      :hint="f.hint"
    >
      <input
        v-if="f.type === 'text'"
        :value="strValue(f.key)"
        type="text"
        class="input"
        :placeholder="f.placeholder"
        @input="setValue(f.key, ($event.target as HTMLInputElement).value)"
      >
      <textarea
        v-else-if="f.type === 'textarea'"
        :value="strValue(f.key)"
        class="textarea"
        :placeholder="f.placeholder"
        @input="setValue(f.key, ($event.target as HTMLTextAreaElement).value)"
      />
      <!-- 空欄は '' のまま保持する（Number('') = 0 で空欄にできなくなる実バグの修正。
           「空欄 = 未設定（null）」を持つ項目（休暇種別の使用期限等）は保存側で '' → null 変換する -->
      <input
        v-else-if="f.type === 'number'"
        :value="strValue(f.key)"
        type="number"
        class="input num"
        :min="f.min"
        :max="f.max"
        :step="f.step"
        @input="setValue(f.key, ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))"
      >
      <input
        v-else-if="f.type === 'date'"
        :value="strValue(f.key)"
        type="date"
        class="input"
        @input="setValue(f.key, ($event.target as HTMLInputElement).value)"
      >
      <input
        v-else-if="f.type === 'time'"
        :value="strValue(f.key)"
        type="time"
        class="input"
        @input="setValue(f.key, ($event.target as HTMLInputElement).value)"
      >
      <select
        v-else-if="f.type === 'select'"
        :value="strValue(f.key)"
        class="select"
        :aria-label="f.label"
        @change="setValue(f.key, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ f.emptyLabel ?? '選択してください' }}</option>
        <option v-for="o in f.options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <UiChipSelect
        v-else-if="f.type === 'multiselect'"
        :model-value="arrValue(f.key)"
        :options="f.options ?? []"
        :aria-label="f.label"
        @update:model-value="setValue(f.key, $event)"
      />
      <label v-else-if="f.type === 'boolean'" class="flex cursor-pointer items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          class="h-4 w-4 accent-[var(--c-brand)]"
          :checked="Boolean(getValue(f.key))"
          @change="setValue(f.key, ($event.target as HTMLInputElement).checked)"
        >
        <span class="text-sub">有効にする</span>
      </label>
    </UiFormField>
  </div>
</template>
