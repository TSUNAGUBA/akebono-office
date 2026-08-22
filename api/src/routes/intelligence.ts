/**
 * AKEBONO Intelligence API（改善要望 2026-08-22。requirements §5 モック境界の本実装）。
 * - 記録ストア: インサイト・アクション・分析サイクルの SoT を localStorage からサーバー（0090 intel_*）へ移行。
 *   所有モデルはメンバー単位（従来のユーザー別 localStorage と同じ可視性 = 原則7。全操作 member_id スコープ）。
 * - 分析生成: サーバーがスナップショット（日報・活動・売上等）を DB から組み立て、
 *   Vertex AI（generateJson）で生成 → 失敗・無効環境は shared/domain/intelligence の
 *   決定的ヒューリスティックへフォールバック（原則4。llm フラグで区別 = akebono-dashboard と同型）。
 * - 移行: POST /import が旧ローカル記録（aki.store.v1.<memberId>）を一括取込する。
 *   サーバー側ストアが空のユーザーのみ取込む（再実行しても重複しない = 原則2）。
 * - サイクルは追記のみ・インサイト/アクションは論理削除 + 復元（原則9.5）。
 * エラー: AKO-ITL-001 入力不正 / 002 不在 / 003 状態遷移不正。
 *   分析対象データなし等のエンジン判定は AKI-INS-*（shared エンジンの宣言コード）を 422 で素通しし、
 *   モックモードとエラー表示を一致させる。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import type { Env } from '../env'
import {
  generateInsightDraft, INTEL_ACTION_STATUS_FLOW,
  type EngineData, type EngineInsightDraft, type InsightProposal, type IntelAction,
  type IntelActionStatus, type IntelCycle, type IntelInsight, type InsightTheme,
} from '../../../shared/domain/intelligence'
import { todayJst } from '../../../shared/domain/jst'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'

const jstOf = (col: string, alias: string): string =>
  `to_char(${col} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "${alias}"`

const CYCLE_COLS = `id, theme, target_id AS "targetId", target_name AS "targetName",
  ${jstOf('at', 'at')}, input_snapshot AS "inputSnapshot",
  feedback_considered AS "feedbackConsidered", insight_ids AS "insightIds",
  member_id AS "createdBy", active`

const INSIGHT_COLS = `id, cycle_id AS "cycleId", theme, target_id AS "targetId",
  target_name AS "targetName", title, summary, findings, evidence, proposals, confidence,
  feedback_considered AS "feedbackConsidered", llm, ${jstOf('created_at', 'createdAt')},
  member_id AS "createdBy", active`

const ACTION_COLS = `id, insight_id AS "insightId", proposal_id AS "proposalId", theme,
  target_id AS "targetId", target_name AS "targetName", title, description, status,
  due_date::text AS "dueDate", member_id AS "ownerId", result,
  feedback_rating AS "feedbackRating", feedback_note AS "feedbackNote", feedback_next AS "feedbackNext",
  ${jstOf('created_at', 'createdAt')}, ${jstOf('updated_at', 'updatedAt')}, active`

const THEMES = new Set<string>(['management', 'customer', 'project'])

function themeOf(v: unknown): InsightTheme {
  const s = String(v ?? '').trim()
  if (!THEMES.has(s)) throw err('AKO-ITL-001', 'テーマは management / customer / project を指定してください', 400)
  return s as InsightTheme
}

// ---------- 分析スナップショット（EngineData の Pick 宣言と同じ列のみ SELECT する） ----------

/** 日報は直近 3 ヶ月分（当月 + 前 2 ヶ月）= intelligence フロントの取得範囲と同一（パリティ） */
function dailySinceMonth(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  const idx = y * 12 + (m - 1) - 2
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`
}

async function gatherEngineData(pool: pg.Pool, today: string): Promise<EngineData> {
  const [daily, weekly, monthly, support, sales, partner, customerLogs, salesMonthly, companies, projects]
    = await Promise.all([
      pool.query(
        `SELECT member_id AS "memberId", date::text AS date, entries, issues, status
         FROM daily_reports WHERE status = 'submitted' AND date >= $1::date`, [dailySinceMonth(today)]),
      // 週報・月報は提出済みのみ（エンジンは件数のみを根拠として使う）
      pool.query(`SELECT week_start::text AS "weekStart" FROM weekly_reports WHERE status = 'submitted'`),
      pool.query(`SELECT month_start::text AS "monthStart" FROM monthly_reports WHERE status = 'submitted'`),
      pool.query(
        `SELECT company_id AS "companyId", received_date::text AS "receivedDate", category, status, active
         FROM support_activities`),
      pool.query(
        `SELECT company_id AS "companyId", title, phase, amount::float8 AS amount,
           next_action_date::text AS "nextActionDate", customer_issue AS "customerIssue",
           ${jstOf('created_at', 'createdAt')}, ${jstOf('updated_at', 'updatedAt')}, active
         FROM sales_activities`),
      pool.query(
        `SELECT partner_company_id AS "partnerCompanyId", approach_company_id AS "approachCompanyId",
           status, ${jstOf('created_at', 'createdAt')}, active
         FROM partner_activities`),
      pool.query(`SELECT company_id AS "companyId", log_date::text AS "logDate", active FROM customer_logs`),
      pool.query(`SELECT month, amount::float8 AS amount FROM sales_monthly`),
      pool.query(`SELECT id, name FROM companies`),
      pool.query(`SELECT id, name, status, end_date::text AS "endDate" FROM projects`),
    ])
  return {
    daily: daily.rows,
    weekly: weekly.rows,
    monthly: monthly.rows,
    support: support.rows,
    sales: sales.rows,
    partner: partner.rows,
    customerLogs: customerLogs.rows,
    salesMonthly: salesMonthly.rows,
    companies: companies.rows,
    projects: projects.rows,
  } as EngineData
}

// ---------- LLM 仕上げ（ヒューリスティック案を素材に文面・提案を精緻化。失敗はフォールバック = 原則4） ----------

const PRIORITIES = new Set(['high', 'mid', 'low'])

interface LlmDraft {
  title: string
  summary: string
  findings: string[]
  proposals: { title: string; description: string; priority: 'high' | 'mid' | 'low' }[]
}

/** LLM 出力の正規化（欠落・型崩れは null = ヒューリスティックへフォールバック） */
export function normalizeInsightDraft(res: unknown): LlmDraft | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const title = String(r.title ?? '').trim()
  const summary = String(r.summary ?? '').trim()
  if (!title || !summary) return null
  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .map(f => String(f ?? '').trim()).filter(Boolean).slice(0, 8)
  const proposals = (Array.isArray(r.proposals) ? r.proposals : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map(p => ({
      title: String(p.title ?? '').trim(),
      description: String(p.description ?? '').trim(),
      priority: (PRIORITIES.has(String(p.priority)) ? String(p.priority) : 'mid') as 'high' | 'mid' | 'low',
    }))
    .filter(p => p.title.length > 0)
    .slice(0, 6)
  if (findings.length === 0) return null
  return { title, summary, findings, proposals }
}

async function llmRefineDraft(
  env: Env, theme: InsightTheme, heuristic: EngineInsightDraft,
): Promise<LlmDraft | null> {
  if (!env.vertexProjectId) return null
  const themeLabel = theme === 'management' ? '経営（全社横断）' : theme === 'customer' ? '顧客' : '案件'
  const res = await generateJson<Record<string, unknown>>(env, {
    system: 'あなたは事業会社の経営参謀 AI です。社内の業務データ（日報・週報・月報・サポート/営業/'
      + 'ビジネスパートナー活動・顧客活動・月次売上）を決定的に集計した分析ドラフトを素材に、'
      + `${themeLabel}テーマのインサイト（発見事項）と実行提案を日本語で仕上げます。`
      + 'ドラフトの集計値・固有名詞にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'findings は 3〜8 件（各 1〜2 文）。proposals は最大 6 件で priority は high / mid / low。'
      + 'ドラフトの「反映済みフィードバック」の趣旨（継続・代替・重複抑制）は維持すること。',
    prompt: `# 分析ドラフト（決定的集計）\n${JSON.stringify({
      targetName: heuristic.targetName,
      title: heuristic.title,
      findings: heuristic.findings,
      evidence: heuristic.evidence,
      proposals: heuristic.proposals,
      feedbackConsidered: heuristic.feedbackConsidered,
    }, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' },
            },
            required: ['title', 'description', 'priority'],
          },
        },
      },
      required: ['title', 'summary', 'findings', 'proposals'],
    },
    maxTokens: 3000,
  })
  return normalizeInsightDraft(res)
}

