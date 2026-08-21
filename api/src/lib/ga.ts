/**
 * GA4 レスポンス → MediaMetrics の整形（純粋関数・単体テスト対象）。
 * Data API v1beta の runReport / batchRunReports のレスポンスを、モックと同一の
 * `MediaMetrics` 型（shared/domain/media-metrics）へ整形する（モック/API パリティが設計原則）。
 *
 * 防御方針:
 * - rows は省略されうる（データなし）→ 必ず `?? []` で防御
 * - 値は文字列で届く → 数値化の失敗（NaN）は 0 に倒す
 * - 比率の分母ゼロは 0（ゼロ除算を作らない）
 * - GA の日付はプロパティのタイムゾーン基準（アプリは JST 前提）。日単位のずれは許容する設計判断
 *   （リクエストの dateRanges は JST の日付キーで指定し、返る date/yearMonth をそのまま採用する）
 *
 * メトリクス対応の注記: GA4 の `conversions` は廃止済みのため `keyEvents` を使う。
 * bounceRate / engagementRate は GA4 定義の比率（0..1）で返る。
 */
import { recentMonthKeys as sharedRecentMonthKeys } from '../../../shared/domain/media-integrated'
import type {
  MediaChannelStat, MediaDailyPoint, MediaDeviceStat, MediaMetrics, MediaMonthlyPoint,
  MediaPageStat, MediaSectionStat,
} from '../../../shared/domain/media-metrics'
import { addDays } from '../../../shared/domain/jst'

// ---------- GA レスポンス型（必要最小限。全フィールド optional で防御） ----------

export interface GaReport {
  dimensionHeaders?: { name?: string }[]
  metricHeaders?: { name?: string; type?: string }[]
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]
  rowCount?: number
}

