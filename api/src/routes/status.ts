/**
 * 提供システム稼働状況 API（F-11）。mockup useSystemStatus の API 版。
 * - system_services はマスタ的（0018 でシード投入。参照は認証済み全員 = 機能ガード 'status' が前段）
 * - service_incidents は記録系: updates への追記のみ。status / resolved_at はその射影。
 *   ライフサイクルは investigating → identified → monitoring → resolved の正順のみ（FOR UPDATE で直列化）
 * - uptime_daily は導出データ（SoT = インシデント）。shared/domain/uptime の純粋関数で日次集計し、
 *   非 operational の日のみ格納。再計算は窓内 DELETE→INSERT のトランザクション = 冪等。
 *   トリガ: インシデント作成/更新時（イベント）+ /jobs/uptime-rollup（日次）+ 管理者の手動再計算（回復パス）
 * - GET は一括ハイドレーション（services + incidents + 90 日分の uptime を operational 埋めで返却 =
 *   フロントの表示射影はモックと共通のまま）
 * - 登録・状況更新は管理者のみ。成功後の管理者通知は非ブロッキング（原則4）
 * エラー: AKO-STS-001（サービスなし）/ 002（タイトル未入力）/ 003（インシデントなし）/
 *         004（正順以外の遷移）/ 005（状況説明未入力）/ 006（影響度不正）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { IncidentStatus, ServiceIncident } from '../../../shared/domain/types'
import { computeUptimeDaily } from '../../../shared/domain/uptime'
import { requireAdmin } from '../auth'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notifyAdmins } from '../lib/notify'

const UPTIME_WINDOW_DAYS = 90
const INCIDENT_STATUS_ORDER: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved']
const STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: '調査中', identified: '原因特定', monitoring: '経過観察', resolved: '解決済み',
}
const IMPACTS = new Set(['minor', 'major', 'critical'])

const SERVICE_COLS = `id, name, description, url, components`
const INCIDENT_COLS = `id, service_id AS "serviceId", title, impact, status, updates,
  started_at AS "startedAt", resolved_at AS "resolvedAt"`

/** コードポイント単位の切詰め（サロゲートペアを境界で壊さない） */
function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

/**
 * uptime_daily の再計算（サービス単位・[fromDate, toDate] 窓・冪等）。
 * SoT = service_incidents から導出し、窓内を DELETE → 非 operational の日のみ INSERT する。
 * インシデント作成/更新・日次ジョブ・手動回復の全経路がこの 1 実装を使う（原則3）。
 */
export async function recomputeUptime(
  pool: pg.Pool,
  serviceId: string | null,
  fromDate: string,
  toDate: string,
): Promise<{ services: number; rows: number }> {
  const { rows: services } = await pool.query<{ id: string }>(
    `SELECT id FROM system_services WHERE active = true AND ($1::text IS NULL OR id = $1) ORDER BY id`,
    [serviceId])
  const now = nowJstIso()
  let total = 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const svc of services) {
      const { rows: incidents } = await client.query<Pick<ServiceIncident, 'impact' | 'startedAt' | 'resolvedAt'>>(
        `SELECT impact, started_at AS "startedAt", resolved_at AS "resolvedAt"
         FROM service_incidents WHERE service_id = $1`, [svc.id])
      const days = computeUptimeDaily(svc.id, incidents, fromDate, toDate, now)
        .filter(d => d.worstState !== 'operational' || d.downMinutes > 0)
      await client.query(
        `DELETE FROM uptime_daily WHERE service_id = $1 AND date BETWEEN $2::date AND $3::date`,
        [svc.id, fromDate, toDate])
      for (const d of days) {
        // 並行再計算（イベント × 日次ジョブ × 手動）で DELETE が他 Tx の新規行を見ない場合に備え
        // upsert にする（先勝ち・後勝ちいずれも SoT からの導出値のため同値 = 冪等）
        await client.query(
          `INSERT INTO uptime_daily (service_id, date, down_minutes, worst_state) VALUES ($1, $2, $3, $4)
           ON CONFLICT (service_id, date) DO UPDATE
           SET down_minutes = EXCLUDED.down_minutes, worst_state = EXCLUDED.worst_state`,
          [d.serviceId, d.date, d.downMinutes, d.worstState])
      }
      total += days.length
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return { services: services.length, rows: total }
}

/** 直近 90 日の窓（今日を含む閉区間） */
function uptimeWindow(): { fromDate: string; toDate: string } {
  const toDate = todayJst()
  return { fromDate: addDays(toDate, -(UPTIME_WINDOW_DAYS - 1)), toDate }
}

