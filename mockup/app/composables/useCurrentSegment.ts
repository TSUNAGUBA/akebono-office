/**
 * 現在の業態（事業セグメント）コンテキスト（マルチ業態。F-20 拡張）
 *
 * 1 テナントで複数の業態を扱うため、「今どの業態で作業しているか」をユーザー単位で保持する。
 * 配下のアプリ（売上・商品・発注 等）は毎回業態を選ばせず、この現在業態を既定値として使う
 * （ユーザーは各画面で「全セグメント」や他業態へ切り替え可能 = 非破壊）。
 *
 * 永続化（デュアルモード）:
 *  - API モード: SoT はサーバー（/v1/me の prefs.currentSegmentId = user_preferences。0039）。
 *    **どの端末からログインしても同じ業態で開ける**（オペレーター指示 2026-07-30。§40-5 の端末ローカル判断を上書き）。
 *  - モックモード: 従来どおり端末ローカル（useState + localStorage・SSR 安全・原則3）。
 * 「現在の業態」の解決（無効 id のフォールバック）は utils/akebono の純関数 resolveDefaultSegmentId に集約
 * （保存済み id が無効化・削除されても先頭業態へ倒れるため情報損失なし = 原則2。両モード共通）。
 */
import type { BusinessSegment } from '~/types/akebono'
import {
  INDUSTRY_TYPE_LABELS, resolveDefaultSegmentId, segmentFieldDefaults,
  type SegmentFieldDefaults,
} from '~/utils/akebono'

/** モックモードの端末ローカル保存キー（API モードでは使わない） */
const STORAGE_KEY = 'ako.currentSegment.v1'
/** API モードの user_preferences キー（/v1/me の prefs 配下） */
const PREF_KEY = 'currentSegmentId'

export function useCurrentSegment() {
  const { tbl } = useMockDb()
  const isApi = useApiMode()
  const me = useApiMe()
  const segments = tbl('businessSegments')

  /** 有効な業態（表示順） */
  const activeSegments = computed(() =>
    (segments.value as BusinessSegment[])
      .filter(s => s.active !== false)
      .sort((a, b) => a.displayOrder - b.displayOrder))

  /** モックモードの選択状態（端末ローカル）。API モードでは参照しない */
  const mockSegmentId = useState<string>('ako-current-segment', () => {
    if (!isApi && import.meta.client) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) return saved
      } catch { /* noop */ }
    }
    return ''
  })

  /**
   * 選択中の業態 id（未選択 = '' のときは先頭業態に解決される）。
   * API モードはサーバー保管（me.prefs）を SoT とし、端末間で同期する。
   */
  const currentSegmentId = computed<string>(() =>
    isApi
      ? String((me.value?.prefs as Record<string, unknown> | undefined)?.[PREF_KEY] ?? '')
      : mockSegmentId.value)

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

  /**
   * 業態を切り替える（有効な業態のみ）。
   *  - API モード: 即時に楽観反映（me.prefs を更新）し、サーバー保管は非ブロッキング（原則4）。
   *    永続化に失敗しても当該セッションの選択は成立し、次回ロードで既定へ倒れるだけ（原則2）。
   *    ※同一ユーザーの高速連打は最後の書込が勝つ（last-write-wins）= UI 選択状態のため許容。
   *  - モックモード: 従来どおり端末ローカル（localStorage）へ保存。
   */
  function switchSegment(id: string): void {
    if (!activeSegments.value.some(s => s.id === id)) return
    if (isApi) {
      if (me.value) me.value = { ...me.value, prefs: { ...(me.value.prefs ?? {}), [PREF_KEY]: id } }
      void saveMePreference(PREF_KEY, id)
      return
    }
    mockSegmentId.value = id
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, id) } catch { /* noop */ }
    }
  }

  /** 業態レコードを id で解決（無効化済みも含めて全件から。編集時のフォールバック用） */
  function segmentById(id: string | null | undefined): BusinessSegment | null {
    return (segments.value as BusinessSegment[]).find(s => s.id === id) ?? null
  }

  /** 業態の商品既定値（単位・課金区分・バリアント軸）。商品登録の自動適用に使う */
  function defaultsFor(id: string | null | undefined): SegmentFieldDefaults {
    return segmentFieldDefaults(segmentById(id))
  }

  return {
    activeSegments,
    currentSegmentId,
    effectiveSegmentId,
    currentSegment,
    currentIndustryLabel,
    switchSegment,
    segmentById,
    defaultsFor,
  }
}
