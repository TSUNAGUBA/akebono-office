<script setup lang="ts">
/**
 * 生要望（改善要望）のステータス別カンバン（改修依頼 2026-08-19 第4弾 項目5.5）。
 * 要望 1 件ずつの対応状況（未対応 / 対応済み / 見送り）を列に並べ、一望する。
 * - 全利用者が閲覧できる（改善要望の「全要望を閲覧可」）。カード押下で詳細（親のドロワー）を開く。
 * - ステータス変更は管理権限者のみ（詳細ドロワー内で行う）。本コンポーネントは参照専用。
 * - 列は横スクロール（原則8: 広い内容は自身の overflow-x コンテナ内でスクロール）。
 */
import {
  IMPROVEMENT_REQUEST_STATUSES, IMPROVEMENT_REQUEST_STATUS_META,
  type ImprovementRequest, requestStatusOf,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{ requests: ImprovementRequest[] }>()
const emit = defineEmits<{ open: [request: ImprovementRequest] }>()

const columns = computed(() => IMPROVEMENT_REQUEST_STATUSES.map(status => ({
  status,
  meta: IMPROVEMENT_REQUEST_STATUS_META[status],
  requests: props.requests.filter(r => requestStatusOf(r) === status),
})))

/** 投稿元の表示（対象ページ名＋対象箇所） */
function whereText(r: ImprovementRequest): string {
  const page = r.pageLabel || (r.pagePath ? pageDisplay(r.pagePath) : '')
  return [page, r.targetSpot].filter(Boolean).join(' / ')
}
/** 本文 1 行プレビュー（改行を詰める） */
function bodyLine(r: ImprovementRequest): string {
  return r.body.trim().replace(/\s*\n\s*/g, ' ')
}
</script>

<template>
  <div class="flex gap-3 overflow-x-auto pb-2">
    <section
      v-for="col in columns"
      :key="col.status"
      class="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-soft"
    >
      <header class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <UiStatusBadge :tone="col.meta.tone" :label="col.meta.label" dot />
        <span class="num text-[12px] font-bold text-muted">{{ col.requests.length }}</span>
      </header>

      <div class="grid gap-2 p-2">
        <button
          v-for="r in col.requests"
          :key="r.id"
          type="button"
          class="card min-w-0 p-2.5 text-left transition hover:border-brand focus-visible:border-brand"
          @click="emit('open', r)"
        >
          <span class="line-clamp-2 text-[13px] font-semibold text-ink">{{ bodyLine(r) }}</span>
          <span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span v-if="whereText(r)" class="min-w-0 max-w-full truncate" :title="whereText(r)">{{ whereText(r) }}</span>
          </span>
          <span class="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
            <span class="truncate">{{ r.memberName }}</span>
            <span class="num ml-auto">{{ fmtDate(r.createdAt) }}</span>
          </span>
        </button>

        <p v-if="col.requests.length === 0" class="px-1 py-4 text-center text-[12px] text-muted">なし</p>
      </div>
    </section>
  </div>
</template>
