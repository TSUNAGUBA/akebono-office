<script setup lang="ts">
/**
 * 一覧表示の唯一の実装（開発原則 8: PC=高密度テーブル / モバイル=カード型を自動切替）
 * セルのカスタム描画は #cell-<key> スロット。行クリックは row-click イベント。
 */
import type { TableColumn } from '~/types/ui'

const props = withDefaults(defineProps<{
  columns: TableColumn[]
  rows: Record<string, unknown>[]
  rowKey?: string
  maxHeight?: string
  clickable?: boolean
  emptyTitle?: string
  emptyHint?: string
}>(), {
  rowKey: 'id',
  maxHeight: '',
  clickable: false,
  emptyTitle: 'データがありません',
  emptyHint: '',
})

const emit = defineEmits<{ 'row-click': [row: Record<string, unknown>] }>()

const sortKey = ref('')
const sortDir = ref<1 | -1>(1)

function toggleSort(key: string): void {
  if (sortKey.value === key) {
    if (sortDir.value === 1) { sortDir.value = -1 }
    else { sortKey.value = ''; sortDir.value = 1 }
  } else {
    sortKey.value = key
    sortDir.value = 1
  }
}

const sortedRows = computed(() => {
  if (!sortKey.value) return props.rows
  const k = sortKey.value
  return [...props.rows].sort((a, b) => {
    const av = a[k]
    const bv = b[k]
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir.value
    return String(av ?? '').localeCompare(String(bv ?? ''), 'ja') * sortDir.value
  })
})

const primaryCols = computed(() => {
  const marked = props.columns.filter(c => c.primary)
  return marked.length > 0 ? marked : props.columns.slice(0, 3)
})

function keyOf(row: Record<string, unknown>, idx: number): string {
  return String(row[props.rowKey] ?? idx)
}

/** ソート状態 → aria-sort 値（ソート可能な th 全てに付与） */
function ariaSortOf(key: string): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 1 ? 'ascending' : 'descending'
}

/** クリック可能行のキーボード操作（Enter / Space で row-click。セル内の対話要素からのバブリングは無視） */
function onRowKeydown(e: KeyboardEvent, row: Record<string, unknown>): void {
  if (!props.clickable) return
  if (e.target !== e.currentTarget) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  emit('row-click', row)
}
</script>

<template>
  <div>
    <UiEmptyState v-if="rows.length === 0" :title="emptyTitle" :hint="emptyHint">
      <template v-if="$slots['empty-action']" #action>
        <slot name="empty-action" />
      </template>
    </UiEmptyState>

    <template v-else>
      <!-- PC: テーブル -->
      <div
        class="hidden overflow-auto scroll-slim md:block"
        :style="maxHeight ? { maxHeight } : {}"
      >
        <table class="tbl">
          <thead>
            <tr>
              <th
                v-for="c in columns"
                :key="c.key"
                :style="c.width ? { width: c.width } : {}"
                :class="c.align === 'right' ? '!text-right' : c.align === 'center' ? '!text-center' : ''"
                :aria-sort="ariaSortOf(c.key)"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-0.5 hover:text-ink"
                  @click="toggleSort(c.key)"
                >
                  {{ c.label }}
                  <span v-if="sortKey === c.key" aria-hidden="true">{{ sortDir === 1 ? '▲' : '▼' }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, idx) in sortedRows"
              :key="keyOf(row, idx)"
              :class="clickable ? 'is-clickable' : ''"
              :tabindex="clickable ? 0 : undefined"
              @click="clickable && emit('row-click', row)"
              @keydown="onRowKeydown($event, row)"
            >
              <td
                v-for="c in columns"
                :key="c.key"
                :class="[
                  c.align === 'right' ? 'text-right num' : c.align === 'center' ? 'text-center' : '',
                ]"
              >
                <slot :name="`cell-${c.key}`" :row="row" :value="row[c.key]">
                  {{ row[c.key] ?? '—' }}
                </slot>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- モバイル: カード型 -->
      <ul class="grid gap-2 md:hidden">
        <li
          v-for="(row, idx) in sortedRows"
          :key="keyOf(row, idx)"
          class="card p-3"
          :class="clickable ? 'cursor-pointer active:bg-brand-soft' : ''"
          :tabindex="clickable ? 0 : undefined"
          @click="clickable && emit('row-click', row)"
          @keydown="onRowKeydown($event, row)"
        >
          <dl class="grid gap-1">
            <div
              v-for="c in primaryCols"
              :key="c.key"
              class="flex items-baseline justify-between gap-2"
            >
              <dt class="shrink-0 text-[11px] font-semibold text-muted">{{ c.label }}</dt>
              <dd class="text-right text-[13px]">
                <slot :name="`cell-${c.key}`" :row="row" :value="row[c.key]">
                  {{ row[c.key] ?? '—' }}
                </slot>
              </dd>
            </div>
          </dl>
        </li>
      </ul>
    </template>
  </div>
</template>
