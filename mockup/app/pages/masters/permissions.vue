<script setup lang="ts">
/**
 * F-16 権限設定（管理者専用・オペレーター指示 2026-07-17）
 * ロール/役職/個人の 3 レイヤで機能・表示項目の権限ルールを管理する。
 * - 解決順: 個人 > 役職 > ロール（上位レイヤが下位を上書き。同一レイヤは deny 優先・未設定は許可）
 * - 既存のロールガード（管理者のみ操作等）は緩められない「制限レイヤ」
 * - 表示項目レベル（field）はマスタ GET のレスポンスから API が剥がす（フィールドは API モードで有効）
 * - 管理者の マスタ/設定 deny はロックアウト防止のため無視される（shared/domain/permissions.ts）
 */
import { Plus } from 'lucide-vue-next'
import type { Member, PermissionRule } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { FEATURE_PERMISSION_KEYS } from '../../../../shared/domain/permissions'
import { FIELD_CATALOG, FIELD_RESOURCES, fieldLabel } from '~/utils/permission-catalog'

const ruleCrud = useMasterCrudAsync('permissionRules', 'pm')
const memberCrud = useMasterCrudAsync('members', 'm')
const { list: codeMasters } = useMasterCrudAsync('codeMaster', 'cm')
const toast = useToast()
const confirm = useConfirm()

const KIND_LABELS: Record<PermissionRule['subjectKind'], string> = {
  role: 'ロール', title: '役職', member: '個人',
}
const ROLE_LABELS: Record<string, string> = { admin: '管理者', hr: '人事', member: '一般' }
const EFFECT_LABELS: Record<PermissionRule['effect'], string> = { allow: '許可', deny: '拒否' }

// 項目カタログ（論理名）はルール一覧・権限表の両モードで共有（~/utils/permission-catalog）

/** 表示モード: ルール一覧（従来）/ 権限表（オペレーター指示 2026-07-19 #2） */
const viewTab = ref('list')
const VIEW_TABS = [
  { key: 'list', label: 'ルール一覧' },
  { key: 'matrix', label: '権限表' },
]

const resourceOptions = [
  ...FEATURE_PERMISSION_KEYS.map(f => ({ value: f.key, label: `機能: ${f.label}` })),
  ...FIELD_RESOURCES.map(f => ({ value: f.key, label: `マスタ項目: ${f.label}` })),
]

function resourceLabel(key: string): string {
  return resourceOptions.find(o => o.value === key)?.label ?? key
}

function subjectLabel(r: PermissionRule): string {
  if (r.subjectKind === 'role') return ROLE_LABELS[r.subjectId] ?? r.subjectId
  if (r.subjectKind === 'member') {
    return (memberCrud.byId(r.subjectId) as Member | undefined)?.name ?? r.subjectId
  }
  return r.subjectId
}

const columns: TableColumn[] = [
  { key: 'kind', label: 'レイヤ', primary: true, width: '72px' },
  { key: 'subject', label: '対象', primary: true },
  { key: 'resource', label: 'リソース', primary: true },
  { key: 'field', label: '項目' },
  { key: 'effect', label: '効果', primary: true, width: '64px' },
  { key: 'active', label: '状態', primary: true },
]

const rows = computed(() =>
  (ruleCrud.list.value as PermissionRule[]).map(r => ({
    ...r,
    kind: KIND_LABELS[r.subjectKind],
    subject: subjectLabel(r),
    resourceName: resourceLabel(r.resource),
  })) as unknown as Record<string, unknown>[])

function asRule(row: Record<string, unknown>): PermissionRule {
  return row as unknown as PermissionRule
}

// ---------- 追加・編集モーダル ----------

const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const editing = computed<PermissionRule | null>(() =>
  editingId.value ? ((ruleCrud.byId(editingId.value) as PermissionRule | undefined) ?? null) : null)

const form = ref({
  subjectKind: 'role' as PermissionRule['subjectKind'],
  subjectId: '',
  resource: '',
  /** 選択した項目キー（複数選択 = 1 項目 1 ルールで一括作成。編集時は単一選択） */
  fields: [] as string[],
  effect: 'deny' as PermissionRule['effect'],
})

/** 選択中リソースが表示項目制御に対応しているか（機能リソースは項目指定なし） */
const isFieldResource = computed(() => form.value.resource in FIELD_CATALOG)
const fieldOptions = computed(() => FIELD_CATALOG[form.value.resource] ?? [])

