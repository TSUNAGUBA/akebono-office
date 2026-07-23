/**
 * 日報・週報（F-06）
 * - 提出済みの日報・週報は編集不可（記録系の状態保護）
 * - 提出時の課題エスカレーション・通知は主フロー成立後の補助処理（非ブロッキング）
 * - 工数合計と勤怠実労働の乖離チェック（60 分超で warning を画面へ返す）
 *
 * デュアルモード（バッチ2b-1）:
 * - モックモード: 従来どおり useMockDb
 * - API モード: SoT は /v1/reports。参照はモジュールスコープの API キャッシュ（月/期間単位の遅延ロード）を
 *   バッキングにした同一の射影ロジックで行い、書込（保存・提出・コメント・リアクション・リマインド）は
 *   API を呼んでからキャッシュを取り直す（SoT 書込 → キャッシュ反映。原則6）。
 *   工数乖離は提出レスポンス（サーバー計算）を用いる。提出時エスカレーションはエスカレーション API 化
 *   （バッチ3）まで未発火（implementation-status.md に明記）。
 */
import type { Ref } from 'vue'
import type {
  DailyReport, ReportComment, ReportEntry, Result, TomorrowPlan, WeeklyReport,
} from '~/types/domain'
import { TOMORROW_PLANS_MAX } from '../../../shared/domain/types'
import { addDays, weekdayOf } from '~/utils/format'
import { matrixVisible, parseTeamVisibleIds, timelineVisibleWith } from '~/utils/team-visibility'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiDaily = ref<DailyReport[]>([])
const apiWeekly = ref<WeeklyReport[]>([])
const apiComments = ref<ReportComment[]>([])

function mergeById<T extends { id: string }>(store: Ref<T[]>, rows: T[]): void {
  const map = new Map(store.value.map(r => [r.id, r]))
  for (const r of rows) map.set(r.id, r)
  store.value = [...map.values()]
}

function loadMineMonth(month: string, force = false): Promise<void> {
  return apiLoadOnce(`rep:mine:${month}`, async () => {
    mergeById(apiDaily, await apiFetch<DailyReport[]>('/v1/reports/daily', { query: { month } }))
  }, force)
}

function loadTeamRange(from: string, to: string, force = false): Promise<void> {
  return apiLoadOnce(`rep:team:${from}:${to}`, async () => {
    mergeById(apiDaily, await apiFetch<DailyReport[]>('/v1/reports/daily', { query: { scope: 'team', from, to } }))
  }, force)
}

function loadAllMonth(month: string, force = false): Promise<void> {
  return apiLoadOnce(`rep:all:${month}`, async () => {
    mergeById(apiDaily, await apiFetch<DailyReport[]>('/v1/reports/daily', { query: { scope: 'all', month } }))
  }, force)
}

/** 全員の日報キャッシュの取り直し（AI 日次報告の生成後などサーバー側で増えたときに呼ぶ） */
export function reloadAllMonth(month: string): Promise<void> {
  return loadAllMonth(month, true)
}

function loadWeekly(force = false): Promise<void> {
  return apiLoadOnce('rep:weekly', async () => {
    mergeById(apiWeekly, await apiFetch<WeeklyReport[]>('/v1/reports/weekly'))
  }, force)
}

/** 全員の提出済み週報（scope=all・単週指定。参照権限の絞り込みはサーバー側でも適用される） */
function loadWeeklyAll(weekStart: string, force = false): Promise<void> {
  return apiLoadOnce(`rep:weekly:all:${weekStart}`, async () => {
    mergeById(apiWeekly, await apiFetch<WeeklyReport[]>('/v1/reports/weekly', { query: { scope: 'all', weekStart } }))
  }, force)
}

function loadComments(reportId: string, force = false): Promise<void> {
  return apiLoadOnce(`rep:comments:${reportId}`, async () => {
    mergeById(apiComments, await apiFetch<ReportComment[]>(`/v1/reports/${reportId}/comments`))
  }, force)
}

// ログイン確立・切替時に取り直す（キーの解除は resetApiData が一括で行う）
onApiReset(() => {
  apiDaily.value = []
  apiWeekly.value = []
  apiComments.value = []
})

