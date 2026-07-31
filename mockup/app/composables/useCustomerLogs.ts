/**
 * 顧客ログ（オペレーター指示 2026-07-30 → 項目拡張 2026-07-31）
 * 「いつ（何月何日・開始/終了時刻は任意）どの顧客（会社/人）と誰（自社担当者）が
 * どんな会話（担当者メモ/議事録メモ・属性タグ）をしたか」を本人が記録する。
 * - 記録系 = 追記 + 本人編集 + 取消/復元（論理削除）。本人所有・本人のみ操作可。AI の参照対象（本人スコープ）。
 * - 閲覧: 本人の記録は常に参照可。他メンバーの記録は権限（canViewMemberCustomerLog）で許可された対象者のみ readonly 参照可。
 * - コンボボックス新規登録: newCompanyName / newContactName が未登録名なら顧客(会社)・担当者(人)を
 *   マスタへ新規登録したうえでログに反映する（API = サーバーが同一トランザクションで実施 / モック = ここで実施）。
 * - デュアルモード: API = /v1/customer-logs（SoT。AI 検索インデックスへ自動反映）/ モック = customerLogs コレクション
 */
import {
  capCodePoints as capCp, cleanCustomerLogTags as cleanTags,
  CUSTOMER_LOG_BODY_CAP as BODY_CAP, CUSTOMER_LOG_NAME_CAP as NAME_CAP, CUSTOMER_LOG_TITLE_CAP as TITLE_CAP,
  customerLogCompanyError, customerLogDateError, customerLogMemoError,
  customerLogTagsError, customerLogTimeError, customerLogTimeRangeError,
} from '../../../shared/domain/customer-log'
import { normalizeCompanyName } from '../../../shared/domain/name-match'
import type { Company, Contact, CustomerLog, Result } from '~/types/domain'

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
  /** 開始時刻（HH:MM・任意） */
  logTime: string | null
  /** 終了時刻（HH:MM・任意。開始がある場合のみ） */
  endTime: string | null
  /** 既存の顧客(会社) id。newCompanyName とどちらか必須 */
  companyId: string
  /** コンボボックスの自由入力名（未登録ならマスタへ新規登録して反映） */
  newCompanyName: string
  /** 既存の顧客担当者 id（任意） */
  contactId: string | null
  /** コンボボックスの自由入力名（未登録ならマスタへ新規登録して反映。任意） */
  newContactName: string
  /** 自社の担当者（既定 = ログインユーザー） */
  staffMemberId: string
  /** 属性タグ（商談/取材/イベント等） */
  tags: string[]
  title: string
  /** 担当者メモ（議事録メモとどちらか必須） */
  body: string
  /** 議事録メモ */
  minutesMemo: string
}

/**
 * 入力検証（モックモード用。API モードはサーバーが正）。検証ロジック・メッセージ・順序は
 * shared/domain/customer-log が SoT（API と同一関数を同一順で適用 = パリティを構造的に担保）
 */
