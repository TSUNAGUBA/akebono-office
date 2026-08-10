<script setup lang="ts">
/**
 * ダッシュボードのレイアウト選択（テンプレート + プレビュー + 適用スコープ。オペレーター指示 2026-08-03）。
 * - テンプレートをカードで一覧 + 軽量プレビュー（OfficeDashboardLayoutPreview）
 * - 適用スコープ: 自分（この端末/アカウント）= user / 全社（テナント既定）= tenant（管理者のみ）
 * - 現在有効な層（ユーザー/テナント/デフォルト）と適用中テンプレートを明示
 * - 取消フロー（原則 9.5）: 「自分の設定を解除」/「全社設定を解除」= resetLayout
 * - 「セクションを編集」タブ（#25）: セクション構成そのものを 3 階層で編集（OfficeDashboardSectionEditor）
 * レスポンシブ（原則8）: テンプレートは 1 → 2 列で流し込む
 */
import { Check, RotateCcw, Smartphone } from 'lucide-vue-next'
import type { ApplyScope } from '~/composables/useDashboardLayout'

const {
  templates, resolvedScope, activeTemplateId,
  userLayout, tenantLayoutOwn, hasUserLayout, hasTenantLayout, hasTenantLayoutOwn, isAdmin,
  applyTemplate, resetLayout,
} = useDashboardLayout()
const { show } = useToast()
const confirmAsk = useConfirm()

const SCOPE_LABELS: Record<string, string> = {
  user: '自分の設定', tenant: '全社設定', default: 'デフォルト表示',
}

/** 編集モード: テンプレート選択 / セクション構成の手動編集（#25） */
const mode = ref<'templates' | 'sections'>('templates')
const modeChips = [
  { value: 'templates', label: 'テンプレート' },
  { value: 'sections', label: 'セクションを編集' },
]

/** 適用先スコープ（既定は自分。管理者のみ全社を選べる） */
const scope = ref<ApplyScope>('user')
const scopeChips = computed(() => [
  { value: 'user', label: '自分（このアカウント）' },
  ...(isAdmin.value ? [{ value: 'tenant', label: '全社（テナント既定）' }] : []),
])

/** 選択中スコープに適用済みのテンプレート id（ハイライト用）。tenant は解除可能な新キー設定のみを対象にする */
const activeForScope = computed(() =>
  scope.value === 'user' ? userLayout.value?.templateId : tenantLayoutOwn.value?.templateId)

// 解除可否・ハイライト = その層自身に（解除できる）設定があるか。tenant は新キーのみを対象にする（レビュー MINOR）
const hasForScope = computed(() => scope.value === 'user' ? hasUserLayout.value : hasTenantLayoutOwn.value)
// 全社かつ「新キーは無いが従来のメニューカテゴリ設定は有効」= 解除は別画面（設定>メニューカテゴリ）担当（§53 NIT）
const tenantLegacyActive = computed(() =>
  scope.value === 'tenant' && !hasTenantLayoutOwn.value && hasTenantLayout.value)

function templateName(id: string): string {
  if (id === 'custom') return 'カスタム'
  return templates.find(t => t.id === id)?.name ?? id
}

const busy = ref(false)

async function onApply(templateId: string): Promise<void> {
  busy.value = true
  try {
    const res = await applyTemplate(templateId, scope.value)
    if (res.ok) {
      show(`「${templateName(templateId)}」を${scope.value === 'user' ? '自分' : '全社'}に適用しました`, 'ok')
    }
  } finally {
    busy.value = false
  }
}

