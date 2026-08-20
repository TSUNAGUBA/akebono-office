<script setup lang="ts">
/**
 * サポート活動パネル（改修依頼 2026-08-18・F-43）。
 * 受付日時・顧客・問い合わせ内容・対応/原因/解決・改善ナレッジのタネを記録・一覧・編集・取消/復元する。
 * - チーム共有の記録系: 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログ）。
 * - 一覧は useListView（1 ページ 20 件。モック = クライアント / API = サーバーページング）+ UiPagination。
 * - 顧客(会社)は UiCombobox（未登録名は保存時にマスタへ新規登録 = 顧客活動と同じ導線）。
 * - 取消（論理削除）+ 復元（原則9.5）。
 */
import { Plus, RefreshCw, RotateCcw } from 'lucide-vue-next'
import {
  SUPPORT_ACTIVITY_BODY_TEMPLATE, SUPPORT_ACTIVITY_CATEGORIES, SUPPORT_ACTIVITY_PRIORITIES,
  SUPPORT_ACTIVITY_STATUSES, SUPPORT_FIRST_CONTACT_METHODS,
} from '../../../../shared/domain/types'
import type { Company, Member, SupportActivity, Village } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const sup = useSupportActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()

const members = tbl('members')
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const villages = computed(() => (tbl('villages').value as Village[]).filter(v => v.active))

function companyName(id: string): string {
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id
}
function villageName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('villages').value as Village[]).find(v => v.id === id)?.name ?? ''
}
const villageOptions = computed(() => villages.value.map(v => ({ value: v.id, label: v.name })))
const firstContactMethodOptions = SUPPORT_FIRST_CONTACT_METHODS.map(v => ({ value: v, label: v }))
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
/** 受付日時の表示（時刻は任意） */
function fmtWhen(r: SupportActivity): string {
  const date = r.receivedDate.replace(/-/g, '/')
  return r.receivedTime ? `${date} ${r.receivedTime}` : date
}
function fmtCompleted(r: SupportActivity): string {
  if (!r.completedDate) return '—'
  const date = r.completedDate.replace(/-/g, '/')
  return r.completedTime ? `${date} ${r.completedTime}` : date
}

// ---------- 一覧（検索 + フィルタ + ページング。デュアルモード） ----------

const statusFilter = ref('')
const categoryFilter = ref('')
const statusOptions = SUPPORT_ACTIVITY_STATUSES.map(v => ({ value: v, label: v }))
const categoryOptions = SUPPORT_ACTIVITY_CATEGORIES.map(v => ({ value: v, label: v }))
const priorityOptions = SUPPORT_ACTIVITY_PRIORITIES.map(v => ({ value: v, label: v }))

const filterPredicate = computed(() => (r: SupportActivity): boolean => {
  if (statusFilter.value && r.status !== statusFilter.value) return false
  if (categoryFilter.value && r.category !== categoryFilter.value) return false
  return true
})
/** サーバーモードのフィルタパラメータ（f.active = 有効のみ。取消済みは下部の専用セクション） */
const filterParams = computed(() => {
  const p: Record<string, string> = { 'f.active': 'true' }
  if (statusFilter.value) p['f.status'] = statusFilter.value
  if (categoryFilter.value) p['f.category'] = categoryFilter.value
  return p
})

const lv = useListView<SupportActivity>({
  source: computed(() => sup.list()),
  // クライアント検索の対象はサーバー searchCols（件名/内容/顧客名/問い合わせ者/対象システム）と揃える
  match: (r, q) => [r.title, r.body, companyName(r.companyId), r.inquirerName, r.targetSystem]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => apiListPage<SupportActivity>('supportActivities', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'when', label: '受付日時', primary: true, width: '130px' },
  { key: 'companyName', label: '顧客', primary: true },
  { key: 'title', label: '件名', primary: true },
  { key: 'category', label: '種別', width: '72px' },
  { key: 'priority', label: '優先度', width: '80px' },
  { key: 'status', label: 'ステータス', primary: true, width: '110px' },
  { key: 'staffName', label: '担当', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    when: fmtWhen(r),
    companyName: companyName(r.companyId),
    staffName: memberName(r.staffMemberId),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): SupportActivity {
  return row as unknown as SupportActivity
}

// ---------- 詳細・編集（ドロワー） ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<SupportActivity | null>(() => {
  if (!selectedId.value) return null
  return sup.list().find(r => r.id === selectedId.value)
    ?? sup.archivedList().find(r => r.id === selectedId.value)
    ?? (lv.rows.value.find(r => r.id === selectedId.value) ?? null)
})
const saving = ref(false)

const drawerTitle = computed(() =>
  mode.value === 'create' ? 'サポート活動を登録' : mode.value === 'edit' ? 'サポート活動を編集' : 'サポート活動の詳細')

