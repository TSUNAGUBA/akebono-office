<script setup lang="ts">
/**
 * ダッシュボードのセクション構成エディタ（3 階層。オペレーター指示 2026-08-03 #25）。
 * 「どのメニューをどのセクションに置くか」を、自分（user）/ 全社（tenant〔管理者のみ〕）のスコープを選んで
 * 編集・保存する。適用は「ユーザー > テナント > アプリ既定」で解決（useDashboardLayout.effectiveLayout）。
 * - ドラフト初期値 = 現在の有効レイアウトの sections（今見えている構成をそのまま編集開始点にする）
 * - 割当候補 = 基本メニュー + 外部リンク + AKEBONO 業態アプリ（原則3: MenuCategoryEditor と同じ流儀）
 * - 編集 UI は共通部品 UiMenuSectionEditor（追加・削除・改名・並び替え・カード割当）
 * - 保存 = saveSections(draft, scope)。「この階層の設定を解除」= resetLayout(scope)（取消フロー = 原則9.5）
 * - 現在有効な層（resolvedScope）と適用中テンプレートを明示
 * レスポンシブ（原則8）は UiMenuSectionEditor / チップに委譲。
 */
import { RotateCcw } from 'lucide-vue-next'
import type { ApplyScope } from '~/composables/useDashboardLayout'
import { MENU_CARDS, type MenuCategoryDef } from '~/utils/menu-registry'

const {
  effectiveLayout, resolvedScope, activeTemplateId, templates,
  hasUserLayout, hasTenantLayout, isAdmin,
  saveSections, resetLayout,
} = useDashboardLayout()
const { externalCards } = useExternalLinkCards()
const { akebonoCards } = useAkebonoAppCards()
const { show } = useToast()
const confirmAsk = useConfirm()
const settings = useAppSettings()

const SCOPE_LABELS: Record<string, string> = {
  user: '自分の設定', tenant: '全社設定', default: 'デフォルト表示',
}

function templateName(id: string): string {
  return templates.find(t => t.id === id)?.name ?? id
}

/** 適用先スコープ（既定は自分。管理者のみ全社を選べる） */
const scope = ref<ApplyScope>('user')
const scopeChips = computed(() => [
  { value: 'user', label: '自分（このアカウント）' },
  ...(isAdmin.value ? [{ value: 'tenant', label: '全社（テナント既定）' }] : []),
])
const hasForScope = computed(() => (scope.value === 'user' ? hasUserLayout.value : hasTenantLayout.value))

// 割当可能カード = 基本メニュー + 外部リンク + AKEBONO 業態アプリ
const cardOptions = computed(() => [
  ...MENU_CARDS.dashboard.map(c => ({ value: c.id, label: c.title })),
  ...externalCards.value.map(c => ({ value: String(c.id), label: `${c.title}（外部リンク）` })),
  ...akebonoCards.value.map(c => ({ value: String(c.id), label: `${c.title}（AKEBONO）` })),
])

// ドラフト = 現在の有効レイアウトの sections（ユーザー > テナント > デフォルトの解決結果）
const draft = ref<MenuCategoryDef[]>([])
const dirty = ref(false)
function syncDraft(): void {
  draft.value = effectiveLayout.value.sections.map(s => ({ id: s.id, label: s.label, cardIds: [...s.cardIds] }))
  dirty.value = false
}
// 編集中（dirty）は上書きしない。API モードの非同期ハイドレーション・解除後の再解決に追従する
watch(effectiveLayout, () => { if (!dirty.value) syncDraft() }, { immediate: true })

const hydrated = ref(false)
onMounted(async () => {
  try {
    await settings.reloadConfigs()
  } finally {
    if (!dirty.value) syncDraft()
    hydrated.value = true
  }
})

/** 共通エディタからの更新（すべてユーザー操作起点 = dirty 化） */
function onDraftUpdate(next: MenuCategoryDef[]): void {
  draft.value = next
  dirty.value = true
}

const saving = ref(false)
async function save(): Promise<void> {
  const invalid = draft.value.some(c => !c.label.trim())
  if (invalid) {
    show('カテゴリ名を入力してください', 'warn')
    return
  }
  saving.value = true
  try {
    const res = await saveSections(draft.value.map(c => ({ ...c, label: c.label.trim() })), scope.value)
    if (!res.ok) return
    dirty.value = false
    show(`セクション構成を${scope.value === 'user' ? '自分' : '全社'}に保存しました`, 'ok')
  } finally {
    saving.value = false
  }
}

async function onReset(): Promise<void> {
  const ok = await confirmAsk.ask(
    scope.value === 'user' ? '自分の設定を解除' : '全社設定を解除',
    scope.value === 'user'
      ? '自分のダッシュボードレイアウト設定（セクション構成を含む）を解除します。全社設定（あれば）またはデフォルト表示に戻ります。'
      : '全社のダッシュボードレイアウト設定（セクション構成を含む）を解除します。従来のメニューカテゴリ設定（あれば）またはデフォルト表示に戻ります。',
  )
  if (!ok) return
  saving.value = true
  try {
    const res = await resetLayout(scope.value)
    if (res.ok) {
      show('レイアウト設定を解除しました', 'ok')
      syncDraft()
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 現在有効な層 -->
    <p class="rounded-lg bg-brand-soft px-3 py-2 text-xs text-sub">
      現在有効:
      <span class="font-bold text-brand">{{ SCOPE_LABELS[resolvedScope] }}</span>
      ／ テンプレート「<span class="font-semibold">{{ templateName(activeTemplateId) }}</span>」
    </p>

    <!-- 適用スコープ -->
    <div class="grid gap-1.5">
      <p class="text-[11px] font-bold text-muted">保存先</p>
      <UiChipTabs
        :model-value="scope"
        :options="scopeChips"
        aria-label="保存先スコープ"
        @update:model-value="(v: string) => { scope = v as ApplyScope }"
      />
      <p class="text-[11px] text-muted">
        <template v-if="scope === 'user'">この端末/アカウントにだけ適用されます（他の人には影響しません）。</template>
        <template v-else>全社の既定セクション構成として適用されます（各ユーザーが自分の設定で上書き可能）。</template>
        <template v-if="hasForScope">この層には現在レイアウト設定があります。</template>
        <template v-else>この層には現在設定がありません。</template>
      </p>
    </div>

    <!-- セクション編集（共通部品。追加・削除・改名・並び替え・カード割当） -->
    <UiMenuSectionEditor
      :model-value="draft"
      :card-options="cardOptions"
      @update:model-value="onDraftUpdate"
    />

    <!-- 保存 / 解除（取消フロー = 原則 9.5） -->
    <div class="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
      <button
        type="button"
        class="btn btn-sm"
        :disabled="saving || !hydrated || !hasForScope"
        @click="onReset"
      >
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
        {{ scope === 'user' ? '自分の設定を解除' : '全社設定を解除' }}
      </button>
      <span class="flex-1" />
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="saving || !dirty || !hydrated"
        @click="save"
      >
        {{ saving ? '保存中…' : !hydrated ? '読込中…' : (scope === 'user' ? '自分に保存' : '全社に保存') }}
      </button>
    </div>
  </div>
</template>
