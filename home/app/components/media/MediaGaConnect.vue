<script setup lang="ts">
/**
 * Google Analytics 連携ゲート — メディアチャンネル単位。
 * 未連携: 連携の案内 + 「Google Analytics を連携」/ 連携済み: 状態表示 + 連携解除。
 * 設定画面（/media/settings）と分析画面のゲートで共用する。
 *
 * デュアルモード（CalendarConnectGate の流儀）:
 * - モック: 擬似同意モーダル（プロパティ選択込み）。実際の Google 認証は行わない
 * - API: Google OAuth 2.0（analytics.readonly）の同意画面へフルリダイレクト →
 *   復帰クエリ（/media/settings?ga=connected|error&reason=&channel=）を処理 →
 *   GA4 プロパティ選択モーダル（Admin API の一覧 → PUT /v1/media/property）で連携が完成する。
 *   連携・解除は管理者のみ（API 側 requireAdmin と一致）
 * 画面操作だけで完結し、鍵の手動設定は不要（原則1）。
 */
import { ChartNoAxesCombined, Link2Off, ShieldCheck } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** 対象チャンネル。未指定なら現在のチャンネル */
  channelId?: string
  /** gate = 未連携時に大きな案内 / bar = 連携済みの状態バー（両方描画・状態で出し分け） */
  variant?: 'gate' | 'bar'
}>(), { channelId: '', variant: 'gate' })

const { effectiveChannelId, channelById } = useCurrentChannel()
const {
  settingFor, connectGa, disconnectGa, gaStatusFor, refreshGa, startGaConnect, listGaProperties, selectGaProperty,
} = useMediaChannels()
const { isAdmin } = useCurrentUser()
const isApi = useApiMode()
const { show } = useToast()
const confirm = useConfirm()
const route = useRoute()
const router = useRouter()

const cid = computed(() => props.channelId || effectiveChannelId.value)
const setting = computed(() => settingFor(cid.value))
const status = computed(() => gaStatusFor(cid.value))
const chName = computed(() => channelById(cid.value)?.name ?? setting.value?.name ?? 'このチャンネル')

/** 連携失敗理由（callback の ?reason=）→ 利用者向けメッセージ（calendar の FAIL_REASONS と同じ語彙） */
const FAIL_REASONS: Record<string, string> = {
  'account-mismatch': '会社アカウント以外の Google アカウントで同意されたため連携できませんでした。'
    + 'AKEBONO Office に登録されたメールアドレスと同じ Google アカウントを選択してください',
  'denied': 'Google の同意画面でアクセスがキャンセルされました。連携するには「許可」を選択してください',
  'invalid-state': '連携リクエストの有効期限が切れました（10 分以内に同意してください）。もう一度お試しください',
  'not-configured': 'Google Analytics 連携が未設定です。管理者に OAuth クライアントの設定を依頼してください',
  'token-exchange': 'Google との認証処理に失敗しました。時間をおいて再試行してください',
  'exchange-error': 'Google との認証処理に失敗しました。時間をおいて再試行してください',
}

// ---------- API: GA4 プロパティ選択（OAuth 復帰後 / needsProperty の再開） ----------

const propertyOpen = ref(false)
const propertyLoading = ref(false)
const propertySaving = ref(false)
const propertyList = ref<{ id: string; name: string; account: string }[]>([])
const selectedProp = ref('')
/** 選択モーダルの対象チャンネル（OAuth 復帰クエリの channel は現在の表示対象と異なりうる） */
const propertyChannel = ref('')

async function openPropertySelect(channelId: string): Promise<void> {
  propertyChannel.value = channelId
  propertyOpen.value = true
  propertyLoading.value = true
  const r = await listGaProperties(channelId)
  propertyLoading.value = false
  if (!r.ok) {
    show(`${r.error?.code}: ${r.error?.message}`, 'crit')
    propertyOpen.value = false
    return
  }
  propertyList.value = r.properties ?? []
  selectedProp.value = propertyList.value[0]?.id ?? ''
}

async function savePropertySelect(): Promise<void> {
  const prop = propertyList.value.find(p => p.id === selectedProp.value)
  if (!prop) return
  propertySaving.value = true
  const r = await selectGaProperty(propertyChannel.value, prop.id, prop.name)
  propertySaving.value = false
  if (!r.ok) {
    show(`${r.error?.code}: ${r.error?.message}`, 'crit')
    return
  }
  propertyOpen.value = false
  show(`Google Analytics を連携しました（${prop.name}）`, 'ok')
}

