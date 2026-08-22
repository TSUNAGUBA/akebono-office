/**
 * インサイト・アクション・分析サイクルの記録ストア（FI-03/04/05。改善要望 2026-08-22 で本実装）。
 *
 * SoT（requirements §5 の宣言どおりモック境界を解消）:
 * - API モード: サーバー（/v1/intelligence/* = intel_* テーブル。メンバー単位の所有）。
 *   分析生成もサーバー実行（スナップショット収集 + Vertex AI → 決定的ヒューリスティックへ
 *   フォールバック）。旧ユーザー別 localStorage（`aki.store.v1.<memberId>`）の記録は、
 *   サーバー側ストアが空のとき初回ロードで自動移行する（原則1: 手動の書き写しをさせない /
 *   原則2: 再実行しても重複しない = サーバー側ガード。移行後もローカルはバックアップとして残し
 *   migratedAt を刻んで再移行を抑止する = 唯一の永続コピーを消さない）。
 * - モックモード: useMockDb（デモシード + localStorage。日付跨ぎで再シード = デモ仕様）。
 *   分析は共有エンジン（shared/domain/intelligence）をクライアントで実行する（API と同一関数 = パリティ）。
 *
 * 記録系の保護:
 * - サイクルは追記のみ（編集 API を公開しない）
 * - インサイト・アクションはアーカイブ（論理削除）+ 復元で取消可能（原則9.5）
 */
import type { Ref } from 'vue'
import type { IntelAction, IntelCycle, IntelInsight, InsightTheme } from '~/types/intelligence'
import type { EngineData } from '~/utils/insight-engine'
import { generateInsightDraft } from '~/utils/insight-engine'
import { INTEL_ACTION_STATUS_FLOW } from '../../../shared/domain/intelligence'
import type { Result } from '~/types/domain'

/** 旧ローカル記録（バックアップとして残置。migratedAt 付与後は再移行しない） */
const LEGACY_STORAGE_KEY_BASE = 'aki.store.v1'

interface LegacyStore {
  version: number
  insights: IntelInsight[]
  actions: IntelAction[]
  cycles: IntelCycle[]
  /** サーバーへ移行済みの時刻（本実装 2026-08-22 で付与。以後は取込しない） */
  migratedAt?: string
}

// ---------- API モードのサーバーストアキャッシュ（モジュールスコープ単一） ----------

const apiInsights = ref<IntelInsight[]>([])
const apiActions = ref<IntelAction[]>([])
const apiCycles = ref<IntelCycle[]>([])
const storeLoading = ref(false)

function legacyKeyFor(memberId: string): string {
  return `${LEGACY_STORAGE_KEY_BASE}.${memberId}`
}

function readLegacy(memberId: string): LegacyStore | null {
  if (!import.meta.client) return null
  try {
    const raw = localStorage.getItem(legacyKeyFor(memberId))
    if (!raw) return null
    return JSON.parse(raw) as LegacyStore
  } catch {
    return null
  }
}

function markLegacyMigrated(memberId: string, store: LegacyStore): void {
  try {
    localStorage.setItem(legacyKeyFor(memberId), JSON.stringify({ ...store, migratedAt: nowJstIso() }))
  } catch {
    // 刻めなくてもサーバー側ガード（既存記録ありは取込スキップ）が重複を防ぐ（原則2）
  }
}

async function fetchServerStore(): Promise<void> {
  storeLoading.value = true
  try {
    const data = await apiFetch<{ insights: IntelInsight[]; actions: IntelAction[]; cycles: IntelCycle[] }>(
      '/v1/intelligence/store')
    apiInsights.value = data.insights
    apiActions.value = data.actions
    apiCycles.value = data.cycles
  } finally {
    storeLoading.value = false
  }
}

/**
 * サーバーストアのロード + 旧ローカル記録の自動移行。
 * 移行条件: サーバーが空 / ローカルに記録あり / migratedAt 未付与。取込後に取り直して反映する。
 */
async function loadServerStore(notify?: (message: string) => void, force = false): Promise<void> {
  await apiLoadOnce('intel:store', async () => {
    await fetchServerStore()
    const uid = useApiMe().value?.id
    if (!uid) return
    const serverEmpty = apiInsights.value.length === 0 && apiActions.value.length === 0 && apiCycles.value.length === 0
    const legacy = readLegacy(uid)
    const hasLegacy = !!legacy && !legacy.migratedAt
      && ((legacy.insights?.length ?? 0) + (legacy.actions?.length ?? 0) + (legacy.cycles?.length ?? 0)) > 0
    if (!serverEmpty || !hasLegacy || !legacy) return
    try {
      const res = await apiFetch<{ imported: number }>('/v1/intelligence/import', {
        method: 'POST',
        body: { insights: legacy.insights ?? [], actions: legacy.actions ?? [], cycles: legacy.cycles ?? [] },
      })
      markLegacyMigrated(uid, legacy)
      if (res.imported > 0) {
        await fetchServerStore()
        notify?.(`このブラウザに保存されていた記録 ${res.imported} 件をサーバーへ移行しました（今後は端末間で同期されます）`)
      }
    } catch {
      // 移行失敗は非ブロッキング（原則4）。次回ロードで再試行される（migratedAt を刻んでいないため）
    }
  }, force)
}

