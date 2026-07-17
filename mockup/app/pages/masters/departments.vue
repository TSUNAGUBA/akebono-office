<script setup lang="ts">
/**
 * F-10-9 部署マスタ + 組織図（管理者専用）
 * - 部署の CRUD（名称・親部署・責任者・表示順。論理削除）
 * - 組織図ビュー: 階層ツリー + 所属メンバー（Member.departmentId が所属の SoT）
 * - 所属の変更はこの画面（配属操作）とメンバーマスタのどちらからでも可能（書込はどちらも members へ）
 */
import { Network, Plus, Table2 } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { Department, Member } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrud('departments', 'dp')
const membersCrud = useMasterCrud('members', 'm')
const departments = useDepartments()
const toast = useToast()
const confirm = useConfirm()

// ---------- 表示モード（組織図 / 一覧） ----------

const viewMode = ref<'chart' | 'list'>('chart')

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as Department[])
    .filter((d) => {
      if (!matchesActiveFilter(d, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || d.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a.displayOrder - b.displayOrder),
)

const tableRows = computed(() =>
  filtered.value.map(d => ({
    ...d,
    parentName: d.parentId ? departments.nameOf(d.parentId) : '—',
    managerName: memberName(d.managerId),
    memberCount: departments.membersOf(d.id).length,
  })) as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'name', label: '部署名', primary: true },
  { key: 'parentName', label: '親部署' },
  { key: 'managerName', label: '責任者', primary: true },
  { key: 'memberCount', label: '所属人数', align: 'right', width: '90px' },
  { key: 'displayOrder', label: '表示順', align: 'right', width: '80px' },
  { key: 'active', label: '状態', primary: true },
]

function asDept(row: Record<string, unknown>): Department {
  return row as unknown as Department
}

function memberName(id: string | null): string {
  if (!id) return '—'
  return (membersCrud.byId(id) as Member | undefined)?.name ?? '—'
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Department | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Department | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '部署を追加' : mode.value === 'edit' ? '部署を編集' : '部署詳細',
)

/** 指定部署の子孫 id 集合（親部署の選択肢から除外して循環を防ぐ） */
function descendantIds(rootId: string): Set<string> {
  const all = crud.list.value as Department[]
  const result = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const d of all) {
      if (d.parentId && result.has(d.parentId) && !result.has(d.id)) {
        result.add(d.id)
        grew = true
      }
    }
  }
  return result
}

const activeMembers = computed(() =>
  (membersCrud.activeList.value as Member[]).filter(m => m.active))

