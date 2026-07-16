<script setup lang="ts">
/**
 * F-04 勤怠管理（タブ: 日次 / 週次 / 月次 / 有給 / 申請 / 設定※管理者）
 * 集計・状態機械は useAttendance / useLeave が SoT。この画面は表示と操作フローのみを持つ。
 * ?tab=settings 等のクエリで初期タブを指定できる。
 */
import { CalendarPlus, Check, ChevronLeft, ChevronRight, FilePen, Plus, X } from 'lucide-vue-next'
import type { CalendarDayCell } from '~/components/widgets/CalendarMonth.vue'
import type { DaySummary } from '~/composables/useAttendance'
import {
  LEAVE_REQUEST_STATUS_LABELS, LEAVE_REQUEST_STATUS_TONES, LEAVE_UNIT_LABELS, useLeave,
} from '~/composables/useLeave'
import type {
  AttendanceBuckets, AttendanceRule, EmploymentType, LeaveRequest, PunchKind,
} from '~/types/domain'
import type { TableColumn, TabItem, Tone } from '~/types/ui'
import { effectivePunches, LEGAL_WEEKLY_MIN, OT_MONTHLY_LIMIT_MIN } from '~/utils/attendance-calc'
import { addDays, fmtDate, fmtDateLong, fmtHours, fmtMinutes, fmtTime, weekdayOf } from '~/utils/format'
import { EMPLOYMENT_TYPE_LABELS, PUNCH_KIND_LABELS } from '~/utils/labels'

const route = useRoute()
const router = useRouter()
const { tbl } = useMockDb()
const { currentUser, isAdmin } = useCurrentUser()
const {
  fixRequests, ruleFor, punchesRawOf, daySummary, monthSummary, alerts,
  raiseOvertimeEscalations, requestFix, decideFix,
} = useAttendance()
const leave = useLeave()
const { show } = useToast()
const { ask } = useConfirm()

const members = tbl('members')

function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}

// ---------- タブ（route.query.tab で初期化・同期） ----------

const VALID_TABS = ['daily', 'weekly', 'monthly', 'leave', 'requests', 'settings']

function normalizeTab(v: unknown): string {
  const s = String(v ?? '')
  if (!VALID_TABS.includes(s)) return 'daily'
  if (s === 'settings' && !isAdmin.value) return 'daily'
  return s
}

const tab = ref<string>(normalizeTab(route.query.tab))

watch(tab, (v) => {
  // 離脱ナビゲーション中に他ページの URL を書き換えないようガード
  if (route.path !== '/attendance') return
  if (String(route.query.tab ?? '') !== v) {
    router.replace({ query: { ...route.query, tab: v } })
  }
})
watch(() => route.query.tab, (v) => {
  if (route.path !== '/attendance') return
  const n = normalizeTab(v)
  if (n !== tab.value) tab.value = n
})
watch(isAdmin, (v) => {
  if (!v && tab.value === 'settings') tab.value = 'daily'
})

const pendingCount = computed(() =>
  fixRequests.value.filter(f => f.status === 'pending').length + leave.pendingRequests.value.length)

const tabs = computed<TabItem[]>(() => {
  const t: TabItem[] = [
    { key: 'daily', label: '日次' },
    { key: 'weekly', label: '週次' },
    { key: 'monthly', label: '月次' },
    { key: 'leave', label: '有給' },
    { key: 'requests', label: '申請', badge: isAdmin.value ? pendingCount.value : undefined },
  ]
  if (isAdmin.value) t.push({ key: 'settings', label: '設定' })
  return t
})

// ---------- 対象メンバー（日次・週次・月次で共有。管理者のみ他メンバーを閲覧可） ----------

const punchTargets = computed(() => members.value.filter(m => m.active && m.punchRequired))
const memberOptions = computed(() =>
  punchTargets.value.map(m => ({ value: m.id, label: `${m.name}（${m.dept}）` })))

function defaultMemberId(): string {
  if (currentUser.value.punchRequired) return currentUser.value.id
  return punchTargets.value[0]?.id ?? currentUser.value.id
}

const selMemberId = ref(defaultMemberId())
watch(() => currentUser.value.id, () => { selMemberId.value = defaultMemberId() })

const viewingSelf = computed(() => selMemberId.value === currentUser.value.id)
const canRequestFix = computed(() => viewingSelf.value && currentUser.value.punchRequired)

// ---------- 6 バケット（ラベルは労基法の区分。labels.ts は共有のためここに定義） ----------

const BUCKET_DEFS: { key: keyof AttendanceBuckets; label: string }[] = [
  { key: 'scheduled', label: '所定内' },
  { key: 'statutoryOt', label: '法定内残業' },
  { key: 'nonStatutoryOt', label: '法定外残業' },
  { key: 'over60Ot', label: '60h超残業' },
  { key: 'night', label: '深夜' },
  { key: 'legalHoliday', label: '法定休日' },
]

function bucketValueClass(key: keyof AttendanceBuckets, value: number): string {
  if (value <= 0) return 'text-muted'
  if (key === 'over60Ot') return 'text-crit'
  if (key === 'nonStatutoryOt' || key === 'legalHoliday') return 'text-warn'
  return 'text-ink'
}

// ---------- 日次タブ ----------

const todayKey = todayJst()
const selDate = ref(todayKey)

// date input をクリアされた場合は今日へ戻す（NaN 表示の防止）
watch(selDate, (v) => {
  if (!v) selDate.value = todayKey
})

function shiftDate(delta: number): void {
  selDate.value = addDays(selDate.value, delta)
}

/** 60h 超バケットを正しく出すため、月の頭からの累計を織り込んだ monthSummary から日を取り出す */
const dailyData = computed(() => {
  const month = selDate.value.slice(0, 7)
  const s = monthSummary(selMemberId.value, month)
  return s.days.find(d => d.date === selDate.value) ?? daySummary(selMemberId.value, selDate.value)
})

const dayPendingFixes = computed(() =>
  fixRequests.value.filter(f =>
    f.memberId === selMemberId.value && f.date === selDate.value && f.status === 'pending'))

