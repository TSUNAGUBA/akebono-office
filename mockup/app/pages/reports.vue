<script setup lang="ts">
/**
 * 日報・週報（F-06）
 * タブ: 自分の日報 / 全員の日報（提出済みの月次一覧・全メンバー参照可） /
 *       チーム（提出状況マトリクス+タイムライン。バッチ7h で全員へ公開 = 表示メンバー設定 ∩ 日報参照権限。
 *       リマインド・下書き状態の表示は管理者のみ） / 週報
 * 参照 = 基本ビュー・入力 = ボタン押下で表示（バッチ7h・オペレーター指示 2026-07-19 #10 ④）
 */
import {
  BellRing, Check, ChevronLeft, ChevronRight, Eye, Minus, Pencil, Plus, Send, Settings2, Sparkles, Trash2,
} from 'lucide-vue-next'
import type { DailyReport, ReportEntry, WeeklyReport } from '~/types/domain'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { addDays, fmtDate, fmtDateLong, fmtMinutes, fmtTime, weekdayOf } from '~/utils/format'
import { EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPE_TONES } from '~/utils/labels'
import { parseTeamVisibleIds } from '~/utils/team-visibility'
import type { TabItem, TableColumn } from '~/types/ui'

const route = useRoute()
const { currentUser, currentUserId, isAdmin, isHrOrAdmin } = useCurrentUser()
const reports = useReports()
const attendance = useAttendance()
const { show } = useToast()
const { ask } = useConfirm()
const { isRunning, run } = useAsyncAction()
const { tbl } = useMockDb()
const projects = tbl('projects')

