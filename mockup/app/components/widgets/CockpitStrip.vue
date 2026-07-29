<script setup lang="ts">
/**
 * コックピット・ストリップ（F-01 §3 ①: フレーム + 地平線 1 行）
 * 挨拶・氏名・日付（旧 index.vue の UiPageHeader 相当を内包）+ フェーズバッジ + 今日の完了メーター
 * + 着地予報 1 行（タップで CockpitForecast の開閉をトグル = emit のみ。状態は親が持つ）
 */
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import * as icons from 'lucide-vue-next'
import type { CockpitMeter, CockpitPhase } from '~/utils/cockpit'
import { fmtDateLong } from '~/utils/format'

const props = defineProps<{
  phase: CockpitPhase
  meter: CockpitMeter
  forecast: { headline: string; tone: 'ok' | 'warn'; badge: string; available: boolean }
  expanded: boolean
}>()

const emit = defineEmits<{ 'toggle-forecast': [] }>()

const { currentUser } = useCurrentUser()

// 挨拶（旧 pages/index.vue から移設。JST 壁時計 = jstClock を使用）
const greeting = computed(() => {
  const h = Number(jstClock().h)
  if (h < 5) return 'お疲れさまです'
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'こんにちは'
  return 'こんばんは'
})
const todayLong = computed(() => fmtDateLong(nowJstIso()))

const phaseIcon = computed(() => {
  if (!props.phase.icon) return null
  return (icons as Record<string, unknown>)[props.phase.icon] ?? null
})
</script>

<template>
  <section class="card p-3" aria-label="今日のブリーフィング">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <div class="min-w-0">
        <h1 class="text-base font-bold leading-tight">{{ greeting }}、{{ currentUser.name }} さん</h1>
        <p class="mt-0.5 text-xs text-muted">{{ todayLong }}</p>
      </div>
      <div v-if="phase.key !== 'none'" class="flex shrink-0 items-center gap-1.5" aria-label="今日の状態">
        <component :is="phaseIcon" v-if="phaseIcon" class="h-4 w-4 text-sub" aria-hidden="true" />
        <UiStatusBadge :label="phase.label" :tone="phase.tone" dot />
      </div>
    </div>

    <!-- 今日の完了メーター（一手が 0 件の日は非表示 = 分母 0 を祝わない） -->
    <div v-if="meter.visible" class="mt-2.5">
      <div class="flex items-center justify-between text-[11px] text-muted">
        <span>今日の完了メーター</span>
        <span class="num font-semibold">{{ meter.done }}/{{ meter.total }}</span>
      </div>
      <div
        class="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-soft"
        role="progressbar"
        :aria-valuenow="meter.done"
        :aria-valuemin="0"
        :aria-valuemax="meter.total"
        :aria-label="`今日の一手 ${meter.done} / ${meter.total} 完了`"
      >
        <div class="h-full rounded-full bg-brand transition-all" :style="{ width: `${Math.round(meter.ratio * 100)}%` }" />
      </div>
    </div>

    <!-- 着地予報 1 行（タップで滑走路ボードを開閉） -->
    <button
      v-if="forecast.available"
      type="button"
      class="mt-2.5 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-2 text-left transition-colors hover:bg-brand-soft"
      :aria-expanded="expanded"
      aria-controls="cockpit-forecast"
      @click="emit('toggle-forecast')"
    >
      <span class="flex min-w-0 items-center gap-2">
        <UiStatusBadge :label="forecast.badge" :tone="forecast.tone" dot />
        <span class="truncate text-[13px] font-semibold">{{ forecast.headline }}</span>
      </span>
      <component :is="expanded ? ChevronUp : ChevronDown" class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
    </button>
  </section>
</template>
