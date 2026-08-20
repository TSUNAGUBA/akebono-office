<script setup lang="ts">
/**
 * 生要望（改善要望）のカンバン（改修依頼 2026-08-19 第4弾 → 2026-08-20 でステータス軸を再編）。
 *
 * 設計判断（2026-08-20）: 列 = 改修案件と同じ IMPROVEMENT_STATUSES（未判定/改善対応/対応中/運用対応/
 * 継続検討/解決済み/対応見送り = 7 列）。**要望の表示ステータスは、紐づく改修単位（itemId → item.status）の
 * ステータスを継承する**。未集約（itemId なし）・紐づく item を参照できない場合（一般利用者は改修案件を
 * 取得できない等）は「未判定」列に置く。要望カンバンと案件カンバンで語彙・列がずれない（原則5/6）。
 * - 全利用者が閲覧できる。カード押下で詳細（親のドロワー）を開く。本コンポーネントは参照専用。
 * - カードには要望単位のステータス（未対応/対応済み/見送り）バッジを併記する（列 = 案件の方針、
 *   バッジ = 要望 1 件の対応状況、の 2 軸を混同させない）。
 * - 列は横スクロール（原則8: 7 列でもモバイル 375px は自身の overflow-x コンテナ内でスクロール）。
 */
import {
  IMPROVEMENT_REQUEST_STATUS_META, IMPROVEMENT_STATUS_META, IMPROVEMENT_STATUSES,
  type ImprovementRequest, type ImprovementStatus, requestStatusOf,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{
  requests: ImprovementRequest[]
  /** 要望 → 表示ステータス（紐づく item の status。親が items から解決して渡す。未指定 = 全件 triage） */
  itemStatusOf?: (r: ImprovementRequest) => ImprovementStatus
}>()

const emit = defineEmits<{ open: [request: ImprovementRequest] }>()

/** 要望の表示ステータス（紐づく item の status を継承。未集約・不明は triage） */
function statusOf(r: ImprovementRequest): ImprovementStatus {
  return props.itemStatusOf?.(r) ?? 'triage'
}

const columns = computed(() => IMPROVEMENT_STATUSES.map(status => ({
  status,
  meta: IMPROVEMENT_STATUS_META[status],
  requests: props.requests.filter(r => statusOf(r) === status),
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
          <!-- 要望 1 件のステータス（進捗タグ）。列（案件の方針）とは別軸のため明示する -->
          <span class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <UiStatusBadge
              :tone="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].tone"
              :label="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].label"
              dot
            />
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
