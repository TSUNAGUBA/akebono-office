<script setup lang="ts">
/**
 * F-10-6 顧客関係マスタ（管理者専用）
 * (a) 会社間関係: RelationGraph + エッジ一覧 + 追加フォーム
 * (b) 人どうしの関係: 同様（contacts）
 * (c) 関係種別マスタ: relationTypes の CRUD
 * 関係エッジ（CompanyRelation/ContactRelation）のみ物理削除可（UiConfirm 必須）。
 */
import { Plus } from 'lucide-vue-next'
import type { Company, CompanyRelation, Contact, ContactRelation, RelationType } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const companyCrud = useMasterCrud('companies', 'c')
const contactCrud = useMasterCrud('contacts', 'p')
const rtCrud = useMasterCrud('relationTypes', 'rt')
const crCrud = useMasterCrud('companyRelations', 'cr')
const prCrud = useMasterCrud('contactRelations', 'pr')
const { tbl, commit, nextId } = useMockDb()
const { currentUser } = useCurrentUser()
const toast = useToast()
const confirm = useConfirm()

/** 画面固有の固定区分（labels.ts は共有ファイルのためページ内定義） */
const DIRECTION_LABELS: Record<string, string> = { directed: '有向（From→To）', mutual: '相互' }
const APPLIES_TO_LABELS: Record<string, string> = { company: '会社間', contact: '人どうし' }

// ---------- 参照ヘルパー ----------

function companyName(id: string): string {
  return (companyCrud.byId(id) as Company | undefined)?.name ?? id
}

function contactLabel(id: string): string {
  const c = contactCrud.byId(id) as Contact | undefined
  return c ? `${c.name}（${companyName(c.companyId)}）` : id
}

function rtOf(id: string): RelationType | undefined {
  return rtCrud.byId(id) as RelationType | undefined
}

/** エッジ削除の監査ログ（補助処理・非ブロッキング） */
function auditDelete(entity: string, entityId: string, detail: string): void {
  try {
    const logs = tbl('auditLogs')
    logs.value = [...logs.value, {
      id: nextId('auditLogs', 'aud'),
      actorId: currentUser.value.id,
      action: 'delete',
      entity,
      entityId,
      detail,
      at: nowJstIso(),
    }]
  } catch {
    // 監査ログ失敗は主フローを止めない
  }
}

// ========== (a) 会社間関係 ==========

const selCompany = ref<string | null>(null)

function onSelectCompany(id: string): void {
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

function addCompanyRelation(): void {
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
  const res = crCrud.save(payload)
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
  const rows = tbl('companyRelations')
  rows.value = rows.value.filter(r => r.id !== id)
  auditDelete('companyRelations', id, '会社間関係を削除')
  commit()
  toast.show('会社間の関係を削除しました', 'warn')
}

// ========== (b) 人どうしの関係 ==========

const selContact = ref<string | null>(null)

function onSelectContact(id: string): void {
  selContact.value = selContact.value === id ? null : id
}

const contactNodes = computed(() =>
  (contactCrud.activeList.value as Contact[]).map(c => ({ id: c.id, label: c.name })),
)

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

const contactOptions = computed(() =>
  (contactCrud.activeList.value as Contact[]).map(c => ({ value: c.id, label: contactLabel(c.id) })),
)

const contactRtOptions = computed(() =>
  (rtCrud.activeList.value as RelationType[])
    .filter(t => t.appliesTo === 'contact')
    .map(t => ({ value: t.id, label: `${t.label}（${DIRECTION_LABELS[t.direction]}）` })),
)

const prForm = ref({ from: '', typeId: '', to: '', notes: '' })
const prError = ref('')

function addContactRelation(): void {
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
  const res = prCrud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('人どうしの関係を追加しました')
  prForm.value = { from: '', typeId: '', to: '', notes: '' }
}

async function deleteContactRelation(row: Record<string, unknown>): Promise<void> {
  const id = String(row.id)
  const ok = await confirm.ask(
    '関係の削除',
    `「${String(row.fromName)} → ${String(row.toName)}（${String(row.typeLabel)}）」を削除しますか？関係エッジのため物理削除され、復元できません。`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const rows = tbl('contactRelations')
  rows.value = rows.value.filter(r => r.id !== id)
  auditDelete('contactRelations', id, '人どうしの関係を削除')
  commit()
  toast.show('人どうしの関係を削除しました', 'warn')
}

// ========== (c) 関係種別マスタ ==========

const rtColumns: TableColumn[] = [
  { key: 'label', label: '名称', primary: true },
  { key: 'direction', label: '方向', primary: true },
  { key: 'appliesTo', label: '適用対象' },
  { key: 'active', label: '状態', primary: true },
]

const rtRows = computed(() => rtCrud.list.value as unknown as Record<string, unknown>[])

function asRt(row: Record<string, unknown>): RelationType {
  return row as unknown as RelationType
}

const rtModalOpen = ref(false)
const rtEditingId = ref<string | null>(null)
const rtEditing = computed<RelationType | null>(() =>
  rtEditingId.value ? ((rtCrud.byId(rtEditingId.value) as RelationType | undefined) ?? null) : null,
)
const rtForm = ref<Record<string, unknown>>({})
const rtErrors = ref<Record<string, string>>({})

const rtFormFields: FieldDef[] = [
  { key: 'label', label: '名称', type: 'text', required: true, placeholder: '例）納品先' },
  {
    key: 'direction', label: '方向', type: 'select', required: true,
    options: Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ value, label })),
    hint: '有向は From→To の向きを持ちます（例: 納品先）。相互は向きなし（例: 競合）',
  },
  {
    key: 'appliesTo', label: '適用対象', type: 'select', required: true,
    options: Object.entries(APPLIES_TO_LABELS).map(([value, label]) => ({ value, label })),
  },
]

