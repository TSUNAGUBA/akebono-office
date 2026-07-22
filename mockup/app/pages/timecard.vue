<script setup lang="ts">
/**
 * タイムカード（オペレーター指示 2026-07-22: 勤怠管理のタブから同階層メニューへ切り出し）
 * このページで見られるのは **ログインユーザー本人のタイムカードのみ**。
 * 全メンバーの一覧は 勤怠管理 > 全員のタイムカード（権限表 attendance / timecard-all で制御）。
 * 集計は useAttendance が SoT（API モードは月キャッシュから射影 = 日別の個別リクエストを出さない）
 */
import { ChevronRight } from 'lucide-vue-next'
import type { TableColumn } from '~/types/ui'
import { addDays, fmtMinutes, fmtTime } from '~/utils/format'

const { currentUser } = useCurrentUser()
const { monthSummary } = useAttendance()

const todayKey = todayJst()

// ---------- 期間フィルター（既定 = 直近 7 日） ----------

const filterOpen = ref(true)
const from = ref(addDays(todayKey, -6))
const to = ref(todayKey)

/** 期間の上限（勤怠タブの全員のタイムカードと同じ 62 日） */
const RANGE_MAX_DAYS = 62

/** 期間（from〜to）の日付リスト（降順・上限あり。入力が逆転していても補正） */
const dates = computed(() => {
  let f = from.value || todayKey
  let t = to.value || todayKey
  if (f > t) [f, t] = [t, f]
  const out: string[] = []
  for (let d = t; d >= f && out.length < RANGE_MAX_DAYS; d = addDays(d, -1)) out.push(d)
  return out
})

const truncated = computed(() => {
  if (!from.value || !to.value) return false
  let f = from.value
  let t = to.value
  if (f > t) [f, t] = [t, f]
  let count = 0
  for (let d = t; d >= f; d = addDays(d, -1)) {
    count++
    if (count > RANGE_MAX_DAYS) return true
  }
  return false
})

// ---------- 自分のタイムカード行（打刻のある日のみ） ----------

const columns: TableColumn[] = [
  { key: 'date', label: '日付', width: '110px', primary: true },
  { key: 'inTime', label: '出勤時間', width: '90px', align: 'right', primary: true },
  { key: 'outTime', label: '退勤時間', width: '90px', align: 'right', primary: true },
  { key: 'breakTime', label: '休憩', width: '80px', align: 'right' },
  { key: 'workHours', label: '労働時間', width: '90px', align: 'right', primary: true },
]

/**
 * 期間内の月サマリから本人の日別行を射影する（モック = クライアント集計 / API = サーバー集計キャッシュ）。
 * daySummary.punches は有効打刻のみのため、出勤 = 先頭 in・退勤 = 末尾 out
 */
const rows = computed(() => {
  const me = currentUser.value.id
  const byDate = new Map<string, { inAt?: string; outAt?: string; workMinutes: number; breakMinutes: number; hasPunch: boolean }>()
  for (const month of new Set(dates.value.map(d => d.slice(0, 7)))) {
    for (const s of monthSummary(me, month).days) {
      const firstIn = s.punches.find(p => p.kind === 'in')
      const lastOut = [...s.punches].reverse().find(p => p.kind === 'out')
      byDate.set(s.date, {
        inAt: firstIn?.at,
        outAt: lastOut?.at,
        workMinutes: s.workMinutes,
        breakMinutes: s.breakMinutes,
        hasPunch: s.punches.length > 0,
      })
    }
  }
  return dates.value.flatMap((date) => {
    const s = byDate.get(date)
    if (!s || !s.hasPunch) return []
    return [{
      id: date,
      date,
      inTime: s.inAt ? fmtTime(s.inAt) : '—',
      outTime: s.outAt ? fmtTime(s.outAt) : '—',
      breakTime: fmtMinutes(s.breakMinutes),
      workHours: fmtMinutes(s.workMinutes),
    }]
  })
})

const totalWorkMinutes = computed(() => {
  const me = currentUser.value.id
  const range = new Set(dates.value)
  let total = 0
  for (const month of new Set(dates.value.map(d => d.slice(0, 7)))) {
    for (const s of monthSummary(me, month).days) {
      if (range.has(s.date)) total += s.workMinutes
    }
  }
  return total
})
</script>

<template>
  <div>
    <UiPageHeader
      title="タイムカード"
      :description="`${currentUser.name} さんの打刻と出退勤・労働時間（本人のみ）`"
    />

    <div class="grid gap-3">
      <!-- 打刻（ヘッダーのタイムカードモーダルと同じウィジェット） -->
      <WidgetsPunchClock v-if="currentUser.punchRequired" />
      <UiSectionCard v-else title="打刻">
        <p class="text-[12px] text-muted">{{ currentUser.name }} さんは打刻対象外です（メンバーマスタの打刻要否）</p>
      </UiSectionCard>

      <!-- 自分の出退勤一覧 -->
      <UiSectionCard title="出退勤の一覧" description="打刻のある日を新しい順に表示します。修正は 勤怠管理 > 日次 の「打刻修正を申請」から">
        <template #actions>
          <button
            type="button"
            class="btn btn-sm"
            :aria-expanded="filterOpen"
            aria-controls="timecard-filter-panel"
            @click="filterOpen = !filterOpen"
          >
            <ChevronRight class="h-3.5 w-3.5 transition-transform" :class="filterOpen ? 'rotate-90' : ''" aria-hidden="true" />
            期間
          </button>
        </template>

        <div v-show="filterOpen" id="timecard-filter-panel" class="mb-3 grid gap-2 rounded-lg border border-line bg-surface-soft p-3 sm:grid-cols-2">
          <UiFormField label="日付（から）">
            <input v-model="from" type="date" class="input" aria-label="期間フィルター（開始）">
          </UiFormField>
          <UiFormField label="日付（まで）">
            <input v-model="to" type="date" class="input" aria-label="期間フィルター（終了）">
          </UiFormField>
        </div>

        <p v-if="truncated" class="mb-2 text-[11px] text-warn">
          期間が長いため直近 {{ RANGE_MAX_DAYS }} 日分のみ表示しています。期間を狭めてください。
        </p>

        <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-sub">
          <span>出勤日数 <b class="num text-ink">{{ rows.length }}日</b></span>
          <span>実労働合計 <b class="num text-ink">{{ fmtMinutes(totalWorkMinutes) }}</b></span>
        </div>

        <UiDataTable
          :columns="columns"
          :rows="rows"
          empty-title="この期間の打刻がありません"
          empty-hint="上の打刻カード、またはヘッダーの「タイムカード」から打刻できます"
        />
      </UiSectionCard>
    </div>
  </div>
</template>
