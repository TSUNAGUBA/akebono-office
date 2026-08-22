<script setup lang="ts">
/**
 * 日報（F-06）
 * タブ: 自分の日報 / 全員の日報 / チーム
 * - 週報・月報は独立したトップレベルページへ分離（/weekly-report・/monthly-report =
 *   改修依頼 2026-08-20 第2バッチ。旧 /reports?kind=weekly|monthly は本ページが新パスへ
 *   replace リダイレクトする = 旧リンク・通知・ブックマーク互換〔原則7〕）
 * - 参照権限は権限表の「日報・週報の参照対象」（F-16-6 canViewMemberReports）で管理する
 * - 自分の日報: 週/月の表示モード（月は横スクロール・カレンダーの 2 ビュー）+ テーブル形式の通常入力 +
 *   明日の予定（自由テキスト。改修依頼 2026-08-21 でリスト形式＋翌営業日エントリへの自動反映を廃止）
 * - 全員の日報・チーム: 部署・メンバーで絞り込み
 * - チーム: 週/月の表示モード（月は横スクロールマトリクス・カレンダーの 2 ビュー）
 * 参照 = 基本ビュー・入力 = ボタン押下で表示（バッチ7h・オペレーター指示 2026-07-19 #10 ④）
 */
import {
  BellRing, CalendarDays, Check, ChevronLeft, ChevronRight, Eye, Minus, Pencil, Plus, Send, Settings2, Sparkles, Trash2,
} from 'lucide-vue-next'
import type { LocationQueryRaw } from 'vue-router'
import type { DailyReport, ReportEntry, TomorrowPlan } from '~/types/domain'
import { DAILY_ISSUE_CATEGORY_PRESETS } from '../../../shared/domain/types'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { hhmmToMin } from '../../../shared/domain/jst'
import { toQuarterHours } from '../../../shared/domain/report-draft'
import { capCodePoints } from '../../../shared/domain/improvement'
import { addDays, daysInMonth, fmtDate, fmtDateLong, fmtMinutes, fmtTime, weekdayOf } from '~/utils/format'
import { EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPE_TONES } from '~/utils/labels'
import { parseTeamVisibleIds } from '~/utils/team-visibility'
import { matchesMemberFilter, memberFilterOptionsOf } from '~/utils/report-filters'
import { weekRangeLabel } from '~/utils/report-weeks'
import { poipoiPostsOnDay } from '~/utils/report-poipoi'
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

// ---------- 旧 URL 互換リダイレクト（改修依頼 2026-08-20 第2バッチ・原則7） ----------
// 週報・月報は物理パス /weekly-report・/monthly-report へ独立した。既存の通知・ブックマーク
// （/reports?kind=weekly 等）を生かすため、旧クエリを新パスへ写像して replace 遷移する:
// - ?kind=weekly → /weekly-report ・ ?kind=monthly → /monthly-report
// - 旧タブキー ?tab=weekly-mine|weekly-all|weekly-team → 新 ?tab=mine|all|team（monthly-* も同様。
//   kind 無しで旧タブキーだけが付いた URL も対象）
// - さらに古い ?tab=weekly（kind 導入前の週報タブリンク）→ /weekly-report?tab=mine
// kind と tab が矛盾する場合（?kind=monthly&tab=weekly-mine 等）は kind を優先し tab は捨てる。
// その他のクエリは持ち越す（kind/tab のみ写像）。
// 注: 旧 URL は本ページ（機能キー 'reports'）のルートガードを通過してからリダイレクトするため、
// 日報 deny × 週報 allow の明示設定をした環境では旧 URL がダッシュボードへ退避する（新パスは正常）。
// 新キーを明示設定する運用へ移った時点で新 URL の利用を前提とする設計判断。
function legacyRedirectTarget(): { path: string; query: LocationQueryRaw } | null {
  const legacyTabRaw = typeof route.query.tab === 'string' ? route.query.tab : ''
  const legacyKind
    = route.query.kind === 'weekly' ? 'weekly'
      : route.query.kind === 'monthly' ? 'monthly'
        : legacyTabRaw === 'weekly' || legacyTabRaw.startsWith('weekly-') ? 'weekly'
          : legacyTabRaw.startsWith('monthly-') ? 'monthly'
            : null
  if (!legacyKind) return null
  const mappedTab = legacyTabRaw.startsWith(`${legacyKind}-`)
    ? legacyTabRaw.slice(legacyKind.length + 1)
    : legacyTabRaw === 'weekly' ? 'mine' : ''
  const { kind: _kind, tab: _tab, ...restQuery } = route.query
  return { path: `/${legacyKind}-report`, query: { ...restQuery, ...(mappedTab ? { tab: mappedTab } : {}) } }
}
{
  const target = legacyRedirectTarget()
  if (target) await navigateTo(target, { replace: true })
}
// 滞在中の同一パス内クエリ変化（/reports 表示中に旧 ?kind= リンクを踏む = ページ再マウントなし）でも
// 読み替える（setup は再実行されないため watch で補完。useRouteDeepLink と同じ考え方 = 原則3）
watch(() => [route.query.kind, route.query.tab], () => {
  const target = legacyRedirectTarget()
  if (target) void navigateTo(target, { replace: true })
})

