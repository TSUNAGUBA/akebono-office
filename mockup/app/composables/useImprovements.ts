/**
 * 改善要望（F-42）の composable。デュアルモード（mock = useMockDb + 決定的集約 / API = /v1/improvements）。
 *
 * - submit(): 各ページの「要望を送る」から生要望を追記（認証済み全員可・読み取りしない）。
 * - 管理系（items / generate / setStatus / archive / buildPrompt）は改善要望管理ページ専用。
 *   API モードでは GET /items・/requests が管理権限者のみ（canManageImprovements）のため、
 *   非権限者はそもそも管理ページに到達しない（フロントの canPath ガード + サーバー 403）。
 * - 集約は shared/domain/improvement の決定的ヒューリスティックを使う（API は Vertex → 同関数へフォールバック）。
 *   未集約の要望のみ処理し、判定済み item のステータス・編集は巻き戻さない（原則2）。
 */
import type { Result } from '~/types/domain'
import {
  buildCodingPrompt,
  buildItemDetail,
  buildUnclusterNoteBody,
  canTransition,
  capCodePoints,
  heuristicClusterRequests,
  IMPROVEMENT_BODY_CAP,
  IMPROVEMENT_DETAIL_CAP,
  IMPROVEMENT_NOTE_CAP,
  IMPROVEMENT_PAGE_LABEL_CAP,
  IMPROVEMENT_PAGE_PATH_CAP,
  IMPROVEMENT_TARGET_SPOT_CAP,
  IMPROVEMENT_SUMMARY_CAP,
  IMPROVEMENT_TITLE_CAP,
  IMPROVEMENT_COMMENT_CAP,
  IMPROVEMENT_REQUEST_ADOPTIONS,
  IMPROVEMENT_REQUEST_STATUSES,
  type ImprovementFilter,
  type ImprovementItem,
  type ImprovementNote,
  type ImprovementNoteKind,
  type ImprovementRequest,
  type ImprovementRequestAdoption,
  type ImprovementRequestComment,
  type ImprovementRequestImage,
  type ImprovementRequestStatus,
  type ImprovementRequestTag,
  type ImprovementStatus,
  improvementAdoptionError,
  improvementBodyError,
  improvementEditError,
  improvementUnclusterError,
  improvementCommentError,
  improvementEditChangedLabel,
  improvementImagesError,
  improvementLinksError,
  improvementNoteError,
  improvementPlanError,
  improvementRequestEditFields,
  matchesImprovementFilter,
  normalizeImprovementImages,
  normalizeImprovementLinks,
  normalizeImprovementPagePath,
  normalizeImprovementTags,
  planAdoptionBulk,
  clusterTargetRequests,
  requestAdoptionOf,
  type PromptItemInput,
} from '~/types/improvement'

export interface GenerateResult {
  ok: boolean
  error?: { code: string; message: string }
  created?: number
  appended?: number
  clustered?: number
  llm?: boolean
  /** mock のみ: localStorage への永続化可否（false = 容量超過 = 再読込で消える可能性。レビュー R17） */
  persisted?: boolean
}

