<script setup lang="ts">
/**
 * ロール設定（F-08-2）
 * ロールの一覧・追加・編集・無効化/復元 + AI 社員へのロール割当変更。
 */
import { ArrowLeft, Plus } from 'lucide-vue-next'
import type { AiModelTier, AiRole } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { AI_EMPLOYEE_STATUS_LABELS } from '~/utils/labels'

const roleCrud = useMasterCrud('aiRoles', 'r')
const empCrud = useMasterCrud('aiEmployees', 'ai')
const { employees, roleOf } = useAiCompany()
const { show } = useToast()

// ---------- 一覧 ----------

const columns: TableColumn[] = [
  { key: 'name', label: '名前', primary: true },
  { key: 'mission', label: 'ミッション', primary: true },
  { key: 'modelTier', label: 'モデル層', width: '110px' },
  { key: 'permCount', label: '権限数', width: '80px', align: 'right' },
  { key: 'state', label: '状態', width: '90px', primary: true },
]

const rows = computed(() =>
  roleCrud.list.value.map(r => ({
    ...r,
    permCount: r.permissions.length,
    state: r.active ? '有効' : '無効',
  })))

// ---------- 追加・編集モーダル ----------

const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  mission: '',
  systemPrompt: '',
  permissions: [] as string[],
  modelTier: 'standard' as AiModelTier,
})
const formErrors = reactive({ name: '', mission: '' })

const editingRole = computed(() => (editingId.value ? roleCrud.byId(editingId.value) : undefined))

const tierOptions = (Object.keys(AI_MODEL_TIER_LABELS) as AiModelTier[])
  .map(t => ({ value: t, label: AI_MODEL_TIER_LABELS[t] }))

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.mission = ''
  form.systemPrompt = ''
  form.permissions = []
  form.modelTier = 'standard'
  formErrors.name = ''
  formErrors.mission = ''
  modalOpen.value = true
}

function openEdit(role: AiRole): void {
  editingId.value = role.id
  form.name = role.name
  form.mission = role.mission
  form.systemPrompt = role.systemPrompt
  form.permissions = [...role.permissions]
  form.modelTier = role.modelTier
  formErrors.name = ''
  formErrors.mission = ''
  modalOpen.value = true
}

function saveRole(): void {
  formErrors.name = form.name.trim() ? '' : 'ロール名を入力してください'
  formErrors.mission = form.mission.trim() ? '' : 'ミッションを入力してください'
  if (formErrors.name || formErrors.mission) return
  const res = roleCrud.save({
    id: editingId.value ?? undefined,
    name: form.name.trim(),
    mission: form.mission.trim(),
    systemPrompt: form.systemPrompt.trim(),
    permissions: form.permissions,
    modelTier: form.modelTier,
  })
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(editingId.value ? 'ロールを更新しました' : 'ロールを追加しました')
  modalOpen.value = false
}

function toggleActive(): void {
  if (!editingId.value || !editingRole.value) return
  const res = editingRole.value.active
    ? roleCrud.archive(editingId.value)
    : roleCrud.restore(editingId.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(editingRole.value.active ? 'ロールを復元しました' : 'ロールを無効化しました')
  modalOpen.value = false
}

// ---------- AI 社員への割当 ----------

const activeRoleOptions = computed(() =>
  roleCrud.activeList.value.map(r => ({ value: r.id, label: r.name })))

function changeAssignment(empId: string, roleId: string): void {
  if (!roleId) return
  const emp = employees.value.find(e => e.id === empId)
  const res = empCrud.save({ id: empId, roleId })
  if (res.ok) show(`${emp?.name ?? empId} のロールを変更しました`)
  else show(res.error.message, 'warn')
}
</script>

<template>
  <div>
    <UiPageHeader title="ロール設定" description="AI 社員のロール（責務・システムプロンプト・権限・モデル層）を管理します">
      <template #actions>
        <NuxtLink to="/ai-company" class="btn btn-ghost btn-sm">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          オフィスへ戻る
        </NuxtLink>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          ロールを追加
        </button>
      </template>
    </UiPageHeader>

    <div class="grid gap-3">
      <UiSectionCard title="ロール一覧" description="行をクリックすると編集できます" flush>
        <UiDataTable
          :columns="columns"
          :rows="rows"
          clickable
          empty-title="ロールがありません"
          @row-click="row => openEdit(row as unknown as AiRole)"
        >
          <template #cell-modelTier="{ value }">
            {{ AI_MODEL_TIER_LABELS[value as AiModelTier] }}
          </template>
          <template #cell-state="{ row }">
            <UiStatusBadge :label="String(row.state)" :tone="row.active ? 'ok' : 'neutral'" dot />
          </template>
        </UiDataTable>
      </UiSectionCard>

      <UiSectionCard title="AI 社員への割当" description="ロールは AI 社員に割当できます。変更は即時反映されます">
        <ul class="grid gap-2">
          <li
            v-for="e in employees"
            :key="e.id"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
          >
            <UiAvatar :name="e.name" kind="ai" size="sm" />
            <span class="text-[13px] font-bold">{{ e.name }}</span>
            <UiStatusBadge :label="AI_EMPLOYEE_STATUS_LABELS[e.status]" :tone="AI_EMPLOYEE_STATUS_TONES[e.status]" dot />
            <span class="ml-auto flex items-center gap-1.5 text-xs text-muted">
              <span class="hidden sm:inline">現在: {{ roleOf(e)?.name ?? '未設定' }}</span>
              <UiSelect
                :model-value="e.roleId"
                :options="activeRoleOptions"
                :aria-label="`${e.name} のロール`"
                @update:model-value="v => changeAssignment(e.id, v)"
              />
            </span>
          </li>
        </ul>
      </UiSectionCard>
    </div>

    <!-- 追加・編集モーダル -->
    <UiModal
      :open="modalOpen"
      :title="editingId ? 'ロールを編集' : 'ロールを追加'"
      @close="modalOpen = false"
    >
      <div class="grid gap-3">
        <UiFormField label="ロール名" required :error="formErrors.name">
          <input v-model="form.name" type="text" class="input" placeholder="例: リサーチャー">
        </UiFormField>
        <UiFormField label="ミッション" required :error="formErrors.mission">
          <input v-model="form.mission" type="text" class="input" placeholder="このロールの責務を 1 行で">
        </UiFormField>
        <UiFormField label="システムプロンプト" hint="AI 社員の振る舞いを規定する指示文">
          <textarea v-model="form.systemPrompt" class="textarea" rows="4" placeholder="あなたは◯◯専門の AI 社員です。…" />
        </UiFormField>
        <UiFormField label="権限">
          <UiChipSelect v-model="form.permissions" :options="AI_PERMISSION_OPTIONS" aria-label="権限の選択" />
        </UiFormField>
        <UiFormField label="モデル層">
          <UiSelect
            :model-value="form.modelTier"
            :options="tierOptions"
            aria-label="モデル層"
            @update:model-value="v => form.modelTier = v as AiModelTier"
          />
        </UiFormField>
      </div>
      <template #footer>
        <button
          v-if="editingId"
          type="button"
          class="btn mr-auto"
          :class="editingRole?.active ? 'btn-danger' : ''"
          @click="toggleActive"
        >
          {{ editingRole?.active ? '無効化' : '復元' }}
        </button>
        <button type="button" class="btn btn-ghost" @click="modalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="saveRole">保存</button>
      </template>
    </UiModal>
  </div>
</template>
