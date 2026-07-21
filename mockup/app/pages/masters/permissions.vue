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
import {
  AI_SCOPE_FEATURES, AI_SCOPE_FIELD, ASSIST_MEMBER_FIELD_PREFIX,
  FEATURE_PERMISSION_KEYS, REPORT_MEMBER_FIELD_PREFIX,
} from '../../../../shared/domain/permissions'
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

// AI 参照範囲はフォーム上は擬似リソース 'ai-scope:<機能キー>' で選ばせ、保存時に
// resource=<機能キー> + field='ai-scope' へ写像する（PermissionRule スキーマ不変 = 権限表と相互運用）
const AI_SCOPE_PREFIX = 'ai-scope:'

// 日報の参照対象（バッチ7h・F-16-6）: フォーム上は擬似リソース 'report-view' で対象メンバーを選ばせ、
// 保存時に resource='reports' + field='member:<対象メンバー id>' へ写像する（1 対象 1 ルール）
const REPORT_VIEW_PSEUDO = 'report-view'
// AI業務アシスタントの参照対象（F-16-7）: 擬似リソース 'assistant-view' で対象メンバーを選ばせ、
// 保存時に resource='ai-assistant' + field='member:<対象メンバー id>' へ写像する（既定 = 参照不可 = 許可制）
const ASSIST_VIEW_PSEUDO = 'assistant-view'

const resourceOptions = [
  ...FEATURE_PERMISSION_KEYS.map(f => ({ value: f.key, label: `機能: ${f.label}` })),
  ...AI_SCOPE_FEATURES.map(f => ({
    value: `${AI_SCOPE_PREFIX}${f.key}`,
    label: `AI 参照範囲: ${f.label}（既定: ${f.defaultScope === 'all' ? 'すべて' : '自分のみ'}）`,
  })),
  { value: REPORT_VIEW_PSEUDO, label: '日報の参照対象: メンバー指定（既定: 参照可）' },
  { value: ASSIST_VIEW_PSEUDO, label: 'AI業務アシスタントの参照対象: メンバー指定（既定: 参照不可）' },
  ...FIELD_RESOURCES.map(f => ({ value: f.key, label: `マスタ項目: ${f.label}` })),
]

function resourceLabel(key: string): string {
  return resourceOptions.find(o => o.value === key)?.label ?? key
}

/** ルールが日報の参照対象（reports + member:<id>）か */
function isReportViewRule(r: PermissionRule): boolean {
  return r.resource === 'reports' && (r.field ?? '').startsWith(REPORT_MEMBER_FIELD_PREFIX)
}

/** ルールが AI業務アシスタントの参照対象（ai-assistant + member:<id>）か */
function isAssistViewRule(r: PermissionRule): boolean {
  return r.resource === 'ai-assistant' && (r.field ?? '').startsWith(ASSIST_MEMBER_FIELD_PREFIX)
}

/** 一覧行のリソース表示（ai-scope / 日報・AIアシスタントの参照対象 は擬似リソースとして表示） */
function ruleResourceLabel(r: PermissionRule): string {
  if ((r.field ?? null) === AI_SCOPE_FIELD) {
    const f = AI_SCOPE_FEATURES.find(x => x.key === r.resource)
    return `AI 参照範囲: ${f?.label ?? r.resource}`
  }
  if (isReportViewRule(r)) return '日報の参照対象'
  if (isAssistViewRule(r)) return 'AI業務アシスタントの参照対象'
  return resourceLabel(r.resource)
}

/** 効果ラベル（ai-scope = すべて/自分のみ・参照対象 = 参照可/参照不可 の語彙） */
function ruleEffectLabel(r: PermissionRule): string {
  if ((r.field ?? null) === AI_SCOPE_FIELD) return r.effect === 'allow' ? 'すべて' : '自分のみ'
  if (isReportViewRule(r) || isAssistViewRule(r)) return r.effect === 'allow' ? '参照可' : '参照不可'
  return EFFECT_LABELS[r.effect]
}

