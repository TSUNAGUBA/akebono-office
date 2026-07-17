<script setup lang="ts">
/**
 * ワークフロー・稟議（F-07）
 * タブ: 自分の申請 / 承認待ち / 全件（管理者） / 経路設定（管理者）。?tab= で初期タブ指定可。
 * 職務権限マトリクス（区分×金額帯）により承認経路が金額でリアルタイムに変わる。
 */
import { Paperclip, Pencil, Plus, Send, X } from 'lucide-vue-next'
import type {
  ApprovalAction, DelegateSetting, WorkflowCategory, WorkflowRequest,
  WorkflowRoute, WorkflowRouteStep,
} from '~/types/domain'
import { addDays, fmtDateTime, fmtYen } from '~/utils/format'
import {
  APPROVAL_ACTION_LABELS, WORKFLOW_CATEGORY_LABELS, WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_TONES,
} from '~/utils/labels'
import type { TabItem, TableColumn, Tone } from '~/types/ui'

const route = useRoute()
const { currentUserId, isAdmin } = useCurrentUser()
const wf = useWorkflow()

// サーバー側で進んだ申請・承認（他者の操作）を表示時に取り込む
onMounted(() => { void wf.refresh() })
const { show } = useToast()
const { ask } = useConfirm()
const { tbl } = useMockDb()
// 申請一覧はデュアルモードのバッキング（API モード: /v1/workflows キャッシュ）を必ず経由する
const requests = wf.requests
const members = tbl('members')
const routesCrud = useMasterCrudAsync('workflowRoutes', 'wr')

// ---------- タブ ----------

const pendingRows = computed(() => wf.pendingFor(currentUserId.value))

const tabs = computed<TabItem[]>(() => {
  const t: TabItem[] = [
    { key: 'mine', label: '自分の申請' },
    { key: 'pending', label: '承認待ち', badge: pendingRows.value.length },
  ]
  if (isAdmin.value) {
    t.push({ key: 'all', label: '全件' })
    t.push({ key: 'routes', label: '経路設定' })
  }
  return t
})
const queryTab = typeof route.query.tab === 'string' ? route.query.tab : ''
const tab = ref<string>(['mine', 'pending', 'all', 'routes'].includes(queryTab) ? queryTab : 'mine')
watchEffect(() => {
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = 'mine'
})

// ---------- 一覧 ----------

const q = ref('')
const statusFilter = ref('')
const statusOptions = Object.entries(WORKFLOW_STATUS_LABELS).map(([value, label]) => ({ value, label }))