// ---------- タブ（自分の日報 / 全員の日報 / チーム） ----------
// 週報・月報の分離後、本ページは日報専用（キーは権限カタログ `reports` と一致）

const TABS: { key: string; label: string }[] = [
  { key: 'mine', label: '自分の日報' },
  { key: 'all', label: '全員の日報' },
  { key: 'team', label: 'チーム' },
]

// タブ利用可否（権限表の `tab:<key>` 擬似フィールド = 改修依頼 2026-08-18。既定 = 全タブ利用可）
const { canTab } = usePermissions()
const tabs = computed<TabItem[]>(() =>
  (TABS as TabItem[]).filter(t => canTab('reports', t.key)))

// ?tab=<key> は初期タブ指定（旧・週報/月報系キーは上のリダイレクトが新ページへ写像済み）
const queryTab = typeof route.query.tab === 'string' ? route.query.tab : ''
const initialTab = TABS.some(t => t.key === queryTab) ? queryTab : (TABS[0]?.key ?? '')
const tab = ref<string>(initialTab)
watchEffect(() => {
  // 権限で消えたタブ・無効キーは先頭の利用可能タブへ退避。
  // 全タブ deny の場合は空値にしてどのタブ内容も描画しない（フェイルクローズ = R1 レビュー反映）
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = tabs.value[0]?.key ?? ''
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

// ---------- 部署・メンバー絞り込み（全員の日報 / チーム） ----------
// 判定・選択肢は utils/report-filters.ts（週報パネルと共通の純粋関数 = 原則3）

const memberFilterOptions = computed(() => memberFilterOptionsOf(members.value))

// ---------- 自分の日報タブ ----------

// 通知ディープリンク: ?date=YYYY-MM-DD で対象日を初期表示（日報コメント通知から対象の日報へ即到達 = 改善要望 2026-08-17）
const DEEP_LINK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const queryDate = typeof route.query.date === 'string' && DEEP_LINK_DATE_RE.test(route.query.date)
  ? route.query.date
  : ''
const selDate = ref(queryDate || todayJst())
// URL からの除去（選び直した日付がリロードで巻き戻らない）+ 滞在中の同一ページ内 ?date= 変化への追従は
// 共通の useRouteDeepLink（原則3。初期値は上の同期初期化 = 初回描画のちらつき回避。2026-08-18）
useRouteDeepLink('date', (v) => {
  if (DEEP_LINK_DATE_RE.test(v)) selDate.value = v
})
const myReport = computed(() => reports.myReportOn(selDate.value))

/** 表示モード（週 / 月）と月ビューの形式（横スクロール / カレンダー）。
 *  既定 = 月表示の横スクロール（改善要望 2026-08-17。従来の既定は週） */
const mineView = ref<'week' | 'month'>('month')
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
// フリー入力欄のマークダウンプレビュー（バッチ7e。入力はプレーンな textarea のまま = 記法をそのまま保存）
const dailyMdPreview = ref(false)
const wkMdPreview = ref(false)
const editReflection = ref('')
const editIssues = ref('')
/** 本日の課題の種別（DAILY_ISSUE_CATEGORY_PRESETS のいずれか。'' = 未選択。オペレーター指示 2026-08-03） */
const editIssueCategory = ref('')
/** 課題種別の選択肢（値=ラベル。空選択肢「未選択」は UiSelect の empty-label で提示） */
const issueCategoryOptions = DAILY_ISSUE_CATEGORY_PRESETS.map(c => ({ value: c, label: c }))
/** 明日の予定（自由記述テキスト。行形式からテキスト入力へ回帰 = 改善要望 2026-08-21） */
const editTomorrow = ref('')

/**
 * 旧形式（行構造 tomorrowPlans）をテキストへ変換する（編集開始時のみ。
 * 保存でテキストへ一本化されるが、変換テキストとして情報は保持される = 原則7。
 * 未編集の既存日報は行構造のまま参照表示される = データ自体は書き換えない）
 */
function plansToText(plans: TomorrowPlan[]): string {
  return plans.map((p) => {
    const label = [p.theme, p.purpose, p.task].map(s => s.trim()).filter(Boolean).join(' / ')
    return `- ${label || '—'}（${p.hours}h）`
  }).join('\n')
}

/** 編集初期値: 自由記述があればそれ、無ければ旧形式の変換。両方あれば結合（情報を落とさない） */
function tomorrowTextOf(r: DailyReport): string {
  const plans = r.tomorrowPlans ?? []
  if (r.tomorrow.trim() && plans.length > 0) return `${r.tomorrow}\n${plansToText(plans)}`
  return r.tomorrow.trim() ? r.tomorrow : (plans.length > 0 ? plansToText(plans) : '')
}

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
    editIssueCategory.value = r.issueCategory ?? ''
    editTomorrow.value = tomorrowTextOf(r)
  } else {
    // 前営業日の「明日の予定」の自動反映は廃止（改善要望 2026-08-21: テキスト入力形式化とあわせて除外）
    editEntries.value = [blankEntry()]
    editReflection.value = ''
    editIssues.value = ''
    editIssueCategory.value = ''
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
  editIssueCategory.value = r.issueCategory ?? ''
  editTomorrow.value = tomorrowTextOf(r)
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
    await submitPoipoiIfAny()
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
    issueCategory: editIssueCategory.value,
    tomorrow: editTomorrow.value,
    // テキスト入力へ一本化（改善要望 2026-08-21）。旧行形式は編集開始時にテキストへ変換済みのため
    // 空で送る（未編集の既存日報はそもそも保存されないので行データは温存される = 原則2）
    tomorrowPlans: [],
  }
}

