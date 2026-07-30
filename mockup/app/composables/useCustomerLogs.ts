/**
 * 顧客ログ（オペレーター指示 2026-07-30）
 * 「いつ（何月何日・時刻は任意）どの顧客（会社/人）とどんな会話をしたか」を本人が記録する。
 * - 記録系 = 追記 + 本人編集 + 取消/復元（論理削除）。本人所有・本人のみ操作可。AI の参照対象（本人スコープ）。
 * - 閲覧: 本人の記録は常に参照可。他メンバーの記録は権限（canViewMemberCustomerLog）で許可された対象者のみ readonly 参照可。
 * - デュアルモード: API = /v1/customer-logs（SoT。AI 検索インデックスへ自動反映）/ モック = customerLogs コレクション
 */
import type { CustomerLog, Result } from '~/types/domain'

/** 参照キャッシュ（memberId ごと。自分 = currentUser.id・他メンバー = 権限で許可された対象者） */
const apiLogs = ref<Record<string, CustomerLog[]>>({})

function loadLogs(memberId: string, force = false): Promise<void> {
  return apiLoadOnce(`customer-logs:${memberId}`, async () => {
    // 取消済みも取得して復元 UI に使う（他メンバー分はサーバーが active のみへ絞る）
    const rows = await apiFetch<CustomerLog[]>('/v1/customer-logs', {
      query: { memberId, includeArchived: '1' },
    })
    apiLogs.value = { ...apiLogs.value, [memberId]: rows }
  }, force)
}

onApiReset(() => { apiLogs.value = {} })

export interface CustomerLogInput {
  logDate: string
  logTime: string | null
  companyId: string
  contactId: string | null
  title: string
  body: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 入力検証（モックモード用。API モードはサーバーが正。エラーコードはサーバーと同一 = AKO-CLG-001） */
function validate(input: CustomerLogInput): { code: string; message: string } | null {
  if (!DATE_RE.test(input.logDate)) return { code: 'AKO-CLG-001', message: '日付（何月何日）を選択してください' }
  if (input.logTime && !TIME_RE.test(input.logTime)) return { code: 'AKO-CLG-001', message: '時刻は HH:MM 形式で入力してください' }
  if (!input.companyId) return { code: 'AKO-CLG-001', message: '顧客(会社)を選択してください' }
  if (!input.body.trim()) return { code: 'AKO-CLG-001', message: '会話内容を入力してください' }
  return null
}

/** 表示順: 日付降順 → 時刻降順（未設定は後ろ）→ 作成降順 */
function byWhenDesc(a: CustomerLog, b: CustomerLog): number {
  if (a.logDate !== b.logDate) return b.logDate.localeCompare(a.logDate)
  const at = a.logTime ?? ''
  const bt = b.logTime ?? ''
  if (at !== bt) {
    if (!at) return 1 // 時刻未設定は後ろへ
    if (!bt) return -1
    return bt.localeCompare(at) // 時刻降順
  }
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
}

export function useCustomerLogs() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const mockLogs = tbl('customerLogs')

  /** 対象メンバーの読み込みを保証する（API モードのみ。ページの対象切替時に呼ぶ） */
  function ensureLoaded(memberId: string): void {
    if (isApi && memberId) void loadLogs(memberId)
  }

  /** 有効な顧客ログ一覧（対象メンバー。既定 = 本人）*/
  function logsOf(memberId: string): CustomerLog[] {
    const rows = isApi
      ? (apiLogs.value[memberId] ?? [])
      : (mockLogs.value as CustomerLog[]).filter(l => l.memberId === memberId)
    return rows.filter(l => l.active !== false).slice().sort(byWhenDesc)
  }

  /** 取消済み一覧（復元 UI 用。本人のみ意味を持つ = サーバーは他メンバーの取消済みを返さない）*/
  function archivedOf(memberId: string): CustomerLog[] {
    const rows = isApi
      ? (apiLogs.value[memberId] ?? [])
      : (mockLogs.value as CustomerLog[]).filter(l => l.memberId === memberId)
    return rows.filter(l => l.active === false).slice().sort(byWhenDesc)
  }

  function ownError(verb: string): Result {
    return { ok: false, error: { code: 'AKO-CLG-002', message: `自分の顧客ログのみ${verb}` } }
  }

  /** 登録（本人）*/
  async function add(input: CustomerLogInput): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/customer-logs', { method: 'POST', body: input }))
      if (res.ok) await loadLogs(currentUser.value.id, true)
      return res
    }
    const e = validate(input)
    if (e) return { ok: false, error: e }
    const id = nextId('customerLogs', 'clog')
    const now = nowJstIso()
    mockLogs.value = [...(mockLogs.value as CustomerLog[]), {
      id,
      memberId: currentUser.value.id,
      logDate: input.logDate,
      logTime: input.logTime || null,
      companyId: input.companyId,
      contactId: input.contactId || null,
      title: input.title.trim(),
      body: input.body.trim(),
      createdAt: now,
      updatedAt: now,
      active: true,
    }]
    commit()
    return { ok: true, id }
  }

  /** 編集（本人のみ。フォームは全項目を送るため全置換 = API PATCH と同じ結果）*/
  async function update(id: string, input: CustomerLogInput): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/customer-logs/${id}`, { method: 'PATCH', body: input }))
      if (res.ok) await loadLogs(currentUser.value.id, true)
      return res
    }
    const target = (mockLogs.value as CustomerLog[]).find(l => l.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-CLG-002', message: '顧客ログが見つかりません' } }
    if (target.memberId !== currentUser.value.id) return ownError('編集できます')
    const e = validate(input)
    if (e) return { ok: false, error: e }
    mockLogs.value = (mockLogs.value as CustomerLog[]).map(l => l.id === id ? {
      ...l,
      logDate: input.logDate,
      logTime: input.logTime || null,
      companyId: input.companyId,
      contactId: input.contactId || null,
      title: input.title.trim(),
      body: input.body.trim(),
      updatedAt: nowJstIso(),
    } : l)
    commit()
    return { ok: true, id }
  }

  async function archive(id: string): Promise<Result> {
    return setActive(id, false, `/v1/customer-logs/${id}/archive`, '取り消せます')
  }

  async function restore(id: string): Promise<Result> {
    return setActive(id, true, `/v1/customer-logs/${id}/restore`, '復元できます')
  }

  async function setActive(id: string, active: boolean, apiPath: string, verb: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(apiPath, { method: 'POST' }))
      if (res.ok) await loadLogs(currentUser.value.id, true)
      return res
    }
    const target = (mockLogs.value as CustomerLog[]).find(l => l.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-CLG-002', message: '顧客ログが見つかりません' } }
    if (target.memberId !== currentUser.value.id) return ownError(verb)
    mockLogs.value = (mockLogs.value as CustomerLog[]).map(l => l.id === id ? { ...l, active, updatedAt: nowJstIso() } : l)
    commit()
    return { ok: true, id }
  }

  async function refresh(memberId?: string): Promise<void> {
    if (isApi) await loadLogs(memberId ?? currentUser.value.id, true)
  }

  return { logsOf, archivedOf, ensureLoaded, add, update, archive, restore, refresh }
}
