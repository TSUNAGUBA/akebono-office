/**
 * 日報の自動リマインド（純粋関数・フロントエンドと API サービスで共有）
 *
 * SoT 宣言:
 * - 設定の保管: configs の key 'report-reminder'（{ enabled, time } の JSON）。
 *   モックモードは JSON 文字列・API モード（app_configs jsonb）は文字列/オブジェクトの両形があり得るため
 *   parseReportReminderConfig が両対応する（原則7）
 * - 送信済み管理: key 'report-reminder-last-sent'（日付キー）。日次 1 回・再実行しても再送しない（原則2）
 * - 実行主体はサーバー cron（POST /jobs/report-reminders → api/src/routes/reports.ts runReportReminders）。
 *   モックモードは plugins/report-reminder.client.ts がデモ用にアプリ起動時 1 回だけ判定する
 */
import { addDays, weekdayOf } from './jst'

export interface ReportReminderConfig {
  /** リマインドを有効にするか */
  enabled: boolean
  /** 通知時刻（'HH:mm'。この時刻以降の最初の実行タイミングで送信する） */
  time: string
}

/** 既定値（無効・9:15）。壊れた設定はこの値（disabled）へフォールバックする */
export const DEFAULT_REPORT_REMINDER: ReportReminderConfig = { enabled: false, time: '09:15' }

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 設定のパース（JSON 文字列 / オブジェクトの両対応）。
 * 不正 JSON・型不一致・不正時刻は既定値（disabled）へフォールバックし、誤送信を起こさない（原則7）
 */
export function parseReportReminderConfig(raw: unknown): ReportReminderConfig {
  let v: unknown = raw
  if (typeof v === 'string') {
    if (!v.trim()) return { ...DEFAULT_REPORT_REMINDER }
    try {
      v = JSON.parse(v)
    } catch {
      return { ...DEFAULT_REPORT_REMINDER }
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_REPORT_REMINDER }
  const o = v as { enabled?: unknown; time?: unknown }
  if (typeof o.enabled !== 'boolean' || typeof o.time !== 'string' || !TIME_RE.test(o.time)) {
    return { ...DEFAULT_REPORT_REMINDER }
  }
  return { enabled: o.enabled, time: o.time }
}

/** 判定対象の日報（DailyReport の構造的サブセット。モックの行・API 行の双方から渡せる） */
export interface ReminderDailyReport {
  authorKind: string
  memberId: string | null
  date: string
  status: string
}

/**
 * リマインド対象の日付窓 = todayKey の前日以前（today は含まない）の直近 lookbackBusinessDays 営業日。
 * 営業日は月〜金の簡易判定（**祝日は考慮しない** = 祝日明けに祝日分の「未提出」が出ることは受容する）。
 * 昇順で返す
 */
export function reminderWindowDates(todayKey: string, lookbackBusinessDays = 5): string[] {
  const dates: string[] = []
  let d = addDays(todayKey, -1)
  while (dates.length < lookbackBusinessDays) {
    const w = weekdayOf(d)
    if (w !== 0 && w !== 6) dates.unshift(d)
    d = addDays(d, -1)
  }
  return dates
}

/**
 * 前日までの直近 lookbackBusinessDays 営業日（月〜金。祝日は考慮しない = reminderWindowDates 参照）のうち、
 * 提出済み（status='submitted'）の日報が無い日付リスト（昇順）。
 * 下書きは未提出扱い（提出 = submitted のみ）。today 当日分は判定対象外
 */
export function missingReportDates(
  memberId: string,
  dailyReports: ReminderDailyReport[],
  todayKey: string,
  lookbackBusinessDays = 5,
): string[] {
  const submitted = new Set(
    dailyReports
      .filter(r => r.authorKind === 'human' && r.memberId === memberId && r.status === 'submitted')
      .map(r => r.date))
  return reminderWindowDates(todayKey, lookbackBusinessDays).filter(d => !submitted.has(d))
}

/**
 * 送信すべきか = enabled かつ 現在時刻が設定時刻以降 かつ 今日まだ送っていない。
 * 'HH:mm' 同士は辞書順で正しく大小比較できる。日次 1 回 = lastSentDateKey !== todayKey（冪等・原則2）
 */
export function shouldFireReminder(
  config: ReportReminderConfig,
  nowHhmm: string,
  lastSentDateKey: string,
  todayKey: string,
): boolean {
  return config.enabled && nowHhmm >= config.time && lastSentDateKey !== todayKey
}

/** 通知メッセージ（日付は '8/18, 8/19' の M/D 表記・昇順のまま並べる） */
export function buildReminderMessage(dates: string[]): { title: string; body: string } {
  const md = dates.map(d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`)
  return {
    title: '日報リマインド',
    body: `未提出の日報があります: ${md.join(', ')}。記載をお願いします`,
  }
}
