<script setup lang="ts">
/**
 * F-10-7 プロジェクトマスタ（管理者専用）
 * 顧客・種別・状態・優先度・担当・期間・予算・目的（AI 文脈供給用）を管理。
 * カスタム項目 entity='project' をフォームに合成。
 */
import { Plus } from 'lucide-vue-next'
import {
  ACTIVE_FILTER_OPTIONS, fmtCustomValue, matchesActiveFilter,
} from '~/components/masters/MasterShell.vue'
import type { Company, CustomValues, Project } from '~/types/domain'
import type { FieldDef, TableColumn, Tone } from '~/types/ui'
import { fmtYenCompact } from '~/utils/format'
import { PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS } from '~/utils/labels'

const crud = useMasterCrudAsync('projects', 'pj')
const companyCrud = useMasterCrudAsync('companies', 'c')
const memberCrud = useMasterCrudAsync('members', 'm')
const { defsFor, formSchemaFor } = useCustomFields()
const toast = useToast()
const confirm = useConfirm()

/** 画面固有の固定区分（labels.ts は共有ファイルのためページ内定義） */
const PRIORITY_LABELS: Record<string, string> = { high: '高', mid: '中', low: '低' }
const PRIORITY_TONES: Record<string, Tone> = { high: 'serious', mid: 'info', low: 'neutral' }
const PROJECT_STATUS_TONES: Record<string, Tone> = { planned: 'info', active: 'ok', onhold: 'warn', closed: 'neutral' }

function companyName(id: string): string {
  return (companyCrud.byId(id) as Company | undefined)?.name ?? id
}

function memberName(id: string): string {
  return memberCrud.byId(id)?.name ?? id
}

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as Project[]).filter((p) => {
    if (!matchesActiveFilter(p, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    return [p.name, companyName(p.companyId), memberName(p.ownerMemberId)].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() =>
  filtered.value.map(p => ({
    ...p,
    companyName: companyName(p.companyId),
    ownerName: memberName(p.ownerMemberId),
  })) as unknown as Record<string, unknown>[],
)

const columns: TableColumn[] = [
  { key: 'name', label: 'PJ 名', primary: true },
  { key: 'companyName', label: '顧客', primary: true },
  { key: 'type', label: '種別' },
  { key: 'status', label: '状態', primary: true },
  { key: 'priority', label: '優先度', align: 'center' },
  { key: 'ownerName', label: '担当' },
  { key: 'budget', label: '予算', align: 'right' },
]

function asProject(row: Record<string, unknown>): Project & { companyName: string; ownerName: string } {
  return row as unknown as Project & { companyName: string; ownerName: string }
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Project | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Project | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? 'プロジェクトを追加' : mode.value === 'edit' ? 'プロジェクトを編集' : 'プロジェクト詳細',
)

/** 顧客の選択肢（自社 PJ 用に自社も含む） */
const companyOptions = computed(() =>
  (companyCrud.activeList.value as Company[]).map(c => ({
    value: c.id,
    label: c.kind === 'self' ? `${c.name}（自社）` : c.name,
  })),
)

const memberOptions = computed(() =>
  memberCrud.activeList.value.map(m => ({ value: m.id, label: m.name })),
)

const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: 'PJ 名', type: 'text', required: true },
  { key: 'companyId', label: '顧客', type: 'select', required: true, options: companyOptions.value },
  {
    key: 'type', label: '種別', type: 'select', required: true,
    options: Object.entries(PROJECT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
  },
  {
    key: 'status', label: '状態', type: 'select', required: true,
    options: Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => ({ value, label })),
  },
  {
    key: 'priority', label: '優先度', type: 'select', required: true,
    options: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })),
  },
  { key: 'ownerMemberId', label: '担当（オーナー）', type: 'select', required: true, options: memberOptions.value },
  { key: 'memberIds', label: 'メンバー', type: 'multiselect', options: memberOptions.value },
  { key: 'startDate', label: '開始日', type: 'date' },
  { key: 'endDate', label: '終了日', type: 'date', hint: '未定（継続中）の場合は空のまま' },
  { key: 'budget', label: '予算（円）', type: 'number', min: 0, step: 100000 },
  {
    key: 'objective', label: '目的・説明', type: 'textarea',
    hint: 'AI の文脈供給に使用（AI 社員・チャットボットがこの記述を参照します）',
  },
  ...formSchemaFor('project'),
])

