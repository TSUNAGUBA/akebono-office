/**
 * 営業アプローチリスト API（改善要望 2026-08-21・F-53）。
 * - 顧客(会社)を対象に、アプローチ状態・優先度・担当・次アクション・方針メモを 1社1行で管理する。
 * - チーム共有（全員が閲覧・登録・編集可 = 活動記録 3 種と同じ所有モデル。訂正履歴は監査ログ）。
 * - 取消 = 論理削除（active=false）+ 復元（原則9.5）。1社1行 = company_id UNIQUE（取消済みも 1 行に数える。
 *   再登録は取消済み行の復元 + 編集で行う = 重複行を作らない）。
 * - 表示に使う基本情報・属性・コンテキスト・活動実績はフロントが各 SoT コレクションから解決する
 *   （本 API はアプローチ行のみを返す = SoT の重複を作らない・原則6）。
 * - 検証は shared/domain/sales-approach（モックと同一関数・同一順 = パリティ）。
 * エラー: AKO-SAP-001 入力不正 / 002 不在 / 003 1社1行の重複。
 *   （営業活動〔案件〕の AKO-SAL とは別領域として AKO-SAP を用いる）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { capCodePoints } from '../../../shared/domain/customer-log'
import {
  SALES_APPROACH_ACTION_CAP, SALES_APPROACH_NOTE_CAP,
  salesApproachError, type SalesApproachInput,
} from '../../../shared/domain/sales-approach'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

const COLS = `sa.id, sa.member_id AS "memberId", sa.company_id AS "companyId", sa.status, sa.priority,
  sa.assignee_member_id AS "assigneeMemberId", sa.next_action AS "nextAction",
  sa.next_action_date::text AS "nextActionDate", sa.note, sa.active,
  to_char(sa.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(sa.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

function str(v: unknown, cap: number): string {
  return capCodePoints(String(v ?? '').trim(), cap)
}

function strOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s || null
}

function inputOf(b: Record<string, unknown>, userId: string): SalesApproachInput {
  return {
    companyId: String(b.companyId ?? '').trim(),
    status: String(b.status ?? '').trim(),
    priority: String(b.priority ?? '').trim(),
    assigneeMemberId: String(b.assigneeMemberId ?? '').trim() || userId,
    nextAction: str(b.nextAction, SALES_APPROACH_ACTION_CAP),
    nextActionDate: strOrNull(b.nextActionDate),
    note: str(b.note, SALES_APPROACH_NOTE_CAP),
  }
}

function assertValid(message: string | null): void {
  if (message) throw err('AKO-SAP-001', message, 400)
}

/** FK 違反（23503）= 紐付け先不在（400）/ UNIQUE 違反（23505）= 1社1行の重複（409） */
function writeError(e: unknown): never {
  const code = (e as { code?: string }).code
  if (code === '23503') throw err('AKO-SAP-001', '紐付け先（顧客・担当メンバー）が見つかりません', 400)
  if (code === '23505') {
    throw err('AKO-SAP-003', 'この顧客は既にアプローチリストに登録されています（取消済みの場合は復元してください）', 409)
  }
  throw e
}

async function findRow(pool: pg.Pool, id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM sales_approaches sa WHERE id = $1`, [id])
  if (!rows[0]) throw err('AKO-SAP-002', '営業アプローチが見つかりません', 404)
  return rows[0]
}

/** 対象は顧客(会社)のみ（kind='customer'。自社 self は登録不可 = フロントの候補絞り込みと同一判定・レビュー R1） */
async function requireCustomerCompany(pool: pg.Pool, companyId: string): Promise<void> {
  const { rows } = await pool.query<{ kind: string }>(`SELECT kind FROM companies WHERE id = $1`, [companyId])
  if (!rows[0]) throw err('AKO-SAP-001', '紐付け先（顧客・担当メンバー）が見つかりません', 400)
  if (rows[0].kind !== 'customer') throw err('AKO-SAP-001', '顧客(会社)のみ登録できます（自社は対象外です）', 400)
}

export function salesApproachesRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一覧（取消済み込みの全量ハイドレーション = customer-contexts と同じ設計判断: 1社1行のため
  // 件数上限は顧客数。並びは優先度 → 状態はフロントの表示ソートが担い、ここでは作成降順で安定返却）
  app.get('/', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM sales_approaches sa ORDER BY sa.created_at DESC, sa.id DESC`)
    return c.json({ data: rows })
  })

  // 登録（全員可・1社1行）
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = inputOf(b, user.id)
    assertValid(salesApproachError(input))
    await requireCustomerCompany(pool, input.companyId)
    const id = newId('sap')
    try {
      await pool.query(
        `INSERT INTO sales_approaches
           (id, member_id, company_id, status, priority, assignee_member_id, next_action, next_action_date, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
        [id, user.id, input.companyId, input.status, input.priority, input.assigneeMemberId,
          input.nextAction, input.nextActionDate, input.note])
    } catch (e) {
      writeError(e)
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'sales_approaches', entityId: id,
      detail: '営業アプローチを登録',
    })
    return c.json({ data: await findRow(pool, id) }, 201)
  })

  // 編集（全員可 = チーム共有。送られたキーのみ更新 = 部分更新の安全側 → マージ後に shared 宣言順で全体検証）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findRow(pool, id) as unknown as SalesApproachInput
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const merged: SalesApproachInput = {
      companyId: has('companyId') ? String(b.companyId ?? '').trim() : cur.companyId,
      status: has('status') ? String(b.status ?? '').trim() : cur.status,
      priority: has('priority') ? String(b.priority ?? '').trim() : cur.priority,
      assigneeMemberId: has('assigneeMemberId')
        ? (String(b.assigneeMemberId ?? '').trim() || user.id) : cur.assigneeMemberId,
      nextAction: has('nextAction') ? str(b.nextAction, SALES_APPROACH_ACTION_CAP) : cur.nextAction,
      nextActionDate: has('nextActionDate') ? strOrNull(b.nextActionDate) : cur.nextActionDate,
      note: has('note') ? str(b.note, SALES_APPROACH_NOTE_CAP) : cur.note,
    }
    assertValid(salesApproachError(merged))
    await requireCustomerCompany(pool, merged.companyId)
    try {
      await pool.query(
        `UPDATE sales_approaches
         SET company_id = $2, status = $3, priority = $4, assignee_member_id = $5,
             next_action = $6, next_action_date = $7::date, note = $8, updated_at = now()
         WHERE id = $1`,
        [id, merged.companyId, merged.status, merged.priority, merged.assigneeMemberId,
          merged.nextAction, merged.nextActionDate, merged.note])
    } catch (e) {
      writeError(e)
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'sales_approaches', entityId: id,
      detail: '営業アプローチを編集',
    })
    return c.json({ data: await findRow(pool, id) })
  })

  // 取消/復元（論理削除。全員可・冪等: 条件付き UPDATE で同時実行でも監査ログは 1 回だけ = activities と同型）
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, id)
    const upd = await pool.query(
      `UPDATE sales_approaches SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'sales_approaches', entityId: id, detail: '営業アプローチを取消' })
    return c.json({ data: { id } })
  })

  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findRow(pool, id)
    const upd = await pool.query(
      `UPDATE sales_approaches SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'sales_approaches', entityId: id, detail: '営業アプローチを復元' })
    return c.json({ data: { id } })
  })

  return app
}
