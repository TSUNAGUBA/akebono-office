/**
 * JST 時刻・日付キーユーティリティ（純粋関数・フロント/API 共有）
 *
 * 時刻の方針: 業務時刻は JST のウォールクロック（"+09:00" 付き ISO 文字列）を正とする。
 * 保存時は nowJstIso() / todayJst() を使い、表示時は文字列から直接パースする。
 * これにより閲覧者・実行環境のタイムゾーンに依存せず、日本の労務時刻として一貫する。
 * （SoT: 旧 mockup/app/utils/format.ts から移設。mockup 側は再エクスポートで参照）
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

/** 'HH:mm' → 0:00 からの分数（カレンダー予定・勤務時間帯などの壁時計計算用） */
export function hhmmToMin(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
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
