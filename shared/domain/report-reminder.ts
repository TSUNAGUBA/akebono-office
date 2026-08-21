/**
 * 日報・週報・月報の自動リマインド（純粋関数・フロントエンドと API サービスで共有）
 *
 * SoT 宣言:
 * - 設定の保管: configs の key 'report-reminder'。値は種別ごとの設定
 *   { daily: { enabled, time, external }, weekly: {...}, monthly: {...} } の JSON
 *   （種別単位の構成 = 改善要望 2026-08-21。旧形状 { enabled, time } は日報設定として読む = 原則7）。
 *   モックモードは JSON 文字列・API モード（app_configs jsonb）は文字列/オブジェクトの両形があり得るため
 *   parseReportReminderConfig が両対応する
 * - external = 外部チャネル（Slack / Google Chat）へも配信するか。false = アプリ内通知のみ
 *   （通知マトリクスの外部設定より優先して抑制する。種別ごとの外部通知設定 = 改善要望 2026-08-21）
 * - 送信済み管理: key 'report-reminder-last-sent'。値は種別ごとの最終送信日
 *   { daily?: 'YYYY-MM-DD', weekly?: ..., monthly?: ... }（旧形状 = 単一日付文字列は daily として読む）。
 *   種別ごとに日次 1 回・再実行しても再送しない（原則2）
 * - 実行主体はサーバー cron（POST /jobs/report-reminders → api/src/routes/reports.ts runReportReminders）。
 *   モックモードは plugins/report-reminder.client.ts がデモ用にアプリ起動時 1 回だけ判定する
 */
import { addDays, isRealDateKey, weekdayOf } from './jst'

export type ReportReminderKind = 'daily' | 'weekly' | 'monthly'
export const REPORT_REMINDER_KINDS: ReportReminderKind[] = ['daily', 'weekly', 'monthly']
export const REPORT_REMINDER_KIND_LABELS: Record<ReportReminderKind, string> = {
  daily: '日報',
  weekly: '週報',
  monthly: '月報',
}

/** 1 種別分のリマインド設定 */
export interface ReminderKindConfig {
  /** リマインドを有効にするか */
  enabled: boolean
  /** 通知時刻（'HH:mm'。この時刻以降の最初の実行タイミングで送信する） */
  time: string
  /** 外部チャネル（Slack / Google Chat）へも配信するか（false = アプリ内通知のみ） */
  external: boolean
}

/** 種別ごとのリマインド設定 */
export interface ReportReminderConfig {
  daily: ReminderKindConfig
  weekly: ReminderKindConfig
  monthly: ReminderKindConfig
}

/** 1 種別の既定値（無効・9:15・外部配信あり）。壊れた設定はこの値（disabled）へフォールバックする */
export const DEFAULT_REMINDER_KIND_CONFIG: ReminderKindConfig = { enabled: false, time: '09:15', external: true }

/** 既定値（全種別 無効） */
export const DEFAULT_REPORT_REMINDER: ReportReminderConfig = {
  daily: { ...DEFAULT_REMINDER_KIND_CONFIG },
  weekly: { ...DEFAULT_REMINDER_KIND_CONFIG },
  monthly: { ...DEFAULT_REMINDER_KIND_CONFIG },
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 1 種別分のパース（型不一致・不正時刻は既定 = disabled。external 欠落は true = 従来挙動） */
function parseKindConfig(v: unknown): ReminderKindConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_REMINDER_KIND_CONFIG }
  const o = v as { enabled?: unknown; time?: unknown; external?: unknown }
  if (typeof o.enabled !== 'boolean' || typeof o.time !== 'string' || !TIME_RE.test(o.time)) {
    return { ...DEFAULT_REMINDER_KIND_CONFIG }
  }
  return { enabled: o.enabled, time: o.time, external: typeof o.external === 'boolean' ? o.external : true }
}

/**
 * 設定のパース（JSON 文字列 / オブジェクトの両対応）。
 * 旧形状 { enabled, time }（種別化前 = 日報のみの設定）は daily として読み替える（原則7）。
 * 不正 JSON・型不一致・不正時刻は既定値（disabled）へフォールバックし、誤送信を起こさない
 */
