<script setup lang="ts">
/**
 * 改善要望の対応予定期間ガントチャート（F-42）。
 * スケール（月次=1年 / 週次=3か月 / 日次=1か月）を切り替え、前後の期間へページ送り、
 * 「今月/今週/本日」で現在の期間へスナップする。バーは各案件の planStart〜planEnd。
 * 列計算・バー配置は shared/domain/gantt の純関数。横スクロール + ラベル列は sticky（原則8）。
 */
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import {
  ganttAnchorForToday, ganttBar, ganttColumns, ganttRangeLabel, GANTT_SCALES, ganttStep,
  type GanttScale,
} from '~/types/gantt'
import { IMPROVEMENT_STATUS_META, type ImprovementItem } from '~/types/improvement'
import { fmtDate } from '~/utils/format'

const props = defineProps<{ items: ImprovementItem[] }>()
const emit = defineEmits<{ open: [item: ImprovementItem] }>()

const today = todayJst()
const scale = ref<GanttScale>('month')
const anchor = ref<string>(ganttAnchorForToday('month', today))

/** 列幅（px）。列数が多い日次ほど狭く。全体は横スクロール */
const COL_W: Record<GanttScale, number> = { month: 64, week: 52, day: 34 }
const LABEL_W = 184
const colW = computed(() => COL_W[scale.value])

const columns = computed(() => ganttColumns(scale.value, anchor.value, today))
const rangeLabel = computed(() => ganttRangeLabel(columns.value))
const gridWidth = computed(() => LABEL_W + columns.value.length * colW.value)

const scheduled = computed(() =>
  props.items.filter(it => it.planStart)
    .slice()
    .sort((a, b) => (a.planStart ?? '').localeCompare(b.planStart ?? '')))
const unscheduled = computed(() => props.items.filter(it => !it.planStart))

/** 各案件のバー（可視範囲内の列インデックス範囲。範囲外は null） */
function barOf(it: ImprovementItem): { left: number; width: number } | null {
  const span = ganttBar(it.planStart, it.planEnd, columns.value)
  if (!span) return null
  return { left: span.startIdx * colW.value, width: (span.endIdx - span.startIdx + 1) * colW.value }
}
function barTone(it: ImprovementItem): string {
  const tone = IMPROVEMENT_STATUS_META[it.status]?.tone ?? 'neutral'
  return tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'info' ? 'bg-info' : 'bg-muted'
}
function planText(it: ImprovementItem): string {
  if (!it.planStart) return ''
  return it.planEnd && it.planEnd !== it.planStart
    ? `${fmtDate(it.planStart)}〜${fmtDate(it.planEnd)}`
    : fmtDate(it.planStart)
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

    <p class="text-[12px] text-muted">表示範囲: <span class="num font-semibold text-sub">{{ rangeLabel }}</span></p>

    <!-- ガント本体（横スクロール・ラベル列は sticky） -->
    <div v-if="scheduled.length > 0" class="overflow-x-auto rounded-xl border border-line">
      <div :style="{ minWidth: `${gridWidth}px` }">
        <!-- ヘッダー行 -->
        <div class="flex border-b border-line bg-surface-soft">
          <div class="gantt-label shrink-0 px-2 py-1.5 text-[11px] font-bold text-muted" :style="{ width: `${LABEL_W}px` }">改修案件</div>
          <div
            v-for="c in columns"
            :key="c.key"
            class="shrink-0 border-l border-line py-1.5 text-center text-[10px]"
            :class="c.isToday ? 'bg-brand-soft font-bold text-brand' : 'text-muted'"
            :style="{ width: `${colW}px` }"
          >{{ c.label }}</div>
        </div>

        <!-- 案件行 -->
        <div
          v-for="it in scheduled"
          :key="it.id"
          class="flex border-b border-line last:border-b-0 hover:bg-surface-soft"
        >
          <button
            type="button"
            class="gantt-label shrink-0 truncate px-2 py-2 text-left text-[12px] font-semibold text-ink hover:text-brand"
            :style="{ width: `${LABEL_W}px` }"
            :title="it.title"
            @click="emit('open', it)"
          >{{ it.title }}</button>

          <div class="relative flex shrink-0" :style="{ height: '36px' }">
            <div
              v-for="c in columns"
              :key="c.key"
              class="shrink-0 border-l border-line"
              :class="c.isToday ? 'bg-brand-soft' : ''"
              :style="{ width: `${colW}px` }"
            />
            <button
              v-if="barOf(it)"
              type="button"
              class="absolute top-1/2 flex h-5 -translate-y-1/2 items-center overflow-hidden rounded px-1.5 text-[10px] font-semibold text-white"
              :class="barTone(it)"
              :style="{ left: `${barOf(it)!.left + 2}px`, width: `${barOf(it)!.width - 4}px` }"
              :title="`${it.title}（${planText(it)}）`"
              @click="emit('open', it)"
            >
              <span class="truncate">{{ planText(it) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
      対応予定期間が設定された改修案件はまだありません。案件を開いて「対応予定期間」を登録するとガントに表示されます。
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
          :title="it.title"
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
