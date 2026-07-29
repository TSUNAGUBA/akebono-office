<script setup lang="ts">
/**
 * 役割と文脈の計器（F-01 §3 ③）
 * 自分の計器 / シフト計器 / 労務計器 / 経営計器 / 事業計器（useCockpit が権限・データ有無で組立済み）。
 * 該当データ・権限がない計器は枠ごと出さない（禁じ手 #1）。KPI 表示は UiKpiCard を再利用（原則3）。
 * 週次インサイト 1 行は保存済み personal の要約のみ（生成は /reports の明示操作。禁じ手 #3）
 */
import { ChevronRight, Sparkles } from 'lucide-vue-next'
import type { CockpitInstrumentGroup } from '~/utils/cockpit'
import type { CockpitWeeklyLine } from '~/composables/useCockpit'
import { fmtDate } from '~/utils/format'

defineProps<{
  groups: CockpitInstrumentGroup[]
  weekly: CockpitWeeklyLine | null
}>()
</script>

<template>
  <section v-if="groups.length > 0 || weekly" class="grid gap-3" aria-label="役割と文脈の計器">
    <div v-for="g in groups" :key="g.id" class="grid gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] font-bold text-muted">{{ g.label }}</p>
        <NuxtLink v-if="g.link" :to="g.link.to" class="link text-[11px] font-semibold">{{ g.link.label }}</NuxtLink>
      </div>
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <UiKpiCard
          v-for="it in g.items"
          :key="it.id"
          :label="it.label"
          :value="it.value"
          :sub="it.sub"
          :delta="it.delta ?? null"
          :inverse="it.inverse ?? false"
          :icon="it.icon"
          :to="it.to"
        />
      </div>
    </div>

    <!-- 週次インサイト 1 行（保存済み personal の要約のみ） -->
    <NuxtLink
      v-if="weekly"
      :to="weekly.to"
      class="card flex min-h-11 items-center gap-2.5 px-3 py-2 transition-colors hover:border-brand"
      aria-label="週次インサイト"
    >
      <Sparkles class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block text-[11px] font-bold text-muted">週次インサイト（{{ fmtDate(weekly.weekStart) }} 週）</span>
        <span class="block truncate text-[13px]">{{ weekly.text }}</span>
      </span>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
    </NuxtLink>
  </section>
</template>
