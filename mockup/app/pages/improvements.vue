<script setup lang="ts">
/**
 * 改善要望管理（F-42）。権限を持つ人のみ閲覧（deny-by-default・管理者は常時可）。
 * - 各ページから寄せられた要望を「AI で集約」して改修単位（改修 1 件の粒度）へ整理する。
 * - 改修単位を単一ステータス（未判定 → 対応する → 解決済み／対応しない）で管理し、
 *   未解決/解決済み・対応可否でフィルターできる。
 * - フィルター結果を、コーディング AI エージェント向けの詳細プロンプトとして出力する。
 */
import { ClipboardCopy, Pencil, RefreshCw, Sparkles, Undo2, Wand2 } from 'lucide-vue-next'
import type { TabItem, TableColumn, Tone } from '~/types/ui'
import {
  IMPROVEMENT_FILTER_OPTIONS,
  improvementAdoptionError,
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
  isInternalPagePath,
  isOpenStatus,
  matchesImprovementFilter,
  requestAdoptionOf,
  requestStatusOf,
} from '~/types/improvement'
import { fmtDate, fmtDateTime, fmtDateTimeSec } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const { canManageImprovements, canTab } = usePermissions()
const imp = useImprovements()
const toast = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()

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

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込み・検索は rows が担う。
// page リセット watch は tab 定義の後段〔タブ定義セクション〕にまとめて置く）
const { page: itemPage, pageSize: itemPageSize, rows: pagedItems, total: itemTotal } = useListView<ImprovementItem>({ source: rows })

// UiDataTable は Record<string, unknown>[] を要求するため表示用に変換（セルは個別にキャストして参照）
const tableRows = computed(() => pagedItems.value as unknown as Record<string, unknown>[])

