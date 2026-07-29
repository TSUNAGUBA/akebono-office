<script setup lang="ts">
/**
 * 業態アプリ設定（F-20 拡張。2026-07-28）— /akebono/settings/segments（管理者ゲート必須）
 * 業態（事業セグメント）ごとに以下を設定する:
 * - トップに並ぶ業態アプリの表示名（appName）とアイコン（画像アップロード or 選択式アイコン）
 * - 商品登録の既定値（単位・課金区分・バリアント軸1/2ラベル）。通常フォームではこれを自動適用し、
 *   個別変更は商品側の「カスタマイズ」フォームでのみ許す（入力コストの最小化）
 *
 * 書込は useMasterCrudAsync('businessSegments') の部分パッチ（name/業種等は保持 = 非破壊。
 * Phase B で API 移行済み = API モードの SoT はサーバー（business_segments）・部分 PATCH は
 * hasOwn フィルタで未送信フィールドを保持する）。
 * 取消可能性（原則9.5）: 再編集で上書き可能。画像は「アイコンに戻す」で取消できる。
 */
import * as icons from 'lucide-vue-next'
import { ImageUp, RotateCcw } from 'lucide-vue-next'
import type { BillingType, BusinessSegment } from '~/types/akebono'
import {
  BILLING_TYPE_LABELS, INDUSTRY_TYPE_LABELS, SEGMENT_ICON_CHOICES,
  segmentAppName,
} from '~/utils/akebono'
import { IMAGE_MAX_CHARS, imageToDataUri } from '~/utils/thumb'

const { activeSegments } = useCurrentSegment()
const masters = useAkebonoMasters()
const segCrud = useMasterCrudAsync('businessSegments', 'seg')
const { commit } = useMockDb()
const isApi = useApiMode()
const toast = useToast()

const billingOptions = Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => ({ value, label }))

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Sunrise
}

/** 既定値のサマリ（一覧表示） */
function defaultsSummary(s: BusinessSegment): string {
  const unit = s.defaultUnitId ? masters.unitName(s.defaultUnitId) || '—' : '未設定'
  const billing = s.defaultBillingType ? BILLING_TYPE_LABELS[s.defaultBillingType] : '物販'
  const v1 = s.defaultVariantAxis1Label?.trim()
  const v2 = s.defaultVariantAxis2Label?.trim()
  const variant = v1 ? (v2 ? `${v1}×${v2}` : v1) : 'バリアントなし'
  return `単位: ${unit} ／ 課金: ${billing} ／ ${variant}`
}

// ---------- 編集ドロワー ----------
const drawerOpen = ref(false)
const editingId = ref<string | null>(null)
const editing = computed<BusinessSegment | null>(() =>
  activeSegments.value.find(s => s.id === editingId.value) ?? null)

interface EditForm {
  appName: string
  appIcon: string
  appIconImage: string | null
  defaultUnitId: string
  defaultBillingType: string
  defaultVariantAxis1Label: string
  defaultVariantAxis2Label: string
}
const form = ref<EditForm>({
  appName: '', appIcon: '', appIconImage: null,
  defaultUnitId: '', defaultBillingType: '', defaultVariantAxis1Label: '', defaultVariantAxis2Label: '',
})
const imageBusy = ref(false)

/** プレビュー用に編集中の値を業態レコードへ重ねる（アイコン表示コンポーネントへ渡す） */
const previewSegment = computed<BusinessSegment | null>(() => {
  const s = editing.value
  if (!s) return null
  return {
    ...s,
    appName: form.value.appName.trim() || null,
    appIcon: form.value.appIcon || null,
    appIconImage: form.value.appIconImage,
  }
})

function openEdit(s: BusinessSegment): void {
  editingId.value = s.id
  form.value = {
    appName: s.appName ?? '',
    appIcon: s.appIcon ?? '',
    appIconImage: s.appIconImage ?? null,
    defaultUnitId: s.defaultUnitId ?? '',
    defaultBillingType: s.defaultBillingType ?? '',
    defaultVariantAxis1Label: s.defaultVariantAxis1Label ?? '',
    defaultVariantAxis2Label: s.defaultVariantAxis2Label ?? '',
  }
  drawerOpen.value = true
}