const detailRows = computed(() => {
  const p = selected.value
  if (!p) return []
  const rows = [
    { label: 'PJ 名', value: p.name },
    { label: '顧客', value: companyName(p.companyId) },
    { label: '種別', value: PROJECT_TYPE_LABELS[p.type] ?? p.type },
    { label: '状態', value: PROJECT_STATUS_LABELS[p.status] ?? p.status },
    { label: '優先度', value: PRIORITY_LABELS[p.priority] ?? p.priority },
    { label: '担当', value: memberName(p.ownerMemberId) },
    { label: 'メンバー', value: p.memberIds.length > 0 ? p.memberIds.map(memberName).join('、') : '—' },
    { label: '期間', value: `${p.startDate || '—'} 〜 ${p.endDate ?? '継続中'}` },
    { label: '予算', value: p.budget > 0 ? fmtYenCompact(p.budget) : '—' },
    { label: '目的・説明', value: p.objective || '—' },
    { label: '状態フラグ', value: p.active ? '有効' : '無効' },
  ]
  for (const d of defsFor('project')) {
    rows.push({ label: `${d.label}（カスタム）`, value: fmtCustomValue(p.custom?.[d.key]) })
  }
  return rows
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = {
    name: '', companyId: '', type: 'biz_consulting', status: 'planned', priority: 'mid',
    ownerMemberId: '', memberIds: [], startDate: '', endDate: '', budget: 0, objective: '', custom: {},
  }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

async function openEdit(): Promise<void> {
  if (!selected.value) return
  const clone = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  form.value = { ...clone, endDate: selected.value.endDate ?? '' }
  errors.value = {}
  mode.value = 'edit'
}

async function cancelEdit(): Promise<void> {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = 'PJ 名は必須です'
  if (!String(form.value.companyId ?? '')) e.companyId = '顧客は必須です'
  if (!String(form.value.ownerMemberId ?? '')) e.ownerMemberId = '担当は必須です'
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of defsFor('project')) {
    const v = custom[d.key]
    if (d.required && (v == null || v === '' || (Array.isArray(v) && v.length === 0))) {
      e[`custom.${d.key}`] = `${d.label}は必須です`
    }
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }

  const payload: Partial<Project> & { id?: string } = {
    name: String(form.value.name ?? '').trim(),
    companyId: String(form.value.companyId),
    type: form.value.type as Project['type'],
    status: form.value.status as Project['status'],
    priority: form.value.priority as Project['priority'],
    ownerMemberId: String(form.value.ownerMemberId),
    memberIds: (form.value.memberIds as string[] | undefined) ?? [],
    startDate: String(form.value.startDate ?? ''),
    endDate: String(form.value.endDate ?? '') || null,
    budget: Number(form.value.budget ?? 0),
    objective: String(form.value.objective ?? ''),
    custom,
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value

  const res = await crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? 'プロジェクトを追加しました' : 'プロジェクトを更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    'プロジェクトの無効化',
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
  <MastersMasterShell title="プロジェクトマスタ" description="顧客・種別・状態・優先度・担当・期間・予算・目的（AI の文脈供給に使用）を管理します">
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="PJ 名・顧客・担当で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`プロジェクト一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当するプロジェクトがありません"
        empty-hint="検索条件・状態フィルタを見直してください"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asProject(row).name }}</span>
        </template>
        <template #cell-type="{ row }">
          {{ PROJECT_TYPE_LABELS[asProject(row).type] ?? asProject(row).type }}
        </template>
        <template #cell-status="{ row }">
          <UiStatusBadge
            :label="PROJECT_STATUS_LABELS[asProject(row).status] ?? asProject(row).status"
            :tone="PROJECT_STATUS_TONES[asProject(row).status] ?? 'neutral'"
            dot
          />
        </template>
        <template #cell-priority="{ row }">
          <UiStatusBadge
            :label="PRIORITY_LABELS[asProject(row).priority] ?? asProject(row).priority"
            :tone="PRIORITY_TONES[asProject(row).priority] ?? 'neutral'"
          />
        </template>
        <template #cell-budget="{ row }">
          <span class="num">{{ asProject(row).budget > 0 ? fmtYenCompact(asProject(row).budget) : '—' }}</span>
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" width="520px" @close="drawerOpen = false">
        <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd class="whitespace-pre-wrap">{{ r.value }}</dd>
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
