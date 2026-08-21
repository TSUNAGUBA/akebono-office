<script setup lang="ts">
/**
 * ビジネスパートナー活動（案件ヘッダー）の登録・編集ドロワー（改修依頼 2026-08-20）。
 * 一覧（新規登録）と案件詳細（編集）の両方から使う共通フォーム（二重実装しない = 原則3）。
 * - 「概要」→「背景・目的」はラベルのみ変更（フィールド名 summary は維持）。「取組内容」（initiatives）を追加。
 * - 検証・保存は usePartnerActivities.save（shared 検証 = API とパリティ）。
 * - 保存失敗はフッター直上のインライン領域（role="alert"）に必ず表示（登録バグ根本対応: トースト任せにしない）。
 *   活動区分（既定値なしの必須項目）は未選択時にフィールド単位のインラインエラーも出す（H3）。
 */
import { AlertCircle } from 'lucide-vue-next'
import { PARTNER_ACTIVITY_STATUSES, PARTNER_ACTIVITY_TYPES } from '../../../../shared/domain/types'
import type { Company, Contact, Member, PartnerActivity, Village } from '~/types/domain'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  /** mode='edit' のときの対象案件 */
  activity?: PartnerActivity | null
}>()

const emit = defineEmits<{ close: []; saved: [id: string] }>()

const pact = usePartnerActivities()
const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const { currentUserId } = useCurrentUser()

const members = tbl('members')
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const villages = computed(() => (tbl('villages').value as Village[]).filter(v => v.active))
const contacts = computed(() => (tbl('contacts').value as Contact[]).filter(c => c.active))

function companyName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? ''
}
function villageName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('villages').value as Village[]).find(v => v.id === id)?.name ?? ''
}
function contactName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('contacts').value as Contact[]).find(c => c.id === id)?.name ?? ''
}

const typeOptions = PARTNER_ACTIVITY_TYPES.map(v => ({ value: v, label: v }))
const statusOptions = PARTNER_ACTIVITY_STATUSES.map(v => ({ value: v, label: v }))
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
  partnerCompanyId: '',
  partnerCompanyText: '',
  partnerContactId: '',
  partnerContactText: '',
  approachCompanyId: '',
  approachCompanyText: '',
  approachGroup: '',
  theme: '',
  activityType: '',
  status: '情報収集',
  summary: '',
  initiatives: '',
  currentState: '',
  nextAction: '',
  nextActionDate: '',
  nextActionNote: '',
  staffMemberId: '',
  relatedMeeting: '',
  relatedSalesActivityId: '',
  memo: '',
  links: [] as string[],
})

/** 保存失敗のインライン表示（role="alert"。登録バグ根本対応 H3: トースト任せにしない） */
const formError = ref('')
/** 活動区分のフィールド単位エラー（既定値なしの必須項目 = 見落としの実績があるためフィールドでも示す） */
const activityTypeError = ref('')
const saving = ref(false)

/** パートナー担当（顧客(人)）候補は選択パートナー会社に所属する contacts のみ（未選択時は空 = 担当欄 disabled） */
const partnerContactOptions = computed(() =>
  form.value.partnerCompanyId ? contacts.value.filter(c => c.companyId === form.value.partnerCompanyId).map(c => ({ value: c.id, label: c.name })) : [])
const hasPartnerCompanyInput = computed(() => !!form.value.partnerCompanyId || !!form.value.partnerCompanyText.trim())

// パートナー会社を変更したら、別会社に属する担当の選択をクリアする（一括代入時は restoring で抑止）
const restoringForm = ref(false)
watch(() => form.value.partnerCompanyId, () => {
  if (restoringForm.value) return
  form.value.partnerContactId = ''
  form.value.partnerContactText = ''
})

// 活動区分を選択したらフィールドエラーを消す（修正が反映された手応えを返す）
watch(() => form.value.activityType, (v) => {
  if (v) activityTypeError.value = ''
})

/** 関連商談の選択肢（有効な営業活動。編集中の既存リンクが取消済みでも保持できるよう追加する） */
const salesOptions = computed(() => {
  const options = sal.list().map(s => ({ value: s.id, label: `${s.title}` }))
  const linked = form.value.relatedSalesActivityId
  if (linked && !options.some(o => o.value === linked)) {
    const s = sal.byId(linked)
    if (s) options.push({ value: s.id, label: `${s.title}（取消済み）` })
  }
  return options
})

