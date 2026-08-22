/**
 * AKEBONO Intelligence のドメイン型 + 決定的分析エンジン（FI-03。改善要望 2026-08-22 で本実装）。
 *
 * 旧: intelligence/app/utils/insight-engine.ts（フロント専用のモック実装）。
 * 本実装では API サービス（/v1/intelligence/generate の LLM フォールバック）と
 * intelligence アプリのモックモードが**同一関数**を共有する = パリティの SoT
 * （customer-insight.ts / media-weekly-report.ts と同じ設計）。
 * intelligence 側の旧 import パス（~/types/intelligence・~/utils/insight-engine）はシムで維持する。
 *
 * 決定的（同じ入力 → 同じ出力）・乱数不使用・副作用なし = ユニットテスト対象。
 *
 * フィードバックループ（FI-05）:
 * - 完了 + 高評価（4-5）の過去アクション → 同系施策の「継続・横展開」を提案（reinforce）
 * - 完了 + 低評価（1-2）→ 「代替アプローチ」を提案（alternative）
 * - 計画・実行中 → 同種の重複提案を抑制（dedupe）
 * どのアクションを反映したかは feedbackConsidered として明細を返し、サイクル記録に残す。
 */
import type {
  Company, CustomerLog, DailyReport, MonthlyReport, PartnerActivity,
  Project, SalesActivity, SalesMonthly, SupportActivity, WeeklyReport,
} from './types'
import {
  PARTNER_ACTIVITY_STATUSES, SALES_ACTIVITY_PHASES, SUPPORT_ACTIVITY_STATUSES,
} from './types'
import { addDays } from './jst'
import { normalizedIncludes } from './text-match'
import { capCodePoints } from './customer-log'

// ---------- ドメイン型（インサイト・アクション・分析サイクル） ----------
// SoT はサーバー（intel_* テーブル。API モード）/ useMockDb（モックモード）。

export type InsightTheme = 'management' | 'customer' | 'project'
export type InsightConfidence = 'high' | 'mid' | 'low'

/** 分析の根拠（参照したデータソースと件数） */
export interface InsightEvidence {
  source: string
  label: string
  count: number
}

/** インサイトからの提案（アクション化の元） */
export interface InsightProposal {
  id: string
  title: string
  description: string
  priority: 'high' | 'mid' | 'low'
}

/** 反映したフィードバックの明細（ループの可視化） */
export interface FeedbackConsidered {
  actionId: string
  title: string
  rating: number | null
  effect: 'reinforce' | 'alternative' | 'dedupe'
}

export interface IntelInsight {
  id: string
  cycleId: string
  theme: InsightTheme
  /** customer = companyId / project = projectId / management = null */
  targetId: string | null
  targetName: string
  title: string
  summary: string
  findings: string[]
  evidence: InsightEvidence[]
  proposals: InsightProposal[]
  confidence: InsightConfidence
  feedbackConsidered: FeedbackConsidered[]
  /** LLM（Vertex AI）生成か（false/未定義 = 決定的ヒューリスティック）。API 本実装（0090）で付与。
   *  モック・旧ローカル記録は未定義（原則7） */
  llm?: boolean
  createdAt: string
  createdBy: string
  active: boolean
}

export type IntelActionStatus = 'planned' | 'in_progress' | 'done' | 'cancelled'

export interface IntelAction {
  id: string
  /** 提案からのアクション化の場合の由来（手動登録は null） */
  insightId: string | null
  proposalId: string | null
  theme: InsightTheme
  targetId: string | null
  targetName: string
  title: string
  description: string
  status: IntelActionStatus
  dueDate: string | null
  ownerId: string
  /** 実施内容・結果の記録 */
  result: string
  /** フィードバック（5 段階。未記録は null） */
  feedbackRating: number | null
  feedbackNote: string
  feedbackNext: string
  createdAt: string
  updatedAt: string
  active: boolean
}

