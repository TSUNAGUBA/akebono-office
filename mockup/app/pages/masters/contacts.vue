<script setup lang="ts">
/**
 * F-10-5 顧客(人)マスタ（管理者専用）
 * 所属会社 JOIN 表示・キーパーソン度（1-3 の星表示）・連絡先・メモ。
 * カスタム項目 entity='contact' をフォームに合成。
 */
import { Plus } from 'lucide-vue-next'
import {
  ACTIVE_FILTER_OPTIONS, fmtCustomValue, matchesActiveFilter,
} from '~/components/masters/MasterShell.vue'
import type { Company, Contact, CustomValues } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrud('contacts', 'p')
const companyCrud = useMasterCrud('companies', 'c')
const { defsFor, formSchemaFor } = useCustomFields()
const toast = useToast()
const confirm = useConfirm()

/** キーパーソン度の表示（1-3 の星） */
const KEY_PERSON_OPTIONS = [
  { value: '3', label: '★★★ 最重要' },
  { value: '2', label: '★★ 重要' },
  { value: '1', label: '★ 通常' },
]

function stars(n: number): string {
  return '★'.repeat(Math.max(1, Math.min(3, n)))
}

function companyName(id: string): string {
  return (companyCrud.byId(id) as Company | undefined)?.name ?? id
}

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as Contact[]).filter((c) => {
    if (!matchesActiveFilter(c, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    return [c.name, companyName(c.companyId), c.dept, c.title, c.email].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() =>
  filtered.value.map(c => ({
    ...c,
    companyName: companyName(c.companyId),
  })) as unknown as Record<string, unknown>[],
)

const columns: TableColumn[] = [
  { key: 'name', label: '氏名', primary: true },
  { key: 'companyName', label: '所属会社', primary: true },
  { key: 'dept', label: '部署' },
  { key: 'title', label: '役職' },
  { key: 'keyPerson', label: 'キーパーソン', align: 'center', primary: true },
  { key: 'email', label: 'メール' },
  { key: 'active', label: '状態' },
]

function asContact(row: Record<string, unknown>): Contact & { companyName: string } {
  return row as unknown as Contact & { companyName: string }
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Contact | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as Contact | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? '顧客(人)を追加' : mode.value === 'edit' ? '顧客(人)を編集' : '顧客(人)詳細',
)

/** 所属会社の選択肢は顧客(会社)の有効データから */
const companyOptions = computed(() =>
  (companyCrud.activeList.value as Company[])
    .filter(c => c.kind === 'customer')
    .map(c => ({ value: c.id, label: c.name })),
)

const formFields = computed<FieldDef[]>(() => [
  { key: 'companyId', label: '所属会社', type: 'select', required: true, options: companyOptions.value },
  { key: 'name', label: '氏名', type: 'text', required: true },
  { key: 'dept', label: '部署', type: 'text' },
  { key: 'title', label: '役職', type: 'text' },
  {
    key: 'keyPerson', label: 'キーパーソン度', type: 'select', required: true,
    options: KEY_PERSON_OPTIONS, hint: '★ の数が多いほど重要（意思決定への影響度）',
  },
  { key: 'email', label: 'メール', type: 'text' },
  { key: 'phone', label: '電話', type: 'text' },
  { key: 'notes', label: 'メモ', type: 'textarea', placeholder: '人柄・刺さる話し方・注意点など' },
  ...formSchemaFor('contact'),
])

const detailRows = computed(() => {
  const c = selected.value
  if (!c) return []
  const rows = [
    { label: '氏名', value: c.name },
    { label: '所属会社', value: companyName(c.companyId) },
    { label: '部署', value: c.dept || '—' },
    { label: '役職', value: c.title || '—' },
    { label: 'キーパーソン', value: `${stars(c.keyPerson)}（${c.keyPerson}/3）` },
    { label: 'メール', value: c.email || '—' },
    { label: '電話', value: c.phone || '—' },
    { label: 'メモ', value: c.notes || '—' },
    { label: '状態', value: c.active ? '有効' : '無効' },
  ]
  for (const d of defsFor('contact')) {
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
    companyId: '', name: '', dept: '', title: '', keyPerson: '1',
    email: '', phone: '', notes: '', custom: {},
  }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  const clone = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  form.value = { ...clone, keyPerson: String(selected.value.keyPerson) }
  errors.value = {}
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

function save(): void {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '氏名は必須です'
  if (!String(form.value.companyId ?? '')) e.companyId = '所属会社は必須です'
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of defsFor('contact')) {
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

  const kp = Math.max(1, Math.min(3, Number(form.value.keyPerson ?? 1))) as 1 | 2 | 3
  const payload: Partial<Contact> & { id?: string } = {
    companyId: String(form.value.companyId),
    name: String(form.value.name ?? '').trim(),
    dept: String(form.value.dept ?? ''),
    title: String(form.value.title ?? ''),
    keyPerson: kp,
    email: String(form.value.email ?? '').trim(),
    phone: String(form.value.phone ?? '').trim(),
    notes: String(form.value.notes ?? ''),
    custom,
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value

  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '顧客(人)を追加しました' : '顧客(人)を更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '顧客(人)の無効化',
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
  <MastersMasterShell title="顧客(人)マスタ" description="所属会社・キーパーソン度（★1-3）・連絡先・メモを管理します">
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="氏名・会社名・部署で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`顧客(人)一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する顧客(人)がいません"
        empty-hint="検索条件・状態フィルタを見直してください"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="flex items-center gap-2">
            <UiAvatar :name="asContact(row).name" size="sm" />
            <span class="font-medium">{{ asContact(row).name }}</span>
          </span>
        </template>
        <template #cell-keyPerson="{ row }">
          <span class="text-warn" :aria-label="`キーパーソン度 ${asContact(row).keyPerson}/3`">
            {{ stars(asContact(row).keyPerson) }}
          </span>
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asContact(row).active ? '有効' : '無効'" :tone="asContact(row).active ? 'ok' : 'neutral'" dot />
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
