/**
 * 権限制御（F-16・オペレーター指示 2026-07-17）のフロント側判定。
 * 判定ロジックは shared/domain/permissions.ts（API と共有）。ルールは移行済みマスタ
 * `permissionRules`（API モードはサーバーの permission_rules をハイドレーション）。
 * - can(resource): 機能の利用可否（メニュー表示・ページガード）
 * - canPath(path): ページパスからの判定（ガード対象外パスは常に true）
 * - canField(resource, field): 表示項目の可否（API モードはサーバーもレスポンスから剥がす）
 * 既定は allow（ルール未設定なら挙動不変）。既存のロールガードを緩めることはできない（制限レイヤ）。
 */
import {
  canUseFeature, canViewAllTimecards as canViewAllTimecardsShared, canViewField,
  canViewMemberReports as canViewMemberReportsShared,
  canViewMemberTaskPlans as canViewMemberTaskPlansShared,
  featureKeyOfPath, type PermissionSubject,
} from '../../../shared/domain/permissions'

export function usePermissions() {
  const { tbl } = useMockDb()
  const { currentUser } = useCurrentUser()
  const rules = tbl('permissionRules')

  const subject = computed<PermissionSubject>(() => ({
    memberId: currentUser.value.id,
    title: currentUser.value.title ?? '',
    role: currentUser.value.role,
  }))

  function can(resource: string): boolean {
    return canUseFeature(rules.value, subject.value, resource)
  }

  function canPath(path: string): boolean {
    const key = featureKeyOfPath(path)
    return key === null || can(key)
  }

  function canField(resource: string, field: string): boolean {
    return canViewField(rules.value, subject.value, resource, field)
  }

  /** 対象メンバーの日報を参照できるか（F-16-6・バッチ7h。自分は常に可・未設定 = 可） */
  function canViewMemberReports(targetMemberId: string): boolean {
    return canViewMemberReportsShared(rules.value, subject.value, targetMemberId)
  }

  /** 対象メンバーの AI業務アシスタントを readonly 参照できるか（F-16-7。自分は常に可・未設定 = 不可 = 許可制） */
  function canViewMemberTaskPlans(targetMemberId: string): boolean {
    return canViewMemberTaskPlansShared(rules.value, subject.value, targetMemberId)
  }

  /** 全員のタイムカードを参照できるか（既定 = 管理者/人事。権限表の明示ルールで変更可） */
  const canViewAllTimecards = computed(() =>
    canViewAllTimecardsShared(rules.value, subject.value))

  return { can, canPath, canField, canViewMemberReports, canViewMemberTaskPlans, canViewAllTimecards }
}