export function useImprovements() {
  const { tbl, commit, nextId } = useMockDb()
  const isApi = useApiMode()
  const { currentUser } = useCurrentUser()
  const { canManageImprovements } = usePermissions()

  // API モードの管理データ（includeArchived で取消済みも取得。refresh で更新）。
  // mock モードは tbl（localStorage）をそのまま参照する（リアクティブ）。
  const apiItems = ref<ImprovementItem[]>([])
  const apiRequests = ref<ImprovementRequest[]>([])
  const apiNotes = ref<ImprovementNote[]>([])
  const apiComments = ref<ImprovementRequestComment[]>([])

  // isApi 分岐で tbl を触るのは mock モードのみ = API モードで管理 GET を誤発火しない
  const allItems = computed<ImprovementItem[]>(() => (isApi ? apiItems.value : tbl('improvementItems').value))
  const allRequests = computed<ImprovementRequest[]>(() => (isApi ? apiRequests.value : tbl('improvementRequests').value))
  const allNotes = computed<ImprovementNote[]>(() => (isApi ? apiNotes.value : tbl('improvementNotes').value))
  const allComments = computed<ImprovementRequestComment[]>(() =>
    (isApi ? apiComments.value : tbl('improvementRequestComments').value))

  /** 有効な改修単位（取消済みを除く）。ステータスは含めall */
  const activeItems = computed(() => allItems.value.filter(it => !it.archivedAt))
  /** 取消済みの改修単位 */
  const archivedItems = computed(() => allItems.value.filter(it => it.archivedAt))
  /** 未集約かつ有効な生要望 */
  const unclusteredRequests = computed(() => allRequests.value.filter(r => !r.itemId && !r.archivedAt))
  /** 採用済み・未集約の生要望（「AI で集約」の対象 = 件数バッジ。改善要望 2026-08-17 第 2 弾）。
   *  判定は shared の clusterTargetRequests（API generate の SQL 条件と同一 = 原則6） */
  const adoptedUnclustered = computed(() => clusterTargetRequests(allRequests.value))
  /** 未選別の生要望（管理者の確認待ち = 受付箱バッジ） */
  const pendingRequests = computed(() =>
    unclusteredRequests.value.filter(r => requestAdoptionOf(r) === 'pending'))

  /** ある改修単位の元要望（有効なもの） */
  function requestsForItem(itemId: string): ImprovementRequest[] {
    return allRequests.value.filter(r => r.itemId === itemId && !r.archivedAt)
  }

  /** ある改修単位の時系列メモ（有効なもの・古い順） */
  function notesForItem(itemId: string): ImprovementNote[] {
    return allNotes.value
      .filter(n => n.itemId === itemId && !n.archivedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** ある生要望のコメント（有効なもの・古い順。選別のやり取り = 改善要望 2026-08-17 第 2 弾） */
  function commentsForRequest(requestId: string): ImprovementRequestComment[] {
    return allComments.value
      .filter(cm => cm.requestId === requestId && !cm.archivedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** 要望 id → 有効コメント件数（一覧セル用。行ごとの全件フィルタを避け 1 パスで集計 = レビュー R9） */
  const commentCountByRequest = computed<Map<string, number>>(() => {
    const counts = new Map<string, number>()
    for (const cm of allComments.value) {
      if (cm.archivedAt) continue
      counts.set(cm.requestId, (counts.get(cm.requestId) ?? 0) + 1)
    }
    return counts
  })

  // ---------- 投稿（各ページから。全員可） ----------

  async function submit(input: {
    body: string; pagePath?: string; pageLabel?: string; targetSpot?: string
    links?: string[]; images?: ImprovementRequestImage[]; tags?: ImprovementRequestTag[]
  }): Promise<Result & { persisted?: boolean }> {
    const body = (input.body ?? '').trim()
    const msg = improvementBodyError(body)
    if (msg) return { ok: false, error: { code: 'AKO-REQ-001', message: msg } }
    // 添付（URL リンク・画像。任意）。検証は shared の共有関数 = API と両モード parity
    const links = normalizeImprovementLinks(input.links ?? [])
    const linksMsg = improvementLinksError(links)
    if (linksMsg) return { ok: false, error: { code: 'AKO-REQ-009', message: linksMsg } }
    const images = normalizeImprovementImages(input.images ?? [])
    const imagesMsg = improvementImagesError(images)
    if (imagesMsg) return { ok: false, error: { code: 'AKO-REQ-010', message: imagesMsg } }
    // 任意タグ（壁打ち/お任せ = F-42-17）。allowlist 正規化のみ（未知値は落とす = API と同一）
    const tags = normalizeImprovementTags(input.tags ?? [])
    // アプリ内パスのみ保持（'//host' 等は '' へ = 対象ページリンク化 F-42-20 に伴う防御。API と同一規則）
    const pagePath = capCodePoints(normalizeImprovementPagePath(input.pagePath), IMPROVEMENT_PAGE_PATH_CAP)
    const pageLabel = capCodePoints((input.pageLabel ?? '').trim(), IMPROVEMENT_PAGE_LABEL_CAP)
    // 対象箇所（ページ内のどこか = 自由入力・任意。改修依頼 2026-08-19 第4弾。API と同一規則）
    const targetSpot = capCodePoints((input.targetSpot ?? '').trim(), IMPROVEMENT_TARGET_SPOT_CAP)
    if (isApi) {
      // 管理 GET は権限者のみのため reload しない（投稿者は一覧を見ない）
      const res = await apiWrite<{ id: string }>('/v1/improvements/requests', {
        body: { body: capCodePoints(body, IMPROVEMENT_BODY_CAP), pagePath, pageLabel, targetSpot, links, images, tags },
      })
      return res.ok ? { ok: true, id: res.id } : res
    }
    const rows = tbl('improvementRequests')
    const id = nextId('improvementRequests', 'imreq')
    rows.value = [...rows.value, {
      id,
      memberId: currentUser.value.id,
      memberName: currentUser.value.name,
      pagePath,
      pageLabel,
      targetSpot,
      body: capCodePoints(body, IMPROVEMENT_BODY_CAP),
      adoption: 'pending', // 投稿直後は未選別（管理者の取捨選択が先 = 改善要望 2026-08-17 第 2 弾）
      tags,
      links,
      images,
      itemId: null,
      archivedAt: null,
      createdAt: nowJstIso(),
    }]
    // 画像添付で localStorage 容量超過になりうる。永続化可否を返し UI が警告できるようにする（useProducts.addImage と同型）
    const persisted = commit()
    return { ok: true, id, persisted }
  }

  // ---------- 管理データのロード（管理ページから） ----------

  /** 管理データを取得（API モードのみ実フェッチ。mock はライブ computed のため no-op） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    // 失敗時は最後に取得できたデータを保持する（[] を返すと 401/403/断線のたびに管理画面が白紙化する =
    // レビュー R18。初回ロード失敗はキャッシュが空のため従来どおり空表示）
    const [items, reqs, notes, comments] = await Promise.all([
      apiFetch<ImprovementItem[]>('/v1/improvements/items', { query: { includeArchived: '1' } }).catch(() => apiItems.value),
      apiFetch<ImprovementRequest[]>('/v1/improvements/requests', { query: { includeArchived: '1' } }).catch(() => apiRequests.value),
      // メモ・コメントは有効なもののみ（取消済みは UI に出さない = 追加操作の取消は確認ダイアログで担保。原則9.5）
      apiFetch<ImprovementNote[]>('/v1/improvements/notes').catch(() => apiNotes.value),
      apiFetch<ImprovementRequestComment[]>('/v1/improvements/request-comments').catch(() => apiComments.value),
    ])
    apiItems.value = items
    apiComments.value = comments
    // 全件 GET は画像を含まない（転送量削減）。遅延ロード済みの画像は引き継ぐ
    // （要望は追記系で画像は不変のため、キャッシュが古くなることはない）
    const prevImages = new Map(apiRequests.value.filter(r => (r.images ?? []).length > 0).map(r => [r.id, r.images!]))
    apiRequests.value = reqs.map(r =>
      ((r.images ?? []).length === 0 && prevImages.has(r.id) ? { ...r, images: prevImages.get(r.id)! } : r))
    apiNotes.value = notes
  }

  /** 画像ロード済みの改修単位 id（画像は追記系で不変のため無効化不要 = 再オープンは再取得しない） */
  const imagesLoadedFor = new Set<string>()
  /**
   * 進行中フェッチの共有（itemId 単位）。受付箱の一覧 watch がページ内の全行を一括で呼ぶため、
   * 完了メモだけでは同一 API へ並列重複フェッチが発行される（R1 コードレビュー MAJOR）。
   * 進行中は同じ Promise を返し、失敗時はエントリを消して次回リトライ可能にする
   */
  const imagesLoading = new Map<string, Promise<void>>()

  /**
   * ある改修単位の元要望の添付画像を遅延ロード（API モードのみ。全件 GET は画像を含まないため、
   * 一覧表示・ドロワーオープン時に itemId 指定の GET から画像込み行を取得して差し替える）。
   * 失敗しても本文表示は妨げない（原則4）。mock は画像を常に保持しているため no-op。
   */
  function loadRequestImages(itemId: string): Promise<void> {
    if (!isApi || !itemId || imagesLoadedFor.has(itemId)) return Promise.resolve()
    const inflight = imagesLoading.get(itemId)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const rows = await apiFetch<ImprovementRequest[]>('/v1/improvements/requests', {
          query: { itemId, includeArchived: '1' },
        })
        const byId = new Map(rows.map(r => [r.id, r]))
        apiRequests.value = apiRequests.value.map(r => byId.get(r.id) ?? r)
        imagesLoadedFor.add(itemId)
      } catch { /* 画像の遅延ロード失敗は無視（本文・リンクは表示済み。次回表示で再試行） */ } finally {
        imagesLoading.delete(itemId)
      }
    })()
    imagesLoading.set(itemId, p)
    return p
  }

  /** 画像ロード済みの未集約要望 id（loadRequestImagesFor 用。画像は不変のため無効化不要） */
  const unclusteredImagesLoaded = new Set<string>()
  /** 未集約分の進行中フェッチの共有（1 リクエストで未集約全件を取得するため単一スロット） */
  let unclusteredImagesLoading: Promise<void> | null = null

  /**
   * 生要望一覧・ドロワー用の添付画像の遅延ロード（API モードのみ）。集約済みは itemId 指定ロードへ委譲し、
   * 未集約は unclustered=1 の GET（画像込み・未集約全件を 1 回で取得）で差し替える。
   * 進行中は同じ Promise を共有し重複発行しない。失敗しても本文表示は妨げない（原則4）。
   */
  function loadRequestImagesFor(r: ImprovementRequest): Promise<void> {
    if (!isApi) return Promise.resolve()
    if (r.itemId) return loadRequestImages(r.itemId)
    if (unclusteredImagesLoaded.has(r.id)) return Promise.resolve()
    if (unclusteredImagesLoading) return unclusteredImagesLoading
    unclusteredImagesLoading = (async () => {
      try {
        // includeArchived: 取消済み（復元判断で添付を見る）も対象。省略すると API が archived を除外し、
        // 取消済み行の画像が永久にロードされず毎回空振りフェッチになる（レビュー指摘 2026-08-17）
        const rows = await apiFetch<ImprovementRequest[]>('/v1/improvements/requests', {
          query: { unclustered: '1', includeArchived: '1' },
        })
        const byId = new Map(rows.map(x => [x.id, x]))
        apiRequests.value = apiRequests.value.map(x => byId.get(x.id) ?? x)
        rows.forEach(x => unclusteredImagesLoaded.add(x.id))
        // 要求元の行が応答に無くてもマークする（並行して集約された等の stale 行）。応答は未集約全件の
        // 正であり以後も返らない = マークしても取りこぼしなし（集約後の画像は itemId 経由が担う）。
        // マークしないと成功のたびに一覧 watch が再発火して逐次リフェッチが続く（R2 レビュー反映）
        unclusteredImagesLoaded.add(r.id)
      } catch { /* 画像の遅延ロード失敗は無視（次回表示で再試行） */ } finally {
        unclusteredImagesLoading = null
      }
    })()
    return unclusteredImagesLoading
  }

  /**
   * 要望の添付画像が遅延ロード済みか（API モードのみ意味を持つ。mock は常に画像を保持するため true）。
   * 一覧 GET は画像を含まない（images:[] スタブ）ため、編集フォームが未ロードのスナップショットを
   * そのまま保存すると添付を消してしまう。呼び出し側はこれで「編集開始前にロードをゲート」
   * 「未ロード時は images をパッチから外す（= 現行値保持）」を判断する（レビュー R1 CRIT）。
   * ロード成功後は画像が無い要望も true になる（= 「未確認」と「確認済みで画像なし」を区別できる）。
   */
  function imagesLoadedForRequest(r: ImprovementRequest): boolean {
    if (!isApi) return true
    return r.itemId ? imagesLoadedFor.has(r.itemId) : unclusteredImagesLoaded.has(r.id)
  }

  // ---------- AI 集約（生成・再生成） ----------

  /** mock モードの決定的集約（API の Vertex→ヒューリスティックのフォールバックと同一ロジック）。
   *  対象は**採用（adopted）済み**の未集約要望のみ（未選別・不採用は集約しない = 2026-08-17 第 2 弾） */
  function mockGenerate(): GenerateResult {
    const reqsRef = tbl('improvementRequests')
    const itemsRef = tbl('improvementItems')
    const unclustered = clusterTargetRequests(reqsRef.value)
      // excludeItemIds = 「集約の解除」の履歴（そこへは再追記しない = F-42-19）
      .map(r => ({ id: r.id, pagePath: r.pagePath, pageLabel: r.pageLabel, body: r.body, excludeItemIds: r.excludedItemIds ?? [] }))
    if (unclustered.length === 0) return { ok: true, created: 0, appended: 0, clustered: 0, llm: false }
    const openItems = itemsRef.value
      .filter(it => it.status === 'triage' && !it.archivedAt)
      .map(it => ({ id: it.id, status: it.status, pagePaths: it.pagePaths }))
    const plan = heuristicClusterRequests(openItems, unclustered)
    const now = nowJstIso()
    const reqPatch = new Map<string, string>()
    const newItems: ImprovementItem[] = []
    // nextId はコミット済みの行しか見ないため、ループ内で 2 件目以降を採番すると id が重複する
    // （1 回の集約で複数ページ分の新規 item ができるのは通常ケース。id 重複 = 別 item への一括変更・
    // v-for キー衝突の実バグ = レビュー R11）。基点を 1 回だけ取り、以降はローカルに加算する
    let nextItemNum = Number(nextId('improvementItems', 'imp').slice('imp-'.length))
    for (const cr of plan.creates) {
      const id = `imp-${String(nextItemNum).padStart(4, '0')}`
      nextItemNum += 1
      newItems.push({
        id, title: cr.title, summary: cr.summary, detail: cr.detail, status: 'triage',
        pagePaths: cr.pagePaths, sourceRequestIds: cr.requestIds, llm: false,
        archivedAt: null, createdAt: now, updatedAt: now, resolvedAt: null,
        planStart: null, planEnd: null,
      })
      cr.requestIds.forEach(rid => reqPatch.set(rid, id))
    }
    let itemsVal = [...itemsRef.value]
    for (const ap of plan.appends) {
      const idx = itemsVal.findIndex(it => it.id === ap.itemId && it.status === 'triage' && !it.archivedAt)
      if (idx < 0) continue
      const cur = itemsVal[idx]!
      const newReqs = ap.requestIds
        .map(rid => unclustered.find(u => u.id === rid))
        .filter((r): r is NonNullable<typeof r> => !!r)
      if (newReqs.length === 0) continue
      const mergedSources = [...new Set([...cur.sourceRequestIds, ...ap.requestIds])]
      const mergedPaths = [...new Set([...cur.pagePaths, ...newReqs.map(r => r.pagePath.trim()).filter(Boolean)])]
      itemsVal[idx] = {
        ...cur, sourceRequestIds: mergedSources, pagePaths: mergedPaths,
        detail: capCodePoints(`${cur.detail}\n\n${buildItemDetail(newReqs)}`, IMPROVEMENT_DETAIL_CAP),
        updatedAt: now,
      }
      ap.requestIds.forEach(rid => reqPatch.set(rid, ap.itemId))
    }
    itemsRef.value = [...itemsVal, ...newItems]
    // excludedItemIds（解除の履歴）は集約後もクリアしない（過去に外した単位へ戻さない = レビュー R6・API と同一）
    reqsRef.value = reqsRef.value.map(r => (reqPatch.has(r.id) ? { ...r, itemId: reqPatch.get(r.id)! } : r))
    // 永続化可否を返し UI が警告できるようにする（他の書込と同型 = 容量超過の変更消失を黙認しない。レビュー R17）
    const persisted = commit()
    return { ok: true, created: plan.creates.length, appended: plan.appends.length, clustered: reqPatch.size, llm: false, persisted }
  }

  async function generate(): Promise<GenerateResult> {
    if (isApi) {
      const res = await apiWrite<{ created: number; appended: number; clustered: number; llm: boolean }>(
        '/v1/improvements/generate', {})
      if (!res.ok) return { ok: false, error: res.error }
      // 集約で要望の紐付け先が変わる（画像付き要望が既存 item へ追記されうる）ため、画像ロード済みフラグを破棄
      imagesLoadedFor.clear()
      await refresh()
      return { ok: true, ...res.data }
    }
    return mockGenerate()
  }

  // ---------- ステータス・編集・取消 ----------

  async function setStatus(id: string, status: ImprovementStatus): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/items/${id}/status`, { body: { status } })
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const itemsRef = tbl('improvementItems')
    const cur = itemsRef.value.find(it => it.id === id)
    if (!cur) return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の改修単位が見つかりません' } }
    if (cur.status === status) return { ok: true, id } // 同一ステータスは no-op（再スタンプしない）
    if (!canTransition(cur.status, status)) {
      return { ok: false, error: { code: 'AKO-REQ-006', message: `「${cur.status}」から「${status}」へは変更できません` } }
    }
    const now = nowJstIso()
    itemsRef.value = itemsRef.value.map(it => (it.id === id
      ? { ...it, status, resolvedAt: status === 'resolved' ? now : null, updatedAt: now }
      : it))
    commit()
    return { ok: true, id }
  }

  async function editItem(
    id: string,
    patch: { title?: string; summary?: string; detail?: string; planStart?: string; planEnd?: string },
  ): Promise<Result> {
    // 対応予定期間の検証（両モード。実在日・終了>=開始）
    const hasPlan = patch.planStart !== undefined || patch.planEnd !== undefined
    if (hasPlan) {
      const msg = improvementPlanError(patch.planStart ?? '', patch.planEnd ?? '')
      if (msg) return { ok: false, error: { code: 'AKO-REQ-007', message: msg } }
    }
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/items/${id}`, { body: patch })
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const itemsRef = tbl('improvementItems')
    if (!itemsRef.value.some(it => it.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の改修単位が見つかりません' } }
    }
    const now = nowJstIso()
    itemsRef.value = itemsRef.value.map(it => (it.id === id
      ? {
          ...it,
          ...(patch.title !== undefined ? { title: capCodePoints(patch.title.trim(), IMPROVEMENT_TITLE_CAP) } : {}),
          ...(patch.summary !== undefined ? { summary: capCodePoints(patch.summary.trim(), IMPROVEMENT_SUMMARY_CAP) } : {}),
          ...(patch.detail !== undefined ? { detail: capCodePoints(patch.detail.trim(), IMPROVEMENT_DETAIL_CAP) } : {}),
          // 予定期間は開始/終了をまとめて更新（空 = クリア = null。API と同じ挙動）
          ...(hasPlan
            ? { planStart: (patch.planStart ?? '').trim() || null, planEnd: (patch.planEnd ?? '').trim() || null }
            : {}),
          updatedAt: now,
        }
      : it))
    commit()
    return { ok: true, id }
  }

  async function setItemArchived(id: string, archived: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/items/${id}/${archived ? 'archive' : 'restore'}`, {})
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const itemsRef = tbl('improvementItems')
    if (!itemsRef.value.some(it => it.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の改修単位が見つかりません' } }
    }
    const now = nowJstIso()
    itemsRef.value = itemsRef.value.map(it => (it.id === id
      ? { ...it, archivedAt: archived ? now : null, updatedAt: now }
      : it))
    commit()
    return { ok: true, id }
  }

  /**
   * 要望の選別（採用/不採用/未選別へ戻す。遷移自由 = 選び直しはいつでも可 = 原則9.5）。
   * 採用のみ AI 集約対象。集約済み（itemId あり）の要望は変更不可（API は AKO-REQ-013 = 記録保護）。
   */
  async function setRequestAdoption(id: string, adoption: ImprovementRequestAdoption): Promise<Result & { persisted?: boolean }> {
    if (!IMPROVEMENT_REQUEST_ADOPTIONS.includes(adoption)) {
      return { ok: false, error: { code: 'AKO-REQ-012', message: 'adoption が不正です（pending / adopted / declined）' } }
    }
    if (isApi) {
      const res = await apiWrite<ImprovementRequest>(`/v1/improvements/requests/${id}/adoption`, { body: { adoption } })
      if (!res.ok) return res
      // 応答行（RETURNING）をキャッシュへ差し込む: 行内 採用/不採用 は選別のホットパスのため、
      // 1 クリックごとの 4 コレクション全再取得（refresh）を避ける（レビュー R22）。
      // 一覧応答は images を '[]' で伏せるため、遅延ロード済みの画像は既存キャッシュから引き継ぐ
      const updated = res.data
      apiRequests.value = apiRequests.value.map(r => (r.id === id
        ? { ...updated, images: (updated.images ?? []).length > 0 ? updated.images : r.images }
        : r))
      return { ok: true, id }
    }
    const reqsRef = tbl('improvementRequests')
    // ガード（存在 → 取消済み → 集約済み）は共有の improvementAdoptionError（API・一括仕分けと同一判定 = 原則6）
    const guard = improvementAdoptionError(reqsRef.value.find(r => r.id === id))
    if (guard) return { ok: false, error: guard }
    reqsRef.value = reqsRef.value.map(r => (r.id === id ? { ...r, adoption } : r))
    // 永続化可否を返し UI が警告できるようにする（submit / 一括選別と同型 = 容量超過の変更消失を黙認しない。レビュー R16）
    const persisted = commit()
    return { ok: true, id, persisted }
  }

  /**
   * 要望の選別の一括変更（受付箱の複数選択 → まとめて採用/不採用 = 改修依頼 2026-08-18）。
   * setRequestAdoption と同じ検証・ガード（集約済みは変更不可）を通し、一部が失敗しても
   * 処理できた分は確定して done/failed で報告する（グレースフルデグラデーション = 原則4）。
   * API モードは既存の 1 件エンドポイントを逐次呼び、再取得（refresh）は最後に 1 回だけ行う。
   * 選別は遷移自由のため何度実行しても同じ結果（冪等 = 原則2）。
   */
  async function setRequestAdoptionBulk(
    ids: string[], adoption: ImprovementRequestAdoption,
  ): Promise<{
    ok: boolean; done: number; failed: number; failedIds: string[]
    error?: { code: string; message: string }; persisted?: boolean
  }> {
    // 重複除去は全経路で 1 回だけ行う（同一入力で failed 件数が揺れない = レビュー R14/R20）
    const targets = [...new Set(ids)]
    if (!IMPROVEMENT_REQUEST_ADOPTIONS.includes(adoption)) {
      return { ok: false, done: 0, failed: targets.length, failedIds: targets, error: { code: 'AKO-REQ-012', message: 'adoption が不正です（pending / adopted / declined）' } }
    }
    if (targets.length === 0) {
      return { ok: false, done: 0, failed: 0, failedIds: [], error: { code: 'AKO-REQ-016', message: '選別する要望が選択されていません' } }
    }
    let done = 0
    let lastError: { code: string; message: string } | undefined
    let persisted: boolean | undefined
    const failedIds: string[] = []
    // 以降の全滅が確定するエラー（認可断・認証断・ネットワーク断）: 残りへの逐次 POST と refresh を
    // 打ち切る判定を 1 か所に（レビュー R15/R18/R19）
    const isFatalBulkError = (code: string): boolean =>
      code === 'AKO-PRM-001' || code.startsWith('AKO-AUTH-') || code === 'AKO-GEN-NET'
    if (isApi) {
      for (let i = 0; i < targets.length; i += 1) {
        const id = targets[i]!
        // 1 件 API（setRequestAdoption = 成功時に応答行をキャッシュへ即反映）を再利用する:
        // 途中で打ち切られても成功分の表示が正しく残る（原則3・レビュー R24）
        const res = await setRequestAdoption(id, adoption)
        if (res.ok) {
          done += 1
          continue
        }
        lastError = res.error
        failedIds.push(id)
        if (isFatalBulkError(res.error.code)) {
          failedIds.push(...targets.slice(i + 1))
          break
        }
      }
      // 成功分は setRequestAdoption がキャッシュへ反映済み。失敗があった場合のみ、他端末の先行変更
      // （409 の原因 = 集約・取消済み）を取り込むため 1 回だけ refresh する（レビュー R2/R24）。
      // 認可断・認証断・ネットワーク断は refresh の全 GET も失敗が確定しているため呼ばない
      // （refresh 自体も失敗時は最後のデータを保持するが、無駄な 4 GET を避ける = レビュー R17/R18/R19）
      if (failedIds.length > 0 && !(lastError && isFatalBulkError(lastError.code))) await refresh()
    } else {
      const reqsRef = tbl('improvementRequests')
      // 仕分け（存在・集約済み・取消済み）は共有純関数（API 側の 1 件判定と同一 = 原則6。単体テストで固定）
      const plan = planAdoptionBulk(targets, reqsRef.value)
      const applicableSet = new Set(plan.applicable)
      if (applicableSet.size > 0) {
        reqsRef.value = reqsRef.value.map(r => (applicableSet.has(r.id) ? { ...r, adoption } : r))
        // 永続化可否を返し UI が警告できるようにする（submit と同型 = 容量超過の変更消失を黙認しない。レビュー R7）
        persisted = commit()
      }
      done = plan.applicable.length
      lastError = plan.lastError ?? undefined
      failedIds.push(...targets.filter(id => !applicableSet.has(id)))
    }
    const failed = targets.length - done
    if (done === 0) {
      return { ok: false, done, failed, failedIds, error: lastError ?? { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' } }
    }
    return { ok: true, done, failed, failedIds, error: lastError, persisted }
  }

  /**
   * 集約の解除（F-42-19・改修依頼 2026-08-18）。集約済みの要望を改修単位から外し、
   * 「採用済み（集約待ち）」へ明示的に戻す = 次回の「AI で集約」の対象になる（取消 archive と違い
   * 要望は生きたまま）。item のステータス・本文には触れない（人手の記録は不変 = 原則2）が、
   * sourceRequestIds のトレースからは除去して導出値を整合させる（原則6）。ガードは共有の
   * improvementUnclusterError（存在 → 未集約 → 取消済み = API ルートと同一判定・単体テストで固定）。
   */
  async function unclusterRequest(id: string): Promise<Result & { persisted?: boolean }> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/requests/${id}/uncluster`, {})
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const reqsRef = tbl('improvementRequests')
    const itemsRef = tbl('improvementItems')
    const target = reqsRef.value.find(r => r.id === id)
    // 取消済み（AKO-REQ-022）・決着済み（AKO-REQ-021）item の元要望は解除不可（API と同一判定 = 原則6）
    const guard = improvementUnclusterError(
      target,
      target?.itemId ? itemsRef.value.find(it => it.id === target.itemId) ?? null : null,
    )
    if (guard) return { ok: false, error: guard }
    const itemId = target!.itemId!
    // excludedItemIds へ元 item を追記（解除の履歴 = 蓄積・クリアしない。次回以降の集約でそこへは再追記しない）
    reqsRef.value = reqsRef.value.map(r => (r.id === id
      ? {
          ...r,
          itemId: null,
          adoption: 'adopted' as const,
          excludedItemIds: [...new Set([...(r.excludedItemIds ?? []), itemId])],
        }
      : r))
    const now = nowJstIso()
    itemsRef.value = itemsRef.value.map(it => (it.id === itemId
      ? { ...it, sourceRequestIds: it.sourceRequestIds.filter(rid => rid !== id), updatedAt: now }
      : it))
    // 元 item の detail に残る旧記載を実装対象から外す修正メモ（buildCodingPrompt の担当者メモに載る。
    // 文言は shared の buildUnclusterNoteBody = API と同一・原則6。レビュー R4）
    const notesRef = tbl('improvementNotes')
    notesRef.value = [...notesRef.value, {
      id: nextId('improvementNotes', 'imnote'),
      itemId,
      memberId: currentUser.value.id,
      memberName: currentUser.value.name,
      body: buildUnclusterNoteBody(target!.body),
      kind: 'note',
      archivedAt: null,
      createdAt: now,
    }]
    // 永続化可否を返し UI が警告できるようにする（submit と同型 = 容量超過の変更消失を黙認しない。レビュー R7）
    const persisted = commit()
    return { ok: true, id, persisted }
  }

  // ---------- 生要望へのコメント（選別のやり取り。記録系・追記のみ = 2026-08-17 第 2 弾） ----------

  /** コメントを追加（管理権限者 + 投稿者本人。API 側で権限判定） */
  async function addRequestComment(requestId: string, body: string): Promise<Result> {
    const text = (body ?? '').trim()
    const msg = improvementCommentError(text)
    if (msg) return { ok: false, error: { code: 'AKO-REQ-014', message: msg } }
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/requests/${requestId}/comments`, {
        body: { body: capCodePoints(text, IMPROVEMENT_COMMENT_CAP) },
      })
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id: requestId } : res
    }
    const reqsRef = tbl('improvementRequests')
    if (!reqsRef.value.some(r => r.id === requestId && !r.archivedAt)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' } }
    }
    const commentsRef = tbl('improvementRequestComments')
    const id = nextId('improvementRequestComments', 'imcmt')
    commentsRef.value = [...commentsRef.value, {
      id, requestId, memberId: currentUser.value.id, memberName: currentUser.value.name,
      body: capCodePoints(text, IMPROVEMENT_COMMENT_CAP), archivedAt: null, createdAt: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  /** コメントの取消（論理削除）/ 復元（原則9.5） */
  async function setRequestCommentArchived(id: string, archived: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/request-comments/${id}/${archived ? 'archive' : 'restore'}`, {})
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const commentsRef = tbl('improvementRequestComments')
    if (!commentsRef.value.some(cm => cm.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象のコメントが見つかりません' } }
    }
    commentsRef.value = commentsRef.value.map(cm => (cm.id === id ? { ...cm, archivedAt: archived ? nowJstIso() : null } : cm))
    commit()
    return { ok: true, id }
  }

  /** 要望 1 件ずつのステータス変更（open/resolved/dismissed。遷移自由 = 誤操作はいつでも戻せる = 原則9.5） */
  async function setRequestStatus(id: string, status: ImprovementRequestStatus): Promise<Result> {
    if (!IMPROVEMENT_REQUEST_STATUSES.includes(status)) {
      return { ok: false, error: { code: 'AKO-REQ-011', message: 'status が不正です（open / resolved / dismissed）' } }
    }
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/requests/${id}/status`, { body: { status } })
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const reqsRef = tbl('improvementRequests')
    if (!reqsRef.value.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' } }
    }
    reqsRef.value = reqsRef.value.map(r => (r.id === id ? { ...r, status } : r))
    commit()
    return { ok: true, id }
  }

  /**
   * 要望の編集（改修依頼 2026-08-18 で新設 → 2026-08-19 で本文以外の項目〔タグ・リンク・画像〕も編集可能に）。
   * 投稿者本人または管理権限者（API 側ガードと同一）。編集は全項目の上書きだが editedAt を記録して
   * 「編集済み」を明示する（再編集で戻せる = 原則9.5）。取消済みは編集不可（先に復元する）。
   * 集約済みは編集可（プロンプト再生成が現行本文を読む）。本文・タグ・リンク・画像は投稿時と同一の
   * shared 検証（improvementRequestEditFields）で正規化 = API とパリティ。
   */
  async function editRequest(
    id: string,
    // tags は UiChipSelect の string[] をそのまま受ける（shared 検証が allowlist 正規化する = 未知値は落とす）
    patch: { body: string; tags?: string[]; links?: string[]; images?: ImprovementRequestImage[] },
  ): Promise<Result & { persisted?: boolean }> {
    const parsed = improvementRequestEditFields(patch)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const fields = parsed.value
    if (isApi) {
      const res = await apiWrite<ImprovementRequest>(`/v1/improvements/requests/${id}/edit`, { body: fields })
      if (!res.ok) return res
      // 応答は画像の実体を含む（API は reqColsOf(true) で返す）。キャッシュへ上書きマージする（レビュー R1 MAJOR）:
      // マージしないと refresh() の prevImages 再注入が「削除された画像を復活」「追加した画像を取りこぼし」する
      // （一覧 GET は images:[] スタブのため）。削除/追加/保持の正しさはこの map 上書きだけで成立する。
      const row = res.data
      apiRequests.value = apiRequests.value.map(r => (r.id === id ? row : r))
      // 集約済み（itemId あり）は imagesLoadedFor（item 単位フラグ）へマークしない（レビュー R2 CRITICAL）:
      // このマークは「その item の全要望が画像込みでロード済み」を意味し、正当なセッタは全要望を取得する
      // loadRequestImages(itemId) だけ。1 件の編集応答で item 全体を loaded 詐称すると、item 画像ロードが
      // 失敗した窓で兄弟要望が images:[] スタブのまま loaded 扱いになり、その兄弟の編集で添付を無言全消しする。
      // 未集約は要望 id 単位フラグのため、この行の画像が実体込みでマージ済み = 自分だけロード済みマークで安全。
      if (!row.itemId) unclusteredImagesLoaded.add(row.id)
      // 再取得は管理権限者のみ（管理 GET は非管理者に 403。投稿者本人の編集〔送信直後の修正〕は
      // ローカル表示のみで完結する = submit が管理 GET を誤発火しないのと同じ配慮）。
      // マージ済みのため refresh の prevImages は編集後の画像を正しく引き継ぐ（削除は削除のまま）
      if (canManageImprovements.value) await refresh()
      return { ok: true, id }
    }
    const reqsRef = tbl('improvementRequests')
    const target = reqsRef.value.find(r => r.id === id)
    // 判定は共有の improvementEditError（API ルートと同一の順序・コード。単体テストで固定 = parity）
    const guard = improvementEditError(target, currentUser.value.id, canManageImprovements.value)
    if (guard) return { ok: false, error: guard }
    if (!target) return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' } } // 型ナローイング用（guard が先に返る）
    // 部分更新: fields に実在するキーのみ上書き（未指定の tags/links/images は現行値を保持 = API と同一）
    reqsRef.value = reqsRef.value.map(r => (r.id === id
      ? {
          ...r,
          body: fields.body,
          ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
          ...(fields.links !== undefined ? { links: fields.links } : {}),
          ...(fields.images !== undefined ? { images: fields.images } : {}),
          editedAt: nowJstIso(),
        }
      : r))
    // 記録系（原則2）の上書きは変更前の本文＋変更項目を監査ログへ残す（API の audit_logs と同じ = parity）。
    // 変更項目ラベルは shared 純関数で API と共有（原則3。文言・順序のズレを作らない）
    const logs = tbl('auditLogs')
    logs.value = [...logs.value, {
      id: nextId('auditLogs', 'aud'),
      actorId: currentUser.value.id,
      action: 'update',
      entity: 'improvement_requests',
      entityId: id,
      detail: `要望を編集（変更項目: ${improvementEditChangedLabel(fields)}／変更前本文: ${target.body}）`,
      at: nowJstIso(),
    }]
    // 永続化可否を返し UI が警告できるようにする（submit と同型 = localStorage 容量超過で編集が消える事故を黙認しない）
    const persisted = commit()
    return { ok: true, id, persisted }
  }

  async function setRequestArchived(id: string, archived: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/requests/${id}/${archived ? 'archive' : 'restore'}`, {})
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const reqsRef = tbl('improvementRequests')
    if (!reqsRef.value.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' } }
    }
    reqsRef.value = reqsRef.value.map(r => (r.id === id ? { ...r, archivedAt: archived ? nowJstIso() : null } : r))
    commit()
    return { ok: true, id }
  }

  // ---------- 時系列メモ（改修方針・保留/見送り理由。AI プロンプトに加味） ----------

  /** メモを追加（kind='note' 既定 / 'reject' = 「対応しない」理由）。改修方針の検討を時系列で残す */
  async function addNote(itemId: string, body: string, kind: ImprovementNoteKind = 'note'): Promise<Result> {
    const text = (body ?? '').trim()
    const msg = improvementNoteError(text)
    if (msg) return { ok: false, error: { code: 'AKO-REQ-008', message: msg } }
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/items/${itemId}/notes`, {
        body: { body: capCodePoints(text, IMPROVEMENT_NOTE_CAP), kind },
      })
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id: itemId } : res
    }
    const itemsRef = tbl('improvementItems')
    if (!itemsRef.value.some(it => it.id === itemId && !it.archivedAt)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象の改修単位が見つかりません' } }
    }
    const notesRef = tbl('improvementNotes')
    const id = nextId('improvementNotes', 'imnote')
    notesRef.value = [...notesRef.value, {
      id, itemId, memberId: currentUser.value.id, memberName: currentUser.value.name,
      body: capCodePoints(text, IMPROVEMENT_NOTE_CAP), kind, archivedAt: null, createdAt: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  /** メモの取消（論理削除）/ 復元（原則9.5） */
  async function setNoteArchived(id: string, archived: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/improvements/notes/${id}/${archived ? 'archive' : 'restore'}`, {})
      if (res.ok) await refresh()
      return res.ok ? { ok: true, id } : res
    }
    const notesRef = tbl('improvementNotes')
    if (!notesRef.value.some(n => n.id === id)) {
      return { ok: false, error: { code: 'AKO-REQ-002', message: '対象のメモが見つかりません' } }
    }
    notesRef.value = notesRef.value.map(n => (n.id === id ? { ...n, archivedAt: archived ? nowJstIso() : null } : n))
    commit()
    return { ok: true, id }
  }

  // ---------- 改修プロンプト出力（フィルター結果 → コーディング AI 向け） ----------

  async function buildPrompt(filter: ImprovementFilter): Promise<{ ok: true; prompt: string; count: number } | { ok: false; error: { code: string; message: string } }> {
    if (isApi) {
      try {
        const data = await apiFetch<{ prompt: string; count: number }>('/v1/improvements/prompt', {
          method: 'POST', body: { filter },
        })
        return { ok: true, prompt: data.prompt, count: data.count }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const matched = activeItems.value.filter(it => matchesImprovementFilter(it.status, filter))
    const promptItems: PromptItemInput[] = matched.map(it => ({
      title: it.title, summary: it.summary, detail: it.detail, status: it.status, pagePaths: it.pagePaths,
      // API /prompt は ORDER BY created_at で返すため mock も createdAt 昇順に揃える（時系列統合のパリティ = 原則6）
      requests: [...requestsForItem(it.id)]
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : 1)))
        .map(r => ({
          pageLabel: r.pageLabel, pagePath: r.pagePath, body: r.body,
          // 要望ステータス + 添付（リンクは列挙・画像は件数のみ）+ 受付箱のコメント（API /prompt と同じ内容 =
          // 両モード parity）。改修依頼 2026-08-19 第4弾: 要望とコメントを createdAt で時系列統合するため双方に時刻を渡す
          status: r.status, links: r.links ?? [], imageCount: (r.images ?? []).length,
          createdAt: r.createdAt,
          comments: commentsForRequest(r.id).map(cm => ({ body: cm.body, createdAt: cm.createdAt })),
        })),
      // 時系列メモも加味（古い順。notesForItem がソート済み）
      notes: notesForItem(it.id).map(n => ({ body: n.body, kind: n.kind })),
    }))
    return { ok: true, prompt: buildCodingPrompt(promptItems), count: promptItems.length }
  }

  return {
    // データ
    activeItems, archivedItems, unclusteredRequests, adoptedUnclustered, pendingRequests, allRequests,
    requestsForItem, notesForItem, commentsForRequest, commentCountByRequest, refresh, loadRequestImages, loadRequestImagesFor,
    imagesLoadedForRequest,
    // 操作
    submit, generate, setStatus, editItem, setItemArchived, setRequestArchived, setRequestStatus,
    setRequestAdoption, setRequestAdoptionBulk, unclusterRequest, editRequest, addRequestComment, setRequestCommentArchived,
    addNote, setNoteArchived, buildPrompt,
  }
}