/** 項目ラベル（参照対象は対象メンバー名を表示） */
function ruleFieldLabel(r: PermissionRule): string {
  if (isReportViewRule(r) || isAssistViewRule(r)) {
    const prefix = isReportViewRule(r) ? REPORT_MEMBER_FIELD_PREFIX : ASSIST_MEMBER_FIELD_PREFIX
    const id = (r.field ?? '').slice(prefix.length)
    return (memberCrud.byId(id) as Member | undefined)?.name ?? id
  }
  return fieldLabel(r.resource, r.field)
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
    resourceName: ruleResourceLabel(r),
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
/** 選択中リソースが AI 参照範囲か（効果の語彙が すべて/自分のみ に変わる） */
const isAiScope = computed(() => form.value.resource.startsWith(AI_SCOPE_PREFIX))
/** 選択中リソースが日報の参照対象か（項目 = 対象メンバー・効果の語彙が 参照可/参照不可 に変わる） */
const isReportView = computed(() => form.value.resource === REPORT_VIEW_PSEUDO)
/** 選択中リソースが AI業務アシスタントの参照対象か（項目 = 対象メンバー・既定 = 参照不可 = 許可制） */
const isAssistView = computed(() => form.value.resource === ASSIST_VIEW_PSEUDO)
/** 参照対象（メンバー指定）系のリソースか（対象メンバー UI を出すかの判定） */
const isMemberTargetView = computed(() => isReportView.value || isAssistView.value)
/** 対象メンバーの選択肢（参照対象。論理名 = メンバー名で検索） */
const reportTargetOptions = computed(() =>
  (memberCrud.activeList.value as Member[]).map(m => ({ value: m.id, label: m.name })))
/** フォームの擬似リソースを実際の resource / field へ写像 */
function actualResource(): string {
  if (isAiScope.value) return form.value.resource.slice(AI_SCOPE_PREFIX.length)
  if (isReportView.value) return 'reports'
  if (isAssistView.value) return 'ai-assistant'
  return form.value.resource
}
function actualField(field: string | null): string | null {
  if (isAiScope.value) return AI_SCOPE_FIELD
  if (isReportView.value) return field ? `${REPORT_MEMBER_FIELD_PREFIX}${field}` : null
  if (isAssistView.value) return field ? `${ASSIST_MEMBER_FIELD_PREFIX}${field}` : null
  return field
}
const effectOptions = computed(() => {
  if (isAiScope.value) {
    return [{ value: 'allow', label: 'すべて（他メンバーの登録データも AI が参照）' },
            { value: 'deny', label: '自分の登録データのみ' }]
  }
  if (isReportView.value) {
    return [{ value: 'deny', label: '参照不可（この対象者の日報を見せない）' },
            { value: 'allow', label: '参照可（下位レイヤの参照不可を上書き）' }]
  }
  if (isAssistView.value) {
    return [{ value: 'allow', label: '参照可（この対象者の AI業務アシスタントを readonly 閲覧可）' },
            { value: 'deny', label: '参照不可（明示的に禁止。既定も参照不可）' }]
  }
  return Object.entries(EFFECT_LABELS).map(([value, label]) => ({ value, label }))
})

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
  const isScope = (r.field ?? null) === AI_SCOPE_FIELD
  const isRv = isReportViewRule(r)
  const isAv = isAssistViewRule(r)
  form.value = {
    subjectKind: r.subjectKind, subjectId: r.subjectId,
    resource: isScope
      ? `${AI_SCOPE_PREFIX}${r.resource}`
      : isRv ? REPORT_VIEW_PSEUDO : isAv ? ASSIST_VIEW_PSEUDO : r.resource,
    fields: isRv
      ? [(r.field ?? '').slice(REPORT_MEMBER_FIELD_PREFIX.length)]
      : isAv
        ? [(r.field ?? '').slice(ASSIST_MEMBER_FIELD_PREFIX.length)]
        : !isScope && r.field ? [r.field] : [],
    effect: r.effect,
  }
  modalOpen.value = true
}

/** リソース変更時: 項目をリセットし、参照許可制（AI業務アシスタント）は allow を既定効果にする */
function onResourceChange(): void {
  form.value.fields = []
  if (form.value.resource === ASSIST_VIEW_PSEUDO) form.value.effect = 'allow'
}