/**
 * 修正履歴を含むタイムライン（F-04-6 修正履歴）。
 * punchesOf は置換済みの旧打刻を返さないため、生列（punchesRawOf）を使い、
 * 有効打刻の判定は集計と同じ effectivePunches（fix の連鎖対応）に委譲して
 * 有効セットに含まれない打刻を「修正前」として注釈する。
 * 集計値は daySummary（有効打刻ベース）のままで変えない。
 */
const dailyTimeline = computed(() => {
  const rows = punchesRawOf(selMemberId.value, selDate.value)
  const effectiveIds = new Set(effectivePunches(rows).map(p => p.id))
  return rows.map(p => ({
    ...p,
    superseded: !effectiveIds.has(p.id),
  }))
})

function punchDotClass(kind: PunchKind): string {
  if (kind === 'in') return 'bg-ok'
  if (kind === 'out') return 'bg-info'
  return 'bg-warn'
}

// 打刻修正申請モーダル
const fixOpen = ref(false)
const fixForm = ref({ kind: 'in', time: '09:00', reason: '' })
const fixError = ref('')
const punchKindOptions = Object.entries(PUNCH_KIND_LABELS).map(([value, label]) => ({ value, label }))

function openFixModal(): void {
  fixForm.value = { kind: 'in', time: '09:00', reason: '' }
  fixError.value = ''
  fixOpen.value = true
}

function submitFix(): void {
  fixError.value = ''
  if (!fixForm.value.time) {
    fixError.value = '修正時刻を入力してください'
    return
  }
  const r = requestFix({
    date: selDate.value,
    kind: fixForm.value.kind as PunchKind,
    requestedAt: `${selDate.value}T${fixForm.value.time}:00+09:00`,
    reason: fixForm.value.reason,
  })
  if (!r.ok) {
    fixError.value = r.error.message
    return
  }
  fixOpen.value = false
  show('打刻修正を申請しました（承認後に反映されます）', 'ok', { label: '申請状況', to: '/attendance?tab=requests' })
}

// ---------- 週次タブ（F-04-2 週 40h 判定含む週間グリッド） ----------

/** 週の起点は日曜（法定休日曜日に合わせる）。todayJst() 起点のため TZ 非依存 */
function startOfWeek(dateKey: string): string {
  return addDays(dateKey, -weekdayOf(dateKey))
}

const selWeekStart = ref(startOfWeek(todayKey))

function shiftWeek(delta: number): void {
  selWeekStart.value = addDays(selWeekStart.value, delta * 7)
}

const weekLabel = computed(() =>
  `${fmtDateLong(selWeekStart.value)} 〜 ${fmtDateLong(addDays(selWeekStart.value, 6))}`)

/** 日曜〜土曜の 7 日分。60h 超判定を保つため、月をまたぐ週も monthSummary から日を取り出す */
const weekDays = computed<DaySummary[]>(() => {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(selWeekStart.value, i))
  const byDate = new Map<string, DaySummary>()
  for (const month of new Set(dates.map(d => d.slice(0, 7)))) {
    for (const s of monthSummary(selMemberId.value, month).days) byDate.set(s.date, s)
  }
  return dates.map(date => byDate.get(date) ?? daySummary(selMemberId.value, date))
})

const weekLegalWd = computed(() => ruleFor(selMemberId.value)?.legalHolidayWeekday ?? 0)

function dayOtMinutes(d: DaySummary): number {
  return d.buckets.nonStatutoryOt + d.buckets.over60Ot
}

// 週 40h（法定労働時間）に対する進捗（80% で警告・超過で重大）
const weekTotalWork = computed(() => weekDays.value.reduce((s, d) => s + d.workMinutes, 0))
const weekRatio = computed(() => weekTotalWork.value / LEGAL_WEEKLY_MIN)
const weekGaugeFillClass = computed(() => {
  if (weekRatio.value > 1) return 'bg-crit'
  if (weekRatio.value >= 0.8) return 'bg-warn'
  return 'bg-brand'
})

// ---------- 月次タブ ----------

const selMonth = ref(todayKey.slice(0, 7))

const monthLabel = computed(() =>
  `${Number(selMonth.value.slice(0, 4))}年${Number(selMonth.value.slice(5, 7))}月`)

