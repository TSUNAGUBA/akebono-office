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
import { canUseFeature } from '../../../shared/domain/permissions'
import { requireAdmin, requireHrOrAdmin, type AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { activePermissionRules, clearPermissionCache, stripMasterFields, subjectOf } from '../lib/permissions'
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

/** 既定シードの画像セクション（is_seed）は無効化不可（名称変更は可 = モック UI の isSeedLocked と同じ保護） */
async function imageSectionSeedGuard(pool: pg.Pool, id: string): Promise<void> {
  const { rows } = await pool.query<{ is_seed: boolean }>(
    'SELECT is_seed FROM product_image_sections WHERE id = $1', [id])
  if (rows[0]?.is_seed) {
    throw err('AKO-AKB-002', '既定シードの画像セクションは無効化できません（名称変更は可能です）', 409)
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

/**
 * goals の部分更新でも metric × segmentId × 値域（report_rate = 全社・0-100）の不変条件を
 * 破らせない（workflowRouteCrossGuard と同型: POST は schema の superRefine が担うが、
 * .partial() 由来の patchSchema ではクロスフィールド検証ができないため、既存行とマージした
 * 結果で検証する。DB 側も 0039 の CHECK 制約で二重防衛）
 */
async function goalCrossGuard(
  pool: pg.Pool,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const { rows } = await pool.query<{ metric: string; segmentId: string | null; monthlyValue: number }>(
    `SELECT metric, segment_id AS "segmentId", monthly_value::float8 AS "monthlyValue"
     FROM goals WHERE id = $1`, [id])
  const existing = rows[0]
  if (!existing) return // 対象なしは後段の UPDATE が 404 を返す
  const metric = 'metric' in body ? String(body.metric) : existing.metric
  const segmentId = 'segmentId' in body ? (body.segmentId as string | null) : existing.segmentId
  const monthlyValue = 'monthlyValue' in body ? Number(body.monthlyValue) : existing.monthlyValue
  if (metric === 'segment_sales' && !segmentId) {
    throw err('AKO-GEN-001', '業態売上の目標は対象業態を指定してください', 400)
  }
  if (metric === 'report_rate') {
    if (segmentId) {
      throw err('AKO-GEN-001', '日報提出率の目標は全社です（業態は指定できません）', 400)
    }
    if (monthlyValue > 100) {
      throw err('AKO-GEN-001', '日報提出率は 0〜100 で入力してください', 400)
    }
  }
}

/**
 * goals（経営目標 = C2）の一覧参照のサーバー側行フィルタ（システム監査指摘 2026-07-29。
 * hr の絞り込みはレビュー2巡目 G2 = 運用デフォルト pr-def-05（hr sales deny）と整合させる）。
 * - admin / sales 機能を許可されたユーザー（canUseFeature = F-16 のレイヤ解決。ルール未設定は
 *   既定 allow = 下位互換）→ 全件
 * - hr（sales deny）→ report_rate 全件（提出率予報の材料 = 全社目標）+ 自分の担当業態
 *   （members.segment_ids）の segment_sales 行（他業態の経営数字は返さない）
 * - それ以外 → 自分の担当業態の segment_sales 行のみ（report_rate = 全社目標は含めない）。
 * 汎用 CRUD の他エンティティへ影響させない goals 専用の特例
 * （事業予報: segmentIds を持つ一般メンバーは自業態の目標を従来どおり取得できる）
 */
async function filterGoalRows(
  pool: pg.Pool,
  user: AuthUser,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (user.role === 'admin') return rows
  const rules = await activePermissionRules(pool)
  if (canUseFeature(rules, subjectOf(user), 'sales')) return rows
  const { rows: memberRows } = await pool.query<{ segmentIds: string[] | null }>(
    'SELECT segment_ids AS "segmentIds" FROM members WHERE id = $1', [user.id])
  const mine = new Set(memberRows[0]?.segmentIds ?? [])
  const isMySegmentSales = (r: Record<string, unknown>): boolean =>
    r.metric === 'segment_sales' && typeof r.segmentId === 'string' && mine.has(r.segmentId)
  if (user.role === 'hr') return rows.filter(r => r.metric === 'report_rate' || isMySegmentSales(r))
  return rows.filter(isMySegmentSales)
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
    const hasOrder = ['departments', 'leave_types', 'industries', 'work_categories', 'custom_field_defs', 'code_masters', 'external_links',
      // Akebono 設定系（Phase B。payment_terms / consignment_terms は display_order 列なし = id 順）
      'business_segments', 'warehouses', 'units', 'tax_rates', 'variant_axis_templates', 'product_categories', 'product_image_sections'].includes(def.table)
    const orderBy = def.table === 'public_holidays' ? 'ORDER BY date' : hasOrder ? order : 'ORDER BY id'
    const { rows } = await pool.query(
      `SELECT * FROM ${def.table} ${where} ${orderBy}`)
    let list = rows.map(rowToCamel)
    if (entity === 'goals') list = await filterGoalRows(pool, c.get('user'), list) // C2 の行フィルタ（goals 専用）
    const data = await stripMasterFields(pool, c.get('user'), entity, list)
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
    // 既定シードは migration 投入のみ。API で is_seed=true を作らせない（作れると archive が
    // AKO-AKB-002 で恒久拒否・PATCH も isSeed を omit しており取消不能行になる = 原則9.5。レビュー B-1）
    if (entity === 'product-image-sections' && body.isSeed) {
      throw err('AKO-AKB-002', '既定シードの画像セクションは追加できません（migration 投入のみ）', 409)
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
      // CHECK 制約違反（例: goals の metric × segmentId × 値域 = 0039）。アプリ側ガードの最終防衛が
      // 発火した場合も 500 でなく想定エラーとして返す（レビュー2巡目 G4）
      if ((e as { code?: string }).code === '23514') {
        throw err('AKO-GEN-001', '入力値の組み合わせがデータ整合性の制約に違反しています。入力内容を確認してください', 400)
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
    if (entity === 'goals' && ('metric' in body || 'segmentId' in body || 'monthlyValue' in body)) {
      await goalCrossGuard(pool, id, body)
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
      // CHECK 制約違反（例: goals の metric × segmentId × 値域 = 0039）。アプリ側ガードの最終防衛が
      // 発火した場合も 500 でなく想定エラーとして返す（レビュー2巡目 G4）
      if ((e as { code?: string }).code === '23514') {
        throw err('AKO-GEN-001', '入力値の組み合わせがデータ整合性の制約に違反しています。入力内容を確認してください', 400)
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
    if (entity === 'product-image-sections') await imageSectionSeedGuard(pool, id)
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
