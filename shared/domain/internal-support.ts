/**
 * 社内サポート活動（改善要望 2026-08-22・F-57）の入力検証。
 * API サービス / home モックモードで共有する = パリティの SoT（activity.ts / sales-approach.ts と同じ設計）。
 * - 返り値は「エラーメッセージ | null」。API 側は AKO-ISP-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - 検証順は internalSupportError() 内の並びが規約（API・モックとも同一順で適用する）。
 * - 区分値（フォローアップ方法）のプリセットは shared/domain/types.ts が SoT（「値=ラベル」方式）。
 */
import { activityDateError, activityEnumError, activityTimeError, ACTIVITY_BODY_CAP } from './activity'
import { INTERNAL_SUPPORT_METHODS } from './types'

/** 対象業務内容・フィードバック（長文）の上限（コードポイント。活動記録 BODY_CAP と同値） */
export const INTERNAL_SUPPORT_TEXT_CAP = ACTIVITY_BODY_CAP

export interface InternalSupportInput {
  /** 活動日（YYYY-MM-DD・必須） */
  activityDate: string
  /** 活動時刻（HH:MM・任意） */
  activityTime: string | null
  /** フォローアップ実施者（Member 参照。空 = ログインユーザーへ既定化は呼び出し側） */
  performerMemberId: string
  /** フォローアップ対象者（Member 参照・必須） */
  targetMemberId: string
  /** 対象業務内容（必須） */
  taskDescription: string
  /** フォローアップ方法（INTERNAL_SUPPORT_METHODS） */
  method: string
  /** 活動結果および効果に関するフィードバック（任意） */
  feedback: string
}

/**
 * 社内サポート活動の入力検証（宣言順 = API/モック共通の適用順)。
 * 活動日 → 活動時刻 → 実施者 → 対象者 → 実施者≠対象者 → 対象業務内容 → フォローアップ方法。
 * 実施者・対象者のメンバー実在検証はデータ層の責務（API は FK・モックは composable）。
 */
export function internalSupportError(input: InternalSupportInput): string | null {
  return activityDateError(input.activityDate, '活動日', true)
    ?? activityTimeError(input.activityTime, '活動時刻')
    ?? (input.performerMemberId.trim() ? null : 'フォローアップ実施者を選択してください')
    ?? (input.targetMemberId.trim() ? null : 'フォローアップ対象者を選択してください')
    ?? (input.performerMemberId.trim() === input.targetMemberId.trim()
      ? 'フォローアップ実施者と対象者には別のメンバーを選択してください' : null)
    ?? (input.taskDescription.trim() ? null : '対象業務内容を入力してください')
    ?? activityEnumError(input.method, INTERNAL_SUPPORT_METHODS, 'フォローアップ方法')
}
