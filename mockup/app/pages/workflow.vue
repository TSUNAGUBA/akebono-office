<script setup lang="ts">
/**
 * 稟議（F-07。旧称ワークフロー = オペレーター指示 2026-07-22 で改名）
 * タブ: 自分の申請 / 承認待ち / 全件（管理者） / 経路設定（管理者）。?tab= で初期タブ指定可。
 * 職務権限マトリクス（区分×金額帯）により承認経路が金額でリアルタイムに変わる。
 * 申請の本文は「目的」「内容」に分割（旧データの body は互換表示）。内容は区分別テンプレートを呼び出せる。
 */
import { Download, FileText, Paperclip, Pencil, Plus, Send, X } from 'lucide-vue-next'
import type {
  ApprovalAction, DelegateSetting, WorkflowCategory, WorkflowFile, WorkflowRequest,
  WorkflowRoute, WorkflowRouteStep,
} from '~/types/domain'
import { addDays, fmtDateTime, fmtYen } from '~/utils/format'
import {
  approverTargetLabel, APPROVAL_ACTION_LABELS, WORKFLOW_CATEGORY_LABELS, WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_TONES,
} from '~/utils/labels'
import { workflowTemplatesFor } from '~/utils/workflow-templates'
import type { ApproverStepForm } from '~/components/widgets/ApproverSteps.vue'
import type { TabItem, TableColumn, Tone } from '~/types/ui'

const route = useRoute()
const { currentUserId, isAdmin } = useCurrentUser()
const wf = useWorkflow()
const isApi = useApiMode()

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

/** 実ファイルと重複しない名前のみ添付（旧データ・モックの表示分） */
const selectedNameOnlyAttachments = computed(() => {
  const r = selectedReq.value
  if (!r) return []
  const fileNames = new Set(wf.filesOf(r.id).map(f => f.filename))
  return r.attachments.filter(a => !fileNames.has(a))
})

async function onDownloadFile(f: WorkflowFile): Promise<void> {
  const res = await wf.downloadFile(f)
  if (!res.ok) show(res.error.message, 'warn')
}

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
  purpose: '',
  content: '',
  attachments: [] as string[],
})
/** 新規アップロード（API モード = 実ファイル。監査指摘 2026-07-30 ②） */
const newFiles = ref<File[]>([])
/** 編集中に取り外した既存添付（API モード。keepFileIds の除外分） */
const removedFileIds = ref<string[]>([])
/**
 * 既存添付一覧のロード成否（API モードの編集時）。false のまま保存すると keepFileIds が
 * 空扱いになり既存添付を意図せず削除するため、false のときは添付同期を送らない（原則7）
 */
const filesReady = ref(true)
const fileInput = ref<HTMLInputElement | null>(null)
const MAX_WF_FILES = 5

/** 編集中申請の既存実ファイル（取り外し済みを除く。遅延ロードに追従する computed） */
const existingFiles = computed<WorkflowFile[]>(() =>
  editingId.value ? wf.filesOf(editingId.value).filter(f => !removedFileIds.value.includes(f.id)) : [])

/** 名前のみの添付（実ファイルと重複しない表示分。旧データ・モックの互換） */
const nameOnlyAttachments = computed(() => {
  const fileNames = new Set([
    ...existingFiles.value.map(f => f.filename),
    ...newFiles.value.map(f => f.name),
  ])
  return form.attachments.filter(a => !fileNames.has(a))
})

// ---------- 内容テンプレート（区分別 + 標準。utils/workflow-templates.ts が SoT） ----------

const templateKey = ref('')
const templateOptions = computed(() =>
  workflowTemplatesFor(form.category).map(t => ({ value: t.key, label: t.label })))
// 区分を切り替えたら選択中テンプレートをリセット（区分外のキーを残さない）
watch(() => form.category, () => { templateKey.value = '' })

