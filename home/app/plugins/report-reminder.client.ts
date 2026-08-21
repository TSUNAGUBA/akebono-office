/**
 * 日報・週報・月報リマインドのモックモード簡易実行。
 *
 * SoT 宣言: 本実装はサーバー cron（POST /jobs/report-reminders → api/src/routes/reports.ts の
 * runReportReminders）。本プラグインはモックモードのデモ用クライアント簡易版で、アプリ起動時に
 * 1 回だけ「設定時刻を過ぎている & 今日未送信」を種別ごとに判定し、未提出メンバーへアプリ内通知を発行する。
 * - API モード（apiBase 設定時）は何もしない（通知の発火はサーバーの責務）
 * - 送信済み管理はブラウザ単位（localStorage 'ako.report-reminder-last.v2' = 種別ごとの最終送信日 JSON）
 *   = 種別ごとに日次 1 回・冪等（原則2）。旧キー v1（単一日付）は日報分として読み替える（原則7）
 * - モック通知はアプリ内のみのため external 設定は関与しない（外部チャネル抑制はサーバー実装の責務）
 * - 判定・本文の純ロジックはサーバーと共有（shared/domain/report-reminder.ts）
 * - 失敗してもアプリ起動をブロックしない（原則4）
 */
import { canUseFeature, resolveFeatureResource } from '../../../shared/domain/permissions'
import {
  buildMonthlyReminderMessage, buildReminderMessage, buildWeeklyReminderMessage, hasSubmittedPeriodReport,
  lastCompletedWeekStart, lastMonthStart, missingReportDates, parseReminderLastSent,
  parseReportReminderConfig, type ReminderLastSent, shouldFireReminder,
} from '../../../shared/domain/report-reminder'
import type { Member } from '../../../shared/domain/types'

const LAST_SENT_KEY = 'ako.report-reminder-last.v2'
const LEGACY_LAST_SENT_KEY = 'ako.report-reminder-last.v1'

export default defineNuxtPlugin(() => {
  if (apiPublicConfig().apiBase) return
  try {
    const { getConfig } = useAppSettings()
    const config = parseReportReminderConfig(getConfig('report-reminder', ''))
    const today = todayJst()
    const clock = jstClock()
    const now = `${clock.h}:${clock.m}`
    // v2（種別ごと）→ 無ければ旧 v1（単一日付 = 日報分）を読み替え
    const lastSent: ReminderLastSent = parseReminderLastSent(
      localStorage.getItem(LAST_SENT_KEY) ?? JSON.stringify(localStorage.getItem(LEGACY_LAST_SENT_KEY) ?? ''))

    const { tbl } = useMockDb()
    const activeMembers = tbl('members').value.filter(m => m.active)
    const { notify } = useNotifications()
    // 機能 deny のメンバーへは送らない（deny 対象者には提出手段が無い = API runReportReminders と同一判定。
    // ルール未設定は全員へ = 既定 allow）
    const permRules = tbl('permissionRules').value.filter(r => r.active)
    const canUseReportFeature = (m: Member, feature: string): boolean =>
      permRules.length === 0 || canUseFeature(
        permRules, { memberId: m.id, title: m.title, role: m.role }, resolveFeatureResource(permRules, feature))

    if (shouldFireReminder(config.daily, now, lastSent.daily ?? '', today)) {
      const dailyReports = tbl('dailyReports').value
      for (const member of activeMembers) {
        if (!canUseReportFeature(member, 'reports')) continue
        const missing = missingReportDates(member.id, dailyReports, today)
        const latest = missing[missing.length - 1]
        if (!latest) continue
        const { title, body } = buildReminderMessage(missing)
        // リンクは最新の未提出日の日報へのディープリンク（?date= = 手動リマインド remind と同型）
        notify(member.id, 'reminder', title, body, `/reports?date=${latest}`)
      }
      lastSent.daily = today
    }

    if (shouldFireReminder(config.weekly, now, lastSent.weekly ?? '', today)) {
      const weekStart = lastCompletedWeekStart(today)
      const rows = tbl('weeklyReports').value.map(r =>
        ({ memberId: r.memberId, periodStart: r.weekStart, status: r.status }))
      const { title, body } = buildWeeklyReminderMessage(weekStart)
      for (const member of activeMembers) {
        if (!canUseReportFeature(member, 'weekly-report')) continue
        if (hasSubmittedPeriodReport(member.id, rows, weekStart)) continue
        notify(member.id, 'reminder', title, body, `/weekly-report?week=${weekStart}`)
      }
      lastSent.weekly = today
    }

    if (shouldFireReminder(config.monthly, now, lastSent.monthly ?? '', today)) {
      const monthStart = lastMonthStart(today)
      const rows = tbl('monthlyReports').value.map(r =>
        ({ memberId: r.memberId, periodStart: r.monthStart, status: r.status }))
      const { title, body } = buildMonthlyReminderMessage(monthStart)
      for (const member of activeMembers) {
        if (!canUseReportFeature(member, 'monthly-report')) continue
        if (hasSubmittedPeriodReport(member.id, rows, monthStart)) continue
        notify(member.id, 'reminder', title, body, `/monthly-report?month=${monthStart}`)
      }
      lastSent.monthly = today
    }

    // 送信済みの記録は通知発行後（進捗の巻き戻し・再送を防ぐ = 原則2）。
    // v2 保存が成立したら役目を終えた旧 v1 キーを掃除する（読み替え済みのため情報は失わない）
    localStorage.setItem(LAST_SENT_KEY, JSON.stringify(lastSent))
    localStorage.removeItem(LEGACY_LAST_SENT_KEY)
  } catch {
    // リマインドは補助処理。失敗は握りつぶしてアプリ起動を止めない（原則4）
  }
})