// OAuth 同意画面からの復帰（?ga=connected / error&reason=&channel=）を反映してクエリを消す
onMounted(async () => {
  if (!isApi) return
  const q = route.query.ga
  if (typeof q !== 'string') return
  const channel = typeof route.query.channel === 'string' && route.query.channel ? route.query.channel : cid.value
  const reason = typeof route.query.reason === 'string' ? route.query.reason : ''
  // 先にクエリを消す（リロードで復帰処理が二重実行されない = 冪等）
  void router.replace({ query: { ...route.query, ga: undefined, reason: undefined, channel: undefined } })
  if (q === 'connected') {
    await refreshGa(channel)
    show('Google アカウントを連携しました。続けて GA4 プロパティを選択してください', 'ok')
    await openPropertySelect(channel)
  } else {
    show(FAIL_REASONS[reason] ?? 'Google Analytics の連携に失敗しました。時間をおいて再試行してください', 'warn')
  }
})

// ---------- 連携の開始・解除 ----------

// 擬似 GA4 プロパティ候補（モック専用。API は OAuth 後に Admin API で実一覧を取得する）
const consentOpen = ref(false)
const mockSelectedProp = ref('')
const MOCK_PROPERTIES = computed(() => [
  { id: `properties/${380000000 + (cid.value.length * 111)}`, name: `${chName.value} - GA4` },
  { id: `properties/${380000000 + (cid.value.length * 222)}`, name: `${chName.value}（サブドメイン） - GA4` },
])

/** 連携開始。API モードは Google の同意画面へフルリダイレクト（モーダルは出さない） */
async function openConsent(): Promise<void> {
  if (isApi) {
    const r = await startGaConnect(cid.value) // 成功時はページ遷移するためここへは戻らない
    if (!r.ok) show(`${r.error?.code}: ${r.error?.message}`, 'crit')
    return
  }
  mockSelectedProp.value = MOCK_PROPERTIES.value[0]?.id ?? ''
  consentOpen.value = true
}

function approve(): void {
  const prop = MOCK_PROPERTIES.value.find(p => p.id === mockSelectedProp.value) ?? MOCK_PROPERTIES.value[0]
  if (!prop) return
  const r = connectGa(cid.value, prop.id, prop.name)
  consentOpen.value = false
  if (r.ok) show(`Google Analytics を連携しました（${prop.name}）`, 'ok')
  else show(`${r.error?.code}: ${r.error?.message}`, 'crit')
}

async function disconnect(): Promise<void> {
  const ok = await confirm.ask(
    'GA 連携の解除',
    `「${chName.value}」の Google Analytics 連携を解除しますか？取得済みの記事・設定は残りますが、以後の分析は行えません。`,
    { confirmLabel: '解除する', danger: true },
  )
  if (!ok) return
  const r = await disconnectGa(cid.value)
  if (r.ok) show('GA 連携を解除しました', 'warn')
  else show(`${r.error?.code}: ${r.error?.message}`, 'crit')
}
</script>