/** テンプレートを「内容」へ挿入する（既存の入力があれば上書き確認 = 黙って消さない） */
async function applyTemplate(): Promise<void> {
  const tpl = workflowTemplatesFor(form.category).find(t => t.key === templateKey.value)
  if (!tpl) return
  if (form.content.trim()) {
    const ok = await ask('テンプレートの呼び出し', '入力済みの「内容」をテンプレートで置き換えます。よろしいですか？', { confirmLabel: '置き換える' })
    if (!ok) return
  }
  form.content = tpl.body
}

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
  form.purpose = ''
  form.content = ''
  form.attachments = []
  newFiles.value = []
  removedFileIds.value = []
  filesReady.value = true
  templateKey.value = ''
  modalOpen.value = true
}

function openEdit(req: WorkflowRequest): void {
  editingId.value = req.id
  form.category = req.category
  form.title = req.title
  form.amount = req.amount
  // 旧データ（本文のみ）は内容へ読み込んで編集を続けられるようにする（原則7）。
  // API モードは migration 0029 の DEFAULT '' により旧行の content が空文字列で返るため、
  // nullish（??）ではなく falsy（||）で本文へフォールバックする（?? だと旧本文が消失する）
  form.purpose = req.purpose || ''
  form.content = req.content || req.body || ''
  form.attachments = [...req.attachments]
  newFiles.value = []
  removedFileIds.value = []
  templateKey.value = ''
  modalOpen.value = true
  // 既存添付一覧を確定ロードしてから添付編集を有効化（keepFileIds の空送信 = 全削除事故を防ぐ）
  if (isApi) {
    filesReady.value = false
    void wf.loadFiles(req.id).then((ok) => {
      filesReady.value = ok
      if (!ok) show('添付情報を取得できませんでした。今回の保存では添付は変更されません', 'warn')
    })
  } else {
    filesReady.value = true
  }
}

/** ファイル選択（API = 実体を保持して送信 / モック = ファイル名のみ登録 = ドキュメント管理と同方針） */
function onFilePick(e: Event): void {
  const input = e.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  input.value = '' // 同じファイルの再選択を許す
  for (const f of picked) {
    if (isApi) {
      if (existingFiles.value.length + newFiles.value.length >= MAX_WF_FILES) {
        show(`添付は ${MAX_WF_FILES} 件までです`, 'warn')
        return
      }
      if (f.size > 10 * 1024 * 1024) {
        show(`${f.name} は 10MB を超えているため添付できません`, 'warn')
        continue
      }
      newFiles.value = [...newFiles.value, f]
    } else if (!form.attachments.includes(f.name)) {
      form.attachments = [...form.attachments, f.name]
    }
  }
}

function removeNewFile(i: number): void {
  newFiles.value = newFiles.value.filter((_, idx) => idx !== i)
}

/** 既存実ファイルの取り外し（保存時に keepFileIds から除外 → サーバーが削除） */
function removeExistingFile(id: string): void {
  removedFileIds.value = [...removedFileIds.value, id]
}

function removeAttachment(name: string): void {
  // 同名の名前のみ添付が複数ある場合に両方消さない（最初の 1 件のみ取り外す）
  const idx = form.attachments.indexOf(name)
  if (idx >= 0) form.attachments = form.attachments.filter((_, i) => i !== idx)
}

