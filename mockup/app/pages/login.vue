<script setup lang="ts">
/**
 * ログイン（API モード専用。F-01 認証）。
 * モックモード・dev 認証では表示されない（自動でダッシュボードへ）。
 */
import { CloudOff, LogIn, ShieldAlert, Sunrise } from 'lucide-vue-next'
import {
  firebaseAuthReady, signInWithEmail, signInWithGoogle, signOutFirebase, useFbUser,
} from '~/utils/firebase-auth'

definePageMeta({ layout: false })

const route = useRoute()
const fbUser = useFbUser()
const me = useApiMe()
const meError = useApiMeError()

const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

/** /v1/me 確認中（確定前に「未登録」カードを一瞬表示しないためのゲート） */
const checking = ref(false)

/**
 * サインイン済みなのに入れない状態の分類。
 * - unregistered: /v1/me が AKO-AUTH-002（本当にメンバー未登録）
 * - unreachable: それ以外の失敗（API 未達・CORS・トークン検証失敗・サーバーエラー等）
 * 未登録以外を「未登録」と誤表示しない（原因調査を誤誘導した実バグの修正）。
 */
const failState = computed<'none' | 'unregistered' | 'unreachable'>(() => {
  if (checking.value) return 'none'
  if (fbUser.value && !me.value) {
    if (meError.value) return meError.value.code === 'AKO-AUTH-002' ? 'unregistered' : 'unreachable'
    // meError 不明（直リンク等）はミドルウェアが付けた query を信用する
    return route.query.reason === 'unreachable' ? 'unreachable' : 'unregistered'
  }
  if (route.query.reason === 'unregistered') return 'unregistered'
  if (route.query.reason === 'unreachable') return 'unreachable'
  return 'none'
})
const unregistered = computed(() => failState.value === 'unregistered')
const unreachable = computed(() => failState.value === 'unreachable')

onMounted(async () => {
  const config = apiPublicConfig()
  if (!config.apiBase || config.devMemberId) {
    await navigateTo('/')
    return
  }
  await firebaseAuthReady()
  if (fbUser.value) await afterSignIn()
})

/** サインイン成立後の突合。失敗理由の表示は failState のカードが担う */
async function afterSignIn(): Promise<void> {
  checking.value = true
  const u = await ensureMeLoaded()
  checking.value = false
  if (u) await navigateTo('/')
}

/** API 未達時の再試行（メンバー登録直後の再確認にも使う） */
async function retryMe(): Promise<void> {
  busy.value = true
  clearMe()
  await afterSignIn()
  busy.value = false
}

async function submitEmail(): Promise<void> {
  error.value = ''
  if (!email.value.trim() || !password.value) {
    error.value = 'メールアドレスとパスワードを入力してください'
    return
  }
  busy.value = true
  const res = await signInWithEmail(email.value.trim(), password.value)
  busy.value = false
  if (!res.ok) {
    error.value = res.message
    return
  }
  await afterSignIn()
}

async function submitGoogle(): Promise<void> {
  error.value = ''
  busy.value = true
  const res = await signInWithGoogle()
  busy.value = false
  if (!res.ok) {
    error.value = res.message
    return
  }
  await afterSignIn()
}

async function logout(): Promise<void> {
  await signOutFirebase()
  clearMe()
  error.value = ''
}
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center bg-[var(--c-bg)] p-4">
    <div class="card w-full max-w-sm p-6">
      <div class="flex items-center gap-2">
        <Sunrise class="h-6 w-6 text-[var(--c-accent)]" aria-hidden="true" />
        <h1 class="text-[18px] font-bold">AKEBONO Office</h1>
      </div>
      <p class="mt-1 text-xs text-sub">社内アカウントでログインしてください</p>

      <div v-if="checking" class="mt-5 text-center text-xs text-muted" role="status">アカウントを確認しています…</div>

      <div v-else-if="unregistered" class="mt-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3">
        <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        <div class="text-xs leading-relaxed">
          <p class="font-semibold">メンバー未登録です</p>
          <p class="mt-0.5 text-sub">
            {{ fbUser?.email }} はメンバーマスタに登録されていません。管理者に登録を依頼してください。
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button type="button" class="btn btn-sm" :disabled="busy" @click="retryMe">登録後に再確認</button>
            <button type="button" class="btn btn-sm" @click="logout">別のアカウントでログイン</button>
          </div>
        </div>
      </div>

      <div v-else-if="unreachable" class="mt-4 flex items-start gap-2 rounded-lg border border-crit/40 bg-crit/10 p-3">
        <CloudOff class="mt-0.5 h-4 w-4 shrink-0 text-crit" aria-hidden="true" />
        <div class="text-xs leading-relaxed">
          <p class="font-semibold">API に接続できません（メンバー登録の問題ではありません）</p>
          <p v-if="meError" class="num mt-0.5 text-sub">{{ meError.code }}: {{ meError.message }}</p>
          <p class="mt-1 text-sub">
            時間をおいて再試行してください。解消しない場合は管理者に連絡してください
            （確認箇所: API の稼働 `/healthz`・`API_BASE_URL`・`CORS_ORIGINS` にこのサイトの URL・`FIREBASE_PROJECT_ID` の一致）。
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button type="button" class="btn btn-sm" :disabled="busy" @click="retryMe">再試行</button>
            <button type="button" class="btn btn-sm" @click="logout">別のアカウントでログイン</button>
          </div>
        </div>
      </div>

      <form v-else class="mt-5 grid gap-3" @submit.prevent="submitEmail">
        <label class="grid gap-1 text-xs font-semibold">
          メールアドレス
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            class="input"
            placeholder="you@example.com"
          >
        </label>
        <label class="grid gap-1 text-xs font-semibold">
          パスワード
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="input"
          >
        </label>
        <p v-if="error" class="text-xs text-crit" role="alert">{{ error }}</p>
        <button type="submit" class="btn btn-primary w-full" :disabled="busy">
          <LogIn class="h-4 w-4" aria-hidden="true" /> ログイン
        </button>
        <button type="button" class="btn w-full" :disabled="busy" @click="submitGoogle">
          Google でログイン
        </button>
      </form>

      <p class="mt-4 text-[11px] leading-relaxed text-muted">
        ログインには管理者によるメンバーマスタへの登録（email 一致）が必要です。
      </p>
    </div>
  </div>
</template>