/** アイコンを選ぶ（画像を使っていた場合はアイコン表示へ戻す） */
function pickIcon(key: string): void {
  form.value.appIcon = key
  form.value.appIconImage = null
}

async function onImageFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    toast.show('画像ファイルを選択してください', 'warn')
    return
  }
  imageBusy.value = true
  try {
    // アイコンは小さく表示するため 160px へ縮小（localStorage 容量に配慮）
    const uri = await imageToDataUri(file, 160)
    if (uri.length > IMAGE_MAX_CHARS) {
      toast.show('画像を縮小しても大きすぎます。別の画像をお試しください', 'warn')
      return
    }
    form.value.appIconImage = uri
  } catch (e) {
    toast.show((e as Error).message, 'crit')
  } finally {
    imageBusy.value = false
  }
}

/** 画像を外してアイコン表示に戻す（取消フロー・原則9.5） */
function clearImage(): void {
  form.value.appIconImage = null
}

const saving = ref(false)

async function save(): Promise<void> {
  if (!editingId.value || saving.value) return
  const patch: Partial<BusinessSegment> & { id: string } = {
    id: editingId.value,
    appName: form.value.appName.trim() || null,
    appIcon: form.value.appIcon || null,
    appIconImage: form.value.appIconImage,
    defaultUnitId: form.value.defaultUnitId || null,
    defaultBillingType: (form.value.defaultBillingType || null) as BillingType | null,
    defaultVariantAxis1Label: form.value.defaultVariantAxis1Label.trim() || null,
    defaultVariantAxis2Label: form.value.defaultVariantAxis2Label.trim() || null,
  }
  saving.value = true
  try {
    const res = await segCrud.save(patch)
    if (!res.ok) {
      toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
      return
    }
    // モックモード: 画像アイコンは data URI で嵩むため localStorage 容量超過で永続化に失敗しうる。
    // 商品画像と同様に警告する（API モードはサーバー保管のため対象外 = Phase B）
    if (!isApi && form.value.appIconImage && commit() === false) {
      toast.show('業態アプリ設定を保存しましたが、画像アイコンは保存容量の上限により再読込時に失われる可能性があります。小さい画像や選択式アイコンをお試しください', 'warn')
    } else {
      toast.show('業態アプリ設定を保存しました', 'ok')
    }
    drawerOpen.value = false
  } finally { saving.value = false }
}
</script>

