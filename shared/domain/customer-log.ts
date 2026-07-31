/**
 * 顧客ログの入力検証（API サービス / mockup モックモードで共有 = パリティの SoT。
 * レビュー指摘 2026-07-31: 両者の重複実装で検証順・メッセージ・法人格のみ会社名の扱いが割れたため、
 * 純関数へ集約する = 原則3）。
 * - 返り値は「エラーメッセージ | null」。API 側は AKO-CLG-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - 検証順も本モジュールの並び（日付 → 開始 → 終了 → 範囲 → タグ → メモ → 会社）を両者で守る。
 */
import { normalizeCompanyName } from './name-match'
import { CUSTOMER_LOG_TAG_CAP, CUSTOMER_LOG_TAGS_MAX } from './types'

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

/** YYYY-MM-DD かつ実在日か（2026-13-40 / 2026-02-30 を弾く。DB の 22007→500 を防ぐ共通判定） */
export function isRealDateKey(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
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
 * = 意味のないマスタを新規登録しない（レビュー指摘 m-2）
 */
export function customerLogCompanyError(companyId: string, newCompanyName: string): string | null {
  if (companyId) return null
  if (!newCompanyName.trim() || !normalizeCompanyName(newCompanyName)) return '顧客(会社)を選択してください'
  return null
}
