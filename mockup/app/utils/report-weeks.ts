/**
 * 週報の週キー計算（純粋関数）。
 * 週キー = 週初め（月曜）の日付文字列（YYYY-MM-DD）。週列生成の SoT はここ
 * （useReports.weekStartOf も本実装へ委譲する = 原則3）
 */
import { addDays, weekdayOf } from '../../../shared/domain/jst'

/** 週の開始日（月曜）。日曜は前週の月曜へ戻す（月曜始まりの週） */
export function weekStartOf(date: string): string {
  const w = weekdayOf(date)
  return addDays(date, w === 0 ? -6 : 1 - w)
}

/**
 * 直近 n 週の週初め（月曜）リスト。**昇順**（左 = 最も古い週 → 右端 = today を含む今週）。
 * 週報マトリクスの列順はこの並びをそのまま使う。年・月跨ぎは addDays が吸収する
 */
export function recentWeekStarts(today: string, n: number): string[] {
  const current = weekStartOf(today)
  return Array.from({ length: n }, (_, i) => addDays(current, -7 * (n - 1 - i)))
}
