<script setup lang="ts">
/**
 * 日報・週報（F-06）
 * タブ: 自分の日報 / 自分の週報 / 全員の日報 / 全員の週報 / チーム（オペレーター指示 2026-07-22 で再編）
 * - 参照権限は権限表の「日報・週報の参照対象」（F-16-6 canViewMemberReports）で管理する
 * - 自分の日報: 週/月の表示モード（月は横スクロール・カレンダーの 2 ビュー）+ テーブル形式の通常入力 +
 *   明日の予定（最大 3 件。翌営業日の日報へ自動反映）
 * - 全員の日報・全員の週報・チーム: 部署・メンバーで絞り込み
 * - チーム: 週/月の表示モード（月は横スクロールマトリクス・カレンダーの 2 ビュー）
 * 参照 = 基本ビュー・入力 = ボタン押下で表示（バッチ7h・オペレーター指示 2026-07-19 #10 ④）
 */
import {
  BellRing, Check, ChevronLeft, ChevronRight, Eye, Minus, Pencil, Plus, Send, Settings2, Sparkles, Trash2,
} from 'lucide-vue-next'
import type { DailyReport, ReportEntry, TomorrowPlan, WeeklyReport } from '~/types/domain'
import { TOMORROW_PLANS_MAX } from '../../../shared/domain/types'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { addDays, daysInMonth, fmtDate, fmtDateLong, fmtMinutes, fmtTime, weekdayOf } from '~/utils/format'
import { EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPE_TONES } from '~/utils/labels'
import { parseTeamVisibleIds } from '~/utils/team-visibility'
import type { TabItem, TableColumn, Tone } from '~/types/ui'

const route = useRoute()
const { currentUser, currentUserId, isAdmin, isHrOrAdmin } = useCurrentUser()
const reports = useReports()
const attendance = useAttendance()
const { show } = useToast()
const { ask } = useConfirm()
const { isRunning, run } = useAsyncAction()
const { tbl } = useMockDb()
const projects = tbl('projects')
const members = tbl('members')
const { options: deptOptions } = useDepartments()

