/**
 * AIネイティブカンパニー（F-08）
 * タスク依頼 → 分解 → 承認 → 実行 → 完了報告 → 日次報告生成。
 *
 * デュアルモード（バッチ6a）:
 * - モックモード: 従来どおり useMockDb + 決定的分解（SoT は shared/domain/ai-tasks = API フォールバックと同一）
 * - API モード: SoT は /v1/ai-company（タスク・活動ログ）+ /v1/masters/ai-roles・ai-employees（マスタ）。
 *   分解はサーバー（Vertex AI → 失敗時同一ヒューリスティック）。操作は API → キャッシュ取り直し（原則6）。
 *   AI 日次報告は daily_reports（author_kind='ai'）が SoT = useReports の全員の日報キャッシュから射影
 * - 活動ログ・日次報告は追記のみ（記録系保護）。日次報告は既存分をスキップする UPSERT（冪等）
 * - エスカレーション・通知は主フロー成立後に非ブロッキングで呼ぶ（API モードはサーバーが担う）
 */
import type { Ref } from 'vue'
import {
  buildFinalReport, decomposeTask, DELEGATE_PERMISSION, heuristicNeedsInput, heuristicStepOutput,
  judgeTaskConfidence, mockActivityCost, planDelegation,
} from '../../../shared/domain/ai-tasks'
import type {
  AiActivityKind, AiActivityLog, AiEmployee, AiModelTier, AiRole, AiTask, AiTaskFileMeta,
  DailyReport, ReportEntry, Result,
} from '~/types/domain'
import type { Tone } from '~/types/ui'
import { fmtInt } from '~/utils/format'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiTasks = ref<AiTask[]>([])
const apiLogs = ref<AiActivityLog[]>([])

function loadAiTasks(force = false): Promise<void> {
  return apiLoadOnce('aic:tasks', async () => {
    apiTasks.value = await apiFetch<AiTask[]>('/v1/ai-company/tasks')
  }, force)
}

function loadAiLogs(force = false): Promise<void> {
  return apiLoadOnce('aic:logs', async () => {
    apiLogs.value = await apiFetch<AiActivityLog[]>('/v1/ai-company/logs')
  }, force)
}

onApiReset(() => {
  apiTasks.value = []
  apiLogs.value = []
})

// ---------- 画面固有ラベル（labels.ts にない区分は担当ファイルで定義） ----------

export const AI_ACTIVITY_KIND_LABELS: Record<AiActivityKind, string> = {
  plan: '計画',
  execute: '実行',
  report: '報告',
  escalate: 'エスカレーション',
  chat: '対話',
}

export const AI_ACTIVITY_KIND_ICONS: Record<AiActivityKind, string> = {
  plan: 'ClipboardList',
  execute: 'Play',
  report: 'FileText',
  escalate: 'TriangleAlert',
  chat: 'MessageCircle',
}

export const AI_MODEL_TIER_LABELS: Record<AiModelTier, string> = {
  lite: 'ライト',
  standard: 'スタンダード',
  pro: 'プロ',
}

/** ロールに付与できる権限の固定候補（7 種） */
export const AI_PERMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: 'knowledge:read', label: 'ナレッジ参照' },
  { value: 'knowledge:write', label: 'ナレッジ更新' },
  { value: 'documents:write', label: 'ドキュメント作成' },
  { value: 'mart:read', label: '分析データ参照' },
  { value: 'masters:read', label: 'マスタ参照' },
  { value: 'web:search', label: 'Web 検索' },
  // マネージャーロールの要件（オペレーター指示 2026-07-19 #3）: 依頼の承認時に他 AI 社員へ分担を連携する
  { value: DELEGATE_PERMISSION, label: '他のAI社員への依頼・連携（マネージャー）' },
]

export const AI_CONFIDENCE_META: Record<AiTask['confidence'], { label: string; tone: Tone }> = {
  high: { label: '確信度高', tone: 'ok' },
  mid: { label: '確信度中', tone: 'info' },
  low: { label: '確信度低', tone: 'warn' },
}

export const AI_EMPLOYEE_STATUS_TONES: Record<AiEmployee['status'], Tone> = {
  working: 'ok',
  waiting_approval: 'warn',
  idle: 'neutral',
}

export const AI_TASK_STATUS_TONES: Record<AiTask['status'], Tone> = {
  proposed: 'info',
  approved: 'brand',
  in_progress: 'ok',
  blocked: 'warn',
  done: 'neutral',
  cancelled: 'neutral',
}

