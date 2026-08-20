<script setup lang="ts">
/**
 * ダッシュボードのセクション設定（3 階層。オペレーター指示 2026-08-03 #25 / 分離・強化 2026-08-18）。
 * セクションと中のメニューの配置（配置と並び順）に特化する。通知の配置は「レイアウト」タブが担当（分離）。
 * - 「テンプレート」サブモード: 配置プリセット（6 種・プレビュー付き）を選んで適用。
 *   適用はセクション構成 + 表示オプション（AKEBONO・密度）のみで、**通知の配置は保存先層の現行値を維持**
 *   （useDashboardLayout.applyTemplate）。
 * - 「自由設定」サブモード: セクションの追加・削除・改名・並び替え・カード割当（UiMenuSectionEditor）。
 *   自由設定は**お気に入り**として名前を付けて保存・呼び出しできる（useSectionFavorites。ユーザー個人・上限 10 件）。
 * - ドラフト初期値 = 保存先スコープ自身の土台レイアウトの sections（baseLayoutForScope）。
 *   effectiveLayout（解決結果）を使うと管理者の user 設定が tenant 編集へ紛れ込む（レビュー MAJOR）ため層で分ける。
 * - 割当候補 = 基本メニュー + 外部リンク + AKEBONO 業態アプリ（原則3: MenuCategoryEditor と同じ流儀）
 * - セクション「その他」（未配置メニューの自動セクション）の表示/非表示トグル（改修依頼 2026-08-20）。
 *   ドラフトの一部として dirty 管理し、「保存」で saveSections の optionsPatch として一緒に永続化する。
 *   解除（resetLayout）で既定 = 表示へ戻る（取消フロー = 原則9.5）。
 * - 保存 = saveSections(draft, scope, { showOther })。「この階層の設定を解除」= resetLayout(scope)（取消フロー = 原則9.5）
 * - 現在有効な層（resolvedScope）と適用中テンプレートを明示
 * レスポンシブ（原則8）は UiMenuSectionEditor / チップ / テンプレート 1 → 2 列に委譲。
 */
import { Check, FolderHeart, RotateCcw, Star, Trash2 } from 'lucide-vue-next'
import type { ApplyScope } from '~/composables/useDashboardLayout'
import { withNotificationPlacement } from '~/utils/dashboard-layout'
import { fmtDateTime } from '~/utils/format'
import { MENU_CARDS, type MenuCategoryDef } from '~/utils/menu-registry'

const {
  resolvedScope, activeTemplateId, templates, effectiveLayout, tenantEffectivePlacement,
  hasUserLayout, hasTenantLayout, hasTenantLayoutOwn, userLayout, tenantLayoutOwn,
  baseLayoutForScope, isAdmin,
  applyTemplate, saveSections, resetLayout,
} = useDashboardLayout()
const { favorites, saveFavorite, deleteFavorite } = useSectionFavorites()
const { externalCards } = useExternalLinkCards()
const { akebonoCards } = useAkebonoAppCards()
const { show } = useToast()
const confirmAsk = useConfirm()
const settings = useAppSettings()

const SCOPE_LABELS: Record<string, string> = {
  user: '自分の設定', tenant: '全社設定', default: 'デフォルト表示',
}

function templateName(id: string): string {
  if (id === 'custom') return 'カスタム'
  return templates.find(t => t.id === id)?.name ?? id
}

/** サブモード: テンプレート選択 / 自由設定（手動編集 + お気に入り）。改修依頼 2026-08-18 */
const subMode = ref<'templates' | 'custom'>('templates')
const subModeChips = [
  { value: 'templates', label: 'テンプレート' },
  { value: 'custom', label: '自由設定' },
]

