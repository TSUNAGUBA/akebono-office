/**
 * 勤怠（打刻・日次/月次集計・36 協定アラート・修正申請）
 * 集計ロジックは utils/attendance-calc.ts の純粋関数に委譲する。
 */
import type { PunchKind, PunchRecord, Result } from '~/types/domain'
import {
  calcWorkedMinutes, effectivePunches, judgeArticle36, requiredBreakMinutes, splitBuckets,
  type Article36Alert, type MonthOtRecord,
} from '~/utils/attendance-calc'
import { daysInMonth, weekdayOf } from '~/utils/format'
import { PUNCH_KIND_LABELS } from '~/utils/labels'

export type PunchState = 'before' | 'working' | 'breaking' | 'done'

export interface DaySummary {
  date: string
  workMinutes: number
  breakMinutes: number
  nightMinutes: number
  buckets: ReturnType<typeof splitBuckets>
  breakShortage: number
  punches: PunchRecord[]
}

export function useAttendance() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notifyAdmins } = useNotifications()
  const punches = tbl('punches')
  const fixRequests = tbl('attendanceFixRequests')
  const rules = tbl('attendanceRules')

  function ruleFor(memberId: string) {
    const members = tbl('members')
    const m = members.value.find(x => x.id === memberId)
    return rules.value.find(r => r.active && m && r.appliesTo.includes(m.employmentType)) ?? rules.value[0]
  }

  /**
   * その日の有効な打刻列を返す（表示射影）。
   * 修正打刻（source==='fix'）が承認された場合、元レコードは削除せず保全し、
   * 置換の解決は effectivePunches（純粋関数・fix の連鎖対応）に委譲する（記録系は追記のみ）。
   */
  function punchesOf(memberId: string, date: string): PunchRecord[] {
    return effectivePunches(punches.value.filter(p => p.memberId === memberId && p.date === date))
  }

  /** 修正で置換された旧打刻も含む生の打刻列（履歴表示用） */
  function punchesRawOf(memberId: string, date: string): PunchRecord[] {
    return punches.value
      .filter(p => p.memberId === memberId && p.date === date)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  /** 打刻の状態機械（未出勤→勤務中⇄休憩中→退勤済） */
  function punchState(memberId: string, date: string): PunchState {
    const rows = punchesOf(memberId, date)
    const last = rows[rows.length - 1]
    if (!last) return 'before'
    if (last.kind === 'out') return 'done'
    if (last.kind === 'break_start') return 'breaking'
    return 'working'
  }

  const ALLOWED: Record<PunchState, PunchKind[]> = {
    before: ['in'],
    working: ['break_start', 'out'],
    breaking: ['break_end'],
    done: [],
  }

  /** 打刻する（状態機械ガード付き。二重打刻は no-op エラー） */
  function punch(kind: PunchKind, source: 'web' | 'mobile' = 'web'): Result {
    const memberId = currentUser.value.id
    const date = todayJst()
    const state = punchState(memberId, date)
    if (!ALLOWED[state].includes(kind)) {
      return { ok: false, error: { code: 'AKO-ATT-001', message: `現在の状態では「${PUNCH_KIND_LABELS[kind]}」はできません` } }
    }
    const id = nextId('punches', 'pch-u')
    punches.value = [...punches.value, {
      id, memberId, date, kind,
      at: nowJstIso(),
      source, fixedFrom: null, fixReason: null, approvedBy: null,
    }]
    commit()
    return { ok: true, id }
  }

  /** 日次サマリ（6 バケット分解） */
  function daySummary(memberId: string, date: string, monthOtSoFar = 0): DaySummary {
    const rows = punchesOf(memberId, date)
    const { workMinutes, breakMinutes, nightMinutes } = calcWorkedMinutes(rows)
    const rule = ruleFor(memberId)
    const scheduled = rule ? Math.max(0, toMin(rule.workEnd) - toMin(rule.workStart) - rule.breakMinutes) : 480
    const isLegalHoliday = weekdayOf(date) === (rule?.legalHolidayWeekday ?? 0)
    const buckets = splitBuckets({
      workMinutes, scheduledMinutes: scheduled, nightMinutes, isLegalHoliday,
      monthNonStatutoryOtSoFar: monthOtSoFar,
    })
    const required = requiredBreakMinutes(workMinutes)
    return {
      date, workMinutes, breakMinutes, nightMinutes, buckets,
      breakShortage: Math.max(0, required - breakMinutes),
      punches: rows,
    }
  }

  /** 月次サマリ（日別 + 合計） */
  function monthSummary(memberId: string, month: string) {
    const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
    const days: DaySummary[] = []
    let otSoFar = 0
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`
      const s = daySummary(memberId, date, otSoFar)
      otSoFar += s.buckets.nonStatutoryOt + s.buckets.over60Ot
      days.push(s)
    }
    const total = days.reduce((acc, s) => ({
      scheduled: acc.scheduled + s.buckets.scheduled,
      statutoryOt: acc.statutoryOt + s.buckets.statutoryOt,
      nonStatutoryOt: acc.nonStatutoryOt + s.buckets.nonStatutoryOt,
      over60Ot: acc.over60Ot + s.buckets.over60Ot,
      night: acc.night + s.buckets.night,
      legalHoliday: acc.legalHoliday + s.buckets.legalHoliday,
    }), { scheduled: 0, statutoryOt: 0, nonStatutoryOt: 0, over60Ot: 0, night: 0, legalHoliday: 0 })
    return { days, total, workDays: days.filter(s => s.workMinutes > 0).length }
  }

  /**
   * 36 協定アラート（endMonth を最終月とする直近 6 ヶ月）
   * @param endMonth YYYY-MM。省略時は JST の当月（閲覧環境の TZ に依存させない）
   */
  function alerts(memberId: string, endMonth?: string): Article36Alert[] {
    const base = endMonth ?? todayJst().slice(0, 7)
    const [ey, em] = [Number(base.slice(0, 4)), Number(base.slice(5, 7))]
    const months: MonthOtRecord[] = []
    let over45 = 0
    for (let back = 5; back >= 0; back--) {
      const idx = ey * 12 + (em - 1) - back
      const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
      const s = monthSummary(memberId, month)
      const rec = {
        month,
        nonStatutoryOtMin: s.total.nonStatutoryOt + s.total.over60Ot,
        legalHolidayMin: s.total.legalHoliday,
      }
      months.push(rec)
      // 45h ちょうどは「以内」で適法のため、年 6 回カウントも厳密に「超」のみ（judgeArticle36 と統一）
      if (rec.nonStatutoryOtMin > 45 * 60) over45++
    }
    return judgeArticle36(months, over45)
  }

  /** 残業アラートをエスカレーションへ連携（補助処理・冪等） */
  function raiseOvertimeEscalations(memberId: string): void {
    const found = alerts(memberId)
    if (found.length === 0) return
    const { raise } = useEscalations()
    const month = todayJst().slice(0, 7)
    raise({
      reason: 'overtime_alert',
      targetMemberId: memberId,
      context: `36協定アラート: ${found.map(a => a.message).join(' / ')}`,
      dedupeKey: `overtime:${memberId}:${month}`,
    })
  }

  /** 打刻修正申請（理由必須・承認後に反映） */
  function requestFix(input: { date: string; kind: PunchKind; requestedAt: string; reason: string }): Result {
    if (!input.reason.trim()) {
      return { ok: false, error: { code: 'AKO-ATT-002', message: '修正理由を入力してください（客観的記録の担保）' } }
    }
    const id = nextId('attendanceFixRequests', 'fix')
    fixRequests.value = [...fixRequests.value, {
      id, memberId: currentUser.value.id,
      date: input.date, kind: input.kind, requestedAt: input.requestedAt,
      reason: input.reason, status: 'pending', decidedBy: null,
    }]
    commit()
    notifyAdmins('approval', '打刻修正申請', `${currentUser.value.name} さんから ${input.date} の修正申請`, '/attendance')
    return { ok: true, id }
  }

  /**
   * 修正申請の承認/却下（管理者）。
   * 承認時は修正打刻を追記するのみで元打刻は削除しない（記録系は追記のみ）。
   * 集計・表示への反映は punchesOf の射影（fixedFrom 一致の旧打刻を除外）が担う。
   */
  function decideFix(fixId: string, action: 'approved' | 'rejected'): Result {
    if (currentUser.value.role !== 'admin') {
      return { ok: false, error: { code: 'AKO-ATT-004', message: 'この操作には管理者権限が必要です' } }
    }
    const req = fixRequests.value.find(f => f.id === fixId)
    if (!req || req.status !== 'pending') {
      return { ok: false, error: { code: 'AKO-ATT-003', message: 'この申請は処理済みです' } }
    }
    if (action === 'approved') {
      // 置換対象 = 現在有効な同種打刻（fix の連鎖時も punchesOf が最新のみを返すため正しく繋がる）
      const existing = punchesOf(req.memberId, req.date).find(p => p.kind === req.kind)
      punches.value = [...punches.value, {
        id: nextId('punches', 'pch-u'),
        memberId: req.memberId, date: req.date, kind: req.kind,
        at: req.requestedAt, source: 'fix',
        fixedFrom: existing?.at ?? null, fixReason: req.reason,
        approvedBy: currentUser.value.id,
      }]
    }
    fixRequests.value = fixRequests.value.map(f => f.id === fixId
      ? { ...f, status: action, decidedBy: currentUser.value.id }
      : f)
    commit()
    return { ok: true, id: fixId }
  }

  return {
    punches, fixRequests, ruleFor, punchesOf, punchesRawOf, punchState, punch,
    daySummary, monthSummary, alerts, raiseOvertimeEscalations, requestFix, decideFix,
  }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
