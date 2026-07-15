<script setup lang="ts">
/**
 * F-10-4 顧客(会社)マスタ（管理者専用）
 * kind==='customer' のみ対象。業界（複数+主）・エイリアス・規模・担当を管理。
 * カスタム項目 entity='company' をフォームに合成。
 */
import { Plus } from 'lucide-vue-next'
import {
  ACTIVE_FILTER_OPTIONS, fmtCustomValue, matchesActiveFilter, splitAliases,
} from '~/components/masters/MasterShell.vue'
import type { Company, CustomValues } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrud('companies', 'c')
const industryCrud = useMasterCrud('industries', 'ind')
const memberCrud = useMasterCrud('members', 'm')
const { itemsOf } = useCodeMaster()
const { defsFor, formSchemaFor } = useCustomFields()
const toast = useToast()
const confirm = useConfirm()

// ---------- 参照ヘルパー ----------

function industryName(id: string | null): string {
  if (!id) return '—'
  return industryCrud.byId(id)?.name ?? id
}

function memberName(id: string | null): string {
  if (!id) return '—'
  return memberCrud.byId(id)?.name ?? id
}

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const customers = computed(() => (crud.list.value as Company[]).filter(c => c.kind === 'customer'))

const filtered = computed(() =>
  customers.value.filter((c) => {
    if (!matchesActiveFilter(c, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    return [c.name, ...c.aliases, c.location].some(v => v.toLowerCase().includes(q))
  }),
)

/** テーブル用行（ソート・表示用に JOIN 済み項目を付与） */
const tableRows = computed(() =>
  filtered.value.map(c => ({
    ...c,
    primaryIndustryName: industryName(c.primaryIndustryId),
    ownerName: memberName(c.ownerMemberId),
  })) as unknown as Record<string, unknown>[],
)

const columns: TableColumn[] = [
  { key: 'name', label: '会社名', primary: true },
  { key: 'primaryIndustryName', label: '業界', primary: true },
  { key: 'size', label: '規模' },
  { key: 'location', label: '所在地' },
  { key: 'ownerName', label: '担当' },
  { key: 'active', label: '状態', primary: true },
]

function asCompany(row: Record<string, unknown>): Company & { primaryIndustryName: string; ownerName: string } {
  return row as unknown as Company & { primaryIndustryName: string; ownerName: string }
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Company | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Company | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '顧客(会社)を追加' : mode.value === 'edit' ? '顧客(会社)を編集' : '顧客(会社)詳細',
)

const industryOptions = computed(() =>
  industryCrud.activeList.value
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map(i => ({ value: i.id, label: i.name })),
)

/** 主業界は選択済みの業界からのみ選べる */
const primaryOptions = computed(() => {
  const chosen = (form.value.industryIds as string[] | undefined) ?? []
  return industryOptions.value.filter(o => chosen.includes(o.value))
})

const memberOptions = computed(() =>
  memberCrud.activeList.value.map(m => ({ value: m.id, label: m.name })),
)

const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '会社名', type: 'text', required: true },
  {
    key: 'aliasesText', label: 'エイリアス（表記ゆれ）', type: 'text',
    placeholder: '例）アケボノ, akebono', hint: 'カンマ・読点区切り。2文字未満は除外されます',
  },
  { key: 'industryIds', label: '業界（複数可）', type: 'multiselect', options: industryOptions.value },
  {
    key: 'primaryIndustryId', label: '主業界', type: 'select', options: primaryOptions.value,
    hint: '選択済みの業界から 1 つ指定します',
  },
  { key: 'size', label: '規模', type: 'select', options: itemsOf('companySize') },
  { key: 'location', label: '所在地', type: 'text' },
  { key: 'description', label: '事業内容', type: 'textarea' },
  { key: 'ownerMemberId', label: '担当メンバー', type: 'select', options: memberOptions.value },
  ...formSchemaFor('company'),
])

const detailRows = computed(() => {
  const c = selected.value
  if (!c) return []
  const rows = [
    { label: '会社名', value: c.name },
    { label: 'エイリアス', value: c.aliases.length > 0 ? c.aliases.join('、') : '—' },
    { label: '業界', value: c.industryIds.length > 0 ? c.industryIds.map(industryName).join('、') : '—' },
    { label: '主業界', value: industryName(c.primaryIndustryId) },
    { label: '規模', value: c.size || '—' },
    { label: '所在地', value: c.location || '—' },
    { label: '事業内容', value: c.description || '—' },
    { label: '担当', value: memberName(c.ownerMemberId) },
    { label: '状態', value: c.active ? '有効' : '無効' },
  ]
  for (const d of defsFor('company')) {
    rows.push({ label: `${d.label}（カスタム）`, value: fmtCustomValue(c.custom?.[d.key]) })
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
    name: '', aliasesText: '', industryIds: [], primaryIndustryId: '', size: '',
    location: '', description: '', ownerMemberId: '', custom: {},
  }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  const s = selected.value
  const clone = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
  form.value = {
    ...clone,
    aliasesText: s.aliases.join(', '),
    primaryIndustryId: s.primaryIndustryId ?? '',
    ownerMemberId: s.ownerMemberId ?? '',
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
  if (!String(form.value.name ?? '').trim()) e.name = '会社名は必須です'
  const industryIds = (form.value.industryIds as string[] | undefined) ?? []
  const primary = String(form.value.primaryIndustryId ?? '')
  if (primary && !industryIds.includes(primary)) {
    e.primaryIndustryId = '主業界は選択済みの業界リストに含まれている必要があります'
  }
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of defsFor('company')) {
    const v = custom[d.key]
    if (d.required && (v == null || v === '' || (Array.isArray(v) && v.length === 0))) {
      e[`custom.${d.key}`] = `${d.label}は必須です`
    }
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 入力内容を確認してください', 'crit')
    return
  }

  const payload: Partial<Company> & { id?: string } = {
    kind: 'customer',
    name: String(form.value.name ?? '').trim(),
    aliases: splitAliases(String(form.value.aliasesText ?? '')),
    industryIds,
    primaryIndustryId: primary || null,
    size: String(form.value.size ?? ''),
    location: String(form.value.location ?? ''),
    description: String(form.value.description ?? ''),
    ownerMemberId: String(form.value.ownerMemberId ?? '') || null,
    fiscalStartMonth: null,
    custom,
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value

  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '顧客(会社)を追加しました' : '顧客(会社)を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '顧客(会社)の無効化',
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
</script>

<template>
  <MastersMasterShell title="顧客(会社)マスタ" description="業界（複数+主業界）・エイリアス（表記ゆれ照合）・規模・担当メンバーを管理します">
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="会社名・エイリアスで検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`顧客(会社)一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する顧客(会社)がありません"
        empty-hint="検索条件・状態フィルタを見直してください"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asCompany(row).name }}</span>
          <span v-if="asCompany(row).aliases.length > 0" class="ml-1.5 text-[11px] text-muted">
            {{ asCompany(row).aliases.join('・') }}
          </span>
        </template>
        <template #cell-primaryIndustryName="{ row }">
          {{ asCompany(row).primaryIndustryName }}
          <span v-if="asCompany(row).industryIds.length > 1" class="ml-1 text-[11px] text-muted">
            +{{ asCompany(row).industryIds.length - 1 }}
          </span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asCompany(row).active ? '有効' : '無効'" :tone="asCompany(row).active ? 'ok' : 'neutral'" dot />
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
