/**
 * インサイト・アクション・分析サイクルの記録ストア（FI-03/04/05）。
 *
 * 【モック境界の宣言】これらのデータの SoT は現状フロントエンド:
 * - モックモード: useMockDb（デモシード + localStorage。日付跨ぎで再シード = デモ仕様）
 * - API モード: ユーザー別の localStorage（`aki.store.v1.<memberId>`）。**再シード・日次リセットなし**
 *   （利用者の記録を保護 = 原則2）。キーを memberId で名前空間化し、同一端末で別アカウントが
 *   ログインしても他ユーザーの記録が見えない（R1 監査指摘 MAJOR-1。ログアウトでは消さない =
 *   唯一の永続コピーを保護しつつ、次のログインで本人の記録だけを読み込む）。
 *   端末間同期されない制約は各画面に明示する。共通 API 本実装時にサーバー側 CRUD へ移行する（requirements §5）。
 *
 * 記録系の保護:
 * - サイクルは追記のみ（編集 API を公開しない）
 * - インサイト・アクションはアーカイブ（論理削除）+ 復元で取消可能（原則9.5）
 * - STORE_VERSION を上げる際は旧バージョンの読み捨てではなく**移行処理を実装すること**
 *   （現実装はバージョン不一致を空扱いにするため、無移行での引き上げは記録喪失になる = 原則2。R1 #17）
 */
import type { Ref } from 'vue'
import type { IntelAction, IntelCycle, IntelInsight } from '~/types/intelligence'
import type { Result } from '~/types/domain'

const STORAGE_KEY_BASE = 'aki.store.v1'
const STORE_VERSION = 1

interface PersistedStore {
  version: number
  insights: IntelInsight[]
  actions: IntelAction[]
  cycles: IntelCycle[]
}

// ---------- API モードの永続ストア（モジュールスコープ単一・ユーザー別キー） ----------

const apiInsights = ref<IntelInsight[]>([])
const apiActions = ref<IntelAction[]>([])
const apiCycles = ref<IntelCycle[]>([])
/** 現在ロード済みの memberId（null = 未ロード。persist はこのユーザーのキーへのみ書く） */
let loadedForUser: string | null = null

function storageKeyFor(memberId: string): string {
  return `${STORAGE_KEY_BASE}.${memberId}`
}

function clearApiRefs(): void {
  apiInsights.value = []
  apiActions.value = []
  apiCycles.value = []
  loadedForUser = null
}

/** 指定ユーザーの記録をロードする（ロード済みなら no-op。ユーザー切替時は読み替え） */
function ensureApiStore(memberId: string): void {
  if (loadedForUser === memberId || !import.meta.client) return
  clearApiRefs()
  loadedForUser = memberId
  try {
    const raw = localStorage.getItem(storageKeyFor(memberId))
    if (!raw) return
    const parsed = JSON.parse(raw) as PersistedStore
    if (parsed.version === STORE_VERSION) {
      apiInsights.value = parsed.insights ?? []
      apiActions.value = parsed.actions ?? []
      apiCycles.value = parsed.cycles ?? []
    }
  } catch {
    // 壊れた保存値は空から開始（記録系のため上書き保存は次回操作まで行わない）
  }
}

