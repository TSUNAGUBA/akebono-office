/**
 * メディア分析メトリクス（Google Analytics 由来の集計の型 + 決定的導出）。
 * フロント（モック）/ API 共有の純粋関数。Math.random 非依存（同じ入力 → 常に同じ出力）。
 *
 * 本実装では Google Analytics Data API（GA4 runReport）の結果をこの `MediaMetrics` へ整形する。
 * モックでは「サイトの記事インベントリ（MediaArticleInput）」から GA 風の指標を決定的に生成し、
 * 実 API と同一の型・同一のインサイト生成（heuristicMediaInsight）を通す（原則: モック/API パリティ）。
 */
import { addDays, weekdayOf } from './jst'

// ---------- 入力（サイトのコンテンツ資産 = GA の page に対応） ----------

export interface MediaArticleInput {
  id: string
  title: string
  /** サイト内パス（例: /blog/xxx）。GA の pagePath に対応 */
  path: string
  /** セクション（サイト構成の第 1 階層。例: ブログ / サービス / 導入事例） */
  section: string
  /** 公開日（YYYY-MM-DD） */
  publishedAt: string
  /** 記事の分量（本文文字数の目安）。SEO・滞在の重み付けに使う */
  wordCount: number
  origin: 'seed' | 'generated'
}

export interface DeriveOptions {
  segmentId: string
  siteName: string
  /** 集計基準日（この日まで。通常は前日 = 前日基準で悲観評価しない） */
  asOf: string
  /** 集計期間の日数（既定 28 日） */
  days: number
}

// ---------- 出力（GA 由来の集計。実 API と同一型） ----------

export interface MediaPageStat {
  id: string
  title: string
  path: string
  section: string
  pageviews: number
  users: number
  avgEngagementSec: number
  entrances: number
  bounceRate: number
  convRate: number
  conversions: number
  /** 前期間の表示数（増減の算出用） */
  prevPageviews: number
}

export interface MediaChannelStat { channel: string; sessions: number; conversions: number }
export interface MediaDeviceStat { device: string; sessions: number }
export interface MediaSectionStat {
  section: string
  pages: number
  pageviews: number
  avgEngagementSec: number
  convRate: number
}
export interface MediaDailyPoint { date: string; sessions: number; users: number; conversions: number }

export interface MediaMetrics {
  segmentId: string
  siteName: string
  periodFrom: string
  periodTo: string
  days: number
  // 総計
  sessions: number
  users: number
  newUsers: number
  pageviews: number
  avgEngagementSec: number
  engagementRate: number
  bounceRate: number
  conversions: number
  conversionRate: number
  // 前期間（同じ日数の直前期間）
  prevSessions: number
  prevUsers: number
  prevPageviews: number
  prevConversions: number
  // 内訳
  channels: MediaChannelStat[]
  devices: MediaDeviceStat[]
  daily: MediaDailyPoint[]
  topPages: MediaPageStat[]
  sections: MediaSectionStat[]
  articleCount: number
}

// ---------- 決定的ハッシュ（rng.ts と同型の FNV-1a。shared 内で自己完結） ----------

function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
/** キーから [0,1) の決定的な値 */
function unit(key: string): number {
  return hashStr(key) / 0x100000000
}

// ---------- セクション別の重み（サイト構成の性格を反映） ----------

const SECTION_TRAFFIC_WEIGHT: Record<string, number> = {
  ブログ: 1.0, コラム: 0.9, サービス: 1.25, 導入事例: 1.15, お知らせ: 0.45, 料金: 0.8, トップ: 1.6,
}
const SECTION_CONV_BASE: Record<string, number> = {
  ブログ: 0.016, コラム: 0.013, サービス: 0.052, 導入事例: 0.061, お知らせ: 0.006, 料金: 0.07, トップ: 0.03,
}
function sectionWeight(section: string): number { return SECTION_TRAFFIC_WEIGHT[section] ?? 1.0 }
function sectionConvBase(section: string): number { return SECTION_CONV_BASE[section] ?? 0.02 }

/** 日付差（日数。a→b が過去なら負）。純粋計算 */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 公開からの経過に応じた鮮度係数（新しいほど高い。0.32〜1.45） */
function recencyFactor(publishedAt: string, asOf: string): number {
  const age = Math.max(0, daysBetween(publishedAt, asOf))
  return Math.min(1.45, Math.max(0.32, 1.45 - age / 260))
}

/** 記事 1 本の指定期間の表示数（決定的） */
function pageviewsOf(a: MediaArticleInput, seed: string, periodTag: string, asOf: string): number {
  const wc = 0.8 + Math.min(a.wordCount, 3200) / 3200 * 0.6
  const base = 90 + unit(`${seed}:pv:${a.id}:${periodTag}`) * 820
  return Math.max(0, Math.round(base * sectionWeight(a.section) * recencyFactor(a.publishedAt, asOf) * wc))
}

