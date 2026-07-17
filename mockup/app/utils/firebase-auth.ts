/**
 * Firebase Authentication の薄いラッパ（API モード専用。SPA・モジュールスコープ状態）。
 * firebase/* は動的 import（モックモードのバンドルへ含めない）。
 * 初期化はプラグイン（plugins/api-auth.client.ts）から一度だけ行う。
 */
import type { Auth } from 'firebase/auth'
import { ref, type Ref } from 'vue'

export interface FbUser {
  uid: string
  email: string
  name: string
}

let authInstance: Auth | null = null
const fbUser = ref<FbUser | null>(null)

let readyResolve: (() => void) | null = null
const readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve
})

function markReady(): void {
  readyResolve?.()
  readyResolve = null
}

/** 最初の認証状態が確定するまで待つ（未初期化環境では markFirebaseUnavailable で即解決） */
export function firebaseAuthReady(): Promise<void> {
  return readyPromise
}

/** Firebase を使わない構成（モック・dev 認証・設定なし）で ready を解決する */
export function markFirebaseUnavailable(): void {
  markReady()
}

export function useFbUser(): Ref<FbUser | null> {
  return fbUser
}

export interface FirebaseAuthHooks {
  onSignIn: () => void
  onSignOut: () => void
}

/** Firebase 初期化 + 認証状態の購読（プラグインから一度だけ）。失敗しても ready は解決する（非ブロッキング） */
export async function initFirebaseAuth(config: Record<string, unknown>, hooks: FirebaseAuthHooks): Promise<void> {
  try {
    const { initializeApp, getApps } = await import('firebase/app')
    const { getAuth, onAuthStateChanged } = await import('firebase/auth')
    const app = getApps()[0] ?? initializeApp(config)
    authInstance = getAuth(app)
    onAuthStateChanged(authInstance, (user) => {
      // Firebase User は Proxy traverse 不可のため plain object へ変換して保持（規約）
      fbUser.value = user
        ? { uid: user.uid, email: user.email ?? '', name: user.displayName ?? user.email ?? '' }
        : null
      if (user) hooks.onSignIn()
      else hooks.onSignOut()
      markReady()
    })
  } catch (e) {
    console.warn('Firebase 初期化に失敗しました:', (e as Error).message)
    markReady()
  }
}

/** 現在ユーザーの ID トークン（未サインインは空文字。SDK がキャッシュ・自動更新する） */
export async function getFirebaseIdToken(): Promise<string> {
  const user = authInstance?.currentUser
  if (!user) return ''
  try {
    return await user.getIdToken()
  } catch {
    return ''
  }
}

export async function signInWithEmail(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!authInstance) return { ok: false, message: 'Firebase が初期化されていません（NUXT_PUBLIC_FIREBASE_CONFIG 未設定）' }
  try {
    const { signInWithEmailAndPassword } = await import('firebase/auth')
    await signInWithEmailAndPassword(authInstance, email, password)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: authErrorMessage(e) }
  }
}

export async function signInWithGoogle(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!authInstance) return { ok: false, message: 'Firebase が初期化されていません（NUXT_PUBLIC_FIREBASE_CONFIG 未設定）' }
  try {
    const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth')
    await signInWithPopup(authInstance, new GoogleAuthProvider())
    return { ok: true }
  } catch (e) {
    return { ok: false, message: authErrorMessage(e) }
  }
}

export async function signOutFirebase(): Promise<void> {
  if (!authInstance) return
  const { signOut } = await import('firebase/auth')
  await signOut(authInstance)
}

function authErrorMessage(e: unknown): string {
  const code = (e as { code?: string }).code ?? ''
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'メールアドレスまたはパスワードが正しくありません'
  }
  if (code.includes('popup-closed')) return 'ログインがキャンセルされました'
  if (code.includes('too-many-requests')) return '試行回数が多すぎます。しばらく待ってから再度お試しください'
  return `ログインに失敗しました（${code || (e as Error).message}）`
}
