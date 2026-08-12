<script setup lang="ts">
/**
 * 改善要望の対応予定期間ガントチャート（F-42）。
 * スケール（月次=1年 / 週次=3か月 / 日次=1か月）を切り替え、前後の期間へページ送り、
 * 「今月/今週/本日」で現在の期間へスナップする。バーは各案件の planStart〜planEnd。
 * 列計算・バー配置は shared/domain/gantt の純関数。
 * 列は画面幅に合わせて等分に伸縮（flex）。狭い画面では最小幅で横スクロール・ラベル列は sticky（原則8）。
 */
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import {
  ganttAnchorForToday, ganttBar, ganttColumns, ganttRangeLabel, GANTT_SCALES, ganttStep,
  type GanttScale,
} from '~/types/gantt'
import {
  IMPROVEMENT_FILTER_OPTIONS, IMPROVEMENT_STATUS_META, IMPROVEMENT_STATUSES,
  type ImprovementFilter, type ImprovementItem, type ImprovementStatus,
  matchesImprovementFilter,
} from '~/types/improvement'
import { fmtDate } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const props = defineProps<{ items: ImprovementItem[] }>()
const emit = defineEmits<{ open: [item: ImprovementItem] }>()

const today = todayJst()
const scale = ref<GanttScale>('month')
const anchor = ref<string>(ganttAnchorForToday('month', today))

// ステータスフィルタ（既定 = accepted = 実装が決まっていて未完了の案件。オペレーター指示 2026-08-12）。
// 一覧ビューと同じ選択肢・判定（IMPROVEMENT_FILTER_OPTIONS / matchesImprovementFilter）を共用する（原則3）。
const statusFilter = ref<ImprovementFilter>('accepted')
const filteredItems = computed(() =>
  props.items.filter(it => matchesImprovementFilter(it.status, statusFilter.value)))

/**
 * ガントのバー色（ステータス別・凡例と一致）。完了（解決済み）はグレーで区別し、他は色分けする（オペレーター指示 2026-08-12）。
 * 一覧のバッジ（IMPROVEMENT_STATUS_META.tone）とは目的が異なる（ガントは「完了 = 退色グレー」を優先）ため専用マップ。
 */
const GANTT_BAR_CLASS: Record<ImprovementStatus, string> = {
  triage: 'bg-warn', // 未判定 = 要判定（アンバー）
  accepted: 'bg-brand', // 対応する = 予定・進行中（ブランド青。既定フィルタの主対象）
  resolved: 'bg-muted', // 解決済み = 完了（グレーで退色）
  rejected: 'bg-crit', // 対応しない = 見送り（レッド）
}
/** 決着済み（完了・見送り）は退色させて「終わった案件」を視覚的に沈める */
const CLOSED_STATUSES: ImprovementStatus[] = ['resolved', 'rejected']

/** 列の最小幅（px）。画面が広ければ flex で等分に伸び、狭ければこの幅で横スクロール */
const MIN_COL_W: Record<GanttScale, number> = { month: 56, week: 44, day: 30 }
const LABEL_W = 200
const minColW = computed(() => MIN_COL_W[scale.value])

const columns = computed(() => ganttColumns(scale.value, anchor.value, today))
const rangeLabel = computed(() => ganttRangeLabel(columns.value))
/** 狭い画面での横スクロール下限（列は最小幅・ラベル固定）。広ければ 100% に伸びて等分 */
const minWidth = computed(() => `${LABEL_W + columns.value.length * minColW.value}px`)

const scheduled = computed(() =>
  filteredItems.value.filter(it => it.planStart)
    .slice()
    .sort((a, b) => (a.planStart ?? '').localeCompare(b.planStart ?? '')))
const unscheduled = computed(() => filteredItems.value.filter(it => !it.planStart))

/** 凡例（実際にバーとして表示中のステータスのみ = バーの色と厳密に一致。未定チップは別バッジのため対象外） */
const legendStatuses = computed<ImprovementStatus[]>(() =>
  IMPROVEMENT_STATUSES.filter(s => scheduled.value.some(it => it.status === s)))

/** 予定期間バーの位置（トラック幅に対する割合。列の等分伸縮に追従する） */
function barOf(it: ImprovementItem): { left: number; width: number } | null {
  const span = ganttBar(it.planStart, it.planEnd, columns.value)
  if (!span) return null
  const n = columns.value.length
  return { left: (span.startIdx / n) * 100, width: ((span.endIdx - span.startIdx + 1) / n) * 100 }
}
function barTone(it: ImprovementItem): string {
  return GANTT_BAR_CLASS[it.status] ?? 'bg-muted'
}
function isClosed(it: ImprovementItem): boolean {
  return CLOSED_STATUSES.includes(it.status)
}
function setStatusFilter(v: string): void { statusFilter.value = v as ImprovementFilter }
function planText(it: ImprovementItem): string {
  if (!it.planStart) return ''
  return it.planEnd && it.planEnd !== it.planStart
    ? `${fmtDate(it.planStart)}〜${fmtDate(it.planEnd)}`
    : fmtDate(it.planStart)
}
function pagesText(it: ImprovementItem): string {
  return it.pagePaths.map(pageDisplay).join(' / ')
}