export type RequestTaskResult =
  | { ok: true; id: string; confidence: AiTask['confidence'] }
  | { ok: false; error: { code: string; message: string } }

export function useAiCompany() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify } = useNotifications()
  const { raise } = useEscalations()
  const isApi = useApiMode()

  // ai-roles / ai-employees は移行済みマスタ（API モードは tbl() が API キャッシュを返す）
  const aiEmployees = tbl('aiEmployees')
  const aiRoles = tbl('aiRoles')
  // タスク・活動ログは API モードでは /v1/ai-company のキャッシュをバッキングにする
  const aiTasks = isApi ? (apiTasks as Ref<AiTask[]>) : tbl('aiTasks')
  const aiActivityLogs = isApi ? (apiLogs as Ref<AiActivityLog[]>) : tbl('aiActivityLogs')
  const dailyReports = tbl('dailyReports')
  const escalationRules = tbl('escalationRules')
  // AI 日次報告（API モード）は全員の日報キャッシュ（scope=all）から射影する
  const reportsApi = isApi ? useReports() : null
  if (isApi) {
    void loadAiTasks()
    void loadAiLogs()
  }

  /** 操作後の取り直し（タスク・ログ・AI 社員の派生 status。原則6: SoT 書込 → キャッシュ反映） */
  async function reloadAi(): Promise<void> {
    await Promise.all([loadAiTasks(true), loadAiLogs(true), loadApiCollection('aiEmployees', true)])
  }

  // ---------- 参照系 ----------

  const employees = computed<AiEmployee[]>(() => aiEmployees.value.filter(e => e.active))
  /** 無効化済みも含む全 AI 社員（タスクボード等の名前解決用 = 過去タスクの担当名を生 id にしない） */
  const employeesAll = computed<AiEmployee[]>(() => aiEmployees.value)
  const roles = computed<AiRole[]>(() => aiRoles.value)

  function roleOf(emp: AiEmployee | undefined): AiRole | undefined {
    return emp ? aiRoles.value.find(r => r.id === emp.roleId) : undefined
  }

  function employeeById(id: string): AiEmployee | undefined {
    return aiEmployees.value.find(e => e.id === id)
  }

  const tasks = computed<AiTask[]>(() =>
    [...aiTasks.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

  /** AI 社員の未完了タスク（ドロワー表示用） */
  function tasksOf(aiEmployeeId: string): AiTask[] {
    return tasks.value.filter(t => t.aiEmployeeId === aiEmployeeId)
  }

  const logs = computed<AiActivityLog[]>(() =>
    [...aiActivityLogs.value].sort((a, b) => b.at.localeCompare(a.at)))

  /** その日の AI 日次報告（プレビュー用。API モードは全員の日報キャッシュ = daily_reports が SoT） */
  function aiReportsOn(date: string): DailyReport[] {
    if (reportsApi) {
      return reportsApi.allSubmitted(date.slice(0, 7)).filter(r => r.authorKind === 'ai' && r.date === date)
    }
    return dailyReports.value.filter(r => r.authorKind === 'ai' && r.date === date)
  }

  // ---------- 内部ヘルパー ----------

  /** タスク状況から AI 社員の状態を導出して同期する（SoT: aiTasks → 派生: aiEmployees.status） */
  function syncEmployeeStatus(aiEmployeeId: string): void {
    const mine = aiTasks.value.filter(t => t.aiEmployeeId === aiEmployeeId)
    const next: AiEmployee['status']
      = mine.some(t => t.status === 'in_progress' || t.status === 'approved') ? 'working'
        : mine.some(t => t.status === 'proposed') ? 'waiting_approval'
          : 'idle'
    aiEmployees.value = aiEmployees.value.map(e => e.id === aiEmployeeId ? { ...e, status: next } : e)
  }

  /** 活動ログを追記する（モックモードのみ。tokens/costUsd は shared の決定的モック値） */
  function addLog(aiEmployeeId: string, taskId: string | null, kind: AiActivityKind, summary: string): void {
    const emp = employeeById(aiEmployeeId)
    const tier: AiModelTier = roleOf(emp)?.modelTier ?? 'standard'
    // seq は当該社員のログ件数（API 版 ai-company.ts と同一 = モック/API のモック値パリティ）
    const seq = aiActivityLogs.value.filter(l => l.aiEmployeeId === aiEmployeeId).length
    const { tokens, costUsd } = mockActivityCost(aiEmployeeId, kind, seq, tier)
    aiActivityLogs.value = [...aiActivityLogs.value, {
      id: nextId('aiActivityLogs', 'aal'),
      aiEmployeeId, taskId, kind, summary, tokens, costUsd,
      at: nowJstIso(),
    }]
  }

  // ---------- AI 社員間の連携（モック。API 版 ai-company.ts と同一の決定的ロジック） ----------

  /**
   * 承認時の連携（delegate 権限を持つロールの AI 社員 = マネージャーのみ。
   * 子タスクからの再連携はしない = 連鎖の暴走防止。分担は planDelegation で決定的に割当）
   */
  function delegateOnApproveMock(task: AiTask): void {
    if (task.parentTaskId) return
    const mgr = employeeById(task.aiEmployeeId)
    if (!roleOf(mgr)?.permissions.includes(DELEGATE_PERMISSION)) return
    const candidates = aiEmployees.value
      .filter(e => e.active && e.id !== task.aiEmployeeId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(e => ({ id: e.id, name: e.name, roleName: roleOf(e)?.name ?? '', mission: roleOf(e)?.mission ?? '' }))
    if (candidates.length === 0 || task.decomposition.length === 0) return
    const plan = planDelegation(task.decomposition, candidates)
    const byEmp = new Map<string, string[]>()
    for (const p of plan) byEmp.set(p.aiEmployeeId, [...(byEmp.get(p.aiEmployeeId) ?? []), p.title])
    for (const [empId, stepTitles] of byEmp) {
      const cand = candidates.find(x => x.id === empId)
      if (!cand) continue
      const childId = nextId('aiTasks', 'at')
      const childTitle = [...`${task.title}（分担: ${cand.roleName}）`].slice(0, 100).join('')
      const description = `マネージャー ${mgr?.name ?? ''} からの連携依頼（元タスク: ${task.title}）`
      aiTasks.value = [...aiTasks.value, {
        id: childId,
        aiEmployeeId: empId,
        requesterId: task.requesterId,
        title: childTitle,
        description,
        decomposition: stepTitles.map(t => ({ title: t, done: false })),
        status: 'in_progress',
        dueDate: null,
        confidence: judgeTaskConfidence(empId, childTitle, description),
        createdAt: nowJstIso(),
        requesterAiEmployeeId: task.aiEmployeeId,
        parentTaskId: task.id,
      }]
      addLog(task.aiEmployeeId, task.id, 'chat', `${cand.name} へ「${task.title}」の分担を依頼（${stepTitles.length} ステップ）`)
      addLog(empId, childId, 'plan', `${mgr?.name ?? 'マネージャー'} から「${task.title}」の分担を受領し実行を開始`)
      syncEmployeeStatus(empId)
    }
  }

  /** 分担子タスク完了時の親（マネージャー）へのロールアップ（全子完了で親も done + 統合報告 + 通知） */
  function rollUpToParentMock(child: AiTask): void {
    const parent = aiTasks.value.find(t => t.id === child.parentTaskId)
    if (!parent || (parent.status !== 'in_progress' && parent.status !== 'blocked')) return
    addLog(parent.aiEmployeeId, parent.id, 'report',
      `${employeeById(child.aiEmployeeId)?.name ?? 'AI社員'} から「${child.title}」の完了報告を受領`)
    const childTitles = new Set(child.decomposition.map(s => s.title))
    // cancelled の分担は「完了待ち」に数えない（API 版と同一 = レビュー PR #48 R1 指摘）
    const allChildrenDone = !aiTasks.value.some(t =>
      t.parentTaskId === parent.id && t.id !== child.id && t.status !== 'done' && t.status !== 'cancelled')
    const decomposition = parent.decomposition.map(s =>
      allChildrenDone || childTitles.has(s.title) ? { ...s, done: true } : s)
    // 全分担完了時は分担先の統合報告を集約した親の統合成果物も作る（API 版と同一 = バッチ7f）
    let parentOutputs = parent.outputs ?? []
    if (allChildrenDone) {
      const childDone = aiTasks.value.filter(t => t.parentTaskId === parent.id && (t.id === child.id || t.status === 'done'))
      const body = [
        `# 「${parent.title}」統合完了報告（連携分担）`,
        ...childDone.map((ct) => {
          const src = ct.id === child.id ? child : ct
          const fin = (src.outputs ?? []).find(o => o.step === -1) ?? (src.outputs ?? [])[(src.outputs ?? []).length - 1]
          return `## ${ct.title}\n${[...(fin?.body ?? '（成果物なし）')].slice(0, 800).join('')}`
        }),
      ].join('\n\n')
      parentOutputs = [...parentOutputs, { step: -1, title: '統合報告', body, at: nowJstIso() }]
    }
    aiTasks.value = aiTasks.value.map(t => t.id === parent.id
      ? { ...t, decomposition, outputs: parentOutputs, status: allChildrenDone ? 'done' as const : t.status }
      : t)
    if (allChildrenDone) {
      addLog(parent.aiEmployeeId, parent.id, 'report', `「${parent.title}」の全分担が完了、成果を統合して報告`)
      notify(parent.requesterId, 'ai_report', `AI 連携完了報告: ${parent.title}`,
        `${employeeById(parent.aiEmployeeId)?.name ?? 'マネージャー'} が分担タスクの成果を統合して完了しました`, '/ai-company')
    }
    syncEmployeeStatus(parent.aiEmployeeId)
  }

  // ---------- 操作系 ----------

  /** File → base64（依頼・回答の添付。useNotes.importFile と同じ変換パターン） */
  async function toAttachment(file: File): Promise<{ filename: string; contentBase64: string }> {
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { filename: file.name, contentBase64: btoa(bin) }
  }

  /** モックモードの添付メタ（原本は保存しない = メタのみの設計判断。API モードはサーバーが原本保全） */
  function mockFileMetas(taskId: string, questionId: string | null, files: File[]): AiTaskFileMeta[] {
    return files.map((f, i) => ({
      id: `${taskId}-f${questionId ?? 'req'}-${i}`,
      filename: f.name,
      mime: f.type || 'application/octet-stream',
      sizeBytes: f.size,
      questionId,
    }))
  }

  /**
   * タスクを依頼する。AI が決定的にタスク分解を生成し status='proposed' で登録する。
   * confidence が low の場合はエスカレーション起票（非ブロッキング）し、フラグを返す。
   * 添付（画像/ドキュメント = バッチ7f）は API モードでサーバーが抽出・原本保全して材料に使う
   */
  async function requestTask(
    aiEmployeeId: string,
    title: string,
    description: string,
    files: File[] = [],
  ): Promise<RequestTaskResult> {
    if (isApi) {
      // 分解はサーバー（Vertex AI → 失敗時 shared ヒューリスティック）。エスカレーションもサーバーが担う
      try {
        const attachments = await Promise.all(files.map(toAttachment))
        const data = await apiFetch<{ id: string; confidence: AiTask['confidence'] }>('/v1/ai-company/tasks', {
          method: 'POST', body: { aiEmployeeId, title: title.trim(), description: description.trim(), attachments },
        })
        await reloadAi()
        return { ok: true, id: data.id, confidence: data.confidence }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const emp = employeeById(aiEmployeeId)
    if (!emp) return { ok: false, error: { code: 'AKO-AIC-001', message: 'AI 社員が見つかりません' } }
    // title は先に正規化（trim）してから分解・確信度判定へ渡す（API 版と同一 = 生成結果のパリティ）
    const t = title.trim()
    const d = description.trim()
    if (!t) return { ok: false, error: { code: 'AKO-AIC-002', message: '件名を入力してください' } }

    const confidence = judgeTaskConfidence(aiEmployeeId, t, d)
    const id = nextId('aiTasks', 'at')
    aiTasks.value = [...aiTasks.value, {
      id,
      aiEmployeeId,
      requesterId: currentUser.value.id,
      title: t,
      description: d,
      decomposition: decomposeTask(t, d),
      status: 'proposed',
      dueDate: null,
      confidence,
      createdAt: nowJstIso(),
      outputs: [],
      questions: [],
      files: mockFileMetas(id, null, files),
    }]
    addLog(aiEmployeeId, id, 'plan', `「${t}」の分解案を作成し承認待ち`)
    syncEmployeeStatus(aiEmployeeId)
    commit()

    // 補助処理: 低確信度エスカレーション（失敗しても主フローは成立）。
    // dedupe は先頭 2 セグメントで判定されるため日付は付けない（API 版と同一）
    if (confidence === 'low') {
      raise({
        reason: 'low_confidence',
        targetAiEmployeeId: aiEmployeeId,
        context: `AI社員への依頼「${t}」の確信度が低いため確認が必要`,
        dedupeKey: `lowconf:${aiEmployeeId}`,
      })
    }
    return { ok: true, id, confidence }
  }

  /** タスクの状態遷移（API モード共通。サーバーが状態機械・ログ・通知・status 同期を担う） */
  async function transitionApi(taskId: string, action: 'approve' | 'progress' | 'block' | 'cancel'): Promise<Result> {
    const res = await apiResult(() => apiFetch(`/v1/ai-company/tasks/${taskId}/${action}`, { method: 'POST' }))
    if (res.ok) await reloadAi()
    return res
  }

  /**
   * 全自動実行（バッチ7i・オペレーター指示 2026-07-19 #11 = モック版）。
   * 承認・回答・ブロック解除後、「進める」の連打なしで 完了 / 依頼者への質問 / 中止 まで走り切る。
   * 分担があれば子タスク群を対象にする（API の autoRunAfterApprove と同型）。
   * モックは決定的ヒューリスティックのため即座に収束する（Web 調査は API モードのみの機能）
   */
  const AUTO_RUN_MAX_STEPS = 12
  async function autoRunMock(taskId: string): Promise<void> {
    const kids = aiTasks.value.filter(t => t.parentTaskId === taskId && t.status === 'in_progress')
    const targets = kids.length > 0 ? kids.map(k => k.id) : [taskId]
    for (const id of targets) {
      for (let i = 0; i < AUTO_RUN_MAX_STEPS; i++) {
        const t = aiTasks.value.find(x => x.id === id)
        if (!t || t.status !== 'in_progress') break
        if ((t.questions ?? []).some(q => q.status === 'open')) break
        if (!t.decomposition.some(s => !s.done)) break
        const res = await progressTask(id)
        if (!res.ok) break
      }
    }
  }

  /** 分解案を承認して実行開始（proposed → 即 in_progress → 全自動実行 = バッチ7i） */
  async function approveTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'approve')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.status !== 'proposed') {
      return { ok: false, error: { code: 'AKO-AIC-004', message: '提案中のタスクのみ承認できます' } }
    }
    aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'in_progress' as const } : t)
    addLog(task.aiEmployeeId, taskId, 'plan', `「${task.title}」の分解が承認され実行を開始`)
    // マネージャーロール（delegate 権限）なら承認と同時に他 AI 社員へ分担を連携（API 版と同一）
    delegateOnApproveMock(task)
    syncEmployeeStatus(task.aiEmployeeId)
    commit()
    // 承認 = ユーザーの意思表示。以降は「進める」なしで走り切る（バッチ7i）
    await autoRunMock(taskId)
    return { ok: true, id: taskId }
  }

  /**
   * 実行を 1 ステップ進める（実遂行 = バッチ7f）。ステップの成果物を生成して保存し、
   * 人間の判断が必要な依頼（決定的判定 = API のヒューリスティックフォールバックと同一）は
   * 依頼者へ質問してブロックする。全ステップ完了で done + 統合報告 + 依頼者へ通知
   */
  async function progressTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'progress')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    // 質問によるブロックは status='blocked' のため、状態ガードより先に判定して 014 を返す（API 版と同一）
    if ((task.questions ?? []).some(q => q.status === 'open')) {
      return { ok: false, error: { code: 'AKO-AIC-014', message: '依頼者の回答待ちです（回答すると実行を再開できます）' } }
    }
    if (task.status !== 'in_progress') {
      return { ok: false, error: { code: 'AKO-AIC-005', message: '実行中のタスクのみ進められます' } }
    }
    const idx = task.decomposition.findIndex(s => !s.done)
    if (idx < 0) return { ok: false, error: { code: 'AKO-AIC-006', message: '未完了のステップがありません' } }

    const step = task.decomposition[idx]!
    const answered = (task.questions ?? []).filter(q => q.status === 'answered')
    // 人間のアクションが必要か（API のフォールバックと同一の決定的判定）
    const question = heuristicNeedsInput(task.description, answered.length)
    if (question) {
      const q = {
        id: `${taskId}-q${(task.questions ?? []).length + 1}`,
        stepIndex: idx,
        question,
        status: 'open' as const,
        answer: null,
        answeredBy: null,
        askedAt: nowJstIso(),
        answeredAt: null,
      }
      aiTasks.value = aiTasks.value.map(t => t.id === taskId
        ? { ...t, status: 'blocked' as const, questions: [...(t.questions ?? []), q] }
        : t)
      addLog(task.aiEmployeeId, taskId, 'escalate', `「${step.title}」の遂行に確認が必要: ${question.slice(0, 60)}`)
      syncEmployeeStatus(task.aiEmployeeId)
      commit()
      const emp = employeeById(task.aiEmployeeId)
      notify(task.requesterId, 'ai_report', `AI 確認依頼: ${task.title}`,
        `${emp?.name ?? 'AI社員'} から確認: ${question}（/ai-company で回答してください）`, '/ai-company')
      return { ok: true, id: taskId }
    }
    // 実遂行: 材料（依頼文 + 回答済み Q&A）から成果物を生成（API フォールバックと同一関数）
    const materials = [
      `依頼内容: ${task.description || '（記載なし）'}`,
      ...answered.map(q => `確認済み Q&A:\nQ: ${q.question}\nA: ${q.answer ?? ''}`),
    ].join('\n\n')
    const outputs = [
      ...(task.outputs ?? []),
      { step: idx, title: step.title, body: heuristicStepOutput(task.title, step.title, materials), at: nowJstIso() },
    ]
    const decomposition = task.decomposition.map((s, i) => i === idx ? { ...s, done: true } : s)
    const finished = decomposition.every(s => s.done)
    if (finished) {
      outputs.push({ step: -1, title: '統合報告', body: buildFinalReport(task.title, outputs), at: nowJstIso() })
    }
    aiTasks.value = aiTasks.value.map(t => t.id === taskId
      ? { ...t, decomposition, outputs, status: finished ? 'done' as const : t.status }
      : t)
    addLog(task.aiEmployeeId, taskId, 'execute', `「${step.title}」を遂行し成果物を作成`)
    if (finished) {
      addLog(task.aiEmployeeId, taskId, 'report', `「${task.title}」の全ステップが完了、成果を統合して報告`)
    }
    // 分担子タスクの完了は依頼元マネージャーへ報告・ロールアップ（API 版と同一）
    if (finished && task.parentTaskId) {
      // outputs も渡す（親の統合報告が今回ステップの成果物・子の統合報告を参照できるように = R1 指摘）
      rollUpToParentMock({ ...task, decomposition, outputs, status: 'done' })
    }
    syncEmployeeStatus(task.aiEmployeeId)
    commit()

    // 補助処理: 完了通知（失敗しても主フローは成立。子タスクは親の統合報告時のみ = 通知の重複防止）
    if (finished && !task.parentTaskId) {
      const emp = employeeById(task.aiEmployeeId)
      notify(task.requesterId, 'ai_report', `AI 完了報告: ${task.title}`,
        `${emp?.name ?? 'AI社員'} がタスクを完了しました`, '/ai-company')
    }
    return { ok: true, id: taskId }
  }

  /**
   * 依頼者の回答（人間のアクションが必要な箇所への応答 = バッチ7f）。
   * 最も古い open な質問へ回答し、ブロック中なら実行を再開できる状態へ戻す
   */
  async function answerTask(taskId: string, answer: string, files: File[] = []): Promise<Result> {
    const text = answer.trim()
    if (!text) return { ok: false, error: { code: 'AKO-GEN-001', message: '回答を入力してください' } }
    if (isApi) {
      const attachments = await Promise.all(files.map(toAttachment))
      const res = await apiResult(() => apiFetch(`/v1/ai-company/tasks/${taskId}/answer`, {
        method: 'POST', body: { answer: text, attachments },
      }))
      if (res.ok) await reloadAi()
      return res
    }
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.requesterId !== currentUser.value.id && currentUser.value.role !== 'admin') {
      return { ok: false, error: { code: 'AKO-AIC-013', message: '依頼者本人（または管理者）のみ回答できます' } }
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      return { ok: false, error: { code: 'AKO-AIC-012', message: '完了・中止済みのタスクには回答できません' } }
    }
    const open = (task.questions ?? []).find(q => q.status === 'open')
    if (!open) return { ok: false, error: { code: 'AKO-AIC-012', message: '回答待ちの質問がありません' } }
    const questions = (task.questions ?? []).map(q => q.id === open.id
      ? { ...q, status: 'answered' as const, answer: text, answeredBy: currentUser.value.id, answeredAt: nowJstIso() }
      : q)
    aiTasks.value = aiTasks.value.map(t => t.id === taskId
      ? {
          ...t,
          questions,
          files: [...(t.files ?? []), ...mockFileMetas(taskId, open.id, files)],
          status: t.status === 'blocked' ? 'in_progress' as const : t.status,
        }
      : t)
    addLog(task.aiEmployeeId, taskId, 'chat',
      `依頼者から回答を受領: ${[...text].slice(0, 60).join('')}${files.length > 0 ? `（添付 ${files.length} 件）` : ''}`)
    syncEmployeeStatus(task.aiEmployeeId)
    commit()
    // 回答で実行を自動再開する（バッチ7i = 「進める」の連打不要）
    await autoRunMock(taskId)
    return { ok: true, id: taskId }
  }

  /** ブロック ↔ 実行中 のトグル */
  async function blockTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'block')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.status === 'in_progress') {
      aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'blocked' as const } : t)
      addLog(task.aiEmployeeId, taskId, 'escalate', `「${task.title}」がブロックされ対応待ち`)
      // 分担先のブロックは依頼元マネージャーの活動ログへエスカレーション + 依頼者へ補助通知（API 版と同一）
      if (task.parentTaskId) {
        const parent = aiTasks.value.find(t => t.id === task.parentTaskId)
        if (parent) {
          addLog(parent.aiEmployeeId, parent.id, 'escalate', `分担先で「${task.title}」がブロック、対応を検討`)
          notify(parent.requesterId, 'ai_report', `AI 連携ブロック: ${task.title}`,
            '分担先のタスクがブロックされました。/ai-company で状況を確認してください', '/ai-company')
        }
      }
    } else if (task.status === 'blocked') {
      aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'in_progress' as const } : t)
      addLog(task.aiEmployeeId, taskId, 'plan', `「${task.title}」のブロックが解除され実行を再開`)
      syncEmployeeStatus(task.aiEmployeeId)
      commit()
      // 解除後は自動で走り切る（バッチ7i。open な質問があれば autoRunMock 側で停止）
      await autoRunMock(taskId)
      return { ok: true, id: taskId }
    } else {
      return { ok: false, error: { code: 'AKO-AIC-007', message: '実行中またはブロック中のタスクのみ切替できます' } }
    }
    syncEmployeeStatus(task.aiEmployeeId)
    commit()
    return { ok: true, id: taskId }
  }

  /** タスクを中止する（done/cancelled 以外から遷移可） */
  async function cancelTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'cancel')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.status === 'done' || task.status === 'cancelled') {
      return { ok: false, error: { code: 'AKO-AIC-008', message: '完了・中止済みのタスクは中止できません' } }
    }
    // 親の中止は未完了の分担子タスクへ連鎖（API 版と同一 = 分担だけが走り続ける宙吊りを作らない）。
    // open な質問は中止で打ち切り（宙吊りの回答待ちを残さない = API 版と同一）
    const kids = aiTasks.value.filter(t =>
      t.parentTaskId === taskId && t.status !== 'done' && t.status !== 'cancelled')
    aiTasks.value = aiTasks.value.map(t =>
      (t.id === taskId || kids.some(k => k.id === t.id))
        ? {
            ...t,
            status: 'cancelled' as const,
            questions: (t.questions ?? []).map(q => q.status === 'open'
              ? { ...q, status: 'answered' as const, answer: '（タスク中止により打ち切り）', answeredBy: currentUser.value.id, answeredAt: nowJstIso() }
              : q),
          }
        : t)
    for (const k of kids) {
      addLog(k.aiEmployeeId, k.id, 'chat', `連携元タスクの中止に伴い「${k.title}」を中止`)
      syncEmployeeStatus(k.aiEmployeeId)
    }
    syncEmployeeStatus(task.aiEmployeeId)
    commit()
    return { ok: true, id: taskId }
  }

  /**
   * 指定日の活動ログを AI 社員ごとに集約し、日次報告を UPSERT する。
   * 既存（同一 AI × 同一日）はスキップ = 冪等（再実行で既存報告を巻き戻さない）。
   */
  async function generateDailyReports(date: string): Promise<{ created: number; skipped: number }> {
    if (isApi) {
      try {
        const data = await apiFetch<{ created: number; skipped: number }>('/v1/ai-company/daily-reports', {
          method: 'POST', body: { date },
        })
        // 生成された AI 日報を全員の日報キャッシュへ反映（SoT → キャッシュ。原則6）
        if (data.created > 0) await reloadAllMonth(date.slice(0, 7))
        return data
      } catch {
        return { created: 0, skipped: 0 } // 画面は「生成対象なし」を表示（原則4）
      }
    }
    const dayLogs = aiActivityLogs.value.filter(l => l.at.slice(0, 10) === date)
    const byEmp = new Map<string, AiActivityLog[]>()
    for (const l of dayLogs) {
      byEmp.set(l.aiEmployeeId, [...(byEmp.get(l.aiEmployeeId) ?? []), l])
    }

    let created = 0
    let skipped = 0
    for (const [empId, empLogs] of byEmp) {
      const exists = dailyReports.value.some(r => r.authorKind === 'ai' && r.aiEmployeeId === empId && r.date === date)
      if (exists) { skipped++; continue }

      // タスク別エントリ（業務テーマ = 「AI カンパニー」。API 版 ai-company.ts と同一形式 = 原則5）
      const byTask = new Map<string | null, AiActivityLog[]>()
      for (const l of empLogs) byTask.set(l.taskId, [...(byTask.get(l.taskId) ?? []), l])
      const entries: ReportEntry[] = [...byTask.entries()].map(([taskId, ls]) => {
        const task = taskId ? aiTasks.value.find(t => t.id === taskId) : undefined
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
      const remaining = aiTasks.value
        .filter(t => t.aiEmployeeId === empId && (t.status === 'in_progress' || t.status === 'blocked'))
        .map(t => t.decomposition.find(s => !s.done)?.title)
        .filter((s): s is string => !!s)

      dailyReports.value = [...dailyReports.value, {
        id: nextId('dailyReports', 'dr'),
        authorKind: 'ai',
        memberId: null,
        aiEmployeeId: empId,
        date,
        entries,
        reflection: `活動 ${empLogs.length} 件 / 消費トークン ${fmtInt(totalTokens)} / 概算コスト $${totalCost.toFixed(3)}`,
        issues,
        tomorrow: remaining.length > 0 ? `継続: ${remaining.join(' / ')}` : '新規依頼の待機',
        status: 'submitted',
        submittedAt: `${date}T18:00:00+09:00`,
      }]
      created++
    }
    if (created > 0) commit()
    return { created, skipped }
  }

  /**
   * ワークロードシグナル検知（stalled_task / overload）。画面表示時などに呼ぶ。
   * - タスク停滞: in_progress タスクの最新活動（ログなしは createdAt）が threshold 日以上前
   * - 過負荷: AI 社員ごとの open タスク（proposed/approved/in_progress/blocked）件数が threshold 超
   * ルールの enabled / クールダウンは raise 側が判定するため二重チェックしない。
   * 補助処理のため例外は握りつぶし、呼び出し元（画面表示）をブロックしない。
   */
  async function evaluateWorkloadSignals(): Promise<{ raised: number }> {
    if (isApi) {
      // サーバーが停滞・過負荷を判定して起票する（クールダウン冪等。失敗は握りつぶし = 補助処理）
      try {
        return await apiFetch<{ raised: number }>('/v1/ai-company/workload-check', { method: 'POST' })
      } catch {
        return { raised: 0 }
      }
    }
    let raised = 0
    try {
      const stalledThreshold = escalationRules.value.find(r => r.key === 'stalled_task')?.threshold ?? 3
      const overloadThreshold = escalationRules.value.find(r => r.key === 'overload')?.threshold ?? 7
      const today = todayJst()

      // a) タスク停滞（日付キー文字列の比較で TZ 非依存に判定する）
      const stalledCutoff = addDays(today, -stalledThreshold)
      for (const task of aiTasks.value) {
        if (task.status !== 'in_progress') continue
        let lastAt: string | null = null
        for (const l of aiActivityLogs.value) {
          if (l.taskId === task.id && (lastAt === null || l.at > lastAt)) lastAt = l.at
        }
        const lastKey = (lastAt ?? task.createdAt).slice(0, 10)
        if (lastKey > stalledCutoff) continue
        const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastKey}T00:00:00Z`)) / 86_400_000)
        const r = await raise({
          reason: 'stalled_task',
          targetAiEmployeeId: task.aiEmployeeId,
          context: `AIタスク「${task.title}」が${days}日間更新されていません`,
          dedupeKey: `stalled:${task.id}`,
        })
        if (r.ok) raised++
      }

      // b) 過負荷
      const openStatuses: AiTask['status'][] = ['proposed', 'approved', 'in_progress', 'blocked']
      for (const emp of aiEmployees.value.filter(e => e.active)) {
        const count = aiTasks.value.filter(t => t.aiEmployeeId === emp.id && openStatuses.includes(t.status)).length
        if (count <= overloadThreshold) continue
        const r = await raise({
          reason: 'overload',
          targetAiEmployeeId: emp.id,
          context: `${emp.name} の保有タスクが${count}件に達しています`,
          dedupeKey: `overload:${emp.id}`,
        })
        if (r.ok) raised++
      }
    } catch {
      // 補助処理: 検知失敗は主フロー（画面表示）を止めない
    }
    return { raised }
  }

  return {
    employees, employeesAll, roles, roleOf, employeeById, tasks, tasksOf, logs, aiReportsOn,
    requestTask, approveTask, progressTask, answerTask, blockTask, cancelTask, generateDailyReports,
    evaluateWorkloadSignals,
    /** API モードのタスク・ログ再取得（バッチ7i: 承認後の自動実行の進捗を追うポーリングに使う） */
    reloadAi,
  }
}
