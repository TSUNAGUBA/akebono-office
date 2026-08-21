/**
 * 週報の週キー計算（純粋関数）。
 * 週キー = 週初め（月曜）の日付文字列（YYYY-MM-DD）。計算本体の SoT は
 * shared/domain/report-reminder.weekStartKeyOf（API のリマインド判定と同一定義 = 原則3）。
 * home 側の従来名 weekStartOf は re-export で維持する（参照元多数のため I/F 不変）
 */
import { addDays } from '../../../shared/domain/jst'
import { weekStartKeyOf } from '../../../shared/domain/report-reminder'
import { fmtDate } from './format'

/** 週の開始日（月曜）。日曜は前週の月曜へ戻す（月曜始まりの週） */
export const weekStartOf = weekStartKeyOf

/**
 * 直近 n 週の週初め（月曜）リスト。**昇順**（左 = 最も古い週 → 右端 = today を含む今週）。
 * 週報マトリクスの列順はこの並びをそのまま使う。年・月跨ぎは addDays が吸収する
 */
export function recentWeekStarts(today: string, n: number): string[] {
  const current = weekStartOf(today)
  return Array.from({ length: n }, (_, i) => addDays(current, -7 * (n - 1 - i)))
}

/**
 * 週レンジのラベル（M/D〜M/D）。自分の週報・全員の週報・週報詳細ドロワー・提出状況マトリクスで
 * 共通（改修依頼 2026-08-20 第2バッチで reports.vue から週報パネルを分離するにあたり一元化 = 原則3）
 */
export function weekRangeLabel(weekStart: string): string {
  return `${fmtDate(weekStart)}〜${fmtDate(addDays(weekStart, 6))}`
}