/** 分析サイクル（生成のたびに追記する記録系。入力スナップショット + 反映フィードバック明細） */
export interface IntelCycle {
  id: string
  theme: InsightTheme
  targetId: string | null
  targetName: string
  at: string
  inputSnapshot: InsightEvidence[]
  feedbackConsidered: FeedbackConsidered[]
  insightIds: string[]
  createdBy: string
  active: boolean
}

/** アクションの状態遷移（完了・中止の取消 = 差し戻しを許す = 原則9.5）。API/モック共通の SoT */
export const INTEL_ACTION_STATUS_FLOW: Record<IntelActionStatus, IntelActionStatus[]> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['done', 'planned', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['planned'],
}

// ---------- 分析エンジン ----------

// エンジンが実際に読むフィールドのみの部分型（Pick）で入力を宣言する。
// フロント（全項目の行）は構造的部分型としてそのまま渡せ、API サービス（/v1/intelligence/generate）は
// この宣言どおりの SELECT でスナップショットを組み立てる = エンジンの参照列を増やしたら
// ここと API の SELECT を同時に更新する（型が乖離を検出する）。
export type EngineDaily = Pick<DailyReport, 'memberId' | 'date' | 'entries' | 'issues' | 'status'>
export type EngineWeekly = Pick<WeeklyReport, 'weekStart'> & { active?: boolean }
export type EngineMonthly = Pick<MonthlyReport, 'monthStart'> & { active?: boolean }
export type EngineSupport = Pick<SupportActivity, 'companyId' | 'receivedDate' | 'category' | 'status' | 'active'>
export type EngineSales = Pick<SalesActivity,
  'companyId' | 'title' | 'phase' | 'amount' | 'nextActionDate' | 'customerIssue' | 'createdAt' | 'updatedAt' | 'active'>
export type EnginePartner = Pick<PartnerActivity, 'partnerCompanyId' | 'approachCompanyId' | 'status' | 'createdAt' | 'active'>
export type EngineCustomerLog = Pick<CustomerLog, 'companyId' | 'logDate' | 'active'>
export type EngineSalesMonthly = Pick<SalesMonthly, 'month' | 'amount'>
export type EngineCompany = Pick<Company, 'id' | 'name'>
export type EngineProject = Pick<Project, 'id' | 'name' | 'status' | 'endDate'>

export interface EngineData {
  daily: EngineDaily[]
  weekly: EngineWeekly[]
  monthly: EngineMonthly[]
  support: EngineSupport[]
  sales: EngineSales[]
  partner: EnginePartner[]
  customerLogs: EngineCustomerLog[]
  salesMonthly: EngineSalesMonthly[]
  companies: EngineCompany[]
  projects: EngineProject[]
}

export interface EngineOptions {
  theme: InsightTheme
  /** customer = companyId / project = projectId / management = null */
  targetId: string | null
  /** JST 日付キー（YYYY-MM-DD） */
  today: string
  /** フィードバックループの入力（アーカイブ済みは呼び出し側で除外して渡す） */
  pastActions: IntelAction[]
}

export interface EngineInsightDraft {
  targetName: string
  title: string
  summary: string
  findings: string[]
  evidence: InsightEvidence[]
  proposals: Omit<InsightProposal, 'id'>[]
  confidence: InsightConfidence
  feedbackConsidered: FeedbackConsidered[]
}

export type EngineResult =
  | ({ ok: true } & EngineInsightDraft)
  | { ok: false; error: { code: string; message: string } }

// ---------- 期間ヘルパー ----------

