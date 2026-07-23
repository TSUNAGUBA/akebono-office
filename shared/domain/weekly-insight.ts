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
  /**
   * 集計基準日 = min(weekEnd, 前日)（バッチ7j・オペレーター指示 2026-07-19 #12）。
   * 日報は前日分までしか存在しないのが正常な状態のため、提出系の集計・評価はこの日までを対象にする
   *（当日・未来日を「未提出」として悲観的に扱わない）。週初め前は weekStart より前の日付になり得る
   */
  asOf: string
  /** weekStart〜asOf の営業日数（祝日・休日を除く。提出率の分母の基準。週初め前は 0） */
  businessDaysElapsed: number
  /** 日報: 提出件数・提出者数・アクティブメンバー数（提出率の分母） */
  reportSubmitted: number
  reporters: number
  membersActive: number
  /** 工数（提出済み日報の entries 合計） */
  totalHours: number
  /** memberId は閲覧時の参照権限マスク（F-16-6）用（バッチ7j: 保管データを閲覧者ごとに絞るため） */
  memberHours: { memberId?: string; name: string; hours: number }[]
  themeHours: { theme: string; hours: number }[]
  dailySubmissions: { date: string; count: number }[]
  /** 課題（日報の課題欄。member = 表示名・memberId = 参照権限マスク用） */
  issues: { memberId?: string; member: string; issue: string }[]
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

/**
 * 保管された週次インサイト（バッチ7j = 永続化。API = weekly_insights テーブル / モック = weeklyInsights コレクション）。
 * audience = 'company'（全体共通）または `member:<メンバー id>`（個別ユーザー向け）。
 * 導出キャッシュ（SoT は集計元データ）であり記録系ではない = 再生成で上書きしてよい
 */
export interface WeeklyInsightRecord {
  id: string
  weekStart: string
  audience: string
  metrics: WeeklyMetrics | PersonalWeeklyMetrics
  insight: WeeklyInsight | PersonalWeeklyInsight
  llm: boolean
  generatedBy: string
  generatedAt: string
}

const fmtH = (h: number): string => `${Math.round(h * 10) / 10}h`

/**
 * 決定的な洞察生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * しきい値はコード内に明示（提出率 80%/50%・計画完了率 70%・課題件数 3 等）
 */
export function heuristicWeeklyInsight(m: WeeklyMetrics): WeeklyInsight {
  // 提出評価は「経過した営業日（前日まで）」基準（バッチ7j: 当日・未来日を未提出扱いしない）。
  // 経過営業日ゼロ（週初め前）の週は提出系の弱み・リスクを出さない
  const elapsed = m.businessDaysElapsed
  const expectedReports = m.membersActive * elapsed
  const coverage = expectedReports > 0 ? m.reportSubmitted / expectedReports : null
  const planRate = m.planTotal > 0 ? m.planDone / m.planTotal : null
  const strengths: string[] = []
  const weaknesses: string[] = []
  const opportunities: string[] = []
  const threats: string[] = []
  const risks: WeeklyInsight['risks'] = []
  const actions: string[] = []

  if (coverage !== null && coverage >= 0.8) {
    strengths.push(`日報提出が定着（前日までの営業日 ${elapsed} 日 × ${m.membersActive} 名に対し ${m.reportSubmitted} 件）`)
  } else if (coverage !== null && coverage < 0.5) {
    weaknesses.push(`日報提出率が低い（前日までの営業日基準で ${m.reportSubmitted}/${expectedReports} 件）`)
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
    `${m.weekStart}〜${m.weekEnd} の週次サマリー（集計は前日 = ${m.asOf} 分まで。日報は前日分までが正常な運用）。`,
    elapsed === 0
      ? 'この週はまだ集計対象の営業日がありません。'
      : `日報 ${m.reportSubmitted} 件（提出者 ${m.reporters}/${m.membersActive} 名・経過営業日 ${elapsed} 日）・総時間 ${fmtH(m.totalHours)}・週報 ${m.weeklyCount} 件。`,
    m.planTotal > 0 ? `タスク計画は ${m.planDone}/${m.planTotal} 完了。` : '',
    m.workflowSubmitted > 0 ? `稟議は提出 ${m.workflowSubmitted} 件・承認 ${m.workflowApproved} 件。` : '',
    m.issues.length > 0 ? `課題報告 ${m.issues.length} 件に注意。` : '課題報告はありません。',
  ].filter(Boolean).join('')

  return { executiveSummary: summary, swot: { strengths, weaknesses, opportunities, threats }, risks, actions }
}

// ---------- 個別ユーザー向けインサイト（バッチ7j・オペレーター指示 2026-07-19 #12） ----------

