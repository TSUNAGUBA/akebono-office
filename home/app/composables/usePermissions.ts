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
  canEditField as canEditFieldShared,
  canManageImprovements as canManageImprovementsShared,
  canUseFeature, canUseTab as canUseTabShared,
  canViewAllTimecards as canViewAllTimecardsShared,
  canViewField,
  canViewMemberReports as canViewMemberReportsShared,
  canViewMemberTaskPlans as canViewMemberTaskPlansShared,
  featureKeyOfPath, type PermissionSubject,
  resolveFeatureResource, resolveTabPermission,
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
    // resolveFeatureResource = API featureGuard と共通の解決（旧 'reports' からの動的継承は
    // 改善要望 2026-08-21 で撤去・migration 0078 で物理移行済み = 現在は素通し。I/F 互換のため経由を維持）
    return canUseFeature(rules.value, subject.value, resolveFeatureResource(rules.value, resource))
  }

  function canPath(path: string): boolean {
    const key = featureKeyOfPath(path)
    if (key === null) return true
    // /timecard のデータ面（打刻・月次集計）は attendance API（機能キー 'attendance'）に従属する。
    // attendance deny のままページだけ出すと API モードで全操作が 403 になるため、
    // メニュー・ページ表示も attendance との AND で判定し UI と API の挙動を一致させる
    if (key === 'timecard') return can('timecard') && can('attendance')
    // 改善要望は認証済み全員が閲覧できる（改修依頼 2026-08-19 第4弾: 全要望を閲覧可）。
    // ページ内の管理系操作（選別・ステータス変更・AI 集約・改修案件）は canManageImprovements で個別ガードする。
    if (key === 'improvements') return true
    return can(key)
  }

  /** 改善要望の閲覧・管理ができるか（既定 deny・管理者は常時可・権限設定で付与）。F-42 */
  const canManageImprovements = computed(() =>
    canManageImprovementsShared(rules.value, subject.value))

  function canField(resource: string, field: string): boolean {
    return canViewField(rules.value, subject.value, resource, field)
  }

  /** ページ内タブの利用可否（`tab:<key>` 擬似フィールド。既定 allow・改修依頼 2026-08-18）。
   *  resolveTabPermission = API と共通の解決（旧 `reports` の `tab:weekly-*` への写像フォールバックは
   *  改善要望 2026-08-21 で撤去・migration 0078 で物理移行済み = 現在は素通し。I/F 互換のため経由を維持） */
  function canTab(feature: string, tabKey: string): boolean {
    const eff = resolveTabPermission(rules.value, feature, tabKey)
    return canUseTabShared(rules.value, subject.value, eff.resource, eff.tabKey)
  }

  /** 項目の更新可否（参照＞更新の階層。`<項目>:write` 擬似フィールド・改修依頼 2026-08-18） */
  function canEditField(resource: string, field: string): boolean {
    return canEditFieldShared(rules.value, subject.value, resource, field)
  }

  /** 対象メンバーの日報を参照できるか（F-16-6・バッチ7h。自分は常に可・未設定 = 可） */
  function canViewMemberReports(targetMemberId: string): boolean {
    return canViewMemberReportsShared(rules.value, subject.value, targetMemberId)
  }

  /** 対象メンバーの AI業務アシスタントを readonly 参照できるか（F-16-7。自分は常に可・未設定 = 不可 = 許可制） */
  function canViewMemberTaskPlans(targetMemberId: string): boolean {
    return canViewMemberTaskPlansShared(rules.value, subject.value, targetMemberId)
  }

  // 旧 canViewMemberCustomerLog（顧客ログの参照対象・許可制）は改修依頼 2026-08-18 で撤去
  // （顧客活動の一覧は全メンバーの記録を全員が閲覧できる = shared/domain/permissions.ts 参照）

  /** 全員のタイムカードを参照できるか（既定 = 管理者/人事。権限表の明示ルールで変更可） */
  const canViewAllTimecards = computed(() =>
    canViewAllTimecardsShared(rules.value, subject.value))

  return {
    can, canPath, canField, canTab, canEditField, canViewMemberReports, canViewMemberTaskPlans,
    canViewAllTimecards, canManageImprovements,
  }
}
