/**
 * ガントチャートの列生成・バー配置・期間ナビゲーションの純関数（フロント共有・決定的）。
 * 改善要望（F-42）の対応予定期間の可視化に使う。日付は JST の日付キー（YYYY-MM-DD）で扱う。
 *
 * スケール（列表示の範囲。オペレーター指示 2026-08-11）:
 * - month（月次）: 12 か月（1年間）。列 = 暦月
 * - week（週次）: 13 週（約3か月）。列 = 月曜始まりの週
 * - day（日次）: アンカー月の全日（約1か月）。列 = 日
 * 「前後の期間」ボタンは表示範囲ぶんだけ送る（month=±12か月 / week=±13週 / day=±1か月）。
 * 「今月/今週/本日」はアンカーを現在の期間へスナップする。
 */
import { addDays, daysInMonth, weekdayOf } from './jst'

export type GanttScale = 'month' | 'week' | 'day'

export interface GanttColumn {
  /** 一意キー（month='YYYY-MM' / week=月曜の日付キー / day=日付キー） */
  key: string
  /** 列見出し（month='M月' / week='M/D' / day='D'） */
  label: string
  /** 期間の開始日（YYYY-MM-DD・含む） */
  startKey: string
  /** 期間の終了日（YYYY-MM-DD・含む） */
  endKey: string
  /** 今日を含む列か */
  isToday: boolean
}

export const GANTT_SCALES: { value: GanttScale; label: string; span: string; nowLabel: string }[] = [
  { value: 'month', label: '月次', span: '1年間', nowLabel: '今月' },
  { value: 'week', label: '週次', span: '3か月', nowLabel: '今週' },
  { value: 'day', label: '日次', span: '1か月', nowLabel: '本日' },
]

const MONTH_COLS = 12
const WEEK_COLS = 13

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 月初の日付キー（YYYY-MM-01） */
function firstOfMonth(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`
}

/** 日付キーへ n か月加算（日は月末で丸める。純粋・Date のローカルTZに依存しない月演算） */
export function addMonths(dateKey: string, n: number): string {
  const y = Number(dateKey.slice(0, 4))
  const m = Number(dateKey.slice(5, 7))
  const d = Number(dateKey.slice(8, 10)) || 1
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const nd = Math.min(d, daysInMonth(ny, nm))
  return `${ny}-${pad2(nm)}-${pad2(nd)}`
}

/** その日付を含む週の月曜（週の起点 = 月曜） */
export function mondayOf(dateKey: string): string {
  const offset = (weekdayOf(dateKey) + 6) % 7 // 月曜からの経過日数（日=0→6, 月=1→0, …）
  return addDays(dateKey, -offset)
}

/** スケールとアンカー日から可視列を生成する */
export function ganttColumns(scale: GanttScale, anchor: string, today: string): GanttColumn[] {
  const cols: GanttColumn[] = []
  if (scale === 'month') {
    const start = firstOfMonth(anchor)
    for (let i = 0; i < MONTH_COLS; i++) {
      const mk = addMonths(start, i)
      const ym = mk.slice(0, 7)
      const startKey = `${ym}-01`
      const endKey = `${ym}-${pad2(daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))))}`
      cols.push({
        key: ym,
        label: `${Number(ym.slice(5, 7))}月`,
        startKey,
        endKey,
        isToday: today >= startKey && today <= endKey,
      })
    }
    return cols
  }
  if (scale === 'week') {
    const start = mondayOf(anchor)
    for (let i = 0; i < WEEK_COLS; i++) {
      const ws = addDays(start, i * 7)
      const we = addDays(ws, 6)
      cols.push({
        key: ws,
        label: `${Number(ws.slice(5, 7))}/${Number(ws.slice(8, 10))}`,
        startKey: ws,
        endKey: we,
        isToday: today >= ws && today <= we,
      })
    }
    return cols
  }
  // day: アンカー月の全日
  const ym = anchor.slice(0, 7)
  const dim = daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)))
  for (let d = 1; d <= dim; d++) {
    const key = `${ym}-${pad2(d)}`
    cols.push({ key, label: String(d), startKey: key, endKey: key, isToday: key === today })
  }
  return cols
}

/** 可視列に対する予定期間バーの列インデックス範囲（可視範囲外は null）。planEnd 未設定は単日扱い */
export function ganttBar(
  planStart: string | null,
  planEnd: string | null,
  columns: GanttColumn[],
): { startIdx: number; endIdx: number } | null {
  if (!planStart || columns.length === 0) return null
  const s = planStart
  const e = planEnd && planEnd >= planStart ? planEnd : planStart
  const winStart = columns[0]!.startKey
  const winEnd = columns[columns.length - 1]!.endKey
  if (e < winStart || s > winEnd) return null // 可視範囲外
  let startIdx = columns.findIndex(c => c.endKey >= s)
  if (startIdx < 0) startIdx = 0
  let endIdx = startIdx
  for (let i = columns.length - 1; i >= 0; i--) {
    if (columns[i]!.startKey <= e) { endIdx = i; break }
  }
  if (endIdx < startIdx) endIdx = startIdx
  return { startIdx, endIdx }
}

/** 「前後の期間」= 表示範囲ぶんアンカーを送る（month=±12か月 / week=±13週 / day=±1か月） */
export function ganttStep(scale: GanttScale, anchor: string, dir: -1 | 1): string {
  if (scale === 'month') return addMonths(firstOfMonth(anchor), dir * MONTH_COLS)
  if (scale === 'week') return addDays(mondayOf(anchor), dir * WEEK_COLS * 7)
  return addMonths(firstOfMonth(anchor), dir) // day: ±1 か月
}

/** 「今月/今週/本日」= 現在の期間を先頭列にするアンカー */
export function ganttAnchorForToday(scale: GanttScale, today: string): string {
  if (scale === 'week') return mondayOf(today)
  return firstOfMonth(today) // month / day はアンカー月で解決
}

/** 可視範囲の見出し（月次は月単位・週次/日次は日単位。例: 2026年3月 〜 2027年2月 / 2026年3月1日 〜 2026年3月31日） */
export function ganttRangeLabel(columns: GanttColumn[]): string {
  if (columns.length === 0) return ''
  const monthScale = columns[0]!.key.length === 7 // month スケールの列キーは 'YYYY-MM'
  const fmt = (key: string): string => monthScale
    ? `${Number(key.slice(0, 4))}年${Number(key.slice(5, 7))}月`
    : `${Number(key.slice(0, 4))}年${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`
  const first = fmt(columns[0]!.startKey)
  const last = fmt(columns[columns.length - 1]!.endKey)
  return first === last ? first : `${first} 〜 ${last}`
}
