<script setup lang="ts">
/**
 * 提供システム稼働状況 一覧（F-11-1）
 * 全体バナー（最悪値ロールアップ）+ サービスカード（現在状態 + 90 日稼働率バー + uptime%）
 */
import { ChevronRight, CircleAlert, CircleCheck, TriangleAlert, Wrench } from 'lucide-vue-next'
import type { ServiceState } from '~/composables/useSystemStatus'
import { fmtDateTime, fmtPct } from '~/utils/format'
import { INCIDENT_STATUS_LABELS, SERVICE_STATE_LABELS, SERVICE_STATE_TONES } from '~/utils/labels'

const { services, overallState, stateOf, uptimeDaysOf, uptimePctOf, openIncidentsOf, refresh } = useSystemStatus()

// 表示時に最新状態を取り込む（API モード。他管理者の登録・更新の反映）
onMounted(() => { void refresh() })

/** 全体バナーの見た目（ステータストーンの soft 背景） */
const BANNER_META: Record<ServiceState, { class: string; icon: typeof CircleCheck; message: string }> = {
  operational: { class: 'bg-ok-soft text-ok', icon: CircleCheck, message: '全サービスが正常に稼働しています' },
  maintenance: { class: 'bg-info-soft text-info', icon: Wrench, message: 'メンテナンス実施中のサービスがあります' },
  degraded: { class: 'bg-warn-soft text-warn', icon: TriangleAlert, message: '一部サービスで性能低下が発生しています' },
  partial_outage: { class: 'bg-serious-soft text-serious', icon: TriangleAlert, message: '一部サービスで障害が発生しています' },
  major_outage: { class: 'bg-crit-soft text-crit', icon: CircleAlert, message: '重大な障害が発生しています' },
}

const banner = computed(() => BANNER_META[overallState.value])

const serviceCards = computed(() => services.value.map((s) => {
  const state = stateOf(s.id)
  const incident = openIncidentsOf(s.id)[0]
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    stateLabel: SERVICE_STATE_LABELS[state] ?? state,
    stateTone: SERVICE_STATE_TONES[state] ?? 'neutral',
    uptime: fmtPct(uptimePctOf(s.id), 2),
    days: uptimeDaysOf(s.id),
    incident,
  }
}))
</script>

<template>
  <div>
    <UiPageHeader
      title="提供システム稼働状況"
      description="提供中サービスの現在状態と、過去 90 日の日別稼働状況"
    />

    <!-- 全体バナー（最悪値ロールアップ） -->
    <div
      class="mb-3 flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-2.5"
      :class="banner.class"
      role="status"
      aria-live="polite"
    >
      <component :is="banner.icon" class="h-5 w-5 shrink-0" aria-hidden="true" />
      <p class="text-[13px] font-bold">{{ banner.message }}</p>
      <UiStatusBadge
        class="ml-auto"
        :label="SERVICE_STATE_LABELS[overallState] ?? overallState"
        :tone="SERVICE_STATE_TONES[overallState] ?? 'neutral'"
        dot
      />
    </div>

    <!-- サービスカード -->
    <div class="grid gap-3">
      <NuxtLink
        v-for="s in serviceCards"
        :key="s.id"
        :to="`/status/${s.id}`"
        class="card block p-3 transition-colors hover:border-brand"
      >
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-[14px] font-bold">
              {{ s.name }}
              <ChevronRight class="h-4 w-4 text-muted" aria-hidden="true" />
            </p>
            <p class="truncate text-[11px] text-muted">{{ s.description }}</p>
          </div>
          <span class="num text-[11px] text-muted">90日稼働率 <span class="text-[13px] font-bold text-ink">{{ s.uptime }}</span></span>
          <UiStatusBadge :label="s.stateLabel" :tone="s.stateTone" dot />
        </div>
        <p v-if="s.incident" class="mt-1.5 text-xs font-semibold text-serious">
          対応中: {{ s.incident.title }}（{{ INCIDENT_STATUS_LABELS[s.incident.status] }} / {{ fmtDateTime(s.incident.startedAt) }}〜）
        </p>
        <div class="mt-2.5">
          <WidgetsUptimeBar :days="s.days" />
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