export function parseReportReminderConfig(raw: unknown): ReportReminderConfig {
  let v: unknown = raw
  if (typeof v === 'string') {
    if (!v.trim()) return structuredClone(DEFAULT_REPORT_REMINDER)
    try {
      v = JSON.parse(v)
    } catch {
      return structuredClone(DEFAULT_REPORT_REMINDER)
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return structuredClone(DEFAULT_REPORT_REMINDER)
  const o = v as Record<string, unknown>
  // 旧形状（トップレベルに enabled/time）= 日報のみの設定として読み替え
  if (typeof o.enabled === 'boolean' || typeof o.time === 'string') {
    return {
      daily: parseKindConfig(o),
      weekly: { ...DEFAULT_REMINDER_KIND_CONFIG },
      monthly: { ...DEFAULT_REMINDER_KIND_CONFIG },
    }
  }
  return {
    daily: parseKindConfig(o.daily),
    weekly: parseKindConfig(o.weekly),
    monthly: parseKindConfig(o.monthly),
  }
}

/** 種別ごとの最終送信日（'YYYY-MM-DD'。未送信の種別はキーなし） */
export type ReminderLastSent = Partial<Record<ReportReminderKind, string>>

/**
 * 最終送信日のパース。旧形状（単一の日付文字列 = 種別化前の日報送信記録）は daily として読み替える（原則7）。
 * 旧値は保存経路により 2 形で届く: API モード = app_configs jsonb の自動デコード済み**素の日付文字列**
 * （'2026-08-20'。JSON.parse すると SyntaxError）/ モック = JSON 文字列（'"2026-08-20"'）。
 * どちらも { daily } へ読み替えないと、デプロイ当日に日報リマインドが重複送信される（監査 R1 MAJOR-1）
 */
export function parseReminderLastSent(raw: unknown): ReminderLastSent {
  let v: unknown = raw
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return {}
    try {
      v = JSON.parse(s)
    } catch {
      // JSON でない文字列 = jsonb 経由の旧形状（素の日付キー）。日付でなければ未送信扱い（誤抑制しない）
      return isRealDateKey(s) ? { daily: s } : {}
    }
  }
  if (typeof v === 'string') return isRealDateKey(v) ? { daily: v } : {} // JSON.parse 後も文字列（= '"2026-08-20"'）
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const o = v as Record<string, unknown>
  const out: ReminderLastSent = {}
  for (const k of REPORT_REMINDER_KINDS) {
    if (typeof o[k] === 'string' && o[k] !== '') out[k] = o[k] as string
  }
  return out
}

/** 判定対象の日報（DailyReport の構造的サブセット。モックの行・API 行の双方から渡せる） */
export interface ReminderDailyReport {
  authorKind: string
  memberId: string | null
  date: string
  status: string
}

/** 判定対象の期間レポート（週報/月報の構造的サブセット。periodStart = weekStart / monthStart） */
export interface ReminderPeriodReport {
  memberId: string | null
  periodStart: string
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

/** 属する週の月曜（週キー。home/app/utils/report-weeks.ts weekStartOf と同一定義 = 月曜始まり） */
export function weekStartKeyOf(dateKey: string): string {
  const w = weekdayOf(dateKey)
  return addDays(dateKey, w === 0 ? -6 : 1 - w)
}

/** 直近の完了週（先週）の週開始（月曜）。週報リマインドの対象期間 */
export function lastCompletedWeekStart(todayKey: string): string {
  return addDays(weekStartKeyOf(todayKey), -7)
}

/** 先月の月初キー（YYYY-MM-01）。月報リマインドの対象期間 */
export function lastMonthStart(todayKey: string): string {
  const y = Number(todayKey.slice(0, 4))
  const m = Number(todayKey.slice(5, 7))
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1]
  return `${py}-${String(pm).padStart(2, '0')}-01`
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

/** 対象期間（週/月）の提出済みレポートが有るか（下書きは未提出扱い = 日報と同じ規則） */
export function hasSubmittedPeriodReport(
  memberId: string,
  reports: ReminderPeriodReport[],
  periodStart: string,
): boolean {
  return reports.some(r => r.memberId === memberId && r.periodStart === periodStart && r.status === 'submitted')
}

/**
 * 送信すべきか = enabled かつ 現在時刻が設定時刻以降 かつ 今日まだ送っていない。
 * 'HH:mm' 同士は辞書順で正しく大小比較できる。日次 1 回 = lastSentDateKey !== todayKey（冪等・原則2）
 */
export function shouldFireReminder(
  config: ReminderKindConfig,
  nowHhmm: string,
  lastSentDateKey: string,
  todayKey: string,
): boolean {
  return config.enabled && nowHhmm >= config.time && lastSentDateKey !== todayKey
}

/** 通知メッセージ（日報。日付は '8/18, 8/19' の M/D 表記・昇順のまま並べる） */
export function buildReminderMessage(dates: string[]): { title: string; body: string } {
  const md = dates.map(d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`)
  return {
    title: '日報リマインド',
    body: `未提出の日報があります: ${md.join(', ')}。記載をお願いします`,
  }
}

/** 通知メッセージ（週報。対象 = 先週 M/D〜M/D） */
export function buildWeeklyReminderMessage(weekStart: string): { title: string; body: string } {
  const end = addDays(weekStart, 6)
  const md = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
  return {
    title: '週報リマインド',
    body: `先週（${md(weekStart)}〜${md(end)}）の週報が未提出です。記載をお願いします`,
  }
}

/** 通知メッセージ（月報。対象 = 先月 YYYY年M月） */
export function buildMonthlyReminderMessage(monthStart: string): { title: string; body: string } {
  const y = Number(monthStart.slice(0, 4))
  const m = Number(monthStart.slice(5, 7))
  return {
    title: '月報リマインド',
    body: `先月（${y}年${m}月）の月報が未提出です。記載をお願いします`,
  }
}
