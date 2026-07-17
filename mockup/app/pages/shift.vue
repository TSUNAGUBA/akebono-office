<script setup lang="ts">
/**
 * シフト表（F-05）
 * タブ: 確定シフト（本人ビュー）/ 希望提出（スタッフ）/ 調整（管理者）/ 募集期間（管理者）
 * 業務ロジックは useShifts が SoT。この画面は表示射影と操作フィードバックに徹する。
 */
import { ArrowRight, CircleCheck, Info, Plus, TriangleAlert, Users } from 'lucide-vue-next'
import type { ShiftPeriod, ShiftPeriodStatus, ShiftWishKind } from '~/types/domain'
import type { TabItem, TableColumn } from '~/types/ui'
import { addDays, fmtDate, fmtDateLong, fmtDateTime, weekdayOf } from '~/utils/format'
import { SHIFT_PERIOD_STATUS_LABELS, SHIFT_WISH_LABELS } from '~/utils/labels'
import {
  periodDates, SHIFT_ASSIGNMENT_STATUS_LABELS, SHIFT_ASSIGNMENT_STATUS_TONES,
  SHIFT_NEXT_ACTION_LABELS, SHIFT_PERIOD_STATUS_TONES, SHIFT_WISH_MARKS,
} from '~/composables/useShifts'

const { currentUser, isAdmin, switchUser } = useCurrentUser()
const isApi = useApiMode()
const shifts = useShifts()
const { staffMembers, sortedPeriods } = shifts

// サーバー側で進んだ希望・割当・状態遷移（他者の操作）を表示時に取り込む
onMounted(() => { void shifts.refresh() })
const { show } = useToast()
const { ask } = useConfirm()

const today = todayJst()
const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'] as const
const WISH_KINDS: ShiftWishKind[] = ['want', 'ng', 'either']

const isStaff = computed(() => currentUser.value.employmentType === 'parttime')

// ---------- タブ ----------

const myShifts = computed(() => shifts.myAssignments(currentUser.value.id))
const consentPendingCount = computed(() => myShifts.value.filter(a => a.status === 'change_requested').length)

const tabs = computed<TabItem[]>(() => {
  const base: TabItem[] = [
    { key: 'confirmed', label: '確定シフト', badge: consentPendingCount.value },
    { key: 'wish', label: '希望提出' },
  ]
  if (isAdmin.value) {
    base.push({ key: 'adjust', label: '調整' }, { key: 'periods', label: '募集期間' })
  }
  return base
})
const tab = ref('confirmed')
watch(tabs, (list) => {
  if (!list.some(t => t.key === tab.value)) tab.value = 'confirmed'
})

function dayTextClass(date: string): string {
  const dow = weekdayOf(date)
  if (dow === 0) return 'text-crit'
  if (dow === 6) return 'text-info'
  return 'text-ink'
}

// ---------- 確定シフト（本人ビュー） ----------

const upcomingShifts = computed(() => myShifts.value.filter(a => a.date >= today))
const pastShifts = computed(() => myShifts.value.filter(a => a.date < today).reverse())

async function onConsent(assignmentId: string): Promise<void> {
  const r = await shifts.consent(assignmentId)
  if (r.ok) show('シフト変更に合意しました。管理者へ通知済みです', 'ok')
  else show(r.error.message, 'crit')
}

// ---------- 希望提出（スタッフ） ----------

const openPeriods = computed(() => sortedPeriods.value.filter(p => p.status === 'open'))

