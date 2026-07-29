<script setup lang="ts">
/**
 * 着地予報の滑走路ボード（F-01 §3 ④。既定は閉 = CockpitStrip の予報 1 行から開閉）
 * - 滑走路バーは CSS のみ: トラック（bg-neutral-soft）に実績塗り（bg-brand）+ 予測マーカー（bg-ink）
 *   + 目標ティック（bg-line-strong）。ステータス色（ok/warn）は tone バッジのみに使用する
 * - 各行に reason 1 行（予報の透明性）+ 針路修正 1 件（最大乖離の warn への導線）
 * - goals 空 かつ 予報 0 本は「目標が未設定です」+ admin のみ /masters/goals への導線
 */
import { Navigation } from 'lucide-vue-next'
import type { CockpitForecastView } from '~/composables/useCockpit'
import { fmtCockpitValue } from '~/utils/cockpit'

const props = defineProps<{
  forecasts: CockpitForecastView[]
  correction: CockpitForecastView | null
  goalsEmpty: boolean
  isAdmin: boolean
}>()

/** バーのスケール（実績・予測が目標を超えても収まるよう最大比率で正規化） */
function scaleOf(f: CockpitForecastView): number {
  return Math.max(1, f.progressRatio, f.projectedRatio)
}

function pct(ratio: number, f: CockpitForecastView): string {
  return `${Math.round(Math.min(1, Math.max(0, ratio / scaleOf(f))) * 1000) / 10}%`
}

const showEmpty = computed(() => props.goalsEmpty && props.forecasts.length === 0)
</script>

<template>
  <UiSectionCard
    id="cockpit-forecast"
    title="着地予報"
    description="月次目標に対する着地見込み（営業日の日割りペース。率は外挿しない）"
  >
    <template v-if="isAdmin && !showEmpty" #actions>
      <NuxtLink to="/masters/goals" class="link text-xs font-semibold">目標を編集</NuxtLink>
    </template>

    <!-- 目標未設定（goals 空 かつ 予報 0 本） -->
    <div v-if="showEmpty" class="py-2 text-center">
      <p class="text-[13px] font-semibold">目標が未設定です</p>
      <p class="mt-0.5 text-xs text-muted">月次目標を登録すると、目標に対する着地見込みをここに表示します</p>
      <NuxtLink v-if="isAdmin" to="/masters/goals" class="btn btn-sm mt-2.5">目標を設定する</NuxtLink>
    </div>

    <ul v-else class="grid gap-3">
      <li v-for="f in forecasts" :key="f.id" class="grid gap-1">
        <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <p class="flex items-center gap-1.5 text-[13px] font-semibold">
            {{ f.label }}
            <UiStatusBadge :label="f.tone === 'warn' ? '注意' : '順調'" :tone="f.tone" dot />
          </p>
          <p class="num text-[11px] text-sub">
            実績 {{ fmtCockpitValue(f.current, f.unit) }} → 着地 {{ fmtCockpitValue(f.projected, f.unit) }}
            / {{ f.inverse ? '上限' : '目標' }} {{ fmtCockpitValue(f.target, f.unit) }}
          </p>
        </div>
        <!-- 滑走路バー（実績塗り + 予測マーカー + 目標ティック。値はテキストで併記済み） -->
        <div class="relative h-2.5 rounded-full bg-neutral-soft" aria-hidden="true">
          <div class="absolute inset-y-0 left-0 rounded-full bg-brand" :style="{ width: pct(f.progressRatio, f) }" />
          <div class="absolute -inset-y-0.5 w-1 -translate-x-1/2 rounded-full bg-ink" :style="{ left: pct(f.projectedRatio, f) }" />
          <div class="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded bg-line-strong" :style="{ left: pct(1, f) }" />
        </div>
        <p class="text-[11px] text-muted">{{ f.reason }}</p>
      </li>
    </ul>

    <!-- 針路修正 1 件（最も乖離が大きい warn への対処導線） -->
    <div v-if="correction" class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-soft px-2.5 py-2">
      <p class="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-warn">
        <Navigation class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">針路修正: {{ correction.label }}</span>
      </p>
      <NuxtLink :to="correction.to" class="btn btn-sm w-full sm:w-auto">対処する</NuxtLink>
    </div>
  </UiSectionCard>
</template>
