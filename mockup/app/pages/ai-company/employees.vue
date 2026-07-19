<script setup lang="ts">
/**
 * AI 社員の管理（バッチ7f・オペレーター指示 2026-07-19 #7）
 * AI 社員の追加（増員）・名前/ロール変更・無効化（減員）/復元。roles.vue と同じ汎用マスタパターン。
 * 減員は論理削除（過去タスク・活動ログの担当名を保全 = 原則 9.5 の取消可能性は復元で担保）
 */
import { Plus } from 'lucide-vue-next'
import type { AiEmployee, AiRole } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { AI_EMPLOYEE_STATUS_LABELS } from '~/utils/labels'

const empCrud = useMasterCrudAsync('aiEmployees', 'ai')
const roleCrud = useMasterCrudAsync('aiRoles', 'r')
const { roleOf } = useAiCompany()
const { show } = useToast()
// 増減員は管理者のみ（API はサーバーの masters ガードが正。UI でも出し分けて誤操作を防ぐ = レビュー M-6）
const { isAdmin } = useCurrentUser()

// ---------- 一覧 ----------

const columns: TableColumn[] = [
  { key: 'name', label: '名前', primary: true },
  { key: 'roleName', label: 'ロール', primary: true },
  { key: 'statusLabel', label: '稼働状態', width: '110px' },
  { key: 'state', label: '状態', width: '90px', primary: true },
]

const rows = computed(() =>
  (empCrud.list.value as AiEmployee[]).map(e => ({
    ...e,
    roleName: roleOf(e)?.name ?? '未設定',
    statusLabel: AI_EMPLOYEE_STATUS_LABELS[e.status],
    state: e.active ? '有効' : '無効',
  })))

const activeRoleOptions = computed(() =>
  (roleCrud.activeList.value as AiRole[]).map(r => ({ value: r.id, label: r.name })))

// ---------- 追加・編集モーダル ----------

const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', roleId: '' })
const formErrors = reactive({ name: '', roleId: '' })

const editingEmp = computed(() =>
  (editingId.value ? empCrud.byId(editingId.value) as AiEmployee | undefined : undefined))

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.roleId = ''
  formErrors.name = ''
  formErrors.roleId = ''
  modalOpen.value = true
}

function openEdit(emp: AiEmployee): void {
  editingId.value = emp.id
  form.name = emp.name
  form.roleId = emp.roleId
  formErrors.name = ''
  formErrors.roleId = ''
  modalOpen.value = true
}

/**
 * 新規席の自動割当（手動入力を求めない）。オフィスは 4×3 グリッド（IsometricOffice の GRID_X/GRID_Y）。
 * 既存席（無効化済みも含む = 復元との衝突防止）を避けて最初の空きセルへ。満席時はグリッド内を循環
 * （視覚上の重なりは許容 = 描画範囲外へ出さないことを優先）
 */
function nextDeskPosition(): { x: number; y: number } {
  const all = empCrud.list.value as AiEmployee[]
  const occupied = new Set(all.map(e => `${e.deskPosition.x},${e.deskPosition.y}`))
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      if (!occupied.has(`${x},${y}`)) return { x, y }
    }
  }
  return { x: all.length % 4, y: all.length % 3 }
}

async function saveEmployee(): Promise<void> {
  formErrors.name = form.name.trim() ? '' : '名前を入力してください'
  formErrors.roleId = form.roleId ? '' : 'ロールを選択してください'
  if (formErrors.name || formErrors.roleId) return
  const res = await empCrud.save({
    id: editingId.value ?? undefined,
    name: form.name.trim(),
    roleId: form.roleId,
    ...(editingId.value ? {} : { deskPosition: nextDeskPosition() }),
  })
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(editingId.value ? 'AI 社員を更新しました' : 'AI 社員を追加しました（オフィスに着席します）')
  modalOpen.value = false
}

async function toggleActive(): Promise<void> {
  if (!editingId.value || !editingEmp.value) return
  const wasActive = editingEmp.value.active
  const res = wasActive
    ? await empCrud.archive(editingId.value)
    : await empCrud.restore(editingId.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(wasActive
    ? 'AI 社員を無効化しました（過去のタスク・ログは保全されます。復元でいつでも戻せます）'
    : 'AI 社員を復元しました', wasActive ? 'warn' : 'ok')
  modalOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader title="AI 社員の管理" description="AI 社員の増員・減員（無効化/復元）とロール割当を管理します">
      <template #actions>
        <!-- オフィスへの戻る導線はヘッダー共通の親リンク（nav-map.ts）に統一（バッチ7h） -->
        <button v-if="isAdmin" type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          AI 社員を追加
        </button>
      </template>
    </UiPageHeader>

    <UiEmptyState
      v-if="!isAdmin"
      icon="Users"
      title="AI 社員の管理は管理者のみ行えます"
      hint="閲覧・依頼は AI オフィス（/ai-company）から"
    />
    <UiSectionCard
      v-else
      title="AI 社員一覧"
      description="行をクリックすると編集できます。減員は無効化（論理削除）で行い、過去のタスク・活動ログは保全されます"
      flush
    >
      <UiDataTable
        :columns="columns"
        :rows="rows"
        clickable
        empty-title="AI 社員がいません"
        empty-hint="「AI 社員を追加」から増員できます"
        @row-click="row => openEdit(row as unknown as AiEmployee)"
      >
        <template #cell-name="{ row }">
          <span class="flex items-center gap-2">
            <UiAvatar :name="String(row.name)" kind="ai" size="sm" />
            <span class="font-semibold">{{ row.name }}</span>
          </span>
        </template>
        <template #cell-state="{ row }">
          <UiStatusBadge :label="String(row.state)" :tone="row.active ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <!-- 追加・編集モーダル -->
    <UiModal
      :open="modalOpen"
      :title="editingId ? 'AI 社員を編集' : 'AI 社員を追加'"
      @close="modalOpen = false"
    >
      <div class="grid gap-3">
        <UiFormField label="名前" required :error="formErrors.name">
          <input v-model="form.name" type="text" class="input" placeholder="例: リサーチャー・ハナ">
        </UiFormField>
        <UiFormField label="ロール" required :error="formErrors.roleId" hint="ロールの新設・編集はロール設定から">
          <UiSelect
            :model-value="form.roleId"
            :options="activeRoleOptions"
            empty-label="ロールを選択"
            aria-label="ロール"
            @update:model-value="v => form.roleId = v"
          />
        </UiFormField>
      </div>
      <template #footer>
        <button
          v-if="editingId"
          type="button"
          class="btn mr-auto"
          :class="editingEmp?.active ? 'btn-danger' : ''"
          @click="toggleActive"
        >
          {{ editingEmp?.active ? '無効化（減員）' : '復元' }}
        </button>
        <button type="button" class="btn btn-ghost" @click="modalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="saveEmployee">保存</button>
      </template>
    </UiModal>
  </div>
</template>
