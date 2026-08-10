<script setup lang="ts">
/**
 * 項目カスタマイズ（F-31）— /akebono/settings/items（管理者ゲート必須）
 * 基本項目カタログ（コード SoT）にテナント差分を重ね、エンティティ単位で
 * フォーム/一覧の表示・必須・表示名を調整する。基本項目は非表示化のみ（削除不可）。
 */
import { Pencil, Plus, RotateCcw, X } from 'lucide-vue-next'
import { useItemSettings, ITEM_ENTITY_LABELS, ITEM_CATALOG } from '~/composables/useItemSettings'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import type { ResolvedItem } from '~/composables/useItemSettings'
import type { CustomFieldDef, CustomFieldEntity, CustomFieldType } from '~/types/domain'
import type { TabItem, TableColumn } from '~/types/ui'

const its = useItemSettings()
const cf = useCustomFields()
const toast = useToast()
const confirm = useConfirm()

// ---------- エンティティ切替 ----------

const tabs = computed<TabItem[]>(() =>
  its.entities.map(e => ({ key: e, label: ITEM_ENTITY_LABELS[e] ?? e })),
)
const current = ref<string>(its.entities[0] ?? '')

// 追加カスタム項目がフォーム/一覧に反映される業務アプリ（入力フォームを持つもの）。
// SKU（商品ページ内蔵）・請求（締めで自動生成・フォーム無し）はここに追加しても反映先が無いため、
// 追加カスタム項目セクションを無効化して「宣言だけあって実態が伴わない」状態を防ぐ（レビュー指摘 2026-08-10）。
const CUSTOM_FORM_ENTITIES = new Set([
  'product', 'sales_record', 'purchase_order', 'production_order',
  'purchase_record', 'inbound', 'outbound', 'inventory',
])
const customRenders = computed(() => CUSTOM_FORM_ENTITIES.has(current.value))

const items = computed<ResolvedItem[]>(() => its.resolve(current.value))
const rows = computed(() => items.value as unknown as Record<string, unknown>[])
const overriddenCount = computed(() => items.value.filter(i => i.overridden).length)

function asItem(row: Record<string, unknown>): ResolvedItem {
  return row as unknown as ResolvedItem
}

const columns: TableColumn[] = [
  { key: 'item', label: '項目', primary: true },
  { key: 'form', label: 'フォーム表示', align: 'center', width: '110px', primary: true },
  { key: 'list', label: '一覧表示', align: 'center', width: '100px', primary: true },
  { key: 'filter', label: '検索対象', align: 'center', width: '100px', primary: true },
  { key: 'label', label: '表示名の上書き', width: '200px' },
]

// ---------- 変更ハンドラ ----------

async function toggleForm(item: ResolvedItem, ev: Event): Promise<void> {
  if (item.requiredFixed) return
  const checked = (ev.target as HTMLInputElement).checked
  const res = await its.upsert(current.value, item.itemKey, { formVisible: checked })
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show(`「${item.labelDisplay}」のフォーム表示を${checked ? 'ON' : 'OFF'}にしました`, 'ok')
}

async function toggleList(item: ResolvedItem, ev: Event): Promise<void> {
  const checked = (ev.target as HTMLInputElement).checked
  const res = await its.upsert(current.value, item.itemKey, { listVisible: checked })
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show(`「${item.labelDisplay}」の一覧表示を${checked ? 'ON' : 'OFF'}にしました`, 'ok')
}

async function toggleFilter(item: ResolvedItem, ev: Event): Promise<void> {
  const checked = (ev.target as HTMLInputElement).checked
  const res = await its.upsert(current.value, item.itemKey, { filterVisible: checked })
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show(`「${item.labelDisplay}」の検索対象を${checked ? 'ON' : 'OFF'}にしました`, 'ok')
}

async function changeLabel(item: ResolvedItem, ev: Event): Promise<void> {
  const raw = (ev.target as HTMLInputElement).value.trim()
  const next = raw === '' || raw === item.label ? null : raw
  const res = await its.upsert(current.value, item.itemKey, { labelOverride: next })
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
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
  const res = await its.resetEntity(current.value)
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show('業種の基本項目へ戻しました', 'ok')
}

// ---------- 追加カスタム項目（F-31 汎用化。同一エンジン = useCustomFields。全アプリ共通） ----------

