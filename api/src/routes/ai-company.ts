/**
 * AI ネイティブカンパニー API（F-08）。mockup useAiCompany の API 版。
 * - AI ロール / AI 社員は汎用マスタ（/v1/masters/ai-roles・ai-employees。管理者のみ変更）
 * - タスク依頼 → 分解（Vertex AI 構造化出力 → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック）
 *   → 承認 → 実行 → 完了報告。状態機械は FOR UPDATE で直列化（proposed → in_progress → done / blocked / cancelled）
 * - ai_employees.status はタスク状態からの派生（SoT: ai_tasks → 操作時にサーバーが同期）
 * - 活動ログは追記のみ（記録系）。トークン/コストは決定的モック値（実 LLM 課金の代替 = 設計判断）
 * - 日次報告は既存 daily_reports（author_kind='ai'）へ生成。既存分はスキップ = 冪等（原則2）
 * - 低確信度・停滞・過負荷は raiseEscalation（クールダウン冪等・非ブロッキング = 原則4）
 * - 実遂行（バッチ7f）: 「進める」でステップを LLM が実際に遂行し成果物（outputs）を生成。
 *   人間の判断が必要な場合は依頼者へ質問（ai_task_questions）してブロック → 回答（/answer）で再開。
 *   依頼・回答の添付（画像/ドキュメント = ai_task_files）は抽出テキスト + マルチモーダルで材料化
 * エラー: AKO-AIC-001〜014（api-design の台帳に準拠）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  buildFinalReport, decomposeTask, DELEGATE_PERMISSION, heuristicNeedsInput, heuristicStepOutput, judgeTaskConfidence,
  mockActivityCost, planDelegation,
  type DelegationCandidate,
} from '../../../shared/domain/ai-tasks'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { AiActivityKind, AiModelTier, AiTask, AiTaskOutput, ReportEntry } from '../../../shared/domain/types'
import type { Env } from '../env'
import { raiseEscalation } from '../lib/escalate'
import { extractDocumentText } from '../lib/extract-text'
import { capCp } from '../lib/text'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { notify } from '../lib/notify'

// questions / files（メタのみ）はタスク行へ埋め込んで返す（フロントの型 = AiTask.questions/files と一致。
// 一覧 LIMIT 200 での相関サブクエリは SME 規模で十分軽量）。
// 可視性の設計判断（バッチ7f レビュー R-5）: タスクボードは従来どおり全員参照（C2）で、
// 成果物・質問/回答（添付から抽出したテキストの引用を含む）も全員に見える = チームで共有する前提。
// 原本ファイル（バイナリ）のダウンロードのみ依頼者 + 管理者に制限する（GET /files/:id）
const TASK_COLS = `id, ai_employee_id AS "aiEmployeeId", requester_id AS "requesterId",
  title, description, decomposition, outputs, status, due_date::text AS "dueDate", confidence, created_at AS "createdAt",
  requester_ai_employee_id AS "requesterAiEmployeeId", parent_task_id AS "parentTaskId",
  (SELECT COALESCE(json_agg(json_build_object(
      'id', q.id, 'stepIndex', q.step_index, 'question', q.question, 'status', q.status,
      'answer', q.answer, 'answeredBy', q.answered_by,
      'askedAt', to_char(q.asked_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'),
      'answeredAt', CASE WHEN q.answered_at IS NULL THEN NULL
        ELSE to_char(q.answered_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') END
    ) ORDER BY q.asked_at, q.id), '[]'::json)
   FROM ai_task_questions q WHERE q.task_id = ai_tasks.id) AS questions,
  (SELECT COALESCE(json_agg(json_build_object(
      'id', f.id, 'filename', f.filename, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'questionId', f.question_id
    ) ORDER BY f.created_at, f.id), '[]'::json)
   FROM ai_task_files f WHERE f.task_id = ai_tasks.id) AS files`
const LOG_COLS = `id, ai_employee_id AS "aiEmployeeId", task_id AS "taskId", kind, summary, tokens,
  cost_usd::float AS "costUsd", at`

// ---------- 添付（依頼者インプット: 画像 + ドキュメント。バッチ7f） ----------

const TASK_FILE_EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png'])
const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024
const MAX_TASK_FILES = 5
const EXTRACT_CAP = 20_000

interface PreparedAttachment {
  filename: string
  ext: string
  mime: string
  bytes: Buffer
  extractedText: string | null
}

/**
 * 添付の検証と抽出（.md/.txt/.pdf/.docx/.pptx = テキスト抽出・.jpg/.png = 画像として保持し LLM へ渡す）。
 * DB 書込前に全件検証する = 失敗時に中途半端な保存を残さない
 */
