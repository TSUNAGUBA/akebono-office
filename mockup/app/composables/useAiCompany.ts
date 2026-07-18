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
  decomposeTask, judgeTaskConfidence, mockActivityCost,
} from '../../../shared/domain/ai-tasks'
import type {
  AiActivityKind, AiActivityLog, AiEmployee, AiModelTier, AiRole, AiTask,
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

/** ロールに付与できる権限の固定候補（6 種） */
export const AI_PERMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: 'knowledge:read', label: 'ナレッジ参照' },
  { value: 'knowledge:write', label: 'ナレッジ更新' },
  { value: 'documents:write', label: 'ドキュメント作成' },
  { value: 'mart:read', label: '分析データ参照' },
  { value: 'masters:read', label: 'マスタ参照' },
  { value: 'web:search', label: 'Web 検索' },
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
    const { tokens, costUsd } = mockActivityCost(aiEmployeeId, kind, aiActivityLogs.value.length, tier)
    aiActivityLogs.value = [...aiActivityLogs.value, {
      id: nextId('aiActivityLogs', 'aal'),
      aiEmployeeId, taskId, kind, summary, tokens, costUsd,
      at: nowJstIso(),
    }]
  }

  // ---------- 操作系 ----------

  /**
   * タスクを依頼する。AI が決定的にタスク分解を生成し status='proposed' で登録する。
   * confidence が low の場合はエスカレーション起票（非ブロッキング）し、フラグを返す。
   */
  async function requestTask(aiEmployeeId: string, title: string, description: string): Promise<RequestTaskResult> {
    if (isApi) {
      // 分解はサーバー（Vertex AI → 失敗時 shared ヒューリスティック）。エスカレーションもサーバーが担う
      try {
        const data = await apiFetch<{ id: string; confidence: AiTask['confidence'] }>('/v1/ai-company/tasks', {
          method: 'POST', body: { aiEmployeeId, title: title.trim(), description: description.trim() },
        })
        await reloadAi()
        return { ok: true, id: data.id, confidence: data.confidence }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const emp = employeeById(aiEmployeeId)
    if (!emp) return { ok: false, error: { code: 'AKO-AIC-001', message: 'AI 社員が見つかりません' } }
    if (!title.trim()) return { ok: false, error: { code: 'AKO-AIC-002', message: '件名を入力してください' } }

    const confidence = judgeTaskConfidence(aiEmployeeId, title.trim(), description)
    const id = nextId('aiTasks', 'at')
    aiTasks.value = [...aiTasks.value, {
      id,
      aiEmployeeId,
      requesterId: currentUser.value.id,
      title: title.trim(),
      description: description.trim(),
      decomposition: decomposeTask(title, description),
      status: 'proposed',
      dueDate: null,
      confidence,
      createdAt: nowJstIso(),
    }]
    addLog(aiEmployeeId, id, 'plan', `「${title.trim()}」の分解案を作成し承認待ち`)
    syncEmployeeStatus(aiEmployeeId)
    commit()

    // 補助処理: 低確信度エスカレーション（失敗しても主フローは成立）
    if (confidence === 'low') {
      const date = nowJstIso().slice(0, 10)
      raise({
        reason: 'low_confidence',
        targetAiEmployeeId: aiEmployeeId,
        context: `AI社員への依頼「${title.trim()}」の確信度が低いため確認が必要`,
        dedupeKey: `lowconf:${aiEmployeeId}:${date}`,
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

  /** 分解案を承認して実行開始（proposed → approved → 即 in_progress） */
  async function approveTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'approve')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.status !== 'proposed') {
      return { ok: false, error: { code: 'AKO-AIC-004', message: '提案中のタスクのみ承認できます' } }
    }
    aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'in_progress' as const } : t)
    addLog(task.aiEmployeeId, taskId, 'plan', `「${task.title}」の分解が承認され実行を開始`)
    syncEmployeeStatus(task.aiEmployeeId)
    commit()
    return { ok: true, id: taskId }
  }

  /** 実行を 1 ステップ進める。全ステップ完了で done + 完了報告 + 依頼者へ通知 */
  async function progressTask(taskId: string): Promise<Result> {
    if (isApi) return transitionApi(taskId, 'progress')
    const task = aiTasks.value.find(t => t.id === taskId)
    if (!task) return { ok: false, error: { code: 'AKO-AIC-003', message: 'タスクが見つかりません' } }
    if (task.status !== 'in_progress') {
      return { ok: false, error: { code: 'AKO-AIC-005', message: '実行中のタスクのみ進められます' } }
    }
    const idx = task.decomposition.findIndex(s => !s.done)
    if (idx < 0) return { ok: false, error: { code: 'AKO-AIC-006', message: '未完了のステップがありません' } }

    const step = task.decomposition[idx]!
    const decomposition = task.decomposition.map((s, i) => i === idx ? { ...s, done: true } : s)
    const finished = decomposition.every(s => s.done)
    aiTasks.value = aiTasks.value.map(t => t.id === taskId
      ? { ...t, decomposition, status: finished ? 'done' as const : t.status }
      : t)
    addLog(task.aiEmployeeId, taskId, 'execute', `「${step.title}」を完了`)
    if (finished) {
      addLog(task.aiEmployeeId, taskId, 'report', `「${task.title}」の全ステップが完了、成果を報告`)
    }
    syncEmployeeStatus(task.aiEmployeeId)
    commit()

    // 補助処理: 完了通知（失敗しても主フローは成立）
    if (finished) {
      const emp = employeeById(task.aiEmployeeId)
      notify(task.requesterId, 'ai_report', `AI 完了報告: ${task.title}`,
        `${emp?.name ?? 'AI社員'} がタスクを完了しました`, '/ai-company')
    }
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
    } else if (task.status === 'blocked') {
      aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'in_progress' as const } : t)
      addLog(task.aiEmployeeId, taskId, 'plan', `「${task.title}」のブロックが解除され実行を再開`)
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
    aiTasks.value = aiTasks.value.map(t => t.id === taskId ? { ...t, status: 'cancelled' as const } : t)
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

      // タスク別エントリ（AI 活動は自社 PJ「AKEBONO Office 開発」に計上）
      const byTask = new Map<string | null, AiActivityLog[]>()
      for (const l of empLogs) byTask.set(l.taskId, [...(byTask.get(l.taskId) ?? []), l])
      const entries: ReportEntry[] = [...byTask.entries()].map(([taskId, ls]) => {
        const task = taskId ? aiTasks.value.find(t => t.id === taskId) : undefined
        const doneCount = task ? task.decomposition.filter(s => s.done).length : 0
        return {
          projectId: 'pj-08',
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
    employees, roles, roleOf, employeeById, tasks, tasksOf, logs, aiReportsOn,
    requestTask, approveTask, progressTask, blockTask, cancelTask, generateDailyReports,
    evaluateWorkloadSignals,
  }
}
