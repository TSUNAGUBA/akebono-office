<script setup lang="ts">
/**
 * メニューセクション（カテゴリ）編集の共通 UI（原則3。オペレーター指示 2026-08-03 #25）。
 * カテゴリの追加・削除・改名・並び替え・カード割当（UiMultiCombobox）を行う純プレゼンテーション。
 * v-model（MenuCategoryDef[]）で双方向。保存・リセット・ハイドレーション・スコープは呼び出し側が担う
 * （settings.MenuCategoryEditor / office.DashboardSectionEditor の両方から利用）。
 * カテゴリ削除でカードは消えない（未割当カードは categorize が自動的に「その他」へ回す）。
 *
 * 内部に編集バッファ `rows` を持ち、カテゴリ名入力は v-model（IME 合成に安全 = 日本語入力が壊れない）。
 * 変更は都度クローンして emit する。親からの modelValue 変化は、自分が emit した配列（参照一致）なら取り込まず
 * （自己エコーの無限ループ回避 + 入力中の再バインド防止）、外部由来（ハイドレーション・リセット）のときだけ再同期。
 * レスポンシブ（原則8）: 行内の操作は flex-wrap で折り返す。取消（原則9.5）は親のリセット導線で担保。
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-vue-next'
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
      </li>
    </ul>

    <div>
      <button type="button" class="btn btn-sm" @click="addCategory">
        <Plus class="h-3.5 w-3.5" aria-hidden="true" /> カテゴリを追加
      </button>
    </div>
  </div>
</template>