/** 'YYYY-MM' に月を加算（全員の日報タブの月送り。日付キー計算は addDays と別で月境界を扱う） */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  const base = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`
}

// ---------- タブ ----------

const TAB_KEYS = ['mine', 'all', 'team', 'weekly'] as const
const tabs = computed<TabItem[]>(() => {
  // チームタブは全員へ公開（バッチ7h。表示範囲は 表示メンバー設定 ∩ 日報参照権限 で制御）
  const t: TabItem[] = [
    { key: 'mine', label: '自分の日報' },
    { key: 'all', label: '全員の日報' },
    { key: 'team', label: 'チーム' },
    { key: 'weekly', label: '週報' },
  ]
  return t
})
const queryTab = typeof route.query.tab === 'string' ? route.query.tab : ''
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
 * エントリの業務テーマ表示（旧データは theme 未設定 → プロジェクト名へフォールバック。原則7）。
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

// ---------- 自分の日報タブ ----------

const selDate = ref(todayJst())
const myReport = computed(() => reports.myReportOn(selDate.value))

const editEntries = ref<ReportEntry[]>([])
// フリー入力欄のマークダウンプレビュー（バッチ7e。入力はプレーンな textarea のまま = 記法をそのまま保存）
const dailyMdPreview = ref(false)
const wkMdPreview = ref(false)
const editReflection = ref('')
const editIssues = ref('')
const editTomorrow = ref('')

function blankEntry(): ReportEntry {
  return { theme: '', projectId: '', task: '', hours: 1, progress: 0 }
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
  } else {
    editEntries.value = [blankEntry()]
    editReflection.value = ''
    editIssues.value = ''
    editTomorrow.value = ''
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
      show(`勤怠実労働と工数合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
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
      show(`勤怠実労働と工数合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
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

// 参照する週を選択できる（オペレーター指示 2026-07-21 #2）。既定 = 今週（月曜始まり）。
// マトリクスはその週の営業日（月〜金）、タイムラインは同じ日付群を対象にする
const teamWeekStart = ref(reports.weekStartOf(todayJst()))
const matrixDays = computed(() => reports.businessDaysOfWeek(teamWeekStart.value))
const teamTimeline = computed(() => reports.timelineForDates(matrixDays.value))

function moveTeamWeek(delta: number): void {
  teamWeekStart.value = addDays(teamWeekStart.value, delta * 7)
}
const isTeamThisWeek = computed(() => teamWeekStart.value === reports.weekStartOf(todayJst()))

/**
 * セルの表示状態。他人の下書きの存在は管理者以外に見せない（内容も API が返さない）
 */
function displayCellStatus(memberId: string, date: string): 'submitted' | 'draft' | 'none' {
  const s = reports.cellStatus(memberId, date)
  if (s === 'draft' && !isAdmin.value && memberId !== currentUserId.value) return 'none'
  return s
}

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
  const label = s === 'none'
    ? (isAdmin.value ? '未提出（クリックでリマインド）' : '未提出')
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
  // 対象日 = 選択週の営業日のうち本日以前で最新の日（未来週・未来日を催促しない）
  const today = todayJst()
  const past = matrixDays.value.filter(d => d <= today)
  const date = past[past.length - 1]
  if (!date) {
    show('この週はまだ到来していないため、リマインド対象がありません', 'info')
    return
  }
  const targets = reports.teamMembers.value.filter(m =>
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
const allReports = computed(() => reports.allSubmitted(allMonth.value))

const ALL_COLUMNS: TableColumn[] = [
  { key: 'dateLabel', label: '日付', primary: true, width: '110px' },
  { key: 'author', label: '名前', primary: true, width: '160px' },
  { key: 'summary', label: 'サマリー', primary: true },
  { key: 'hours', label: '工数', align: 'right', width: '70px' },
]

/** 一覧のサマリー: 先頭エントリの業務テーマ + 作業内容（複数行は件数を添える） */
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

// ---------- 週報タブ ----------

/** 週報タブ内のサブビュー（自分の週報 / 週次 AI インサイト = バッチ7g・オペレーター指示 2026-07-19 #9） */
const weeklyView = ref('mine')
const WEEKLY_VIEW_TABS = [
  { key: 'mine', label: '自分の週報' },
  { key: 'insight', label: 'AI インサイト' },
]

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
  reports.myWeeklies.value.find(r => r.id === weeklyDrawerId.value) ?? null)

/** 週報も参照 = 基本ビュー・入力はボタン押下（バッチ7h ④）。提出・週切替・ユーザー切替で参照へ戻す */
const weeklyEditing = ref(false)
watch([currentUserId, selWeekStart], () => { weeklyEditing.value = false })

async function onSaveWeeklyAndClose(submitNow: boolean): Promise<void> {
  await onSaveWeekly(submitNow)
  if (submitNow && reports.myWeeklyOn(selWeekStart.value)?.status === 'submitted') {
    weeklyEditing.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="日報・週報" description="日々の活動報告と週次のふりかえり。AI 社員の日次報告も同じタイムラインに届きます" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ================= 自分の日報 ================= -->
    <div v-if="tab === 'mine'" class="grid gap-3">
      <!-- 日付ナビ: 上段 = 前日 / 今日 / 翌日、下段 = 選択中の日付（直接選択可） -->
      <UiFilterBar>
        <div class="grid justify-items-start gap-1.5">
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-sm" aria-label="前日へ" @click="selDate = addDays(selDate, -1)">
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-sm" @click="selDate = todayJst()">今日</button>
            <button type="button" class="btn btn-sm" aria-label="翌日へ" @click="selDate = addDays(selDate, 1)">
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <input v-model="selDate" type="date" class="input w-auto" aria-label="対象日（直接選択可）">
        </div>
        <template #trailing>
          <UiStatusBadge :tone="mineStatus.tone" :label="mineStatus.label" dot />
        </template>
      </UiFilterBar>

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
            <UiStatusBadge v-if="submittedGap !== null" tone="warn" :label="`工数乖離 ${gapText(submittedGap)}`" />
            <UiStatusBadge v-if="myReport.issues" tone="warn" label="課題あり" />
          </div>
          <div class="overflow-x-auto scroll-slim">
            <table class="tbl">
              <thead>
                <tr><th>業務テーマ</th><th>作業内容</th><th class="!text-right">工数</th><th class="!text-right">進捗</th></tr>
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
          <div class="grid gap-3 md:grid-cols-3">
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
            <div>
              <p class="label">明日の予定</p>
              <UiMarkdown v-if="myReport.tomorrow" :source="myReport.tomorrow" />
              <p v-else class="text-[13px]">—</p>
            </div>
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
        :description="editingSubmitted ? '提出済みの日報を修正します。保存しても提出状態と提出時刻は変わりません（編集は監査ログに記録されます）' : '業務テーマごとに作業内容と工数（0.25h 刻み）を記録します'"
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

          <!-- PC は「業務テーマ / 作業内容 / 工数 / 進捗」を 1 行に収める（オペレーター指示） -->
          <div v-for="(e, i) in editEntries" :key="i" class="rounded-lg border border-line p-2.5">
            <div class="grid items-end gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto_auto_auto]">
              <UiFormField label="業務テーマ" required>
                <input v-model="e.theme" type="text" maxlength="100" class="input" placeholder="例）○○案件・社内改善・採用" :aria-label="`エントリ${i + 1} 業務テーマ`">
              </UiFormField>
              <UiFormField label="作業内容" required>
                <input v-model="e.task" type="text" class="input" placeholder="実施した作業" :aria-label="`エントリ${i + 1} 作業内容`">
              </UiFormField>
              <UiFormField label="工数 (h)">
                <div class="flex items-center gap-1">
                  <button type="button" class="btn btn-sm" aria-label="工数を 0.25h 減らす" @click="stepHours(i, -0.25)">
                    <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <input v-model.number="e.hours" type="number" min="0" step="0.25" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 工数`">
                  <button type="button" class="btn btn-sm" aria-label="工数を 0.25h 増やす" @click="stepHours(i, 0.25)">
                    <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </UiFormField>
              <UiFormField label="進捗 (%)">
                <input v-model.number="e.progress" type="number" min="0" max="100" step="5" class="input num w-20 text-right" :aria-label="`エントリ${i + 1} 進捗`">
              </UiFormField>
              <button type="button" class="btn btn-sm mb-0.5 justify-self-start text-crit md:justify-self-auto" aria-label="行を削除" @click="removeRow(i)">
                <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                <span class="md:hidden">行を削除</span>
              </button>
            </div>
          </div>

          <div>
            <button type="button" class="btn btn-sm" @click="addRow">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              行を追加
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-lg bg-surface-soft px-3 py-2 text-xs text-sub">
            <span class="num font-semibold">工数合計 {{ totalHours }}h</span>
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
          <div class="grid gap-3 md:grid-cols-3">
            <UiFormField label="所感" :hint="dailyMdPreview ? '' : 'マークダウン記法に対応'">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editReflection" /></div>
              <textarea v-else v-model="editReflection" class="textarea" placeholder="今日のふりかえり" />
            </UiFormField>
            <UiFormField label="課題" :hint="dailyMdPreview ? '' : '記入して提出すると管理者へ自動共有されます'">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editIssues" /></div>
              <textarea v-else v-model="editIssues" class="textarea" placeholder="困っていること・ブロッカー" />
            </UiFormField>
            <UiFormField label="明日の予定">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editTomorrow" /></div>
              <textarea v-else v-model="editTomorrow" class="textarea" placeholder="翌営業日の予定" />
            </UiFormField>
          </div>

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
      <!-- 月ナビ: 「自分の日報」の日付コントロールに合わせ、左右ボタン + 今月 + 月選択（直接選択可） -->
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
        <template #trailing>
          <span class="num text-xs text-muted">{{ allReports.length }} 件</span>
        </template>
      </UiFilterBar>

      <UiSectionCard
        title="全員の日報"
        description="全メンバー・AI 社員の提出済み日報（新しい順）。行（モバイルはカード）を押すと詳細が開きます"
        flush
      >
        <UiDataTable
          :columns="ALL_COLUMNS"
          :rows="allRows"
          clickable
          empty-title="この月の提出済み日報がありません"
          empty-hint="「自分の日報」から提出すると、ここに表示されます"
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
      <!-- 週ナビ: 「自分の日報」の日付コントロールに合わせ、左右ボタン + 今週 + 週レンジ表示（オペレーター指示 2026-07-21 #2） -->
      <UiFilterBar>
        <div class="flex items-center gap-1.5">
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
      </UiFilterBar>

      <UiSectionCard
        title="提出状況マトリクス"
        :description="isAdmin
          ? 'メンバー × 選択した週の営業日（月〜金）。未提出セルをクリックするとリマインドできます'
          : 'メンバー × 選択した週の営業日（月〜金）。提出済みセルをクリックすると日報を参照できます'"
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
                <th v-for="d in matrixDays" :key="d" class="!text-center">{{ dayLabel(d) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in reports.teamMembers.value" :key="m.id">
                <td class="sticky left-0 z-[1] whitespace-nowrap bg-surface">
                  <span class="flex items-center gap-2">
                    <UiAvatar :name="m.name" size="sm" />
                    <span class="text-[13px] font-semibold">{{ m.name }}</span>
                  </span>
                </td>
                <td v-for="d in matrixDays" :key="d" class="!p-1 text-center">
                  <button
                    type="button"
                    class="inline-flex h-8 w-full min-w-[52px] items-center justify-center rounded-md text-[11px] font-semibold transition-colors"
                    :class="cellClass(m.id, d)"
                    :aria-label="cellAria(m.id, d)"
                    @click="openCell(m.id, d)"
                  >
                    <Check v-if="displayCellStatus(m.id, d) === 'submitted'" class="h-4 w-4" aria-hidden="true" />
                    <template v-else-if="displayCellStatus(m.id, d) === 'draft'">{{ REPORT_STATUS_LABELS.draft }}</template>
                    <template v-else>未</template>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiSectionCard>

      <UiSectionCard title="タイムライン" :description="`チームと AI 社員の日報（${weekLabel(teamWeekStart)}・新しい順）`" flush>
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

    <!-- ================= 週報 ================= -->
    <div v-else class="grid gap-3">
      <UiTabBar v-model="weeklyView" :tabs="WEEKLY_VIEW_TABS" />

      <!-- 週次 AI インサイト（該当週の全登録データから経営・営業・チーム視点のレポート = バッチ7g） -->
      <WidgetsWeeklyInsight v-if="weeklyView === 'insight'" :initial-week-start="selWeekStart" />

      <template v-else>
      <!-- 週ナビ: 「自分の日報」の日付コントロールに合わせ、左右ボタン + 今週 + 週レンジ表示（オペレーター指示 2026-07-21 #2） -->
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
      </template>
    </div>

    <!-- 日報詳細ドロワー（チームタブ） -->
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
            <UiStatusBadge v-if="drawerGap !== null" tone="warn" :label="`工数乖離 ${gapText(drawerGap)}`" />
          </div>
        </div>

        <div class="overflow-x-auto scroll-slim">
          <table class="tbl">
            <thead>
              <tr><th>業務テーマ</th><th>作業内容</th><th class="!text-right">工数</th><th class="!text-right">進捗</th></tr>
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
            <UiMarkdown v-if="drawerReport.tomorrow" :source="drawerReport.tomorrow" />
            <p v-else class="text-[13px]">—</p>
          </div>
        </div>

        <WidgetsCommentThread :report-id="drawerReport.id" />
      </div>
    </UiDrawer>

    <!-- 週報詳細ドロワー -->
    <UiDrawer
      :open="!!weeklyDrawer"
      :title="weeklyDrawer ? `週報 ${weekLabel(weeklyDrawer.weekStart)}` : '週報'"
      @close="weeklyDrawerId = null"
    >
      <div v-if="weeklyDrawer" class="grid gap-3">
        <UiStatusBadge
          :tone="weeklyDrawer.status === 'submitted' ? 'ok' : 'warn'"
          :label="REPORT_STATUS_LABELS[weeklyDrawer.status]"
          dot
          class="justify-self-start"
        />
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
          誰の日報を参照できるかは権限設定（日報の参照対象）でロール・役職・個人ごとに制御できます
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
