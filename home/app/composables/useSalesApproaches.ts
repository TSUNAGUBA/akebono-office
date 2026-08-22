/**
 * 営業アプローチリスト（改善要望 2026-08-21・F-53）
 * 顧客基本情報・顧客属性・顧客コンテキストを基に「アプローチする / している顧客」を 1社1行で管理する。
 * チーム共有（全員が閲覧・登録・編集可・取消/復元 = 原則9.5）。
 * - 検証は shared/domain/sales-approach（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード: API = /v1/sales-approaches / モック = salesApproaches コレクション。
 * - 基本情報・属性・コンテキスト・活動実績は各 SoT（companies / customerContexts / customerLogs 等）
 *   からのライブ参照で表示する（本エンティティに複製しない = 原則6）。
 */
import {
  SALES_APPROACH_ACTION_CAP, SALES_APPROACH_NOTE_CAP,
  salesApproachError, type SalesApproachInput,
} from '../../../shared/domain/sales-approach'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { Result, SalesApproach } from '~/types/domain'
import type { Tone } from '~/types/ui'

export type { SalesApproachInput }

/** 状態・優先度の表示トーン（単一ドメイン固有のためここに定義 = 規約6） */
export const SALES_APPROACH_STATUS_TONES: Record<string, Tone> = {
  候補: 'neutral', アプローチ中: 'info', 商談化: 'brand', 受注: 'ok', 見送り: 'crit', 休眠: 'warn',
}
export const SALES_APPROACH_PRIORITY_TONES: Record<string, Tone> = {
  高: 'crit', 中: 'info', 低: 'neutral',
}

/** 表示順: 作成降順（API の ORDER BY と同一 = パリティ。優先度等の並びは画面のソートが担う） */
function byCreatedDesc(a: SalesApproach, b: SalesApproach): number {
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: SalesApproachInput): SalesApproachInput {
  return {
    ...input,
    companyId: input.companyId.trim(),
    nextAction: capCp(input.nextAction.trim(), SALES_APPROACH_ACTION_CAP),
    nextActionDate: input.nextActionDate || null,
    note: capCp(input.note.trim(), SALES_APPROACH_NOTE_CAP),
  }
}

export function useSalesApproaches() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('salesApproaches')

  /** 有効な一覧（クライアントページングのソース。API モードは全量ハイドレーションキャッシュ） */
  function list(): SalesApproach[] {
    return (rows.value as SalesApproach[]).filter(r => r.active !== false).slice().sort(byCreatedDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): SalesApproach[] {
    return (rows.value as SalesApproach[]).filter(r => r.active === false).slice().sort(byCreatedDesc)
  }

  function payloadOf(input: SalesApproachInput): Record<string, unknown> {
    return { ...normalized(input), assigneeMemberId: input.assigneeMemberId || currentUser.value.id }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有。1社1行 = 既登録の会社は AKO-SAP-003） */
  async function save(id: string | null, input: SalesApproachInput): Promise<Result> {
    if (isApi) {
      const res = id
        ? await apiWrite(`/v1/sales-approaches/${id}`, { method: 'PATCH', body: payloadOf(input), reload: ['salesApproaches'] })
        : await apiWrite('/v1/sales-approaches', { body: payloadOf(input), reload: ['salesApproaches'] })
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    const message = salesApproachError({ ...n, assigneeMemberId: n.assigneeMemberId || currentUser.value.id })
    if (message) return { ok: false, error: { code: 'AKO-SAP-001', message } }
    // 対象は顧客(会社)のみ（kind='customer' = API の requireCustomerCompany と同一判定。自社は登録不可）
    const company = (tbl('companies').value as { id: string; kind: string }[]).find(c => c.id === n.companyId)
    if (!company) return { ok: false, error: { code: 'AKO-SAP-001', message: '紐付け先（顧客・担当メンバー）が見つかりません' } }
    if (company.kind !== 'customer') {
      return { ok: false, error: { code: 'AKO-SAP-001', message: '顧客(会社)のみ登録できます（自社は対象外です）' } }
    }
    const all = rows.value as SalesApproach[]
    // 1社1行（API の UNIQUE 制約と同じ判定。取消済みも 1 行に数える = 復元で重複させない）
    const dup = all.find(r => r.companyId === n.companyId && r.id !== id)
    if (dup) {
      return {
        ok: false,
        error: { code: 'AKO-SAP-003', message: 'この顧客は既にアプローチリストに登録されています（取消済みの場合は復元してください）' },
      }
    }
    const now = nowJstIso()
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-SAP-002', message: '営業アプローチが見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        companyId: n.companyId,
        status: n.status,
        priority: n.priority,
        assigneeMemberId: n.assigneeMemberId || currentUser.value.id,
        nextAction: n.nextAction,
        nextActionDate: n.nextActionDate,
        note: n.note,
        updatedAt: now,
      } : r)
      if (!commit()) return { ok: false, error: { code: 'AKO-SAP-090', message: '保存容量が不足しています' } }
      return { ok: true, id }
    }
    const newRowId = nextId('salesApproaches', 'sap')
    rows.value = [...all, {
      id: newRowId,
      memberId: currentUser.value.id,
      companyId: n.companyId,
      status: n.status,
      priority: n.priority,
      assigneeMemberId: n.assigneeMemberId || currentUser.value.id,
      nextAction: n.nextAction,
      nextActionDate: n.nextActionDate,
      note: n.note,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies SalesApproach]
    if (!commit()) {
      rows.value = all // ロールバック（登録無反応バグの根本対応と同型）
      return { ok: false, error: { code: 'AKO-SAP-090', message: '保存容量が不足しています' } }
    }
    return { ok: true, id: newRowId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/sales-approaches/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['salesApproaches'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as SalesApproach[]
    const target = all.find(r => r.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-SAP-002', message: '営業アプローチが見つかりません' } }
    // 状態不一致（二重取消等）は no-op（API の警告 no-op と同じ冪等挙動）
    if ((target.active !== false) === active) return { ok: true, id }
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    commit()
    return { ok: true, id }
  }

  const archive = (id: string): Promise<Result> => setActive(id, false)
  const restore = (id: string): Promise<Result> => setActive(id, true)

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) await loadApiCollection('salesApproaches', true)
  }

  return { list, archivedList, save, archive, restore, refresh }
}
