/**
 * 日報・週報（F-06）
 * - 提出済みの日報・週報は編集不可（記録系の状態保護）
 * - 提出時の課題エスカレーション・通知は主フロー成立後の補助処理（非ブロッキング）
 * - 工数合計と勤怠実労働の乖離チェック（60 分超で warning を画面へ返す）
 */
import type {
  DailyReport, ReportComment, ReportEntry, Result, WeeklyReport,
} from '~/types/domain'
import { addDays, toDateKey, weekdayOf } from '~/utils/format'

export interface DailyReportInput {
  date: string
  entries: ReportEntry[]
  reflection: string
  issues: string
  tomorrow: string
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
  const dailyReports = tbl('dailyReports')
  const weeklyReports = tbl('weeklyReports')
  const comments = tbl('reportComments')
  const members = tbl('members')
  const aiEmployees = tbl('aiEmployees')

  function err(code: string, message: string): Result {
    return { ok: false, error: { code, message } }
  }

  // ---------- 参照系 ----------

  function reportById(id: string): DailyReport | undefined {
    return dailyReports.value.find(r => r.id === id)
  }

  function reportOn(memberId: string, date: string): DailyReport | undefined {
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
    let d = toDateKey(new Date())
    while (days.length < n) {
      const w = weekdayOf(d)
      if (w !== 0 && w !== 6) days.unshift(d)
      d = addDays(d, -1)
    }
    return days
  }

  /** 提出状況マトリクスの対象メンバー（在籍中の社員・契約・アルバイト） */
  const teamMembers = computed(() =>
    members.value.filter(m =>
      m.active && m.employmentType !== 'outsource' && m.employmentType !== 'director'))

  function cellStatus(memberId: string, date: string): SubmissionCell {
    const r = reportOn(memberId, date)
    if (!r) return 'none'
    return r.status === 'submitted' ? 'submitted' : 'draft'
  }

  /** チームタイムライン（直近営業日分の提出済み日報。AI 社員の日報も同列に混在） */
  function timeline(days = 7): DailyReport[] {
    const range = new Set(recentBusinessDays(days))
    return dailyReports.value
      .filter(r => r.status === 'submitted' && range.has(r.date))
      .sort((a, b) =>
        b.date.localeCompare(a.date)
        || (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''))
  }

  // ---------- 工数乖離チェック ----------

  /** 工数合計と勤怠実労働の乖離。60 分超のときのみ符号付き分数を返す（打刻がない日は対象外 = null） */
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
      .filter(e => e.projectId || e.task.trim())
      .map(e => ({
        projectId: e.projectId,
        task: e.task.trim(),
        hours: Math.max(0, Math.round((Number.isFinite(e.hours) ? e.hours : 0) * 4) / 4),
        progress: Math.min(100, Math.max(0, Math.round(Number.isFinite(e.progress) ? e.progress : 0))),
      }))
  }

  function upsertDaily(input: DailyReportInput, status: 'draft' | 'submitted'): Result {
    const existing = myReportOn(input.date)
    if (existing && existing.status === 'submitted') {
      return err('AKO-REP-001', '提出済みの日報は編集できません')
    }
    const entries = cleanEntries(input.entries)
    if (status === 'submitted') {
      if (entries.length === 0) {
        return err('AKO-GEN-001', '作業エントリを 1 行以上入力してください')
      }
      if (entries.some(e => !e.projectId || !e.task)) {
        return err('AKO-GEN-001', '各エントリのプロジェクトと作業内容を入力してください')
      }
    }
    const submittedAt = status === 'submitted' ? new Date().toISOString() : null
    if (existing) {
      dailyReports.value = dailyReports.value.map(r => r.id === existing.id
        ? { ...r, entries, reflection: input.reflection, issues: input.issues, tomorrow: input.tomorrow, status, submittedAt }
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
      status,
      submittedAt,
    }]
    commit()
    return { ok: true, id }
  }

  function saveDraft(input: DailyReportInput): Result {
    return upsertDaily(input, 'draft')
  }

  /**
   * 日報提出。提出成立後の補助処理:
   * (a) 課題記入あり → エスカレーション起票（起票成否に関わらず提出は成立）
   * (b) 工数合計と勤怠実労働の乖離 60 分超 → hoursGapMinutes を返す（画面が警告表示）
   */
  function submit(input: DailyReportInput): SubmitDailyResult {
    const res = upsertDaily(input, 'submitted')
    if (!res.ok) return res

    let escalated = false
    if (input.issues.trim()) {
      const raised = useEscalations().raise({
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

  /** リマインド送信（kind 'reminder' 通知） */
  function remind(memberId: string, date: string): Result {
    notify(memberId, 'reminder', '日報リマインド', `${date} の日報が未提出です。提出をお願いします`, '/reports')
    return { ok: true }
  }

  // ---------- コメント・リアクション ----------

  function commentsOf(reportId: string): ReportComment[] {
    return comments.value
      .filter(c => c.reportId === reportId)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  function addComment(reportId: string, body: string): Result {
    const text = body.trim()
    if (!text) return err('AKO-GEN-001', 'コメントを入力してください')
    const report = reportById(reportId)
    if (!report) return err('AKO-GEN-002', '対象の日報が見つかりません')
    const id = nextId('reportComments', 'rc')
    comments.value = [...comments.value, {
      id,
      reportId,
      memberId: currentUser.value.id,
      body: text,
      at: new Date().toISOString(),
      reactions: [],
    }]
    commit()
    // 補助処理: 日報作成者へ通知（自分の日報・AI 日報は除く）
    if (report.authorKind === 'human' && report.memberId && report.memberId !== currentUser.value.id) {
      notify(report.memberId, 'comment', `日報（${report.date}）にコメント`, `${currentUser.value.name}: ${text.slice(0, 60)}`, '/reports')
    }
    return { ok: true, id }
  }

  function toggleReaction(commentId: string, emoji: string): Result {
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

  function saveWeekly(input: WeeklyReportInput, submitNow: boolean): Result {
    const existing = myWeeklyOn(input.weekStart)
    if (existing && existing.status === 'submitted') {
      return err('AKO-REP-002', '提出済みの週報は編集できません')
    }
    if (submitNow && !input.mainWork.trim()) {
      return err('AKO-GEN-001', '主要業務を入力してください')
    }
    const status = submitNow ? 'submitted' as const : 'draft' as const
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
  function draftFromDailies(weekStart: string): { mainWork: string; issues: string } {
    const end = addDays(weekStart, 6)
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
    teamMembers,
    cellStatus,
    timeline,
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
    saveWeekly,
    draftFromDailies,
  }
}
