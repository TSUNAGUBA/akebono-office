<script setup lang="ts">
/**
 * 営業活動パネル（改修依頼 2026-08-18・F-44）。
 * 顧客 × 商談名を 1 件として、フェーズ・金額・確度・Next Action を記録・一覧・編集・取消/復元する。
 * - チーム共有の記録系: 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログ）。
 * - 一覧は useListView（1 ページ 20 件。モック = クライアント / API = サーバーページング）+ UiPagination。
 * - 顧客(会社)は UiCombobox（未登録名は保存時にマスタへ新規登録 = 顧客活動と同じ導線）。
 * - 取消（論理削除）+ 復元（原則9.5）。
 */
import { Plus, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { SALES_ACTIVITY_DEAL_TYPES, SALES_ACTIVITY_PHASES } from '../../../../shared/domain/types'
import type { Company, Contact, Member, SalesActivity, Village } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtYen } from '~/utils/format'

const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
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
const villageOptions = computed(() => villages.value.map(v => ({ value: v.id, label: v.name })))
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
function fmtDateKey(d: string | null): string {
  return d ? d.replace(/-/g, '/') : '—'
}
function fmtAmount(n: number | null): string {
  return n === null ? '—' : fmtYen(n)
}
function fmtProbability(n: number | null): string {
  return n === null ? '—' : `${n}%`
}

// ---------- 一覧（検索 + フィルタ + ページング。デュアルモード） ----------

const phaseFilter = ref('')
const dealTypeFilter = ref('')
const phaseOptions = SALES_ACTIVITY_PHASES.map(v => ({ value: v, label: v }))
const dealTypeOptions = SALES_ACTIVITY_DEAL_TYPES.map(v => ({ value: v, label: v }))

const filterPredicate = computed(() => (r: SalesActivity): boolean => {
  if (phaseFilter.value && r.phase !== phaseFilter.value) return false
  if (dealTypeFilter.value && r.dealType !== dealTypeFilter.value) return false
  return true
})
const filterParams = computed(() => {
  const p: Record<string, string> = { 'f.active': 'true' }
  if (phaseFilter.value) p['f.phase'] = phaseFilter.value
  if (dealTypeFilter.value) p['f.dealType'] = dealTypeFilter.value
  return p
})

const lv = useListView<SalesActivity>({
  source: computed(() => sal.list()),
  // クライアント検索の対象はサーバー searchCols（商談名/顧客名/顧客課題/提案概要/Next Action）と揃える
  match: (r, q) => [r.title, companyName(r.companyId), r.customerIssue, r.proposal, r.nextAction]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => apiListPage<SalesActivity>('salesActivities', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'companyName', label: '顧客', primary: true },
  { key: 'title', label: '商談名', primary: true },
  { key: 'dealType', label: '種別', width: '64px' },
  { key: 'phase', label: 'フェーズ', primary: true, width: '96px' },
  { key: 'amountLabel', label: '商談金額', align: 'right', width: '110px' },
  { key: 'probabilityLabel', label: '確度', align: 'right', width: '64px' },
  { key: 'expectedLabel', label: '受注予定', width: '100px' },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'staffName', label: '担当', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    companyName: companyName(r.companyId),
    amountLabel: fmtAmount(r.amount),
    probabilityLabel: fmtProbability(r.probability),
    expectedLabel: fmtDateKey(r.expectedCloseDate),
    staffName: memberName(r.staffMemberId),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): SalesActivity {
  return row as unknown as SalesActivity
}

// ---------- 詳細・編集（ドロワー） ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<SalesActivity | null>(() => {
  if (!selectedId.value) return null
  return sal.list().find(r => r.id === selectedId.value)
    ?? sal.archivedList().find(r => r.id === selectedId.value)
    ?? lv.rows.value.find(r => r.id === selectedId.value)
    ?? null
})
const saving = ref(false)

const drawerTitle = computed(() =>
  mode.value === 'create' ? '営業活動を登録' : mode.value === 'edit' ? '営業活動を編集' : '営業活動の詳細')

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

