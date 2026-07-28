<script setup lang="ts">
/**
 * AKEBONO 業務アプリ ハブ（F-20-1。マルチ業態対応）
 * 現在の業態（トップの業態アプリで入場・ヘッダの業態スイッチャでも切替可。/akebono?seg=<id> で切替）に応じて、
 * 使用（導入）中のアプリのみをカードで表示。
 * 管理者はアプリの使用/不使用・業種プリセット適用を「業態ごと」に設定でき、
 * 業態アプリ設定/共通マスタ/取込/項目カスタマイズへの導線を持つ。要望ボックス（F-03-2）は残置。
 */
import { Building2, ChevronRight, CircleCheck, CircleDashed, Layers, LayoutDashboard, Send, Sparkles, Sunrise } from 'lucide-vue-next'
import { fmtDateTime } from '~/utils/format'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import type { MenuCard } from '~/types/ui'

const apps = useAkebonoApps()
const { activeSegments, currentSegment, currentIndustryLabel, effectiveSegmentId, switchSegment } = useCurrentSegment()
const { isAdmin } = useCurrentUser()
const { can } = usePermissions()
const canSales = computed(() => can('sales'))
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { wishes, submitWish: submitWishApi, refresh } = useAkebono()
const members = tbl('members')
const route = useRoute()
const router = useRouter()

// トップの業態アプリカード（/akebono?seg=<id>）からの入場で現在業態を切り替える。
// クエリの seg が有効な業態ならそれを現在業態にする（毎回ヘッダで選ばせない導線）。
function applySegmentQuery(seg: unknown): void {
  const id = typeof seg === 'string' ? seg : ''
  if (id && id !== effectiveSegmentId.value && activeSegments.value.some(s => s.id === id)) {
    switchSegment(id)
  }
}
watch(() => route.query.seg, applySegmentQuery, { immediate: true })

onMounted(() => {
  void refresh()
  // 適用後は URL から seg を除去する。以降ヘッダで切り替えた業態がリロードで
  // 入場時の seg に引き戻されないようにする（seg は「入場のワンショット指定」= localStorage が正）。
  if (route.query.seg) void router.replace({ path: '/akebono', query: {} })
})

// ---------- アプリランチャー（現在業態のみ） ----------
const appCards = computed<MenuCard[]>(() =>
  apps.enabledApps.value.map(a => ({
    id: a.key, title: apps.labelOf(a), description: a.description, icon: a.icon, to: a.to,
  })))

// アプリ・業態の設定モーダルで列挙するアプリ（機能トグルで利用可能なもののみ）
const manageableApps = computed(() => apps.catalog.value)

// ---------- アプリ使用/不使用管理（管理者・業態ごと） ----------
const manageOpen = ref(false)
/** 設定対象の業態（既定 = 現在の業態） */
const settingsSegmentId = ref('')
const settingsSegment = computed(() => activeSegments.value.find(s => s.id === settingsSegmentId.value) ?? null)

function openManage(): void {
  settingsSegmentId.value = effectiveSegmentId.value
  manageOpen.value = true
}

async function toggleApp(appKey: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    const ok = await confirm.ask('アプリの不使用化', 'この業態のメニューからアプリを外します。登録済みデータは保全され、再度有効化すると元に戻ります。', { confirmLabel: '不使用にする' })
    if (!ok) return
  }
  apps.setEnabled(appKey, enabled, settingsSegmentId.value)
  show(enabled ? 'アプリを有効化しました' : 'アプリを不使用にしました', enabled ? 'ok' : 'warn')
}

async function applyPreset(): Promise<void> {
  const willEnable = apps.presetDiffOf(settingsSegmentId.value).filter(d => d.willEnable)
  if (willEnable.length === 0) {
    show('プリセットで新たに有効化するアプリはありません（既に反映済み）', 'info')
    return
  }
  const names = willEnable.map(d => apps.labelOf(d.app, settingsSegmentId.value)).join('、')
  const segName = settingsSegment.value?.name ?? '業態'
  const ok = await confirm.ask('業種プリセットの適用', `「${segName}」に次のアプリを有効化します（既存の設定は OFF にしません）:\n${names}`, { confirmLabel: '適用する' })
  if (!ok) return
  apps.applyPreset(settingsSegmentId.value) // 成功トーストは composable 側で表示
}

function saveLabel(appKey: string, value: string): void {
  apps.setLabel(appKey, value, settingsSegmentId.value)
}