/** 'YYYY-MM' へ月数を加算する */
export function addMonths(month: string, delta: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const idx = y * 12 + (m - 1) + delta
  const ny = Math.floor(idx / 12)
  const nm = (idx % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/** 直近 days 日（today 含む）の開始日付キー */
function sinceDays(today: string, days: number): string {
  return addDays(today, -(days - 1))
}

// 区分値は shared/domain/types（SoT）から導出する（R1 #3: 直書き散在の禁止 = 追加値への自動追従）。
// 終端側（受注/失注・解決・休眠系）のみ列挙し、進行中系は SoT から差し引いて求める。
const PHASE_WON = '受注'
const CLOSED_SALES_PHASES = new Set<string>([PHASE_WON, '失注'])
const OPEN_SALES_PHASES = new Set<string>(SALES_ACTIVITY_PHASES.filter(p => !CLOSED_SALES_PHASES.has(p)))
const RESOLVED_SUPPORT_STATUS = '解決'
const OPEN_SUPPORT_STATUSES = new Set<string>(SUPPORT_ACTIVITY_STATUSES.filter(s => s !== RESOLVED_SUPPORT_STATUS))
const DORMANT_PARTNER_STATUSES = new Set<string>(['情報収集', '検討', '完了'])
const ACTIVE_PARTNER_STATUSES = new Set<string>(PARTNER_ACTIVITY_STATUSES.filter(s => !DORMANT_PARTNER_STATUSES.has(s)))

function activeRows<T>(rows: T[]): T[] {
  return rows.filter(r => (r as { active?: boolean }).active !== false)
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0
}

function fmtMan(amount: number): string {
  return `${Math.round(amount / 10_000).toLocaleString('ja-JP')}万円`
}

// ---------- フィードバックループ ----------

interface FeedbackOutcome {
  considered: FeedbackConsidered[]
  extraProposals: Omit<InsightProposal, 'id'>[]
  /** dedupe 対象のアクションタイトル（生成済み提案から同種を除外する） */
  dedupeTitles: string[]
}

function applyFeedback(theme: InsightTheme, targetId: string | null, pastActions: IntelAction[]): FeedbackOutcome {
  const relevant = pastActions.filter(a =>
    a.theme === theme && (theme === 'management' || a.targetId === targetId))
  const considered: FeedbackConsidered[] = []
  const extraProposals: Omit<InsightProposal, 'id'>[] = []
  const dedupeTitles: string[] = []
  for (const a of relevant) {
    if (a.status === 'done' && a.feedbackRating !== null && a.feedbackRating >= 4) {
      considered.push({ actionId: a.id, title: a.title, rating: a.feedbackRating, effect: 'reinforce' })
      extraProposals.push({
        title: `「${a.title}」の継続・横展開`,
        description: `前回サイクルで高評価（${a.feedbackRating}/5）だった施策。フィードバック「${a.feedbackNote || '（コメントなし）'}」を踏まえ、対象を広げて継続する。`,
        priority: 'high',
      })
    } else if (a.status === 'done' && a.feedbackRating !== null && a.feedbackRating <= 2) {
      considered.push({ actionId: a.id, title: a.title, rating: a.feedbackRating, effect: 'alternative' })
      extraProposals.push({
        title: `「${a.title}」に代わるアプローチの検討`,
        description: `前回サイクルで低評価（${a.feedbackRating}/5）だった施策。「${a.feedbackNext || a.feedbackNote || '（コメントなし）'}」を踏まえ、別の切り口を試す。`,
        priority: 'mid',
      })
    } else if (a.status === 'planned' || a.status === 'in_progress') {
      considered.push({ actionId: a.id, title: a.title, rating: null, effect: 'dedupe' })
      dedupeTitles.push(a.title)
    }
  }
  return { considered, extraProposals, dedupeTitles }
}

/** 実行中アクションと同種の提案を抑制する（タイトルの正規化部分一致） */
function dedupeProposals(
  proposals: Omit<InsightProposal, 'id'>[], dedupeTitles: string[],
): Omit<InsightProposal, 'id'>[] {
  if (dedupeTitles.length === 0) return proposals
  return proposals.filter(p =>
    !dedupeTitles.some(t => normalizedIncludes(p.title, t) || normalizedIncludes(t, p.title)))
}

function confidenceOf(evidence: InsightEvidence[]): InsightConfidence {
  const total = evidence.reduce((s, e) => s + e.count, 0)
  if (total >= 40) return 'high'
  if (total >= 10) return 'mid'
  return 'low'
}

// ---------- テーマ別分析 ----------

function analyzeManagement(data: EngineData, opts: EngineOptions): EngineResult {
  const month = opts.today.slice(0, 7)
  const prevMonth = addMonths(month, -1)
  const daily = activeRows(data.daily).filter(r => r.status === 'submitted')
  const dailyThis = daily.filter(r => r.date.slice(0, 7) === month)
  const dailyPrev = daily.filter(r => r.date.slice(0, 7) === prevMonth)
  const support = activeRows(data.support)
  const sales = activeRows(data.sales)
  const partner = activeRows(data.partner)
  const supportThis = support.filter(s => s.receivedDate.slice(0, 7) === month)
  const supportPrev = support.filter(s => s.receivedDate.slice(0, 7) === prevMonth)
  const partnerThis = partner.filter(p => p.createdAt.slice(0, 7) === month)

  const evidence: InsightEvidence[] = [
    { source: 'daily', label: `日報（${month}）`, count: dailyThis.length },
    { source: 'weekly', label: '週報', count: activeRows(data.weekly).length },
    { source: 'monthly', label: '月報', count: activeRows(data.monthly).length },
    { source: 'support', label: `サポート活動（${month}）`, count: supportThis.length },
    { source: 'sales', label: '営業活動（進行中含む全件）', count: sales.length },
    { source: 'partner', label: 'ビジネスパートナー活動', count: partner.length },
    { source: 'salesMonthly', label: '月次売上', count: data.salesMonthly.length },
  ]
  if (evidence.every(e => e.count === 0)) {
    return { ok: false, error: { code: 'AKI-INS-001', message: '分析対象のデータがありません（データソースの状況を確認してください）' } }
  }

  const findings: string[] = []
  const proposals: Omit<InsightProposal, 'id'>[] = []

  // 1) 営業パイプライン
  const openDeals = sales.filter(s => OPEN_SALES_PHASES.has(s.phase))
  const pipeline = openDeals.reduce((s, d) => s + (d.amount ?? 0), 0)
  const stalled = openDeals.filter(d => !d.nextActionDate || d.nextActionDate < opts.today)
  if (openDeals.length > 0) {
    findings.push(`進行中の商談は ${openDeals.length} 件（パイプライン ${fmtMan(pipeline)}）。うち ${stalled.length} 件は Next Action 日が未設定または期限超過。`)
  }
  if (stalled.length > 0) {
    proposals.push({
      title: '停滞商談の Next Action 再設定',
      description: `Next Action が未設定・期限超過の商談 ${stalled.length} 件（${stalled.slice(0, 3).map(d => `「${d.title}」`).join('・')}${stalled.length > 3 ? ' ほか' : ''}）について、担当者と次の一手を決める。`,
      priority: 'high',
    })
  }

  // 2) 売上トレンド（月次売上マートの直近 2 ヶ月比較）
  const monthsWithSales = [...new Set(data.salesMonthly.map(s => s.month))].sort()
  if (monthsWithSales.length >= 2) {
    const latest = monthsWithSales[monthsWithSales.length - 1]!
    const before = monthsWithSales[monthsWithSales.length - 2]!
    const sumOf = (m: string) => data.salesMonthly.filter(s => s.month === m).reduce((s, x) => s + x.amount, 0)
    const a = sumOf(latest)
    const b = sumOf(before)
    const diffPct = b > 0 ? Math.round(((a - b) / b) * 100) : 0
    findings.push(`月次売上は ${latest} が ${fmtMan(a)}（前月比 ${diffPct >= 0 ? '+' : ''}${diffPct}%）。`)
    if (diffPct < -10) {
      proposals.push({
        title: '売上減少要因の深掘りレビュー',
        description: `${before} → ${latest} で売上が ${diffPct}% 減少。顧客別・案件種別の内訳を確認し、減少要因を特定する。`,
        priority: 'high',
      })
    }
  }

  // 3) サポート負荷
  if (supportThis.length > 0 || supportPrev.length > 0) {
    const openSupport = support.filter(s => OPEN_SUPPORT_STATUSES.has(s.status))
    const catCount = new Map<string, number>()
    for (const s of supportThis) catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1)
    const topCat = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]
    findings.push(`サポート受付は当月 ${supportThis.length} 件（前月 ${supportPrev.length} 件）、未解決 ${openSupport.length} 件${topCat ? `。最多カテゴリは「${topCat[0]}」（${topCat[1]} 件）` : ''}。`)
    if (topCat && topCat[1] >= 3) {
      proposals.push({
        title: `「${topCat[0]}」問い合わせの恒久対策`,
        description: `当月最多のカテゴリ「${topCat[0]}」（${topCat[1]} 件）について、FAQ 整備・機能改善などの恒久対策を検討し、問い合わせ件数の削減を図る。`,
        priority: 'mid',
      })
    }
  }

  // 4) 日報から見た組織の稼働と課題
  if (dailyThis.length > 0) {
    const withIssues = dailyThis.filter(r => r.issues.trim().length > 0)
    findings.push(`当月の日報提出は ${dailyThis.length} 件（前月 ${dailyPrev.length} 件）。課題記載率は ${pct(withIssues.length, dailyThis.length)}%。`)
    if (pct(withIssues.length, dailyThis.length) >= 40) {
      proposals.push({
        title: '日報の課題傾向の棚卸し',
        description: `日報の ${pct(withIssues.length, dailyThis.length)}% に課題が記載されている。カテゴリ別に集計し、繰り返し発生している課題への対策を打つ。`,
        priority: 'mid',
      })
    }
  }

  // 5) パートナー連携
  const partnerActive = partner.filter(p => ACTIVE_PARTNER_STATUSES.has(p.status))
  if (partnerActive.length > 0) {
    // 文言も SoT 導出の集合から組み立てる（件数と文言の乖離防止 = R2 #3）
    findings.push(`ビジネスパートナー活動は${[...ACTIVE_PARTNER_STATUSES].join('・')}が計 ${partnerActive.length} 件（当月新規 ${partnerThis.length} 件）。`)
  }

  const fb = applyFeedback('management', null, opts.pastActions)
  const finalProposals = [...dedupeProposals(proposals, fb.dedupeTitles), ...fb.extraProposals]

  return {
    ok: true,
    targetName: '全社',
    title: `経営サマリー（${month}）`,
    summary: findings[0] ?? `${month} の全社活動データを横断した分析結果です。`,
    findings,
    evidence,
    proposals: finalProposals,
    confidence: confidenceOf(evidence),
    feedbackConsidered: fb.considered,
  }
}

