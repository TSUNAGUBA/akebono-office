/**
 * ワークフロー・稟議 API（F-07）。mockup useWorkflow の API 版。
 * - 経路解決は shared/domain/approval-route.resolveRoute（職務権限マトリクス = workflow_routes）
 * - 申請は routeSnapshot を凍結保存（経路変更の影響を受けない）。承認証跡は追記のみ
 * - 承認操作はクレームファースト（FOR UPDATE + 状態ガード）で二重処理を防ぐ
 * - 権限: 参照は認証済み全員（C2 社内情報・mockup と同一）。操作は本人/承認者/有効な代理人
 * エラー: AKO-WFL-001（権限・状態違反）/ 002（コメント必須）/ 003（該当経路なし）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { resolveRoute } from '../../../shared/domain/approval-route'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import type {
  ApprovalAction, Member, WorkflowCategory, WorkflowRoute, WorkflowRouteStep,
} from '../../../shared/domain/types'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify } from '../lib/notify'

const CATEGORIES: WorkflowCategory[] = ['purchase', 'contract', 'expense', 'hiring', 'trip', 'other']
const CATEGORY_LABELS: Record<WorkflowCategory, string> = {
  purchase: '購買', contract: '契約', expense: '経費', hiring: '採用', trip: '出張', other: 'その他',
}
const ACTION_LABELS: Record<Exclude<ApprovalAction, 'submit' | 'approve'>, string> = {
  reject: '却下', remand: '差戻し', withdraw: '取下げ',
}

const REQ_COLS = `id, category, title, amount::float8 AS amount, body, purpose, content,
  attachments, requester_id AS "requesterId",
  status, current_step AS "currentStep", route_snapshot AS "routeSnapshot", created_at AS "createdAt"`
const LOG_COLS = `id, request_id AS "requestId", step, actor_id AS "actorId",
  delegate_for_id AS "delegateForId", action, comment, at`
const DELEGATE_COLS = `id, member_id AS "memberId", delegate_member_id AS "delegateMemberId",
  from_date AS "from", to_date AS "to", active`

function fmtYen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`
}

interface WorkflowInput {
  category: WorkflowCategory
  title: string
  amount: number
  /** 旧形式の本文（旧クライアント互換。新クライアントは purpose / content を送る） */
  body: string
  purpose: string
  content: string
  attachments: string[]
}

function parseInput(raw: Record<string, unknown>): WorkflowInput {
  const category = CATEGORIES.includes(raw.category as WorkflowCategory)
    ? raw.category as WorkflowCategory
    : null
  if (!category) throw err('AKO-GEN-001', '区分（category）を指定してください', 400)
  const title = String(raw.title ?? '').trim()
  if (!title) throw err('AKO-GEN-001', '件名を入力してください', 400)
  const amount = Number(raw.amount)
  if (!Number.isFinite(amount) || amount < 0) throw err('AKO-GEN-001', '金額を 0 以上で入力してください', 400)
  return {
    category,
    title,
    amount,
    body: String(raw.body ?? ''),
    purpose: String(raw.purpose ?? ''),
    content: String(raw.content ?? ''),
    attachments: Array.isArray(raw.attachments) ? (raw.attachments as string[]).map(String) : [],
  }
}

type ApproverMember = Pick<Member, 'id' | 'name'>

/** 承認ロール → 実メンバー解決（mockup approverFor と同一。見つからなければ president へフォールバック） */
async function approverFor(
  pool: pg.Pool | pg.PoolClient,
  role: WorkflowRouteStep['approverRole'],
): Promise<ApproverMember | undefined> {
  const { rows } = await pool.query<Pick<Member, 'id' | 'name' | 'title' | 'employmentType' | 'role'>>(
    `SELECT id, name, title, employment_type AS "employmentType", role FROM members WHERE active = true ORDER BY id`)
  const president = rows.find(m => m.title === '代表取締役')
  if (role === 'president') return president
  if (role === 'director') {
    return rows.find(m => m.employmentType === 'director' && m.id !== president?.id) ?? president
  }
  return rows.find(m => m.role === 'admin' && m.employmentType === 'employee') ?? president
}

/** ステップの承認者（個人指定があれば優先。無効ならロール解決へ） */
async function stepApprover(
  pool: pg.Pool | pg.PoolClient,
  step: WorkflowRouteStep,
): Promise<ApproverMember | undefined> {
  if (step.approverMemberId) {
    const { rows } = await pool.query<ApproverMember>(
      'SELECT id, name FROM members WHERE id = $1 AND active = true', [step.approverMemberId])
    if (rows[0]) return rows[0]
  }
  return approverFor(pool, step.approverRole)
}

