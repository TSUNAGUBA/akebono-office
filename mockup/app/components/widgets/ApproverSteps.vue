<script setup lang="ts">
/**
 * 承認経路のステップ編集（稟議・勤怠 共通）。各ステップの承認者を「役職 / ロール / 個人」から選ぶ。
 * PermissionRule.subjectKind（role|title|member）と同じ 3 種。解決名は共有 pickApprover でプレビューする。
 * 稟議のみの拡張（改善要望 2026-08-17。props で opt-in = 勤怠側は従来 UI のまま）:
 * - withKind: ステップ種別（承認/決裁/確認）の選択列を表示
 * - allowApplicant: 承認者の指定方法に「申請者本人」を追加（確認ステップの既定担当。提出時に申請者へ解決）
 */
import { Plus, X } from 'lucide-vue-next'
import type { ApprovalStepKind, ApproverType, Member, MemberRole } from '~/types/domain'
import { pickApprover, stepKindOf } from '~/utils/approver'
import { APPROVAL_STEP_KIND_LABELS, APPROVER_TYPE_LABELS, MEMBER_ROLE_LABELS } from '~/utils/labels'

export interface ApproverStepForm {
  approverType: ApproverType
  approverRole: MemberRole | null
  approverTitle: string | null
  approverMemberId: string | null
  /** ステップ種別（withKind のときのみ編集。省略 = 旧呼び出し互換 = 原則7） */
  stepKind?: ApprovalStepKind | null
}

const props = withDefaults(defineProps<{
  modelValue: ApproverStepForm[]
  /** ステップ種別（承認/決裁/確認）の選択列を表示（稟議の経路設定） */
  withKind?: boolean
  /** 「申請者本人」を承認者の指定方法に含める（稟議の経路設定） */
  allowApplicant?: boolean
}>(), { withKind: false, allowApplicant: false })
const emit = defineEmits<{ 'update:modelValue': [ApproverStepForm[]] }>()

const { tbl } = useMockDb()
const { itemsOf } = useCodeMaster()
const members = tbl('members')

const typeOptions = computed(() =>
  (Object.keys(APPROVER_TYPE_LABELS) as ApproverType[])
    .filter(t => props.allowApplicant || t !== 'applicant')
    .map(value => ({ value, label: APPROVER_TYPE_LABELS[value] })))
const kindOptions = (Object.keys(APPROVAL_STEP_KIND_LABELS) as ApprovalStepKind[])
  .map(value => ({ value, label: APPROVAL_STEP_KIND_LABELS[value] }))
// ロールは承認権限を持つ 管理者/人事 のみ提示（レビュー指摘: 一般は任意の一般社員へ解決＝承認者として無意味・自己承認の温床）
const roleOptions = (['admin', 'hr'] as MemberRole[]).map(value => ({ value, label: MEMBER_ROLE_LABELS[value] }))
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
/** 種別の切替。「確認」にした場合、担当の既定を申請者本人にする（改善要望 2026-08-17。担当は選び直し可） */
function setKind(i: number, k: ApprovalStepKind): void {
  const cur = props.modelValue[i]
  if (k === 'confirm' && props.allowApplicant) {
    patch(i, { stepKind: k, approverType: 'applicant', approverRole: null, approverTitle: null, approverMemberId: null })
  } else if (k !== 'confirm' && cur?.approverType === 'applicant') {
    // 確認以外へ戻したら申請者本人指定を解除（承認/決裁を申請者本人にする自己承認を既定にしない）
    patch(i, { stepKind: k, approverType: 'role', approverRole: 'admin', approverTitle: null, approverMemberId: null })
  } else {
    patch(i, { stepKind: k })
  }
}
function addStep(): void {
  update([...props.modelValue, {
    approverType: 'role', approverRole: 'admin', approverTitle: null, approverMemberId: null,
    ...(props.withKind ? { stepKind: 'approval' as ApprovalStepKind } : {}),
  }])
}
function removeStep(i: number): void {
  update(props.modelValue.filter((_, idx) => idx !== i))
}

/** 現在の指定で解決される承認者名（プレビュー）。申請者本人は提出時に解決されるため固定表示 */
function resolvedName(s: ApproverStepForm): string {
  if (s.approverType === 'applicant') return '申請者本人（提出時に解決）'
  return pickApprover(members.value as Member[], s)?.name ?? '未設定'
}
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(s, i) in modelValue" :key="i" class="flex flex-wrap items-center gap-2">
      <span class="w-6 shrink-0 text-center text-[12px] font-semibold text-sub num">{{ i + 1 }}</span>
      <!-- 表示既定は一覧チップ・フロー可視化と同じ stepKindOf（未設定の旧経路 = 最終=決裁・他=承認）に揃える -->
      <UiSelect
        v-if="withKind"
        :model-value="stepKindOf(s, i === modelValue.length - 1)"
        :options="kindOptions"
        aria-label="ステップ種別（承認/決裁/確認）"
        @update:model-value="setKind(i, String($event) as ApprovalStepKind)"
      />
      <UiSelect
        :model-value="s.approverType"
        :options="typeOptions"
        aria-label="承認者の指定方法"
        @update:model-value="setType(i, String($event) as ApproverType)"
      />
      <template v-if="s.approverType === 'applicant'">
        <!-- 申請者本人は追加指定なし（提出時にその申請の申請者へ解決） -->
      </template>
      <UiSelect
        v-else-if="s.approverType === 'title'"
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
