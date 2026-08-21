<script setup lang="ts">
/**
 * 改善要望管理（F-42 → ステータス管理の再編 = 改修依頼 2026-08-21）。
 * - 受付箱（生要望）が一次のライフサイクルを持つ: 未確認（起票時）→ 検討中 →
 *   改善対応（AI 集約の対象）/ 運用対応（起票者へ運用案内を自動通知）/ 継続検討（再検討日 +
 *   リマインド）/ 対応見送り。集約済みは改修案件の進捗に連動して「対応済み」→（起票者確認 or
 *   手動で）「解決済み」。表示ステータスの解決は useImprovements.inboxStatusOf（原則6 導出）。
 * - 改修案件（AI 集約後）は 未対応 → 対応中（担当者アサイン可・関連画面に表示）→ 対応済 の 3 状態。
 *   旧 7 値語彙の保存値は表示・遷移とも 3 状態へ正規化する（原則7）。
 * - タブは 受付箱（inbox・全員）/ 改修案件（items・管理者のみ）の 2 つ（改修依頼 2026-08-20 で再編）。
 *   各タブ内の表示は 一覧 / カンバン / ガント の切替（?view=）。旧 ?tab=（req-kanban 等）も読み替える（原則7）。
 * - フィルター結果（未対応の案件）を、コーディング AI エージェント向けの詳細プロンプトとして出力する。
 */
import { Check, ClipboardCopy, Pencil, RefreshCw, Sparkles, Undo2, UserRound, Wand2 } from 'lucide-vue-next'
import type { TabItem, TableColumn, Tone } from '~/types/ui'
import {
  IMPROVEMENT_ASSESS_META,
  IMPROVEMENT_FILTER_OPTIONS,
  IMPROVEMENT_INBOX_BASES,
  IMPROVEMENT_INBOX_FILTER_OPTIONS,
  IMPROVEMENT_INBOX_NEXT,
  IMPROVEMENT_INBOX_STATUS_META,
  IMPROVEMENT_INBOX_STATUSES,
  IMPROVEMENT_ITEM_NEXT,
  IMPROVEMENT_ITEM_STATUS_META,
  IMPROVEMENT_ITEM_VIEWS,
  improvementRevisitError,
  type ImprovementFilter,
  type ImprovementInboxBase,
  type ImprovementInboxStatus,
  type ImprovementItem,
  type ImprovementItemView,
  type ImprovementRequest,
  type ImprovementRequestImage,
  improvementItemViewOf,
  isInternalPagePath,
  isOpenItemStatus,
  matchesImprovementFilter,
  matchesInboxFilter,
  OPERATIONAL_NOTE_MAX,
} from '~/types/improvement'
import { kbDocById } from '~/types/kb'
import { fmtDate, fmtDateTime, fmtDateTimeSec } from '~/utils/format'
import { pageDisplay } from '~/utils/page-label'

const { canManageImprovements, canTab } = usePermissions()
const imp = useImprovements()
const toast = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()

onMounted(() => {
  void imp.refresh()
  // 継続検討の再検討日リマインド（mock モード・管理者のみ。日次デデュープ・非ブロッキング = 原則4）
  void imp.checkRevisitReminders()
})

// ---------- フィルター（改修案件 = 3 状態 + 未完了/すべて + 取消済み） ----------
const FILTER_OPTIONS = [...IMPROVEMENT_FILTER_OPTIONS, { value: 'archived' as const, label: '取消済み' }]
const uiFilter = ref<string>('open')
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
    || it.pagePaths.some(p => pageDisplay(p).toLowerCase().includes(q))
    // 担当者名でも検索できる（対応中アサインの関連画面表示 = 改修依頼 2026-08-21）
    || (it.assigneeName ?? '').toLowerCase().includes(q))
})

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込み・検索は rows が担う。
// page リセット watch は tab 定義の後段〔タブ定義セクション〕にまとめて置く）
const { page: itemPage, pageSize: itemPageSize, rows: pagedItems, total: itemTotal } = useListView<ImprovementItem>({ source: rows })

// UiDataTable は Record<string, unknown>[] を要求するため表示用に変換（セルは個別にキャストして参照）
const tableRows = computed(() => pagedItems.value as unknown as Record<string, unknown>[])

/** 改修案件のステータス別件数（KPI 表示用。旧語彙は 3 状態へ正規化して集計 = 原則7） */
const itemCounts = computed(() => {
  const c = Object.fromEntries(IMPROVEMENT_ITEM_VIEWS.map(s => [s, 0])) as Record<ImprovementItemView, number>
  for (const it of imp.activeItems.value) c[improvementItemViewOf(it.status)] += 1
  return c
})

const columns: TableColumn[] = [
  { key: 'title', label: '改修案件', primary: true },
  { key: 'status', label: 'ステータス', width: '110px' },
  // 担当者（対応中でアサイン = 関連画面に表示する要件。改修依頼 2026-08-21）
  { key: 'assignee', label: '担当者', width: '110px', primary: true, sortable: false },
  { key: 'pages', label: '対象ページ', width: '200px' },
  { key: 'count', label: '要望', width: '70px', align: 'right' },
  { key: 'updatedAt', label: '更新', width: '110px' },
]

/** 改修案件のステータスラベル・トーン（保存値を 3 状態へ正規化 = 旧語彙にも効く = 原則7） */
function itemViewOf(it: ImprovementItem): ImprovementItemView { return improvementItemViewOf(it.status) }
function statusLabel(s: ImprovementItemView): string { return IMPROVEMENT_ITEM_STATUS_META[s].label }
function statusTone(s: ImprovementItemView): Tone { return IMPROVEMENT_ITEM_STATUS_META[s].tone }

/** 受付箱ステータスのラベル・トーン（SoT = IMPROVEMENT_INBOX_STATUS_META） */
function inboxLabel(s: ImprovementInboxStatus): string { return IMPROVEMENT_INBOX_STATUS_META[s].label }
function inboxTone(s: ImprovementInboxStatus): Tone { return IMPROVEMENT_INBOX_STATUS_META[s].tone }

/** 受付箱ステータスバッジのラベル（継続検討は再検討日を併記。例: 継続検討（8/30 再検討）） */
function inboxBadgeLabelOf(r: ImprovementRequest): string {
  const s = imp.inboxStatusOf(r)
  if (s === 'deferred' && r.revisitOn) {
    const [, m, d] = r.revisitOn.split('-')
    return `${inboxLabel('deferred')}（${Number(m)}/${Number(d)} 再検討）`
  }
  return inboxLabel(s)
}

// ---------- 生要望（受付箱 = 一次ライフサイクル。改修依頼 2026-08-21） ----------

// 投稿者フィルタ（自分のみ/全員 = 改修依頼 2026-08-20。既定 = 自分のみ。受付箱の一覧〔管理者テーブル・
// 一般リスト〕とカンバン/ガントでページ内共有の 1 つの ref。純述語 = memberId 一致のみ）
const authorFilter = ref<'mine' | 'all'>('mine')
const AUTHOR_FILTER_OPTIONS = [
  { value: 'mine', label: '自分の投稿のみ' },
  { value: 'all', label: '全員' },
]
function matchesAuthor(r: ImprovementRequest): boolean {
  return authorFilter.value === 'all' || r.memberId === currentUserId.value
}

/** 生要望一覧の絞り込み（既定 = 未確認 = 起票直後の確認待ち。選択肢は受付箱ステータス + 取消済み） */
const rawFilter = ref<string>('unconfirmed')
const RAW_FILTER_OPTIONS = [
  ...IMPROVEMENT_INBOX_FILTER_OPTIONS,
  { value: 'archived' as const, label: '取消済み' },
]

const rawRequests = computed<ImprovementRequest[]>(() => {
  // 新しい順に明示ソート（API の GET は降順・mock の tbl は挿入順 = 昇順のため、
  // ここで揃えないと両モードで並びが逆転する = 原則6。レビュー指摘 2026-08-17）。
  // 投稿者フィルタ（自分のみ/全員 = 2026-08-20）を先に適用する（一括変更バーの対象も表示中の絞り込みに一致）
  const all = [...imp.allRequests.value]
    .filter(matchesAuthor)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const f = rawFilter.value
  if (f === 'archived') return all.filter(r => r.archivedAt)
  const active = all.filter(r => !r.archivedAt)
  if (f === 'all') return active
  // 受付箱ステータスで絞り込み（表示ステータス = inboxStatusOf の導出値。集約済みは item 連動）
  return active.filter(r => matchesInboxFilter(imp.inboxStatusOf(r), f as ImprovementInboxStatus))
})
// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。絞り込みは rawRequests が担う。
// 一括変更の選択（selectedReqIds）は行 id ベースのため、ページを跨いでも選択状態は維持される）
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

// select = 一括変更の複数選択 / ops = 行内のステータス変更（改修依頼 2026-08-21）。
// primary 指定列はモバイルのカード表示にも出す（一覧上のステータス操作をモバイルでも可能にする = 原則8）
const RAW_COLUMNS: TableColumn[] = [
  // 列順は「対象ページ → 対象箇所 → 要望 → 投稿者 → それ以外」（改修依頼 2026-08-19 → 対象箇所の追加 2026-08-21）。
  // 先頭の select は一括変更のチェックボックス（データ列ではなく行選択の操作列）のため列順の対象外で先頭固定。
  // select / ops は行データにキーの無い仮想列 = ソート不可（飾りのソートボタンを出さない = X-1）
  { key: 'select', label: '選択', width: '44px', primary: true, sortable: false },
  // page も行データにキーの無い仮想列（スロット描画 = pageLabel/リンク）= ソート不可
  { key: 'page', label: '対象ページ', width: '160px', sortable: false },
  // 対象箇所（改修依頼 2026-08-21: 受付箱の一覧に表示・詳細で編集）。行データのキーそのままのためソート可
  { key: 'targetSpot', label: '対象箇所', width: '130px', primary: true },
  { key: 'body', label: '要望', primary: true },
  { key: 'memberName', label: '投稿者', width: '110px' },
  // attachments は行データにキーの無い仮想列（添付の直接確認 = 改修依頼 2026-08-18。リンク = 別タブ・画像 = 押下で拡大）
  { key: 'attachments', label: '添付', width: '150px', primary: true, sortable: false },
  // status は受付箱の表示ステータス（inboxStatusOf の導出値 = カンバン/ガントと同じ軸）。導出値のためソート不可
  { key: 'status', label: 'ステータス', width: '130px', primary: true, sortable: false },
  // AI 判定（既存機能/運用工夫/改修要 = 改修依頼 2026-08-21。詳細・実行はドロワー）。導出表示のためソート不可
  { key: 'assess', label: 'AI判定', width: '130px', primary: true, sortable: false },
  // ops = 行内のステータス変更（許可された遷移の select。運用対応・継続検討は入力が必要なためドロワーへ誘導）
  { key: 'ops', label: 'ステータス変更', width: '150px', primary: true, sortable: false },
  // comments も行データにキーの無い仮想列（スロット描画 = コメント集計）= ソート不可
  { key: 'comments', label: 'コメント', width: '70px', align: 'right', sortable: false },
  // タイムスタンプは秒まで表示（yyyy/MM/dd HH:mm:ss = 改修依頼 2026-08-18）
  { key: 'createdAt', label: '投稿日時', width: '160px', primary: true },
]

