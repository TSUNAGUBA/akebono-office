<script setup lang="ts">
/**
 * 生要望（改善要望）の投稿タイムライン（改修依頼 2026-08-19 第4弾 項目5.5「【要望】ガント」）。
 * 各要望を投稿日（createdAt）に 1 目盛りのバーとして時間軸に並べ、いつ・どのステータスの要望が
 * 寄せられたかを俯瞰する（要望は対応予定期間を持たないため、改修案件ガントと異なり投稿日基準）。
 * - スケール（月次/週次/日次）切替・期間ナビは改修案件ガントと同じ純関数（shared/domain/gantt）を共用（原則3）。
 * - 全利用者が閲覧できる（参照専用）。バー押下で詳細（親のドロワー）を開く。
 * - 列は等分伸縮・狭い画面は横スクロール・ラベル列は sticky（原則8）。
 */
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import {
  ganttAnchorForToday, ganttBar, ganttColumns, ganttRangeLabel, GANTT_SCALES, ganttStep,
  type GanttScale,
} from '~/types/gantt'
import {
  IMPROVEMENT_REQUEST_STATUSES, IMPROVEMENT_REQUEST_STATUS_META,
  type ImprovementRequest, type ImprovementRequestStatus, requestStatusOf,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{ requests: ImprovementRequest[] }>()
const emit = defineEmits<{ open: [request: ImprovementRequest] }>()

const today = todayJst()
const scale = ref<GanttScale>('month')
const anchor = ref<string>(ganttAnchorForToday('month', today))

/** ステータス絞り込み（既定 = すべて） */
const statusFilter = ref<'all' | ImprovementRequestStatus>('all')
const FILTER_OPTIONS = [
  { value: 'all', label: 'すべて' },
  ...IMPROVEMENT_REQUEST_STATUSES.map(s => ({ value: s, label: IMPROVEMENT_REQUEST_STATUS_META[s].label })),
]

/** バー色（ステータス別・凡例と一致） */
const BAR_CLASS: Record<ImprovementRequestStatus, string> = {
  open: 'bg-warn', // 未対応 = 要対応（アンバー）
  resolved: 'bg-brand', // 対応済み（ブランド）
  dismissed: 'bg-muted', // 見送り（グレーで退色）
}

const MIN_COL_W: Record<GanttScale, number> = { month: 56, week: 44, day: 30 }
const LABEL_W = 220
const minColW = computed(() => MIN_COL_W[scale.value])
const columns = computed(() => ganttColumns(scale.value, anchor.value, today))
const rangeLabel = computed(() => ganttRangeLabel(columns.value))
const minWidth = computed(() => `${LABEL_W + columns.value.length * minColW.value}px`)

/** 投稿日（YYYY-MM-DD） */
function dateOf(r: ImprovementRequest): string {
  return r.createdAt.slice(0, 10)
}

/** 絞り込み後・投稿日昇順 */
const filtered = computed(() =>
  props.requests
    .filter(r => statusFilter.value === 'all' || requestStatusOf(r) === statusFilter.value)
    .slice()
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.id.localeCompare(b.id)))

/** 可視範囲（現在のスケール）に投稿日が入る要望のみ行に出す */
const visible = computed(() => filtered.value.filter(r => ganttBar(dateOf(r), dateOf(r), columns.value)))

const legendStatuses = computed<ImprovementRequestStatus[]>(() =>
  IMPROVEMENT_REQUEST_STATUSES.filter(s => visible.value.some(r => requestStatusOf(r) === s)))

function barOf(r: ImprovementRequest): { left: number; width: number } | null {
  const span = ganttBar(dateOf(r), dateOf(r), columns.value)
  if (!span) return null
  const n = columns.value.length
  return { left: (span.startIdx / n) * 100, width: ((span.endIdx - span.startIdx + 1) / n) * 100 }
}
function barTone(r: ImprovementRequest): string {
  return BAR_CLASS[requestStatusOf(r)] ?? 'bg-muted'
}
function whereText(r: ImprovementRequest): string {
  const page = r.pageLabel || (r.pagePath ? pageDisplay(r.pagePath) : '')
  return [page, r.targetSpot].filter(Boolean).join(' / ')
}
function bodyLine(r: ImprovementRequest): string {
  return r.body.trim().replace(/\s*\n\s*/g, ' ')
}
function setScale(v: string): void { scale.value = v as GanttScale }
function setStatusFilter(v: string): void { statusFilter.value = v as 'all' | ImprovementRequestStatus }
function goPrev(): void { anchor.value = ganttStep(scale.value, anchor.value, -1) }
function goNext(): void { anchor.value = ganttStep(scale.value, anchor.value, 1) }
function goToday(): void { anchor.value = ganttAnchorForToday(scale.value, today) }
const nowLabel = computed(() => GANTT_SCALES.find(s => s.value === scale.value)?.nowLabel ?? '今')
</script>

