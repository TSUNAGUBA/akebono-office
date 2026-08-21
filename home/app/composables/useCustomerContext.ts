/**
 * 顧客コンテキスト（改修依頼 2026-08-20: トップ層メニュー「顧客コンテキスト」）
 * 顧客ごとの定性情報（ビジョン・経営課題・補足メモ・事業メモ〔2026-08-21 追加〕= 1社1行の設定系）と
 * 時系列メモ（記録系）、AI リサーチ（Web 調査 → 構築 → 反映 → 取消）を扱う。
 * - 検証は shared/domain/customer-context（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード:
 *   - モック = customerContexts / customerContextNotes コレクション。AI リサーチは shared の
 *     決定的ヒューリスティック（example.com のデモ候補。llm=false）。
 *   - API = /v1/customer-contexts（読み取りは CUSTOM_COLLECTION_ENDPOINTS の全量ハイドレーション・
 *     書込は本 composable の専用経路 = SoT 先行 → reload。原則6）。
 * - 反映の取消（原則9.5）: research ノートの payload.before から復元。ノートは archive せず
 *   payload.revertedAt を追記する（監査可能な取消）。メモの取消は論理取消（archivedAt）+ 復元。
 * - commit() の戻り値を必ず検査し、localStorage 容量超過等の保存失敗は AKO-CTX-090 として返す +
 *   メモリ上の変更をロールバックする（useActivityLogs の storageCommitError と同型。同関数はコード型が
 *   AKO-SAL/PTN に閉じているため import せず、同文言のローカル定数を使う）。
 */
import {
  CUSTOMER_CONTEXT_NOTE_CAP as NOTE_CAP,
  type CustomerContextInput,
  customerContextError, customerContextNoteError,
  type CustomerResearchCandidate, type CustomerResearchHints,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeCustomerContext,
} from '../../../shared/domain/customer-context'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type {
  Company, CustomerContext, CustomerContextNote, CustomerContextResearchSource, Result,
} from '~/types/domain'

export type { CustomerContextInput, CustomerResearchCandidate, CustomerResearchHints }

/** commit() 失敗（localStorage 容量超過等）の共通エラー（storageCommitError の AKO-CTX 版） */
const COMMIT_ERROR = {
  code: 'AKO-CTX-090',
  message: 'ブラウザの保存容量が不足していて保存できませんでした。設定の「デモデータをリセット」または不要なデータの削除をお試しください',
} as const

