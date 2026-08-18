<script setup lang="ts">
/**
 * ダッシュボードのレイアウト設定モーダル（オペレーター指示 2026-08-03 / 分離改修 2026-08-18）。
 * レイアウト設定（通知の配置）とセクション設定（セクション・メニューの配置）を明確に分離する:
 * - 「レイアウト」タブ: 通知欄をどこに置くか（上 / 右 / 下 / 非表示）に特化。適用スコープ = 自分 / 全社（管理者のみ）
 * - 「セクション設定」タブ: テンプレート選択 + 自由設定（+ お気に入り保存/呼び出し）= OfficeDashboardSectionEditor
 * - 「アプリヘッダー」タブ: ヘッダーのクイックアクセス設定（「通知」ベルの表示もここで制御。2026-08-18 追加）
 * - 「通知タブ」タブ: 通知欄・/inbox に出すカテゴリタブの設定
 * レスポンシブ（原則8）: 配置の選択肢は 1 → 2 列で流し込む
 */
import { Check, RotateCcw, Smartphone } from 'lucide-vue-next'
import type { ApplyScope } from '~/composables/useDashboardLayout'
import {
  NOTIFICATION_PLACEMENT_OPTIONS, type NotificationPlacement, withNotificationPlacement,
} from '~/utils/dashboard-layout'

const {
  templates, activeTemplateId, effectiveLayout, placementSource, placementFromOwnLegacyLayout,
  userPlacement, tenantPlacement, isAdmin,
  baseLayoutForScope, saveNotificationPlacement, resetNotificationPlacement,
} = useDashboardLayout()
const { show } = useToast()
const confirmAsk = useConfirm()

/** 通知配置の由来表示（専用キーの層 / レイアウト由来 / アプリ既定） */
const PLACEMENT_SOURCE_LABELS: Record<string, string> = {
  user: '自分の設定', tenant: '全社設定', layout: 'レイアウト構成の既定', default: 'デフォルト表示',
}

/**
 * 編集モード: レイアウト（通知の配置）/ セクション設定（テンプレート + 自由設定 + お気に入り）/
 * アプリヘッダー（クイックアクセス）/ 通知タブ（何を表示するか）。
 * 通知の配置とセクション・メニューの配置は設定として分離する（改修依頼 2026-08-18）。
 */
type LayoutMode = 'layout' | 'sections' | 'header' | 'notifications'
const mode = ref<LayoutMode>('layout')
const modeChips = [
  { value: 'layout', label: 'レイアウト（通知の配置）' },
  { value: 'sections', label: 'セクション設定' },
  { value: 'header', label: 'アプリヘッダー' },
  { value: 'notifications', label: '通知タブ' },
]

/** 適用先スコープ（既定は自分。管理者のみ全社を選べる） */
const scope = ref<ApplyScope>('user')
const scopeChips = computed(() => [
  { value: 'user', label: '自分（このアカウント）' },
  ...(isAdmin.value ? [{ value: 'tenant', label: '全社（テナント既定）' }] : []),
])

/** 選択中スコープ自身に保存済みの通知配置（専用キー。適用中ハイライト用。未設定層はハイライトなし） */
const placementForScope = computed<NotificationPlacement | null>(() =>
  scope.value === 'user' ? userPlacement.value : tenantPlacement.value)

function templateName(id: string): string {
  if (id === 'custom') return 'カスタム'
  return templates.find(t => t.id === id)?.name ?? id
}

function placementLabel(p: NotificationPlacement): string {
  return NOTIFICATION_PLACEMENT_OPTIONS.find(o => o.value === p)?.label ?? p
}

/** 各選択肢 + ミニプレビュー（保存先スコープの現行セクション構成 + その配置）。
 *  computed = 再描画のたびに 4 回のディープコピーを繰り返さない（依存変化時のみ再構築） */
const placementOptionViews = computed(() =>
  NOTIFICATION_PLACEMENT_OPTIONS.map(o => ({
    ...o,
    preview: withNotificationPlacement(baseLayoutForScope(scope.value), o.value),
  })))

const busy = ref(false)

async function onApplyPlacement(placement: NotificationPlacement): Promise<void> {
  busy.value = true
  try {
    const res = await saveNotificationPlacement(placement, scope.value)
    if (res.ok) {
      show(`通知の配置を「${placementLabel(placement)}」に設定しました（${scope.value === 'user' ? '自分' : '全社'}）`, 'ok')
    }
  } finally {
    busy.value = false
  }
}