async function prepareAttachments(raw: unknown): Promise<PreparedAttachment[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw err('AKO-AIC-010', 'attachments は配列で指定してください', 400)
  if (raw.length > MAX_TASK_FILES) throw err('AKO-AIC-011', `添付は ${MAX_TASK_FILES} 件までです`, 400)
  const out: PreparedAttachment[] = []
  for (const a of raw as { filename?: unknown; contentBase64?: unknown }[]) {
    const filename = String(a?.filename ?? '').trim()
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
    const mime = TASK_FILE_EXT_MIME[ext]
    if (!mime) {
      throw err('AKO-AIC-010',
        `対応形式は .md / .txt / .pdf / .docx / .pptx / .jpg / .png です${ext === 'doc' || ext === 'ppt' ? '（旧形式は新形式へ変換してください）' : ''}`, 400)
    }
    const contentBase64 = String(a?.contentBase64 ?? '')
    if (!contentBase64 || contentBase64.length > MAX_TASK_FILE_BYTES * 1.4) {
      throw err('AKO-AIC-011', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_TASK_FILE_BYTES) {
      throw err('AKO-AIC-011', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    // 抽出失敗（画像のみの PDF 等）は原本のみ保全して継続（フェイルオープン = 依頼自体は成立させる）
    const extractedText = IMAGE_EXTS.has(ext)
      ? null
      : capCp(((await extractDocumentText(ext, bytes)) ?? '').trim(), EXTRACT_CAP) || null
    out.push({ filename, ext, mime, bytes, extractedText })
  }
  return out
}

async function insertAttachments(
  db: pg.Pool | pg.PoolClient,
  taskId: string,
  questionId: string | null,
  uploadedBy: string,
  files: PreparedAttachment[],
): Promise<void> {
  for (const f of files) {
    await db.query(
      `INSERT INTO ai_task_files (id, task_id, question_id, filename, mime, size_bytes, bytes, extracted_text, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId('atf'), taskId, questionId, capCp(f.filename, 200), f.mime, f.bytes.length, f.bytes, f.extractedText, uploadedBy])
  }
}

/** タスクの実行材料（依頼文 + 回答済み Q&A + 添付抽出テキスト。LLM/ヒューリスティック共通） */
async function taskMaterials(pool: pg.Pool, task: AiTask): Promise<{
  text: string
  images: { mime: string; dataBase64: string }[]
  answeredCount: number
}> {
  const { rows: qs } = await pool.query<{ question: string; answer: string | null }>(
    `SELECT question, answer FROM ai_task_questions WHERE task_id = $1 AND status = 'answered'
     ORDER BY asked_at, id`, [task.id])
  const { rows: files } = await pool.query<{ filename: string; extractedText: string | null }>(
    `SELECT filename, extracted_text AS "extractedText"
     FROM ai_task_files WHERE task_id = $1 ORDER BY created_at, id`, [task.id])
  // 画像は SQL 側で 3 枚に制限（bytes の全件ロードを避ける）。Vertex の inline data 上限（~20MB/リクエスト）は
  // 入口の 10MB×3 制限内でも超え得るため、超過時は API エラー → ヒューリスティック縮退（原則4）で自己回復する
  const { rows: imgRows } = await pool.query<{ mime: string; bytes: Buffer }>(
    `SELECT mime, bytes FROM ai_task_files WHERE task_id = $1 AND mime LIKE 'image/%'
     ORDER BY created_at, id LIMIT 3`, [task.id])
  const parts: string[] = [`依頼内容: ${task.description || '（記載なし）'}`]
  for (const q of qs) parts.push(`確認済み Q&A:\nQ: ${q.question}\nA: ${q.answer ?? ''}`)
  for (const f of files) {
    if (f.extractedText) parts.push(`添付「${f.filename}」の内容:\n${capCp(f.extractedText, 6000)}`)
  }
  const images = imgRows.map(f => ({ mime: f.mime, dataBase64: f.bytes.toString('base64') }))
  return { text: capCp(parts.join('\n\n'), 16_000), images, answeredCount: qs.length }
}

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

/**
 * ステップの実遂行（バッチ7f）。LLM が材料（依頼文・Q&A・添付）に基づき実際に成果物を生成する。
 * 人間の判断・情報が必要と判定した場合は needsInput=true + 具体的な質問を返す（依頼者へ確認）。
 * LLM 無効・失敗時は決定的ヒューリスティック（heuristicNeedsInput / heuristicStepOutput）へ（原則4）
 */
async function prepareStepExecution(
  pool: pg.Pool,
  env: Env,
  task: AiTask & { decomposition: { title: string; done: boolean }[]; outputs: AiTaskOutput[] },
  stepIndex: number,
): Promise<{ kind: 'output'; body: string } | { kind: 'question'; question: string }> {
  const step = task.decomposition[stepIndex]!
  const materials = await taskMaterials(pool, task)
  const { rows: roleRows } = await pool.query<{ name: string; mission: string; systemPrompt: string }>(
    `SELECT r.name, r.mission, r.system_prompt AS "systemPrompt"
     FROM ai_employees e JOIN ai_roles r ON r.id = e.role_id WHERE e.id = $1`, [task.aiEmployeeId])
  const role = roleRows[0]
  const priorOutputs = task.outputs
    .filter(o => o.step >= 0)
    .map(o => `【${o.title}】\n${capCp(o.body, 1500)}`)
    .join('\n\n')
  const res = await generateJson<{ needsInput?: boolean; question?: string; output?: string }>(env, {
    system: `あなたは AI 社員「${role?.name ?? '汎用'}」です。ミッション: ${role?.mission ?? ''}\n`
      + `${role?.systemPrompt ? `${role.systemPrompt}\n` : ''}`
      + 'タスクの現在のステップを実際に遂行し、成果物をマークダウンで出力します。'
      + '材料（依頼文・確認済み Q&A・添付）にある情報のみを使い、推測で事実を作らないこと。'
      + '人間の判断・追加情報がないと遂行できない場合のみ needsInput=true とし、依頼者への具体的な質問を question に書くこと'
      + '（その場合 output は空でよい）。',
    prompt: `# タスク\n件名: ${task.title}\n\n# 材料\n${materials.text}`
      + (priorOutputs ? `\n\n# これまでのステップ成果\n${capCp(priorOutputs, 6000)}` : '')
      + `\n\n# 今回遂行するステップ\n${step.title}\n\nこのステップを遂行し、成果物を出力してください。`,
    schema: {
      type: 'object',
      properties: {
        needsInput: { type: 'boolean' },
        question: { type: 'string' },
        output: { type: 'string' },
      },
      required: ['needsInput', 'output'],
    },
    maxTokens: 4096,
    images: materials.images,
  })
  if (res) {
    // 再質問はタスクあたり 3 回まで（LLM が needsInput を返し続ける無限問答の防止。
    // 上限到達後は needsInput を無視して output を採用し、output が空なら決定的出力へ縮退する）
    if (res.needsInput && String(res.question ?? '').trim() && materials.answeredCount < 3) {
      return { kind: 'question', question: capCp(String(res.question).trim(), 500) }
    }
    const body = String(res.output ?? '').trim()
    if (body) return { kind: 'output', body: capCp(body, 6000) }
  }
  // フォールバック（LLM 無効・失敗・空応答）: 決定的ヒューリスティック
  const q = heuristicNeedsInput(task.description, materials.answeredCount)
  if (q) return { kind: 'question', question: q }
  return { kind: 'output', body: heuristicStepOutput(task.title, step.title, materials.text) }
}

/**
 * 連携計画（LLM 構造化出力。失敗・不正 id は null = shared/domain/ai-tasks の planDelegation へフォールバック）。
 * 各分解ステップを、候補 AI 社員の役割・ミッションに照らして最適な担当へ割り当てる
 */
async function llmPlanDelegation(
  env: Env,
  title: string,
  steps: { title: string }[],
  candidates: DelegationCandidate[],
): Promise<{ title: string; aiEmployeeId: string }[] | null> {
  const validIds = new Set(candidates.map(cand => cand.id))
  const res = await generateJson<{ assignments?: { aiEmployeeId?: string }[] }>(env, {
    system: 'あなたは AI 社員チームのマネージャーです。タスクの各ステップを、最も適した AI 社員へ割り当てます。',
    prompt: `タスク「${title}」の各ステップを担当 AI 社員へ割り当ててください。\n`
      + `ステップ（この順で assignments を返す）:\n${steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}\n`
      + `候補 AI 社員:\n${candidates.map(cand => `- id=${cand.id}: ${cand.name}（${cand.roleName} / ${cand.mission}）`).join('\n')}`,
    schema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          items: { type: 'object', properties: { aiEmployeeId: { type: 'string' } }, required: ['aiEmployeeId'] },
        },
      },
      required: ['assignments'],
    },
    maxTokens: 512,
  })
  const assignments = res?.assignments
  if (!Array.isArray(assignments) || assignments.length !== steps.length) return null
  if (!assignments.every(a => a.aiEmployeeId && validIds.has(a.aiEmployeeId))) return null
  return steps.map((s, i) => ({ title: s.title, aiEmployeeId: assignments[i]!.aiEmployeeId! }))
}