function pageStatOf(
  a: MediaArticleInput, seed: string,
  periodFrom: string, periodTo: string, prevFrom: string, prevTo: string,
): MediaPageStat {
  const pv = pageviewsOf(a, seed, `${periodFrom}_${periodTo}`, periodTo)
  const prevPv = pageviewsOf(a, seed, `${prevFrom}_${prevTo}`, prevTo)
  const users = Math.max(1, Math.round(pv * (0.62 + unit(`${seed}:u:${a.id}`) * 0.18)))
  const avgEngagementSec = Math.round(35 + unit(`${seed}:eng:${a.id}`) * 195)
  const bounceRate = Math.round((0.30 + unit(`${seed}:b:${a.id}`) * 0.42) * 1000) / 1000
  const entrances = Math.round(pv * (0.28 + unit(`${seed}:ent:${a.id}`) * 0.34))
  const convRate = Math.round(
    (sectionConvBase(a.section) * (0.6 + unit(`${seed}:cv:${a.id}`) * 1.1)) * 10000) / 10000
  const conversions = Math.round(users * convRate)
  return {
    id: a.id, title: a.title, path: a.path, section: a.section,
    pageviews: pv, users, avgEngagementSec, entrances, bounceRate, convRate, conversions, prevPageviews: prevPv,
  }
}

/** 決定的な比率分割（base 重み × セグメント差分）を合計値 total へ割り付ける */
function splitByWeight(
  keys: { key: string; base: number }[], total: number, seed: string, salt: string,
): { key: string; value: number }[] {
  const weighted = keys.map(k => ({ key: k.key, w: k.base * (0.7 + unit(`${seed}:${salt}:${k.key}`) * 0.6) }))
  const sum = weighted.reduce((s, x) => s + x.w, 0) || 1
  let allocated = 0
  const out = weighted.map((x, i) => {
    if (i === weighted.length - 1) return { key: x.key, value: Math.max(0, total - allocated) }
    const v = Math.round(total * x.w / sum)
    allocated += v
    return { key: x.key, value: v }
  })
  return out
}

const CHANNELS: { key: string; base: number; conv: number }[] = [
  { key: 'オーガニック検索', base: 3.2, conv: 1.0 },
  { key: '直接', base: 1.6, conv: 1.05 },
  { key: 'ソーシャル', base: 1.15, conv: 0.7 },
  { key: 'リファラル', base: 0.9, conv: 0.95 },
  { key: '有料広告', base: 0.85, conv: 1.35 },
  { key: 'メール', base: 0.5, conv: 1.45 },
]
const DEVICES: { key: string; base: number }[] = [
  { key: 'モバイル', base: 0.60 }, { key: 'デスクトップ', base: 0.34 }, { key: 'タブレット', base: 0.06 },
]

/**
 * サイトの記事インベントリから GA 風メトリクスを決定的に導出する（モックの唯一のロジック）。
 * 実 API では GA4 runReport の結果をこの型へ整形する（同じインサイト生成を通す）。
 */