// ---------- 行ヘルパー ----------

async function findOwnRow(
  pool: pg.Pool, table: 'intel_insights' | 'intel_actions', cols: string, id: string, userId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT ${cols} FROM ${table} WHERE id = $1 AND member_id = $2`, [id, userId])
  if (!rows[0]) throw err('AKO-ITL-002', '対象が見つかりません', 404)
  return rows[0]
}

function strOf(v: unknown): string {
  return String(v ?? '').trim()
}

export function intelligenceRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---------- ストア一括取得（本人の記録のみ。1 リクエストで 3 コレクション） ----------
  app.get('/store', async (c) => {
    const user = c.get('user')
    const [insights, actions, cycles] = await Promise.all([
      pool.query(`SELECT ${INSIGHT_COLS} FROM intel_insights WHERE member_id = $1 ORDER BY created_at, id`, [user.id]),
      pool.query(`SELECT ${ACTION_COLS} FROM intel_actions WHERE member_id = $1 ORDER BY created_at, id`, [user.id]),
      pool.query(`SELECT ${CYCLE_COLS} FROM intel_cycles WHERE member_id = $1 ORDER BY at, id`, [user.id]),
    ])
    return c.json({ data: { insights: insights.rows, actions: actions.rows, cycles: cycles.rows } })
  })

  // ---------- 分析生成（サーバーがスナップショット収集 → LLM → フォールバック → 記録） ----------
  app.post('/generate', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const theme = themeOf(b.theme)
    const targetId = theme === 'management' ? null : strOf(b.targetId)
    if (theme !== 'management' && !targetId) throw err('AKO-ITL-001', '分析対象を選択してください', 400)

    const today = todayJst()
    const [data, pastActionsRes] = await Promise.all([
      gatherEngineData(pool, today),
      pool.query(
        `SELECT ${ACTION_COLS} FROM intel_actions WHERE member_id = $1 AND active = true`, [user.id]),
    ])
    const draftRes = generateInsightDraft(data, {
      theme, targetId, today, pastActions: pastActionsRes.rows as unknown as IntelAction[],
    })
    if (!draftRes.ok) {
      // 分析対象データなし等（エンジン宣言コード AKI-INS-*）はモックモードと同一表示になるよう素通し
      throw err(draftRes.error.code, draftRes.error.message, 422)
    }

    // LLM 仕上げ（無効環境・失敗はヒューリスティックのまま = 原則4）
    const llmDraft = await llmRefineDraft(env, theme, draftRes)
    const llm = !!llmDraft
    const title = llmDraft?.title ?? draftRes.title
    const summary = llmDraft?.summary ?? draftRes.summary
    const findings = llmDraft?.findings ?? draftRes.findings
    const proposalDrafts = llmDraft?.proposals ?? draftRes.proposals

    const cycleId = newId('cy')
    const insightId = newId('ins')
    const proposals: InsightProposal[] = proposalDrafts.map((p, i) => ({ ...p, id: `${insightId}-p${i + 1}` }))

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO intel_cycles (id, member_id, theme, target_id, target_name, input_snapshot, feedback_considered, insight_ids)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
        [cycleId, user.id, theme, targetId, draftRes.targetName,
          JSON.stringify(draftRes.evidence), JSON.stringify(draftRes.feedbackConsidered), JSON.stringify([insightId])])
      await client.query(
        `INSERT INTO intel_insights
           (id, member_id, cycle_id, theme, target_id, target_name, title, summary,
            findings, evidence, proposals, confidence, feedback_considered, llm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14)`,
        [insightId, user.id, cycleId, theme, targetId, draftRes.targetName, title, summary,
          JSON.stringify(findings), JSON.stringify(draftRes.evidence), JSON.stringify(proposals),
          draftRes.confidence, JSON.stringify(draftRes.feedbackConsidered), llm])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'intel_insights', entityId: insightId,
      detail: `インサイトを生成（${llm ? 'AI' : 'ヒューリスティック'}）`,
    })
    const insight = await findOwnRow(pool, 'intel_insights', INSIGHT_COLS, insightId, user.id)
    return c.json({ data: { insight, llm } }, 201)
  })

  // ---------- インサイトのアーカイブ / 復元（論理削除・冪等 = 原則9.5） ----------
  app.post('/insights/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findOwnRow(pool, 'intel_insights', 'id', id, user.id)
    const upd = await pool.query(
      `UPDATE intel_insights SET active = false WHERE id = $1 AND member_id = $2 AND active = true`, [id, user.id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでにアーカイブ済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'intel_insights', entityId: id, detail: 'インサイトをアーカイブ' })
    return c.json({ data: { id } })
  })

  app.post('/insights/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findOwnRow(pool, 'intel_insights', 'id', id, user.id)
    const upd = await pool.query(
      `UPDATE intel_insights SET active = true WHERE id = $1 AND member_id = $2 AND active = false`, [id, user.id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'アーカイブされていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'intel_insights', entityId: id, detail: 'インサイトを復元' })
    return c.json({ data: { id } })
  })

  // ---------- アクション（登録・編集・状態遷移・結果・フィードバック・アーカイブ/復元） ----------
  app.post('/actions', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const title = strOf(b.title)
    if (!title) throw err('AKO-ITL-001', 'タイトルを入力してください', 400)
    const theme = themeOf(b.theme)
    const insightId = strOf(b.insightId) || null
    // 由来インサイトは本人のもののみ紐付け可（他人の記録への参照を作らない）
    if (insightId) await findOwnRow(pool, 'intel_insights', 'id', insightId, user.id)
    const id = newId('act')
    await pool.query(
      `INSERT INTO intel_actions
         (id, member_id, insight_id, proposal_id, theme, target_id, target_name, title, description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)`,
      [id, user.id, insightId, strOf(b.proposalId) || null, theme,
        strOf(b.targetId) || null, strOf(b.targetName), title, strOf(b.description), strOf(b.dueDate) || null])
    await audit(pool, { actorId: user.id, action: 'create', entity: 'intel_actions', entityId: id, detail: 'アクションを登録' })
    return c.json({ data: await findOwnRow(pool, 'intel_actions', ACTION_COLS, id, user.id) }, 201)
  })

  app.patch('/actions/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    await findOwnRow(pool, 'intel_actions', 'id', id, user.id)
    const has = (k: string): boolean => Object.hasOwn(b, k)
    if (has('title') && !strOf(b.title)) throw err('AKO-ITL-001', 'タイトルを入力してください', 400)
    // 送られたキーのみ更新（部分更新の安全側 = Object.hasOwn。Zod .partial() の既定値注入問題と同型の防御）
    const sets: string[] = []
    const params: unknown[] = [id, user.id]
    const add = (col: string, value: unknown, cast = ''): void => {
      params.push(value)
      sets.push(`${col} = $${params.length}${cast}`)
    }
    if (has('title')) add('title', strOf(b.title))
    if (has('description')) add('description', strOf(b.description))
    if (has('dueDate')) add('due_date', strOf(b.dueDate) || null, '::date')
    if (sets.length === 0) throw err('AKO-ITL-001', '更新する項目がありません', 400)
    await pool.query(
      `UPDATE intel_actions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND member_id = $2`, params)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'intel_actions', entityId: id, detail: 'アクションを編集' })
    return c.json({ data: await findOwnRow(pool, 'intel_actions', ACTION_COLS, id, user.id) })
  })

  app.post('/actions/:id/transition', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const next = strOf(b.status) as IntelActionStatus
    const cur = await findOwnRow(pool, 'intel_actions', 'id, status', id, user.id) as { status: IntelActionStatus }
    if (!INTEL_ACTION_STATUS_FLOW[cur.status]?.includes(next)) {
      throw err('AKO-ITL-003', `「${cur.status}」から「${String(b.status)}」へは変更できません`, 400)
    }
    await pool.query(
      `UPDATE intel_actions SET status = $3, updated_at = now() WHERE id = $1 AND member_id = $2`, [id, user.id, next])
    await audit(pool, { actorId: user.id, action: 'update', entity: 'intel_actions', entityId: id, detail: `アクションを「${next}」へ変更` })
    return c.json({ data: await findOwnRow(pool, 'intel_actions', ACTION_COLS, id, user.id) })
  })

  app.post('/actions/:id/result', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    await findOwnRow(pool, 'intel_actions', 'id', id, user.id)
    await pool.query(
      `UPDATE intel_actions SET result = $3, updated_at = now() WHERE id = $1 AND member_id = $2`,
      [id, user.id, strOf(b.result)])
    await audit(pool, { actorId: user.id, action: 'update', entity: 'intel_actions', entityId: id, detail: 'アクションの結果を記録' })
    return c.json({ data: await findOwnRow(pool, 'intel_actions', ACTION_COLS, id, user.id) })
  })

  app.post('/actions/:id/feedback', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const rating = Number(b.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw err('AKO-ITL-001', '評価は 1〜5 で入力してください', 400)
    }
    await findOwnRow(pool, 'intel_actions', 'id', id, user.id)
    await pool.query(
      `UPDATE intel_actions SET feedback_rating = $3, feedback_note = $4, feedback_next = $5, updated_at = now()
       WHERE id = $1 AND member_id = $2`,
      [id, user.id, rating, strOf(b.note), strOf(b.next)])
    await audit(pool, { actorId: user.id, action: 'update', entity: 'intel_actions', entityId: id, detail: 'アクションのフィードバックを記録' })
    return c.json({ data: await findOwnRow(pool, 'intel_actions', ACTION_COLS, id, user.id) })
  })

  app.post('/actions/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findOwnRow(pool, 'intel_actions', 'id', id, user.id)
    const upd = await pool.query(
      `UPDATE intel_actions SET active = false, updated_at = now() WHERE id = $1 AND member_id = $2 AND active = true`,
      [id, user.id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでにアーカイブ済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'intel_actions', entityId: id, detail: 'アクションをアーカイブ' })
    return c.json({ data: { id } })
  })

  app.post('/actions/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findOwnRow(pool, 'intel_actions', 'id', id, user.id)
    const upd = await pool.query(
      `UPDATE intel_actions SET active = true, updated_at = now() WHERE id = $1 AND member_id = $2 AND active = false`,
      [id, user.id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'アーカイブされていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'intel_actions', entityId: id, detail: 'アクションを復元' })
    return c.json({ data: { id } })
  })

  // ---------- 旧ローカル記録の移行取込（原則1: 手動の書き写しをさせない） ----------
  // サーバー側ストアが**空のユーザーのみ**取込む = 再実行しても重複しない（原則2）。
  // 旧 id（ins-0001 等）はユーザー間で衝突するためサーバー id へ再採番し、参照
  // （cycle.insightIds / insight.cycleId / action.insightId / proposalId）を張り替える。
  app.post('/import', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const insights = (Array.isArray(b.insights) ? b.insights : []) as IntelInsight[]
    const actions = (Array.isArray(b.actions) ? b.actions : []) as IntelAction[]
    const cycles = (Array.isArray(b.cycles) ? b.cycles : []) as IntelCycle[]
    // 上限は明示エラー（黙って切り捨てない = 部分移行で残りが取り残される事故を防ぐ。
    // 移行元はブラウザ手動生成の記録のため現実的な件数は数十件規模）
    const MAX_IMPORT = 2000
    if (insights.length > MAX_IMPORT || actions.length > MAX_IMPORT || cycles.length > MAX_IMPORT) {
      throw err('AKO-ITL-001', `取込件数が上限（各 ${MAX_IMPORT} 件）を超えています`, 400)
    }
    if (insights.length === 0 && actions.length === 0 && cycles.length === 0) {
      return c.json({ data: { imported: 0 } })
    }
    const existing = await pool.query(
      `SELECT (SELECT count(*) FROM intel_insights WHERE member_id = $1)
            + (SELECT count(*) FROM intel_actions WHERE member_id = $1)
            + (SELECT count(*) FROM intel_cycles WHERE member_id = $1) AS n`, [user.id])
    if (Number(existing.rows[0]?.n ?? 0) > 0) {
      return c.json({ data: { imported: 0, warning: 'サーバーに既存の記録があるため取込をスキップしました' } })
    }

    // id 再採番マップ（参照整合を保って張り替える）
    const cycleIdMap = new Map<string, string>()
    const insightIdMap = new Map<string, string>()
    for (const cy of cycles) cycleIdMap.set(cy.id, newId('cy'))
    for (const ins of insights) insightIdMap.set(ins.id, newId('ins'))
    const remapProposalId = (pid: string | null): string | null => {
      if (!pid) return null
      for (const [oldId, newIdVal] of insightIdMap) {
        if (pid.startsWith(`${oldId}-`)) return `${newIdVal}-${pid.slice(oldId.length + 1)}`
      }
      return pid
    }

    let imported = 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const cy of cycles) {
        await client.query(
          `INSERT INTO intel_cycles
             (id, member_id, theme, target_id, target_name, at, input_snapshot, feedback_considered, insight_ids, active)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
          [cycleIdMap.get(cy.id), user.id, cy.theme, cy.targetId, strOf(cy.targetName), cy.at,
            JSON.stringify(cy.inputSnapshot ?? []), JSON.stringify(cy.feedbackConsidered ?? []),
            JSON.stringify((cy.insightIds ?? []).map(i => insightIdMap.get(i) ?? i)), cy.active !== false])
        imported++
      }
      for (const ins of insights) {
        // 対応するサイクルが無い旧データは取込のためプレースホルダサイクルを補完する（FK 整合）
        let cid = cycleIdMap.get(ins.cycleId)
        if (!cid) {
          cid = newId('cy')
          cycleIdMap.set(ins.cycleId, cid)
          await client.query(
            `INSERT INTO intel_cycles (id, member_id, theme, target_id, target_name, at, insight_ids)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)`,
            [cid, user.id, ins.theme, ins.targetId, strOf(ins.targetName), ins.createdAt,
              JSON.stringify([insightIdMap.get(ins.id)])])
        }
        await client.query(
          `INSERT INTO intel_insights
             (id, member_id, cycle_id, theme, target_id, target_name, title, summary,
              findings, evidence, proposals, confidence, feedback_considered, active, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15::timestamptz)`,
          [insightIdMap.get(ins.id), user.id, cid, ins.theme, ins.targetId, strOf(ins.targetName),
            strOf(ins.title) || '(無題)', strOf(ins.summary),
            JSON.stringify(ins.findings ?? []), JSON.stringify(ins.evidence ?? []),
            JSON.stringify((ins.proposals ?? []).map(p => ({ ...p, id: remapProposalId(p.id) }))),
            ins.confidence ?? 'low', JSON.stringify(ins.feedbackConsidered ?? []),
            ins.active !== false, ins.createdAt])
        imported++
      }
      for (const a of actions) {
        await client.query(
          `INSERT INTO intel_actions
             (id, member_id, insight_id, proposal_id, theme, target_id, target_name, title, description,
              status, due_date, result, feedback_rating, feedback_note, feedback_next, active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16, $17::timestamptz, $18::timestamptz)`,
          [newId('act'), user.id, a.insightId ? (insightIdMap.get(a.insightId) ?? null) : null,
            remapProposalId(a.proposalId), a.theme, a.targetId, strOf(a.targetName),
            strOf(a.title) || '(無題)', strOf(a.description),
            INTEL_ACTION_STATUS_FLOW[a.status] ? a.status : 'planned', a.dueDate || null, strOf(a.result),
            Number.isInteger(a.feedbackRating) ? a.feedbackRating : null,
            strOf(a.feedbackNote), strOf(a.feedbackNext), a.active !== false, a.createdAt, a.updatedAt || a.createdAt])
        imported++
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw err('AKO-ITL-001', `ローカル記録の取込に失敗しました（${(e as Error).message}）`, 400)
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'intel_insights', entityId: user.id,
      detail: `ローカル記録をサーバーへ移行（${imported} 件）`,
    })
    return c.json({ data: { imported } }, 201)
  })

  return app
}
