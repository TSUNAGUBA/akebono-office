/**
 * 現在の業態（事業セグメント）コンテキスト（マルチ業態。F-20 拡張）
 *
 * 1 テナントで複数の業態を扱うため、「今どの業態で作業しているか」をユーザー単位で保持する。
 * 配下のアプリ（売上・商品・発注 等）は毎回業態を選ばせず、この現在業態を既定値として使う
 * （ユーザーは各画面で「全セグメント」や他業態へ切り替え可能 = 非破壊）。
 *
 * 永続化パターンは useCurrentUser を踏襲（useState + localStorage・SSR 安全・原則3）。
 * 「現在の業態」の解決（無効 id のフォールバック）は utils/akebono の純関数 resolveDefaultSegmentId に集約。
 */
import type { BusinessSegment } from '~/types/akebono'
import { INDUSTRY_TYPE_LABELS, resolveDefaultSegmentId } from '~/utils/akebono'

const STORAGE_KEY = 'ako.currentSegment.v1'

export function useCurrentSegment() {
  const { tbl } = useMockDb()
  const segments = tbl('businessSegments')

  /** 有効な業態（表示順） */
  const activeSegments = computed(() =>
    (segments.value as BusinessSegment[])
      .filter(s => s.active !== false)
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder))

  /** 選択中の業態 id（未選択 = '' のときは先頭業態に解決される） */
  const currentSegmentId = useState<string>('ako-current-segment', () => {
    if (import.meta.client) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) return saved
      } catch { /* noop */ }
    }
    return ''
  })

  /**
   * 実効業態 id（常に有効な業態 id を返す。業態が無ければ ''）。
   * 保存済み id が無効化・削除された場合も先頭業態へフォールバックする。
   */
  const effectiveSegmentId = computed(() =>
    resolveDefaultSegmentId(currentSegmentId.value, activeSegments.value))

  /** 現在の業態レコード（無ければ null） */
  const currentSegment = computed<BusinessSegment | null>(() =>
    activeSegments.value.find(s => s.id === effectiveSegmentId.value) ?? null)

  /** 現在業態の業種タイプ表示名（例: 小売業 / 情報サービス業） */
  const currentIndustryLabel = computed(() =>
    currentSegment.value ? INDUSTRY_TYPE_LABELS[currentSegment.value.industryType] : '')

  /** 業態を切り替える（有効な業態のみ。localStorage へ永続化） */
  function switchSegment(id: string): void {
    if (!activeSegments.value.some(s => s.id === id)) return
    currentSegmentId.value = id
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, id) } catch { /* noop */ }
    }
  }

  return {
    activeSegments,
    currentSegmentId,
    effectiveSegmentId,
    currentSegment,
    currentIndustryLabel,
    switchSegment,
  }
}
