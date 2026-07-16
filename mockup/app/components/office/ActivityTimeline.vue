<script setup lang="ts">
/**
 * AI 活動ログのタイムライン（F-08-4）
 * 時系列表示 + kind アイコン + tokens/cost 表示 + AI 社員/タスクでのフィルタ。
 */
import * as icons from 'lucide-vue-next'
import type { AiActivityKind, AiActivityLog, AiEmployee, AiTask } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { fmtDateTime, fmtInt } from '~/utils/format'

const props = defineProps<{
  logs: AiActivityLog[]
  employees: AiEmployee[]
  tasks: AiTask[]
}>()

const filterEmp = ref('')
const filterTask = ref('')

const empOptions = computed(() => props.employees.map(e => ({ value: e.id, label: e.name })))
const taskOptions = computed(() => props.tasks.map(t => ({ value: t.id, label: t.title })))

const filtered = computed(() =>
  props.logs.filter(l =>
    (!filterEmp.value || l.aiEmployeeId === filterEmp.value)
    && (!filterTask.value || l.taskId === filterTask.value)))

const KIND_TONES: Record<AiActivityKind, Tone> = {
  plan: 'info',
  execute: 'ok',
  report: 'brand',
  escalate: 'warn',
  chat: 'neutral',
}

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  serious: 'bg-serious-soft text-serious',
  crit: 'bg-crit-soft text-crit',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand',
  neutral: 'bg-page text-sub',
}

function iconOf(kind: AiActivityKind) {
  return (icons as Record<string, unknown>)[AI_ACTIVITY_KIND_ICONS[kind]] ?? icons.Circle
}

function empName(id: string): string {
  return props.employees.find(e => e.id === id)?.name ?? id
}

function taskTitle(id: string | null): string {
  if (!id) return ''
  return props.tasks.find(t => t.id === id)?.title ?? id
}
</script>

<template>
  <div>
    <UiFilterBar>
      <UiSelect v-model="filterEmp" :options="empOptions" empty-label="AI 社員: すべて" aria-label="AI 社員で絞り込み" />
      <UiSelect v-model="filterTask" :options="taskOptions" empty-label="タスク: すべて" aria-label="タスクで絞り込み" />
      <template #trailing>
        <span class="num text-xs text-muted">{{ filtered.length }} 件</span>
      </template>
    </UiFilterBar>

    <UiEmptyState v-if="filtered.length === 0" icon="Activity" title="活動ログがありません" hint="フィルタ条件を変更してください" />

    <ol v-else class="mt-2 grid gap-0">
      <li
        v-for="l in filtered"
        :key="l.id"
        class="relative flex gap-3 border-l-2 border-line pb-4 pl-4 last:pb-0"
      >
        <span
          class="absolute -left-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface"
          :class="TONE_CLASSES[KIND_TONES[l.kind]]"
          :title="AI_ACTIVITY_KIND_LABELS[l.kind]"
        >
          <component :is="iconOf(l.kind)" class="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <UiAvatar :name="empName(l.aiEmployeeId)" kind="ai" size="sm" />
            <span class="text-xs font-bold">{{ empName(l.aiEmployeeId) }}</span>
            <UiStatusBadge :label="AI_ACTIVITY_KIND_LABELS[l.kind]" :tone="KIND_TONES[l.kind]" />
            <span class="num text-[11px] text-muted">{{ fmtDateTime(l.at) }}</span>
          </div>
          <p class="mt-0.5 text-[13px] text-ink">{{ l.summary }}</p>
          <p class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            <span v-if="l.taskId" class="truncate">{{ taskTitle(l.taskId) }}</span>
            <span class="num shrink-0">{{ fmtInt(l.tokens) }} tokens / ${{ l.costUsd.toFixed(3) }}</span>
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>
