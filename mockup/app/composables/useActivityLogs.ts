/**
 * 活動ログ（案件ヘッダー + 活動ログ構造。改修依頼 2026-08-20）
 * 営業活動（sales）とビジネスパートナー活動（partner）の両案件で**同一実装**を共有する
 * （資源名・コレクション名をパラメタ化 = 原則3。二重実装しない）。
 * - チーム共有の記録系: 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログ）。
 *   取消 = 論理削除 + 復元（原則9.5）。
 * - 検証は shared/domain/activity の activityLogError（API と同一関数・同一順 = パリティの SoT）。
 * - デュアルモード:
 *   - モック = salesActivityLogs / partnerActivityLogs コレクション（クライアントページング）
 *   - API = /v1/{sales|partner}-activities/:id/logs のサーバーページング。
 *     **設計判断: ログは CUSTOM_COLLECTION_ENDPOINTS に載せない（コレクションキャッシュを使わない）**。
 *     案件にネストする資源のため全量ハイドレーションに向かず、案件詳細ページで都度フェッチする
 *     （一覧 = pageFetch / 取消済み = loadArchived）。モックの MockDbShape コレクションはモックモード専用。
 * - commit() の戻り値を必ず検査し、localStorage 容量超過等の保存失敗を Result のエラーとして返す
 *   （登録バグ根本対応 H1: 「登録ボタン無反応」の一因だったサイレント失敗を可視化）。
 */
import {
  ACTIVITY_BODY_CAP as BODY_CAP, ACTIVITY_TITLE_CAP as TITLE_CAP,
  activityLogError, type ActivityLogInput,
  normalizeActivityLinks,
} from '../../../shared/domain/activity'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import type { ActivityLog, Result } from '~/types/domain'
import type { ListPageParams } from '~/composables/useListView'

export type { ActivityLogInput }

export type ActivityCaseKind = 'sales' | 'partner'

interface KindConfig {
  collection: 'salesActivityLogs' | 'partnerActivityLogs'
  parentCollection: 'salesActivities' | 'partnerActivities'
  endpointBase: string
  idPrefix: string
  code: 'AKO-SAL' | 'AKO-PTN'
  parentLabel: string
}

const KIND_CONFIG: Record<ActivityCaseKind, KindConfig> = {
  sales: {
    collection: 'salesActivityLogs',
    parentCollection: 'salesActivities',
    endpointBase: '/v1/sales-activities',
    idPrefix: 'slog',
    code: 'AKO-SAL',
    parentLabel: '営業活動',
  },
  partner: {
    collection: 'partnerActivityLogs',
    parentCollection: 'partnerActivities',
    endpointBase: '/v1/partner-activities',
    idPrefix: 'plog',
    code: 'AKO-PTN',
    parentLabel: 'ビジネスパートナー活動',
  },
}

/**
 * commit() 失敗（localStorage 容量超過等）の共通エラー（登録バグ根本対応 H1）。
 * 従来は commit() が false を返しても呼び出し側が無視して ok:true を返す = 保存されないのに
 * 成功トーストが出る（あるいは何も出ない）サイレント失敗だった。営業/パートナー系の書込経路は
 * 必ずこのエラーを返して UI のインライン表示へつなぐ。
 */
export function storageCommitError(codePrefix: 'AKO-SAL' | 'AKO-PTN'): { code: string; message: string } {
  return {
    code: `${codePrefix}-090`,
    message: 'ブラウザの保存容量が不足していて保存できませんでした。設定の「デモデータをリセット」または不要なデータの削除をお試しください',
  }
}

/** 表示順: 活動日降順 → 登録降順 → id 降順（API の ORDER BY と同一 = パリティ） */
function byLoggedDesc(a: ActivityLog, b: ActivityLog): number {
  if (a.loggedOn !== b.loggedOn) return b.loggedOn.localeCompare(a.loggedOn)
  if ((a.createdAt ?? '') !== (b.createdAt ?? '')) return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  return b.id.localeCompare(a.id)
}

/** 入力の cap 正規化（保存形 = API パリティ） */
function normalized(input: ActivityLogInput): ActivityLogInput {
  return {
    loggedOn: input.loggedOn.trim(),
    kind: input.kind.trim(),
    title: capCp(input.title.trim(), TITLE_CAP),
    body: capCp(input.body.trim(), BODY_CAP),
    nextAction: capCp(input.nextAction.trim(), BODY_CAP),
    nextActionDate: input.nextActionDate || null,
    links: normalizeActivityLinks(input.links),
  }
}