const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))
/** 担当（顧客(人)）候補は選択会社に所属する contacts のみ（会社未選択時は空 = 担当欄 disabled） */
const contactOptions = computed(() =>
  form.value.companyId ? contacts.value.filter(c => c.companyId === form.value.companyId).map(c => ({ value: c.id, label: c.name })) : [])
const hasCompanyInput = computed(() => !!form.value.companyId || !!form.value.companyText.trim())
const staffOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

// 会社を変更したら、別会社に属する担当の選択をクリアする（フォームの一括代入時は openEdit の restoring で抑止）
const restoringForm = ref(false)
watch(() => form.value.companyId, () => {
  if (restoringForm.value) return
  form.value.contactId = ''
  form.value.contactText = ''
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
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
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const s = selected.value
  if (!s) return
  // 一括代入中は company watch による contact クリアを抑止（既存の担当を保持）
  restoringForm.value = true
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
  void nextTick(() => { restoringForm.value = false })
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

/** 数値入力（空 = null）。数値でない持込は NaN のまま渡し shared 検証のメッセージで案内する */
function numOrNull(s: string): number | null {
  const t = s.trim()
  return t === '' ? null : Number(t)
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await sal.save(mode.value === 'edit' ? selectedId.value : null, {
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
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    const created = mode.value === 'create'
    show(created ? '営業活動を登録しました' : '営業活動を更新しました')
    if (!form.value.companyId && form.value.companyText.trim()) {
      show('未登録の顧客はマスタへ登録し、記録に反映しました', 'info')
    }
    if (res.id) selectedId.value = res.id
    mode.value = 'view'
    lv.refresh()
  } finally {
    saving.value = false
  }
}

// ---------- 取消/復元（原則9.5） ----------

const restoring = ref(false)
const showArchived = ref(false)
const archived = computed(() => sal.archivedList())

async function onArchive(r: SalesActivity): Promise<void> {
  const ok = await confirm.ask(
    '営業活動の取消',
    `「${r.title}」を取り消しますか？（一覧から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await sal.archive(r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerOpen.value = false
  show('取り消しました', 'warn')
  lv.refresh()
}

async function onRestore(r: SalesActivity): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await sal.restore(r.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
    lv.refresh()
  } finally {
    restoring.value = false
  }
}

const detailRows = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: '事業区分', value: villageName(s.villageId) || '—' },
    { label: '顧客', value: companyName(s.companyId) },
    { label: '担当', value: contactName(s.contactId) || '—' },
    { label: 'アプローチグループ', value: s.approachGroup || '—' },
    { label: '商談名', value: s.title },
    { label: '商談種別', value: s.dealType },
    { label: '担当者', value: memberName(s.staffMemberId) },
    { label: '商談フェーズ', value: s.phase },
    { label: '商談金額', value: fmtAmount(s.amount) },
    { label: '受注確度', value: fmtProbability(s.probability) },
    { label: '受注予定日', value: fmtDateKey(s.expectedCloseDate) },
    { label: '顧客課題', value: s.customerIssue || '—' },
    { label: '提案概要', value: s.proposal || '—' },
    { label: 'Next Action', value: s.nextAction || '—' },
    { label: 'Next Action日', value: fmtDateKey(s.nextActionDate) },
    { label: '参考リンク', value: (s.links ?? []).join('\n') || '—' },
    { label: '記録者', value: memberName(s.memberId) },
  ]
})
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="lv.query.value" placeholder="商談名・顧客名・課題で検索" />
      <UiSelect v-model="phaseFilter" :options="phaseOptions" empty-label="すべてのフェーズ" aria-label="商談フェーズで絞り込み" class="w-auto" />
      <UiSelect v-model="dealTypeFilter" :options="dealTypeOptions" empty-label="すべての種別" aria-label="商談種別で絞り込み" class="w-auto" />
      <template #trailing>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="sal.refresh(); lv.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          登録する
        </button>
      </template>
    </UiFilterBar>

    <UiSectionCard :title="`営業活動一覧（${lv.total.value}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する営業活動がありません"
        empty-hint="「登録する」から商談を記録できます"
        @row-click="openDetail"
      >
        <template #cell-phase="{ row }">
          <UiStatusBadge :label="asRow(row).phase" :tone="SALES_PHASE_TONES[asRow(row).phase] ?? 'neutral'" dot />
        </template>
      </UiDataTable>
      <div class="px-4 pb-3">
        <UiPagination v-model:page="lv.page.value" v-model:page-size="lv.pageSize.value" :total="lv.total.value" />
      </div>

      <!-- 取消済み（復元 = 原則9.5） -->
      <div v-if="archived.length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${archived.length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="r in archived" :key="r.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <span class="text-[13px] text-muted line-through">{{ companyName(r.companyId) }} / {{ r.title }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${r.title}」を復元する`" @click="onRestore(r)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <UiDrawer :open="drawerOpen" :title="drawerTitle" width="560px" @close="drawerOpen = false">
      <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
        <div
          v-for="r in detailRows"
          :key="r.label"
          class="grid grid-cols-[130px_1fr] gap-2 border-b border-line pb-2 last:border-0"
        >
          <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
          <dd class="whitespace-pre-wrap">{{ r.value }}</dd>
        </div>
      </dl>

      <div v-else class="grid gap-3">
        <!-- 事業区分（Village。最上段・任意・自由入力で新規登録可 = 改修依頼 2026-08-19 第4弾） -->
        <UiFormField label="事業区分（Village・任意）" hint="社内事業の区分。未登録名を入力すると保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.villageId"
            v-model:text="form.villageText"
            :options="villageOptions"
            placeholder="事業区分で検索・入力"
            aria-label="事業区分（Village）"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <!-- 顧客（会社）の右に担当（顧客(人)= contacts 参照。改修依頼 2026-08-19 第4弾） -->
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
          <UiFormField label="担当（任意）" hint="選択会社の担当者。未登録名を入力すると保存時にマスタへ新規登録されます">
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
        <!-- アプローチグループ（自由入力・任意。改修依頼 2026-08-19 第4弾） -->
        <UiFormField label="アプローチグループ（任意）">
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
          <UiFormField label="商談金額（円・任意）">
            <input v-model="form.amount" type="number" min="0" step="1" class="input num" placeholder="1500000" aria-label="商談金額">
          </UiFormField>
          <UiFormField label="受注確度（%・任意）">
            <input v-model="form.probability" type="number" min="0" max="100" step="1" class="input num" placeholder="60" aria-label="受注確度">
          </UiFormField>
          <UiFormField label="受注予定日（任意）">
            <input v-model="form.expectedCloseDate" type="date" class="input" aria-label="受注予定日">
          </UiFormField>
        </div>
        <UiFormField label="顧客課題（任意）">
          <textarea v-model="form.customerIssue" class="textarea min-h-16" placeholder="例）CSV加工に毎週3時間" aria-label="顧客課題" />
        </UiFormField>
        <UiFormField label="提案概要（任意）">
          <textarea v-model="form.proposal" class="textarea min-h-16" placeholder="例）CSV取込・変換自動化" aria-label="提案概要" />
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="Next Action（任意）">
            <input v-model="form.nextAction" type="text" class="input" placeholder="例）デモ実施" aria-label="Next Action">
          </UiFormField>
          <UiFormField label="Next Action日（任意）">
            <input v-model="form.nextActionDate" type="date" class="input" aria-label="Next Action日">
          </UiFormField>
        </div>
        <!-- 参考リンク（改修依頼 2026-08-19 第4弾。改善要望と同じ部品を再利用 = 原則3） -->
        <ImprovementsLinkEditor v-model:links="form.links" />
      </div>

      <template #footer>
        <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
          <button type="button" class="btn btn-danger btn-sm" @click="onArchive(selected)">取り消す</button>
          <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
        </div>
        <div v-else class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : mode === 'create' ? '登録' : '更新' }}
          </button>
        </div>
      </template>
    </UiDrawer>
  </div>
</template>
