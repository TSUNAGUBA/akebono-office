<script setup lang="ts">
/**
 * 改善要望のタグ選択（お任せ / 壁打ち のトグル。改修依頼 2026-08-20）。
 * 「お任せ」「壁打ち」は同時に選べず、常にどちらか 1 つだけが選択された状態を維持する
 * （片方を選ぶともう片方は自動で外れる = 二者択一のセグメント型トグル）。
 * データ形は従来どおり ImprovementRequestTag[]（shared 検証・表示部品と互換）だが、本トグルでは
 * 常に要素数 1 の配列を親へ通知する。既存データ（0 件 / 2 件）はマウント時に既定 or 先頭へ正規化する（原則7）。
 * 投稿フォーム（ImprovementSubmit）と要望編集（ImprovementsRequestEditForm）で共用する（原則3）。
 */
import {
  IMPROVEMENT_REQUEST_TAGS, IMPROVEMENT_REQUEST_TAG_META, type ImprovementRequestTag,
} from '~/types/improvement'

const props = withDefaults(defineProps<{
  /** 選択中タグ（v-model）。常に要素数 1 で通知する */
  modelValue: string[]
  ariaLabel?: string
}>(), { ariaLabel: '要望のタグ' })

const emit = defineEmits<{ 'update:modelValue': [v: string[]] }>()

/** 既定タグ（未選択・不正値のフォールバック = お任せ）。表示順 SoT = IMPROVEMENT_REQUEST_TAGS の先頭 */
const DEFAULT_TAG: ImprovementRequestTag = IMPROVEMENT_REQUEST_TAGS[0] ?? 'entrust'

function isTag(v: string): v is ImprovementRequestTag {
  return (IMPROVEMENT_REQUEST_TAGS as string[]).includes(v)
}

/** 現在の選択（modelValue に含まれる最初の既知タグ・無ければ既定）。複数・未選択でも 1 つに寄せて表示する */
const selected = computed<ImprovementRequestTag>(() => props.modelValue.find(isTag) ?? DEFAULT_TAG)

// マウント時に「ちょうど 1 つ」へ正規化する（既存データが 0 件 / 2 件でも常にどちらか 1 つの状態にする）。
// 既に [selected] と一致していれば何もしない（不要な emit を出さない）
onMounted(() => {
  const cur = props.modelValue
  if (cur.length !== 1 || !isTag(cur[0]!)) emit('update:modelValue', [selected.value])
})

function pick(tag: ImprovementRequestTag): void {
  if (tag === selected.value && props.modelValue.length === 1) return
  emit('update:modelValue', [tag])
}

// WAI-ARIA ラジオグループの作法（UiRadioCards と同じ = 原則3）: Tab はグループへ 1 ストップ
// （roving tabindex = 選択中のみ tabindex 0）・矢印キーで選択を移動する。
const groupEl = ref<HTMLElement | null>(null)

/** roving tabindex: 選択中タグのみ Tab ストップにする */
function tabindexOf(tag: ImprovementRequestTag): number {
  return tag === selected.value ? 0 : -1
}

/** 矢印キーで前後のタグへ移動して選択 + フォーカス（radiogroup の標準操作） */
function onKeydown(e: KeyboardEvent, index: number): void {
  const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (delta === 0) return
  e.preventDefault()
  const n = IMPROVEMENT_REQUEST_TAGS.length
  if (n === 0) return
  const nextIdx = (index + delta + n) % n
  const next = IMPROVEMENT_REQUEST_TAGS[nextIdx]!
  pick(next)
  const btns = groupEl.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  btns?.[nextIdx]?.focus()
}
</script>

<template>
  <div
    ref="groupEl"
    class="inline-flex rounded-full border border-line-strong bg-surface p-0.5"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <button
      v-for="(t, i) in IMPROVEMENT_REQUEST_TAGS"
      :key="t"
      type="button"
      role="radio"
      :aria-checked="selected === t"
      :tabindex="tabindexOf(t)"
      class="min-h-8 rounded-full px-4 py-1 text-xs font-semibold transition-colors"
      :class="selected === t ? 'bg-brand text-white' : 'text-sub hover:text-ink'"
      @click="pick(t)"
      @keydown="onKeydown($event, i)"
    >
      {{ IMPROVEMENT_REQUEST_TAG_META[t].label }}
    </button>
  </div>
</template>