function setScale(v: string): void { scale.value = v as GanttScale }
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

    <!-- ステータスで絞り込み（既定 = 対応する = 実装が決まっていて未完了。一覧ビューと同じ選択肢） -->
    <UiChipTabs
      :model-value="statusFilter"
      :options="IMPROVEMENT_FILTER_OPTIONS"
      aria-label="ステータスで絞り込み"
      @update:model-value="setStatusFilter"
    />

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p class="text-[12px] text-muted">表示範囲: <span class="num font-semibold text-sub">{{ rangeLabel }}</span></p>
      <!-- 凡例（バーの色 = ステータス。完了＝グレー・見送り＝レッドで退色） -->
      <div v-if="legendStatuses.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-for="s in legendStatuses" :key="s" class="flex items-center gap-1 text-[11px] text-muted">
          <span
            class="inline-block h-2.5 w-2.5 rounded-sm"
            :class="[GANTT_BAR_CLASS[s], CLOSED_STATUSES.includes(s) ? 'opacity-80' : '']"
            aria-hidden="true"
          />
          {{ IMPROVEMENT_STATUS_META[s].label }}
        </span>
      </div>
    </div>

    <!-- ガント本体（列は等分伸縮・狭い画面は横スクロール・ラベル列は sticky） -->
    <div v-if="scheduled.length > 0" class="overflow-x-auto rounded-xl border border-line">
      <div :style="{ minWidth }">
        <!-- ヘッダー行 -->
        <div class="flex border-b border-line bg-surface-soft">
          <div class="gantt-label shrink-0 px-2 py-1.5 text-[11px] font-bold text-muted" :style="{ width: `${LABEL_W}px` }">改修案件</div>
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

        <!-- 案件行 -->
        <div
          v-for="it in scheduled"
          :key="it.id"
          class="flex border-b border-line last:border-b-0 hover:bg-surface-soft"
        >
          <button
            type="button"
            class="gantt-label shrink-0 px-2 py-1.5 text-left"
            :style="{ width: `${LABEL_W}px` }"
            :title="`${it.title}｜${pagesText(it)}`"
            @click="emit('open', it)"
          >
            <span class="block truncate text-[12px] font-semibold text-ink hover:text-brand">{{ it.title }}</span>
            <span v-if="pagesText(it)" class="block truncate text-[10px] text-muted">{{ pagesText(it) }}</span>
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
              v-if="barOf(it)"
              type="button"
              class="absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-[10px] font-semibold text-white"
              :class="[barTone(it), isClosed(it) ? 'opacity-80' : '']"
              :style="{ left: `calc(${barOf(it)!.left}% + 2px)`, width: `calc(${barOf(it)!.width}% - 4px)` }"
              :title="`${it.title}（${planText(it)}・${IMPROVEMENT_STATUS_META[it.status].label}）`"
              @click="emit('open', it)"
            >
              <span class="truncate">{{ planText(it) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
      <template v-if="statusFilter !== 'all'">
        この絞り込み条件に該当する、対応予定期間つきの改修案件はありません。フィルタを変えるか、案件を開いて「対応予定期間」を登録してください。
      </template>
      <template v-else>
        対応予定期間が設定された改修案件はまだありません。案件を開いて「対応予定期間」を登録するとガントに表示されます。
      </template>
    </div>

    <!-- 予定未定の案件 -->
    <div v-if="unscheduled.length > 0" class="grid gap-1.5">
      <p class="text-[12px] font-semibold text-muted">対応予定 未定（{{ unscheduled.length }}）</p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="it in unscheduled"
          :key="it.id"
          type="button"
          class="rounded-lg border border-line px-2.5 py-1.5 text-left text-[12px] hover:border-brand"
          :title="`${it.title}｜${pagesText(it)}`"
          @click="emit('open', it)"
        >
          <UiStatusBadge :tone="IMPROVEMENT_STATUS_META[it.status].tone" :label="IMPROVEMENT_STATUS_META[it.status].label" dot />
          <span class="ml-1.5">{{ it.title }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gantt-label {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--surface, #fff);
  border-right: 1px solid var(--line, #e5e7eb);
}
</style>