export interface DailyReportInput {
  date: string
  entries: ReportEntry[]
  reflection: string
  issues: string
  /** 旧形式の明日の予定（自由記述。既存データの保持用パススルー） */
  tomorrow: string
  /** 明日の予定（構造化・最大 TOMORROW_PLANS_MAX 件。翌営業日の日報へ自動反映） */
  tomorrowPlans: TomorrowPlan[]
}

export interface WeeklyReportInput {
  weekStart: string
  goalReview: string
  mainWork: string
  issues: string
  nextWeek: string
}

export type SubmissionCell = 'submitted' | 'draft' | 'none'

export type SubmitDailyResult =
  | { ok: true; id: string; escalated: boolean; hoursGapMinutes: number | null }
  | { ok: false; error: { code: string; message: string } }

/** リアクションはアイコンではなく感情表現のため絵文字を使用（規約 5 の例外用途） */
export const REPORT_REACTION_EMOJIS = ['👍', '✅', '💬'] as const

/** 日報・週報ステータスのラベル（共有 labels.ts は編集不可のため本領域固有ラベルはここが SoT） */
export const REPORT_STATUS_LABELS: Record<'draft' | 'submitted', string> = {
  draft: '下書き',
  submitted: '提出済',
}

export function useReports() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify } = useNotifications()
  const isApi = useApiMode()
  // API モードはキャッシュをバッキングにし、以降の射影ロジックを共通利用する
  const dailyReports = isApi ? (apiDaily as Ref<DailyReport[]>) : tbl('dailyReports')
  const weeklyReports = isApi ? (apiWeekly as Ref<WeeklyReport[]>) : tbl('weeklyReports')
  const comments = isApi ? (apiComments as Ref<ReportComment[]>) : tbl('reportComments')
  const members = tbl('members')
  const aiEmployees = tbl('aiEmployees')
  if (isApi) {
    void loadMineMonth(todayJst().slice(0, 7))
    void loadWeekly()
  }

  /** API モード時、参照された月の自分の日報を遅延ロードする（射影関数から fire-and-forget で呼ぶ） */
  function touchMineMonth(date: string): void {
    if (isApi && /^\d{4}-\d{2}/.test(date)) void loadMineMonth(date.slice(0, 7))
  }

  /** API モード時、チーム提出状況の対象期間を遅延ロードする（チームタブ = バッチ7h で全員公開） */
  function touchTeamWindow(days: number): void {
    if (!isApi) return
    const range = recentBusinessDays(days)
    const from = range[0]
    const to = range[range.length - 1]
    if (from && to) void loadTeamRange(from, to)
  }

  function err(code: string, message: string): Result {
    return { ok: false, error: { code, message } }
  }

  // ---------- 参照系 ----------

  function reportById(id: string): DailyReport | undefined {
    return dailyReports.value.find(r => r.id === id)
  }

  function reportOn(memberId: string, date: string): DailyReport | undefined {
    if (memberId === currentUser.value.id) touchMineMonth(date)
    return dailyReports.value.find(r =>
      r.authorKind === 'human' && r.memberId === memberId && r.date === date)
  }

  function myReportOn(date: string): DailyReport | undefined {
    return reportOn(currentUser.value.id, date)
  }

  function authorOf(report: DailyReport): { name: string; kind: 'human' | 'ai' } {
    if (report.authorKind === 'ai') {
      return {
        name: aiEmployees.value.find(a => a.id === report.aiEmployeeId)?.name ?? 'AI社員',
        kind: 'ai',
      }
    }
    return {
      name: members.value.find(m => m.id === report.memberId)?.name ?? '不明',
      kind: 'human',
    }
  }

  function memberName(id: string): string {
    return members.value.find(m => m.id === id)?.name ?? id
  }

  /** 直近 n 営業日（土日除外・今日を含む・昇順） */
  function recentBusinessDays(n = 7): string[] {
    const days: string[] = []
    let d = todayJst()
    while (days.length < n) {
      const w = weekdayOf(d)
      if (w !== 0 && w !== 6) days.unshift(d)
      d = addDays(d, -1)
    }
    return days
  }

  /** 指定週（weekStart = 月曜）の営業日（月〜金・昇順）。チームタブの週切替で参照する */
  function businessDaysOfWeek(weekStart: string): string[] {
    return Array.from({ length: 5 }, (_, i) => addDays(weekStart, i))
  }

  /** API モード時、指定した日付群を含む期間のチーム提出状況を遅延ロードする */
  function touchTeamDates(dates: string[]): void {
    if (!isApi || dates.length === 0) return
    const from = dates[0]
    const to = dates[dates.length - 1]
    if (from && to) void loadTeamRange(from, to)
  }

  // 表示メンバー設定 + 日報参照権限（バッチ7h・オペレーター指示 2026-07-19 #10 ① → バッチ7k #13 で候補拡大）
  const perms = usePermissions()
  const { getConfig } = useAppSettings()

  /** チームタブの表示メンバー設定（configs 'teamVisibleMemberIds' = JSON 配列。未設定・空・不正 = 既定表示） */
  const teamVisibleIds = computed<Set<string> | null>(() =>
    parseTeamVisibleIds(getConfig('teamVisibleMemberIds', '')))

  /** 表示メンバー設定の選択肢 = 在籍中の全メンバー（バッチ7k で取締役・外注も選択可能に） */
  const teamMemberCandidates = computed(() => members.value.filter(m => m.active))

  /**
   * 提出状況マトリクスの対象メンバー = 候補 ∩ 表示メンバー設定 ∩ 日報参照権限（F-16-6）。
   * 設定未設定の既定は従来どおり社員・契約・アルバイトのみ。設定ありは「選択メンバー + 自分」
   * （自分の提出状況を見失わない。判定は utils/team-visibility.ts が SoT）
   */
  const teamMembers = computed(() =>
    teamMemberCandidates.value.filter(m =>
      matrixVisible(teamVisibleIds.value, m, currentUser.value.id)
      && perms.canViewMemberReports(m.id)))

  function cellStatus(memberId: string, date: string): SubmissionCell {
    touchTeamWindow(7)
    const r = reportOn(memberId, date)
    if (!r) return 'none'
    return r.status === 'submitted' ? 'submitted' : 'draft'
  }

  /** チームタイムライン（直近営業日分の提出済み日報。AI 社員の日報も同列に混在 = モックのみ） */
  /** タイムライン上の人間日報の可視判定（PR #57 R1 M-5 / R2 Minor-2 → バッチ7k で統一）。
   * - 参照権限（F-16-6）は常に適用
   * - 表示メンバー設定: 未設定 = 全員（従来どおり）/ 設定あり = 選択メンバー + 自分。
   *   在籍中の全メンバーが設定の選択肢に出るため、バッチ7h の「候補外は設定の影響を受けない」
   *   特例は在籍中の取締役・外注については廃止（選択状態がそのまま表示状態）。
   *   候補に出ない在籍外（退職者等）は引き続き設定の影響外 = 常に表示（PR #61 R1 M-1。
   *   判定は utils/team-visibility.ts が SoT） */
  function timelineVisible(memberId: string): boolean {
    if (!perms.canViewMemberReports(memberId)) return false
    const selectable = teamMemberCandidates.value.some(m => m.id === memberId)
    return timelineVisibleWith(teamVisibleIds.value, memberId, currentUser.value.id, selectable)
  }

  /** 指定した日付群の提出済み日報タイムライン（表示メンバー設定 ∩ 参照権限を適用） */
  function timelineForDates(dates: string[]): DailyReport[] {
    touchTeamDates(dates)
    const range = new Set(dates)
    return dailyReports.value
      .filter(r => r.status === 'submitted' && range.has(r.date))
      // 人間の日報は表示メンバー設定 ∩ 参照権限に従う（AI 社員の日次報告は従来どおり全員分）
      .filter(r => r.authorKind !== 'human' || !r.memberId || timelineVisible(r.memberId))
      .sort((a, b) =>
        b.date.localeCompare(a.date)
        || (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))
  }

  function timeline(days = 7): DailyReport[] {
    touchTeamWindow(days)
    return timelineForDates(recentBusinessDays(days))
  }

  /**
   * 全員の日報（バッチ5e: 全メンバーが相互参照できる提出済み日報の月次一覧）。
   * 下書きは本人以外に見せない（API も scope=all は提出済みのみを返す）
   */
  function allSubmitted(month: string): DailyReport[] {
    if (isApi && /^\d{4}-\d{2}$/.test(month)) void loadAllMonth(month)
    return dailyReports.value
      .filter(r => r.status === 'submitted' && r.date.startsWith(month))
      // 日報参照権限（F-16-6）: deny された対象者の日報は一覧に出さない（API 側でも同じ絞り込み）
      .filter(r => r.authorKind !== 'human' || !r.memberId || perms.canViewMemberReports(r.memberId))
      .sort((a, b) =>
        b.date.localeCompare(a.date)
        || (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))
  }

  /**
   * 指定日の日報エディタへ自動反映する「明日の予定」（オペレーター指示 2026-07-22）。
   * 直近の自分の日報のうち、その日報の日付の翌営業日（本人の勤怠ルール基準）が指定日に一致し、
   * かつ明日の予定が登録されているものを返す（該当なし = null）。
   */
  function tomorrowPlansFor(date: string): { fromDate: string; plans: TomorrowPlan[] } | null {
    // 週明け・連休明けに備えて前月分もロードしておく（API モードの遅延ロード）
    touchMineMonth(date)
    touchMineMonth(addDays(date, -14))
    const me = currentUser.value.id
    const latest = dailyReports.value
      .filter(r => r.authorKind === 'human' && r.memberId === me && r.date < date
        && (r.tomorrowPlans?.length ?? 0) > 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    if (!latest) return null
    // 予定の反映先は「登録した日の翌営業日」のみ（それ以外の日に古い予定を出さない）
    if (useBusinessDay().nextWorkingDayFor(me, latest.date) !== date) return null
    return { fromDate: latest.date, plans: latest.tomorrowPlans ?? [] }
  }

  // ---------- 工数乖離チェック ----------

  /**
   * 工数合計と勤怠実労働の乖離。60 分超のときのみ符号付き分数を返す（打刻がない日は対象外 = null）。
   * API モードの daySummary はサーバー集計キャッシュ（未ロード時は 0 = null 扱いで、到着後に追従する）。
   * 提出時の確定値はサーバー計算（提出レスポンス）が SoT。
   */
  function hoursGapMinutes(memberId: string, date: string, entries: ReportEntry[]): number | null {
    try {
      const work = useAttendance().daySummary(memberId, date).workMinutes
      if (work <= 0) return null
      const reported = Math.round(entries.reduce((s, e) => s + (Number.isFinite(e.hours) ? e.hours : 0), 0) * 60)
      const gap = reported - work
      return Math.abs(gap) > 60 ? gap : null
    } catch {
      return null
    }
  }

  function gapOf(report: DailyReport): number | null {
    if (report.authorKind !== 'human' || !report.memberId) return null
    return hoursGapMinutes(report.memberId, report.date, report.entries)
  }

  // ---------- 日報 書込系 ----------

  function cleanEntries(entries: ReportEntry[]): ReportEntry[] {
    return entries
      .filter(e => (e.theme ?? '').trim() || e.projectId || e.task.trim())
      .map(e => ({
        theme: [...(e.theme ?? '').trim()].slice(0, 100).join(''),
        projectId: e.projectId ?? '',
        task: e.task.trim(),
        hours: Math.max(0, Math.round((Number.isFinite(e.hours) ? e.hours : 0) * 4) / 4),
        progress: Math.min(100, Math.max(0, Math.round(Number.isFinite(e.progress) ? e.progress : 0))),
      }))
  }

  /** 明日の予定の正規化（空行除去・0.25h 刻み・最大 TOMORROW_PLANS_MAX 件） */
  function cleanTomorrowPlans(plans: TomorrowPlan[] | undefined): TomorrowPlan[] {
    return (plans ?? [])
      .filter(p => p.theme.trim() || p.purpose.trim() || p.task.trim())
      .slice(0, TOMORROW_PLANS_MAX)
      .map(p => ({
        theme: [...p.theme.trim()].slice(0, 100).join(''),
        purpose: p.purpose.trim(),
        task: p.task.trim(),
        hours: Math.max(0, Math.round((Number.isFinite(p.hours) ? p.hours : 0) * 4) / 4),
      }))
  }

  async function upsertDaily(
    input: DailyReportInput,
    status: 'draft' | 'submitted',
  ): Promise<Result & { hoursGapMinutes?: number | null; escalated?: boolean }> {
    const existing = myReportOn(input.date)
    // 提出済みは本人が編集可（提出状態は維持。下書きへ戻す操作のみ不可 = サーバーと同一挙動）
    if (existing && existing.status === 'submitted' && status !== 'submitted') {
      return err('AKO-REP-001', '提出済みの日報は下書きへ戻せません（提出済みのまま編集してください）')
    }
    const entries = cleanEntries(input.entries)
    if (status === 'submitted') {
      if (entries.length === 0) {
        return err('AKO-GEN-001', '作業エントリを 1 行以上入力してください')
      }
      // theme（業務テーマ）が正。旧データ編集の projectId のみも許容する（原則7）
      if (entries.some(e => !(e.theme || e.projectId) || !e.task)) {
        return err('AKO-GEN-001', '各エントリのテーマと内容を入力してください')
      }
    }
    const tomorrowPlans = cleanTomorrowPlans(input.tomorrowPlans)
    if (isApi) {
      // SoT（API）へ書込 → 対象月キャッシュを取り直す（原則6）。提出済み保護はサーバーが FOR UPDATE で最終判定
      try {
        const data = await apiFetch<{ id: string; hoursGapMinutes: number | null; escalated?: boolean }>('/v1/reports/daily', {
          method: 'PUT',
          body: {
            date: input.date,
            entries,
            reflection: input.reflection,
            issues: input.issues,
            tomorrow: input.tomorrow,
            tomorrowPlans,
            status,
          },
        })
        await loadMineMonth(input.date.slice(0, 7), true)
        return { ok: true, id: data.id, hoursGapMinutes: data.hoursGapMinutes, escalated: data.escalated ?? false }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const submittedAt = status === 'submitted' ? nowJstIso() : null
    if (existing) {
      // 初回提出時刻は保持（提出済みの編集で提出時刻を書き換えない）
      dailyReports.value = dailyReports.value.map(r => r.id === existing.id
        ? { ...r, entries, reflection: input.reflection, issues: input.issues, tomorrow: input.tomorrow, tomorrowPlans, status, submittedAt: r.submittedAt ?? submittedAt }
        : r)
      commit()
      return { ok: true, id: existing.id }
    }
    const id = nextId('dailyReports', 'dr')
    dailyReports.value = [...dailyReports.value, {
      id,
      authorKind: 'human',
      memberId: currentUser.value.id,
      aiEmployeeId: null,
      date: input.date,
      entries,
      reflection: input.reflection,
      issues: input.issues,
      tomorrow: input.tomorrow,
      tomorrowPlans,
      status,
      submittedAt,
    }]
    commit()
    return { ok: true, id }
  }

  function saveDraft(input: DailyReportInput): Promise<Result> {
    return upsertDaily(input, 'draft')
  }

  /**
   * 日報提出。提出成立後の補助処理:
   * (a) 課題記入あり → エスカレーション起票（起票成否に関わらず提出は成立）
   * (b) 工数合計と勤怠実労働の乖離 60 分超 → hoursGapMinutes を返す（画面が警告表示）
   * API モード: 乖離・エスカレーション起票ともサーバーが担い、提出レスポンスの値を用いる。
   */
  async function submit(input: DailyReportInput): Promise<SubmitDailyResult> {
    const res = await upsertDaily(input, 'submitted')
    if (!res.ok) return res
    if (isApi) {
      return { ok: true, id: res.id ?? '', escalated: res.escalated ?? false, hoursGapMinutes: res.hoursGapMinutes ?? null }
    }

    let escalated = false
    if (input.issues.trim()) {
      const raised = await useEscalations().raise({
        reason: 'issue_reported',
        targetMemberId: currentUser.value.id,
        context: `日報（${input.date}）で課題の記入: 「${input.issues.trim()}」`,
        dedupeKey: `issue:${currentUser.value.id}:${input.date}`,
      })
      // クールダウン中（AKO-ESC-001）は既に管理者へ共有済みとして扱う
      escalated = raised.ok || (!raised.ok && raised.error.code === 'AKO-ESC-001')
    }
    const gap = hoursGapMinutes(currentUser.value.id, input.date, cleanEntries(input.entries))
    return { ok: true, id: res.id ?? '', escalated, hoursGapMinutes: gap }
  }

  /** リマインド送信（kind 'reminder' 通知。API モードはサーバーが通知を発火する） */
  async function remind(memberId: string, date: string): Promise<Result> {
    if (isApi) {
      return apiResult(() => apiFetch('/v1/reports/remind', { method: 'POST', body: { memberId, date } }))
    }
    notify(memberId, 'reminder', '日報リマインド', `${date} の日報が未提出です。提出をお願いします`, '/reports')
    return { ok: true }
  }

  // ---------- コメント・リアクション ----------

  function commentsOf(reportId: string): ReportComment[] {
    if (isApi) void loadComments(reportId)
    return comments.value
      .filter(c => c.reportId === reportId)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  async function addComment(reportId: string, body: string): Promise<Result> {
    const text = body.trim()
    if (!text) return err('AKO-GEN-001', 'コメントを入力してください')
    if (isApi) {
      // 作成者への通知はサーバーが発火する。書込成立後にスレッドを取り直す（原則6）
      const res = await apiResult(() =>
        apiFetch<{ id: string }>(`/v1/reports/${reportId}/comments`, { method: 'POST', body: { body: text } }))
      if (res.ok) await loadComments(reportId, true)
      return res
    }
    const report = reportById(reportId)
    if (!report) return err('AKO-GEN-002', '対象の日報が見つかりません')
    const id = nextId('reportComments', 'rc')
    comments.value = [...comments.value, {
      id,
      reportId,
      memberId: currentUser.value.id,
      body: text,
      at: nowJstIso(),
      reactions: [],
    }]
    commit()
    // 補助処理: 日報作成者へ通知（自分の日報・AI 日報は除く）
    if (report.authorKind === 'human' && report.memberId && report.memberId !== currentUser.value.id) {
      notify(report.memberId, 'comment', `日報（${report.date}）にコメント`, `${currentUser.value.name}: ${text.slice(0, 60)}`, '/reports')
    }
    return { ok: true, id }
  }

  async function toggleReaction(commentId: string, emoji: string): Promise<Result> {
    if (isApi) {
      // サーバーがトグルを確定し reactions 全量を返す → 該当行のみキャッシュへ反映（原則6）
      try {
        const data = await apiFetch<{ id: string; reactions: ReportComment['reactions'] }>(
          `/v1/reports/comments/${commentId}/reactions`, { method: 'POST', body: { emoji } })
        apiComments.value = apiComments.value.map(c =>
          c.id === commentId ? { ...c, reactions: data.reactions } : c)
        return { ok: true, id: commentId }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const target = comments.value.find(c => c.id === commentId)
    if (!target) return err('AKO-GEN-002', '対象のコメントが見つかりません')
    const me = currentUser.value.id
    const has = target.reactions.some(r => r.memberId === me && r.emoji === emoji)
    const reactions = has
      ? target.reactions.filter(r => !(r.memberId === me && r.emoji === emoji))
      : [...target.reactions, { memberId: me, emoji }]
    comments.value = comments.value.map(c => c.id === commentId ? { ...c, reactions } : c)
    commit()
    return { ok: true, id: commentId }
  }

  // ---------- 週報 ----------

  /** 週の開始日（月曜） */
  function weekStartOf(date: string): string {
    const w = weekdayOf(date)
    return addDays(date, w === 0 ? -6 : 1 - w)
  }

  function myWeeklyOn(weekStart: string): WeeklyReport | undefined {
    return weeklyReports.value.find(r =>
      r.memberId === currentUser.value.id && r.weekStart === weekStart)
  }

  const myWeeklies = computed(() =>
    weeklyReports.value
      .filter(r => r.memberId === currentUser.value.id)
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart)))

  /** 週報を id で取得（全員の週報タブのドロワー用。一覧に出るもの = 参照可のもののみ開かれる前提） */
  function weeklyById(id: string): WeeklyReport | undefined {
    return weeklyReports.value.find(r => r.id === id)
  }

  /**
   * 全員の提出済み週報（オペレーター指示 2026-07-22: 全員の週報タブ）。
   * 参照可否は日報と同じ権限表の「日報・週報の参照対象」（F-16-6 canViewMemberReports）で制御する。
   * 下書きは本人以外に見せない（提出済みのみ）
   */
  function allSubmittedWeeklies(weekStart: string): WeeklyReport[] {
    if (isApi) void loadWeeklyAll(weekStart)
    return weeklyReports.value
      .filter(r => r.status === 'submitted' && r.weekStart === weekStart)
      .filter(r => perms.canViewMemberReports(r.memberId))
      .sort((a, b) => memberName(a.memberId).localeCompare(memberName(b.memberId), 'ja'))
  }

  async function saveWeekly(input: WeeklyReportInput, submitNow: boolean): Promise<Result> {
    const existing = myWeeklyOn(input.weekStart)
    if (existing && existing.status === 'submitted') {
      return err('AKO-REP-002', '提出済みの週報は編集できません')
    }
    if (submitNow && !input.mainWork.trim()) {
      return err('AKO-GEN-001', '主要業務を入力してください')
    }
    const status = submitNow ? 'submitted' as const : 'draft' as const
    if (isApi) {
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/reports/weekly', {
        method: 'PUT',
        body: {
          weekStart: input.weekStart,
          goalReview: input.goalReview,
          mainWork: input.mainWork,
          issues: input.issues,
          nextWeek: input.nextWeek,
          status,
        },
      }))
      if (res.ok) await loadWeekly(true)
      return res
    }
    if (existing) {
      weeklyReports.value = weeklyReports.value.map(r => r.id === existing.id
        ? { ...r, goalReview: input.goalReview, mainWork: input.mainWork, issues: input.issues, nextWeek: input.nextWeek, status }
        : r)
      commit()
      return { ok: true, id: existing.id }
    }
    const id = nextId('weeklyReports', 'wk')
    weeklyReports.value = [...weeklyReports.value, {
      id,
      memberId: currentUser.value.id,
      weekStart: input.weekStart,
      goalReview: input.goalReview,
      mainWork: input.mainWork,
      issues: input.issues,
      nextWeek: input.nextWeek,
      status,
    }]
    commit()
    return { ok: true, id }
  }

  /** その週の自分の日報（entries.task / issues）から週報の下書きを生成 */
  async function draftFromDailies(weekStart: string): Promise<{ mainWork: string; issues: string }> {
    const end = addDays(weekStart, 6)
    if (isApi) {
      // 週が月をまたぐ場合に備えて両端の月をロードしてから射影する
      await Promise.all([loadMineMonth(weekStart.slice(0, 7)), loadMineMonth(end.slice(0, 7))])
    }
    const mine = dailyReports.value
      .filter(r =>
        r.authorKind === 'human'
        && r.memberId === currentUser.value.id
        && r.date >= weekStart && r.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date))
    const tasks: string[] = []
    const issues: string[] = []
    for (const r of mine) {
      for (const e of r.entries) {
        const t = e.task.trim()
        if (t && !tasks.includes(t)) tasks.push(t)
      }
      const i = r.issues.trim()
      if (i && !issues.includes(i)) issues.push(i)
    }
    return {
      mainWork: tasks.map(t => `・${t}`).join('\n'),
      issues: issues.map(t => `・${t}`).join('\n'),
    }
  }

  return {
    dailyReports,
    weeklyReports,
    reportById,
    reportOn,
    myReportOn,
    authorOf,
    memberName,
    recentBusinessDays,
    businessDaysOfWeek,
    teamMembers,
    teamMemberCandidates,
    cellStatus,
    timeline,
    timelineForDates,
    touchTeamDates,
    allSubmitted,
    hoursGapMinutes,
    gapOf,
    saveDraft,
    submit,
    remind,
    commentsOf,
    addComment,
    toggleReaction,
    weekStartOf,
    myWeeklyOn,
    myWeeklies,
    weeklyById,
    allSubmittedWeeklies,
    tomorrowPlansFor,
    saveWeekly,
    draftFromDailies,
  }
}
