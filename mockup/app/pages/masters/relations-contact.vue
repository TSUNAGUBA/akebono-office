<script setup lang="ts">
/**
 * F-10-6 顧客関係(人)マスタ（管理者専用）
 * 人どうしの関係（上司部下・意思決定ライン・紹介など）: RelationGraph + エッジ一覧 + 追加フォーム。
 * 端点は顧客の担当者（contacts）に加えて自社メンバー（members）も選択できる
 * （オペレーター指示 2026-07-17。エッジの端点 id は contacts / members のどちらの id も保持可）。
 * 関係エッジ（ContactRelation）のみ物理削除可（UiConfirm 必須）。種別の定義は /masters/relation-types。
 */
import { Plus, Tags } from 'lucide-vue-next'
import type { Company, Contact, ContactRelation, Member, RelationType } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const companyCrud = useMasterCrudAsync('companies', 'c')
const contactCrud = useMasterCrudAsync('contacts', 'p')
const memberCrud = useMasterCrudAsync('members', 'm')
const rtCrud = useMasterCrudAsync('relationTypes', 'rt')
const prCrud = useMasterCrudAsync('contactRelations', 'pr')
const toast = useToast()
const confirm = useConfirm()

const DIRECTION_LABELS: Record<string, string> = { directed: '有向（From→To）', mutual: '相互' }

function companyName(id: string): string {
  return (companyCrud.byId(id) as Company | undefined)?.name ?? id
}

/** 端点のラベル（顧客担当者 = 名前（会社）/ 自社メンバー = 名前（自社）） */
function contactLabel(id: string): string {
  const c = contactCrud.byId(id) as Contact | undefined
  if (c) return `${c.name}（${companyName(c.companyId)}）`
  const m = memberCrud.byId(id) as Member | undefined
  return m ? `${m.name}（自社）` : id
}

function rtOf(id: string): RelationType | undefined {
  return rtCrud.byId(id) as RelationType | undefined
}

const selContact = ref<string | null>(null)

async function onSelectContact(id: string): Promise<void> {
  selContact.value = selContact.value === id ? null : id
}

const contactNodes = computed(() => [
  ...(contactCrud.activeList.value as Contact[]).map(c => ({ id: c.id, label: c.name })),
  ...(memberCrud.activeList.value as Member[]).map(m => ({ id: m.id, label: `${m.name}（自社）` })),
])

const contactGraphEdges = computed(() =>
  (prCrud.list.value as ContactRelation[]).map((r) => {
    const rt = rtOf(r.relationTypeId)
    return { id: r.id, from: r.fromContactId, to: r.toContactId, label: rt?.label ?? '関係', directed: rt?.direction !== 'mutual' }
  }),
)

