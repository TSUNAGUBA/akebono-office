<script setup lang="ts">
/**
 * メニューセクション（カテゴリ）編集の共通 UI（原則3。オペレーター指示 2026-08-03 #25）。
 * カテゴリの追加・削除・改名・並び替え・カード割当（UiMultiCombobox）を行う純プレゼンテーション。
 * v-model（MenuCategoryDef[]）で双方向。保存・リセット・ハイドレーション・スコープは呼び出し側が担う
 * （settings.MenuCategoryEditor / office.DashboardSectionEditor の両方から利用）。
 * カテゴリ削除でカードは消えない（未割当カードは categorize が自動的に「その他」へ回す）。
 *
 * カード（メニュー）の並び替え（改善要望 2026-08-17）: 割当済みカードを「並び順」リストで表示し、
 * ドラッグ&ドロップ（HTML5 DnD）または ↑/↓ ボタンで順番を入れ替えられる。cardIds の配列順が
 * そのまま表示順（categorizeCards は cardIds 順に描画）。タッチ端末はボタンで操作（原則8）。
 *
 * 内部に編集バッファ `rows` を持ち、カテゴリ名入力は v-model（IME 合成に安全 = 日本語入力が壊れない）。
 * 変更は都度クローンして emit する。親からの modelValue 変化は、自分が emit した配列（参照一致）なら取り込まず
 * （自己エコーの無限ループ回避 + 入力中の再バインド防止）、外部由来（ハイドレーション・リセット）のときだけ再同期。
 * レスポンシブ（原則8）: 行内の操作は flex-wrap で折り返す。取消（原則9.5）は親のリセット導線で担保。
 */
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-vue-next'
import type { MenuCategoryDef } from '~/utils/menu-registry'

const props = withDefaults(defineProps<{
  modelValue: MenuCategoryDef[]
  /** 割当可能カードの選択肢（value=カード id / label=表示名） */
  cardOptions: { value: string; label: string }[]
  /** カテゴリが 0 件のときの案内文 */
  emptyHint?: string
}>(), {
  emptyHint: 'カテゴリがありません。「カテゴリを追加」で作成してください（すべてのメニューは「その他」に表示されています）',
})

const emit = defineEmits<{ 'update:modelValue': [v: MenuCategoryDef[]] }>()

function clone(src: MenuCategoryDef[]): MenuCategoryDef[] {
  return src.map(c => ({ id: c.id, label: c.label, cardIds: [...c.cardIds] }))
}

/** 編集バッファ（v-model 対象。IME 安全のため直接ミューテートする） */
const rows = ref<MenuCategoryDef[]>(clone(props.modelValue))
/** 直近に emit した配列（親からのエコーを取り込まないための参照マーカー） */
let lastEmitted: MenuCategoryDef[] | null = null

watch(() => props.modelValue, (v) => {
  if (v === lastEmitted) return // 自己エコー = 取り込まない（入力中の再バインドを防ぐ）
  rows.value = clone(v)
})

/** 現在のバッファをクローンして親へ通知（親が dirty 化・保存対象にする） */
function commit(): void {
  const next = clone(rows.value)
  lastEmitted = next
  emit('update:modelValue', next)
}

function addCategory(): void {
  const used = new Set(rows.value.map(c => c.id))
  let n = 1
  while (used.has(`custom-${n}`)) n += 1
  rows.value = [...rows.value, { id: `custom-${n}`, label: '', cardIds: [] }]
  commit()
}

function removeCategory(id: string): void {
  rows.value = rows.value.filter(c => c.id !== id)
  commit()
}

function move(index: number, delta: number): void {
  const next = [...rows.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  rows.value = next
  commit()
}

function setCardIds(index: number, cardIds: string[]): void {
  const row = rows.value[index]
  if (!row) return
  row.cardIds = cardIds
  commit()
}

// ---------- セクション内カードの並び替え（改善要望 2026-08-17。cardIds の配列順 = 表示順） ----------

const labelByCardId = computed(() => new Map(props.cardOptions.map(o => [o.value, o.label])))

function cardLabel(id: string): string {
  return labelByCardId.value.get(id) ?? id
}

/** カードを同一セクション内で移動（↑/↓ ボタン。タッチ端末の主導線 = 原則8） */
function moveCard(sectionIndex: number, cardIndex: number, delta: number): void {
  const row = rows.value[sectionIndex]
  if (!row) return
  const target = cardIndex + delta
  if (target < 0 || target >= row.cardIds.length) return
  const next = [...row.cardIds]
  const [id] = next.splice(cardIndex, 1)
  next.splice(target, 0, id!)
  row.cardIds = next
  commit()
}

/** ドラッグ中のカード（セクションを跨ぐ移動はしない = 割当は上のコンボボックスで行う） */
const dragging = ref<{ section: number; card: number } | null>(null)

function onCardDragStart(sectionIndex: number, cardIndex: number, ev: DragEvent): void {
  dragging.value = { section: sectionIndex, card: cardIndex }
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(cardIndex)) // Firefox で DnD を有効化するため必須
  }
}

