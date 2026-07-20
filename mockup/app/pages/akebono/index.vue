<script setup lang="ts">
/**
 * AKEBONO 業務アプリ ハブ（F-20-1）
 * 使用（導入）中のアプリのみをカードで表示。管理者はアプリの使用/不使用・業種プリセット適用・
 * 共通マスタ/取込/項目カスタマイズへの導線を持つ。要望ボックス（F-03-2）は残置。
 */
import { CircleCheck, CircleDashed, Send, Sparkles, Sunrise } from 'lucide-vue-next'
import { fmtDateTime } from '~/utils/format'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import type { MenuCard } from '~/types/ui'

const apps = useAkebonoApps()
const { isAdmin } = useCurrentUser()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { wishes, submitWish: submitWishApi, refresh } = useAkebono()
const members = tbl('members')

onMounted(() => { void refresh() })

// ---------- アプリランチャー ----------
const appCards = computed<MenuCard[]>(() =>
  apps.enabledApps.value.map(a => ({
    id: a.key, title: apps.labelOf(a), description: a.description, icon: a.icon, to: a.to,
  })))

// ---------- アプリ使用/不使用管理（管理者） ----------
const manageOpen = ref(false)

async function toggleApp(appKey: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    const ok = await confirm.ask('アプリの不使用化', 'このアプリをメニューから外します。登録済みデータは保全され、再度有効化すると元に戻ります。', { confirmLabel: '不使用にする' })
    if (!ok) return
  }
  apps.setEnabled(appKey, enabled)
  show(enabled ? 'アプリを有効化しました' : 'アプリを不使用にしました', enabled ? 'ok' : 'warn')
}

async function applyPreset(): Promise<void> {
  const willEnable = apps.presetDiff.value.filter(d => d.willEnable)
  if (willEnable.length === 0) {
    show('プリセットで新たに有効化するアプリはありません（既に反映済み）', 'info')
    return
  }
  const names = willEnable.map(d => apps.labelOf(d.app)).join('、')
  const ok = await confirm.ask('業種プリセットの適用', `次のアプリを有効化します（既存の設定は OFF にしません）:\n${names}`, { confirmLabel: '適用する' })
  if (!ok) return
  apps.applyPreset() // 成功トーストは composable 側で表示
}

function saveLabel(appKey: string, value: string): void {
  apps.setLabel(appKey, value)
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
    <UiPageHeader title="AKEBONO 業務" description="商品マスタ〜在庫・売上・請求までの業務アプリ群。業種に応じた構成でご利用いただけます">
      <template v-if="isAdmin" #actions>
        <button type="button" class="btn btn-sm" @click="manageOpen = true">アプリ・業態の設定</button>
      </template>
    </UiPageHeader>

    <div class="grid gap-4">
      <!-- アプリランチャー -->
      <UiCardMenu v-if="appCards.length > 0" :items="appCards" />
      <UiEmptyState v-else icon="PackageOpen" title="使用中のアプリがありません" hint="管理者が「アプリ・業態の設定」から使用するアプリを有効化してください" />

      <!-- 管理者ツール -->
      <UiSectionCard v-if="isAdmin" title="管理者ツール" description="共通マスタ・データ取込・項目カスタマイズ（常時有効）">
        <div class="grid gap-2 sm:grid-cols-3">
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

    <!-- アプリ・業態の設定（管理者） -->
    <UiModal :open="manageOpen" title="アプリ・業態の設定" width="lg" @close="manageOpen = false">
      <div class="grid gap-4">
        <section>
          <div class="flex items-center justify-between">
            <p class="text-[12px] font-bold">事業セグメント（業態）</p>
            <NuxtLink to="/akebono/masters" class="link text-[11px]" @click="manageOpen = false">セグメントを編集</NuxtLink>
          </div>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <UiStatusBadge v-for="s in apps.activeSegments.value" :key="s.id" :label="`${s.name}（${INDUSTRY_TYPE_LABELS[s.industryType]}）`" tone="info" />
          </div>
          <div class="mt-2">
            <button type="button" class="btn btn-sm" @click="applyPreset">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> 業種プリセットを適用（不足アプリを有効化）
            </button>
          </div>
        </section>
        <section>
          <p class="text-[12px] font-bold">使用するアプリ</p>
          <p class="mt-0.5 text-[11px] text-muted">使用するアプリのみメニューに表示されます。不使用にしてもデータは保全されます。</p>
          <ul class="mt-2 grid gap-1.5">
            <li v-for="a in apps.catalog" :key="a.key" class="grid gap-2 rounded-[8px] border border-line px-3 py-2 sm:grid-cols-[1fr_auto]">
              <div class="flex items-center gap-2">
                <CircleCheck v-if="apps.isAppEnabled(a.key)" class="h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
                <CircleDashed v-else class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div class="min-w-0">
                  <p class="text-[13px] font-medium">{{ a.title }}</p>
                  <p class="text-[10px] text-muted">{{ a.description }}</p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="text" class="input h-8 w-40 text-[12px]" :value="apps.labelOf(a) === a.title ? '' : apps.labelOf(a)"
                  :placeholder="a.title" :aria-label="`${a.title}の表示名`"
                  @change="saveLabel(a.key, ($event.target as HTMLInputElement).value)"
                >
                <label class="flex items-center gap-1.5 whitespace-nowrap py-1 text-[11px]">
                  <input type="checkbox" :checked="apps.isAppEnabled(a.key)" @change="toggleApp(a.key, ($event.target as HTMLInputElement).checked)">
                  使用
                </label>
              </div>
            </li>
          </ul>
          <p class="mt-1.5 text-[10px] text-muted">表示名を入力するとメニュー上のアプリ名を上書きできます（例: 発注管理 → 外注管理。情報サービス業向け）。空で既定名に戻ります。</p>
        </section>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="manageOpen = false">閉じる</button>
      </template>
    </UiModal>
  </div>
</template>
