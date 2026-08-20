/**
 * 日報リマインドのモックモード簡易実行。
 *
 * SoT 宣言: 本実装はサーバー cron（POST /jobs/report-reminders → api/src/routes/reports.ts の
 * runReportReminders）。本プラグインはモックモードのデモ用クライアント簡易版で、アプリ起動時に
 * 1 回だけ「設定時刻を過ぎている & 今日未送信」を判定し、未提出メンバーへアプリ内通知を発行する。
 * - API モード（apiBase 設定時）は何もしない（通知の発火はサーバーの責務）
 * - 送信済み管理はブラウザ単位（localStorage 'ako.report-reminder-last.v1'）= 日次 1 回・冪等（原則2）
 * - 判定・本文の純ロジックはサーバーと共有（shared/domain/report-reminder.ts）
 * - 失敗してもアプリ起動をブロックしない（原則4）
 */
import {
  buildReminderMessage, missingReportDates, parseReportReminderConfig, shouldFireReminder,
} from '../../../shared/domain/report-reminder'

const LAST_SENT_KEY = 'ako.report-reminder-last.v1'

export default defineNuxtPlugin(() => {
  if (apiPublicConfig().apiBase) return
  try {
    const { getConfig } = useAppSettings()
    const config = parseReportReminderConfig(getConfig('report-reminder', ''))
    const today = todayJst()
    const clock = jstClock()
    const lastSent = localStorage.getItem(LAST_SENT_KEY) ?? ''
    if (!shouldFireReminder(config, `${clock.h}:${clock.m}`, lastSent, today)) return

    const { tbl } = useMockDb()
    const activeMembers = tbl('members').value.filter(m => m.active)
    const dailyReports = tbl('dailyReports').value
    const { notify } = useNotifications()
    for (const member of activeMembers) {
      const missing = missingReportDates(member.id, dailyReports, today)
      const latest = missing[missing.length - 1]
      if (!latest) continue
      const { title, body } = buildReminderMessage(missing)
      // リンクは最新の未提出日の日報へのディープリンク（?date= = 手動リマインド remind と同型）
      notify(member.id, 'reminder', title, body, `/reports?date=${latest}`)
    }
    // 送信済みの記録は通知発行後（進捗の巻き戻し・再送を防ぐ = 原則2）
    localStorage.setItem(LAST_SENT_KEY, today)
  } catch {
    // リマインドは補助処理。失敗は握りつぶしてアプリ起動を止めない（原則4）
  }
})
