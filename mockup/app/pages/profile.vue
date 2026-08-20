<script setup lang="ts">
/**
 * プロフィール・個人設定（バッチ5e・オペレーター指示 2026-07-17）
 * - アイコン画像の登録・削除（クライアントで 256px へ縮小 → data URI。SoT は members.avatar）
 * - パスワード変更（API モード + メール/パスワード認証のみ。Firebase が再認証の上で更新）
 * - アカウント情報の確認（氏名・メール・ロールは管理者のメンバーマスタが SoT のため読み取り専用）
 * - 外部チャット連携（Slack / Google Chat。改修依頼 2026-08-20 → AKEBONO HOME 名義化 2026-08-20:
 *   通知アプリ「AKEBONO HOME」からの DM。連携 = メール突合による宛先解決の 1 クリックで、OAuth 同意は不要）と
 *   通知の配信先マトリクス（行=通知種別 × 列=チャネルの ON/OFF。useNotificationChannels）
 */
import type { Component } from 'vue'
import { KeyRound, Link2, MessageSquare, MessagesSquare, Send, Trash2, Upload, UserCircle2 } from 'lucide-vue-next'
import { changeFirebasePassword, useFbUser } from '~/utils/firebase-auth'
import { EMPLOYMENT_TYPE_LABELS, NOTIFICATION_KIND_LABELS } from '~/utils/labels'
import type { ChatService, NotificationChannelType } from '~/utils/notification-channels'
import { CHANNEL_META, NOTIFICATION_CHANNEL_TYPES, NOTIFICATION_MATRIX_KINDS } from '~/utils/notification-channels'

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

// ---------- 外部チャット連携・通知の配信先（改修依頼 2026-08-20） ----------

const channels = useNotificationChannels()
const confirm = useConfirm()

/** サービスの表示アイコン（ブランドロゴは使わない = lucide + テキストラベルで表現） */
const SERVICE_ICONS: Record<ChatService, Component> = { slack: MessageSquare, google_chat: MessagesSquare }

const SERVICE_DESCRIPTIONS: Record<ChatService, string> = {
  slack: '連携すると、通知アプリ「AKEBONO HOME」からあなた宛の通知が Slack の DM で届きます。',
  google_chat: '連携すると、通知アプリ「AKEBONO HOME」からあなた宛の通知が Google Chat の DM で届きます。',
}

function chatLabel(service: ChatService): string {
  return CHANNEL_META[service].label
}

const chatBusy = ref<ChatService | null>(null)

/**
 * 連携開始（1 クリック連携: 登録メールアドレスで宛先を解決して完了。OAuth 同意・画面遷移なし =
 * AKEBONO HOME 名義化 2026-08-20）
 */
async function startChatConnect(service: ChatService): Promise<void> {
  if (chatBusy.value) return // 連携・テスト送信の同時多重を防ぐ（busy は 1 サービスずつ）
  chatBusy.value = service
  const r = await channels.connect(service)
  chatBusy.value = null
  if (r.ok) show(`${chatLabel(service)} を連携しました。「通知の配信先」で ON にすると AKEBONO HOME からの DM が届きます`)
  else show(`${r.error.code}: ${r.error.message}`, 'warn')
}

async function disconnectChat(service: ChatService): Promise<void> {
  const ok = await confirm.ask(
    '連携の解除',
    `${chatLabel(service)} 連携を解除しますか？この宛先への通知配信は停止します（再連携でいつでも再開できます）。`,
    { confirmLabel: '解除する', danger: true },
  )
  if (!ok) return
  const r = await channels.disconnect(service)
  if (r.ok) show(`${chatLabel(service)} 連携を解除しました`, 'warn')
  else show(`${r.error.code}: ${r.error.message}`, 'crit')
}

async function sendChatTest(service: ChatService): Promise<void> {
  if (chatBusy.value) return
  chatBusy.value = service
  const r = await channels.sendTest(service)
  chatBusy.value = null
  if (r.ok) show(`${chatLabel(service)} へテスト通知を送信しました${isApi ? '' : '（デモ: 実際の送信は行いません）'}`)
  else show(`${r.error.code}: ${r.error.message}`, 'crit')
}

/** マトリクスのセルが非活性か（in_app は常に操作可・外部チャネルは連携済みのときのみ） */
function matrixCellDisabled(channel: NotificationChannelType): boolean {
  if (channel === 'in_app') return false
  const l = channels.links.value.find(x => x.service === channel)
  return !(l?.connected ?? false)
}

