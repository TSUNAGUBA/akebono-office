<script setup lang="ts">
/**
 * 業務種別マスタ（管理者専用。バッチ7c・オペレーター指示 2026-07-19 #4）
 * ぽいぽいポスト・議事録の任意分類。シンプルな一覧 + 追加/編集（名称・表示順）。
 */
import { Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { WorkCategory } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrudAsync('workCategories', 'wc')
const toast = useToast()
const confirm = useConfirm()

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as WorkCategory[])
    .filter((i) => {
      if (!matchesActiveFilter(i, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || i.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a.displayOrder - b.displayOrder),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'name', label: '業務種別名', primary: true },
  { key: 'displayOrder', label: '表示順', align: 'right', width: '90px', primary: true },
  { key: 'active', label: '状態', primary: true },
]

function asWorkCategory(row: Record<string, unknown>): WorkCategory {
  return row as unknown as WorkCategory
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<WorkCategory | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as WorkCategory | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '業務種別を追加' : mode.value === 'edit' ? '業務種別を編集' : '業務種別詳細',
)

const formFields: FieldDef[] = [
  {
    key: 'name', label: '業務種別名', type: 'text', required: true, placeholder: '例）定例会議',
    hint: 'ぽいぽいポスト・議事録の分類に使います（例: 定例会議・顧客対応）',
  },
  { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
]

const detailRows = computed(() => {
  const i = selected.value
  if (!i) return []
  return [
    { label: '業務種別名', value: i.name },
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
  const maxOrder = Math.max(0, ...(crud.list.value as WorkCategory[]).map(i => i.displayOrder))
  form.value = { name: '', displayOrder: maxOrder + 1 }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

async function openEdit(): Promise<void> {
  if (!selected.value) return
  form.value = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  errors.value = {}
  mode.value = 'edit'
}

async function cancelEdit(): Promise<void> {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '業務種別名は必須です'
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<WorkCategory> & { id?: string } = {
    name: String(form.value.name ?? '').trim(),
    displayOrder: Number(form.value.displayOrder ?? 1),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = await crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '業務種別を追加しました' : '業務種別を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '業務種別の無効化',
    `「${selected.value.name}」を無効化しますか？（論理削除。あとから復元できます）`,
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
    title="業務種別マスタ"
    description="ぽいぽいポスト・議事録の任意分類を管理します。名称と表示順のみのシンプルなマスタです"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="業務種別名で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`業務種別一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する業務種別がありません"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asWorkCategory(row).name }}</span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asWorkCategory(row).active ? '有効' : '無効'" :tone="asWorkCategory(row).active ? 'ok' : 'neutral'" dot />
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
