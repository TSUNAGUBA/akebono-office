/**
 * ビジネスパートナー活動（改修依頼 2026-08-18・F-45）
 * パートナー連携のテーマ（紹介/共創/案件支援等）を記録・管理する。チーム共有の記録系 =
 * 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログで残す）。取消/復元 = 論理削除（原則9.5）。
 * - パートナー・関連企業は自由入力（マスタ参照にしない設計判断 = shared/domain/types.ts 参照）。
 * - 関連商談（relatedSalesActivityId）は営業活動への任意リンク。「案件化したら商談へリンク」の導線。
 * - 検証は shared/domain/activity（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード: API = /v1/partner-activities（サーバーページング対応）/ モック = partnerActivities コレクション
 */
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_NAME_CAP as NAME_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  partnerActivityError, type PartnerActivityInput,
} from '../../../shared/domain/activity'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { PartnerActivity, Result, SalesActivity } from '~/types/domain'
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
    partnerName: capCp(input.partnerName.trim(), NAME_CAP),
    theme: capCp(input.theme.trim(), TITLE_CAP),
    relatedCompany: capCp(input.relatedCompany.trim(), NAME_CAP),
    summary: capCp(input.summary.trim(), BODY_CAP),
    currentState: capCp(input.currentState.trim(), BODY_CAP),
    nextAction: capCp(input.nextAction.trim(), BODY_CAP),
    relatedMeeting: capCp(input.relatedMeeting.trim(), NAME_CAP),
    memo: capCp(input.memo.trim(), BODY_CAP),
    nextActionDate: input.nextActionDate || null,
    relatedSalesActivityId: input.relatedSalesActivityId || null,
  }
}

export function usePartnerActivities() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const rows = tbl('partnerActivities')
  const salesRows = tbl('salesActivities')

  /** 有効な一覧（クライアントページングのソース。API モードは全件ハイドレーションキャッシュ） */
  function list(): PartnerActivity[] {
    return (rows.value as PartnerActivity[]).filter(r => r.active !== false).slice().sort(byCreatedDesc)
  }

  /** 取消済み一覧（復元 UI 用） */
  function archivedList(): PartnerActivity[] {
    return (rows.value as PartnerActivity[]).filter(r => r.active === false).slice().sort(byCreatedDesc)
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
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    const n = normalized(input)
    const message = partnerActivityError(n)
    if (message) return { ok: false, error: { code: 'AKO-PTN-001', message } }
    const refErr = salesRefError(n.relatedSalesActivityId)
    if (refErr) return { ok: false, error: refErr }
    const now = nowJstIso()
    const all = rows.value as PartnerActivity[]
    if (id) {
      const target = all.find(r => r.id === id)
      if (!target) return { ok: false, error: { code: 'AKO-PTN-002', message: 'ビジネスパートナー活動が見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        partnerName: n.partnerName,
        theme: n.theme,
        relatedCompany: n.relatedCompany,
        activityType: n.activityType,
        status: n.status,
        summary: n.summary,
        currentState: n.currentState,
        nextAction: n.nextAction,
        nextActionDate: n.nextActionDate,
        staffMemberId: n.staffMemberId || currentUser.value.id,
        relatedMeeting: n.relatedMeeting,
        relatedSalesActivityId: n.relatedSalesActivityId,
        memo: n.memo,
        updatedAt: now,
      } : r)
      commit()
      return { ok: true, id }
    }
    const newId = nextId('partnerActivities', 'pact')
    rows.value = [...all, {
      id: newId,
      memberId: currentUser.value.id,
      partnerName: n.partnerName,
      theme: n.theme,
      relatedCompany: n.relatedCompany,
      activityType: n.activityType,
      status: n.status,
      summary: n.summary,
      currentState: n.currentState,
      nextAction: n.nextAction,
      nextActionDate: n.nextActionDate,
      staffMemberId: n.staffMemberId || currentUser.value.id,
      relatedMeeting: n.relatedMeeting,
      relatedSalesActivityId: n.relatedSalesActivityId,
      memo: n.memo,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies PartnerActivity]
    commit()
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
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    commit()
    return { ok: true, id }
  }

  const archive = (id: string): Promise<Result> => setActive(id, false)
  const restore = (id: string): Promise<Result> => setActive(id, true)

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) await loadApiCollection('partnerActivities', true)
  }

  return { list, archivedList, save, archive, restore, refresh }
}