// リソース/レイヤ変更時のリセットは watch ではなくセレクトの change ハンドラで行う
// （watch だと openEdit のフォーム丸ごと差し替えにも発火し、編集初期値の項目・対象を
// 消してしまう = 無変更保存でルールが「マスタ全体」へ静かに拡大する実バグ。レビュー R-1）

const subjectOptions = computed(() => {
  if (form.value.subjectKind === 'role') {
    return Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))
  }
  if (form.value.subjectKind === 'title') {
    return (codeMasters.value as { category: string; label: string; active: boolean }[])
      .filter(cm => cm.category === 'title' && cm.active)
      .map(cm => ({ value: cm.label, label: cm.label }))
  }
  return (memberCrud.activeList.value as Member[]).map(m => ({ value: m.id, label: m.name }))
})

// レイヤ変更時の対象リセットもセレクトの change ハンドラで行う（上記 R-1 と同じ理由。
// こちらは保存時バリデーションで止まるため静かな破壊にはならないが「編集で対象欄が空く」UX バグだった）

function openCreate(): void {
  editingId.value = null
  form.value = { subjectKind: 'role', subjectId: '', resource: '', fields: [], effect: 'deny' }
  modalOpen.value = true
}

function openEdit(row: Record<string, unknown>): void {
  const r = ruleCrud.byId(String(row.id)) as PermissionRule | undefined
  if (!r) return
  editingId.value = r.id
  form.value = {
    subjectKind: r.subjectKind, subjectId: r.subjectId,
    resource: r.resource, fields: r.field ? [r.field] : [], effect: r.effect,
  }
  modalOpen.value = true
}

/** 同一のルール（レイヤ・対象・リソース・項目・効果）が既に有効で存在するか */
function ruleExists(field: string | null): boolean {
  return (ruleCrud.list.value as PermissionRule[]).some(r =>
    r.active
    && r.id !== editingId.value
    && r.subjectKind === form.value.subjectKind
    && r.subjectId === form.value.subjectId
    && r.resource === form.value.resource
    && (r.field ?? null) === field
    && r.effect === form.value.effect)
}

async function save(): Promise<void> {
  if (!form.value.subjectId || !form.value.resource) {
    toast.show('AKO-GEN-001: 対象とリソースを選択してください', 'crit')
    return
  }
  const base = {
    subjectKind: form.value.subjectKind,
    subjectId: form.value.subjectId,
    resource: form.value.resource,
    effect: form.value.effect,
  }
  // 編集 = 単一ルールの更新 / 追加 = 選択した項目ぶんのルールを一括作成（1 項目 1 ルール = スキーマ不変）
  if (editingId.value) {
    // 変更後の内容が別の有効ルールと同一になる場合は重複を作らせない（ruleExists は自ルールを除外）
    if (ruleExists(form.value.fields[0] ?? null)) {
      toast.show('同一の権限ルールが既に存在します', 'warn')
      return
    }
    const res = await ruleCrud.save({ ...base, id: editingId.value, field: form.value.fields[0] ?? null })
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    toast.show('権限ルールを更新しました')
    modalOpen.value = false
    return
  }
  const fields: (string | null)[] = isFieldResource.value && form.value.fields.length > 0
    ? form.value.fields
    : [null]
  let created = 0
  let skipped = 0
  for (const field of fields) {
    if (ruleExists(field)) {
      skipped++
      continue
    }
    const res = await ruleCrud.save({ ...base, field })
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    created++
  }
  toast.show(created > 0
    ? `権限ルールを ${created} 件追加しました${skipped > 0 ? `（同一ルール ${skipped} 件はスキップ）` : ''}`
    : '同一のルールが既に存在するため追加しませんでした', created > 0 ? 'ok' : 'warn')
  modalOpen.value = false
}

