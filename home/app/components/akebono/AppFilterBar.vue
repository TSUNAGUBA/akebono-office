<script setup lang="ts">
/**
 * 構造化フィルタフォーム（オペレーター指示 2026-08-10）。
 * 項目カスタマイズで「検索対象」に設定された項目を、種別ごとの入力で絞り込む（フリーテキスト検索の置換）。
 * - ref（マスタ参照）= UiMultiCombobox（single）= オートコンプリート（大文字小文字・全角半角を吸収）
 * - enum = UiSelect（固定選択・「すべて」で解除）
 * - text = 正規化部分一致の入力 / date = 期間（from〜to）/ number = 範囲（min〜max）
 * 状態・述語・クエリは useAppFilter が保持。本コンポーネントは表示層に徹する（原則3）。
 */
import { RotateCcw } from 'lucide-vue-next'
import type { ResolvedItem } from '~/composables/useItemSettings'
import type { DateRange, FilterOption, NumberRange } from '~/composables/useAppFilter'

const props = defineProps<{
  fields: ResolvedItem[]
  model: Record<string, string | DateRange | NumberRange>
  optionsFor: (item: ResolvedItem) => FilterOption[]
  activeCount: number
  /** 表示しない項目キー（専用コントロールが別にある項目 = 例: segmentId を業態スイッチャに委ねる） */
  exclude?: string[]
}>()
const emit = defineEmits<{ clear: [] }>()

// 除外指定を差し引いた表示対象（専用コントロールとの二重操作を避ける）
const shownFields = computed(() => props.fields.filter(f => !(props.exclude ?? []).includes(f.itemKey)))

// 種別ごとの型付きアクセサ（テンプレートの union 展開を避ける）
function dateVal(f: ResolvedItem): DateRange {
  return props.model[f.itemKey] as DateRange
}
function numVal(f: ResolvedItem): NumberRange {
  return props.model[f.itemKey] as NumberRange
}
function refArr(f: ResolvedItem): string[] {
  const v = props.model[f.itemKey]
  return typeof v === 'string' && v ? [v] : []
}
function setRef(f: ResolvedItem, v: string[]): void {
  props.model[f.itemKey] = v[0] ?? ''
}
function enumOptions(f: ResolvedItem): FilterOption[] {
  return [{ value: '', label: 'すべて' }, ...props.optionsFor(f)]
}
</script>

<template>
  <div v-if="shownFields.length > 0" class="rounded-[12px] border border-line bg-surface p-3">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-[11px] font-bold text-muted">
        絞り込み<span v-if="activeCount > 0" class="ml-1 text-brand">（{{ activeCount }}件適用中）</span>
      </span>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="activeCount === 0"
        @click="emit('clear')"
      >
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> クリア
      </button>
    </div>

    <div class="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="f in shownFields" :key="f.itemKey" class="grid gap-1">
        <label class="text-[11px] font-semibold text-muted">{{ f.labelDisplay }}</label>

        <!-- ref: マスタ参照のオートコンプリート -->
        <UiMultiCombobox
          v-if="f.filterKind === 'ref'"
          :model-value="refArr(f)"
          :options="optionsFor(f)"
          single
          :placeholder="`${f.labelDisplay}で絞り込み`"
          :aria-label="`${f.labelDisplay}で絞り込み`"
          @update:model-value="v => setRef(f, v)"
        />

        <!-- enum: 固定選択 -->
        <UiSelect
          v-else-if="f.filterKind === 'enum'"
          v-model="(model[f.itemKey] as string)"
          :options="enumOptions(f)"
          :aria-label="`${f.labelDisplay}で絞り込み`"
        />

        <!-- date: 期間（狭幅で 2 入力が収まるよう min-w-0 で縮小可に） -->
        <div v-else-if="f.filterKind === 'date'" class="flex items-center gap-1">
          <input v-model="dateVal(f).from" type="date" class="input min-w-0 flex-1" :aria-label="`${f.labelDisplay}（開始）`">
          <span class="shrink-0 text-[11px] text-muted">〜</span>
          <input v-model="dateVal(f).to" type="date" class="input min-w-0 flex-1" :aria-label="`${f.labelDisplay}（終了）`">
        </div>

        <!-- number: 範囲 -->
        <div v-else-if="f.filterKind === 'number'" class="flex items-center gap-1">
          <input v-model="numVal(f).min" type="number" class="input min-w-0 flex-1" :placeholder="`最小`" :aria-label="`${f.labelDisplay}（最小）`">
          <span class="shrink-0 text-[11px] text-muted">〜</span>
          <input v-model="numVal(f).max" type="number" class="input min-w-0 flex-1" :placeholder="`最大`" :aria-label="`${f.labelDisplay}（最大）`">
        </div>

        <!-- text: 正規化部分一致 -->
        <input
          v-else
          v-model="(model[f.itemKey] as string)"
          type="search"
          class="input"
          :placeholder="`${f.labelDisplay}で絞り込み`"
          :aria-label="`${f.labelDisplay}で絞り込み`"
        >
      </div>
    </div>
  </div>
</template>
