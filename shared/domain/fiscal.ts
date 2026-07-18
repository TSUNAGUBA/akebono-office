/**
 * 会計年度の純粋関数（フロント/API 共有。バッチ6b）。
 * 会計年度は自社（companies kind='self'）の fiscalStartMonth 起点で解釈する
 * （未設定時の既定は 4 月始まり。呼び出し側で ?? DEFAULT_FISCAL_START_MONTH する）。
 * 「会計年度 fy」は開始年の西暦で表す（例: 4 月始まりの 2026 年度 = 2026-04 〜 2027-03）。
 */

export const DEFAULT_FISCAL_START_MONTH = 4

/** YYYY-MM が属する会計年度（開始年の西暦） */
export function fiscalYearOf(month: string, fiscalStartMonth: number): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m >= fiscalStartMonth ? y : y - 1
}

/** 会計年度 fy に属する 12 ヶ月の YYYY-MM 配列（開始月起点） */
export function fiscalMonthsOf(fy: number, fiscalStartMonth: number): string[] {
  const months: string[] = []
  for (let i = 0; i < 12; i++) {
    const m0 = fiscalStartMonth - 1 + i
    const y = fy + Math.floor(m0 / 12)
    const m = (m0 % 12) + 1
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return months
}

/** YYYY-MM の会計年度内の月序数（1〜12。開始月 = 1。四半期・並び順の導出に使う） */
export function fiscalMonthNoOf(month: string, fiscalStartMonth: number): number {
  const m = Number(month.slice(5, 7))
  return ((m - fiscalStartMonth + 12) % 12) + 1
}

/** YYYY-MM の会計四半期（1〜4） */
export function fiscalQuarterOf(month: string, fiscalStartMonth: number): number {
  return Math.ceil(fiscalMonthNoOf(month, fiscalStartMonth) / 3)
}
