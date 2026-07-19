<script setup lang="ts">
/**
 * メニューカテゴリのカスタマイズ（バッチ7h・オペレーター指示 2026-07-19 #10）。
 * ダッシュボード / マスタメンテナンスのカードメニューのカテゴリを自由に設定する:
 * カテゴリの追加・削除・名称変更・並び替え・カードの割当（論理名で検索する複数選択）。
 * 取消フロー（原則 9.5）: 「既定に戻す」+ 全操作が再編集で上書き可能。
 * カテゴリ削除でカードは消えない（未割当カードは自動的に「その他」へ表示される）
 */
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
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
// 編集中（dirty）は上書きしない（PR #57 R1 M-1: 到着前に編集を始めると既定構成ベースの保存で
// 保存済みカスタマイズを静かに上書きするレースの解消）
watch(() => current.value.categories.value, () => {
  if (!dirty.value) syncDraft()
})

const cardOptions = computed(() =>
  MENU_CARDS[area.value].map(c => ({ value: c.id, label: c.title })))

function markDirty(): void {
  dirty.value = true
}

function addCategory(): void {
  const used = new Set(draft.value.map(c => c.id))
  let n = 1
  while (used.has(`custom-${n}`)) n += 1
  draft.value = [...draft.value, { id: `custom-${n}`, label: '', cardIds: [] }]
  dirty.value = true
}

function removeCategory(id: string): void {
  draft.value = draft.value.filter(c => c.id !== id)
  dirty.value = true
}

function move(index: number, delta: number): void {
  const next = [...draft.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
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
    await current.value.save(draft.value.map(c => ({ ...c, label: c.label.trim() })))
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
    await current.value.reset()
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

      <div v-if="draft.length === 0" class="text-[13px] text-muted">
        カテゴリがありません。「カテゴリを追加」で作成してください（すべてのメニューは「その他」に表示されています）
      </div>

      <ul v-else class="grid gap-2">
        <li
          v-for="(cat, i) in draft"
          :key="cat.id"
          class="rounded-lg border border-line p-2.5"
        >
          <div class="flex flex-wrap items-center gap-1.5">
            <input
              v-model="cat.label"
              type="text"
              class="input min-w-0 flex-1"
              :aria-label="`カテゴリ名（${i + 1} 番目）`"
              placeholder="カテゴリ名"
              @input="markDirty"
            >
            <button type="button" class="btn btn-sm" :disabled="i === 0" aria-label="上へ移動" @click="move(i, -1)">
              <ArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-sm" :disabled="i === draft.length - 1" aria-label="下へ移動" @click="move(i, 1)">
              <ArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-danger btn-sm" aria-label="カテゴリを削除" @click="removeCategory(cat.id)">
              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div class="mt-2">
            <UiMultiCombobox
              :model-value="cat.cardIds"
              :options="cardOptions"
              :aria-label="`${cat.label || 'カテゴリ'}のメニュー割当`"
              @update:model-value="(v: string[]) => { cat.cardIds = v; markDirty() }"
            />
          </div>
        </li>
      </ul>

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-sm" @click="addCategory">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> カテゴリを追加
        </button>
        <span class="flex-1" />
        <button type="button" class="btn btn-sm" :disabled="saving" @click="resetToDefault">
          <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> 既定に戻す
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="saveDraft">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </UiSectionCard>
</template>
