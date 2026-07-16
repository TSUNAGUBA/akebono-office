<script lang="ts">
/** 月間カレンダーのセルデータ（集計は親が行い、この契約で渡す） */
export interface CalendarDayCell {
  date: string // YYYY-MM-DD
  /** 実労働分（0 は非表示） */
  workMinutes: number
  /** 法定休日（グレー表示） */
  legalHoliday: boolean
  /** アラート日（warn 表示: 休憩不足・60h超残業など） */
  alert: boolean
  /** 承認済み休暇 */
  leave: boolean
}
</script>

<script setup lang="ts">
/**
 * 月間カレンダー（F-04-3 月次ビューの表示ウィジェット）
 * 表示専用: 集計は親（useAttendance.monthSummary）が SoT。
 * モバイルではコンテナ内横スクロール（ページ全体は横スクロールさせない）。
 */
import { fmtMinutes, toDateKey, weekdayOf } from '~/utils/format'

const props = withDefaults(defineProps<{
  month: string // YYYY-MM
  days: CalendarDayCell[]
  selectedDate?: string
}>(), { selectedDate: '' })

const emit = defineEmits<{ select: [date: string] }>()

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

const todayKey = todayJst()
const leadingBlanks = computed(() => weekdayOf(`${props.month}-01`))

function dayNum(date: string): number {
  return Number(date.slice(8, 10))
}

function cellLabel(d: CalendarDayCell): string {
  const parts = [`${Number(props.month.slice(5, 7))}月${dayNum(d.date)}日`]
  if (d.workMinutes > 0) parts.push(`勤務 ${fmtMinutes(d.workMinutes)}`)
  if (d.leave) parts.push('休暇')
  if (d.legalHoliday) parts.push('法定休日')
  if (d.alert) parts.push('アラートあり')
  parts.push('選択すると日次表示')
  return parts.join('、')
}
</script>

<template>
  <div class="overflow-x-auto scroll-slim">
    <div class="min-w-[560px]">
      <div class="grid grid-cols-7 gap-1">
        <div
          v-for="(w, i) in WEEKDAYS"
          :key="w"
          class="pb-1 text-center text-[11px] font-semibold"
          :class="i === 0 ? 'text-serious' : 'text-muted'"
        >{{ w }}</div>
      </div>
      <div class="grid grid-cols-7 gap-1">
        <div v-for="n in leadingBlanks" :key="`blank-${n}`" aria-hidden="true" />
        <button
          v-for="d in days"
          :key="d.date"
          type="button"
          class="flex min-h-[52px] flex-col rounded-lg border p-1.5 text-left transition-colors"
          :class="[
            d.legalHoliday
              ? 'border-line bg-page'
              : d.alert
                ? 'border-warn bg-warn-soft hover:border-brand'
                : 'border-line bg-surface hover:border-brand',
            selectedDate === d.date ? 'ring-2 ring-brand' : '',
          ]"
          :aria-label="cellLabel(d)"
          @click="emit('select', d.date)"
        >
          <span class="flex w-full items-center justify-between">
            <span
              class="num text-[11px] font-semibold leading-none"
              :class="d.date === todayKey
                ? 'rounded bg-brand px-1 py-0.5 text-white'
                : d.legalHoliday ? 'text-muted' : 'text-sub'"
            >{{ dayNum(d.date) }}</span>
            <span v-if="d.alert" class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
          </span>
          <span
            v-if="d.workMinutes > 0"
            class="num mt-auto text-[12px] font-bold"
            :class="d.alert ? 'text-warn' : 'text-ink'"
          >{{ fmtMinutes(d.workMinutes) }}</span>
          <span v-else-if="d.leave" class="mt-auto text-[10px] font-semibold text-info">休暇</span>
          <span v-else class="mt-auto text-[10px] text-muted" aria-hidden="true">—</span>
        </button>
      </div>
    </div>
  </div>
</template>
