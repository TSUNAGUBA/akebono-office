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
  canTransition,
  capCodePoints,
  heuristicClusterRequests,
  IMPROVEMENT_BODY_CAP,
  IMPROVEMENT_DETAIL_CAP,
  IMPROVEMENT_PAGE_LABEL_CAP,
  IMPROVEMENT_PAGE_PATH_CAP,
  IMPROVEMENT_SUMMARY_CAP,
  IMPROVEMENT_TITLE_CAP,
  type ImprovementFilter,
  type ImprovementItem,
  type ImprovementRequest,
  type ImprovementStatus,
  improvementBodyError,
  improvementPlanError,
  matchesImprovementFilter,
  type PromptItemInput,
} from '~/types/improvement'

export interface GenerateResult {
  ok: boolean
  error?: { code: string; message: string }
  created?: number
  appended?: number
  clustered?: number
  llm?: boolean
}

export function useImprovements() {
  const { tbl, commit, nextId } = useMockDb()
  const isApi = useApiMode()
  const { currentUser } = useCurrentUser()

  // API モードの管理データ（includeArchived で取消済みも取得。refresh で更新）。
  // mock モードは tbl（localStorage）をそのまま参照する（リアクティブ）。
  const apiItems = ref<ImprovementItem[]>([])
  const apiRequests = ref<ImprovementRequest[]>([])

  // isApi 分岐で tbl を触るのは mock モードのみ = API モードで管理 GET を誤発火しない
  const allItems = computed<ImprovementItem[]>(() => (isApi ? apiItems.value : tbl('improvementItems').value))
  const allRequests = computed<ImprovementRequest[]>(() => (isApi ? apiRequests.value : tbl('improvementRequests').value))

  /** 有効な改修単位（取消済みを除く）。ステータスは含めall */
  const activeItems = computed(() => allItems.value.filter(it => !it.archivedAt))
  /** 取消済みの改修単位 */
  const archivedItems = computed(() => allItems.value.filter(it => it.archivedAt))
  /** 未集約かつ有効な生要望（「AI で集約」対象の件数バッジ等に使う） */
  const unclusteredRequests = computed(() => allRequests.value.filter(r => !r.itemId && !r.archivedAt))

  /** ある改修単位の元要望（有効なもの） */
  function requestsForItem(itemId: string): ImprovementRequest[] {
    return allRequests.value.filter(r => r.itemId === itemId && !r.archivedAt)
  }

  // ---------- 投稿（各ページから。全員可） ----------

  async function submit(input: { body: string; pagePath?: string; pageLabel?: string }): Promise<Result> {
    const body = (input.body ?? '').trim()
    const msg = improvementBodyError(body)
    if (msg) return { ok: false, error: { code: 'AKO-REQ-001', message: msg } }
    const pagePath = capCodePoints((input.pagePath ?? '').trim(), IMPROVEMENT_PAGE_PATH_CAP)
    const pageLabel = capCodePoints((input.pageLabel ?? '').trim(), IMPROVEMENT_PAGE_LABEL_CAP)
    if (isApi) {
      // 管理 GET は権限者のみのため reload しない（投稿者は一覧を見ない）
      const res = await apiWrite<{ id: string }>('/v1/improvements/requests', {
        body: { body: capCodePoints(body, IMPROVEMENT_BODY_CAP), pagePath, pageLabel },
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
      body: capCodePoints(body, IMPROVEMENT_BODY_CAP),
      itemId: null,
      archivedAt: null,
      createdAt: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  // ---------- 管理データのロード（管理ページから） ----------

  /** 管理データを取得（API モードのみ実フェッチ。mock はライブ computed のため no-op） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    const [items, reqs] = await Promise.all([
      apiFetch<ImprovementItem[]>('/v1/improvements/items', { query: { includeArchived: '1' } }).catch(() => [] as ImprovementItem[]),
      apiFetch<ImprovementRequest[]>('/v1/improvements/requests', { query: { includeArchived: '1' } }).catch(() => [] as ImprovementRequest[]),
    ])
    apiItems.value = items
    apiRequests.value = reqs
  }

  // ---------- AI 集約（生成・再生成） ----------

  /** mock モードの決定的集約（API の Vertex→ヒューリスティックのフォールバックと同一ロジック） */
  function mockGenerate(): GenerateResult {
    const reqsRef = tbl('improvementRequests')
    const itemsRef = tbl('improvementItems')
    const unclustered = reqsRef.value
      .filter(r => !r.itemId && !r.archivedAt)
      .map(r => ({ id: r.id, pagePath: r.pagePath, pageLabel: r.pageLabel, body: r.body }))
    if (unclustered.length === 0) return { ok: true, created: 0, appended: 0, clustered: 0, llm: false }
    const openItems = itemsRef.value
      .filter(it => it.status === 'triage' && !it.archivedAt)
      .map(it => ({ id: it.id, status: it.status, pagePaths: it.pagePaths }))
    const plan = heuristicClusterRequests(openItems, unclustered)
    const now = nowJstIso()
    const reqPatch = new Map<string, string>()
    const newItems: ImprovementItem[] = []
    for (const cr of plan.creates) {
      const id = nextId('improvementItems', 'imp')
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
    reqsRef.value = reqsRef.value.map(r => (reqPatch.has(r.id) ? { ...r, itemId: reqPatch.get(r.id)! } : r))
    commit()
    return { ok: true, created: plan.creates.length, appended: plan.appends.length, clustered: reqPatch.size, llm: false }
  }

  async function generate(): Promise<GenerateResult> {
    if (isApi) {
      const res = await apiWrite<{ created: number; appended: number; clustered: number; llm: boolean }>(
        '/v1/improvements/generate', {})
      if (!res.ok) return { ok: false, error: res.error }
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
      requests: requestsForItem(it.id).map(r => ({ pageLabel: r.pageLabel, pagePath: r.pagePath, body: r.body })),
    }))
    return { ok: true, prompt: buildCodingPrompt(promptItems), count: promptItems.length }
  }

  return {
    // データ
    activeItems, archivedItems, unclusteredRequests, requestsForItem, refresh,
    // 操作
    submit, generate, setStatus, editItem, setItemArchived, setRequestArchived, buildPrompt,
  }
}