/** 表示順: 登録降順 → id 降順（API の ORDER BY と同一 = パリティ） */
function byCreatedDesc(a: CustomerContextNote, b: CustomerContextNote): number {
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** リサーチ系の応答（Result と同じ ok 分岐で拡張データを返す） */
type ResearchResult
  = { ok: true; candidates: CustomerResearchCandidate[]; llm: boolean }
    | { ok: false; error: { code: string; message: string } }
type BuildResult
  = { ok: true; proposal: CustomerContextInput; llm: boolean }
    | { ok: false; error: { code: string; message: string } }

export function useCustomerContext() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const ctxRows = tbl('customerContexts')
  const noteRows = tbl('customerContextNotes')

  function companyNameOf(companyId: string): string {
    return (tbl('companies').value as Company[]).find(c => c.id === companyId)?.name ?? companyId
  }

  /** 会社の定性情報（未登録は null =「登録」導線を出す） */
  function contextOf(companyId: string): CustomerContext | null {
    return (ctxRows.value as CustomerContext[]).find(r => r.companyId === companyId && r.active !== false) ?? null
  }

  /** 有効なメモ一覧（新しい順） */
  function notesOf(companyId: string): CustomerContextNote[] {
    return (noteRows.value as CustomerContextNote[])
      .filter(r => r.companyId === companyId && !r.archivedAt)
      .sort(byCreatedDesc)
  }

  /** 取消済みメモ（復元 UI 用） */
  function archivedNotesOf(companyId: string): CustomerContextNote[] {
    return (noteRows.value as CustomerContextNote[])
      .filter(r => r.companyId === companyId && !!r.archivedAt)
      .sort(byCreatedDesc)
  }

  /** モック: 定性情報の upsert（1社1行）。commit 検査 + 失敗ロールバック */
  function mockUpsertContext(companyId: string, values: CustomerContextInput): Result {
    const now = nowJstIso()
    const all = ctxRows.value as CustomerContext[]
    const prev = ctxRows.value
    const target = all.find(r => r.companyId === companyId)
    if (target) {
      ctxRows.value = all.map(r => r.companyId === companyId ? {
        ...r,
        ...values,
        updatedByMemberId: currentUser.value.id,
        updatedByName: currentUser.value.name,
        active: true,
        updatedAt: now,
      } : r)
      if (!commit()) {
        ctxRows.value = prev
        return { ok: false, error: COMMIT_ERROR }
      }
      return { ok: true, id: target.id }
    }
    const id = nextId('customerContexts', 'cctx')
    ctxRows.value = [...all, {
      id,
      companyId,
      ...values,
      updatedByMemberId: currentUser.value.id,
      updatedByName: currentUser.value.name,
      active: true,
      createdAt: now,
      updatedAt: now,
    } satisfies CustomerContext]
    if (!commit()) {
      ctxRows.value = prev
      return { ok: false, error: COMMIT_ERROR }
    }
    return { ok: true, id }
  }

  /** 定性情報の保存（設定系 = 全員が上書き更新可。全項目送信 = 実質全置換の upsert） */
  async function saveContext(companyId: string, input: CustomerContextInput): Promise<Result> {
    const n = normalizeCustomerContext(input)
    const message = customerContextError(n)
    if (message) return { ok: false, error: { code: 'AKO-CTX-001', message } }
    if (isApi) {
      const res = await apiWrite(`/v1/customer-contexts/${encodeURIComponent(companyId)}`, {
        method: 'PUT', body: n, reload: ['customerContexts'], idempotent: true,
      })
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id } : res
    }
    if (!(tbl('companies').value as Company[]).some(c => c.id === companyId)) {
      return { ok: false, error: { code: 'AKO-CTX-002', message: '顧客(会社)が見つかりません' } }
    }
    return mockUpsertContext(companyId, n)
  }

  /** メモの追記（記録系。kind='note'。記録者名スナップショット） */
  async function addNote(companyId: string, body: string): Promise<Result> {
    const capped = capCp(body.trim(), NOTE_CAP)
    const message = customerContextNoteError(capped)
    if (message) return { ok: false, error: { code: 'AKO-CTX-001', message } }
    if (isApi) {
      const res = await apiWrite(`/v1/customer-contexts/${encodeURIComponent(companyId)}/notes`, {
        body: { body: capped }, reload: ['customerContextNotes'],
      })
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id } : res
    }
    if (!(tbl('companies').value as Company[]).some(c => c.id === companyId)) {
      return { ok: false, error: { code: 'AKO-CTX-002', message: '顧客(会社)が見つかりません' } }
    }
    const prev = noteRows.value
    const id = nextId('customerContextNotes', 'cnote')
    noteRows.value = [...(noteRows.value as CustomerContextNote[]), {
      id,
      companyId,
      memberId: currentUser.value.id,
      memberName: currentUser.value.name,
      kind: 'note',
      body: capped,
      payload: null,
      archivedAt: null,
      createdAt: nowJstIso(),
    } satisfies CustomerContextNote]
    if (!commit()) {
      noteRows.value = prev
      return { ok: false, error: COMMIT_ERROR }
    }
    return { ok: true, id }
  }

  /** メモの取消/復元（論理取消 = archivedAt。全員可・冪等） */
  async function setNoteArchived(companyId: string, noteId: string, archived: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(
        `/v1/customer-contexts/${encodeURIComponent(companyId)}/notes/${encodeURIComponent(noteId)}/${archived ? 'archive' : 'restore'}`,
        { reload: ['customerContextNotes'], idempotent: true },
      )
      return res.ok ? { ok: true, id: noteId } : res
    }
    const all = noteRows.value as CustomerContextNote[]
    const target = all.find(r => r.id === noteId && r.companyId === companyId)
    if (!target) return { ok: false, error: { code: 'AKO-CTX-003', message: 'メモが見つかりません' } }
    // 状態不一致（二重取消等）は no-op（API の警告 no-op と同じ冪等挙動）
    if (!!target.archivedAt === archived) return { ok: true, id: noteId }
    const prev = noteRows.value
    noteRows.value = all.map(r => r.id === noteId ? { ...r, archivedAt: archived ? nowJstIso() : null } : r)
    if (!commit()) {
      noteRows.value = prev
      return { ok: false, error: COMMIT_ERROR }
    }
    return { ok: true, id: noteId }
  }

  const archiveNote = (companyId: string, noteId: string): Promise<Result> => setNoteArchived(companyId, noteId, true)
  const restoreNote = (companyId: string, noteId: string): Promise<Result> => setNoteArchived(companyId, noteId, false)

  // ---------- AI リサーチ（Web 調査 → 構築 → 反映 → 取消） ----------

  /** ① 調査: 候補リストの収集（API = generateGroundedText / モック = 決定的ヒューリスティックのデモ候補） */
  async function research(companyId: string, hints: CustomerResearchHints): Promise<ResearchResult> {
    if (isApi) {
      try {
        // Web 調査（グラウンディング）は最長 45 秒かかるためタイムアウトを個別延長する
        const data = await apiFetch<{ candidates: CustomerResearchCandidate[]; llm: boolean }>(
          `/v1/customer-contexts/${encodeURIComponent(companyId)}/research`,
          { method: 'POST', body: hints, timeoutMs: 60_000 })
        return { ok: true, candidates: data.candidates ?? [], llm: data.llm === true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    return { ok: true, candidates: heuristicResearchCandidates(companyNameOf(companyId), hints), llm: false }
  }

  /** ② 構築: 採用候補から定性情報の提案値を作る（反映はしない = 差分確認は画面の責務） */
  async function buildProposal(
    companyId: string, sources: CustomerContextResearchSource[],
  ): Promise<BuildResult> {
    if (isApi) {
      try {
        const data = await apiFetch<{ proposal: CustomerContextInput; llm: boolean }>(
          `/v1/customer-contexts/${encodeURIComponent(companyId)}/research/build`,
          { method: 'POST', body: { sources }, timeoutMs: 60_000 })
        return { ok: true, proposal: data.proposal, llm: data.llm === true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const current = contextOf(companyId)
    const proposal = heuristicContextBuild(companyNameOf(companyId), sources, {
      vision: current?.vision ?? '',
      challenges: current?.challenges ?? '',
      strategyNotes: current?.strategyNotes ?? '',
      businessNotes: current?.businessNotes ?? '',
    })
    return { ok: true, proposal, llm: false }
  }

  /**
   * ③ 反映: 定性情報の保存 + research ノートの自動追記（採用ソース + 反映前の値 = payload.before）。
   * モックは 1 回の commit にまとめ、失敗時は両コレクションをロールバックする（片肺の反映を作らない）
   */
  async function applyResearch(
    companyId: string, proposal: CustomerContextInput, sources: CustomerContextResearchSource[],
  ): Promise<Result> {
    const n = normalizeCustomerContext(proposal)
    const message = customerContextError(n)
    if (message) return { ok: false, error: { code: 'AKO-CTX-001', message } }
    if (sources.length === 0) {
      return { ok: false, error: { code: 'AKO-CTX-001', message: '採用する情報源を 1 件以上選択してください' } }
    }
    if (isApi) {
      const res = await apiWrite<{ id?: string }>(
        `/v1/customer-contexts/${encodeURIComponent(companyId)}/research/apply`,
        { body: { ...n, sources }, reload: ['customerContexts', 'customerContextNotes'] })
      return res.ok ? { ok: true, id: res.data?.id } : res
    }
    const cur = contextOf(companyId)
    const before = {
      vision: cur?.vision ?? '',
      challenges: cur?.challenges ?? '',
      strategyNotes: cur?.strategyNotes ?? '',
      businessNotes: cur?.businessNotes ?? '',
    }
    const prevCtx = ctxRows.value
    const prevNotes = noteRows.value
    const now = nowJstIso()
    // 定性情報の upsert（commit は最後に 1 回 = ノートと合わせて原子的に永続化）
    const all = ctxRows.value as CustomerContext[]
    if (cur) {
      ctxRows.value = all.map(r => r.companyId === companyId ? {
        ...r, ...n, updatedByMemberId: currentUser.value.id, updatedByName: currentUser.value.name, updatedAt: now,
      } : r)
    } else {
      ctxRows.value = [...all, {
        id: nextId('customerContexts', 'cctx'),
        companyId,
        ...n,
        updatedByMemberId: currentUser.value.id,
        updatedByName: currentUser.value.name,
        active: true,
        createdAt: now,
        updatedAt: now,
      } satisfies CustomerContext]
    }
    const noteId = nextId('customerContextNotes', 'cnote')
    noteRows.value = [...(noteRows.value as CustomerContextNote[]), {
      id: noteId,
      companyId,
      memberId: currentUser.value.id,
      memberName: currentUser.value.name,
      kind: 'research',
      body: `AI リサーチの結果を反映（採用 ${sources.length} 件: ${sources.map(s => s.title).join(' / ')}）`,
      payload: { sources, before },
      archivedAt: null,
      createdAt: now,
    } satisfies CustomerContextNote]
    if (!commit()) {
      ctxRows.value = prevCtx
      noteRows.value = prevNotes
      return { ok: false, error: COMMIT_ERROR }
    }
    return { ok: true, id: noteId }
  }

  /**
   * ④ 反映の取消（原則9.5）: research ノートの payload.before から定性情報を復元する。
   * ノートは archive せず payload.revertedAt を追記する（監査可能な取消）。二重取消は no-op（冪等）
   */
  async function revertResearch(companyId: string, noteId: string): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(
        `/v1/customer-contexts/${encodeURIComponent(companyId)}/research/${encodeURIComponent(noteId)}/revert`,
        { reload: ['customerContexts', 'customerContextNotes'], idempotent: true })
      return res.ok ? { ok: true, id: noteId } : res
    }
    const note = (noteRows.value as CustomerContextNote[]).find(r => r.id === noteId && r.companyId === companyId)
    if (!note) return { ok: false, error: { code: 'AKO-CTX-003', message: 'メモが見つかりません' } }
    if (note.kind !== 'research' || !note.payload?.before) {
      return { ok: false, error: { code: 'AKO-CTX-004', message: 'このメモには復元できる反映前の情報がありません' } }
    }
    if (note.payload.revertedAt) return { ok: true, id: noteId } // すでに取消済み = no-op（冪等）
    const before = normalizeCustomerContext({
      vision: note.payload.before.vision ?? '',
      challenges: note.payload.before.challenges ?? '',
      strategyNotes: note.payload.before.strategyNotes ?? '',
      // 事業メモ（2026-08-21 追加）が無い旧スナップショットの復元は現在値を保持（原則7 = API と同一判定）
      businessNotes: note.payload.before.businessNotes === undefined
        ? (contextOf(companyId)?.businessNotes ?? '')
        : note.payload.before.businessNotes,
    })
    const prevCtx = ctxRows.value
    const prevNotes = noteRows.value
    const now = nowJstIso()
    const all = ctxRows.value as CustomerContext[]
    // 反映前が全項目空（新規登録の反映だった）でも「空へ戻す」= 復元として行を保持する（API と同じ設計判断）
    ctxRows.value = all.some(r => r.companyId === companyId)
      ? all.map(r => r.companyId === companyId ? {
          ...r, ...before, updatedByMemberId: currentUser.value.id, updatedByName: currentUser.value.name, updatedAt: now,
        } : r)
      : all
    noteRows.value = (noteRows.value as CustomerContextNote[]).map(r => r.id === noteId ? {
      ...r, payload: { ...(r.payload ?? {}), revertedAt: now },
    } : r)
    if (!commit()) {
      ctxRows.value = prevCtx
      noteRows.value = prevNotes
      return { ok: false, error: COMMIT_ERROR }
    }
    return { ok: true, id: noteId }
  }

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) {
      await Promise.all([
        loadApiCollection('customerContexts', true),
        loadApiCollection('customerContextNotes', true),
      ])
    }
  }

  return {
    contextOf, notesOf, archivedNotesOf,
    saveContext, addNote, archiveNote, restoreNote,
    research, buildProposal, applyResearch, revertResearch,
    refresh,
  }
}
