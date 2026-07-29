/**
 * AKEBONO API（F-03 + Phase B 設定系）。
 * - akebono_wishes は記録系（追記のみ）。編集・削除は設けない。参照・投稿は認証済み全員（社内 C2）
 * - Phase B（0031）: 業態×アプリ設定（akebono_app_configs）と項目カスタマイズ（item_settings）。
 *   どちらも汎用マスタ registry（id 主キーの行 CRUD）に合わないため専用エンドポイント:
 *   app-configs は複合キー (segmentId, appKey) の upsert（プリセット materialize を含むバッチ書込）、
 *   item-settings は複合キー (entity, itemKey) の差分 upsert + エンティティ単位のリセット
 *   （= カタログ既定へ戻す取消フロー。原則9.5）。カタログ（アプリ・項目の定義）はフロント静的 SoT の
 *   ため、サーバーはキーの形式検証のみ行う（存在検証はしない = 設計判断）
 * - 参照は全員（メニュー表示・項目解決に全画面が使う）。書込は管理者のみ（設定画面の管理者ゲートと一致）
 * エラー: AKO-AKB-001（要望未入力）/ AKO-AKB-002（既定シード画像セクションの無効化・作成拒否 = masters.ts）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { capCp } from '../lib/text'

// ---------- Phase B: 入力検証（純粋関数・単体テスト対象） ----------

export interface AppConfigRow {
  segmentId: string
  appKey: string
  enabled: boolean
  labelOverride: string | null
  source: 'preset' | 'manual'
}

/**
 * 業態×アプリ設定のバッチ upsert 入力を検証・正規化する（不正は null = AKO-GEN-001）。
 * 同一 (segmentId, appKey) の重複行は後勝ちで畳む（単一 upsert 文の
 * 「ON CONFLICT DO UPDATE command cannot affect row a second time」エラーを防ぐ = 冪等）
 */
export function appConfigRowsOf(body: unknown): AppConfigRow[] | null {
  const rows = (body as { rows?: unknown })?.rows
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) return null
  const byKey = new Map<string, AppConfigRow>()
  for (const r of rows) {
    const o = r as Record<string, unknown> | null
    if (!o || typeof o !== 'object') return null
    const segmentId = String(o.segmentId ?? '').trim()
    const appKey = String(o.appKey ?? '').trim()
    if (!segmentId || segmentId.length > 64 || !appKey || appKey.length > 40) return null
    byKey.set(`${segmentId}:${appKey}`, {
      segmentId,
      appKey,
      enabled: o.enabled === true,
      labelOverride: typeof o.labelOverride === 'string' && o.labelOverride.trim()
        ? capCp(o.labelOverride.trim(), 60)
        : null,
      source: o.source === 'preset' ? 'preset' : 'manual',
    })
  }
  return [...byKey.values()]
}

export interface ItemSettingPatch {
  formVisible?: boolean | null
  formRequired?: boolean | null
  listVisible?: boolean | null
  displayOrder?: number | null
  labelOverride?: string | null
}

/**
 * 項目カスタマイズの部分 upsert 入力（body に実在するキーのみ = Object.hasOwn。
 * CLAUDE.md の Zod v4 注意と同じく「送っていないフィールドの保持」を構造的に保証する）。
 * null は「カタログ既定へ戻す」明示値として通す（差分テーブルの意味論）
 */
export function itemSettingPatchOf(body: Record<string, unknown>): ItemSettingPatch | null {
  const out: ItemSettingPatch = {}
  const boolOrNull = (v: unknown): boolean | null | undefined =>
    v === null ? null : v === true || v === false ? v : undefined
  for (const key of ['formVisible', 'formRequired', 'listVisible'] as const) {
    if (!Object.hasOwn(body, key)) continue
    const v = boolOrNull(body[key])
    if (v === undefined) return null
    out[key] = v
  }
  if (Object.hasOwn(body, 'displayOrder')) {
    const v = body.displayOrder
    if (v === null) out.displayOrder = null
    else if (Number.isInteger(v) && Math.abs(v as number) <= 10_000) out.displayOrder = v as number
    else return null
  }
  if (Object.hasOwn(body, 'labelOverride')) {
    const v = body.labelOverride
    if (v === null) out.labelOverride = null
    else if (typeof v === 'string') out.labelOverride = capCp(v.trim(), 60) || null
    else return null
  }
  return out
}

const WISH_COLS = `id, member_id AS "memberId", body, at`
/** 要望本文の上限（コードポイント） */
const WISH_BODY_CAP = 2000

