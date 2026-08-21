<script setup lang="ts">
/**
 * 比較値つき KPI カード（改善要望 2026-08-21 = サマリーの各カードに前週比 / 4週平均比 / 前年同期比を表示）。
 * UiKpiCard と同じカード様式に、直近 7 日の値と 3 つの比較行を積む（/media ハブ・/media/analytics で共用）。
 * 比較が算出できない場合（前年データなし・系列不足）は「—」（誤読させない = 原則7）。
 */
import * as icons from 'lucide-vue-next'
// resolveComponent('NuxtLink') は本番ビルドで解決されないため実体を import する（UiKpiCard と同じ対応）
import { NuxtLink } from '#components'
import { fmtRatio } from '../../../../shared/domain/media-weekly-report'

const props = withDefaults(defineProps<{
  label: string
  /** 集計期間（28 日）の値（整形済み文字列） */
  value: string
  /** 補足（直近 7 日の値など） */
  sub?: string
  icon?: string
  to?: string
  /** 比較値（null = 算出不可 = 「—」表示。いずれも直近 7 日の値に対する比較） */
  wow: number | null
  fourWeekAvg: number | null
  yoy: number | null
}>(), { sub: '', icon: '', to: '' })

const iconComp = computed(() => {
  if (!props.icon) return null
  return (icons as Record<string, unknown>)[props.icon] ?? null
})

const ROWS = [
  { key: 'wow', label: '前週比' },
  { key: 'fourWeekAvg', label: '4週平均比' },
  { key: 'yoy', label: '前年同期比' },
] as const

// 比率の整形は shared の fmtRatio（週次レポート・比較の単一実装 = 原則3）
function ratioTone(r: number | null): string {
  if (r === null || r === 0) return 'text-sub'
  return r > 0 ? 'text-ok' : 'text-crit'
}
</script>

<template>
  <component
    :is="to ? NuxtLink : 'div'"
    :to="to || undefined"
    class="card block px-3 py-2.5"
    :class="to ? 'transition-colors hover:border-brand cursor-pointer' : ''"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] font-semibold text-muted">{{ label }}</p>
      <component :is="iconComp" v-if="iconComp" class="h-4 w-4 text-muted" aria-hidden="true" />
    </div>
    <p class="num mt-0.5 text-xl font-bold leading-tight">{{ value }}</p>
    <p v-if="sub" class="mt-0.5 text-[11px] text-muted">{{ sub }}</p>
    <dl class="mt-1.5 grid gap-0.5 border-t border-line pt-1.5">
      <div v-for="row in ROWS" :key="row.key" class="flex items-baseline justify-between gap-2 text-[11px]">
        <dt class="text-muted">{{ row.label }}</dt>
        <dd class="num font-semibold" :class="ratioTone(props[row.key])">{{ fmtRatio(props[row.key]) }}</dd>
      </div>
    </dl>
  </component>
</template>
