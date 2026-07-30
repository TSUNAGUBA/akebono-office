/**
 * ワークフロー・稟議 API（F-07）。mockup useWorkflow の API 版。
 * - 経路解決は shared/domain/approval-route.resolveRoute（職務権限マトリクス = workflow_routes）
 * - 申請は routeSnapshot を凍結保存（経路変更の影響を受けない）。承認証跡は追記のみ
 * - 承認操作はクレームファースト（FOR UPDATE + 状態ガード）で二重処理を防ぐ
 * - 権限: 参照は認証済み全員（C2 社内情報・mockup と同一）。操作は本人/承認者/有効な代理人
 * - 添付（監査指摘 2026-07-30 ②）: 実体は workflow_files（bytea = ai_task_files と同型）。
 *   attachments(jsonb) は表示名一覧として維持（旧データ = 名前のみの互換表示。原則7）。
 *   files（新規 base64）+ keepFileIds（既存維持）を draft/submit で受領し、差分同期する
 * エラー: AKO-WFL-001（権限・状態違反）/ 002（コメント必須）/ 003（該当経路なし）/
 *         004（添付の形式・サイズ・件数）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { resolveRoute } from '../../../shared/domain/approval-route'
import { pickApprover, type ApproverStepLike } from '../../../shared/domain/approver'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import type {
  ApprovalAction, Member, WorkflowCategory, WorkflowRoute, WorkflowRouteStep,
} from '../../../shared/domain/types'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { notify } from '../lib/notify'
import { capCp } from '../lib/text'

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
  /** 名前のみの添付（旧データ・モック互換の表示名一覧。実ファイル名はサーバーが合成する） */
  attachments: string[]
  /** 新規アップロード（実体）。undefined = 添付同期なし（旧クライアント互換） */
  files: { filename: string; mime: string; bytes: Buffer }[] | undefined
  /** 既存 workflow_files のうち維持するもの（同期時、含まれない既存分は削除される） */
  keepFileIds: string[] | undefined
}

/** 添付の対応形式（稟議の実務で使う書類 + 画像。ai-company の添付と同方針） */
const WF_FILE_EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}
const MAX_WF_FILE_BYTES = 10 * 1024 * 1024
const MAX_WF_FILES = 5