function validate(input: CustomerLogInput): { code: string; message: string } | null {
  const message = customerLogDateError(input.logDate)
    ?? customerLogTimeError(input.logTime ?? '', '開始')
    ?? customerLogTimeError(input.endTime ?? '', '終了')
    ?? customerLogTimeRangeError(input.logTime, input.endTime)
    ?? customerLogTagsError(input.tags)
    ?? customerLogMemoError(input.body, input.minutesMemo)
    ?? customerLogCompanyError(input.companyId, input.newCompanyName)
  return message ? { code: 'AKO-CLG-001', message } : null
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
  const companiesTbl = tbl('companies')
  const contactsTbl = tbl('contacts')

  /**
   * 担当者が選択会社に属するか（モック検証。API は assertContact = AKO-CLG-003 と同一の順序:
   * 存在チェック → 所属チェック）。companyId = null（新規会社 = 照合なし）は既存担当者が所属し得ないため所属エラー
   */
  function contactError(contactId: string | null, companyId: string | null): { code: string; message: string } | null {
    if (!contactId) return null
    const c = (contactsTbl.value as Contact[]).find(x => x.id === contactId)
    if (!c) return { code: 'AKO-CLG-003', message: '指定した顧客担当者が見つかりません' }
    if (c.companyId !== companyId) return { code: 'AKO-CLG-003', message: '顧客担当者は選択した会社に所属している必要があります' }
    return null
  }

  /**
   * 顧客(会社)の照合（モック・作成なし）。id 指定はそのまま・自由入力名は正規化名
   * （法人格・空白ゆらぎ除去）の完全一致で既存の顧客(会社)へ照合する（API resolveCompany と同一規則）。
   * 作成（createCompanyMock）と分けるのは、後続検証の失敗時に孤児マスタを残さないため（原子性）
   */
  function lookupCompanyMock(input: CustomerLogInput): string | null {
    if (input.companyId) return input.companyId
    const norm = normalizeCompanyName(capCp(input.newCompanyName.trim(), NAME_CAP))
    const hit = (companiesTbl.value as Company[]).find(c => c.active && c.kind === 'customer'
      && [c.name, ...(c.aliases ?? [])].some(n => n && normalizeCompanyName(String(n)) === norm))
    return hit?.id ?? null
  }

  /** 顧客(会社)のマスタ新規登録（モック。全検証通過後にのみ呼ぶ） */
  function createCompanyMock(input: CustomerLogInput): string {
    const id = nextId('companies', 'c')
    companiesTbl.value = [...(companiesTbl.value as Company[]), {
      id,
      kind: 'customer',
      name: capCp(input.newCompanyName.trim(), NAME_CAP),
      aliases: [],
      industryIds: [],
      primaryIndustryId: null,
      size: '',
      location: '',
      description: '',
      ownerMemberId: null,
      fiscalStartMonth: null,
      active: true,
      custom: {},
    } satisfies Company]
    return id
  }

  /** 顧客担当者(人)の解決（モック）。同一会社内の氏名（空白除去・大小無視）完全一致 → なければ新規登録 */
  function resolveContactMock(companyId: string, input: CustomerLogInput): string | null {
    if (input.contactId) return input.contactId
    const name = capCp(input.newContactName.trim(), NAME_CAP)
    if (!name) return null
    const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
    const contacts = contactsTbl.value as Contact[]
    const hit = contacts.find(c => c.active && c.companyId === companyId && norm(c.name) === norm(name))
    if (hit) return hit.id
    const id = nextId('contacts', 'p')
    contactsTbl.value = [...contacts, {
      id,
      companyId,
      name,
      dept: '',
      title: '',
      keyPerson: 1,
      email: '',
      phone: '',
      notes: '',
      active: true,
      custom: {},
    } satisfies Contact]
    return id
  }

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

  /** API 書込後の反映（ログ + 新規マスタ登録があり得た場合はマスタキャッシュも取り直す = SoT → キャッシュ） */
  async function refreshAfterWrite(input: CustomerLogInput): Promise<void> {
    await loadLogs(currentUser.value.id, true)
    if (input.newCompanyName.trim() || input.newContactName.trim()) {
      await Promise.all([loadApiCollection('companies', true), loadApiCollection('contacts', true)])
    }
  }

  /** 送信ペイロード（API。自社担当者の既定 = ログインユーザーはサーバーでも適用される） */
  function payloadOf(input: CustomerLogInput): Record<string, unknown> {
    return {
      logDate: input.logDate,
      logTime: input.logTime || null,
      endTime: input.endTime || null,
      companyId: input.companyId,
      newCompanyName: input.newCompanyName,
      contactId: input.contactId || null,
      newContactName: input.newContactName,
      staffMemberId: input.staffMemberId,
      tags: cleanTags(input.tags),
      title: input.title,
      body: input.body,
      minutesMemo: input.minutesMemo,
    }
  }

  /** 登録（本人）*/
  async function add(input: CustomerLogInput): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/customer-logs', { method: 'POST', body: payloadOf(input) }))
      if (res.ok) await refreshAfterWrite(input)
      return res
    }
    const e = validate(input)
    if (e) return { ok: false, error: e }
    // 会社は照合のみ先行し、担当者の所属検証を通過してから作成する（失敗時に孤児マスタを残さない）。
    // 新規会社（照合なし = companyId null）は contactError 側が「既存担当者は所属し得ない」を判定する
    const foundCompanyId = lookupCompanyMock(input)
    const ce = contactError(input.contactId, foundCompanyId)
    if (ce) return { ok: false, error: ce }
    const companyId = foundCompanyId ?? createCompanyMock(input)
    const contactId = resolveContactMock(companyId, input)
    const id = nextId('customerLogs', 'clog')
    const now = nowJstIso()
    mockLogs.value = [...(mockLogs.value as CustomerLog[]), {
      id,
      memberId: currentUser.value.id,
      logDate: input.logDate,
      logTime: input.logTime || null,
      endTime: input.endTime || null,
      companyId,
      contactId,
      staffMemberId: input.staffMemberId || currentUser.value.id,
      tags: cleanTags(input.tags),
      title: capCp(input.title.trim(), TITLE_CAP),
      body: capCp(input.body.trim(), BODY_CAP),
      minutesMemo: capCp(input.minutesMemo.trim(), BODY_CAP),
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
      const res = await apiResult(() => apiFetch(`/v1/customer-logs/${id}`, { method: 'PATCH', body: payloadOf(input) }))
      if (res.ok) await refreshAfterWrite(input)
      return res
    }
    const target = (mockLogs.value as CustomerLog[]).find(l => l.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-CLG-002', message: '顧客ログが見つかりません' } }
    if (target.memberId !== currentUser.value.id) return ownError('編集できます')
    const e = validate(input)
    if (e) return { ok: false, error: e }
    // add と同じ順序: 照合 → 所属検証 → 作成（失敗時に孤児マスタを残さない）
    const foundCompanyId = lookupCompanyMock(input)
    const ce = contactError(input.contactId, foundCompanyId)
    if (ce) return { ok: false, error: ce }
    const companyId = foundCompanyId ?? createCompanyMock(input)
    const contactId = resolveContactMock(companyId, input)
    mockLogs.value = (mockLogs.value as CustomerLog[]).map(l => l.id === id ? {
      ...l,
      logDate: input.logDate,
      logTime: input.logTime || null,
      endTime: input.endTime || null,
      companyId,
      contactId,
      staffMemberId: input.staffMemberId || currentUser.value.id,
      tags: cleanTags(input.tags),
      title: capCp(input.title.trim(), TITLE_CAP),
      body: capCp(input.body.trim(), BODY_CAP),
      minutesMemo: capCp(input.minutesMemo.trim(), BODY_CAP),
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
