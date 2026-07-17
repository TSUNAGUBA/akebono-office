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
import type { AttendanceRule, CustomValues, EmploymentType, Member } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'
import { EMPLOYMENT_TYPE_LABELS, MEMBER_ROLE_LABELS } from '~/utils/labels'

const crud = useMasterCrudAsync('members', 'm')
const rulesCrud = useMasterCrudAsync('attendanceRules', 'ar')
const { itemsOf } = useCodeMaster()
const { defsFor, formSchemaFor } = useCustomFields()
const departments = useDepartments()
const toast = useToast()
const confirm = useConfirm()

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
    return [m.name, m.email, departments.nameOf(m.departmentId), m.title].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() =>
  filtered.value.map(m => ({
    ...m,
    dept: departments.nameOf(m.departmentId), // 表示用（列キー dept）
  })) as unknown as Record<string, unknown>[])

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

// ---------- 勤務体系（勤怠ルール）の選択肢 ----------

/** 「既定を適用」を表すフォーム用センチネル（保存時に null へ変換） */
const DEFAULT_RULE_VALUE = '__default__'

/** 指定雇用区分で選択可能な有効ルール（appliesTo で絞り込み） */
function applicableRules(employmentType: string): AttendanceRule[] {
  return (rulesCrud.activeList.value as AttendanceRule[])
    .filter(r => r.appliesTo.includes(employmentType as EmploymentType))
}

/** 指定雇用区分の既定ルール名（defaultFor → appliesTo 先頭 の順で解決） */
function defaultRuleNameFor(employmentType: string): string {
  const rules = rulesCrud.activeList.value as AttendanceRule[]
  const def = rules.find(r => r.defaultFor.includes(employmentType as EmploymentType))
    ?? rules.find(r => r.appliesTo.includes(employmentType as EmploymentType))
  return def?.name ?? '未設定'
}

const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '氏名', type: 'text', required: true, placeholder: '例）曙 太郎' },
  { key: 'email', label: 'メールアドレス', type: 'text', placeholder: 'user@tsunaguba.co.jp' },
  {
    key: 'employmentType', label: '雇用区分', type: 'select', required: true,
    options: Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
  },
  {
    key: 'attendanceRuleId', label: '勤務体系（勤怠ルール）', type: 'select',
    options: [
      { value: DEFAULT_RULE_VALUE, label: `既定（${defaultRuleNameFor(String(form.value.employmentType ?? 'employee'))}）` },
      ...applicableRules(String(form.value.employmentType ?? 'employee'))
        .map(r => ({ value: r.id, label: r.name })),
    ],
    hint: '同一雇用区分でも固定時間・フレックス・時短等を個別に指定できます。「既定」は雇用区分の既定ルールを適用',
  },
  {
    key: 'departmentId', label: '部署', type: 'select', emptyLabel: '未所属',
    options: departments.options.value,
    hint: '未所属のまま登録できます。部署の追加・階層の変更は 部署マスタ（組織図）で行います',
  },
  {
    key: 'title', label: '役職', type: 'select', emptyLabel: '未設定',
    options: itemsOf('title'),
    hint: '選択肢は 役職マスタ（マスタメンテナンス > 役職）で管理します',
  },
  {
    key: 'role', label: 'ロール', type: 'select', required: true,
    options: Object.entries(MEMBER_ROLE_LABELS).map(([value, label]) => ({ value, label })),
    hint: '管理者はマスタ・設定・承認系の操作が可能。人事はタイムカード・休暇管理（付与含む）が可能',
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
    {
      label: '勤務体系',
      value: m.attendanceRuleId
        ? `${(rulesCrud.byId(m.attendanceRuleId) as AttendanceRule | undefined)?.name ?? m.attendanceRuleId}（個別指定）`
        : `既定（${defaultRuleNameFor(m.employmentType)}）`,
    },
    { label: '部署', value: departments.nameOf(m.departmentId) },
    { label: '役職', value: m.title || '—' },
    { label: 'ロール', value: MEMBER_ROLE_LABELS[m.role] ?? m.role },
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
    name: '', email: '', employmentType: 'employee', attendanceRuleId: DEFAULT_RULE_VALUE,
    departmentId: '', title: '', role: 'member',
    weeklyDays: 5, weeklyHours: 40, punchRequired: true, hireDate: '', birthDate: '', custom: {},
  }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  form.value = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  // null（既定適用）はフォーム上のセンチネル値へ変換（保存時に戻す）
  form.value.attendanceRuleId = selected.value.attendanceRuleId ?? DEFAULT_RULE_VALUE
  errors.value = {}
  mode.value = 'edit'
}

async function cancelEdit(): Promise<void> {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

function validate(): boolean {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '氏名は必須です'
  if (!String(form.value.employmentType ?? '')) e.employmentType = '雇用区分は必須です'
  const ruleId = String(form.value.attendanceRuleId ?? '')
  if (ruleId && ruleId !== DEFAULT_RULE_VALUE) {
    // 雇用区分を変更した後に、旧区分向けの勤務体系が残るのを防ぐ
    if (!applicableRules(String(form.value.employmentType ?? '')).some(r => r.id === ruleId)) {
      e.attendanceRuleId = 'この雇用区分では選択できない勤務体系です。「既定」に戻すか選択し直してください'
    }
  }
  if (!String(form.value.role ?? '')) e.role = 'ロールは必須です'
  // 部署は任意（未所属のまま登録できる。配属は部署マスタ or メンバー編集で）
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

async function save(): Promise<void> {
  if (!validate()) return
  const f = form.value
  const payload: Partial<Member> & { id?: string } = {
    name: String(f.name ?? '').trim(),
    email: String(f.email ?? '').trim(),
    employmentType: f.employmentType as Member['employmentType'],
    attendanceRuleId: f.attendanceRuleId && f.attendanceRuleId !== DEFAULT_RULE_VALUE
      ? String(f.attendanceRuleId)
      : null,
    departmentId: String(f.departmentId ?? ''),
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
  // 新規メンバーはカレンダー未連携から開始（連携は本人の擬似 OAuth 同意で行う）
  if (mode.value === 'create') payload.googleCalendarConnected = false
  const res = await crud.save(payload)
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