export function statusRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一括ハイドレーション（サービス + 全インシデント + 90 日 uptime。表示射影はフロント共通ロジック）
  app.get('/', async (c) => {
    const { fromDate, toDate } = uptimeWindow()
    const { rows: services } = await pool.query(
      `SELECT ${SERVICE_COLS} FROM system_services WHERE active = true ORDER BY id`)
    const { rows: incidents } = await pool.query(
      `SELECT ${INCIDENT_COLS} FROM service_incidents ORDER BY started_at DESC LIMIT 500`)
    const { rows: stored } = await pool.query<{
      serviceId: string; date: string; downMinutes: number; worstState: string
    }>(
      `SELECT service_id AS "serviceId", date::text AS date, down_minutes AS "downMinutes",
              worst_state AS "worstState"
       FROM uptime_daily WHERE date BETWEEN $1::date AND $2::date`, [fromDate, toDate])
    // 記録のない日は operational で埋め、全サービス × 90 日の密な配列を返す（フロント射影の前提）
    const byKey = new Map(stored.map(u => [`${u.serviceId}:${u.date}`, u]))
    const uptime = []
    for (const svc of services as { id: string }[]) {
      for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
        uptime.push(byKey.get(`${svc.id}:${d}`)
          ?? { serviceId: svc.id, date: d, downMinutes: 0, worstState: 'operational' })
      }
    }
    return c.json({ data: { services, incidents, uptime } })
  })

  // インシデント登録（管理者のみ。初報を updates[0] として記録し、管理者へ通知 = 非ブロッキング）
  app.post('/incidents', async (c) => {
    requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const serviceId = String(body.serviceId ?? '')
    const title = capCp(String(body.title ?? '').trim(), 80)
    const impact = String(body.impact ?? '')
    const firstNote = capCp(String(body.body ?? '').trim(), 2000)
    const { rows: svcRows } = await pool.query<{ name: string }>(
      `SELECT name FROM system_services WHERE id = $1 AND active = true`, [serviceId])
    const svc = svcRows[0]
    if (!svc) throw err('AKO-STS-001', '対象サービスが見つかりません', 404)
    if (!title) throw err('AKO-STS-002', 'タイトルを入力してください', 400)
    if (!IMPACTS.has(impact)) throw err('AKO-STS-006', '影響度が不正です（minor / major / critical）', 400)
    const now = nowJstIso()
    const id = newId('inc')
    const updates = [{
      status: 'investigating',
      body: firstNote || '事象を検知し、調査を開始しました。',
      at: now,
    }]
    await pool.query(
      `INSERT INTO service_incidents (id, service_id, title, impact, status, updates, started_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'investigating', $5, $6, NULL)`,
      [id, serviceId, title, impact, JSON.stringify(updates), now])
    // 集計の追随（導出データの再計算。失敗しても登録は成立 = 原則4。日次ジョブ/手動再計算が回復パス）
    try {
      await recomputeUptime(pool, serviceId, todayJst(), todayJst())
    } catch (e) {
      console.warn('uptime recompute failed (non-blocking):', (e as Error).message)
    }
    await notifyAdmins(pool, 'system', `インシデント発生: ${svc.name}`, title, `/status/${serviceId}`)
    return c.json({ data: { id } }, 201)
  })

  // 状況更新（管理者のみ・正順のみ。FOR UPDATE で並行更新を直列化し、updates へ追記）
  app.post('/incidents/:id/updates', async (c) => {
    requireAdmin(c)
    const incidentId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const nextStatus = String(body.status ?? '') as IncidentStatus
    const note = capCp(String(body.body ?? '').trim(), 2000)
    if (!note) throw err('AKO-STS-005', '状況の説明を入力してください', 400)

    const client = await pool.connect()
    let serviceId = ''
    let serviceName = ''
    try {
      await client.query('BEGIN')
      // サービス名も同一トランザクションで取得する（コミット後の補助クエリ失敗で
      // 「更新は成立したのに 500」となる経路を作らない = 原則4）
      const { rows } = await client.query<{ serviceId: string; status: IncidentStatus; serviceName: string }>(
        `SELECT i.service_id AS "serviceId", i.status, s.name AS "serviceName"
         FROM service_incidents i JOIN system_services s ON s.id = i.service_id
         WHERE i.id = $1 FOR UPDATE OF i`,
        [incidentId])
      const target = rows[0]
      if (!target) throw err('AKO-STS-003', 'インシデントが見つかりません', 404)
      const curIdx = INCIDENT_STATUS_ORDER.indexOf(target.status)
      const nextIdx = INCIDENT_STATUS_ORDER.indexOf(nextStatus)
      if (nextIdx <= curIdx || nextIdx < 0) {
        throw err('AKO-STS-004',
          `「${STATUS_LABELS[target.status]}」から「${STATUS_LABELS[nextStatus] ?? nextStatus}」へは更新できません（正順のみ）`,
          409)
      }
      const now = nowJstIso()
      await client.query(
        `UPDATE service_incidents
         SET status = $2,
             resolved_at = CASE WHEN $2 = 'resolved' THEN $3 ELSE resolved_at END,
             updates = updates || $4::jsonb
         WHERE id = $1`,
        [incidentId, nextStatus, now, JSON.stringify([{ status: nextStatus, body: note, at: now }])])
      await client.query('COMMIT')
      serviceId = target.serviceId
      serviceName = target.serviceName
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    // 集計の追随（解決で停止時間が確定する。窓全体を再計算 = 複数日にまたがる障害の反映）
    const { fromDate, toDate } = uptimeWindow()
    try {
      await recomputeUptime(pool, serviceId, fromDate, toDate)
    } catch (e) {
      console.warn('uptime recompute failed (non-blocking):', (e as Error).message)
    }
    await notifyAdmins(pool, 'system',
      `インシデント更新: ${serviceName}（${STATUS_LABELS[nextStatus]}）`,
      note, `/status/${serviceId}`)
    return c.json({ data: { id: incidentId } })
  })

  // uptime の手動再計算（管理者のみ。導出データの回復パス = 原則6。serviceId 省略で全サービス）
  app.post('/uptime/recompute', async (c) => {
    requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as { serviceId?: string }
    const { fromDate, toDate } = uptimeWindow()
    const result = await recomputeUptime(pool,
      typeof body.serviceId === 'string' && body.serviceId ? body.serviceId : null, fromDate, toDate)
    return c.json({ data: result })
  })

  return app
}

/** 日次ロールアップ（/jobs/uptime-rollup）。未解決インシデントの停止時間を毎日進める */
export async function runUptimeRollup(pool: pg.Pool): Promise<{ services: number; rows: number }> {
  // 昨日 + 今日を再計算（日跨ぎの未解決インシデントの確定と当日分の進行。冪等）
  const toDate = todayJst()
  return recomputeUptime(pool, null, addDays(toDate, -1), toDate)
}
