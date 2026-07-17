<script setup lang="ts">
/**
 * Google カレンダー連携ゲート（F-06-8・擬似 OAuth）
 * 未連携時: 連携の案内カード + 「Google アカウントを連携」→ 擬似 OAuth 同意モーダル → 許可で連携+初回同期。
 * 連携済み: 小さな状態表示 + 連携解除。
 * 本実装では Google OAuth 2.0（calendar.readonly / calendar.events スコープ）の
 * 同意画面リダイレクトに置き換わる。画面遷移だけで完結し、鍵の手動設定は不要。
 */
import { CalendarCheck, CalendarOff, ShieldCheck } from 'lucide-vue-next'

const { currentUser } = useCurrentUser()
const cal = useCalendar()
const isApi = useApiMode()
const { show } = useToast()
const confirm = useConfirm()
const route = useRoute()
const router = useRouter()

const consentOpen = ref(false)

const SCOPES = [
  { name: 'カレンダーの予定の表示', detail: 'calendar.readonly — 日ごとのタスク見える化と日報ドラフトに使用' },
  { name: '予定の作成・更新', detail: 'calendar.events — 本アプリで登録したタスクの反映に使用' },
]

// OAuth 同意画面からの復帰（?calendar=connected / error）を反映してクエリを消す
onMounted(async () => {
  const q = route.query.calendar
  if (typeof q !== 'string') return
  if (q === 'connected') {
    await cal.refreshStatus()
    const r = await cal.syncFromGoogle(currentUser.value.id, todayJst())
    if (r.ok) {
      show(`Google カレンダーを連携しました（本日の予定 ${r.synced ?? 0} 件を同期）`, 'ok')
    } else {
      show(`連携は完了しましたが初回同期に失敗しました: ${r.error.message}`, 'warn')
    }
  } else {
    show('Google カレンダーの連携に失敗しました。時間をおいて再試行してください', 'warn')
  }
  void router.replace({ query: { ...route.query, calendar: undefined, reason: undefined } })
})

/** 連携開始。API モードは Google の同意画面へフルリダイレクト（モーダルは出さない） */
async function startConnect(): Promise<void> {
  if (!isApi) {
    consentOpen.value = true
    return
  }
  const r = await cal.connect() // 成功時はページ遷移するためここへは戻らない
  if (!r.ok) show(r.error.message, 'warn')
}

async function approve(): Promise<void> {
  const r = await cal.connect()
  consentOpen.value = false
  if (r.ok) {
    show(`Google カレンダーを連携しました（本日の予定 ${r.synced ?? 0} 件を同期）`, 'ok')
  } else {
    show(r.error.message, 'warn')
  }
}

async function disconnect(): Promise<void> {
  const ok = await confirm.ask(
    '連携の解除',
    'Google カレンダー連携を解除しますか？同期済みの予定は残りますが、以後の同期・反映はできなくなります。',
    { confirmLabel: '解除する', danger: true },
  )
  if (!ok) return
  const r = await cal.disconnect()
  if (r.ok) show('Google カレンダー連携を解除しました', 'warn')
  else show(r.error.message, 'warn')
}
</script>

<template>
  <!-- 状態取得中は何も出さない（未設定バナーの誤表示防止） -->
  <div v-if="!cal.isStatusLoaded.value" aria-hidden="true" />

  <!-- 連携機能が未設定（API モードで OAuth 未投入）: 案内のみ -->
  <div
    v-else-if="!cal.isEnabled.value"
    class="flex items-center gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5 text-xs text-muted"
  >
    <CalendarOff class="h-3.5 w-3.5" aria-hidden="true" />
    Google カレンダー連携は未設定です（管理者が OAuth クライアントを設定すると利用できます）
  </div>

  <!-- 未連携: 連携プロンプト -->
  <UiSectionCard v-else-if="!cal.isConnected.value">
    <div class="flex flex-col items-center gap-3 py-4 text-center">
      <CalendarOff class="h-8 w-8 text-muted" aria-hidden="true" />
      <div>
        <p class="text-[14px] font-bold">Google カレンダーが未連携です</p>
        <p class="mt-1 text-xs text-sub">
          連携すると予定が同期され、日ごとのタスク見える化と AI ヒアリング・日報ドラフト生成が使えます。
        </p>
      </div>
      <button type="button" class="btn btn-primary btn-lg" @click="startConnect">
        <CalendarCheck class="h-4 w-4" aria-hidden="true" /> Google アカウントを連携
      </button>
      <p class="text-[10px] text-muted">
        {{ isApi
          ? 'Google の同意画面へ移動します（カレンダーの予定の表示・予定の作成のみを許可します）'
          : '連携は画面上の同意フローだけで完結します（モック: 実際の Google 認証は行いません）' }}
      </p>
    </div>
  </UiSectionCard>

  <!-- 連携済み: 状態表示 -->
  <div v-else class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5">
    <p class="flex items-center gap-1.5 text-xs text-sub">
      <CalendarCheck class="h-3.5 w-3.5 text-ok" aria-hidden="true" />
      Google カレンダー連携済み（{{ currentUser.email }}）
    </p>
    <button type="button" class="btn btn-ghost btn-sm" @click="disconnect">連携解除</button>
  </div>

  <!-- 擬似 OAuth 同意画面 -->
  <UiModal :open="consentOpen" title="Google アカウントへのアクセス許可（モック）" width="440px" @close="consentOpen = false">
    <div class="grid gap-3">
      <div class="flex items-center gap-2 rounded-lg border border-line p-2.5">
        <UiAvatar :name="currentUser.name" size="md" />
        <div class="min-w-0">
          <p class="text-[13px] font-bold">{{ currentUser.name }}</p>
          <p class="truncate text-xs text-muted">{{ currentUser.email }}</p>
        </div>
      </div>
      <p class="text-[13px]">
        <span class="font-bold">AKEBONO Office</span> が次の操作を求めています:
      </p>
      <ul class="grid gap-2">
        <li v-for="s in SCOPES" :key="s.name" class="flex items-start gap-2 rounded-lg bg-surface-soft p-2.5">
          <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <p class="text-[13px] font-semibold">{{ s.name }}</p>
            <p class="text-[11px] text-muted">{{ s.detail }}</p>
          </div>
        </li>
      </ul>
      <p class="text-[11px] text-muted">
        許可すると、本アプリはあなたのカレンダー予定を同期します。連携はいつでも解除できます。
        （本実装では Google OAuth 2.0 の同意画面がここに表示されます）
      </p>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="consentOpen = false">キャンセル</button>
      <button type="button" class="btn btn-primary" @click="approve">許可して連携</button>
    </template>
  </UiModal>
</template>