export function akebonoRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 要望一覧（新しい順。表示名はフロントが members マスタキャッシュから解決）
  app.get('/wishes', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${WISH_COLS} FROM akebono_wishes ORDER BY at DESC, id LIMIT 500`)
    return c.json({ data: rows })
  })

  // 要望の投稿（追記のみ = 記録系）
  app.post('/wishes', async (c) => {
    const user = c.get('user')
    const reqBody = await c.req.json().catch(() => ({})) as { body?: unknown }
    const body = capCp(String(reqBody.body ?? '').trim(), WISH_BODY_CAP)
    if (!body) throw err('AKO-AKB-001', '要望を入力してください', 400)
    const id = newId('aw')
    await pool.query(
      `INSERT INTO akebono_wishes (id, member_id, body, at) VALUES ($1, $2, $3, $4)`,
      [id, user.id, body, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  // ---------- 業態×アプリ設定（Phase B。複合キー = (segmentId, appKey) の upsert） ----------

  const APP_CONFIG_COLS = `segment_id AS "segmentId", app_key AS "appKey", enabled,
    label_override AS "labelOverride", source`

  // 一覧（全員可 = 業態メニューの表示判定に全画面が使う。行が無い業態はフロントがプリセットへフォールバック）
  app.get('/app-configs', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${APP_CONFIG_COLS} FROM akebono_app_configs ORDER BY segment_id, app_key LIMIT 2000`)
    return c.json({ data: rows })
  })

  // バッチ upsert（管理者のみ）。setEnabled / setLabel / applyPreset / プリセット materialize が
  // 変更行だけを 1 リクエストで送る。冪等（同じ rows の再送は同じ結果）・他業態の行には触れない
  app.put('/app-configs', async (c) => {
    const user = requireAdmin(c)
    const rows = appConfigRowsOf(await c.req.json().catch(() => ({})))
    if (!rows) throw err('AKO-GEN-001', 'rows（業態×アプリ設定）を 1〜200 件で指定してください', 400)
    const saved: Record<string, unknown>[] = []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        const { rows: upserted } = await client.query(
          `INSERT INTO akebono_app_configs (segment_id, app_key, enabled, label_override, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (segment_id, app_key) DO UPDATE SET
             enabled = EXCLUDED.enabled, label_override = EXCLUDED.label_override,
             source = EXCLUDED.source, updated_at = now()
           RETURNING ${APP_CONFIG_COLS}`,
          [r.segmentId, r.appKey, r.enabled, r.labelOverride, r.source])
        saved.push(upserted[0]!)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'akebono_app_configs',
      entityId: rows[0]!.segmentId, detail: `業態アプリ設定を更新（${rows.length} 件）`,
    })
    return c.json({ data: saved })
  })

  // ---------- 項目カスタマイズ（Phase B。差分の upsert + エンティティ単位リセット） ----------

  const ITEM_SETTING_COLS = `id, app_key AS "appKey", entity, item_key AS "itemKey",
    form_visible AS "formVisible", form_required AS "formRequired", list_visible AS "listVisible",
    display_order AS "displayOrder", label_override AS "labelOverride"`

  app.get('/item-settings', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${ITEM_SETTING_COLS} FROM item_settings ORDER BY entity, item_key LIMIT 2000`)
    return c.json({ data: rows })
  })

  // 部分 upsert（管理者のみ）。body に実在するキーのみ更新（未送信フィールドは保持 = itemSettingPatchOf）
  app.put('/item-settings', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const entity = String(body.entity ?? '').trim()
    const itemKey = String(body.itemKey ?? '').trim()
    if (!entity || entity.length > 64 || !itemKey || itemKey.length > 64) {
      throw err('AKO-GEN-001', 'entity / itemKey を指定してください', 400)
    }
    const patch = itemSettingPatchOf(body)
    if (!patch) throw err('AKO-GEN-001', '項目カスタマイズの入力が不正です', 400)
    if (Object.keys(patch).length === 0) throw err('AKO-GEN-001', '更新内容がありません', 400)
    // 送信されたキーのみ EXCLUDED から反映（media_settings と同じ部分 upsert パターン）
    const setCols: string[] = ['updated_at = now()']
    if (patch.formVisible !== undefined) setCols.push('form_visible = EXCLUDED.form_visible')
    if (patch.formRequired !== undefined) setCols.push('form_required = EXCLUDED.form_required')
    if (patch.listVisible !== undefined) setCols.push('list_visible = EXCLUDED.list_visible')
    if (patch.displayOrder !== undefined) setCols.push('display_order = EXCLUDED.display_order')
    if (patch.labelOverride !== undefined) setCols.push('label_override = EXCLUDED.label_override')
    const { rows } = await pool.query(
      `INSERT INTO item_settings (id, app_key, entity, item_key, form_visible, form_required, list_visible, display_order, label_override)
       VALUES ($1, 'akebono', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (app_key, entity, item_key) DO UPDATE SET ${setCols.join(', ')}
       RETURNING ${ITEM_SETTING_COLS}`,
      [newId('is'), entity, itemKey,
        patch.formVisible ?? null, patch.formRequired ?? null, patch.listVisible ?? null,
        patch.displayOrder ?? null, patch.labelOverride ?? null])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'item_settings',
      entityId: `${entity}:${itemKey}`, detail: '項目カスタマイズを更新',
    })
    return c.json({ data: rows[0] })
  })

  // エンティティ単位のリセット（管理者のみ）= カタログ既定へ戻す取消フロー（原則9.5。差分の物理削除）
  app.post('/item-settings/reset', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const entity = String(body.entity ?? '').trim()
    if (!entity || entity.length > 64) throw err('AKO-GEN-001', 'entity を指定してください', 400)
    const result = await pool.query(
      `DELETE FROM item_settings WHERE app_key = 'akebono' AND entity = $1`, [entity])
    await audit(pool, {
      actorId: user.id, action: 'delete', entity: 'item_settings',
      entityId: entity, detail: `項目カスタマイズをリセット（${result.rowCount ?? 0} 件削除 = カタログ既定へ）`,
    })
    return c.json({ data: { entity, deleted: result.rowCount ?? 0 } })
  })

  return app
}
