/**
 * 営業活動（改修依頼 2026-08-18・F-44）
 * 商談の履歴と進捗（フェーズ・金額・確度・Next Action）を管理する。チーム共有の記録系 =
 * 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログで残す）。取消/復元 = 論理削除（原則9.5）。
 * - 検証は shared/domain/activity（API と同一関数・同一順 = パリティの SoT）。
 * - 顧客(会社)のコンボボックス新規登録は useCompanyResolve（顧客活動と共通 = 原則3）。
 * - デュアルモード: API = /v1/sales-activities（サーバーページング対応）/ モック = salesActivities コレクション
 */
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  salesActivityError, type SalesActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { Result, SalesActivity } from '~/types/domain'
import type { Tone } from '~/types/ui'

export type { SalesActivityInput }

/** 商談フェーズの表示トーン（単一ドメイン固有のためここに定義 = 規約6） */
export const SALES_PHASE_TONES: Record<string, Tone> = {
  初回: 'neutral', ヒアリング: 'info', 提案: 'brand', 見積: 'brand', 稟議: 'warn', 受注: 'ok', 失注: 'crit',
}

/** 表示順: 作成降順（API の ORDER BY と同一 = パリティ） */
function byCreatedDesc(a: SalesActivity, b: SalesActivity): number {
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: SalesActivityInput): SalesActivityInput {
  return {
    ...input,
    title: capCp(input.title.trim(), TITLE_CAP),
    customerIssue: capCp(input.customerIssue.trim(), BODY_CAP),
    proposal: capCp(input.proposal.trim(), BODY_CAP),
    nextAction: capCp(input.nextAction.trim(), BODY_CAP),
    expectedCloseDate: input.expectedCloseDate || null,
    nextActionDate: input.nextActionDate || null,
  }
}

export function useSalesActivities() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('salesActivities')
  const { lookupCompany, createCompany } = useCompanyResolve()

  /** 有効な一覧（クライアントページングのソース。API モードは全件ハイドレーションキャッシュ） */
  function list(): SalesActivity[] {
    return (rows.value as SalesActivity[]).filter(r => r.active !== false).slice().sort(byCreatedDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): SalesActivity[] {
    return (rows.value as SalesActivity[]).filter(r => r.active === false).slice().sort(byCreatedDesc)
  }

  /** id 参照（ビジネスパートナー活動の「関連商談」リンク解決に使う。取消済みも名前解決できるよう全件から引く） */
  function byId(id: string | null): SalesActivity | null {
    if (!id) return null
    return (rows.value as SalesActivity[]).find(r => r.id === id) ?? null
  }

  function payloadOf(input: SalesActivityInput): Record<string, unknown> {
    return { ...normalized(input), staffMemberId: input.staffMemberId || currentUser.value.id }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有） */
  async function save(id: string | null, input: SalesActivityInput): Promise<Result> {
    if (isApi) {
      const res = id
        ? await apiWrite(`/v1/sales-activities/${id}`, { method: 'PATCH', body: payloadOf(input), reload: ['salesActivities'] })
        : await apiWrite('/v1/sales-activities', { body: payloadOf(input), reload: ['salesActivities'] })
      if (res.ok && input.newCompanyName.trim()) await loadApiCollection('companies', true)
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    const message = salesActivityError(n)
    if (message) return { ok: false, error: { code: 'AKO-SAL-001', message } }
    const companyId = lookupCompany(n.companyId, n.newCompanyName) ?? createCompany(n.newCompanyName)
    const now = nowJstIso()
    const all = rows.value as SalesActivity[]
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-SAL-002', message: '営業活動が見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        companyId,
        title: n.title,
        dealType: n.dealType,
        staffMemberId: n.staffMemberId || currentUser.value.id,
        phase: n.phase,
        amount: n.amount,
        probability: n.probability,
        expectedCloseDate: n.expectedCloseDate,
        customerIssue: n.customerIssue,
        proposal: n.proposal,
        nextAction: n.nextAction,
        nextActionDate: n.nextActionDate,
        updatedAt: now,
      } : r)
      commit()
      return { ok: true, id }
    }
    const newId = nextId('salesActivities', 'deal')
    rows.value = [...all, {
      id: newId,
      memberId: currentUser.value.id,
      companyId,
      title: n.title,
      dealType: n.dealType,
      staffMemberId: n.staffMemberId || currentUser.value.id,
      phase: n.phase,
      amount: n.amount,
      probability: n.probability,
      expectedCloseDate: n.expectedCloseDate,
      customerIssue: n.customerIssue,
      proposal: n.proposal,
      nextAction: n.nextAction,
      nextActionDate: n.nextActionDate,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies SalesActivity]
    commit()
    return { ok: true, id: newId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/sales-activities/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['salesActivities'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as SalesActivity[]
    if (!all.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-SAL-002', message: '営業活動が見つかりません' } }
    }
    // 状態不一致（二重取消等）は no-op（API の警告 no-op と同じ冪等挙動 = updatedAt を動かさない。監査 n-1）
    const target = all.find(r => r.id === id)!
    if ((target.active !== false) === active) return { ok: true, id }
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    commit()
    return { ok: true, id }
  }

  const archive = (id: string): Promise<Result> => setActive(id, false)
  const restore = (id: string): Promise<Result> => setActive(id, true)

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) await loadApiCollection('salesActivities', true)
  }

  return { list, archivedList, byId, save, archive, restore, refresh }
}