function wfPayload() {
  return {
    category: form.category,
    title: form.title,
    amount: Number(form.amount) || 0,
    purpose: form.purpose,
    content: form.content,
    attachments: [...form.attachments],
    // filesReady でない間は添付同期を送らない（サーバーは files/keepFileIds 未指定なら実体に触れない = 原則7）
    ...(isApi && filesReady.value
      ? { newFiles: [...newFiles.value], keepFileIds: existingFiles.value.map(f => f.id) }
      : {}),
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

const routeModalOpen = ref(false)
const routeEditingId = ref<string | null>(null)
const routeForm = reactive({
  category: 'purchase' as WorkflowCategory,
  minAmount: 0,
  steps: [] as ApproverStepForm[],
  active: true,
})
const routeMaxStr = ref('') // '' = 上限なし
const routeCategoryModel = computed({
  get: () => routeForm.category as string,
  set: (v: string) => { routeForm.category = v as WorkflowCategory },
})

/** 新規ステップの既定（ロール=管理者） */
function defaultStep(): ApproverStepForm {
  return { approverType: 'role', approverRole: 'admin', approverTitle: null, approverMemberId: null }
}

function openRouteCreate(category: WorkflowCategory): void {
  routeEditingId.value = null
  routeForm.category = category
  routeForm.minAmount = 0
  routeForm.steps = [defaultStep()]
  routeForm.active = true
  routeMaxStr.value = ''
  routeModalOpen.value = true
}

function openRouteEdit(r: WorkflowRoute): void {
  routeEditingId.value = r.id
  routeForm.category = r.category
  routeForm.minAmount = r.minAmount
  routeForm.steps = sortedSteps(r).map(s => ({
    approverType: s.approverType, approverRole: s.approverRole,
    approverTitle: s.approverTitle, approverMemberId: s.approverMemberId,
  }))
  routeForm.active = r.active
  routeMaxStr.value = r.maxAmount === null ? '' : String(r.maxAmount)
  routeModalOpen.value = true
}

/** ステップの指定内容が未入力なら弾く（役職/ロール/個人 の必須） */
function stepIncomplete(s: ApproverStepForm): boolean {
  return (s.approverType === 'title' && !s.approverTitle)
    || (s.approverType === 'role' && !s.approverRole)
    || (s.approverType === 'member' && !s.approverMemberId)
}

async function onRouteSave(): Promise<void> {
  if (routeForm.steps.length === 0) {
    show('承認ステップを 1 つ以上設定してください', 'warn')
    return
  }
  if (routeForm.steps.some(stepIncomplete)) {
    show('各ステップの承認者（役職／ロール／個人）を選択してください', 'warn')
    return
  }
  const maxAmount = routeMaxStr.value.trim() === '' ? null : Number(routeMaxStr.value)
  if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount <= routeForm.minAmount)) {
    show('上限金額は下限金額より大きい数値にしてください', 'warn')
    return
  }
  const steps: WorkflowRouteStep[] = routeForm.steps.map((s, i) => ({
    order: i + 1,
    approverType: s.approverType,
    approverRole: s.approverRole,
    approverTitle: s.approverTitle,
    approverMemberId: s.approverMemberId,
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
    <UiPageHeader title="稟議" description="職務権限マトリクス（区分×金額）で承認経路が自動決定されます">
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
                  {{ i + 1 }}. {{ approverTargetLabel(s) }}（{{ wf.stepApprover(s)?.name ?? '未設定' }}）
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

        <!-- 目的・内容（旧データは body を本文として互換表示 = 原則7） -->
        <template v-if="selectedReq.purpose || selectedReq.content">
          <div>
            <p class="label">目的</p>
            <p class="whitespace-pre-wrap rounded-lg border border-line bg-surface-soft p-3 text-[13px]">{{ selectedReq.purpose || '—' }}</p>
          </div>
          <div>
            <p class="label">内容</p>
            <div class="rounded-lg border border-line bg-surface-soft p-3">
              <UiMarkdown v-if="selectedReq.content" :source="selectedReq.content" />
              <p v-else class="text-[13px]">—</p>
            </div>
          </div>
        </template>
        <div v-else>
          <p class="label">本文</p>
          <p class="whitespace-pre-wrap rounded-lg border border-line bg-surface-soft p-3 text-[13px]">{{ selectedReq.body || '—' }}</p>
        </div>

        <div>
          <p class="label">添付ファイル</p>
          <ul v-if="wf.filesOf(selectedReq.id).length > 0 || selectedNameOnlyAttachments.length > 0" class="flex flex-wrap gap-1.5">
            <li v-for="f in wf.filesOf(selectedReq.id)" :key="f.id">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs hover:bg-surface-soft"
                :title="`${f.filename} をダウンロード`"
                @click="onDownloadFile(f)"
              >
                <Download class="h-3 w-3 text-brand" aria-hidden="true" />
                {{ f.filename }}
              </button>
            </li>
            <li
              v-for="(a, i) in selectedNameOnlyAttachments"
              :key="`n-${i}`"
              class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs"
              :title="isApi ? '名前のみの添付（旧データ = 原本なし）' : undefined"
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
        <UiFormField label="目的" required>
          <textarea v-model="form.purpose" class="textarea" rows="2" placeholder="この稟議で実現したいこと（なぜ必要か）" />
        </UiFormField>
        <UiFormField label="内容" required hint="区分に応じたテンプレートを呼び出して記入できます（マークダウン記法に対応）">
          <div class="mb-1.5 flex flex-wrap items-center gap-2">
            <UiSelect
              v-model="templateKey"
              :options="templateOptions"
              empty-label="テンプレートを選択"
              aria-label="内容テンプレート"
            />
            <button type="button" class="btn btn-sm" :disabled="!templateKey" @click="applyTemplate">
              <FileText class="h-3.5 w-3.5" aria-hidden="true" />
              テンプレートを呼び出す
            </button>
          </div>
          <textarea v-model="form.content" class="textarea" rows="8" placeholder="具体的な内容・金額の根拠など" />
        </UiFormField>
        <UiFormField
          label="添付ファイル"
          :hint="isApi
            ? '.md / .txt / .csv / .pdf / .docx / .xlsx / .pptx / .jpg / .png・10MB・5 件まで（原本を保管します）'
            : 'モックモードはファイル名のみ登録されます（原本の保管は API モード）'"
        >
          <div>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden"
              accept=".md,.txt,.csv,.pdf,.docx,.xlsx,.pptx,.jpg,.jpeg,.png"
              aria-label="添付ファイルを選択"
              @change="onFilePick"
            >
            <button type="button" class="btn" :disabled="!filesReady" @click="fileInput?.click()">
              <Paperclip class="h-3.5 w-3.5" aria-hidden="true" />
              {{ filesReady ? 'ファイルを選択' : '添付情報を取得中…' }}
            </button>
          </div>
          <ul
            v-if="existingFiles.length > 0 || newFiles.length > 0 || nameOnlyAttachments.length > 0"
            class="mt-2 flex flex-wrap gap-1.5"
          >
            <li
              v-for="f in existingFiles"
              :key="f.id"
              class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs"
            >
              <Paperclip class="h-3 w-3 text-muted" aria-hidden="true" />
              {{ f.filename }}
              <button type="button" class="text-muted hover:text-crit" :aria-label="`${f.filename} を削除`" @click="removeExistingFile(f.id)">
                <X class="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
            <li
              v-for="(f, i) in newFiles"
              :key="`new-${i}`"
              class="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs"
            >
              <Paperclip class="h-3 w-3 text-brand" aria-hidden="true" />
              {{ f.name }}
              <button type="button" class="text-muted hover:text-crit" :aria-label="`${f.name} を削除`" @click="removeNewFile(i)">
                <X class="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
            <li
              v-for="(a, i) in nameOnlyAttachments"
              :key="`name-${i}-${a}`"
              class="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs"
              :title="isApi ? '名前のみの添付（旧データ）' : undefined"
            >
              <Paperclip class="h-3 w-3 text-muted" aria-hidden="true" />
              {{ a }}
              <button type="button" class="text-muted hover:text-crit" :aria-label="`${a} を削除`" @click="removeAttachment(a)">
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
        <UiFormField label="承認ステップ" required hint="上から順に直列承認されます。承認者は役職／ロール／個人から指定できます">
          <WidgetsApproverSteps v-model="routeForm.steps" />
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
