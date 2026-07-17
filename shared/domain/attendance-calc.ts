/**
 * 勤怠計算（純粋関数・Vue 非依存）
 * 法的根拠: 労基法 32/36/37/39 条・安衛法 66 条の 8 の 3
 * 設計: .ai-native/outputs/phase5/data-design.md（fact_attendance の 6 バケット）
 */
import type { AttendanceBuckets, PunchRecord } from './types'

export const LEGAL_DAILY_MIN = 8 * 60 // 法定労働時間/日
export const LEGAL_WEEKLY_MIN = 40 * 60 // 法定労働時間/週
export const OT_MONTHLY_LIMIT_MIN = 45 * 60 // 36協定 原則月上限
export const OT_MONTHLY_HARD_LIMIT_MIN = 100 * 60 // 特別条項 単月上限（未満）
export const OT_AVG_LIMIT_MIN = 80 * 60 // 2〜6ヶ月平均上限
export const OT_OVER45_MAX_COUNT = 6 // 月45h超は年6回まで
export const OVER60_THRESHOLD_MIN = 60 * 60 // 割増50%の閾値（月60h超）
export const NIGHT_START_HOUR = 22
export const NIGHT_END_HOUR = 5

/**
 * 有効打刻の射影（修正打刻による置換の解決）。
 * fix レコードの fixedFrom は「置換した旧打刻の at」を保持する。
 * fix を追記順（= 承認順）に適用し、その時点で未置換の同種・同時刻レコードを
 * 1 件だけ無効化する（レコード id 単位の解決）。候補は常に同一 at を持つため
 * 入力が安定ソートで並べ替えられていても結果の id 集合は不変。これにより
 * 通常の連鎖（fix の fix）だけでなく、元の時刻へ戻す差戻し連鎖
 * （at の再利用でキーが衝突するケース）でも最新の fix だけが有効になる。
 */
export function effectivePunches(rows: PunchRecord[]): PunchRecord[] {
  const superseded = new Set<string>() // 置換された（無効化された）レコードの id
  for (const p of rows) {
    if (p.source !== 'fix' || !p.fixedFrom) continue
    const target = rows.find(q =>
      q.id !== p.id && !superseded.has(q.id) && q.kind === p.kind && q.at === p.fixedFrom)
    if (target) superseded.add(target.id)
  }
  return rows
    .filter(p => !superseded.has(p.id))
    .sort((a, b) => a.at.localeCompare(b.at))
}

export interface DayWorkInput {
  /** 実労働分（休憩除く） */
  workMinutes: number
  /** 所定労働分 */
  scheduledMinutes: number
  /** 深夜帯（22-5時）に含まれる労働分 */
  nightMinutes: number
  /** 法定休日か */
  isLegalHoliday: boolean
  /** 当月のこの日までの法定外残業累計分（60h超判定用） */
  monthNonStatutoryOtSoFar: number
}

/** 1 日分の勤務を 6 バケットへ分解する */
export function splitBuckets(input: DayWorkInput): AttendanceBuckets {
  const b: AttendanceBuckets = {
    scheduled: 0, statutoryOt: 0, nonStatutoryOt: 0, over60Ot: 0, night: 0, legalHoliday: 0,
  }
  if (input.isLegalHoliday) {
    // 法定休日労働に時間外の概念はない（全時間が休日労働 35% 扱い）
    b.legalHoliday = input.workMinutes
    b.night = input.nightMinutes
    return b
  }
  b.scheduled = Math.min(input.workMinutes, input.scheduledMinutes)
  const beyondScheduled = Math.max(0, input.workMinutes - input.scheduledMinutes)
  // 所定超〜法定内 = 法定内残業（割増なし）
  const statutoryRoom = Math.max(0, LEGAL_DAILY_MIN - input.scheduledMinutes)
  b.statutoryOt = Math.min(beyondScheduled, statutoryRoom)
  // 法定超 = 法定外残業（25%）。月60h超過分は 50% バケットへ
  const nonStatutory = Math.max(0, beyondScheduled - statutoryRoom)
  const roomTo60 = Math.max(0, OVER60_THRESHOLD_MIN - input.monthNonStatutoryOtSoFar)
  b.nonStatutoryOt = Math.min(nonStatutory, roomTo60)
  b.over60Ot = Math.max(0, nonStatutory - roomTo60)
  b.night = input.nightMinutes
  return b
}

