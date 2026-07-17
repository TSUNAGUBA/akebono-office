<script setup lang="ts">
/**
 * 役職マスタ（管理者専用）
 * 実体は汎用区分マスタ（codeMaster）の category='title'。メンバー登録の役職選択肢はここを参照する。
 * メンバーは役職名（ラベル）を保持するため、役職名の変更は登録済みメンバーへ遡及しない
 * （必要時はメンバー編集で再選択する = 設計判断をヒントに明示）。
 */
import { Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { CodeMasterItem } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrudAsync('codeMaster', 'cm')
const toast = useToast()
const confirm = useConfirm()

const TITLE_CATEGORY = 'title'

// ---------- 一覧（category='title' のみ） ----------

const search = ref('')
const statusFilter = ref('active')

const titleItems = computed(() =>
  (crud.list.value as CodeMasterItem[]).filter(i => i.category === TITLE_CATEGORY))

const filtered = computed(() =>
  titleItems.value
    .filter((i) => {
      if (!matchesActiveFilter(i, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || i.label.toLowerCase().includes(q)
    })
    .sort((a, b) => a.displayOrder - b.displayOrder),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'label', label: '役職名', primary: true },
  { key: 'displayOrder', label: '表示順', align: 'right', width: '90px', primary: true },
  { key: 'active', label: '状態', primary: true },
]

function asItem(row: Record<string, unknown>): CodeMasterItem {
  return row as unknown as CodeMasterItem
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<CodeMasterItem | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as CodeMasterItem | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '役職を追加' : mode.value === 'edit' ? '役職を編集' : '役職詳細',
)

const formFields: FieldDef[] = [
  {
    key: 'label', label: '役職名', type: 'text', required: true, placeholder: '例）マネージャー',
    hint: '役職名を変更しても、登録済みメンバーの役職表示は変わりません（メンバー編集で再選択してください）',
  },
  { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
]

const detailRows = computed(() => {
  const i = selected.value
  if (!i) return []
  return [
    { label: '役職名', value: i.label },
    { label: '表示順', value: String(i.displayOrder) },
    { label: '状態', value: i.active ? '有効' : '無効' },
  ]
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  const maxOrder = Math.max(0, ...titleItems.value.map(i => i.displayOrder))
  form.value = { label: '', displayOrder: maxOrder + 1 }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  form.value = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  errors.value = {}
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  const e: Record<string, string> = {}
  if (!String(form.value.label ?? '').trim()) e.label = '役職名は必須です'
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<CodeMasterItem> & { id?: string } = {
    label: String(form.value.label ?? '').trim(),
    displayOrder: Number(form.value.displayOrder ?? 1),
  }
  if (mode.value === 'edit' && selectedId.value) {
    payload.id = selectedId.value
  } else {
    // 新規は category を固定し、code は内部キーとして自動採番（メンバーはラベルを保持するため画面に出さない）
    payload.category = TITLE_CATEGORY
    payload.code = `t-${Math.random().toString(36).slice(2, 8)}`
  }
  const res = await crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '役職を追加しました' : '役職を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '役職の無効化',
    `「${selected.value.label}」を無効化しますか？（メンバー登録の選択肢から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = await crud.archive(selected.value.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function restoreSelected(): Promise<void> {
  if (!selected.value) return
  const res = await crud.restore(selected.value.id)
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <MastersMasterShell
    title="役職マスタ"
    description="メンバー登録の役職選択肢を管理します（実体は汎用区分マスタの category = title）"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="役職名で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`役職一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="役職がまだありません"
        empty-hint="「新規追加」から役職を登録すると、メンバー登録の選択肢に表示されます"
        @row-click="openDetail"
      >
        <template #cell-label="{ row }">
          <span class="font-medium">{{ asItem(row).label }}</span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asItem(row).active ? '有効' : '無効'" :tone="asItem(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" @close="drawerOpen = false">
        <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd>{{ r.value }}</dd>
          </div>
        </dl>
        <UiSchemaForm v-else v-model="form" :fields="formFields" :errors="errors" />

        <template #footer>
          <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
            <button v-if="selected.active" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
            <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
            <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
          </div>
          <div v-else class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
            <button type="button" class="btn btn-primary" @click="save">保存</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
