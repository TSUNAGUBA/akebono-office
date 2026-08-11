<script setup lang="ts">
/**
 * 改善要望のカンバン表示（F-42）。ステータス別の列に改修単位カードを並べ、進捗・状況を一望する。
 * カードクリックで詳細ドロワー（open）、許可された遷移先へのクイック操作（status）を親へ通知する。
 * 列は横スクロール（原則8: 広い内容は自身の overflow-x コンテナ内でスクロール）。
 */
import { Calendar } from 'lucide-vue-next'
import {
  IMPROVEMENT_STATUS_META, IMPROVEMENT_STATUS_NEXT, IMPROVEMENT_STATUSES,
  type ImprovementItem, type ImprovementStatus,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{ items: ImprovementItem[]; reqCount: (id: string) => number }>()
const emit = defineEmits<{ open: [item: ImprovementItem]; status: [id: string, to: ImprovementStatus] }>()

const columns = computed(() => IMPROVEMENT_STATUSES.map(status => ({
  status,
  meta: IMPROVEMENT_STATUS_META[status],
  items: props.items.filter(it => it.status === status),
})))

function planLabel(it: ImprovementItem): string {
  if (!it.planStart) return ''
  return it.planEnd && it.planEnd !== it.planStart
    ? `${fmtDate(it.planStart)}〜${fmtDate(it.planEnd)}`
    : fmtDate(it.planStart)
}
function statusLabel(s: ImprovementStatus): string { return IMPROVEMENT_STATUS_META[s]?.label ?? s }
</script>

<template>
  <div class="flex gap-3 overflow-x-auto pb-2">
    <section
      v-for="col in columns"
      :key="col.status"
      class="flex w-64 shrink-0 flex-col rounded-xl border border-line bg-surface-soft"
    >
      <header class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <UiStatusBadge :tone="col.meta.tone" :label="col.meta.label" dot />
        <span class="num text-[12px] font-bold text-muted">{{ col.items.length }}</span>
      </header>

      <div class="grid gap-2 p-2">
        <!-- カードは非対話コンテナ。見出しボタンが「開く」主アクション、遷移ボタンは兄弟（入れ子対話を避け a11y 準拠） -->
        <article
          v-for="it in col.items"
          :key="it.id"
          class="card p-2.5 transition focus-within:border-brand hover:border-brand"
        >
          <button
            type="button"
            class="block w-full truncate text-left text-[13px] font-semibold text-ink hover:text-brand"
            :title="it.title"
            @click="emit('open', it)"
          >{{ it.title }}</button>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span v-if="it.pagePaths.length" class="max-w-full truncate" :title="it.pagePaths.map(pageDisplay).join(' / ')">{{ it.pagePaths.map(pageDisplay).join(' / ') }}</span>
            <span class="num">要望 {{ reqCount(it.id) }}</span>
          </div>
          <p v-if="it.planStart" class="mt-1 inline-flex items-center gap-1 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] text-brand">
            <Calendar class="h-3 w-3" aria-hidden="true" />
            <span class="num">{{ planLabel(it) }}</span>
          </p>
          <div v-if="IMPROVEMENT_STATUS_NEXT[it.status].length" class="mt-2 flex flex-wrap gap-1">
            <button
              v-for="to in IMPROVEMENT_STATUS_NEXT[it.status]"
              :key="to"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="emit('status', it.id, to)"
            >
              {{ statusLabel(to) }}へ
            </button>
          </div>
        </article>

        <p v-if="col.items.length === 0" class="px-1 py-4 text-center text-[12px] text-muted">なし</p>
      </div>
    </section>
  </div>
</template>
