<script setup lang="ts">
/**
 * 改善要望管理（F-42）。権限を持つ人のみ閲覧（deny-by-default・管理者は常時可）。
 * - 各ページから寄せられた要望を「AI で集約」して改修単位（改修 1 件の粒度）へ整理する。
 * - 改修単位を単一ステータス（未判定 → 対応する → 解決済み／対応しない）で管理し、
 *   未解決/解決済み・対応可否でフィルターできる。
 * - フィルター結果を、コーディング AI エージェント向けの詳細プロンプトとして出力する。
 */
import { ClipboardCopy, ExternalLink, Inbox, RefreshCw, Sparkles, Undo2, Wand2 } from 'lucide-vue-next'
import type { TableColumn, Tone } from '~/types/ui'
import {
  IMPROVEMENT_FILTER_OPTIONS,
  IMPROVEMENT_REQUEST_ADOPTION_META,
  IMPROVEMENT_REQUEST_STATUS_META,
  IMPROVEMENT_REQUEST_STATUSES,
  IMPROVEMENT_STATUS_META,
  IMPROVEMENT_STATUS_NEXT,
  type ImprovementFilter,
  type ImprovementItem,
  type ImprovementRequest,
  type ImprovementRequestImage,
  type ImprovementRequestStatus,
  type ImprovementStatus,
  matchesImprovementFilter,
  requestAdoptionOf,
  requestStatusOf,
} from '~/types/improvement'
import { fmtDate, fmtDateTime } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const { canManageImprovements } = usePermissions()
const imp = useImprovements()
const toast = useToast()
const confirm = useConfirm()

onMounted(() => { void imp.refresh() })

// ---------- フィルター（未解決/解決済み・対応可否 + 取消済み） ----------
const FILTER_OPTIONS = [...IMPROVEMENT_FILTER_OPTIONS, { value: 'archived' as const, label: '取消済み' }]
const uiFilter = ref<string>('all')
const search = ref('')

const rows = computed<ImprovementItem[]>(() => {
  const base = uiFilter.value === 'archived'
    ? imp.archivedItems.value
    : imp.activeItems.value.filter(it => matchesImprovementFilter(it.status, uiFilter.value as ImprovementFilter))
  const q = search.value.trim().toLowerCase()
  if (!q) return base
  return base.filter(it =>
    it.title.toLowerCase().includes(q)
    || it.summary.toLowerCase().includes(q)
    || it.detail.toLowerCase().includes(q)
    // 表示中の「名称（パス）」で検索できるようにする（名称でも生パスでも一致）
    || it.pagePaths.some(p => pageDisplay(p).toLowerCase().includes(q)))
})

// UiDataTable は Record<string, unknown>[] を要求するため表示用に変換（セルは個別にキャストして参照）
const tableRows = computed(() => rows.value as unknown as Record<string, unknown>[])

/** ステータス別の件数（KPI 表示用） */
const counts = computed(() => {
  const c = { triage: 0, accepted: 0, resolved: 0, rejected: 0 } as Record<ImprovementStatus, number>
  for (const it of imp.activeItems.value) c[it.status] += 1
  return c
})

const columns: TableColumn[] = [
  { key: 'title', label: '改修単位', primary: true },
  { key: 'status', label: 'ステータス', width: '110px' },
  { key: 'pages', label: '対象ページ', width: '200px' },
  { key: 'count', label: '要望', width: '70px', align: 'right' },
  { key: 'updatedAt', label: '更新', width: '110px' },
]

function statusLabel(s: ImprovementStatus): string { return IMPROVEMENT_STATUS_META[s]?.label ?? s }
function statusTone(s: ImprovementStatus): Tone { return IMPROVEMENT_STATUS_META[s]?.tone ?? 'neutral' }

// ---------- 生要望（受付箱 = 選別。改善要望 2026-08-17 第 2 弾） ----------

/** 生要望一覧の絞り込み（既定 = 未選別。選別 → 採用分のみ AI 集約へ進むフロー） */
const rawFilter = ref<string>('pending')
const RAW_FILTER_OPTIONS = [
  { value: 'pending', label: '未選別' },
  { value: 'adopted', label: '採用（集約待ち）' },
  { value: 'declined', label: '不採用' },
  { value: 'clustered', label: '集約済み' },
  { value: 'all', label: 'すべて' },
  { value: 'archived', label: '取消済み' },
]

const rawRequests = computed<ImprovementRequest[]>(() => {
  // 新しい順に明示ソート（API の GET は降順・mock の tbl は挿入順 = 昇順のため、
  // ここで揃えないと両モードで並びが逆転する = 原則6。レビュー指摘 2026-08-17）
  const all = [...imp.allRequests.value]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const f = rawFilter.value
  if (f === 'archived') return all.filter(r => r.archivedAt)
  const active = all.filter(r => !r.archivedAt)
  if (f === 'clustered') return active.filter(r => !!r.itemId)
  if (f === 'all') return active
  return active.filter(r => !r.itemId && requestAdoptionOf(r) === f)
})
const rawTableRows = computed(() => rawRequests.value as unknown as Record<string, unknown>[])