onApiReset(() => {
  apiInsights.value = []
  apiActions.value = []
  apiCycles.value = []
  if (useApiMe().value) void loadServerStore()
})

/** prefix-#### 形式の次 ID（useMockDb.nextId と同一規則。モックモード用） */
function nextIdOf(rows: { id: string }[], prefix: string): string {
  let max = 0
  for (const r of rows) {
    if (r.id.startsWith(prefix)) {
      const n = Number(r.id.slice(prefix.length).replace(/^-/, ''))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

export interface NewActionInput {
  insightId: string | null
  proposalId: string | null
  theme: IntelAction['theme']
  targetId: string | null
  targetName: string
  title: string
  description: string
  dueDate: string | null
}

/** 生成の入力（テーマ + 対象。management は targetId 不要） */
export interface GenerateInput {
  theme: InsightTheme
  targetId: string | null
}

/** ローカル記録ストアの想定エラー（N-3: フロント発のエラーは AKI-* 体系） */
const ERR_SAVE_FAILED: Result = {
  ok: false,
  error: { code: 'AKI-STO-001', message: '保存に失敗しました（ブラウザの保存領域を確認してください）' },
}
const ERR_NOT_FOUND: Result = {
  ok: false,
  error: { code: 'AKI-STO-002', message: '対象が見つかりません' },
}

export function useIntelStore() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { show } = useToast()
  const isApi = useApiMode()
  if (isApi && useApiMe().value) {
    void loadServerStore(message => show(message, 'ok'))
  }

  const insights = isApi ? (apiInsights as Ref<IntelInsight[]>) : tbl('insights')
  const actions = isApi ? (apiActions as Ref<IntelAction[]>) : tbl('actions')
  const cycles = isApi ? (apiCycles as Ref<IntelCycle[]>) : tbl('cycles')

  /** API モードのサーバー書込 → ストア再取得（SoT 書込が先・キャッシュ反映が後 = 原則6） */
  async function apiCall(path: string, body?: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<Result> {
    try {
      const data = await apiFetch<{ id?: string }>(path, { method, body })
      await fetchServerStore()
      return { ok: true, id: data?.id }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  function save(): boolean {
    return commit()
  }

  // ---------- 分析の実行（API = サーバー生成 / モック = 共有エンジンをクライアント実行） ----------

  /**
   * 分析を実行してインサイト + サイクルを記録する。
   * - API モード: POST /v1/intelligence/generate（サーバーがスナップショット収集 + Vertex AI →
   *   決定的ヒューリスティックへフォールバック。llm フラグ付きで保存）
   * - モックモード: useIntelligenceData のデータで共有エンジンを実行し、モック DB へ記録
   */
  async function generate(
    input: GenerateInput,
    mockData: () => EngineData,
  ): Promise<Result & { feedbackConsidered?: number }> {
    if (isApi) {
      try {
        const data = await apiFetch<{ insight: IntelInsight }>('/v1/intelligence/generate', {
          method: 'POST', body: { theme: input.theme, targetId: input.targetId },
        })
        await fetchServerStore()
        return { ok: true, id: data.insight.id, feedbackConsidered: data.insight.feedbackConsidered.length }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const draft = generateInsightDraft(mockData(), {
      theme: input.theme,
      targetId: input.theme === 'management' ? null : input.targetId,
      today: todayJst(),
      pastActions: actions.value.filter(a => a.active),
    })
    if (!draft.ok) return { ok: false, error: draft.error }
    const res = recordGenerationMock({
      theme: input.theme,
      targetId: input.theme === 'management' ? null : input.targetId,
      targetName: draft.targetName,
      title: draft.title,
      summary: draft.summary,
      findings: draft.findings,
      evidence: draft.evidence,
      proposals: draft.proposals,
      confidence: draft.confidence,
      feedbackConsidered: draft.feedbackConsidered,
    })
    return res.ok ? { ...res, feedbackConsidered: draft.feedbackConsidered.length } : res
  }

  /** モックモードの生成記録（サイクル追記 → インサイト追加。1 生成 = 1 サイクル + 1 インサイト） */
  function recordGenerationMock(input: {
    theme: IntelInsight['theme']
    targetId: string | null
    targetName: string
    title: string
    summary: string
    findings: string[]
    evidence: IntelInsight['evidence']
    proposals: { title: string; description: string; priority: 'high' | 'mid' | 'low' }[]
    confidence: IntelInsight['confidence']
    feedbackConsidered: IntelInsight['feedbackConsidered']
  }): Result & { insightId?: string } {
    try {
      const cycleId = nextId('cycles', 'cy')
      const insightId = nextId('insights', 'ins')
      const at = nowJstIso()
      const proposals = input.proposals.map((p, i) => ({ ...p, id: `${insightId}-p${i + 1}` }))
      cycles.value = [...cycles.value, {
        id: cycleId,
        theme: input.theme,
        targetId: input.targetId,
        targetName: input.targetName,
        at,
        inputSnapshot: input.evidence,
        feedbackConsidered: input.feedbackConsidered,
        insightIds: [insightId],
        createdBy: currentUser.value.id,
        active: true,
      }]
      insights.value = [...insights.value, {
        id: insightId,
        cycleId,
        theme: input.theme,
        targetId: input.targetId,
        targetName: input.targetName,
        title: input.title,
        summary: input.summary,
        findings: input.findings,
        evidence: input.evidence,
        proposals,
        confidence: input.confidence,
        feedbackConsidered: input.feedbackConsidered,
        createdAt: at,
        createdBy: currentUser.value.id,
        active: true,
      }]
      if (!save()) return ERR_SAVE_FAILED
      return { ok: true, id: insightId, insightId }
    } catch {
      return { ok: false, error: { code: 'AKI-STO-999', message: '記録に失敗しました' } }
    }
  }

  /** インサイトのアーカイブ（論理削除・冪等）/ 復元（原則9.5） */
  async function setInsightActive(id: string, active: boolean): Promise<Result> {
    if (isApi) return apiCall(`/v1/intelligence/insights/${id}/${active ? 'restore' : 'archive'}`)
    if (!insights.value.some(i => i.id === id)) return ERR_NOT_FOUND
    insights.value = insights.value.map(i => (i.id === id ? { ...i, active } : i))
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  // ---------- アクション（登録・状態・結果・フィードバック） ----------

  async function addAction(input: NewActionInput): Promise<Result> {
    const title = input.title.trim()
    if (!title) return { ok: false, error: { code: 'AKI-ACT-001', message: 'タイトルを入力してください' } }
    if (isApi) {
      return apiCall('/v1/intelligence/actions', {
        insightId: input.insightId,
        proposalId: input.proposalId,
        theme: input.theme,
        targetId: input.targetId,
        targetName: input.targetName,
        title,
        description: input.description.trim(),
        dueDate: input.dueDate,
      })
    }
    const id = nextIdOf(actions.value, 'act')
    const at = nowJstIso()
    actions.value = [...actions.value, {
      id,
      insightId: input.insightId,
      proposalId: input.proposalId,
      theme: input.theme,
      targetId: input.targetId,
      targetName: input.targetName,
      title,
      description: input.description.trim(),
      status: 'planned',
      dueDate: input.dueDate,
      ownerId: currentUser.value.id,
      result: '',
      feedbackRating: null,
      feedbackNote: '',
      feedbackNext: '',
      createdAt: at,
      updatedAt: at,
      active: true,
    }]
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** 基本情報の編集（タイトル・説明・期日。取消 = 再編集で上書き可能） */
  async function updateAction(id: string, patch: { title?: string; description?: string; dueDate?: string | null }): Promise<Result> {
    if (patch.title !== undefined && !patch.title.trim()) {
      return { ok: false, error: { code: 'AKI-ACT-001', message: 'タイトルを入力してください' } }
    }
    if (isApi) return apiCall(`/v1/intelligence/actions/${id}`, patch, 'PATCH')
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => a.id === id
      ? {
          ...a,
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
          ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
          updatedAt: nowJstIso(),
        }
      : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  async function transitionAction(id: string, next: IntelAction['status']): Promise<Result> {
    if (isApi) return apiCall(`/v1/intelligence/actions/${id}/transition`, { status: next })
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    if (!INTEL_ACTION_STATUS_FLOW[target.status].includes(next)) {
      return { ok: false, error: { code: 'AKI-ACT-002', message: `「${target.status}」から「${next}」へは変更できません` } }
    }
    actions.value = actions.value.map(a => a.id === id ? { ...a, status: next, updatedAt: nowJstIso() } : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** 結果の記録（実施内容・結果。完了時に記入。再記録 = 上書きで取消可能） */
  async function recordResult(id: string, result: string): Promise<Result> {
    if (isApi) return apiCall(`/v1/intelligence/actions/${id}/result`, { result: result.trim() })
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => a.id === id ? { ...a, result: result.trim(), updatedAt: nowJstIso() } : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** フィードバックの記録（5 段階 + コメント。次サイクルの分析に反映される = FI-05） */
  async function recordFeedback(id: string, rating: number, note: string, next: string): Promise<Result> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: { code: 'AKI-ACT-003', message: '評価は 1〜5 で入力してください' } }
    }
    if (isApi) return apiCall(`/v1/intelligence/actions/${id}/feedback`, { rating, note: note.trim(), next: next.trim() })
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => a.id === id
      ? { ...a, feedbackRating: rating, feedbackNote: note.trim(), feedbackNext: next.trim(), updatedAt: nowJstIso() }
      : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** アクションのアーカイブ（論理削除・冪等）/ 復元（原則9.5） */
  async function setActionActive(id: string, active: boolean): Promise<Result> {
    if (isApi) return apiCall(`/v1/intelligence/actions/${id}/${active ? 'restore' : 'archive'}`)
    if (!actions.value.some(a => a.id === id)) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => (a.id === id ? { ...a, active } : a))
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  return {
    insights, actions, cycles, storeLoading,
    generate, setInsightActive,
    addAction, updateAction, transitionAction, recordResult, recordFeedback, setActionActive,
  }
}
