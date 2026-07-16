/**
 * シフト表（F-05）: 募集期間の状態機械・希望 CRUD・割当バリデーション・確定公開・本人合意
 * - 期間状態は draft → open → closed → adjusting → published の一方向のみ（transition が唯一の遷移口）
 * - 希望は open かつ締切内のみ、割当は adjusting 中のみ書込可（設定系データとして上書き可）
 * - 確定後の変更は requestChange → 本人 consent の 2 段階（労基法上の本人合意を体感させる）
 * - バリデーション閾値は utils/attendance-calc.ts の定数（requiredBreakMinutes / LEGAL_WEEKLY_MIN / 深夜帯）を再利用
 */
import type {
  Member, Result, ShiftAssignment, ShiftAssignmentStatus, ShiftDemand,
  ShiftPeriod, ShiftPeriodStatus, ShiftWish, ShiftWishKind,
} from '~/types/domain'
import type { Tone } from '~/types/ui'
import {
  LEGAL_WEEKLY_MIN, NIGHT_END_HOUR, NIGHT_START_HOUR, requiredBreakMinutes,
} from '~/utils/attendance-calc'
import { addDays, fmtDate, fmtDateLong, fmtHours, weekdayOf } from '~/utils/format'
import { SHIFT_PERIOD_STATUS_LABELS, SHIFT_WISH_LABELS } from '~/utils/labels'

// ---------- 定数（区分ラベルは labels.ts が SoT。ここは F-05 固有の補完分のみ） ----------

/** 期間状態の正順（この順にしか遷移できない） */
export const SHIFT_STATUS_FLOW: ShiftPeriodStatus[] = ['draft', 'open', 'closed', 'adjusting', 'published']

export const SHIFT_PERIOD_STATUS_TONES: Record<ShiftPeriodStatus, Tone> = {
  draft: 'neutral',
  open: 'info',
  closed: 'warn',
  adjusting: 'brand',
  published: 'ok',
}

/** 状態遷移ボタンの文言（現在状態 → 次へ進める操作名） */
export const SHIFT_NEXT_ACTION_LABELS: Record<ShiftPeriodStatus, string> = {
  draft: '希望受付を開始',
  open: '受付を締め切る',
  closed: '調整を開始',
  adjusting: '確定・公開',
  published: '',
}

export const SHIFT_ASSIGNMENT_STATUS_LABELS: Record<ShiftAssignmentStatus, string> = {
  tentative: '仮割当',
  confirmed: '確定',
  change_requested: '変更申請中',
}

export const SHIFT_ASSIGNMENT_STATUS_TONES: Record<ShiftAssignmentStatus, Tone> = {
  tentative: 'info',
  confirmed: 'ok',
  change_requested: 'warn',
}

/** 調整グリッドの希望マーク（色だけに頼らず記号 + aria ラベルを併記する） */
export const SHIFT_WISH_MARKS: Record<ShiftWishKind, { symbol: string; tone: Tone }> = {
  want: { symbol: '○', tone: 'ok' },
  ng: { symbol: '×', tone: 'crit' },
  either: { symbol: '△', tone: 'warn' },
}

/** 割当バリデーションの結果 1 件。error は割当不可、warn は割当可だが注意喚起 */
export interface ShiftWarning {
  code: string
  level: 'error' | 'warn'
  message: string
}

// ---------- 純粋関数（Vue 非依存） ----------

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** シフト時間帯を分区間へ。終了 <= 開始は日跨ぎとして +24h */
function shiftSpan(from: string, to: string): { start: number; end: number; minutes: number } {
  const start = toMin(from)
  let end = toMin(to)
  if (end <= start) end += 24 * 60
  return { start, end, minutes: end - start }
}

