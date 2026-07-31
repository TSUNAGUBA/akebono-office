/**
 * 顧客ログの入力検証（API サービス / mockup モックモードで共有 = パリティの SoT。
 * レビュー指摘 2026-07-31: 両者の重複実装で検証順・メッセージ・法人格のみ会社名の扱いが割れたため、
 * 純関数へ集約する = 原則3）。
 * - 返り値は「エラーメッセージ | null」。API 側は AKO-CLG-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - 検証順も本モジュールの並び（日付 → 開始 → 終了 → 範囲 → タグ → メモ → 会社）を両者で守る。
 */
import { isRealDateKey } from './jst'
import { normalizeCompanyName } from './name-match'
import { CUSTOMER_LOG_TAG_CAP, CUSTOMER_LOG_TAGS_MAX } from './types'

// 実在日判定は汎用ユーティリティ（shared/domain/jst）が SoT。既存の参照互換のため再エクスポートする
export { isRealDateKey } from './jst'

export const CUSTOMER_LOG_BODY_CAP = 20_000
export const CUSTOMER_LOG_TITLE_CAP = 200
/** コンボボックス自由入力（会社名・担当者名）の上限（コードポイント） */
export const CUSTOMER_LOG_NAME_CAP = 120

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** コードポイント単位で cap（絵文字等を境界で壊さない。api lib/text capCp と同義の共有版） */
export function capCodePoints(s: string, n: number): string {
  const cps = [...s]
  return cps.length > n ? cps.slice(0, n).join('') : s
}

/** 日付（必須・実在日） */
export function customerLogDateError(s: string): string | null {
  if (!DATE_RE.test(s)) return '日付（何月何日）を選択してください'
  if (!isRealDateKey(s)) return '日付が正しくありません'
  return null
}

/** 時刻（HH:MM・任意。空 = null 扱いは呼び出し側）。分の 15 分単位は UI の選択肢制約（旧データ互換で API は HH:MM を許容） */
export function customerLogTimeError(s: string, label: '開始' | '終了'): string | null {
  if (!s) return null
  if (!TIME_RE.test(s)) return `${label}時間は HH:MM 形式で入力してください`
  return null
}

/** 開始・終了の組み合わせ（終了のみは不可・終了は開始より後） */
export function customerLogTimeRangeError(logTime: string | null, endTime: string | null): string | null {
  if (endTime && !logTime) return '終了時間を入力する場合は開始時間も入力してください'
  if (logTime && endTime && endTime <= logTime) return '終了時間は開始時間より後にしてください'
  return null
}

/** 属性タグの正規化（trim・上限 cap・重複除去）。件数上限の検証は customerLogTagsError */
export function cleanCustomerLogTags(tags: readonly unknown[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const s = capCodePoints(String(t ?? '').trim(), CUSTOMER_LOG_TAG_CAP)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 属性タグの検証（配列であること・正規化後の件数上限） */
export function customerLogTagsError(tags: unknown): string | null {
  if (tags === undefined || tags === null) return null
  if (!Array.isArray(tags)) return '属性タグの形式が正しくありません'
  if (cleanCustomerLogTags(tags).length > CUSTOMER_LOG_TAGS_MAX) {
    return `属性タグは ${CUSTOMER_LOG_TAGS_MAX} 件までです`
  }
  return null
}

/** 担当者メモ・議事録メモ（どちらか必須） */
export function customerLogMemoError(body: string, minutesMemo: string): string | null {
  if (!body.trim() && !minutesMemo.trim()) return '担当者メモまたは議事録メモを入力してください'
  return null
}

/**
 * 顧客(会社)の指定（companyId または newCompanyName のどちらか必須）。
 * 自由入力は正規化名（法人格・空白ゆらぎ除去）が空になる名前（例「株式会社」のみ）を弾く
 * = 意味のないマスタを新規登録しない（レビュー指摘 m-2）。
 * 判定は登録時と同じ **NAME_CAP で切り詰めた後の名前**で行う（未 cap 名で判定すると
 * 「法人格の羅列 120cp + 実名」が検証を通過して cap 後に空正規化名のマスタが生まれる = レビュー 2 巡目 NIT-2）
 */
export function customerLogCompanyError(companyId: string, newCompanyName: string): string | null {
  if (companyId) return null
  const capped = capCodePoints(newCompanyName.trim(), CUSTOMER_LOG_NAME_CAP)
  if (!capped || !normalizeCompanyName(capped)) return '顧客(会社)を選択してください'
  return null
}
