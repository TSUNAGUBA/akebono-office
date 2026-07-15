<script setup lang="ts">
/**
 * F-10-1 メンバー管理（管理者専用）
 * 一覧（検索・有効/無効フィルタ）→ 詳細ドロワー → 追加/編集/無効化/復元。
 * カスタム項目 entity='member' をフォームに合成。
 */
import { Plus } from 'lucide-vue-next'
import {
  ACTIVE_FILTER_OPTIONS, fmtCustomValue, matchesActiveFilter,
} from '~/components/masters/MasterShell.vue'
import type { CustomValues, Member } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'
import { EMPLOYMENT_TYPE_LABELS } from '~/utils/labels'

const crud = useMasterCrud('members', 'm')
const { itemsOf } = useCodeMaster()
const { defsFor, formSchemaFor } = useCustomFields()
const toast = useToast()
const confirm = useConfirm()

/** 画面固有の固定区分（labels.ts は共有ファイルのためページ内定義） */
const ROLE_LABELS: Record<string, string> = { admin: '管理者', member: '一般' }

const EMPLOYMENT_TYPE_TONES: Record<string, 'brand' | 'info' | 'ok' | 'warn' | 'neutral'> = {
  director: 'brand',
  employee: 'info',
  contract: 'ok',
  parttime: 'warn',
  outsource: 'neutral',
}

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as Member[]).filter((m) => {
    if (!matchesActiveFilter(m, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    return [m.name, m.email, m.dept, m.title].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'name', label: '氏名', primary: true },
  { key: 'employmentType', label: '雇用区分', primary: true },
  { key: 'dept', label: '部門' },
  { key: 'title', label: '役職' },
  { key: 'weeklyHours', label: '週所定', align: 'right' },
  { key: 'punchRequired', label: '打刻対象', align: 'center' },
  { key: 'active', label: '状態', primary: true },
]

function asMember(row: Record<string, unknown>): Member {
  return row as unknown as Member
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Member | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Member | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? 'メンバーを追加' : mode.value === 'edit' ? 'メンバーを編集' : 'メンバー詳細',
)

const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '氏名', type: 'text', required: true, placeholder: '例）曙 太郎' },
  { key: 'email', label: 'メールアドレス', type: 'text', placeholder: 'user@tsunaguba.co.jp' },
  {
    key: 'employmentType', label: '雇用区分', type: 'select', required: true,
    options: Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
  },
  { key: 'dept', label: '部門', type: 'select', options: itemsOf('dept') },
  { key: 'title', label: '役職', type: 'select', options: itemsOf('title') },
  {
    key: 'role', label: 'ロール', type: 'select', required: true,
    options: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
    hint: '管理者はマスタ・設定・承認系の操作が可能',
  },
  { key: 'weeklyDays', label: '週所定日数', type: 'number', min: 1, max: 7, step: 1, hint: '有給の比例付与判定に使用' },
  { key: 'weeklyHours', label: '週所定時間', type: 'number', min: 1, max: 60, step: 0.5, hint: '有給の比例付与判定に使用' },
  { key: 'punchRequired', label: '打刻対象', type: 'boolean', hint: '打刻画面・勤怠集計の対象にする' },
  { key: 'hireDate', label: '入社日', type: 'date' },
  { key: 'birthDate', label: '生年月日', type: 'date' },
  ...formSchemaFor('member'),
])

const detailRows = computed(() => {
  const m = selected.value
  if (!m) return []
  const rows = [
    { label: '氏名', value: m.name },
    { label: 'メール', value: m.email || '—' },
    { label: '雇用区分', value: EMPLOYMENT_TYPE_LABELS[m.employmentType] ?? m.employmentType },
    { label: '部門', value: m.dept || '—' },
    { label: '役職', value: m.title || '—' },
    { label: 'ロール', value: ROLE_LABELS[m.role] ?? m.role },
    { label: '週所定', value: `${m.weeklyDays}日 / ${m.weeklyHours}h` },
    { label: '打刻対象', value: m.punchRequired ? '対象' : '対象外' },
    { label: '入社日', value: m.hireDate || '—' },
    { label: '生年月日', value: m.birthDate || '—' },
    { label: '状態', value: m.active ? '有効' : '無効' },
  ]
  for (const d of defsFor('member')) {
    rows.push({ label: `${d.label}（カスタム）`, value: fmtCustomValue(m.custom?.[d.key]) })
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
    name: '', email: '', employmentType: 'employee', dept: '', title: '', role: 'member',
    weeklyDays: 5, weeklyHours: 40, punchRequired: true, hireDate: '', birthDate: '', custom: {},
  }
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

function validate(): boolean {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '氏名は必須です'
  if (!String(form.value.employmentType ?? '')) e.employmentType = '雇用区分は必須です'
  if (!String(form.value.role ?? '')) e.role = 'ロールは必須です'
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of defsFor('member')) {
    const v = custom[d.key]
    if (d.required && (v == null || v === '' || (Array.isArray(v) && v.length === 0))) {
      e[`custom.${d.key}`] = `${d.label}は必須です`
    }
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return false
  }
  return true
}

function save(): void {
  if (!validate()) return
  const f = form.value
  const payload: Partial<Member> & { id?: string } = {
    name: String(f.name ?? '').trim(),
    email: String(f.email ?? '').trim(),
    employmentType: f.employmentType as Member['employmentType'],
    dept: String(f.dept ?? ''),
    title: String(f.title ?? ''),
    role: f.role as Member['role'],
    weeklyDays: Number(f.weeklyDays ?? 5),
    weeklyHours: Number(f.weeklyHours ?? 40),
    punchRequired: Boolean(f.punchRequired),
    hireDate: String(f.hireDate ?? ''),
    birthDate: String(f.birthDate ?? ''),
    custom: (f.custom ?? {}) as CustomValues,
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? 'メンバーを追加しました' : 'メンバーを更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    'メンバーの無効化',
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
  <MastersMasterShell title="メンバー管理" description="雇用区分・週所定（有給の比例付与に連動）・打刻対象・ロールを管理します">
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="氏名・メール・部門で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`メンバー一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当するメンバーがいません"
        empty-hint="検索条件・状態フィルタを見直してください"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="flex items-center gap-2">
            <UiAvatar :name="asMember(row).name" size="sm" />
            <span class="font-medium">{{ asMember(row).name }}</span>
          </span>
        </template>
        <template #cell-employmentType="{ row }">
          <UiStatusBadge
            :label="EMPLOYMENT_TYPE_LABELS[asMember(row).employmentType] ?? asMember(row).employmentType"
            :tone="EMPLOYMENT_TYPE_TONES[asMember(row).employmentType] ?? 'neutral'"
          />
        </template>
        <template #cell-weeklyHours="{ row }">
          <span class="num">{{ asMember(row).weeklyDays }}日/{{ asMember(row).weeklyHours }}h</span>
        </template>
        <template #cell-punchRequired="{ row }">
          {{ asMember(row).punchRequired ? '対象' : '対象外' }}
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asMember(row).active ? '有効' : '無効'" :tone="asMember(row).active ? 'ok' : 'neutral'" dot />
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
