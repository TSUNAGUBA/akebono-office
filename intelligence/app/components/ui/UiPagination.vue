<script setup lang="ts">
/**
 * 一覧のページング UI（開発原則 8: PC=横並び / モバイル=折返しでページ横スクロールを作らない）。
 * サーバー/クライアント双方のページングで共用する（rows の供給元は useListView が抽象化）。
 * page は 1 始まり。total は「現在の検索条件での総件数」。
 */
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  total: number
  page: number
  pageSize: number
  pageSizeOptions?: number[]
}>(), {
  pageSizeOptions: () => [20, 50, 100],
})

const emit = defineEmits<{
  'update:page': [v: number]
  'update:pageSize': [v: number]
}>()

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const to = computed(() => Math.min(props.total, props.page * props.pageSize))

const sizeOptions = computed(() =>
  props.pageSizeOptions.map(n => ({ value: String(n), label: `${n}件` })))

function go(next: number): void {
  const clamped = Math.min(Math.max(1, next), pageCount.value)
  if (clamped !== props.page) emit('update:page', clamped)
}
</script>

<template>
  <nav
    v-if="total > 0"
    class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px] text-muted"
    aria-label="ページング"
  >
    <p class="tabular-nums">
      全 {{ total.toLocaleString('ja-JP') }} 件中
      <span class="font-medium text-ink">{{ from.toLocaleString('ja-JP') }}–{{ to.toLocaleString('ja-JP') }}</span>
      件を表示
    </p>

    <div class="flex items-center gap-1.5">
      <UiSelect
        :model-value="String(pageSize)"
        :options="sizeOptions"
        aria-label="1ページの表示件数"
        @update:model-value="emit('update:pageSize', Number($event))"
      />
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="page <= 1"
          aria-label="前のページ"
          @click="go(page - 1)"
        >
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <span class="min-w-[4.5rem] text-center tabular-nums" aria-live="polite">
          {{ page.toLocaleString('ja-JP') }} / {{ pageCount.toLocaleString('ja-JP') }}
        </span>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="page >= pageCount"
          aria-label="次のページ"
          @click="go(page + 1)"
        >
          <ChevronRight class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  </nav>
</template>
