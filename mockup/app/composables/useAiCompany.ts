/**
 * AIネイティブカンパニー（F-08）
 * タスク依頼 → 分解（決定的モック）→ 承認 → 実行 → 完了報告 → 日次報告生成。
 * - 乱数は使わず hashStr / irange（~/utils/rng）で決定的に生成する
 * - 活動ログ・日次報告は追記のみ（記録系保護）。日次報告は既存分をスキップする UPSERT（冪等）
 * - エスカレーション・通知は主フロー成立後に非ブロッキングで呼ぶ
 */
import type {
  AiActivityKind, AiActivityLog, AiEmployee, AiModelTier, AiRole, AiTask,
  DailyReport, ReportEntry, Result,
} from '~/types/domain'
import type { Tone } from '~/types/ui'
import { fmtInt } from '~/utils/format'
import { hashStr, irange } from '~/utils/rng'

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

// ---------- 決定的なタスク分解テンプレート ----------

const DECOMPOSITION_TEMPLATES: { keywords: string[]; steps: string[] }[] = [
  { keywords: ['調査', 'リサーチ', '動向', '市場'], steps: ['対象範囲と情報源の洗い出し', '一次情報の収集と突合', '論点別の要約整理', '調査レポートのドラフト作成'] },
  { keywords: ['資料', '提案', '議事録', 'ドラフト', '文書'], steps: ['構成案の作成', '既存ナレッジ・過去資料の参照', 'ドラフト作成', '体裁調整とセルフレビュー'] },
  { keywords: ['分析', '集計', 'データ', 'KPI'], steps: ['データ抽出条件の定義', '集計・可視化の実行', '示唆の抽出', '分析サマリーの作成'] },
  { keywords: ['レビュー', 'チェック', '確認', '点検'], steps: ['レビュー観点の整理', '対象の通読と指摘リスト化', '改善提案のまとめ'] },
]

const GENERIC_STEPS: string[][] = [
  ['依頼内容の要件整理', '必要情報の収集', '成果物ドラフトの作成', 'セルフチェックと提出'],
  ['要件の確認と論点整理', '作業の実施', '結果報告のまとめ'],
]

function decompose(title: string, description: string): { title: string; done: boolean }[] {
  const text = `${title} ${description}`
  const matched = DECOMPOSITION_TEMPLATES.find(t => t.keywords.some(k => text.includes(k)))
  const steps = matched?.steps ?? GENERIC_STEPS[hashStr(`decomp:${title}`) % GENERIC_STEPS.length]!
  return steps.map(s => ({ title: s, done: false }))
}

function judgeConfidence(aiEmployeeId: string, title: string, description: string): AiTask['confidence'] {
  const d = description.trim()
  if (d.length < 20 || d.includes('?') || d.includes('？')) return 'low'
  return hashStr(`conf:${aiEmployeeId}:${title}`) % 2 === 0 ? 'high' : 'mid'
}

export function useAiCompany() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notify } = useNotifications()
  const { raise } = useEscalations()

  const aiEmployees = tbl('aiEmployees')
  const aiRoles = tbl('aiRoles')
  const aiTasks = tbl('aiTasks')
  const aiActivityLogs = tbl('aiActivityLogs')
  const dailyReports = tbl('dailyReports')

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

  /** その日の AI 日次報告（プレビュー用） */
  function aiReportsOn(date: string): DailyReport[] {
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

  /** 活動ログを追記する（tokens/costUsd は決定的モック値） */
  function addLog(aiEmployeeId: string, taskId: string | null, kind: AiActivityKind, summary: string): void {
    const seq = aiActivityLogs.value.length
    const range: Record<AiActivityKind, [number, number]> = {
      plan: [2000, 5000], execute: [8000, 28000], report: [1500, 4000], escalate: [800, 2500], chat: [500, 1500],
    }
    const [lo, hi] = range[kind]
    const tokens = irange(`tok:${aiEmployeeId}:${kind}:${seq}`, lo, hi)
    const emp = employeeById(aiEmployeeId)
    const tier = roleOf(emp)?.modelTier ?? 'standard'
    const rate: Record<AiModelTier, number> = { lite: 0.6, standard: 1.1, pro: 2.8 }
    const costUsd = Number((tokens * rate[tier] / 1_000_000).toFixed(4))
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
  function requestTask(aiEmployeeId: string, title: string, description: string): RequestTaskResult {
    const emp = employeeById(aiEmployeeId)
    if (!emp) return { ok: false, error: { code: 'AKO-AIC-001', message: 'AI 社員が見つかりません' } }
    if (!title.trim()) return { ok: false, error: { code: 'AKO-AIC-002', message: '件名を入力してください' } }

    const confidence = judgeConfidence(aiEmployeeId, title.trim(), description)
    const id = nextId('aiTasks', 'at')
    aiTasks.value = [...aiTasks.value, {
      id,
      aiEmployeeId,
      requesterId: currentUser.value.id,
      title: title.trim(),
      description: description.trim(),
      decomposition: decompose(title, description),
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

  /** 分解案を承認して実行開始（proposed → approved → 即 in_progress） */
  function approveTask(taskId: string): Result {
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
  function progressTask(taskId: string): Result {
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
  function blockTask(taskId: string): Result {
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
  function cancelTask(taskId: string): Result {
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
  function generateDailyReports(date: string): { created: number; skipped: number } {
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

  return {
    employees, roles, roleOf, employeeById, tasks, tasksOf, logs, aiReportsOn,
    requestTask, approveTask, progressTask, blockTask, cancelTask, generateDailyReports,
  }
}