/** 該当層の配置設定を解除する（レイアウト構成の既定へ戻す。取消フロー = 原則 9.5） */
async function onResetPlacement(): Promise<void> {
  const ok = await confirmAsk.ask(
    scope.value === 'user' ? '自分の配置設定を解除' : '全社の配置設定を解除',
    scope.value === 'user'
      // 解除後の適用順は解決の層整合と一致させる（分離前の自分レイアウトが配置を持つ場合はそれが優先 = 原則7）
      ? '自分の通知配置の設定を解除します。以後は 自分のレイアウト構成の配置（以前レイアウトで選んでいた場合）→ 全社設定 → レイアウト構成の既定 の順で有効なものが適用されます。'
      : '全社の通知配置の設定を解除します。レイアウト構成の既定に戻ります（各ユーザーの自分設定は維持されます）。',
  )
  if (!ok) return
  busy.value = true
  try {
    const res = await resetNotificationPlacement(scope.value)
    if (res.ok) show('通知配置の設定を解除しました', 'ok')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 編集モード切替（レイアウト = 通知の配置 / セクション設定 / アプリヘッダー / 通知タブ） -->
    <UiChipTabs
      :model-value="mode"
      :options="modeChips"
      aria-label="レイアウト編集モード"
      @update:model-value="(v: string) => { mode = v as LayoutMode }"
    />

    <!-- セクション設定（テンプレート選択 + 自由設定 + お気に入り。2026-08-18 で分離・強化） -->
    <OfficeDashboardSectionEditor v-if="mode === 'sections'" />

    <!-- アプリヘッダー（クイックアクセス）の設定。「通知」ベルの表示もここで制御（2026-08-18） -->
    <OfficeHeaderQuickAccessPicker v-else-if="mode === 'header'" />

    <!-- 通知タブ（何を表示するか）の設定 -->
    <OfficeNotificationTabsPicker v-else-if="mode === 'notifications'" />

    <!-- レイアウト = 通知の配置（上 / 右 / 下 / 非表示）に特化 -->
    <template v-else>
      <!-- 現在有効な配置とその由来 -->
      <p class="rounded-lg bg-brand-soft px-3 py-2 text-xs text-sub">
        現在の通知の配置:
        <span class="font-bold text-brand">{{ placementLabel(effectiveLayout.options.notifications) }}</span>
        （{{ PLACEMENT_SOURCE_LABELS[placementSource] }}）
        ／ セクション構成「<span class="font-semibold">{{ templateName(activeTemplateId) }}</span>」
      </p>
      <!-- 自分の分離前レイアウトが配置を保持している場合のみ案内（このときだけ全社の配置設定より優先される = 原則7。
           テナント層レイアウト由来の場合は全社キーの設定で即座に上書きされるため出さない = レビュー R12） -->
      <p v-if="placementFromOwnLegacyLayout" class="rounded-lg border border-line px-3 py-2 text-[11px] text-muted">
        現在の配置は、自分の保存済みレイアウト構成に含まれる配置（以前の保存時の選択）が適用されています。
        この場合は全社の配置設定より自分のレイアウトが優先されます。変更するには下の 4 択から選んで適用してください。
      </p>

      <!-- モバイル/PC のシーン分離を明示（オペレーター指示 2026-08-10）。通知欄の配置は PC 表示に適用される -->
      <p class="flex items-start gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] text-muted">
        <Smartphone class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          モバイル表示は<b class="text-sub">メニューを最優先</b>し、通知はヘッダーのベル（未読バッジ付き）／下部ナビ「通知」から開きます。
          通知の配置は主に<b class="text-sub">PC 表示</b>に適用されます。セクションとメニューの配置は「セクション設定」タブで行います。
        </span>
      </p>

      <!-- 適用スコープ -->
      <div class="grid gap-1.5">
        <p class="text-[11px] font-bold text-muted">適用先</p>
        <UiChipTabs
          :model-value="scope"
          :options="scopeChips"
          aria-label="適用先スコープ"
          @update:model-value="(v: string) => { scope = v as ApplyScope }"
        />
        <p class="text-[11px] text-muted">
          <template v-if="scope === 'user'">この端末/アカウントにだけ適用されます（他の人には影響しません）。</template>
          <template v-else>全社の既定として適用されます（各ユーザーが自分の設定で上書き可能）。</template>
          セクション構成は変更されません（通知の配置だけを保存します）。
        </p>
      </div>

      <!-- 通知の配置（上 / 右 / 下 / 非表示） -->
      <ul class="grid gap-2.5 sm:grid-cols-2">
        <li
          v-for="o in placementOptionViews"
          :key="o.value"
          class="flex flex-col gap-2 rounded-xl border p-2.5"
          :class="placementForScope === o.value ? 'border-brand bg-brand-soft/30' : 'border-line'"
        >
          <div class="min-w-0">
            <p class="flex items-center gap-1.5 text-[13px] font-bold">
              {{ o.label }}
              <span
                v-if="placementForScope === o.value"
                class="inline-flex items-center gap-0.5 rounded-full bg-brand px-1.5 text-[10px] font-bold leading-4 text-white"
              >
                <Check class="h-2.5 w-2.5" /> 適用中
              </span>
            </p>
            <p class="mt-0.5 text-[11px] leading-relaxed text-muted">{{ o.description }}</p>
          </div>

          <OfficeDashboardLayoutPreview :layout="o.preview" />

          <button
            type="button"
            class="btn btn-sm mt-auto"
            :class="placementForScope === o.value ? '' : 'btn-primary'"
            :disabled="busy"
            @click="onApplyPlacement(o.value)"
          >
            {{ placementForScope === o.value ? '再適用' : (scope === 'user' ? '自分に適用' : '全社に適用') }}
          </button>
        </li>
      </ul>

      <!-- 解除（取消フロー = 原則 9.5。配置の専用キーのみ解除 = セクション構成には影響しない） -->
      <div class="flex items-center justify-end gap-2 border-t border-line pt-2.5">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy || placementForScope === null"
          @click="onResetPlacement"
        >
          <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
          {{ scope === 'user' ? '自分の配置設定を解除' : '全社の配置設定を解除' }}
        </button>
      </div>
    </template>
  </div>
</template>