const myRequests = computed(() =>
  requests.value
    .filter(r => r.requesterId === currentUserId.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

const allRequests = computed(() =>
  [...requests.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

const listRows = computed<WorkflowRequest[]>(() => {
  const base = tab.value === 'pending' ? pendingRows.value : tab.value === 'all' ? allRequests.value : myRequests.value
  return base.filter(r =>
    (!statusFilter.value || r.status === statusFilter.value)
    && (!q.value.trim() || r.title.includes(q.value.trim()) || r.id.includes(q.value.trim())))
})

const columns: TableColumn[] = [
  { key: 'id', label: '決裁番号', width: '110px' },
  { key: 'title', label: '件名', primary: true },
  { key: 'category', label: '区分', width: '80px' },
  { key: 'amount', label: '金額', width: '110px', align: 'right', primary: true },
  { key: 'status', label: '状態', width: '96px', primary: true },
  { key: 'requester', label: '申請者', width: '110px' },
  { key: 'createdAt', label: '申請日時', width: '120px' },
]

const tableRows = computed(() => listRows.value.map(r => ({
  id: r.id,
  title: r.title,
  category: WORKFLOW_CATEGORY_LABELS[r.category],
  amount: r.amount,
  status: r.status,
  requester: wf.memberName(r.requesterId),
  createdAt: r.createdAt,
})))

function rowYen(row: Record<string, unknown>): string {
  return fmtYen(Number(row.amount ?? 0))
}
function rowDate(row: Record<string, unknown>): string {
  return fmtDateTime(String(row.createdAt ?? ''))
}
function rowStatusTone(row: Record<string, unknown>): Tone {
  return WORKFLOW_STATUS_TONES[row.status as keyof typeof WORKFLOW_STATUS_TONES] ?? 'neutral'
}
function rowStatusLabel(row: Record<string, unknown>): string {
  return WORKFLOW_STATUS_LABELS[row.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? String(row.status)
}

const emptyTitles: Record<string, string> = {
  mine: '申請はまだありません',
  pending: '承認待ちの申請はありません',
  all: '申請がありません',
}

// ---------- 詳細ドロワー ----------

const selectedId = ref<string | null>(null)
const selectedReq = computed(() => selectedId.value ? wf.byId(selectedId.value) ?? null : null)

function openRow(row: Record<string, unknown>): void {
  selectedId.value = String(row.id ?? '')
}

const canAct = computed(() => {
  const r = selectedReq.value
  return !!r && wf.canActOn(r, currentUserId.value)
})
const actingDelegateFor = computed(() => {
  const r = selectedReq.value
  if (!r || !canAct.value) return null
  const approver = wf.currentApproverOf(r)
  return approver && approver.id !== currentUserId.value ? approver.name : null
})
const canWithdraw = computed(() => {
  const r = selectedReq.value
  return !!r && r.requesterId === currentUserId.value
    && (r.status === 'in_review' || r.status === 'submitted')
})
const canResubmit = computed(() => {
  const r = selectedReq.value
  return !!r && r.requesterId === currentUserId.value
    && (r.status === 'remanded' || r.status === 'draft')
})
const hasFooterActions = computed(() => canAct.value || canWithdraw.value || canResubmit.value)

const ACTION_TONES: Record<ApprovalAction, Tone> = {
  submit: 'info', approve: 'ok', reject: 'crit', remand: 'warn', withdraw: 'neutral',
}

async function onApprove(): Promise<void> {
  const r = selectedReq.value
  if (!r) return
  const ok = await ask('承認', `「${r.title}」（${fmtYen(r.amount)}）を承認しますか？`, { confirmLabel: '承認' })
  if (!ok) return
  const res = await wf.act(r.id, 'approve')
  show(res.ok ? '承認しました' : res.error.message, res.ok ? 'ok' : 'warn')
}

async function onWithdraw(): Promise<void> {
  const r = selectedReq.value
  if (!r) return
  const ok = await ask('取下げ', `「${r.title}」を取下げますか？`, { confirmLabel: '取下げ', danger: true })
  if (!ok) return
  const res = await wf.act(r.id, 'withdraw')
  show(res.ok ? '申請を取下げました' : res.error.message, res.ok ? 'ok' : 'warn')
}

// 却下・差戻しコメントモーダル
const commentAction = ref<'reject' | 'remand' | null>(null)
const commentBody = ref('')

function openCommentModal(action: 'reject' | 'remand'): void {
  commentAction.value = action
  commentBody.value = ''
}

async function onCommentSubmit(): Promise<void> {
  const r = selectedReq.value
  const action = commentAction.value
  if (!r || !action) return
  const res = await wf.act(r.id, action, commentBody.value)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(action === 'reject' ? '却下しました' : '差戻しました')
  commentAction.value = null
}

// ---------- 申請作成・編集モーダル ----------

const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const editingReq = computed(() => editingId.value ? wf.byId(editingId.value) : undefined)
const canSaveDraftInModal = computed(() => !editingId.value || editingReq.value?.status === 'draft')

const form = reactive({
  category: 'purchase' as WorkflowCategory,
  title: '',
  amount: 0,
  body: '',
  attachments: [] as string[],
})
const attachName = ref('')

const categoryOptions = Object.entries(WORKFLOW_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))
const categoryModel = computed({
  get: () => form.category as string,
  set: (v: string) => { form.category = v as WorkflowCategory },
})

const previewFlow = computed(() =>
  wf.previewSteps(form.category, Number.isFinite(form.amount) ? form.amount : 0))

function openCreate(): void {
  editingId.value = null
  form.category = 'purchase'
  form.title = ''
  form.amount = 0
  form.body = ''
  form.attachments = []
  attachName.value = ''
  modalOpen.value = true
}

function openEdit(req: WorkflowRequest): void {
  editingId.value = req.id
  form.category = req.category
  form.title = req.title
  form.amount = req.amount
  form.body = req.body
  form.attachments = [...req.attachments]
  attachName.value = ''
  modalOpen.value = true
}

function addAttachment(): void {
  const name = attachName.value.trim()
  if (!name) return
  form.attachments = [...form.attachments, name.includes('.') ? name : `${name}.pdf`]
  attachName.value = ''
}

function removeAttachment(i: number): void {
  form.attachments = form.attachments.filter((_, idx) => idx !== i)
}

function wfPayload() {
  return {
    category: form.category,
    title: form.title,
    amount: Number(form.amount) || 0,
    body: form.body,
    attachments: [...form.attachments],
  }
}

async function onModalSubmit(): Promise<void> {
  // submit() が status を書き換える前に元の状態を退避（再申請判定は元 status で行う）
  const wasRemanded = editingReq.value?.status === 'remanded'
  const res = await wf.submit(wfPayload(), editingId.value ?? undefined)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show(wasRemanded ? '再申請しました' : '申請を提出しました')
  modalOpen.value = false
  selectedId.value = res.id ?? null
}

async function onModalDraft(): Promise<void> {
  const res = await wf.saveDraft(wfPayload(), editingId.value ?? undefined)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show('下書きを保存しました')
  modalOpen.value = false
}

// ---------- 経路設定タブ（管理者） ----------

const routeGroups = computed(() =>
  (Object.keys(WORKFLOW_CATEGORY_LABELS) as WorkflowCategory[]).map(category => ({
    category,
    label: WORKFLOW_CATEGORY_LABELS[category],
    routes: routesCrud.list.value
      .filter(r => r.category === category)
      .sort((a, b) => a.minAmount - b.minAmount),
  })))

function bandLabel(r: WorkflowRoute): string {
  return r.maxAmount === null
    ? `${fmtYen(r.minAmount)} 以上`
    : `${fmtYen(r.minAmount)} 〜 ${fmtYen(r.maxAmount)} 未満`
}

function sortedSteps(r: WorkflowRoute): WorkflowRouteStep[] {
  return [...r.steps].sort((a, b) => a.order - b.order)
}

const roleOptions = (Object.keys(APPROVER_ROLE_LABELS) as WorkflowRouteStep['approverRole'][])
  .map(value => ({ value, label: APPROVER_ROLE_LABELS[value] }))

const routeModalOpen = ref(false)
const routeEditingId = ref<string | null>(null)
const routeForm = reactive({
  category: 'purchase' as WorkflowCategory,
  minAmount: 0,
  steps: [] as { approverRole: WorkflowRouteStep['approverRole'] }[],
  active: true,
})
const routeMaxStr = ref('') // '' = 上限なし
const routeCategoryModel = computed({
  get: () => routeForm.category as string,
  set: (v: string) => { routeForm.category = v as WorkflowCategory },
})

function openRouteCreate(category: WorkflowCategory): void {
  routeEditingId.value = null
  routeForm.category = category
  routeForm.minAmount = 0
  routeForm.steps = [{ approverRole: 'manager' }]
  routeForm.active = true
  routeMaxStr.value = ''
  routeModalOpen.value = true
}

function openRouteEdit(r: WorkflowRoute): void {
  routeEditingId.value = r.id
  routeForm.category = r.category
  routeForm.minAmount = r.minAmount
  routeForm.steps = sortedSteps(r).map(s => ({ approverRole: s.approverRole }))
  routeForm.active = r.active
  routeMaxStr.value = r.maxAmount === null ? '' : String(r.maxAmount)
  routeModalOpen.value = true
}

function addRouteStep(): void {
  routeForm.steps.push({ approverRole: 'manager' })
}

function removeRouteStep(i: number): void {
  routeForm.steps.splice(i, 1)
}

function setStepRole(i: number, v: string): void {
  const s = routeForm.steps[i]
  if (s) s.approverRole = v as WorkflowRouteStep['approverRole']
}

async function onRouteSave(): Promise<void> {
  if (routeForm.steps.length === 0) {
    show('承認ステップを 1 つ以上設定してください', 'warn')
    return
  }
  const maxAmount = routeMaxStr.value.trim() === '' ? null : Number(routeMaxStr.value)
  if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount <= routeForm.minAmount)) {
    show('上限金額は下限金額より大きい数値にしてください', 'warn')
    return
  }
  const steps: WorkflowRouteStep[] = routeForm.steps.map((s, i) => ({
    order: i + 1,
    approverRole: s.approverRole,
    approverMemberId: null,
    mode: 'serial',
  }))
  const res = await routesCrud.save({
    ...(routeEditingId.value ? { id: routeEditingId.value } : {}),
    category: routeForm.category,
    minAmount: Number(routeForm.minAmount) || 0,
    maxAmount,
    steps,
    active: routeForm.active,
  })
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show('承認経路を保存しました')
  routeModalOpen.value = false
}

// ---------- 代理承認設定 ----------

const delegateForm = reactive({
  delegateMemberId: '',
  from: todayJst(),
  to: addDays(todayJst(), 7),
})

const delegateOptions = computed(() =>
  members.value
    .filter(m => m.active && m.id !== currentUserId.value && m.employmentType !== 'outsource')
    .map(m => ({ value: m.id, label: m.name })))

async function onSaveDelegate(): Promise<void> {
  const res = await wf.saveDelegate({ ...delegateForm })
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  show('代理承認を設定しました')
  delegateForm.delegateMemberId = ''
}

async function onRemoveDelegate(d: DelegateSetting): Promise<void> {
  const ok = await ask('代理設定の解除', `${wf.memberName(d.delegateMemberId)} さんへの代理設定を解除しますか？`, { confirmLabel: '解除', danger: true })
  if (!ok) return
  const res = await wf.removeDelegate(d.id)
  show(res.ok ? '代理設定を解除しました' : res.error.message, res.ok ? 'ok' : 'warn')
}
</script>

<template>
  <div>
    <UiPageHeader title="ワークフロー・稟議" description="職務権限マトリクス（区分×金額）で承認経路が自動決定されます">
      <template #actions>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <Plus class="h-4 w-4" aria-hidden="true" />
          新規申請
        </button>
      </template>
    </UiPageHeader>

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ================= 一覧タブ（自分の申請 / 承認待ち / 全件） ================= -->
    <div v-if="tab !== 'routes'" class="grid gap-3">
      <UiFilterBar>
        <UiSearchInput v-model="q" placeholder="件名・決裁番号で検索" />
        <UiSelect v-model="statusFilter" :options="statusOptions" empty-label="すべての状態" aria-label="状態フィルタ" />
        <template #trailing>
          <span class="num text-xs text-muted">{{ listRows.length }} 件</span>
        </template>
      </UiFilterBar>

      <UiSectionCard flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          :empty-title="emptyTitles[tab] ?? 'データがありません'"
          empty-hint="「新規申請」から稟議を作成できます"
          @row-click="openRow"
        >
          <template #cell-id="{ row }">
            <span class="num font-semibold text-brand">{{ row.id }}</span>
          </template>
          <template #cell-amount="{ row }">
            <span class="num">{{ rowYen(row) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge :tone="rowStatusTone(row)" :label="rowStatusLabel(row)" dot />
          </template>
          <template #cell-createdAt="{ row }">
            <span class="num text-sub">{{ rowDate(row) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ================= 経路設定タブ（管理者） ================= -->
    <div v-else class="grid gap-3">
      <UiSectionCard
        v-for="g in routeGroups"
        :key="g.category"
        :title="`${g.label}の承認経路`"
        flush
      >
        <template #actions>
          <button type="button" class="btn btn-sm" @click="openRouteCreate(g.category)">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
            金額帯を追加
          </button>
        </template>
        <UiEmptyState v-if="g.routes.length === 0" title="経路が未設定です" hint="この区分は申請時に AKO-WFL-003 エラーになります" />
        <ul v-else class="divide-y divide-line">
          <li v-for="r in g.routes" :key="r.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
            <span
              class="num min-w-[200px] text-[13px] font-semibold"
              :class="r.active ? '' : 'text-muted line-through'"
            >{{ bandLabel(r) }}</span>
            <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <template v-for="(s, i) in sortedSteps(r)" :key="i">
                <span v-if="i > 0" class="text-xs text-muted" aria-hidden="true">→</span>
                <span class="whitespace-nowrap rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                  {{ i + 1 }}. {{ APPROVER_ROLE_LABELS[s.approverRole] }}（{{ wf.approverFor(s.approverRole)?.name ?? '未設定' }}）
                </span>
              </template>
            </span>
            <UiStatusBadge v-if="!r.active" tone="neutral" label="無効" />
            <button type="button" class="btn btn-sm" @click="openRouteEdit(r)">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              編集
            </button>
          </li>
        </ul>
      </UiSectionCard>

      <!-- 代理承認設定 -->
      <UiSectionCard title="代理承認設定" description="不在時に自分宛ての承認を代理人が実行できます（期間が今日を含む設定のみ有効。代理実行は承認ログに記録）">
        <div class="grid gap-3">
          <ul v-if="wf.myDelegates.value.length > 0" class="grid gap-2">
            <li
              v-for="d in wf.myDelegates.value"
              :key="d.id"
              class="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
            >
              <UiAvatar :name="wf.memberName(d.delegateMemberId)" size="sm" />
              <span class="text-[13px] font-semibold">{{ wf.memberName(d.delegateMemberId) }}</span>
              <span class="num text-xs text-sub">{{ d.from }} 〜 {{ d.to }}</span>
              <UiStatusBadge
                :tone="wf.isDelegateActive(d) ? 'ok' : 'neutral'"
                :label="wf.isDelegateActive(d) ? '有効' : '期間外'"
                dot
              />
              <button type="button" class="btn btn-sm ml-auto text-crit" @click="onRemoveDelegate(d)">解除</button>
            </li>
          </ul>
          <p v-else class="text-xs text-muted">代理設定はありません</p>

          <div class="grid gap-2 rounded-lg bg-surface-soft p-3 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-end">
            <UiFormField label="代理人">
              <UiSelect v-model="delegateForm.delegateMemberId" :options="delegateOptions" empty-label="選択してください" aria-label="代理人" class="!w-full" />
            </UiFormField>
            <UiFormField label="開始日">
              <input v-model="delegateForm.from" type="date" class="input" aria-label="代理期間の開始日">
            </UiFormField>
            <UiFormField label="終了日">
              <input v-model="delegateForm.to" type="date" class="input" aria-label="代理期間の終了日">
            </UiFormField>
            <button type="button" class="btn btn-primary" :disabled="!delegateForm.delegateMemberId" @click="onSaveDelegate">設定</button>
          </div>
        </div>
      </UiSectionCard>
    </div>

    <!-- ================= 詳細ドロワー ================= -->
    <UiDrawer
      :open="!!selectedReq"
      :title="selectedReq ? `${selectedReq.id} ${selectedReq.title}` : '申請詳細'"
      width="600px"
      @close="selectedId = null"
    >
      <div v-if="selectedReq" class="grid gap-4">
        <dl class="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-3">
          <div>
            <dt class="label !mb-0.5">状態</dt>
            <dd>
              <UiStatusBadge :tone="WORKFLOW_STATUS_TONES[selectedReq.status]" :label="WORKFLOW_STATUS_LABELS[selectedReq.status]" dot />
            </dd>
          </div>
          <div>
            <dt class="label !mb-0.5">区分</dt>
            <dd class="text-[13px] font-semibold">{{ WORKFLOW_CATEGORY_LABELS[selectedReq.category] }}</dd>
          </div>
          <div>
            <dt class="label !mb-0.5">金額</dt>
            <dd class="num text-[13px] font-bold">{{ fmtYen(selectedReq.amount) }}</dd>
          </div>
          <div>
            <dt class="label !mb-0.5">申請者</dt>
            <dd class="flex items-center gap-1.5 text-[13px] font-semibold">
              <UiAvatar :name="wf.memberName(selectedReq.requesterId)" size="sm" />
              {{ wf.memberName(selectedReq.requesterId) }}
            </dd>
          </div>
          <div>
            <dt class="label !mb-0.5">申請日時</dt>
            <dd class="num text-[13px]">{{ fmtDateTime(selectedReq.createdAt) }}</dd>
          </div>
          <div>
            <dt class="label !mb-0.5">決裁番号</dt>
            <dd class="num text-[13px]">{{ selectedReq.id }}</dd>
          </div>
        </dl>

        <div>
          <p class="label">本文</p>
          <p class="whitespace-pre-wrap rounded-lg border border-line bg-surface-soft p-3 text-[13px]">{{ selectedReq.body || '—' }}</p>
        </div>

        <div>
          <p class="label">添付ファイル</p>
          <ul v-if="selectedReq.attachments.length > 0" class="flex flex-wrap gap-1.5">
            <li
              v-for="(a, i) in selectedReq.attachments"
              :key="i"
              class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs"
            >
              <Paperclip class="h-3 w-3 text-muted" aria-hidden="true" />
              {{ a }}
            </li>
          </ul>
          <p v-else class="text-xs text-muted">添付なし</p>
        </div>

        <div>
          <p class="label">承認経路</p>
          <div class="rounded-lg border border-line p-3">
            <WidgetsApprovalFlow :steps="wf.flowSteps(selectedReq)" />
            <p v-if="actingDelegateFor" class="mt-2 rounded-md bg-brand-soft px-2 py-1 text-[11px] font-semibold text-brand">
              {{ actingDelegateFor }} さんの代理として承認操作できます
            </p>
          </div>
        </div>

        <div>
          <p class="label">承認ログ</p>
          <ol v-if="wf.logsOf(selectedReq.id).length > 0" class="grid gap-2">
            <li v-for="l in wf.logsOf(selectedReq.id)" :key="l.id" class="flex items-start gap-2">
              <UiStatusBadge :tone="ACTION_TONES[l.action]" :label="APPROVAL_ACTION_LABELS[l.action]" />
              <div class="min-w-0 flex-1 text-[13px]">
                <p class="font-semibold">
                  {{ wf.memberName(l.actorId) }}
                  <span v-if="l.delegateForId" class="text-[11px] font-normal text-brand">（{{ wf.memberName(l.delegateForId) }} さんの代理）</span>
                  <span v-if="l.step > 0" class="num text-[11px] font-normal text-muted">step{{ l.step }}</span>
                </p>
                <p v-if="l.comment" class="whitespace-pre-wrap text-xs text-sub">{{ l.comment }}</p>
                <p class="num text-[10px] text-muted">{{ fmtDateTime(l.at) }}</p>
              </div>
            </li>
          </ol>
          <p v-else class="text-xs text-muted">ログはまだありません（下書き）</p>
        </div>
      </div>

      <template v-if="hasFooterActions" #footer>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button v-if="canWithdraw" type="button" class="btn text-crit" @click="onWithdraw">取下げ</button>
          <button v-if="canResubmit && selectedReq" type="button" class="btn btn-primary" @click="openEdit(selectedReq)">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            {{ selectedReq.status === 'remanded' ? '編集して再申請' : '編集して申請' }}
          </button>
          <template v-if="canAct">
            <button type="button" class="btn" @click="openCommentModal('remand')">差戻し</button>
            <button type="button" class="btn btn-danger" @click="openCommentModal('reject')">却下</button>
            <button type="button" class="btn btn-primary" @click="onApprove">承認</button>
          </template>
        </div>
      </template>
    </UiDrawer>

    <!-- ================= 申請作成・編集モーダル ================= -->
    <UiModal
      :open="modalOpen"
      :title="editingId ? (editingReq?.status === 'remanded' ? '編集して再申請' : '下書きを編集') : '新規申請'"
      width="640px"
      @close="modalOpen = false"
    >
      <div class="grid gap-3">
        <div class="grid gap-3 md:grid-cols-2">
          <UiFormField label="区分" required>
            <UiSelect v-model="categoryModel" :options="categoryOptions" aria-label="区分" class="!w-full" />
          </UiFormField>
          <UiFormField label="金額（円）" required hint="金額で承認経路が変わります">
            <input v-model.number="form.amount" type="number" min="0" step="1000" class="input num text-right" aria-label="金額">
          </UiFormField>
        </div>
        <UiFormField label="件名" required>
          <input v-model="form.title" type="text" class="input" placeholder="申請の件名">
        </UiFormField>
        <UiFormField label="本文" required>
          <textarea v-model="form.body" class="textarea" rows="4" placeholder="目的・内容・金額の根拠" />
        </UiFormField>
        <UiFormField label="添付ファイル" hint="モックのためファイル名のみ登録されます">
          <div class="flex gap-2">
            <input
              v-model="attachName"
              type="text"
              class="input flex-1"
              placeholder="例: 見積書_A社.pdf"
              aria-label="添付ファイル名"
              @keydown.enter.prevent="addAttachment"
            >
            <button type="button" class="btn" @click="addAttachment">追加</button>
          </div>
          <ul v-if="form.attachments.length > 0" class="mt-2 flex flex-wrap gap-1.5">
            <li
              v-for="(a, i) in form.attachments"
              :key="i"
              class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs"
            >
              <Paperclip class="h-3 w-3 text-muted" aria-hidden="true" />
              {{ a }}
              <button type="button" class="text-muted hover:text-crit" :aria-label="`${a} を削除`" @click="removeAttachment(i)">
                <X class="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </UiFormField>

        <div class="rounded-lg border border-line bg-surface-soft p-3">
          <p class="mb-2 text-xs font-bold text-sub">承認経路プレビュー</p>
          <WidgetsApprovalFlow v-if="previewFlow" :steps="previewFlow" />
          <p v-else class="text-xs font-semibold text-crit">
            この区分・金額に該当する承認経路がありません（AKO-WFL-003）。経路設定を確認してください
          </p>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="modalOpen = false">キャンセル</button>
        <button v-if="canSaveDraftInModal" type="button" class="btn" @click="onModalDraft">下書き保存</button>
        <button type="button" class="btn btn-primary" :disabled="!previewFlow || !form.title.trim()" @click="onModalSubmit">
          <Send class="h-3.5 w-3.5" aria-hidden="true" />
          {{ editingReq?.status === 'remanded' ? '再申請する' : '申請する' }}
        </button>
      </template>
    </UiModal>

    <!-- ================= 却下・差戻しコメントモーダル ================= -->
    <UiModal
      :open="commentAction !== null"
      :title="commentAction === 'reject' ? '却下コメント' : '差戻しコメント'"
      @close="commentAction = null"
    >
      <UiFormField label="コメント" required hint="却下・差戻しにはコメントの入力が必要です（AKO-WFL-002）">
        <textarea v-model="commentBody" class="textarea" rows="4" placeholder="理由・修正してほしい点" />
      </UiFormField>
      <template #footer>
        <button type="button" class="btn" @click="commentAction = null">キャンセル</button>
        <button
          type="button"
          :class="commentAction === 'reject' ? 'btn btn-danger' : 'btn btn-primary'"
          :disabled="!commentBody.trim()"
          @click="onCommentSubmit"
        >
          {{ commentAction === 'reject' ? '却下する' : '差戻す' }}
        </button>
      </template>
    </UiModal>

    <!-- ================= 経路編集モーダル ================= -->
    <UiModal
      :open="routeModalOpen"
      :title="routeEditingId ? '承認経路を編集' : '承認経路を追加'"
      @close="routeModalOpen = false"
    >
      <div class="grid gap-3">
        <UiFormField label="区分" required>
          <UiSelect v-model="routeCategoryModel" :options="categoryOptions" aria-label="経路の区分" class="!w-full" />
        </UiFormField>
        <div class="grid gap-3 md:grid-cols-2">
          <UiFormField label="下限金額（円）" required hint="この金額以上で適用">
            <input v-model.number="routeForm.minAmount" type="number" min="0" step="10000" class="input num text-right" aria-label="下限金額">
          </UiFormField>
          <UiFormField label="上限金額（円）" hint="空欄で上限なし（未満判定）">
            <input v-model="routeMaxStr" type="number" min="0" step="10000" class="input num text-right" placeholder="上限なし" aria-label="上限金額">
          </UiFormField>
        </div>
        <UiFormField label="承認ステップ" required hint="上から順に直列承認されます">
          <div class="grid gap-2">
            <div v-for="(s, i) in routeForm.steps" :key="i" class="flex items-center gap-2">
              <span class="num w-6 text-center text-xs font-bold text-muted">{{ i + 1 }}</span>
              <UiSelect
                :model-value="s.approverRole"
                :options="roleOptions"
                :aria-label="`ステップ${i + 1} の承認ロール`"
                class="flex-1"
                @update:model-value="setStepRole(i, $event)"
              />
              <span class="text-xs text-sub">{{ wf.approverFor(s.approverRole)?.name ?? '未設定' }}</span>
              <button type="button" class="btn btn-sm text-crit" :aria-label="`ステップ${i + 1} を削除`" @click="removeRouteStep(i)">
                <X class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div>
              <button type="button" class="btn btn-sm" @click="addRouteStep">
                <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                ステップを追加
              </button>
            </div>
          </div>
        </UiFormField>
        <label class="flex items-center gap-2 text-[13px]">
          <input v-model="routeForm.active" type="checkbox" class="h-4 w-4 accent-[var(--c-brand)]">
          この経路を有効にする
        </label>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="routeModalOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="onRouteSave">保存</button>
      </template>
    </UiModal>
  </div>
</template>
