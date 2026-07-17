<script setup lang="ts">
/**
 * F-10-5 顧客関係(会社)マスタ（管理者専用）
 * 会社間関係: RelationGraph + エッジ一覧 + 追加フォーム。
 * 関係エッジ（CompanyRelation）のみ物理削除可（UiConfirm 必須）。種別の定義は /masters/relation-types。
 */
import { Plus, Tags } from 'lucide-vue-next'
import type { Company, CompanyRelation, RelationType } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const companyCrud = useMasterCrudAsync('companies', 'c')
const rtCrud = useMasterCrudAsync('relationTypes', 'rt')
const crCrud = useMasterCrudAsync('companyRelations', 'cr')
const toast = useToast()
const confirm = useConfirm()

const DIRECTION_LABELS: Record<string, string> = { directed: '有向（From→To）', mutual: '相互' }

function companyName(id: string): string {
  return (companyCrud.byId(id) as Company | undefined)?.name ?? id
}

function rtOf(id: string): RelationType | undefined {
  return rtCrud.byId(id) as RelationType | undefined
}

const selCompany = ref<string | null>(null)

async function onSelectCompany(id: string): Promise<void> {
  selCompany.value = selCompany.value === id ? null : id
}

const companyNodes = computed(() =>
  (companyCrud.activeList.value as Company[]).map(c => ({ id: c.id, label: c.name, kind: c.kind })),
)

const companyGraphEdges = computed(() =>
  (crCrud.list.value as CompanyRelation[]).map((r) => {
    const rt = rtOf(r.relationTypeId)
    return { id: r.id, from: r.fromCompanyId, to: r.toCompanyId, label: rt?.label ?? '関係', directed: rt?.direction !== 'mutual' }
  }),
)

const companyEdgeRows = computed(() =>
  (crCrud.list.value as CompanyRelation[])
    .filter(r => !selCompany.value || r.fromCompanyId === selCompany.value || r.toCompanyId === selCompany.value)
    .map(r => ({
      id: r.id,
      fromName: companyName(r.fromCompanyId),
      typeLabel: rtOf(r.relationTypeId)?.label ?? r.relationTypeId,
      direction: rtOf(r.relationTypeId)?.direction === 'mutual' ? '相互' : '→',
      toName: companyName(r.toCompanyId),
      notes: r.notes,
    })) as unknown as Record<string, unknown>[],
)

const edgeColumns: TableColumn[] = [
  { key: 'fromName', label: 'From', primary: true },
  { key: 'direction', label: '向き', align: 'center', width: '56px' },
  { key: 'toName', label: 'To', primary: true },
  { key: 'typeLabel', label: '関係種別', primary: true },
  { key: 'notes', label: 'メモ' },
  { key: 'actions', label: '操作', align: 'center', width: '80px', primary: true },
]

const companyOptions = computed(() =>
  (companyCrud.activeList.value as Company[]).map(c => ({
    value: c.id,
    label: c.kind === 'self' ? `${c.name}（自社）` : c.name,
  })),
)

const companyRtOptions = computed(() =>
  (rtCrud.activeList.value as RelationType[])
    .filter(t => t.appliesTo === 'company')
    .map(t => ({ value: t.id, label: `${t.label}（${DIRECTION_LABELS[t.direction]}）` })),
)

const crForm = ref({ from: '', typeId: '', to: '', notes: '' })
const crError = ref('')

async function addCompanyRelation(): Promise<void> {
  const f = crForm.value
  if (!f.from || !f.typeId || !f.to) {
    crError.value = 'AKO-GEN-001: From・関係種別・To は必須です'
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  if (f.from === f.to) {
    crError.value = '同一会社どうしの関係は登録できません'
    toast.show('同一会社どうしの関係は登録できません', 'crit')
    return
  }
  crError.value = ''
  const payload: Partial<CompanyRelation> = {
    fromCompanyId: f.from,
    toCompanyId: f.to,
    relationTypeId: f.typeId,
    notes: f.notes.trim(),
  }
  const res = await crCrud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('会社間の関係を追加しました')
  crForm.value = { from: '', typeId: '', to: '', notes: '' }
}

async function deleteCompanyRelation(row: Record<string, unknown>): Promise<void> {
  const id = String(row.id)
  const ok = await confirm.ask(
    '関係の削除',
    `「${String(row.fromName)} → ${String(row.toName)}（${String(row.typeLabel)}）」を削除しますか？関係エッジのため物理削除され、復元できません。`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const res = await crCrud.remove(id)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('会社間の関係を削除しました', 'warn')
}
</script>

<template>
  <MastersMasterShell
    title="顧客関係(会社)マスタ"
    description="会社間の関係を有向エッジで管理します。関係エッジのみ物理削除できます"
  >
    <UiSectionCard title="会社間の関係" description="ノードをクリックすると、その会社に関する関係だけに絞り込めます">
      <template #actions>
        <NuxtLink to="/masters/relation-types" class="btn btn-ghost btn-sm">
          <Tags class="h-3.5 w-3.5" aria-hidden="true" />
          関係種別マスタ
        </NuxtLink>
      </template>
      <WidgetsRelationGraph
        :nodes="companyNodes"
        :edges="companyGraphEdges"
        :selected-id="selCompany"
        @select="onSelectCompany"
      />

      <div v-if="selCompany" class="mb-2 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-1.5 text-xs text-brand">
        <span class="font-semibold">{{ companyName(selCompany) }}</span> に関する関係のみ表示中
        <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="selCompany = null">絞り込み解除</button>
      </div>

      <UiDataTable
        :columns="edgeColumns"
        :rows="companyEdgeRows"
        empty-title="会社間の関係がありません"
        empty-hint="下のフォームから追加できます"
      >
        <template #cell-fromName="{ row }">
          <span class="font-medium">{{ row.fromName }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button type="button" class="btn btn-danger btn-sm" @click="deleteCompanyRelation(row)">削除</button>
        </template>
      </UiDataTable>

      <div class="mt-3 border-t border-line pt-3">
        <p class="mb-2 text-[12px] font-bold text-sub">関係を追加</p>
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <UiFormField label="From" required>
            <UiSelect v-model="crForm.from" :options="companyOptions" empty-label="会社を選択" aria-label="From 会社" />
          </UiFormField>
          <UiFormField label="関係種別" required>
            <UiSelect v-model="crForm.typeId" :options="companyRtOptions" empty-label="種別を選択" aria-label="関係種別" />
          </UiFormField>
          <UiFormField label="To" required>
            <UiSelect v-model="crForm.to" :options="companyOptions" empty-label="会社を選択" aria-label="To 会社" />
          </UiFormField>
          <UiFormField label="メモ">
            <input v-model="crForm.notes" type="text" class="input" placeholder="関係の補足">
          </UiFormField>
          <div class="flex items-end">
            <button type="button" class="btn btn-primary w-full lg:w-auto" @click="addCompanyRelation">
              <Plus class="h-4 w-4" aria-hidden="true" />
              追加
            </button>
          </div>
        </div>
        <p v-if="crError" class="mt-1 text-[11px] font-medium text-crit" role="alert">{{ crError }}</p>
      </div>
    </UiSectionCard>
  </MastersMasterShell>
</template>