/** 適用先スコープ（既定は自分。管理者のみ全社を選べる） */
const scope = ref<ApplyScope>('user')
const scopeChips = computed(() => [
  { value: 'user', label: '自分（このアカウント）' },
  ...(isAdmin.value ? [{ value: 'tenant', label: '全社（テナント既定）' }] : []),
])
// 解除可否 = その層自身に（解除できる）設定があるか。tenant は新キーのみを解除対象にする（レビュー MINOR）
const hasForScope = computed(() => (scope.value === 'user' ? hasUserLayout.value : hasTenantLayoutOwn.value))
// 全社かつ「新キーは無いが従来のメニューカテゴリ設定は有効」= 解除は別画面（設定>メニューカテゴリ）担当（§53 NIT）
const tenantLegacyActive = computed(() =>
  scope.value === 'tenant' && !hasTenantLayoutOwn.value && hasTenantLayout.value)

// ---------- テンプレート選択（旧「テンプレート」タブから移設。2026-08-18） ----------

/** 選択中スコープ自身に適用済みのテンプレート id（ハイライト用。tenant は解除可能な新キー設定のみ） */
const activeForScope = computed(() =>
  scope.value === 'user' ? userLayout.value?.templateId : tenantLayoutOwn.value?.templateId)

/** プレビューに使う通知の配置 = **保存先スコープ視点**の現行値（「適用しても配置は変わらない」を可視化）。
 *  user = 自分の解決有効値 / tenant = テナント層視点の有効値（キー > 分離前レイアウト > 既定 =
 *  管理者個人の設定・inherit 付き陳腐値を全社プレビューへ持ち込まない。レビュー R12/R13） */
const previewPlacement = computed(() =>
  scope.value === 'user'
    ? effectiveLayout.value.options.notifications
    : tenantEffectivePlacement.value)

/** テンプレート + プレビュー。computed = 再描画のたびに全テンプレートのディープコピーを繰り返さない */
const templateViews = computed(() =>
  templates.map(t => ({
    ...t,
    preview: withNotificationPlacement(t.layout, previewPlacement.value),
  })))

const busy = ref(false)

async function onApplyTemplate(templateId: string): Promise<void> {
  busy.value = true
  try {
    const res = await applyTemplate(templateId, scope.value)
    if (res.ok) {
      show(`「${templateName(templateId)}」を${scope.value === 'user' ? '自分' : '全社'}に適用しました（通知の配置は変わりません）`, 'ok')
    }
  } finally {
    busy.value = false
  }
}

// ---------- 自由設定（手動編集） ----------

// 割当可能カード = 基本メニュー + 外部リンク + AKEBONO 業態アプリ
const cardOptions = computed(() => [
  ...MENU_CARDS.dashboard.map(c => ({ value: c.id, label: c.title })),
  ...externalCards.value.map(c => ({ value: String(c.id), label: `${c.title}（外部リンク）` })),
  ...akebonoCards.value.map(c => ({ value: String(c.id), label: `${c.title}（AKEBONO）` })),
])

// ドラフト = 保存先スコープ自身の土台レイアウトの sections（baseLayoutForScope）。
// user なら user 設定（無ければ tenant→既定）、tenant なら tenant 設定（無ければ既定）を開始点にする。
// effectiveLayout（解決結果）だと管理者の user 設定が tenant 編集へ混入する（レビュー MAJOR）ため層で分ける。
const draft = ref<MenuCategoryDef[]>([])
const dirty = ref(false)
const baseSections = computed(() => baseLayoutForScope(scope.value).sections)
// セクション「その他」の表示（改修依頼 2026-08-20）。土台レイアウトの options.showOther を反映（未定義 = 表示 = 原則7）
const baseShowOther = computed(() => baseLayoutForScope(scope.value).options.showOther !== false)
const draftShowOther = ref(true)
function syncDraft(): void {
  draft.value = baseSections.value.map(s => ({ id: s.id, label: s.label, cardIds: [...s.cardIds] }))
  draftShowOther.value = baseShowOther.value
  dirty.value = false
}
// スコープ切替は明示操作 = 対象層の土台で必ず seed し直す（他層のドラフトを持ち越さない = レビュー MAJOR）
watch(scope, () => syncDraft())
// 編集中（dirty）は上書きしない。API モードの非同期ハイドレーション・解除後の再解決に追従する
watch(baseSections, () => { if (!dirty.value) syncDraft() }, { immediate: true })

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