/**
 * 承認前の連携計画（トランザクション外で実行する = LLM 呼び出し（最長 30 秒）中に
 * タスク行ロック・プール接続を保持しない。レビュー PR #48 R1 指摘。llmDecompose と同じ配置）。
 * 対象外（子タスク・delegate 権限なし・候補ゼロ）は null = 連携なし
 */
async function prepareDelegationPlan(
  pool: pg.Pool,
  env: Env,
  task: AiTask & { decomposition: { title: string; done: boolean }[] },
): Promise<{ plan: { title: string; aiEmployeeId: string }[]; candidates: DelegationCandidate[]; managerName: string } | null> {
  if (task.parentTaskId) return null
  const { rows: roleRows } = await pool.query<{ permissions: string[]; name: string }>(
    `SELECT r.permissions, e.name FROM ai_employees e JOIN ai_roles r ON r.id = e.role_id WHERE e.id = $1`,
    [task.aiEmployeeId])
  if (!(roleRows[0]?.permissions ?? []).includes(DELEGATE_PERMISSION)) return null
  const { rows: candidates } = await pool.query<DelegationCandidate>(
    `SELECT e.id, e.name, r.name AS "roleName", r.mission
     FROM ai_employees e JOIN ai_roles r ON r.id = e.role_id
     WHERE e.active = true AND e.id <> $1 ORDER BY e.id`, [task.aiEmployeeId])
  if (candidates.length === 0 || task.decomposition.length === 0) return null
  const plan = (await llmPlanDelegation(env, task.title, task.decomposition, candidates))
    ?? planDelegation(task.decomposition, candidates)
  return { plan, candidates, managerName: roleRows[0]?.name ?? 'マネージャー' }
}