const formFields = computed<FieldDef[]>(() => {
  const excluded = selectedId.value && mode.value === 'edit' ? descendantIds(selectedId.value) : new Set<string>()
  return [
    { key: 'name', label: '部署名', type: 'text', required: true, placeholder: '例）コンサルティング部' },
    {
      key: 'parentId', label: '親部署', type: 'select',
      options: [
        { value: '', label: 'なし（トップレベル）' },
        ...departments.options.value.filter(o => !excluded.has(o.value)),
      ],
      hint: '自部署とその配下は選択できません（循環防止）',
    },
    {
      key: 'managerId', label: '責任者', type: 'select',
      options: [
        { value: '', label: '未設定' },
        ...activeMembers.value.map(m => ({ value: m.id, label: m.name })),
      ],
    },
    { key: 'description', label: '説明', type: 'text', placeholder: '部署の役割を一言で' },
    { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
  ]
})

const selectedMembers = computed(() =>
  selected.value ? departments.membersOf(selected.value.id) : [])

const detailRows = computed(() => {
  const d = selected.value
  if (!d) return []
  return [
    { label: '部署名', value: d.name },
    { label: '親部署', value: d.parentId ? departments.nameOf(d.parentId) : 'なし（トップレベル）' },
    { label: '責任者', value: memberName(d.managerId) },
    { label: '説明', value: d.description || '—' },
    { label: '表示順', value: String(d.displayOrder) },
    { label: '状態', value: d.active ? '有効' : '無効' },
  ]
})

function openDetail(deptId: string): void {
  selectedId.value = deptId
  mode.value = 'view'
  drawerOpen.value = true
}

function openDetailRow(row: Record<string, unknown>): void {
  openDetail(String(row.id))
}

function openCreate(): void {
  selectedId.value = null
  const maxOrder = Math.max(0, ...(crud.list.value as Department[]).map(d => d.displayOrder))
  form.value = { name: '', parentId: '', managerId: '', description: '', displayOrder: maxOrder + 1 }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  form.value = {
    ...JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>,
    parentId: selected.value.parentId ?? '',
    managerId: selected.value.managerId ?? '',
  }
  errors.value = {}
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

function save(): void {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '部署名は必須です'
  const parentId = String(form.value.parentId ?? '')
  if (parentId && mode.value === 'edit' && selectedId.value && descendantIds(selectedId.value).has(parentId)) {
    e.parentId = '自部署または配下の部署を親にはできません（循環防止）'
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を確認してください', 'crit')
    return
  }
  const payload: Partial<Department> & { id?: string } = {
    name: String(form.value.name ?? '').trim(),
    parentId: parentId || null,
    managerId: String(form.value.managerId ?? '') || null,
    description: String(form.value.description ?? ''),
    displayOrder: Number(form.value.displayOrder ?? 1),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '部署を追加しました' : '部署を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  if (selectedMembers.value.length > 0) {
    toast.show(`AKO-DEP-001: 所属メンバーが ${selectedMembers.value.length} 名います。先に配属を変更してください`, 'crit')
    return
  }
  if ((crud.activeList.value as Department[]).some(d => d.parentId === selected.value?.id)) {
    toast.show('AKO-DEP-002: 配下に有効な部署があります。先に親部署を変更してください', 'crit')
    return
  }
  const ok = await confirm.ask(
    '部署の無効化',
    `「${selected.value.name}」を無効化しますか？（論理削除。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = crud.archive(selected.value.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

function restoreSelected(): void {
  if (!selected.value) return
  const res = crud.restore(selected.value.id)
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 配属（メンバーの所属変更。SoT は Member.departmentId） ----------

const assignMemberId = ref('')

const assignableMembers = computed(() =>
  activeMembers.value.filter(m => m.departmentId !== selected.value?.id))

function assignMember(): void {
  if (!selected.value || !assignMemberId.value) return
  const m = membersCrud.byId(assignMemberId.value) as Member | undefined
  if (!m) return
  const from = departments.nameOf(m.departmentId)
  const res = membersCrud.save({ id: m.id, departmentId: selected.value.id })
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(`${m.name} さんを ${from} から ${selected.value.name} へ配属しました`)
  assignMemberId.value = ''
}
</script>

<template>
  <MastersMasterShell
    title="部署マスタ・組織図"
    description="部署の階層とメンバーの所属を管理します。所属の SoT はメンバーの部署設定（この画面の配属操作とメンバーマスタのどちらからでも変更可能）"
  >
    <template #actions>
      <div class="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1" role="group" aria-label="表示切替">
        <button
          type="button"
          class="btn btn-sm"
          :class="viewMode === 'chart' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="viewMode === 'chart'"
          @click="viewMode = 'chart'"
        >
          <Network class="h-3.5 w-3.5" aria-hidden="true" /> 組織図
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="viewMode === 'list' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="viewMode === 'list'"
          @click="viewMode = 'list'"
        >
          <Table2 class="h-3.5 w-3.5" aria-hidden="true" /> 一覧
        </button>
      </div>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template v-if="viewMode === 'list'" #filter>
      <UiSearchInput v-model="search" placeholder="部署名で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <!-- 組織図 -->
    <UiSectionCard
      v-if="viewMode === 'chart'"
      title="組織図"
      description="部署カードをクリックすると詳細・配属操作を開きます"
    >
      <UiEmptyState v-if="departments.tree.value.length === 0" icon="Network" title="有効な部署がありません" />
      <div v-else>
        <MastersDeptOrgNode
          v-for="node in departments.tree.value"
          :key="node.dept.id"
          :node="node"
          :depth="0"
          @select="openDetail"
        />
      </div>
    </UiSectionCard>

    <!-- 一覧 -->
    <UiSectionCard v-else :title="`部署一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する部署がありません"
        @row-click="openDetailRow"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asDept(row).name }}</span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asDept(row).active ? '有効' : '無効'" :tone="asDept(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" @close="drawerOpen = false">
        <template v-if="mode === 'view' && selected">
          <dl class="grid gap-2 text-[13px]">
            <div
              v-for="r in detailRows"
              :key="r.label"
              class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
            >
              <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
              <dd>{{ r.value }}</dd>
            </div>
          </dl>

          <!-- 所属メンバーと配属操作 -->
          <div class="mt-4">
            <p class="label">所属メンバー（{{ selectedMembers.length }}名）</p>
            <ul v-if="selectedMembers.length > 0" class="mt-1.5 grid gap-1.5">
              <li v-for="m in selectedMembers" :key="m.id" class="flex items-center gap-2 rounded-lg bg-surface-soft px-2 py-1.5">
                <UiAvatar :name="m.name" size="sm" />
                <span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{{ m.name }}</span>
                <span class="text-[11px] text-muted">{{ m.title }}</span>
                <UiStatusBadge v-if="m.id === selected.managerId" label="責任者" tone="brand" />
              </li>
            </ul>
            <p v-else class="mt-1.5 text-xs text-muted">直属メンバーはいません</p>

            <div v-if="selected.active" class="mt-3 grid gap-1.5">
              <p class="label">メンバーを配属する（他部署からの異動）</p>
              <div class="flex gap-1.5">
                <select v-model="assignMemberId" class="select min-w-0 flex-1" aria-label="配属するメンバー">
                  <option value="" disabled>メンバーを選択</option>
                  <option v-for="m in assignableMembers" :key="m.id" :value="m.id">
                    {{ m.name }}（現: {{ departments.nameOf(m.departmentId) }}）
                  </option>
                </select>
                <button type="button" class="btn btn-primary shrink-0" :disabled="!assignMemberId" @click="assignMember">配属</button>
              </div>
            </div>
          </div>
        </template>
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
