/**
 * 権限ルールによるページガード（F-16）。auth.global の後に実行される（ファイル名順）。
 * 機能 deny のページへ直接遷移した場合はダッシュボードへ戻す（メニューからは既に非表示）。
 * ルール取得完了後・ユーザー切替後の「滞在中に deny になった」ケースは layouts/default.vue の watchEffect が補完する。
 * 判定は usePermissions（ルール未設定なら常に許可 = 従来挙動）。
 */
export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/' || to.path === '/login') return
  const { canPath } = usePermissions()
  if (!canPath(to.path)) {
    return navigateTo('/')
  }
})
