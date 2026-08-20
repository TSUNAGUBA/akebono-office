<script setup lang="ts">
/** 棒チャートカード（horizontal で横棒） */
import type { ChartData, ChartOptions } from 'chart.js'
import { Bar } from 'vue-chartjs'
import { CHART_GRID, SERIES_COLORS } from '~/utils/chart-theme'

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
      grid: { color: CHART_GRID },
    },
    [props.horizontal ? 'y' : 'x']: {
      grid: { display: false },
      // 横棒の項目ラベルは長文（記事タイトル等）だと canvas 幅を超えて先頭が切断される
      // （モバイル・UnitI 検出）。チャート幅から上限字数を導出して表示のみ省略（ツールチップは全文。
      // デスクトップは広い分だけ長く表示 = レビュー R1）。コードポイント単位 = 絵文字を境界で壊さない
      ...(props.horizontal
        ? { ticks: { callback(this: { chart: { width: number }; getLabelForValue: (v: number) => string }, v: unknown) {
            const label = this.getLabelForValue(Number(v))
            const max = Math.max(12, Math.floor(this.chart.width / 28))
            const cps = [...label]
            return cps.length > max ? `${cps.slice(0, max).join('')}…` : label
          } } }
        : {}),
    },
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
