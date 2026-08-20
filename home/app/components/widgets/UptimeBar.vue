<script setup lang="ts">
/** 90 日稼働率バー（日別 worstState を色分け。各日セルに「M/D 状態名」の title/aria-label。凡例付き） */
import type { UptimeDaily } from '~/types/domain'
import { fmtDate } from '~/utils/format'
import { SERVICE_STATE_LABELS } from '~/utils/labels'

const props = defineProps<{ days: UptimeDaily[] }>()

/** ステータストークンで日別色分け（系列色は使用しない） */
const STATE_COLOR: Record<UptimeDaily['worstState'], string> = {
  operational: 'var(--c-ok)',
  degraded: 'var(--c-warn)',
  partial_outage: 'var(--c-serious)',
  major_outage: 'var(--c-crit)',
  maintenance: 'var(--c-info)',
}

/** 凡例の表示順（正常 → 障害の重さ順 → メンテ） */
const LEGEND_STATES: UptimeDaily['worstState'][] = [
  'operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance',
]

/** 各日セルの title / aria-label（「M/D 状態名」+ 停止分数） */
function titleOf(d: UptimeDaily): string {
  const base = `${fmtDate(d.date)} ${SERVICE_STATE_LABELS[d.worstState] ?? d.worstState}`
  return d.downMinutes > 0 ? `${base}（停止 ${d.downMinutes} 分）` : base
}

const firstDate = computed(() => {
  const d = props.days[0]
  return d ? fmtDate(`${d.date}T00:00:00`) : ''
})
</script>

<template>
  <div>
    <div
      class="flex h-7 items-stretch gap-px"
      role="group"
      :aria-label="`過去 ${days.length} 日間の日別稼働状況`"
    >
      <span
        v-for="d in days"
        :key="d.date"
        class="min-w-0 flex-1 rounded-[1px]"
        :style="{ backgroundColor: STATE_COLOR[d.worstState] }"
        :title="titleOf(d)"
        role="img"
        :aria-label="titleOf(d)"
      />
    </div>
    <div class="mt-1 flex items-center justify-between text-[10px] text-muted">
      <span class="num">{{ firstDate }}</span>
      <span>{{ days.length }} 日間</span>
      <span>昨日</span>
    </div>
    <!-- 凡例（色だけに頼らずラベル併記） -->
    <ul class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="稼働状況の凡例">
      <li
        v-for="s in LEGEND_STATES"
        :key="s"
        class="flex items-center gap-1 text-[10px] text-sub"
      >
        <span
          class="inline-block h-2 w-2 shrink-0 rounded-[2px]"
          :style="{ backgroundColor: STATE_COLOR[s] }"
          aria-hidden="true"
        />
        {{ SERVICE_STATE_LABELS[s] ?? s }}
      </li>
    </ul>
  </div>
</template>
