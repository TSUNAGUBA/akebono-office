<script setup lang="ts">
/**
 * 複数選択オートコンプリート（論理名で検索して選ぶ。オペレーター指示 2026-07-19）。
 * - 入力でオプションを部分一致フィルタ（ラベル・値の両方に一致）
 * - 選択済みはチップ表示（× で解除）。single 指定時は 1 件のみ（選び直しで置換）
 * - Enter = 絞り込み先頭の未選択項目を追加 / Esc = 候補を閉じる
 */
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: { value: string; label: string }[]
  placeholder?: string
  ariaLabel?: string
  /** true = 単一選択（編集画面など 1 件だけ選ばせたい場合） */
  single?: boolean
}>(), { placeholder: '入力して検索', ariaLabel: '項目を選択', single: false })

const emit = defineEmits<{ 'update:modelValue': [v: string[]] }>()

const query = ref('')
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

const selectedSet = computed(() => new Set(props.modelValue))
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.options.filter(o =>
    !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
})

function labelOf(v: string): string {
  return props.options.find(o => o.value === v)?.label ?? v
}

function toggle(value: string): void {
  if (props.single) {
    emit('update:modelValue', selectedSet.value.has(value) ? [] : [value])
    open.value = false
    query.value = ''
    return
  }
  const set = new Set(props.modelValue)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  emit('update:modelValue', [...set])
  query.value = ''
}

function remove(value: string): void {
  emit('update:modelValue', props.modelValue.filter(v => v !== value))
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    const first = filtered.value.find(o => !selectedSet.value.has(o.value))
    if (first) toggle(first.value)
  } else if (e.key === 'Escape') {
    open.value = false
  } else if (e.key === 'Backspace' && query.value === '' && props.modelValue.length > 0) {
    remove(props.modelValue[props.modelValue.length - 1]!)
  }
}

/** フォーカスがコンポーネント外へ出たら候補を閉じる（候補ボタンへの移動では閉じない） */
function onFocusOut(e: FocusEvent): void {
  if (root.value && e.relatedTarget instanceof Node && root.value.contains(e.relatedTarget)) return
  open.value = false
}
</script>

<template>
  <div ref="root" class="relative" @focusout="onFocusOut">
    <div
      class="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-line-strong bg-surface px-2 py-1"
      @click="inputEl?.focus()"
    >
      <span
        v-for="v in modelValue"
        :key="v"
        class="inline-flex items-center gap-1 rounded-full border border-brand bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand"
      >
        {{ labelOf(v) }}
        <button type="button" class="transition-opacity hover:opacity-60" :aria-label="`${labelOf(v)} を解除`" @click.stop="remove(v)">
          <X class="h-3 w-3" aria-hidden="true" />
        </button>
      </span>
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        class="min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted"
        :placeholder="modelValue.length === 0 ? placeholder : ''"
        :aria-label="ariaLabel"
        role="combobox"
        :aria-expanded="open"
        @focus="open = true"
        @input="open = true"
        @keydown="onKeydown"
      >
    </div>
    <div
      v-if="open"
      class="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
      role="listbox"
      :aria-multiselectable="!single"
    >
      <button
        v-for="o in filtered"
        :key="o.value"
        type="button"
        role="option"
        :aria-selected="selectedSet.has(o.value)"
        class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-soft"
        :class="selectedSet.has(o.value) ? 'font-medium text-brand' : ''"
        @click="toggle(o.value)"
      >
        <span>{{ o.label }}</span>
        <span class="num text-[11px] text-muted">{{ o.value }}</span>
      </button>
      <p v-if="filtered.length === 0" class="px-3 py-2 text-[12px] text-muted">該当する項目がありません</p>
    </div>
  </div>
</template>
