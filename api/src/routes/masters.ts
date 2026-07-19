/**
 * 汎用マスタ CRUD（/v1/masters/:entity）。mockup useMasterCrud の API 版。
 * - 参照は認証済みなら誰でも可（氏名・部署名等は全画面で必要）
 * - 変更は管理者のみ。休暇種別と勤怠ルールの変更は管理者または人事も可
 * - 論理削除（archive/restore）。関係エッジのみ物理 DELETE（監査ログ必須）
 * - エンティティ固有ガード:
 *   departments: 所属者あり無効化不可(AKO-DEP-001) / 子部署あり無効化不可(AKO-DEP-002) / 循環親子(AKO-DEP-003)
 *   leave-types: 法定有給の編集・無効化不可(AKO-LEV-008)
 *   attendance-rules: defaultFor の区分ごと 1 ルール排他（保存時に他ルールから自動で外す）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin, requireHrOrAdmin, type AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { clearPermissionCache, stripMasterFields } from '../lib/permissions'
import { scheduleSearchRebuild, SEARCH_RELEVANT_ENTITIES } from '../lib/search-index'
import { camelToSnake, MASTERS, rowToCamel, type MasterEntity } from '../masters/registry'

function defOf(entity: string) {
  const def = MASTERS[entity as MasterEntity]
  if (!def) throw err('AKO-GEN-002', `未知のマスタです: ${entity}`, 404)
  return { def, entity: entity as MasterEntity }
}

/** 変更系の権限ガード（休暇種別・勤怠ルールは人事も可、それ以外は管理者のみ） */
function requireMutator(c: Parameters<typeof requireAdmin>[0], entity: MasterEntity): AuthUser {
  return entity === 'leave-types' || entity === 'attendance-rules' ? requireHrOrAdmin(c) : requireAdmin(c)
}

async function departmentArchiveGuard(pool: pg.Pool, id: string): Promise<void> {
  const members = await pool.query(
    'SELECT count(*)::int AS n FROM members WHERE department_id = $1 AND active = true', [id])
  if ((members.rows[0]?.n ?? 0) > 0) {
    throw err('AKO-DEP-001', `所属メンバーが ${members.rows[0].n} 名います。先に配属を変更してください`, 409)
  }
  const children = await pool.query(
    'SELECT count(*)::int AS n FROM departments WHERE parent_id = $1 AND active = true', [id])
  if ((children.rows[0]?.n ?? 0) > 0) {
    throw err('AKO-DEP-002', '配下に有効な部署があります。先に親部署を変更してください', 409)
  }
}

