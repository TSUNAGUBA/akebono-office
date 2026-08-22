/**
 * 社内サポート活動（改善要望 2026-08-22・F-57）
 * 社内メンバーどうしのフォローアップ（業務支援・技術支援・教育等）を時系列で記録する。
 * チーム共有（全員が閲覧・登録・編集可・取消/復元 = 原則9.5）。
 * - 検証は shared/domain/internal-support（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード: API = /v1/internal-supports / モック = internalSupports コレクション。
 * - 記録は AKEBONO Intelligence の AI 分析（ナレッジカテゴリ「社内サポート」）の材料になる。
 */
import {
  INTERNAL_SUPPORT_TEXT_CAP, internalSupportError, type InternalSupportInput,
} from '../../../shared/domain/internal-support'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { InternalSupport, Member, Result } from '~/types/domain'

export type { InternalSupportInput }

/** 表示順: 活動日降順 → 作成降順（API の ORDER BY と同一 = パリティ） */
function byActivityDesc(a: InternalSupport, b: InternalSupport): number {
  if (a.activityDate !== b.activityDate) return b.activityDate.localeCompare(a.activityDate)
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: InternalSupportInput): InternalSupportInput {
  return {
    ...input,
    activityDate: input.activityDate.trim(),
    activityTime: input.activityTime || null,
    performerMemberId: input.performerMemberId.trim(),
    targetMemberId: input.targetMemberId.trim(),
    taskDescription: capCp(input.taskDescription.trim(), INTERNAL_SUPPORT_TEXT_CAP),
    method: input.method.trim(),
    feedback: capCp(input.feedback.trim(), INTERNAL_SUPPORT_TEXT_CAP),
  }
}

export function useInternalSupports() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('internalSupports')

  /** 有効な一覧（クライアントページングのソース。API モードは全量ハイドレーションキャッシュ） */
  function list(): InternalSupport[] {
    return (rows.value as InternalSupport[]).filter(r => r.active !== false).slice().sort(byActivityDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): InternalSupport[] {
    return (rows.value as InternalSupport[]).filter(r => r.active === false).slice().sort(byActivityDesc)
  }

  function payloadOf(input: InternalSupportInput): Record<string, unknown> {
    const n = normalized(input)
    return { ...n, performerMemberId: n.performerMemberId || currentUser.value.id }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有） */
  async function save(id: string | null, input: InternalSupportInput): Promise<Result> {
    if (isApi) {
      const res = id
        ? await apiWrite(`/v1/internal-supports/${id}`, { method: 'PATCH', body: payloadOf(input), reload: ['internalSupports'] })
        : await apiWrite('/v1/internal-supports', { body: payloadOf(input), reload: ['internalSupports'] })
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    n.performerMemberId = n.performerMemberId || currentUser.value.id
    const message = internalSupportError(n)
    if (message) return { ok: false, error: { code: 'AKO-ISP-001', message } }
    // 実施者・対象者はメンバーマスタ参照（API の FK と同一判定）
    const members = tbl('members').value as Member[]
    if (!members.some(m => m.id === n.performerMemberId) || !members.some(m => m.id === n.targetMemberId)) {
      return { ok: false, error: { code: 'AKO-ISP-001', message: '紐付け先（実施者・対象者のメンバー）が見つかりません' } }
    }
    const all = rows.value as InternalSupport[]
    const now = nowJstIso()
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-ISP-002', message: '社内サポート活動が見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        activityDate: n.activityDate,
        activityTime: n.activityTime,
        performerMemberId: n.performerMemberId,
        targetMemberId: n.targetMemberId,
        taskDescription: n.taskDescription,
        method: n.method,
        feedback: n.feedback,
        updatedAt: now,
      } : r)
      if (!commit()) return { ok: false, error: { code: 'AKO-ISP-090', message: '保存容量が不足しています' } }
      return { ok: true, id }
    }
    const newRowId = nextId('internalSupports', 'isp')
    rows.value = [...all, {
      id: newRowId,
      memberId: currentUser.value.id,
      activityDate: n.activityDate,
      activityTime: n.activityTime,
      performerMemberId: n.performerMemberId,
      targetMemberId: n.targetMemberId,
      taskDescription: n.taskDescription,
      method: n.method,
      feedback: n.feedback,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies InternalSupport]
    if (!commit()) {
      rows.value = all // ロールバック（登録無反応バグの根本対応と同型）
      return { ok: false, error: { code: 'AKO-ISP-090', message: '保存容量が不足しています' } }
    }
    return { ok: true, id: newRowId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/internal-supports/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['internalSupports'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as InternalSupport[]
    const target = all.find(r => r.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-ISP-002', message: '社内サポート活動が見つかりません' } }
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
    if (isApi) await loadApiCollection('internalSupports', true)
  }

  return { list, archivedList, save, archive, restore, refresh }
}
