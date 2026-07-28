<script setup lang="ts">
/**
 * メディア分析の対象セグメント（業態）切替バー。
 * メディア分析は Akebono 業務のセグメントと 1:1 で対になるため、全メディア画面の先頭でこのバーから対象を選ぶ。
 * 現在の業態（useCurrentSegment）を共有し、切替は非破壊（localStorage 永続・他画面と一貫）。
 */
import { Layers, LineChart, Settings2 } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'

const { activeSegments, effectiveSegmentId, currentSegment, currentIndustryLabel, switchSegment } = useCurrentSegment()
const { settingFor } = useMediaSettings()
const { isAdmin } = useCurrentUser()

const currentConnected = computed(() => settingFor(effectiveSegmentId.value)?.gaConnected === true)
</script>

<template>
  <div class="grid gap-2 rounded-[10px] border border-line bg-surface-soft p-3">
    <div class="flex flex-wrap items-center gap-2">
      <LineChart class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span class="text-[12px] text-sub">対象メディア（業態）</span>
      <span v-if="currentSegment" class="text-[13px] font-bold">{{ currentSegment.name }}</span>
      <UiStatusBadge v-if="currentSegment" :label="currentIndustryLabel" tone="info" />
      <UiStatusBadge :label="currentConnected ? 'GA 連携済み' : 'GA 未連携'" :tone="currentConnected ? 'ok' : 'neutral'" dot />
      <NuxtLink
        v-if="isAdmin"
        to="/media/settings"
        class="btn btn-ghost btn-sm ml-auto"
      >
        <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
        メディア設定
      </NuxtLink>
    </div>
    <div v-if="activeSegments.length > 1" class="flex flex-wrap gap-1.5">
      <button
        v-for="s in activeSegments"
        :key="s.id"
        type="button"
        class="rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors"
        :class="s.id === effectiveSegmentId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
        :aria-pressed="s.id === effectiveSegmentId"
        @click="switchSegment(s.id)"
      >
        <Layers class="mr-1 inline h-3 w-3" aria-hidden="true" />{{ s.name }}
        <span class="ml-1 text-[10px] text-muted">{{ INDUSTRY_TYPE_LABELS[s.industryType] }}</span>
      </button>
    </div>
  </div>
</template>
