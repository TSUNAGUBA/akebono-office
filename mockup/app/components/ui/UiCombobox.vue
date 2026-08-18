<script setup lang="ts">
/**
 * 単一選択コンボボックス（自由入力可 = 未登録名の新規登録に対応。オペレーター指示 2026-07-31）。
 * - 入力でオプションを部分一致フィルタ。候補クリックで選択（modelValue = 既存 id・入力欄はラベル表示）
 * - 入力がどのラベルとも一致しない場合は自由入力として保持（modelValue = ''・text に入力名）。
 *   呼び出し側が text を「新規登録名」として扱う（例: 顧客活動の会社・担当者 = 保存時にマスタ登録）
 * - 入力がラベルと完全一致（trim）したらその項目を自動選択（重複マスタを作らない）
 * - Enter = ①完全一致を選択 ②選択済み・空入力は閉じるだけ（選択を変えない）③絞り込み一致の先頭を選択
 *   ④一致なしは自由入力（新規登録名）として確定 / Esc = 候補を閉じる（開いていなければ親モーダルへ伝播）
 * - 候補リストの開閉方向は UiMultiCombobox と共通の実測ロジック（useDropdownDirection）
 */
import { X } from 'lucide-vue-next'
import { normalizeSearch } from '~/utils/search'

const props = withDefaults(defineProps<{
  /** 選択中の既存項目 id（'' = 未選択 or 自由入力中） */
  modelValue: string
  /** 入力欄の表示文字列（選択時 = ラベル / 自由入力時 = 入力名）。呼び出し側と双方向同期 */
  text: string
  options: { value: string; label: string }[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  /** 自由入力（新規登録）を許可するか。false = 既存からの選択のみ */
  allowCreate?: boolean
  /** 自由入力時に候補リスト下部へ出す案内（例: 保存時に新規登録されます） */
  createHint?: string
}>(), {
  placeholder: '入力して検索',
  ariaLabel: '項目を選択',
  disabled: false,
  allowCreate: true,
  createHint: '',
})

const emit = defineEmits<{ 'update:modelValue': [v: string]; 'update:text': [v: string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listboxId = useId()
const { openUp, listMaxHeight, updateDirection } = useDropdownDirection(root)

watch(open, (v) => {
  if (v) updateDirection()
})

/** 入力文字列そのままの絞り込み結果（Enter の選択対象 = 見えている検索結果と一致させる） */
const queryFiltered = computed(() => {
  const q = normalizeSearch(props.text.trim())
  if (!q) return props.options
  // 大文字小文字・全角半角を吸収して label / value を部分一致（0056）
  return props.options.filter(o => normalizeSearch(o.label).includes(q) || normalizeSearch(o.value).includes(q))
})

/** 表示用の候補（選択済み = 入力が選択ラベルと一致しているときは全候補 = 選び直しやすさ優先） */
const filtered = computed(() => {
  const q = normalizeSearch(props.text.trim())
  if (!q || (props.modelValue && normalizeSearch(labelOf(props.modelValue)) === q)) return props.options
  return queryFiltered.value
})

/** 入力が既存ラベルと完全一致するか（trim・大小/全角半角無視 = 重複登録の防止） */
const exactMatch = computed(() => {
  const q = normalizeSearch(props.text.trim())
  return q ? props.options.find(o => normalizeSearch(o.label.trim()) === q) : undefined
})

/** 自由入力状態（未登録名）か。呼び出し側の「新規登録されます」表示と対 */
const isFreeInput = computed(() => !props.modelValue && !!props.text.trim())

function labelOf(v: string): string {
  return props.options.find(o => o.value === v)?.label ?? ''
}

function select(value: string): void {
  emit('update:modelValue', value)
  emit('update:text', labelOf(value))
  open.value = false
}

function clear(): void {
  emit('update:modelValue', '')
  emit('update:text', '')
  inputEl.value?.focus()
}

function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value
  emit('update:text', v)
  open.value = true
  // ラベル完全一致は自動選択・それ以外は選択解除（入力名と選択 id の不一致を残さない。全角半角も吸収）
  const nv = normalizeSearch(v.trim())
  const hit = nv ? props.options.find(o => normalizeSearch(o.label.trim()) === nv) : undefined
  emit('update:modelValue', hit?.value ?? '')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (!open.value) {
      open.value = true
      return
    }
    // Enter の優先順（レビュー指摘 M-1: 選択済み・空入力時に無関係な先頭候補へ差し替えない）:
    // ①完全一致 = その項目を選択 ②選択済み or 空入力 = 閉じるだけ（選択を変えない）
    // ③絞り込み一致あり = 見えている検索結果の先頭を選択 ④一致なし = 自由入力（新規登録名）として確定
    if (exactMatch.value) {
      select(exactMatch.value.value)
      return
    }
    if (props.modelValue || !props.text.trim()) {
      open.value = false
      return
    }
    const first = queryFiltered.value[0]
    if (first) select(first.value)
    else open.value = false
  } else if (e.key === 'ArrowDown') {
    open.value = true
  } else if (e.key === 'Escape') {
    // 候補が開いているときの Esc は候補を閉じるだけ（親モーダルまで閉じない = UiMultiCombobox と同じ）
    if (open.value) {
      open.value = false
      e.stopPropagation()
    }
  }
}

/** フォーカスがコンポーネント外へ出たら候補を閉じる（候補ボタンへの移動では閉じない） */
function onFocusOut(e: FocusEvent): void {
  if (root.value && e.relatedTarget instanceof Node && root.value.contains(e.relatedTarget)) return
  open.value = false
  // 自由入力を許可しない場合、未確定の入力は選択済みラベル（未選択なら空）へ戻す
  if (!props.allowCreate && !props.modelValue) emit('update:text', '')
}
</script>

<template>
  <div ref="root" class="relative" @focusout="onFocusOut">
    <div class="relative">
      <input
        ref="inputEl"
        :value="text"
        type="text"
        class="input w-full pr-8"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        :disabled="disabled"
        role="combobox"
        aria-haspopup="listbox"
        aria-autocomplete="list"
        :aria-controls="listboxId"
        :aria-expanded="open"
        @focus="open = true"
        @input="onInput"
        @keydown="onKeydown"
      >
      <button
        v-if="text && !disabled"
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-muted transition-opacity hover:opacity-60"
        aria-label="入力をクリア"
        @click="clear"
      >
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
    <div
      v-if="open && !disabled"
      :id="listboxId"
      class="absolute z-20 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
      :class="openUp ? 'bottom-full mb-1' : 'mt-1'"
      :style="{ maxHeight: `${listMaxHeight}px` }"
      role="listbox"
    >
      <button
        v-for="o in filtered"
        :key="o.value"
        type="button"
        role="option"
        :aria-selected="o.value === modelValue"
        class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-soft"
        :class="o.value === modelValue ? 'font-medium text-brand' : ''"
        @click="select(o.value)"
      >
        <span>{{ o.label }}</span>
        <span class="num text-[11px] text-muted">{{ o.value }}</span>
      </button>
      <p v-if="filtered.length === 0 && !isFreeInput" class="px-3 py-2 text-[12px] text-muted">該当する項目がありません</p>
      <!-- Enter の挙動とヒントを一致させる（2 巡目 NIT-3）: 部分一致候補がある間は Enter が先頭候補を選ぶ旨を明示 -->
      <p v-if="allowCreate && isFreeInput && !exactMatch" class="border-t border-line px-3 py-2 text-[12px] text-brand">
        「{{ text.trim() }}」は未登録です{{ createHint ? `（${createHint}）` : '' }}{{
          queryFiltered.length > 0 ? '。Enter は絞り込み候補の先頭を選択します（この名前のまま確定するには他の項目へ移動）' : '' }}
      </p>
      <p v-else-if="!allowCreate && isFreeInput" class="border-t border-line px-3 py-2 text-[12px] text-muted">
        既存の項目から選択してください
      </p>
    </div>
  </div>
</template>
