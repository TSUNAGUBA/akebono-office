/**
 * ビジネスパートナー活動（改修依頼 2026-08-18・F-45 → 2026-08-19 第4弾で改訂 →
 * 2026-08-20 改修で「案件ヘッダー + 活動ログ」構造へ再編）
 * パートナー連携のテーマ（紹介/共創/案件支援等）を記録・管理する。チーム共有の記録系 =
 * 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログで残す）。取消/復元 = 論理削除（原則9.5）。
 * - 改修依頼 2026-08-19 第4弾: パートナー会社・担当・アプローチ企業を顧客(会社/人)マスタ参照へ変更
 *   （自由入力→新規登録は useCompanyResolve / useContactResolve = 顧客活動と共通・原則3）。表示用に
 *   partnerName/relatedCompany へ会社名スナップショットを載せる（旧行の自由入力表示と同じ列で見える = 下位互換）。
 * - 改修依頼 2026-08-20: 既存行はそのまま「案件ヘッダー」（原則7）。活動ログは useActivityLogs('partner')、
 *   AI集約は generateDigest。「概要」→「背景・目的」はラベルのみ変更（summary 維持）+ 取組内容（initiatives）追加。
 * - 関連商談（relatedSalesActivityId）は営業活動への任意リンク。「案件化したら商談へリンク」の導線。
 * - 検証は shared/domain/activity（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード: API = /v1/partner-activities（サーバーページング対応）/ モック = partnerActivities コレクション
 * - commit() の戻り値を必ず検査（登録バグ根本対応 H1 = 保存失敗のサイレント化を許さない）。
 */
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_NAME_CAP as NAME_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  heuristicActivityDigest,
  normalizeActivityLinks,
  partnerActivityError, type PartnerActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import { PARTNER_ACTIVITY_STATUSES } from '../../../shared/domain/types'
import { storageCommitError } from '~/composables/useActivityLogs'
import type { ActivityDigestProposal, ActivityLog, Company, PartnerActivity, Result, SalesActivity } from '~/types/domain'
import type { Tone } from '~/types/ui'

export type { PartnerActivityInput }

/** ステータスの表示トーン（単一ドメイン固有のためここに定義 = 規約6） */
export const PARTNER_STATUS_TONES: Record<string, Tone> = {
  情報収集: 'neutral', 検討: 'info', 接続予定: 'brand', 進行中: 'brand', 案件化: 'ok', 完了: 'neutral',
}

/** 表示順: 作成降順（API の ORDER BY と同一 = パリティ） */
function byCreatedDesc(a: PartnerActivity, b: PartnerActivity): number {
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: PartnerActivityInput): PartnerActivityInput {
  return {
    ...input,
    approachGroup: capCp(input.approachGroup.trim(), NAME_CAP),
    theme: capCp(input.theme.trim(), TITLE_CAP),
    summary: capCp(input.summary.trim(), BODY_CAP),
    initiatives: capCp(input.initiatives.trim(), BODY_CAP),
    currentState: capCp(input.currentState.trim(), BODY_CAP),
    nextAction: capCp(input.nextAction.trim(), BODY_CAP),
    nextActionNote: capCp(input.nextActionNote.trim(), BODY_CAP),
    relatedMeeting: capCp(input.relatedMeeting.trim(), NAME_CAP),
    memo: capCp(input.memo.trim(), BODY_CAP),
    nextActionDate: input.nextActionDate || null,
    relatedSalesActivityId: input.relatedSalesActivityId || null,
    links: normalizeActivityLinks(input.links),
  }
}