function daysUntil(dateKey: string): number {
  return Math.round((new Date(`${dateKey}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000)
}

function deadlineLabel(p: ShiftPeriod): string {
  const left = daysUntil(p.wishDeadline)
  if (left < 0) return `締切超過（${fmtDate(p.wishDeadline)}）`
  if (left === 0) return `締切: 本日（${fmtDate(p.wishDeadline)}）`
  return `締切: ${fmtDate(p.wishDeadline)}（あと${left}日）`
}

function deadlineTone(p: ShiftPeriod): 'warn' | 'crit' | 'info' {
  const left = daysUntil(p.wishDeadline)
  if (left < 0) return 'crit'
  if (left <= 1) return 'warn'
  return 'info'
}

function myWishCount(p: ShiftPeriod): number {
  return shifts.wishes.value.filter(w => w.periodId === p.id && w.memberId === currentUser.value.id).length
}

const WISH_BTN_ACTIVE: Record<ShiftWishKind, string> = {
  want: 'border-ok bg-ok-soft text-ok',
  ng: 'border-crit bg-crit-soft text-crit',
  either: 'border-warn bg-warn-soft text-warn',
}

function wishBtnClass(p: ShiftPeriod, date: string, kind: ShiftWishKind): string {
  const cur = shifts.wishOf(p.id, currentUser.value.id, date)
  return cur?.wish === kind
    ? WISH_BTN_ACTIVE[kind]
    : 'border-line-strong bg-surface text-sub hover:border-muted'
}

async function toggleWish(p: ShiftPeriod, date: string, kind: ShiftWishKind): Promise<void> {
  const cur = shifts.wishOf(p.id, currentUser.value.id, date)
  if (cur?.wish === kind) {
    const r = await shifts.clearWish(p.id, currentUser.value.id, date)
    if (r.ok) show(`${fmtDate(date)} の希望を取り消しました`, 'ok')
    else show(r.error.message, 'crit')
    return
  }
  const r = await shifts.submitWish({
    periodId: p.id, memberId: currentUser.value.id, date, wish: kind,
    from: cur?.from, to: cur?.to,
  })
  if (r.ok) show(`${fmtDate(date)} を「${SHIFT_WISH_LABELS[kind]}」で提出しました`, 'ok')
  else show(r.error.message, 'crit')
}

async function updateWishTime(p: ShiftPeriod, date: string, field: 'from' | 'to', value: string): Promise<void> {
  const cur = shifts.wishOf(p.id, currentUser.value.id, date)
  if (!cur || cur.wish !== 'want') return
  const r = await shifts.submitWish({
    periodId: p.id, memberId: currentUser.value.id, date, wish: 'want',
    from: field === 'from' ? value : cur.from,
    to: field === 'to' ? value : cur.to,
  })
  if (r.ok) show(`${fmtDate(date)} の希望時間帯を更新しました`, 'ok')
  else show(r.error.message, 'crit')
}

function trySwitchStaff(memberId: string, name: string): void {
  switchUser(memberId)
  show(`デモユーザーを ${name} さんに切り替えました`, 'ok')
}

// ---------- 調整（管理者） ----------

const adjustPeriodId = ref('')
watchEffect(() => {
  if (adjustPeriodId.value && sortedPeriods.value.some(p => p.id === adjustPeriodId.value)) return
  const best = sortedPeriods.value.find(p => p.status === 'adjusting')
    ?? sortedPeriods.value.find(p => p.status === 'closed')
    ?? sortedPeriods.value.find(p => p.status === 'open')
    ?? sortedPeriods.value[0]
  adjustPeriodId.value = best?.id ?? ''
})
const adjustPeriod = computed(() => sortedPeriods.value.find(p => p.id === adjustPeriodId.value) ?? null)
const adjustPeriodOptions = computed(() => sortedPeriods.value.map(p => ({
  value: p.id,
  label: `${p.label}（${SHIFT_PERIOD_STATUS_LABELS[p.status]}）`,
})))

const adjustBanner = computed<{ text: string; quickAction: boolean } | null>(() => {
  const st = adjustPeriod.value?.status
  if (!st || st === 'adjusting') return null
  const map: Record<Exclude<ShiftPeriodStatus, 'adjusting'>, { text: string; quickAction: boolean }> = {
    draft: { text: 'この期間は準備中です。希望受付を開始すると、スタッフが希望を提出できるようになります。', quickAction: true },
    open: { text: '希望受付中です。受付を締め切ってから調整を開始してください（グリッドは閲覧のみ）。', quickAction: true },
    closed: { text: '希望受付を締め切りました。「調整を開始」すると割当を編集できます。', quickAction: true },
    published: { text: '公開済みの期間です。セルをクリックすると確定後変更（本人合意が必要）を申請できます。', quickAction: false },
  }
  return map[st]
})

// 割当モーダル
const assignModal = reactive({ open: false, memberId: '', date: '', from: '10:00', to: '17:00' })

const modalMember = computed(() => staffMembers.value.find(m => m.id === assignModal.memberId) ?? null)
const modalExisting = computed(() => adjustPeriod.value
  ? shifts.assignmentAt(adjustPeriod.value.id, assignModal.memberId, assignModal.date)
  : undefined)
const modalWish = computed(() => adjustPeriod.value
  ? shifts.wishOf(adjustPeriod.value.id, assignModal.memberId, assignModal.date)
  : undefined)
const modalDemands = computed(() => adjustPeriod.value
  ? shifts.demandFor(adjustPeriod.value.id, assignModal.date)
  : [])
const modalWarnings = computed(() => (assignModal.open && assignModal.memberId)
  ? shifts.validateAssign(assignModal.memberId, assignModal.date, assignModal.from, assignModal.to, { excludeAssignmentId: modalExisting.value?.id, periodId: adjustPeriod.value?.id })
  : [])
const modalHasError = computed(() => modalWarnings.value.some(w => w.level === 'error'))
const modalMode = computed<'assign' | 'change' | 'readonly'>(() => {
  const st = adjustPeriod.value?.status
  if (st === 'adjusting') return 'assign'
  if (st === 'published' && modalExisting.value?.status === 'confirmed') return 'change'
  return 'readonly'
})

function openAssignCell(memberId: string, date: string): void {
  const p = adjustPeriod.value
  if (!p) return
  const existing = shifts.assignmentAt(p.id, memberId, date)
  const wish = shifts.wishOf(p.id, memberId, date)
  const demand = shifts.demandFor(p.id, date)[0]
  assignModal.memberId = memberId
  assignModal.date = date
  assignModal.from = existing?.from ?? (wish?.wish === 'want' && wish.from ? wish.from : demand?.from ?? '10:00')
  assignModal.to = existing?.to ?? (wish?.wish === 'want' && wish.to ? wish.to : demand?.to ?? '17:00')
  assignModal.open = true
}

async function doAssign(): Promise<void> {
  const p = adjustPeriod.value
  if (!p) return
  const warnCount = modalWarnings.value.filter(w => w.level === 'warn').length
  const r = await shifts.assign({
    periodId: p.id, memberId: assignModal.memberId, date: assignModal.date,
    from: assignModal.from, to: assignModal.to,
  })
  if (r.ok) {
    show(warnCount > 0 ? `割当を保存しました（警告${warnCount}件あり）` : '割当を保存しました', warnCount > 0 ? 'warn' : 'ok')
    assignModal.open = false
  } else {
    show(r.error.message, 'crit')
  }
}

async function doUnassign(): Promise<void> {
  const existing = modalExisting.value
  if (!existing) return
  const r = await shifts.unassign(existing.id)
  if (r.ok) {
    show('割当を解除しました', 'ok')
    assignModal.open = false
  } else {
    show(r.error.message, 'crit')
  }
}

async function doRequestChange(): Promise<void> {
  const existing = modalExisting.value
  if (!existing) return
  const ok = await ask(
    '確定後の変更申請',
    `${fmtDateLong(existing.date)} のシフトを ${assignModal.from}〜${assignModal.to} へ変更します。本人の合意が得られるまで「変更申請中」になります。`,
    { confirmLabel: '変更を申請' },
  )
  if (!ok) return
  const r = await shifts.requestChange(existing.id, assignModal.from, assignModal.to)
  if (r.ok) {
    show('変更を申請し、本人へ合意依頼を通知しました', 'ok', { label: '通知を確認', to: '/inbox' })
    assignModal.open = false
  } else {
    show(r.error.message, 'crit')
  }
}

async function publishPeriod(p: ShiftPeriod): Promise<void> {
  const shortage = shifts.dayCoverage(p.id).filter(c => c.required > 0 && c.assigned < c.required).length
  const message = `「${p.label}」のシフトを確定・公開し、割当のあるスタッフへ通知します。`
    + (shortage > 0 ? ` ※必要人数に不足がある日が${shortage}日あります。` : '')
  const ok = await ask('シフトの確定・公開', message, { confirmLabel: '確定・公開する' })
  if (!ok) return
  const r = await shifts.publish(p.id)
  if (r.ok) show('シフトを確定・公開し、スタッフへ通知しました', 'ok', { label: '通知を確認', to: '/inbox' })
  else show(r.error.message, 'crit')
}

// ---------- 募集期間（管理者） ----------

const periodColumns: TableColumn[] = [
  { key: 'label', label: '期間名', primary: true },
  { key: 'range', label: '対象期間', primary: true },
  { key: 'deadline', label: '希望締切' },
  { key: 'status', label: '状態', primary: true },
  { key: 'actions', label: '操作', align: 'right', primary: true },
]

const periodRows = computed(() => sortedPeriods.value.map(p => ({
  id: p.id,
  label: p.label,
  range: `${fmtDate(p.startDate)} 〜 ${fmtDate(p.endDate)}`,
  deadline: fmtDate(p.wishDeadline),
  status: p.status,
})))

function nextActionLabelOf(row: Record<string, unknown>): string {
  const p = shifts.periodById(String(row.id))
  return p ? SHIFT_NEXT_ACTION_LABELS[p.status] : ''
}

async function advancePeriod(p: ShiftPeriod): Promise<void> {
  const next = shifts.nextStatusOf(p)
  if (!next) return
  if (next === 'published') {
    await publishPeriod(p)
    return
  }
  if (next === 'closed') {
    const ok = await ask('希望受付の締切', `「${p.label}」の希望受付を締め切ります。以後、スタッフは希望を提出・変更できません。`, { confirmLabel: '締め切る' })
    if (!ok) return
  }
  const r = await shifts.transition(p.id, next)
  if (r.ok) show(`「${p.label}」を「${SHIFT_PERIOD_STATUS_LABELS[next]}」にしました`, 'ok')
  else show(r.error.message, 'crit')
}

async function advancePeriodRow(row: Record<string, unknown>): Promise<void> {
  const p = shifts.periodById(String(row.id))
  if (p) await advancePeriod(p)
}

// 新規期間モーダル
const periodModal = reactive({ open: false })
const periodForm = reactive({ label: '', startDate: '', endDate: '', wishDeadline: '' })

function openPeriodModal(): void {
  periodForm.label = ''
  periodForm.startDate = addDays(today, 17)
  periodForm.endDate = addDays(today, 30)
  periodForm.wishDeadline = addDays(today, 14)
  periodModal.open = true
}

async function savePeriod(): Promise<void> {
  const r = await shifts.createPeriod({ ...periodForm })
  if (r.ok) {
    show('募集期間を作成しました（状態: 準備中）', 'ok')
    periodModal.open = false
  } else {
    show(r.error.message, 'crit')
  }
}

// 必要人数モーダル
const demandModal = reactive({ open: false, periodId: '', label: '' })
const demandRows = ref<{ date: string; from: string; to: string; required: number }[]>([])

function openDemandModal(p: ShiftPeriod): void {
  demandRows.value = periodDates(p).map((date) => {
    const d = shifts.demandFor(p.id, date)[0]
    return { date, from: d?.from ?? '10:00', to: d?.to ?? '17:00', required: d?.required ?? 0 }
  })
  demandModal.periodId = p.id
  demandModal.label = p.label
  demandModal.open = true
}

function openDemandRow(row: Record<string, unknown>): void {
  const p = shifts.periodById(String(row.id))
  if (p) openDemandModal(p)
}

async function saveDemandRow(row: { date: string; from: string; to: string; required: number }): Promise<void> {
  const r = await shifts.setDemand(demandModal.periodId, row.date, row.from, row.to, Number(row.required))
  if (r.ok) show(`${fmtDate(row.date)} の必要人数を保存しました`, 'ok')
  else show(r.error.message, 'crit')
}
</script>

<template>
  <div>
    <UiPageHeader title="シフト表" description="募集期間の希望提出から調整・確定公開までを一元管理します" />
    <UiTabBar v-model="tab" :tabs="tabs" />

    <!-- ================= 確定シフト（本人ビュー） ================= -->
    <div v-if="tab === 'confirmed'" class="mt-3 grid gap-3">
      <UiSectionCard title="今後のシフト" :description="`${currentUser.name} さんの確定シフト`">
        <UiEmptyState
          v-if="myShifts.length === 0"
          icon="CalendarRange"
          title="確定シフトはまだありません"
          hint="シフトが公開されるとここに表示され、通知が届きます"
        />
        <template v-else>
          <p v-if="upcomingShifts.length === 0" class="py-2 text-xs text-muted">今後の予定はありません</p>
          <ul v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <li v-for="a in upcomingShifts" :key="a.id" class="card p-3">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="text-[12px] font-semibold" :class="dayTextClass(a.date)">{{ fmtDateLong(a.date) }}</p>
                  <p class="num mt-1 text-xl font-bold leading-none">
                    {{ a.from }}<span class="mx-1 text-sm font-normal text-muted">〜</span>{{ a.to }}
                  </p>
                  <p class="mt-1.5 text-[11px] text-muted">{{ a.periodLabel }}</p>
                </div>
                <UiStatusBadge
                  :label="SHIFT_ASSIGNMENT_STATUS_LABELS[a.status]"
                  :tone="SHIFT_ASSIGNMENT_STATUS_TONES[a.status]"
                  dot
                />
              </div>
              <div v-if="a.status === 'change_requested'" class="mt-2 rounded-md bg-warn-soft px-2.5 py-2">
                <p class="flex items-start gap-1 text-[11px] font-medium text-warn">
                  <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  時間変更の申請があります。内容を確認のうえ合意してください（本人合意までは確定しません）
                </p>
                <button type="button" class="btn btn-primary btn-sm mt-1.5 w-full sm:w-auto" @click="onConsent(a.id)">
                  <CircleCheck class="h-3.5 w-3.5" /> この変更に合意する
                </button>
              </div>
              <p v-else-if="a.consentAt" class="mt-1.5 text-[10px] text-muted">
                変更合意済み: {{ fmtDateTime(a.consentAt) }}
              </p>
            </li>
          </ul>
        </template>
      </UiSectionCard>

      <UiSectionCard v-if="pastShifts.length > 0" title="過去のシフト">
        <ul class="grid gap-1">
          <li
            v-for="a in pastShifts"
            :key="a.id"
            class="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1.5 text-xs text-sub last:border-b-0"
          >
            <span>{{ fmtDateLong(a.date) }}</span>
            <span class="flex items-center gap-2">
              <span class="num">{{ a.from }}〜{{ a.to }}</span>
              <UiStatusBadge :label="SHIFT_ASSIGNMENT_STATUS_LABELS[a.status]" :tone="SHIFT_ASSIGNMENT_STATUS_TONES[a.status]" />
            </span>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- ================= 希望提出（スタッフ） ================= -->
    <div v-else-if="tab === 'wish'" class="mt-3 grid gap-3">
      <template v-if="isStaff">
        <UiSectionCard v-if="openPeriods.length === 0">
          <UiEmptyState
            icon="CalendarOff"
            title="現在募集中の期間はありません"
            hint="希望の受付が開始されると、ここから提出できます"
          />
        </UiSectionCard>
        <UiSectionCard
          v-for="p in openPeriods"
          :key="p.id"
          :title="p.label"
          :description="`${fmtDateLong(p.startDate)} 〜 ${fmtDateLong(p.endDate)}`"
        >
          <template #actions>
            <UiStatusBadge :tone="deadlineTone(p)" :label="deadlineLabel(p)" dot />
          </template>
          <p class="mb-2 text-[11px] text-muted">
            日ごとに希望をタップしてください。締切までは何度でも変更できます（同じ希望を再タップで取消）。
            提出済み: <span class="num font-bold text-ink">{{ myWishCount(p) }}</span> / {{ periodDates(p).length }}日
          </p>
          <ul>
            <li
              v-for="d in periodDates(p)"
              :key="d"
              class="flex flex-col gap-1.5 border-b border-line py-2 last:border-b-0 md:flex-row md:items-center md:gap-3"
            >
              <div class="w-36 shrink-0">
                <span class="text-[12px] font-semibold" :class="dayTextClass(d)">
                  {{ fmtDate(d) }}（{{ WEEKDAY_JP[weekdayOf(d)] }}）
                </span>
                <span v-if="shifts.demandFor(p.id, d).length > 0" class="block text-[10px] text-muted">
                  募集 {{ shifts.demandFor(p.id, d)[0]!.from }}〜{{ shifts.demandFor(p.id, d)[0]!.to }} ×{{ shifts.demandFor(p.id, d)[0]!.required }}名
                </span>
              </div>
              <div class="flex gap-1" role="group" :aria-label="`${fmtDate(d)} の希望`">
                <button
                  v-for="k in WISH_KINDS"
                  :key="k"
                  type="button"
                  class="h-11 flex-1 rounded-lg border px-2 text-[12px] font-semibold transition-colors md:h-8 md:flex-none md:px-3"
                  :class="wishBtnClass(p, d, k)"
                  :aria-pressed="shifts.wishOf(p.id, currentUser.id, d)?.wish === k"
                  @click="toggleWish(p, d, k)"
                >
                  {{ SHIFT_WISH_MARKS[k].symbol }} {{ SHIFT_WISH_LABELS[k] }}
                </button>
              </div>
              <div v-if="shifts.wishOf(p.id, currentUser.id, d)?.wish === 'want'" class="flex items-center gap-1.5">
                <input
                  type="time"
                  class="input h-11 w-[104px] md:h-8"
                  :value="shifts.wishOf(p.id, currentUser.id, d)?.from ?? '10:00'"
                  :aria-label="`${fmtDate(d)} の希望開始時刻`"
                  @change="updateWishTime(p, d, 'from', ($event.target as HTMLInputElement).value)"
                >
                <span class="text-xs text-muted">〜</span>
                <input
                  type="time"
                  class="input h-11 w-[104px] md:h-8"
                  :value="shifts.wishOf(p.id, currentUser.id, d)?.to ?? '17:00'"
                  :aria-label="`${fmtDate(d)} の希望終了時刻`"
                  @change="updateWishTime(p, d, 'to', ($event.target as HTMLInputElement).value)"
                >
              </div>
            </li>
          </ul>
        </UiSectionCard>
      </template>
      <UiSectionCard v-else>
        <UiEmptyState
          icon="Users"
          title="アルバイト・パートスタッフ向けの機能です"
          :hint="isApi
            ? '希望提出はシフト制スタッフ（アルバイト・パート）のアカウントでログインすると利用できます'
            : '希望提出はシフト制スタッフが利用します。ヘッダーのデモユーザー切替、または下のボタンで体験できます'"
        >
          <template v-if="!isApi" #action>
            <div class="flex flex-wrap justify-center gap-2">
              <button
                v-for="m in staffMembers"
                :key="m.id"
                type="button"
                class="btn btn-sm"
                @click="trySwitchStaff(m.id, m.name)"
              >
                {{ m.name }} さんとして試す
              </button>
            </div>
          </template>
        </UiEmptyState>
      </UiSectionCard>
    </div>

    <!-- ================= 調整（管理者） ================= -->
    <div v-else-if="tab === 'adjust' && isAdmin" class="mt-3 grid gap-3">
      <UiFilterBar>
        <UiSelect v-model="adjustPeriodId" :options="adjustPeriodOptions" aria-label="調整する期間" />
        <UiStatusBadge
          v-if="adjustPeriod"
          :label="SHIFT_PERIOD_STATUS_LABELS[adjustPeriod.status]"
          :tone="SHIFT_PERIOD_STATUS_TONES[adjustPeriod.status]"
          dot
        />
        <template #trailing>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="adjustPeriod?.status !== 'adjusting'"
            @click="adjustPeriod && publishPeriod(adjustPeriod)"
          >
            <CircleCheck class="h-4 w-4" /> 確定・公開
          </button>
        </template>
      </UiFilterBar>

      <div
        v-if="adjustBanner"
        class="flex flex-wrap items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-[12px] font-medium text-info"
        role="status"
      >
        <Info class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span class="flex-1">{{ adjustBanner.text }}</span>
        <button
          v-if="adjustBanner.quickAction && adjustPeriod"
          type="button"
          class="btn btn-sm"
          @click="advancePeriod(adjustPeriod)"
        >
          {{ SHIFT_NEXT_ACTION_LABELS[adjustPeriod.status] }} <ArrowRight class="h-3.5 w-3.5" />
        </button>
      </div>

      <UiSectionCard v-if="adjustPeriod" :title="adjustPeriod.label" :description="`${fmtDateLong(adjustPeriod.startDate)} 〜 ${fmtDateLong(adjustPeriod.endDate)}`">
        <WidgetsShiftGrid :period="adjustPeriod" @cell="openAssignCell" />
      </UiSectionCard>
      <UiSectionCard v-else>
        <UiEmptyState icon="CalendarRange" title="募集期間がありません" hint="募集期間タブから作成してください" />
      </UiSectionCard>
    </div>

    <!-- ================= 募集期間（管理者） ================= -->
    <div v-else-if="tab === 'periods' && isAdmin" class="mt-3 grid gap-3">
      <UiSectionCard
        title="募集期間の一覧"
        description="状態は 準備中→希望受付中→締切→調整中→確定公開 の順にのみ進みます"
        flush
      >
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" @click="openPeriodModal">
            <Plus class="h-3.5 w-3.5" /> 新規作成
          </button>
        </template>
        <UiDataTable
          :columns="periodColumns"
          :rows="periodRows"
          empty-title="募集期間がありません"
          empty-hint="「新規作成」から募集期間を追加してください"
        >
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="SHIFT_PERIOD_STATUS_LABELS[row.status as ShiftPeriodStatus]"
              :tone="SHIFT_PERIOD_STATUS_TONES[row.status as ShiftPeriodStatus]"
              dot
            />
          </template>
          <template #cell-actions="{ row }">
            <div class="flex flex-wrap justify-end gap-1">
              <button type="button" class="btn btn-sm" @click.stop="openDemandRow(row)">
                <Users class="h-3.5 w-3.5" /> 必要人数
              </button>
              <button
                v-if="nextActionLabelOf(row)"
                type="button"
                class="btn btn-primary btn-sm"
                @click.stop="advancePeriodRow(row)"
              >
                {{ nextActionLabelOf(row) }} <ArrowRight class="h-3.5 w-3.5" />
              </button>
            </div>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ================= 割当モーダル ================= -->
    <UiModal :open="assignModal.open" title="シフト割当" width="480px" @close="assignModal.open = false">
      <div class="grid gap-3">
        <div class="flex items-center gap-2.5">
          <UiAvatar :name="modalMember?.name ?? ''" kind="human" />
          <div>
            <p class="text-[13px] font-bold">{{ modalMember?.name }}</p>
            <p class="text-[11px] text-muted">{{ fmtDateLong(assignModal.date) }}</p>
          </div>
          <UiStatusBadge
            v-if="modalExisting"
            class="ml-auto"
            :label="SHIFT_ASSIGNMENT_STATUS_LABELS[modalExisting.status]"
            :tone="SHIFT_ASSIGNMENT_STATUS_TONES[modalExisting.status]"
          />
        </div>

        <div class="rounded-md bg-page px-2.5 py-2 text-[12px] text-sub">
          <p>
            本人希望:
            <span class="font-semibold text-ink">
              {{ modalWish
                ? SHIFT_WISH_LABELS[modalWish.wish] + (modalWish.wish === 'want' && modalWish.from ? `（${modalWish.from}〜${modalWish.to}）` : '')
                : '未提出' }}
            </span>
          </p>
          <p class="mt-0.5">
            必要人数:
            <span class="font-semibold text-ink">
              {{ modalDemands.length > 0 ? modalDemands.map(d => `${d.from}〜${d.to} ×${d.required}名`).join(' / ') : '設定なし' }}
            </span>
          </p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <UiFormField label="開始" required>
            <input v-model="assignModal.from" type="time" class="input">
          </UiFormField>
          <UiFormField label="終了" required>
            <input v-model="assignModal.to" type="time" class="input">
          </UiFormField>
        </div>

        <ul v-if="modalWarnings.length > 0" class="grid gap-1" aria-live="polite">
          <li
            v-for="w in modalWarnings"
            :key="w.code"
            class="flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium"
            :class="w.level === 'error' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn'"
          >
            <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {{ w.message }}
              <span class="num ml-1 text-[10px] opacity-70">{{ w.code }}</span>
              <span v-if="w.level === 'error'" class="ml-1 text-[10px] font-bold">（割当不可）</span>
            </span>
          </li>
        </ul>

        <p v-if="modalMode === 'readonly'" class="rounded-md bg-page px-2.5 py-2 text-[11px] text-muted">
          <template v-if="modalExisting?.status === 'change_requested'">
            この割当は変更申請中（本人の合意待ち）です。合意されると確定に戻ります。
          </template>
          <template v-else-if="adjustPeriod?.status === 'published'">
            公開済みの期間では新規割当はできません。既存の確定割当のみ変更申請できます。
          </template>
          <template v-else>
            割当の編集は期間が「調整中」のときのみ可能です。
          </template>
        </p>
      </div>
      <template #footer>
        <button
          v-if="modalMode === 'assign' && modalExisting"
          type="button"
          class="btn btn-danger mr-auto"
          @click="doUnassign"
        >
          割当を解除
        </button>
        <button type="button" class="btn" @click="assignModal.open = false">キャンセル</button>
        <button
          v-if="modalMode === 'assign'"
          type="button"
          class="btn btn-primary"
          :disabled="modalHasError"
          @click="doAssign"
        >
          {{ modalExisting ? '割当を更新' : '割当する' }}
        </button>
        <button
          v-if="modalMode === 'change'"
          type="button"
          class="btn btn-primary"
          :disabled="modalHasError"
          @click="doRequestChange"
        >
          変更を申請（本人合意へ）
        </button>
      </template>
    </UiModal>

    <!-- ================= 新規期間モーダル ================= -->
    <UiModal :open="periodModal.open" title="募集期間の新規作成" width="480px" @close="periodModal.open = false">
      <div class="grid gap-3">
        <UiFormField label="期間名" required>
          <input v-model="periodForm.label" type="text" class="input" placeholder="例: 来月前半シフト">
        </UiFormField>
        <div class="grid grid-cols-2 gap-2">
          <UiFormField label="開始日" required>
            <input v-model="periodForm.startDate" type="date" class="input">
          </UiFormField>
          <UiFormField label="終了日" required>
            <input v-model="periodForm.endDate" type="date" class="input">
          </UiFormField>
        </div>
        <UiFormField label="希望締切" required hint="開始日以前の日付。締切後に調整・確定を行います">
          <input v-model="periodForm.wishDeadline" type="date" class="input">
        </UiFormField>
        <p class="text-[11px] text-muted">作成時は「準備中」で始まり、「希望受付を開始」でスタッフに公開されます。</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="periodModal.open = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="savePeriod">作成する</button>
      </template>
    </UiModal>

    <!-- ================= 必要人数モーダル ================= -->
    <UiModal :open="demandModal.open" :title="`必要人数の設定: ${demandModal.label}`" width="560px" @close="demandModal.open = false">
      <div class="grid gap-1.5">
        <p class="text-[11px] text-muted">日別 × 時間帯 × 人数の簡易設定です。変更するとその場で保存されます。0名にするとその日の募集を削除します。</p>
        <div
          v-for="row in demandRows"
          :key="row.date"
          class="flex flex-wrap items-center gap-2 border-b border-line py-1.5 last:border-b-0"
        >
          <span class="w-20 shrink-0 text-[12px] font-semibold" :class="dayTextClass(row.date)">
            {{ fmtDate(row.date) }}（{{ WEEKDAY_JP[weekdayOf(row.date)] }}）
          </span>
          <input
            v-model="row.from"
            type="time"
            class="input h-9 w-[96px]"
            :aria-label="`${fmtDate(row.date)} の開始時刻`"
            @change="saveDemandRow(row)"
          >
          <span class="text-xs text-muted">〜</span>
          <input
            v-model="row.to"
            type="time"
            class="input h-9 w-[96px]"
            :aria-label="`${fmtDate(row.date)} の終了時刻`"
            @change="saveDemandRow(row)"
          >
          <input
            v-model.number="row.required"
            type="number"
            min="0"
            max="9"
            class="input num h-9 w-16"
            :aria-label="`${fmtDate(row.date)} の必要人数`"
            @change="saveDemandRow(row)"
          >
          <span class="text-xs text-sub">名</span>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn btn-primary" @click="demandModal.open = false">閉じる</button>
      </template>
    </UiModal>
  </div>
</template>