/** ドロワーを開いたタイミングでフォームを初期化（create = 既定値 / edit = 対象案件から復元） */
watch(() => props.open, (open) => {
  if (!open) return
  formError.value = ''
  activityTypeError.value = ''
  restoringForm.value = true
  if (props.mode === 'edit' && props.activity) {
    const s = props.activity
    form.value = {
      villageId: s.villageId ?? '',
      villageText: villageName(s.villageId),
      partnerCompanyId: s.partnerCompanyId ?? '',
      // 旧行（FK 未設定）は自由入力スナップショット partnerName をテキストへ復元 → 保存時にマスタ化（移行）
      partnerCompanyText: s.partnerCompanyId ? companyName(s.partnerCompanyId) : (s.partnerName ?? ''),
      partnerContactId: s.partnerContactId ?? '',
      partnerContactText: contactName(s.partnerContactId),
      approachCompanyId: s.approachCompanyId ?? '',
      approachCompanyText: s.approachCompanyId ? companyName(s.approachCompanyId) : (s.relatedCompany ?? ''),
      approachGroup: s.approachGroup ?? '',
      theme: s.theme,
      activityType: s.activityType,
      status: s.status,
      summary: s.summary,
      initiatives: s.initiatives ?? '',
      currentState: s.currentState,
      nextAction: s.nextAction,
      nextActionDate: s.nextActionDate ?? '',
      nextActionNote: s.nextActionNote ?? '',
      staffMemberId: s.staffMemberId,
      relatedMeeting: s.relatedMeeting,
      relatedSalesActivityId: s.relatedSalesActivityId ?? '',
      memo: s.memo,
      links: [...(s.links ?? [])],
    }
  } else {
    form.value = {
      villageId: '',
      villageText: '',
      partnerCompanyId: '',
      partnerCompanyText: '',
      partnerContactId: '',
      partnerContactText: '',
      approachCompanyId: '',
      approachCompanyText: '',
      approachGroup: '',
      theme: '',
      activityType: '',
      status: '情報収集',
      summary: '',
      initiatives: '',
      currentState: '',
      nextAction: '',
      nextActionDate: '',
      nextActionNote: '',
      staffMemberId: currentUserId.value,
      relatedMeeting: '',
      relatedSalesActivityId: '',
      memo: '',
      links: [],
    }
  }
  void nextTick(() => { restoringForm.value = false })
}, { immediate: true })

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const res = await pact.save(props.mode === 'edit' ? (props.activity?.id ?? null) : null, {
      villageId: form.value.villageId,
      newVillageName: form.value.villageId ? '' : form.value.villageText,
      partnerCompanyId: form.value.partnerCompanyId,
      newPartnerCompanyName: form.value.partnerCompanyId ? '' : form.value.partnerCompanyText,
      partnerContactId: form.value.partnerContactId,
      newPartnerContactName: form.value.partnerContactId ? '' : form.value.partnerContactText,
      approachCompanyId: form.value.approachCompanyId,
      newApproachCompanyName: form.value.approachCompanyId ? '' : form.value.approachCompanyText,
      approachGroup: form.value.approachGroup,
      theme: form.value.theme,
      activityType: form.value.activityType,
      status: form.value.status,
      summary: form.value.summary,
      initiatives: form.value.initiatives,
      currentState: form.value.currentState,
      nextAction: form.value.nextAction,
      nextActionDate: form.value.nextActionDate || null,
      nextActionNote: form.value.nextActionNote,
      staffMemberId: form.value.staffMemberId || currentUserId.value,
      relatedMeeting: form.value.relatedMeeting,
      relatedSalesActivityId: form.value.relatedSalesActivityId || null,
      memo: form.value.memo,
      links: form.value.links,
    })
    if (!res.ok) {
      formError.value = `${res.error.code}: ${res.error.message}`
      // 活動区分のエラーはフィールド単位でも示す（既定値なしの必須項目 = 見落とし対策 H3）
      if (res.error.message.startsWith('活動区分')) activityTypeError.value = res.error.message
      return
    }
    show(props.mode === 'create' ? 'ビジネスパートナー活動（案件）を登録しました' : 'ビジネスパートナー活動（案件）を更新しました')
    const registeredCompany = (!form.value.partnerCompanyId && form.value.partnerCompanyText.trim())
      || (!form.value.approachCompanyId && form.value.approachCompanyText.trim())
    if (registeredCompany) show('未登録の会社はマスタへ登録し、記録に反映しました', 'info')
    emit('saved', res.id ?? props.activity?.id ?? '')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDrawer
    :open="open"
    :title="mode === 'create' ? 'ビジネスパートナー活動（案件）を登録' : 'ビジネスパートナー活動（案件）を編集'"
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
      <!-- パートナー会社（必須）の右にパートナー担当（顧客(人)= contacts 参照） -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="パートナー会社" required hint="未登録の会社名を入力すると、保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.partnerCompanyId"
            v-model:text="form.partnerCompanyText"
            :options="companyOptions"
            placeholder="会社名で検索・入力"
            aria-label="パートナー会社"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <UiFormField label="パートナー担当" hint="選択会社の担当者。未登録名を入力すると保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.partnerContactId"
            v-model:text="form.partnerContactText"
            :options="partnerContactOptions"
            :disabled="!hasPartnerCompanyInput"
            placeholder="担当者名で検索・入力"
            aria-label="パートナー担当"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
      </div>
      <!-- アプローチ企業（顧客(会社)参照・任意）+ アプローチグループ（自由入力・任意） -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="アプローチ企業" hint="未登録の会社名を入力すると、保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.approachCompanyId"
            v-model:text="form.approachCompanyText"
            :options="companyOptions"
            placeholder="会社名で検索・入力"
            aria-label="アプローチ企業"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <UiFormField label="アプローチグループ">
          <input v-model="form.approachGroup" type="text" class="input" placeholder="例）紹介ルートA" aria-label="アプローチグループ">
        </UiFormField>
      </div>
      <UiFormField label="テーマ名" required>
        <input v-model="form.theme" type="text" class="input" placeholder="例）フローラ社との協業検討" aria-label="テーマ名">
      </UiFormField>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <UiFormField label="活動区分" required :error="activityTypeError">
          <UiSelect v-model="form.activityType" :options="typeOptions" empty-label="選択してください" aria-label="活動区分" />
        </UiFormField>
        <UiFormField label="ステータス" required>
          <UiSelect v-model="form.status" :options="statusOptions" aria-label="ステータス" />
        </UiFormField>
        <UiFormField label="自社担当者" required hint="既定はログインユーザー">
          <UiSelect v-model="form.staffMemberId" :options="staffOptions" aria-label="自社担当者" />
        </UiFormField>
      </div>
      <!-- 「概要」→「背景・目的」（ラベルのみ変更。フィールド名 summary は維持 = 改修依頼 2026-08-20） -->
      <UiFormField label="背景・目的">
        <textarea v-model="form.summary" class="textarea min-h-16" placeholder="活動テーマの背景・目的" aria-label="背景・目的" />
      </UiFormField>
      <!-- 取組内容（改修依頼 2026-08-20 で追加） -->
      <UiFormField label="取組内容">
        <textarea v-model="form.initiatives" class="textarea min-h-16" placeholder="例）データ連携PoCの共同実施、勉強会の開催" aria-label="取組内容" />
      </UiFormField>
      <UiFormField label="現在状況">
        <textarea v-model="form.currentState" class="textarea min-h-16" placeholder="例）先方担当者と初回協議済み" aria-label="現在状況" />
      </UiFormField>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="Next Action">
          <input v-model="form.nextAction" type="text" class="input" placeholder="例）3者MTG" aria-label="Next Action">
        </UiFormField>
        <UiFormField label="Next Action日">
          <input v-model="form.nextActionDate" type="date" class="input" aria-label="Next Action日">
        </UiFormField>
      </div>
      <!-- Next Action メモ（改善要望 2026-08-21。Next Action の補足を自由記述） -->
      <UiFormField label="Next Action メモ">
        <textarea
          v-model="form.nextActionNote"
          class="textarea"
          rows="2"
          placeholder="例）参画条件の合意点・持ち帰り事項など"
          aria-label="Next Action メモ"
        />
      </UiFormField>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <UiFormField label="関連MTG">
          <input v-model="form.relatedMeeting" type="text" class="input" placeholder="例）9/7 フローラMTG" aria-label="関連MTG">
        </UiFormField>
        <UiFormField label="関連商談" hint="案件化したら営業活動へリンク">
          <UiSelect v-model="form.relatedSalesActivityId" :options="salesOptions" empty-label="（未リンク）" aria-label="関連商談" />
        </UiFormField>
      </div>
      <UiFormField label="メモ">
        <textarea v-model="form.memo" class="textarea min-h-16" placeholder="その他のメモ" aria-label="メモ" />
      </UiFormField>
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
