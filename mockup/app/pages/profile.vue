<script setup lang="ts">
/**
 * プロフィール・個人設定（バッチ5e・オペレーター指示 2026-07-17）
 * - アイコン画像の登録・削除（クライアントで 256px へ縮小 → data URI。SoT は members.avatar）
 * - パスワード変更（API モード + メール/パスワード認証のみ。Firebase が再認証の上で更新）
 * - アカウント情報の確認（氏名・メール・ロールは管理者のメンバーマスタが SoT のため読み取り専用）
 */
import { KeyRound, Trash2, Upload, UserCircle2 } from 'lucide-vue-next'
import { changeFirebasePassword, useFbUser } from '~/utils/firebase-auth'
import { EMPLOYMENT_TYPE_LABELS } from '~/utils/labels'

const { currentUser } = useCurrentUser()
const { tbl, commit } = useMockDb()
const members = tbl('members')
const { show } = useToast()
const isApi = useApiMode()
const fbUser = useFbUser()
const me = useApiMe()

/** dev 認証（E2E・ローカル検証）では Firebase セッションがないためパスワード変更は対象外 */
const devMode = computed(() => !!apiPublicConfig().devMemberId)

// ---------- アイコン画像 ----------

const AVATAR_MAX_PX = 256
/** サーバー上限 300KB より十分小さい保存キャップ（256px JPEG なら通常 10-30KB） */
const AVATAR_MAX_CHARS = 200_000

const fileInput = ref<HTMLInputElement | null>(null)
const avatarBusy = ref(false)
/** 選択済み・未保存のプレビュー（null = 未選択で現在値を表示） */
const pendingAvatar = ref<string | null>(null)

const displayedAvatar = computed(() => pendingAvatar.value ?? currentUser.value.avatar ?? '')

function pickFile(): void {
  fileInput.value?.click()
}

/** 画像を正方形 256px へ縮小して data URI 化（中央クロップ） */
function resizeToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const side = Math.min(img.width, img.height)
      const size = Math.min(AVATAR_MAX_PX, side)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('canvas が利用できません'))
        return
      }
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像を読み込めませんでした'))
    }
    img.src = url
  })
}

async function onFileChange(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0]
  ;(ev.target as HTMLInputElement).value = '' // 同じファイルの再選択でも change を発火させる
  if (!file) return
  if (!file.type.startsWith('image/')) {
    show('画像ファイルを選択してください', 'warn')
    return
  }
  try {
    const uri = await resizeToDataUri(file)
    if (uri.length > AVATAR_MAX_CHARS) {
      show('画像を縮小しても大きすぎます。別の画像をお試しください', 'warn')
      return
    }
    pendingAvatar.value = uri
  } catch (e) {
    show((e as Error).message, 'warn')
  }
}

async function saveAvatar(next: string): Promise<void> {
  avatarBusy.value = true
  try {
    if (isApi) {
      // SoT（members.avatar）へ書込 → /v1/me キャッシュとメンバーキャッシュへ反映（原則6）
      const res = await apiResult(() =>
        apiFetch<{ avatar: string }>('/v1/me/profile', { method: 'PUT', body: { avatar: next } }))
      if (!res.ok) {
        show(`${res.error.code}: ${res.error.message}`, 'crit')
        return
      }
      if (me.value) me.value = { ...me.value, avatar: next }
      members.value = members.value.map(m => m.id === currentUser.value.id ? { ...m, avatar: next } : m)
    } else {
      members.value = members.value.map(m => m.id === currentUser.value.id ? { ...m, avatar: next } : m)
      commit()
    }
    pendingAvatar.value = null
    show(next ? 'プロフィール画像を保存しました' : 'プロフィール画像を削除しました')
  } finally {
    avatarBusy.value = false
  }
}

// ---------- パスワード変更 ----------

/** パスワード変更の可否と、できない場合の理由 */
const passwordState = computed<'available' | 'mock' | 'dev' | 'google'>(() => {
  if (!isApi) return 'mock'
  if (devMode.value) return 'dev'
  if (fbUser.value && !fbUser.value.hasPassword) return 'google'
  return 'available'
})

const pwCurrent = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwBusy = ref(false)

async function onChangePassword(): Promise<void> {
  if (!pwCurrent.value || !pwNew.value) {
    show('現在のパスワードと新しいパスワードを入力してください', 'warn')
    return
  }
  if (pwNew.value.length < 6) {
    show('新しいパスワードは 6 文字以上にしてください', 'warn')
    return
  }
  if (pwNew.value !== pwConfirm.value) {
    show('新しいパスワード（確認）が一致しません', 'warn')
    return
  }
  pwBusy.value = true
  const res = await changeFirebasePassword(pwCurrent.value, pwNew.value)
  pwBusy.value = false
  if (!res.ok) {
    show(res.message, 'crit')
    return
  }
  pwCurrent.value = ''
  pwNew.value = ''
  pwConfirm.value = ''
  show('パスワードを変更しました')
}