async function onSaveDraft(): Promise<void> {
  await run('mine-draft', async () => {
    const res = await reports.saveDraft(payload())
    show(res.ok ? '下書きを保存しました' : res.error.message, res.ok ? 'ok' : 'warn')
    if (res.ok) await submitPoipoiIfAny()
  }, { message: '下書きを保存しています…' })
}

async function onSubmit(): Promise<void> {
  // 改善のタネ（旧称: ぽいぽいポスト）は提出時の必須項目（オペレーター指示 2026-08-03）。入力欄が空でも、
  // 当日すでに登録済み（下書き保存時に投稿済み等）なら要件を満たす扱いとし二重投稿を防ぐ。
  // ※ confirmStep はここで触らない（アシストモードでは confirmStep=false がエディタごと隠してしまうため）
  if (!poipoiDraft.value.trim() && !hasPoipoiForDay.value) {
    show('改善のタネを入力してください（提出には必須です）', 'warn')
    return
  }
  await run('mine-submit', async () => {
    const res = await reports.submit(payload())
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    mineEditing.value = false
    confirmStep.value = false
    show('日報を提出しました')
    await submitPoipoiIfAny()
    if (res.escalated) {
      show('課題が管理者へ共有されました', 'info', { label: '受信箱', to: '/inbox' })
    }
    if (res.hoursGapMinutes !== null) {
      show(`勤怠実労働と時間合計に 60 分超の乖離があります（${gapText(res.hoursGapMinutes)}）`, 'warn')
    }
  }, { message: '日報を提出しています…' })
}