/** セクション「その他」トグル（ドラフトの一部 = dirty 化。永続化は「保存」ボタンで一括） */
function onToggleShowOther(): void {
  draftShowOther.value = !draftShowOther.value
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
    const res = await saveSections(
      draft.value.map(c => ({ ...c, label: c.label.trim() })),
      scope.value,
      { showOther: draftShowOther.value },
    )
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
      ? '自分のダッシュボードレイアウト設定（セクション構成を含む）を解除します。全社設定（あれば）またはデフォルト表示に戻ります。レイアウトタブで設定した通知の配置（あれば）はそのまま残ります。'
      : '全社のダッシュボードレイアウト設定（セクション構成を含む）を解除します。従来のメニューカテゴリ設定（あれば）またはデフォルト表示に戻ります。レイアウトタブで設定した通知の配置（あれば）はそのまま残ります。',
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

// ---------- お気に入り（自由設定の保存・呼び出し。2026-08-18） ----------

const favoriteName = ref('')
const favoriteBusy = ref(false)

async function onSaveFavorite(): Promise<void> {
  const name = favoriteName.value.trim()
  if (!name) {
    show('お気に入りの名前を入力してください', 'warn')
    return
  }
  if (draft.value.some(c => !c.label.trim())) {
    show('カテゴリ名を入力してください', 'warn')
    return
  }
  const exists = favorites.value.some(f => f.name === name)
  if (exists) {
    const ok = await confirmAsk.ask(
      'お気に入りを上書き',
      `同じ名前のお気に入り「${name}」があります。現在の構成で上書きしますか？`,
    )
    if (!ok) return
  }
  favoriteBusy.value = true
  try {
    const res = await saveFavorite(name, draft.value.map(c => ({ ...c, label: c.label.trim() })))
    if (!res.ok) {
      show(res.error, 'warn')
      return
    }
    favoriteName.value = ''
    show(res.overwritten ? `お気に入り「${name}」を上書きしました` : `お気に入り「${name}」に保存しました`, 'ok')
  } finally {
    favoriteBusy.value = false
  }
}

/** お気に入りをドラフトへ呼び出す（保存はしない = 内容を確認して「保存」で反映） */
function onApplyFavorite(id: string): void {
  const fav = favorites.value.find(f => f.id === id)
  if (!fav) return
  draft.value = fav.sections.map(s => ({ id: s.id, label: s.label, cardIds: [...s.cardIds] }))
  dirty.value = true
  show(`お気に入り「${fav.name}」を読み込みました。「保存」で反映されます`, 'ok')
}

async function onDeleteFavorite(id: string): Promise<void> {
  const fav = favorites.value.find(f => f.id === id)
  if (!fav) return
  const ok = await confirmAsk.ask('お気に入りを削除', `お気に入り「${fav.name}」を削除します。よろしいですか？`, { danger: true })
  if (!ok) return
  favoriteBusy.value = true
  try {
    const res = await deleteFavorite(id)
    if (res.ok) show(`お気に入り「${fav.name}」を削除しました`, 'warn')
  } finally {
    favoriteBusy.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 現在有効な層 -->
    <p class="rounded-lg bg-brand-soft px-3 py-2 text-xs text-sub">
      現在有効:
      <span class="font-bold text-brand">{{ SCOPE_LABELS[resolvedScope] }}</span>
      ／ セクション構成「<span class="font-semibold">{{ templateName(activeTemplateId) }}</span>」
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
        <template v-else-if="tenantLegacyActive">従来のメニューカテゴリ設定が全社に適用されています（解除は「設定 &gt; メニューカテゴリ」から）。ここで保存すると全社の新しいレイアウト設定になります。</template>
        <template v-else>この層には現在設定がありません。</template>
        通知の配置は「レイアウト」タブで設定します（ここでは変わりません）。
      </p>
    </div>

    <!-- サブモード（テンプレート / 自由設定） -->
    <UiChipTabs
      :model-value="subMode"
      :options="subModeChips"
      aria-label="セクション設定の方法"
      @update:model-value="(v: string) => { subMode = v as 'templates' | 'custom' }"
    />

    <!-- ================= テンプレート選択 ================= -->
    <ul v-if="subMode === 'templates'" class="grid gap-2.5 sm:grid-cols-2">
      <li
        v-for="t in templateViews"
        :key="t.id"
        class="flex flex-col gap-2 rounded-xl border p-2.5"
        :class="activeForScope === t.id ? 'border-brand bg-brand-soft/30' : 'border-line'"
      >
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

        <OfficeDashboardLayoutPreview :layout="t.preview" />

        <button
          type="button"
          class="btn btn-sm mt-auto"
          :class="activeForScope === t.id ? '' : 'btn-primary'"
          :disabled="busy"
          @click="onApplyTemplate(t.id)"
        >
          {{ activeForScope === t.id ? '再適用' : (scope === 'user' ? '自分に適用' : '全社に適用') }}
        </button>
      </li>
    </ul>

    <!-- ================= 自由設定（手動編集 + お気に入り） ================= -->
    <template v-else>
      <!-- お気に入り（呼び出し・削除。ユーザー個人の保存） -->
      <div class="grid gap-1.5 rounded-xl border border-line p-2.5">
        <p class="flex items-center gap-1.5 text-[11px] font-bold text-muted">
          <FolderHeart class="h-3.5 w-3.5" aria-hidden="true" />
          お気に入り（自分だけの保存構成）
        </p>
        <p v-if="favorites.length === 0" class="text-[11px] text-muted">
          まだお気に入りがありません。下で構成を編集し「お気に入りに保存」で名前を付けて保存すると、ここから呼び出せます。
        </p>
        <ul v-else class="grid gap-1.5">
          <li
            v-for="f in favorites"
            :key="f.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] font-semibold">{{ f.name }}</span>
              <span class="block text-[10px] text-muted">
                セクション {{ f.sections.length }} 件<template v-if="f.savedAt">・{{ fmtDateTime(f.savedAt) }} 保存</template>
              </span>
            </span>
            <button type="button" class="btn btn-sm" :disabled="favoriteBusy" @click="onApplyFavorite(f.id)">
              呼び出す
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm text-crit"
              :disabled="favoriteBusy"
              :aria-label="`お気に入り「${f.name}」を削除`"
              @click="onDeleteFavorite(f.id)"
            >
              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </div>

      <!-- セクション編集（共通部品。追加・削除・改名・並び替え・カード割当） -->
      <UiMenuSectionEditor
        :model-value="draft"
        :card-options="cardOptions"
        @update:model-value="onDraftUpdate"
      />

      <!-- セクション「その他」の表示/非表示（改修依頼 2026-08-20。dirty 管理し「保存」で永続化。解除で表示へ戻る = 原則9.5） -->
      <div class="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2.5">
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-semibold">セクション「その他」を表示する</span>
          <span class="block text-[11px] leading-relaxed text-muted">
            オフにすると、どのセクションにも配置していないメニューはトップに表示されません。
          </span>
        </span>
        <button
          type="button"
          role="switch"
          :aria-checked="draftShowOther"
          aria-label="セクション「その他」を表示する"
          class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
          :class="draftShowOther ? 'bg-brand' : 'bg-line-strong'"
          @click="onToggleShowOther"
        >
          <span
            class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all"
            :class="draftShowOther ? 'left-[22px]' : 'left-0.5'"
            aria-hidden="true"
          />
        </button>
      </div>

      <!-- お気に入りに保存（現在の編集内容へ名前を付けて保存） -->
      <div class="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2.5">
        <Star class="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        <input
          v-model="favoriteName"
          type="text"
          class="input min-w-0 flex-1"
          placeholder="お気に入り名（例: 繁忙期用・自分の定番）"
          aria-label="お気に入り名"
          maxlength="40"
          @keydown.enter.prevent="onSaveFavorite"
        >
        <button type="button" class="btn btn-sm" :disabled="favoriteBusy" @click="onSaveFavorite">
          お気に入りに保存
        </button>
      </div>

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
    </template>
  </div>
</template>