function persistApiStore(): boolean {
  if (!import.meta.client) return true
  if (!loadedForUser) return false // 未認証（ユーザー未確定）の書込は保存先がないため失敗扱い
  try {
    const payload: PersistedStore = {
      version: STORE_VERSION,
      insights: apiInsights.value,
      actions: apiActions.value,
      cycles: apiCycles.value,
    }
    localStorage.setItem(storageKeyFor(loadedForUser), JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

// ログイン確立・切替・ログアウトでユーザーのストアを読み替える（フックはモジュールロード時に 1 回だけ登録）
onApiReset(() => {
  const uid = useApiMe().value?.id
  if (uid) ensureApiStore(uid)
  else clearApiRefs()
})

/** prefix-#### 形式の次 ID（useMockDb.nextId と同一規則） */
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
  const isApi = useApiMode()
  if (isApi) {
    const uid = useApiMe().value?.id
    if (uid) ensureApiStore(uid)
  }

  const insights = isApi ? (apiInsights as Ref<IntelInsight[]>) : tbl('insights')
  const actions = isApi ? (apiActions as Ref<IntelAction[]>) : tbl('actions')
  const cycles = isApi ? (apiCycles as Ref<IntelCycle[]>) : tbl('cycles')

  /**
   * 書込を確定する（モック = mockdb commit / API モード = ユーザー別ストア保存）。失敗 = false。
   * API モードで保存に失敗した場合はメモリ上の変異を最終保存状態へ巻き戻す
   * （エラートーストと画面表示を一致させ、幻の行が残り続けない = R2 監査 NIT-3。
   *  モックモードのデモ DB は Home と同様に巻き戻さない = デモ限定の既存パターン）
   */
  function save(): boolean {
    if (!isApi) return commit()
    if (persistApiStore()) return true
    const uid = loadedForUser
    clearApiRefs()
    if (uid) ensureApiStore(uid)
    return false
  }

  function newId(collection: 'insights' | 'actions' | 'cycles', prefix: string): string {
    if (isApi) {
      const rows = collection === 'insights' ? apiInsights.value : collection === 'actions' ? apiActions.value : apiCycles.value
      return nextIdOf(rows, prefix)
    }
    return nextId(collection, prefix)
  }

  // ---------- インサイト + サイクル（生成の記録） ----------

  /**
   * 生成結果を記録する（サイクル追記 → インサイト追加。1 生成 = 1 サイクル + 1 インサイト）。
   * サイクルは追記のみの記録系（原則2: 再実行しても過去サイクルは巻き戻らない）。
   */
  function recordGeneration(input: {
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
      const cycleId = newId('cycles', 'cy')
      const insightId = newId('insights', 'ins')
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
  function setInsightActive(id: string, active: boolean): Result {
    if (!insights.value.some(i => i.id === id)) return ERR_NOT_FOUND
    insights.value = insights.value.map(i => (i.id === id ? { ...i, active } : i))
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  // ---------- アクション（登録・状態・結果・フィードバック） ----------

  function addAction(input: NewActionInput): Result {
    const title = input.title.trim()
    if (!title) return { ok: false, error: { code: 'AKI-ACT-001', message: 'タイトルを入力してください' } }
    const id = newId('actions', 'act')
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
  function updateAction(id: string, patch: { title?: string; description?: string; dueDate?: string | null }): Result {
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    if (patch.title !== undefined && !patch.title.trim()) {
      return { ok: false, error: { code: 'AKI-ACT-001', message: 'タイトルを入力してください' } }
    }
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

  const STATUS_FLOW: Record<IntelAction['status'], IntelAction['status'][]> = {
    planned: ['in_progress', 'cancelled'],
    in_progress: ['done', 'planned', 'cancelled'],
    done: ['in_progress'], // 完了の取消（差し戻し）を許す = 原則9.5
    cancelled: ['planned'], // 中止の取消
  }

  function transitionAction(id: string, next: IntelAction['status']): Result {
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    if (!STATUS_FLOW[target.status].includes(next)) {
      return { ok: false, error: { code: 'AKI-ACT-002', message: `「${target.status}」から「${next}」へは変更できません` } }
    }
    actions.value = actions.value.map(a => a.id === id ? { ...a, status: next, updatedAt: nowJstIso() } : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** 結果の記録（実施内容・結果。完了時に記入。再記録 = 上書きで取消可能） */
  function recordResult(id: string, result: string): Result {
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => a.id === id ? { ...a, result: result.trim(), updatedAt: nowJstIso() } : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** フィードバックの記録（5 段階 + コメント。次サイクルの分析に反映される = FI-05） */
  function recordFeedback(id: string, rating: number, note: string, next: string): Result {
    const target = actions.value.find(a => a.id === id)
    if (!target) return ERR_NOT_FOUND
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, error: { code: 'AKI-ACT-003', message: '評価は 1〜5 で入力してください' } }
    }
    actions.value = actions.value.map(a => a.id === id
      ? { ...a, feedbackRating: rating, feedbackNote: note.trim(), feedbackNext: next.trim(), updatedAt: nowJstIso() }
      : a)
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  /** アクションのアーカイブ（論理削除・冪等）/ 復元（原則9.5） */
  function setActionActive(id: string, active: boolean): Result {
    if (!actions.value.some(a => a.id === id)) return ERR_NOT_FOUND
    actions.value = actions.value.map(a => (a.id === id ? { ...a, active } : a))
    if (!save()) return ERR_SAVE_FAILED
    return { ok: true, id }
  }

  return {
    insights, actions, cycles,
    recordGeneration, setInsightActive,
    addAction, updateAction, transitionAction, recordResult, recordFeedback, setActionActive,
  }
}