/** 未連携サービス（マトリクス下の連携導線に表示。状態取得前は出さない） */
const unlinkedChatServices = computed(() =>
  channels.isLoaded.value ? channels.links.value.filter(l => !l.connected) : [])

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
    <UiPageHeader title="プロフィール・個人設定" description="アイコン画像・パスワード・外部チャット連携と通知の配信先を設定できます" />

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

    <!-- 外部チャット連携（改修依頼 2026-08-20 → AKEBONO HOME 名義化 2026-08-20） -->
    <UiSectionCard
      title="外部チャット連携"
      description="通知を Slack / Google Chat の DM でも受け取れます（送信元は通知アプリ「AKEBONO HOME」。いつでも解除できます）"
    >
      <div class="grid gap-2 sm:grid-cols-2">
        <div v-for="l in channels.links.value" :key="l.service" class="rounded-lg border border-line p-3">
          <div class="flex flex-wrap items-center gap-2">
            <component :is="SERVICE_ICONS[l.service]" class="h-4 w-4 shrink-0 text-sub" aria-hidden="true" />
            <p class="text-[13px] font-bold">{{ l.label }}</p>
            <UiStatusBadge v-if="l.connected" label="連携済み" tone="ok" />
            <UiStatusBadge v-else label="未連携" tone="neutral" />
          </div>
          <!-- 状態取得中は誤った「未設定」表示を出さない -->
          <p v-if="!channels.isLoaded.value" class="mt-2 text-xs text-muted" aria-live="polite">状態を確認中…</p>
          <p v-else-if="!l.enabled" class="mt-2 text-xs text-muted">
            連携が未設定です（管理者が通知アプリ「AKEBONO HOME」を設定すると利用できます）
          </p>
          <template v-else-if="!l.connected">
            <p class="mt-2 text-xs text-sub">{{ SERVICE_DESCRIPTIONS[l.service] }}</p>
            <button
              type="button"
              class="btn btn-primary btn-sm mt-2"
              :disabled="chatBusy === l.service"
              @click="startChatConnect(l.service)"
            >
              <Link2 class="h-3.5 w-3.5" aria-hidden="true" />
              {{ chatBusy === l.service ? '連携中…' : '連携する' }}
            </button>
            <p class="mt-1.5 text-[10px] text-muted">
              {{ isApi ? `登録メールアドレス（${currentUser.email || '未登録'}）で宛先を確認し、その場で連携が完了します`
                : '連携はその場で完了します（モック: 実際の送信は行いません）' }}
            </p>
          </template>
          <template v-else>
            <p class="mt-2 truncate text-xs text-sub" :title="l.displayName">{{ l.displayName || l.label }}</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                class="btn btn-sm"
                :disabled="chatBusy === l.service"
                @click="sendChatTest(l.service)"
              >
                <Send class="h-3.5 w-3.5" aria-hidden="true" />
                {{ chatBusy === l.service ? '送信中…' : 'テスト送信' }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="disconnectChat(l.service)">解除</button>
            </div>
          </template>
        </div>
      </div>
    </UiSectionCard>

    <!-- 通知の配信先マトリクス（改修依頼 2026-08-20） -->
    <UiSectionCard
      title="通知の配信先"
      description="通知の種類ごとに届けるチャネルを選べます（アプリ内は既定で ON）"
    >
      <!-- モバイル幅は横スクロール（行ヘッダーは sticky = 原則8） -->
      <div class="overflow-x-auto">
        <table class="w-full min-w-[420px] border-collapse text-[13px]">
          <thead>
            <tr class="border-b border-line">
              <th scope="col" class="sticky left-0 z-10 bg-surface px-2 py-2 text-left text-[11px] font-semibold text-muted">
                通知種別
              </th>
              <th
                v-for="ch in NOTIFICATION_CHANNEL_TYPES"
                :key="ch"
                scope="col"
                class="px-2 py-2 text-center text-[11px] font-semibold text-muted"
              >
                <span class="inline-flex items-center gap-1">
                  {{ CHANNEL_META[ch].label }}
                  <UiStatusBadge v-if="matrixCellDisabled(ch)" label="未連携" tone="neutral" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="kind in NOTIFICATION_MATRIX_KINDS" :key="kind" class="border-b border-line last:border-0">
              <th scope="row" class="sticky left-0 z-10 bg-surface px-2 py-1 text-left font-medium whitespace-nowrap">
                {{ NOTIFICATION_KIND_LABELS[kind] }}
              </th>
              <td v-for="ch in NOTIFICATION_CHANNEL_TYPES" :key="ch" class="px-2 py-1 text-center">
                <button
                  type="button"
                  role="switch"
                  :aria-checked="channels.cellOn(kind, ch)"
                  :aria-label="`${NOTIFICATION_KIND_LABELS[kind]}を${CHANNEL_META[ch].label}へ通知`"
                  :disabled="matrixCellDisabled(ch)"
                  class="inline-flex h-11 min-w-11 items-center justify-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40"
                  @click="channels.setCell(kind, ch, !channels.cellOn(kind, ch))"
                >
                  <span
                    class="relative inline-block h-5 w-9 rounded-full border transition-colors"
                    :class="channels.cellOn(kind, ch) ? 'border-brand bg-brand' : 'border-line bg-neutral-soft'"
                    aria-hidden="true"
                  >
                    <span
                      class="absolute top-[3px] h-3.5 w-3.5 rounded-full bg-surface shadow-sm transition-all"
                      :class="channels.cellOn(kind, ch) ? 'left-[19px]' : 'left-[3px]'"
                    />
                  </span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- 未連携サービスの連携導線 -->
      <div
        v-for="l in unlinkedChatServices"
        :key="l.service"
        class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-soft px-3 py-1.5 text-xs text-sub"
      >
        <component :is="SERVICE_ICONS[l.service]" class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span>{{ l.label }} は未連携です。連携すると選択できます</span>
        <button
          v-if="l.enabled"
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="chatBusy === l.service"
          @click="startChatConnect(l.service)"
        >
          <Link2 class="h-3.5 w-3.5" aria-hidden="true" />
          {{ chatBusy === l.service ? '連携中…' : '連携する' }}
        </button>
        <span v-else class="text-muted">（管理者による AKEBONO HOME の設定後に利用できます）</span>
      </div>
      <p class="mt-2 text-[11px] text-muted">
        アプリ内通知の一覧は
        <NuxtLink to="/inbox" class="link">通知（/inbox）</NuxtLink>
        で確認できます。外部チャネルには通知の内容が DM で届きます。
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
