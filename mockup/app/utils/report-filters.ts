/**
 * 日報・週報の一覧/チームビュー共通の部署・メンバー絞り込み（純粋関数。SoT）。
 * 改修依頼 2026-08-20 第2バッチで週報パネル（components/reports/WeeklyAllPanel）を
 * reports.vue から分離するにあたり、両者で同一実装を共有するため切り出した（原則3。挙動不変）。
 */
import type { Member } from '~/types/domain'

/**
 * 部署・メンバーの絞り込み判定。memberId = null は AI 社員の日報
 * （メンバー・部署の属性を持たないため、絞り込み未指定のときのみ表示する）
 */
export function matchesMemberFilter(
  members: Pick<Member, 'id' | 'departmentId'>[],
  memberId: string | null | undefined,
  deptId: string,
  memId: string,
): boolean {
  if (!memberId) return !deptId && !memId
  if (memId && memberId !== memId) return false
  if (deptId) {
    const m = members.find(x => x.id === memberId)
    if (!m || m.departmentId !== deptId) return false
  }
  return true
}

/** メンバー絞り込みセレクトの選択肢（在籍中のみ・値 = id・ラベル = 氏名） */
export function memberFilterOptionsOf(
  members: Pick<Member, 'id' | 'name' | 'active'>[],
): { value: string; label: string }[] {
  return members.filter(m => m.active).map(m => ({ value: m.id, label: m.name }))
}
