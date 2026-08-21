<script setup lang="ts">
/**
 * 受付箱（生要望）のカンバン（改修依頼 2026-08-19 第4弾 → 2026-08-21 で受付箱ステータス軸へ再編）。
 *
 * 設計判断（2026-08-21）: 列 = 受付箱ステータス（未確認/検討中/改善対応/運用対応/継続検討/対応見送り/
 * 対応済み/解決済み = IMPROVEMENT_INBOX_STATUSES の 8 列）。表示ステータスは親から渡される
 * `statusOf`（useImprovements.inboxStatusOf = improvementInboxStatusOf）で解決する:
 * 集約済みは改修案件の進捗に連動（改善対応/対応済み）・解決済みは resolvedAt の記録が最優先（原則6 導出）。
 * - 全利用者が閲覧できる。カード押下で詳細（親のドロワー）を開く。本コンポーネントは参照専用。
 * - カードには対象ページ + 対象箇所（targetSpot）・継続検討の再検討日を併記する。
 * - 列は横スクロール（原則8: 8 列でもモバイル 375px は自身の overflow-x コンテナ内でスクロール）。
 */
import { Calendar } from 'lucide-vue-next'
import {
  IMPROVEMENT_INBOX_STATUS_META, IMPROVEMENT_INBOX_STATUSES,
  type ImprovementInboxStatus, type ImprovementRequest,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{
  requests: ImprovementRequest[]
  /** 要望 → 受付箱表示ステータス（親が useImprovements.inboxStatusOf を渡す = 判定点の一元化・原則6） */
  statusOf: (r: ImprovementRequest) => ImprovementInboxStatus
}>()

const emit = defineEmits<{ open: [request: ImprovementRequest] }>()

const columns = computed(() => IMPROVEMENT_INBOX_STATUSES.map(status => ({
  status,
  meta: IMPROVEMENT_INBOX_STATUS_META[status],
  requests: props.requests.filter(r => props.statusOf(r) === status),
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
          <!-- 継続検討の再検討日（到来で管理者へリマインド = 改修依頼 2026-08-21） -->
          <span
            v-if="col.status === 'deferred' && r.revisitOn"
            class="mt-1 inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-[11px] text-info"
          >
            <Calendar class="h-3 w-3" aria-hidden="true" />
            <span class="num">{{ fmtDate(r.revisitOn) }} 再検討</span>
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