export function useActivityLogs(kind: ActivityCaseKind) {
  const cfg = KIND_CONFIG[kind]
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  // モックモード専用のコレクション参照（API モードでは触らない = docblock の設計判断）
  const rows = tbl(cfg.collection)
  const parentRows = tbl(cfg.parentCollection)

  /** 有効なログ一覧（モックのクライアントページングのソース。API モードは pageFetch を使う） */
  function logsOf(activityId: string): ActivityLog[] {
    return (rows.value as ActivityLog[])
      .filter(r => r.activityId === activityId && r.active !== false)
      .sort(byLoggedDesc)
  }

  /** 取消済みログ（モック。復元 UI 用） */
  function archivedOf(activityId: string): ActivityLog[] {
    return (rows.value as ActivityLog[])
      .filter(r => r.activityId === activityId && r.active === false)
      .sort(byLoggedDesc)
  }

  /** API モードのサーバーページング取得（useListView の fetch に渡す） */
  function pageFetch(activityId: string): (p: ListPageParams) => Promise<{ rows: ActivityLog[]; total: number }> {
    return p => apiFetchList<ActivityLog>(`${cfg.endpointBase}/${encodeURIComponent(activityId)}/logs`, p)
  }

  /** 取消済みログの取得（モック = コレクション / API = f.active=false の一覧 GET。失敗は空 = 原則4） */
  async function loadArchived(activityId: string): Promise<ActivityLog[]> {
    if (!isApi) return archivedOf(activityId)
    try {
      const res = await apiFetchList<ActivityLog>(`${cfg.endpointBase}/${encodeURIComponent(activityId)}/logs`, {
        q: '', limit: 100, offset: 0, filter: { 'f.active': 'false' },
      })
      return res.rows
    } catch {
      return []
    }
  }

  /** 登録・編集（id = null で新規。全員可 = チーム共有）。検証 → 親実在 → 保存 → commit 検査 */
  async function save(activityId: string, id: string | null, input: ActivityLogInput): Promise<Result> {
    const n = normalized(input)
    const message = activityLogError(n)
    if (message) return { ok: false, error: { code: `${cfg.code}-001`, message } }
    if (isApi) {
      const res = id
        ? await apiWrite(`${cfg.endpointBase}/${encodeURIComponent(activityId)}/logs/${encodeURIComponent(id)}`, { method: 'PATCH', body: n })
        : await apiWrite(`${cfg.endpointBase}/${encodeURIComponent(activityId)}/logs`, { body: n })
      return res.ok ? { ok: true, id: (res.data as { id?: string })?.id ?? id ?? undefined } : res
    }
    if (!(parentRows.value as { id: string }[]).some(r => r.id === activityId)) {
      return { ok: false, error: { code: `${cfg.code}-002`, message: `${cfg.parentLabel}が見つかりません` } }
    }
    const now = nowJstIso()
    const all = rows.value as ActivityLog[]
    const prev = rows.value
    if (id) {
      const target = all.find(r => r.id === id && r.activityId === activityId)
      if (!target) return { ok: false, error: { code: `${cfg.code}-004`, message: '活動ログが見つかりません' } }
      rows.value = all.map(r => r.id === id ? {
        ...r,
        loggedOn: n.loggedOn,
        kind: n.kind,
        title: n.title,
        body: n.body,
        nextAction: n.nextAction,
        nextActionDate: n.nextActionDate,
        links: n.links,
        updatedAt: now,
      } : r)
      if (!commit()) {
        rows.value = prev // 永続化できなかった変更を画面に残さない（保存済みに見える取り違え防止）
        return { ok: false, error: storageCommitError(cfg.code) }
      }
      return { ok: true, id }
    }
    const newLogId = nextId(cfg.collection, cfg.idPrefix)
    rows.value = [...all, {
      id: newLogId,
      activityId,
      memberId: currentUser.value.id,
      memberName: currentUser.value.name,
      loggedOn: n.loggedOn,
      kind: n.kind,
      title: n.title,
      body: n.body,
      nextAction: n.nextAction,
      nextActionDate: n.nextActionDate,
      links: n.links,
      createdAt: now,
      updatedAt: now,
      active: true,
    } satisfies ActivityLog]
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError(cfg.code) }
    }
    return { ok: true, id: newLogId }
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setActive(activityId: string, id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(
        `${cfg.endpointBase}/${encodeURIComponent(activityId)}/logs/${encodeURIComponent(id)}/${active ? 'restore' : 'archive'}`,
        { idempotent: true },
      )
      return res.ok ? { ok: true, id } : res
    }
    const all = rows.value as ActivityLog[]
    const target = all.find(r => r.id === id && r.activityId === activityId)
    if (!target) return { ok: false, error: { code: `${cfg.code}-004`, message: '活動ログが見つかりません' } }
    // 状態不一致（二重取消等）は no-op（API の警告 no-op と同じ冪等挙動 = updatedAt を動かさない）
    if ((target.active !== false) === active) return { ok: true, id }
    const prev = rows.value
    rows.value = all.map(r => r.id === id ? { ...r, active, updatedAt: nowJstIso() } : r)
    if (!commit()) {
      rows.value = prev
      return { ok: false, error: storageCommitError(cfg.code) }
    }
    return { ok: true, id }
  }

  const archive = (activityId: string, id: string): Promise<Result> => setActive(activityId, id, false)
  const restore = (activityId: string, id: string): Promise<Result> => setActive(activityId, id, true)

  return { logsOf, archivedOf, pageFetch, loadArchived, save, archive, restore }
}
