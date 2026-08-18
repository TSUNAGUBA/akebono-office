/**
 * サポート活動（改修依頼 2026-08-18・F-43）
 * 顧客サポートの受付〜解決を記録・管理する。チーム共有の記録系 = 全員が閲覧・登録・編集できる
 * （対応状況をチームで引き継ぐ運用。訂正履歴は API モードの監査ログで残す）。取消/復元 = 論理削除（原則9.5）。
 * - 検証は shared/domain/activity（API と同一関数・同一順 = パリティの SoT）。
 * - 顧客(会社)のコンボボックス新規登録は useCompanyResolve（顧客活動と共通 = 原則3）。
 * - デュアルモード: API = /v1/support-activities（サーバーページング対応）/ モック = supportActivities コレクション
 */
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_NAME_CAP as NAME_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  supportActivityError, type SupportActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { Result, SupportActivity } from '~/types/domain'
import type { Tone } from '~/types/ui'

export type { SupportActivityInput }

/** ステータス・優先度の表示トーン（単一ドメイン固有のためここに定義 = 規約6） */
export const SUPPORT_STATUS_TONES: Record<string, Tone> = {
  未対応: 'warn', 対応中: 'info', 顧客確認待ち: 'brand', 保留: 'neutral', 解決: 'ok',
}
export const SUPPORT_PRIORITY_TONES: Record<string, Tone> = {
  低: 'neutral', 通常: 'info', 高: 'warn', 緊急: 'crit',
}

/** 表示順: 受付日降順 → 作成降順（API の ORDER BY と同一 = パリティ） */
function byReceivedDesc(a: SupportActivity, b: SupportActivity): number {
  if (a.receivedDate !== b.receivedDate) return b.receivedDate.localeCompare(a.receivedDate)
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: SupportActivityInput): SupportActivityInput {
  return {
    ...input,
    inquirerName: capCp(input.inquirerName.trim(), NAME_CAP),
    targetSystem: capCp(input.targetSystem.trim(), NAME_CAP),
    title: capCp(input.title.trim(), TITLE_CAP),
    body: capCp(input.body.trim(), BODY_CAP),
    response: capCp(input.response.trim(), BODY_CAP),
    cause: capCp(input.cause.trim(), BODY_CAP),
    resolution: capCp(input.resolution.trim(), BODY_CAP),
    knowledgeNote: capCp(input.knowledgeNote.trim(), BODY_CAP),
    receivedTime: input.receivedTime || null,
    completedDate: input.completedDate || null,
    completedTime: input.completedTime || null,
  }
}

export function useSupportActivities() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('supportActivities')
  const { lookupCompany, createCompany } = useCompanyResolve()

  /** 有効な一覧（クライアントページングのソース。API モードは全件ハイドレーションキャッシュ） */
  function list(): SupportActivity[] {
    return (rows.value as SupportActivity[]).filter(r => r.active !== false).slice().sort(byReceivedDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): SupportActivity[] {
    return (rows.value as SupportActivity[]).filter(r => r.active === false).slice().sort(byReceivedDesc)
  }

  /** API 書込後の反映（新規会社があり得た場合はマスタキャッシュも取り直す = SoT → キャッシュ） */
  async function reloadAfterWrite(input: SupportActivityInput): Promise<void> {
    if (input.newCompanyName.trim()) await loadApiCollection('companies', true)
  }

  function payloadOf(input: SupportActivityInput): Record<string, unknown> {
    return { ...normalized(input), staffMemberId: input.staffMemberId || currentUser.value.id }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有） */
  async function save(id: string | null, input: SupportActivityInput): Promise<Result> {
    if (isApi) {
      const res = id
        ? await apiWrite(`/v1/support-activities/${id}`, { method: 'PATCH', body: payloadOf(input), reload: ['supportActivities'] })
        : await apiWrite('/v1/support-activities', { body: payloadOf(input), reload: ['supportActivities'] })
      if (res.ok) await reloadAfterWrite(input)
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    const message = supportActivityError(n)
    if (message) return { ok: false, error: { code: 'AKO-SUP-001', message } }
    const companyId = lookupCompany(n.companyId, n.newCompanyName) ?? createCompany(n.newCompanyName)
    const now = nowJstIso()
    const all = rows.value as SupportActivity[]
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-SUP-002', message: 'サポート活動が見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        receivedDate: n.receivedDate,
        receivedTime: n.receivedTime,
        companyId,
        inquirerName: n.inquirerName,
        targetSystem: n.targetSystem,
        category: n.category,
        title: n.title,
        body: n.body,
        priority: n.priority,
        status: n.status,
        staffMemberId: n.staffMemberId || currentUser.value.id,
        response: n.response,
        cause: n.cause,
        resolution: n.resolution,
        completedDate: n.completedDate,
        completedTime: n.completedTime,
        knowledgeNote: n.knowledgeNote,
        updatedAt: now,
      } : r)
      commit()
      return { ok: true, id }
    }
    const newId = nextId('supportActivities', 'sup')
    rows.value = [...all, {
      id: newId,
      memberId: currentUser.value.id,
      receivedDate: n.receivedDate,
      receivedTime: n.receivedTime,
      companyId,
      inquirerName: n.inquirerName,
      targetSystem: n.targetSystem,
      category: n.category,
      title: n.title,
      body: n.body,
      priority: n.priority,
      status: n.status,
      staffMemberId: n.staffMemberId || currentUser.value.id,
      response: n.response,
      cause: n.cause,
      resolution: n.resolution,
      completedDate: n.completedDate,
      completedTime: n.completedTime,
      knowledgeNote: n.knowledgeNote,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies SupportActivity]
    commit()
    return { ok: true, id: newId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/support-activities/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['supportActivities'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as SupportActivity[]
    if (!all.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-SUP-002', message: 'サポート活動が見つかりません' } }
    }
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    commit()
    return { ok: true, id }
  }

  const archive = (id: string): Promise<Result> => setActive(id, false)
  const restore = (id: string): Promise<Result> => setActive(id, true)

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) await loadApiCollection('supportActivities', true)
  }

  return { list, archivedList, save, archive, restore, refresh }
}
