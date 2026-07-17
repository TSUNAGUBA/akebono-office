<script setup lang="ts">
/**
 * F-10-5 関係種別マスタ（管理者専用）
 * 納品先・競合・上司部下など、顧客関係(会社)/(人) で使う関係の種類を定義する。
 * 登録・編集・無効化/復元に加え、未使用（関係エッジから参照されていない）種別のみ物理削除可。
 * 使用中の種別の削除はサーバーが AKO-RTM-001 で拒否する（モックモードは画面前チェックで同一挙動）。
 */
import { Plus } from 'lucide-vue-next'
import type { CompanyRelation, ContactRelation, RelationType } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const rtCrud = useMasterCrudAsync('relationTypes', 'rt')
const crCrud = useMasterCrudAsync('companyRelations', 'cr')
const prCrud = useMasterCrudAsync('contactRelations', 'pr')
const toast = useToast()
const confirm = useConfirm()

const DIRECTION_LABELS: Record<string, string> = { directed: '有向（From→To）', mutual: '相互' }
const APPLIES_TO_LABELS: Record<string, string> = { company: '会社間', contact: '人どうし' }

/** 種別を参照している関係エッジ数（削除可否の判定・表示） */
function usageCount(rtId: string): number {
  return (crCrud.list.value as CompanyRelation[]).filter(r => r.relationTypeId === rtId).length
    + (prCrud.list.value as ContactRelation[]).filter(r => r.relationTypeId === rtId).length
}

const rtColumns: TableColumn[] = [
  { key: 'label', label: '名称', primary: true },
  { key: 'direction', label: '方向', primary: true },
  { key: 'appliesTo', label: '適用対象' },
  { key: 'usage', label: '使用中', align: 'right', width: '72px' },
  { key: 'active', label: '状態', primary: true },
]

const rtRows = computed(() =>
  (rtCrud.list.value as RelationType[]).map(t => ({
    ...t,
    usage: usageCount(t.id),
  })) as unknown as Record<string, unknown>[])

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
    hint: '会社間 = 顧客関係(会社) / 人どうし = 顧客関係(人) の選択肢に表示されます',
  },
]

async function openRtCreate(): Promise<void> {
  rtEditingId.value = null
  rtForm.value = { label: '', direction: 'directed', appliesTo: 'company' }
  rtErrors.value = {}
  rtModalOpen.value = true
}

async function openRtEdit(row: Record<string, unknown>): Promise<void> {
  rtEditingId.value = String(row.id)
  const t = rtCrud.byId(rtEditingId.value)
  rtForm.value = t ? (JSON.parse(JSON.stringify(t)) as Record<string, unknown>) : {}
  rtErrors.value = {}
  rtModalOpen.value = true
}

async function saveRt(): Promise<void> {
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
  const res = await rtCrud.save(payload)
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
  const res = await rtCrud.archive(rtEditing.value.id)
  if (res.ok) {
    toast.show('無効化しました', 'warn')
    rtModalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

async function restoreRt(): Promise<void> {
  if (!rtEditing.value) return
  const res = await rtCrud.restore(rtEditing.value.id)
  if (res.ok) {
    toast.show('復元しました')
    rtModalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

/** 物理削除（未使用の種別のみ。使用中はサーバーが AKO-RTM-001 で拒否） */
async function deleteRt(): Promise<void> {
  const t = rtEditing.value
  if (!t) return
  const used = usageCount(t.id)
  if (used > 0) {
    toast.show(`AKO-RTM-001: この関係種別は ${used} 件の関係で使用中のため削除できません（無効化を使用してください）`, 'crit')
    return
  }
  const ok = await confirm.ask(
    '関係種別の削除',
    `「${t.label}」を削除しますか？物理削除され、復元できません（どの関係からも使用されていない種別のみ削除できます）。`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const res = await rtCrud.remove(t.id)
  if (res.ok) {
    toast.show('関係種別を削除しました', 'warn')
    rtModalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}
</script>

<template>
  <MastersMasterShell
    title="関係種別マスタ"
    description="顧客関係(会社)・顧客関係(人) で使う関係の種類（納品先・競合・上司部下など）を定義します。未使用の種別のみ削除できます"
  >
    <UiSectionCard title="関係種別" description="ID は自動採番。適用対象で表示されるページが決まります" flush>
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
        empty-hint="「種別を追加」から登録できます"
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
        <template #cell-usage="{ row }">
          <span class="num">{{ row.usage }} 件</span>
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
            <div class="mr-auto flex items-center gap-1.5">
              <button v-if="rtEditing.active" type="button" class="btn btn-danger btn-sm" @click="archiveRt">無効化</button>
              <button v-else type="button" class="btn btn-sm" @click="restoreRt">復元</button>
              <button type="button" class="btn btn-danger btn-sm" :disabled="usageCount(rtEditing.id) > 0" @click="deleteRt">削除</button>
            </div>
          </template>
          <button type="button" class="btn" @click="rtModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveRt">保存</button>
        </template>
      </UiModal>
    </template>
  </MastersMasterShell>
</template>