/**
 * 承認時の連携（AI 社員間の依頼・連携 = オペレーター指示 2026-07-19 #3）。
 * - 対象: delegate 権限（AiRole.permissions）を持つロールの AI 社員（= マネージャーロール）
 * - 子タスクからの再連携はしない（連鎖の暴走防止）。候補ゼロ（自分以外に有効な AI 社員なし）は連携なし
 * - 割当は事前計画（prepareDelegationPlan = LLM → 決定的フォールバック）を受け取り、INSERT のみ行う
 * - 子タスクは即 in_progress（人間の承認は親の 1 回のみ = 依頼を一挙に引き受ける）
 */
async function delegateOnApprove(
  client: pg.PoolClient,
  task: AiTask & { decomposition: { title: string; done: boolean }[] },
  prepared: { plan: { title: string; aiEmployeeId: string }[]; candidates: DelegationCandidate[]; managerName: string },
): Promise<number> {
  const { candidates, managerName } = prepared
  // 事前計画とロック後の分解が食い違う場合（通常起きない防御）は決定的計画で作り直す
  const plan = prepared.plan.length === task.decomposition.length
    && prepared.plan.every((p, i) => p.title === task.decomposition[i]!.title)
    ? prepared.plan
    : planDelegation(task.decomposition, candidates)
  // 担当ごとにステップをまとめて 1 子タスク（AI 社員 1 名 = 分担 1 件でボードが読みやすい）
  const byEmp = new Map<string, string[]>()
  for (const p of plan) byEmp.set(p.aiEmployeeId, [...(byEmp.get(p.aiEmployeeId) ?? []), p.title])
  let delegated = 0
  for (const [empId, stepTitles] of byEmp) {
    const cand = candidates.find(x => x.id === empId)
    if (!cand) continue
    const childId = newId('at')
    const childTitle = capCp(`${task.title}（分担: ${cand.roleName}）`, 100)
    const description = `マネージャー ${managerName} からの連携依頼（元タスク: ${task.title}）`
    await client.query(
      `INSERT INTO ai_tasks (id, ai_employee_id, requester_id, title, description, decomposition, status,
         confidence, created_at, requester_ai_employee_id, parent_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7, $8, $9, $10)`,
      [childId, empId, task.requesterId, childTitle, description,
        JSON.stringify(stepTitles.map(t => ({ title: t, done: false }))),
        judgeTaskConfidence(empId, childTitle, description), nowJstIso(), task.aiEmployeeId, task.id])
    await addLog(client, task.aiEmployeeId, task.id, 'chat',
      `${cand.name} へ「${task.title}」の分担を依頼（${stepTitles.length} ステップ）`)
    await addLog(client, empId, childId, 'plan', `${managerName} から「${task.title}」の分担を受領し実行を開始`)
    await syncEmployeeStatus(client, empId)
    delegated++
  }
  return delegated
}

/**
 * 分担子タスク完了時の親（マネージャー）へのロールアップ。
 * 子のステップと同名の親ステップを done 化し、全子タスク完了で親も done + 統合報告。
 * 戻り値 = 親が完了した場合の通知材料（null = 継続中）
 */