// ---------- 要望ボックス ----------
const wishBody = ref('')
const wishSaving = ref(false)
function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}
async function submitWish(): Promise<void> {
  if (wishSaving.value) return
  wishSaving.value = true
  try {
    const res = await submitWishApi(wishBody.value)
    if (!res.ok) { show(res.error.message, 'crit'); return }
    wishBody.value = ''
    show('受け付けました。要件定義の参考にします')
  } finally { wishSaving.value = false }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader title="AKEBONO 業務" description="商品マスタ〜在庫・売上・請求までの業務アプリ群。業態ごとの構成でご利用いただけます">
      <template v-if="isAdmin" #actions>
        <button type="button" class="btn btn-sm" @click="openManage">アプリ・業態の設定</button>
      </template>
    </UiPageHeader>

    <!-- 現在の業態（配下アプリはこの業態が既定になる） -->
    <div v-if="currentSegment" class="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface-soft px-3 py-2">
      <Layers class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      <span class="text-[12px] text-sub">現在の業態</span>
      <span class="text-[13px] font-bold">{{ currentSegment.name }}</span>
      <UiStatusBadge :label="currentIndustryLabel" tone="info" />
      <span class="hidden text-[11px] text-muted sm:inline">・配下アプリはこの業態が既定になります（トップの業態アプリで入場・ヘッダでも切替可）</span>
    </div>

    <div class="grid gap-4">
      <!-- ダッシュボード導線（サマリー・AI レポート・AI インサイト。業態別 + 会社全体） -->
      <div v-if="currentSegment" class="grid gap-2 sm:grid-cols-2">
        <NuxtLink to="/akebono/dashboard" class="card group flex items-center gap-3 p-3 transition-colors hover:border-brand">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand">
            <LayoutDashboard class="h-5 w-5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-bold">この業態のダッシュボード</span>
            <span class="block text-[11px] text-muted">{{ currentSegment.name }} のサマリー・AI レポート・AI インサイト</span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink v-if="canSales" to="/akebono/company" class="card group flex items-center gap-3 p-3 transition-colors hover:border-brand">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-brand-soft text-brand">
            <Building2 class="h-5 w-5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-bold">会社全体ダッシュボード</span>
            <span class="block text-[11px] text-muted">セグメントを超えた全社サマリー・AI レポート・AI インサイト</span>
          </span>
          <ChevronRight class="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" aria-hidden="true" />
        </NuxtLink>
      </div>

      <!-- アプリランチャー -->
      <UiCardMenu v-if="appCards.length > 0" :items="appCards" />
      <UiEmptyState v-else icon="PackageOpen" title="この業態で使用中のアプリがありません" :hint="isAdmin ? '「アプリ・業態の設定」から使用するアプリを有効化してください' : '管理者が「アプリ・業態の設定」から使用するアプリを有効化してください'" />

      <!-- 管理者ツール -->
      <UiSectionCard v-if="isAdmin" title="管理者ツール" description="業態アプリ設定・共通マスタ・データ取込・項目カスタマイズ（常時有効）">
        <div class="grid gap-2 sm:grid-cols-2">
          <NuxtLink to="/akebono/settings/segments" class="card block p-3 hover:border-brand">
            <p class="text-[13px] font-bold">業態アプリ設定</p>
            <p class="mt-1 text-[11px] text-sub">トップに並ぶ業態アプリの名称・アイコンと、商品登録の既定値（単位・課金区分・バリアント軸）</p>
          </NuxtLink>
          <NuxtLink to="/akebono/masters" class="card block p-3 hover:border-brand">
            <p class="text-[13px] font-bold">共通マスタ管理</p>
            <p class="mt-1 text-[11px] text-sub">取引先ロール・事業セグメント・倉庫・単位・税区分・委託条件ほか</p>
          </NuxtLink>
          <NuxtLink to="/akebono/imports" class="card block p-3 hover:border-brand">
            <p class="text-[13px] font-bold">データ取込・連携</p>
            <p class="mt-1 text-[11px] text-sub">CSV/固定長/JSON/API の項目マッピング・変換・取込</p>
          </NuxtLink>
          <NuxtLink to="/akebono/settings/items" class="card block p-3 hover:border-brand">
            <p class="text-[13px] font-bold">項目カスタマイズ</p>
            <p class="mt-1 text-[11px] text-sub">フォーム/一覧の項目を業種の基本項目から差し引き・追加</p>
          </NuxtLink>
        </div>
      </UiSectionCard>

      <!-- 要望ボックス（F-03-2） -->
      <UiSectionCard title="AKEBONO への要望" description="「こうなってほしい」を送ってください。要件定義の参考にします">
        <div class="flex items-start gap-2">
          <Sunrise class="mt-1 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <div class="flex-1">
            <textarea v-model="wishBody" class="textarea" rows="2" placeholder="例）在庫のロット管理をしたい" aria-label="要望"></textarea>
            <div class="mt-2 flex justify-end">
              <button type="button" class="btn btn-primary btn-sm" :disabled="wishSaving || !wishBody.trim()" @click="submitWish">
                <Send class="h-3.5 w-3.5" aria-hidden="true" /> 送信
              </button>
            </div>
          </div>
        </div>
        <ul v-if="wishes.length > 0" class="mt-2 grid gap-1.5">
          <li v-for="w in wishes.slice(0, 5)" :key="w.id" class="rounded-[8px] border border-line px-3 py-2 text-[12px]">
            <span class="text-sub">{{ w.body }}</span>
            <span class="ml-2 text-[10px] text-muted">{{ memberName(w.memberId) }}・{{ fmtDateTime(w.at) }}</span>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- アプリ・業態の設定（管理者・業態ごと） -->
    <UiModal :open="manageOpen" title="アプリ・業態の設定" width="lg" @close="manageOpen = false">
      <div class="grid gap-4">
        <section>
          <div class="flex items-center justify-between">
            <p class="text-[12px] font-bold">設定する業態</p>
            <NuxtLink to="/akebono/masters" class="link text-[11px]" @click="manageOpen = false">業態を編集</NuxtLink>
          </div>
          <p class="mt-0.5 text-[11px] text-muted">業態ごとに使用するアプリ・表示名を設定します。</p>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <button
              v-for="s in activeSegments"
              :key="s.id"
              type="button"
              class="rounded-full border px-3 py-1 text-[12px] font-semibold"
              :class="s.id === settingsSegmentId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
              @click="settingsSegmentId = s.id"
            >
              {{ s.name }}<span class="ml-1 text-[10px] text-muted">{{ INDUSTRY_TYPE_LABELS[s.industryType] }}</span>
            </button>
          </div>
          <div class="mt-2">
            <button type="button" class="btn btn-sm" :disabled="!settingsSegment" @click="applyPreset">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> 業種プリセットを適用（不足アプリを有効化）
            </button>
          </div>
        </section>
        <section v-if="settingsSegment">
          <p class="text-[12px] font-bold">「{{ settingsSegment.name }}」で使用するアプリ</p>
          <p class="mt-0.5 text-[11px] text-muted">使用するアプリのみこの業態のメニューに表示されます。不使用にしてもデータは保全されます。</p>
          <ul class="mt-2 grid gap-1.5">
            <li v-for="a in manageableApps" :key="a.key" class="grid gap-2 rounded-[8px] border border-line px-3 py-2 sm:grid-cols-[1fr_auto]">
              <div class="flex items-center gap-2">
                <CircleCheck v-if="apps.isAppEnabled(a.key, settingsSegmentId)" class="h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
                <CircleDashed v-else class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div class="min-w-0">
                  <p class="text-[13px] font-medium">{{ a.title }}</p>
                  <p class="text-[10px] text-muted">{{ a.description }}</p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="text" class="input h-8 w-40 text-[12px]" :value="apps.labelOf(a, settingsSegmentId) === a.title ? '' : apps.labelOf(a, settingsSegmentId)"
                  :placeholder="a.title" :aria-label="`${a.title}の表示名`"
                  @change="saveLabel(a.key, ($event.target as HTMLInputElement).value)"
                >
                <label class="flex items-center gap-1.5 whitespace-nowrap py-1 text-[11px]">
                  <input type="checkbox" :checked="apps.isAppEnabled(a.key, settingsSegmentId)" @change="toggleApp(a.key, ($event.target as HTMLInputElement).checked)">
                  使用
                </label>
              </div>
            </li>
          </ul>
          <p class="mt-1.5 text-[10px] text-muted">表示名を入力するとこの業態のメニュー上のアプリ名を上書きできます（例: 発注管理 → 外注管理。情報サービス業向け）。空で既定名に戻ります。</p>
        </section>
        <UiEmptyState v-else icon="Layers" title="業態がありません" hint="共通マスタ管理から事業セグメント（業態）を登録してください" />
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="manageOpen = false">閉じる</button>
      </template>
    </UiModal>
  </div>
</template>
