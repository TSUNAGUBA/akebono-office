<script setup lang="ts">
/**
 * 伝票の明細エディタ（発注・入荷・出荷・仕入で共用）。
 * modelValue = 行配列 { skuId, qty, price? }。行の追加/削除・SKU 選択・数量/単価入力を提供する。
 * price 列は priceLabel が指定されたときのみ表示（単価/原価）。
 */
import { Plus, Trash2 } from 'lucide-vue-next'

export interface LineRow {
  skuId: string
  qty: number
  price?: number
}

const props = defineProps<{
  modelValue: LineRow[]
  skuOptions: { value: string; label: string }[]
  /** 指定時に価格列を表示（例: '単価' / '原価'）。未指定なら数量のみ */
  priceLabel?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [LineRow[]] }>()

function update(rows: LineRow[]): void {
  emit('update:modelValue', rows)
}
function addRow(): void {
  update([...props.modelValue, { skuId: '', qty: 1, ...(props.priceLabel ? { price: 0 } : {}) }])
}
function removeRow(idx: number): void {
  update(props.modelValue.filter((_, i) => i !== idx))
}
function setField(idx: number, field: keyof LineRow, value: string): void {
  update(props.modelValue.map((r, i) => {
    if (i !== idx) return r
    if (field === 'skuId') return { ...r, skuId: value }
    return { ...r, [field]: Number(value) }
  }))
}
</script>

<template>
  <div class="grid gap-2">
    <div v-if="modelValue.length === 0" class="rounded-[8px] border border-dashed border-line px-3 py-4 text-center text-[12px] text-muted">
      明細がありません。「行を追加」で入力してください
    </div>
    <div
      v-for="(row, idx) in modelValue"
      :key="idx"
      class="grid items-center gap-2"
      :class="priceLabel ? 'grid-cols-[1fr_72px_96px_36px]' : 'grid-cols-[1fr_72px_36px]'"
    >
      <UiSelect
        :model-value="row.skuId"
        :options="skuOptions"
        aria-label="SKU"
        @update:model-value="setField(idx, 'skuId', $event)"
      />
      <input
        :value="row.qty" type="number" min="1" step="1" class="input text-right" aria-label="数量"
        @input="setField(idx, 'qty', ($event.target as HTMLInputElement).value)"
      >
      <input
        v-if="priceLabel"
        :value="row.price ?? 0" type="number" min="0" step="1" class="input text-right" :aria-label="priceLabel"
        @input="setField(idx, 'price', ($event.target as HTMLInputElement).value)"
      >
      <button type="button" class="btn btn-ghost btn-sm px-1.5" aria-label="行を削除" @click="removeRow(idx)">
        <Trash2 class="h-4 w-4 text-crit" aria-hidden="true" />
      </button>
    </div>
    <div class="flex items-center justify-between">
      <button type="button" class="btn btn-sm" @click="addRow">
        <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 行を追加
      </button>
      <span v-if="priceLabel" class="text-[11px] text-muted">数量 × {{ priceLabel }}</span>
    </div>
  </div>
</template>