async function rollUpToParent(
  client: pg.PoolClient,
  child: AiTask & { decomposition: { title: string; done: boolean }[] },
): Promise<{ requesterId: string; title: string; managerId: string } | null> {
  const { rows: pRows } = await client.query<AiTask & { decomposition: { title: string; done: boolean }[] }>(
    `SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1 FOR UPDATE`, [child.parentTaskId])
  const parent = pRows[0]
  if (!parent || (parent.status !== 'in_progress' && parent.status !== 'blocked')) return null
  const { rows: empRows } = await client.query<{ name: string }>(
    `SELECT name FROM ai_employees WHERE id = $1`, [child.aiEmployeeId])
  await addLog(client, parent.aiEmployeeId, parent.id, 'report',
    `${empRows[0]?.name ?? 'AI社員'} から「${child.title}」の完了報告を受領`)
  const childTitles = new Set(child.decomposition.map(s => s.title))
  // cancelled の分担は「完了待ち」に数えない（中止された分担が残りの完了・統合報告を
  // 恒久ブロックしないため。親中止の連鎖条件と同じ集合 = レビュー PR #48 R1 指摘）
  const { rows: sib } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_tasks
     WHERE parent_task_id = $1 AND id <> $2 AND status NOT IN ('done', 'cancelled')`, [parent.id, child.id])
  const allChildrenDone = Number(sib[0]?.n ?? '0') === 0
  // 全分担完了なら親ステップも全完了とみなす（分担漏れステップの宙吊り防止）
  const decomposition = parent.decomposition.map(s =>
    allChildrenDone || childTitles.has(s.title) ? { ...s, done: true } : s)
  // 全分担完了時は、分担先の統合報告を集約した親（マネージャー）の統合成果物も作る（バッチ7f = 実遂行）
  let outputs = (parent as unknown as { outputs: AiTaskOutput[] }).outputs
  if (allChildrenDone) {
    const { rows: childDone } = await client.query<{ title: string; outputs: AiTaskOutput[] }>(
      `SELECT title, outputs FROM ai_tasks WHERE parent_task_id = $1 AND status = 'done' ORDER BY id`, [parent.id])
    const body = [
      `# 「${parent.title}」統合完了報告（連携分担）`,
      ...childDone.map((ct) => {
        const fin = ct.outputs.find(o => o.step === -1) ?? ct.outputs[ct.outputs.length - 1]
        return `## ${ct.title}\n${capCp(fin?.body ?? '（成果物なし）', 800)}`
      }),
    ].join('\n\n')
    outputs = [...outputs, { step: -1, title: '統合報告', body, at: nowJstIso() }]
  }
  await client.query(
    `UPDATE ai_tasks SET decomposition = $2, outputs = $3, status = $4, updated_at = now() WHERE id = $1`,
    [parent.id, JSON.stringify(decomposition), JSON.stringify(outputs), allChildrenDone ? 'done' : parent.status])
  if (allChildrenDone) {
    await addLog(client, parent.aiEmployeeId, parent.id, 'report',
      `「${parent.title}」の全分担が完了、成果を統合して報告`)
  }
  await syncEmployeeStatus(client, parent.aiEmployeeId)
  return allChildrenDone
    ? { requesterId: parent.requesterId, title: parent.title, managerId: parent.aiEmployeeId }
    : null
}