/** approverId の有効な代理人として memberId が動けるか（期間は今日を含む） */
async function isActiveDelegateOf(
  pool: pg.Pool | pg.PoolClient,
  approverId: string,
  memberId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM delegate_settings
     WHERE member_id = $1 AND delegate_member_id = $2 AND active = true
       AND from_date <= $3::date AND to_date >= $3::date LIMIT 1`,
    [approverId, memberId, todayJst()])
  return rows.length > 0
}

async function appendLog(
  db: pg.Pool | pg.PoolClient,
  requestId: string,
  step: number,
  actorId: string,
  action: ApprovalAction,
  comment: string,
  delegateForId: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO approval_logs (id, request_id, step, actor_id, delegate_for_id, action, comment, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId('apl'), requestId, step, actorId, delegateForId, action, comment, nowJstIso()])
}

async function activeRoutes(pool: pg.Pool | pg.PoolClient): Promise<WorkflowRoute[]> {
  const { rows } = await pool.query(
    `SELECT id, category, min_amount::float8 AS "minAmount", max_amount::float8 AS "maxAmount", steps, active
     FROM workflow_routes WHERE active = true ORDER BY id`)
  return rows as WorkflowRoute[]
}

interface RequestRow {
  id: string
  category: WorkflowCategory
  title: string
  amount: number
  requesterId: string
  status: string
  currentStep: number
  routeSnapshot: WorkflowRouteStep[]
}

export function workflowsRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 一覧（認証済み全員 = 社内 C2。ただし他人の下書きは本人と管理者のみ = 未提出の情報露出を防ぐ）
  app.get('/', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query(
      `SELECT ${REQ_COLS} FROM workflow_requests
       WHERE ($1 OR status <> 'draft' OR requester_id = $2)
       ORDER BY created_at DESC, id LIMIT 500`,
      [user.role === 'admin', user.id])
    return c.json({ data: rows })
  })

  // 承認証跡（時系列昇順）
  app.get('/:id/logs', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${LOG_COLS} FROM approval_logs WHERE request_id = $1 ORDER BY at, created_at`,
      [c.req.param('id')])
    return c.json({ data: rows })
  })

  // 代理設定一覧（承認可否の射影に全員分が必要 = mockup と同一の可視性）
  app.get('/delegates', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${DELEGATE_COLS} FROM delegate_settings WHERE active = true ORDER BY id`)
    return c.json({ data: rows })
  })

  // 代理設定の追加（本人のみ）
  app.post('/delegates', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { delegateMemberId?: string; from?: string; to?: string }
    const { delegateMemberId, from, to } = body
    if (!delegateMemberId || !from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw err('AKO-GEN-001', '代理人と期間を入力してください', 400)
    }
    if (delegateMemberId === user.id) throw err('AKO-GEN-001', '自分自身を代理人にはできません', 400)
    if (to < from) throw err('AKO-GEN-001', '期間の終了日は開始日以降にしてください', 400)
    const target = await pool.query<{ employmentType: string }>(
      `SELECT employment_type AS "employmentType" FROM members WHERE id = $1 AND active = true`, [delegateMemberId])
    if (!target.rows[0]) throw err('AKO-GEN-002', '代理人のメンバーが見つかりません', 404)
    if (target.rows[0].employmentType === 'outsource') {
      throw err('AKO-GEN-001', '外部委託メンバーは代理人に設定できません', 400)
    }
    const id = newId('dg')
    await pool.query(
      `INSERT INTO delegate_settings (id, member_id, delegate_member_id, from_date, to_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, user.id, delegateMemberId, from, to])
    return c.json({ data: { id } }, 201)
  })

  // 代理設定の解除（本人のみ・論理削除）
  app.post('/delegates/:id/archive', async (c) => {
    const user = c.get('user')
    const result = await pool.query(
      `UPDATE delegate_settings SET active = false, updated_at = now() WHERE id = $1 AND member_id = $2`,
      [c.req.param('id'), user.id])
    if (result.rowCount === 0) throw err('AKO-GEN-002', '対象の代理設定が見つかりません', 404)
    return c.json({ data: { id: c.req.param('id') } })
  })

  // 下書き保存（経路未確定のまま。既存下書きの更新可）
  app.put('/draft', async (c) => {
    const user = c.get('user')
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = parseInput(raw)
    const requestId = typeof raw.id === 'string' && raw.id ? raw.id : null

    if (requestId) {
      // エラー区分は mockup と同一（対象なし = AKO-GEN-002 / 本人・状態違反 = AKO-WFL-001）
      const existing = await pool.query<{ requesterId: string; status: string }>(
        `SELECT requester_id AS "requesterId", status FROM workflow_requests WHERE id = $1`, [requestId])
      const row = existing.rows[0]
      if (!row) throw err('AKO-GEN-002', '対象の申請が見つかりません', 404)
      if (row.requesterId !== user.id) throw err('AKO-WFL-001', '申請者本人のみ編集できます', 403)
      if (row.status !== 'draft') throw err('AKO-WFL-001', '下書き以外は下書き保存できません', 409)
      const result = await pool.query(
        `UPDATE workflow_requests
         SET category = $2, title = $3, amount = $4, body = $5, purpose = $6, content = $7,
             attachments = $8, updated_at = now()
         WHERE id = $1 AND requester_id = $9 AND status = 'draft'`,
        [requestId, input.category, input.title, input.amount, input.body, input.purpose, input.content,
          JSON.stringify(input.attachments), user.id])
      if (result.rowCount === 0) {
        throw err('AKO-WFL-001', '下書き以外は下書き保存できません（申請者本人の下書きのみ）', 409)
      }
      return c.json({ data: { id: requestId } })
    }
    const id = newId('WF')
    await pool.query(
      `INSERT INTO workflow_requests (id, category, title, amount, body, purpose, content, attachments, requester_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
        JSON.stringify(input.attachments), user.id, nowJstIso()])
    return c.json({ data: { id } }, 201)
  })

  // 提出（新規 / draft・remanded の再申請。経路を凍結し in_review step1 へ）
  app.post('/submit', async (c) => {
    const user = c.get('user')
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = parseInput(raw)
    const requestId = typeof raw.id === 'string' && raw.id ? raw.id : null

    const route = resolveRoute(await activeRoutes(pool), input.category, input.amount)
    if (!route || route.length === 0) {
      throw err('AKO-WFL-003', 'この区分・金額に該当する承認経路がありません。経路設定を確認してください', 409)
    }

    const client = await pool.connect()
    let id: string
    try {
      await client.query('BEGIN')
      if (requestId) {
        const existing = await client.query<{ requesterId: string; status: string }>(
          `SELECT requester_id AS "requesterId", status FROM workflow_requests WHERE id = $1 FOR UPDATE`,
          [requestId])
        const row = existing.rows[0]
        if (!row) throw err('AKO-GEN-002', '対象の申請が見つかりません', 404)
        if (row.requesterId !== user.id) throw err('AKO-WFL-001', '申請者本人のみ再申請できます', 403)
        if (row.status !== 'draft' && row.status !== 'remanded') {
          throw err('AKO-WFL-001', 'この申請は提出できる状態ではありません', 409)
        }
        id = requestId
        await client.query(
          `UPDATE workflow_requests
           SET category = $2, title = $3, amount = $4, body = $5, purpose = $6, content = $7,
               attachments = $8, status = 'in_review', current_step = 1, route_snapshot = $9, updated_at = now()
           WHERE id = $1`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
            JSON.stringify(input.attachments), JSON.stringify(route)])
      } else {
        id = newId('WF')
        await client.query(
          `INSERT INTO workflow_requests
             (id, category, title, amount, body, purpose, content, attachments, requester_id, status, current_step, route_snapshot, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_review', 1, $10, $11)`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
            JSON.stringify(input.attachments), user.id, JSON.stringify(route), nowJstIso()])
      }
      await appendLog(client, id, 0, user.id, 'submit', '')
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    // 補助処理: step1 承認者へ通知（承認者解決を含め、失敗しても提出は成立 = コミット済みを 500 にしない）
    try {
      const first = route[0]
      const approver = first ? await stepApprover(pool, first) : undefined
      if (approver && approver.id !== user.id) {
        await notify(pool, approver.id, 'approval', `承認依頼: ${input.title}`,
          `${user.name} さんから${CATEGORY_LABELS[input.category]}稟議（${fmtYen(input.amount)}）が届いています`, '/workflow')
      }
    } catch (e) {
      console.warn('submit notify failed (non-blocking):', (e as Error).message)
    }
    return c.json({ data: { id } }, requestId ? 200 : 201)
  })

  // 承認操作（approve / reject / remand / withdraw）。クレームファースト
  app.post('/:id/actions', async (c) => {
    const user = c.get('user')
    const requestId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { action?: string; comment?: string }
    const action = body.action
    if (action !== 'approve' && action !== 'reject' && action !== 'remand' && action !== 'withdraw') {
      throw err('AKO-GEN-001', 'action は approve / reject / remand / withdraw を指定してください', 400)
    }
    const comment = String(body.comment ?? '').trim()

    const client = await pool.connect()
    let req: RequestRow
    let delegateForId: string | null = null
    let nextApprover: ApproverMember | undefined
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<RequestRow>(
        `SELECT ${REQ_COLS} FROM workflow_requests WHERE id = $1 FOR UPDATE`, [requestId])
      const row = rows[0]
      if (!row) throw err('AKO-GEN-002', '対象の申請が見つかりません', 404)
      req = row

      if (action === 'withdraw') {
        if (req.requesterId !== user.id) throw err('AKO-WFL-001', '取下げは申請者本人のみ可能です', 403)
        if (req.status !== 'in_review' && req.status !== 'submitted') {
          throw err('AKO-WFL-001', 'この申請は取下げできる状態ではありません', 409)
        }
        await client.query(`UPDATE workflow_requests SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [requestId])
        await appendLog(client, requestId, req.currentStep, user.id, 'withdraw', comment)
        await client.query('COMMIT')
        return c.json({ data: { id: requestId } })
      }

      if (req.status !== 'in_review' && req.status !== 'submitted') {
        throw err('AKO-WFL-001', 'この申請は現在承認操作できません', 409)
      }
      const step = req.routeSnapshot[req.currentStep - 1]
      const approver = step ? await stepApprover(client, step) : undefined
      if (!approver) throw err('AKO-WFL-001', '現在ステップの承認者を解決できません', 409)
      const isSelf = approver.id === user.id
      const asDelegate = !isSelf && await isActiveDelegateOf(client, approver.id, user.id)
      if (!isSelf && !asDelegate) throw err('AKO-WFL-001', 'このステップの承認権限がありません', 403)
      if ((action === 'reject' || action === 'remand') && !comment) {
        throw err('AKO-WFL-002', `${ACTION_LABELS[action]}にはコメントの入力が必要です`, 400)
      }
      delegateForId = asDelegate ? approver.id : null

      if (action === 'approve') {
        const isLast = req.currentStep >= req.routeSnapshot.length
        await appendLog(client, requestId, req.currentStep, user.id, 'approve', comment, delegateForId)
        if (isLast) {
          await client.query(`UPDATE workflow_requests SET status = 'approved', updated_at = now() WHERE id = $1`, [requestId])
        } else {
          await client.query(`UPDATE workflow_requests SET current_step = current_step + 1, updated_at = now() WHERE id = $1`, [requestId])
          const ns = req.routeSnapshot[req.currentStep]
          nextApprover = ns ? await stepApprover(client, ns) : undefined
        }
      } else {
        await client.query(
          `UPDATE workflow_requests SET status = $2, updated_at = now() WHERE id = $1`,
          [requestId, action === 'reject' ? 'rejected' : 'remanded'])
        await appendLog(client, requestId, req.currentStep, user.id, action, comment, delegateForId)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    // 補助処理: 通知（自分宛てはスキップ = mockup と同一）
    const label = CATEGORY_LABELS[req.category]
    if (action === 'approve') {
      const isLast = req.currentStep >= req.routeSnapshot.length
      if (isLast) {
        if (req.requesterId !== user.id) {
          await notify(pool, req.requesterId, 'approval', `決裁: ${req.title}`,
            `${label}稟議（${fmtYen(req.amount)}）が決裁されました`, '/workflow')
        }
      } else if (nextApprover && nextApprover.id !== user.id) {
        await notify(pool, nextApprover.id, 'approval', `承認依頼: ${req.title}`,
          `${label}稟議（${fmtYen(req.amount)}）が step${req.currentStep + 1} に到達しました`, '/workflow')
      }
    } else if (req.requesterId !== user.id) {
      await notify(pool, req.requesterId, 'approval',
        `${ACTION_LABELS[action as 'reject' | 'remand']}: ${req.title}`, comment, '/workflow')
    }
    return c.json({ data: { id: requestId } })
  })

  return app
}
