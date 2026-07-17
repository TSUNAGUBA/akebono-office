/**
 * API モードの認証ゲート（モックモードでは何もしない = 従来どおり誰でも閲覧可）。
 * - dev 認証（NUXT_PUBLIC_DEV_MEMBER_ID）: /v1/me のロードのみ（ゲートしない。ローカル/E2E 用）
 * - Firebase 認証: 未サインイン → /login。サインイン済みで members 未登録 → /login?reason=unregistered
 */
import { firebaseAuthReady, useFbUser } from '~/utils/firebase-auth'

export default defineNuxtRouteMiddleware(async (to) => {
  if (!useApiMode()) return
  const config = apiPublicConfig()
  if (config.devMemberId) {
    await ensureMeLoaded()
    return
  }
  if (to.path === '/login') return
  await firebaseAuthReady()
  if (!useFbUser().value) return navigateTo('/login')
  const me = await ensureMeLoaded()
  if (!me) return navigateTo('/login?reason=unregistered')
})
