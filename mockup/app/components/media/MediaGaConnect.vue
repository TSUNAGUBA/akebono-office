<script setup lang="ts">
/**
 * Google Analytics 連携ゲート（擬似 OAuth）— セグメント単位。
 * 未連携: 連携の案内 + 「Google Analytics を連携」→ 擬似同意モーダル（プロパティ選択）→ 許可で連携。
 * 連携済み: 状態表示 + 連携解除。設定画面（/media/settings）と分析画面のゲートで共用する。
 * 本実装では Google OAuth 2.0（analytics.readonly スコープ）+ GA4 プロパティ選択に置き換わる。
 * 画面操作だけで完結し、鍵の手動設定は不要（原則1）。
 */
import { ChartNoAxesCombined, Link2Off, ShieldCheck } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** 対象セグメント。未指定なら現在の業態 */
  segmentId?: string
  /** gate = 未連携時に大きな案内 / bar = 連携済みの状態バー（両方描画・状態で出し分け） */
  variant?: 'gate' | 'bar'
}>(), { segmentId: '', variant: 'gate' })

const { effectiveSegmentId, segmentById } = useCurrentSegment()
const { settingFor, connectGa, disconnectGa } = useMediaSettings()
const { show } = useToast()
const confirm = useConfirm()

const sid = computed(() => props.segmentId || effectiveSegmentId.value)
const setting = computed(() => settingFor(sid.value))
const segName = computed(() => segmentById(sid.value)?.name ?? 'この業態')

// 擬似 GA4 プロパティ候補（本実装では OAuth 後に Admin API で取得する一覧）
const consentOpen = ref(false)
const selectedProp = ref('')
const PROPERTIES = computed(() => [
  { id: `properties/${380000000 + (sid.value.length * 111)}`, name: `${segName.value} - GA4` },
  { id: `properties/${380000000 + (sid.value.length * 222)}`, name: `${segName.value}（サブドメイン） - GA4` },
])

function openConsent(): void {
  selectedProp.value = PROPERTIES.value[0]?.id ?? ''
  consentOpen.value = true
}

function approve(): void {
  const prop = PROPERTIES.value.find(p => p.id === selectedProp.value) ?? PROPERTIES.value[0]
  if (!prop) return
  const r = connectGa(sid.value, prop.id, prop.name)
  consentOpen.value = false
  if (r.ok) show(`Google Analytics を連携しました（${prop.name}）`, 'ok')
  else show(`${r.error?.code}: ${r.error?.message}`, 'crit')
}

async function disconnect(): Promise<void> {
  const ok = await confirm.ask(
    'GA 連携の解除',
    `「${segName.value}」の Google Analytics 連携を解除しますか？取得済みの記事・設定は残りますが、以後の分析は行えません。`,
    { confirmLabel: '解除する', danger: true },
  )
  if (!ok) return
  const r = disconnectGa(sid.value)
  if (r.ok) show('GA 連携を解除しました', 'warn')
  else show(`${r.error?.code}: ${r.error?.message}`, 'crit')
}
</script>

<template>
  <div>
    <!-- 連携済み: 状態バー -->
    <div
      v-if="setting?.gaConnected"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5"
    >
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-sub">
        <ChartNoAxesCombined class="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
        <span class="truncate">GA 連携済み（{{ setting.gaPropertyName || setting.gaPropertyId }}）</span>
      </p>
      <button type="button" class="btn btn-ghost btn-sm" @click="disconnect">連携解除</button>
    </div>

    <!-- 未連携: 案内（gate） -->
    <UiSectionCard v-else-if="variant === 'gate'">
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <Link2Off class="h-8 w-8 text-muted" aria-hidden="true" />
        <div>
          <p class="text-[14px] font-bold">「{{ segName }}」の Google Analytics が未連携です</p>
          <p class="mt-1 text-xs text-sub">
            連携すると、サイトのアクセス指標を取得して AI 分析・記事提案・PDCA が使えます。
          </p>
        </div>
        <button type="button" class="btn btn-primary btn-lg" @click="openConsent">
          <ChartNoAxesCombined class="h-4 w-4" aria-hidden="true" /> Google Analytics を連携
        </button>
        <p class="text-[10px] text-muted">
          連携は画面上の同意フローだけで完結します（モック: 実際の Google 認証は行いません）
        </p>
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
      <button type="button" class="btn btn-primary btn-sm" @click="openConsent">
        <ChartNoAxesCombined class="h-3.5 w-3.5" aria-hidden="true" /> GA を連携
      </button>
    </div>

    <!-- 擬似 OAuth 同意 + プロパティ選択 -->
    <UiModal :open="consentOpen" title="Google Analytics へのアクセス許可（モック）" width="460px" @close="consentOpen = false">
      <div class="grid gap-3">
        <p class="text-[13px]">
          <span class="font-bold">AKEBONO Office</span> が「{{ segName }}」のアクセス解析データの参照を求めています:
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
            v-model="selectedProp"
            :options="PROPERTIES.map(p => ({ value: p.id, label: `${p.name}（${p.id}）` }))"
            aria-label="GA4 プロパティ"
          />
        </UiFormField>
        <p class="text-[11px] text-muted">
          許可すると、選択したプロパティの集計データを分析に使用します。連携はいつでも解除できます。
          （本実装では Google OAuth 2.0 の同意画面と GA4 プロパティ選択がここに表示されます）
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="consentOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="!selectedProp" @click="approve">許可して連携</button>
      </template>
    </UiModal>
  </div>
</template>