const contactEdgeRows = computed(() =>
  (prCrud.list.value as ContactRelation[])
    .filter(r => !selContact.value || r.fromContactId === selContact.value || r.toContactId === selContact.value)
    .map(r => ({
      id: r.id,
      fromName: contactLabel(r.fromContactId),
      typeLabel: rtOf(r.relationTypeId)?.label ?? r.relationTypeId,
      direction: rtOf(r.relationTypeId)?.direction === 'mutual' ? '相互' : '→',
      toName: contactLabel(r.toContactId),
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

const contactOptions = computed(() => [
  ...(contactCrud.activeList.value as Contact[]).map(c => ({ value: c.id, label: contactLabel(c.id) })),
  ...(memberCrud.activeList.value as Member[]).map(m => ({ value: m.id, label: `${m.name}（自社）` })),
])

const contactRtOptions = computed(() =>
  (rtCrud.activeList.value as RelationType[])
    .filter(t => t.appliesTo === 'contact')
    .map(t => ({ value: t.id, label: `${t.label}（${DIRECTION_LABELS[t.direction]}）` })),
)

const prForm = ref({ from: '', typeId: '', to: '', notes: '' })
const prError = ref('')
// 追加フォームはドロワーへ分離（バッチ7h: 参照 = 基本ビュー・入力 = ボタン押下。マスタ標準と同型）
const addOpen = ref(false)

async function addContactRelation(): Promise<void> {
  const f = prForm.value
  if (!f.from || !f.typeId || !f.to) {
    prError.value = 'AKO-GEN-001: From・関係種別・To は必須です'
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  if (f.from === f.to) {
    prError.value = '同一人物どうしの関係は登録できません'
    toast.show('同一人物どうしの関係は登録できません', 'crit')
    return
  }
  prError.value = ''
  const payload: Partial<ContactRelation> = {
    fromContactId: f.from,
    toContactId: f.to,
    relationTypeId: f.typeId,
    notes: f.notes.trim(),
  }
  const res = await prCrud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('人どうしの関係を追加しました')
  prForm.value = { from: '', typeId: '', to: '', notes: '' }
  addOpen.value = false
}

async function deleteContactRelation(row: Record<string, unknown>): Promise<void> {
  const id = String(row.id)
  const ok = await confirm.ask(
    '関係の削除',
    `「${String(row.fromName)} → ${String(row.toName)}（${String(row.typeLabel)}）」を削除しますか？関係エッジのため物理削除され、復元できません。`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const res = await prCrud.remove(id)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('人どうしの関係を削除しました', 'warn')
}
</script>

<template>
  <MastersMasterShell
    title="顧客関係(人)マスタ"
    description="上司部下・意思決定ライン・紹介など、人どうしの関係を有向エッジで管理します（顧客の担当者に加えて自社メンバーも選択できます）。関係エッジのみ物理削除できます"
  >
    <UiSectionCard title="人どうしの関係" description="ノードをクリックすると、その人に関する関係だけに絞り込めます">
      <template #actions>
        <NuxtLink to="/masters/relation-types" class="btn btn-ghost btn-sm">
          <Tags class="h-3.5 w-3.5" aria-hidden="true" />
          関係種別マスタ
        </NuxtLink>
        <button type="button" class="btn btn-primary btn-sm" @click="addOpen = true">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          追加
        </button>
      </template>
      <WidgetsRelationGraph
        :nodes="contactNodes"
        :edges="contactGraphEdges"
        :selected-id="selContact"
        @select="onSelectContact"
      />

      <div v-if="selContact" class="mb-2 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-1.5 text-xs text-brand">
        <span class="font-semibold">{{ contactLabel(selContact) }}</span> に関する関係のみ表示中
        <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="selContact = null">絞り込み解除</button>
      </div>

      <UiDataTable
        :columns="edgeColumns"
        :rows="contactEdgeRows"
        empty-title="人どうしの関係がありません"
        empty-hint="右上の「追加」から登録できます"
      >
        <template #cell-fromName="{ row }">
          <span class="font-medium">{{ row.fromName }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button type="button" class="btn btn-danger btn-sm" @click="deleteContactRelation(row)">削除</button>
        </template>
      </UiDataTable>

    </UiSectionCard>

    <!-- 追加ドロワー（バッチ7h: 他マスタと同じ「一覧 = 基本ビュー・入力 = ドロワー」に統一） -->
    <template #drawer>
      <UiDrawer :open="addOpen" title="人どうしの関係を追加" @close="addOpen = false">
        <div class="grid gap-2">
          <UiFormField label="From" required>
            <UiSelect v-model="prForm.from" :options="contactOptions" empty-label="担当者を選択" aria-label="From 担当者" />
          </UiFormField>
          <UiFormField label="関係種別" required>
            <UiSelect v-model="prForm.typeId" :options="contactRtOptions" empty-label="種別を選択" aria-label="関係種別" />
          </UiFormField>
          <UiFormField label="To" required>
            <UiSelect v-model="prForm.to" :options="contactOptions" empty-label="担当者を選択" aria-label="To 担当者" />
          </UiFormField>
          <UiFormField label="メモ">
            <input v-model="prForm.notes" type="text" class="input" placeholder="関係の補足">
          </UiFormField>
          <p v-if="prError" class="text-[11px] font-medium text-crit" role="alert">{{ prError }}</p>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="addOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="addContactRelation">
            <Plus class="h-4 w-4" aria-hidden="true" />
            追加
          </button>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