// ---------- 改善のタネ（旧称: ぽいぽいポスト）の同時登録（オペレーター指示 2026-07-31: 日報フォーム内） ----------

/** 日報フォーム内の改善のタネ入力。保存・提出の成立時に通常経路（useNotes 'poipoi' = トップメニューの
 * 改善のタネと同一経路）で登録する。日付・ユーザー切替でクリア（別日の日報への持ち越しを防ぐ） */
const poipoiDraft = ref('')
watch([selDate, currentUserId], () => { poipoiDraft.value = '' })

/** 入力があれば日報の登録と合わせて登録・空欄ならスキップ。
 * 登録成功でクリア = 続けて保存しても二重登録しない（冪等）。失敗しても日報フローは止めない（原則4） */
async function submitPoipoiIfAny(): Promise<void> {
  const text = poipoiDraft.value.trim()
  if (!text) return
  // origin='report' = 日報提出時の登録経路（ぽいぽいポスト一覧の経路バッジに使う。改善要望 2026-08-21）
  const res = await poipoiNotes.add({ title: '', body: text, projectId: null, companyId: null, workCategoryId: null, origin: 'report' })
  if (res.ok) {
    poipoiDraft.value = ''
    show('改善のタネを登録しました')
  } else {
    show(`改善のタネの登録に失敗しました（${res.error.message}）。入力は保持されています`, 'warn')
  }
}

// ---------- Google カレンダー予定の読込・取込（改善要望 2026-08-17。AI業務アシスタント F-14 と同じ useCalendar） ----------

const cal = useCalendar()
const calConnected = cal.isConnected
const calEnabled = cal.isEnabled
const calStatusLoaded = cal.isStatusLoaded

/** 選択日のカレンダー予定（連携済みのとき。API モードは参照キー単位の遅延ロード） */
const dayCalEvents = computed(() =>
  calConnected.value ? cal.eventsOf(currentUserId.value, selDate.value) : [])

/**
 * カレンダー予定を日報エントリへ取り込む（同期 → 予定を行へ変換）。
 * 予定タイトルは「テーマ」列へ入れる（改善要望 2026-08-21: 従来は「内容」に入っていた。
 * 内容 = 実際に行った作業はユーザーが記入する）。テーマは入力欄と同じ 100 字キャップ。
 * 既存エントリと同名（テーマ一致）の予定はスキップ = 再取込しても増殖しない（冪等 = 原則2）。
 * 取り込んだ行はその後自由に編集・削除できる（取消フロー = 行削除。原則9.5）。
 */
async function importCalendarEvents(): Promise<void> {
  await run('mine-cal-import', async () => {
    // 連携済みなら最新を同期してから読み込む。同期失敗は手元の予定で続行（非ブロッキング = 原則4）
    const sync = await cal.syncFromGoogle(currentUserId.value, selDate.value)
    if (!sync.ok) show('カレンダー同期に失敗しました。取得済みの予定で続行します', 'warn')
    else if (sync.warning) show(sync.warning, 'warn') // 一部カレンダーの取得失敗等 = 欠落を報告（ai-assistant と同じ扱い）
    const events = cal.eventsOf(currentUserId.value, selDate.value)
    if (events.length === 0) {
      show('この日のカレンダー予定はありません', 'info')
      return
    }
    const existing = new Set(editEntries.value.map(e => entryTheme(e).trim()).filter(Boolean))
    const rows: ReportEntry[] = events
      .filter(e => !existing.has(capCodePoints(e.title.trim(), 100)))
      .map(e => ({
        theme: capCodePoints(e.title.trim(), 100), projectId: '', task: '',
        hours: toQuarterHours(Math.max(0, hhmmToMin(e.to) - hhmmToMin(e.from))), progress: 0,
      }))
    if (rows.length === 0) {
      show('この日の予定はすべて取込済みです', 'info')
      return
    }
    // 未入力の初期行（空行）は取り込んだ行で置き換える（空行が先頭に残らない）
    const nonEmpty = editEntries.value.filter(e => e.task.trim() || (e.theme ?? '').trim())
    editEntries.value = [...nonEmpty, ...rows]
    show(`カレンダーから ${rows.length} 件の予定を取り込みました（内容欄に実施した作業を記入してください）`)
  }, { message: 'カレンダーの予定を読み込んでいます…' })
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
/** この日に自分のぽいぽいポストが既に登録済みか（下書き保存時に投稿済み等）。提出必須判定の二重投稿防止に使う */
const hasPoipoiForDay = computed(() =>
  poipoiNotes.list.value.some(n => n.memberId === currentUserId.value && n.createdAt.slice(0, 10) === selDate.value))
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

/** 表示モード（週 / 月）と月ビューの形式（横スクロール / カレンダー）。
 *  既定 = 月・横スクロール（改修依頼 2026-08-19。従来の既定は週。週/月トグルで週表示にも切替可） */
const teamView = ref<'week' | 'month'>('month')
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
  reports.teamMembers.value.filter(m => matchesMemberFilter(members.value, m.id, teamDeptId.value, teamMemberId.value)))

