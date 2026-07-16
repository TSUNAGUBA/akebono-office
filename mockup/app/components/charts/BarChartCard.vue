<script setup lang="ts">
/** 棒チャートカード（horizontal で横棒） */
import type { ChartData, ChartOptions } from 'chart.js'
import { Bar } from 'vue-chartjs'
import { SERIES_COLORS } from '~/utils/chart-theme'

const props = withDefaults(defineProps<{
  title: string
  labels: string[]
  series: { label: string; data: number[] }[]
  horizontal?: boolean
  height?: number
  yFormatter?: (v: number) => string
}>(), { horizontal: false, height: 240, yFormatter: undefined })

const data = computed<ChartData<'bar'>>(() => ({
  labels: props.labels,
  datasets: props.series.map((s, i) => ({
    label: s.label,
    data: s.data,
    backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
    barMaxWidth: 24,
    borderRadius: 3,
  } as never)),
}))

const options = computed<ChartOptions<'bar'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: props.horizontal ? 'y' : 'x',
  plugins: {
    legend: { display: props.series.length >= 2, position: 'bottom' },
  },
  scales: {
    [props.horizontal ? 'x' : 'y']: {
      beginAtZero: true,
      ticks: props.yFormatter ? { callback: (v: unknown) => props.yFormatter!(Number(v)) } : {},
      grid: { color: '#eef0f2' },
    },
    [props.horizontal ? 'y' : 'x']: { grid: { display: false } },
  } as ChartOptions<'bar'>['scales'],
}))
</script>

<template>
  <UiSectionCard :title="title">
    <div :style="{ height: `${height}px` }">
      <Bar :data="data" :options="options" />
    </div>
  </UiSectionCard>
</template>
