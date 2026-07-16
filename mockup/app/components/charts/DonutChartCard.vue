<script setup lang="ts">
/** ドーナツチャートカード（構成比。9 系列以上は「その他」に畳む） */
import type { ChartData, ChartOptions } from 'chart.js'
import { Doughnut } from 'vue-chartjs'
import { CHART_BORDER, CHART_MUTED_SLICE, SERIES_COLORS } from '~/utils/chart-theme'

const props = withDefaults(defineProps<{
  title: string
  items: { label: string; value: number }[]
  height?: number
  valueFormatter?: (v: number) => string
}>(), { height: 220, valueFormatter: undefined })

const MAX_SLICES = 6

const folded = computed(() => {
  const sorted = [...props.items].sort((a, b) => b.value - a.value)
  if (sorted.length <= MAX_SLICES) return sorted
  const head = sorted.slice(0, MAX_SLICES - 1)
  const restSum = sorted.slice(MAX_SLICES - 1).reduce((s, x) => s + x.value, 0)
  return [...head, { label: 'その他', value: restSum }]
})

const data = computed<ChartData<'doughnut'>>(() => ({
  labels: folded.value.map(i => i.label),
  datasets: [{
    data: folded.value.map(i => i.value),
    backgroundColor: folded.value.map((_, i) => i === MAX_SLICES - 1 && folded.value[i]?.label === 'その他' ? CHART_MUTED_SLICE : SERIES_COLORS[i % SERIES_COLORS.length]),
    borderWidth: 1,
    borderColor: CHART_BORDER,
  }],
}))

const options = computed<ChartOptions<'doughnut'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '62%',
  plugins: {
    legend: { position: 'right', labels: { boxWidth: 10 } },
    tooltip: props.valueFormatter
      ? { callbacks: { label: ctx => `${ctx.label}: ${props.valueFormatter!(Number(ctx.parsed))}` } }
      : {},
  },
}))
</script>

<template>
  <UiSectionCard :title="title">
    <div :style="{ height: `${height}px` }">
      <Doughnut :data="data" :options="options" />
    </div>
  </UiSectionCard>
</template>
