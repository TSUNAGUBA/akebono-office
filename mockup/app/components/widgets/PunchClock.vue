<script setup lang="ts">
/** 打刻ウィジェット（ダッシュボード・モバイルで共用。状態機械は useAttendance が SoT） */
import { Coffee, LogIn, LogOut, Play } from 'lucide-vue-next'
import type { PunchKind } from '~/types/domain'
import { fmtTime, toDateKey } from '~/utils/format'
import { PUNCH_KIND_LABELS } from '~/utils/labels'

const { currentUser } = useCurrentUser()
const { punch, punchState, punchesOf } = useAttendance()
const { show } = useToast()

const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { now.value = new Date() }, 1000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const today = computed(() => toDateKey(now.value))
const state = computed(() => punchState(currentUser.value.id, today.value))
const todayPunches = computed(() => punchesOf(currentUser.value.id, today.value))

const clock = computed(() => {
  const h = String(now.value.getHours()).padStart(2, '0')
  const m = String(now.value.getMinutes()).padStart(2, '0')
  const s = String(now.value.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
})

const stateLabel = computed(() => ({
  before: '未出勤',
  working: '勤務中',
  breaking: '休憩中',
  done: '退勤済み',
}[state.value]))

const stateTone = computed(() => ({
  before: 'neutral' as const,
  working: 'ok' as const,
  breaking: 'warn' as const,
  done: 'info' as const,
}[state.value]))

function doPunch(kind: PunchKind): void {
  const r = punch(kind)
  if (r.ok) {
    show(`${PUNCH_KIND_LABELS[kind]}を打刻しました`, 'ok', { label: '勤怠管理で確認', to: '/attendance' })
  } else {
    show(r.error.message, 'warn')
  }
}
</script>

<template>
  <UiSectionCard>
    <div v-if="!currentUser.punchRequired" class="py-2 text-center text-xs text-muted">
      {{ currentUser.name }} さんは打刻対象外です（{{ currentUser.employmentType === 'outsource' ? '外注は稼働報告で管理' : '管理監督者' }}）
    </div>
    <div v-else class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div>
          <p class="num text-2xl font-bold leading-none tracking-tight">{{ clock }}</p>
          <p class="mt-1 text-[11px] text-muted">{{ today }}</p>
        </div>
        <UiStatusBadge :label="stateLabel" :tone="stateTone" dot />
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="btn btn-lg btn-primary" :disabled="state !== 'before'" @click="doPunch('in')">
          <LogIn class="h-4 w-4" /> 出勤
        </button>
        <button type="button" class="btn btn-lg" :disabled="state !== 'working'" @click="doPunch('out')">
          <LogOut class="h-4 w-4" /> 退勤
        </button>
        <button type="button" class="btn" :disabled="state !== 'working'" @click="doPunch('break_start')">
          <Coffee class="h-4 w-4" /> 休憩開始
        </button>
        <button type="button" class="btn" :disabled="state !== 'breaking'" @click="doPunch('break_end')">
          <Play class="h-4 w-4" /> 休憩終了
        </button>
      </div>
      <div v-if="todayPunches.length > 0" class="border-t border-line pt-2">
        <p class="mb-1 text-[10px] font-bold text-muted">本日の打刻</p>
        <ol class="flex flex-wrap gap-x-3 gap-y-0.5">
          <li v-for="p in todayPunches" :key="p.id" class="text-xs text-sub">
            <span class="font-semibold">{{ PUNCH_KIND_LABELS[p.kind] }}</span>
            <span class="num ml-1">{{ fmtTime(p.at) }}</span>
          </li>
        </ol>
      </div>
    </div>
  </UiSectionCard>
</template>