function analyzeCustomer(data: EngineData, opts: EngineOptions): EngineResult {
  const company = data.companies.find(c => c.id === opts.targetId)
  if (!company) {
    return { ok: false, error: { code: 'AKI-INS-002', message: '対象の顧客が見つかりません' } }
  }
  const since = sinceDays(opts.today, 90)
  const support = activeRows(data.support).filter(s => s.companyId === company.id)
  const sales = activeRows(data.sales).filter(s => s.companyId === company.id)
  const partner = activeRows(data.partner).filter(p =>
    p.approachCompanyId === company.id || p.partnerCompanyId === company.id)
  const logs = activeRows(data.customerLogs).filter(l => l.companyId === company.id)
  const logsRecent = logs.filter(l => l.logDate >= since)

  const evidence: InsightEvidence[] = [
    { source: 'customerLog', label: '顧客活動（直近90日）', count: logsRecent.length },
    { source: 'sales', label: '営業活動', count: sales.length },
    { source: 'support', label: 'サポート活動', count: support.length },
    { source: 'partner', label: 'ビジネスパートナー活動', count: partner.length },
  ]
  if (evidence.every(e => e.count === 0)) {
    return { ok: false, error: { code: 'AKI-INS-001', message: `「${company.name}」の活動データがありません` } }
  }

  const findings: string[] = []
  const proposals: Omit<InsightProposal, 'id'>[] = []

  // 1) 接点の鮮度
  const touchDates = [
    ...logs.map(l => l.logDate),
    ...support.map(s => s.receivedDate),
    ...sales.map(s => (s.updatedAt ?? s.createdAt).slice(0, 10)),
  ].sort()
  const lastTouch = touchDates[touchDates.length - 1]
  if (lastTouch) {
    const silentDays = Math.round((Date.parse(`${opts.today}T00:00:00Z`) - Date.parse(`${lastTouch}T00:00:00Z`)) / 86_400_000)
    findings.push(`最終接点は ${lastTouch}（${silentDays} 日前）。直近 90 日の顧客活動は ${logsRecent.length} 件。`)
    if (silentDays >= 30) {
      proposals.push({
        title: `${company.name} へのフォローアップ接点の設定`,
        description: `最終接点から ${silentDays} 日が経過。近況ヒアリングを兼ねた定例・訪問を設定し、関係の希薄化を防ぐ。`,
        priority: 'high',
      })
    }
  }

  // 2) 商談状況
  const openDeals = sales.filter(s => OPEN_SALES_PHASES.has(s.phase))
  const stalled = openDeals.filter(d => !d.nextActionDate || d.nextActionDate < opts.today)
  const won = sales.filter(s => s.phase === PHASE_WON)
  if (sales.length > 0) {
    findings.push(`商談は全 ${sales.length} 件（進行中 ${openDeals.length} / 受注 ${won.length}）。進行中パイプラインは ${fmtMan(openDeals.reduce((s, d) => s + (d.amount ?? 0), 0))}。`)
  }
  for (const d of stalled.slice(0, 2)) {
    proposals.push({
      title: `商談「${d.title}」の Next Action 設定`,
      description: `フェーズ「${d.phase}」で Next Action が${d.nextActionDate ? `期限超過（${d.nextActionDate}）` : '未設定'}。顧客課題「${d.customerIssue || '未記載'}」を踏まえた次の一手を決める。`,
      priority: 'high',
    })
  }

  // 3) サポート状況
  const openSupport = support.filter(s => OPEN_SUPPORT_STATUSES.has(s.status))
  if (support.length > 0) {
    const catCount = new Map<string, number>()
    for (const s of support) catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1)
    const topCat = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]!
    findings.push(`サポートは累計 ${support.length} 件（未解決 ${openSupport.length} 件）。最多カテゴリは「${topCat[0]}」。`)
    if (openSupport.length >= 2) {
      proposals.push({
        title: `${company.name} の未解決サポートの一斉レビュー`,
        description: `未解決 ${openSupport.length} 件の対応状況を棚卸しし、優先度順に解決期日を設定する。顧客満足の低下を防ぐ。`,
        priority: 'mid',
      })
    }
  }

  // 4) 拡販機会（接点は多いが進行中商談がない）
  if (logsRecent.length >= 3 && openDeals.length === 0) {
    proposals.push({
      title: `${company.name} への新規提案の検討`,
      description: `直近 90 日に ${logsRecent.length} 件の接点がある一方、進行中の商談がない。ヒアリング内容から課題を整理し、新規提案の機会を探る。`,
      priority: 'mid',
    })
  }

  const fb = applyFeedback('customer', company.id, opts.pastActions)
  const finalProposals = [...dedupeProposals(proposals, fb.dedupeTitles), ...fb.extraProposals]

  return {
    ok: true,
    targetName: company.name,
    title: `顧客分析: ${company.name}`,
    summary: findings[0] ?? `${company.name} の活動データを横断した分析結果です。`,
    findings,
    evidence,
    proposals: finalProposals,
    confidence: confidenceOf(evidence),
    feedbackConsidered: fb.considered,
  }
}

