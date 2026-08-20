<script setup lang="ts">
/**
 * 営業活動（案件ヘッダー）の登録・編集ドロワー（改修依頼 2026-08-20）。
 * 一覧（新規登録）と案件詳細（編集）の両方から使う共通フォーム（二重実装しない = 原則3）。
 * - 検証・保存は useSalesActivities.save（shared 検証 = API とパリティ）。
 * - 保存失敗（バリデーション・通信・保存容量超過）は**フッター直上のインライン領域（role="alert"）に必ず表示**する
 *   （登録バグ根本対応: トースト任せにしない = 3.6 秒で消える右下トーストの見落としを防ぐ）。
 */
import { AlertCircle } from 'lucide-vue-next'
import { SALES_ACTIVITY_DEAL_TYPES, SALES_ACTIVITY_PHASES } from '../../../../shared/domain/types'
import type { Company, Contact, Member, SalesActivity, Village } from '~/types/domain'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  /** mode='edit' のときの対象案件 */
  activity?: SalesActivity | null
}>()

const emit = defineEmits<{ close: []; saved: [id: string] }>()

const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const { currentUserId } = useCurrentUser()

const members = tbl('members')
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const villages = computed(() => (tbl('villages').value as Village[]).filter(v => v.active))
const contacts = computed(() => (tbl('contacts').value as Contact[]).filter(c => c.active))

function companyName(id: string): string {
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id
}
function villageName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('villages').value as Village[]).find(v => v.id === id)?.name ?? ''
}
function contactName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('contacts').value as Contact[]).find(c => c.id === id)?.name ?? ''
}

const dealTypeOptions = SALES_ACTIVITY_DEAL_TYPES.map(v => ({ value: v, label: v }))
const phaseOptions = SALES_ACTIVITY_PHASES.map(v => ({ value: v, label: v }))
const villageOptions = computed(() => villages.value.map(v => ({ value: v.id, label: v.name })))
const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))
const staffOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

const form = ref({
  villageId: '',
  villageText: '',
  companyId: '',
  companyText: '',
  contactId: '',
  contactText: '',
  approachGroup: '',
  title: '',
  dealType: '新規',
  staffMemberId: '',
  phase: '初回',
  amount: '',
  probability: '',
  expectedCloseDate: '',
  customerIssue: '',
  proposal: '',
  nextAction: '',
  nextActionDate: '',
  links: [] as string[],
})

/** 保存失敗のインライン表示（role="alert"。登録バグ根本対応 H3: トースト任せにしない） */
const formError = ref('')
const saving = ref(false)

/** 担当（顧客(人)）候補は選択会社に所属する contacts のみ（会社未選択時は空 = 担当欄 disabled） */
const contactOptions = computed(() =>
  form.value.companyId ? contacts.value.filter(c => c.companyId === form.value.companyId).map(c => ({ value: c.id, label: c.name })) : [])
const hasCompanyInput = computed(() => !!form.value.companyId || !!form.value.companyText.trim())

// 会社を変更したら、別会社に属する担当の選択をクリアする（フォームの一括代入時は restoring で抑止）
const restoringForm = ref(false)
watch(() => form.value.companyId, () => {
  if (restoringForm.value) return
  form.value.contactId = ''
  form.value.contactText = ''
})

/** ドロワーを開いたタイミングでフォームを初期化（create = 既定値 / edit = 対象案件から復元） */
watch(() => props.open, (open) => {
  if (!open) return
  formError.value = ''
  restoringForm.value = true
  if (props.mode === 'edit' && props.activity) {
    const s = props.activity
    form.value = {
      villageId: s.villageId ?? '',
      villageText: villageName(s.villageId),
      companyId: s.companyId,
      companyText: companyName(s.companyId),
      contactId: s.contactId ?? '',
      contactText: contactName(s.contactId),
      approachGroup: s.approachGroup ?? '',
      title: s.title,
      dealType: s.dealType,
      staffMemberId: s.staffMemberId,
      phase: s.phase,
      amount: s.amount === null ? '' : String(s.amount),
      probability: s.probability === null ? '' : String(s.probability),
      expectedCloseDate: s.expectedCloseDate ?? '',
      customerIssue: s.customerIssue,
      proposal: s.proposal,
      nextAction: s.nextAction,
      nextActionDate: s.nextActionDate ?? '',
      links: [...(s.links ?? [])],
    }
  } else {
    form.value = {
      villageId: '',
      villageText: '',
      companyId: '',
      companyText: '',
      contactId: '',
      contactText: '',
      approachGroup: '',
      title: '',
      dealType: '新規',
      staffMemberId: currentUserId.value,
      phase: '初回',
      amount: '',
      probability: '',
      expectedCloseDate: '',
      customerIssue: '',
      proposal: '',
      nextAction: '',
      nextActionDate: '',
      links: [],
    }
  }
  void nextTick(() => { restoringForm.value = false })
}, { immediate: true })

