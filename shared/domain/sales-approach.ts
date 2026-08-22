/**
 * 営業アプローチリスト（改善要望 2026-08-21・F-53）の入力検証。
 * API サービス / home モックモードで共有する = パリティの SoT（activity.ts と同じ設計）。
 * - 返り値は「エラーメッセージ | null」。API 側は AKO-SAP-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - 検証順は salesApproachError() 内の並びが規約（API・モックとも同一順で適用する）。
 * - 区分値（状態・優先度）のプリセットは shared/domain/types.ts が SoT（「値=ラベル」方式）。
 */
import { activityDateError, activityEnumError, ACTIVITY_BODY_CAP, ACTIVITY_TITLE_CAP } from './activity'
import { SALES_APPROACH_PRIORITIES, SALES_APPROACH_STATUSES } from './types'

/** 次のアクション（短文）の上限（コードポイント） */
export const SALES_APPROACH_ACTION_CAP = ACTIVITY_TITLE_CAP
/** 方針メモ（長文）の上限（コードポイント） */
export const SALES_APPROACH_NOTE_CAP = ACTIVITY_BODY_CAP

export interface SalesApproachInput {
  /** 対象の顧客(会社) id（必須。既存マスタから選択 = アプローチリストは既存顧客が対象） */
  companyId: string
  /** アプローチ状態（SALES_APPROACH_STATUSES） */
  status: string
  /** 優先度（SALES_APPROACH_PRIORITIES） */
  priority: string
  /** 担当（Member 参照。空 = ログインユーザーへ既定化は呼び出し側） */
  assigneeMemberId: string
  /** 次のアクション（任意） */
  nextAction: string
  /** 次のアクション日（YYYY-MM-DD・任意） */
  nextActionDate: string | null
  /** アプローチ方針・メモ（任意） */
  note: string
}

/**
 * 営業アプローチの入力検証（宣言順 = API/モック共通の適用順）。
 * 顧客 → 状態 → 優先度 → 次のアクション日。
 */
export function salesApproachError(input: SalesApproachInput): string | null {
  if (!input.companyId.trim()) return '顧客(会社)を選択してください'
  return activityEnumError(input.status, SALES_APPROACH_STATUSES, 'アプローチ状態')
    ?? activityEnumError(input.priority, SALES_APPROACH_PRIORITIES, '優先度')
    ?? activityDateError(input.nextActionDate, '次のアクション日', false)
}
