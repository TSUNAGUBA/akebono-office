/**
 * 顧客別ダッシュボードの AI 分析（改善要望 2026-08-21・F-54）。
 * 顧客ログ（顧客活動）・営業案件・サポート活動・顧客コンテキストから、顧客ごとの
 * エンゲージメント傾向・リスク・推奨アクションを**決定的に**導出する純粋関数（Vue/DB 非依存）。
 *
 * 設計判断: 定量情報 KPI（customer-context の computeLogStats）や業態サマリー
 * （portfolio-insight の buildSegmentSummary）と同じ「常時ライブ導出・保存しない」方式。
 * 各記録系（SoT）から表示のたびに導くため、同期バグ・鮮度切れが構造的に起きない（原則6）。
 * Math.random 非依存（同じ入力 → 常に同じ出力）。
 */
import { addDays } from './jst'

// ---------- 入力（各記録系の必要最小限の射影） ----------

export interface CustomerInsightLog {
  /** 活動日（YYYY-MM-DD） */
  logDate: string
  /** 活動目的タグ（CUSTOMER_LOG_TAG_PRESETS + 自由入力） */
  tags: string[]
}

export interface CustomerInsightDeal {
  /** 商談フェーズ（SALES_ACTIVITY_PHASES） */
  phase: string
  /** 商談金額（円・null = 未定） */
  amount: number | null
}

export interface CustomerInsightSupport {
  /** ステータス（SUPPORT_ACTIVITY_STATUSES） */
  status: string
}

export interface CustomerInsightContext {
  vision: string
  challenges: string
  strategyNotes: string
  businessNotes?: string
}

export interface CustomerInsightInput {
  companyName: string
  /** 集計基準日（YYYY-MM-DD。通常は今日 = todayJst()） */
  asOf: string
  /** 顧客活動（取消済みを除く） */
  logs: CustomerInsightLog[]
  /** 営業案件（取消済みを除く） */
  deals: CustomerInsightDeal[]
  /** サポート活動（取消済みを除く） */
  supports: CustomerInsightSupport[]
  /** 顧客コンテキストの定性情報（未登録は null） */
  context: CustomerInsightContext | null
}

// ---------- 出力 ----------

export type EngagementTrend = 'up' | 'flat' | 'down' | 'none'

export interface CustomerEngagement {
  /** 直近 90 日の顧客活動件数 */
  recentCount: number
  /** その前 90 日の顧客活動件数 */
  prevCount: number
  /** 接点の増減（recent vs prev。両方 0 = none） */
  trend: EngagementTrend
  /** 最終接点日（YYYY-MM-DD。活動なしは null） */
  lastContact: string | null
  /** 最終接点からの経過日数（活動なしは null） */
  daysSinceContact: number | null
}

export interface CustomerInsight {
  /** 現状サマリー（箇条書き） */
  summary: string[]
  engagement: CustomerEngagement
  /** 活動目的の上位（最大 3 件） */
  topTags: { tag: string; count: number }[]
  /** リスク・注意点 */
  risks: string[]
  /** 推奨アクション */
  actions: string[]
}

/** 進行中とみなす商談フェーズか（決着 = 受注・失注以外はすべて進行中。SALES_ACTIVITY_PHASES に
 *  フェーズが増えても既定で進行中に数える安全側 = 語彙の複製リストを持たない・原則3。
 *  アプローチリスト / 顧客別ダッシュボードの件数導出でも共用する単一判定） */
export function isOpenDealPhase(phase: string): boolean {
  return phase !== '受注' && phase !== '失注'
}
/** フォロー切れとみなす最終接点からの日数 */
export const CONTACT_STALE_DAYS = 60

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** コンテキストの定性情報が 1 つでも埋まっているか */
export function hasContextInfo(ctx: CustomerInsightContext | null): boolean {
  if (!ctx) return false
  return [ctx.vision, ctx.challenges, ctx.strategyNotes, ctx.businessNotes ?? '']
    .some(s => s.trim() !== '')
}

/**
 * 顧客ログ等から顧客インサイトを決定的に導出する。
 * ロジックは閾値ベース（LLM 不使用 = デュアルモード共通。API/モックとも同一の分析を表示する）。
 */
