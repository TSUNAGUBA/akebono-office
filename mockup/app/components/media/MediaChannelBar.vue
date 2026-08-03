<script setup lang="ts">
/**
 * メディア分析の対象チャンネル切替バー。
 * メディア分析は独立したメディアチャンネル（任意で業態と連携）を単位に動くため、全メディア画面の先頭で
 * このバーから対象チャンネルを選ぶ。現在のチャンネル（useCurrentChannel）を共有し、切替は非破壊。
 */
import { LineChart, Link2, Radio, Settings2 } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'

const { activeChannels, effectiveChannelId, currentChannel, switchChannel } = useCurrentChannel()
const { settingFor } = useMediaChannels()
const { segmentById } = useCurrentSegment()
const { isAdmin } = useCurrentUser()

const currentConnected = computed(() => settingFor(effectiveChannelId.value)?.gaConnected === true)
/** 現在チャンネルの連携先業態（null = 単体チャンネル） */
const linkedSegment = computed(() => {
  const sid = currentChannel.value?.segmentId
  return sid ? segmentById(sid) : null
})
</script>

<template>
  <div class="grid gap-2 rounded-[10px] border border-line bg-surface-soft p-3">
    <div class="flex flex-wrap items-center gap-2">
      <LineChart class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span class="text-[12px] text-sub">対象チャンネル</span>
      <span v-if="currentChannel" class="text-[13px] font-bold">{{ currentChannel.name }}</span>
      <!-- 連携先業態バッジ（連携済み） or 単体バッジ -->
      <UiStatusBadge
        v-if="linkedSegment"
        :label="`連携: ${linkedSegment.name}（${INDUSTRY_TYPE_LABELS[linkedSegment.industryType]}）`"
        tone="info"
      />
      <UiStatusBadge v-else label="単体（業態未連携）" tone="neutral" />
      <UiStatusBadge :label="currentConnected ? 'GA 連携済み' : 'GA 未連携'" :tone="currentConnected ? 'ok' : 'neutral'" dot />
      <div class="ml-auto flex items-center gap-1">
        <NuxtLink to="/media" class="btn btn-ghost btn-sm">
          <Radio class="h-3.5 w-3.5" aria-hidden="true" />
          チャンネル一覧
        </NuxtLink>
        <NuxtLink v-if="isAdmin" to="/media/settings" class="btn btn-ghost btn-sm">
          <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
          設定
        </NuxtLink>
      </div>
    </div>
    <div v-if="activeChannels.length > 1" class="flex flex-wrap gap-1.5">
      <button
        v-for="ch in activeChannels"
        :key="ch.id"
        type="button"
        class="rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors"
        :class="ch.id === effectiveChannelId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
        :aria-pressed="ch.id === effectiveChannelId"
        @click="switchChannel(ch.id)"
      >
        <component :is="ch.segmentId ? Link2 : Radio" class="mr-1 inline h-3 w-3" aria-hidden="true" />{{ ch.name }}
      </button>
    </div>
  </div>
</template>
