<script setup lang="ts">
/**
 * エスカレーションカード（/inbox 用）
 * open: 理由バッジ・対象者・context・経過時間 + 「対応する」導線
 * resolved: 対応内容・対応者・ナレッジ還流バッジを表示
 */
import { CircleCheck, UserRound } from 'lucide-vue-next'
import type { Escalation, EscalationReason } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { fmtDateTime } from '~/utils/format'
import { ESCALATION_REASON_LABELS, ESCALATION_RESOLUTION_LABELS } from '~/utils/labels'

const props = defineProps<{ escalation: Escalation }>()
const emit = defineEmits<{ respond: [] }>()

const { tbl } = useMockDb()
const members = tbl('members')
const aiEmployees = tbl('aiEmployees')

/** 理由のトーン（共有 labels.ts は編集しないためローカル定義） */
const REASON_TONES: Record<EscalationReason, Tone> = {
  issue_reported: 'serious',
  stalled_task: 'warn',
  overload: 'crit',
  low_confidence: 'info',
  overtime_alert: 'crit',
}

const target = computed(() => {
  if (props.escalation.targetMemberId) {
    const m = members.value.find(x => x.id === props.escalation.targetMemberId)
    if (m) return { name: m.name, kind: 'human' as const, sub: `${m.dept} / ${m.title}` }
  }
  if (props.escalation.targetAiEmployeeId) {
    const a = aiEmployees.value.find(x => x.id === props.escalation.targetAiEmployeeId)
    if (a) return { name: a.name, kind: 'ai' as const, sub: 'AI社員' }
  }
  return null
})

const resolvedByName = computed(() => {
  const id = props.escalation.resolution?.resolvedBy
  if (!id) return ''
  return members.value.find(m => m.id === id)?.name ?? id
})

/** 起票からの経過時間（open カードの鮮度表示） */
const elapsed = computed(() => {
  const ms = Date.now() - new Date(props.escalation.raisedAt).getTime()
  const min = Math.max(1, Math.floor(ms / 60000))
  if (min < 60) return `${min}分前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}時間前`
  return `${Math.floor(h / 24)}日前`
})
</script>

<template>
  <article class="card p-3">
    <div class="flex flex-wrap items-center gap-1.5">
      <UiStatusBadge
        :label="ESCALATION_REASON_LABELS[escalation.reason]"
        :tone="REASON_TONES[escalation.reason]"
        dot
      />
      <UiStatusBadge
        v-if="escalation.status === 'resolved' && escalation.resolution"
        :label="ESCALATION_RESOLUTION_LABELS[escalation.resolution.type]"
        tone="neutral"
      />
      <UiStatusBadge
        v-if="escalation.knowledgeReflected"
        label="ナレッジ還流済"
        tone="brand"
      />
      <span class="num ml-auto text-[11px] text-muted" :title="fmtDateTime(escalation.raisedAt)">
        {{ escalation.status === 'open' ? `起票 ${elapsed}` : `起票 ${fmtDateTime(escalation.raisedAt)}` }}
      </span>
    </div>

    <div v-if="target" class="mt-2 flex items-center gap-2">
      <UiAvatar :name="target.name" :kind="target.kind" size="sm" />
      <p class="text-[13px] font-semibold">{{ target.name }}</p>
      <p class="text-[11px] text-muted">{{ target.sub }}</p>
    </div>
    <div v-else class="mt-2 flex items-center gap-2 text-[11px] text-muted">
      <UserRound class="h-4 w-4" aria-hidden="true" /> 対象者なし（システム検知）
    </div>

    <p class="mt-1.5 text-[13px] leading-relaxed text-sub">{{ escalation.context }}</p>

    <!-- open: 対応導線 -->
    <div v-if="escalation.status === 'open'" class="mt-2.5 flex justify-end">
      <button type="button" class="btn btn-primary" @click="emit('respond')">対応する</button>
    </div>

    <!-- resolved: 対応内容 -->
    <div v-else-if="escalation.resolution" class="mt-2.5 rounded-lg bg-surface-soft p-2.5">
      <p class="flex items-center gap-1 text-[11px] font-bold text-ok">
        <CircleCheck class="h-3.5 w-3.5" aria-hidden="true" />
        {{ resolvedByName }} が対応
        <span class="num ml-auto font-normal text-muted">{{ fmtDateTime(escalation.resolution.at) }}</span>
      </p>
      <p v-if="escalation.resolution.body" class="mt-1 text-xs leading-relaxed text-sub">
        {{ escalation.resolution.body }}
      </p>
    </div>
  </article>
</template>