/** ステータス別の件数（KPI 表示用） */
const counts = computed(() => {
  const c = { triage: 0, accepted: 0, in_progress: 0, resolved: 0, rejected: 0 } as Record<ImprovementStatus, number>
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
// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込みは rawRequests が担う。
// 一括選別の選択（selectedReqIds）は行 id ベースのため、ページを跨いでも選択状態は維持される）
const { page: rawPage, pageSize: rawPageSize, rows: pagedRawRequests, total: rawTotal } = useListView<ImprovementRequest>({ source: rawRequests })
const rawTableRows = computed(() => pagedRawRequests.value as unknown as Record<string, unknown>[])
// 受付箱の一覧に添付を直接表示するため、表示中ページの行の画像を先読みする（改修依頼 2026-08-18。
// API モードの全件 GET は images を含まないため = 遅延ロード。未集約分は 1 リクエストのまとめ取得・
// 集約済みは案件単位で、完了済み + 進行中の両方をメモ化して重複発行しない〔R1 レビュー反映〕。
// 失敗は非ブロッキング〔原則4〕。モックモードは即時 no-op）
watch(pagedRawRequests, (rows) => {
  for (const r of rows) void imp.loadRequestImagesFor(r)
}, { immediate: true })

/**
 * 対象ページへの遷移リンク（改修依頼 2026-08-18）。アプリ内パスのみリンク化（shared isInternalPagePath =
 * '//host' のプロトコル相対 URL 等は外部遷移になるためリンクにしない。旧データにも効く表示側の防御 =
 * R1 監査 MAJOR-1。'' = 全体/新設ページはテキストのまま）
 */
function pageLinkOf(pagePath: string | null | undefined): string | null {
  const p = String(pagePath ?? '').trim()
  return isInternalPagePath(p) ? p : null
}
/** 一覧行 → ImprovementRequest（UiDataTable の行型は Record<string, unknown> のため、キャストは 1 か所に集約 = レビュー R4） */
function reqOf(row: Record<string, unknown>): ImprovementRequest {
  return row as unknown as ImprovementRequest
}

// select = 一括選別の複数選択 / ops = 行内の 採用/不採用（改修依頼 2026-08-18）。
// primary 指定列はモバイルのカード表示にも出す（一覧上の選別操作をモバイルでも可能にする = 原則8）
const RAW_COLUMNS: TableColumn[] = [
  // 列順は「対象ページ → 要望 → 投稿者 → それ以外」（改修依頼 2026-08-19）。
  // 先頭の select は一括選別のチェックボックス（データ列ではなく行選択の操作列）のため列順の対象外で先頭固定。
  // select / ops は行データにキーの無い仮想列 = ソート不可（飾りのソートボタンを出さない = X-1）
  { key: 'select', label: '選択', width: '44px', primary: true, sortable: false },
  // page も行データにキーの無い仮想列（スロット描画 = pageLabel/リンク）= ソート不可
  { key: 'page', label: '対象ページ', width: '180px', sortable: false },
  { key: 'body', label: '要望', primary: true },
  { key: 'memberName', label: '投稿者', width: '110px' },
  // attachments は行データにキーの無い仮想列（添付の直接確認 = 改修依頼 2026-08-18。リンク = 別タブ・画像 = 押下で拡大）
  { key: 'attachments', label: '添付', width: '170px', primary: true, sortable: false },
  // adoption は表示値（集約済みバッジ・未定義の補完）が保存値と異なるためソート不可（並びが表示と矛盾しない = R10）
  { key: 'adoption', label: '選別', width: '90px', primary: true, sortable: false },
  { key: 'ops', label: '選別操作', width: '150px', primary: true, sortable: false },
  // comments も行データにキーの無い仮想列（スロット描画 = コメント集計）= ソート不可
  { key: 'comments', label: 'コメント', width: '70px', align: 'right', sortable: false },
  // タイムスタンプは秒まで表示（yyyy/MM/dd HH:mm:ss = 改修依頼 2026-08-18）
  { key: 'createdAt', label: '投稿日時', width: '160px', primary: true },
]

// 生要望の詳細ドロワー（選別・コメント・添付の参照）
const selectedRequestId = ref<string | null>(null)
const selectedRequest = computed<ImprovementRequest | null>(() =>
  imp.allRequests.value.find(r => r.id === selectedRequestId.value) ?? null)
/** 集約先の改修単位（集約済み表示・解除可否の判定用）。決着済み（解決済み/対応しない）は解除不可 = AKO-REQ-021 */
const selectedRequestItem = computed<ImprovementItem | null>(() => {
  const iid = selectedRequest.value?.itemId
  if (!iid) return null
  return imp.activeItems.value.find(it => it.id === iid)
    ?? imp.archivedItems.value.find(it => it.id === iid)
    ?? null
})
/** 集約先が解除不可（取消済み = AKO-REQ-022 / 決着済み = AKO-REQ-021）か。ボタン表示と案内文の判定 */
const selectedRequestItemDecided = computed(() => {
  const it = selectedRequestItem.value
  if (!it) return false
  return !!it.archivedAt || !isOpenStatus(it.status)
})
const requestComments = computed(() => (selectedRequest.value ? imp.commentsForRequest(selectedRequest.value.id) : []))
const commentInput = ref('')
const commentBusy = ref(false)

/** 選択中の要望が自分の投稿か（一般利用者は自分の要望のみ編集・コメント・取消できる = 改修依頼 2026-08-19 第4弾） */
const isOwnSelectedRequest = computed(() => !!selectedRequest.value && selectedRequest.value.memberId === currentUserId.value)
/** 選択中の要望に書込（編集・コメント・取消）できるか（本人または管理権限者。選別/ステータスは管理者のみ = 別ゲート） */
const canWriteSelectedRequest = computed(() => isOwnSelectedRequest.value || canManageImprovements.value)

function openRequestDrawer(row: Record<string, unknown>): void {
  selectedRequestId.value = String(row.id)
  commentInput.value = ''
  requestEditing.value = false
  const r = imp.allRequests.value.find(x => x.id === selectedRequestId.value)
  if (r) void imp.loadRequestImagesFor(r) // 添付画像の遅延ロード（非ブロッキング）
}
/** 生要望カンバン/ガント・一般の受付箱一覧から詳細ドロワーを開く（改修依頼 2026-08-19 第4弾） */
function openRequestDetail(r: ImprovementRequest): void {
  openRequestDrawer({ id: r.id })
}
/** 要望本文の 1 行プレビュー（改行を詰める。一般の受付箱一覧の表示用） */
function reqBodyLine(r: ImprovementRequest): string {
  return r.body.trim().replace(/\s*\n\s*/g, ' ')
}
/** 要望の投稿元表示（対象ページ名＋対象箇所） */
function reqWhere(r: ImprovementRequest): string {
  return [r.pageLabel || r.pagePath, r.targetSpot].filter(Boolean).join(' / ')
}

/** 有効な生要望（新しい順）。全利用者が閲覧できる（生要望カンバン/ガント・一般の受付箱の共通ソース） */
const activeRequests = computed<ImprovementRequest[]>(() =>
  [...imp.allRequests.value]
    .filter(r => !r.archivedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)))
// 一般利用者の受付箱一覧のページング（1 ページ 20 件。管理者は既存の選別テーブルを使う）。
// 添付は一覧にサムネイル表示せず、詳細ドロワーを開いたとき（openRequestDrawer）に遅延ロードする
const { page: genPage, pageSize: genPageSize, rows: pagedGeneralRequests, total: genTotal } =
  useListView<ImprovementRequest>({ source: activeRequests })

// ---------- 生要望の編集（改修依頼 2026-08-18 → 2026-08-19 で本文以外の項目も編集可能に。共通部品 ImprovementsRequestEditForm） ----------
// 編集は全項目の上書きだが editedAt を記録して「編集済み」を明示（再編集で戻せる = 原則9.5）。取消済みは編集不可

const requestEditing = ref(false)
const requestEditBusy = ref(false)
const requestEditOpening = ref(false)
// 編集開始時点で画像が編集可能か（= 遅延ロード済みか）を確定して保持する。フォーム表示・保存の両方で
// この 1 つの値を使い、開いてから保存までの間にロードが完了しても判断がぶれない（= 未ロードで開いた編集が
// 途中の loaded 遷移で images:[] を「全削除」として送ってしまう事故を防ぐ = レビュー R2）
const requestImagesEditable = ref(true)

// 編集開始は添付画像のロード完了をゲートする（レビュー R1 CRIT）: API モードの一覧 GET は画像を含まない
// （images:[] スタブ）ため、未ロードのまま編集フォームを開いて保存すると添付を全消ししてしまう。
// ロード完了を待ってからフォームを表示する。ロードに失敗した場合は images を送らず現行添付を保持し、
// フォームでも画像編集を無効化して追加の無言喪失を防ぐ（レビュー R2 MINOR）
async function startRequestEdit(): Promise<void> {
  if (!selectedRequest.value || requestEditOpening.value) return
  requestEditOpening.value = true
  try {
    await imp.loadRequestImagesFor(selectedRequest.value)
  } finally {
    requestEditOpening.value = false
    if (selectedRequest.value && !selectedRequest.value.archivedAt) {
      requestImagesEditable.value = imp.imagesLoadedForRequest(selectedRequest.value)
      if (!requestImagesEditable.value) {
        toast.show('添付画像を読み込めませんでした。本文・タグ・リンクのみ編集できます（現在の添付は保持されます）', 'warn')
      }
      requestEditing.value = true
    }
  }
}

async function saveEditRequest(payload: { body: string; tags: string[]; links: string[]; images: ImprovementRequestImage[] }): Promise<void> {
  if (!selectedRequest.value || requestEditBusy.value) return
  requestEditBusy.value = true
  try {
    // 画像が編集不可（遅延ロード失敗）で開いた編集は images をパッチから外し、現行の添付を保持する
    // （部分更新の鉄則。開いた時点の判断を使う = 途中の loaded 遷移で空配列を全削除として送らない）
    const patch = requestImagesEditable.value
      ? payload
      : { body: payload.body, tags: payload.tags, links: payload.links }
    const res = await imp.editRequest(selectedRequest.value.id, patch)
    if (res.ok) {
      requestEditing.value = false
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える編集を黙認しない）
        toast.show('要望を編集しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        toast.show('要望を編集しました', 'ok')
      }
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    requestEditBusy.value = false
  }
}

/** 1 件選別の実行中フラグ（連打の二重送信・トグルの空振りを防ぐ = レビュー R21。行内・ドロワー共用） */
const adoptionBusy = ref(false)

/** 選別の変更（採用 / 不採用 / 未選別に戻す。遷移自由 = 原則9.5。採用分のみ AI 集約対象） */
async function changeAdoption(id: string, to: 'pending' | 'adopted' | 'declined'): Promise<void> {
  if (adoptionBusy.value) return
  adoptionBusy.value = true
  try {
    await changeAdoptionInner(id, to)
  } finally {
    adoptionBusy.value = false
  }
}
async function changeAdoptionInner(id: string, to: 'pending' | 'adopted' | 'declined'): Promise<void> {
  const res = await imp.setRequestAdoption(id, to)
  if (res.ok) {
    const label = IMPROVEMENT_REQUEST_ADOPTION_META[to].label
    if (res.persisted === false) {
      // mock の localStorage 容量超過（submit と同型の警告 = 消える変更を黙認しない。レビュー R16）
      toast.show(`「${label}」にしましたが、保存容量が上限に達したため再読込時に失われる可能性があります`, 'warn')
    } else {
      toast.show(to === 'adopted' ? `「${label}」にしました（「AI で集約」の対象になります）` : `「${label}」にしました`, 'ok')
    }
  } else {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

// ---------- 受付箱の一覧内選別（行内 採用/不採用 + 複数選択の一括選別 = 改修依頼 2026-08-18） ----------

/** 選別を変更できる行か（共有ガード improvementAdoptionError と同一判定 = 条件の分散コピーを作らない。原則3/6） */
function isTriageable(r: ImprovementRequest): boolean {
  return improvementAdoptionError(r) === null
}
/** 選別を変更できる行（集約済み・取消済みは対象外 = setRequestAdoption のガードと一致） */
const selectableRequests = computed(() => rawRequests.value.filter(isTriageable))
const selectedReqIds = ref<string[]>([])
const bulkBusy = ref(false)

// データ更新（集約・取消等）で選別対象外になった id は選択から外す（無効 id への一括操作を防ぐ）
watch(selectableRequests, (rows) => {
  const ok = new Set(rows.map(r => r.id))
  if (selectedReqIds.value.some(id => !ok.has(id))) {
    selectedReqIds.value = selectedReqIds.value.filter(id => ok.has(id))
  }
})
// 絞り込みを変えたら選択をリセット（見えていない行への一括操作を防ぐ）
watch(rawFilter, () => { selectedReqIds.value = [] })

const allSelected = computed(() =>
  selectableRequests.value.length > 0 && selectedReqIds.value.length === selectableRequests.value.length)

function toggleSelect(id: string): void {
  selectedReqIds.value = selectedReqIds.value.includes(id)
    ? selectedReqIds.value.filter(x => x !== id)
    : [...selectedReqIds.value, id]
}
function toggleSelectAll(): void {
  selectedReqIds.value = allSelected.value ? [] : selectableRequests.value.map(r => r.id)
}

/** 行内の 採用/不採用（同じ選別をもう一度押すと未選別へ戻す = 取消フロー・原則9.5） */
async function toggleRowAdoption(r: ImprovementRequest, to: 'adopted' | 'declined'): Promise<void> {
  await changeAdoption(r.id, requestAdoptionOf(r) === to ? 'pending' : to)
}

/** 選択した要望をまとめて選別（採用/不採用/未選別に戻す。部分成功は件数で案内 = 原則4。成功後は選択解除） */
async function bulkAdoption(to: 'adopted' | 'declined' | 'pending'): Promise<void> {
  if (bulkBusy.value || selectedReqIds.value.length === 0) return
  bulkBusy.value = true
  try {
    const res = await imp.setRequestAdoptionBulk(selectedReqIds.value, to)
    if (!res.ok) {
      toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
      return
    }
    // 成功分は選択解除・再操作できる失敗分だけ選択に残す（レビュー R15）。
    // 代入時点の選別可能行で濾す: refresh 後の watch は代入より先に走り終えるため、選別不能になった行
    //（他者の集約・取消等）をここで除かないと見えない選択が残留する（レビュー R16）。
    // トーストは実際に残った件数で案内する（残していないのに「残した」と言わない = レビュー R17）
    const stillSelectable = new Set(selectableRequests.value.map(r => r.id))
    const retained = (res.failedIds ?? []).filter(id => stillSelectable.has(id))
    const retainedNote = retained.length > 0 ? `。再操作できる ${retained.length} 件は選択に残しました` : ''
    const label = IMPROVEMENT_REQUEST_ADOPTION_META[to].label
    if (res.persisted === false) {
      // mock の localStorage 容量超過（submit と同型の警告 = 消える変更を黙認しない。レビュー R7）。
      // 部分失敗が同時に起きた場合はその件数も併記する（容量警告で失敗報告を握り潰さない = レビュー R10）
      const failedNote = res.failed > 0 ? `。${res.failed} 件は変更できませんでした${retainedNote}` : ''
      toast.show(`${res.done} 件を「${label}」にしましたが、保存容量が上限に達したため再読込時に失われる可能性があります${failedNote}`, 'warn')
    } else if (res.failed > 0) {
      // 部分成功は失敗の理由（最後のエラー）も添える（原因不明の「変更できませんでした」で終わらせない = レビュー R6）
      const reason = res.error ? `。${res.error.message}` : ''
      toast.show(`${res.done} 件を「${label}」にしました（${res.failed} 件は変更できませんでした${reason}${retainedNote}）`, 'warn')
    } else {
      toast.show(to === 'adopted'
        ? `${res.done} 件を「${label}」にしました（「AI で集約」の対象になります）`
        : to === 'pending'
          ? `${res.done} 件を「${label}」に戻しました`
          : `${res.done} 件を「${label}」にしました`, 'ok')
    }
    selectedReqIds.value = retained
  } finally {
    bulkBusy.value = false
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

/**
 * 集約の解除（F-42-19・追加指示 2026-08-18）。集約済みの要望を改修単位から外し、
 * 「採用済み（集約待ち）」へ戻す = 次回の「採用済みを AI で集約」で再度整理の対象になる。
 * 受付箱ドロワー（集約済み表示）と改修単位ドロワーの元要望カードの両方から呼ぶ。
 */
const unclusterBusy = ref(false)
async function unclusterRequestWithConfirm(id: string): Promise<void> {
  if (unclusterBusy.value) return // 二重発火ガード（成功直後の再送が AKO-REQ-017 の誤エラー表示になるのを防ぐ）
  unclusterBusy.value = true
  try {
    const ok = await confirm.ask(
      '集約の解除',
      'この要望を改修単位から外し、「採用済み（集約待ち）」に戻します。次回の「採用済みを AI で集約」で再度整理の対象になります。'
      + 'なお、解除した要望が AI 集約で元の改修単位へ戻ることはありません（別の単位として整理されます）。',
    )
    if (!ok) return
    const res = await imp.unclusterRequest(id)
    if (res.ok) {
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える変更を黙認しない。レビュー R7）
        toast.show('集約を解除しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        toast.show('集約を解除しました（採用済み・集約待ちに戻りました）', 'ok')
      }
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    unclusterBusy.value = false
  }
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
          ? '採用済みの要望がありません。受付箱で「採用」してから集約してください'
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
    if (res.persisted === false) {
      // mock の localStorage 容量超過（他の書込と同型の警告 = 集約結果の消失を黙認しない。レビュー R17）
      toast.show(`${how}で集約しました（改修単位 新規${res.created}・追記${res.appended}／要望${res.clustered}件）が、保存容量が上限に達したため再読込時に失われる可能性があります`, 'warn')
    } else {
      toast.show(`${how}で集約しました（改修単位 新規${res.created}・追記${res.appended}／要望${res.clustered}件）`, 'ok')
    }
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

// ---------- タブ（受付箱 / 改修案件 / カンバン / ガントチャート = 改修依頼 2026-08-18） ----------
// サマリーカードの下にタブメニューを置き、受付箱 = 生要望の選別 / 改修案件 = AI 集約後の一覧 /
// カンバン・ガントチャート = 既存ビュー を切り替える。?tab= のディープリンクは useRouteTabSync で取り込む
// 改修依頼 2026-08-19 第4弾 項目5.5: 要望系（全員閲覧可）と改修案件系（管理者のみ）へタブを分離。
// - 一般利用者: 受付箱（全要望を閲覧・自分のみ編集・ステータス変更不可）/ カンバン / ガント（いずれも要望系）。
// - 管理権限者: 上記に加えて 改修案件 / 【改修案件】カンバン / 【改修案件】ガント。要望系タブは【要望】と明示。
const TAB_KEYS = ['inbox', 'req-kanban', 'req-gantt', 'items', 'kanban', 'gantt'] as const
const tab = ref<string>('inbox')
// タブ利用可否（権限表の `tab:<key>` 擬似フィールド = 改修依頼 2026-08-18。既定 = 全タブ利用可）
const tabs = computed<TabItem[]>(() => {
  const manage = canManageImprovements.value
  const base: TabItem[] = [
    { key: 'inbox', label: '受付箱', badge: manage ? imp.pendingRequests.value.length : undefined },
    { key: 'req-kanban', label: manage ? '【要望】カンバン' : 'カンバン' },
    { key: 'req-gantt', label: manage ? '【要望】ガント' : 'ガント' },
  ]
  const adminOnly: TabItem[] = manage
    ? [
        { key: 'items', label: '改修案件' },
        { key: 'kanban', label: '【改修案件】カンバン' },
        { key: 'gantt', label: '【改修案件】ガント' },
      ]
    : []
  return [...base, ...adminOnly].filter(t => canTab('improvements', t.key))
})
useRouteTabSync(tab, { valid: TAB_KEYS })
watchEffect(() => {
  // 権限で消えたタブは先頭の利用可能タブへ退避。全タブ deny の場合は空値にして
  // どのタブ内容も描画しない（フェイルクローズ = R1 レビュー反映）
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = tabs.value[0]?.key ?? ''
})

// ページングの 1 ページ目リセット（tab がここで定義されるため watch もここに置く。
// タブ切替・絞り込み・検索の変更で対象一覧を先頭ページから表示する = 改修依頼 2026-08-18）
watch([tab, rawFilter], () => { rawPage.value = 1 })
watch([tab, uiFilter, search], () => { itemPage.value = 1 })

/** サマリーカードからのタブ直行（受付箱カード = 受付箱タブ / ステータスカード = 改修案件タブ + 絞り込み） */
function goInbox(): void {
  tab.value = 'inbox'
  // カードの「未選別」件数どおりの一覧へ直行（残っていた絞り込みと食い違わせない = goItems と同じ規則）
  rawFilter.value = 'pending'
}
function goItems(filter: ImprovementFilter): void {
  tab.value = 'items'
  uiFilter.value = filter
  // 残っていた検索語で件数と一覧が食い違わないようにする（カードの件数どおりの一覧へ直行 = レビュー指摘）
  search.value = ''
}

/** サマリーカードの定義（v-for で 1 か所に描画 = クリック可能カードの boilerplate を複製しない。レビュー R4） */
const summaryCards = computed(() => [
  { key: 'inbox', label: '受付箱', value: imp.pendingRequests.value.length, sub: '未選別（選別待ち）', icon: 'Inbox', inverse: false, aria: '受付箱タブを開く', go: goInbox },
  { key: 'triage', label: '未判定', value: counts.value.triage, sub: '対応可否の判定待ち', icon: 'HelpCircle', inverse: false, aria: '改修案件タブを未判定で開く', go: () => goItems('triage') },
  { key: 'accepted', label: '対応する', value: counts.value.accepted, sub: '改修予定（未着手）', icon: 'Wrench', inverse: false, aria: '改修案件タブを対応するで開く', go: () => goItems('accepted') },
  { key: 'in_progress', label: '対応中', value: counts.value.in_progress, sub: '着手済み（未解決）', icon: 'Loader', inverse: false, aria: '改修案件タブを対応中で開く', go: () => goItems('in_progress') },
  { key: 'resolved', label: '解決済み', value: counts.value.resolved, sub: '改修完了', icon: 'CheckCircle2', inverse: true, aria: '改修案件タブを解決済みで開く', go: () => goItems('resolved') },
  { key: 'rejected', label: '対応しない', value: counts.value.rejected, sub: '見送り', icon: 'MinusCircle', inverse: false, aria: '改修案件タブを対応しないで開く', go: () => goItems('rejected') },
])

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
// 出力対象は「対応する」ステータスの改修単位のみ（改修依頼 2026-08-18。従来の既定 open は
// 未判定も含んでいたため除外 = フィルタ選択 UI も撤去して対象を固定する）
const promptOpen = ref(false)
const promptText = ref('')
const promptCount = ref(0)
const promptBusy = ref(false)

async function openPrompt(): Promise<void> {
  promptOpen.value = true
  await refreshPrompt()
}
async function refreshPrompt(): Promise<void> {
  promptBusy.value = true
  const res = await imp.buildPrompt('accepted')
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
      <!-- AI 集約・改修プロンプト出力は管理権限者のみ（改修依頼 2026-08-19 第4弾: 一般利用者は要望の閲覧・投稿のみ） -->
      <template v-if="canManageImprovements" #actions>
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

    <!-- 改修依頼 2026-08-19 第4弾: 生要望の閲覧は全員可。改修案件系（サマリー・集約・プロンプト）は管理者のみ表示 -->
    <div class="mt-4 grid gap-3">
      <!-- サマリーカード（受付箱の件数 + 改修単位のステータス別件数 = 改修依頼 2026-08-18）。押下で該当タブへ直行。
           改修単位の件数を含むため管理権限者のみ表示（一般利用者には出さない） -->
      <!-- 対応中の追加（2026-08-18）で 6 枚 = lg は 6 列で 1 行に収める -->
      <div v-if="canManageImprovements" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <UiKpiCard
          v-for="c in summaryCards"
          :key="c.key"
          :label="c.label"
          :value="String(c.value)"
          :sub="c.sub"
          :icon="c.icon"
          :inverse="c.inverse"
          class="cursor-pointer transition-colors hover:border-brand"
          role="button"
          tabindex="0"
          :aria-label="c.aria"
          @click="c.go()"
          @keydown.enter.prevent="c.go()"
          @keydown.space.prevent="c.go()"
        />
      </div>

      <!-- タブメニュー（受付箱 / 改修案件 / カンバン / ガントチャート = 改修依頼 2026-08-18） -->
      <UiTabBar v-model="tab" :tabs="tabs" />
      <!-- 全タブ deny 時の空状態（タブ内容は tab='' のためどれも描画されない = フェイルクローズ） -->
      <p v-if="tabs.length === 0" class="card p-6 text-center text-[13px] text-sub">利用できるタブがありません（権限設定で制限されています。管理者にお問い合わせください）</p>

      <!-- ① 受付箱: まず投稿された生の一覧を確認し、採用/不採用を選別する（改善要望 2026-08-17 第 2 弾）。
           採用された要望のみが「AI で集約」の対象になる。一覧上の「採用」「不採用」ボタン・複数選択の
           一括選別で直接選別できる（改修依頼 2026-08-18）。行クリックで詳細（本文全文・添付・コメント・選別） -->
      <UiSectionCard
        v-if="tab === 'inbox' && canManageImprovements"
        flush
        title="受付箱"
        description="投稿された生の要望を確認し、採用／不採用を選別します。採用した要望だけが「AI で集約」の対象になります。一覧の「採用」「不採用」で直接選別でき、複数選択してまとめて選別もできます。行クリックでコメントのやり取り・添付の参照ができます"
      >
        <div class="border-b border-line p-2">
          <UiChipTabs v-model="rawFilter" :options="RAW_FILTER_OPTIONS" />
        </div>
        <!-- 一括選別バー（複数選択 → まとめて採用/不採用 = 改修依頼 2026-08-18） -->
        <div
          v-if="selectableRequests.length > 0"
          class="flex flex-wrap items-center gap-2 border-b border-line bg-surface-soft px-3 py-2"
        >
          <label class="flex min-h-6 cursor-pointer items-center gap-1.5 text-[12px] text-sub">
            <input
              type="checkbox"
              class="h-4 w-4 accent-[var(--c-brand)]"
              :checked="allSelected"
              :disabled="bulkBusy"
              aria-label="絞り込み結果の選別できる要望をすべて選択（全ページ対象）"
              @change="toggleSelectAll"
            >
            <!-- ページング導入後も対象は絞り込み結果の全件（全ページ）= 表示中の 20 件だけではない（R1 レビュー NIT-1 の明示） -->
            すべて選択（全ページ）
          </label>
          <span class="num text-[12px]" :class="selectedReqIds.length > 0 ? 'font-semibold text-brand' : 'text-muted'">
            {{ selectedReqIds.length }} 件選択中
          </span>
          <!-- 実行中の可視フィードバック（ボタン無効化だけで黙らせない = X-1。レビュー R23） -->
          <span v-if="bulkBusy" class="text-[12px] text-muted" role="status">処理中…</span>
          <div class="ml-auto flex gap-2">
            <button
              type="button" class="btn btn-primary btn-sm"
              :disabled="selectedReqIds.length === 0 || bulkBusy"
              @click="bulkAdoption('adopted')"
            >
              まとめて採用
            </button>
            <button
              type="button" class="btn btn-ghost btn-sm"
              :disabled="selectedReqIds.length === 0 || bulkBusy"
              @click="bulkAdoption('declined')"
            >
              まとめて不採用
            </button>
            <!-- 一括操作の取り消しも一括でできるようにする（誤って一括採用/不採用 → 1 件ずつ戻す非対称を作らない = 原則9.5・レビュー R9） -->
            <button
              type="button" class="btn btn-ghost btn-sm"
              :disabled="selectedReqIds.length === 0 || bulkBusy"
              @click="bulkAdoption('pending')"
            >
              まとめて未選別に戻す
            </button>
          </div>
        </div>
        <UiDataTable
          :columns="RAW_COLUMNS"
          :rows="rawTableRows"
          clickable
          empty-title="該当する要望はありません"
          :empty-hint="rawFilter === 'pending' ? '未選別の要望はありません。新しい投稿を待つか、他の絞り込みを確認してください' : '絞り込みを変えて確認してください'"
          @row-click="openRequestDrawer"
        >
          <!-- 複数選択（選別できる行のみ。クリックは行クリックへ伝播させない） -->
          <template #cell-select="{ row }">
            <input
              v-if="isTriageable(reqOf(row))"
              type="checkbox"
              class="h-4 w-4 accent-[var(--c-brand)]"
              :checked="selectedReqIds.includes(String(row.id))"
              :disabled="bulkBusy"
              :aria-label="`要望「${String(reqOf(row).body).slice(0, 20)}」を一括選別の対象に選択`"
              @click.stop
              @change="toggleSelect(String(row.id))"
            >
            <span v-else class="text-[11px] text-muted">—</span>
          </template>
          <template #cell-body="{ row }">
            <div class="min-w-0">
              <span class="line-clamp-2 text-[13px] text-ink">{{ row.body }}</span>
              <!-- 投稿時の任意タグ（壁打ち/お任せ = F-42-17。共通部品 = 各ドロワーと共用。
                   空判定・normalize・外枠は部品側 = 未知値だけの行に空の余白を作らない = R13/R20） -->
              <ImprovementsTagBadges :tags="reqOf(row).tags" wrapper-class="mt-0.5 flex flex-wrap gap-1" />
            </div>
          </template>
          <!-- 添付の直接確認（改修依頼 2026-08-18）: リンク = 別タブ・画像 = 押下で拡大（既存の共通部品を共用）。
               行クリック（ドロワー起動）と干渉しないよう click は止める -->
          <template #cell-attachments="{ row }">
            <div
              v-if="(reqOf(row).links?.length ?? 0) > 0 || (reqOf(row).images?.length ?? 0) > 0"
              @click.stop
            >
              <ImprovementsAttachmentList
                :links="reqOf(row).links"
                :images="reqOf(row).images"
                @preview="(img) => { previewImage = img }"
              />
            </div>
            <span v-else class="text-[11px] text-muted">—</span>
          </template>
          <template #cell-adoption="{ row }">
            <UiStatusBadge
              v-if="reqOf(row).itemId"
              tone="info"
              label="集約済み"
              dot
            />
            <UiStatusBadge
              v-else
              :tone="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(reqOf(row))].tone"
              :label="IMPROVEMENT_REQUEST_ADOPTION_META[requestAdoptionOf(reqOf(row))].label"
              dot
            />
          </template>
          <!-- 行内の 採用/不採用（同じ選別の再押下 = 未選別へ戻す。集約済み・取消済みは操作なし） -->
          <template #cell-ops="{ row }">
            <div
              v-if="isTriageable(reqOf(row))"
              class="flex gap-1"
              @click.stop
            >
              <button
                type="button"
                class="btn btn-sm"
                :class="requestAdoptionOf(reqOf(row)) === 'adopted' ? 'btn-primary' : 'btn-ghost'"
                :aria-pressed="requestAdoptionOf(reqOf(row)) === 'adopted'"
                :disabled="adoptionBusy || bulkBusy"
                :title="requestAdoptionOf(reqOf(row)) === 'adopted' ? 'もう一度押すと未選別に戻します' : '採用する（AI 集約の対象）'"
                @click="toggleRowAdoption(reqOf(row), 'adopted')"
              >
                採用
              </button>
              <button
                type="button"
                class="btn btn-sm"
                :class="requestAdoptionOf(reqOf(row)) === 'declined' ? 'btn-danger' : 'btn-ghost'"
                :aria-pressed="requestAdoptionOf(reqOf(row)) === 'declined'"
                :disabled="adoptionBusy || bulkBusy"
                :title="requestAdoptionOf(reqOf(row)) === 'declined' ? 'もう一度押すと未選別に戻します' : '不採用にする'"
                @click="toggleRowAdoption(reqOf(row), 'declined')"
              >
                不採用
              </button>
            </div>
            <span v-else class="text-[11px] text-muted">—</span>
          </template>
          <template #cell-memberName="{ row }">
            <span class="text-[12px] text-sub">{{ row.memberName }}</span>
          </template>
          <!-- 対象ページ（改修依頼 2026-08-18: 実パスは押下で当該ページへ遷移して確認できる） -->
          <template #cell-page="{ row }">
            <NuxtLink
              v-if="pageLinkOf(reqOf(row).pagePath)"
              :to="pageLinkOf(reqOf(row).pagePath)!"
              class="link text-[12px]"
              :aria-label="`対象ページ（${String(row.pageLabel || row.pagePath)}）を開く`"
              @click.stop
            >{{ String(row.pageLabel || row.pagePath) }}</NuxtLink>
            <span v-else class="text-[12px] text-sub">{{ String(row.pageLabel || row.pagePath || 'ページ不明') }}</span>
          </template>
          <template #cell-comments="{ row }">
            <span class="num" :class="(imp.commentCountByRequest.value.get(String(row.id)) ?? 0) > 0 ? 'font-semibold text-brand' : 'text-muted'">
              {{ imp.commentCountByRequest.value.get(String(row.id)) ?? 0 }}
            </span>
          </template>
          <template #cell-createdAt="{ row }">
            <!-- 受付箱のタイムスタンプは yyyy/MM/dd HH:mm:ss（改修依頼 2026-08-18） -->
            <span class="num text-[12px] text-muted">{{ fmtDateTimeSec(row.createdAt as string) }}</span>
          </template>
        </UiDataTable>
        <UiPagination v-model:page="rawPage" v-model:page-size="rawPageSize" :total="rawTotal" />
      </UiSectionCard>

      <!-- 受付箱（一般利用者）: 全要望を閲覧できる読み取り専用リスト。編集は自分の要望のみ・選別/ステータス変更は管理者のみ（改修依頼 2026-08-19 第4弾） -->
      <UiSectionCard
        v-else-if="tab === 'inbox'"
        flush
        title="受付箱（すべての要望）"
        description="全メンバーから寄せられた要望を閲覧できます。編集できるのは自分が投稿した要望のみです。採用／不採用の選別・ステータス変更・AI 集約は管理者が行います。行クリックで詳細（本文全文・添付・コメント）を確認できます"
      >
        <UiEmptyState v-if="activeRequests.length === 0" title="まだ要望がありません" hint="各ページの「要望を送る」から投稿できます" />
        <ul v-else class="divide-y divide-line">
          <li v-for="r in pagedGeneralRequests" :key="r.id">
            <button
              type="button"
              class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
              @click="openRequestDetail(r)"
            >
              <span class="min-w-0 flex-1">
                <span class="line-clamp-2 text-[13px] font-semibold text-ink">{{ reqBodyLine(r) }}</span>
                <span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                  <span v-if="reqWhere(r)" class="truncate">{{ reqWhere(r) }}</span>
                  <span>{{ r.memberName }}<span v-if="r.memberId === currentUserId" class="ml-0.5 text-brand">（自分）</span></span>
                  <span class="num">{{ fmtDateTimeSec(r.createdAt) }}</span>
                </span>
              </span>
              <UiStatusBadge
                :tone="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].tone"
                :label="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].label"
                dot
                class="shrink-0"
              />
            </button>
          </li>
        </ul>
        <UiPagination v-model:page="genPage" v-model:page-size="genPageSize" :total="genTotal" />
      </UiSectionCard>

      <!-- 【要望】カンバン: 要望をステータス別（未対応/対応済み/見送り）に一望（全員閲覧可・参照専用） -->
      <ImprovementsRequestKanban
        v-else-if="tab === 'req-kanban'"
        :requests="activeRequests"
        @open="openRequestDetail"
      />

      <!-- 【要望】ガント: 要望の投稿タイムライン（全員閲覧可・参照専用） -->
      <ImprovementsRequestGantt
        v-else-if="tab === 'req-gantt'"
        :requests="activeRequests"
        @open="openRequestDetail"
      />

      <!-- カンバン: ステータス別に進捗を一望 -->
      <ImprovementsKanban
        v-else-if="tab === 'kanban'"
        :items="imp.activeItems.value"
        :req-count="reqCount"
        @open="openDrawerItem"
        @status="onKanbanStatus"
      />

      <!-- ガントチャート: 対応予定期間を月次/週次/日次で可視化 -->
      <ImprovementsGantt
        v-else-if="tab === 'gantt'"
        :items="imp.activeItems.value"
        @open="openDrawerItem"
      />

      <!-- ② 改修案件（採用 → AI 集約後の一覧）: フィルターと一覧。
           タブキーの明示指定: tab=''（全タブ deny の退避値）でフォールバック描画しない = フェイルクローズ（R2 レビュー反映） -->
      <UiSectionCard v-else-if="tab === 'items'" flush>
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
        <UiPagination v-model:page="itemPage" v-model:page-size="itemPageSize" :total="itemTotal" />
      </UiSectionCard>

      <p class="text-[12px] text-muted">
        未選別 {{ imp.pendingRequests.value.length }} 件・採用済み（集約待ち）{{ imp.adoptedUnclustered.value.length }} 件。
        受付箱で選別し、「採用済みを AI で集約」で改修単位に整理できます。
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
                  <!-- 添付（リンク = 別タブ・画像 = 押下で拡大。共通部品 = 生要望ドロワーと共用） -->
                  <ImprovementsAttachmentList
                    :links="r.links"
                    :images="r.images"
                    @preview="(img) => { previewImage = img }"
                  />
                  <p class="mt-1 text-[11px] text-muted">
                    {{ r.memberName }}・<NuxtLink
                      v-if="pageLinkOf(r.pagePath)"
                      :to="pageLinkOf(r.pagePath)!"
                      class="link"
                    >{{ r.pageLabel || r.pagePath }}</NuxtLink><template v-else>{{ r.pageLabel || r.pagePath || 'ページ不明' }}</template>・{{ fmtDate(r.createdAt) }}
                  </p>
                  <!-- 要望単位のステータス（進捗タグ）。変更はプロンプト再生成に反映（【対応済み】【見送り】明記） -->
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <UiStatusBadge
                      :tone="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].tone"
                      :label="IMPROVEMENT_REQUEST_STATUS_META[requestStatusOf(r)].label"
                      dot
                    />
                    <!-- 投稿時の任意タグ（壁打ち/お任せ = F-42-17。プロンプトにも〔壁打ち〕〔お任せ〕で反映） -->
                    <ImprovementsTagBadges :tags="r.tags" />
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
                <div class="flex shrink-0 flex-col items-stretch gap-1">
                  <!-- 集約解除 = 改修単位から外して「採用済み（集約待ち）」へ戻す（再度 AI 集約の対象 = F-42-19）。
                       決着済み item = AKO-REQ-021（先に reopen）・取消済み item = AKO-REQ-022（先に復元）は不可 = 記録保護 -->
                  <button
                    v-if="!selected.archivedAt && isOpenStatus(selected.status)"
                    type="button"
                    class="btn btn-ghost btn-sm"
                    title="この要望の集約を解除（採用済み・集約待ちへ戻して再度 AI 集約の対象にする）"
                    :disabled="unclusterBusy"
                    @click="unclusterRequestWithConfirm(r.id)"
                  >
                    集約解除
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" title="この要望を取消" @click="archiveRequest(r.id)">
                    取消
                  </button>
                </div>
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

    <!-- 受付箱の要望の詳細ドロワー（選別・コメントのやり取り・添付の参照 = 改善要望 2026-08-17 第 2 弾） -->
    <UiDrawer :open="!!selectedRequest" title="要望の詳細" width="520px" @close="selectedRequestId = null">
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
          <!-- 投稿時の任意タグ（壁打ち/お任せ = F-42-17。hover/長押しで意味を表示） -->
          <ImprovementsTagBadges :tags="selectedRequest.tags" />
          <span v-if="selectedRequest.archivedAt" class="text-[12px] text-crit">取消済み</span>
          <span class="text-[12px] text-muted">
            {{ selectedRequest.memberName }}・<NuxtLink
              v-if="pageLinkOf(selectedRequest.pagePath)"
              :to="pageLinkOf(selectedRequest.pagePath)!"
              class="link"
            >{{ selectedRequest.pageLabel || selectedRequest.pagePath }}</NuxtLink><template v-else>{{ selectedRequest.pageLabel || selectedRequest.pagePath || 'ページ不明' }}</template>・{{ fmtDateTimeSec(selectedRequest.createdAt) }}
          </span>
          <span v-if="selectedRequest.editedAt" class="text-[11px] text-muted">
            （編集済み {{ fmtDateTime(selectedRequest.editedAt) }}）
          </span>
        </div>

        <!-- 本文 + 添付（本文・タグ・リンク・画像を編集可 = 改修依頼 2026-08-19。編集済みは editedAt で明示） -->
        <div class="card p-3">
          <!-- 編集フォーム（共通部品。本文・タグ・リンク・画像を編集。保存 = 上書き + editedAt 記録。キャンセルで破棄） -->
          <ImprovementsRequestEditForm
            v-if="requestEditing"
            :initial-body="selectedRequest.body"
            :initial-tags="selectedRequest.tags ?? []"
            :initial-links="selectedRequest.links ?? []"
            :initial-images="selectedRequest.images ?? []"
            :busy="requestEditBusy"
            :active="requestEditing"
            :images-editable="requestImagesEditable"
            @save="saveEditRequest"
            @cancel="requestEditing = false"
          />
          <template v-else>
            <div class="flex items-start gap-2">
              <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] text-ink">{{ selectedRequest.body }}</p>
              <button
                v-if="!selectedRequest.archivedAt && canWriteSelectedRequest"
                type="button"
                class="btn btn-ghost btn-sm shrink-0"
                :disabled="requestEditOpening"
                aria-label="要望を編集"
                @click="startRequestEdit"
              >
                <Pencil class="h-3.5 w-3.5" aria-hidden="true" /> 編集
              </button>
            </div>
            <!-- 添付（リンク = 別タブ・画像 = 押下で拡大。共通部品 = 改修単位ドロワーの元要望と共用） -->
            <ImprovementsAttachmentList
              :links="selectedRequest.links"
              :images="selectedRequest.images"
              @preview="(img) => { previewImage = img }"
            />
          </template>
        </div>

        <!-- 選別（採用/不採用。集約済みは変更不可 = 記録保護。取消可能性 = いつでも選び直せる）。管理権限者のみ（改修依頼 2026-08-19 第4弾） -->
        <div v-if="!selectedRequest.archivedAt && canManageImprovements" class="grid gap-2">
          <p class="label">選別</p>
          <template v-if="selectedRequest.itemId">
            <p class="text-[12px] text-muted">
              この要望は改修単位へ集約済みです（選別は変更できません）。「集約を解除」すると改修単位から外れ、
              「採用済み（集約待ち）」に戻って再度 AI 集約の対象になります（F-42-19。解除した要望が
              AI 集約で元の改修単位へ戻ることはありません = 別の単位として整理されます）。
            </p>
            <!-- 決着済み/取消済みの改修単位からは解除不可（記録保護 = 原則2。先に reopen/復元する導線を案内） -->
            <p v-if="selectedRequestItemDecided" class="text-[12px] text-warn">
              集約先の改修単位が決着済み（解決済み/対応しない）または取消済みのため解除できません。解除するには、先に改修単位のステータスを戻す／復元してください。
            </p>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm" @click="openItemOfRequest">集約先の改修単位を開く</button>
              <button
                v-if="!selectedRequestItemDecided"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="unclusterBusy"
                @click="unclusterRequestWithConfirm(selectedRequest.id)"
              >
                集約を解除（再集約の対象へ戻す）
              </button>
            </div>
          </template>
          <div v-else class="flex flex-wrap gap-2">
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'adopted'"
              type="button" class="btn btn-primary btn-sm"
              :disabled="adoptionBusy || bulkBusy"
              @click="changeAdoption(selectedRequest.id, 'adopted')"
            >採用する（AI 集約の対象）</button>
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'declined'"
              type="button" class="btn btn-ghost btn-sm"
              :disabled="adoptionBusy || bulkBusy"
              @click="changeAdoption(selectedRequest.id, 'declined')"
            >不採用にする</button>
            <button
              v-if="requestAdoptionOf(selectedRequest) !== 'pending'"
              type="button" class="btn btn-ghost btn-sm"
              :disabled="adoptionBusy || bulkBusy"
              @click="changeAdoption(selectedRequest.id, 'pending')"
            >未選別に戻す</button>
          </div>
        </div>

        <!-- コメント（やり取り。時系列・追記のみ。取消 = 論理削除 = 原則9.5）。選別検討の記録のため管理権限者のみ（改修依頼 2026-08-19 第4弾） -->
        <div v-if="canManageImprovements" class="grid gap-2">
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
        <!-- 取消/復元は投稿者本人または管理権限者のみ（改修依頼 2026-08-19 第4弾。サーバーも同一判定） -->
        <button v-if="selectedRequest && !selectedRequest.archivedAt && canWriteSelectedRequest" type="button" class="btn btn-danger" @click="archiveSelectedRequest">
          要望を取消
        </button>
        <button v-else-if="selectedRequest && selectedRequest.archivedAt && canWriteSelectedRequest" type="button" class="btn btn-ghost" @click="restoreSelectedRequest">
          <Undo2 class="h-4 w-4" aria-hidden="true" /> 取消を戻す
        </button>
      </template>
    </UiDrawer>

    <!-- 改修プロンプト出力モーダル -->
    <UiModal :open="promptOpen" title="改修プロンプトを出力" width="720px" @close="promptOpen = false">
      <div class="grid gap-3">
        <p class="text-[13px] text-sub">
          「対応する」ステータスの改修単位のみを、コーディング AI エージェント向けの詳細プロンプト（対象ページ・機能名・改修内容・元要望・受入基準）として出力します（未判定・対応中・解決済み・対応しないは含まれません = 改修依頼 2026-08-18）。
          要望ごとのステータス変更後は「再生成」で最新の状態（【対応済み】【見送り】の明記）を反映できます。
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="label">対象</span>
          <UiStatusBadge label="対応する" tone="info" dot />
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
