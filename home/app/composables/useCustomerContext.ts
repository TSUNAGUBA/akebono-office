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
  cleanResearchSources,
  type CustomerContextInput,
  type CustomerContextBuildProposal,
  customerContextError, customerContextNoteError,
  type CustomerResearchCandidate, type CustomerResearchHints,
  normalizeContextPhone,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeCustomerContext, restoreContextFromSnapshot,
} from '../../../shared/domain/customer-context'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type {
  Company, CustomerContext, CustomerContextNote, CustomerContextNotePayload,
  CustomerContextResearchSource, Result,
} from '~/types/domain'

export type { CustomerContextBuildProposal, CustomerContextInput, CustomerResearchCandidate, CustomerResearchHints }

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
  = { ok: true; proposal: CustomerContextBuildProposal; llm: boolean }
    | { ok: false; error: { code: string; message: string } }

export function useCustomerContext() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const perms = usePermissions()
  const isApi = useApiMode()
  const ctxRows = tbl('customerContexts')
  const noteRows = tbl('customerContextNotes')

  /** AI 反映で companies.phone を更新・復元できるか（API の canReflectCompanyPhone と同一規則 = 原則6。
   *  マスタ更新経路と同じ「管理者 + 項目権限」。不許可は電話番号だけスキップし反映/取消は続行 = 原則4） */
  function canReflectPhone(): boolean {
    return currentUser.value.role === 'admin' && perms.canEditField('companies', 'phone')
  }

  function companyNameOf(companyId: string): string {
    return (tbl('companies').value as Company[]).find(c => c.id === companyId)?.name ?? companyId
  }

  /** 会社の定性情報（未登録は null =「登録」導線を出す） */
  function contextOf(companyId: string): CustomerContext | null {
    return (ctxRows.value as CustomerContext[]).find(r => r.companyId === companyId && r.active !== false) ?? null
  }

  /** companies.phone の参照 deny ユーザーには payload.before.companyPhone を伏せる
   *  （API の GET /notes と同一規則 = ノート経由で項目権限を迂回させない。原則6） */
  function stripPhoneForViewer(rows: CustomerContextNote[]): CustomerContextNote[] {
    if (perms.canField('companies', 'phone')) return rows
    return rows.map((r) => {
      if (r.payload?.before?.companyPhone === undefined) return r
      const { companyPhone: _companyPhone, ...rest } = r.payload.before
      return { ...r, payload: { ...r.payload, before: rest } }
    })
  }

  /** 有効なメモ一覧（新しい順） */
  function notesOf(companyId: string): CustomerContextNote[] {
    return stripPhoneForViewer((noteRows.value as CustomerContextNote[])
      .filter(r => r.companyId === companyId && !r.archivedAt)
      .sort(byCreatedDesc))
  }

  /** 取消済みメモ（復元 UI 用）。companyPhone の伏せは有効メモと同一規則（API = 全ノート対象と揃える） */
  function archivedNotesOf(companyId: string): CustomerContextNote[] {
    return stripPhoneForViewer((noteRows.value as CustomerContextNote[])
      .filter(r => r.companyId === companyId && !!r.archivedAt)
      .sort(byCreatedDesc))
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
        const data = await apiFetch<{ proposal: CustomerContextBuildProposal; llm: boolean }>(
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
    companyId: string, proposal: CustomerContextBuildProposal, sources: CustomerContextResearchSource[],
  ): Promise<Result> {
    const n = normalizeCustomerContext(proposal)
    const message = customerContextError(n)
    if (message) return { ok: false, error: { code: 'AKO-CTX-001', message } }
    if (sources.length === 0) {
      return { ok: false, error: { code: 'AKO-CTX-001', message: '採用する情報源を 1 件以上選択してください' } }
    }
    // 電話番号の提案（第3弾）。'' = 取得なし → 会社マスタの電話番号は変更しない
    const proposedPhone = normalizeContextPhone(proposal.phone)
    if (isApi) {
      const res = await apiWrite<{ id?: string }>(
        `/v1/customer-contexts/${encodeURIComponent(companyId)}/research/apply`,
        // companies も再取得 = 電話番号の反映を基本情報表示へ即時反映（SoT → キャッシュ）
        { body: { ...n, phone: proposedPhone, sources }, reload: ['customerContexts', 'customerContextNotes', 'companies'] })
      return res.ok ? { ok: true, id: res.data?.id } : res
    }
    const cur = contextOf(companyId)
    const before: NonNullable<CustomerContextNotePayload['before']> = {
      vision: cur?.vision ?? '',
      challenges: cur?.challenges ?? '',
      strategyNotes: cur?.strategyNotes ?? '',
      businessNotes: cur?.businessNotes ?? '',
    }
    const prevCtx = ctxRows.value
    const prevNotes = noteRows.value
    const now = nowJstIso()
    // 電話番号の反映（API と同一規則 = 原則6）: 管理者 + 項目権限（canReflectPhone）が条件で、
    // 非空かつ現在値と異なる場合のみ会社マスタを更新し、変更前の値を before.companyPhone に保存
    // （取消で復元 = 原則9.5。不許可は電話番号だけスキップ = 原則4）。失敗時ロールバック対象
    const companiesTbl = tbl('companies')
    const prevCompanies = companiesTbl.value
    const companyRow = (companiesTbl.value as Company[]).find(r => r.id === companyId)
    const curPhone = companyRow?.phone ?? ''
    if (proposedPhone && companyRow && proposedPhone !== curPhone && canReflectPhone()) {
      before.companyPhone = curPhone
      companiesTbl.value = (companiesTbl.value as Company[]).map(r =>
        r.id === companyId ? { ...r, phone: proposedPhone } : r)
    }
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
      // 保存形は shared cleanResearchSources（title/uri/snippet cap = API と同一 = 原則6）
      payload: { sources: cleanResearchSources(sources), before },
      archivedAt: null,
      createdAt: now,
    } satisfies CustomerContextNote]
    if (!commit()) {
      ctxRows.value = prevCtx
      noteRows.value = prevNotes
      companiesTbl.value = prevCompanies // 電話番号の反映もロールバック（片肺の反映を作らない）
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
        // companies も再取得 = 電話番号の復元を基本情報表示へ即時反映（SoT → キャッシュ）
        { reload: ['customerContexts', 'customerContextNotes', 'companies'], idempotent: true })
      return res.ok ? { ok: true, id: noteId } : res
    }
    const note = (noteRows.value as CustomerContextNote[]).find(r => r.id === noteId && r.companyId === companyId)
    if (!note) return { ok: false, error: { code: 'AKO-CTX-003', message: 'メモが見つかりません' } }
    if (note.kind !== 'research' || !note.payload?.before) {
      return { ok: false, error: { code: 'AKO-CTX-004', message: 'このメモには復元できる反映前の情報がありません' } }
    }
    if (note.payload.revertedAt) return { ok: true, id: noteId } // すでに取消済み = no-op（冪等）
    // 復元値の構築は shared の単一実装（旧スナップショット = businessNotes キーなしは現在値を保持 =
    // 原則7。判定の SoT を API と共有 = 原則3/6）。現在値は active に依らず行から読む
    // （API の currentContextOf と同一の参照 = パリティ。contextOf は active フィルタ付きのため使わない）
    const curRow = (ctxRows.value as CustomerContext[]).find(r => r.companyId === companyId)
    const before = restoreContextFromSnapshot(note.payload.before, curRow?.businessNotes ?? '')
    const prevCtx = ctxRows.value
    const prevNotes = noteRows.value
    const now = nowJstIso()
    // 電話番号の復元（API と同一規則 = 原則6）: 反映で変更したノート（companyPhone キーあり）だけが対象。
    // 復元も「管理者 + 項目権限」が条件（更新と対称）。保存時の生値をそのまま書き戻す
    // （正規化 cap で反映前の値を壊さない = 原則9.5）
    const companiesTbl = tbl('companies')
    const prevCompanies = companiesTbl.value
    if (note.payload.before.companyPhone !== undefined && canReflectPhone()) {
      const restorePhone = String(note.payload.before.companyPhone ?? '')
      companiesTbl.value = (companiesTbl.value as Company[]).map(r =>
        r.id === companyId && (r.phone ?? '') !== restorePhone ? { ...r, phone: restorePhone } : r)
    }
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
      companiesTbl.value = prevCompanies // 電話番号の復元もロールバック
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