function shiftMonth(delta: number): void {
  const y = Number(selMonth.value.slice(0, 4))
  const m = Number(selMonth.value.slice(5, 7))
  const d = new Date(y, m - 1 + delta, 1)
  selMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const monthData = computed(() => monthSummary(selMemberId.value, selMonth.value))
const monthTotalWork = computed(() => monthData.value.days.reduce((s, d) => s + d.workMinutes, 0))

const approvedLeaveDates = computed(() => new Set(
  leave.requests.value
    .filter(r => r.memberId === selMemberId.value && r.status === 'approved')
    .map(r => r.date),
))

const calendarDays = computed<CalendarDayCell[]>(() => {
  const legalWd = ruleFor(selMemberId.value)?.legalHolidayWeekday ?? 0
  return monthData.value.days.map(d => ({
    date: d.date,
    workMinutes: d.workMinutes,
    legalHoliday: weekdayOf(d.date) === legalWd,
    alert: d.breakShortage > 0 || d.buckets.over60Ot > 0,
    leave: approvedLeaveDates.value.has(d.date),
  }))
})

function openDaily(date: string): void {
  selDate.value = date
  tab.value = 'daily'
}

// 36 協定アラート + 45h 進捗ゲージ（アラートはゲージと同じく選択月を最終月として判定）
const a36 = computed(() => alerts(selMemberId.value, selMonth.value))
const otMinutes = computed(() =>
  monthData.value.total.nonStatutoryOt + monthData.value.total.over60Ot)
const otRatio = computed(() => otMinutes.value / OT_MONTHLY_LIMIT_MIN)
const gaugeFillClass = computed(() => {
  if (otRatio.value >= 1) return 'bg-crit'
  if (otRatio.value >= 0.8) return 'bg-warn'
  return 'bg-brand'
})

// 自分の月次閲覧時にアラートがあればエスカレーション連携（冪等・補助処理）
watch([tab, selMemberId], () => {
  if (tab.value === 'monthly' && viewingSelf.value) {
    raiseOvertimeEscalations(currentUser.value.id)
  }
}, { immediate: true })

// ---------- 有給タブ ----------

const leaveBalance = computed(() => leave.balance(currentUser.value.id))
const leaveObligation = computed(() => leave.obligation(currentUser.value.id))

function fmtDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const leaveHistoryColumns: TableColumn[] = [
  { key: 'date', label: '日付', width: '110px', primary: true },
  { key: 'kindLabel', label: '区分', width: '70px', primary: true },
  { key: 'detail', label: '内容' },
  { key: 'status', label: '状態', width: '90px', primary: true },
  { key: 'days', label: '日数', width: '70px', align: 'right', primary: true },
]

const leaveHistoryRows = computed(() => {
  const me = currentUser.value.id
  const grantRows = leave.grantsOf(me).map(g => ({
    id: g.id,
    date: g.grantDate,
    rowKind: 'grant',
    kindLabel: '付与',
    detail: `${g.kind === 'normal' ? '通常' : '比例'}付与（失効 ${g.expireDate}）`,
    status: '',
    days: `+${fmtDays(g.days)}`,
  }))
  const reqRows = leave.requestsOf(me).map(r => ({
    id: r.id,
    date: r.date,
    rowKind: 'request',
    kindLabel: '取得',
    detail: `${LEAVE_UNIT_LABELS[r.unit]}${r.reason ? `・${r.reason}` : ''}`,
    status: r.status,
    days: r.status === 'approved' ? `-${fmtDays(r.unit === 'half' ? 0.5 : 1)}` : '—',
  }))
  return [...grantRows, ...reqRows].sort((a, b) => b.date.localeCompare(a.date))
})

function leaveStatusLabel(s: unknown): string {
  return LEAVE_REQUEST_STATUS_LABELS[s as LeaveRequest['status']] ?? ''
}
function leaveStatusTone(s: unknown): Tone {
  return LEAVE_REQUEST_STATUS_TONES[s as LeaveRequest['status']] ?? 'neutral'
}

// 有給申請モーダル
const leaveOpen = ref(false)
const leaveForm = ref({ date: '', unit: 'full', reason: '' })
const leaveError = ref('')
const leaveUnitOptions = Object.entries(LEAVE_UNIT_LABELS).map(([value, label]) => ({ value, label }))

function openLeaveModal(): void {
  leaveForm.value = { date: '', unit: 'full', reason: '' }
  leaveError.value = ''
  leaveOpen.value = true
}

function submitLeave(): void {
  leaveError.value = ''
  const r = leave.request({
    date: leaveForm.value.date,
    unit: leaveForm.value.unit as LeaveRequest['unit'],
    reason: leaveForm.value.reason,
  })
  if (!r.ok) {
    leaveError.value = r.error.message
    return
  }
  leaveOpen.value = false
  show('有給申請を送信しました（管理者へ通知済み）', 'ok', { label: '申請状況', to: '/attendance?tab=requests' })
}

// ---------- 申請タブ ----------

const myRequestColumns: TableColumn[] = [
  { key: 'type', label: '種類', width: '90px', primary: true },
  { key: 'date', label: '対象日', width: '110px', primary: true },
  { key: 'detail', label: '内容' },
  { key: 'reason', label: '理由' },
  { key: 'status', label: '状態', width: '90px', primary: true },
  { key: 'decidedBy', label: '承認者', width: '100px' },
]

const myRequestRows = computed(() => {
  const me = currentUser.value.id
  const fixRows = fixRequests.value
    .filter(f => f.memberId === me)
    .map(f => ({
      id: f.id,
      reqKind: 'fix',
      type: '打刻修正',
      date: f.date,
      detail: `${PUNCH_KIND_LABELS[f.kind]} を ${fmtTime(f.requestedAt)} に修正`,
      reason: f.reason,
      status: f.status,
      decidedBy: f.decidedBy ? memberName(f.decidedBy) : '—',
    }))
  const lvRows = leave.requestsOf(me).map(r => ({
    id: r.id,
    reqKind: 'leave',
    type: '有給休暇',
    date: r.date,
    detail: LEAVE_UNIT_LABELS[r.unit],
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy ? memberName(r.decidedBy) : '—',
  }))
  return [...fixRows, ...lvRows].sort((a, b) => b.date.localeCompare(a.date))
})

const pendingColumns: TableColumn[] = [
  { key: 'member', label: '申請者', width: '110px', primary: true },
  { key: 'type', label: '種類', width: '90px', primary: true },
  { key: 'date', label: '対象日', width: '110px' },
  { key: 'detail', label: '内容', primary: true },
  { key: 'reason', label: '理由' },
  { key: 'actions', label: '操作', width: '150px', align: 'right', primary: true },
]

const pendingRows = computed(() => {
  const fixRows = fixRequests.value
    .filter(f => f.status === 'pending')
    .map(f => ({
      id: f.id,
      reqKind: 'fix',
      member: memberName(f.memberId),
      type: '打刻修正',
      date: f.date,
      detail: `${PUNCH_KIND_LABELS[f.kind]} を ${fmtTime(f.requestedAt)} に修正`,
      reason: f.reason,
    }))
  const lvRows = leave.pendingRequests.value.map(r => ({
    id: r.id,
    reqKind: 'leave',
    member: memberName(r.memberId),
    type: '有給休暇',
    date: r.date,
    detail: LEAVE_UNIT_LABELS[r.unit],
    reason: r.reason,
  }))
  return [...fixRows, ...lvRows].sort((a, b) => a.date.localeCompare(b.date))
})

async function onDecide(row: Record<string, unknown>, action: 'approved' | 'rejected'): Promise<void> {
  const id = String(row.id)
  if (action === 'rejected') {
    const ok = await ask('申請の却下', `${String(row.member)} さんの${String(row.type)}申請（${String(row.date)}）を却下しますか？`, {
      danger: true, confirmLabel: '却下する',
    })
    if (!ok) return
  }
  const r = row.reqKind === 'fix' ? decideFix(id, action) : leave.decide(id, action)
  if (r.ok) {
    show(action === 'approved'
      ? `申請を承認しました${row.reqKind === 'fix' ? '（打刻へ反映済み）' : ''}`
      : '申請を却下しました', 'ok')
  } else {
    show(r.error.message, 'warn')
  }
}

// ---------- 設定タブ（管理者・attendanceRules） ----------

const rulesCrud = useMasterCrud('attendanceRules', 'ar')

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const weekdayOptions = WEEKDAYS.map((w, i) => ({ value: String(i), label: `${w}曜日` }))
const employmentOptions = Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))