/** 'YYYY-MM' に月を加算（月送り。日付キー計算は addDays と別で月境界を扱う） */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  const base = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' の全日付（1日〜末日・昇順） */
function daysOfMonth(ym: string): string[] {
  const [y, m] = [Number(ym.slice(0, 4)), Number(ym.slice(5, 7))]
  return Array.from({ length: daysInMonth(y, m) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)
}

// ---------- タブ ----------

const TAB_KEYS = ['mine', 'weekly-mine', 'all', 'weekly-all', 'team'] as const
const tabs = computed<TabItem[]>(() => [
  { key: 'mine', label: '自分の日報' },
  { key: 'weekly-mine', label: '自分の週報' },
  { key: 'all', label: '全員の日報' },
  { key: 'weekly-all', label: '全員の週報' },
  { key: 'team', label: 'チーム' },
])
// 旧タブキーのリンク互換（?tab=weekly = 旧・週報タブ → 自分の週報）
const queryTabRaw = typeof route.query.tab === 'string' ? route.query.tab : ''
const queryTab = queryTabRaw === 'weekly' ? 'weekly-mine' : queryTabRaw
const tab = ref<string>((TAB_KEYS as readonly string[]).includes(queryTab) ? queryTab : 'mine')
watchEffect(() => {
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = 'mine'
})

// ---------- 共通ヘルパー ----------

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

function dayLabel(d: string): string {
  return `${fmtDate(d)}(${WEEKDAYS[weekdayOf(d)] ?? ''})`
}

function projectName(id: string): string {
  return projects.value.find(p => p.id === id)?.name ?? id
}

/**
 * エントリのテーマ表示（旧データは theme 未設定 → プロジェクト名へフォールバック。原則7）。
 * プロジェクトは論理削除のみで名称が残るため、フォールバックは常に名称解決できる
 */
function entryTheme(e: ReportEntry): string {
  return e.theme || (e.projectId ? projectName(e.projectId) : '')
}

function totalHoursOf(r: DailyReport): number {
  return r.entries.reduce((s, e) => s + e.hours, 0)
}

function gapText(gap: number): string {
  return gap > 0 ? `+${fmtMinutes(gap)}` : fmtMinutes(gap)
}

// ---------- 部署・メンバー絞り込み（全員の日報 / 全員の週報 / チーム） ----------

const memberFilterOptions = computed(() =>
  members.value.filter(m => m.active).map(m => ({ value: m.id, label: m.name })))

/**
 * 部署・メンバーの絞り込み判定。memberId = null は AI 社員の日報
 * （メンバー・部署の属性を持たないため、絞り込み未指定のときのみ表示する）
 */
function matchesMemberFilter(memberId: string | null | undefined, deptId: string, memId: string): boolean {
  if (!memberId) return !deptId && !memId
  if (memId && memberId !== memId) return false
  if (deptId) {
    const m = members.value.find(x => x.id === memberId)
    if (!m || m.departmentId !== deptId) return false
  }
  return true
}

// ---------- 自分の日報タブ ----------

const selDate = ref(todayJst())
const myReport = computed(() => reports.myReportOn(selDate.value))

/** 表示モード（週 / 月）と月ビューの形式（横スクロール / カレンダー） */
const mineView = ref<'week' | 'month'>('week')
const mineMonthView = ref<'scroll' | 'calendar'>('scroll')
const mineMonth = computed(() => selDate.value.slice(0, 7))
const mineMonthDays = computed(() => daysOfMonth(mineMonth.value))
const mineWeekDays = computed(() => {
  const start = reports.weekStartOf(selDate.value)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
})

/** 自分の日報の提出状態（本人のため下書きも表示する） */
function myStatusOf(date: string): 'submitted' | 'draft' | 'none' {
  const r = reports.reportOn(currentUserId.value, date)
  if (!r) return 'none'
  return r.status === 'submitted' ? 'submitted' : 'draft'
}

function myDayCellClass(date: string): string {
  const s = myStatusOf(date)
  const sel = date === selDate.value ? ' ring-2 ring-[var(--c-brand)]' : ''
  if (s === 'submitted') return `bg-ok-soft text-ok${sel}`
  if (s === 'draft') return `bg-warn-soft text-warn${sel}`
  return `bg-surface-soft text-muted${sel}`
}

function myDayAria(date: string): string {
  const s = myStatusOf(date)
  return `${fmtDateLong(date)}: ${s === 'none' ? '未作成' : REPORT_STATUS_LABELS[s]}。クリックで表示`
}

/** カレンダー形式の週分割（日曜始まり。先頭週は前月分を null 詰め） */
const mineCalendarWeeks = computed(() => {
  const cells: (string | null)[] = []
  const first = mineMonthDays.value[0]
  if (first) for (let i = 0; i < weekdayOf(first); i++) cells.push(null)
  cells.push(...mineMonthDays.value)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (string | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
})

const editEntries = ref<ReportEntry[]>([])
const editPlans = ref<TomorrowPlan[]>([])
// フリー入力欄のマークダウンプレビュー（バッチ7e。入力はプレーンな textarea のまま = 記法をそのまま保存）
const dailyMdPreview = ref(false)
const wkMdPreview = ref(false)
const editReflection = ref('')
const editIssues = ref('')
/** 旧形式の明日の予定（自由記述）。編集 UI は持たず保存時にそのまま保持する（原則7） */
const editTomorrow = ref('')

/** 前営業日の「明日の予定」を自動反映した場合の反映元（バナー表示用） */
const reflected = ref<{ fromDate: string; plans: TomorrowPlan[] } | null>(null)

/**
 * 選択日へ自動反映すべき前営業日の「明日の予定」（未作成日のみ）。
 * computed にすることで API モードの遅延ロード到着（dailyReports の変化）にも追従する
 * （loadEditor の watch は myReport が undefined のままだと発火しないため、下の watch が補完する）
 */
const autoPlans = computed(() =>
  myReport.value ? null : reports.tomorrowPlansFor(selDate.value))

/** エディタが未入力（= 空行の既定値のみ。自動反映で上書きしてよい状態）か */
function isPristineEditor(): boolean {
  return editEntries.value.every(e =>
    !(e.theme ?? '').trim() && !e.task.trim() && e.hours === 1 && e.progress === 0)
    && !editReflection.value.trim() && !editIssues.value.trim() && editPlans.value.length === 0
}

// API モード: 前営業日の日報（明日の予定入り）が非同期到着した時点で未入力エディタへ反映する
watch(autoPlans, (v) => {
  if (!v || v.plans.length === 0) return
  if (myReport.value || editingSubmitted.value) return
  if (reflected.value?.fromDate === v.fromDate) return // 反映済み（二重適用しない）
  if (!isPristineEditor()) return // 入力中の内容を黙って上書きしない
  editEntries.value = v.plans.map(p => ({ theme: p.theme, projectId: '', task: p.task, hours: p.hours, progress: 0 }))
  reflected.value = v
})

function blankEntry(): ReportEntry {
  return { theme: '', projectId: '', task: '', hours: 1, progress: 0 }
}

function blankPlan(): TomorrowPlan {
  return { theme: '', purpose: '', task: '', hours: 1 }
}

/** エディタへ読み込む形へ整える（旧データの theme をプロジェクト名で補完してから編集させる） */
function toEditable(e: ReportEntry): ReportEntry {
  return { ...e, theme: entryTheme(e) }
}

/** 提出済み日報の編集モード（オペレーター指示: 提出済みも本人が編集可。提出状態は維持） */
const editingSubmitted = ref(false)

/** 参照 = 基本ビュー・入力はボタン押下（バッチ7h ④）。日付・ユーザー切替で参照へ戻す */
const mineEditing = ref(false)
watch([selDate, currentUserId], () => { mineEditing.value = false })

function loadEditor(): void {
  if (editingSubmitted.value) return // 編集中の内容をデータ再取得で消さない
  const r = myReport.value
  if (r && r.status === 'draft') {
    editEntries.value = r.entries.length > 0 ? r.entries.map(toEditable) : [blankEntry()]
    editReflection.value = r.reflection
    editIssues.value = r.issues
    editTomorrow.value = r.tomorrow
    editPlans.value = (r.tomorrowPlans ?? []).map(p => ({ ...p }))
    reflected.value = null
  } else {
    // 未作成日は前営業日に登録した「明日の予定」をエントリへ自動反映する（オペレーター指示 2026-07-22）
    const auto = autoPlans.value
    if (auto && auto.plans.length > 0) {
      editEntries.value = auto.plans.map(p => ({ theme: p.theme, projectId: '', task: p.task, hours: p.hours, progress: 0 }))
      reflected.value = auto
    } else {
      editEntries.value = [blankEntry()]
      reflected.value = null
    }
    editReflection.value = ''
    editIssues.value = ''
    editTomorrow.value = ''
    editPlans.value = []
  }
}
// 日付・ユーザーが変わったら提出済み編集モードを終了する。
// watcher は登録順に実行されるため、loadEditor より先に登録する（後だと editingSubmitted ガードで
// 新日付の loadEditor がスキップされ、編集中の旧日付の内容が別日付のエディタに残留する）
watch([selDate, currentUserId], () => { editingSubmitted.value = false })
// myReport も監視: API モードでは月データが非同期に届くため、到着後に下書きを復元する
watch([selDate, currentUserId, myReport], loadEditor, { immediate: true })

/** 提出済み日報の編集を開始（内容をエディタへ読み込む） */
function startEditSubmitted(): void {
  const r = myReport.value
  if (!r || r.status !== 'submitted') return
  editEntries.value = r.entries.length > 0 ? r.entries.map(toEditable) : [blankEntry()]
  editReflection.value = r.reflection
  editIssues.value = r.issues
  editTomorrow.value = r.tomorrow
  editPlans.value = (r.tomorrowPlans ?? []).map(p => ({ ...p }))
  reflected.value = null
  editingSubmitted.value = true
  scrollToEditor()
}

/** 提出済み日報の更新保存（提出状態は維持。サーバーが監査ログへ記録） */
async function onUpdateSubmitted(): Promise<void> {
  await run('mine-update', async () => {
    const res = await reports.submit(payload())
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    editingSubmitted.value = false
    show('提出済みの日報を更新しました')
    if (res.escalated) {
      show('課題が管理者へ共有されました', 'info', { label: '受信箱', to: '/inbox' })
    }
    if (res.hoursGapMinutes !== null && res.hoursGapMinutes !== undefined) {
      show(`勤怠実労働と時間合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
    }
  }, { message: '提出済みの日報を更新しています…' })
}

function addRow(): void {
  editEntries.value.push(blankEntry())
}

function removeRow(i: number): void {
  editEntries.value.splice(i, 1)
  if (editEntries.value.length === 0) editEntries.value.push(blankEntry())
}

function stepHours(i: number, delta: number): void {
  const e = editEntries.value[i]
  if (!e) return
  const cur = Number.isFinite(e.hours) ? e.hours : 0
  e.hours = Math.max(0, Math.round((cur + delta) * 4) / 4)
}

// 明日の予定（最大 TOMORROW_PLANS_MAX 件）

function addPlan(): void {
  if (editPlans.value.length >= TOMORROW_PLANS_MAX) return
  editPlans.value.push(blankPlan())
}

function removePlan(i: number): void {
  editPlans.value.splice(i, 1)
}

function stepPlanHours(i: number, delta: number): void {
  const p = editPlans.value[i]
  if (!p) return
  const cur = Number.isFinite(p.hours) ? p.hours : 0
  p.hours = Math.max(0, Math.round((cur + delta) * 4) / 4)
}

const totalHours = computed(() =>
  editEntries.value.reduce((s, e) => s + (Number.isFinite(e.hours) ? e.hours : 0), 0))

const dayWorkMinutes = computed(() => {
  // API モードの daySummary はサーバー集計キャッシュ（未ロード時 0 → 到着後に追従）
  try {
    return attendance.daySummary(currentUser.value.id, selDate.value).workMinutes
  } catch {
    return 0
  }
})

const editorGap = computed(() => {
  if (dayWorkMinutes.value <= 0) return null
  const gap = Math.round(totalHours.value * 60) - dayWorkMinutes.value
  return Math.abs(gap) > 60 ? gap : null
})

const submittedGap = computed(() => {
  const r = myReport.value
  return r && r.status === 'submitted' ? reports.gapOf(r) : null
})

const mineStatus = computed(() => {
  const r = myReport.value
  if (!r) return { tone: 'neutral' as const, label: '未作成' }
  return r.status === 'submitted'
    ? { tone: 'ok' as const, label: REPORT_STATUS_LABELS.submitted }
    : { tone: 'warn' as const, label: REPORT_STATUS_LABELS.draft }
})

function payload() {
  return {
    date: selDate.value,
    entries: editEntries.value.map(e => ({ ...e })),
    reflection: editReflection.value,
    issues: editIssues.value,
    tomorrow: editTomorrow.value,
    tomorrowPlans: editPlans.value.map(p => ({ ...p })),
  }
}

async function onSaveDraft(): Promise<void> {
  await run('mine-draft', async () => {
    const res = await reports.saveDraft(payload())
    show(res.ok ? '下書きを保存しました' : res.error.message, res.ok ? 'ok' : 'warn')
  }, { message: '下書きを保存しています…' })
}

async function onSubmit(): Promise<void> {
  await run('mine-submit', async () => {
    const res = await reports.submit(payload())
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    mineEditing.value = false
    confirmStep.value = false
    show('日報を提出しました')
    if (res.escalated) {
      show('課題が管理者へ共有されました', 'info', { label: '受信箱', to: '/inbox' })
    }
    if (res.hoursGapMinutes !== null) {
      show(`勤怠実労働と時間合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
    }
  }, { message: '日報を提出しています…' })
}

// ---------- AI アシスト入力（F-06-7。材料の入力は AI業務アシスタント F-14 へ移設） ----------

const assist = useReportAssist()
const tp = useTaskPlans()
const inputMode = assist.inputMode

/** 入力方式が 'both' のときの切替（既定は通常フォーム。AI アシストは補助機能 = オペレーター指示 2026-07-19 #4） */
const entryMethod = ref<'form' | 'assist'>('form')
const assistActive = computed(() =>
  inputMode.value === 'assist' || (inputMode.value === 'both' && entryMethod.value === 'assist'))

/** この日の自分の日報（提出済みのときのみ）。提出済み保護（ドラフト再生成不可）の唯一の判定元 */
const submittedForDate = computed(() =>
  myReport.value?.status === 'submitted' ? myReport.value : undefined)
const isSubmittedDay = computed(() => !!submittedForDate.value)

/** AI アシスト時、編集フォームはドラフトの確認・修正ステップとしてのみ表示する */
const confirmStep = ref(false)
/** 直近生成した AI ドラフトの根拠（null = AI 生成のドラフトではない） */
const draftBasis = ref<string[] | null>(null)
const editorWrap = ref<HTMLElement | null>(null)
const showEditor = computed(() => !assistActive.value || confirmStep.value)

watch([selDate, currentUserId], () => {
  confirmStep.value = false
  draftBasis.value = null
})

// -- 材料サマリ（入力は AI業務アシスタントで行う） --

const dayPlanStats = computed(() => {
  const plans = tp.plansOf(currentUserId.value, selDate.value)
  return { total: plans.length, done: plans.filter(p => p.status === 'done').length }
})
// 独立メニュー（/poipoi = notes）のメモも材料へ合流するため件数へ含める（バッチ7c レビュー指摘）
const poipoiNotes = useNotes('poipoi')
const dayMemoCount = computed(() =>
  assist.logsOf(currentUserId.value, selDate.value).filter(l => l.kind === 'memo').length
  + poipoiNotes.list.value.filter(n => n.memberId === currentUserId.value && n.createdAt.slice(0, 10) === selDate.value).length)
const dayAnswerStats = computed(() => {
  const qs = assist.questionsFor(currentUserId.value, selDate.value)
  return { total: qs.length, answered: qs.filter(q => q.answered).length }
})

// -- ドラフト生成 → 確認・修正ステップ --

function scrollToEditor(): void {
  void nextTick(() => editorWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

async function onGenerateDraft(): Promise<void> {
  if (submittedForDate.value) return // 提出済みの日報は上書きしない
  if (confirmStep.value) {
    // 確認・修正中の手直しを黙って捨てない
    const okAsk = await ask('ドラフトの再生成', '生成し直すと、確認・修正中の内容を新しいドラフトで置き換えます。よろしいですか？', { confirmLabel: '再生成' })
    if (!okAsk) return
  }
  await run('gen-draft', async () => {
    const d = await assist.generateDraft(currentUserId.value, selDate.value)
    editEntries.value = d.entries.map(toEditable)
    editReflection.value = d.reflection
    editIssues.value = d.issues
    editTomorrow.value = d.tomorrow
    draftBasis.value = d.basis
    reflected.value = null
    confirmStep.value = true
    mineEditing.value = true
    show('AI ドラフトを生成しました。内容を確認・修正して提出してください')
    scrollToEditor()
  }, { message: 'AI が日報ドラフトを生成しています…' })
}

/** 保存済みの下書きを（AI 生成なしで）確認・修正ステップで開く */
function openSavedDraft(): void {
  draftBasis.value = null
  confirmStep.value = true
  mineEditing.value = true
  scrollToEditor()
}

// ---------- チームタブ（バッチ7h で全員へ公開。リマインド・下書き表示は管理者のみ） ----------

/** 表示モード（週 / 月）と月ビューの形式（横スクロール / カレンダー） */
const teamView = ref<'week' | 'month'>('week')
const teamMonthView = ref<'scroll' | 'calendar'>('scroll')
const teamMonth = ref(todayJst().slice(0, 7))
const teamMonthDays = computed(() => daysOfMonth(teamMonth.value))
/** 月カレンダービューで選択中の日（日別の提出状況を下に表示） */
const teamSelDate = ref(todayJst())

function moveTeamMonth(delta: number): void {
  teamMonth.value = shiftMonth(teamMonth.value, delta)
}

// API モード: 月ビューの対象月レンジを遅延ロードする。週ビューはタイムラインカードの
// timelineForDates が対象週をロードするが、月ビューはタイムライン非表示のため明示的にタッチする
watchEffect(() => {
  if (tab.value === 'team' && teamView.value === 'month') {
    reports.touchTeamDates(teamMonthDays.value)
  }
})
const isTeamThisMonth = computed(() => teamMonth.value === todayJst().slice(0, 7))
// 月を移動したら選択日をその月へ合わせる（当月なら今日）
watch(teamMonth, (ym) => {
  if (teamSelDate.value.slice(0, 7) !== ym) {
    teamSelDate.value = ym === todayJst().slice(0, 7) ? todayJst() : `${ym}-01`
  }
})

// 参照する週を選択できる（オペレーター指示 2026-07-21 #2）。既定 = 今週（月曜始まり）。
// マトリクスはその週の営業日（月〜金）、タイムラインは同じ日付群を対象にする
const teamWeekStart = ref(reports.weekStartOf(todayJst()))
const matrixDays = computed(() => reports.businessDaysOfWeek(teamWeekStart.value))

function moveTeamWeek(delta: number): void {
  teamWeekStart.value = addDays(teamWeekStart.value, delta * 7)
}
const isTeamThisWeek = computed(() => teamWeekStart.value === reports.weekStartOf(todayJst()))

// 部署・メンバー絞り込み（チームタブ）
const teamDeptId = ref('')
const teamMemberId = ref('')

/** マトリクス・タイムラインの表示メンバー（表示メンバー設定 ∩ 参照権限 ∩ 絞り込み） */
const visibleTeamMembers = computed(() =>
  reports.teamMembers.value.filter(m => matchesMemberFilter(m.id, teamDeptId.value, teamMemberId.value)))

const teamTimeline = computed(() => {
  const dates = teamView.value === 'month' ? teamMonthDays.value : matrixDays.value
  // AI 社員（memberId=null）は matchesMemberFilter が「絞り込み未指定のときのみ表示」を判定する
  return reports.timelineForDates(dates)
    .filter(r => matchesMemberFilter(r.memberId, teamDeptId.value, teamMemberId.value))
})

/**
 * セルの表示状態。他人の下書きの存在は管理者以外に見せない（内容も API が返さない）
 */
function displayCellStatus(memberId: string, date: string): 'submitted' | 'draft' | 'none' {
  const s = reports.cellStatus(memberId, date)
  if (s === 'draft' && !isAdmin.value && memberId !== currentUserId.value) return 'none'
  return s
}

/** 月カレンダービュー: その日の提出数（表示メンバー基準） */
function submittedCountOf(date: string): number {
  return visibleTeamMembers.value.filter(m => displayCellStatus(m.id, date) === 'submitted').length
}

/** 月カレンダービューの日別詳細のバッジ表示（'none' を含むためラベル・トーンをここで解決） */
function cellStatusLabel(memberId: string, date: string): string {
  const s = displayCellStatus(memberId, date)
  return s === 'none' ? '未提出' : REPORT_STATUS_LABELS[s]
}
function cellStatusTone(memberId: string, date: string): Tone {
  const s = displayCellStatus(memberId, date)
  return s === 'submitted' ? 'ok' : s === 'draft' ? 'warn' : 'neutral'
}

/** チーム月カレンダーの週分割（日曜始まり） */
const teamCalendarWeeks = computed(() => {
  const cells: (string | null)[] = []
  const first = teamMonthDays.value[0]
  if (first) for (let i = 0; i < weekdayOf(first); i++) cells.push(null)
  cells.push(...teamMonthDays.value)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (string | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
})

// ---------- チームタブの表示メンバー設定（管理者。configs 'teamVisibleMemberIds'） ----------

const { getConfig, setConfig } = useAppSettings()
const teamSettingsOpen = ref(false)
const teamSettingsDraft = ref<string[]>([])
const teamSettingsSaving = ref(false)

// 候補 = 在籍中の全メンバー（バッチ7k）。雇用区分バッジで取締役・外注を判別できるようにする
const teamCandidateOptions = computed(() =>
  reports.teamMemberCandidates.value.map(m => ({
    value: m.id,
    label: m.name,
    tag: EMPLOYMENT_TYPE_LABELS[m.employmentType] ?? m.employmentType,
    tagTone: EMPLOYMENT_TYPE_TONES[m.employmentType] ?? 'neutral',
  })))

// 保存済み設定から除外した候補外 id（退職者等）の数。0 超のときモーダルに案内を出す（PR #61 R2 N2-1）
const teamSettingsDroppedCount = ref(0)

function openTeamSettings(): void {
  // 解釈は utils/team-visibility.ts と共通（未設定・不正 = null = 既定表示 → 空ドラフト）。
  // 候補外の id（退職者等 = 名前解決できず設定の影響外）はドラフトから除いて生 id チップを出さない
  const candidateIds = new Set(reports.teamMemberCandidates.value.map(m => m.id))
  const stored = [...(parseTeamVisibleIds(getConfig('teamVisibleMemberIds', '')) ?? [])]
  teamSettingsDraft.value = stored.filter(id => candidateIds.has(id))
  teamSettingsDroppedCount.value = stored.length - teamSettingsDraft.value.length
  teamSettingsOpen.value = true
}

/** 保存（空選択 = 既定の表示に戻す。取消フロー = いつでも再設定・既定に戻すが可能） */
async function saveTeamSettings(reset = false): Promise<void> {
  teamSettingsSaving.value = true
  try {
    const value = reset || teamSettingsDraft.value.length === 0 ? '' : JSON.stringify(teamSettingsDraft.value)
    await setConfig('teamVisibleMemberIds', value)
    teamSettingsOpen.value = false
    show(value ? '表示メンバーを保存しました' : '既定の表示に戻しました')
  } finally {
    teamSettingsSaving.value = false
  }
}

const drawerReportId = ref<string | null>(null)
const drawerReport = computed(() =>
  drawerReportId.value ? reports.reportById(drawerReportId.value) ?? null : null)
const drawerAuthor = computed(() =>
  drawerReport.value ? reports.authorOf(drawerReport.value) : null)
// 工数乖離は勤怠データが必要。他人の勤怠は HR/管理者のみ参照可のため、
// 権限がない閲覧者（全員の日報タブの一般メンバー）は計算しない（403 リクエストを発生させない）
const drawerGap = computed(() => {
  const r = drawerReport.value
  if (!r) return null
  if (r.memberId !== currentUserId.value && !isHrOrAdmin.value) return null
  return reports.gapOf(r)
})

function cellClass(memberId: string, date: string): string {
  const s = displayCellStatus(memberId, date)
  if (s === 'submitted') return 'bg-ok-soft text-ok hover:brightness-95'
  if (s === 'draft') return 'bg-warn-soft text-warn hover:brightness-95'
  return 'bg-surface-soft text-muted hover:bg-brand-soft hover:text-brand'
}

function cellAria(memberId: string, date: string): string {
  const s = displayCellStatus(memberId, date)
  const name = reports.memberName(memberId)
  // 未来日はリマインド不可（openCell のガードと整合。未来日に「クリックでリマインド」と読み上げない）
  const remindable = isAdmin.value && date <= todayJst()
  const label = s === 'none'
    ? (remindable ? '未提出（クリックでリマインド）' : '未提出')
    : REPORT_STATUS_LABELS[s]
  return `${name} ${dayLabel(date)}: ${label}`
}

function openCell(memberId: string, date: string): void {
  const r = reports.reportOn(memberId, date)
  // 他人の下書きは管理者のみ開ける（一般メンバーには存在も見せない = displayCellStatus と対）
  const canOpen = !!r && (r.status === 'submitted' || isAdmin.value || memberId === currentUserId.value)
  if (r && canOpen) {
    drawerReportId.value = r.id
    return
  }
  if (isAdmin.value) {
    // 未来日（未来週の営業日）は提出不能のためリマインド対象にしない
    if (date > todayJst()) {
      show('未来の日付にはリマインドできません', 'info')
      return
    }
    void askRemind(memberId, date)
    return
  }
  show(`${reports.memberName(memberId)} さんの ${fmtDateLong(date)} の日報はまだ提出されていません`, 'info')
}

async function askRemind(memberId: string, date: string): Promise<void> {
  const name = reports.memberName(memberId)
  const ok = await ask('リマインド送信', `${name} さんへ ${fmtDateLong(date)} の日報リマインドを送信しますか？`, { confirmLabel: '送信' })
  if (!ok) return
  await run(`remind:${memberId}:${date}`, async () => {
    const res = await reports.remind(memberId, date)
    show(res.ok ? `${name} さんへリマインドを送信しました` : res.error.message, res.ok ? 'ok' : 'warn')
  }, { message: 'リマインドを送信しています…' })
}

async function remindAll(): Promise<void> {
  // 対象日 = 選択中ビューの日付群のうち本日以前で最新の日（未来週・未来日を催促しない）
  const today = todayJst()
  const baseDays = teamView.value === 'month' ? teamMonthDays.value : matrixDays.value
  const past = baseDays.filter(d => d <= today)
  const date = past[past.length - 1]
  if (!date) {
    show('この期間はまだ到来していないため、リマインド対象がありません', 'info')
    return
  }
  const targets = visibleTeamMembers.value.filter(m =>
    reports.cellStatus(m.id, date) !== 'submitted' && m.id !== currentUserId.value)
  if (targets.length === 0) {
    show('全員提出済みです')
    return
  }
  const ok = await ask('一括リマインド', `${fmtDateLong(date)} が未提出の ${targets.length} 名へリマインドを送信しますか？`, { confirmLabel: '送信' })
  if (!ok) return
  await run('remind-all', async () => {
    // 一部失敗しても送れた分は成立させる（原則4: グレースフルデグラデーション）
    let sent = 0
    for (const m of targets) {
      const res = await reports.remind(m.id, date)
      if (res.ok) sent += 1
    }
    if (sent === targets.length) {
      show(`${targets.length} 名へリマインドを送信しました`)
    } else {
      show(`${sent} / ${targets.length} 名へ送信しました（一部失敗）`, 'warn')
    }
  }, { message: 'リマインドを送信しています…' })
}

// ---------- 全員の日報タブ（バッチ5e: 提出済みの月次一覧を全メンバーが参照可） ----------

const allMonth = ref(todayJst().slice(0, 7))
const allDeptId = ref('')
const allMemberId = ref('')
// AI 社員（memberId=null）は matchesMemberFilter が「絞り込み未指定のときのみ表示」を判定する
const allReports = computed(() =>
  reports.allSubmitted(allMonth.value)
    .filter(r => matchesMemberFilter(r.memberId, allDeptId.value, allMemberId.value)))

const ALL_COLUMNS: TableColumn[] = [
  { key: 'dateLabel', label: '日付', primary: true, width: '110px' },
  { key: 'author', label: '名前', primary: true, width: '160px' },
  { key: 'summary', label: 'サマリー', primary: true },
  { key: 'hours', label: '時間', align: 'right', width: '70px' },
]

/** 一覧のサマリー: 先頭エントリのテーマ + 内容（複数行は件数を添える） */
function summaryOf(r: DailyReport): string {
  const first = r.entries[0]
  if (!first) return '—'
  const head = [entryTheme(first), first.task].filter(Boolean).join(': ')
  return r.entries.length > 1 ? `${head}（他 ${r.entries.length - 1} 件）` : (head || '—')
}

const allRows = computed(() =>
  allReports.value.map(r => ({
    id: r.id,
    dateLabel: dayLabel(r.date),
    author: reports.authorOf(r).name,
    summary: summaryOf(r),
    hours: `${totalHoursOf(r)}h`,
    issues: r.issues,
  })) as unknown as Record<string, unknown>[])

function openAllRow(row: Record<string, unknown>): void {
  drawerReportId.value = String(row.id)
}

// ---------- 自分の週報タブ ----------

// 参照する週を選択できる（オペレーター指示 2026-07-21 #2）。既定 = 今週（月曜始まり）
const selWeekStart = ref(reports.weekStartOf(todayJst()))
const selWeekly = computed(() => reports.myWeeklyOn(selWeekStart.value))
const isThisWeek = computed(() => selWeekStart.value === reports.weekStartOf(todayJst()))

function moveWeeklyWeek(delta: number): void {
  selWeekStart.value = addDays(selWeekStart.value, delta * 7)
}

const wkGoal = ref('')
const wkMain = ref('')
const wkIssues = ref('')
const wkNext = ref('')

function loadWeeklyEditor(): void {
  const r = selWeekly.value
  if (r && r.status === 'draft') {
    wkGoal.value = r.goalReview
    wkMain.value = r.mainWork
    wkIssues.value = r.issues
    wkNext.value = r.nextWeek
  } else {
    // 下書き以外（未作成・提出済み）は全クリア。週送りで別週へ入力内容が残留し、
    // 誤った週へ提出される事故を防ぐ（提出済みはエディタ非表示だが残留も断つ）
    wkGoal.value = ''
    wkMain.value = ''
    wkIssues.value = ''
    wkNext.value = ''
  }
}
// selWeekStart も監視: 未作成週→未作成週の移動では selWeekly が undefined→undefined で
// 参照変化せず watcher が発火しないため、週初め自体を復元トリガに含める（入力残留の防止）。
// selWeekly も監視: API モードでは週報データが非同期に届くため到着後に下書きを復元する
watch([currentUserId, selWeekStart, selWeekly], loadWeeklyEditor, { immediate: true })

function weekLabel(weekStart: string): string {
  return `${fmtDate(weekStart)}〜${fmtDate(addDays(weekStart, 6))}`
}

async function generateFromDailies(): Promise<void> {
  await run('wk-generate', async () => {
    const d = await reports.draftFromDailies(selWeekStart.value)
    if (!d.mainWork && !d.issues) {
      show('この週の日報がまだありません', 'warn')
      return
    }
    if (d.mainWork) wkMain.value = d.mainWork
    if (d.issues) wkIssues.value = d.issues
    show('日報から下書きを生成しました')
  }, { message: '日報から下書きを生成しています…' })
}

async function onSaveWeekly(submitNow: boolean): Promise<void> {
  await run(submitNow ? 'wk-submit' : 'wk-draft', async () => {
    const res = await reports.saveWeekly({
      weekStart: selWeekStart.value,
      goalReview: wkGoal.value,
      mainWork: wkMain.value,
      issues: wkIssues.value,
      nextWeek: wkNext.value,
    }, submitNow)
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    show(submitNow ? '週報を提出しました' : '下書きを保存しました')
  }, { message: submitNow ? '週報を提出しています…' : '下書きを保存しています…' })
}

const weeklyDrawerId = ref<string | null>(null)
const weeklyDrawer = computed<WeeklyReport | null>(() =>
  weeklyDrawerId.value ? reports.weeklyById(weeklyDrawerId.value) ?? null : null)

/** 週報も参照 = 基本ビュー・入力はボタン押下（バッチ7h ④）。提出・週切替・ユーザー切替で参照へ戻す */
const weeklyEditing = ref(false)
watch([currentUserId, selWeekStart], () => { weeklyEditing.value = false })

async function onSaveWeeklyAndClose(submitNow: boolean): Promise<void> {
  await onSaveWeekly(submitNow)
  if (submitNow && reports.myWeeklyOn(selWeekStart.value)?.status === 'submitted') {
    weeklyEditing.value = false
  }
}

// ---------- 全員の週報タブ（オペレーター指示 2026-07-22。参照権限 = 日報・週報の参照対象） ----------

/** サブビュー（一覧 / 週次 AI インサイト = バッチ7g。インサイトは全登録データ横断のため本タブに置く） */
const weeklyAllView = ref('list')
const WEEKLY_ALL_VIEW_TABS = [
  { key: 'list', label: '全員の週報' },
  { key: 'insight', label: 'AI インサイト' },
]

const selAllWeekStart = ref(reports.weekStartOf(todayJst()))
const isAllThisWeek = computed(() => selAllWeekStart.value === reports.weekStartOf(todayJst()))

function moveAllWeeklyWeek(delta: number): void {
  selAllWeekStart.value = addDays(selAllWeekStart.value, delta * 7)
}

const waDeptId = ref('')
const waMemberId = ref('')

const allWeeklies = computed(() =>
  reports.allSubmittedWeeklies(selAllWeekStart.value)
    .filter(r => matchesMemberFilter(r.memberId, waDeptId.value, waMemberId.value)))
</script>

<template>
  <div>
    <UiPageHeader title="日報・週報" description="日々の活動報告と週次のふりかえり。AI 社員の日次報告も同じタイムラインに届きます" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ================= 自分の日報 ================= -->
    <div v-if="tab === 'mine'" class="grid gap-3">
      <!-- 日付ナビ + 表示モード（週 / 月） -->
      <UiFilterBar>
        <div class="grid justify-items-start gap-1.5">
          <div class="flex items-center gap-1.5">
            <template v-if="mineView === 'week'">
              <button type="button" class="btn btn-sm" aria-label="前日へ" @click="selDate = addDays(selDate, -1)">
                <ChevronLeft class="h-4 w-4" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn-sm" @click="selDate = todayJst()">今日</button>
              <button type="button" class="btn btn-sm" aria-label="翌日へ" @click="selDate = addDays(selDate, 1)">
                <ChevronRight class="h-4 w-4" aria-hidden="true" />
              </button>
            </template>
            <template v-else>
              <button type="button" class="btn btn-sm" aria-label="前月へ" @click="selDate = `${shiftMonth(mineMonth, -1)}-01`">
                <ChevronLeft class="h-4 w-4" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn-sm" @click="selDate = todayJst()">今月</button>
              <button type="button" class="btn btn-sm" aria-label="翌月へ" @click="selDate = `${shiftMonth(mineMonth, 1)}-01`">
                <ChevronRight class="h-4 w-4" aria-hidden="true" />
              </button>
            </template>
          </div>
          <input v-model="selDate" type="date" class="input w-auto" aria-label="対象日（直接選択可）">
        </div>
        <div class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1" role="group" aria-label="表示モード">
          <button
            type="button"
            class="btn btn-sm"
            :class="mineView === 'week' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mineView === 'week'"
            @click="mineView = 'week'"
          >
            週
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :class="mineView === 'month' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mineView === 'month'"
            @click="mineView = 'month'"
          >
            月
          </button>
        </div>
        <div
          v-if="mineView === 'month'"
          class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1"
          role="group"
          aria-label="月ビューの形式"
        >
          <button
            type="button"
            class="btn btn-sm"
            :class="mineMonthView === 'scroll' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mineMonthView === 'scroll'"
            @click="mineMonthView = 'scroll'"
          >
            横スクロール
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :class="mineMonthView === 'calendar' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mineMonthView === 'calendar'"
            @click="mineMonthView = 'calendar'"
          >
            カレンダー
          </button>
        </div>
        <template #trailing>
          <UiStatusBadge :tone="mineStatus.tone" :label="mineStatus.label" dot />
        </template>
      </UiFilterBar>

      <!-- 週ビュー: 選択日を含む週（月〜日）の提出状況ストリップ -->
      <UiSectionCard v-if="mineView === 'week'" :title="`週の提出状況（${weekLabel(reports.weekStartOf(selDate))}）`">
        <div class="grid grid-cols-7 gap-1">
          <button
            v-for="d in mineWeekDays"
            :key="d"
            type="button"
            class="grid min-h-[52px] place-items-center rounded-md py-1 text-[11px] font-semibold transition-colors"
            :class="myDayCellClass(d)"
            :aria-label="myDayAria(d)"
            :aria-pressed="d === selDate"
            @click="selDate = d"
          >
            <span :class="weekdayOf(d) === 0 ? 'text-serious' : ''">{{ WEEKDAYS[weekdayOf(d)] }}</span>
            <span class="num text-[13px] font-bold">{{ Number(d.slice(8, 10)) }}</span>
            <Check v-if="myStatusOf(d) === 'submitted'" class="h-3.5 w-3.5" aria-hidden="true" />
            <span v-else-if="myStatusOf(d) === 'draft'">下書き</span>
            <span v-else class="text-muted">—</span>
          </button>
        </div>
      </UiSectionCard>

      <!-- 月ビュー（横スクロール）: 1日〜末日を横一列で表示 -->
      <UiSectionCard v-else-if="mineMonthView === 'scroll'" :title="`月の提出状況（${Number(mineMonth.slice(0, 4))}年${Number(mineMonth.slice(5, 7))}月）`">
        <div class="overflow-x-auto scroll-slim">
          <div class="flex w-max gap-1 pb-1">
            <button
              v-for="d in mineMonthDays"
              :key="d"
              type="button"
              class="grid min-h-[52px] w-12 shrink-0 place-items-center rounded-md py-1 text-[11px] font-semibold transition-colors"
              :class="myDayCellClass(d)"
              :aria-label="myDayAria(d)"
              :aria-pressed="d === selDate"
              @click="selDate = d"
            >
              <span :class="weekdayOf(d) === 0 ? 'text-serious' : ''">{{ WEEKDAYS[weekdayOf(d)] }}</span>
              <span class="num text-[13px] font-bold">{{ Number(d.slice(8, 10)) }}</span>
              <Check v-if="myStatusOf(d) === 'submitted'" class="h-3.5 w-3.5" aria-hidden="true" />
              <span v-else-if="myStatusOf(d) === 'draft'">下書き</span>
              <span v-else class="text-muted">—</span>
            </button>
          </div>
        </div>
      </UiSectionCard>

      <!-- 月ビュー（カレンダー形式） -->
      <UiSectionCard v-else :title="`月の提出状況（${Number(mineMonth.slice(0, 4))}年${Number(mineMonth.slice(5, 7))}月）`">
        <div class="grid grid-cols-7 gap-1">
          <span v-for="w in WEEKDAYS" :key="w" class="text-center text-[10px] font-bold text-muted">{{ w }}</span>
          <template v-for="(week, wi) in mineCalendarWeeks" :key="wi">
            <template v-for="(d, di) in week" :key="`${wi}-${di}`">
              <button
                v-if="d"
                type="button"
                class="grid min-h-[48px] place-items-center rounded-md py-1 text-[11px] font-semibold transition-colors"
                :class="myDayCellClass(d)"
                :aria-label="myDayAria(d)"
                :aria-pressed="d === selDate"
                @click="selDate = d"
              >
                <span class="num text-[13px] font-bold">{{ Number(d.slice(8, 10)) }}</span>
                <Check v-if="myStatusOf(d) === 'submitted'" class="h-3.5 w-3.5" aria-hidden="true" />
                <span v-else-if="myStatusOf(d) === 'draft'">下書き</span>
                <span v-else class="text-muted">—</span>
              </button>
              <span v-else aria-hidden="true" />
            </template>
          </template>
        </div>
      </UiSectionCard>

      <!-- 未提出日の参照ビュー（バッチ7h ④: 参照が基本。入力は「日報を書く」から） -->
      <UiSectionCard
        v-if="!isSubmittedDay && !mineEditing && !editingSubmitted"
        :title="`${fmtDateLong(selDate)} の日報`"
        :description="myReport ? '下書きが保存されています。「日報を書く」から続きを編集できます' : 'まだ作成されていません'"
      >
        <template #actions>
          <button type="button" class="btn btn-primary btn-sm" @click="mineEditing = true">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            日報を書く
          </button>
        </template>
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :tone="mineStatus.tone" :label="mineStatus.label" dot />
          <span v-if="myReport" class="num text-xs text-sub">
            {{ myReport.entries.length }} エントリ / 合計 {{ totalHoursOf(myReport) }}h
          </span>
          <span v-else class="text-xs text-muted">「日報を書く」から入力を始められます（AI アシストは入力画面から）</span>
        </div>
      </UiSectionCard>

      <!-- 入力方式の切替（設定が 'both' かつ入力中のとき） -->
      <div
        v-if="inputMode === 'both' && mineEditing && !isSubmittedDay"
        class="inline-flex items-center gap-1 justify-self-start rounded-lg border border-line bg-surface p-1"
        role="group"
        aria-label="日報の入力方式"
      >
        <button
          type="button"
          class="btn btn-sm"
          :class="entryMethod === 'form' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="entryMethod === 'form'"
          @click="entryMethod = 'form'"
        >
          通常入力
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="entryMethod === 'assist' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="entryMethod === 'assist'"
          @click="entryMethod = 'assist'"
        >
          <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
          AI アシスト
        </button>
      </div>

      <!-- 提出済み: 読み取り表示 + コメントスレッド（本人は編集可 = 提出状態のまま更新） -->
      <UiSectionCard v-if="myReport && myReport.status === 'submitted' && !editingSubmitted" :title="`${fmtDateLong(selDate)} の日報`">
        <template #actions>
          <button type="button" class="btn btn-sm" @click="startEditSubmitted">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            編集
          </button>
        </template>
        <div class="grid gap-4">
          <div class="flex flex-wrap items-center gap-2">
            <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot />
            <span v-if="myReport.submittedAt" class="num text-[11px] text-muted">提出 {{ fmtTime(myReport.submittedAt) }}</span>
            <UiStatusBadge v-if="submittedGap !== null" tone="warn" :label="`時間乖離 ${gapText(submittedGap)}`" />
            <UiStatusBadge v-if="myReport.issues" tone="warn" label="課題あり" />
          </div>
          <div class="overflow-x-auto scroll-slim">
            <table class="tbl">
              <thead>
                <tr><th>テーマ</th><th>内容</th><th class="!text-right">時間</th><th class="!text-right">進捗</th></tr>
              </thead>
              <tbody>
                <tr v-for="(e, i) in myReport.entries" :key="i">
                  <td class="whitespace-nowrap">{{ entryTheme(e) || '—' }}</td>
                  <td>{{ e.task }}</td>
                  <td class="num text-right">{{ e.hours }}h</td>
                  <td class="num text-right">{{ e.progress }}%</td>
                </tr>
                <tr>
                  <td colspan="2" class="text-right text-[11px] font-semibold text-muted">合計</td>
                  <td class="num text-right font-bold">{{ totalHoursOf(myReport) }}h</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <div>
              <p class="label">所感</p>
              <UiMarkdown v-if="myReport.reflection" :source="myReport.reflection" />
              <p v-else class="text-[13px]">—</p>
            </div>
            <div :class="myReport.issues ? 'rounded-lg bg-warn-soft p-2.5' : ''">
              <p class="label" :class="myReport.issues ? '!text-warn' : ''">課題{{ myReport.issues ? '（管理者へ共有済み）' : '' }}</p>
              <UiMarkdown v-if="myReport.issues" :source="myReport.issues" />
              <p v-else class="text-[13px]">—</p>
            </div>
          </div>
          <div>
            <p class="label">明日の予定</p>
            <div v-if="(myReport.tomorrowPlans?.length ?? 0) > 0" class="overflow-x-auto scroll-slim">
              <table class="tbl">
                <thead>
                  <tr><th>テーマ</th><th>目的</th><th>内容</th><th class="!text-right">時間</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in myReport.tomorrowPlans" :key="i">
                    <td class="whitespace-nowrap">{{ p.theme || '—' }}</td>
                    <td>{{ p.purpose || '—' }}</td>
                    <td>{{ p.task || '—' }}</td>
                    <td class="num text-right">{{ p.hours }}h</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <UiMarkdown v-else-if="myReport.tomorrow" :source="myReport.tomorrow" />
            <p v-else class="text-[13px]">—</p>
          </div>
          <WidgetsCommentThread :report-id="myReport.id" />
        </div>
      </UiSectionCard>

      <!-- ================= AI アシスト入力（F-06-7/8。入力中のみ表示 = バッチ7h ④） ================= -->
      <template v-if="assistActive && mineEditing && !isSubmittedDay">
        <!-- 材料サマリ（計画・メモ・回答の入力は AI業務アシスタント F-14 で行う） -->
        <UiSectionCard
          title="AI アシストの材料"
          description="タスク計画の結果・ぽいぽいポスト・ヒアリング回答を材料に AI が下書きを作ります。材料の入力は AI業務アシスタントで"
        >
          <template #actions>
            <NuxtLink to="/ai-assistant" class="btn btn-sm btn-primary">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              AI業務アシスタントを開く
            </NuxtLink>
          </template>
          <ul class="grid gap-2 sm:grid-cols-3">
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">タスク計画（結果記録）</p>
              <p class="num mt-0.5 text-[15px] font-bold">
                {{ dayPlanStats.done }}<span class="text-xs text-muted"> / {{ dayPlanStats.total }} 件</span>
              </p>
            </li>
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">ぽいぽいポスト</p>
              <p class="num mt-0.5 text-[15px] font-bold">{{ dayMemoCount }}<span class="text-xs text-muted"> 件</span></p>
            </li>
            <li class="rounded-lg border border-line p-2.5 text-center">
              <p class="text-[11px] font-bold text-muted">ヒアリング回答</p>
              <p class="num mt-0.5 text-[15px] font-bold">
                {{ dayAnswerStats.answered }}<span class="text-xs text-muted"> / {{ dayAnswerStats.total }} 問</span>
              </p>
            </li>
          </ul>
        </UiSectionCard>

        <!-- ドラフト生成 -->
        <UiSectionCard title="日報ドラフト生成" description="スケジュール・回答・ぽいぽいポストを材料に AI が下書きを作ります">
          <div class="grid gap-2">
            <UiButton
              variant="primary"
              size="lg"
              block
              :loading="isRunning('gen-draft')"
              :disabled="!!submittedForDate"
              @click="onGenerateDraft"
            >
              <template #icon><Sparkles class="h-4 w-4" aria-hidden="true" /></template>
              AI で日報ドラフトを生成
            </UiButton>
            <p v-if="submittedForDate" class="text-center text-xs text-muted">
              この日の日報は提出済みです（提出済みの日報は上書きしません）
            </p>
            <p v-else class="text-center text-[11px] text-muted">
              生成後、フォームで内容を確認・修正してから提出します（何度でも生成し直せます）
            </p>
            <button
              v-if="!submittedForDate && myReport && myReport.status === 'draft' && !confirmStep"
              type="button"
              class="btn btn-sm justify-self-center"
              @click="openSavedDraft"
            >
              保存済みの下書きを開いて修正
            </button>
          </div>
        </UiSectionCard>
      </template>

      <!-- エディタ（未提出時 = 「日報を書く」押下後。AI アシスト時はドラフトの確認・修正ステップとしてのみ表示。提出済みは編集モードで表示） -->
      <div v-if="(!isSubmittedDay && mineEditing && showEditor) || editingSubmitted" ref="editorWrap">
      <UiSectionCard
        :title="editingSubmitted ? `${fmtDateLong(selDate)} の日報を編集（提出済み）` : `${fmtDateLong(selDate)} の日報を書く`"
        :description="editingSubmitted ? '提出済みの日報を修正します。保存しても提出状態と提出時刻は変わりません（編集は監査ログに記録されます）' : 'テーマごとに内容と時間（0.25h 刻み）をテーブルの各セルへ記録します'"
      >
        <div class="grid gap-3">
          <!-- AI ドラフトバナー（生成根拠つき） -->
          <div v-if="assistActive && draftBasis" class="rounded-lg bg-brand-soft p-3">
            <p class="flex items-start gap-1.5 text-[13px] font-bold text-brand">
              <Sparkles class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              AI ドラフトです。内容を確認・修正してから提出してください
            </p>
            <template v-if="draftBasis.length > 0">
              <p class="label mt-1.5 !mb-1">生成根拠</p>
              <ul class="grid gap-0.5">
                <li v-for="(b, i) in draftBasis" :key="i" class="flex items-start gap-1 text-xs text-sub">
                  <span aria-hidden="true">・</span>
                  <span>{{ b }}</span>
                </li>
              </ul>
            </template>
          </div>

          <!-- 前営業日の明日の予定を自動反映したバナー -->
          <div v-if="reflected" class="rounded-lg bg-brand-soft p-3">
            <p class="text-[13px] font-bold text-brand">
              {{ fmtDateLong(reflected.fromDate) }} に登録した「明日の予定」を反映しました
            </p>
            <ul class="mt-1 grid gap-0.5">
              <li v-for="(p, i) in reflected.plans" :key="i" class="text-xs text-sub">
                ・{{ p.theme || '—' }}{{ p.purpose ? `（目的: ${p.purpose}）` : '' }}
              </li>
            </ul>
          </div>

          <!-- 通常入力: テーブル形式（共通ヘッダ 1 行 + 各セルへの入力 = オペレーター指示 2026-07-22） -->
          <div class="overflow-x-auto scroll-slim">
            <table class="tbl min-w-[640px]">
              <thead>
                <tr>
                  <th class="w-[26%]">テーマ <span class="text-crit" aria-hidden="true">*</span></th>
                  <th>内容 <span class="text-crit" aria-hidden="true">*</span></th>
                  <th class="w-40 !text-right">時間 (h)</th>
                  <th class="w-24 !text-right">進捗 (%)</th>
                  <th class="w-12"><span class="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(e, i) in editEntries" :key="i">
                  <td class="!py-1.5">
                    <input v-model="e.theme" type="text" maxlength="100" class="input" placeholder="例）○○案件・社内改善" :aria-label="`エントリ${i + 1} テーマ`">
                  </td>
                  <td class="!py-1.5">
                    <input v-model="e.task" type="text" class="input min-w-40" placeholder="実施した作業" :aria-label="`エントリ${i + 1} 内容`">
                  </td>
                  <td class="!py-1.5">
                    <div class="flex items-center justify-end gap-1">
                      <button type="button" class="btn btn-sm" aria-label="時間を 0.25h 減らす" @click="stepHours(i, -0.25)">
                        <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <input v-model.number="e.hours" type="number" min="0" step="0.25" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 時間`">
                      <button type="button" class="btn btn-sm" aria-label="時間を 0.25h 増やす" @click="stepHours(i, 0.25)">
                        <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                  <td class="!py-1.5">
                    <input v-model.number="e.progress" type="number" min="0" max="100" step="5" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 進捗`">
                  </td>
                  <td class="!py-1.5 text-right">
                    <button type="button" class="btn btn-sm text-crit" :aria-label="`エントリ${i + 1} を削除`" @click="removeRow(i)">
                      <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <button type="button" class="btn btn-sm" @click="addRow">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              行を追加
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-lg bg-surface-soft px-3 py-2 text-xs text-sub">
            <span class="num font-semibold">時間合計 {{ totalHours }}h</span>
            <span v-if="dayWorkMinutes > 0" class="num">/ 勤怠実労働 {{ fmtMinutes(dayWorkMinutes) }}</span>
            <span v-else>/ この日の打刻がないため乖離チェック対象外</span>
            <UiStatusBadge v-if="editorGap !== null" tone="warn" :label="`乖離 ${gapText(editorGap)}`" />
          </div>

          <div class="flex items-center justify-end">
            <button type="button" class="btn btn-sm" :aria-pressed="dailyMdPreview" @click="dailyMdPreview = !dailyMdPreview">
              <component :is="dailyMdPreview ? Pencil : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
              {{ dailyMdPreview ? '編集に戻る' : 'プレビュー' }}
            </button>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <UiFormField label="所感" :hint="dailyMdPreview ? '' : 'マークダウン記法に対応'">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editReflection" /></div>
              <textarea v-else v-model="editReflection" class="textarea" placeholder="今日のふりかえり" />
            </UiFormField>
            <UiFormField label="課題" :hint="dailyMdPreview ? '' : '記入して提出すると管理者へ自動共有されます'">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editIssues" /></div>
              <textarea v-else v-model="editIssues" class="textarea" placeholder="困っていること・ブロッカー" />
            </UiFormField>
          </div>

          <!-- 明日の予定（最大 3 件。翌営業日の日報へ自動反映） -->
          <UiFormField label="明日の予定" :hint="`最大 ${TOMORROW_PLANS_MAX} 件。登録すると翌営業日の日報エントリへ自動反映されます`">
            <div v-if="editPlans.length > 0" class="overflow-x-auto scroll-slim">
              <table class="tbl min-w-[640px]">
                <thead>
                  <tr>
                    <th class="w-[22%]">テーマ</th>
                    <th class="w-[26%]">目的</th>
                    <th>内容</th>
                    <th class="w-40 !text-right">時間 (h)</th>
                    <th class="w-12"><span class="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in editPlans" :key="i">
                    <td class="!py-1.5">
                      <input v-model="p.theme" type="text" maxlength="100" class="input" placeholder="例）○○案件" :aria-label="`明日の予定${i + 1} テーマ`">
                    </td>
                    <td class="!py-1.5">
                      <input v-model="p.purpose" type="text" class="input" placeholder="何のために" :aria-label="`明日の予定${i + 1} 目的`">
                    </td>
                    <td class="!py-1.5">
                      <input v-model="p.task" type="text" class="input min-w-36" placeholder="実施する作業" :aria-label="`明日の予定${i + 1} 内容`">
                    </td>
                    <td class="!py-1.5">
                      <div class="flex items-center justify-end gap-1">
                        <button type="button" class="btn btn-sm" aria-label="時間を 0.25h 減らす" @click="stepPlanHours(i, -0.25)">
                          <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <input v-model.number="p.hours" type="number" min="0" step="0.25" class="input num w-20 text-right" :aria-label="`明日の予定${i + 1} 時間`">
                        <button type="button" class="btn btn-sm" aria-label="時間を 0.25h 増やす" @click="stepPlanHours(i, 0.25)">
                          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                    <td class="!py-1.5 text-right">
                      <button type="button" class="btn btn-sm text-crit" :aria-label="`明日の予定${i + 1} を削除`" @click="removePlan(i)">
                        <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                class="btn btn-sm"
                :disabled="editPlans.length >= TOMORROW_PLANS_MAX"
                @click="addPlan"
              >
                <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                予定を追加
              </button>
              <span v-if="editPlans.length >= TOMORROW_PLANS_MAX" class="text-[11px] text-muted">上限 {{ TOMORROW_PLANS_MAX }} 件に達しています</span>
            </div>
            <p v-if="editTomorrow" class="mt-1.5 text-[11px] text-muted">
              旧形式の明日の予定（自由記述）が保存されています: 「{{ editTomorrow }}」（保存時にそのまま保持されます）
            </p>
          </UiFormField>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <template v-if="editingSubmitted">
              <button type="button" class="btn" @click="editingSubmitted = false; loadEditor()">キャンセル</button>
              <UiButton variant="primary" :loading="isRunning('mine-update')" @click="onUpdateSubmitted">
                <template #icon><Send class="h-3.5 w-3.5" aria-hidden="true" /></template>
                更新を保存
              </UiButton>
            </template>
            <template v-else>
              <button type="button" class="btn" @click="mineEditing = false; confirmStep = false">閉じる</button>
              <UiButton :loading="isRunning('mine-draft')" @click="onSaveDraft">下書き保存</UiButton>
              <UiButton variant="primary" :loading="isRunning('mine-submit')" @click="onSubmit">
                <template #icon><Send class="h-3.5 w-3.5" aria-hidden="true" /></template>
                提出
              </UiButton>
            </template>
          </div>
        </div>
      </UiSectionCard>
      </div>
    </div>

    <!-- ================= 全員の日報 ================= -->
    <div v-else-if="tab === 'all'" class="grid gap-3">
      <!-- 月ナビ + 部署・メンバー絞り込み -->
      <UiFilterBar>
        <div class="grid justify-items-start gap-1.5">
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-sm" aria-label="前の月へ" @click="allMonth = shiftMonth(allMonth, -1)">
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-sm" @click="allMonth = todayJst().slice(0, 7)">今月</button>
            <button type="button" class="btn btn-sm" aria-label="次の月へ" @click="allMonth = shiftMonth(allMonth, 1)">
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <input v-model="allMonth" type="month" class="input w-auto" aria-label="対象月（直接選択可）">
        </div>
        <UiSelect v-model="allDeptId" :options="deptOptions" empty-label="すべての部署" aria-label="部署で絞り込み" />
        <UiSelect v-model="allMemberId" :options="memberFilterOptions" empty-label="すべてのメンバー" aria-label="メンバーで絞り込み" />
        <template #trailing>
          <span class="num text-xs text-muted">{{ allReports.length }} 件</span>
        </template>
      </UiFilterBar>

      <UiSectionCard
        title="全員の日報"
        description="全メンバー・AI 社員の提出済み日報（新しい順）。行（モバイルはカード）を押すと詳細が開きます。参照できる範囲は権限設定（日報・週報の参照対象）に従います"
        flush
      >
        <UiDataTable
          :columns="ALL_COLUMNS"
          :rows="allRows"
          clickable
          empty-title="この月の提出済み日報がありません"
          empty-hint="「自分の日報」から提出すると、ここに表示されます（絞り込み条件も確認してください）"
          @row-click="openAllRow"
        >
          <template #cell-summary="{ row }">
            <span class="flex items-center gap-1.5">
              <span class="line-clamp-1">{{ row.summary }}</span>
              <UiStatusBadge v-if="row.issues" tone="warn" label="課題" />
            </span>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ================= チーム（全員。表示メンバー設定 ∩ 日報参照権限 = バッチ7h） ================= -->
    <div v-else-if="tab === 'team'" class="grid gap-3">
      <!-- 週/月ナビ + 表示モード + 絞り込み -->
      <UiFilterBar>
        <div v-if="teamView === 'week'" class="flex items-center gap-1.5">
          <button type="button" class="btn btn-sm" aria-label="前の週へ" @click="moveTeamWeek(-1)">
            <ChevronLeft class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-sm" :disabled="isTeamThisWeek" @click="teamWeekStart = reports.weekStartOf(todayJst())">今週</button>
          <button type="button" class="btn btn-sm" aria-label="次の週へ" @click="moveTeamWeek(1)">
            <ChevronRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekLabel(teamWeekStart) }}</span>
          <UiStatusBadge v-if="isTeamThisWeek" label="今週" tone="brand" />
        </div>
        <div v-else class="flex items-center gap-1.5">
          <button type="button" class="btn btn-sm" aria-label="前の月へ" @click="moveTeamMonth(-1)">
            <ChevronLeft class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-sm" :disabled="isTeamThisMonth" @click="teamMonth = todayJst().slice(0, 7)">今月</button>
          <button type="button" class="btn btn-sm" aria-label="次の月へ" @click="moveTeamMonth(1)">
            <ChevronRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ Number(teamMonth.slice(0, 4)) }}年{{ Number(teamMonth.slice(5, 7)) }}月</span>
          <UiStatusBadge v-if="isTeamThisMonth" label="今月" tone="brand" />
        </div>
        <div class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1" role="group" aria-label="表示モード">
          <button
            type="button"
            class="btn btn-sm"
            :class="teamView === 'week' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="teamView === 'week'"
            @click="teamView = 'week'"
          >
            週
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :class="teamView === 'month' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="teamView === 'month'"
            @click="teamView = 'month'"
          >
            月
          </button>
        </div>
        <div
          v-if="teamView === 'month'"
          class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1"
          role="group"
          aria-label="月ビューの形式"
        >
          <button
            type="button"
            class="btn btn-sm"
            :class="teamMonthView === 'scroll' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="teamMonthView === 'scroll'"
            @click="teamMonthView = 'scroll'"
          >
            横スクロール
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :class="teamMonthView === 'calendar' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="teamMonthView === 'calendar'"
            @click="teamMonthView = 'calendar'"
          >
            カレンダー
          </button>
        </div>
        <UiSelect v-model="teamDeptId" :options="deptOptions" empty-label="すべての部署" aria-label="部署で絞り込み" />
        <UiSelect v-model="teamMemberId" :options="memberFilterOptions" empty-label="すべてのメンバー" aria-label="メンバーで絞り込み" />
      </UiFilterBar>

      <!-- 週ビュー / 月・横スクロールビュー: 提出状況マトリクス -->
      <UiSectionCard
        v-if="teamView === 'week' || teamMonthView === 'scroll'"
        title="提出状況マトリクス"
        :description="(teamView === 'week'
          ? 'メンバー × 選択した週の営業日（月〜金）。'
          : 'メンバー × 選択した月の 1 日〜末日（横スクロールで表示）。')
          + (isAdmin
            ? '本日以前の未提出セルをクリックするとリマインドできます（未来の日付はまだ提出対象外）'
            : '提出済みセルをクリックすると日報を参照できます')"
        flush
      >
        <template #actions>
          <button v-if="isAdmin" type="button" class="btn btn-ghost btn-sm" @click="openTeamSettings">
            <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
            表示メンバー
          </button>
          <UiButton v-if="isAdmin" size="sm" :loading="isRunning('remind-all')" @click="remindAll">
            <template #icon><BellRing class="h-3.5 w-3.5" aria-hidden="true" /></template>
            一括リマインド
          </UiButton>
        </template>
        <div class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr>
                <!-- .tbl th の z-index:1 は詳細度で z-[2] に勝つため !important で上書きする
                     （日付ヘッダー（後続兄弟・同 z）が横スクロール時にメンバー列ヘッダーへ被る不具合の修正） -->
                <th class="sticky left-0 !z-[2] bg-surface-soft">メンバー</th>
                <template v-if="teamView === 'week'">
                  <th v-for="d in matrixDays" :key="d" class="!text-center">{{ dayLabel(d) }}</th>
                </template>
                <template v-else>
                  <th v-for="d in teamMonthDays" :key="d" class="!px-1 !text-center">
                    <span class="block text-[10px]" :class="weekdayOf(d) === 0 ? 'text-serious' : ''">{{ WEEKDAYS[weekdayOf(d)] }}</span>
                    <span class="num">{{ Number(d.slice(8, 10)) }}</span>
                  </th>
                </template>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in visibleTeamMembers" :key="m.id">
                <td class="sticky left-0 z-[1] whitespace-nowrap bg-surface">
                  <span class="flex items-center gap-2">
                    <UiAvatar :name="m.name" size="sm" />
                    <span class="text-[13px] font-semibold">{{ m.name }}</span>
                  </span>
                </td>
                <td v-for="d in (teamView === 'week' ? matrixDays : teamMonthDays)" :key="d" class="!p-1 text-center">
                  <button
                    type="button"
                    class="inline-flex min-h-11 w-full items-center justify-center rounded-md text-[11px] font-semibold transition-colors"
                    :class="[cellClass(m.id, d), teamView === 'week' ? 'min-w-[52px]' : 'min-w-[44px]']"
                    :aria-label="cellAria(m.id, d)"
                    @click="openCell(m.id, d)"
                  >
                    <Check v-if="displayCellStatus(m.id, d) === 'submitted'" class="h-4 w-4" aria-hidden="true" />
                    <template v-else-if="displayCellStatus(m.id, d) === 'draft'">{{ teamView === 'week' ? REPORT_STATUS_LABELS.draft : '書' }}</template>
                    <template v-else>未</template>
                  </button>
                </td>
              </tr>
              <tr v-if="visibleTeamMembers.length === 0">
                <td :colspan="1 + (teamView === 'week' ? matrixDays.length : teamMonthDays.length)" class="py-6 text-center text-[13px] text-muted">
                  絞り込み条件に一致するメンバーがいません
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiSectionCard>

      <!-- 月・カレンダービュー: 日別の提出数 + 選択日の詳細 -->
      <template v-else>
        <UiSectionCard
          title="提出状況カレンダー"
          description="各日の提出数（提出済み / 表示メンバー数）。日をクリックすると下にその日の提出状況を表示します"
        >
          <div class="grid grid-cols-7 gap-1">
            <span v-for="w in WEEKDAYS" :key="w" class="text-center text-[10px] font-bold text-muted">{{ w }}</span>
            <template v-for="(week, wi) in teamCalendarWeeks" :key="wi">
              <template v-for="(d, di) in week" :key="`${wi}-${di}`">
                <button
                  v-if="d"
                  type="button"
                  class="grid min-h-[52px] place-items-center rounded-md py-1 text-[11px] font-semibold transition-colors"
                  :class="[
                    submittedCountOf(d) > 0 ? 'bg-ok-soft text-ok' : 'bg-surface-soft text-muted',
                    d === teamSelDate ? 'ring-2 ring-[var(--c-brand)]' : '',
                  ]"
                  :aria-label="`${fmtDateLong(d)}: 提出 ${submittedCountOf(d)} / ${visibleTeamMembers.length} 名。クリックで詳細を表示`"
                  :aria-pressed="d === teamSelDate"
                  @click="teamSelDate = d"
                >
                  <span class="num text-[13px] font-bold">{{ Number(d.slice(8, 10)) }}</span>
                  <span class="num">{{ submittedCountOf(d) }}/{{ visibleTeamMembers.length }}</span>
                </button>
                <span v-else aria-hidden="true" />
              </template>
            </template>
          </div>
        </UiSectionCard>

        <UiSectionCard :title="`${fmtDateLong(teamSelDate)} の提出状況`" flush>
          <template #actions>
            <button v-if="isAdmin" type="button" class="btn btn-ghost btn-sm" @click="openTeamSettings">
              <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
              表示メンバー
            </button>
          </template>
          <UiEmptyState v-if="visibleTeamMembers.length === 0" title="絞り込み条件に一致するメンバーがいません" />
          <ul v-else class="divide-y divide-line">
            <li v-for="m in visibleTeamMembers" :key="m.id">
              <button
                type="button"
                class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
                :aria-label="cellAria(m.id, teamSelDate)"
                @click="openCell(m.id, teamSelDate)"
              >
                <UiAvatar :name="m.name" size="sm" />
                <span class="min-w-0 flex-1 text-[13px] font-semibold">{{ m.name }}</span>
                <UiStatusBadge
                  :tone="cellStatusTone(m.id, teamSelDate)"
                  :label="cellStatusLabel(m.id, teamSelDate)"
                  dot
                />
              </button>
            </li>
          </ul>
        </UiSectionCard>
      </template>

      <UiSectionCard
        v-if="teamView === 'week'"
        title="タイムライン"
        :description="`チームと AI 社員の日報（${weekLabel(teamWeekStart)}・新しい順）`"
        flush
      >
        <UiEmptyState v-if="teamTimeline.length === 0" title="提出済みの日報がありません" />
        <ul v-else class="divide-y divide-line">
          <li v-for="r in teamTimeline" :key="r.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="drawerReportId = r.id"
            >
              <UiAvatar :name="reports.authorOf(r).name" :kind="reports.authorOf(r).kind" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span class="text-[13px] font-bold">{{ reports.authorOf(r).name }}</span>
                  <UiStatusBadge v-if="r.authorKind === 'ai'" tone="info" label="AI社員" />
                  <span class="num text-[11px] text-muted">{{ fmtDateLong(r.date) }}</span>
                </span>
                <span class="block truncate text-xs text-sub">{{ r.entries[0]?.task ?? '—' }}</span>
              </span>
              <UiStatusBadge v-if="r.issues" tone="warn" label="課題あり" />
              <span class="num shrink-0 text-xs text-sub">{{ totalHoursOf(r) }}h</span>
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- ================= 全員の週報（オペレーター指示 2026-07-22） ================= -->
    <div v-else-if="tab === 'weekly-all'" class="grid gap-3">
      <UiTabBar v-model="weeklyAllView" :tabs="WEEKLY_ALL_VIEW_TABS" />

      <!-- 週次 AI インサイト（該当週の全登録データから経営・営業・チーム視点のレポート = バッチ7g） -->
      <WidgetsWeeklyInsight v-if="weeklyAllView === 'insight'" :initial-week-start="selAllWeekStart" />

      <template v-else>
        <UiFilterBar>
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-sm" aria-label="前の週へ" @click="moveAllWeeklyWeek(-1)">
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-sm" :disabled="isAllThisWeek" @click="selAllWeekStart = reports.weekStartOf(todayJst())">今週</button>
            <button type="button" class="btn btn-sm" aria-label="次の週へ" @click="moveAllWeeklyWeek(1)">
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
            <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekLabel(selAllWeekStart) }}</span>
            <UiStatusBadge v-if="isAllThisWeek" label="今週" tone="brand" />
          </div>
          <UiSelect v-model="waDeptId" :options="deptOptions" empty-label="すべての部署" aria-label="部署で絞り込み" />
          <UiSelect v-model="waMemberId" :options="memberFilterOptions" empty-label="すべてのメンバー" aria-label="メンバーで絞り込み" />
          <template #trailing>
            <span class="num text-xs text-muted">{{ allWeeklies.length }} 件</span>
          </template>
        </UiFilterBar>

        <UiSectionCard
          title="全員の週報"
          description="選択した週の提出済み週報。参照できる範囲は権限設定（日報・週報の参照対象）に従います"
          flush
        >
          <UiEmptyState
            v-if="allWeeklies.length === 0"
            title="この週の提出済み週報がありません"
            hint="「自分の週報」から提出すると、ここに表示されます（絞り込み条件も確認してください）"
          />
          <ul v-else class="divide-y divide-line">
            <li v-for="w in allWeeklies" :key="w.id">
              <button
                type="button"
                class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
                @click="weeklyDrawerId = w.id"
              >
                <UiAvatar :name="reports.memberName(w.memberId)" size="sm" />
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] font-bold">{{ reports.memberName(w.memberId) }}</span>
                  <span class="block truncate text-xs text-sub">{{ w.mainWork || '—' }}</span>
                </span>
                <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot />
              </button>
            </li>
          </ul>
        </UiSectionCard>
      </template>
    </div>

    <!-- ================= 自分の週報 ================= -->
    <div v-else-if="tab === 'weekly-mine'" class="grid gap-3">
      <UiFilterBar>
        <div class="flex items-center gap-1.5">
          <button type="button" class="btn btn-sm" aria-label="前の週へ" @click="moveWeeklyWeek(-1)">
            <ChevronLeft class="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-sm" :disabled="isThisWeek" @click="selWeekStart = reports.weekStartOf(todayJst())">今週</button>
          <button type="button" class="btn btn-sm" aria-label="次の週へ" @click="moveWeeklyWeek(1)">
            <ChevronRight class="h-4 w-4" aria-hidden="true" />
          </button>
          <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekLabel(selWeekStart) }}</span>
          <UiStatusBadge v-if="isThisWeek" label="今週" tone="brand" />
        </div>
        <template #trailing>
          <UiStatusBadge
            :tone="selWeekly?.status === 'submitted' ? 'ok' : selWeekly ? 'warn' : 'neutral'"
            :label="selWeekly ? REPORT_STATUS_LABELS[selWeekly.status] : '未作成'"
            dot
          />
        </template>
      </UiFilterBar>

      <!-- 選択した週の週報（参照 = 基本ビュー・入力は「週報を書く」から = バッチ7h ④） -->
      <UiSectionCard
        :title="`${isThisWeek ? '今週' : '選択週'}の週報（${weekLabel(selWeekStart)}）`"
        :description="selWeekly?.status === 'submitted'
          ? '提出済みです'
          : weeklyEditing ? '日報から下書きを生成できます' : '「週報を書く」から入力できます'"
      >
        <template v-if="selWeekly?.status !== 'submitted'" #actions>
          <button v-if="!weeklyEditing" type="button" class="btn btn-primary btn-sm" @click="weeklyEditing = true">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            週報を書く
          </button>
          <UiButton v-else size="sm" :loading="isRunning('wk-generate')" @click="generateFromDailies">
            <template #icon><Sparkles class="h-3.5 w-3.5" aria-hidden="true" /></template>
            日報から下書き生成
          </UiButton>
        </template>

        <!-- 提出済み: 読み取り表示 -->
        <div v-if="selWeekly && selWeekly.status === 'submitted'" class="grid gap-3">
          <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot class="justify-self-start" />
          <div class="grid gap-3 md:grid-cols-2">
            <div><p class="label">今週の目標達成</p><UiMarkdown v-if="selWeekly.goalReview" :source="selWeekly.goalReview" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">主要業務</p><UiMarkdown v-if="selWeekly.mainWork" :source="selWeekly.mainWork" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">課題</p><UiMarkdown v-if="selWeekly.issues" :source="selWeekly.issues" /><p v-else class="text-[13px]">—</p></div>
            <div><p class="label">来週の予定</p><UiMarkdown v-if="selWeekly.nextWeek" :source="selWeekly.nextWeek" /><p v-else class="text-[13px]">—</p></div>
          </div>
        </div>

        <!-- 参照ビュー（未提出・未編集: 状態表示のみ） -->
        <div v-else-if="!weeklyEditing" class="flex flex-wrap items-center gap-2">
          <UiStatusBadge
            :tone="selWeekly ? 'warn' : 'neutral'"
            :label="selWeekly ? REPORT_STATUS_LABELS.draft : '未作成'"
            dot
          />
          <span class="text-xs text-muted">
            {{ selWeekly ? '下書きが保存されています。「週報を書く」から続きを編集できます' : `${isThisWeek ? '今週' : 'この週'}の週報はまだ作成されていません` }}
          </span>
        </div>

        <!-- エディタ -->
        <div v-else class="grid gap-3">
          <div class="flex items-center justify-end">
            <button type="button" class="btn btn-sm" :aria-pressed="wkMdPreview" @click="wkMdPreview = !wkMdPreview">
              <component :is="wkMdPreview ? Pencil : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
              {{ wkMdPreview ? '編集に戻る' : 'プレビュー' }}
            </button>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <UiFormField label="今週の目標達成" :hint="wkMdPreview ? '' : 'マークダウン記法に対応'">
              <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkGoal" /></div>
              <textarea v-else v-model="wkGoal" class="textarea" placeholder="目標に対するふりかえり" />
            </UiFormField>
            <UiFormField label="主要業務" required>
              <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkMain" /></div>
              <textarea v-else v-model="wkMain" class="textarea" placeholder="今週の主な業務" />
            </UiFormField>
            <UiFormField label="課題">
              <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkIssues" /></div>
              <textarea v-else v-model="wkIssues" class="textarea" placeholder="課題・相談したいこと" />
            </UiFormField>
            <UiFormField label="来週の予定">
              <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkNext" /></div>
              <textarea v-else v-model="wkNext" class="textarea" placeholder="来週やること" />
            </UiFormField>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="btn" @click="weeklyEditing = false">閉じる</button>
            <UiButton :loading="isRunning('wk-draft')" @click="onSaveWeekly(false)">下書き保存</UiButton>
            <UiButton variant="primary" :loading="isRunning('wk-submit')" @click="onSaveWeeklyAndClose(true)">
              <template #icon><Send class="h-3.5 w-3.5" aria-hidden="true" /></template>
              提出
            </UiButton>
          </div>
        </div>
      </UiSectionCard>

      <!-- 過去の週報 -->
      <UiSectionCard title="過去の週報" flush>
        <UiEmptyState v-if="reports.myWeeklies.value.length === 0" title="週報がまだありません" hint="今週の週報を作成すると一覧に表示されます" />
        <ul v-else class="divide-y divide-line">
          <li v-for="w in reports.myWeeklies.value" :key="w.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="weeklyDrawerId = w.id"
            >
              <span class="num flex-1 text-[13px] font-semibold">{{ weekLabel(w.weekStart) }}</span>
              <UiStatusBadge :tone="w.status === 'submitted' ? 'ok' : 'warn'" :label="REPORT_STATUS_LABELS[w.status]" />
            </button>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- 日報詳細ドロワー（チーム / 全員の日報） -->
    <UiDrawer
      :open="!!drawerReport"
      :title="drawerReport && drawerAuthor ? `${drawerAuthor.name} の日報` : '日報'"
      width="560px"
      @close="drawerReportId = null"
    >
      <div v-if="drawerReport && drawerAuthor" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiAvatar :name="drawerAuthor.name" :kind="drawerAuthor.kind" />
          <div class="min-w-0">
            <p class="flex flex-wrap items-center gap-2 text-[13px] font-bold">
              {{ drawerAuthor.name }}
              <UiStatusBadge v-if="drawerReport.authorKind === 'ai'" tone="info" label="AI社員" />
            </p>
            <p class="num text-[11px] text-muted">{{ fmtDateLong(drawerReport.date) }}</p>
          </div>
          <div class="ml-auto flex flex-wrap gap-1.5">
            <UiStatusBadge
              :tone="drawerReport.status === 'submitted' ? 'ok' : 'warn'"
              :label="REPORT_STATUS_LABELS[drawerReport.status]"
              dot
            />
            <UiStatusBadge v-if="drawerGap !== null" tone="warn" :label="`時間乖離 ${gapText(drawerGap)}`" />
          </div>
        </div>

        <div class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr><th>テーマ</th><th>内容</th><th class="!text-right">時間</th><th class="!text-right">進捗</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in drawerReport.entries" :key="i">
                <td class="whitespace-nowrap">{{ entryTheme(e) || '—' }}</td>
                <td>{{ e.task }}</td>
                <td class="num text-right">{{ e.hours }}h</td>
                <td class="num text-right">{{ e.progress }}%</td>
              </tr>
              <tr>
                <td colspan="2" class="text-right text-[11px] font-semibold text-muted">合計</td>
                <td class="num text-right font-bold">{{ totalHoursOf(drawerReport) }}h</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid gap-3">
          <div>
            <p class="label">所感</p>
            <UiMarkdown v-if="drawerReport.reflection" :source="drawerReport.reflection" />
            <p v-else class="text-[13px]">—</p>
          </div>
          <div v-if="drawerReport.issues" class="rounded-lg bg-warn-soft p-2.5">
            <p class="label !text-warn">課題（管理者へ共有済み）</p>
            <UiMarkdown :source="drawerReport.issues" />
          </div>
          <div>
            <p class="label">明日の予定</p>
            <div v-if="(drawerReport.tomorrowPlans?.length ?? 0) > 0" class="overflow-x-auto scroll-slim">
              <table class="tbl">
                <thead>
                  <tr><th>テーマ</th><th>目的</th><th>内容</th><th class="!text-right">時間</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(p, i) in drawerReport.tomorrowPlans" :key="i">
                    <td class="whitespace-nowrap">{{ p.theme || '—' }}</td>
                    <td>{{ p.purpose || '—' }}</td>
                    <td>{{ p.task || '—' }}</td>
                    <td class="num text-right">{{ p.hours }}h</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <UiMarkdown v-else-if="drawerReport.tomorrow" :source="drawerReport.tomorrow" />
            <p v-else class="text-[13px]">—</p>
          </div>
        </div>

        <WidgetsCommentThread :report-id="drawerReport.id" />
      </div>
    </UiDrawer>

    <!-- 週報詳細ドロワー（自分の週報の過去一覧 / 全員の週報） -->
    <UiDrawer
      :open="!!weeklyDrawer"
      :title="weeklyDrawer ? `${weeklyDrawer.memberId === currentUserId ? '' : `${reports.memberName(weeklyDrawer.memberId)} の`}週報 ${weekLabel(weeklyDrawer.weekStart)}` : '週報'"
      @close="weeklyDrawerId = null"
    >
      <div v-if="weeklyDrawer" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <UiAvatar :name="reports.memberName(weeklyDrawer.memberId)" size="sm" />
          <span class="text-[13px] font-bold">{{ reports.memberName(weeklyDrawer.memberId) }}</span>
          <UiStatusBadge
            :tone="weeklyDrawer.status === 'submitted' ? 'ok' : 'warn'"
            :label="REPORT_STATUS_LABELS[weeklyDrawer.status]"
            dot
          />
        </div>
        <div><p class="label">今週の目標達成</p><UiMarkdown v-if="weeklyDrawer.goalReview" :source="weeklyDrawer.goalReview" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">主要業務</p><UiMarkdown v-if="weeklyDrawer.mainWork" :source="weeklyDrawer.mainWork" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">課題</p><UiMarkdown v-if="weeklyDrawer.issues" :source="weeklyDrawer.issues" /><p v-else class="text-[13px]">—</p></div>
        <div><p class="label">来週の予定</p><UiMarkdown v-if="weeklyDrawer.nextWeek" :source="weeklyDrawer.nextWeek" /><p v-else class="text-[13px]">—</p></div>
      </div>
    </UiDrawer>

    <!-- チームタブの表示メンバー設定（管理者。バッチ7h → 7k で候補を在籍全メンバーへ拡大。空選択 = 既定表示 = 取消フロー） -->
    <UiModal :open="teamSettingsOpen" title="チームタブの表示メンバー" width="560px" @close="teamSettingsOpen = false">
      <div class="grid gap-2">
        <p class="text-[12px] text-muted">
          提出状況マトリクス・タイムラインに表示するメンバーを選びます。取締役・外注を含む在籍中の全メンバーから
          選択できます（雇用区分はバッジで表示）。未選択のまま保存すると既定の表示
          （マトリクス = 社員・契約・アルバイト / タイムライン = 全員）に戻ります。
          誰の日報を参照できるかは権限設定（日報・週報の参照対象）でロール・役職・個人ごとに制御できます
        </p>
        <p v-if="teamSettingsDroppedCount > 0" class="text-[12px] text-warn">
          保存済みの設定に在籍していないメンバーが {{ teamSettingsDroppedCount }} 名含まれていたため、選択から除外しています。
          このまま保存すると除外後の内容で確定します（未選択のまま保存 = 既定の表示）
        </p>
        <UiMultiCombobox
          v-model="teamSettingsDraft"
          :options="teamCandidateOptions"
          aria-label="表示メンバーを選択"
          placeholder="メンバー名で検索"
        />
      </div>
      <template #footer>
        <button type="button" class="btn" :disabled="teamSettingsSaving" @click="saveTeamSettings(true)">既定の表示に戻す</button>
        <UiButton variant="primary" :loading="teamSettingsSaving" @click="saveTeamSettings()">保存</UiButton>
      </template>
    </UiModal>
  </div>
</template>
