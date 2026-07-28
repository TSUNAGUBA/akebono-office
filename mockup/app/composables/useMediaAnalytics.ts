/**
 * メディア分析メトリクス（GA 由来の集計）。
 * - モック: サイトの記事インベントリ（mediaArticles）から決定的に GA 風メトリクスを導出（shared/domain/media-metrics）
 * - 本実装: GA4 Data API の runReport 結果を同じ型へ整形する（インサイト生成は共通）
 * - 統合分析（業務 × メディア）は当該セグメントの売上明細（salesRecords）を月次集計して突き合わせる
 *
 * 集計基準日は「前日（asOf）」（週次インサイトと同じ思想 = 当日を未確定として悲観評価しない）。
 */
import type { SalesRecord } from '~/types/akebono'
import type { MediaArticle } from '~/types/media'
import {
  deriveMediaMetrics, deriveMonthlyMediaTrend,
  type MediaArticleInput, type MediaMetrics,
} from '../../../shared/domain/media-metrics'
import type { IntegratedMetrics } from '../../../shared/domain/media-integrated'

/**
 * 直近 N ヶ月の月キー（古い順）。
 * endBackMonths=0 は今日の月で終わる。統合分析は「最終月 = 直前の完了月」（endBackMonths=1）を基準にする
 * （進行中の当月を締めていない売上で悲観評価しないため。前日基準と同じ思想）。
 */
function recentMonths(n: number, endBackMonths = 0): string[] {
  const cur = todayJst().slice(0, 7)
  const y = Number(cur.slice(0, 4))
  const m0 = Number(cur.slice(5, 7))
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const m = m0 - 1 - endBackMonths - i
    const ny = y + Math.floor(m / 12)
    const nm = ((m % 12) + 12) % 12
    out.push(`${ny}-${String(nm + 1).padStart(2, '0')}`)
  }
  return out
}

export function useMediaAnalytics() {
  const { tbl } = useMockDb()
  const articlesTbl = tbl('mediaArticles')
  const salesTbl = tbl('salesRecords')
  const { segmentById } = useCurrentSegment()
  const { settingFor } = useMediaSettings()

  /** 集計基準日（前日） */
  const asOf = computed(() => addDays(todayJst(), -1))

  /** セグメントの記事インベントリ（GA 導出の入力） */
  function articleInputsFor(segmentId: string): MediaArticleInput[] {
    return (articlesTbl.value as MediaArticle[])
      .filter(a => a.segmentId === segmentId && a.active !== false && a.status === 'published')
      .map(a => ({
        id: a.id, title: a.title, path: a.path, section: a.section,
        publishedAt: a.publishedAt, wordCount: a.wordCount, origin: a.origin,
      }))
  }

  /** GA 風メトリクスを導出する（既定 28 日） */
  function metricsFor(segmentId: string, days = 28): MediaMetrics {
    const setting = settingFor(segmentId)
    return deriveMediaMetrics(articleInputsFor(segmentId), {
      segmentId,
      siteName: setting?.siteName ?? 'メディア',
      asOf: asOf.value,
      days,
    })
  }

  /** 当該セグメントの売上を月次集計（active な売上明細。赤黒訂正は amount 相殺で反映） */
  function businessMonthly(segmentId: string, months: string[]): Map<string, { amount: number; orders: number }> {
    const map = new Map<string, { amount: number; orders: number }>()
    for (const m of months) map.set(m, { amount: 0, orders: 0 })
    for (const r of salesTbl.value as SalesRecord[]) {
      if (r.segmentId !== segmentId || r.active === false) continue
      const month = r.salesDate.slice(0, 7)
      const cur = map.get(month)
      if (!cur) continue
      cur.amount += r.amount
      // 受注件数は正の明細のみ数える（赤黒の相殺行は件数に数えない）
      if (r.amount > 0) cur.orders += 1
    }
    return map
  }

  /** 業務 × メディアの統合メトリクスを組み立てる（直近 monthsCount ヶ月） */
  function integratedMetricsFor(segmentId: string, monthsCount = 6): IntegratedMetrics {
    // 最終月は直前の完了月（進行中の当月は締め前のため対象外）
    const months = recentMonths(monthsCount, 1)
    const setting = settingFor(segmentId)
    const seg = segmentById(segmentId)
    const mediaTrend = deriveMonthlyMediaTrend(articleInputsFor(segmentId), months, segmentId)
    const biz = businessMonthly(segmentId, months)
    const trend = months.map((month, i) => {
      const mt = mediaTrend[i]!
      const b = biz.get(month) ?? { amount: 0, orders: 0 }
      return { month, sessions: mt.sessions, conversions: mt.conversions, salesAmount: b.amount, orders: b.orders }
    })
    const cur = trend[trend.length - 1]!
    const prev = trend[trend.length - 2] ?? { sessions: 0, conversions: 0, salesAmount: 0, orders: 0 }
    const aov = cur.orders > 0 ? Math.round(cur.salesAmount / cur.orders) : 0
    const salesPerSession = cur.sessions > 0 ? Math.round(cur.salesAmount / cur.sessions) : 0
    return {
      segmentId,
      segmentName: seg?.name ?? 'セグメント',
      siteName: setting?.siteName ?? 'メディア',
      periodMonth: cur.month,
      sessions: cur.sessions,
      conversions: cur.conversions,
      conversionRate: cur.sessions > 0 ? Math.round(cur.conversions / cur.sessions * 10000) / 10000 : 0,
      prevSessions: prev.sessions,
      prevConversions: prev.conversions,
      salesAmount: cur.salesAmount,
      orders: cur.orders,
      prevSalesAmount: prev.salesAmount,
      aov,
      salesPerSession,
      funnel: {
        sessions: cur.sessions,
        engaged: Math.round(cur.sessions * 0.55),
        conversions: cur.conversions,
        orders: cur.orders,
      },
      trend,
    }
  }

  return { asOf, articleInputsFor, metricsFor, integratedMetricsFor, businessMonthly }
}
