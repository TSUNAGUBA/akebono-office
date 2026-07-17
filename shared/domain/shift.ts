/**
 * シフト（F-05）の純粋ロジック（フロントエンドと API サービスで共有）
 * - 期間状態の正順フロー・日付展開・時間帯計算（日跨ぎ対応）
 * - 割当バリデーション（労基法34条 休憩 / 61条 年少者深夜業 / 週40時間）
 * 週合計・本人希望などの文脈はストア依存のため、呼び出し側が集めて渡す（Vue/pg 非依存を保つ）
 */
import {
  LEGAL_WEEKLY_MIN, NIGHT_END_HOUR, NIGHT_START_HOUR, requiredBreakMinutes,
} from './attendance-calc'
import { addDays } from './jst'
import type { ShiftPeriod, ShiftPeriodStatus } from './types'

/** 期間状態の正順（この順にしか遷移できない） */
export const SHIFT_STATUS_FLOW: ShiftPeriodStatus[] = ['draft', 'open', 'closed', 'adjusting', 'published']

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** シフト時間帯を分区間へ。終了 <= 開始は日跨ぎとして +24h */
export function shiftSpan(from: string, to: string): { start: number; end: number; minutes: number } {
  const start = toMin(from)
  let end = toMin(to)
  if (end <= start) end += 24 * 60
  return { start, end, minutes: end - start }
}

function overlapMin(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** 深夜帯（22:00-翌5:00）との重なり分。end は日跨ぎで 1440 超もあり得る */
export function nightOverlapMinutes(start: number, end: number): number {
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
export function periodDates(p: Pick<ShiftPeriod, 'startDate' | 'endDate'>): string[] {
  const dates: string[] = []
  let d = p.startDate
  for (let i = 0; i < 92 && d <= p.endDate; i++) {
    dates.push(d)
    d = addDays(d, 1)
  }
  return dates
}

/** 割当バリデーションの結果 1 件。error は割当不可、warn は割当可だが注意喚起 */
export interface ShiftWarning {
  code: string
  level: 'error' | 'warn'
  message: string
}

/** M/D 表示（メッセージ用の最小フォーマッタ。UI の fmtDate と同一表示） */
function md(dateKey: string): string {
  return `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`
}

/** 時間表示（メッセージ用。UI の fmtHours と同一表示） */
function hours(min: number): string {
  return `${(min / 60).toFixed(2).replace(/\.?0+$/, '')}h`
}

export interface ShiftAssignContext {
  /** 対象メンバー（年少者判定。birthDate 不明なら深夜チェックはスキップ） */
  memberName: string
  birthDate: string | null
  date: string
  from: string
  to: string
  /** 同一週（日曜起算）の他割当の合計分（今回変更対象の割当は除外して集計すること） */
  weekAssignedMinutes: number
  /** 週の開始日（日曜。警告メッセージ表示用） */
  weekStartDate: string
  /** 同一期間・同一日の本人希望が NG か */
  hasNgWish: boolean
}

/**
 * 割当バリデーション（error = 割当不可 / warn = 割当可だが警告表示）
 * a) 休憩不足（6h超45分・8h超60分） b) 18歳未満の深夜（労基法61条・エラー）
 * c) 週40時間超（同一週の割当合計） d) 本人希望 NG との衝突
 */
export function validateShiftAssign(ctx: ShiftAssignContext): ShiftWarning[] {
  if (!ctx.from || !ctx.to || ctx.from === ctx.to) {
    return [{ code: 'AKO-SFT-007', level: 'error', message: '開始・終了時刻を正しく入力してください' }]
  }
  const list: ShiftWarning[] = []
  const span = shiftSpan(ctx.from, ctx.to)

  // b) 18歳未満の深夜業（労基法61条）→ 割当不可
  if (ctx.birthDate && ageAt(ctx.birthDate, ctx.date) < 18 && nightOverlapMinutes(span.start, span.end) > 0) {
    list.push({
      code: 'AKO-SFT-001',
      level: 'error',
      message: `${ctx.memberName} さんは18歳未満のため深夜帯（22:00〜翌5:00）に割当できません（労基法61条）`,
    })
  }

  // a) 休憩不足（労基法34条: 6h超45分 / 8h超60分）
  const reqBreak = requiredBreakMinutes(span.minutes)
  if (reqBreak > 0) {
    list.push({
      code: 'AKO-SFT-W01',
      level: 'warn',
      message: `勤務${hours(span.minutes)}のため休憩${reqBreak}分の確保が必要です`,
    })
  }

  // c) 週40時間超（週 = 日曜起算。今回分を含めた合計で判定）
  const weekTotal = ctx.weekAssignedMinutes + span.minutes
  if (weekTotal > LEGAL_WEEKLY_MIN) {
    list.push({
      code: 'AKO-SFT-W02',
      level: 'warn',
      message: `同一週（${md(ctx.weekStartDate)}〜）の割当合計が${hours(weekTotal)}となり週40時間を超えます`,
    })
  }

  // d) 本人希望 NG との衝突
  if (ctx.hasNgWish) {
    list.push({
      code: 'AKO-SFT-W03',
      level: 'warn',
      message: '本人希望が「NG」の日です',
    })
  }
  return list
}