function analyzeProject(data: EngineData, opts: EngineOptions): EngineResult {
  const project = data.projects.find(p => p.id === opts.targetId)
  if (!project) {
    return { ok: false, error: { code: 'AKI-INS-003', message: '対象の案件が見つかりません' } }
  }
  const month = opts.today.slice(0, 7)
  const prevMonth = addMonths(month, -1)
  const daily = activeRows(data.daily).filter(r => r.status === 'submitted')

  interface Entry { date: string; memberId: string | null; hours: number; progress: number; issues: string }
  const entries: Entry[] = []
  for (const r of daily) {
    for (const e of r.entries) {
      if (e.projectId === project.id) {
        entries.push({ date: r.date, memberId: r.memberId, hours: e.hours, progress: e.progress, issues: r.issues })
      }
    }
  }
  const entThis = entries.filter(e => e.date.slice(0, 7) === month)
  const entPrev = entries.filter(e => e.date.slice(0, 7) === prevMonth)

  const evidence: InsightEvidence[] = [
    { source: 'daily', label: `日報の案件エントリ（${month}）`, count: entThis.length },
    { source: 'daily', label: `日報の案件エントリ（${prevMonth}）`, count: entPrev.length },
  ]
  if (entries.length === 0) {
    return { ok: false, error: { code: 'AKI-INS-001', message: `「${project.name}」に紐づく日報エントリがありません` } }
  }

  const findings: string[] = []
  const proposals: Omit<InsightProposal, 'id'>[] = []

  // 1) 投下工数のトレンド
  const hoursThis = entThis.reduce((s, e) => s + e.hours, 0)
  const hoursPrev = entPrev.reduce((s, e) => s + e.hours, 0)
  const membersThis = new Set(entThis.map(e => e.memberId).filter(Boolean)).size
  findings.push(`当月の投下工数は ${hoursThis.toFixed(1)}h（前月 ${hoursPrev.toFixed(1)}h）、稼働メンバー ${membersThis} 名。`)
  if (hoursPrev > 0 && hoursThis < hoursPrev * 0.5 && project.status === 'active') {
    proposals.push({
      title: `${project.name} の稼働低下の要因確認`,
      description: `投下工数が前月比 ${pct(hoursThis, hoursPrev)}% に低下。優先度変更・ブロッカーの有無をオーナーに確認し、計画を更新する。`,
      priority: 'high',
    })
  }

  // 2) 進捗の到達度（直近エントリの平均進捗）
  const recent = [...entries].sort((a, b) => a.date.localeCompare(b.date)).slice(-10)
  const avgProgress = Math.round(recent.reduce((s, e) => s + e.progress, 0) / Math.max(1, recent.length))
  findings.push(`直近エントリの平均進捗は ${avgProgress}%。案件ステータスは「${project.status}」。`)
  if (avgProgress < 50 && project.endDate && project.endDate <= addMonths(month, 1) + '-31') {
    proposals.push({
      title: `${project.name} のスコープ・期日の再調整`,
      description: `終了予定（${project.endDate}）が近いが平均進捗 ${avgProgress}%。残作業を棚卸しし、スコープ調整または期日再設定を判断する。`,
      priority: 'high',
    })
  }

  // 3) 課題の言及
  const issueEntries = entries.filter(e => e.issues.trim().length > 0)
  if (issueEntries.length > 0) {
    const lastIssue = issueEntries[issueEntries.length - 1]!.issues
    const excerpt = capCodePoints(lastIssue, 40) + ([...lastIssue].length > 40 ? '…' : '')
    findings.push(`案件に従事した日の日報のうち ${issueEntries.length} 件に課題の記載あり（例: ${excerpt}）。`)
    proposals.push({
      title: `${project.name} の課題レビュー会の実施`,
      description: `日報に記載された課題 ${issueEntries.length} 件を棚卸しし、対応方針をチームで決める。`,
      priority: 'mid',
    })
  }

  const fb = applyFeedback('project', project.id, opts.pastActions)
  const finalProposals = [...dedupeProposals(proposals, fb.dedupeTitles), ...fb.extraProposals]

  return {
    ok: true,
    targetName: project.name,
    title: `案件分析: ${project.name}`,
    summary: findings[0] ?? `${project.name} の日報データを横断した分析結果です。`,
    findings,
    evidence,
    proposals: finalProposals,
    confidence: confidenceOf(evidence),
    feedbackConsidered: fb.considered,
  }
}

/** 分析を実行する（決定的。データが無い場合は AKI-INS-001 を返す） */
export function generateInsightDraft(data: EngineData, opts: EngineOptions): EngineResult {
  if (opts.theme === 'management') return analyzeManagement(data, opts)
  if (opts.theme === 'customer') return analyzeCustomer(data, opts)
  return analyzeProject(data, opts)
}