<template>
  <MastersMasterShell
    title="業態アプリ設定"
    description="トップに並ぶ業態アプリの表示名・アイコンと、商品登録の既定値（単位・課金区分・バリアント軸）を業態ごとに設定します。既定値は通常の登録・編集フォームでは自動適用され、個別変更は商品側の「カスタマイズ」でのみ行えます。"
  >
    <UiSectionCard
      :title="`業態（${activeSegments.length}件）`"
      description="押下でトップに並ぶ順・アイコン・既定値を編集します。業態の追加・無効化は共通マスタ管理で行います。"
      flush
    >
      <UiEmptyState
        v-if="activeSegments.length === 0"
        icon="Layers"
        title="業態がありません"
        hint="共通マスタ管理から事業セグメント（業態）を登録してください"
      />
      <ul v-else class="divide-y divide-[var(--c-line)]">
        <li
          v-for="s in activeSegments"
          :key="s.id"
          class="flex items-center gap-3 px-3 py-2.5"
        >
          <AkebonoSegmentIcon :segment="s" :size="40" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="truncate text-[13px] font-bold">{{ segmentAppName(s) }}</span>
              <span v-if="s.appName && s.appName.trim()" class="text-[11px] text-muted">（{{ s.name }}）</span>
              <UiStatusBadge :label="INDUSTRY_TYPE_LABELS[s.industryType]" tone="info" />
            </div>
            <p class="mt-0.5 truncate text-[11px] text-muted">{{ defaultsSummary(s) }}</p>
          </div>
          <button type="button" class="btn btn-sm shrink-0" @click="openEdit(s)">編集</button>
        </li>
      </ul>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="editing ? `「${editing.name}」の業態アプリ設定` : '業態アプリ設定'" width="520px" @close="drawerOpen = false">
        <div v-if="editing" class="grid gap-4">
          <!-- アプリ表示・アイコン -->
          <section class="grid gap-3">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">トップ表示（アプリ）</h3>
            <div class="flex items-center gap-3 rounded-[10px] border border-line bg-surface-soft p-3">
              <AkebonoSegmentIcon v-if="previewSegment" :segment="previewSegment" :size="48" />
              <div class="min-w-0">
                <p class="truncate text-[13px] font-bold">{{ form.appName.trim() || editing.name }}</p>
                <p class="text-[11px] text-muted">トップに並ぶ業態アプリのプレビュー</p>
              </div>
            </div>

            <UiFormField label="アプリ表示名" hint="未入力なら業態名を表示します">
              <input
                v-model="form.appName"
                type="text"
                class="input"
                :placeholder="editing.name"
                aria-label="アプリ表示名"
              >
            </UiFormField>

            <UiFormField label="アイコン">
              <div class="grid gap-2">
                <!-- 画像アップロード -->
                <div class="flex flex-wrap items-center gap-2">
                  <label class="btn btn-sm cursor-pointer">
                    <ImageUp class="h-3.5 w-3.5" aria-hidden="true" />
                    画像をアップロード
                    <input type="file" accept="image/*" class="hidden" aria-label="アイコン画像をアップロード" @change="onImageFile">
                  </label>
                  <button
                    v-if="form.appIconImage"
                    type="button"
                    class="btn btn-sm"
                    @click="clearImage"
                  >
                    <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
                    アイコンに戻す
                  </button>
                  <span v-if="imageBusy" class="text-[11px] text-muted">画像を処理しています…</span>
                  <span v-else-if="form.appIconImage" class="text-[11px] text-brand">画像アイコンを使用中</span>
                </div>
                <!-- 選択式アイコン（画像未使用時） -->
                <div v-if="!form.appIconImage" class="flex flex-wrap gap-1.5">
                  <button
                    v-for="key in SEGMENT_ICON_CHOICES"
                    :key="key"
                    type="button"
                    class="flex h-9 w-9 items-center justify-center rounded-lg border"
                    :class="form.appIcon === key ? 'border-brand bg-brand-soft text-brand' : 'border-line text-sub hover:border-muted'"
                    :aria-label="`アイコン ${key}`"
                    :aria-pressed="form.appIcon === key"
                    @click="pickIcon(key)"
                  >
                    <component :is="iconOf(key)" class="h-4.5 w-4.5" aria-hidden="true" />
                  </button>
                </div>
                <p class="text-[11px] text-muted">画像をアップロードするか、アイコンを選びます。未設定なら業種タイプの既定アイコンを使います。</p>
              </div>
            </UiFormField>
          </section>

          <!-- 商品登録の既定値 -->
          <section class="grid gap-3">
            <h3 class="text-[11px] font-bold uppercase tracking-wide text-muted">商品登録の既定値</h3>
            <p class="text-[11px] text-muted">この業態で商品を登録するときの初期値です。通常フォームでは編集せずこの既定が入り、変更したい場合のみ商品側の「カスタマイズ」で個別に上書きします。</p>
            <UiFormField label="既定の単位">
              <UiSelect v-model="form.defaultUnitId" :options="masters.unitOptions.value" empty-label="（未設定）" aria-label="既定の単位" />
            </UiFormField>
            <UiFormField label="既定の課金区分">
              <UiSelect v-model="form.defaultBillingType" :options="billingOptions" empty-label="（物販）" aria-label="既定の課金区分" />
            </UiFormField>
            <UiFormField label="既定のバリアント軸1ラベル" hint="入力すると SKU 展開商品が既定になります（例: カラー）">
              <input v-model="form.defaultVariantAxis1Label" type="text" class="input" placeholder="例）カラー" aria-label="既定のバリアント軸1ラベル">
            </UiFormField>
            <UiFormField label="既定のバリアント軸2ラベル">
              <input v-model="form.defaultVariantAxis2Label" type="text" class="input" placeholder="例）サイズ（任意）" aria-label="既定のバリアント軸2ラベル">
            </UiFormField>
          </section>
        </div>

        <template #footer>
          <button type="button" class="btn" @click="drawerOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="imageBusy || saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
