<script setup lang="ts">
/**
 * 事業区分（Village）マスタ（管理者専用。改修依頼 2026-08-19 第4弾）。
 * 社内事業の区分を管理する最小マスタ（名称・表示順）。活動記録の最上段でコンボボックス参照され、
 * フォームの自由入力で新規登録もできる（この画面からも新規登録・編集できる = industries と同型）。
 */
import { Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { Village } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrudAsync('villages', 'vil')
const toast = useToast()
const confirm = useConfirm()

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as Village[])
    .filter((v) => {
      if (!matchesActiveFilter(v, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || v.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a.displayOrder - b.displayOrder),
)

const { page, pageSize, rows: pagedVillages, total } = useListView<Village>({ source: filtered })
watch([search, statusFilter], () => { page.value = 1 })

const tableRows = computed(() => pagedVillages.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'name', label: '事業区分名', primary: true },
  { key: 'displayOrder', label: '表示順', align: 'right', width: '90px', primary: true },
  { key: 'active', label: '状態', primary: true },
]

function asVillage(row: Record<string, unknown>): Village {
  return row as unknown as Village
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Village | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Village | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '事業区分を追加' : mode.value === 'edit' ? '事業区分を編集' : '事業区分詳細',
)

const formFields: FieldDef[] = [
  { key: 'name', label: '事業区分名', type: 'text', required: true, placeholder: '例）AKEBONO' },
  { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
]

const detailRows = computed(() => {
  const v = selected.value
  if (!v) return []
  return [
    { label: '事業区分名', value: v.name },
    { label: '表示順', value: String(v.displayOrder) },
    { label: '状態', value: v.active ? '有効' : '無効' },
  ]
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  const maxOrder = Math.max(0, ...(crud.list.value as Village[]).map(v => v.displayOrder))
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
  if (!String(form.value.name ?? '').trim()) e.name = '事業区分名は必須です'
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<Village> & { id?: string } = {
    name: String(form.value.name ?? '').trim(),
    displayOrder: Number(form.value.displayOrder ?? 1),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = await crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '事業区分を追加しました' : '事業区分を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '事業区分の無効化',
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
    title="事業区分（Village）マスタ"
    description="社内事業の区分を管理します。活動記録（サポート/営業/パートナー活動）の最上段で参照され、フォームの自由入力からも新規登録できます"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="事業区分名で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`事業区分一覧（${total}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する事業区分がありません"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asVillage(row).name }}</span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asVillage(row).active ? '有効' : '無効'" :tone="asVillage(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
      <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
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