export function aiCompanyRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // タスク一覧（全員参照可 = モックのタスクボードと同じ可視性。作成日降順）
  app.get('/tasks', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${TASK_COLS} FROM ai_tasks ORDER BY created_at DESC, id LIMIT 200`)
    return c.json({ data: rows })
  })

  // 活動ログ（新しい順。at は秒精度のため id を第 2 キーに = 同一秒内でも順序を決定化）
  app.get('/logs', async (c) => {
    const { rows } = await pool.query(
      `SELECT ${LOG_COLS} FROM ai_activity_logs ORDER BY at DESC, id LIMIT 200`)
    return c.json({ data: rows })
  })

  // タスク依頼（分解 = LLM → 失敗時ヒューリスティック。proposed で登録・低確信度はエスカレーション）。
  // 添付（画像/ドキュメント = バッチ7f）はテキスト抽出して分解・実行の材料に使い、原本を保全する
  app.post('/tasks', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      aiEmployeeId?: string; title?: string; description?: string
      attachments?: { filename?: string; contentBase64?: string }[]
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
    // 添付は DB 書込前に全件検証・抽出（失敗時に中途半端なタスクを作らない）
    const attachments = await prepareAttachments(body.attachments)
    const attachedTexts = attachments
      .filter(a => a.extractedText)
      .map(a => `添付「${a.filename}」:\n${capCp(a.extractedText!, 3000)}`)
      .join('\n\n')
    const materialForDecompose = attachedTexts ? `${description}\n\n参考資料:\n${attachedTexts}` : description

    const llm = await llmDecompose(env, { name: emp.roleName, mission: emp.mission }, title,
      capCp(materialForDecompose, 12_000))
    const decomposition = llm
      ? llm.steps.map(s => ({ title: s, done: false }))
      : decomposeTask(title, description)
    const confidence = llm ? llm.confidence : judgeTaskConfidence(emp.id, title, description)

    const id = newId('at')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ai_tasks (id, ai_employee_id, requester_id, title, description, decomposition, status, confidence, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8)`,
        [id, emp.id, user.id, title, description, JSON.stringify(decomposition), confidence, nowJstIso()])
      await insertAttachments(client, id, null, user.id, attachments)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await addLog(pool, emp.id, id, 'plan',
      `「${title}」の分解案を作成し承認待ち${attachments.length > 0 ? `（添付 ${attachments.length} 件を受領）` : ''}`)
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

    // 連携計画・ステップ実行（LLM 呼び出しあり = 最長 30 秒）はロック取得前に済ませる。
    // 事前読みの状態が対象外ならスキップ（トランザクション内の状態ガードが正）
    let prepared: Awaited<ReturnType<typeof prepareDelegationPlan>> = null
    let preparedExec: {
      stepIndex: number
      stepTitle: string
      result: Awaited<ReturnType<typeof prepareStepExecution>>
    } | null = null
    if (action === 'approve' || action === 'progress') {
      const { rows: pre } = await pool.query<AiTask & {
        decomposition: { title: string; done: boolean }[]
        outputs: AiTaskOutput[]
        questions: { status: string }[]
      }>(
        `SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1`, [taskId])
      if (action === 'approve' && pre[0]?.status === 'proposed') {
        prepared = await prepareDelegationPlan(pool, env, pre[0])
      }
      if (action === 'progress' && pre[0]?.status === 'in_progress'
        && !pre[0].questions.some(q => q.status === 'open')) {
        const idx = pre[0].decomposition.findIndex(s => !s.done)
        if (idx >= 0) {
          preparedExec = {
            stepIndex: idx,
            stepTitle: pre[0].decomposition[idx]!.title,
            result: await prepareStepExecution(pool, env, pre[0], idx),
          }
        }
      }
    }

    const client = await pool.connect()
    let result: {
      finished?: boolean; requesterId?: string; title?: string; aiEmployeeId?: string
      notifyHuman?: boolean
      questionAsked?: string
      parentFinished?: { requesterId: string; title: string; managerId: string }
      childBlocked?: { requesterId: string; title: string }
    } = {}
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
        // マネージャーロール（delegate 権限）なら、承認と同時に他 AI 社員へ分担を連携
        // （人間の承認は親タスク 1 回のみ = 依頼を一挙に引き受ける。オペレーター指示 2026-07-19 #3）
        if (prepared) await delegateOnApprove(client, task, prepared)
      } else if (action === 'progress') {
        // 依頼者の回答待ち（open な質問）の間は進められない = 回答（/answer）で再開する。
        // 質問によるブロックは status='blocked' のため、状態ガードより先に判定して 014 を返す
        const { rows: openQ } = await client.query(
          `SELECT 1 FROM ai_task_questions WHERE task_id = $1 AND status = 'open' LIMIT 1`, [taskId])
        if (openQ.length > 0) throw err('AKO-AIC-014', '依頼者の回答待ちです（回答すると実行を再開できます）', 409)
        if (task.status !== 'in_progress') throw err('AKO-AIC-005', '実行中のタスクのみ進められます', 409)
        const idx = task.decomposition.findIndex(s => !s.done)
        if (idx < 0) throw err('AKO-AIC-006', '未完了のステップがありません', 409)
        const step = task.decomposition[idx]!
        // 事前実行の対象とロック後の状態が食い違う場合（同時操作の競合 = 通常起きない）は、
        // 質問判定・材料を欠いた劣化出力を作らず、再試行可能エラーで返す（次の操作で正しく事前実行される）
        if (!preparedExec || preparedExec.stepIndex !== idx || preparedExec.stepTitle !== step.title) {
          throw err('AKO-AIC-009', '同時操作が競合しました。もう一度お試しください', 409)
        }
        const exec = preparedExec.result
        if (exec.kind === 'question') {
          // 人間のアクションが必要 = 依頼者へ質問し、回答があるまでブロック（バッチ7f）
          const qid = newId('atq')
          await client.query(
            `INSERT INTO ai_task_questions (id, task_id, step_index, question, status, asked_at)
             VALUES ($1, $2, $3, $4, 'open', now())`, [qid, taskId, idx, exec.question])
          await client.query(`UPDATE ai_tasks SET status = 'blocked', updated_at = now() WHERE id = $1`, [taskId])
          await addLog(client, task.aiEmployeeId, taskId, 'escalate',
            `「${step.title}」の遂行に確認が必要: ${capCp(exec.question, 60)}`)
          result = { requesterId: task.requesterId, title: task.title }
          result.questionAsked = exec.question
        } else {
          // 実遂行: 成果物を生成して保存し、ステップを完了へ（outputs は追記のみ = 記録系）
          const outputs: AiTaskOutput[] = [
            ...(task as unknown as { outputs: AiTaskOutput[] }).outputs,
            { step: idx, title: step.title, body: exec.body, at: nowJstIso() },
          ]
          const decomposition = task.decomposition.map((s, i) => i === idx ? { ...s, done: true } : s)
          const finished = decomposition.every(s => s.done)
          if (finished) {
            outputs.push({ step: -1, title: '統合報告', body: buildFinalReport(task.title, outputs), at: nowJstIso() })
          }
          await client.query(
            `UPDATE ai_tasks SET decomposition = $2, outputs = $3, status = $4, updated_at = now() WHERE id = $1`,
            [taskId, JSON.stringify(decomposition), JSON.stringify(outputs), finished ? 'done' : task.status])
          await addLog(client, task.aiEmployeeId, taskId, 'execute', `「${step.title}」を遂行し成果物を作成`)
          if (finished) {
            await addLog(client, task.aiEmployeeId, taskId, 'report', `「${task.title}」の全ステップが完了、成果を統合して報告`)
          }
          // 子タスク（連携分担）の完了は依頼元マネージャーへ報告・ロールアップ（人間への通知は親の完了時のみ）
          result = { finished, requesterId: task.requesterId, title: task.title, notifyHuman: finished && !task.parentTaskId }
          if (finished && task.parentTaskId) {
            const parentDone = await rollUpToParent(client, task)
            if (parentDone) result.parentFinished = parentDone
          }
        }
      } else if (action === 'block') {
        if (task.status === 'in_progress') {
          await client.query(`UPDATE ai_tasks SET status = 'blocked', updated_at = now() WHERE id = $1`, [taskId])
          await addLog(client, task.aiEmployeeId, taskId, 'escalate', `「${task.title}」がブロックされ対応待ち`)
          // 分担先のブロックは依頼元マネージャーの活動ログへエスカレーション（人間へは補助通知）
          if (task.parentTaskId) {
            const { rows: p } = await client.query<{ aiEmployeeId: string; requesterId: string }>(
              `SELECT ai_employee_id AS "aiEmployeeId", requester_id AS "requesterId"
               FROM ai_tasks WHERE id = $1`, [task.parentTaskId])
            if (p[0]) {
              await addLog(client, p[0].aiEmployeeId, task.parentTaskId, 'escalate',
                `分担先で「${task.title}」がブロック、対応を検討`)
              result.childBlocked = { requesterId: p[0].requesterId, title: task.title }
            }
          }
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
        // open な質問は中止で打ち切り（宙吊りの回答待ちを残さない。打ち切りの経緯は answer 欄に記録）。
        // 連鎖中止される分担子タスクの質問も同時に打ち切る（再連携なし = 孫は存在しない）
        await client.query(
          `UPDATE ai_task_questions SET status = 'answered', answer = '（タスク中止により打ち切り）',
             answered_by = $2, answered_at = now()
           WHERE status = 'open'
             AND task_id IN (SELECT id FROM ai_tasks WHERE id = $1 OR parent_task_id = $1)`, [taskId, user.id])
        // 親の中止は未完了の分担子タスクへ連鎖（分担だけが走り続ける宙吊りを作らない）
        const { rows: kids } = await client.query<{ id: string; aiEmployeeId: string; title: string }>(
          `SELECT id, ai_employee_id AS "aiEmployeeId", title FROM ai_tasks
           WHERE parent_task_id = $1 AND status NOT IN ('done', 'cancelled') ORDER BY id FOR UPDATE`, [taskId])
        for (const k of kids) {
          await client.query(`UPDATE ai_tasks SET status = 'cancelled', updated_at = now() WHERE id = $1`, [k.id])
          await addLog(client, k.aiEmployeeId, k.id, 'chat', `連携元タスクの中止に伴い「${k.title}」を中止`)
          await syncEmployeeStatus(client, k.aiEmployeeId)
        }
      }
      await syncEmployeeStatus(client, task.aiEmployeeId)
      result.aiEmployeeId = task.aiEmployeeId
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      // 連携の親子ロックは操作により順序が異なる（progress = 子→親 / cancel = 親→子）ため、
      // 稀にデッドロック検出（40P01）で片方が中断される。再試行可能エラーへ変換する
      if ((e as { code?: string }).code === '40P01') {
        throw err('AKO-AIC-009', '同時操作が競合しました。もう一度お試しください', 409)
      }
      throw e
    } finally {
      client.release()
    }
    // 補助処理: 完了・確認依頼・連携通知（トランザクション確定後・失敗しても遷移は成立 = 原則4）
    if (result.questionAsked && result.requesterId) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ai_employees WHERE id = $1`, [result.aiEmployeeId])
      await notify(pool, result.requesterId, 'ai_report', `AI 確認依頼: ${result.title}`,
        `${rows[0]?.name ?? 'AI社員'} から確認: ${capCp(result.questionAsked, 80)}（/ai-company で回答してください）`,
        '/ai-company')
    }
    if (result.notifyHuman && result.requesterId) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ai_employees WHERE id = $1`, [result.aiEmployeeId])
      await notify(pool, result.requesterId, 'ai_report', `AI 完了報告: ${result.title}`,
        `${rows[0]?.name ?? 'AI社員'} がタスクを完了しました`, '/ai-company')
    }
    if (result.parentFinished) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ai_employees WHERE id = $1`, [result.parentFinished.managerId])
      await notify(pool, result.parentFinished.requesterId, 'ai_report',
        `AI 連携完了報告: ${result.parentFinished.title}`,
        `${rows[0]?.name ?? 'マネージャー'} が分担タスクの成果を統合して完了しました`, '/ai-company')
    }
    if (result.childBlocked) {
      await notify(pool, result.childBlocked.requesterId, 'ai_report',
        `AI 連携ブロック: ${result.childBlocked.title}`,
        '分担先のタスクがブロックされました。/ai-company で状況を確認してください', '/ai-company')
    }
    const { rows: after } = await pool.query(`SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1`, [taskId])
    return c.json({ data: after[0] })
  })

  // 依頼者の回答（人間のアクションが必要な箇所への応答。バッチ7f）。
  // 最も古い open な質問へ回答し、ブロック中なら実行を再開する。添付（画像/ドキュメント）も受け付ける
  app.post('/tasks/:id/answer', async (c) => {
    const user = c.get('user')
    const taskId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as {
      answer?: string; attachments?: { filename?: string; contentBase64?: string }[]
    }
    const answer = capCp(String(body.answer ?? '').trim(), 4000)
    if (!answer) throw err('AKO-GEN-001', '回答を入力してください', 400)
    const attachments = await prepareAttachments(body.attachments)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<AiTask>(
        `SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1 FOR UPDATE`, [taskId])
      const task = rows[0]
      if (!task) throw err('AKO-AIC-003', 'タスクが見つかりません', 404)
      if (task.requesterId !== user.id && user.role !== 'admin') {
        throw err('AKO-AIC-013', '依頼者本人（または管理者）のみ回答できます', 403)
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        throw err('AKO-AIC-012', '完了・中止済みのタスクには回答できません', 409)
      }
      const { rows: qs } = await client.query<{ id: string; question: string }>(
        `SELECT id, question FROM ai_task_questions WHERE task_id = $1 AND status = 'open'
         ORDER BY asked_at, id LIMIT 1 FOR UPDATE`, [taskId])
      const q = qs[0]
      if (!q) throw err('AKO-AIC-012', '回答待ちの質問がありません', 409)
      await client.query(
        `UPDATE ai_task_questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = now()
         WHERE id = $1`, [q.id, answer, user.id])
      await insertAttachments(client, taskId, q.id, user.id, attachments)
      // 回答でブロックを解除し実行を再開できる状態へ（cancelled/done は状態を変えない）
      if (task.status === 'blocked') {
        await client.query(`UPDATE ai_tasks SET status = 'in_progress', updated_at = now() WHERE id = $1`, [taskId])
      }
      await addLog(client, task.aiEmployeeId, taskId, 'chat',
        `依頼者から回答を受領: ${capCp(answer, 60)}${attachments.length > 0 ? `（添付 ${attachments.length} 件）` : ''}`)
      await syncEmployeeStatus(client, task.aiEmployeeId)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    // 回答者本人の操作のため人間への追加通知は不要（AI は次の「進める」で回答を材料に遂行する）
    const { rows: after } = await pool.query(`SELECT ${TASK_COLS} FROM ai_tasks WHERE id = $1`, [taskId])
    return c.json({ data: after[0] })
  })

  // 添付原本のダウンロード（依頼者本人または管理者のみ = 依頼インプットの既定可視性）
  app.get('/files/:id', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{
      filename: string; mime: string; bytes: Buffer; requesterId: string
    }>(
      `SELECT f.filename, f.mime, f.bytes, t.requester_id AS "requesterId"
       FROM ai_task_files f JOIN ai_tasks t ON t.id = f.task_id WHERE f.id = $1`, [c.req.param('id')])
    const f = rows[0]
    if (!f) throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    if (f.requesterId !== user.id && user.role !== 'admin') {
      throw err('AKO-PRM-001', '依頼者本人（または管理者）のみ参照できます', 403)
    }
    return c.json({ data: { filename: f.filename, mime: f.mime, contentBase64: f.bytes.toString('base64') } })
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
       FROM ai_activity_logs WHERE at LIKE $1 || '%' ORDER BY at, id`, [date])
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
