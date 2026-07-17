<script setup lang="ts">
/**
 * ログイン（API モード専用。F-01 認証）。
 * モックモード・dev 認証では表示されない（自動でダッシュボードへ）。
 */
import { LogIn, ShieldAlert, Sunrise } from 'lucide-vue-next'
import {
  firebaseAuthReady, signInWithEmail, signInWithGoogle, signOutFirebase, useFbUser,
} from '~/utils/firebase-auth'

definePageMeta({ layout: false })

const route = useRoute()
const fbUser = useFbUser()
const me = useApiMe()

const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)
const unregistered = computed(() => route.query.reason === 'unregistered' || (fbUser.value && !me.value))

onMounted(async () => {
  const config = apiPublicConfig()
  if (!config.apiBase || config.devMemberId) {
    await navigateTo('/')
    return
  }
  await firebaseAuthReady()
  if (fbUser.value && await ensureMeLoaded()) await navigateTo('/')
})

async function afterSignIn(): Promise<void> {
  if (await ensureMeLoaded()) {
    await navigateTo('/')
  } else {
    error.value = 'このアカウントの email はメンバーとして登録されていません。管理者にメンバーマスタへの登録を依頼してください'
  }
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

      <div v-if="unregistered" class="mt-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3">
        <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
        <div class="text-xs leading-relaxed">
          <p class="font-semibold">メンバー未登録です</p>
          <p class="mt-0.5 text-sub">
            {{ fbUser?.email }} はメンバーマスタに登録されていません。管理者に登録を依頼してください。
          </p>
          <button type="button" class="btn btn-sm mt-2" @click="logout">別のアカウントでログイン</button>
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