/** 同一のルール（レイヤ・対象・リソース・項目・効果）が既に有効で存在するか */
function ruleExists(field: string | null): boolean {
  return (ruleCrud.list.value as PermissionRule[]).some(r =>
    r.active
    && r.id !== editingId.value
    && r.subjectKind === form.value.subjectKind
    && r.subjectId === form.value.subjectId
    && r.resource === actualResource()
    && (r.field ?? null) === actualField(field)
    && r.effect === form.value.effect)
}

async function save(): Promise<void> {
  if (!form.value.subjectId || !form.value.resource) {
    toast.show('AKO-GEN-001: 対象とリソースを選択してください', 'crit')
    return
  }
  if (isMemberTargetView.value && form.value.fields.length === 0) {
    toast.show('AKO-GEN-001: 対象メンバーを選択してください', 'crit')
    return
  }
  const base = {
    subjectKind: form.value.subjectKind,
    subjectId: form.value.subjectId,
    resource: actualResource(),
    effect: form.value.effect,
  }
  // 編集 = 単一ルールの更新 / 追加 = 選択した項目ぶんのルールを一括作成（1 項目 1 ルール = スキーマ不変）
  if (editingId.value) {
    // 変更後の内容が別の有効ルールと同一になる場合は重複を作らせない（ruleExists は自ルールを除外）
    if (ruleExists(form.value.fields[0] ?? null)) {
      toast.show('同一の権限ルールが既に存在します', 'warn')
      return
    }
    const res = await ruleCrud.save({ ...base, id: editingId.value, field: actualField(form.value.fields[0] ?? null) })
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    toast.show('権限ルールを更新しました')
    modalOpen.value = false
    return
  }
  const fields: (string | null)[] = (isFieldResource.value || isMemberTargetView.value) && form.value.fields.length > 0
    ? form.value.fields
    : [null]
  let created = 0
  let skipped = 0
  for (const field of fields) {
    if (ruleExists(field)) {
      skipped++
      continue
    }
    const res = await ruleCrud.save({ ...base, field: actualField(field) })
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

    <!-- v-show でタブ往復しても権限表の状態（レイヤ・個人列の選択）を保持する（レビュー M-6） -->
    <MastersPermissionMatrix v-show="viewTab === 'matrix'" />

    <UiSectionCard v-show="viewTab === 'list'" title="権限ルール" description="拒否ルールで機能を隠し、個人の許可ルールで例外を作れます。表示項目（項目列あり）は API モードでマスタ応答から除外されます" flush>
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
            {{ ruleFieldLabel(asRule(row)) }}
          </span>
          <span v-else class="text-xs text-muted">—</span>
        </template>
        <template #cell-effect="{ row }">
          <UiStatusBadge
            :label="ruleEffectLabel(asRule(row))"
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
              @update:model-value="onResourceChange"
            />
          </UiFormField>
          <UiFormField
            v-if="isMemberTargetView"
            label="対象メンバー"
            required
            :hint="editingId
              ? 'メンバー名で検索して 1 名選択'
              : 'メンバー名で検索して選択。複数選択すると 1 名 1 ルールで一括作成されます'"
          >
            <UiMultiCombobox
              v-model="form.fields"
              :options="reportTargetOptions"
              :single="!!editingId"
              placeholder="メンバー名で検索"
              :aria-label="isAssistView ? 'AI業務アシスタントの参照対象メンバー' : '日報の参照対象メンバー'"
            />
          </UiFormField>
          <UiFormField
            v-else-if="isFieldResource"
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
          <UiFormField
            label="効果"
            required
            :hint="isAiScope
              ? 'AI（チャットボット・AI業務アシスタント）が当該データを参照する範囲'
              : isReportView ? '対象メンバーの日報（チームタブ・全員の日報・AI 文脈）を参照できるか。本人の自分の日報は常に参照可'
                : isAssistView ? '対象メンバーの AI業務アシスタント（計画・振り返り）を readonly 参照できるか。既定は参照不可（許可制）。本人は常に参照可' : undefined"
          >
            <UiSelect
              v-model="form.effect"
              :options="effectOptions"
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