<template>
  <div class="grid gap-3">
    <!-- ツールバー: スケール切替 + 期間ナビ -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1 rounded-lg border border-line p-0.5">
        <button
          v-for="s in GANTT_SCALES"
          :key="s.value"
          type="button"
          class="btn btn-sm"
          :class="scale === s.value ? 'btn-primary' : 'btn-ghost'"
          @click="setScale(s.value)"
        >
          {{ s.label }}<span class="ml-1 hidden text-[10px] opacity-70 sm:inline">{{ s.span }}</span>
        </button>
      </div>
      <div class="flex items-center gap-1">
        <button type="button" class="btn btn-ghost btn-sm" aria-label="前の期間" @click="goPrev">
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="goToday">{{ nowLabel }}</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="次の期間" @click="goNext">
          <ChevronRight class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <UiChipTabs
      :model-value="statusFilter"
      :options="FILTER_OPTIONS"
      aria-label="ステータスで絞り込み"
      @update:model-value="setStatusFilter"
    />

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p class="text-[12px] text-muted">表示範囲: <span class="num font-semibold text-sub">{{ rangeLabel }}</span></p>
      <div v-if="legendStatuses.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-for="s in legendStatuses" :key="s" class="flex items-center gap-1 text-[11px] text-muted">
          <span class="inline-block h-2.5 w-2.5 rounded-sm" :class="BAR_CLASS[s]" aria-hidden="true" />
          {{ IMPROVEMENT_REQUEST_STATUS_META[s].label }}
        </span>
      </div>
    </div>

    <div v-if="visible.length > 0" class="overflow-x-auto rounded-xl border border-line">
      <div :style="{ minWidth }">
        <!-- ヘッダー行 -->
        <div class="flex border-b border-line bg-surface-soft">
          <div class="gantt-label shrink-0 px-2 py-1.5 text-[11px] font-bold text-muted" :style="{ width: `${LABEL_W}px` }">要望</div>
          <div class="flex flex-1">
            <div
              v-for="c in columns"
              :key="c.key"
              class="flex-1 border-l border-line py-1.5 text-center text-[10px]"
              :class="c.isToday ? 'bg-brand-soft font-bold text-brand' : 'text-muted'"
              :style="{ minWidth: `${minColW}px` }"
            >{{ c.label }}</div>
          </div>
        </div>

        <!-- 要望行 -->
        <div
          v-for="r in visible"
          :key="r.id"
          class="flex border-b border-line last:border-b-0 hover:bg-surface-soft"
        >
          <button
            type="button"
            class="gantt-label shrink-0 px-2 py-1.5 text-left"
            :style="{ width: `${LABEL_W}px` }"
            :title="`${bodyLine(r)}｜${whereText(r)}`"
            @click="emit('open', r)"
          >
            <span class="block truncate text-[12px] font-semibold text-ink hover:text-brand">{{ bodyLine(r) }}</span>
            <span v-if="whereText(r)" class="block truncate text-[10px] text-muted">{{ whereText(r) }}</span>
          </button>

          <div class="relative flex flex-1">
            <div
              v-for="c in columns"
              :key="c.key"
              class="flex-1 border-l border-line"
              :class="c.isToday ? 'bg-brand-soft' : ''"
              :style="{ minWidth: `${minColW}px` }"
            />
            <button
              v-if="barOf(r)"
              type="button"
              class="absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-[10px] font-semibold text-white"
              :class="barTone(r)"
              :style="{ left: `calc(${barOf(r)!.left}% + 2px)`, width: `calc(${barOf(r)!.width}% - 4px)` }"
              :title="`${bodyLine(r)}（${fmtDate(r.createdAt)}・${IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].label}）`"
              @click="emit('open', r)"
            >
              <span class="truncate">{{ fmtDate(r.createdAt) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
      表示範囲に投稿された要望がありません。期間を移動するか、絞り込みを変更してください。
    </div>
  </div>
</template>