/** 部署の循環親子チェック（id の子孫（自身含む）を親に指定できない） */
async function departmentCycleGuard(pool: pg.Pool, id: string, parentId: string | null): Promise<void> {
  if (!parentId) return
  const { rows } = await pool.query<{ id: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM departments WHERE id = $1
       UNION ALL
       SELECT d.id FROM departments d JOIN descendants s ON d.parent_id = s.id
     )
     SELECT id FROM descendants WHERE id = $2 LIMIT 1`,
    [id, parentId],
  )
  if (rows.length > 0) {
    throw err('AKO-DEP-003', '自部署または配下の部署を親にはできません（循環防止）', 409)
  }
}

async function leaveTypeStatutoryGuard(pool: pg.Pool, id: string): Promise<void> {
  const { rows } = await pool.query<{ is_statutory: boolean }>(
    'SELECT is_statutory FROM leave_types WHERE id = $1', [id])
  if (rows[0]?.is_statutory) {
    throw err('AKO-LEV-008', '法定有給は編集・無効化できません', 409)
  }
}

/** defaultFor の区分ごと 1 ルール排他（保存対象の区分を他ルールの defaultFor から外す） */
async function exclusiveDefaultFor(db: pg.PoolClient, ruleId: string, defaultFor: string[]): Promise<void> {
  if (defaultFor.length === 0) return
  await db.query(
    `UPDATE attendance_rules
     SET default_for = (
       SELECT coalesce(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(default_for) AS v
       WHERE NOT (v.value = ANY($2::text[]))
     ), updated_at = now()
     WHERE id <> $1 AND default_for ?| $2::text[]`,
    [ruleId, defaultFor],
  )
}

/**
 * workflow-routes の部分更新でも「上限 <= 下限」「steps.order 重複」を許さない
 * （POST は schema の superRefine が担うが、.partial() 由来の patchSchema では
 * クロスフィールド検証ができないため、既存行とマージした結果で検証する）
 */
async function workflowRouteCrossGuard(
  pool: pg.Pool,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const { rows } = await pool.query<{ minAmount: number; maxAmount: number | null; steps: { order: number }[] }>(
    `SELECT min_amount::float8 AS "minAmount", max_amount::float8 AS "maxAmount", steps
     FROM workflow_routes WHERE id = $1`, [id])
  const existing = rows[0]
  if (!existing) return // 対象なしは後段の UPDATE が 404 を返す
  const minAmount = 'minAmount' in body ? Number(body.minAmount) : existing.minAmount
  const maxAmount = 'maxAmount' in body
    ? (body.maxAmount === null ? null : Number(body.maxAmount))
    : existing.maxAmount
  if (maxAmount !== null && maxAmount <= minAmount) {
    throw err('AKO-GEN-001', '上限金額は下限金額より大きくしてください', 400)
  }
  const steps = ('steps' in body ? body.steps : existing.steps) as { order: number }[]
  if (Array.isArray(steps) && new Set(steps.map(s => s.order)).size !== steps.length) {
    throw err('AKO-GEN-001', '承認ステップの順序（order）が重複しています', 400)
  }
}

function toSqlValue(def: { jsonbFields: string[] }, field: string, value: unknown): unknown {
  return def.jsonbFields.includes(field) ? JSON.stringify(value) : value
}

export function mastersRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // マスタ書込後の検索インデックス自動再生成（AI 検索最適化。デバウンス・非ブロッキング = 原則4。
  // 権限キャッシュのクリアと同じ「書込後フック」パターン）
  const refreshSearchIndex = (entity: MasterEntity): void => {
    if (SEARCH_RELEVANT_ENTITIES.has(entity)) scheduleSearchRebuild(pool, env, `masters:${entity}`)
  }

  // 一覧（includeInactive=1 で無効も含む）。表示項目レベルの権限ルールがある場合はフィールドを剥がす（F-16）
  app.get('/:entity', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const where = def.noActive || c.req.query('includeInactive') === '1' ? '' : 'WHERE active = true'
    const order = def.noActive ? 'ORDER BY id' : 'ORDER BY display_order NULLS LAST, id'
    // display_order を持たないテーブルは id 順（祝日は日付順が自然なため date 順）
    const hasOrder = ['departments', 'leave_types', 'industries', 'work_categories', 'custom_field_defs', 'code_masters', 'external_links'].includes(def.table)
    const orderBy = def.table === 'public_holidays' ? 'ORDER BY date' : hasOrder ? order : 'ORDER BY id'
    const { rows } = await pool.query(
      `SELECT * FROM ${def.table} ${where} ${orderBy}`)
    const data = await stripMasterFields(pool, c.get('user'), entity, rows.map(rowToCamel))
    return c.json({ data })
  })

  // 追加
  app.post('/:entity', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const user = requireMutator(c, entity)
    const parsed = def.schema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      throw err('AKO-GEN-001', parsed.error.issues[0]?.message ?? '入力内容を確認してください', 400)
    }
    const body = parsed.data as Record<string, unknown>
    if (entity === 'leave-types' && body.isStatutory) {
      throw err('AKO-LEV-008', '法定有給は追加できません（シード固定）', 409)
    }
    const id = newId(def.idPrefix)
    const fields = Object.keys(body)
    const cols = ['id', ...fields.map(camelToSnake)]
    const params = [id, ...fields.map(f => toSqlValue(def, f, body[f]))]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        params,
      )
      if (entity === 'attendance-rules') {
        await exclusiveDefaultFor(client, id, (body.defaultFor as string[]) ?? [])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-GEN-003', '同じ値のデータが既に存在します（重複）', 409)
      }
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: 'create', entity: def.table, entityId: id, detail: `${entity} を追加` })
    if (entity === 'permission-rules') clearPermissionCache() // 権限キャッシュをクリア（同一インスタンスは即時・他インスタンスは TTL 10 秒で追随）
    refreshSearchIndex(entity)
    const { rows } = await pool.query(`SELECT * FROM ${def.table} WHERE id = $1`, [id])
    return c.json({ data: rowToCamel(rows[0]) }, 201)
  })

  // 更新（部分更新）
  app.patch('/:entity/:id', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const user = requireMutator(c, entity)
    if (!def.patchSchema) throw err('AKO-GEN-002', '関係エッジは更新できません（削除して再登録）', 405)
    const id = c.req.param('id')
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const parsed = def.patchSchema.safeParse(raw)
    if (!parsed.success) {
      throw err('AKO-GEN-001', parsed.error.issues[0]?.message ?? '入力内容を確認してください', 400)
    }
    // 重要: zod v4 の .partial() は .default() 付きフィールドへ既定値を注入する。
    // そのまま UPDATE すると部分更新のつもりが未指定列を既定値で上書きしてしまう
    // （実障害: 部署配属 {departmentId} で members.email が空・role が member に巻き戻った）。
    // リクエスト body に実際に含まれるキーのみを更新対象にする。
    const body = Object.fromEntries(
      Object.entries(parsed.data as Record<string, unknown>).filter(([k]) => Object.hasOwn(raw, k)))
    if (Object.keys(body).length === 0) throw err('AKO-GEN-001', '更新内容がありません', 400)

    if (entity === 'leave-types') await leaveTypeStatutoryGuard(pool, id)
    if (entity === 'departments' && 'parentId' in body) {
      await departmentCycleGuard(pool, id, body.parentId as string | null)
    }
    if (entity === 'workflow-routes' && ('minAmount' in body || 'maxAmount' in body || 'steps' in body)) {
      await workflowRouteCrossGuard(pool, id, body)
    }

    const fields = Object.keys(body)
    const sets = fields.map((f, i) => `${camelToSnake(f)} = $${i + 2}`)
    const params = [id, ...fields.map(f => toSqlValue(def, f, body[f]))]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE ${def.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params)
      if (result.rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
      if (entity === 'attendance-rules' && 'defaultFor' in body) {
        await exclusiveDefaultFor(client, id, (body.defaultFor as string[]) ?? [])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-GEN-003', '同じ値のデータが既に存在します（重複）', 409)
      }
      throw e
    } finally {
      client.release()
    }
    await audit(pool, { actorId: user.id, action: 'update', entity: def.table, entityId: id, detail: `${entity} を更新` })
    if (entity === 'permission-rules') clearPermissionCache() // 権限キャッシュをクリア（同一インスタンスは即時・他インスタンスは TTL 10 秒で追随）
    refreshSearchIndex(entity)
    const { rows } = await pool.query(`SELECT * FROM ${def.table} WHERE id = $1`, [id])
    return c.json({ data: rowToCamel(rows[0]) })
  })

  // 論理削除 / 再有効化
  app.post('/:entity/:id/archive', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const user = requireMutator(c, entity)
    if (def.noActive) throw err('AKO-GEN-002', 'このマスタは無効化できません', 405)
    const id = c.req.param('id')
    if (entity === 'departments') await departmentArchiveGuard(pool, id)
    if (entity === 'leave-types') await leaveTypeStatutoryGuard(pool, id)
    const result = await pool.query(
      `UPDATE ${def.table} SET active = false, updated_at = now() WHERE id = $1`, [id])
    if (result.rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'archive', entity: def.table, entityId: id, detail: `${entity} を無効化` })
    if (entity === 'permission-rules') clearPermissionCache() // 権限キャッシュをクリア（同一インスタンスは即時・他インスタンスは TTL 10 秒で追随）
    refreshSearchIndex(entity)
    return c.json({ data: { id } })
  })

  app.post('/:entity/:id/restore', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const user = requireMutator(c, entity)
    if (def.noActive) throw err('AKO-GEN-002', 'このマスタは復元できません', 405)
    const id = c.req.param('id')
    const result = await pool.query(
      `UPDATE ${def.table} SET active = true, updated_at = now() WHERE id = $1`, [id])
    if (result.rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'restore', entity: def.table, entityId: id, detail: `${entity} を再有効化` })
    if (entity === 'permission-rules') clearPermissionCache() // 権限キャッシュをクリア（同一インスタンスは即時・他インスタンスは TTL 10 秒で追随）
    refreshSearchIndex(entity)
    return c.json({ data: { id } })
  })

  // 物理削除（関係エッジ + 未使用の関係種別のみ。監査ログ必須 = 設計判断）
  app.delete('/:entity/:id', async (c) => {
    const { def, entity } = defOf(c.req.param('entity'))
    const user = requireMutator(c, entity)
    if (!def.physicalDelete) throw err('AKO-GEN-002', 'このマスタは物理削除できません（論理削除を使用）', 405)
    const id = c.req.param('id')
    // 関係種別は関係エッジから参照中なら削除不可（エッジの種別喪失を防ぐ。無効化を案内）。
    // 参照確認と削除は単文で行う（確認と削除の間にエッジが追加される競合を防ぐ）
    if (entity === 'relation-types') {
      const del = await pool.query(
        `DELETE FROM relation_types WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM company_relations WHERE relation_type_id = $1)
           AND NOT EXISTS (SELECT 1 FROM contact_relations WHERE relation_type_id = $1)`, [id])
      if (del.rowCount === 0) {
        const { rows } = await pool.query(`SELECT 1 FROM relation_types WHERE id = $1`, [id])
        if (rows.length === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
        throw err('AKO-RTM-001', 'この関係種別は既存の関係で使用中のため削除できません（無効化を使用してください）', 409)
      }
      await audit(pool, { actorId: user.id, action: 'delete', entity: def.table, entityId: id, detail: `${entity} を物理削除` })
      refreshSearchIndex(entity)
      return c.json({ data: { id } })
    }
    const result = await pool.query(`DELETE FROM ${def.table} WHERE id = $1`, [id])
    if (result.rowCount === 0) throw err('AKO-GEN-002', '対象が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'delete', entity: def.table, entityId: id, detail: `${entity} を物理削除` })
    refreshSearchIndex(entity)
    return c.json({ data: { id } })
  })

  return app
}