const ruleColumns: TableColumn[] = [
  { key: 'name', label: '名称', primary: true },
  { key: 'applies', label: '選択可能な雇用区分' },
  { key: 'defaults', label: '既定にする雇用区分', primary: true },
  { key: 'hours', label: '始業〜終業', width: '120px' },
  { key: 'breakMin', label: '休憩', width: '70px', align: 'right' },
  { key: 'flex', label: 'フレックス', width: '150px' },
  { key: 'closing', label: '締め日', width: '70px' },
  { key: 'holiday', label: '法定休日', width: '80px' },
  { key: 'state', label: '状態', width: '70px', primary: true },
]

const ruleRows = computed(() => rulesCrud.list.value.map(r => ({
  id: r.id,
  name: r.name,
  applies: r.appliesTo.map(t => EMPLOYMENT_TYPE_LABELS[t]).join('・') || '—',
  defaults: r.defaultFor.map(t => EMPLOYMENT_TYPE_LABELS[t]).join('・') || '—（個別割当専用）',
  hours: `${r.workStart}〜${r.workEnd}`,
  breakMin: `${r.breakMinutes}分`,
  flex: r.flex?.enabled ? `コア ${r.flex.coreStart}〜${r.flex.coreEnd}` : '—',
  closing: r.closingDay >= 31 ? '月末' : `${r.closingDay}日`,
  holiday: `${WEEKDAYS[r.legalHolidayWeekday] ?? '日'}曜日`,
  state: r.active ? '有効' : '無効',
})))

const ruleOpen = ref(false)
const ruleErrors = ref<Record<string, string>>({})
const ruleForm = ref({
  id: '',
  name: '',
  appliesTo: [] as string[],
  defaultFor: [] as string[],
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  flexEnabled: false,
  coreStart: '10:00',
  coreEnd: '15:00',
  settlementMonths: 1,
  closingDay: 31,
  legalHolidayWeekday: '0',
})

function openRuleModal(rule?: AttendanceRule): void {
  ruleErrors.value = {}
  if (rule) {
    ruleForm.value = {
      id: rule.id,
      name: rule.name,
      appliesTo: [...rule.appliesTo],
      defaultFor: [...rule.defaultFor],
      workStart: rule.workStart,
      workEnd: rule.workEnd,
      breakMinutes: rule.breakMinutes,
      flexEnabled: rule.flex?.enabled ?? false,
      coreStart: rule.flex?.coreStart ?? '10:00',
      coreEnd: rule.flex?.coreEnd ?? '15:00',
      settlementMonths: rule.flex?.settlementMonths ?? 1,
      closingDay: rule.closingDay,
      legalHolidayWeekday: String(rule.legalHolidayWeekday),
    }
  } else {
    ruleForm.value = {
      id: '', name: '', appliesTo: [], defaultFor: [], workStart: '09:00', workEnd: '18:00',
      breakMinutes: 60, flexEnabled: false, coreStart: '10:00', coreEnd: '15:00',
      settlementMonths: 1, closingDay: 31, legalHolidayWeekday: '0',
    }
  }
  ruleOpen.value = true
}

function onRuleRowClick(row: Record<string, unknown>): void {
  const rule = rulesCrud.byId(String(row.id))
  if (rule) openRuleModal(rule)
}

function submitRule(): void {
  const f = ruleForm.value
  const errs: Record<string, string> = {}
  if (!f.name.trim()) errs.name = '名称を入力してください'
  if (f.appliesTo.length === 0) errs.appliesTo = '選択可能な雇用区分を1つ以上選択してください'
  if (f.defaultFor.some(t => !f.appliesTo.includes(t))) errs.defaultFor = '既定にする雇用区分は「選択可能な雇用区分」に含めてください'
  if (f.workStart && f.workEnd && f.workStart >= f.workEnd) errs.workEnd = '終業は始業より後の時刻にしてください'
  if (f.flexEnabled && f.coreStart >= f.coreEnd) errs.coreEnd = 'コア終了はコア開始より後の時刻にしてください'
  ruleErrors.value = errs
  if (Object.keys(errs).length > 0) return

  const payload: Partial<AttendanceRule> & { id?: string } = {
    name: f.name.trim(),
    appliesTo: f.appliesTo as EmploymentType[],
    defaultFor: f.defaultFor as EmploymentType[],
    workStart: f.workStart,
    workEnd: f.workEnd,
    breakMinutes: Math.max(0, Number(f.breakMinutes) || 0),
    flex: f.flexEnabled
      ? { enabled: true, coreStart: f.coreStart, coreEnd: f.coreEnd, settlementMonths: Math.max(1, Number(f.settlementMonths) || 1) }
      : null,
    closingDay: Math.min(31, Math.max(1, Number(f.closingDay) || 31)),
    legalHolidayWeekday: Number(f.legalHolidayWeekday),
  }
  if (f.id) payload.id = f.id
  const r = rulesCrud.save(payload)
  if (!r.ok) {
    show(r.error.message, 'warn')
    return
  }
  // 排他制御: 各雇用区分の既定は 1 ルールのみ。今回既定にした区分を他ルールの defaultFor から外す
  const savedId = r.id ?? f.id
  const stripped: string[] = []
  for (const other of rulesCrud.list.value) {
    if (other.id === savedId) continue
    const kept = other.defaultFor.filter(t => !payload.defaultFor!.includes(t))
    if (kept.length !== other.defaultFor.length) {
      rulesCrud.save({ id: other.id, defaultFor: kept })
      stripped.push(other.name)
    }
  }
  ruleOpen.value = false
  show(
    stripped.length > 0
      ? `勤怠ルールを保存しました（既定の付け替え: ${stripped.join('・')} から本ルールへ）`
      : '勤怠ルールを保存しました（日次集計に反映されます）',
    'ok',
  )
}
</script>

