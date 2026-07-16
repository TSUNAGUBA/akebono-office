<script setup lang="ts">
/**
 * シフト調整グリッド（縦=スタッフ・横=期間内日付）
 * - セル = 希望マーク（○/×/△）+ 割当チップ（時間帯）。クリックで親へ通知（割当モーダルは親が所有）
 * - 上部に日別の必要人数 vs 割当人数の過不足バー（不足=crit / 充足=ok）
 * - モバイルはコンテナ内横スクロール（スタッフ列は sticky）
 */
import type { ShiftAssignmentStatus, ShiftPeriod, ShiftWishKind } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { fmtDate, weekdayOf } from '~/utils/format'
import { SHIFT_WISH_LABELS } from '~/utils/labels'
import {
  ageAt, periodDates, SHIFT_ASSIGNMENT_STATUS_LABELS, SHIFT_WISH_MARKS,
} from '~/composables/useShifts'

const props = defineProps<{ period: ShiftPeriod }>()
const emit = defineEmits<{ cell: [memberId: string, date: string] }>()

const shifts = useShifts()
const { staffMembers } = shifts

const dates = computed(() => periodDates(props.period))
const coverage = computed(() => shifts.dayCoverage(props.period.id))

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'] as const

const MARK_CLASS: Record<Tone, string> = {
  ok: 'text-ok', warn: 'text-warn', crit: 'text-crit',
  serious: 'text-serious', info: 'text-info', brand: 'text-brand', neutral: 'text-sub',
}

const CHIP_CLASS: Record<ShiftAssignmentStatus, string> = {
  tentative: 'bg-brand-soft text-brand',
  confirmed: 'bg-ok-soft text-ok',
  change_requested: 'bg-warn-soft text-warn',
}

function dayHeadClass(date: string): string {
  const dow = weekdayOf(date)
  if (dow === 0) return 'text-crit'
  if (dow === 6) return 'text-info'
  return 'text-sub'
}

function markOf(wish: ShiftWishKind): { symbol: string; cls: string } {
  const m = SHIFT_WISH_MARKS[wish]
  return { symbol: m.symbol, cls: MARK_CLASS[m.tone] }
}
</script>

<template>
  <div>
    <UiEmptyState
      v-if="staffMembers.length === 0"
      icon="Users"
      title="対象スタッフがいません"
      hint="アルバイト・パートの在籍メンバーが調整対象になります"
    />
    <div v-else class="overflow-x-auto scroll-slim">
      <table class="w-full border-collapse" aria-label="シフト調整グリッド（縦: スタッフ、横: 日付）">
        <thead>
          <tr>
            <th class="sticky left-0 z-10 min-w-[104px] border-b border-r border-line bg-surface px-2 py-1.5 text-left text-[11px] font-bold text-sub">
              スタッフ
            </th>
            <th
              v-for="d in dates"
              :key="d"
              class="min-w-[76px] border-b border-line px-1 py-1.5 text-center text-[11px] font-semibold"
              :class="dayHeadClass(d)"
            >
              <span class="num">{{ fmtDate(d) }}</span>
              <span class="ml-0.5">({{ WEEKDAY_JP[weekdayOf(d)] }})</span>
            </th>
          </tr>
          <!-- 日別の必要人数 vs 割当人数（過不足バー） -->
          <tr>
            <th class="sticky left-0 z-10 border-b border-r border-line bg-surface px-2 py-1 text-left text-[10px] font-semibold text-muted">
              割当 / 必要
            </th>
            <td
              v-for="c in coverage"
              :key="c.date"
              class="border-b border-line px-1.5 py-1 text-center align-middle"
            >
              <template v-if="c.required > 0">
                <span
                  class="num text-[11px] font-bold"
                  :class="c.assigned >= c.required ? 'text-ok' : 'text-crit'"
                >{{ c.assigned }}/{{ c.required }}</span>
                <div
                  class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[#eef0f2]"
                  role="img"
                  :aria-label="`${fmtDate(c.date)}: 必要${c.required}名に対し割当${c.assigned}名（${c.assigned >= c.required ? '充足' : `${c.required - c.assigned}名不足`}）`"
                >
                  <div
                    class="h-full rounded-full transition-all"
                    :class="c.assigned >= c.required ? 'bg-ok' : 'bg-crit'"
                    :style="{ width: `${Math.min(100, (c.assigned / c.required) * 100)}%` }"
                  />
                </div>
              </template>
              <span v-else class="text-[10px] text-muted">—</span>
            </td>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in staffMembers" :key="m.id">
            <th
              scope="row"
              class="sticky left-0 z-10 border-b border-r border-line bg-surface px-2 py-1 text-left align-middle"
            >
              <span class="block text-[12px] font-semibold leading-tight">{{ m.name }}</span>
              <span
                v-if="ageAt(m.birthDate, period.startDate) < 18"
                class="mt-0.5 inline-block rounded-full bg-warn-soft px-1.5 text-[10px] font-semibold text-warn"
              >{{ ageAt(m.birthDate, period.startDate) }}歳・深夜不可</span>
            </th>
            <td v-for="d in dates" :key="d" class="border-b border-line p-0.5 align-middle">
              <button
                type="button"
                class="flex min-h-[44px] w-full flex-col items-center justify-center gap-0.5 rounded-md px-0.5 py-1 transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand"
                :aria-label="`${m.name} ${fmtDate(d)}（${WEEKDAY_JP[weekdayOf(d)]}）の割当を編集`"
                @click="emit('cell', m.id, d)"
              >
                <span
                  v-if="shifts.wishOf(period.id, m.id, d)"
                  class="text-[12px] font-bold leading-none"
                  :class="markOf(shifts.wishOf(period.id, m.id, d)!.wish).cls"
                  :title="`希望: ${SHIFT_WISH_LABELS[shifts.wishOf(period.id, m.id, d)!.wish]}`"
                >{{ markOf(shifts.wishOf(period.id, m.id, d)!.wish).symbol }}<span class="sr-only">（希望: {{ SHIFT_WISH_LABELS[shifts.wishOf(period.id, m.id, d)!.wish] }}）</span></span>
                <span
                  v-if="shifts.assignmentAt(period.id, m.id, d)"
                  class="num rounded px-1 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap"
                  :class="CHIP_CLASS[shifts.assignmentAt(period.id, m.id, d)!.status]"
                  :title="SHIFT_ASSIGNMENT_STATUS_LABELS[shifts.assignmentAt(period.id, m.id, d)!.status]"
                >{{ shifts.assignmentAt(period.id, m.id, d)!.from }}-{{ shifts.assignmentAt(period.id, m.id, d)!.to }}</span>
                <span
                  v-if="!shifts.wishOf(period.id, m.id, d) && !shifts.assignmentAt(period.id, m.id, d)"
                  class="text-[10px] text-muted"
                  aria-hidden="true"
                >—</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mt-1.5 text-[10px] text-muted">
      記号は本人希望（○=出勤希望 / ×=NG / △=どちらでも）。チップは割当時間帯。セルをクリックすると割当を編集できます。
    </p>
  </div>
</template>