/** 数値入力（空 = null）。数値でない持込は NaN のまま渡し shared 検証のメッセージで案内する */
function numOrNull(s: string): number | null {
  const t = s.trim()
  return t === '' ? null : Number(t)
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const res = await sal.save(props.mode === 'edit' ? (props.activity?.id ?? null) : null, {
      villageId: form.value.villageId,
      newVillageName: form.value.villageId ? '' : form.value.villageText,
      companyId: form.value.companyId,
      newCompanyName: form.value.companyId ? '' : form.value.companyText,
      contactId: form.value.contactId,
      newContactName: form.value.contactId ? '' : form.value.contactText,
      approachGroup: form.value.approachGroup,
      title: form.value.title,
      dealType: form.value.dealType,
      staffMemberId: form.value.staffMemberId || currentUserId.value,
      phase: form.value.phase,
      amount: numOrNull(form.value.amount),
      probability: numOrNull(form.value.probability),
      expectedCloseDate: form.value.expectedCloseDate || null,
      customerIssue: form.value.customerIssue,
      proposal: form.value.proposal,
      nextAction: form.value.nextAction,
      nextActionDate: form.value.nextActionDate || null,
      links: form.value.links,
    })
    if (!res.ok) {
      formError.value = `${res.error.code}: ${res.error.message}`
      return
    }
    show(props.mode === 'create' ? '営業活動（案件）を登録しました' : '営業活動（案件）を更新しました')
    if (!form.value.companyId && form.value.companyText.trim()) {
      show('未登録の顧客はマスタへ登録し、記録に反映しました', 'info')
    }
    emit('saved', res.id ?? props.activity?.id ?? '')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDrawer
    :open="open"
    :title="mode === 'create' ? '営業活動（案件）を登録' : '営業活動（案件）を編集'"
    width="560px"
    @close="emit('close')"
  >
    <div class="grid gap-3">
      <!-- 事業区分（Village。最上段・任意・自由入力で新規登録可） -->
      <UiFormField label="事業区分（Village）" hint="社内事業の区分。未登録名を入力すると保存時にマスタへ新規登録されます">
        <UiCombobox
          v-model="form.villageId"
          v-model:text="form.villageText"
          :options="villageOptions"
          placeholder="事業区分で検索・入力"
          aria-label="事業区分（Village）"
          create-hint="保存時にマスタへ新規登録されます"
        />
      </UiFormField>
      <!-- 顧客（会社）の右に担当（顧客(人)= contacts 参照） -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="顧客（会社）" required hint="未登録の会社名を入力すると、保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.companyId"
            v-model:text="form.companyText"
            :options="companyOptions"
            placeholder="会社名で検索・入力"
            aria-label="顧客（会社）"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <UiFormField label="担当" hint="選択会社の担当者。未登録名を入力すると保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.contactId"
            v-model:text="form.contactText"
            :options="contactOptions"
            :disabled="!hasCompanyInput"
            placeholder="担当者名で検索・入力"
            aria-label="担当"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
      </div>
      <UiFormField label="アプローチグループ">
        <input v-model="form.approachGroup" type="text" class="input" placeholder="例）新規開拓A班" aria-label="アプローチグループ">
      </UiFormField>
      <UiFormField label="商談名" required>
        <input v-model="form.title" type="text" class="input" placeholder="例）在庫管理DXプロジェクト" aria-label="商談名">
      </UiFormField>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <UiFormField label="商談種別" required>
          <UiSelect v-model="form.dealType" :options="dealTypeOptions" aria-label="商談種別" />
        </UiFormField>
        <UiFormField label="商談フェーズ" required>
          <UiSelect v-model="form.phase" :options="phaseOptions" aria-label="商談フェーズ" />
        </UiFormField>
        <UiFormField label="担当者" required hint="既定はログインユーザー">
          <UiSelect v-model="form.staffMemberId" :options="staffOptions" aria-label="担当者" />
        </UiFormField>
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <UiFormField label="商談金額（円）">
          <input v-model="form.amount" type="number" min="0" step="1" class="input num" placeholder="1500000" aria-label="商談金額">
        </UiFormField>
        <UiFormField label="受注確度（%）">
          <input v-model="form.probability" type="number" min="0" max="100" step="1" class="input num" placeholder="60" aria-label="受注確度">
        </UiFormField>
        <UiFormField label="受注予定日">
          <input v-model="form.expectedCloseDate" type="date" class="input" aria-label="受注予定日">
        </UiFormField>
      </div>
      <UiFormField label="顧客課題">
        <textarea v-model="form.customerIssue" class="textarea min-h-16" placeholder="例）CSV加工に毎週3時間" aria-label="顧客課題" />
      </UiFormField>
      <UiFormField label="提案概要">
        <textarea v-model="form.proposal" class="textarea min-h-16" placeholder="例）CSV取込・変換自動化" aria-label="提案概要" />
      </UiFormField>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="Next Action">
          <input v-model="form.nextAction" type="text" class="input" placeholder="例）デモ実施" aria-label="Next Action">
        </UiFormField>
        <UiFormField label="Next Action日">
          <input v-model="form.nextActionDate" type="date" class="input" aria-label="Next Action日">
        </UiFormField>
      </div>
      <!-- 参考リンク（改善要望と同じ部品を再利用 = 原則3） -->
      <ImprovementsLinkEditor v-model:links="form.links" />

      <!-- 保存失敗のインライン表示（フッター直上・必ず表示 = トースト任せにしない） -->
      <p v-if="formError" role="alert" class="flex items-start gap-1.5 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[13px] font-medium text-crit">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {{ formError }}
      </p>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <button type="button" class="btn" @click="emit('close')">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : mode === 'create' ? '登録' : '更新' }}
        </button>
      </div>
    </template>
  </UiDrawer>
</template>