async function archiveRule(): Promise<void> {
  if (!editing.value) return
  const ok = await confirm.ask('権限ルールの無効化', 'このルールを無効化しますか？（判定から除外されます）', { danger: true, confirmLabel: '無効化' })
  if (!ok) return
  const res = await ruleCrud.archive(editing.value.id)
  if (res.ok) {
    toast.show('無効化しました', 'warn')
    modalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

async function restoreRule(): Promise<void> {
  if (!editing.value) return
  const res = await ruleCrud.restore(editing.value.id)
  if (res.ok) {
    toast.show('復元しました')
    modalOpen.value = false
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}
</script>

<template>
  <MastersMasterShell
    title="権限設定"
    description="ロール・役職・個人の 3 レイヤで機能と表示項目の権限を制御します（解決順: 個人 > 役職 > ロール。未設定は許可）。管理者向けの基本権限（マスタ変更等）はここでは緩められません"
  >
    <UiTabBar v-model="viewTab" :tabs="VIEW_TABS" class="mb-3" />

    <MastersPermissionMatrix v-if="viewTab === 'matrix'" />

    <UiSectionCard v-else title="権限ルール" description="拒否ルールで機能を隠し、個人の許可ルールで例外を作れます。表示項目（項目列あり）は API モードでマスタ応答から除外されます" flush>
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          ルールを追加
        </button>
      </template>
      <UiDataTable
        :columns="columns"
        :rows="rows"
        clickable
        empty-title="権限ルールがありません"
        empty-hint="ルール未設定の間は全機能が利用できます（既定 = 許可）"
        @row-click="openEdit"
      >
        <template #cell-kind="{ row }">
          <UiStatusBadge :label="String(row.kind)" tone="info" />
        </template>
        <template #cell-subject="{ row }">
          <span class="font-medium">{{ row.subject }}</span>
        </template>
        <template #cell-resource="{ row }">
          {{ row.resourceName }}
        </template>
        <template #cell-field="{ row }">
          <span v-if="asRule(row).field" class="text-xs" :title="`物理キー: ${asRule(row).field}`">
            {{ fieldLabel(asRule(row).resource, asRule(row).field) }}
          </span>
          <span v-else class="text-xs text-muted">—</span>
        </template>
        <template #cell-effect="{ row }">
          <UiStatusBadge
            :label="EFFECT_LABELS[asRule(row).effect]"
            :tone="asRule(row).effect === 'deny' ? 'crit' : 'ok'"
            dot
          />
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asRule(row).active ? '有効' : '無効'" :tone="asRule(row).active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiModal :open="modalOpen" :title="editingId ? '権限ルールを編集' : '権限ルールを追加'" @close="modalOpen = false">
        <div class="grid gap-3">
          <UiFormField label="レイヤ" required hint="個人 > 役職 > ロール の順で優先されます">
            <UiSelect
              v-model="form.subjectKind"
              :options="Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))"
              aria-label="レイヤ"
              @update:model-value="form.subjectId = ''"
            />
          </UiFormField>
          <UiFormField label="対象" required>
            <UiSelect v-model="form.subjectId" :options="subjectOptions" empty-label="対象を選択" aria-label="対象" />
          </UiFormField>
          <UiFormField label="リソース" required hint="機能 = 利用可否 / マスタ項目 = 項目とあわせて表示制御">
            <UiSelect
              v-model="form.resource"
              :options="resourceOptions"
              empty-label="リソースを選択"
              aria-label="リソース"
              @update:model-value="form.fields = []"
            />
          </UiFormField>
          <UiFormField
            v-if="isFieldResource"
            label="項目（任意）"
            :hint="editingId
              ? '項目名で検索して 1 件選択（未選択 = マスタ全体）'
              : '項目名で検索して選択。複数選択すると 1 項目 1 ルールで一括作成されます（未選択 = マスタ全体）'"
          >
            <UiMultiCombobox
              v-model="form.fields"
              :options="fieldOptions"
              :single="!!editingId"
              placeholder="例: 役職・メールアドレス"
              aria-label="制御する項目"
            />
          </UiFormField>
          <UiFormField label="効果" required>
            <UiSelect
              v-model="form.effect"
              :options="Object.entries(EFFECT_LABELS).map(([value, label]) => ({ value, label }))"
              aria-label="効果"
            />
          </UiFormField>
        </div>
        <template #footer>
          <template v-if="editing">
            <button v-if="editing.active" type="button" class="btn btn-danger btn-sm mr-auto" @click="archiveRule">無効化</button>
            <button v-else type="button" class="btn btn-sm mr-auto" @click="restoreRule">復元</button>
          </template>
          <button type="button" class="btn" @click="modalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="save">保存</button>
        </template>
      </UiModal>
    </template>
  </MastersMasterShell>
</template>