/** 数値化（GA は文字列で返す。欠落・非数値は 0 に倒す） */
export function gaNum(v: string | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** レポートの行を { 次元名 → 値, メトリクス名 → 数値 } の列名アクセスに正規化する */
export function gaRows(report: GaReport | null | undefined): { dim: Record<string, string>; met: Record<string, number> }[] {
  if (!report) return []
  const dimNames = (report.dimensionHeaders ?? []).map(h => h.name ?? '')
  const metNames = (report.metricHeaders ?? []).map(h => h.name ?? '')
  return (report.rows ?? []).map((row) => {
    const dim: Record<string, string> = {}
    const met: Record<string, number> = {}
    dimNames.forEach((name, i) => { dim[name] = row.dimensionValues?.[i]?.value ?? '' })
    metNames.forEach((name, i) => { met[name] = gaNum(row.metricValues?.[i]?.value) })
    return { dim, met }
  })
}

// ---------- 形式変換 ----------

/** GA の date（YYYYMMDD）→ YYYY-MM-DD。形式外はそのまま返す（表示破綻より情報保全） */
export function gaDateKey(v: string): string {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v
}

/** GA の yearMonth（YYYYMM）→ YYYY-MM */
export function gaMonthKey(v: string): string {
  return /^\d{6}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}` : v
}

// ---------- チャネル・デバイスの日本語マッピング（モックのラベル語彙へ揃える） ----------

/**
 * sessionDefaultChannelGroup（英語）→ モックの日本語ラベル。
 * 有料系（検索/SNS/ショッピング/ディスプレイ等）は「有料広告」へ集約する（モックの語彙が 1 区分のため）。
 * 未知値はそのまま表示する（情報を落とさない）
 */
const CHANNEL_JA: Record<string, string> = {
  'Organic Search': 'オーガニック検索',
  'Direct': '直接',
  'Organic Social': 'ソーシャル',
  'Referral': 'リファラル',
  'Email': 'メール',
  'Paid Search': '有料広告',
  'Paid Social': '有料広告',
  'Paid Shopping': '有料広告',
  'Paid Video': '有料広告',
  'Display': '有料広告',
  'Cross-network': '有料広告',
}

/** モックと同じ表示順（既知ラベルを先頭固定 → 未知ラベルはセッション降順で後置） */
const CHANNEL_ORDER = ['オーガニック検索', '直接', 'ソーシャル', 'リファラル', '有料広告', 'メール']

export function channelLabelJa(gaChannel: string): string {
  return CHANNEL_JA[gaChannel] ?? gaChannel
}

const DEVICE_JA: Record<string, string> = { mobile: 'モバイル', desktop: 'デスクトップ', tablet: 'タブレット' }
const DEVICE_ORDER = ['モバイル', 'デスクトップ', 'タブレット']

export function deviceLabelJa(gaDevice: string): string {
  return DEVICE_JA[gaDevice.toLowerCase()] ?? gaDevice
}

// ---------- セクション解決 ----------

/** 末尾スラッシュを正規化（'/blog/' と '/blog' を同一視。ルート '/' は維持） */
function normPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * pagePath → セクション。記事インベントリ（media_articles）に path 一致があればその section を優先し、
 * なければ pagePath の第 1 階層をそのまま使う（'/' はトップ）。
 */
export function sectionOfPath(path: string, inventory: Map<string, string>): string {
  const p = normPath(path || '/')
  const hit = inventory.get(p) ?? inventory.get(path)
  if (hit) return hit
  const first = p.split('/').filter(Boolean)[0]
  return first ?? 'トップ'
}

/** インベントリの path → section マップ（正規化キーで登録） */
export function inventorySectionMap(articles: { path: string; section: string }[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of articles) map.set(normPath(a.path), a.section)
  return map
}

// ---------- MediaMetrics の組み立て ----------

export interface GaReportSet {
  /** 当期の総計（次元なし）。取得必須（呼び出し側が全滅時 502 にする） */
  totals: GaReport | null
  /** 前期の総計（次元なし） */
  prevTotals: GaReport | null
  daily: GaReport | null
  channels: GaReport | null
  devices: GaReport | null
  topPages: GaReport | null
  /** 前期の pagePath 別 screenPageViews（前期比の突合用） */
  prevPages: GaReport | null
  /** 前年同期（直近 7 日と同じ日付範囲の前年）の日別。改善要望 2026-08-21。取得失敗/未対応は null = yoyWeek 未設定 */
  yoyWeekDaily?: GaReport | null
}

export interface BuildMetricsOptions {
  segmentId: string
  siteName: string
  periodFrom: string
  periodTo: string
  days: number
  /** 記事インベントリ（セクション対応 + articleCount。GA でなくアプリが SoT） */
  articles: { path: string; section: string }[]
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const round4 = (n: number): number => Math.round(n * 10000) / 10000

/** GA レスポンス一式から MediaMetrics を組み立てる（欠落レポートは空として防御） */
export function buildMediaMetrics(reports: GaReportSet, opts: BuildMetricsOptions): MediaMetrics {
  const totals = gaRows(reports.totals)[0]?.met ?? {}
  const prevTotals = gaRows(reports.prevTotals)[0]?.met ?? {}

  const sessions = Math.round(totals.sessions ?? 0)
  const users = Math.round(totals.totalUsers ?? 0)
  const newUsers = Math.round(totals.newUsers ?? 0)
  const pageviews = Math.round(totals.screenPageViews ?? 0)
  const engagementSecTotal = totals.userEngagementDuration ?? 0
  const conversions = Math.round(totals.keyEvents ?? 0)

  // 日別（GA に無い日は 0 埋め = チャートの連続性。日数分の点を必ず返す）
  const dailyByDate = new Map<string, { sessions: number; users: number; conversions: number }>()
  for (const r of gaRows(reports.daily)) {
    dailyByDate.set(gaDateKey(r.dim.date ?? ''), {
      sessions: Math.round(r.met.sessions ?? 0),
      users: Math.round(r.met.totalUsers ?? 0),
      conversions: Math.round(r.met.keyEvents ?? 0),
    })
  }
  const daily: MediaDailyPoint[] = []
  for (let i = 0; i < opts.days; i++) {
    const date = addDays(opts.periodFrom, i)
    const d = dailyByDate.get(date)
    daily.push({ date, sessions: d?.sessions ?? 0, users: d?.users ?? 0, conversions: d?.conversions ?? 0 })
  }

  // チャネル（日本語ラベルへ集約。既知ラベルは固定順・未知はセッション降順で後置）
  const chMap = new Map<string, { sessions: number; conversions: number }>()
  for (const r of gaRows(reports.channels)) {
    const label = channelLabelJa(r.dim.sessionDefaultChannelGroup ?? '')
    const cur = chMap.get(label) ?? { sessions: 0, conversions: 0 }
    cur.sessions += Math.round(r.met.sessions ?? 0)
    cur.conversions += Math.round(r.met.keyEvents ?? 0)
    chMap.set(label, cur)
  }
  const channels: MediaChannelStat[] = [
    ...CHANNEL_ORDER.filter(label => chMap.has(label)).map(label => ({ channel: label, ...chMap.get(label)! })),
    ...[...chMap.entries()].filter(([label]) => !CHANNEL_ORDER.includes(label))
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .map(([label, v]) => ({ channel: label, ...v })),
  ]

  // デバイス
  const devMap = new Map<string, number>()
  for (const r of gaRows(reports.devices)) {
    const label = deviceLabelJa(r.dim.deviceCategory ?? '')
    devMap.set(label, (devMap.get(label) ?? 0) + Math.round(r.met.sessions ?? 0))
  }
  const devices: MediaDeviceStat[] = [
    ...DEVICE_ORDER.filter(label => devMap.has(label)).map(label => ({ device: label, sessions: devMap.get(label)! })),
    ...[...devMap.entries()].filter(([label]) => !DEVICE_ORDER.includes(label))
      .sort((a, b) => b[1] - a[1])
      .map(([label, sessions]) => ({ device: label, sessions })),
  ]

  // 前期の pagePath 別 PV（前期比の突合）
  const prevPvByPath = new Map<string, number>()
  for (const r of gaRows(reports.prevPages)) {
    const p = normPath(r.dim.pagePath ?? '')
    prevPvByPath.set(p, (prevPvByPath.get(p) ?? 0) + Math.round(r.met.screenPageViews ?? 0))
  }

  // ページ別。GA は要求した**全ディメンションでグループ化**するため、期間中に pageTitle が変わった URL は
  // (pagePath, pageTitle) の組ごとに複数行で返る（Codex 指摘 2）。正規化 path で集約してから統計を構築し、
  // 重複エントリ・セクション記事数の水増し・prevPageviews の重複割当を防ぐ。
  // タイトルは PV 最大の行を代表値とする。users はタイトル変遷をまたぐ同一ユーザーを重複計上しうる
  // （GA が組ごとに返す値の合算 = 近似。path 単体次元での再取得はリクエスト数増のため許容する設計判断）
  interface PageAgg {
    title: string
    titlePv: number
    pv: number
    users: number
    engSum: number
    bounceWSum: number
    conv: number
  }
  const pageAgg = new Map<string, PageAgg>()
  for (const r of gaRows(reports.topPages)) {
    const path = normPath(r.dim.pagePath ?? '') || '/'
    const pv = Math.round(r.met.screenPageViews ?? 0)
    const cur = pageAgg.get(path)
      ?? { title: '', titlePv: -1, pv: 0, users: 0, engSum: 0, bounceWSum: 0, conv: 0 }
    const title = (r.dim.pageTitle ?? '').trim()
    if (pv > cur.titlePv) {
      cur.title = title
      cur.titlePv = pv
    }
    cur.pv += pv
    cur.users += Math.round(r.met.totalUsers ?? 0)
    cur.engSum += r.met.userEngagementDuration ?? 0
    cur.bounceWSum += (r.met.bounceRate ?? 0) * pv // 直帰率は PV 加重平均で合成
    cur.conv += Math.round(r.met.keyEvents ?? 0)
    pageAgg.set(path, cur)
  }
  const sectionMap = inventorySectionMap(opts.articles)
  const pages: MediaPageStat[] = [...pageAgg.entries()].map(([path, a]) => ({
    id: path,
    title: a.title || path,
    path,
    section: sectionOfPath(path, sectionMap),
    pageviews: a.pv,
    users: a.users,
    avgEngagementSec: a.pv > 0 ? Math.round(a.engSum / a.pv) : 0,
    bounceRate: a.pv > 0 ? round3(a.bounceWSum / a.pv) : 0,
    convRate: a.users > 0 ? round4(a.conv / a.users) : 0,
    conversions: a.conv,
    prevPageviews: prevPvByPath.get(path) ?? 0,
  })).sort((a, b) => b.pageviews - a.pageviews)

  // セクション別（取得した全ページで集約。表示上限前の母集団で集計する）
  const secMap = new Map<string, { pages: number; pageviews: number; engSum: number; convSum: number; userSum: number }>()
  for (const p of pages) {
    const cur = secMap.get(p.section) ?? { pages: 0, pageviews: 0, engSum: 0, convSum: 0, userSum: 0 }
    cur.pages += 1
    cur.pageviews += p.pageviews
    cur.engSum += p.avgEngagementSec * p.pageviews
    cur.convSum += p.conversions
    cur.userSum += p.users
    secMap.set(p.section, cur)
  }
  const sections: MediaSectionStat[] = [...secMap.entries()].map(([section, v]) => ({
    section,
    pages: v.pages,
    pageviews: v.pageviews,
    avgEngagementSec: v.pageviews > 0 ? Math.round(v.engSum / v.pageviews) : 0,
    convRate: v.userSum > 0 ? round4(v.convSum / v.userSum) : 0,
  })).sort((a, b) => b.pageviews - a.pageviews)

  // 前年同期（直近 7 日と同じ日付範囲の前年。改善要望 2026-08-21）。日別行を合算する
  // （当年側の週合計 = daily の合算〔延べユーザー〕と同じ尺度）。レポート未取得（null/undefined）は
  // yoyWeek を作らない = フロントは「—」表示（原則7）。取得済みでデータ 0 は 0 として返す（事実）
  let yoyWeek: MediaMetrics['yoyWeek']
  if (reports.yoyWeekDaily) {
    const rows = gaRows(reports.yoyWeekDaily)
    yoyWeek = {
      sessions: rows.reduce((s, r) => s + Math.round(r.met.sessions ?? 0), 0),
      users: rows.reduce((s, r) => s + Math.round(r.met.totalUsers ?? 0), 0),
      conversions: rows.reduce((s, r) => s + Math.round(r.met.keyEvents ?? 0), 0),
    }
  }

  return {
    segmentId: opts.segmentId,
    siteName: opts.siteName,
    periodFrom: opts.periodFrom,
    periodTo: opts.periodTo,
    days: opts.days,
    sessions,
    users,
    newUsers,
    pageviews,
    avgEngagementSec: pageviews > 0 ? Math.round(engagementSecTotal / pageviews) : 0,
    engagementRate: round3(totals.engagementRate ?? 0),
    bounceRate: round3(totals.bounceRate ?? 0),
    conversions,
    conversionRate: sessions > 0 ? round4(conversions / sessions) : 0,
    prevSessions: Math.round(prevTotals.sessions ?? 0),
    prevUsers: Math.round(prevTotals.totalUsers ?? 0),
    prevPageviews: Math.round(prevTotals.screenPageViews ?? 0),
    prevConversions: Math.round(prevTotals.keyEvents ?? 0),
    yoyWeek,
    channels,
    devices,
    daily,
    topPages: pages.slice(0, 12),
    sections,
    articleCount: opts.articles.length,
  }
}

// ---------- 月次トレンド ----------

/** yearMonth レポート → MediaMonthlyPoint[]（GA に無い月は 0 埋め = deriveMonthlyMediaTrend と同じ月数を保証。
 * engagedSessions は実測（統合ファネルの「主体的関与」に擬似係数でなく実値を使うため = 原則: 事実を作らない） */
export function buildMonthlyTrend(report: GaReport | null, months: string[]): MediaMonthlyPoint[] {
  const byMonth = new Map<string, { sessions: number; users: number; conversions: number; engagedSessions: number }>()
  for (const r of gaRows(report)) {
    byMonth.set(gaMonthKey(r.dim.yearMonth ?? ''), {
      sessions: Math.round(r.met.sessions ?? 0),
      users: Math.round(r.met.totalUsers ?? 0),
      conversions: Math.round(r.met.keyEvents ?? 0),
      engagedSessions: Math.round(r.met.engagedSessions ?? 0),
    })
  }
  return months.map((month) => {
    const m = byMonth.get(month)
    return {
      month,
      sessions: m?.sessions ?? 0,
      users: m?.users ?? 0,
      conversions: m?.conversions ?? 0,
      engagedSessions: m?.engagedSessions ?? 0,
    }
  })
}

/**
 * 直近 n ヶ月の月キー（古い順）。endBackMonths=1 で「直前の完了月」まで
 * （進行中の当月を締め前の数値で悲観評価しない = home useMediaAnalytics.recentMonths と同一ロジック）。
 * todayKey を引数に取る純関数（テスト可能・JST は呼び出し側が渡す）
 */
export function recentMonthKeys(n: number, endBackMonths: number, todayKey: string): string[] {
  // 実装の SoT は shared/domain/media-integrated（Phase C でフロントの統合組み立てと共有化。
  // 本シグネチャは既存呼び出し互換のため維持）
  return sharedRecentMonthKeys(todayKey.slice(0, 7), n, endBackMonths)
}

/** 月キー（YYYY-MM）の月末日（YYYY-MM-DD）。dateRanges の endDate 用。実装の SoT = shared/domain/akebono */
export { monthEndOf } from '../../../shared/domain/akebono'