const CF_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'テキスト', number: '数値', date: '日付', select: '選択', multiselect: '複数選択', boolean: 'ON/OFF',
}
const cfTypeOptions = (Object.keys(CF_TYPE_LABELS) as CustomFieldType[]).map(k => ({ value: k, label: CF_TYPE_LABELS[k] }))
const customDefs = computed<CustomFieldDef[]>(() => cf.defsFor(current.value as CustomFieldEntity))
const cfRows = computed(() => customDefs.value as unknown as Record<string, unknown>[])
function asDef(row: Record<string, unknown>): CustomFieldDef { return row as unknown as CustomFieldDef }

const cfColumns: TableColumn[] = [
  { key: 'label', label: '項目名', primary: true },
  { key: 'type', label: '種別', width: '110px' },
  { key: 'required', label: '必須', align: 'center', width: '70px' },
  { key: 'actions', label: '操作', align: 'right', width: '120px', primary: true },
]

const cfOpen = ref(false)
const cfForm = reactive<{ id: string | null; key: string; label: string; fieldType: CustomFieldType; optionsText: string; required: boolean }>({
  id: null, key: '', label: '', fieldType: 'text', optionsText: '', required: false,
})
const cfError = ref('')
const cfNeedsOptions = computed(() => cfForm.fieldType === 'select' || cfForm.fieldType === 'multiselect')

function openCfCreate(): void {
  Object.assign(cfForm, { id: null, key: '', label: '', fieldType: 'text', optionsText: '', required: false })
  cfError.value = ''
  cfOpen.value = true
}
function openCfEdit(d: CustomFieldDef): void {
  Object.assign(cfForm, { id: d.id, key: d.key, label: d.label, fieldType: d.fieldType, optionsText: d.options.join('\n'), required: d.required })
  cfError.value = ''
  cfOpen.value = true
}

async function onCfSave(): Promise<void> {
  cfError.value = ''
  const key = cfForm.key.trim()
  const label = cfForm.label.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) { cfError.value = 'キーは英字始まりの半角英数字（_ 可）で入力してください'; return }
  if (!label) { cfError.value = '項目名を入力してください'; return }
  // 既定項目キー・他カスタム項目キーとの重複を防ぐ（custom.<key> で保存されるが混同回避）
  if (ITEM_CATALOG[current.value]?.some(c => c.itemKey === key)) { cfError.value = 'このキーは既定項目と重複しています'; return }
  if (cf.list.value.some(d => d.entity === current.value && d.key === key && d.id !== cfForm.id)) {
    cfError.value = 'このキーは既に使われています'; return
  }
  const options = cfNeedsOptions.value ? cfForm.optionsText.split('\n').map(s => s.trim()).filter(Boolean) : []
  if (cfNeedsOptions.value && options.length === 0) { cfError.value = '選択肢を 1 つ以上入力してください'; return }
  const order = cfForm.id
    ? (customDefs.value.find(d => d.id === cfForm.id)?.displayOrder ?? customDefs.value.length + 1)
    : customDefs.value.length + 1
  const res = await cf.save({
    ...(cfForm.id ? { id: cfForm.id } : {}),
    entity: current.value as CustomFieldEntity, key, label, fieldType: cfForm.fieldType,
    options, required: cfForm.required, displayOrder: order, active: true,
  })
  if (!res.ok) { cfError.value = res.error.message; return }
  cfOpen.value = false
  toast.show('カスタム項目を保存しました（対応済みのアプリのフォームに反映されます）', 'ok')
}