const teamTimeline = computed(() => {
  const dates = teamView.value === 'month' ? teamMonthDays.value : matrixDays.value
  // AI 社員（memberId=null）は matchesMemberFilter が「絞り込み未指定のときのみ表示」を判定する
  return reports.timelineForDates(dates)
    .filter(r => matchesMemberFilter(members.value, r.memberId, teamDeptId.value, teamMemberId.value))
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

/**
 * 日報詳細に合わせて表示する、同じ著者・同じ日付のぽいぽいポスト（オペレーター要望: 個別の日報閲覧に
 * ぽいぽいポストの投稿内容も合わせて見られるようにする）。可視範囲は既存の poipoi 可視モデルに従う
 * （本人の list + 管理者の全ポスト adminList）= ここで権限を広げない。AI 社員（memberId=null）は対象外。
 */
const drawerPoipoiPosts = computed(() => {
  const r = drawerReport.value
  if (!r || !r.memberId) return []
  // 可視範囲 = 本人の list + 管理者の全ポスト adminList（poipoi の既存モデル。ここで権限を広げない）
  return poipoiPostsOnDay([...poipoiNotes.list.value, ...poipoiNotes.adminList.value], r.memberId, r.date)
})

/**
 * 自分の日報（提出済み表示）に併記する、その日・本人の改善のタネ（改修8）。
 * 本人の投稿は poipoiNotes.list（本人スコープ）に含まれるため adminList は不要。
 * 抽出は drawerPoipoiPosts と同じ純関数を再利用（原則3）。時刻(hh:mm)は表示側で出さない（改修7 と整合）。
 */
const myPoipoiPosts = computed(() =>
  poipoiPostsOnDay(poipoiNotes.list.value, currentUserId.value, selDate.value))

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
    .filter(r => matchesMemberFilter(members.value, r.memberId, allDeptId.value, allMemberId.value)))

// ---- 既読/未読の可視化（オペレーター指示 2026-07-31。SoT = report_reads） ----

/** 自分の日報か（自分の記録は既読管理の対象外 = 未読として数えない） */
function isOwnDaily(r: DailyReport): boolean {
  return r.authorKind === 'human' && r.memberId === currentUserId.value
}

function isDailyUnread(r: DailyReport): boolean {
  return !isOwnDaily(r) && !reports.isReportRead('daily', r.id)
}

// 既定 = 未読のみに統一（通知・日報のデフォルト表示を未読のみに揃える。オペレーター指示）
const allUnreadOnly = ref(true)
const allUnreadCount = computed(() => allReports.value.filter(isDailyUnread).length)
const allVisibleReports = computed(() =>
  allUnreadOnly.value ? allReports.value.filter(isDailyUnread) : allReports.value)

// 詳細を開いたら既読にする（全員の日報・チーム・タイムラインのどの導線でも一貫。
// 下書き（管理者のみ開ける）は既読対象外 = 未読可視化は提出済みのみを扱う）
watch(drawerReportId, (id) => {
  if (!id) return
  const r = reports.reportById(id)
  if (r && r.status === 'submitted' && !isOwnDaily(r)) void reports.markReportRead('daily', id)
})

/** 未読に戻す（既読の取消フロー = 原則9.5）。あとで読み直すための導線 */
async function onMarkUnreadDaily(): Promise<void> {
  const r = drawerReport.value
  if (!r) return
  const res = await reports.markReportUnread('daily', r.id)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  drawerReportId.value = null
  show('未読に戻しました')
}

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

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込みは allVisibleReports が担う）
const { page: allPage, pageSize: allPageSize, rows: pagedAllReports, total: allTotal } = useListView<DailyReport>({ source: allVisibleReports })
watch([tab, allMonth, allDeptId, allMemberId, allUnreadOnly], () => { allPage.value = 1 })

const allRows = computed(() =>
  pagedAllReports.value.map(r => ({
    id: r.id,
    dateLabel: dayLabel(r.date),
    author: reports.authorOf(r).name,
    summary: summaryOf(r),
    hours: `${totalHoursOf(r)}h`,
    issues: r.issues,
    unread: isDailyUnread(r),
  })) as unknown as Record<string, unknown>[])

function openAllRow(row: Record<string, unknown>): void {
  drawerReportId.value = String(row.id)
}
</script>

<template>
  <div>
    <UiPageHeader title="日報" description="日々の活動報告。AI 社員の日次報告も同じタイムラインに届きます" />

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />
    <!-- 全タブ deny 時の空状態（タブ内容は tab='' のためどれも描画されない = フェイルクローズ） -->
    <p v-if="tabs.length === 0" class="card p-6 text-center text-[13px] text-sub">利用できるタブがありません（権限設定で制限されています。管理者にお問い合わせください）</p>

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
      <UiSectionCard v-if="mineView === 'week'" :title="`週の提出状況（${weekRangeLabel(reports.weekStartOf(selDate))}）`">
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
          <!-- py-1: 選択中セルの ring-2 が overflow-x-auto で上下にクリップされないよう逃げ余白を確保（改修依頼 2026-08-18） -->
          <div class="flex w-max gap-1 py-1">
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
              <p class="label">本日の所感</p>
              <UiMarkdown v-if="myReport.reflection" :source="myReport.reflection" />
              <p v-else class="text-[13px]">—</p>
            </div>
            <!-- 本日の課題は所感と同じプレーン表現（背景色・カード化なし。「（管理者へ共有済み）」表記も削除 = 改善要望 2026-08-17） -->
            <div>
              <p class="label">本日の課題</p>
              <span
                v-if="myReport.issueCategory"
                class="mb-1 inline-block rounded-full border border-brand bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand"
              >{{ myReport.issueCategory }}</span>
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
          <!-- その日・本人の改善のタネ（改修8。全員の日報ドロワーの表示様式を再利用 = 原則3。
               時刻(hh:mm)は非表示 = 改修7 と整合。該当日に投稿が無ければセクションごと非表示） -->
          <div v-if="myPoipoiPosts.length > 0">
            <p class="label">改善のタネ</p>
            <ul class="grid gap-2">
              <li
                v-for="p in myPoipoiPosts"
                :key="p.id"
                class="rounded-lg border border-line bg-surface-soft p-2.5"
              >
                <UiMarkdown :source="p.body" />
              </li>
            </ul>
          </div>

          <WidgetsCommentThread :report-id="myReport.id" />
        </div>
      </UiSectionCard>

      <!-- ================= AI アシスト入力（F-06-7/8。入力中のみ表示 = バッチ7h ④） ================= -->
      <template v-if="assistActive && mineEditing && !isSubmittedDay">
        <!-- 材料サマリ（計画・メモ・回答の入力は AI業務アシスタント F-14 で行う） -->
        <UiSectionCard
          title="AI アシストの材料"
          description="タスク計画の結果・改善のタネ・ヒアリング回答を材料に AI が下書きを作ります。材料の入力は AI業務アシスタントで"
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
              <p class="text-[11px] font-bold text-muted">改善のタネ</p>
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
        <UiSectionCard title="日報ドラフト生成" description="スケジュール・回答・改善のタネを材料に AI が下書きを作ります">
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

          <!-- Google カレンダー予定の読込・取込（改善要望 2026-08-17。F-14 と同じ useCalendar。
               未連携時は連携ゲート = WidgetsCalendarConnectGate〔擬似 OAuth / OAuth リダイレクト〕を表示） -->
          <WidgetsCalendarConnectGate v-if="calStatusLoaded && calEnabled && !calConnected" />
          <div
            v-else-if="calConnected"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-page px-3 py-2"
          >
            <p class="text-[12px] text-sub">
              Google カレンダー連携済み。この日の予定（<span class="num font-semibold">{{ dayCalEvents.length }}</span> 件）を日報エントリへ取り込めます
            </p>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="isRunning('mine-cal-import')"
              @click="importCalendarEvents"
            >
              <CalendarDays class="h-4 w-4" aria-hidden="true" />
              {{ isRunning('mine-cal-import') ? '読込中…' : 'カレンダーから予定を取込' }}
            </button>
          </div>

          <!-- 通常入力: テーブル形式（共通ヘッダ 1 行 + 各セルへの入力 = オペレーター指示 2026-07-22）。
               「進捗」列は入力フォームでは非表示（オペレーター指示 2026-07-31。既存データの進捗値は
               編集・保存でもそのまま保持され、参照表示には引き続き出る = 原則7） -->
          <div class="overflow-x-auto scroll-slim">
            <table class="tbl min-w-[560px]">
              <thead>
                <tr>
                  <th class="w-[26%]">テーマ <span class="text-crit" aria-hidden="true">*</span></th>
                  <th>内容 <span class="text-crit" aria-hidden="true">*</span></th>
                  <th class="w-40 !text-right">時間 (h)</th>
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
            <UiFormField label="本日の所感">
              <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editReflection" /></div>
              <textarea v-else v-model="editReflection" class="textarea" placeholder="例）商品ページの改善を予定通り完了。レビューで出た修正点も反映できた。" />
            </UiFormField>
            <UiFormField label="本日の課題">
              <div class="grid gap-1.5">
                <div v-if="dailyMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="editIssues" /></div>
                <textarea v-else v-model="editIssues" class="textarea" placeholder="例）商品データの更新に手作業が多く、想定より時間がかかった。" />
                <UiSelect
                  v-model="editIssueCategory"
                  :options="issueCategoryOptions"
                  empty-label="課題要因を選択"
                  aria-label="本日の課題の課題要因"
                />
              </div>
            </UiFormField>
          </div>

          <!-- 改善のタネ（旧称: ぽいぽいポスト。明日の予定より上に配置 = 改善要望 2026-08-17。
               トップメニューの改善のタネと同一経路（useNotes 'poipoi'）で登録。
               入力があれば日報の保存と合わせて登録・空欄ならスキップ） -->
          <!-- 必須マーカーは初回提出コンテキストのみ（提出済み編集・下書きでは非強制のため誤認防止 = §54 NIT-1） -->
          <UiFormField label="改善のタネ" :required="!editingSubmitted">
            <textarea
              v-model="poipoiDraft"
              class="textarea"
              placeholder="例）商品データの更新を自動化できると効果的！"
              aria-label="改善のタネ"
            />
          </UiFormField>

          <!-- 明日の予定（テキスト入力形式 = 改善要望 2026-08-21。行追加形式と翌営業日への自動反映は廃止。
               旧行形式のデータは編集開始時にテキストへ変換されて引き継がれる = 原則7） -->
          <UiFormField label="明日の予定">
            <textarea
              v-model="editTomorrow"
              class="textarea"
              rows="3"
              placeholder="例）○○案件の実装続き、△△の定例 MTG"
              aria-label="明日の予定"
            />
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
        <button
          type="button"
          class="btn btn-sm"
          :class="allUnreadOnly ? 'btn-primary' : ''"
          :aria-pressed="allUnreadOnly"
          @click="allUnreadOnly = !allUnreadOnly"
        >
          未読のみ
        </button>
        <template #trailing>
          <UiStatusBadge v-if="allUnreadCount > 0" tone="brand" :label="`未読 ${allUnreadCount} 件`" dot />
          <span class="num text-xs text-muted">{{ allReports.length }} 件</span>
        </template>
      </UiFilterBar>

      <UiSectionCard
        title="全員の日報"
        description="全メンバー・AI 社員の提出済み日報（新しい順）。行（モバイルはカード）を押すと詳細が開き、既読になります。参照できる範囲は権限設定（日報・週報の参照対象）に従います"
        flush
      >
        <UiDataTable
          :columns="ALL_COLUMNS"
          :rows="allRows"
          clickable
          :empty-title="allUnreadOnly ? '未読の日報はありません' : 'この月の提出済み日報がありません'"
          :empty-hint="allUnreadOnly ? 'すべて既読です（「未読のみ」を解除すると全件表示されます）' : '「自分の日報」から提出すると、ここに表示されます（絞り込み条件も確認してください）'"
          @row-click="openAllRow"
        >
          <template #cell-summary="{ row }">
            <span class="flex items-center gap-1.5">
              <UiStatusBadge v-if="row.unread" tone="brand" label="未読" dot />
              <span class="line-clamp-1">{{ row.summary }}</span>
              <UiStatusBadge v-if="row.issues" tone="warn" label="課題" />
            </span>
          </template>
        </UiDataTable>
        <UiPagination v-model:page="allPage" v-model:page-size="allPageSize" :total="allTotal" />
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
          <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekRangeLabel(teamWeekStart) }}</span>
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
        :description="`チームと AI 社員の日報（${weekRangeLabel(teamWeekStart)}・新しい順）`"
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
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <UiStatusBadge
              :tone="drawerReport.status === 'submitted' ? 'ok' : 'warn'"
              :label="REPORT_STATUS_LABELS[drawerReport.status]"
              dot
            />
            <UiStatusBadge v-if="drawerGap !== null" tone="warn" :label="`時間乖離 ${gapText(drawerGap)}`" />
            <!-- 未読に戻す（他人の提出済み日報のみ。開いた時点で既読になるため、その取消フロー = 原則9.5） -->
            <button
              v-if="!isOwnDaily(drawerReport) && drawerReport.status === 'submitted' && reports.isReportRead('daily', drawerReport.id)"
              type="button"
              class="btn btn-sm"
              @click="onMarkUnreadDaily"
            >
              未読に戻す
            </button>
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
            <p class="label">本日の所感</p>
            <UiMarkdown v-if="drawerReport.reflection" :source="drawerReport.reflection" />
            <p v-else class="text-[13px]">—</p>
          </div>
          <!-- 本日の課題は所感と同じプレーン表現（背景色・カード化なし。「（管理者へ共有済み）」表記も削除 = 改善要望 2026-08-17） -->
          <div v-if="drawerReport.issues">
            <p class="label">本日の課題</p>
            <span
              v-if="drawerReport.issueCategory"
              class="mb-1 inline-block rounded-full border border-brand bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand"
            >{{ drawerReport.issueCategory }}</span>
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

          <!-- 改善のタネ連携（同じ著者・同じ日付の投稿を日報詳細に合わせて表示。可視範囲は poipoi の既存モデル。
               時刻(hh:mm)は非表示 = 改修依頼 2026-08-19（他者の記録閲覧ビューでは本文のみで足りる）） -->
          <div v-if="drawerPoipoiPosts.length > 0">
            <p class="label">改善のタネ</p>
            <ul class="grid gap-2">
              <li
                v-for="p in drawerPoipoiPosts"
                :key="p.id"
                class="rounded-lg border border-line bg-surface-soft p-2.5"
              >
                <UiMarkdown :source="p.body" />
              </li>
            </ul>
          </div>
        </div>

        <WidgetsCommentThread :report-id="drawerReport.id" />
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