// 生要望の詳細ドロワー（ステータス・コメント・添付・AI 判定の参照）
const selectedRequestId = ref<string | null>(null)
const selectedRequest = computed<ImprovementRequest | null>(() =>
  imp.allRequests.value.find(r => r.id === selectedRequestId.value) ?? null)
/** 集約先の改修案件（集約済み表示・解除可否の判定用）。対応済（決着）は解除不可 = AKO-REQ-021 */
const selectedRequestItem = computed<ImprovementItem | null>(() => {
  const iid = selectedRequest.value?.itemId
  if (!iid) return null
  return imp.activeItems.value.find(it => it.id === iid)
    ?? imp.archivedItems.value.find(it => it.id === iid)
    ?? null
})
/** 集約先が解除不可（取消済み = AKO-REQ-022 / 対応済 = AKO-REQ-021）か。ボタン表示と案内文の判定 */
const selectedRequestItemDecided = computed(() => {
  const it = selectedRequestItem.value
  if (!it) return false
  return !!it.archivedAt || !isOpenItemStatus(it.status)
})
const requestComments = computed(() => (selectedRequest.value ? imp.commentsForRequest(selectedRequest.value.id) : []))
const commentInput = ref('')
const commentBusy = ref(false)

/** 選択中の要望が自分の投稿か（一般利用者は自分の要望のみ編集・コメント・取消できる = 改修依頼 2026-08-19 第4弾） */
const isOwnSelectedRequest = computed(() => !!selectedRequest.value && selectedRequest.value.memberId === currentUserId.value)
/** 自分の要望の運用案内（kind='ops' コメント = 通知と同一本文の記録。判別の SoT = operationalGuidanceFor）。
 *  通知を OFF にしていてもドロワーで案内を読める = 解決確認フローが通知設定に依存しない（R2 監査 2026-08-21） */
const ownGuidance = computed(() => (selectedRequest.value && isOwnSelectedRequest.value
  ? imp.operationalGuidanceFor(selectedRequest.value.id)
  : []))
/** 選択中の要望に書込（編集・コメント・取消）できるか（本人または管理権限者。ステータス変更は管理者のみ = 別ゲート） */
const canWriteSelectedRequest = computed(() => isOwnSelectedRequest.value || canManageImprovements.value)

function openRequestDrawer(row: Record<string, unknown>): void {
  selectedRequestId.value = String(row.id)
  commentInput.value = ''
  requestEditing.value = false
  const r = imp.allRequests.value.find(x => x.id === selectedRequestId.value)
  if (r) {
    void imp.loadRequestImagesFor(r) // 添付画像の遅延ロード（非ブロッキング）
    // 運用案内の遅延ロード（API モードの非管理者のみ実フェッチ = 自分の要望の運用案内を表示する材料。
    // 通知 OFF でもアプリ内で案内を読める = R2 監査 2026-08-21。失敗しても表示は続行 = 原則4）
    if (r.memberId === currentUserId.value) void imp.loadOperationalGuidance(r.id)
  }
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

/** 有効な生要望（新しい順・投稿者フィルタ適用後）。全利用者が閲覧できる
 *  （生要望カンバン/ガント・一般の受付箱の共通ソース） */
const activeRequests = computed<ImprovementRequest[]>(() =>
  [...imp.allRequests.value]
    .filter(r => !r.archivedAt && matchesAuthor(r))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)))

// ---------- 要望 → 表示ステータス ----------
// 受付箱の表示ステータス（一覧・カンバン・ガント・ドロワー共通の軸）は useImprovements.inboxStatusOf が
// 解決する（集約済みは item 連動・API モードの一般利用者は GET /requests の linkedItemStatus を材料にする =
// 改修依頼 2026-08-21。ページ側の独自写像を持たない = 判定点の一元化・原則6）
// 一般利用者の受付箱一覧のページング（1 ページ 20 件。管理者は既存の管理テーブルを使う）。
// 添付は一覧にサムネイル表示せず、詳細ドロワーを開いたとき（openRequestDrawer）に遅延ロードする
const { page: genPage, pageSize: genPageSize, rows: pagedGeneralRequests, total: genTotal } =
  useListView<ImprovementRequest>({ source: activeRequests })

// 自分の取消済み要望（一般利用者も自分の取消は復元できる = 原則9.5。API は自分の取消済みを返す・mock は tbl 全件）
const showMyArchivedRequests = ref(false)
const myArchivedRequests = computed<ImprovementRequest[]>(() =>
  [...imp.allRequests.value]
    .filter(r => r.archivedAt && r.memberId === currentUserId.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)))
const restoringRequest = ref(false)
async function restoreRequestFromList(r: ImprovementRequest): Promise<void> {
  if (restoringRequest.value) return
  restoringRequest.value = true
  try {
    const res = await imp.setRequestArchived(r.id, false)
    if (res.ok) toast.show('要望の取消を戻しました', 'ok')
    else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  } finally {
    restoringRequest.value = false
  }
}

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