function openRtCreate(): void {
  rtEditingId.value = null
  rtForm.value = { label: '', direction: 'directed', appliesTo: 'company' }
  rtErrors.value = {}
  rtModalOpen.value = true
}

function openRtEdit(row: Record<string, unknown>): void {
  rtEditingId.value = String(row.id)
  rtForm.value = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
  rtErrors.value = {}
  rtModalOpen.value = true
}

function saveRt(): void {
  const e: Record<string, string> = {}
  if (!String(rtForm.value.label ?? '').trim()) e.label = '名称は必須です'
  rtErrors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  const payload: Partial<RelationType> & { id?: string } = {
    label: String(rtForm.value.label ?? '').trim(),
    direction: rtForm.value.direction as RelationType['direction'],
    appliesTo: rtForm.value.appliesTo as RelationType['appliesTo'],
  }
  if (rtEditingId.value) payload.id = rtEditingId.value
  const res = rtCrud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(rtEditingId.value ? '関係種別を更新しました' : '関係種別を追加しました')
  rtModalOpen.value = false
}

async function archiveRt(): Promise<void> {
  if (!rtEditing.value) return
  const ok = await confirm.ask(
    '関係種別の無効化',
    `「${rtEditing.value.label}」を無効化しますか？既存の関係エッジは残ります（新規追加の選択肢から外れます）。`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = rtCrud.archive(rtEditing.value.id)
  if (res.ok) {
    toast.show('無効化しました', 'warn')
    rtModalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

function restoreRt(): void {
  if (!rtEditing.value) return
  const res = rtCrud.restore(rtEditing.value.id)
  if (res.ok) {
    toast.show('復元しました')
    rtModalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}
</script>

<template>
  <MastersMasterShell
    title="顧客関係マスタ"
    description="会社間・人どうしの関係を有向エッジで管理します。関係エッジのみ物理削除できます（マスタ本体は論理削除）"
  >
    <!-- (a) 会社間関係 -->
    <UiSectionCard title="会社間の関係" description="ノードをクリックすると、その会社に関する関係だけに絞り込めます">
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

    <!-- (b) 人どうしの関係 -->
    <UiSectionCard title="人どうしの関係" description="上司部下・意思決定ライン・紹介などの関係を管理します">
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
        empty-hint="下のフォームから追加できます"
      >
        <template #cell-fromName="{ row }">
          <span class="font-medium">{{ row.fromName }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button type="button" class="btn btn-danger btn-sm" @click="deleteContactRelation(row)">削除</button>
        </template>
      </UiDataTable>

      <div class="mt-3 border-t border-line pt-3">
        <p class="mb-2 text-[12px] font-bold text-sub">関係を追加</p>
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
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
          <div class="flex items-end">
            <button type="button" class="btn btn-primary w-full lg:w-auto" @click="addContactRelation">
              <Plus class="h-4 w-4" aria-hidden="true" />
              追加
            </button>
          </div>
        </div>
        <p v-if="prError" class="mt-1 text-[11px] font-medium text-crit" role="alert">{{ prError }}</p>
      </div>
    </UiSectionCard>

    <!-- (c) 関係種別マスタ -->
    <UiSectionCard title="関係種別マスタ" description="納品先・競合・上司部下など、関係の種類を定義します（ID は自動採番）" flush>
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openRtCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          種別を追加
        </button>
      </template>
      <UiDataTable
        :columns="rtColumns"
        :rows="rtRows"
        clickable
        empty-title="関係種別がありません"
        @row-click="openRtEdit"
      >
        <template #cell-label="{ row }">
          <span class="font-medium">{{ asRt(row).label }}</span>
        </template>
        <template #cell-direction="{ row }">
          {{ DIRECTION_LABELS[asRt(row).direction] ?? asRt(row).direction }}
        </template>
        <template #cell-appliesTo="{ row }">
          {{ APPLIES_TO_LABELS[asRt(row).appliesTo] ?? asRt(row).appliesTo }}
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asRt(row).active ? '有効' : '無効'" :tone="asRt(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiModal
        :open="rtModalOpen"
        :title="rtEditingId ? '関係種別を編集' : '関係種別を追加'"
        @close="rtModalOpen = false"
      >
        <UiSchemaForm v-model="rtForm" :fields="rtFormFields" :errors="rtErrors" />
        <template #footer>
          <template v-if="rtEditing">
            <button v-if="rtEditing.active" type="button" class="btn btn-danger btn-sm mr-auto" @click="archiveRt">無効化</button>
            <button v-else type="button" class="btn btn-sm mr-auto" @click="restoreRt">復元</button>
          </template>
          <button type="button" class="btn" @click="rtModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveRt">保存</button>
        </template>
      </UiModal>
    </template>
  </MastersMasterShell>
</template>
