/**
 * AI ネイティブカンパニー API（F-08）。mockup useAiCompany の API 版。
 * - AI ロール / AI 社員は汎用マスタ（/v1/masters/ai-roles・ai-employees。管理者のみ変更）
 * - タスク依頼 → 分解（Vertex AI 構造化出力 → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック）
 *   → 承認 → 実行 → 完了報告。状態機械は FOR UPDATE で直列化（proposed → in_progress → done / blocked / cancelled）
 * - ai_employees.status はタスク状態からの派生（SoT: ai_tasks → 操作時にサーバーが同期）
 * - 活動ログは追記のみ（記録系）。トークン/コストは決定的モック値（実 LLM 課金の代替 = 設計判断）
 * - 日次報告は既存 daily_reports（author_kind='ai'）へ生成。既存分はスキップ = 冪等（原則2）
 * - 低確信度・停滞・過負荷は raiseEscalation（クールダウン冪等・非ブロッキング = 原則4）
 * エラー: AKO-AIC-001〜008（api-design の台帳に準拠）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  decomposeTask, judgeTaskConfidence, mockActivityCost,
} from '../../../shared/domain/ai-tasks'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { AiActivityKind, AiModelTier, AiTask, ReportEntry } from '../../../shared/domain/types'
import type { Env } from '../env'
import { raiseEscalation } from '../lib/escalate'
import { capCp } from '../lib/text'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { notify } from '../lib/notify'

const TASK_COLS = `id, ai_employee_id AS "aiEmployeeId", requester_id AS "requesterId",
  title, description, decomposition, status, due_date::text AS "dueDate", confidence, created_at AS "createdAt"`
const LOG_COLS = `id, ai_employee_id AS "aiEmployeeId", task_id AS "taskId", kind, summary, tokens,
  cost_usd::float AS "costUsd", at`

/** タスク状態から AI 社員の状態を導出して同期（SoT: ai_tasks → 派生: ai_employees.status） */
async function syncEmployeeStatus(db: pg.Pool | pg.PoolClient, aiEmployeeId: string): Promise<void> {
  await db.query(
    `UPDATE ai_employees SET status = (
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM ai_tasks WHERE ai_employee_id = $1 AND status IN ('in_progress','approved')) THEN 'working'
         WHEN EXISTS (SELECT 1 FROM ai_tasks WHERE ai_employee_id = $1 AND status = 'proposed') THEN 'waiting_approval'
         ELSE 'idle' END
     ), updated_at = now() WHERE id = $1`, [aiEmployeeId])
}

/** 活動ログを追記する（tokens/costUsd は決定的モック値。ロールのモデル層でレート差） */
async function addLog(
  db: pg.Pool | pg.PoolClient,
  aiEmployeeId: string,
  taskId: string | null,
  kind: AiActivityKind,
  summary: string,
): Promise<void> {
  const { rows: tierRows } = await db.query<{ modelTier: AiModelTier }>(
    `SELECT r.model_tier AS "modelTier" FROM ai_employees e JOIN ai_roles r ON r.id = e.role_id WHERE e.id = $1`,
    [aiEmployeeId])
  const { rows: cnt } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_activity_logs WHERE ai_employee_id = $1`, [aiEmployeeId])
  const { tokens, costUsd } = mockActivityCost(
    aiEmployeeId, kind, Number(cnt[0]?.n ?? 0), tierRows[0]?.modelTier ?? 'standard')
  await db.query(
    `INSERT INTO ai_activity_logs (id, ai_employee_id, task_id, kind, summary, tokens, cost_usd, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId('aal'), aiEmployeeId, taskId, kind, summary, tokens, costUsd, nowJstIso()])
}

/** LLM によるタスク分解（失敗・無効環境は null → shared ヒューリスティックへ） */
async function llmDecompose(
  env: Env,
  role: { name: string; mission: string } | undefined,
  title: string,
  description: string,
): Promise<{ steps: string[]; confidence: AiTask['confidence'] } | null> {
  if (!env.vertexProjectId) return null
  const res = await generateJson<{ steps: string[]; confidence: string }>(env, {
    system: 'あなたは AI 社員のタスク計画者です。依頼内容を 3〜5 個の実行ステップへ分解し、'
      + '依頼の明確さから確信度（high = 明確 / mid = 概ね明確 / low = 情報不足・要確認）を判定して JSON で返します。'
      + 'ステップは動詞で終わる短い日本語（30 字以内）。推測で事実を作らないこと。',
    prompt: `AI 社員のロール: ${role?.name ?? '汎用'}（${role?.mission ?? ''}）\n件名: ${title}\n依頼内容: ${description || '（記載なし）'}`,
    schema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string' },
      },
      required: ['steps', 'confidence'],
    },
    maxTokens: 512,
  })
  if (!res || !Array.isArray(res.steps) || res.steps.length === 0) return null
  const confidence = res.confidence === 'high' || res.confidence === 'low' ? res.confidence : 'mid'
  return { steps: res.steps.slice(0, 6).map(s => capCp(String(s), 40)), confidence }
}

