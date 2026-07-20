<script setup lang="ts">
/**
 * 項目カスタマイズ（F-31）— /akebono/settings/items（管理者ゲート必須）
 * 基本項目カタログ（コード SoT）にテナント差分を重ね、エンティティ単位で
 * フォーム/一覧の表示・必須・表示名を調整する。基本項目は非表示化のみ（削除不可）。
 */
import { RotateCcw } from 'lucide-vue-next'
import { useItemSettings, ITEM_ENTITY_LABELS, ITEM_CATALOG } from '~/composables/useItemSettings'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import type { ResolvedItem } from '~/composables/useItemSettings'
import type { TabItem, TableColumn } from '~/types/ui'

const its = useItemSettings()
const toast = useToast()
const confirm = useConfirm()

// ---------- エンティティ切替 ----------

const tabs = computed<TabItem[]>(() =>
  its.entities.map(e => ({ key: e, label: ITEM_ENTITY_LABELS[e] ?? e })),
)
const current = ref<string>(its.entities[0] ?? '')

const items = computed<ResolvedItem[]>(() => its.resolve(current.value))
const rows = computed(() => items.value as unknown as Record<string, unknown>[])
const overriddenCount = computed(() => items.value.filter(i => i.overridden).length)

function asItem(row: Record<string, unknown>): ResolvedItem {
  return row as unknown as ResolvedItem
}

const columns: TableColumn[] = [
  { key: 'item', label: '項目', primary: true },
  { key: 'form', label: 'フォーム表示', align: 'center', width: '120px', primary: true },
  { key: 'list', label: '一覧表示', align: 'center', width: '110px', primary: true },
  { key: 'label', label: '表示名の上書き', width: '220px' },
]

// ---------- 変更ハンドラ ----------

function toggleForm(item: ResolvedItem, ev: Event): void {
  if (item.requiredFixed) return
  const checked = (ev.target as HTMLInputElement).checked
  its.upsert(current.value, item.itemKey, { formVisible: checked })
  toast.show(`「${item.labelDisplay}」のフォーム表示を${checked ? 'ON' : 'OFF'}にしました`, 'ok')
}

function toggleList(item: ResolvedItem, ev: Event): void {
  const checked = (ev.target as HTMLInputElement).checked
  its.upsert(current.value, item.itemKey, { listVisible: checked })
  toast.show(`「${item.labelDisplay}」の一覧表示を${checked ? 'ON' : 'OFF'}にしました`, 'ok')
}

function changeLabel(item: ResolvedItem, ev: Event): void {
  const raw = (ev.target as HTMLInputElement).value.trim()
  const next = raw === '' || raw === item.label ? null : raw
  its.upsert(current.value, item.itemKey, { labelOverride: next })
  toast.show(next ? `表示名を「${next}」に変更しました` : '表示名を既定に戻しました', 'ok')
}

/** 上書き入力に表示する値（カスタム表示名がある場合のみ。無ければ空 = 既定 placeholder） */
function labelValue(item: ResolvedItem): string {
  return item.labelDisplay !== item.label ? item.labelDisplay : ''
}

async function resetCurrent(): Promise<void> {
  if (overriddenCount.value === 0) {
    toast.show('このエンティティにカスタム差分はありません', 'warn')
    return
  }
  const ok = await confirm.ask(
    '業種の基本項目へ戻す',
    `「${ITEM_ENTITY_LABELS[current.value] ?? current.value}」の項目カスタマイズ（${overriddenCount.value}件）をすべて破棄し、業種の基本項目構成に戻します。よろしいですか？`,
    { danger: true, confirmLabel: '基本項目へ戻す' },
  )
  if (!ok) return
  its.resetEntity(current.value)
  toast.show('業種の基本項目へ戻しました', 'ok')
}
</script>

<template>
  <MastersMasterShell
    title="項目カスタマイズ"
    description="フォーム・一覧に表示する項目と表示名を調整します。基本項目は非表示化のみ可能で、削除はできません（整合のため必須固定の項目もあります）。"
  >
    <template #actions>
      <button type="button" class="btn" @click="resetCurrent">
        <RotateCcw class="h-4 w-4" aria-hidden="true" />
        業種の基本項目へ戻す
      </button>
    </template>

    <template #filter>
      <UiTabBar v-model="current" :tabs="tabs" />
    </template>

    <UiSectionCard
      :title="`${ITEM_ENTITY_LABELS[current] ?? current} の項目（${items.length}件）`"
      :description="overriddenCount > 0 ? `${overriddenCount}件がカスタム済み` : '差分なし（業種の基本項目のまま）'"
      flush
    >
      <UiDataTable
        :columns="columns"
        :rows="rows"
        empty-title="項目がありません"
      >
        <template #cell-item="{ row }">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-medium">{{ asItem(row).labelDisplay }}</span>
            <UiStatusBadge
              v-if="asItem(row).industryHint"
              tone="info"
              :label="INDUSTRY_TYPE_LABELS[asItem(row).industryHint!]"
            />
            <UiStatusBadge v-if="asItem(row).requiredFixed" tone="warn" label="必須固定" />
            <UiStatusBadge v-if="asItem(row).overridden" tone="brand" label="カスタム済み" dot />
          </div>
          <p class="mt-0.5 text-[11px] text-muted">キー: {{ asItem(row).itemKey }}</p>
        </template>

        <template #cell-form="{ row }">
          <label class="inline-flex items-center justify-center gap-1.5">
            <input
              type="checkbox"
              class="h-4 w-4 accent-brand"
              :checked="asItem(row).requiredFixed ? true : asItem(row).formVisible"
              :disabled="asItem(row).requiredFixed"
              :aria-label="`${asItem(row).labelDisplay} のフォーム表示`"
              @change="toggleForm(asItem(row), $event)"
            >
            <span v-if="asItem(row).requiredFixed" class="text-[11px] text-muted">固定</span>
          </label>
        </template>

        <template #cell-list="{ row }">
          <label class="inline-flex items-center justify-center">
            <input
              type="checkbox"
              class="h-4 w-4 accent-brand"
              :checked="asItem(row).listVisible"
              :aria-label="`${asItem(row).labelDisplay} の一覧表示`"
              @change="toggleList(asItem(row), $event)"
            >
          </label>
        </template>

        <template #cell-label="{ row }">
          <input
            type="text"
            class="input"
            :value="labelValue(asItem(row))"
            :placeholder="asItem(row).label"
            :aria-label="`${asItem(row).label} の表示名の上書き`"
            @change="changeLabel(asItem(row), $event)"
          >
        </template>
      </UiDataTable>
    </UiSectionCard>
  </MastersMasterShell>
</template>
