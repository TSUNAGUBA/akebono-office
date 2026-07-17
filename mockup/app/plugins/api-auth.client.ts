/**
 * API モードの初期化プラグイン。
 * - ランタイム設定をモジュールキャッシュへプライム（setup 文脈外からの参照を可能にする）
 * - dev 認証: /v1/me を先行ロード
 * - Firebase 認証: 初期化して認証状態を購読（サインイン → /v1/me、サインアウト → クリア）
 * モックモード（apiBase 未設定）では何もしない。
 */
import {
  initFirebaseAuth, markFirebaseUnavailable,
} from '~/utils/firebase-auth'

export default defineNuxtPlugin(() => {
  const config = apiPublicConfig()
  if (!config.apiBase) {
    markFirebaseUnavailable()
    return
  }
  if (config.devMemberId) {
    markFirebaseUnavailable()
    void ensureMeLoaded()
    return
  }
  if (!config.firebaseConfig) {
    console.warn('API モードですが NUXT_PUBLIC_FIREBASE_CONFIG が未設定のためログインできません')
    markFirebaseUnavailable()
    return
  }
  try {
    const parsed = JSON.parse(config.firebaseConfig) as Record<string, unknown>
    void initFirebaseAuth(parsed, {
      onSignIn: () => { void ensureMeLoaded() },
      onSignOut: () => { clearMe() },
    })
  } catch {
    console.warn('NUXT_PUBLIC_FIREBASE_CONFIG が JSON として解析できません')
    markFirebaseUnavailable()
  }
})
