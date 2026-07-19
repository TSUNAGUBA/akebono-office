/**
 * 週次 AI インサイト（バッチ7g・オペレーター指示 2026-07-19 #9）。
 * 該当週に登録された全データ（閲覧権限準拠）の決定的集計（WeeklyMetrics）と、
 * そこから経営・営業・チーム/メンバー状況の視点で洞察（WeeklyInsight）を導く。
 * - 集計はフロント（モック）/ API で同一の型
 * - 洞察は API = Vertex AI（構造化出力）→ 失敗時 heuristicWeeklyInsight / モック = heuristic のみ（原則4）
 * - ヒューリスティックは metrics のみから決定的に生成する（推測で事実を作らない）
 */

export interface WeeklyMetrics {
  weekStart: string
  weekEnd: string
  /** 日報: 提出件数・提出者数・アクティブメンバー数（提出率の分母） */
  reportSubmitted: number
  reporters: number
  membersActive: number
  /** 工数（提出済み日報の entries 合計） */
  totalHours: number
  memberHours: { name: string; hours: number }[]
  themeHours: { theme: string; hours: number }[]
  dailySubmissions: { date: string; count: number }[]
  /** 課題（日報の課題欄。member = 表示名） */
  issues: { member: string; issue: string }[]
  weeklyCount: number
  /** タスク計画（週内の date） */
  planDone: number
  planTotal: number
  /** ワークフロー（週内に作成/承認） */
  workflowSubmitted: number
  workflowApproved: number
  /** エスカレーション（週内起票 / うち解決済み） */
  escalationRaised: number
  escalationResolved: number
  /** AI カンパニー（週内更新の完了 / 現在進行中） */
  aiTasksDone: number
  aiTasksActive: number
  /** ノート（週内登録） */
  minutesCount: number
  poipoiCount: number
  /** 当月売上（円）。閲覧権限がない場合は null（供給しない） */
  salesMonthAmount: number | null
}

export interface WeeklyInsight {
  executiveSummary: string
  swot: { strengths: string[]; weaknesses: string[]; opportunities: string[]; threats: string[] }
  risks: { title: string; severity: 'high' | 'mid' | 'low'; mitigation: string }[]
  actions: string[]
}

const fmtH = (h: number): string => `${Math.round(h * 10) / 10}h`

/**
 * 決定的な洞察生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * しきい値はコード内に明示（提出率 80%/50%・計画完了率 70%・課題件数 3 等）
 */
export function heuristicWeeklyInsight(m: WeeklyMetrics): WeeklyInsight {
  const submitRate = m.membersActive > 0 ? m.reporters / m.membersActive : 0
  const planRate = m.planTotal > 0 ? m.planDone / m.planTotal : null
  const strengths: string[] = []
  const weaknesses: string[] = []
  const opportunities: string[] = []
  const threats: string[] = []
  const risks: WeeklyInsight['risks'] = []
  const actions: string[] = []

  if (submitRate >= 0.8) strengths.push(`日報提出が定着（提出者 ${m.reporters}/${m.membersActive} 名）`)
  else if (submitRate < 0.5) {
    weaknesses.push(`日報提出率が低い（${m.reporters}/${m.membersActive} 名）`)
    actions.push('未提出メンバーへのリマインド（日報・週報 > チーム > 一括リマインド）')
  }
  if (planRate !== null && planRate >= 0.7) strengths.push(`タスク計画の完了率が高い（${m.planDone}/${m.planTotal}）`)
  if (planRate !== null && planRate < 0.4) {
    weaknesses.push(`タスク計画の完了率が低い（${m.planDone}/${m.planTotal}）`)
    risks.push({ title: '計画と実績の乖離', severity: 'mid', mitigation: '計画粒度の見直しと未完了要因のヒアリング' })
  }
  if (m.aiTasksDone > 0) strengths.push(`AI 社員の完了タスク ${m.aiTasksDone} 件（業務の自動化が回っている）`)
  if (m.minutesCount + m.poipoiCount > 0) {
    opportunities.push(`議事録 ${m.minutesCount} 件・ぽいぽいポスト ${m.poipoiCount} 件の現場情報が蓄積（AI 参照で活用可能）`)
  }
  if (m.workflowSubmitted > m.workflowApproved + 2) {
    weaknesses.push(`承認待ちの稟議が滞留（提出 ${m.workflowSubmitted} / 承認 ${m.workflowApproved}）`)
    actions.push('承認者の滞留稟議の確認（ワークフロー > 承認待ち）')
  }
  if (m.issues.length >= 3) {
    threats.push(`日報の課題報告が ${m.issues.length} 件（現場負荷・ブロッカーの兆候）`)
    risks.push({ title: '現場課題の累積', severity: m.issues.length >= 5 ? 'high' : 'mid', mitigation: '課題の棚卸しと担当・期限の割当（受信箱のエスカレーションから）' })
  }
  if (m.escalationRaised > m.escalationResolved) {
    threats.push(`未解決エスカレーションが増加（起票 ${m.escalationRaised} / 解決 ${m.escalationResolved}）`)
  }
  if (m.salesMonthAmount !== null && m.salesMonthAmount > 0) {
    opportunities.push(`当月売上 ${(m.salesMonthAmount / 10_000).toLocaleString('ja-JP')} 万円（詳細は売上管理・意思決定支援へ）`)
  }
  if (strengths.length === 0) strengths.push('大きな障害なく週次の業務データが記録されている')
  if (actions.length === 0) actions.push('特筆すべき対応事項なし（現状の運用を継続）')

  const summary = [
    `${m.weekStart}〜${m.weekEnd} の週次サマリー。`,
    `日報 ${m.reportSubmitted} 件（提出者 ${m.reporters}/${m.membersActive} 名）・総工数 ${fmtH(m.totalHours)}・週報 ${m.weeklyCount} 件。`,
    m.planTotal > 0 ? `タスク計画は ${m.planDone}/${m.planTotal} 完了。` : '',
    m.workflowSubmitted > 0 ? `稟議は提出 ${m.workflowSubmitted} 件・承認 ${m.workflowApproved} 件。` : '',
    m.issues.length > 0 ? `課題報告 ${m.issues.length} 件に注意。` : '課題報告はありません。',
  ].filter(Boolean).join('')

  return { executiveSummary: summary, swot: { strengths, weaknesses, opportunities, threats }, risks, actions }
}