async function onCfRemove(d: CustomFieldDef): Promise<void> {
  const ok = await confirm.ask('カスタム項目の削除',
    `「${d.label}」を削除します。（既存レコードの入力値は保持されますが、入力欄は表示されなくなります）`,
    { danger: true, confirmLabel: '削除する' })
  if (!ok) return
  const res = await cf.archive(d.id)
  toast.show(res.ok ? 'カスタム項目を削除しました' : res.error.message, res.ok ? 'ok' : 'warn')
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

        <template #cell-filter="{ row }">
          <label v-if="asItem(row).filterKind" class="inline-flex items-center justify-center">
            <input
              type="checkbox"
              class="h-4 w-4 accent-brand"
              :checked="asItem(row).filterVisible"
              :aria-label="`${asItem(row).labelDisplay} を検索対象にする`"
              @change="toggleFilter(asItem(row), $event)"
            >
          </label>
          <span v-else class="text-[11px] text-muted" title="この項目は検索フィルタに使えません">—</span>
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

    <!-- 追加カスタム項目（同一エンジンで全アプリ共通） -->
    <UiSectionCard
      :title="`${ITEM_ENTITY_LABELS[current] ?? current} の追加カスタム項目（${customDefs.length}件）`"
      description="基本項目に無い項目を追加します。追加した項目は、各業務アプリ（商品・売上・発注・生産・仕入・入荷・出荷・在庫）の入力フォームに入力欄として表示され、一覧にも列として表示できます（表示 ON/OFF・表示名の変更も一覧に反映）。データ取込・連携のマッピング項目としても選べます。"
      flush
    >
      <template #actions>
        <button v-if="customRenders" type="button" class="btn" @click="openCfCreate">
          <Plus class="h-4 w-4" aria-hidden="true" /> 項目を追加
        </button>
      </template>
      <p v-if="!customRenders" class="rounded-[10px] border border-line bg-surface-soft px-3 py-2 text-[12px] text-muted">
        「{{ ITEM_ENTITY_LABELS[current] ?? current }}」は専用の入力フォームを持たないため、追加カスタム項目の入力・表示先がありません（{{ current === 'sku' ? 'SKU は商品マスタ内で管理' : '請求は締めで自動生成' }}）。基本項目の表示・表示名の調整のみ利用できます。
      </p>
      <UiDataTable
        v-else
        :columns="cfColumns"
        :rows="cfRows"
        empty-title="カスタム項目はありません"
        empty-hint="「項目を追加」から、このアプリ独自の管理項目を追加できます"
      >
        <template #cell-label="{ row }">
          <span class="font-medium">{{ asDef(row).label }}</span>
          <p class="mt-0.5 text-[11px] text-muted">キー: custom.{{ asDef(row).key }}</p>
        </template>
        <template #cell-type="{ row }">
          {{ CF_TYPE_LABELS[asDef(row).fieldType] }}
        </template>
        <template #cell-required="{ row }">
          <UiStatusBadge v-if="asDef(row).required" tone="warn" label="必須" />
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-actions="{ row }">
          <span class="inline-flex gap-1.5">
            <button type="button" class="btn btn-sm" @click="openCfEdit(asDef(row))">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" /> 編集
            </button>
            <button type="button" class="btn btn-sm btn-danger" @click="onCfRemove(asDef(row))">
              <X class="h-3.5 w-3.5" aria-hidden="true" /> 削除
            </button>
          </span>
        </template>
      </UiDataTable>
    </UiSectionCard>

    <UiModal :open="cfOpen" :title="`カスタム項目を${cfForm.id ? '編集' : '追加'}（${ITEM_ENTITY_LABELS[current] ?? current}）`" @close="cfOpen = false">
      <div class="grid gap-3">
        <UiFormField label="項目名" required>
          <input v-model="cfForm.label" class="input" type="text" placeholder="例）ギフト対応" aria-label="項目名">
        </UiFormField>
        <UiFormField label="キー" required hint="半角英数字（英字始まり）。custom.<キー> として保存されます">
          <input v-model="cfForm.key" class="input" type="text" placeholder="例）giftReady" :disabled="!!cfForm.id" aria-label="キー">
        </UiFormField>
        <UiFormField label="種別" required>
          <UiSelect v-model="cfForm.fieldType" :options="cfTypeOptions" aria-label="種別" />
        </UiFormField>
        <UiFormField v-if="cfNeedsOptions" label="選択肢" required hint="1 行に 1 つ">
          <textarea v-model="cfForm.optionsText" class="textarea" rows="4" placeholder="赤&#10;青&#10;緑" aria-label="選択肢" />
        </UiFormField>
        <label class="flex items-center gap-2 text-[13px] font-medium">
          <input v-model="cfForm.required" type="checkbox" class="h-4 w-4 accent-brand"> 入力必須にする
        </label>
        <p v-if="cfError" class="text-[12px] font-medium text-crit" role="alert">{{ cfError }}</p>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="cfOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="onCfSave">保存する</button>
      </template>
    </UiModal>
  </MastersMasterShell>
</template>
