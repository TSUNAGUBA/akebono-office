/**
 * 表示書式ユーティリティ（表示射影は純粋関数で統一）
 *
 * 時刻の方針: 業務時刻は JST のウォールクロック（"+09:00" 付き ISO 文字列）を正とする。
 * JST・日付キー系の実装 SoT は shared/domain/jst.ts（API サービスと共有）で、
 * 本ファイルは表示専用フォーマッタ + shared の再エクスポート（auto-import 維持）を担う。
 */

export {
  addDays, daysInMonth, hhmmToMin, jstClock, nowJstIso, toDateKey, todayJst, weekdayOf,
} from '../../../shared/domain/jst'

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

/**
 * 「yyyy/MM/dd HH:mm:ss」形式（改善要望の受付箱など、投稿の前後関係を秒まで確認する表示用。
 * 改修依頼 2026-08-18）。文字列の壁時計をそのまま表示する（TZ 変換しない）。
 * 時刻部が無い・形式外の文字列はそのまま返す（他フォーマッタと同じフォールバック）。
 */
export function fmtDateTimeSec(iso: string): string {
  const p = datePart(iso)
  const t = iso.match(/T(\d{2}):(\d{2}):(\d{2})/)
  if (!p || !t) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${p.y}/${pad(p.mo)}/${pad(p.d)} ${t[1]}:${t[2]}:${t[3]}`
}




