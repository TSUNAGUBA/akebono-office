<script setup lang="ts">
/**
 * 業務 × メディアの簡易ファネル可視化（セッション → 主体的関与 → コンバージョン → 受注）。
 * Chart.js を使わず、段階ごとの幅バーと遷移率で直感的に見せる（色だけに頼らず数値・率を併記）。
 */
import { fmtInt } from '~/utils/format'

const props = defineProps<{
  stages: { label: string; value: number }[]
}>()

const max = computed(() => Math.max(1, ...props.stages.map(s => s.value)))
function widthPct(v: number): number {
  return Math.max(4, Math.round(v / max.value * 100))
}
/** 前段からの遷移率（0 段目は null） */
function stepRate(i: number): number | null {
  if (i === 0) return null
  const prev = props.stages[i - 1]?.value ?? 0
  return prev > 0 ? (props.stages[i]!.value / prev) : null
}
const STAGE_COLORS = ['bg-brand', 'bg-info', 'bg-warn', 'bg-ok']
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(s, i) in stages" :key="s.label" class="grid gap-1">
      <div class="flex items-baseline justify-between gap-2 text-[12px]">
        <span class="font-semibold">{{ s.label }}</span>
        <span class="num text-sub">
          {{ fmtInt(s.value) }}
          <span v-if="stepRate(i) !== null" class="ml-1 text-[11px] text-muted">
            （前段比 {{ Math.round((stepRate(i) as number) * 1000) / 10 }}%）
          </span>
        </span>
      </div>
      <div class="h-6 w-full overflow-hidden rounded bg-page">
        <div
          class="flex h-full items-center rounded transition-all"
          :class="STAGE_COLORS[i % STAGE_COLORS.length]"
          :style="{ width: `${widthPct(s.value)}%` }"
          role="img"
          :aria-label="`${s.label} ${s.value}`"
        />
      </div>
    </div>
  </div>
</template>