<template>
  <div>
    <UiPageHeader title="勤怠管理" description="打刻・6バケット集計・36協定アラート・有給・各種申請" />
    <UiTabBar :tabs="tabs" v-model="tab" />

    <!-- ================= 日次 ================= -->
    <div v-if="tab === 'daily'" role="tabpanel" aria-label="日次" class="mt-3">
      <UiFilterBar>
        <button type="button" class="btn" aria-label="前日" @click="shiftDate(-1)">
          <ChevronLeft class="h-4 w-4" /> 前日
        </button>
        <button type="button" class="btn" @click="selDate = todayKey">今日</button>
        <button type="button" class="btn" aria-label="翌日" @click="shiftDate(1)">
          翌日 <ChevronRight class="h-4 w-4" />
        </button>
        <input v-model="selDate" type="date" class="input w-auto" aria-label="表示日" >
        <span class="text-[13px] font-semibold text-sub">{{ fmtDateLong(selDate) }}</span>
        <UiSelect
          v-if="isAdmin"
          v-model="selMemberId"
          :options="memberOptions"
          aria-label="表示メンバー"
        />
        <template #trailing>
          <button v-if="canRequestFix" type="button" class="btn btn-primary" @click="openFixModal">
            <FilePen class="h-4 w-4" /> 打刻修正を申請
          </button>
        </template>
      </UiFilterBar>

      <div class="grid gap-3 lg:grid-cols-2">
        <!-- タイムライン -->
        <UiSectionCard
          title="タイムライン"
          :description="viewingSelf ? '打刻を時刻順に表示（修正前の打刻も履歴として保全）' : `${memberName(selMemberId)} さんの打刻を閲覧中（修正申請は本人のみ）`"
        >
          <UiEmptyState
            v-if="dailyTimeline.length === 0"
            icon="CalendarOff"
            title="この日の打刻はありません"
            :hint="!currentUser.punchRequired && viewingSelf ? `${currentUser.name} さんは打刻対象外です` : '休日または未出勤の日です'"
          />
          <ol v-else class="grid gap-2">
            <li v-for="p in dailyTimeline" :key="p.id" class="flex flex-wrap items-center gap-2">
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                :class="p.superseded ? 'bg-line-strong' : punchDotClass(p.kind)"
                aria-hidden="true"
              />
              <span class="num w-12 text-[13px] font-bold" :class="p.superseded ? 'text-muted line-through' : ''">
                {{ fmtTime(p.at) }}
              </span>
              <span class="text-[13px]" :class="p.superseded ? 'text-muted line-through' : ''">
                {{ PUNCH_KIND_LABELS[p.kind] }}
              </span>
              <UiStatusBadge v-if="p.superseded" tone="neutral" label="修正前" />
              <UiStatusBadge v-else-if="p.source === 'fix'" tone="info" label="修正反映" />
              <span v-if="p.fixReason" class="text-[11px] text-muted">（{{ p.fixReason }}）</span>
            </li>
          </ol>
          <div v-if="dayPendingFixes.length > 0" class="mt-3 border-t border-line pt-2">
            <p v-for="f in dayPendingFixes" :key="f.id" class="flex flex-wrap items-center gap-1.5 text-[12px] text-sub">
              <UiStatusBadge tone="info" label="修正申請中" />
              {{ PUNCH_KIND_LABELS[f.kind] }} を {{ fmtTime(f.requestedAt) }} に修正（{{ f.reason }}）
            </p>
          </div>
        </UiSectionCard>

        <!-- 日次集計 -->
        <UiSectionCard title="日次集計" description="労基法 32/36/37 条に基づく 6 バケット分解">
          <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-sub">
            <span>実労働 <b class="num text-ink">{{ fmtMinutes(dailyData.workMinutes) }}</b></span>
            <span>休憩 <b class="num text-ink">{{ fmtMinutes(dailyData.breakMinutes) }}</b></span>
            <UiStatusBadge
              v-if="dailyData.breakShortage > 0"
              tone="warn"
              :label="`休憩不足 ${fmtMinutes(dailyData.breakShortage)}`"
            />
          </div>
          <p v-if="dailyData.breakShortage > 0" class="mb-2 text-[11px] text-warn">
            法定基準（6h超は45分・8h超は60分）に対して休憩が不足しています。休憩打刻の修正を申請してください。
          </p>
          <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div v-for="b in BUCKET_DEFS" :key="b.key" class="rounded-lg border border-line px-2.5 py-2">
              <dt class="text-[11px] font-semibold text-muted">{{ b.label }}</dt>
              <dd class="num text-[15px] font-bold" :class="bucketValueClass(b.key, dailyData.buckets[b.key])">
                {{ fmtMinutes(dailyData.buckets[b.key]) }}
              </dd>
            </div>
          </dl>
        </UiSectionCard>
      </div>
    </div>

    <!-- ================= 週次 ================= -->
    <div v-else-if="tab === 'weekly'" role="tabpanel" aria-label="週次" class="mt-3">
      <UiFilterBar>
        <button type="button" class="btn" aria-label="前週" @click="shiftWeek(-1)">
          <ChevronLeft class="h-4 w-4" /> 前週
        </button>
        <button type="button" class="btn" @click="selWeekStart = startOfWeek(todayKey)">今週</button>
        <button type="button" class="btn" aria-label="翌週" @click="shiftWeek(1)">
          翌週 <ChevronRight class="h-4 w-4" />
        </button>
        <span class="text-[13px] font-semibold text-sub">{{ weekLabel }}</span>
        <template #trailing>
          <UiSelect
            v-if="isAdmin"
            v-model="selMemberId"
            :options="memberOptions"
            aria-label="表示メンバー"
          />
        </template>
      </UiFilterBar>

      <div class="grid gap-3 lg:grid-cols-2">
        <!-- 週間グリッド（日曜起点） -->
        <UiSectionCard title="週間グリッド" description="日曜〜土曜の実労働と法定外残業。日をクリックするとその日の日次を表示します">
          <ol class="grid gap-1.5">
            <li v-for="d in weekDays" :key="d.date">
              <button
                type="button"
                class="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-brand"
                :class="weekdayOf(d.date) === weekLegalWd ? 'bg-page' : 'bg-surface'"
                :aria-label="`${fmtDateLong(d.date)} の日次を表示`"
                @click="openDaily(d.date)"
              >
                <span class="w-16 shrink-0">
                  <span class="text-[11px] font-semibold" :class="weekdayOf(d.date) === 0 ? 'text-serious' : 'text-muted'">
                    {{ WEEKDAYS[weekdayOf(d.date)] }}
                  </span>
                  <span class="num ml-1 text-[13px] font-bold">{{ fmtDate(d.date) }}</span>
                </span>
                <span class="text-[12px] text-sub">
                  実労働 <b class="num" :class="d.workMinutes > 0 ? 'text-ink' : 'text-muted'">{{ fmtMinutes(d.workMinutes) }}</b>
                </span>
                <span class="text-[12px] text-sub">
                  法定外 <b class="num" :class="dayOtMinutes(d) > 0 ? 'text-warn' : 'text-muted'">{{ fmtMinutes(dayOtMinutes(d)) }}</b>
                </span>
                <UiStatusBadge v-if="weekdayOf(d.date) === weekLegalWd" tone="neutral" label="法定休日" />
              </button>
            </li>
          </ol>
        </UiSectionCard>

        <!-- 週間合計 + 週 40h 進捗 -->
        <UiSectionCard title="週間合計" description="法定労働時間（週40時間・労基法32条）に対する実労働の進捗">
          <div class="flex items-baseline justify-between text-[12px]">
            <span class="font-semibold text-sub">実労働合計（週40時間に対する進捗）</span>
            <span class="num font-bold" :class="weekRatio > 1 ? 'text-crit' : weekRatio >= 0.8 ? 'text-warn' : 'text-ink'">
              {{ fmtMinutes(weekTotalWork) }} / {{ fmtMinutes(LEGAL_WEEKLY_MIN) }}
            </span>
          </div>
          <div
            class="mt-1 h-2 overflow-hidden rounded-full border border-line bg-page"
            role="progressbar"
            aria-label="週40時間に対する実労働の進捗"
            :aria-valuenow="Math.min(100, Math.round(weekRatio * 100))"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full rounded-full transition-all"
              :class="weekGaugeFillClass"
              :style="{ width: `${Math.min(100, weekRatio * 100)}%` }"
            />
          </div>
          <p v-if="weekTotalWork > LEGAL_WEEKLY_MIN" class="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            <UiStatusBadge tone="crit" label="週40時間超過" />
            <span class="text-sub">超過 <b class="num text-crit">{{ fmtMinutes(weekTotalWork - LEGAL_WEEKLY_MIN) }}</b>（法定外残業として月次・36協定判定に反映されます）</span>
          </p>
          <p v-else-if="weekRatio >= 0.8" class="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            <UiStatusBadge tone="warn" label="警告" />
            <span class="text-sub">週40時間の{{ Math.round(weekRatio * 100) }}%に達しています</span>
          </p>
          <p v-else class="mt-2 flex items-center gap-1.5 text-[12px] text-sub">
            <UiStatusBadge tone="ok" label="良好" dot /> 週40時間の範囲内です
          </p>
        </UiSectionCard>
      </div>
    </div>

    <!-- ================= 月次 ================= -->
    <div v-else-if="tab === 'monthly'" role="tabpanel" aria-label="月次" class="mt-3">
      <UiFilterBar>
        <button type="button" class="btn" aria-label="前月" @click="shiftMonth(-1)">
          <ChevronLeft class="h-4 w-4" /> 前月
        </button>
        <button type="button" class="btn" @click="selMonth = todayKey.slice(0, 7)">今月</button>
        <button type="button" class="btn" aria-label="翌月" @click="shiftMonth(1)">
          翌月 <ChevronRight class="h-4 w-4" />
        </button>
        <span class="text-[13px] font-semibold text-sub">{{ monthLabel }}</span>
        <template #trailing>
          <UiSelect
            v-if="isAdmin"
            v-model="selMemberId"
            :options="memberOptions"
            aria-label="表示メンバー"
          />
        </template>
      </UiFilterBar>

      <div class="grid gap-3">
        <UiSectionCard title="月間カレンダー" description="セルをクリックするとその日の日次を表示します">
          <WidgetsCalendarMonth
            :month="selMonth"
            :days="calendarDays"
            :selected-date="selDate"
            @select="openDaily"
          />
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span class="inline-flex items-center gap-1">
              <span class="inline-block h-3 w-3 rounded border border-line bg-page" aria-hidden="true" /> 法定休日
            </span>
            <span class="inline-flex items-center gap-1">
              <span class="inline-block h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" /> アラート（休憩不足・60h超残業）
            </span>
            <span class="inline-flex items-center gap-1"><span class="font-semibold text-info">休暇</span> = 承認済み有給</span>
          </div>
        </UiSectionCard>

        <div class="grid gap-3 lg:grid-cols-2">
          <UiSectionCard title="月次集計" :description="`${monthLabel}の 6 バケット合計`">
            <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-sub">
              <span>出勤日数 <b class="num text-ink">{{ monthData.workDays }}日</b></span>
              <span>実労働合計 <b class="num text-ink">{{ fmtMinutes(monthTotalWork) }}</b></span>
            </div>
            <dl class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div v-for="b in BUCKET_DEFS" :key="b.key" class="rounded-lg border border-line px-2.5 py-2">
                <dt class="text-[11px] font-semibold text-muted">{{ b.label }}</dt>
                <dd class="num text-[15px] font-bold" :class="bucketValueClass(b.key, monthData.total[b.key])">
                  {{ fmtMinutes(monthData.total[b.key]) }}
                </dd>
              </div>
            </dl>
          </UiSectionCard>

          <UiSectionCard title="36協定アラート" description="月45h接近（80%で警告）・単月100h・2〜6ヶ月平均80h・年6回上限を判定">
            <div class="mb-3">
              <div class="flex items-baseline justify-between text-[12px]">
                <span class="font-semibold text-sub">{{ monthLabel }}の法定外残業（月45hに対する進捗）</span>
                <span class="num font-bold" :class="otRatio >= 0.8 ? 'text-warn' : 'text-ink'">
                  {{ fmtHours(otMinutes) }} / {{ fmtHours(OT_MONTHLY_LIMIT_MIN) }}
                </span>
              </div>
              <div
                class="mt-1 h-2 overflow-hidden rounded-full border border-line bg-page"
                role="progressbar"
                aria-label="月45時間に対する法定外残業の進捗"
                :aria-valuenow="Math.round(otRatio * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="h-full rounded-full transition-all"
                  :class="gaugeFillClass"
                  :style="{ width: `${Math.min(100, otRatio * 100)}%` }"
                />
              </div>
            </div>
            <ul v-if="a36.length > 0" class="grid gap-1.5">
              <li v-for="a in a36" :key="a.code" class="flex items-start gap-2">
                <UiStatusBadge :tone="a.level" :label="a.level === 'crit' ? '重大' : '警告'" />
                <span class="text-[12px] leading-5">{{ a.message }}</span>
              </li>
            </ul>
            <p v-else class="flex items-center gap-1.5 text-[12px] text-sub">
              <UiStatusBadge tone="ok" label="良好" dot /> {{ monthLabel }}までの直近6ヶ月に36協定アラートはありません
            </p>
          </UiSectionCard>
        </div>
      </div>
    </div>

    <!-- ================= 有給 ================= -->
    <div v-else-if="tab === 'leave'" role="tabpanel" aria-label="有給" class="mt-3">
      <UiFilterBar>
        <span class="text-[12px] text-sub">{{ currentUser.name }} さんの有給休暇</span>
        <template #trailing>
          <button type="button" class="btn btn-primary" @click="openLeaveModal">
            <CalendarPlus class="h-4 w-4" /> 有給を申請
          </button>
        </template>
      </UiFilterBar>

      <div class="grid gap-3">
        <div class="grid gap-3 md:grid-cols-3">
          <UiKpiCard
            label="有給残数"
            :value="`${fmtDays(leaveBalance.remaining)}日`"
            sub="付与から消化・失効分を差引"
            icon="CalendarCheck"
          />
          <UiKpiCard
            label="直近の失効予定"
            :value="leaveBalance.nextExpire ? `${fmtDays(leaveBalance.nextExpire.days)}日` : 'なし'"
            :sub="leaveBalance.nextExpire ? `${leaveBalance.nextExpire.date} に失効見込み` : '失効予定はありません'"
            icon="CalendarX"
          />
          <UiKpiCard
            label="今年度の取得"
            :value="`${fmtDays(leaveBalance.usedThisFiscalYear)}日`"
            sub="今年度（4月起算）の承認済み取得"
            icon="History"
          />
        </div>

        <UiSectionCard
          title="年5日取得義務トラッカー"
          description="年10日以上付与された労働者は、付与日から1年以内に5日の取得が必要です（労基法39条7項）"
        >
          <template v-if="leaveObligation.applicable">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-[13px]">
                対象付与日 <b class="num">{{ leaveObligation.grantDate }}</b>
                ・取得期限 <b class="num">{{ leaveObligation.deadline }}</b>
              </p>
              <UiStatusBadge v-if="leaveObligation.achieved" tone="ok" label="達成" />
              <UiStatusBadge v-else-if="leaveObligation.warn" tone="warn" label="未達・残り3ヶ月未満" />
              <UiStatusBadge v-else tone="info" label="進行中" />
            </div>
            <div
              class="mt-2 h-2 overflow-hidden rounded-full border border-line bg-page"
              role="progressbar"
              aria-label="年5日取得義務の進捗"
              :aria-valuenow="Math.round(Math.min(1, leaveObligation.taken / leaveObligation.required) * 100)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="h-full rounded-full transition-all"
                :class="leaveObligation.achieved ? 'bg-ok' : leaveObligation.warn ? 'bg-warn' : 'bg-brand'"
                :style="{ width: `${Math.min(100, (leaveObligation.taken / leaveObligation.required) * 100)}%` }"
              />
            </div>
            <p class="mt-1 text-[12px] text-sub">
              取得 <b class="num text-ink">{{ fmtDays(leaveObligation.taken) }}日</b> / {{ leaveObligation.required }}日
              <template v-if="leaveObligation.daysLeft >= 0">（期限まで残り {{ leaveObligation.daysLeft }} 日）</template>
              <template v-else>（期限超過）</template>
            </p>
            <p v-if="leaveObligation.warn" class="mt-1 text-[11px] text-warn">
              期限まで3ヶ月を切っています。「有給を申請」から取得日を計画してください。
            </p>
          </template>
          <p v-else class="text-[12px] text-muted">年10日以上の付与がないため、取得義務の対象外です。</p>
        </UiSectionCard>

        <UiSectionCard title="付与・取得履歴" flush>
          <UiDataTable
            :columns="leaveHistoryColumns"
            :rows="leaveHistoryRows"
            empty-title="付与・取得の履歴がありません"
            empty-hint="入社6ヶ月経過後に付与されます"
          >
            <template #cell-kindLabel="{ row }">
              <UiStatusBadge :tone="row.rowKind === 'grant' ? 'brand' : 'info'" :label="String(row.kindLabel)" />
            </template>
            <template #cell-status="{ value }">
              <UiStatusBadge v-if="value" :tone="leaveStatusTone(value)" :label="leaveStatusLabel(value)" />
              <span v-else class="text-muted">—</span>
            </template>
          </UiDataTable>
        </UiSectionCard>
      </div>
    </div>

    <!-- ================= 申請 ================= -->
    <div v-else-if="tab === 'requests'" role="tabpanel" aria-label="申請" class="mt-3 grid gap-3">
      <UiSectionCard
        v-if="isAdmin"
        title="承認待ち"
        :description="`打刻修正・有給休暇の承認待ち ${pendingRows.length} 件`"
        flush
      >
        <UiDataTable
          :columns="pendingColumns"
          :rows="pendingRows"
          empty-title="承認待ちの申請はありません"
        >
          <template #cell-actions="{ row }">
            <span class="inline-flex gap-1.5">
              <button type="button" class="btn btn-sm btn-primary" @click.stop="onDecide(row, 'approved')">
                <Check class="h-3.5 w-3.5" /> 承認
              </button>
              <button type="button" class="btn btn-sm btn-danger" @click.stop="onDecide(row, 'rejected')">
                <X class="h-3.5 w-3.5" /> 却下
              </button>
            </span>
          </template>
        </UiDataTable>
      </UiSectionCard>

      <UiSectionCard title="自分の申請" description="打刻修正と有給休暇の申請状況" flush>
        <UiDataTable
          :columns="myRequestColumns"
          :rows="myRequestRows"
          empty-title="申請はまだありません"
          empty-hint="日次タブの「打刻修正を申請」、有給タブの「有給を申請」から作成できます"
        >
          <template #cell-status="{ value }">
            <UiStatusBadge :tone="leaveStatusTone(value)" :label="leaveStatusLabel(value)" />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ================= 設定（管理者） ================= -->
    <div v-else-if="tab === 'settings' && isAdmin" role="tabpanel" aria-label="設定" class="mt-3 grid gap-3">
      <UiSectionCard
        title="勤怠ルール"
        description="この設定は日次集計に反映されます（所定労働時間・法定休日の判定・締め日）。行をクリックすると編集できます"
        flush
      >
        <template #actions>
          <button type="button" class="btn" @click="openRuleModal()">
            <Plus class="h-4 w-4" /> ルールを追加
          </button>
        </template>
        <UiDataTable
          :columns="ruleColumns"
          :rows="ruleRows"
          clickable
          empty-title="勤怠ルールがありません"
          @row-click="onRuleRowClick"
        >
          <template #cell-state="{ row }">
            <UiStatusBadge :tone="row.state === '有効' ? 'ok' : 'neutral'" :label="String(row.state)" />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ================= モーダル: 打刻修正申請 ================= -->
    <UiModal :open="fixOpen" title="打刻修正を申請" @close="fixOpen = false">
      <div class="grid gap-3">
        <p class="text-[12px] text-sub">
          対象日: <b class="num">{{ fmtDateLong(selDate) }}</b>。
          修正は承認後に反映され、修正前の打刻・修正者・承認者は履歴として保全されます。
        </p>
        <UiFormField label="打刻種別" required>
          <UiSelect v-model="fixForm.kind" :options="punchKindOptions" aria-label="打刻種別" />
        </UiFormField>
        <UiFormField label="修正時刻" required>
          <input v-model="fixForm.time" type="time" class="input" >
        </UiFormField>
        <UiFormField label="修正理由" required hint="客観的記録の担保のため必須です">
          <textarea
            v-model="fixForm.reason"
            class="textarea"
            placeholder="例: 退勤打刻を忘れて帰宅したため"
          />
        </UiFormField>
        <p v-if="fixError" class="text-[12px] font-medium text-crit" role="alert">{{ fixError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="fixOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitFix">申請する</button>
      </template>
    </UiModal>

    <!-- ================= モーダル: 有給申請 ================= -->
    <UiModal :open="leaveOpen" title="有給を申請" @close="leaveOpen = false">
      <div class="grid gap-3">
        <p class="text-[12px] text-sub">
          現在の残数: <b class="num">{{ fmtDays(leaveBalance.remaining) }}日</b>（承認後に消化されます）
        </p>
        <UiFormField label="取得日" required>
          <input v-model="leaveForm.date" type="date" class="input" >
        </UiFormField>
        <UiFormField label="取得単位" required>
          <UiSelect v-model="leaveForm.unit" :options="leaveUnitOptions" aria-label="取得単位" />
        </UiFormField>
        <UiFormField label="理由" hint="任意。承認者への補足があれば記入してください">
          <textarea v-model="leaveForm.reason" class="textarea" placeholder="例: 私用のため" />
        </UiFormField>
        <p v-if="leaveError" class="text-[12px] font-medium text-crit" role="alert">{{ leaveError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="leaveOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitLeave">申請する</button>
      </template>
    </UiModal>

    <!-- ================= モーダル: 勤怠ルール編集 ================= -->
    <UiModal :open="ruleOpen" :title="ruleForm.id ? '勤怠ルールを編集' : '勤怠ルールを追加'" @close="ruleOpen = false">
      <div class="grid gap-3">
        <UiFormField label="名称" required :error="ruleErrors.name">
          <input v-model="ruleForm.name" type="text" class="input" placeholder="例: 正社員（フレックス）" >
        </UiFormField>
        <UiFormField
          label="選択可能な雇用区分" required :error="ruleErrors.appliesTo"
          hint="この勤務体系を個別割当できる雇用区分（メンバーマスタの選択候補）"
        >
          <UiChipSelect v-model="ruleForm.appliesTo" :options="employmentOptions" aria-label="選択可能な雇用区分" />
        </UiFormField>
        <UiFormField
          label="既定にする雇用区分" :error="ruleErrors.defaultFor"
          hint="メンバーが勤務体系を個別指定していない場合に適用される既定。各雇用区分につき 1 ルールのみ（保存時に自動で付け替え）。個別割当専用のルールは未選択のままにする"
        >
          <UiChipSelect v-model="ruleForm.defaultFor" :options="employmentOptions" aria-label="既定にする雇用区分" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="始業">
            <input v-model="ruleForm.workStart" type="time" class="input" >
          </UiFormField>
          <UiFormField label="終業" :error="ruleErrors.workEnd">
            <input v-model="ruleForm.workEnd" type="time" class="input" >
          </UiFormField>
        </div>
        <UiFormField label="休憩（分）">
          <input v-model.number="ruleForm.breakMinutes" type="number" min="0" step="5" class="input num" >
        </UiFormField>
        <UiFormField label="フレックスタイム">
          <label class="flex cursor-pointer items-center gap-2 text-[13px]">
            <input v-model="ruleForm.flexEnabled" type="checkbox" class="h-4 w-4 accent-[var(--c-brand)]" >
            <span class="text-sub">フレックスを有効にする</span>
          </label>
        </UiFormField>
        <div v-if="ruleForm.flexEnabled" class="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-3">
          <UiFormField label="コア開始">
            <input v-model="ruleForm.coreStart" type="time" class="input" >
          </UiFormField>
          <UiFormField label="コア終了" :error="ruleErrors.coreEnd">
            <input v-model="ruleForm.coreEnd" type="time" class="input" >
          </UiFormField>
          <UiFormField label="清算期間（月）">
            <input v-model.number="ruleForm.settlementMonths" type="number" min="1" max="3" class="input num" >
          </UiFormField>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="締め日" hint="月末締めは 31">
            <input v-model.number="ruleForm.closingDay" type="number" min="1" max="31" class="input num" >
          </UiFormField>
          <UiFormField label="法定休日の曜日">
            <UiSelect v-model="ruleForm.legalHolidayWeekday" :options="weekdayOptions" aria-label="法定休日の曜日" />
          </UiFormField>
        </div>
        <p class="text-[11px] text-muted">
          保存すると、対象雇用区分のメンバーの日次集計（所定内の判定・法定休日の判定）に即時反映されます。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="ruleOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitRule">保存</button>
      </template>
    </UiModal>
  </div>
</template>