<template>
  <div>
    <!-- API: 状態取得中は何も出さない（未設定バナーの誤表示防止） -->
    <div v-if="isApi && !status.loaded" aria-hidden="true" />

    <!-- API: 連携機能が未設定（OAuth クライアント未投入）: 案内のみ -->
    <div
      v-else-if="isApi && !status.enabled"
      class="flex items-center gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5 text-xs text-muted"
    >
      <Link2Off class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Google Analytics 連携は未設定です（管理者が OAuth クライアントを設定すると利用できます）
    </div>

    <!-- 連携済み: 状態バー -->
    <div
      v-else-if="setting?.gaConnected"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5"
    >
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-sub">
        <ChartNoAxesCombined class="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
        <span class="truncate">GA 連携済み（{{ setting.gaPropertyName || setting.gaPropertyId }}）</span>
      </p>
      <button v-if="!isApi || isAdmin" type="button" class="btn btn-ghost btn-sm" @click="disconnect">連携解除</button>
    </div>

    <!-- API: トークンあり・プロパティ未選択の中間状態（選択モーダルへ誘導 = リロードで詰まない） -->
    <div
      v-else-if="isApi && status.needsProperty"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-1.5"
    >
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-sub">
        <ChartNoAxesCombined class="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
        Google アカウントは連携済みです。GA4 プロパティを選択すると分析が始められます
      </p>
      <button v-if="isAdmin" type="button" class="btn btn-primary btn-sm" @click="openPropertySelect(cid)">
        プロパティを選択
      </button>
      <span v-else class="text-[11px] text-muted">管理者がプロパティを選択すると利用できます</span>
    </div>

    <!-- 未連携: 案内（gate） -->
    <UiSectionCard v-else-if="variant === 'gate'">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <Link2Off class="h-8 w-8 text-muted" aria-hidden="true" />
        <div>
          <p class="text-[14px] font-bold">「{{ chName }}」の Google Analytics が未連携です</p>
          <p class="mt-1 text-xs text-sub">
            連携すると、サイトのアクセス指標を取得して AI 分析・記事提案が使えます。
          </p>
        </div>
        <template v-if="!isApi || isAdmin">
          <button type="button" class="btn btn-primary btn-lg" @click="openConsent">
            <ChartNoAxesCombined class="h-4 w-4" aria-hidden="true" /> Google Analytics を連携
          </button>
          <p class="text-[10px] text-muted">
            {{ isApi
              ? 'Google の同意画面へ移動します（アクセス解析データの表示のみを許可します）'
              : '連携は画面上の同意フローだけで完結します（モック: 実際の Google 認証は行いません）' }}
          </p>
        </template>
        <p v-else class="text-[11px] text-muted">連携は管理者が「メディア設定」から行います</p>
      </div>
    </UiSectionCard>

    <!-- 未連携: 小さな案内（bar） -->
    <div
      v-else
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line bg-surface-soft px-3 py-1.5"
    >
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <Link2Off class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> GA 未連携
      </p>
      <button v-if="!isApi || isAdmin" type="button" class="btn btn-primary btn-sm" @click="openConsent">
        <ChartNoAxesCombined class="h-3.5 w-3.5" aria-hidden="true" /> GA を連携
      </button>
      <span v-else class="text-[11px] text-muted">連携は管理者が行います</span>
    </div>

    <!-- 擬似 OAuth 同意 + プロパティ選択（モック専用。API は Google の実同意画面 + 下の実プロパティ選択） -->
    <UiModal :open="consentOpen" title="Google Analytics へのアクセス許可（モック）" width="460px" @close="consentOpen = false">
      <div class="grid gap-3">
        <p class="text-[13px]">
          <span class="font-bold">AKEBONO Office</span> が「{{ chName }}」のアクセス解析データの参照を求めています:
        </p>
        <ul class="grid gap-2">
          <li class="flex items-start gap-2 rounded-lg bg-surface-soft p-2.5">
            <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
            <div>
              <p class="text-[13px] font-semibold">アクセス解析データの表示</p>
              <p class="text-[11px] text-muted">analytics.readonly — セッション・PV・コンバージョン等の集計に使用</p>
            </div>
          </li>
        </ul>
        <UiFormField label="連携する GA4 プロパティ">
          <UiSelect
            v-model="mockSelectedProp"
            :options="MOCK_PROPERTIES.map(p => ({ value: p.id, label: `${p.name}（${p.id}）` }))"
            aria-label="GA4 プロパティ"
          />
        </UiFormField>
        <p class="text-[11px] text-muted">
          許可すると、選択したプロパティの集計データを分析に使用します。連携はいつでも解除できます。
          （API モードでは Google OAuth 2.0 の実同意画面と GA4 プロパティ選択になります）
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="consentOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="!mockSelectedProp" @click="approve">許可して連携</button>
      </template>
    </UiModal>

    <!-- API: GA4 プロパティ選択（Admin API accountSummaries の実一覧） -->
    <UiModal :open="propertyOpen" title="連携する GA4 プロパティを選択" width="460px" @close="propertyOpen = false">
      <p v-if="propertyLoading" class="py-6 text-center text-[13px] text-muted" aria-live="polite" aria-busy="true">
        GA4 プロパティ一覧を取得中…
      </p>
      <div v-else class="grid gap-3">
        <p class="text-[12px] text-sub">
          連携した Google アカウントで参照できる GA4 プロパティです。このチャンネルの分析に使うプロパティを選択してください。
        </p>
        <UiFormField label="GA4 プロパティ">
          <UiSelect
            v-model="selectedProp"
            :options="propertyList.map(p => ({ value: p.id, label: `${p.name}（${p.account || p.id}）` }))"
            aria-label="GA4 プロパティ"
          />
        </UiFormField>
        <p v-if="propertyList.length === 0" class="py-2 text-center text-[12px] text-muted">
          参照できる GA4 プロパティがありません（Google Analytics 側でアクセス権を確認してください）
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="propertyOpen = false">あとで選択</button>
        <button
          type="button" class="btn btn-primary"
          :disabled="propertySaving || propertyLoading || !selectedProp"
          @click="savePropertySelect"
        >
          {{ propertySaving ? '保存中…' : 'このプロパティで連携' }}
        </button>
      </template>
    </UiModal>
  </div>
</template>