/** 打刻列から実労働分・休憩分を求める（同日内・時刻順で解釈） */
export function calcWorkedMinutes(punches: PunchRecord[]): { workMinutes: number; breakMinutes: number; nightMinutes: number } {
  const sorted = [...punches].sort((a, b) => a.at.localeCompare(b.at))
  let inAt: Date | null = null
  let breakStart: Date | null = null
  let work = 0
  let brk = 0
  let night = 0
  let outSeen = false

  // 深夜帯（22:00-24:00 / 0:00-5:00）との重なりを分で返す。
  // 打刻はウォールクロック（+09:00 の壁時計時刻）が正のため、
  // 実行環境の TZ に依存する Date#getHours ではなく文字列の時刻を使う。
  const clockMinOf = (iso: string): number => {
    const m = iso.match(/T(\d{2}):(\d{2})/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0
  }
  const nightOverlap = (fromIso: string, durationMin: number): number => {
    const start = clockMinOf(fromIso)
    let total = 0
    for (let i = 0; i < durationMin; i++) {
      const h = Math.floor(((start + i) % 1440) / 60)
      if (h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR) total++
    }
    return total
  }

  let inIso: string | null = null
  for (const p of sorted) {
    const at = new Date(p.at)
    if (p.kind === 'in') {
      inAt = at
      inIso = p.at
      outSeen = false
    } else if (p.kind === 'break_start' && inAt && !breakStart) {
      const seg = Math.max(0, Math.round((at.getTime() - inAt.getTime()) / 60000))
      work += seg
      if (inIso) night += nightOverlap(inIso, seg)
      breakStart = at
    } else if (p.kind === 'break_end' && breakStart) {
      brk += Math.max(0, Math.round((at.getTime() - breakStart.getTime()) / 60000))
      inAt = at
      inIso = p.at
      breakStart = null
    } else if (p.kind === 'out' && inAt && !outSeen) {
      if (!breakStart) {
        const seg = Math.max(0, Math.round((at.getTime() - inAt.getTime()) / 60000))
        work += seg
        if (inIso) night += nightOverlap(inIso, seg)
      }
      breakStart = null
      inAt = null
      inIso = null
      outSeen = true
    }
  }
  return { workMinutes: work, breakMinutes: brk, nightMinutes: night }
}

/** 休憩不足判定（6h超45分 / 8h超1h） */
export function requiredBreakMinutes(workMinutes: number): number {
  if (workMinutes > 8 * 60) return 60
  if (workMinutes > 6 * 60) return 45
  return 0
}

export interface Article36Alert {
  level: 'warn' | 'crit'
  code: string
  message: string
}

export interface MonthOtRecord {
  month: string // YYYY-MM
  nonStatutoryOtMin: number // 法定外残業（60h超含む）
  legalHolidayMin: number
}

/**
 * 36 協定アラート判定
 * @param months 直近 6 ヶ月分（新しい順の必要はない。month 昇順推奨）。最終要素が当月
 */
export function judgeArticle36(months: MonthOtRecord[], over45CountThisYear: number): Article36Alert[] {
  const alerts: Article36Alert[] = []
  if (months.length === 0) return alerts
  const cur = months[months.length - 1]!
  const curOt = cur.nonStatutoryOtMin
  const curTotal = cur.nonStatutoryOtMin + cur.legalHolidayMin

  // 月 45h ちょうどは「以内」で適法のため、超過判定は厳密に「>」
  if (curOt > OT_MONTHLY_LIMIT_MIN) {
    alerts.push({ level: 'crit', code: 'AKO-ATT-A45', message: `時間外労働が月45時間を超過しています（${Math.floor(curOt / 60)}h）` })
  } else if (curOt >= OT_MONTHLY_LIMIT_MIN * 0.8) {
    alerts.push({ level: 'warn', code: 'AKO-ATT-A45W', message: `時間外労働が月45時間の80%に達しています（${Math.floor(curOt / 60)}h）` })
  }
  if (curTotal >= OT_MONTHLY_HARD_LIMIT_MIN) {
    alerts.push({ level: 'crit', code: 'AKO-ATT-A100', message: '時間外+休日労働が単月100時間に到達しています（特別条項違反）' })
  }
  // 2〜6ヶ月の全平均をチェック
  for (let span = 2; span <= Math.min(6, months.length); span++) {
    const window = months.slice(months.length - span)
    const avg = window.reduce((s, m) => s + m.nonStatutoryOtMin + m.legalHolidayMin, 0) / span
    if (avg > OT_AVG_LIMIT_MIN) {
      alerts.push({ level: 'crit', code: 'AKO-ATT-A80', message: `時間外+休日労働の直近${span}ヶ月平均が80時間を超えています` })
      break
    }
  }
  if (over45CountThisYear >= OT_OVER45_MAX_COUNT) {
    alerts.push({ level: 'crit', code: 'AKO-ATT-A6C', message: '月45時間超が年6回に達しています（特別条項の上限）' })
  } else if (over45CountThisYear === OT_OVER45_MAX_COUNT - 1) {
    alerts.push({ level: 'warn', code: 'AKO-ATT-A6CW', message: `月45時間超が年${over45CountThisYear}回です（上限まで残り1回）` })
  }
  return alerts
}

/** 通常付与テーブル（勤続 0.5 年→10 日 …） */
const NORMAL_GRANT = [10, 11, 12, 14, 16, 18, 20] as const
/** 比例付与テーブル（週所定日数 × 勤続段階） */
const PROPORTIONAL_GRANT: Record<number, readonly number[]> = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
}

/**
 * 有給付与日数（労基法 39 条）
 * 判定は「週30時間以上 or 週5日以上 → 通常付与」が先（比例付与は週4日以下かつ週30h未満のみ）
 * @param serviceYears 勤続年数（0.5, 1.5, 2.5, ...）
 */
export function leaveGrantDays(weeklyDays: number, weeklyHours: number, serviceYears: number): number {
  if (serviceYears < 0.5) return 0
  const stage = Math.min(6, Math.floor(serviceYears - 0.5 + 1e-9))
  if (weeklyHours >= 30 || weeklyDays >= 5) return NORMAL_GRANT[stage] as number
  const table = PROPORTIONAL_GRANT[Math.max(1, Math.min(4, Math.floor(weeklyDays)))]
  return (table?.[stage] ?? 0) as number
}