export function aiCompanyRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // タスク一覧（全員参照可 = モックのタスクボードと同じ可視性。作成日降順）
  app.get('/tasks', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${TASK_COLS} FROM ai_tasks ORDER BY created_at DESC LIMIT 200`)
    return c.json({ data: rows })
  })

  // 活動ログ（新しい順。at は秒精度のため id を第 2 キーに = 同一秒内でも順序を決定化）
  app.get('/logs', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${LOG_COLS} FROM ai_activity_logs ORDER BY at DESC, id LIMIT 200`)
    return c.json({ data: rows })
  })

  // タスク依頼（分解 = LLM → 失敗時ヒューリスティック。proposed で登録・低確信度はエスカレーション）
  app.post('/tasks', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      aiEmployeeId?: string; title?: string; description?: string
    }
    const title = capCp(String(body.title ?? '').trim(), 100)
    const description = capCp(String(body.description ?? '').trim(), 2000)
    if (!title) throw err('AKO-AIC-002', '件名を入力してください', 400)
    const { rows: emps } = await pool.query<{ id: string; name: string; roleName: string; mission: string }>(
      `SELECT e.id, e.name, r.name AS "roleName", r.mission
       FROM ai_employees e JOIN ai_roles r ON r.id = e.role_id
       WHERE e.id = $1 AND e.active = true`, [String(body.aiEmployeeId ?? '')])
    const emp = emps[0]
    if (!emp) throw err('AKO-AIC-001', 'AI 社員が見つかりません', 404)

    const llm = await llmDecompose(env, { name: emp.roleName, mission: emp.mission }, title, description)
    const decomposition = llm
      ? llm.steps.map(s => ({ title: s, done: false }))
      : decomposeTask(title, description)
    const confidence = llm ? llm.confidence : judgeTaskConfidence(emp.id, title, description)

    const id = newId('at')
    await pool.query(
      `INSERT INTO ai_tasks (id, ai_employee_id, requester_id, title, description, decomposition, status, confidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8)`,
      [id, emp.id, user.id, title, description, JSON.stringify(decomposition), confidence, nowJstIso()])
    await addLog(pool, emp.id, id, 'plan', `「${title}」の分解案を作成し承認待ち`)
    await syncEmployeeStatus(pool, emp.id)

    // 補助処理: 低確信度エスカレーション（失敗しても主フローは成立 = 原則4）。
    // dedupe は先頭 2 セグメント + クールダウンで判定されるため日付セグメントは付けない
    let escalated = false
    if (confidence === 'low') {
      const raised = await raiseEscalation(pool, {
        reason: 'low_confidence',
        targetAiEmployeeId: emp.id,
        context: `AI社員への依頼「${title}」の確信度が低いため確認が必要`,
        dedupeKey: `lowconf:${emp.id}`,
      })
      escalated = raised.raised
    }
    return c.json({ data: { id, confidence, escalated } }, 201)
  })

  // 状態遷移（FOR UPDATE で直列化。mock と同一の遷移・エラーコード）
  app.post('/tasks/:id/:action{approve|progress|block|cancel}', async (c) => {
    const user = c.get('user')
    const taskId = c.req.param('id')
    const action = c.req.param('action')
    const client = await pool.connect()
    let result: { finished?: boolean; requesterId?: string; title?: string; aiEmployeeId?: string } = {}
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<AiTask & { decomposition: { title: string; done: boolean }[] }>(
        `SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1 FOR UPDATE`, [taskId])
      const task = rows[0]
      if (!task) throw err('AKO-AIC-003', 'タスクが見つかりません', 404)

      if (action === 'approve') {
        if (task.status !== 'proposed') throw err('AKO-AIC-004', '提案中のタスクのみ承認できます', 409)
        await client.query(`UPDATE ai_tasks SET status = 'in_progress', updated_at = now() WHERE id = $1`, [taskId])
        await addLog(client, task.aiEmployeeId, taskId, 'plan', `「${task.title}」の分解が承認され実行を開始`)
      } else if (action === 'progress') {
        if (task.status !== 'in_progress') throw err('AKO-AIC-005', '実行中のタスクのみ進められます', 409)
        const idx = task.decomposition.findIndex(s => !s.done)
        if (idx < 0) throw err('AKO-AIC-006', '未完了のステップがありません', 409)
        const step = task.decomposition[idx]!
        const decomposition = task.decomposition.map((s, i) => i === idx ? { ...s, done: true } : s)
        const finished = decomposition.every(s => s.done)
        await client.query(
          `UPDATE ai_tasks SET decomposition = $2, status = $3, updated_at = now() WHERE id = $1`,
          [taskId, JSON.stringify(decomposition), finished ? 'done' : task.status])
        await addLog(client, task.aiEmployeeId, taskId, 'execute', `「${step.title}」を完了`)
        if (finished) {
          await addLog(client, task.aiEmployeeId, taskId, 'report', `「${task.title}」の全ステップが完了、成果を報告`)
        }
        result = { finished, requesterId: task.requesterId, title: task.title }
      } else if (action === 'block') {
        if (task.status === 'in_progress') {
          await client.query(`UPDATE ai_tasks SET status = 'blocked', updated_at = now() WHERE id = $1`, [taskId])
          await addLog(client, task.aiEmployeeId, taskId, 'escalate', `「${task.title}」がブロックされ対応待ち`)
        } else if (task.status === 'blocked') {
          await client.query(`UPDATE ai_tasks SET status = 'in_progress', updated_at = now() WHERE id = $1`, [taskId])
          await addLog(client, task.aiEmployeeId, taskId, 'plan', `「${task.title}」のブロックが解除され実行を再開`)
        } else {
          throw err('AKO-AIC-007', '実行中またはブロック中のタスクのみ切替できます', 409)
        }
      } else {
        if (task.status === 'done' || task.status === 'cancelled') {
          throw err('AKO-AIC-008', '完了・中止済みのタスクは中止できません', 409)
        }
        await client.query(`UPDATE ai_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`, [taskId])
      }
      await syncEmployeeStatus(client, task.aiEmployeeId)
      result.aiEmployeeId = task.aiEmployeeId
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    // 補助処理: 完了通知（トランザクション確定後・失敗しても遷移は成立 = 原則4）
    if (result.finished && result.requesterId) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ai_employees WHERE id = $1`, [result.aiEmployeeId])
      await notify(pool, result.requesterId, 'ai_report', `AI 完了報告: ${result.title}`,
        `${rows[0]?.name ?? 'AI社員'} がタスクを完了しました`, '/ai-company')
    }
    const { rows: after } = await pool.query(`SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1`, [taskId])
    return c.json({ data: after[0] })
  })

  // 日次報告の生成（活動ログ集約 → daily_reports。既存分はスキップ = 冪等）
  app.post('/daily-reports', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { date?: string }
    const date = String(body.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('AKO-GEN-001', '対象日（date）を指定してください', 400)
    const { rows: logs } = await pool.query<{
      aiEmployeeId: string; taskId: string | null; kind: AiActivityKind; summary: string
      tokens: number; costUsd: number
    }>(
      `SELECT ai_employee_id AS "aiEmployeeId", task_id AS "taskId", kind, summary, tokens,
              cost_usd::float AS "costUsd"
       FROM ai_activity_logs WHERE at LIKE $1 || '%' ORDER BY at`, [date])
    const byEmp = new Map<string, typeof logs>()
    for (const l of logs) byEmp.set(l.aiEmployeeId, [...(byEmp.get(l.aiEmployeeId) ?? []), l])

    let created = 0
    let skipped = 0
    for (const [empId, empLogs] of byEmp) {
      const { rows: exists } = await pool.query(
        `SELECT 1 FROM daily_reports WHERE author_kind = 'ai' AND ai_employee_id = $1 AND date = $2`, [empId, date])
      if (exists.length > 0) { skipped++; continue }

      const { rows: taskRows } = await pool.query<{ id: string; title: string; status: string; decomposition: { done: boolean }[] }>(
        `SELECT id, title, status, decomposition FROM ai_tasks WHERE ai_employee_id = $1`, [empId])
      const taskById = new Map(taskRows.map(t => [t.id, t]))
      const byTask = new Map<string | null, typeof empLogs>()
      for (const l of empLogs) byTask.set(l.taskId, [...(byTask.get(l.taskId) ?? []), l])
      const entries: ReportEntry[] = [...byTask.entries()].map(([taskId, ls]) => {
        const task = taskId ? taskById.get(taskId) : undefined
        const doneCount = task ? task.decomposition.filter(s => s.done).length : 0
        return {
          theme: 'AI カンパニー',
          task: task?.title ?? '問い合わせ対応・その他の活動',
          hours: Math.max(0.25, ls.length * 0.5),
          progress: task
            ? (task.status === 'done' ? 100 : Math.round(doneCount / Math.max(1, task.decomposition.length) * 100))
            : 100,
        }
      })
      const totalTokens = empLogs.reduce((s, l) => s + l.tokens, 0)
      const totalCost = empLogs.reduce((s, l) => s + l.costUsd, 0)
      const issues = empLogs.filter(l => l.kind === 'escalate').map(l => l.summary).join(' / ')
      const remaining = taskRows
        .filter(t => t.status === 'in_progress' || t.status === 'blocked')
        .map(t => (t as unknown as { decomposition: { title: string; done: boolean }[] }).decomposition.find(s => !s.done)?.title)
        .filter((s): s is string => !!s)
      // 並行実行の重複は部分一意インデックス（daily_reports_ai_uq）+ ON CONFLICT で DB が保証（冪等）
      const ins = await pool.query(
        `INSERT INTO daily_reports (id, author_kind, ai_employee_id, date, entries, reflection, issues, tomorrow, status, submitted_at)
         VALUES ($1, 'ai', $2, $3, $4, $5, $6, $7, 'submitted', $8)
         ON CONFLICT (ai_employee_id, date) WHERE author_kind = 'ai' DO NOTHING`,
        [newId('dr'), empId, date, JSON.stringify(entries),
          `活動 ${empLogs.length} 件 / 消費トークン ${totalTokens.toLocaleString('ja-JP')} / 概算コスト $${totalCost.toFixed(3)}`,
          issues,
          remaining.length > 0 ? `継続: ${remaining.join(' / ')}` : '新規依頼の待機',
          `${date}T18:00:00+09:00`])
      if ((ins.rowCount ?? 0) > 0) created++
      else skipped++
    }
    return c.json({ data: { created, skipped } })
  })

  // ワークロードシグナル検知（stalled_task / overload。画面表示を契機に呼ぶ = overtime-check と同パターン）
  app.post('/workload-check', async (c) => {
    let raised = 0
    const { rows: ruleRows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM app_configs WHERE key = 'escalationRules'`)
    const rules = Array.isArray(ruleRows[0]?.value) ? ruleRows[0]!.value as { key?: string; threshold?: number }[] : []
    const stalledThreshold = rules.find(r => r.key === 'stalled_task')?.threshold ?? 3
    const overloadThreshold = rules.find(r => r.key === 'overload')?.threshold ?? 7
    const today = todayJst()
    const stalledCutoff = addDays(today, -stalledThreshold)

    // a) タスク停滞: in_progress タスクの最新活動（ログなしは createdAt）が threshold 日以上前
    const { rows: stalled } = await pool.query<{ id: string; aiEmployeeId: string; title: string; lastKey: string }>(
      `SELECT t.id, t.ai_employee_id AS "aiEmployeeId", t.title,
              substr(COALESCE((SELECT max(l.at) FROM ai_activity_logs l WHERE l.task_id = t.id), t.created_at), 1, 10) AS "lastKey"
       FROM ai_tasks t WHERE t.status = 'in_progress'`)
    for (const t of stalled) {
      if (t.lastKey > stalledCutoff) continue
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.lastKey}T00:00:00Z`)) / 86_400_000)
      const r = await raiseEscalation(pool, {
        reason: 'stalled_task',
        targetAiEmployeeId: t.aiEmployeeId,
        context: `AIタスク「${t.title}」が${days}日間更新されていません`,
        dedupeKey: `stalled:${t.id}`,
      })
      if (r.raised) raised++
    }

    // b) 過負荷: open タスク件数が threshold 超
    const { rows: loads } = await pool.query<{ id: string; name: string; n: number }>(
      `SELECT e.id, e.name, count(t.id)::int AS n
       FROM ai_employees e JOIN ai_tasks t ON t.ai_employee_id = e.id
         AND t.status IN ('proposed','approved','in_progress','blocked')
       WHERE e.active = true GROUP BY e.id, e.name`)
    for (const l of loads) {
      if (l.n <= overloadThreshold) continue
      const r = await raiseEscalation(pool, {
        reason: 'overload',
        targetAiEmployeeId: l.id,
        context: `${l.name} の保有タスクが${l.n}件に達しています`,
        dedupeKey: `overload:${l.id}`,
      })
      if (r.raised) raised++
    }
    return c.json({ data: { raised } })
  })

  return app
}
