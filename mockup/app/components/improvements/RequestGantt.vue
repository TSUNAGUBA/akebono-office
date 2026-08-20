<script setup lang="ts">
/**
 * 生要望（改善要望）の投稿タイムライン（改修依頼 2026-08-19 第4弾 項目5.5「【要望】ガント」）。
 * 各要望を投稿日（createdAt）に 1 目盛りのバーとして時間軸に並べ、いつ・どのステータスの要望が
 * 寄せられたかを俯瞰する（要望は対応予定期間を持たないため、改修案件ガントと異なり投稿日基準）。
 *
 * 設計判断（2026-08-20）: バー色・絞り込みのステータス軸は要望カンバン（RequestKanban）と同じく
 * **改修案件のステータス（紐づく item.status を継承・未集約/不明は未判定）**に統一する。
 * 絞り込みは改修案件ガントと同じ IMPROVEMENT_FILTER_OPTIONS / matchesImprovementFilter を共用（原則3/5/6）。
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
  IMPROVEMENT_FILTER_OPTIONS, IMPROVEMENT_STATUS_META, IMPROVEMENT_STATUSES,
  type ImprovementFilter, type ImprovementRequest, type ImprovementStatus,
  matchesImprovementFilter,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{
  requests: ImprovementRequest[]
  /** 要望 → 表示ステータス（紐づく item の status。親が items から解決して渡す。未指定 = 全件 triage） */
  itemStatusOf?: (r: ImprovementRequest) => ImprovementStatus
}>()
const emit = defineEmits<{ open: [request: ImprovementRequest] }>()

const today = todayJst()
const scale = ref<GanttScale>('month')
const anchor = ref<string>(ganttAnchorForToday('month', today))

/** 要望の表示ステータス（紐づく item の status を継承。未集約・不明は triage = RequestKanban と同一写像） */
function statusOf(r: ImprovementRequest): ImprovementStatus {
  return props.itemStatusOf?.(r) ?? 'triage'
}

/** ステータス絞り込み（既定 = すべて。選択肢・判定は改修案件と共用 = 原則3） */
const statusFilter = ref<ImprovementFilter>('all')

/** バー色（ステータス別・凡例と一致。改修案件ガント Gantt.vue の GANTT_BAR_CLASS と同配色 = 語彙統一） */
const BAR_CLASS: Record<ImprovementStatus, string> = {
  triage: 'bg-warn', // 未判定 = 要判定（アンバー）
  accepted: 'bg-brand', // 改善対応 = 予定（ブランド青）
  in_progress: 'bg-info', // 対応中 = 着手済み
  operational: 'bg-ok', // 運用対応 = 改修せず運用でカバー（決着）
  deferred: 'bg-serious', // 継続検討 = 再検討待ち
  resolved: 'bg-muted', // 解決済み = 完了（グレーで退色）
  rejected: 'bg-crit', // 対応見送り（レッド）
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

/** 絞り込み後・投稿日昇順（判定は改修案件と同じ matchesImprovementFilter = 原則3） */
const filtered = computed(() =>
  props.requests
    .filter(r => matchesImprovementFilter(statusOf(r), statusFilter.value))
    .slice()
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.id.localeCompare(b.id)))

/** 可視範囲（現在のスケール）に投稿日が入る要望のみ行に出す */
const visible = computed(() => filtered.value.filter(r => ganttBar(dateOf(r), dateOf(r), columns.value)))

const legendStatuses = computed<ImprovementStatus[]>(() =>
  IMPROVEMENT_STATUSES.filter(s => visible.value.some(r => statusOf(r) === s)))

function barOf(r: ImprovementRequest): { left: number; width: number } | null {
  const span = ganttBar(dateOf(r), dateOf(r), columns.value)
  if (!span) return null
  const n = columns.value.length
  return { left: (span.startIdx / n) * 100, width: ((span.endIdx - span.startIdx + 1) / n) * 100 }
}
function barTone(r: ImprovementRequest): string {
  return BAR_CLASS[statusOf(r)] ?? 'bg-muted'
}
function whereText(r: ImprovementRequest): string {
  const page = r.pageLabel || (r.pagePath ? pageDisplay(r.pagePath) : '')
  return [page, r.targetSpot].filter(Boolean).join(' / ')
}
function bodyLine(r: ImprovementRequest): string {
  return r.body.trim().replace(/\s*\n\s*/g, ' ')
}
function setScale(v: string): void { scale.value = v as GanttScale }
function setStatusFilter(v: string): void { statusFilter.value = v as ImprovementFilter }
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

    <!-- ステータスで絞り込み（改修案件ガントと同じ選択肢 = 紐づく案件のステータス軸） -->
    <UiChipTabs
      :model-value="statusFilter"
      :options="IMPROVEMENT_FILTER_OPTIONS"
      aria-label="ステータスで絞り込み"
      @update:model-value="setStatusFilter"
    />

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p class="text-[12px] text-muted">表示範囲: <span class="num font-semibold text-sub">{{ rangeLabel }}</span></p>
      <div v-if="legendStatuses.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-for="s in legendStatuses" :key="s" class="flex items-center gap-1 text-[11px] text-muted">
          <span class="inline-block h-2.5 w-2.5 rounded-sm" :class="BAR_CLASS[s]" aria-hidden="true" />
          {{ IMPROVEMENT_STATUS_META[s].label }}
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
              :title="`${bodyLine(r)}（${fmtDate(r.createdAt)}・${IMPROVEMENT_STATUS_META[statusOf(r)].label}）`"
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
