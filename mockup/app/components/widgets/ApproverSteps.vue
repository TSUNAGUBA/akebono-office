<script setup lang="ts">
/**
 * 承認経路のステップ編集（稟議・勤怠 共通）。各ステップの承認者を「役職 / ロール / 個人」から選ぶ。
 * PermissionRule.subjectKind（role|title|member）と同じ 3 種。解決名は共有 pickApprover でプレビューする。
 */
import { Plus, X } from 'lucide-vue-next'
import type { ApproverType, Member, MemberRole } from '~/types/domain'
import { pickApprover } from '~/utils/approver'
import { APPROVER_TYPE_LABELS, MEMBER_ROLE_LABELS } from '~/utils/labels'

export interface ApproverStepForm {
  approverType: ApproverType
  approverRole: MemberRole | null
  approverTitle: string | null
  approverMemberId: string | null
}

const props = defineProps<{ modelValue: ApproverStepForm[] }>()
const emit = defineEmits<{ 'update:modelValue': [ApproverStepForm[]] }>()

const { tbl } = useMockDb()
const { itemsOf } = useCodeMaster()
const members = tbl('members')

const typeOptions = (Object.keys(APPROVER_TYPE_LABELS) as ApproverType[]).map(value => ({ value, label: APPROVER_TYPE_LABELS[value] }))
const roleOptions = (['admin', 'hr', 'member'] as MemberRole[]).map(value => ({ value, label: MEMBER_ROLE_LABELS[value] }))
const titleOptions = computed(() => itemsOf('title')) // [{ value: label, label }]
const memberOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({ value: m.id, label: `${m.name}（${m.title || '—'}）` })))

function update(steps: ApproverStepForm[]): void { emit('update:modelValue', steps) }
function patch(i: number, p: Partial<ApproverStepForm>): void {
  update(props.modelValue.map((s, idx) => idx === i ? { ...s, ...p } : s))
}
/** 指定方法の切替時は他フィールドをクリアして不整合を防ぐ（role は admin を既定に） */
function setType(i: number, t: ApproverType): void {
  patch(i, { approverType: t, approverRole: t === 'role' ? 'admin' : null, approverTitle: null, approverMemberId: null })
}
function addStep(): void {
  update([...props.modelValue, { approverType: 'role', approverRole: 'admin', approverTitle: null, approverMemberId: null }])
}
function removeStep(i: number): void {
  update(props.modelValue.filter((_, idx) => idx !== i))
}

/** 現在の指定で解決される承認者名（プレビュー） */
function resolvedName(s: ApproverStepForm): string {
  return pickApprover(members.value as Member[], s)?.name ?? '未設定'
}
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(s, i) in modelValue" :key="i" class="flex flex-wrap items-center gap-2">
      <span class="w-6 shrink-0 text-center text-[12px] font-semibold text-sub num">{{ i + 1 }}</span>
      <UiSelect
        :model-value="s.approverType"
        :options="typeOptions"
        aria-label="承認者の指定方法"
        @update:model-value="setType(i, String($event) as ApproverType)"
      />
      <UiSelect
        v-if="s.approverType === 'title'"
        :model-value="s.approverTitle ?? ''"
        :options="titleOptions"
        aria-label="役職"
        @update:model-value="patch(i, { approverTitle: String($event) })"
      />
      <UiSelect
        v-else-if="s.approverType === 'role'"
        :model-value="s.approverRole ?? ''"
        :options="roleOptions"
        aria-label="ロール"
        @update:model-value="patch(i, { approverRole: String($event) as MemberRole })"
      />
      <UiSelect
        v-else
        :model-value="s.approverMemberId ?? ''"
        :options="memberOptions"
        aria-label="承認者（個人）"
        @update:model-value="patch(i, { approverMemberId: String($event) })"
      />
      <span class="text-xs text-sub">→ {{ resolvedName(s) }}</span>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        :disabled="modelValue.length <= 1"
        aria-label="ステップを削除"
        @click="removeStep(i)"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
    <button type="button" class="btn btn-sm w-fit" @click="addStep">
      <Plus class="h-3.5 w-3.5" /> ステップを追加
    </button>
  </div>
</template>
