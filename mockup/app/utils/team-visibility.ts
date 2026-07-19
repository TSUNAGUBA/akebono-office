/**
 * チームタブの表示メンバー判定（バッチ7h → バッチ7k で候補拡大。オペレーター指示 2026-07-19 #13。SoT）。
 * - 設定候補 = 在籍中の全メンバー（バッチ7k で取締役・外注も選択可能に）
 * - 既定（設定未設定）= 従来どおり: マトリクスは社員・契約・アルバイトのみ / タイムラインは全員
 * - 設定あり = マトリクス・タイムラインとも「選択メンバー + 自分」で統一
 *   （バッチ7h の「候補外（役員・業務委託）は設定の影響を受けず常に表示」の特例は、
 *   全メンバーが選択肢に出るようになったため廃止 = 選択状態がそのまま表示状態）
 * - 日報参照権限（F-16-6）は本判定と独立に、呼び出し側で常時適用する
 */
import type { EmploymentType } from '~/types/domain'

/** configs 'teamVisibleMemberIds'（JSON 配列）の解釈。未設定・空配列・不正 JSON = null = 既定表示 */
export function parseTeamVisibleIds(raw: string): Set<string> | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return null
    const ids = arr.filter((x): x is string => typeof x === 'string')
    return ids.length > 0 ? new Set(ids) : null
  } catch {
    return null
  }
}

/** 既定（設定未設定）で提出状況マトリクスに表示する雇用区分か（従来の候補 = 社員・契約・アルバイト） */
export function isDefaultTeamVisible(employmentType: EmploymentType): boolean {
  return employmentType !== 'outsource' && employmentType !== 'director'
}

/** 提出状況マトリクスの表示判定（在籍中のメンバーに対して呼ぶ。自分は設定に関わらず表示） */
export function matrixVisible(
  visibleIds: Set<string> | null,
  member: { id: string; employmentType: EmploymentType },
  selfId: string,
): boolean {
  if (visibleIds === null) return isDefaultTeamVisible(member.employmentType)
  return visibleIds.has(member.id) || member.id === selfId
}

/** タイムライン上の人間日報の表示判定。未設定 = 全員（従来どおり）/ 設定あり = 選択メンバー + 自分 */
export function timelineVisibleWith(
  visibleIds: Set<string> | null,
  memberId: string,
  selfId: string,
): boolean {
  if (visibleIds === null) return true
  return visibleIds.has(memberId) || memberId === selfId
}