async function saveEditRequest(payload: { body: string; tags: string[]; links: string[]; images: ImprovementRequestImage[]; targetSpot: string }): Promise<void> {
  if (!selectedRequest.value || requestEditBusy.value) return
  requestEditBusy.value = true
  try {
    // 画像が編集不可（遅延ロード失敗）で開いた編集は images をパッチから外し、現行の添付を保持する
    // （部分更新の鉄則。開いた時点の判断を使う = 途中の loaded 遷移で空配列を全削除として送らない）
    const patch = requestImagesEditable.value
      ? payload
      : { body: payload.body, tags: payload.tags, links: payload.links, targetSpot: payload.targetSpot }
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

/** 1 件ステータス変更の実行中フラグ（連打の二重送信を防ぐ = レビュー R21。行内・ドロワー共用） */
const statusBusy = ref(false)

/**
 * 受付箱ステータスの変更（行内 select・ドロワーのボタン共通の適用点）。
 * 運用対応（運用案内必須）・継続検討（再検討日必須）は入力が必要なためドロワーの入力モードへ誘導し、
 * それ以外（検討中・改善対応・対応見送り・未確認へ戻す）は即時適用する（X-1: 操作に必ず反応を返す）。
 */
async function changeInboxStatus(r: ImprovementRequest, to: ImprovementInboxBase): Promise<void> {
  if (to === 'operational' || to === 'deferred') {
    openRequestDetail(r)
    // ドロワー切替の watch（入力モードリセット）より後に入力を開く
    void nextTick(() => openReqStatusInput(to))
    return
  }
  if (statusBusy.value) return
  statusBusy.value = true
  try {
    const res = await imp.setRequestStatus(r.id, to)
    if (res.ok) {
      const label = inboxLabel(to)
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える変更を黙認しない。レビュー R16）
        toast.show(`「${label}」にしましたが、保存容量が上限に達したため再読込時に失われる可能性があります`, 'warn')
      } else {
        toast.show(to === 'planned' ? `「${label}」にしました（「AI で集約」の対象になります）` : `「${label}」にしました`, 'ok')
      }
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    statusBusy.value = false
  }
}

/** 行内 select のステータス変更（選択値を適用してから select を空へ戻す = 導出表示と select の二重表示を避ける） */
async function onRowStatusChange(r: ImprovementRequest, ev: Event): Promise<void> {
  const el = ev.target as HTMLSelectElement
  const to = el.value as ImprovementInboxBase
  el.value = ''
  if (!to) return
  await changeInboxStatus(r, to)
}

// ---------- 受付箱の一覧内ステータス操作（行内 select + 複数選択の一括変更 = 改修依頼 2026-08-21） ----------

/** ステータスを直接変更できる行か（集約済み = item 連動・取消済み・解決済みは対象外 = サーバーガードと一致） */
function isTriageable(r: ImprovementRequest): boolean {
  return !r.itemId && !r.archivedAt && imp.inboxStatusOf(r) !== 'resolved'
}
/** 行内 select・一括変更の遷移先候補（現在の表示ステータスの状態機械から列挙 = ボタン活性と検証の一致・原則6） */
function nextInboxOf(r: ImprovementRequest): ImprovementInboxBase[] {
  const s = imp.inboxStatusOf(r)
  const base = (IMPROVEMENT_INBOX_NEXT as Record<string, ImprovementInboxBase[]>)[s] ?? []
  // 継続検討中は再検討日の変更（deferred → deferred）も選べる（原則9.5 の選び直し導線）
  return s === 'deferred' ? [...base, 'deferred'] : base
}
/** ステータスを変更できる行（集約済み・取消済み・解決済みは対象外 = setRequestStatus のガードと一致） */
const selectableRequests = computed(() => rawRequests.value.filter(isTriageable))
const selectedReqIds = ref<string[]>([])
const bulkBusy = ref(false)

// データ更新（集約・取消等）で変更対象外になった id は選択から外す（無効 id への一括操作を防ぐ）
watch(selectableRequests, (rows) => {
  const ok = new Set(rows.map(r => r.id))
  if (selectedReqIds.value.some(id => !ok.has(id))) {
    selectedReqIds.value = selectedReqIds.value.filter(id => ok.has(id))
  }
})
// 絞り込み（ステータス・投稿者）を変えたら選択をリセット（見えていない行への一括操作を防ぐ）
watch([rawFilter, authorFilter], () => { selectedReqIds.value = [] })

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

/** 一括変更の対象ステータス（検討中/改善対応/対応見送り/未確認に戻す。運用対応・継続検討は行ごとの
 *  入力が必要なため一括対象外 = setRequestStatusBulk のガードと一致） */
const BULK_STATUS_OPTIONS: { value: ImprovementInboxBase; label: string }[] = [
  { value: 'reviewing', label: `まとめて${IMPROVEMENT_INBOX_STATUS_META.reviewing.label}` },
  { value: 'planned', label: `まとめて${IMPROVEMENT_INBOX_STATUS_META.planned.label}` },
  { value: 'dismissed', label: `まとめて${IMPROVEMENT_INBOX_STATUS_META.dismissed.label}` },
  { value: 'unconfirmed', label: `まとめて${IMPROVEMENT_INBOX_STATUS_META.unconfirmed.label}に戻す` },
]

/** 選択した要望をまとめてステータス変更（部分成功は件数で案内 = 原則4。成功後は選択解除） */
async function bulkStatus(to: ImprovementInboxBase): Promise<void> {
  if (bulkBusy.value || selectedReqIds.value.length === 0) return
  bulkBusy.value = true
  try {
    const res = await imp.setRequestStatusBulk(selectedReqIds.value, to)
    if (!res.ok) {
      toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
      return
    }
    // 成功分は選択解除・再操作できる失敗分だけ選択に残す（レビュー R15）。
    // 代入時点の変更可能行で濾す: refresh 後の watch は代入より先に走り終えるため、変更不能になった行
    //（他者の集約・取消等）をここで除かないと見えない選択が残留する（レビュー R16）。
    // トーストは実際に残った件数で案内する（残していないのに「残した」と言わない = レビュー R17）
    const stillSelectable = new Set(selectableRequests.value.map(r => r.id))
    const retained = (res.failedIds ?? []).filter(id => stillSelectable.has(id))
    const retainedNote = retained.length > 0 ? `。再操作できる ${retained.length} 件は選択に残しました` : ''
    const label = inboxLabel(to)
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
      toast.show(to === 'planned'
        ? `${res.done} 件を「${label}」にしました（「AI で集約」の対象になります）`
        : to === 'unconfirmed'
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
  const ok = await confirm.ask('要望の取消', 'この要望を取り消します（ステータス設定・集約の対象から外れます）。取消済みからいつでも戻せます。', { danger: true })
  if (!ok) return
  const res = await imp.setRequestArchived(selectedRequest.value.id, true)
  // ドロワーは閉じずに開いたままにする = フッターが「取消を戻す」へ切り替わり、その場で復元できる（原則9.5。R1 レビュー反映）。
  // 取消済みは一般利用者にも「自分の取消済み」として一覧・復元できる（下記トグル）
  if (res.ok) toast.show('要望を取り消しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
async function restoreSelectedRequest(): Promise<void> {
  if (!selectedRequest.value) return
  const res = await imp.setRequestArchived(selectedRequest.value.id, false)
  if (res.ok) toast.show('要望の取消を戻しました', 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/**
 * 集約の解除（F-42-19・追加指示 2026-08-18 → ステータス再編 2026-08-21）。集約済みの要望を改修単位から外し、
 * 「改善対応（集約待ち）」へ戻す = 次回の「改善対応を AI で集約」で再度整理の対象になる。
 * 受付箱ドロワー（集約済み表示）と改修単位ドロワーの元要望カードの両方から呼ぶ。
 */
const unclusterBusy = ref(false)
async function unclusterRequestWithConfirm(id: string): Promise<void> {
  if (unclusterBusy.value) return // 二重発火ガード（成功直後の再送が AKO-REQ-017 の誤エラー表示になるのを防ぐ）
  unclusterBusy.value = true
  try {
    const ok = await confirm.ask(
      '集約の解除',
      'この要望を改修単位から外し、「改善対応（集約待ち）」に戻します。次回の「改善対応を AI で集約」で再度整理の対象になります。'
      + 'なお、解除した要望が AI 集約で元の改修単位へ戻ることはありません（別の単位として整理されます）。',
    )
    if (!ok) return
    const res = await imp.unclusterRequest(id)
    if (res.ok) {
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える変更を黙認しない。レビュー R7）
        toast.show('集約を解除しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        toast.show('集約を解除しました（改善対応・集約待ちに戻りました）', 'ok')
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

// ---------- AI 集約（「改善対応」の未集約要望のみ対象 = 改修依頼 2026-08-21） ----------
const generating = ref(false)
async function runGenerate(): Promise<void> {
  if (generating.value) return
  // refresh を跨いだ再クリックの二重発火を防ぐため、フラグは最初に立てる（try/finally で必ず解除）
  generating.value = true
  try {
    // 改善対応の集約待ちが無いときは、先にステータス設定を促す（未確認が残っている場合はその旨も案内）。
    // 判定前に最新化（他端末・別タブで変更された直後でも古いキャッシュでブロックしない = レビュー指摘 2026-08-17。mock は no-op）
    if (imp.plannedUnclustered.value.length === 0) {
      await imp.refresh()
      if (imp.plannedUnclustered.value.length === 0) {
        toast.show(imp.unconfirmedRequests.value.length > 0
          ? '「改善対応」の要望がありません。受付箱で確認し「改善対応」にしてから集約してください'
          : '集約する要望がありません（「改善対応」の集約待ちが 0 件です）', 'info')
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

// ---------- 改修案件のステータス変更（3 状態。対応中はアサイン入力を伴う = 改修依頼 2026-08-21） ----------
async function changeStatus(to: ImprovementItemView, assigneeMemberId?: string): Promise<void> {
  if (!selected.value) return
  const res = await imp.setStatus(selected.value.id, to, assigneeMemberId)
  if (res.ok) toast.show(`ステータスを「${statusLabel(to)}」に変更しました`, 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

/** 「対応中」への変更は担当者アサイン入力（任意）を挟む。他のステータスは即時変更（インライン入力は閉じる） */
function onStatusClick(to: ImprovementItemView): void {
  if (to === 'in_progress') {
    assignMode.value = true
    assignMemberId.value = selected.value?.assigneeMemberId ?? ''
  } else {
    assignMode.value = false
    void changeStatus(to)
  }
}

// 対応中への遷移時の担当者アサイン（任意。現担当を初期値にし、空のまま確定 = 担当者未設定で着手）。
// 候補 = 有効メンバー（tbl('members') は API モードでもマスタキャッシュを返す = 両モード共通）
const assignMode = ref(false)
const assignMemberId = ref('')
const assignBusy = ref(false)
const { tbl } = useMockDb()
const activeMemberOptions = computed(() =>
  tbl('members').value.filter(m => m.active).map(m => ({ value: m.id, label: m.name })))

async function confirmInProgress(): Promise<void> {
  if (!selected.value || assignBusy.value) return
  assignBusy.value = true
  try {
    const res = await imp.setStatus(selected.value.id, 'in_progress', assignMemberId.value)
    if (res.ok) {
      toast.show(assignMemberId.value
        ? `「${statusLabel('in_progress')}」にしました（担当者をアサイン）`
        : `「${statusLabel('in_progress')}」にしました`, 'ok')
      assignMode.value = false
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    assignBusy.value = false
  }
}

// 担当者の変更・解除（ステータス遷移とは独立にいつでも変更できる = 原則9.5）
const assigneeEditMode = ref(false)
const assigneeEditId = ref('')
const assigneeBusy = ref(false)

function startAssigneeEdit(): void {
  assigneeEditId.value = selected.value?.assigneeMemberId ?? ''
  assigneeEditMode.value = true
}
async function saveAssignee(): Promise<void> {
  if (!selected.value || assigneeBusy.value) return
  assigneeBusy.value = true
  try {
    const res = await imp.editItem(selected.value.id, { assigneeMemberId: assigneeEditId.value })
    if (res.ok) {
      toast.show(assigneeEditId.value ? '担当者を変更しました' : '担当者を解除しました', 'ok')
      assigneeEditMode.value = false
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    assigneeBusy.value = false
  }
}

// ---------- 起票者の解決フラグ（運用対応の案内・対応済みの内容を確認したら「解決済み」へ = 原則9.5 で取消可） ----------
const ownResolveBusy = ref(false)
async function resolveSelectedRequest(resolved: boolean): Promise<void> {
  if (!selectedRequest.value || ownResolveBusy.value) return
  ownResolveBusy.value = true
  try {
    const res = await imp.resolveRequest(selectedRequest.value.id, resolved)
    if (res.ok) toast.show(resolved ? '要望を「解決済み」にしました' : '「解決済み」を取り消しました', 'ok')
    else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
  } finally {
    ownResolveBusy.value = false
  }
}

// ---------- AI 判定（既存機能/運用工夫/改修要。ナレッジベースを RAG に判定 = 改修依頼 2026-08-21） ----------
const assessBusy = ref(false)
const bulkAssessBusy = ref(false)

/** 1 件の AI 判定（ドロワーの「AI で判定/再判定」）。生成→保管→再判定で上書き */
async function runAssess(id: string): Promise<void> {
  if (assessBusy.value) return
  assessBusy.value = true
  try {
    const res = await imp.assessRequest(id)
    if (res.ok) {
      if (res.persisted === false) {
        toast.show('AI 判定を保存しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        toast.show('AI 判定を実行しました', 'ok')
      }
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    assessBusy.value = false
  }
}

/** 選択した要望をまとめて AI 判定（逐次実行・部分成功は件数で報告 = 原則4。選択は解除しない = 続けて一括変更できる） */
async function bulkAssess(): Promise<void> {
  if (bulkAssessBusy.value || selectedReqIds.value.length === 0) return
  bulkAssessBusy.value = true
  try {
    let done = 0
    let failed = 0
    let lastError: { code: string; message: string } | undefined
    for (const id of [...selectedReqIds.value]) {
      const res = await imp.assessRequest(id)
      if (res.ok) done += 1
      else {
        failed += 1
        lastError = res.error
        // 認可断・認証断・ネットワーク断は以降の全滅が確定 = 逐次実行を打ち切る（一括変更と同じ判定）
        if (res.error.code === 'AKO-PRM-001' || res.error.code.startsWith('AKO-AUTH-') || res.error.code === 'AKO-GEN-NET') break
      }
    }
    if (failed > 0) {
      toast.show(`${done} 件を AI 判定しました（${failed} 件は判定できませんでした${lastError ? `。${lastError.message}` : ''}）`, done > 0 ? 'warn' : 'crit')
    } else {
      toast.show(`${done} 件を AI 判定しました`, 'ok')
    }
  } finally {
    bulkAssessBusy.value = false
  }
}

/** AI 判定の参照ドキュメント名（根拠の提示。未知 id は落とす） */
function assessDocTitles(docIds: string[] | undefined): string[] {
  return (docIds ?? []).map(id => kbDocById(id)?.title ?? '').filter(Boolean)
}

/** 推奨アクションが現在の状態から適用可能か（遷移機械と一致 = ボタン活性と検証の一致。
 *  すでに推奨状態のときは非表示 = 押しても何も起きないボタンを出さない〔R1 レビュー 2026-08-21〕） */
function canApplyRecommended(r: ImprovementRequest): boolean {
  const v = r.aiAssessment?.verdict
  if (!v) return false
  const to = IMPROVEMENT_ASSESS_META[v].recommended
  return isTriageable(r) && imp.inboxStatusOf(r) !== to && nextInboxOf(r).includes(to)
}

/** 推奨アクションの適用（運用対応 = 案内入力を開き判定理由を下書きに / 他 = 即時遷移） */
function applyRecommended(r: ImprovementRequest): void {
  const v = r.aiAssessment?.verdict
  if (!v) return
  const to = IMPROVEMENT_ASSESS_META[v].recommended
  if (imp.inboxStatusOf(r) === to) return
  if (to === 'operational') {
    openReqStatusInput('operational')
    // 運用案内の下書きに AI 判定の根拠（マニュアルの該当箇所）を流し込む（起票者向けに編集して確定する前提）
    reqOpsNote.value = r.aiAssessment?.reason ?? ''
    return
  }
  void changeInboxStatus(r, to)
}

// ---------- 受付箱ステータスの入力つき遷移（運用対応 = 運用案内必須 / 継続検討 = 再検討日必須 /
//            対応見送り = 理由コメント任意。要望詳細ドロワーのインライン入力） ----------
const reqStatusMode = ref<'operational' | 'deferred' | 'dismissed' | null>(null)
const reqOpsNote = ref('')
const reqOpsError = ref('')
const reqDeferDate = ref('')
const reqDeferError = ref('')
const reqDismissReason = ref('')
const reqStatusBusy = ref(false)

/** ドロワーのステータスボタン押下。入力が必要な遷移はインライン入力を開き、他は即時適用 */
function openReqStatusInput(to: ImprovementInboxBase): void {
  if (to === 'operational') {
    reqStatusMode.value = 'operational'
    reqOpsNote.value = ''
    reqOpsError.value = ''
  } else if (to === 'deferred') {
    reqStatusMode.value = 'deferred'
    reqDeferDate.value = selectedRequest.value?.revisitOn ?? ''
    reqDeferError.value = ''
  } else if (to === 'dismissed') {
    reqStatusMode.value = 'dismissed'
    reqDismissReason.value = ''
  } else {
    reqStatusMode.value = null
    if (selectedRequest.value) void changeInboxStatus(selectedRequest.value, to)
  }
}

/** 運用対応にする（運用案内必須。コメント記録 + ステータス変更 + 起票者への通知は setRequestStatus が
 *  単一処理で行う = 非原子な 2 コールを作らない） */
async function confirmReqOperational(): Promise<void> {
  if (!selectedRequest.value || reqStatusBusy.value) return
  const note = reqOpsNote.value.trim()
  if (!note) {
    reqOpsError.value = '運用対応にする場合は、運用対応方法の案内を記載してください'
    return
  }
  reqStatusBusy.value = true
  try {
    const res = await imp.setRequestStatus(selectedRequest.value.id, 'operational', undefined, note)
    if (res.ok) {
      toast.show(`「${inboxLabel('operational')}」にしました（運用案内をコメントに記録し、起票者へ通知）`, 'ok')
      reqStatusMode.value = null
      reqOpsNote.value = ''
      reqOpsError.value = ''
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    reqStatusBusy.value = false
  }
}

/** 継続検討にする / 継続検討中の再検討日を変更する（再検討日は必須 = インラインエラーで案内） */
async function confirmReqDefer(): Promise<void> {
  if (!selectedRequest.value || reqStatusBusy.value) return
  const msg = improvementRevisitError('deferred', reqDeferDate.value)
  if (msg) { reqDeferError.value = msg; return }
  reqStatusBusy.value = true
  try {
    const res = await imp.setRequestStatus(selectedRequest.value.id, 'deferred', reqDeferDate.value)
    if (res.ok) {
      toast.show(`「${inboxLabel('deferred')}」にしました（再検討日 ${fmtDate(reqDeferDate.value)}）`, 'ok')
      reqStatusMode.value = null
      reqDeferError.value = ''
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    reqStatusBusy.value = false
  }
}

/** 対応見送りにする（理由は任意 = あればコメントに先に記録してから遷移。二重送信ガード付き） */
async function confirmReqDismiss(): Promise<void> {
  if (!selectedRequest.value || reqStatusBusy.value) return
  reqStatusBusy.value = true
  try {
    const reason = reqDismissReason.value.trim()
    if (reason) {
      const cr = await imp.addRequestComment(selectedRequest.value.id, `見送り理由: ${reason}`)
      if (!cr.ok) { toast.show(`${cr.error.code}: ${cr.error.message}`, 'crit'); return }
    }
    const res = await imp.setRequestStatus(selectedRequest.value.id, 'dismissed')
    if (res.ok) {
      toast.show(reason ? `「${inboxLabel('dismissed')}」にしました（理由をコメントに記録）` : `「${inboxLabel('dismissed')}」にしました`, 'ok')
      reqStatusMode.value = null
      reqDismissReason.value = ''
    } else {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    reqStatusBusy.value = false
  }
}

// ---------- 時系列メモ ----------
const itemNotes = computed(() => (selected.value ? imp.notesForItem(selected.value.id) : []))
const noteInput = ref('')
const noteBusy = ref(false)

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

/** 一覧の「要望」件数 = 有効な元要望数（ドロワー・プロンプトと一致。取消済み要望は除く） */
function reqCount(itemId: string): number {
  return imp.requestsForItem(itemId).length
}

// ---------- タブ（受付箱 / 改修案件）+ 表示切替（一覧 / カンバン / ガント = 改修依頼 2026-08-20） ----------
// タブは 受付箱（inbox = 生要望・全員）/ 改修案件（items = AI 集約後・管理者のみ）の 2 つに再編し、
// 旧タブのカンバン/ガントは各タブ内の表示切替（view。?view= と同期）へ移行した。
// 下位互換（原則7）: 旧 ?tab= 値（req-kanban / req-gantt / kanban / gantt）は新体系へ読み替える
// （reports.vue の ?tab=weekly 変換と同じ初期化時の読み替え）。
const TAB_KEYS = ['inbox', 'items'] as const
const VIEW_KEYS = ['list', 'kanban', 'gantt'] as const
const tab = ref<string>('inbox')
const view = ref<string>('list')

// 旧 ?tab= 値 → 新タブ + 表示の読み替え（useRouteTabSync は valid 外の値を無視するため先に取り込む。
// ?tab= 自体の URL 除去は useRouteTabSync が担う）
const LEGACY_TAB_MAP: Record<string, { tab: string; view: string }> = {
  'req-kanban': { tab: 'inbox', view: 'kanban' },
  'req-gantt': { tab: 'inbox', view: 'gantt' },
  'kanban': { tab: 'items', view: 'kanban' },
  'gantt': { tab: 'items', view: 'gantt' },
}
const route = useRoute()
{
  const legacy = LEGACY_TAB_MAP[typeof route.query.tab === 'string' ? route.query.tab : '']
  if (legacy) {
    tab.value = legacy.tab
    view.value = legacy.view
  }
  // ?view= の初期取り込み（明示指定は旧 ?tab= の読み替えより優先。URL 除去は useRouteDeepLink が担う）
  const rawView = typeof route.query.view === 'string' ? route.query.view : ''
  if ((VIEW_KEYS as readonly string[]).includes(rawView)) view.value = rawView
}
useRouteTabSync(tab, { valid: TAB_KEYS })
// 滞在中の ?view= 変化の追従 + URL からの除去（?open= と同じ一方向規約 = useRouteDeepLink を共用。原則3）
useRouteDeepLink('view', (v) => {
  if ((VIEW_KEYS as readonly string[]).includes(v)) view.value = v
})

// タブ利用可否（権限表の `tab:<key>` 擬似フィールド = 改修依頼 2026-08-18。既定 = 全タブ利用可）
const tabs = computed<TabItem[]>(() => {
  const manage = canManageImprovements.value
  const base: TabItem[] = [
    { key: 'inbox', label: '受付箱', badge: manage ? imp.unconfirmedRequests.value.length : undefined },
  ]
  const adminOnly: TabItem[] = manage ? [{ key: 'items', label: '改修案件' }] : []
  return [...base, ...adminOnly].filter(t => canTab('improvements', t.key))
})
watchEffect(() => {
  // 権限で消えたタブは先頭の利用可能タブへ退避。全タブ deny の場合は空値にして
  // どのタブ内容も描画しない（フェイルクローズ = R1 レビュー反映）
  if (!tabs.value.some(t => t.key === tab.value)) tab.value = tabs.value[0]?.key ?? ''
})

// 表示切替の選択肢。カンバン/ガントの利用可否は**旧タブキー**（tab:req-kanban / tab:req-gantt /
// tab:kanban / tab:gantt）の権限ルールでゲートする = 既存の deny ルールがタブ再編後もそのまま効く（原則7）
const viewOptions = computed(() => {
  const legacyKanban = tab.value === 'items' ? 'kanban' : 'req-kanban'
  const legacyGantt = tab.value === 'items' ? 'gantt' : 'req-gantt'
  return [
    { value: 'list', label: '一覧' },
    ...(canTab('improvements', legacyKanban) ? [{ value: 'kanban', label: 'カンバン' }] : []),
    ...(canTab('improvements', legacyGantt) ? [{ value: 'gantt', label: 'ガント' }] : []),
  ]
})
watchEffect(() => {
  // 権限で消えた表示・無効値は一覧へ退避（一覧はタブ本体の権限でゲート済み）
  if (!viewOptions.value.some(o => o.value === view.value)) view.value = 'list'
})

// ページングの 1 ページ目リセット（tab/view がここで定義されるため watch もここに置く。
// タブ・表示・絞り込み・投稿者フィルタ・検索の変更で対象一覧を先頭ページから表示する）
watch([tab, view, rawFilter, authorFilter], () => {
  rawPage.value = 1
  genPage.value = 1
})
watch([tab, view, uiFilter, search], () => { itemPage.value = 1 })

/** サマリーカードからのタブ直行（受付箱カード = 受付箱タブ / ステータスカード = 改修案件タブ + 絞り込み） */
function goInbox(filter: string = 'unconfirmed'): void {
  tab.value = 'inbox'
  view.value = 'list'
  // カードの件数どおりの一覧へ直行（残っていた絞り込みと食い違わせない = goItems と同じ規則)。
  // 件数は全員分のため投稿者フィルタも「全員」にする
  rawFilter.value = filter
  authorFilter.value = 'all'
}
function goItems(filter: ImprovementFilter): void {
  tab.value = 'items'
  view.value = 'list'
  uiFilter.value = filter
  // 残っていた検索語で件数と一覧が食い違わないようにする（カードの件数どおりの一覧へ直行 = レビュー指摘）
  search.value = ''
}

/** 受付箱ステータスカードの補足文・アイコン（ラベルは IMPROVEMENT_INBOX_STATUS_META が SoT） */
const INBOX_CARD_META: Record<ImprovementInboxStatus, { sub: string; icon: string; inverse: boolean }> = {
  unconfirmed: { sub: '起票直後（確認待ち）', icon: 'Inbox', inverse: false },
  reviewing: { sub: '対応方針の検討中', icon: 'HelpCircle', inverse: false },
  planned: { sub: 'AI 集約 → 改修案件へ', icon: 'Wrench', inverse: false },
  operational: { sub: '運用案内を起票者へ通知', icon: 'Settings', inverse: false },
  deferred: { sub: '再検討日まで持ち越し', icon: 'CalendarClock', inverse: false },
  dismissed: { sub: '対応しない判断', icon: 'MinusCircle', inverse: false },
  addressed: { sub: '改修完了（起票者確認待ち）', icon: 'PackageCheck', inverse: false },
  resolved: { sub: '起票者確認済み（完了）', icon: 'CheckCircle2', inverse: true },
}

/** 受付箱の表示ステータス別件数（有効な要望のみ。集約済みは item 連動の導出値で集計） */
const inboxCounts = computed(() => {
  const c = Object.fromEntries(IMPROVEMENT_INBOX_STATUSES.map(s => [s, 0])) as Record<ImprovementInboxStatus, number>
  for (const r of imp.allRequests.value) {
    if (r.archivedAt) continue
    c[imp.inboxStatusOf(r)] += 1
  }
  return c
})

/** 受付箱サマリーカード（8 枚。押下で受付箱タブ + 当該ステータスの絞り込みへ直行） */
const inboxSummaryCards = computed(() => IMPROVEMENT_INBOX_STATUSES.map(s => ({
  key: s,
  label: IMPROVEMENT_INBOX_STATUS_META[s].label,
  value: inboxCounts.value[s],
  sub: INBOX_CARD_META[s].sub,
  icon: INBOX_CARD_META[s].icon,
  inverse: INBOX_CARD_META[s].inverse,
  aria: `受付箱タブを${IMPROVEMENT_INBOX_STATUS_META[s].label}で開く`,
  go: () => goInbox(s),
})))

/** 改修案件ステータスカードの補足文（3 枚。ラベルは IMPROVEMENT_ITEM_STATUS_META が SoT） */
const ITEM_CARD_META: Record<ImprovementItemView, { sub: string; icon: string; inverse: boolean }> = {
  todo: { sub: '実施決定・未着手', icon: 'Wrench', inverse: false },
  in_progress: { sub: '着手済み（担当者アサイン）', icon: 'Loader', inverse: false },
  done: { sub: '改修完了', icon: 'CheckCircle2', inverse: true },
}

/** 改修案件サマリーカード（押下で改修案件タブ + 当該ステータスの絞り込みへ直行） */
const itemSummaryCards = computed(() => IMPROVEMENT_ITEM_VIEWS.map(s => ({
  key: s,
  label: IMPROVEMENT_ITEM_STATUS_META[s].label,
  value: itemCounts.value[s],
  sub: ITEM_CARD_META[s].sub,
  icon: ITEM_CARD_META[s].icon,
  inverse: ITEM_CARD_META[s].inverse,
  aria: `改修案件タブを${IMPROVEMENT_ITEM_STATUS_META[s].label}で開く`,
  go: () => goItems(s),
})))

/** カンバン/ガントからの詳細ドロワー起動（item を直接受け取る） */
function openDrawerItem(it: ImprovementItem): void {
  selectedId.value = it.id
  editing.value = false
  void imp.loadRequestImages(it.id)
}
/** カンバンのクイック操作（id 指定のステータス変更）。対応中（担当者アサイン入力）はドロワーへ誘導 */
async function onKanbanStatus(id: string, to: ImprovementItemView): Promise<void> {
  if (to === 'in_progress') {
    const it = imp.activeItems.value.find(x => x.id === id)
    if (!it) return
    openDrawerItem(it)
    // ドロワー切替の watch（アサイン入力リセット）より後に入力を開く
    void nextTick(() => onStatusClick(to))
    return
  }
  const res = await imp.setStatus(id, to)
  if (res.ok) toast.show(`ステータスを「${statusLabel(to)}」に変更しました`, 'ok')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

// 通知リンク等の ?open=<itemId> ディープリンク（再検討日リマインドの遷移先 = 改修依頼 2026-08-20。
// API モードのロード完了を待って開く = pending を監視し、見つかった時点で consume）
const openDeepLink = useRouteDeepLink('open')
watchEffect(() => {
  const id = openDeepLink.pending.value
  if (!id) return
  const target = imp.activeItems.value.find(it => it.id === id)
    ?? imp.archivedItems.value.find(it => it.id === id)
  if (target) {
    openDeepLink.consume()
    openDrawerItem(target)
  }
})

// 通知リンクの ?req=<requestId> ディープリンク（運用対応の案内・対応済み通知・継続検討リマインドの遷移先 =
// 改修依頼 2026-08-21。?open= と同じ規約 = データ到着を待って要望詳細ドロワーを開く）
const reqDeepLink = useRouteDeepLink('req')
watchEffect(() => {
  const id = reqDeepLink.pending.value
  if (!id) return
  const target = imp.allRequests.value.find(r => r.id === id)
  if (target) {
    reqDeepLink.consume()
    openRequestDetail(target)
  }
})

// ---------- 対応予定期間（ドロワーで登録・ガントに反映） ----------
const planForm = ref({ start: '', end: '' })
watch(() => selected.value?.id, () => {
  planForm.value = { start: selected.value?.planStart ?? '', end: selected.value?.planEnd ?? '' }
  // 対象を切り替えたらメモ入力・アサイン入力・担当者編集・画像プレビューをリセット
  // （前の対象の状態を持ち越さない）
  noteInput.value = ''
  assignMode.value = false
  assignMemberId.value = ''
  assigneeEditMode.value = false
  previewImage.value = null
}, { immediate: true })

// 要望ドロワーの対象切替でステータス入力モードをリセット（前の対象の入力を持ち越さない）
watch(() => selectedRequest.value?.id, () => {
  reqStatusMode.value = null
  reqOpsNote.value = ''
  reqOpsError.value = ''
  reqDeferDate.value = ''
  reqDeferError.value = ''
  reqDismissReason.value = ''
})

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
// 出力対象は「未対応（todo）」= 実施決定・未着手の改修案件のみ（改修依頼 2026-08-21。旧語彙
// triage/accepted/deferred も未対応へ正規化されて対象になる = 原則7）
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
  const res = await imp.buildPrompt('todo')
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
      description="寄せられた要望を受付箱で確認し、対応方針（改善対応・運用対応・継続検討・対応見送り）を設定します。「改善対応」の要望は AI で改修案件に集約し、未対応 → 対応中（担当者アサイン）→ 対応済 で進捗を管理します"
    >
      <!-- AI 集約・改修プロンプト出力は管理権限者のみ（改修依頼 2026-08-19 第4弾: 一般利用者は要望の閲覧・投稿のみ） -->
      <template v-if="canManageImprovements" #actions>
        <!-- AI 集約の対象 = 「改善対応」・集約待ちの要望のみ（改修依頼 2026-08-21） -->
        <button type="button" class="btn btn-ghost" :disabled="generating" @click="runGenerate">
          <Wand2 class="h-4 w-4" aria-hidden="true" />
          {{ generating ? '集約中…' : '改善対応を AI で集約' }}
          <span v-if="imp.plannedUnclustered.value.length > 0" class="num ml-1 rounded-full bg-brand-soft px-1.5 text-[11px] font-bold text-brand">
            {{ imp.plannedUnclustered.value.length }}
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
      <!-- サマリーカード（受付箱ステータス別 8 枚 + 改修案件ステータス別 3 枚 = 改修依頼 2026-08-21）。
           押下で該当タブ + 絞り込みへ直行。管理指標のため管理権限者のみ表示（一般利用者には出さない） -->
      <div v-if="canManageImprovements" class="grid gap-3">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <UiKpiCard
            v-for="c in inboxSummaryCards"
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
        <div class="grid grid-cols-3 gap-3 sm:max-w-xl">
          <UiKpiCard
            v-for="c in itemSummaryCards"
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
      </div>

      <!-- タブメニュー（受付箱 / 改修案件 = 改修依頼 2026-08-20 で 2 タブへ再編） -->
      <UiTabBar v-model="tab" :tabs="tabs" />
      <!-- 全タブ deny 時の空状態（タブ内容は tab='' のためどれも描画されない = フェイルクローズ） -->
      <p v-if="tabs.length === 0" class="card p-6 text-center text-[13px] text-sub">利用できるタブがありません（権限設定で制限されています。管理者にお問い合わせください）</p>

      <!-- 表示切替（一覧 / カンバン / ガント = 旧カンバン・ガントタブの移行先）+ 受付箱の投稿者フィルタ
           （自分のみ/全員。既定 = 自分のみ = 改修依頼 2026-08-20）。チップは折返し = モバイル 375px でも崩れない -->
      <div v-if="tab" class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <UiChipTabs v-model="view" :options="viewOptions" aria-label="表示切替" />
        <UiChipTabs
          v-if="tab === 'inbox'"
          v-model="authorFilter"
          :options="AUTHOR_FILTER_OPTIONS"
          aria-label="投稿者で絞り込み"
          class="sm:ml-auto"
        />
      </div>

      <!-- ① 受付箱（一覧・管理者）: 投稿された生の一覧を確認し、対応方針ステータスを設定する（改修依頼 2026-08-21）。
           「改善対応」にした要望のみが「AI で集約」の対象になる。一覧上のステータス変更・複数選択の
           一括変更で直接遷移できる。行クリックで詳細（本文全文・添付・コメント・AI 判定・ステータス） -->
      <UiSectionCard
        v-if="tab === 'inbox' && view === 'list' && canManageImprovements"
        flush
        title="受付箱"
        description="投稿された要望を確認し、ステータス（未確認 → 検討中 → 改善対応／運用対応／継続検討／対応見送り）を設定します。「改善対応」にした要望だけが「AI で集約」の対象になります。一覧のステータス変更で直接遷移でき、複数選択してまとめて変更もできます。行クリックで詳細・コメント・添付を確認できます"
      >
        <div class="border-b border-line p-2">
          <UiChipTabs v-model="rawFilter" :options="RAW_FILTER_OPTIONS" />
        </div>
        <!-- 一括変更バー（複数選択 → まとめてステータス変更 = 改修依頼 2026-08-21） -->
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
              aria-label="絞り込み結果のステータス変更できる要望をすべて選択（全ページ対象）"
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
          <!-- 一括操作の取り消しも一括でできるようにする（「まとめて未確認に戻す」= 原則9.5）。
               運用対応・継続検討は行ごとの入力が必要なため一括対象外（1 件ずつドロワーから設定） -->
          <div class="ml-auto flex flex-wrap gap-2">
            <!-- まとめて AI 判定（ナレッジベース照合。判定後に一括変更へ進める = 選択は維持） -->
            <button
              type="button" class="btn btn-ghost btn-sm"
              :disabled="selectedReqIds.length === 0 || bulkBusy || bulkAssessBusy"
              @click="bulkAssess"
            >
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              {{ bulkAssessBusy ? 'AI 判定中…' : 'まとめて AI 判定' }}
            </button>
            <button
              v-for="opt in BULK_STATUS_OPTIONS"
              :key="opt.value"
              type="button" class="btn btn-sm"
              :class="opt.value === 'planned' ? 'btn-primary' : 'btn-ghost'"
              :disabled="selectedReqIds.length === 0 || bulkBusy || bulkAssessBusy"
              @click="bulkStatus(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <UiDataTable
          :columns="RAW_COLUMNS"
          :rows="rawTableRows"
          clickable
          empty-title="該当する要望はありません"
          :empty-hint="rawFilter === 'unconfirmed' ? '未確認の要望はありません。新しい投稿を待つか、他の絞り込みを確認してください' : '絞り込みを変えて確認してください'"
          @row-click="openRequestDrawer"
        >
          <!-- 複数選択（ステータス変更できる行のみ。クリックは行クリックへ伝播させない） -->
          <template #cell-select="{ row }">
            <input
              v-if="isTriageable(reqOf(row))"
              type="checkbox"
              class="h-4 w-4 accent-[var(--c-brand)]"
              :checked="selectedReqIds.includes(String(row.id))"
              :disabled="bulkBusy"
              :aria-label="`要望「${String(reqOf(row).body).slice(0, 20)}」を一括変更の対象に選択`"
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
          <!-- ステータス（受付箱の表示ステータス = inboxStatusOf。カンバン/ガントと同じ軸。
               継続検討は再検討日を併記・集約済みは「集約済み」を小書きで補足） -->
          <template #cell-status="{ row }">
            <div class="min-w-0">
              <UiStatusBadge
                :tone="inboxTone(imp.inboxStatusOf(reqOf(row)))"
                :label="inboxBadgeLabelOf(reqOf(row))"
                dot
              />
              <span v-if="reqOf(row).itemId" class="mt-0.5 block text-[10px] text-muted">集約済み（案件連動）</span>
            </div>
          </template>
          <!-- AI 判定（既存機能/運用工夫/改修要 = 改修依頼 2026-08-21。根拠・実行はドロワー） -->
          <template #cell-assess="{ row }">
            <UiStatusBadge
              v-if="reqOf(row).aiAssessment"
              :tone="IMPROVEMENT_ASSESS_META[reqOf(row).aiAssessment!.verdict].tone"
              :label="IMPROVEMENT_ASSESS_META[reqOf(row).aiAssessment!.verdict].label"
              dot
            />
            <span v-else class="text-[11px] text-muted">未判定</span>
          </template>
          <!-- 行内のステータス変更（許可された遷移の select。運用対応・継続検討は入力が必要なため
               選択するとドロワーの入力へ誘導。集約済み〔案件連動〕・取消済み・解決済みは操作なし） -->
          <template #cell-ops="{ row }">
            <div
              v-if="isTriageable(reqOf(row)) && nextInboxOf(reqOf(row)).length > 0"
              @click.stop
            >
              <select
                class="select w-full py-1 text-[12px]"
                value=""
                :disabled="statusBusy || bulkBusy"
                :aria-label="`要望「${String(reqOf(row).body).slice(0, 20)}」のステータスを変更`"
                @change="onRowStatusChange(reqOf(row), $event)"
              >
                <option value="" disabled>変更…</option>
                <option v-for="to in nextInboxOf(reqOf(row))" :key="to" :value="to">
                  {{ to === 'deferred' && imp.inboxStatusOf(reqOf(row)) === 'deferred' ? '再検討日を変更' : `${inboxLabel(to)}へ` }}
                </option>
              </select>
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
          <!-- 対象箇所（改修依頼 2026-08-21: 一覧に表示。空 = 未入力） -->
          <template #cell-targetSpot="{ row }">
            <span v-if="reqOf(row).targetSpot" class="line-clamp-2 text-[12px] text-sub">{{ reqOf(row).targetSpot }}</span>
            <span v-else class="text-[11px] text-muted">—</span>
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

      <!-- 受付箱（一覧・一般利用者）: 全要望を閲覧できる読み取り専用リスト。編集は自分の要望のみ・ステータス変更は管理者のみ（改修依頼 2026-08-19 第4弾） -->
      <UiSectionCard
        v-else-if="tab === 'inbox' && view === 'list'"
        flush
        title="受付箱（すべての要望）"
        description="全メンバーから寄せられた要望を閲覧できます。編集できるのは自分が投稿した要望のみです。ステータスの設定・AI 集約は管理者が行います。自分の要望が「運用対応」「対応済み」になったら、内容を確認して「解決済み」にできます。行クリックで詳細（本文全文・添付）を確認できます"
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
                :tone="inboxTone(imp.inboxStatusOf(r))"
                :label="inboxBadgeLabelOf(r)"
                dot
                class="shrink-0"
              />
            </button>
          </li>
        </ul>
        <UiPagination v-model:page="genPage" v-model:page-size="genPageSize" :total="genTotal" />

        <!-- 自分の取消済み（復元 = 原則9.5。自分が取り消した要望はいつでも戻せる） -->
        <div v-if="myArchivedRequests.length > 0" class="border-t border-line px-4 py-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="showMyArchivedRequests = !showMyArchivedRequests">
            {{ showMyArchivedRequests ? '自分の取消済みを隠す' : `自分の取消済みを表示（${myArchivedRequests.length}件）` }}
          </button>
          <ul v-if="showMyArchivedRequests" class="mt-1 divide-y divide-line">
            <li v-for="r in myArchivedRequests" :key="r.id" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2">
              <span class="min-w-0 flex-1 truncate text-[13px] text-muted line-through">{{ reqBodyLine(r) }}</span>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="restoringRequest" :aria-label="`「${reqBodyLine(r)}」の取消を戻す`" @click="restoreRequestFromList(r)">
                <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
                取消を戻す
              </button>
            </li>
          </ul>
        </div>
      </UiSectionCard>

      <!-- 受付箱のカンバン表示: 受付箱ステータス（8 列。集約済みは案件連動の導出）で一望
           （全員閲覧可・参照専用 = 改修依頼 2026-08-21 でステータス再編） -->
      <ImprovementsRequestKanban
        v-else-if="tab === 'inbox' && view === 'kanban'"
        :requests="activeRequests"
        :status-of="imp.inboxStatusOf"
        @open="openRequestDetail"
      />

      <!-- 受付箱のガント表示: 要望の投稿タイムライン（全員閲覧可・参照専用。色/絞り込みは受付箱ステータス軸） -->
      <ImprovementsRequestGantt
        v-else-if="tab === 'inbox' && view === 'gantt'"
        :requests="activeRequests"
        :status-of="imp.inboxStatusOf"
        @open="openRequestDetail"
      />

      <!-- 改修案件のカンバン表示: ステータス別（未対応/対応中/対応済の 3 列）に進捗を一望 -->
      <ImprovementsKanban
        v-else-if="tab === 'items' && view === 'kanban' && canManageImprovements"
        :items="imp.activeItems.value"
        :req-count="reqCount"
        @open="openDrawerItem"
        @status="onKanbanStatus"
      />

      <!-- 改修案件のガント表示: 対応予定期間を月次/週次/日次で可視化 -->
      <ImprovementsGantt
        v-else-if="tab === 'items' && view === 'gantt' && canManageImprovements"
        :items="imp.activeItems.value"
        @open="openDrawerItem"
      />

      <!-- ② 改修案件（改善対応 → AI 集約後の一覧）: フィルターと一覧。
           タブキーの明示指定: tab=''（全タブ deny の退避値）でフォールバック描画しない = フェイルクローズ（R2 レビュー反映） -->
      <UiSectionCard v-else-if="tab === 'items' && canManageImprovements" flush>
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
          empty-title="改修案件はまだありません"
          empty-hint="受付箱で「改善対応」にした要望を「AI で集約」すると、改修案件に整理されます"
          @row-click="openDrawer"
        >
          <template #cell-status="{ row }">
            <!-- 保存値は 3 状態へ正規化して表示（旧語彙にも効く = 原則7） -->
            <UiStatusBadge :tone="statusTone(itemViewOf(row as unknown as ImprovementItem))" :label="statusLabel(itemViewOf(row as unknown as ImprovementItem))" dot />
          </template>
          <!-- 担当者（対応中でアサイン = 関連画面に表示する要件。改修依頼 2026-08-21） -->
          <template #cell-assignee="{ row }">
            <span v-if="(row as unknown as ImprovementItem).assigneeName" class="inline-flex items-center gap-1 text-[12px] text-sub">
              <UserRound class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              {{ (row as unknown as ImprovementItem).assigneeName }}
            </span>
            <span v-else class="text-[11px] text-muted">—</span>
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
        未確認 {{ imp.unconfirmedRequests.value.length }} 件・改善対応（集約待ち）{{ imp.plannedUnclustered.value.length }} 件。
        受付箱でステータスを設定し、「改善対応を AI で集約」で改修案件に整理できます。
      </p>
    </div>

    <!-- 詳細ドロワー -->
    <UiDrawer :open="!!selected" :title="selected?.title ?? '改修案件'" width="560px" @close="selectedId = null">
      <div v-if="selected" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :tone="statusTone(itemViewOf(selected))" :label="statusLabel(itemViewOf(selected))" dot />
          <span v-if="selected.assigneeName" class="inline-flex items-center gap-1 text-[12px] text-sub">
            <UserRound class="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            担当: {{ selected.assigneeName }}
          </span>
          <span v-if="selected.archivedAt" class="text-[12px] text-crit">取消済み</span>
          <span class="text-[12px] text-muted">更新 {{ fmtDate(selected.updatedAt) }}</span>
        </div>

        <!-- ステータス操作（許可された遷移のみ = 3 状態機械。対応済 → 対応中の reopen 可 = 原則9.5） -->
        <div v-if="!selected.archivedAt" class="grid gap-2">
          <p class="label">ステータスを変更</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="to in IMPROVEMENT_ITEM_NEXT[itemViewOf(selected)]"
              :key="to"
              type="button"
              class="btn btn-sm"
              :class="to === 'done' ? 'btn-primary' : 'btn-ghost'"
              @click="onStatusClick(to)"
            >
              {{ statusLabel(to) }}へ
            </button>
          </div>
          <!-- 「対応中」への変更: 担当者をアサインできる（任意 = 改修依頼 2026-08-21。後からでも変更可） -->
          <div v-if="assignMode" class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
            <UiFormField label="担当者（任意）" hint="アサインした担当者は案件一覧・カンバン・ガントに表示されます。後からでも変更・解除できます">
              <UiSelect v-model="assignMemberId" :options="activeMemberOptions" empty-label="担当者未設定" aria-label="対応中の担当者" />
            </UiFormField>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="assignBusy" @click="assignMode = false">キャンセル</button>
              <button type="button" class="btn btn-primary btn-sm" :disabled="assignBusy" @click="confirmInProgress">「対応中」にする</button>
            </div>
          </div>
          <!-- 担当者の変更・解除（ステータス遷移と独立にいつでも変更できる = 原則9.5） -->
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="!assigneeEditMode">
              <button type="button" class="btn btn-ghost btn-sm" @click="startAssigneeEdit">
                <UserRound class="h-3.5 w-3.5" aria-hidden="true" />
                {{ selected.assigneeName ? '担当者を変更' : '担当者をアサイン' }}
              </button>
            </template>
            <template v-else>
              <UiSelect v-model="assigneeEditId" :options="activeMemberOptions" empty-label="担当者未設定（解除）" aria-label="担当者" class="w-48" />
              <button type="button" class="btn btn-primary btn-sm" :disabled="assigneeBusy" @click="saveAssignee">保存</button>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="assigneeBusy" @click="assigneeEditMode = false">キャンセル</button>
            </template>
          </div>
        </div>

        <!-- 対応予定期間（任意・ガントに反映） -->
        <div v-if="!selected.archivedAt" class="grid gap-2">
          <p class="label">対応予定期間</p>
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
                    >{{ r.pageLabel || r.pagePath }}</NuxtLink><template v-else>{{ r.pageLabel || r.pagePath || 'ページ不明' }}</template><template v-if="r.targetSpot">・対象箇所: {{ r.targetSpot }}</template>・{{ fmtDate(r.createdAt) }}
                  </p>
                  <!-- 受付箱の表示ステータス（案件連動の導出値。解決済み・見送りはプロンプト再生成にも
                       【解決済み】【対応見送り】として反映される） -->
                  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <UiStatusBadge
                      :tone="inboxTone(imp.inboxStatusOf(r))"
                      :label="inboxBadgeLabelOf(r)"
                      dot
                    />
                    <!-- 投稿時の任意タグ（壁打ち/お任せ = F-42-17） -->
                    <ImprovementsTagBadges :tags="r.tags" />
                  </div>
                </div>
                <div class="flex shrink-0 flex-col items-stretch gap-1">
                  <!-- 集約解除 = 改修案件から外して「改善対応（集約待ち）」へ戻す（再度 AI 集約の対象 = F-42-19）。
                       対応済 item = AKO-REQ-021（先にステータスを戻す）・取消済み item = AKO-REQ-022（先に復元）・
                       解決済みの要望 = AKO-REQ-025（先に解決の取消）は不可 = 記録保護・ボタン表示と検証の一致（R2） -->
                  <button
                    v-if="!selected.archivedAt && isOpenItemStatus(selected.status) && imp.inboxStatusOf(r) !== 'resolved'"
                    type="button"
                    class="btn btn-ghost btn-sm"
                    title="この要望の集約を解除（改善対応・集約待ちへ戻して再度 AI 集約の対象にする)"
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
                  <UiStatusBadge v-if="n.kind === 'reject'" class="mb-1" tone="warn" label="対応見送りの理由" />
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

    <!-- 受付箱の要望の詳細ドロワー（ステータス・AI 判定・コメントのやり取り・添付の参照） -->
    <UiDrawer :open="!!selectedRequest" title="要望の詳細" width="520px" @close="selectedRequestId = null">
      <div v-if="selectedRequest" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <!-- 受付箱の表示ステータス（集約済みは案件連動の導出 = 全員に見える公開情報） -->
          <UiStatusBadge
            :tone="inboxTone(imp.inboxStatusOf(selectedRequest))"
            :label="inboxBadgeLabelOf(selectedRequest)"
            dot
          />
          <UiStatusBadge
            v-if="selectedRequest.itemId"
            tone="info"
            label="集約済み"
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
            >{{ selectedRequest.pageLabel || selectedRequest.pagePath }}</NuxtLink><template v-else>{{ selectedRequest.pageLabel || selectedRequest.pagePath || 'ページ不明' }}</template><template v-if="selectedRequest.targetSpot">・対象箇所: {{ selectedRequest.targetSpot }}</template>・{{ fmtDateTimeSec(selectedRequest.createdAt) }}
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
            :initial-target-spot="selectedRequest.targetSpot ?? ''"
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

        <!-- 起票者の解決フラグ（改修依頼 2026-08-21: 「運用対応」の運用案内・「対応済み」の対応内容を
             確認したら本人が「解決済み」へ移す。「解決済みを取り消す」で戻せる = 原則9.5） -->
        <div
          v-if="!selectedRequest.archivedAt && isOwnSelectedRequest
            && ['operational', 'addressed', 'resolved'].includes(imp.inboxStatusOf(selectedRequest))"
          class="grid gap-2"
        >
          <p class="label">解決の記録（自分の要望）</p>
          <!-- 運用案内（起票者向け。通知と同一本文の記録 = 通知を OFF にしていてもここで読める。R2 監査 2026-08-21） -->
          <div v-for="g in ownGuidance" :key="g.id" class="rounded-lg border border-line bg-surface-soft p-2.5">
            <p class="whitespace-pre-wrap break-words text-[13px] text-ink">{{ g.body }}</p>
            <p class="num mt-1 text-[11px] text-muted">{{ fmtDateTimeSec(g.createdAt) }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="imp.inboxStatusOf(selectedRequest) !== 'resolved'">
              <button type="button" class="btn btn-sm" :disabled="ownResolveBusy" @click="resolveSelectedRequest(true)">
                <Check class="h-3.5 w-3.5" aria-hidden="true" />
                解決済みにする
              </button>
              <!-- 案内文は運用案内の表示有無で出し分け（0 件 = 取消・ロード失敗時に存在しない「上記」を指さない = R3 監査） -->
              <span class="text-[11px] text-muted">
                {{ imp.inboxStatusOf(selectedRequest) !== 'operational'
                  ? '改修が完了しています。内容を確認できたら「解決済み」にしてください'
                  : ownGuidance.length > 0
                    ? '運用対応の案内（上記。通知でもお知らせしています）を確認できたら「解決済み」にしてください'
                    : '運用対応の案内は通知でお知らせしています。案内が表示されない場合は管理者にお問い合わせください' }}
              </span>
            </template>
            <template v-else>
              <UiStatusBadge :tone="inboxTone('resolved')" :label="inboxLabel('resolved')" dot />
              <button type="button" class="btn btn-ghost btn-sm" :disabled="ownResolveBusy" @click="resolveSelectedRequest(false)">
                <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
                解決済みを取り消す
              </button>
            </template>
          </div>
        </div>

        <!-- AI 判定（既存機能で対応可か/運用の工夫で叶うか/改修が必要か = 改修依頼 2026-08-21。
             ナレッジベース〔アプリ仕様・運用/操作マニュアル〕を RAG に判定し、根拠と推奨アクションを表示。
             管理者のトリアージ補助のため管理権限者のみ） -->
        <div v-if="canManageImprovements" class="grid gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="label">AI 判定</p>
            <button
              v-if="!selectedRequest.archivedAt"
              type="button" class="btn btn-ghost btn-sm"
              :disabled="assessBusy"
              @click="runAssess(selectedRequest.id)"
            >
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              {{ assessBusy ? '判定中…' : (selectedRequest.aiAssessment ? 'AI で再判定' : 'AI で判定') }}
            </button>
          </div>
          <template v-if="selectedRequest.aiAssessment">
            <div class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <UiStatusBadge
                  :tone="IMPROVEMENT_ASSESS_META[selectedRequest.aiAssessment.verdict].tone"
                  :label="IMPROVEMENT_ASSESS_META[selectedRequest.aiAssessment.verdict].label"
                  dot
                />
                <UiStatusBadge :label="selectedRequest.aiAssessment.llm ? 'AI（LLM）' : '簡易判定'" tone="neutral" />
                <span class="num text-[11px] text-muted">{{ fmtDateTime(selectedRequest.aiAssessment.assessedAt) }}</span>
              </div>
              <p class="whitespace-pre-wrap break-words text-[13px] text-ink">{{ selectedRequest.aiAssessment.reason }}</p>
              <p v-if="assessDocTitles(selectedRequest.aiAssessment.docIds).length" class="text-[11px] text-muted">
                根拠: {{ assessDocTitles(selectedRequest.aiAssessment.docIds).join('・') }}
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[12px] text-sub">
                  推奨アクション:
                  <span class="font-semibold">「{{ inboxLabel(IMPROVEMENT_ASSESS_META[selectedRequest.aiAssessment.verdict].recommended) }}」</span>
                </span>
                <button
                  v-if="canApplyRecommended(selectedRequest)"
                  type="button" class="btn btn-primary btn-sm"
                  :disabled="statusBusy || reqStatusBusy"
                  @click="applyRecommended(selectedRequest)"
                >
                  推奨アクションを適用
                </button>
              </div>
            </div>
            <p v-if="selectedRequest.editedAt && selectedRequest.aiAssessment.assessedAt < selectedRequest.editedAt" class="text-[11px] text-warn">
              判定後に本文が編集されています。「AI で再判定」で最新の内容を反映できます。
            </p>
          </template>
          <p v-else class="text-[12px] text-muted">
            まだ AI 判定していません。「AI で判定」で、アプリのマニュアル・仕様と照合して
            「既存機能で対応可 / 運用の工夫で対応可 / 改修が必要」を判定できます。
          </p>
        </div>

        <!-- 受付箱ステータスの管理操作（管理権限者のみ = 改修依頼 2026-08-21。集約済みは案件連動 = 変更不可・
             解除が先。解決済みは取消してから遷移する = 記録保護。取消可能性 = 戻り遷移を常に用意 = 原則9.5） -->
        <div v-if="!selectedRequest.archivedAt && canManageImprovements" class="grid gap-2">
          <p class="label">ステータス</p>
          <template v-if="selectedRequest.itemId">
            <p class="text-[12px] text-muted">
              この要望は改修案件へ集約済みで、ステータスは案件の進捗に連動します（改善対応 → 案件対応済で
              「対応済み」）。「集約を解除」すると改修案件から外れ、「改善対応（集約待ち）」に戻って
              再度 AI 集約の対象になります（F-42-19。解除した要望が AI 集約で元の改修案件へ戻ることは
              ありません = 別の案件として整理されます）。
            </p>
            <!-- 対応済/取消済みの改修案件からは解除不可（記録保護 = 原則2。先にステータスを戻す/復元する導線を案内） -->
            <p v-if="selectedRequestItemDecided" class="text-[12px] text-warn">
              集約先の改修案件が対応済（決着）または取消済みのため解除できません。解除するには、先に改修案件のステータスを戻す／復元してください。
            </p>
            <!-- 解決済みの要望も解除不可（AKO-REQ-025 = 解除しても再集約対象にならないため。ボタン表示と検証の一致 = R2） -->
            <p v-else-if="imp.inboxStatusOf(selectedRequest) === 'resolved'" class="text-[12px] text-warn">
              解決済みの要望は集約を解除できません。解除するには、先に「解決済み」を取り消してください。
            </p>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-sm" @click="openItemOfRequest">集約先の改修案件を開く</button>
              <button
                v-if="!selectedRequestItemDecided && imp.inboxStatusOf(selectedRequest) !== 'resolved'"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="unclusterBusy"
                @click="unclusterRequestWithConfirm(selectedRequest.id)"
              >
                集約を解除（再集約の対象へ戻す）
              </button>
              <!-- 対応済みの要望は管理者も「解決済み」を記録できる（起票者確認の代行 = 改善対応トラックの手動遷移） -->
              <button
                v-if="imp.inboxStatusOf(selectedRequest) === 'addressed'"
                type="button" class="btn btn-primary btn-sm"
                :disabled="ownResolveBusy"
                @click="resolveSelectedRequest(true)"
              >解決済みにする</button>
              <button
                v-if="imp.inboxStatusOf(selectedRequest) === 'resolved'"
                type="button" class="btn btn-ghost btn-sm"
                :disabled="ownResolveBusy"
                @click="resolveSelectedRequest(false)"
              >解決済みを取り消す</button>
            </div>
          </template>
          <template v-else-if="imp.inboxStatusOf(selectedRequest) === 'resolved'">
            <p class="text-[12px] text-muted">この要望は解決済みです。ステータスを変更するには、先に「解決済み」を取り消してください。</p>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="ownResolveBusy" @click="resolveSelectedRequest(false)">
                <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
                解決済みを取り消す
              </button>
            </div>
          </template>
          <template v-else>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="to in nextInboxOf(selectedRequest)"
                :key="to"
                type="button"
                class="btn btn-sm"
                :class="to === 'planned' ? 'btn-primary' : 'btn-ghost'"
                :disabled="statusBusy || reqStatusBusy"
                @click="openReqStatusInput(to)"
              >
                {{ to === 'deferred' && imp.inboxStatusOf(selectedRequest) === 'deferred' ? '再検討日を変更' : `${inboxLabel(to)}へ` }}
              </button>
              <!-- 運用対応の要望は管理者も「解決済み」を記録できる（起票者確認を待たない運用も許す） -->
              <button
                v-if="imp.inboxStatusOf(selectedRequest) === 'operational'"
                type="button" class="btn btn-primary btn-sm"
                :disabled="ownResolveBusy"
                @click="resolveSelectedRequest(true)"
              >解決済みにする</button>
            </div>
            <!-- 「運用対応」への変更: 運用対応方法の案内（必須）。コメント〔時系列〕へ記録され、
                 起票者へ全文がそのまま通知される（起票者はこれを確認して「解決済み」へ移す） -->
            <div v-if="reqStatusMode === 'operational'" class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
              <UiFormField
                label="運用対応方法の案内（必須）"
                required
                hint="コメントに記録され、起票者へ全文がそのまま通知されます。起票者に見せる前提の文章で記載してください"
              >
                <!-- maxlength は UTF-16 コードユニット数（検証はコードポイント数）のため、サロゲートペア
                     （絵文字等）混在時は maxlength の方が先に効く = 上限突破しない安全側の差のみ -->
                <textarea
                  v-model="reqOpsNote"
                  class="textarea"
                  rows="3"
                  :maxlength="OPERATIONAL_NOTE_MAX"
                  placeholder="例: 設定 > 外部リンクから同じ導線を追加できます。手順: …"
                />
              </UiFormField>
              <p v-if="reqOpsError" class="text-[12px] text-crit" role="alert">{{ reqOpsError }}</p>
              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn-ghost btn-sm" :disabled="reqStatusBusy" @click="reqStatusMode = null">キャンセル</button>
                <button type="button" class="btn btn-primary btn-sm" :disabled="reqStatusBusy" @click="confirmReqOperational">「運用対応」にする</button>
              </div>
            </div>
            <!-- 「継続検討」への変更・再検討日の変更: 再検討日（必須）。到来すると管理者へリマインド通知が届く -->
            <div v-if="reqStatusMode === 'deferred'" class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
              <UiFormField label="再検討日（必須）" required hint="再検討日になると管理者へリマインド通知が届きます">
                <input
                  v-model="reqDeferDate"
                  class="input"
                  type="date"
                  aria-label="継続検討の再検討日"
                >
              </UiFormField>
              <p v-if="reqDeferError" class="text-[12px] text-crit" role="alert">{{ reqDeferError }}</p>
              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn-ghost btn-sm" :disabled="reqStatusBusy" @click="reqStatusMode = null">キャンセル</button>
                <button type="button" class="btn btn-primary btn-sm" :disabled="reqStatusBusy" @click="confirmReqDefer">
                  {{ imp.inboxStatusOf(selectedRequest) === 'deferred' ? '再検討日を保存' : '「継続検討」にする' }}
                </button>
              </div>
            </div>
            <!-- 「対応見送り」への変更: 任意で理由をコメントとして残せる（原則9.5 の判断根拠の記録） -->
            <div v-if="reqStatusMode === 'dismissed'" class="grid gap-2 rounded-lg border border-line bg-surface-soft p-2.5">
              <UiFormField label="対応見送りの理由（任意・コメントに記録されます）">
                <textarea
                  v-model="reqDismissReason"
                  class="textarea"
                  rows="3"
                  placeholder="例: 影響範囲が大きく、次期リプレイスで対応するため今回は見送り"
                />
              </UiFormField>
              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn-ghost btn-sm" :disabled="reqStatusBusy" @click="reqStatusMode = null">キャンセル</button>
                <button type="button" class="btn btn-primary btn-sm" :disabled="reqStatusBusy" @click="confirmReqDismiss">「対応見送り」にする</button>
              </div>
            </div>
          </template>
        </div>

        <!-- コメント（やり取り。時系列・追記のみ。取消 = 論理削除 = 原則9.5）。対応方針検討の記録のため管理権限者のみ（改修依頼 2026-08-19 第4弾） -->
        <div v-if="canManageImprovements" class="grid gap-2">
          <p class="label">コメント（時系列・{{ requestComments.length }} 件）</p>
          <p class="text-[11px] text-muted">
            対応方針の検討過程・見送り理由・運用案内・確認事項などを時系列で残せます（このページを閲覧できる管理メンバー内の記録です）。
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
              placeholder="コメントを追加（対応方針の検討・確認事項など）"
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
          「未対応」ステータスの改修案件のみを、コーディング AI エージェント向けの詳細プロンプト（対象ページ・機能名・改修内容・元要望・受入基準）として出力します（対応中・対応済は含まれません = 改修依頼 2026-08-21）。
          要望のステータス変更後は「再生成」で最新の状態（【解決済み】【対応見送り】の明記）を反映できます。
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="label">対象</span>
          <UiStatusBadge :label="IMPROVEMENT_ITEM_STATUS_META.todo.label" :tone="IMPROVEMENT_ITEM_STATUS_META.todo.tone" dot />
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