async function onReset(): Promise<void> {
  const ok = await confirmAsk.ask(
    scope.value === 'user' ? '自分の設定を解除' : '全社設定を解除',
    scope.value === 'user'
      ? '自分のダッシュボードレイアウト設定を解除します。全社設定（あれば）またはデフォルト表示に戻ります。'
      : '全社のダッシュボードレイアウト設定を解除します。従来のメニューカテゴリ設定（あれば）またはデフォルト表示に戻ります。',
  )
  if (!ok) return
  busy.value = true
  try {
    const res = await resetLayout(scope.value)
    if (res.ok) show('レイアウト設定を解除しました', 'ok')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 編集モード切替（テンプレート / セクション編集） -->
    <UiChipTabs
      :model-value="mode"
      :options="modeChips"
      aria-label="レイアウト編集モード"
      @update:model-value="(v: string) => { mode = v as 'templates' | 'sections' }"
    />

    <!-- セクション構成の手動編集（3 階層。#25） -->
    <OfficeDashboardSectionEditor v-if="mode === 'sections'" />

    <template v-else>
    <!-- 現在有効な層 -->
    <p class="rounded-lg bg-brand-soft px-3 py-2 text-xs text-sub">
      現在有効:
      <span class="font-bold text-brand">{{ SCOPE_LABELS[resolvedScope] }}</span>
      ／ テンプレート「<span class="font-semibold">{{ templateName(activeTemplateId) }}</span>」
    </p>

    <!-- モバイル/PC のシーン分離を明示（オペレーター指示 2026-08-10）。通知欄の配置は PC 表示に適用される -->
    <p class="flex items-start gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] text-muted">
      <Smartphone class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        モバイル表示は<b class="text-sub">メニューを最優先</b>し、通知はヘッダーのベル（未読バッジ付き）／下部ナビ「通知」から開きます。
        下のテンプレート設定（<b class="text-sub">通知欄の位置</b>など）は主に<b class="text-sub">PC 表示</b>に適用されます（セクション構成・密度はモバイルにも反映）。
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
        <template v-else>全社の既定レイアウトとして適用されます（各ユーザーが自分の設定で上書き可能）。</template>
        <template v-if="hasForScope">
          現在この層は「{{ templateName(activeForScope || '') }}」が設定されています。
        </template>
        <template v-else-if="tenantLegacyActive">従来のメニューカテゴリ設定が全社に適用されています（解除は「設定 &gt; メニューカテゴリ」から）。</template>
        <template v-else>現在この層には設定がありません。</template>
      </p>
    </div>

    <!-- テンプレート一覧 + プレビュー -->
    <ul class="grid gap-2.5 sm:grid-cols-2">
      <li
        v-for="t in templates"
        :key="t.id"
        class="flex flex-col gap-2 rounded-xl border p-2.5"
        :class="activeForScope === t.id ? 'border-brand bg-brand-soft/30' : 'border-line'"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="flex items-center gap-1.5 text-[13px] font-bold">
              {{ t.name }}
              <span
                v-if="activeForScope === t.id"
                class="inline-flex items-center gap-0.5 rounded-full bg-brand px-1.5 text-[10px] font-bold leading-4 text-white"
              >
                <Check class="h-2.5 w-2.5" /> 適用中
              </span>
            </p>
            <p class="mt-0.5 text-[11px] leading-relaxed text-muted">{{ t.description }}</p>
          </div>
        </div>

        <OfficeDashboardLayoutPreview :layout="t.layout" />

        <button
          type="button"
          class="btn btn-sm mt-auto"
          :class="activeForScope === t.id ? '' : 'btn-primary'"
          :disabled="busy"
          @click="onApply(t.id)"
        >
          {{ activeForScope === t.id ? '再適用' : (scope === 'user' ? '自分に適用' : '全社に適用') }}
        </button>
      </li>
    </ul>

    <!-- 解除（取消フロー = 原則 9.5） -->
    <div class="flex items-center justify-end gap-2 border-t border-line pt-2.5">
      <button
        type="button"
        class="btn btn-sm"
        :disabled="busy || !hasForScope"
        @click="onReset"
      >
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
        {{ scope === 'user' ? '自分の設定を解除' : '全社設定を解除' }}
      </button>
    </div>
    </template>
  </div>
</template>
