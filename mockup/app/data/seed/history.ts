/**
 * 履歴系シードデータ（決定的生成）
 * 「今日」を基準に過去分を生成するが、内容は rng（キー付きハッシュ）で決定的。
 * リロードしても同じ日なら同じ世界が再現される。
 */
import type { CalendarEvent, LeaveGrant, PunchRecord, SalesMonthly, UptimeDaily } from '~/types/domain'
import { addDays, toDateKey, weekdayOf } from '~/utils/format'
import { leaveGrantDays } from '~/utils/attendance-calc'
import { irange, pick, unit } from '~/utils/rng'
import { seedAttendanceRules, seedCompanies, seedMembers, seedProjects, seedSystemServices } from './core'

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** シード生成の基準日（実行日の 0:00） */
export function seedToday(): string {
  return todayJst()
}

/** 過去 N 日分の打刻履歴（今日は含めない = 今日はユーザーが操作する） */
export function buildPunchHistory(days = 45): PunchRecord[] {
  const rows: PunchRecord[] = []
  const today = seedToday()
  const targets = seedMembers.filter(m => m.punchRequired && m.active)
  for (let i = days; i >= 1; i--) {
    const date = addDays(today, -i)
    const dow = weekdayOf(date)
    for (const m of targets) {
      const isParttime = m.employmentType === 'parttime'
      // 土日は原則休み。アルバイトは週所定日数に応じて出勤日を間引く
      if (dow === 0 || dow === 6) continue
      if (isParttime && unit(`${m.id}:${date}:attend`) > m.weeklyDays / 5) continue
      if (!isParttime && unit(`${m.id}:${date}:absent`) < 0.03) continue // まれな休暇

      // 個別割当ルール（時短等）があるメンバーは、そのルールの所定時間で生成する
      const assignedRule = m.attendanceRuleId
        ? seedAttendanceRules.find(r => r.id === m.attendanceRuleId)
        : undefined
      const startHour = isParttime
        ? 10
        : assignedRule
          ? Math.floor(toMinutes(assignedRule.workStart) / 60)
          : 9 + (unit(`${m.id}:${date}:st`) > 0.6 ? 1 : 0)
      const startMin = assignedRule
        ? toMinutes(assignedRule.workStart) % 60
        : irange(`${m.id}:${date}:sm`, 0, 25)
      // 忙しいメンバー（開発部）はやや残業が多い分布にする。時短者の残業は控えめに
      const busy = m.dept === 'システム開発部' ? 1.5 : 1
      const otMin = isParttime
        ? 0
        : assignedRule
          ? irange(`${m.id}:${date}:ot`, 0, 30)
          : Math.floor(irange(`${m.id}:${date}:ot`, 0, 90) * busy)
      const workHours = isParttime
        ? irange(`${m.id}:${date}:wh`, 4, 6)
        : assignedRule
          ? (toMinutes(assignedRule.workEnd) - toMinutes(assignedRule.workStart) - assignedRule.breakMinutes) / 60
          : 8
      const breakMin = isParttime ? (workHours > 6 ? 60 : 0) : (assignedRule ? assignedRule.breakMinutes : 60)

      const mk = (h: number, mi: number): string => {
        const hh = String(Math.floor(h + mi / 60)).padStart(2, '0')
        const mm = String(mi % 60).padStart(2, '0')
        return `${date}T${hh}:${mm}:00+09:00`
      }
      const startTotalMin = startHour * 60 + startMin
      const endTotalMin = startTotalMin + workHours * 60 + breakMin + otMin

      rows.push({ id: `pch-${m.id}-${date}-in`, memberId: m.id, date, kind: 'in', at: mk(0, startTotalMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
      if (breakMin > 0) {
        rows.push({ id: `pch-${m.id}-${date}-bs`, memberId: m.id, date, kind: 'break_start', at: mk(0, startTotalMin + 3.5 * 60), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
        rows.push({ id: `pch-${m.id}-${date}-be`, memberId: m.id, date, kind: 'break_end', at: mk(0, startTotalMin + 3.5 * 60 + breakMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
      }
      rows.push({ id: `pch-${m.id}-${date}-out`, memberId: m.id, date, kind: 'out', at: mk(0, endTotalMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
    }
  }
  return rows
}

/** 有給付与（労基法 39 条テーブルに基づく直近付与分） */
export function buildLeaveGrants(): LeaveGrant[] {
  const rows: LeaveGrant[] = []
  const today = seedToday()
  for (const m of seedMembers.filter(x => x.active && x.employmentType !== 'outsource')) {
    const hire = new Date(`${m.hireDate}T00:00:00`)
    const now = new Date(`${today}T00:00:00`)
    const serviceYears = (now.getTime() - hire.getTime()) / (365.25 * 24 * 3600 * 1000)
    // 直近 2 回分の付与を生成（時効 2 年以内のもの）
    for (let back = 0; back < 2; back++) {
      const grantAtYears = Math.floor((serviceYears - 0.5) * 1) - back
      if (grantAtYears < 0) continue
      const grantServiceYears = grantAtYears + 0.5
      const days = leaveGrantDays(m.weeklyDays, m.weeklyHours, grantServiceYears)
      if (days <= 0) continue
      const grantDate = new Date(hire)
      grantDate.setMonth(grantDate.getMonth() + 6 + grantAtYears * 12)
      const expire = new Date(grantDate)
      expire.setFullYear(expire.getFullYear() + 2)
      rows.push({
        id: `lg-${m.id}-${grantAtYears}`,
        memberId: m.id,
        grantDate: toDateKey(grantDate),
        days,
        kind: m.weeklyHours >= 30 || m.weeklyDays >= 5 ? 'normal' : 'proportional',
        expireDate: toDateKey(expire),
      })
    }
  }
  return rows
}

/** 月次売上（過去 24 ヶ月 + 当月。決定的モック） */
export function buildSalesMonthly(): SalesMonthly[] {
  const rows: SalesMonthly[] = []
  const today = seedToday()
  const [y0, m0] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const customers = seedCompanies.filter(c => c.kind === 'customer')
  for (let back = 24; back >= 0; back--) {
    const d = new Date(y0, m0 - 1 - back, 1)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    for (const pj of seedProjects.filter(p => p.type !== 'internal')) {
      // プロジェクト期間外の月はスキップ
      if (month < pj.startDate.slice(0, 7)) continue
      if (pj.endDate && month > pj.endDate.slice(0, 7)) continue
      const base = pj.budget > 0 ? pj.budget / 14 : 900000
      const seasonal = 1 + 0.18 * Math.sin((d.getMonth() + 1) / 12 * Math.PI * 2)
      const noise = 0.82 + unit(`sales:${pj.id}:${month}`) * 0.36
      const growth = 1 + (24 - back) * 0.006
      const amount = Math.round(base * seasonal * noise * growth / 10000) * 10000
      const costRate = 0.55 + unit(`cost:${pj.id}:${month}`) * 0.15
      const company = customers.find(c => c.id === pj.companyId)
      rows.push({ month, projectType: pj.type, companyId: company?.id ?? pj.companyId, amount, cost: Math.round(amount * costRate) })
    }
  }
  return rows
}


/**
 * Google カレンダー予定（モック・決定的生成）。
 * 昨日〜明日+1 の平日に、メンバーの参加プロジェクトから定例・作業ブロックを生成する。
 * id は決定的（gcal-{member}-{date}-{n}）で、再同期時のべき等 upsert キーになる。
 */
export function buildCalendarEvents(): CalendarEvent[] {
  const rows: CalendarEvent[] = []
  const today = seedToday()
  const targets = seedMembers.filter(m => m.active && m.employmentType !== 'outsource' && m.employmentType !== 'parttime')
  for (let offset = -2; offset <= 2; offset++) {
    const date = addDays(today, offset)
    const dow = weekdayOf(date)
    if (dow === 0 || dow === 6) continue
    for (const m of targets) {
      const myProjects = seedProjects.filter(p => p.active && p.status === 'active' && p.memberIds.includes(m.id))
      let n = 0
      const push = (from: string, to: string, title: string, projectId: string | null): void => {
        rows.push({
          id: `gcal-${m.id}-${date}-${n++}`,
          memberId: m.id, date, from, to, title,
          source: 'google', syncedToGoogle: true, projectId,
        })
      }
      // 定例（プロジェクト起点。日によって 1 件目 or 2 件目を選ぶ）
      const pj = myProjects[irange(`cal:${m.id}:${date}:pj`, 0, Math.max(0, myProjects.length - 1))]
      if (pj && unit(`cal:${m.id}:${date}:mtg`) > 0.25) {
        const company = seedCompanies.find(c => c.id === pj.companyId)
        push('10:00', '11:00', `${company?.name ?? '社内'} 定例`, pj.id)
      }
      // 作業ブロック（タイトルにプロジェクト名を含める = AI のタイトル推定デモ用に projectId は持たせない）
      if (pj) {
        push('13:00', unit(`cal:${m.id}:${date}:long`) > 0.5 ? '16:00' : '15:00', `${pj.name.slice(0, 12)} 作業`, null)
      }
      // 社内予定
      if (unit(`cal:${m.id}:${date}:internal`) > 0.6) {
        push('17:00', '17:30', '社内共有会', null)
      }
    }
  }
  return rows
}

/** サービス別の日次稼働状況（過去 90 日。決定的モック） */
export function buildUptimeDaily(): UptimeDaily[] {
  const rows: UptimeDaily[] = []
  const today = seedToday()
  for (const svc of seedSystemServices) {
    for (let i = 90; i >= 1; i--) {
      const date = addDays(today, -i)
      const r = unit(`up:${svc.id}:${date}`)
      let worstState: UptimeDaily['worstState'] = 'operational'
      let downMinutes = 0
      if (r > 0.985) {
        worstState = pick(`upkind:${svc.id}:${date}`, ['partial_outage', 'major_outage'] as const)
        downMinutes = irange(`updown:${svc.id}:${date}`, 30, 240)
      } else if (r > 0.955) {
        worstState = 'degraded'
        downMinutes = irange(`updeg:${svc.id}:${date}`, 5, 45)
      } else if (weekdayOf(date) === 0 && r > 0.87) {
        worstState = 'maintenance'
        downMinutes = 0
      }
      rows.push({ serviceId: svc.id, date, downMinutes, worstState })
    }
  }
  return rows
}