export function usePartnerActivities() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('partnerActivities')
  const logRows = tbl('partnerActivityLogs') // AI集約の材料（モックモード専用。API は digest エンドポイントがログを読む）
  const salesRows = tbl('salesActivities')
  const companiesTbl = tbl('companies')
  const { lookupCompany, createCompany } = useCompanyResolve()
  const { contactError, resolveContactMock } = useContactResolve()
  const { resolveVillage } = useVillageResolve()

  /** 会社名スナップショット取得（partner_name/related_company の表示・検索用。id 未設定は空） */
  function companyNameOf(companyId: string | null): string {
    if (!companyId) return ''
    return (companiesTbl.value as Company[]).find(c => c.id === companyId)?.name ?? ''
  }

  /** 任意の会社解決（id も新規名も空なら null = 未設定。空名で空会社を作らない） */
  function resolveOptionalCompany(companyId: string, newName: string): string | null {
    if (!companyId && !newName.trim()) return null
    return lookupCompany(companyId, newName) ?? createCompany(newName)
  }

  /** 有効な一覧（クライアントページングのソース。API モードは全件ハイドレーションキャッシュ） */
  function list(): PartnerActivity[] {
    return (rows.value as PartnerActivity[]).filter(r => r.active !== false).slice().sort(byCreatedDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): PartnerActivity[] {
    return (rows.value as PartnerActivity[]).filter(r => r.active === false).slice().sort(byCreatedDesc)
  }

  /** id 参照（案件詳細ページの解決用。取消済みも引く = 復元導線） */
  function byId(id: string | null): PartnerActivity | null {
    if (!id) return null
    return (rows.value as PartnerActivity[]).find(r => r.id === id) ?? null
  }

  /** 関連商談の実在検証（モック。API は FK が担う = AKO-PTN-001 400 と同等） */
  function salesRefError(id: string | null): { code: string; message: string } | null {
    if (!id) return null
    if (!(salesRows.value as SalesActivity[]).some(r => r.id === id)) {
      return { code: 'AKO-PTN-001', message: '紐付け先（自社担当者・関連商談）が見つかりません' }
    }
    return null
  }

  function payloadOf(input: PartnerActivityInput): Record<string, unknown> {
    return { ...normalized(input), staffMemberId: input.staffMemberId || currentUser.value.id }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有） */
  async function save(id: string | null, input: PartnerActivityInput): Promise<Result> {
    if (isApi) {
      const res = id
        ? await apiWrite(`/v1/partner-activities/${id}`, { method: 'PATCH', body: payloadOf(input), reload: ['partnerActivities'] })
        : await apiWrite('/v1/partner-activities', { body: payloadOf(input), reload: ['partnerActivities'] })
      if (res.ok && (input.newPartnerCompanyName.trim() || input.newApproachCompanyName.trim())) await loadApiCollection('companies', true)
      if (res.ok && input.newPartnerContactName.trim()) await loadApiCollection('contacts', true)
      if (res.ok && input.newVillageName.trim()) await loadApiCollection('villages', true)
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    const message = partnerActivityError(n)
    if (message) return { ok: false, error: { code: 'AKO-PTN-001', message } }
    const refErr = salesRefError(n.relatedSalesActivityId)
    if (refErr) return { ok: false, error: refErr }
    // パートナー会社（必須）: 照合 → 担当所属検証 → 作成（失敗時に孤児マスタを残さない = 顧客活動と同型）
    const foundPartnerCompanyId = lookupCompany(n.partnerCompanyId, n.newPartnerCompanyName)
    const pce = contactError(n.partnerContactId || null, foundPartnerCompanyId, 'AKO-PTN')
    if (pce) return { ok: false, error: pce }
    const partnerCompanyId = foundPartnerCompanyId ?? createCompany(n.newPartnerCompanyName)
    const partnerContactId = resolveContactMock(partnerCompanyId, n.partnerContactId, n.newPartnerContactName)
    const approachCompanyId = resolveOptionalCompany(n.approachCompanyId, n.newApproachCompanyName)
    const villageId = resolveVillage(n.villageId, n.newVillageName)
    const partnerName = companyNameOf(partnerCompanyId)
    const relatedCompany = companyNameOf(approachCompanyId)
    const now = nowJstIso()
    const all = rows.value as PartnerActivity[]
    const prev = rows.value
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-PTN-002', message: 'ビジネスパートナー活動が見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        villageId,
        partnerCompanyId,
        partnerContactId,
        approachCompanyId,
        approachGroup: n.approachGroup,
        partnerName,
        theme: n.theme,
        relatedCompany,
        activityType: n.activityType,
        status: n.status,
        summary: n.summary,
        initiatives: n.initiatives,
        currentState: n.currentState,
        nextAction: n.nextAction,
        nextActionDate: n.nextActionDate,
        nextActionNote: n.nextActionNote,
        staffMemberId: n.staffMemberId || currentUser.value.id,
        relatedMeeting: n.relatedMeeting,
        relatedSalesActivityId: n.relatedSalesActivityId,
        memo: n.memo,
        links: n.links,
        updatedAt: now,
      } : r)
      if (!commit()) {
        rows.value = prev // 永続化できなかった変更を画面に残さない（保存済みに見える取り違え防止）
        return { ok: false, error: storageCommitError('AKO-PTN') }
      }
      return { ok: true, id }
    }
    const newId = nextId('partnerActivities', 'pact')
    rows.value = [...all, {
      id: newId,
      memberId: currentUser.value.id,
      villageId,
      partnerCompanyId,
      partnerContactId,
      approachCompanyId,
      approachGroup: n.approachGroup,
      partnerName,
      theme: n.theme,
      relatedCompany,
      activityType: n.activityType,
      status: n.status,
      summary: n.summary,
      initiatives: n.initiatives,
      currentState: n.currentState,
      nextAction: n.nextAction,
      nextActionDate: n.nextActionDate,
      nextActionNote: n.nextActionNote,
      staffMemberId: n.staffMemberId || currentUser.value.id,
      relatedMeeting: n.relatedMeeting,
      relatedSalesActivityId: n.relatedSalesActivityId,
      memo: n.memo,
      links: n.links,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies PartnerActivity]
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError('AKO-PTN') }
    }
    return { ok: true, id: newId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/partner-activities/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['partnerActivities'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as PartnerActivity[]
    if (!all.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-PTN-002', message: 'ビジネスパートナー活動が見つかりません' } }
    }
    // 状態不一致（二重取消等）は no-op（API の警告 no-op と同じ冪等挙動 = updatedAt を動かさない。監査 n-1）
    const target = all.find(r => r.id === id)!
    if ((target.active !== false) === active) return { ok: true, id }
    const prev = rows.value
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError('AKO-PTN') }
    }
    return { ok: true, id }
  }

  const archive = (id: string): Promise<Result> => setActive(id, false)
  const restore = (id: string): Promise<Result> => setActive(id, true)

  /**
   * AI集約の生成（活動ログの時系列集約 → 案件行の aiDigest へ保管。再生成で上書き = 導出キャッシュ）。
   * モック = shared の決定的ヒューリスティック / API = POST digest（LLM → 失敗時ヒューリスティック = 原則4）。
   */
  async function generateDigest(id: string): Promise<Result> {
    if (isApi) {
      const res = await apiWrite<PartnerActivity>(`/v1/partner-activities/${encodeURIComponent(id)}/digest`, {
        method: 'POST', timeoutMs: 60_000,
      })
      if (!res.ok) return res
      setApiRow('partnerActivities', res.data) // SoT（サーバー保管）→ キャッシュ反映の順（原則6）
      return { ok: true, id }
    }
    const all = rows.value as PartnerActivity[]
    const target = all.find(r => r.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-PTN-002', message: 'ビジネスパートナー活動が見つかりません' } }
    const logs = (logRows.value as ActivityLog[]).filter(l => l.activityId === id && l.active !== false)
    const digest = heuristicActivityDigest(
      {
        title: target.theme, status: target.status, nextAction: target.nextAction,
        nextActionDate: target.nextActionDate, currentState: target.currentState,
        nextActionNote: target.nextActionNote ?? '',
      },
      logs,
      { propose: true }, // 基本情報の更新提案（改善要望 2026-08-21。ヒューリスティックは Next Action 系のみ提案）
    )
    const prev = rows.value
    // 導出キャッシュの上書きのみ（updatedAt は動かさない = 記録の編集と区別。API と同一挙動）
    rows.value = all.map(r => r.id === id
      ? { ...r, aiDigest: { ...digest, generatedAt: nowJstIso(), logCount: logs.length, llm: false } }
      : r)
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError('AKO-PTN') }
    }
    return { ok: true, id }
  }

  /**
   * AI集約の基本情報更新提案を反映する（改善要望 2026-08-21 = AI 入力 → 確認 → 反映）。
   * 返り値 before = 反映前の値（同じ関数で再反映すると元へ戻る = 取消フロー・原則9.5）。
   * API = PATCH の部分更新（proposal に含まれるフィールドのみ）/ mock = 行の部分更新。
   */
  async function applyDigestProposal(
    id: string, proposal: ActivityDigestProposal,
  ): Promise<Result & { before?: ActivityDigestProposal }> {
    const patch: Record<string, unknown> = {}
    if (proposal.currentState !== undefined) patch.currentState = capCp(proposal.currentState.trim(), BODY_CAP)
    if (proposal.status !== undefined) {
      if (!(PARTNER_ACTIVITY_STATUSES as readonly string[]).includes(proposal.status)) {
        return { ok: false, error: { code: 'AKO-PTN-001', message: 'ステータスの値が正しくありません' } }
      }
      patch.status = proposal.status
    }
    if (proposal.nextAction !== undefined) patch.nextAction = capCp(proposal.nextAction.trim(), BODY_CAP)
    if (proposal.nextActionDate !== undefined) patch.nextActionDate = proposal.nextActionDate
    if (proposal.nextActionNote !== undefined) patch.nextActionNote = capCp(proposal.nextActionNote.trim(), BODY_CAP)
    if (Object.keys(patch).length === 0) return { ok: true, id }
    const cur = byId(id)
    if (!cur) return { ok: false, error: { code: 'AKO-PTN-002', message: 'ビジネスパートナー活動が見つかりません' } }
    const before: ActivityDigestProposal = {}
    if (proposal.currentState !== undefined) before.currentState = cur.currentState
    if (proposal.status !== undefined) before.status = cur.status
    if (proposal.nextAction !== undefined) before.nextAction = cur.nextAction
    if (proposal.nextActionDate !== undefined) before.nextActionDate = cur.nextActionDate
    if (proposal.nextActionNote !== undefined) before.nextActionNote = cur.nextActionNote ?? ''
    if (isApi) {
      const res = await apiWrite<PartnerActivity>(`/v1/partner-activities/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: patch,
      })
      if (!res.ok) return res
      setApiRow('partnerActivities', res.data)
      return { ok: true, id, before }
    }
    const all = rows.value as PartnerActivity[]
    const prev = rows.value
    rows.value = all.map(r => r.id === id ? { ...r, ...patch, updatedAt: nowJstIso() } : r)
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError('AKO-PTN') }
    }
    return { ok: true, id, before }
  }

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) await loadApiCollection('partnerActivities', true)
  }

  return { list, archivedList, byId, save, archive, restore, generateDigest, applyDigestProposal, refresh }
}