export function deriveMediaMetrics(articles: MediaArticleInput[], opts: DeriveOptions): MediaMetrics {
  const days = Math.max(1, opts.days)
  const periodTo = opts.asOf
  const periodFrom = addDays(periodTo, -(days - 1))
  const prevTo = addDays(periodFrom, -1)
  const prevFrom = addDays(prevTo, -(days - 1))
  const seed = `media:${opts.segmentId}`

  // 集計対象は「基準日までに公開済み」の記事
  const live = articles.filter(a => a.publishedAt <= periodTo)
  const pages = live.map(a => pageStatOf(a, seed, periodFrom, periodTo, prevFrom, prevTo))
    .sort((x, y) => y.pageviews - x.pageviews)

  const pageviews = pages.reduce((s, p) => s + p.pageviews, 0)
  const prevPageviews = pages.reduce((s, p) => s + p.prevPageviews, 0)
  // サイト全体のユーザーは記事横断の重複を反映して縮約（Σページユーザー × 0.55）
  const users = Math.round(pages.reduce((s, p) => s + p.users, 0) * 0.55)
  const sessions = Math.round(users * 1.28)
  const newUsers = Math.round(users * (0.45 + unit(`${seed}:new`) * 0.2))
  const conversions = pages.reduce((s, p) => s + p.conversions, 0)
  const engagedWeightedBounce = pageviews > 0
    ? pages.reduce((s, p) => s + p.bounceRate * p.pageviews, 0) / pageviews : 0.5
  const avgEngagementSec = pageviews > 0
    ? Math.round(pages.reduce((s, p) => s + p.avgEngagementSec * p.pageviews, 0) / pageviews) : 0
  const bounceRate = Math.round(engagedWeightedBounce * 1000) / 1000
  const engagementRate = Math.round((1 - bounceRate) * 1000) / 1000
  const conversionRate = sessions > 0 ? Math.round(conversions / sessions * 10000) / 10000 : 0

  // 前期間（同じ日数）— 総量比のみ用いるため簡略に前期表示数から比例縮尺
  const prevScale = pageviews > 0 ? prevPageviews / pageviews : 1
  const prevSessions = Math.round(sessions * prevScale)
  const prevUsers = Math.round(users * prevScale)
  const prevConversions = Math.round(conversions * prevScale)

  // チャネル内訳
  const chSessions = splitByWeight(CHANNELS.map(c => ({ key: c.key, base: c.base })), sessions, seed, 'ch')
  const convWeight = CHANNELS.map(c => ({ key: c.key, base: c.base * c.conv }))
  const chConv = splitByWeight(convWeight, conversions, seed, 'chcv')
  const channels: MediaChannelStat[] = CHANNELS.map(c => ({
    channel: c.key,
    sessions: chSessions.find(x => x.key === c.key)?.value ?? 0,
    conversions: chConv.find(x => x.key === c.key)?.value ?? 0,
  }))

  // デバイス内訳
  const dev = splitByWeight(DEVICES, sessions, seed, 'dev')
  const devices: MediaDeviceStat[] = DEVICES.map(d => ({
    device: d.key, sessions: dev.find(x => x.key === d.key)?.value ?? 0,
  }))

  // 日別（曜日パターン: 平日高・週末低 + 決定的ノイズ）
  const dailyWeights: number[] = []
  for (let i = 0; i < days; i++) {
    const date = addDays(periodFrom, i)
    const dow = weekdayOf(date)
    const weekend = dow === 0 || dow === 6 ? 0.62 : 1.0
    dailyWeights.push(weekend * (0.8 + unit(`${seed}:day:${date}`) * 0.4))
  }
  const wSum = dailyWeights.reduce((s, x) => s + x, 0) || 1
  // 残量から配分する（各日を「残り」でクランプ・最終日は残り全量）。
  // 丸め誤差があっても各値は非負かつ Σ = 総量 を厳密に満たす（微少トラフィックでの破綻防止）。
  let sRem = sessions; let uRem = users; let cRem = conversions
  const daily: MediaDailyPoint[] = dailyWeights.map((w, i) => {
    const date = addDays(periodFrom, i)
    const last = i === days - 1
    const s = last ? sRem : Math.min(sRem, Math.round(sessions * w / wSum))
    const u = last ? uRem : Math.min(uRem, Math.round(users * w / wSum))
    const c = last ? cRem : Math.min(cRem, Math.round(conversions * w / wSum))
    sRem -= s; uRem -= u; cRem -= c
    return { date, sessions: s, users: u, conversions: c }
  })

  // セクション別
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
    section, pages: v.pages, pageviews: v.pageviews,
    avgEngagementSec: v.pageviews > 0 ? Math.round(v.engSum / v.pageviews) : 0,
    convRate: v.userSum > 0 ? Math.round(v.convSum / v.userSum * 10000) / 10000 : 0,
  })).sort((a, b) => b.pageviews - a.pageviews)

  return {
    segmentId: opts.segmentId,
    siteName: opts.siteName,
    periodFrom, periodTo, days,
    sessions, users, newUsers, pageviews, avgEngagementSec, engagementRate, bounceRate,
    conversions, conversionRate,
    prevSessions, prevUsers, prevPageviews, prevConversions,
    channels, devices, daily,
    topPages: pages.slice(0, 12),
    sections,
    articleCount: live.length,
  }
}

// ---------- 月次トレンド（業務 × メディアの統合分析で使う） ----------

export interface MediaMonthlyPoint { month: string; sessions: number; users: number; conversions: number }

/** 記事インベントリから月次の GA 風トレンドを決定的に導出する（月末基準の鮮度で公開前月は 0） */
export function deriveMonthlyMediaTrend(
  articles: MediaArticleInput[], months: string[], segmentId: string,
): MediaMonthlyPoint[] {
  const seed = `media:${segmentId}`
  return months.map((month) => {
    const monthEnd = `${month}-28`
    const live = articles.filter(a => a.publishedAt <= monthEnd)
    let pv = 0; let userSum = 0; let conv = 0
    for (const a of live) {
      const p = pageviewsOf(a, seed, `m:${month}`, monthEnd)
      const u = Math.max(1, Math.round(p * (0.62 + unit(`${seed}:u:${a.id}`) * 0.18)))
      const cr = sectionConvBase(a.section) * (0.6 + unit(`${seed}:cv:${a.id}`) * 1.1)
      pv += p; userSum += u; conv += Math.round(u * cr)
    }
    const users = Math.round(userSum * 0.55)
    return { month, sessions: Math.round(users * 1.28), users, conversions: conv }
  })
}