// ---------- アカウント情報 ----------

const accountRows = computed(() => [
  { label: '氏名', value: currentUser.value.name },
  { label: 'メールアドレス', value: currentUser.value.email || '—' },
  { label: '雇用区分', value: EMPLOYMENT_TYPE_LABELS[currentUser.value.employmentType] ?? '—' },
  { label: '役職', value: currentUser.value.title || '—' },
  {
    label: 'ロール',
    value: currentUser.value.role === 'admin' ? '管理者' : currentUser.value.role === 'hr' ? '人事' : '一般',
  },
])
</script>

<template>
  <div class="mx-auto grid max-w-3xl gap-3">
    <UiPageHeader title="プロフィール・個人設定" description="アイコン画像の登録とパスワードの変更ができます" />

    <!-- アイコン画像 -->
    <UiSectionCard title="プロフィール画像" description="アップロードした画像は 256px の正方形に縮小して保存します">
      <div class="flex flex-wrap items-center gap-4">
        <UiAvatar :name="currentUser.name" :src="displayedAvatar" size="lg" />
        <div class="grid gap-2">
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-sm" :disabled="avatarBusy" @click="pickFile">
              <Upload class="h-3.5 w-3.5" aria-hidden="true" />
              画像を選択
            </button>
            <button
              v-if="pendingAvatar"
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="avatarBusy"
              @click="saveAvatar(pendingAvatar)"
            >
              この画像を保存
            </button>
            <button
              v-if="!pendingAvatar && (currentUser.avatar ?? '')"
              type="button"
              class="btn btn-sm text-crit"
              :disabled="avatarBusy"
              @click="saveAvatar('')"
            >
              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
              画像を削除
            </button>
            <button
              v-if="pendingAvatar"
              type="button"
              class="btn btn-sm"
              :disabled="avatarBusy"
              @click="pendingAvatar = null"
            >
              取り消し
            </button>
          </div>
          <p class="text-[11px] text-muted">
            <UserCircle2 class="mr-0.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
            未設定のときは氏名のイニシャルを表示します
          </p>
        </div>
        <input ref="fileInput" type="file" accept="image/*" class="hidden" aria-label="プロフィール画像を選択" @change="onFileChange">
      </div>
    </UiSectionCard>

    <!-- パスワード変更 -->
    <UiSectionCard title="パスワード変更" description="ログインに使うパスワードを変更します">
      <form v-if="passwordState === 'available'" class="grid max-w-sm gap-3" @submit.prevent="onChangePassword">
        <UiFormField label="現在のパスワード" required>
          <input v-model="pwCurrent" type="password" autocomplete="current-password" class="input">
        </UiFormField>
        <UiFormField label="新しいパスワード" required hint="6 文字以上">
          <input v-model="pwNew" type="password" autocomplete="new-password" class="input">
        </UiFormField>
        <UiFormField label="新しいパスワード（確認）" required>
          <input v-model="pwConfirm" type="password" autocomplete="new-password" class="input">
        </UiFormField>
        <button type="submit" class="btn btn-primary justify-self-start" :disabled="pwBusy">
          <KeyRound class="h-3.5 w-3.5" aria-hidden="true" />
          パスワードを変更
        </button>
      </form>
      <p v-else-if="passwordState === 'google'" class="text-[13px] text-sub">
        Google アカウントでログインしているため、パスワードは Google 側で管理されます（このアプリからの変更はありません）。
      </p>
      <p v-else-if="passwordState === 'dev'" class="text-[13px] text-sub">
        開発用認証（dev モード）ではパスワードはありません。
      </p>
      <p v-else class="text-[13px] text-sub">
        モックモードは擬似ログイン（デモユーザー切替）のためパスワードはありません。本番（API モード）ではここから変更できます。
      </p>
    </UiSectionCard>

    <!-- アカウント情報（読み取り専用） -->
    <UiSectionCard title="アカウント情報" description="氏名・メール・ロールの変更は管理者（メンバーマスタ）が行います">
      <dl class="grid gap-2 text-[13px]">
        <div
          v-for="r in accountRows"
          :key="r.label"
          class="grid grid-cols-[130px_1fr] gap-2 border-b border-line pb-2 last:border-0"
        >
          <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
          <dd>{{ r.value }}</dd>
        </div>
      </dl>
    </UiSectionCard>
  </div>
</template>