function overlapMin(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** 深夜帯（22:00-翌5:00）との重なり分。end は日跨ぎで 1440 超もあり得る */
function nightOverlapMinutes(start: number, end: number): number {
  const nightEnd = NIGHT_END_HOUR * 60 // 05:00
  const nightStart = NIGHT_START_HOUR * 60 // 22:00
  return overlapMin(start, end, 0, nightEnd) + overlapMin(start, end, nightStart, 24 * 60 + nightEnd)
}

/** 指定日時点の満年齢 */
export function ageAt(birthDate: string, date: string): number {
  let age = Number(date.slice(0, 4)) - Number(birthDate.slice(0, 4))
  if (date.slice(5) < birthDate.slice(5)) age--
  return age
}

/** 期間内の日付キー一覧（開始〜終了、暴走ガード 92 日） */
export function periodDates(p: ShiftPeriod): string[] {
  const dates: string[] = []
  let d = p.startDate
  for (let i = 0; i < 92 && d <= p.endDate; i++) {
    dates.push(d)
    d = addDays(d, 1)
  }
  return dates
}

// ---------- composable 本体 ----------

export function useShifts() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify, notifyAdmins } = useNotifications()
  const periods = tbl('shiftPeriods')
  const wishes = tbl('shiftWishes')
  const assignments = tbl('shiftAssignments')
  const demands = tbl('shiftDemands')
  const members = tbl('members')

  /** 対象スタッフ = アルバイト・パートの在籍者 */
  const staffMembers = computed<Member[]>(() =>
    members.value.filter(m => m.active && m.employmentType === 'parttime'))

  const sortedPeriods = computed<ShiftPeriod[]>(() =>
    [...periods.value].sort((a, b) => b.startDate.localeCompare(a.startDate)))

  /** 管理系操作の権限ガード（UI の v-if だけに頼らず composable 層でも防ぐ） */
  function requireAdmin(): Result | null {
    if (currentUser.value.role !== 'admin') {
      return { ok: false, error: { code: 'AKO-SFT-008', message: 'この操作には管理者権限が必要です' } }
    }
    return null
  }

  function periodById(id: string): ShiftPeriod | undefined {
    return periods.value.find(p => p.id === id)
  }

  function nextStatusOf(p: ShiftPeriod): ShiftPeriodStatus | null {
    const idx = SHIFT_STATUS_FLOW.indexOf(p.status)
    return SHIFT_STATUS_FLOW[idx + 1] ?? null
  }

  /** 締切超過か（締切日当日までは提出可） */
  function wishDeadlinePassed(p: ShiftPeriod): boolean {
    return todayJst() > p.wishDeadline
  }

  // ---------- 期間管理 ----------

  /** 状態機械: draft→open→closed→adjusting→published の正順のみ許可 */
  function transition(periodId: string, next: ShiftPeriodStatus): Result {
    const denied = requireAdmin()
    if (denied) return denied
    const p = periodById(periodId)
    if (!p) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の募集期間が見つかりません' } }
    }
    if (SHIFT_STATUS_FLOW.indexOf(next) !== SHIFT_STATUS_FLOW.indexOf(p.status) + 1) {
      const flow = SHIFT_STATUS_FLOW.map(s => SHIFT_PERIOD_STATUS_LABELS[s]).join('→')
      return {
        ok: false,
        error: {
          code: 'AKO-SFT-002',
          message: `「${SHIFT_PERIOD_STATUS_LABELS[p.status]}」から「${SHIFT_PERIOD_STATUS_LABELS[next]}」へは遷移できません（${flow} の順のみ）`,
        },
      }
    }
    periods.value = periods.value.map(x => x.id === periodId ? { ...x, status: next } : x)
    commit()
    return { ok: true, id: periodId }
  }

  function createPeriod(input: { label: string; startDate: string; endDate: string; wishDeadline: string }): Result {
    const denied = requireAdmin()
    if (denied) return denied
    if (!input.label.trim()) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '期間名を入力してください' } }
    }
    if (!input.startDate || !input.endDate || !input.wishDeadline) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '開始日・終了日・希望締切をすべて入力してください' } }
    }
    if (input.endDate < input.startDate) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '終了日は開始日以降の日付にしてください' } }
    }
    if (input.wishDeadline > input.startDate) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '希望締切は開始日以前の日付にしてください（調整期間の確保）' } }
    }
    const id = nextId('shiftPeriods', 'sp')
    periods.value = [...periods.value, {
      id,
      label: input.label.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      wishDeadline: input.wishDeadline,
      status: 'draft',
    }]
    commit()
    return { ok: true, id }
  }

  // ---------- 希望 CRUD（open 中・締切内のみ） ----------

  function wishOf(periodId: string, memberId: string, date: string): ShiftWish | undefined {
    return wishes.value.find(w => w.periodId === periodId && w.memberId === memberId && w.date === date)
  }

  /** 提出可否の共通ガード */
  function wishGuard(p: ShiftPeriod | undefined, date?: string): Result | null {
    if (!p) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の募集期間が見つかりません' } }
    }
    if (p.status !== 'open') {
      return { ok: false, error: { code: 'AKO-SFT-003', message: '希望の提出・変更は「希望受付中」の期間のみ可能です' } }
    }
    if (wishDeadlinePassed(p)) {
      return { ok: false, error: { code: 'AKO-SFT-003', message: `希望締切（${fmtDateLong(p.wishDeadline)}）を過ぎているため提出できません` } }
    }
    if (date && (date < p.startDate || date > p.endDate)) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '期間外の日付には提出できません' } }
    }
    return null
  }

  /** 希望の提出・更新（同一日への再提出は上書き = 設定系データ） */
  function submitWish(input: {
    periodId: string
    memberId: string
    date: string
    wish: ShiftWishKind
    from?: string | null
    to?: string | null
  }): Result {
    const guard = wishGuard(periodById(input.periodId), input.date)
    if (guard) return guard
    const from = input.wish === 'want' ? (input.from ?? '10:00') : null
    const to = input.wish === 'want' ? (input.to ?? '17:00') : null
    const existing = wishOf(input.periodId, input.memberId, input.date)
    if (existing) {
      wishes.value = wishes.value.map(w =>
        w.id === existing.id ? { ...w, wish: input.wish, from, to } : w)
      commit()
      return { ok: true, id: existing.id }
    }
    const id = nextId('shiftWishes', 'sw')
    wishes.value = [...wishes.value, {
      id, periodId: input.periodId, memberId: input.memberId, date: input.date,
      wish: input.wish, from, to,
    }]
    commit()
    return { ok: true, id }
  }

  /** 希望の取消（締切内のみ） */
  function clearWish(periodId: string, memberId: string, date: string): Result {
    const guard = wishGuard(periodById(periodId), date)
    if (guard) return guard
    const existing = wishOf(periodId, memberId, date)
    if (!existing) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: 'この日の希望は未提出です' } }
    }
    wishes.value = wishes.value.filter(w => w.id !== existing.id)
    commit()
    return { ok: true, id: existing.id }
  }

  // ---------- 割当バリデーション ----------

  /**
   * 割当バリデーション（error = 割当不可 / warn = 割当可だが警告表示）
   * a) 休憩不足（6h超45分・8h超60分） b) 18歳未満の深夜（労基法61条・エラー）
   * c) 週40時間超（同一週の割当合計） d) 本人希望 NG との衝突
   */
  function validateAssign(
    memberId: string,
    date: string,
    from: string,
    to: string,
    opts?: { excludeAssignmentId?: string; periodId?: string },
  ): ShiftWarning[] {
    if (!from || !to || from === to) {
      return [{ code: 'AKO-SFT-007', level: 'error', message: '開始・終了時刻を正しく入力してください' }]
    }
    const list: ShiftWarning[] = []
    const span = shiftSpan(from, to)
    const member = members.value.find(m => m.id === memberId)

    // b) 18歳未満の深夜業（労基法61条）→ 割当不可
    if (member && ageAt(member.birthDate, date) < 18 && nightOverlapMinutes(span.start, span.end) > 0) {
      list.push({
        code: 'AKO-SFT-001',
        level: 'error',
        message: `${member.name} さんは18歳未満のため深夜帯（22:00〜翌5:00）に割当できません（労基法61条）`,
      })
    }

    // a) 休憩不足（労基法34条: 6h超45分 / 8h超60分）
    const reqBreak = requiredBreakMinutes(span.minutes)
    if (reqBreak > 0) {
      list.push({
        code: 'AKO-SFT-W01',
        level: 'warn',
        message: `勤務${fmtHours(span.minutes)}のため休憩${reqBreak}分の確保が必要です`,
      })
    }

    // c) 週40時間超（週 = 日曜起算。今回分を含めた合計で判定）
    const weekStart = addDays(date, -weekdayOf(date))
    const weekEnd = addDays(weekStart, 6)
    const weekTotal = assignments.value
      .filter(a => a.memberId === memberId
        && a.id !== opts?.excludeAssignmentId
        && a.date >= weekStart && a.date <= weekEnd)
      .reduce((sum, a) => sum + shiftSpan(a.from, a.to).minutes, 0) + span.minutes
    if (weekTotal > LEGAL_WEEKLY_MIN) {
      list.push({
        code: 'AKO-SFT-W02',
        level: 'warn',
        message: `同一週（${fmtDate(weekStart)}〜）の割当合計が${fmtHours(weekTotal)}となり週40時間を超えます`,
      })
    }

    // d) 本人希望 NG との衝突（期間指定時は同一期間の希望のみ参照。期間重複作成時の誤警告防止）
    const w = wishes.value.find(x => x.memberId === memberId && x.date === date
      && (!opts?.periodId || x.periodId === opts.periodId))
    if (w?.wish === 'ng') {
      list.push({
        code: 'AKO-SFT-W03',
        level: 'warn',
        message: `本人希望が「${SHIFT_WISH_LABELS.ng}」の日です`,
      })
    }
    return list
  }

  // ---------- 割当 CRUD（adjusting 中のみ） ----------

  function assignmentAt(periodId: string, memberId: string, date: string): ShiftAssignment | undefined {
    return assignments.value.find(a => a.periodId === periodId && a.memberId === memberId && a.date === date)
  }

  /** 割当の作成・更新。エラー級バリデーション（18歳未満深夜）に該当する場合は書き込まない */
  function assign(input: { periodId: string; memberId: string; date: string; from: string; to: string }): Result {
    const denied = requireAdmin()
    if (denied) return denied
    const p = periodById(input.periodId)
    if (!p) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の募集期間が見つかりません' } }
    }
    if (p.status !== 'adjusting') {
      return { ok: false, error: { code: 'AKO-SFT-004', message: '割当の変更は期間が「調整中」のときのみ可能です' } }
    }
    if (input.date < p.startDate || input.date > p.endDate) {
      return { ok: false, error: { code: 'AKO-SFT-007', message: '期間外の日付には割当できません' } }
    }
    const existing = assignmentAt(input.periodId, input.memberId, input.date)
    const fatal = validateAssign(input.memberId, input.date, input.from, input.to, { excludeAssignmentId: existing?.id, periodId: input.periodId })
      .find(x => x.level === 'error')
    if (fatal) {
      return { ok: false, error: { code: fatal.code, message: fatal.message } }
    }
    if (existing) {
      assignments.value = assignments.value.map(a =>
        a.id === existing.id ? { ...a, from: input.from, to: input.to, status: 'tentative' as const, consentAt: null } : a)
      commit()
      return { ok: true, id: existing.id }
    }
    const id = nextId('shiftAssignments', 'sa')
    assignments.value = [...assignments.value, {
      id, periodId: input.periodId, memberId: input.memberId, date: input.date,
      from: input.from, to: input.to, status: 'tentative', consentAt: null,
    }]
    commit()
    return { ok: true, id }
  }

  function unassign(assignmentId: string): Result {
    const denied = requireAdmin()
    if (denied) return denied
    const a = assignments.value.find(x => x.id === assignmentId)
    if (!a) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の割当が見つかりません' } }
    }
    const p = periodById(a.periodId)
    if (!p || p.status !== 'adjusting') {
      return { ok: false, error: { code: 'AKO-SFT-004', message: '割当の解除は期間が「調整中」のときのみ可能です' } }
    }
    assignments.value = assignments.value.filter(x => x.id !== assignmentId)
    commit()
    return { ok: true, id: assignmentId }
  }

  // ---------- 確定・公開 ----------

  /** 確定・公開: adjusting→published + 割当を confirmed + 各スタッフへ通知（通知は非ブロッキング） */
  function publish(periodId: string): Result {
    const p = periodById(periodId)
    if (!p) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の募集期間が見つかりません' } }
    }
    const t = transition(periodId, 'published')
    if (!t.ok) return t
    const targets = new Set<string>()
    assignments.value = assignments.value.map((a) => {
      if (a.periodId !== periodId) return a
      targets.add(a.memberId)
      return a.status === 'confirmed' ? a : { ...a, status: 'confirmed' as const }
    })
    commit()
    // 通知は補助処理: useNotifications 側で失敗を握りつぶす（主フローを止めない）
    for (const memberId of targets) {
      notify(memberId, 'system', 'シフトが確定しました',
        `${p.label}（${fmtDate(p.startDate)}〜${fmtDate(p.endDate)}）のシフトが公開されました`, '/shift')
    }
    return { ok: true, id: periodId }
  }

  // ---------- 確定後変更（本人合意ステップ付き） ----------

  /** 確定済み割当の時間変更を申請する（本人合意が得られるまで change_requested） */
  function requestChange(assignmentId: string, from: string, to: string): Result {
    const denied = requireAdmin()
    if (denied) return denied
    const a = assignments.value.find(x => x.id === assignmentId)
    if (!a) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の割当が見つかりません' } }
    }
    const p = periodById(a.periodId)
    if (!p || p.status !== 'published') {
      return { ok: false, error: { code: 'AKO-SFT-006', message: '確定後変更は公開済みの期間のみ対象です' } }
    }
    if (a.status !== 'confirmed') {
      return { ok: false, error: { code: 'AKO-SFT-006', message: 'この割当は確定状態ではないため変更申請できません' } }
    }
    const fatal = validateAssign(a.memberId, a.date, from, to, { excludeAssignmentId: a.id, periodId: a.periodId })
      .find(x => x.level === 'error')
    if (fatal) {
      return { ok: false, error: { code: fatal.code, message: fatal.message } }
    }
    assignments.value = assignments.value.map(x =>
      x.id === assignmentId ? { ...x, from, to, status: 'change_requested' as const, consentAt: null } : x)
    commit()
    notify(a.memberId, 'system', 'シフト変更の合意依頼',
      `${fmtDateLong(a.date)} のシフトを ${from}〜${to} へ変更する申請があります。確認して合意してください`, '/shift')
    return { ok: true, id: assignmentId }
  }

  /** 本人が変更に合意する（consentAt を記録して confirmed へ） */
  function consent(assignmentId: string): Result {
    const a = assignments.value.find(x => x.id === assignmentId)
    if (!a) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の割当が見つかりません' } }
    }
    if (a.status !== 'change_requested') {
      return { ok: false, error: { code: 'AKO-SFT-006', message: '合意待ちの変更はありません' } }
    }
    if (a.memberId !== currentUser.value.id) {
      return { ok: false, error: { code: 'AKO-SFT-006', message: 'シフト変更への合意は本人のみ行えます（労務上の本人合意）' } }
    }
    assignments.value = assignments.value.map(x =>
      x.id === assignmentId ? { ...x, status: 'confirmed' as const, consentAt: nowJstIso() } : x)
    commit()
    notifyAdmins('system', 'シフト変更に本人が合意',
      `${currentUser.value.name} さんが ${fmtDateLong(a.date)} のシフト変更（${a.from}〜${a.to}）に合意しました`, '/shift')
    return { ok: true, id: assignmentId }
  }

  // ---------- 必要人数（demand）と過不足 ----------

  function demandFor(periodId: string, date: string): ShiftDemand[] {
    return demands.value.filter(d => d.periodId === periodId && d.date === date)
  }

  /** 必要人数の設定（日別 1 スロットの簡易編集。0 人で削除 = 設定系データ） */
  function setDemand(periodId: string, date: string, from: string, to: string, required: number): Result {
    const denied = requireAdmin()
    if (denied) return denied
    const p = periodById(periodId)
    if (!p) {
      return { ok: false, error: { code: 'AKO-SFT-005', message: '対象の募集期間が見つかりません' } }
    }
    const existing = demandFor(periodId, date)[0]
    if (required <= 0) {
      if (existing) {
        demands.value = demands.value.filter(d => d.id !== existing.id)
        commit()
      }
      return { ok: true, id: existing?.id }
    }
    if (existing) {
      demands.value = demands.value.map(d =>
        d.id === existing.id ? { ...d, from, to, required } : d)
      commit()
      return { ok: true, id: existing.id }
    }
    const id = nextId('shiftDemands', 'sd')
    demands.value = [...demands.value, { id, periodId, date, from, to, required }]
    commit()
    return { ok: true, id }
  }

  /** 日別の必要人数 vs 割当人数（過不足バーの元データ） */
  function dayCoverage(periodId: string): { date: string; weekday: number; required: number; assigned: number; diff: number }[] {
    const p = periodById(periodId)
    if (!p) return []
    return periodDates(p).map((date) => {
      const required = demandFor(periodId, date).reduce((s, d) => s + d.required, 0)
      const assigned = assignments.value.filter(a => a.periodId === periodId && a.date === date).length
      return { date, weekday: weekdayOf(date), required, assigned, diff: assigned - required }
    })
  }

  // ---------- 本人ビュー ----------

  /** 本人の確定シフト（published 期間の割当のみ・日付昇順） */
  function myAssignments(memberId: string): (ShiftAssignment & { periodLabel: string })[] {
    const published = new Map(periods.value.filter(p => p.status === 'published').map(p => [p.id, p]))
    return assignments.value
      .filter(a => a.memberId === memberId && published.has(a.periodId))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(a => ({ ...a, periodLabel: published.get(a.periodId)!.label }))
  }

  return {
    // 状態
    periods, wishes, assignments, demands, staffMembers, sortedPeriods,
    // 参照
    periodById, nextStatusOf, wishDeadlinePassed, wishOf, assignmentAt, demandFor, dayCoverage, myAssignments,
    // 期間
    transition, createPeriod, publish,
    // 希望
    submitWish, clearWish,
    // 割当
    validateAssign, assign, unassign, requestChange, consent, setDemand,
  }
}