const RAW_COLUMNS: TableColumn[] = [
  { key: 'body', label: '要望', primary: true },
  { key: 'adoption', label: '選別', width: '90px' },
  { key: 'memberName', label: '投稿者', width: '110px' },
  { key: 'page', label: '対象ページ', width: '180px' },
  { key: 'comments', label: 'コメント', width: '80px', align: 'right' },
  { key: 'createdAt', label: '投稿日', width: '110px' },
]

// 生要望の詳細ドロワー（選別・コメント・添付の参照）
const selectedRequestId = ref<string | null>(null)
const selectedRequest = computed<ImprovementRequest | null>(() =>
  imp.allRequests.value.find(r => r.id === selectedRequestId.value) ?? null)
const requestComments = computed(() => (selectedRequest.value ? imp.commentsForRequest(selectedRequest.value.id) : []))
const commentInput = ref('')
const commentBusy = ref(false)

function openRequestDrawer(row: Record<string, unknown>): void {
  selectedRequestId.value = String(row.id)
  commentInput.value = ''
  const r = imp.allRequests.value.find(x => x.id === selectedRequestId.value)
  if (r) void imp.loadRequestImagesFor(r) // 添付画像の遅延ロード（非ブロッキング）
}

/** 選別の変更（採用 / 不採用 / 未選別に戻す。遷移自由 = 原則9.5。採用分のみ AI 集約対象） */
async function changeAdoption(id: string, to: 'pending' | 'adopted' | 'declined'): Promise<void> {
  const res = await imp.setRequestAdoption(id, to)
  if (res.ok) {
    const label = IMPROVEMENT_REQUEST_ADOPTION_META[to].label
    toast.show(to === 'adopted' ? `「${label}」にしました（「AI で集約」の対象になります）` : `「${label}」にしました`, 'ok')
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

async function addComment(): Promise<void> {
  if (!selectedRequest.value || !commentInput.value.trim() || commentBusy.value) return
  commentBusy.value = true
  const res = await imp.addRequestComment(selectedRequest.value.id, commentInput.value)
  commentBusy.value = false
  if (res.ok) { commentInput.value = ''; toast.show('コメントを追加しました', 'ok') }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function removeComment(id: string): Promise<void> {
  const ok = await confirm.ask('コメントの取消', 'このコメントを取り消します（一覧から消えます）。', { danger: true })
  if (!ok) return
  const res = await imp.setRequestCommentArchived(id, true)
  if (res.ok) toast.show('コメントを取り消しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/** 生要望ドロワーからの取消/復元（原則9.5） */
async function archiveSelectedRequest(): Promise<void> {
  if (!selectedRequest.value) return
  const ok = await confirm.ask('要望の取消', 'この要望を取り消します（選別・集約の対象から外れます）。取消済みからいつでも戻せます。', { danger: true })
  if (!ok) return
  const res = await imp.setRequestArchived(selectedRequest.value.id, true)
  if (res.ok) { toast.show('要望を取り消しました', 'ok'); selectedRequestId.value = null }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
async function restoreSelectedRequest(): Promise<void> {
  if (!selectedRequest.value) return
  const res = await imp.setRequestArchived(selectedRequest.value.id, false)
  if (res.ok) toast.show('要望の取消を戻しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/** 集約済み要望のドロワーから改修単位の詳細へ（生要望 → 改修単位の導線） */
function openItemOfRequest(): void {
  const itemId = selectedRequest.value?.itemId
  if (!itemId) return
  selectedRequestId.value = null
  selectedId.value = itemId
  editing.value = false
  void imp.loadRequestImages(itemId)
}

// ---------- AI 集約（採用済みの未集約要望のみ対象 = 選別が先のフロー） ----------
const generating = ref(false)
async function runGenerate(): Promise<void> {
  if (generating.value) return
  // refresh を跨いだ再クリックの二重発火を防ぐため、フラグは最初に立てる（try/finally で必ず解除）
  generating.value = true
  try {
    // 採用済みの集約待ちが無いときは、先に選別を促す（未選別が残っている場合はその旨も案内）。
    // 判定前に最新化（他端末・別タブで採用された直後でも古いキャッシュでブロックしない = レビュー指摘 2026-08-17。mock は no-op）
    if (imp.adoptedUnclustered.value.length === 0) {
      await imp.refresh()
      if (imp.adoptedUnclustered.value.length === 0) {
        toast.show(imp.pendingRequests.value.length > 0
          ? '採用済みの要望がありません。生要望一覧で「採用」してから集約してください'
          : '集約する要望がありません（採用済みの集約待ちが 0 件です）', 'info')
        return
      }
    }
    const res = await imp.generate()
    if (!res.ok) {
      toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
      return
    }
    if ((res.clustered ?? 0) === 0) {
      toast.show('新しく集約する要望はありませんでした', 'info')
      return
    }
    const how = res.llm ? 'AI（LLM）' : 'ルールベース'
    toast.show(`${how}で集約しました（改修単位 新規${res.created}・追記${res.appended}／要望${res.clustered}件）`, 'ok')
  } finally {
    generating.value = false
  }
}

// ---------- 詳細ドロワー ----------
const selectedId = ref<string | null>(null)
const selected = computed<ImprovementItem | null>(() =>
  imp.activeItems.value.find(it => it.id === selectedId.value)
  ?? imp.archivedItems.value.find(it => it.id === selectedId.value)
  ?? null)
const sourceRequests = computed(() => (selected.value ? imp.requestsForItem(selected.value.id) : []))

// 添付画像の拡大表示（要望の画像を押下 → topmost モーダル = ドロワーより前面。閉じるで戻る）
const previewImage = ref<ImprovementRequestImage | null>(null)

// 編集
const editing = ref(false)
const editForm = ref({ title: '', summary: '', detail: '' })
function openDrawer(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  editing.value = false
  // 添付画像の遅延ロード（API モード。全件一覧は画像を含まないためドロワー表示時に取得 = 非ブロッキング）
  void imp.loadRequestImages(selectedId.value)
}
function startEdit(): void {
  if (!selected.value) return
  editForm.value = { title: selected.value.title, summary: selected.value.summary, detail: selected.value.detail }
  editing.value = true
}
async function saveEdit(): Promise<void> {
  if (!selected.value) return
  const res = await imp.editItem(selected.value.id, editForm.value)
  if (res.ok) { editing.value = false; toast.show('改修単位を更新しました', 'ok') }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function changeStatus(to: ImprovementStatus): Promise<void> {
  if (!selected.value) return
  const res = await imp.setStatus(selected.value.id, to)
  if (res.ok) toast.show(`ステータスを「${statusLabel(to)}」に変更しました`, 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// 「対応しない」への変更は理由メモ（任意）を添えられる。他のステータスは即時変更（理由入力は閉じる）
function onStatusClick(to: ImprovementStatus): void {
  if (to === 'rejected') { rejectMode.value = true; rejectReason.value = '' }
  else { rejectMode.value = false; void changeStatus(to) }
}
async function confirmReject(): Promise<void> {
  // 二重送信ガード（rejectBusy）: 連打や addNote 成功→setStatus 失敗後の再クリックで reject メモが重複登録されるのを防ぐ
  if (!selected.value || rejectBusy.value) return
  rejectBusy.value = true
  try {
    const reason = rejectReason.value.trim()
    // 任意: 理由があれば「対応しない理由」メモとして先に残す（ステータス変更前に記録）
    if (reason) {
      const nr = await imp.addNote(selected.value.id, reason, 'reject')
      if (!nr.ok) { toast.show(`${nr.error.code}: ${nr.error.message}`, 'crit'); return }
    }
    const res = await imp.setStatus(selected.value.id, 'rejected')
    if (res.ok) {
      toast.show(reason ? '「対応しない」にしました（理由をメモに記録）' : '「対応しない」にしました', 'ok')
      rejectMode.value = false
      rejectReason.value = ''
    }
    else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  } finally {
    rejectBusy.value = false
  }
}

// ---------- 時系列メモ ----------
const itemNotes = computed(() => (selected.value ? imp.notesForItem(selected.value.id) : []))
const noteInput = ref('')
const noteBusy = ref(false)
const rejectMode = ref(false)
const rejectReason = ref('')
const rejectBusy = ref(false)

async function addNote(): Promise<void> {
  if (!selected.value || !noteInput.value.trim() || noteBusy.value) return
  noteBusy.value = true
  const res = await imp.addNote(selected.value.id, noteInput.value)
  noteBusy.value = false
  if (res.ok) { noteInput.value = ''; toast.show('メモを追加しました', 'ok') }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
async function removeNote(id: string): Promise<void> {
  const ok = await confirm.ask('メモの取消', 'このメモを取り消します（一覧から消えます）。', { danger: true })
  if (!ok) return
  const res = await imp.setNoteArchived(id, true)
  if (res.ok) toast.show('メモを取り消しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function archiveItem(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask('改修単位の取消', 'この改修単位を取り消します（一覧から隠れます）。取消済みからいつでも戻せます。', { danger: true })
  if (!ok) return
  const res = await imp.setItemArchived(selected.value.id, true)
  if (res.ok) { toast.show('改修単位を取り消しました', 'ok'); selectedId.value = null }
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
async function restoreItem(): Promise<void> {
  if (!selected.value) return
  const res = await imp.setItemArchived(selected.value.id, false)
  if (res.ok) toast.show('改修単位を戻しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function archiveRequest(id: string): Promise<void> {
  const ok = await confirm.ask('要望の取消', 'この要望を取り消します（改修単位の対象から外れます）。取消済みからいつでも戻せます。', { danger: true })
  if (!ok) return
  const res = await imp.setRequestArchived(id, true)
  if (res.ok) toast.show('要望を取り消しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/** 要望 1 件ずつのステータス変更（進捗タグ。遷移自由 = いつでも戻せる = 原則9.5。プロンプト再生成に反映） */
async function changeRequestStatus(id: string, ev: Event): Promise<void> {
  const to = (ev.target as HTMLSelectElement).value as ImprovementRequestStatus
  const res = await imp.setRequestStatus(id, to)
  if (res.ok) toast.show(`要望を「${IMPROVEMENT_REQUEST_STATUS_META[to].label}」にしました（プロンプト再生成に反映されます）`, 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/** 一覧の「要望」件数 = 有効な元要望数（ドロワー・プロンプトと一致。取消済み要望は除く） */
function reqCount(itemId: string): number {
  return imp.requestsForItem(itemId).length
}

// ---------- ビュー切替（一覧 / カンバン / ガント） ----------
const view = ref<string>('list')
const VIEW_OPTIONS = [
  { value: 'list', label: '一覧' },
  { value: 'kanban', label: 'カンバン' },
  { value: 'gantt', label: 'ガント' },
]

/** カンバン/ガントからの詳細ドロワー起動（item を直接受け取る） */
function openDrawerItem(it: ImprovementItem): void {
  selectedId.value = it.id
  editing.value = false
  void imp.loadRequestImages(it.id)
}
/** カンバンのクイック操作（id 指定のステータス変更） */
async function onKanbanStatus(id: string, to: ImprovementStatus): Promise<void> {
  const res = await imp.setStatus(id, to)
  if (res.ok) toast.show(`ステータスを「${statusLabel(to)}」に変更しました`, 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 対応予定期間（ドロワーで登録・ガントに反映） ----------
const planForm = ref({ start: '', end: '' })
watch(() => selected.value?.id, () => {
  planForm.value = { start: selected.value?.planStart ?? '', end: selected.value?.planEnd ?? '' }
  // 対象を切り替えたらメモ入力・「対応しない」理由入力・画像プレビューをリセット（前の対象の状態を持ち越さない）
  noteInput.value = ''
  rejectMode.value = false
  rejectReason.value = ''
  previewImage.value = null
}, { immediate: true })

async function savePlan(): Promise<void> {
  if (!selected.value) return
  const res = await imp.editItem(selected.value.id, { planStart: planForm.value.start, planEnd: planForm.value.end })
  if (res.ok) toast.show('対応予定期間を更新しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
async function clearPlan(): Promise<void> {
  if (!selected.value) return
  planForm.value = { start: '', end: '' }
  const res = await imp.editItem(selected.value.id, { planStart: '', planEnd: '' })
  if (res.ok) toast.show('対応予定期間をクリアしました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// ---------- 改修プロンプト出力 ----------
const promptOpen = ref(false)
const promptFilter = ref<string>('open')
const promptText = ref('')
const promptCount = ref(0)
const promptBusy = ref(false)

async function openPrompt(): Promise<void> {
  promptOpen.value = true
  await refreshPrompt()
}
async function refreshPrompt(): Promise<void> {
  promptBusy.value = true
  const res = await imp.buildPrompt(promptFilter.value as ImprovementFilter)
  promptBusy.value = false
  if (res.ok) { promptText.value = res.prompt; promptCount.value = res.count }
  else { promptText.value = ''; promptCount.value = 0; toast.show(`${res.error.code}: ${res.error.message}`, 'crit') }
}
async function copyPrompt(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(promptText.value)
    toast.show('プロンプトをコピーしました', 'ok')
    return true
  } catch {
    toast.show('コピーできませんでした。テキストを選択してコピーしてください', 'warn')
    return false
  }
}
/** コピーして閉じる: コピー成功時のみモーダルを閉じる（失敗時は手動コピーできるよう開いたまま残す） */
async function copyAndClose(): Promise<void> {
  if (await copyPrompt()) promptOpen.value = false
}
</script>

<template>
  <div>
    <UiPageHeader
      title="改善要望"
      description="寄せられた生の要望をまず確認・選別し、採用した要望を AI で改修単位に整理して、対応可否・解決状況を管理します"
    >
      <template #actions>
        <!-- AI 集約の対象 = 採用済み・集約待ちの要望のみ（選別が先 = 改善要望 2026-08-17 第 2 弾） -->
        <button type="button" class="btn btn-ghost" :disabled="generating" @click="runGenerate">
          <Wand2 class="h-4 w-4" aria-hidden="true" />
          {{ generating ? '集約中…' : '採用済みを AI で集約' }}
          <span v-if="imp.adoptedUnclustered.value.length > 0" class="num ml-1 rounded-full bg-brand-soft px-1.5 text-[11px] font-bold text-brand">
            {{ imp.adoptedUnclustered.value.length }}
          </span>
        </button>
        <button type="button" class="btn btn-primary" @click="openPrompt">
          <Sparkles class="h-4 w-4" aria-hidden="true" />
          改修プロンプトを出力
        </button>
      </template>
    </UiPageHeader>

    <!-- 権限ガード（deny-by-default・防御的表示。ルート遷移ガードは permissions.global.ts） -->
    <div v-if="!canManageImprovements" class="card mt-4 p-6 text-center text-sub">
      改善要望を閲覧する権限がありません。管理者にお問い合わせください。
    </div>

    <div v-else class="mt-4 grid gap-3">
      <!-- ① 生要望（受付箱）: まず投稿された生の一覧を確認し、採用/不採用を選別する（改善要望 2026-08-17 第 2 弾）。
           採用された要望のみが「AI で集約」の対象になる。行クリックで詳細（本文全文・添付・コメントのやり取り・選別） -->
      <UiSectionCard
        flush
        title="生要望（受付箱）"
        description="投稿された生の要望を確認し、採用／不採用を選別します。採用した要望だけが「AI で集約」の対象になります。行クリックでコメントのやり取り・添付の参照ができます"
      >
        <template #actions>
          <span
            v-if="imp.pendingRequests.value.length > 0"
            class="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-bold text-warn"
          >
            <Inbox class="h-3.5 w-3.5" aria-hidden="true" />
            未選別 <span class="num">{{ imp.pendingRequests.value.length }}</span> 件
          </span>
        </template>
        <div class="border-b border-line p-2">
          <UiChipTabs v-model="rawFilter" :options="RAW_FILTER_OPTIONS" />
        </div>
        <UiDataTable
          :columns="RAW_COLUMNS"
          :rows="rawTableRows"
          clickable
          empty-title="該当する要望はありません"
          :empty-hint="rawFilter === 'pending' ? '未選別の要望はありません。新しい投稿を待つか、他の絞り込みを確認してください' : '絞り込みを変えて確認してください'"
          @row-click="openRequestDrawer"
        >
          <template #cell-body="{ row }">
            <span class="line-clamp-2 text-[13px] text-ink">{{ row.body }}</span>
          </template>
          <template #cell-adoption="{ row }">
            <UiStatusBadge
              v-if="(row as unknown as ImprovementRequest).itemId"
              tone="info"
              label="集約済み"
              dot
            />
            <UiStatusBadge
              v-else
              :tone="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(row as unknown as ImprovementRequest)].tone"
              :label="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(row as unknown as ImprovementRequest)].label"
              dot
            />
          </template>
          <template #cell-memberName="{ row }">
            <span class="text-[12px] text-sub">{{ row.memberName }}</span>
          </template>
          <template #cell-page="{ row }">
            <span class="text-[12px] text-sub">{{ String(row.pageLabel || row.pagePath || 'ページ不明') }}</span>
          </template>
          <template #cell-comments="{ row }">
            <span class="num" :class="imp.commentsForRequest(String(row.id)).length > 0 ? 'font-semibold text-brand' : 'text-muted'">
              {{ imp.commentsForRequest(String(row.id)).length }}
            </span>
          </template>
          <template #cell-createdAt="{ row }">
            <span class="text-[12px] text-muted">{{ fmtDate(row.createdAt as string) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>

      <!-- ② 改修単位（採用 → AI 集約後）: ステータス別サマリー -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <UiKpiCard label="未判定" :value="String(counts.triage)" sub="対応可否の判定待ち" icon="HelpCircle" />
        <UiKpiCard label="対応する" :value="String(counts.accepted)" sub="改修予定（未解決）" icon="Wrench" />
        <UiKpiCard label="解決済み" :value="String(counts.resolved)" sub="改修完了" icon="CheckCircle2" inverse />
        <UiKpiCard label="対応しない" :value="String(counts.rejected)" sub="見送り" icon="MinusCircle" />
      </div>

      <!-- 表示切替（一覧 / カンバン / ガント） -->
      <UiChipTabs v-model="view" :options="VIEW_OPTIONS" />

      <!-- カンバン: ステータス別に進捗を一望 -->
      <ImprovementsKanban
        v-if="view === 'kanban'"
        :items="imp.activeItems.value"
        :req-count="reqCount"
        @open="openDrawerItem"
        @status="onKanbanStatus"
      />

      <!-- ガント: 対応予定期間を月次/週次/日次で可視化 -->
      <ImprovementsGantt
        v-else-if="view === 'gantt'"
        :items="imp.activeItems.value"
        @open="openDrawerItem"
      />

      <UiSectionCard v-else flush>
        <template #actions>
          <UiSearchInput v-model="search" placeholder="改修単位・対象ページを検索" />
        </template>
        <div class="border-b border-line p-2">
          <UiChipTabs v-model="uiFilter" :options="FILTER_OPTIONS" />
        </div>

        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="改修単位はまだありません"
          empty-hint="「AI で集約」で、寄せられた要望を改修単位に整理します"
          @row-click="openDrawer"
        >
          <template #cell-status="{ row }">
            <UiStatusBadge :tone="statusTone(row.status as ImprovementStatus)" :label="statusLabel(row.status as ImprovementStatus)" dot />
          </template>
          <template #cell-pages="{ row }">
            <span class="text-[12px] text-sub">{{ (row.pagePaths as string[]).map(pageDisplay).join(' / ') || '—' }}</span>
          </template>
          <template #cell-count="{ row }">
            <span class="num">{{ reqCount(row.id as string) }}</span>
          </template>
          <template #cell-updatedAt="{ row }">
            <span class="text-[12px] text-muted">{{ fmtDate(row.updatedAt as string) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>

      <p class="text-[12px] text-muted">
        未選別 {{ imp.pendingRequests.value.length }} 件・採用済み（集約待ち）{{ imp.adoptedUnclustered.value.length }} 件。
        生要望（受付箱）で選別し、「採用済みを AI で集約」で改修単位に整理できます。
      </p>
    </div>

    <!-- 詳細ドロワー -->
    <UiDrawer :open="!!selected" :title="selected?.title ?? '改修単位'" width="560px" @close="selectedId = null">
      <div v-if="selected" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :tone="statusTone(selected.status)" :label="statusLabel(selected.status)" dot />
          <span v-if="selected.archivedAt" class="text-[12px] text-crit">取消済み</span>
          <span class="text-[12px] text-muted">更新 {{ fmtDate(selected.updatedAt) }}</span>
        </div>

        <!-- ステータス操作（許可された遷移のみ = 状態機械。解決の取消 = reopen 可） -->
        <div v-if="!selected.archivedAt" class="grid gap-2">
          <p class="label">ステータスを変更</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="to in IMPROVEMENT_STATUS_NEXT[selected.status]"
              :key="to"
              type="button"
              class="btn btn-sm"
              :class="to === 'resolved' ? 'btn-primary' : 'btn-ghost'"
              @click="onStatusClick(to)"
            >
              {{ statusLabel(to) }}へ
            </button>
            <span v-if="IMPROVEMENT_STATUS_NEXT[selected.status].length === 0" class="text-[12px] text-muted">
              （この状態からの変更はありません）
            </span>
          </div>
          <!-- 「対応しない」への変更: 任意で理由をメモとして残せる（原則9.5 の判断根拠の記録） -->
          <div v-if="rejectMode" class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
            <UiFormField label="対応しない理由（任意・メモに記録されます）">
              <textarea
                v-model="rejectReason"
                class="textarea"
                rows="3"
                placeholder="例: 影響範囲が大きく、次期リプレイスで対応するため今回は見送り"
              />
            </UiFormField>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="rejectBusy" @click="rejectMode = false">キャンセル</button>
              <button type="button" class="btn btn-primary btn-sm" :disabled="rejectBusy" @click="confirmReject">「対応しない」にする</button>
            </div>
          </div>
        </div>

        <!-- 対応予定期間（任意・ガントに反映） -->
        <div v-if="!selected.archivedAt" class="grid gap-2">
          <p class="label">対応予定期間（任意）</p>
          <div class="flex flex-wrap items-end gap-2">
            <UiFormField label="開始日">
              <input v-model="planForm.start" class="input" type="date">
            </UiFormField>
            <span class="pb-2 text-muted">〜</span>
            <UiFormField label="終了日">
              <input v-model="planForm.end" class="input" type="date">
            </UiFormField>
            <button type="button" class="btn btn-primary btn-sm" @click="savePlan">保存</button>
            <button v-if="selected.planStart" type="button" class="btn btn-ghost btn-sm" @click="clearPlan">クリア</button>
          </div>
          <p class="text-[11px] text-muted">終了日は任意（未入力なら単日）。登録するとガントチャートにバーで表示されます。</p>
        </div>

        <!-- 改修内容 -->
        <div v-if="!editing" class="grid gap-2">
          <div class="flex items-center justify-between">
            <p class="label">改修内容</p>
            <button v-if="!selected.archivedAt" type="button" class="link text-[12px]" @click="startEdit">編集</button>
          </div>
          <p v-if="selected.summary" class="text-[13px] font-semibold text-ink">{{ selected.summary }}</p>
          <UiMarkdown :source="selected.detail" />
        </div>
        <div v-else class="grid gap-2">
          <UiFormField label="見出し" required>
            <input v-model="editForm.title" class="input" type="text">
          </UiFormField>
          <UiFormField label="概要">
            <input v-model="editForm.summary" class="input" type="text">
          </UiFormField>
          <UiFormField label="改修内容（マークダウン可）">
            <textarea v-model="editForm.detail" class="textarea" rows="8" />
          </UiFormField>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-ghost btn-sm" @click="editing = false">キャンセル</button>
            <button type="button" class="btn btn-primary btn-sm" @click="saveEdit">保存</button>
          </div>
        </div>

        <!-- 元になった要望 -->
        <div class="grid gap-2">
          <p class="label">元になった要望（{{ sourceRequests.length }} 件）</p>
          <ul class="grid gap-2">
            <li v-for="r in sourceRequests" :key="r.id" class="card p-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <p class="text-[13px] text-ink">{{ r.body }}</p>
                  <!-- 添付リンク（押下で別タブに開く） -->
                  <ul v-if="(r.links ?? []).length > 0" class="mt-1.5 grid gap-1">
                    <li v-for="l in r.links" :key="l" class="min-w-0">
                      <a
                        :href="l"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="link inline-flex max-w-full items-center gap-1 text-[12px]"
                        :title="`${l}（別タブで開く）`"
                      >
                        <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span class="truncate">{{ l }}</span>
                      </a>
                    </li>
                  </ul>
                  <!-- 添付画像（押下で拡大表示） -->
                  <div v-if="(r.images ?? []).length > 0" class="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      v-for="(img, i) in r.images"
                      :key="i"
                      type="button"
                      class="rounded-lg border border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                      :aria-label="`画像「${img.filename}」を拡大表示`"
                      :title="`${img.filename}（押下で拡大）`"
                      @click="previewImage = img"
                    >
                      <img :src="img.dataUrl" :alt="img.filename" class="h-14 w-14 rounded-lg object-cover">
                    </button>
                  </div>
                  <p class="mt-1 text-[11px] text-muted">
                    {{ r.memberName }}・{{ r.pageLabel || r.pagePath || 'ページ不明' }}・{{ fmtDate(r.createdAt) }}
                  </p>
                  <!-- 要望単位のステータス（進捗タグ）。変更はプロンプト再生成に反映（【対応済み】【見送り】明記） -->
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <UiStatusBadge
                      :tone="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].tone"
                      :label="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].label"
                      dot
                    />
                    <select
                      v-if="!selected.archivedAt"
                      class="select w-auto py-1 text-[12px]"
                      :value="requestStatusOf(r)"
                      :aria-label="`この要望のステータスを変更`"
                      @change="changeRequestStatus(r.id, $event)"
                    >
                      <option v-for="s in IMPROVEMENT_REQUEST_STATUSES" :key="s" :value="s">
                        {{ IMPROVEMENT_REQUEST_STATUS_META[s].label }}
                      </option>
                    </select>
                  </div>
                </div>
                <button type="button" class="btn btn-ghost btn-sm shrink-0" title="この要望を取消" @click="archiveRequest(r.id)">
                  取消
                </button>
              </div>
            </li>
            <li v-if="sourceRequests.length === 0" class="text-[12px] text-muted">有効な元要望がありません</li>
          </ul>
        </div>

        <!-- 時系列メモ（改修方針の検討・保留/見送り理由。AI 改修プロンプトにも加味される） -->
        <div class="grid gap-2">
          <p class="label">メモ（時系列・{{ itemNotes.length }} 件）</p>
          <p class="text-[11px] text-muted">
            改修方針の検討過程や保留理由などを時系列で 1 件ずつ残せます。「改修プロンプトを出力」時に AI がこのメモも加味します。
          </p>
          <ul v-if="itemNotes.length" class="grid gap-2">
            <li v-for="n in itemNotes" :key="n.id" class="card p-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <UiStatusBadge v-if="n.kind === 'reject'" class="mb-1" tone="warn" label="対応しない理由" />
                  <p class="whitespace-pre-wrap break-words text-[13px] text-ink">{{ n.body }}</p>
                  <p class="mt-1 text-[11px] text-muted">{{ n.memberName }}・{{ fmtDateTime(n.createdAt) }}</p>
                </div>
                <button
                  v-if="!selected.archivedAt"
                  type="button"
                  class="btn btn-ghost btn-sm shrink-0"
                  title="このメモを取消"
                  @click="removeNote(n.id)"
                >
                  取消
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="text-[12px] text-muted">メモはまだありません</p>

          <!-- メモ追加（改修単位が有効なときのみ） -->
          <div v-if="!selected.archivedAt" class="grid gap-1.5">
            <textarea
              v-model="noteInput"
              class="textarea"
              rows="2"
              placeholder="メモを追加（改修方針・検討メモ・保留理由など）"
              aria-label="メモを追加"
            />
            <div class="flex justify-end">
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!noteInput.trim() || noteBusy"
                @click="addNote"
              >
                メモを追加
              </button>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <button v-if="selected && !selected.archivedAt" type="button" class="btn btn-danger" @click="archiveItem">
          改修単位を取消
        </button>
        <button v-else-if="selected && selected.archivedAt" type="button" class="btn btn-ghost" @click="restoreItem">
          <Undo2 class="h-4 w-4" aria-hidden="true" /> 取消を戻す
        </button>
      </template>
    </UiDrawer>

    <!-- 生要望の詳細ドロワー（選別・コメントのやり取り・添付の参照 = 改善要望 2026-08-17 第 2 弾） -->
    <UiDrawer :open="!!selectedRequest" title="生要望の詳細" width="520px" @close="selectedRequestId = null">
      <div v-if="selectedRequest" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge
            v-if="selectedRequest.itemId"
            tone="info"
            label="集約済み"
            dot
          />
          <UiStatusBadge
            v-else
            :tone="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(selectedRequest)].tone"
            :label="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(selectedRequest)].label"
            dot
          />
          <span v-if="selectedRequest.archivedAt" class="text-[12px] text-crit">取消済み</span>
          <span class="text-[12px] text-muted">
            {{ selectedRequest.memberName }}・{{ selectedRequest.pageLabel || selectedRequest.pagePath || 'ページ不明' }}・{{ fmtDate(selectedRequest.createdAt) }}
          </span>
        </div>

        <!-- 本文 + 添付 -->
        <div class="card p-3">
          <p class="whitespace-pre-wrap break-words text-[13px] text-ink">{{ selectedRequest.body }}</p>
          <ul v-if="(selectedRequest.links ?? []).length > 0" class="mt-2 grid gap-1">
            <li v-for="l in selectedRequest.links" :key="l" class="min-w-0">
              <a
                :href="l"
                target="_blank"
                rel="noopener noreferrer"
                class="link inline-flex max-w-full items-center gap-1 text-[12px]"
                :title="`${l}（別タブで開く）`"
              >
                <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ l }}</span>
              </a>
            </li>
          </ul>
          <div v-if="(selectedRequest.images ?? []).length > 0" class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="(img, i) in selectedRequest.images"
              :key="i"
              type="button"
              class="rounded-lg border border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              :aria-label="`画像「${img.filename}」を拡大表示`"
              :title="`${img.filename}（押下で拡大）`"
              @click="previewImage = img"
            >
              <img :src="img.dataUrl" :alt="img.filename" class="h-14 w-14 rounded-lg object-cover">
            </button>
          </div>
        </div>

        <!-- 選別（採用/不採用。集約済みは変更不可 = 記録保護。取消可能性 = いつでも選び直せる） -->
        <div v-if="!selectedRequest.archivedAt" class="grid gap-2">
          <p class="label">選別</p>
          <template v-if="selectedRequest.itemId">
            <p class="text-[12px] text-muted">この要望は改修単位へ集約済みです（選別は変更できません。対象から外す場合は要望を取り消してください）。</p>
            <div>
              <button type="button" class="btn btn-sm" @click="openItemOfRequest">集約先の改修単位を開く</button>
            </div>
          </template>
          <div v-else class="flex flex-wrap gap-2">
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'adopted'"
              type="button" class="btn btn-primary btn-sm"
              @click="changeAdoption(selectedRequest.id, 'adopted')"
            >採用する（AI 集約の対象）</button>
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'declined'"
              type="button" class="btn btn-ghost btn-sm"
              @click="changeAdoption(selectedRequest.id, 'declined')"
            >不採用にする</button>
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'pending'"
              type="button" class="btn btn-ghost btn-sm"
              @click="changeAdoption(selectedRequest.id, 'pending')"
            >未選別に戻す</button>
          </div>
        </div>

        <!-- コメント（やり取り。時系列・追記のみ。取消 = 論理削除 = 原則9.5） -->
        <div class="grid gap-2">
          <p class="label">コメント（時系列・{{ requestComments.length }} 件）</p>
          <p class="text-[11px] text-muted">
            採用/不採用の検討過程・不採用理由・確認事項などを時系列で残せます（このページを閲覧できる管理メンバー内の記録です）。
          </p>
          <ul v-if="requestComments.length" class="grid gap-2">
            <li v-for="cm in requestComments" :key="cm.id" class="card p-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="whitespace-pre-wrap break-words text-[13px] text-ink">{{ cm.body }}</p>
                  <p class="mt-1 text-[11px] text-muted">{{ cm.memberName }}・{{ fmtDateTime(cm.createdAt) }}</p>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm shrink-0"
                  title="このコメントを取消"
                  @click="removeComment(cm.id)"
                >
                  取消
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="text-[12px] text-muted">コメントはまだありません</p>

          <div v-if="!selectedRequest.archivedAt" class="grid gap-1.5">
            <textarea
              v-model="commentInput"
              class="textarea"
              rows="2"
              placeholder="コメントを追加（採用/不採用の検討・確認事項など）"
              aria-label="コメントを追加"
            />
            <div class="flex justify-end">
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!commentInput.trim() || commentBusy"
                @click="addComment"
              >
                コメントを追加
              </button>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <button v-if="selectedRequest && !selectedRequest.archivedAt" type="button" class="btn btn-danger" @click="archiveSelectedRequest">
          要望を取消
        </button>
        <button v-else-if="selectedRequest && selectedRequest.archivedAt" type="button" class="btn btn-ghost" @click="restoreSelectedRequest">
          <Undo2 class="h-4 w-4" aria-hidden="true" /> 取消を戻す
        </button>
      </template>
    </UiDrawer>

    <!-- 改修プロンプト出力モーダル -->
    <UiModal :open="promptOpen" title="改修プロンプトを出力" width="720px" @close="promptOpen = false">
      <div class="grid gap-3">
        <p class="text-[13px] text-sub">
          フィルター条件に合う改修単位を、コーディング AI エージェント向けの詳細プロンプト（対象ページ・機能名・改修内容・元要望・受入基準）として出力します。
          要望ごとのステータス変更後は「再生成」で最新の状態（【対応済み】【見送り】の明記）を反映できます。
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="label">対象</span>
          <UiSelect v-model="promptFilter" :options="IMPROVEMENT_FILTER_OPTIONS" @update:model-value="refreshPrompt" />
          <span class="text-[12px] text-muted">{{ promptCount }} 件</span>
          <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="promptBusy" @click="refreshPrompt">
            <RefreshCw class="h-4 w-4" aria-hidden="true" /> {{ promptBusy ? '生成中…' : '再生成' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="!promptText" @click="copyPrompt">
            <ClipboardCopy class="h-4 w-4" aria-hidden="true" /> コピー
          </button>
        </div>
        <textarea
          :value="promptBusy ? '生成中…' : promptText"
          readonly
          class="textarea font-mono text-[12px]"
          rows="18"
          aria-label="改修プロンプト"
        />
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="promptOpen = false">閉じる</button>
        <button type="button" class="btn btn-primary" :disabled="!promptText" @click="copyAndClose">コピーして閉じる</button>
      </template>
    </UiModal>

    <!-- 添付画像の拡大表示（topmost = ドロワーより前面。閉じる/背景クリックで戻る = 原則9.5） -->
    <UiModal
      :open="!!previewImage"
      :title="previewImage?.filename || '添付画像'"
      width="760px"
      topmost
      @close="previewImage = null"
    >
      <img
        v-if="previewImage"
        :src="previewImage.dataUrl"
        :alt="previewImage.filename"
        class="mx-auto max-h-[70dvh] w-auto max-w-full rounded-lg"
      >
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="previewImage = null">閉じる</button>
      </template>
    </UiModal>
  </div>
</template>