/** ドロップ先の行の上でドラッグ中の行を並べ替える（同一セクション内のみ） */
function onCardDragOver(sectionIndex: number, cardIndex: number, ev: DragEvent): void {
  const d = dragging.value
  if (!d || d.section !== sectionIndex) return
  ev.preventDefault() // drop を許可
  if (d.card === cardIndex) return
  const row = rows.value[sectionIndex]
  if (!row) return
  const next = [...row.cardIds]
  const [id] = next.splice(d.card, 1)
  next.splice(cardIndex, 0, id!)
  row.cardIds = next
  dragging.value = { section: sectionIndex, card: cardIndex }
}

function onCardDrop(ev: DragEvent): void {
  ev.preventDefault()
  if (dragging.value) commit() // 並び替え結果を確定
  dragging.value = null
}

function onCardDragEnd(): void {
  if (dragging.value) commit() // ドロップ先が行外でも途中までの並びを確定（取消は親のリセット = 原則9.5）
  dragging.value = null
}
</script>

<template>
  <div class="grid gap-2">
    <p v-if="rows.length === 0" class="text-[13px] text-muted">
      {{ emptyHint }}
    </p>

    <ul v-else class="grid gap-2">
      <li
        v-for="(cat, i) in rows"
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
            @input="commit"
          >
          <button type="button" class="btn btn-sm" :disabled="i === 0" aria-label="上へ移動" @click="move(i, -1)">
            <ArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-sm" :disabled="i === rows.length - 1" aria-label="下へ移動" @click="move(i, 1)">
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
            @update:model-value="(v: string[]) => setCardIds(i, v)"
          />
        </div>

        <!-- 並び順（割当が 2 件以上のとき。ドラッグ&ドロップ or ↑/↓ で入れ替え = 改善要望 2026-08-17） -->
        <div v-if="cat.cardIds.length > 1" class="mt-2 grid gap-1">
          <p class="text-[11px] font-semibold text-muted">並び順（ドラッグ&ドロップ または ↑/↓ で入れ替え。上から順に表示されます）</p>
          <ol class="grid gap-1">
            <li
              v-for="(cardId, ci) in cat.cardIds"
              :key="cardId"
              class="flex items-center gap-1.5 rounded border border-line bg-surface px-2 py-1"
              :class="{ 'opacity-60 ring-2 ring-brand-soft': dragging && dragging.section === i && dragging.card === ci }"
              draggable="true"
              @dragstart="onCardDragStart(i, ci, $event)"
              @dragover="onCardDragOver(i, ci, $event)"
              @drop="onCardDrop($event)"
              @dragend="onCardDragEnd"
            >
              <GripVertical class="h-3.5 w-3.5 shrink-0 cursor-grab text-muted" aria-hidden="true" />
              <span class="num w-4 shrink-0 text-center text-[11px] text-muted">{{ ci + 1 }}</span>
              <span class="min-w-0 flex-1 truncate text-[12px] text-ink">{{ cardLabel(cardId) }}</span>
              <button
                type="button" class="btn btn-sm" :disabled="ci === 0"
                :aria-label="`${cardLabel(cardId)} を上へ移動`" @click="moveCard(i, ci, -1)"
              >
                <ArrowUp class="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button" class="btn btn-sm" :disabled="ci === cat.cardIds.length - 1"
                :aria-label="`${cardLabel(cardId)} を下へ移動`" @click="moveCard(i, ci, 1)"
              >
                <ArrowDown class="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          </ol>
        </div>
      </li>
    </ul>

    <div>
      <button type="button" class="btn btn-sm" @click="addCategory">
        <Plus class="h-3.5 w-3.5" aria-hidden="true" /> カテゴリを追加
      </button>
    </div>
  </div>
</template>
