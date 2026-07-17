<script setup lang="ts">
/**
 * F-10-10 休暇種別マスタ（管理者専用）
 * 有給以外の特別休暇（夏季休暇・結婚特休等）は会社ごとに異なるためマスタで管理する。
 * 付与方式（周期自動/手動）・使用期限（付与からの月数）を設定。付与の実行は
 * 勤怠管理 > 休暇管理（F-04-9。管理者/人事のみ）で行う。
 */
import { Plus } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { LeaveType } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrud('leaveTypes', 'lt')
const toast = useToast()
const confirm = useConfirm()

const GRANT_METHOD_LABELS: Record<LeaveType['grantMethod'], string> = {
  periodic: '周期自動付与',
  manual: '手動付与（個別・一括）',
}

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as LeaveType[])
    .filter((t) => {
      if (!matchesActiveFilter(t, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || t.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a.displayOrder - b.displayOrder),
)

const tableRows = computed(() =>
  filtered.value.map(t => ({
    ...t,
    grantMethodLabel: GRANT_METHOD_LABELS[t.grantMethod],
    expiryLabel: t.expiryMonths == null ? '期限なし' : `${t.expiryMonths} ヶ月`,
  })) as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'name', label: '休暇名', primary: true },
  { key: 'grantMethodLabel', label: '付与方式', primary: true },
  { key: 'expiryLabel', label: '使用期限', align: 'right' },
  { key: 'displayOrder', label: '表示順', align: 'right', width: '80px' },
  { key: 'active', label: '状態', primary: true },
]

function asType(row: Record<string, unknown>): LeaveType {
  return row as unknown as LeaveType
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<LeaveType | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as LeaveType | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '休暇種別を追加' : mode.value === 'edit' ? '休暇種別を編集' : '休暇種別詳細',
)

/** 有効期限は「期限なし」を空文字で表すフォーム用センチネル（保存時に null へ変換） */
const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '休暇名', type: 'text', required: true, placeholder: '例）夏季休暇' },
  {
    key: 'grantMethod', label: '付与方式', type: 'select', required: true,
    options: Object.entries(GRANT_METHOD_LABELS).map(([value, label]) => ({ value, label })),
    hint: '周期自動付与は有給のように定期的に自動付与。手動付与は権限者（管理者/人事）が任意のタイミングで個別・一括付与',
  },
  {
    key: 'expiryMonths', label: '使用期限（付与からの月数）', type: 'number', min: 1, max: 120, step: 1,
    hint: '空欄 = 期限なし。有給は労基法の時効 2 年（24 ヶ月）',
  },
  { key: 'description', label: '説明', type: 'text', placeholder: '付与の条件・運用ルールを一言で' },
  { key: 'displayOrder', label: '表示順', type: 'number', min: 1, step: 1 },
])

const detailRows = computed(() => {
  const t = selected.value
  if (!t) return []
  return [
    { label: '休暇名', value: t.name },
    { label: '付与方式', value: GRANT_METHOD_LABELS[t.grantMethod] },
    { label: '使用期限', value: t.expiryMonths == null ? '期限なし' : `付与から ${t.expiryMonths} ヶ月` },
    { label: '法定有給', value: t.isStatutory ? '対象（残数上限 40 日・年 5 日義務）' : '対象外' },
    { label: '説明', value: t.description || '—' },
    { label: '表示順', value: String(t.displayOrder) },
    { label: '状態', value: t.active ? '有効' : '無効' },
  ]
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  const maxOrder = Math.max(0, ...(crud.list.value as LeaveType[]).map(t => t.displayOrder))
  form.value = { name: '', grantMethod: 'manual', expiryMonths: 12, description: '', displayOrder: maxOrder + 1 }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  if (selected.value.isStatutory) {
    toast.show('AKO-LEV-008: 法定有給の設定（付与テーブル・時効）は労基法準拠のため編集できません', 'warn')
    return
  }
  form.value = {
    ...JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>,
    expiryMonths: selected.value.expiryMonths ?? '',
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
  if (!String(form.value.name ?? '').trim()) e.name = '休暇名は必須です'
  const expiryRaw = form.value.expiryMonths
  const expiryMonths = expiryRaw === '' || expiryRaw == null ? null : Number(expiryRaw)
  if (expiryMonths !== null && (!Number.isFinite(expiryMonths) || expiryMonths < 1)) {
    e.expiryMonths = '使用期限は 1 ヶ月以上で入力してください（空欄 = 期限なし）'
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を確認してください', 'crit')
    return
  }
  const payload: Partial<LeaveType> & { id?: string } = {
    name: String(form.value.name ?? '').trim(),
    grantMethod: form.value.grantMethod as LeaveType['grantMethod'],
    expiryMonths,
    description: String(form.value.description ?? ''),
    displayOrder: Number(form.value.displayOrder ?? 1),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  else payload.isStatutory = false // 新設種別は常に特別休暇（法定有給はシード固定）
  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '休暇種別を追加しました' : '休暇種別を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  if (selected.value.isStatutory) {
    toast.show('AKO-LEV-008: 法定有給は無効化できません', 'crit')
    return
  }
  const ok = await confirm.ask(
    '休暇種別の無効化',
    `「${selected.value.name}」を無効化しますか？（付与済みの残数はそのまま。新規の付与・申請ができなくなります）`,
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
  <MastersMasterShell
    title="休暇種別マスタ"
    description="有給休暇と特別休暇（夏季休暇・結婚特休等）の種別・付与方式・使用期限を管理します。付与の実行は 勤怠管理 > 休暇管理（管理者/人事）から"
  >
    <template #actions>
      <NuxtLink to="/attendance?tab=leave-admin" class="btn btn-sm">休暇管理（付与の実行）へ</NuxtLink>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="休暇名で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`休暇種別一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する休暇種別がありません"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ asType(row).name }}</span>
          <UiStatusBadge v-if="asType(row).isStatutory" label="法定" tone="brand" class="ml-1.5" />
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asType(row).active ? '有効' : '無効'" :tone="asType(row).active ? 'ok' : 'neutral'" dot />
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
