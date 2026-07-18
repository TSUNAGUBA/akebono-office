/**
 * 稼働状況の日次集計（F-11。フロント/API 共有の純粋関数）。
 * SoT はインシデント（service_incidents）で、uptime_daily はその導出（日次集計）。
 * - 停止時間 = インシデントの startedAt〜resolvedAt（未解決は now まで）を JST 日境界で分割した分数
 * - worstState = その日に重なるインシデントの影響度写像の最悪値（重なりなしは operational）
 * - 同日に複数インシデントが重なる場合、downMinutes は「いずれかのインシデントが継続中」の
 *   分数の合算ではなく区間の和集合で数える（二重計上しない）
 */
import type { IncidentImpact, ServiceIncident, UptimeDaily } from './types'
import { addDays } from './jst'

export type ServiceState = UptimeDaily['worstState']

/** 影響度 → 状態の写像（mockup useSystemStatus と同一） */
export const IMPACT_TO_STATE: Record<IncidentImpact, ServiceState> = {
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
}

/** 状態の深刻度（最悪値ロールアップ用） */
export const STATE_SEVERITY: Record<ServiceState, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
}

/** 2 状態の最悪値 */
export function worstOf(a: ServiceState, b: ServiceState): ServiceState {
  return STATE_SEVERITY[b] > STATE_SEVERITY[a] ? b : a
}

/** JST 日付キーの 0 時（epoch ms）。at 列は "+09:00" 付き ISO のため Date で決定的に解釈できる */
function dayStartMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00+09:00`)
}

interface Interval {
  fromMs: number
  toMs: number
  state: ServiceState
}

/** 区間集合の和集合の長さ（ms）。二重計上しない */
function unionMs(intervals: { fromMs: number; toMs: number }[]): number {
  const sorted = intervals
    .filter(iv => iv.toMs > iv.fromMs)
    .sort((a, b) => a.fromMs - b.fromMs)
  let total = 0
  let curFrom: number | null = null
  let curTo = 0
  for (const iv of sorted) {
    if (curFrom === null || iv.fromMs > curTo) {
      if (curFrom !== null) total += curTo - curFrom
      curFrom = iv.fromMs
      curTo = iv.toMs
    } else {
      curTo = Math.max(curTo, iv.toMs)
    }
  }
  if (curFrom !== null) total += curTo - curFrom
  return total
}

/**
 * 1 サービスのインシデント群から日次稼働状況を導出する（[fromDate, toDate] の JST 日付キー閉区間）。
 * nowIso = 未解決インシデントの停止時間をどこまで数えるか（通常は現在時刻の JST ISO）。
 * 返り値は窓内の全日（operational の日も含む）を古い順で返す。
 */
export function computeUptimeDaily(
  serviceId: string,
  incidents: Pick<ServiceIncident, 'impact' | 'startedAt' | 'resolvedAt'>[],
  fromDate: string,
  toDate: string,
  nowIso: string,
): UptimeDaily[] {
  const nowMs = Date.parse(nowIso)
  const intervals: Interval[] = incidents
    .map((i) => {
      const fromMs = Date.parse(i.startedAt)
      const toMs = i.resolvedAt ? Date.parse(i.resolvedAt) : nowMs
      return { fromMs, toMs, state: IMPACT_TO_STATE[i.impact] }
    })
    .filter(iv => Number.isFinite(iv.fromMs) && Number.isFinite(iv.toMs) && iv.toMs >= iv.fromMs)

  const rows: UptimeDaily[] = []
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const dayFrom = dayStartMs(d)
    const dayTo = dayStartMs(addDays(d, 1))
    const overlaps = intervals
      .map(iv => ({
        fromMs: Math.max(iv.fromMs, dayFrom),
        toMs: Math.min(iv.toMs, dayTo),
        state: iv.state,
      }))
      .filter(iv => iv.toMs > iv.fromMs)
    let worstState: ServiceState = 'operational'
    for (const iv of overlaps) worstState = worstOf(worstState, iv.state)
    // ゼロ長区間（発生直後の未解決インシデント等）は分数には数えないが、
    // その時点が属する日の状態としては写像する（登録と同時に当日セルへ反映される）
    for (const iv of intervals) {
      if (iv.fromMs === iv.toMs && iv.fromMs >= dayFrom && iv.fromMs < dayTo) {
        worstState = worstOf(worstState, iv.state)
      }
    }
    const downMinutes = Math.round(unionMs(overlaps) / 60000)
    rows.push({ serviceId, date: d, downMinutes, worstState })
  }
  return rows
}
