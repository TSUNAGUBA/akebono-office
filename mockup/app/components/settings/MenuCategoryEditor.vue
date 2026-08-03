<script setup lang="ts">
/**
 * メニューカテゴリのカスタマイズ（バッチ7h・オペレーター指示 2026-07-19 #10）。
 * ダッシュボード / マスタメンテナンスのカードメニューのカテゴリを自由に設定する:
 * カテゴリの追加・削除・名称変更・並び替え・カードの割当（論理名で検索する複数選択）。
 * 編集 UI は共通部品 UiMenuSectionEditor に集約（原則3）。本コンポーネントは保存・リセット・
 * ハイドレーション・エリア切替の orchestration を担う。
 * 取消フロー（原則 9.5）: 「既定に戻す」+ 全操作が再編集で上書き可能。
 * カテゴリ削除でカードは消えない（未割当カードは自動的に「その他」へ表示される）
 *
 * ダッシュボード領域について（2026-08-03 #25）: メニューのセクション配置は「ユーザー>テナント>アプリ既定」の
 * 3 階層をダッシュボードのレイアウト（レイアウト → セクション編集）から編集するのが主導線になった。
 * ここ（設定 > メニューカテゴリ）の「ダッシュボード」タブは従来のテナント設定（menu-categories-dashboard）を
 * そのまま編集する下位互換の導線として残す（テナント dashboard-layout 未設定時に有効。既存挙動を維持 = 原則7）。
 */
import { RotateCcw } from 'lucide-vue-next'
import { MENU_AREAS, MENU_CARDS, type MenuArea, type MenuCategoryDef } from '~/utils/menu-registry'

const { show } = useToast()
const confirmAsk = useConfirm()

const AREA_LABELS: Record<MenuArea, string> = {
  dashboard: 'ダッシュボード',
  masters: 'マスタメンテナンス',
}

const area = ref<MenuArea>('dashboard')
const areaChips = MENU_AREAS.map(a => ({ value: a, label: AREA_LABELS[a] }))

// エリアごとの composable インスタンス（コンポーザブルはトップレベルで確定させる）
const dash = useMenuCategories('dashboard')
const masters = useMenuCategories('masters')
const current = computed(() => (area.value === 'dashboard' ? dash : masters))

/** 編集ドラフト（保存するまで反映しない。エリア切替・保存・リセットで現在値から再同期） */
const draft = ref<MenuCategoryDef[]>([])
const dirty = ref(false)
function syncDraft(): void {
  draft.value = current.value.categories.value.map(c => ({ ...c, cardIds: [...c.cardIds] }))
  dirty.value = false
}
watch(area, syncDraft, { immediate: true })
// API モードは configs が非同期ハイドレーションされるため、保存値の到着時にも再同期する。
// 編集中（dirty）は上書きしない（PR #57 R1 M-1）
watch(() => current.value.categories.value, () => {
  if (!dirty.value) syncDraft()
})
// R2 Minor-1: ハイドレーション「前」に編集を始めた場合の上書きも塞ぐ —
// 設定ページを開いたら configs を取り直し、完了するまで保存・リセットを無効化する
// （モックモードの reloadConfigs は no-op のため即座に有効化される）
const settings = useAppSettings()
const hydrated = ref(false)
onMounted(async () => {
  try {
    await settings.reloadConfigs()
  } finally {
    if (!dirty.value) syncDraft()
    hydrated.value = true
  }
})

// ダッシュボード領域は外部リンク（設定 > 外部リンク）・AKEBONO 業態アプリも割当可能カードに含める
// （基本メニューと同じようにセクション配置できるようにする = オペレーター指示 2026-08-03）
const { externalCards } = useExternalLinkCards()
const { akebonoCards } = useAkebonoAppCards()
const cardOptions = computed(() => {
  const base = MENU_CARDS[area.value].map(c => ({ value: c.id, label: c.title }))
  if (area.value !== 'dashboard') return base
  return [
    ...base,
    ...externalCards.value.map(c => ({ value: String(c.id), label: `${c.title}（外部リンク）` })),
    ...akebonoCards.value.map(c => ({ value: String(c.id), label: `${c.title}（AKEBONO）` })),
  ]
})

/** 共通エディタからの更新（すべてユーザー操作起点 = dirty 化） */
function onDraftUpdate(next: MenuCategoryDef[]): void {
  draft.value = next
  dirty.value = true
}

const saving = ref(false)
async function saveDraft(): Promise<void> {
  const invalid = draft.value.some(c => !c.label.trim())
  if (invalid) {
    show('カテゴリ名を入力してください', 'warn')
    return
  }
  saving.value = true
  try {
    const res = await current.value.save(draft.value.map(c => ({ ...c, label: c.label.trim() })))
    // 失敗時（API エラー = putConfig がエラートーストを表示済み）は編集内容を破棄しない（R2 参考観察）
    if (!res.ok) return
    syncDraft()
    show(`${AREA_LABELS[area.value]}のメニューカテゴリを保存しました`, 'ok')
  } finally {
    saving.value = false
  }
}

async function resetToDefault(): Promise<void> {
  const ok = await confirmAsk.ask(
    '既定に戻す',
    `${AREA_LABELS[area.value]}のカテゴリ設定を既定の構成に戻します。よろしいですか？（保存済みのカスタマイズは失われますが、いつでも再設定できます）`,
  )
  if (!ok) return
  saving.value = true
  try {
    const res = await current.value.reset()
    if (!res.ok) return
    syncDraft()
    show('既定のカテゴリ構成に戻しました', 'ok')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiSectionCard
    title="メニューカテゴリ"
    description="ダッシュボード・マスタメンテナンスのカードメニューをカテゴリで整理します。どのカテゴリにも属さないメニューは自動的に「その他」に表示されます（メニューが消えることはありません）"
  >
    <div class="grid gap-3">
      <UiChipTabs
        :model-value="area"
        :options="areaChips"
        aria-label="対象メニュー"
        @update:model-value="(v: string) => { area = v as MenuArea }"
      />

      <p v-if="area === 'dashboard'" class="rounded-lg bg-brand-soft px-3 py-2 text-[11px] leading-relaxed text-sub">
        ダッシュボードのセクション配置は「自分・全社・アプリ既定」の 3 階層で設定できます。個人ごと／全社の
        使い分けはダッシュボード右上の<span class="font-semibold">「レイアウト → セクションを編集」</span>から行ってください。
        こちらは従来の全社共通設定（テナント既定）を編集する下位互換の導線です。
      </p>

      <UiMenuSectionEditor
        :model-value="draft"
        :card-options="cardOptions"
        @update:model-value="onDraftUpdate"
      />

      <div class="flex flex-wrap items-center gap-2">
        <span class="flex-1" />
        <button type="button" class="btn btn-sm" :disabled="saving || !hydrated" @click="resetToDefault">
          <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> 既定に戻す
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="saving || !dirty || !hydrated" @click="saveDraft">
          {{ saving ? '保存中…' : !hydrated ? '読込中…' : '保存' }}
        </button>
      </div>
    </div>
  </UiSectionCard>
</template>
