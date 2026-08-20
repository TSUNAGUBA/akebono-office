<script setup lang="ts">
/**
 * 通知の宛先エディタ（オペレーター指示 2026-08-03）。宛先を「役職 / ロール / 個人」から複数指定する。
 * 承認者指定（ApproverSteps）と同じ 3 種（ApproverType）だが、順序・承認モードは持たない単純なリスト。
 * 解決（宛先 → 在籍メンバー）は共有 resolveNotifyRecipientIds。ロールは通知用途のため 3 種すべてを提示する
 * （承認と違い一般社員全員への周知もあり得る）。空リスト = 宛先なし（通知は飛ばない）を許容する。
 */
import { Plus, X } from 'lucide-vue-next'
import type { ApproverType, Member, MemberRole } from '~/types/domain'
import type { NotifyRecipientTarget } from '~/utils/notify-recipients'
import { resolveNotifyRecipientIds } from '~/utils/notify-recipients'
import { APPROVER_TYPE_LABELS, MEMBER_ROLE_LABELS } from '~/utils/labels'

const props = defineProps<{ modelValue: NotifyRecipientTarget[] }>()
const emit = defineEmits<{ 'update:modelValue': [NotifyRecipientTarget[]] }>()

const { tbl } = useMockDb()
const { itemsOf } = useCodeMaster()
const members = tbl('members')

// applicant（申請者本人）は稟議の経路設定専用（通知宛先では解決先がなく無効になるため除外 = レビュー指摘 2026-08-17）
const typeOptions = (Object.keys(APPROVER_TYPE_LABELS) as ApproverType[])
  .filter(t => t !== 'applicant')
  .map(value => ({ value, label: APPROVER_TYPE_LABELS[value] }))
// 通知は周知用途もあるためロール 3 種すべて提示（承認 = admin/hr のみ とは異なる）
const roleOptions = (['admin', 'hr', 'member'] as MemberRole[]).map(value => ({ value, label: MEMBER_ROLE_LABELS[value] }))
const titleOptions = computed(() => itemsOf('title')) // [{ value: label, label }]
const memberOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({ value: m.id, label: `${m.name}（${m.title || '—'}）` })))

function update(list: NotifyRecipientTarget[]): void { emit('update:modelValue', list) }
function patch(i: number, p: Partial<NotifyRecipientTarget>): void {
  update(props.modelValue.map((t, idx) => idx === i ? { ...t, ...p } : t))
}
/** 指定方法の切替時は他フィールドをクリアして不整合を防ぐ（role は member を既定に） */
function setType(i: number, t: ApproverType): void {
  patch(i, { type: t, role: t === 'role' ? 'member' : null, title: null, memberId: null })
}
function addTarget(): void {
  update([...props.modelValue, { type: 'role', role: 'member', title: null, memberId: null }])
}
function removeTarget(i: number): void {
  update(props.modelValue.filter((_, idx) => idx !== i))
}

/** この指定で通知が届く在籍メンバー数（プレビュー） */
function resolvedCount(t: NotifyRecipientTarget): number {
  return resolveNotifyRecipientIds([t], members.value as Member[]).length
}
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(t, i) in modelValue" :key="i" class="flex flex-wrap items-center gap-2">
      <UiSelect
        :model-value="t.type"
        :options="typeOptions"
        aria-label="宛先の指定方法"
        @update:model-value="setType(i, String($event) as ApproverType)"
      />
      <UiSelect
        v-if="t.type === 'title'"
        :model-value="t.title ?? ''"
        :options="titleOptions"
        empty-label="役職を選択"
        aria-label="役職"
        @update:model-value="patch(i, { title: String($event) })"
      />
      <UiSelect
        v-else-if="t.type === 'role'"
        :model-value="t.role ?? ''"
        :options="roleOptions"
        aria-label="ロール"
        @update:model-value="patch(i, { role: String($event) as MemberRole })"
      />
      <UiSelect
        v-else
        :model-value="t.memberId ?? ''"
        :options="memberOptions"
        empty-label="メンバーを選択"
        aria-label="宛先（個人）"
        @update:model-value="patch(i, { memberId: String($event) })"
      />
      <span class="text-xs text-sub">→ {{ resolvedCount(t) }} 名</span>
      <button
        type="button"
        class="btn btn-sm btn-ghost"
        aria-label="宛先を削除"
        @click="removeTarget(i)"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
    <p v-if="modelValue.length === 0" class="text-xs text-muted">宛先が未設定です（誰にも通知されません）。</p>
    <button type="button" class="btn btn-sm w-fit" @click="addTarget">
      <Plus class="h-3.5 w-3.5" /> 宛先を追加
    </button>
  </div>
</template>
