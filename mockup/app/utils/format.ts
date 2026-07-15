/** 表示書式ユーティリティ（表示射影は純粋関数で統一） */

export function fmtInt(n: number): string {
  return n.toLocaleString('ja-JP')
}

export function fmtYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}`
}

/** 千円単位・万円単位の略記（KPI 用） */
export function fmtYenCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `¥${(n / 100_000_000).toFixed(1)}億`
  if (abs >= 10_000) return `¥${Math.round(n / 10_000).toLocaleString('ja-JP')}万`
  return fmtYen(n)
}

export function fmtPct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 分 → 「8:15」形式 */
export function fmtMinutes(min: number): string {
  const sign = min < 0 ? '-' : ''
  const abs = Math.abs(min)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

/** 分 → 「8.25h」形式 */
export function fmtHours(min: number): string {
  return `${(min / 60).toFixed(2).replace(/\.?0+$/, '')}h`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function fmtDateLong(iso: string): string {
  const d = new Date(iso)
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()]
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${w})`
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtDateTime(iso: string): string {
  return `${fmtDate(iso)} ${fmtTime(iso)}`
}

/** YYYY-MM-DD（ローカル） */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** date key に日数を加算 */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`)
  d.setDate(d.getDate() + days)
  return toDateKey(d)
}

/** その月の日数 */
export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate()
}

export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00`).getDay()
}
