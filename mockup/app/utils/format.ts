/**
 * 表示書式ユーティリティ（表示射影は純粋関数で統一）
 *
 * 時刻の方針: 業務時刻は JST のウォールクロック（"+09:00" 付き ISO 文字列）を正とする。
 * 保存時は nowJstIso() / todayJst() を使い、表示時は文字列から直接パースする。
 * これにより閲覧者・実行環境のタイムゾーンに依存せず、日本の労務時刻として一貫する。
 */

const JST_OFFSET_MS = 9 * 3600 * 1000

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 現在時刻を JST ウォールクロックの ISO 文字列（+09:00）で返す。保存用タイムスタンプの唯一の生成元 */
export function nowJstIso(): string {
  const d = new Date(Date.now() + JST_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    + `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+09:00`
}

/** JST での今日の日付キー（YYYY-MM-DD） */
export function todayJst(): string {
  return nowJstIso().slice(0, 10)
}

/** JST の現在時計（打刻ウィジェット等の表示用） */
export function jstClock(): { h: string; m: string; s: string } {
  const d = new Date(Date.now() + JST_OFFSET_MS)
  return { h: pad2(d.getUTCHours()), m: pad2(d.getUTCMinutes()), s: pad2(d.getUTCSeconds()) }
}

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

/** 文字列先頭の YYYY-MM-DD を取り出す（ウォールクロック解釈。TZ 非依存） */
function datePart(iso: string): { y: number; mo: number; d: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}

export function fmtDate(iso: string): string {
  const p = datePart(iso)
  if (!p) return iso
  return `${p.mo}/${p.d}`
}

export function fmtDateLong(iso: string): string {
  const p = datePart(iso)
  if (!p) return iso
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()]
  return `${p.y}/${p.mo}/${p.d}(${w})`
}

export function fmtTime(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : iso
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
