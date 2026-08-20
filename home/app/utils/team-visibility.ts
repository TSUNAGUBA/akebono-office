/**
 * チームタブの表示メンバー判定（バッチ7h → バッチ7k で候補拡大。オペレーター指示 2026-07-19 #13。SoT）。
 * - 設定候補 = 在籍中の全メンバー（バッチ7k で取締役・外注も選択可能に）
 * - 既定（設定未設定）= 従来どおり: マトリクスは社員・契約・アルバイトのみ / タイムラインは全員
 * - 設定あり = マトリクス・タイムラインとも「選択メンバー + 自分」で統一
 *   （バッチ7h の「候補外は常に表示」特例のうち在籍中の取締役・外注分は、選択肢に出るように
 *   なったため廃止 = 選択状態がそのまま表示状態。**候補に出ない在籍外（退職者等）は引き続き
 *   設定の影響外 = 常に表示**。「選択肢に出ない対象が部分設定で消える」導線を作らない = PR #61 R1 M-1）
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

/**
 * タイムライン上の人間日報の表示判定。未設定 = 全員（従来どおり）/ 設定あり = 選択メンバー + 自分。
 * selectable = 設定の選択肢に出るか（在籍中か）。選択肢に出ない対象（退職者等）は設定で
 * 取り除く手段がないため、設定の影響を受けず常に表示する（バッチ7h の原則を踏襲。F-16-6 は別途）
 */
export function timelineVisibleWith(
  visibleIds: Set<string> | null,
  memberId: string,
  selfId: string,
  selectable: boolean,
): boolean {
  if (visibleIds === null) return true
  if (!selectable) return true
  return visibleIds.has(memberId) || memberId === selfId
}
