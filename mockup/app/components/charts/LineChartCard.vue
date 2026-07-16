<script setup lang="ts">
/** 折れ線チャートカード（系列色はデザイントークンの固定順） */
import type { ChartData, ChartOptions } from 'chart.js'
import { Line } from 'vue-chartjs'
import { SERIES_COLORS } from '~/utils/chart-theme'

const props = withDefaults(defineProps<{
  title: string
  labels: string[]
  series: { label: string; data: (number | null)[] }[]
  height?: number
  yFormatter?: (v: number) => string
}>(), { height: 240, yFormatter: undefined })

const data = computed<ChartData<'line'>>(() => ({
  labels: props.labels,
  datasets: props.series.map((s, i) => ({
    label: s.label,
    data: s.data,
    borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
    backgroundColor: `${SERIES_COLORS[i % SERIES_COLORS.length]}22`,
    borderWidth: 2,
    pointRadius: 2,
    tension: 0.3,
    fill: false,
  })),
}))

const options = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: props.series.length >= 2, position: 'bottom' },
  },
  scales: {
    y: {
      beginAtZero: true,
      ticks: props.yFormatter ? { callback: v => props.yFormatter!(Number(v)) } : {},
      grid: { color: '#eef0f2' },
    },
    x: { grid: { display: false } },
  },
}))
</script>

<template>
  <UiSectionCard :title="title">
    <div :style="{ height: `${height}px` }">
      <Line :data="data" :options="options" />
    </div>
  </UiSectionCard>
</template>