/** 個別インサイトの材料（ログインユーザーの週次実績 + 属性。API/モックで同一集計） */
export interface PersonalWeeklyMetrics {
  memberId: string
  memberName: string
  role: 'admin' | 'hr' | 'member'
  /** 役職名（なし = ''） */
  title: string
  /** 所属部署名（未所属 = ''） */
  department: string
  /** 本人の提出済み日報数（asOf まで）と経過営業日 */
  reportSubmitted: number
  businessDaysElapsed: number
  /** 本人の週内工数とテーマ内訳 */
  totalHours: number
  themeHours: { theme: string; hours: number }[]
  /** 本人の課題報告（原文の冒頭） */
  issues: string[]
  /** 本人のタスク計画（週内） */
  planDone: number
  planTotal: number
  /** 今週の週報を提出済みか */
  weeklySubmitted: boolean
}

export interface PersonalWeeklyInsight {
  summary: string
  /** 今週の注目ポイント（本人の実績・役割から） */
  focus: string[]
  /** 本人向けの推奨アクション（ロール・役職に応じて最適化） */
  actions: string[]
}

/**
 * 個別インサイトの決定的生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * 本人の実績（p）+ 全体集計（company）から、ロール・役職・所属に応じた要点と推奨アクションを導く
 */
export function heuristicPersonalInsight(
  p: PersonalWeeklyMetrics,
  company: WeeklyMetrics,
): PersonalWeeklyInsight {
  const focus: string[] = []
  const actions: string[] = []
  const elapsed = p.businessDaysElapsed

  // 本人の提出状況（前日まで基準。経過営業日ゼロの週は評価しない）
  if (elapsed > 0 && p.reportSubmitted < elapsed) {
    focus.push(`日報が前日までの営業日 ${elapsed} 日に対し ${p.reportSubmitted} 件（不足分の記入を推奨）`)
    actions.push('未提出日の日報を記入する（自分の日報 > 日付ナビ）')
  } else if (elapsed > 0) {
    focus.push(`日報は前日分まで提出済み（${p.reportSubmitted} 件・時間 ${fmtH(p.totalHours)}）`)
  }
  if (p.planTotal > 0 && p.planDone < p.planTotal) {
    focus.push(`タスク計画 ${p.planDone}/${p.planTotal} 完了（未完了分の結果記録を忘れずに）`)
  }
  if (p.issues.length > 0) {
    focus.push(`自身の課題報告 ${p.issues.length} 件（管理者へ共有済み。解決状況は受信箱で確認）`)
  }
  if (!p.weeklySubmitted) actions.push('今週の週報を作成・提出する（週報 > 週報を書く）')
  if (p.themeHours.length > 0) {
    const top = p.themeHours[0]!
    focus.push(`時間の中心は「${top.theme}」（${fmtH(top.hours)}）`)
  }

  // ロール・役職に応じた視点（管理者 = 承認・課題対応 / 人事 = 提出率・負荷 / 一般 = 自身の実績）
  if (p.role === 'admin') {
    if (company.workflowSubmitted > company.workflowApproved) {
      actions.push(`滞留中の稟議 ${company.workflowSubmitted - company.workflowApproved} 件の確認（ワークフロー > 承認待ち）`)
    }
    if (company.issues.length > 0) {
      actions.push(`チームの課題報告 ${company.issues.length} 件の棚卸し（受信箱のエスカレーション）`)
    }
    if (company.escalationRaised > company.escalationResolved) {
      actions.push(`未解決エスカレーション ${company.escalationRaised - company.escalationResolved} 件への対応`)
    }
  } else if (p.role === 'hr') {
    const expected = company.membersActive * company.businessDaysElapsed
    if (expected > 0 && company.reportSubmitted < expected * 0.8) {
      actions.push('チームの日報提出率が低下傾向（チームタブで未提出者を確認・フォロー）')
    }
  }
  if (focus.length === 0) focus.push('特筆すべき遅れはありません（現状の進め方を継続）')
  if (actions.length === 0) actions.push('対応が必要な事項はありません')

  const who = [p.department, p.title].filter(Boolean).join(' / ')
  const summary = `${p.memberName} さん${who ? `（${who}）` : ''}向けの週次サマリー`
    + `（${company.weekStart}〜${company.weekEnd}・前日 ${company.asOf} 分まで）。`
    + (elapsed === 0
      ? 'この週はまだ集計対象の営業日がありません。'
      : `日報 ${p.reportSubmitted}/${elapsed} 日・時間 ${fmtH(p.totalHours)}`
        + `${p.planTotal > 0 ? `・タスク計画 ${p.planDone}/${p.planTotal}` : ''}`
        + `・週報は${p.weeklySubmitted ? '提出済み' : '未提出'}。`)

  return { summary, focus: focus.slice(0, 5), actions: actions.slice(0, 5) }
}