/** 添付アップロードの検証（DB 書込前に全件検証 = 失敗時に中途半端な保存を残さない） */
function parseFiles(raw: unknown): { filename: string; mime: string; bytes: Buffer }[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw err('AKO-WFL-004', 'files は配列で指定してください', 400)
  const out: { filename: string; mime: string; bytes: Buffer }[] = []
  for (const f of raw as { filename?: unknown; contentBase64?: unknown }[]) {
    const filename = capCp(String(f?.filename ?? '').trim(), 200)
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
    const mime = WF_FILE_EXT_MIME[ext]
    if (!mime) {
      throw err('AKO-WFL-004', '添付の対応形式は .md / .txt / .csv / .pdf / .docx / .xlsx / .pptx / .jpg / .png です', 400)
    }
    const contentBase64 = String(f?.contentBase64 ?? '')
    if (!contentBase64 || contentBase64.length > MAX_WF_FILE_BYTES * 1.4) {
      throw err('AKO-WFL-004', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_WF_FILE_BYTES) {
      throw err('AKO-WFL-004', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    out.push({ filename, mime, bytes })
  }
  return out
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
    files: parseFiles(raw.files),
    keepFileIds: Array.isArray(raw.keepFileIds) ? (raw.keepFileIds as string[]).map(String) : undefined,
  }
}

/**
 * 添付実体の差分同期 + 表示名一覧（attachments jsonb）の合成。
 * files / keepFileIds のどちらも未指定（旧クライアント）は実体に触れず、表示名も送信値のまま
 * = 下位互換（原則7）。指定時は「keep に無い既存を削除 → 新規を挿入」し、
 * 表示名 = 名前のみ添付（input.attachments）+ 実ファイル名 とする（SoT = workflow_files 先行。原則6）
 */
async function syncRequestFiles(
  db: pg.Pool | pg.PoolClient, requestId: string, userId: string, input: WorkflowInput,
): Promise<string[]> {
  if (input.files === undefined && input.keepFileIds === undefined) return input.attachments
  const keep = input.keepFileIds ?? []
  const news = input.files ?? []
  const { rows: existing } = await db.query<{ id: string; filename: string }>(
    `SELECT id, filename FROM workflow_files WHERE request_id = $1 ORDER BY created_at, id`, [requestId])
  const kept = existing.filter(f => keep.includes(f.id))
  if (kept.length + news.length > MAX_WF_FILES) {
    throw err('AKO-WFL-004', `添付は ${MAX_WF_FILES} 件までです`, 400)
  }
  const dropIds = existing.filter(f => !keep.includes(f.id)).map(f => f.id)
  if (dropIds.length > 0) {
    await db.query(`DELETE FROM workflow_files WHERE request_id = $1 AND id = ANY($2)`, [requestId, dropIds])
  }
  for (const f of news) {
    await db.query(
      `INSERT INTO workflow_files (id, request_id, filename, mime, size_bytes, bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId('wff'), requestId, f.filename, f.mime, f.bytes.length, f.bytes, userId])
  }
  // 表示名一覧 = 名前のみ添付（実ファイル名と重複するものは除外）+ 実ファイル名
  const fileNames = [...kept.map(f => f.filename), ...news.map(f => f.filename)]
  return [...input.attachments.filter(a => !fileNames.includes(a)), ...fileNames]
}

type ApproverMember = Pick<Member, 'id' | 'name'>

/**
 * ステップの承認者を実メンバーへ解決（役職/ロール/個人）。解決は共有 pickApprover に委譲し、
 * 勤怠側・モック側と同一ロジックにする。旧形式（approverRole=manager/... の凍結スナップショット）も吸収。
 */
async function stepApprover(
  pool: pg.Pool | pg.PoolClient,
  step: ApproverStepLike,
): Promise<ApproverMember | undefined> {
  const { rows } = await pool.query<{ id: string; name: string; role: string; title: string }>(
    `SELECT id, name, role, title FROM members WHERE active = true ORDER BY id`)
  return pickApprover(rows, step)
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

  /** 添付参照の可視性 = 申請一覧と同一（下書きは本人と管理者のみ。他は認証済み全員 = C2） */
  async function assertRequestViewable(requestId: string, user: { id: string; role: string }): Promise<void> {
    const { rows } = await pool.query<{ requesterId: string; status: string }>(
      `SELECT requester_id AS "requesterId", status FROM workflow_requests WHERE id = $1`, [requestId])
    const row = rows[0]
    if (!row || (row.status === 'draft' && row.requesterId !== user.id && user.role !== 'admin')) {
      throw err('AKO-GEN-002', '対象の申請が見つかりません', 404)
    }
  }

  // 添付ファイル一覧（メタのみ。実体は /:id/files/:fileId）
  app.get('/:id/files', async (c) => {
    await assertRequestViewable(c.req.param('id'), c.get('user'))
    const { rows } = await pool.query(
      `SELECT id, request_id AS "requestId", filename, mime, size_bytes AS "sizeBytes",
              uploaded_by AS "uploadedBy",
              to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"
       FROM workflow_files WHERE request_id = $1 ORDER BY created_at, id`,
      [c.req.param('id')])
    return c.json({ data: rows })
  })

  // 添付原本ダウンロード（base64 JSON = ナレッジ・AI タスク添付と同一パターン）
  app.get('/:id/files/:fileId', async (c) => {
    await assertRequestViewable(c.req.param('id'), c.get('user'))
    const { rows } = await pool.query<{ filename: string; mime: string; bytes: Buffer }>(
      `SELECT filename, mime, bytes FROM workflow_files WHERE id = $1 AND request_id = $2`,
      [c.req.param('fileId'), c.req.param('id')])
    const f = rows[0]
    if (!f) throw err('AKO-GEN-002', '添付ファイルが見つかりません', 404)
    return c.json({ data: { filename: f.filename, mime: f.mime, contentBase64: f.bytes.toString('base64') } })
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

  // 下書き保存（経路未確定のまま。既存下書きの更新可）。添付実体の同期を含むためトランザクションで確定する
  app.put('/draft', async (c) => {
    const user = c.get('user')
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const input = parseInput(raw)
    const requestId = typeof raw.id === 'string' && raw.id ? raw.id : null

    const client = await pool.connect()
    let id: string
    try {
      await client.query('BEGIN')
      if (requestId) {
        // エラー区分は mockup と同一（対象なし = AKO-GEN-002 / 本人・状態違反 = AKO-WFL-001）
        const existing = await client.query<{ requesterId: string; status: string }>(
          `SELECT requester_id AS "requesterId", status FROM workflow_requests WHERE id = $1 FOR UPDATE`,
          [requestId])
        const row = existing.rows[0]
        if (!row) throw err('AKO-GEN-002', '対象の申請が見つかりません', 404)
        if (row.requesterId !== user.id) throw err('AKO-WFL-001', '申請者本人のみ編集できます', 403)
        if (row.status !== 'draft') throw err('AKO-WFL-001', '下書き以外は下書き保存できません', 409)
        id = requestId
        await client.query(
          `UPDATE workflow_requests
           SET category = $2, title = $3, amount = $4, body = $5, purpose = $6, content = $7, updated_at = now()
           WHERE id = $1`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content])
      } else {
        id = newId('WF')
        await client.query(
          `INSERT INTO workflow_requests (id, category, title, amount, body, purpose, content, requester_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
            user.id, nowJstIso()])
      }
      // 添付実体の同期（SoT = workflow_files）→ 表示名一覧（attachments）を反映（原則6）
      const names = await syncRequestFiles(client, id, user.id, input)
      await client.query(
        `UPDATE workflow_requests SET attachments = $2 WHERE id = $1`, [id, JSON.stringify(names)])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return c.json({ data: { id } }, requestId ? 200 : 201)
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
               status = 'in_review', current_step = 1, route_snapshot = $8, updated_at = now()
           WHERE id = $1`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
            JSON.stringify(route)])
      } else {
        id = newId('WF')
        await client.query(
          `INSERT INTO workflow_requests
             (id, category, title, amount, body, purpose, content, requester_id, status, current_step, route_snapshot, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_review', 1, $9, $10)`,
          [id, input.category, input.title, input.amount, input.body, input.purpose, input.content,
            user.id, JSON.stringify(route), nowJstIso()])
      }
      // 添付実体の同期（SoT = workflow_files）→ 表示名一覧（attachments）を反映（原則6）
      const names = await syncRequestFiles(client, id, user.id, input)
      await client.query(
        `UPDATE workflow_requests SET attachments = $2 WHERE id = $1`, [id, JSON.stringify(names)])
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