const form = ref({
  villageId: '',
  villageText: '',
  receivedDate: '',
  receivedTime: '',
  firstContactMethod: '',
  companyId: '',
  companyText: '',
  inquirerName: '',
  targetSystem: '',
  targetLocation: '',
  category: '',
  title: '',
  body: '',
  priority: '通常',
  status: '未対応',
  staffMemberId: '',
  response: '',
  cause: '',
  resolution: '',
  completedDate: '',
  completedTime: '',
  knowledgeNote: '',
  links: [] as string[],
})

const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))
const staffOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

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
    receivedDate: todayJst(),
    receivedTime: '',
    firstContactMethod: '',
    companyId: '',
    companyText: '',
    inquirerName: '',
    targetSystem: '',
    targetLocation: '',
    category: '',
    title: '',
    // 問い合わせ内容はテンプレ既定（改修依頼 2026-08-19 第4弾）
    body: SUPPORT_ACTIVITY_BODY_TEMPLATE,
    priority: '通常',
    status: '未対応',
    staffMemberId: currentUserId.value,
    response: '',
    cause: '',
    resolution: '',
    completedDate: '',
    completedTime: '',
    knowledgeNote: '',
    links: [],
  }
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const s = selected.value
  if (!s) return
  form.value = {
    villageId: s.villageId ?? '',
    villageText: villageName(s.villageId),
    receivedDate: s.receivedDate,
    receivedTime: s.receivedTime ?? '',
    firstContactMethod: s.firstContactMethod ?? '',
    companyId: s.companyId,
    companyText: companyName(s.companyId),
    inquirerName: s.inquirerName,
    targetSystem: s.targetSystem,
    targetLocation: s.targetLocation ?? '',
    category: s.category,
    title: s.title,
    body: s.body,
    priority: s.priority,
    status: s.status,
    staffMemberId: s.staffMemberId,
    response: s.response,
    cause: s.cause,
    resolution: s.resolution,
    completedDate: s.completedDate ?? '',
    completedTime: s.completedTime ?? '',
    knowledgeNote: s.knowledgeNote,
    links: [...(s.links ?? [])],
  }
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await sup.save(mode.value === 'edit' ? selectedId.value : null, {
      villageId: form.value.villageId,
      newVillageName: form.value.villageId ? '' : form.value.villageText,
      receivedDate: form.value.receivedDate,
      receivedTime: form.value.receivedTime || null,
      firstContactMethod: form.value.firstContactMethod,
      companyId: form.value.companyId,
      newCompanyName: form.value.companyId ? '' : form.value.companyText,
      inquirerName: form.value.inquirerName,
      targetSystem: form.value.targetSystem,
      targetLocation: form.value.targetLocation,
      category: form.value.category,
      title: form.value.title,
      body: form.value.body,
      priority: form.value.priority,
      status: form.value.status,
      staffMemberId: form.value.staffMemberId || currentUserId.value,
      response: form.value.response,
      cause: form.value.cause,
      resolution: form.value.resolution,
      completedDate: form.value.completedDate || null,
      completedTime: form.value.completedTime || null,
      knowledgeNote: form.value.knowledgeNote,
      links: form.value.links,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    const created = mode.value === 'create'
    show(created ? 'サポート活動を登録しました' : 'サポート活動を更新しました')
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
const archived = computed(() => sup.archivedList())

async function onArchive(r: SupportActivity): Promise<void> {
  const ok = await confirm.ask(
    'サポート活動の取消',
    `「${r.title}」を取り消しますか？（一覧から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await sup.archive(r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerOpen.value = false
  show('取り消しました', 'warn')
  lv.refresh()
}

async function onRestore(r: SupportActivity): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await sup.restore(r.id)
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
    { label: '受付日時', value: fmtWhen(s) },
    { label: '最初の問い合わせ手段', value: s.firstContactMethod || '—' },
    { label: '顧客', value: companyName(s.companyId) },
    { label: '問い合わせ者', value: s.inquirerName || '—' },
    { label: '対象システム、対象箇所', value: [s.targetSystem, s.targetLocation].filter(Boolean).join(' / ') || '—' },
    { label: '問い合わせ種別', value: s.category },
    { label: '件名', value: s.title },
    { label: '問い合わせ内容', value: s.body },
    { label: '優先度', value: s.priority },
    { label: 'ステータス', value: s.status },
    { label: '自社担当者', value: memberName(s.staffMemberId) },
    { label: '対応内容', value: s.response || '—' },
    { label: '原因', value: s.cause || '—' },
    { label: '解決内容', value: s.resolution || '—' },
    { label: '完了日時', value: fmtCompleted(s) },
    { label: '改善・ナレッジのタネ', value: s.knowledgeNote || '—' },
    { label: '参考リンク', value: (s.links ?? []).join('\n') || '—' },
    { label: '記録者', value: memberName(s.memberId) },
  ]
})
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="lv.query.value" placeholder="件名・内容・顧客名で検索" />
      <UiSelect v-model="statusFilter" :options="statusOptions" empty-label="すべてのステータス" aria-label="ステータスで絞り込み" class="w-auto" />
      <UiSelect v-model="categoryFilter" :options="categoryOptions" empty-label="すべての種別" aria-label="問い合わせ種別で絞り込み" class="w-auto" />
      <template #trailing>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="sup.refresh(); lv.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          登録する
        </button>
      </template>
    </UiFilterBar>

    <UiSectionCard :title="`サポート活動一覧（${lv.total.value}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当するサポート活動がありません"
        empty-hint="「登録する」から問い合わせの受付を記録できます"
        @row-click="openDetail"
      >
        <template #cell-priority="{ row }">
          <UiStatusBadge :label="asRow(row).priority" :tone="SUPPORT_PRIORITY_TONES[asRow(row).priority] ?? 'neutral'" />
        </template>
        <template #cell-status="{ row }">
          <UiStatusBadge :label="asRow(row).status" :tone="SUPPORT_STATUS_TONES[asRow(row).status] ?? 'neutral'" dot />
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
            <span class="num text-[11px] text-muted">{{ fmtWhen(r) }}</span>
            <span class="text-[13px] text-muted line-through">{{ r.title }}</span>
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
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="受付日" required>
            <input v-model="form.receivedDate" type="date" class="input" aria-label="受付日" required>
          </UiFormField>
          <UiFormField label="受付時刻">
            <input v-model="form.receivedTime" type="time" class="input" aria-label="受付時刻">
          </UiFormField>
        </div>
        <!-- 最初の問い合わせ手段（任意。改修依頼 2026-08-19 第4弾） -->
        <UiFormField label="最初の問い合わせ手段">
          <UiSelect v-model="form.firstContactMethod" :options="firstContactMethodOptions" empty-label="選択してください" aria-label="最初の問い合わせ手段" />
        </UiFormField>
        <!-- 顧客・問い合わせ者を横並び（改修依頼 2026-08-19 第4弾） -->
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
          <UiFormField label="問い合わせ者">
            <input v-model="form.inquirerName" type="text" class="input" placeholder="例）山田様" aria-label="問い合わせ者">
          </UiFormField>
        </div>
        <!-- 対象システム、対象箇所（改修依頼 2026-08-19 第4弾で 2 項目化） -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="対象システム">
            <input v-model="form.targetSystem" type="text" class="input" placeholder="例）在庫管理システム" aria-label="対象システム">
          </UiFormField>
          <UiFormField label="対象箇所">
            <input v-model="form.targetLocation" type="text" class="input" placeholder="例）取込画面" aria-label="対象箇所">
          </UiFormField>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UiFormField label="問い合わせ種別" required>
            <UiSelect v-model="form.category" :options="categoryOptions" empty-label="選択してください" aria-label="問い合わせ種別" />
          </UiFormField>
          <UiFormField label="優先度" required>
            <UiSelect v-model="form.priority" :options="priorityOptions" aria-label="優先度" />
          </UiFormField>
          <UiFormField label="ステータス" required>
            <UiSelect v-model="form.status" :options="statusOptions" aria-label="ステータス" />
          </UiFormField>
        </div>
        <UiFormField label="件名" required>
          <input v-model="form.title" type="text" class="input" placeholder="例）CSVが取り込めない" aria-label="件名">
        </UiFormField>
        <UiFormField label="問い合わせ内容" required>
          <textarea v-model="form.body" class="textarea min-h-20" placeholder="問い合わせの内容・状況" aria-label="問い合わせ内容" />
        </UiFormField>
        <UiFormField label="自社担当者" required hint="既定はログインユーザー">
          <UiSelect v-model="form.staffMemberId" :options="staffOptions" aria-label="自社担当者" />
        </UiFormField>
        <UiFormField label="対応内容">
          <textarea v-model="form.response" class="textarea min-h-16" placeholder="実施した対応" aria-label="対応内容" />
        </UiFormField>
        <UiFormField label="原因">
          <textarea v-model="form.cause" class="textarea min-h-16" placeholder="判明した原因" aria-label="原因" />
        </UiFormField>
        <UiFormField label="解決内容">
          <textarea v-model="form.resolution" class="textarea min-h-16" placeholder="解決に至った内容" aria-label="解決内容" />
        </UiFormField>
        <!-- 完了時刻は除外（改修依頼 2026-08-19 第4弾）。完了日のみ -->
        <UiFormField label="完了日">
          <input v-model="form.completedDate" type="date" class="input" aria-label="完了日">
        </UiFormField>
        <UiFormField label="改善・ナレッジのタネ" hint="再発防止・自動化のアイデアなど">
          <textarea v-model="form.knowledgeNote" class="textarea min-h-16" placeholder="例）日付形式を自動変換できないか" aria-label="改善・ナレッジのタネ" />
        </UiFormField>
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