export function buildCustomerInsight(input: CustomerInsightInput): CustomerInsight {
  const recentFrom = addDays(input.asOf, -89)
  const prevFrom = addDays(input.asOf, -179)
  const prevTo = addDays(recentFrom, -1)

  const dated = input.logs.filter(l => l.logDate <= input.asOf)
  const recent = dated.filter(l => l.logDate >= recentFrom)
  const prev = dated.filter(l => l.logDate >= prevFrom && l.logDate <= prevTo)
  const lastContact = dated.reduce<string | null>(
    (max, l) => (max === null || l.logDate > max ? l.logDate : max), null)
  const daysSince = lastContact === null ? null : daysBetween(lastContact, input.asOf)

  let trend: EngagementTrend = 'flat'
  if (recent.length === 0 && prev.length === 0) trend = 'none'
  else if (recent.length > prev.length) trend = 'up'
  else if (recent.length < prev.length) trend = 'down'

  // 活動目的の上位（件数降順 → タグ名昇順で決定的）
  const tagCount = new Map<string, number>()
  for (const l of recent) for (const t of l.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
  const topTags = [...tagCount.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 3)

  const openDeals = input.deals.filter(d => isOpenDealPhase(d.phase))
  const wonDeals = input.deals.filter(d => d.phase === '受注')
  const openAmount = openDeals.reduce((s, d) => s + (d.amount ?? 0), 0)
  const unresolvedSupports = input.supports.filter(s => s.status !== '解決')

  // ---------- サマリー ----------
  const summary: string[] = []
  summary.push(trend === 'none'
    ? `直近 90 日の顧客活動はありません（それ以前を含む記録 ${dated.length} 件）`
    : `直近 90 日の顧客活動は ${recent.length} 件（前の 90 日は ${prev.length} 件・接点は${trend === 'up' ? '増加' : trend === 'down' ? '減少' : '横ばい'}）`)
  if (openDeals.length > 0) {
    summary.push(`進行中の商談は ${openDeals.length} 件${openAmount > 0 ? `（想定金額合計 ${openAmount.toLocaleString('ja-JP')} 円）` : ''}`)
  }
  if (wonDeals.length > 0) summary.push(`受注済みの商談が ${wonDeals.length} 件あります`)
  if (topTags.length > 0) {
    summary.push(`直近の活動目的の中心は「${topTags.map(t => t.tag).join('」「')}」です`)
  }
  if (hasContextInfo(input.context)) summary.push('顧客コンテキスト（定性情報）が整備されています')

  // ---------- リスク ----------
  const risks: string[] = []
  if (daysSince !== null && daysSince >= CONTACT_STALE_DAYS) {
    risks.push(`最終接点（${lastContact}）から ${daysSince} 日が経過しています`)
  }
  if (trend === 'down' && prev.length >= 2) {
    risks.push('接点の頻度が前の 90 日より減少しています（関係の希薄化に注意）')
  }
  if (unresolvedSupports.length > 0) {
    risks.push(`未解決のサポート対応が ${unresolvedSupports.length} 件あります（体験の毀損に注意）`)
  }
  if (openDeals.length > 0 && trend === 'none') {
    risks.push('進行中の商談があるのに直近 90 日の顧客活動記録がありません')
  }

  // ---------- 推奨アクション ----------
  const actions: string[] = []
  if (daysSince === null) {
    actions.push(`${input.companyName} との最初の接点をつくり、顧客活動として記録しましょう`)
  } else if (daysSince >= CONTACT_STALE_DAYS) {
    actions.push('フォローアップの接点（訪問・Web会議など）を計画し、顧客活動へ記録しましょう')
  }
  if (!hasContextInfo(input.context)) {
    actions.push('顧客コンテキストの定性情報（ビジョン・経営課題）を整備すると提案の質が上がります')
  }
  if (unresolvedSupports.length > 0) {
    actions.push('未解決のサポート対応を先に解消し、信頼を維持しましょう')
  }
  if (openDeals.length === 0 && recent.length > 0) {
    actions.push('接点はあるのに進行中の商談がありません。営業活動（案件）としての立ち上げを検討しましょう')
  }
  if (actions.length === 0) {
    actions.push('良好な状態です。現在の接点頻度を維持し、商談の次アクションを進めましょう')
  }

  return {
    summary,
    engagement: {
      recentCount: recent.length,
      prevCount: prev.length,
      trend,
      lastContact,
      daysSinceContact: daysSince,
    },
    topTags,
    risks,
    actions,
  }
}

/**
 * 月次の顧客活動件数（直近 months か月・昇順。チャート用）。
 * month キーは YYYY-MM。asOf の月を右端に含む。
 */
export function customerActivityMonthly(
  logs: CustomerInsightLog[], asOf: string, months: number,
): { month: string; count: number }[] {
  const out: { month: string; count: number }[] = []
  const [y, m] = [Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))]
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({ month: key, count: logs.filter(l => l.logDate.startsWith(key)).length })
  }
  return out
}
