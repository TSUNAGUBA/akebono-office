/**
 * 業務データの決定的シード（モックモード用のデモデータ）。
 * 「今日」を基準に過去分を生成するが、内容は rng（キー付きハッシュ）で決定的。
 * リロードしても同じ日なら同じ世界が再現される（Math.random 禁止 = CONVENTIONS 準拠）。
 * API モードでは使われない（実データを共通 API から読む）。
 */
import type {
  CustomerLog, DailyReport, MonthlyReport, PartnerActivity, ReportEntry,
  SalesActivity, SalesMonthly, SupportActivity, WeeklyReport,
} from '~/types/domain'
import {
  CUSTOMER_LOG_METHOD_PRESETS, CUSTOMER_LOG_TAG_PRESETS,
  PARTNER_ACTIVITY_STATUSES, PARTNER_ACTIVITY_TYPES,
  SALES_ACTIVITY_DEAL_TYPES, SALES_ACTIVITY_PHASES,
  SUPPORT_ACTIVITY_CATEGORIES, SUPPORT_ACTIVITY_PRIORITIES, SUPPORT_ACTIVITY_STATUSES,
  SUPPORT_FIRST_CONTACT_METHODS,
} from '~/types/domain'
import { addDays, todayJst, weekdayOf } from '~/utils/format'
import { irange, pick, unit } from '~/utils/rng'
import { seedCompanies, seedMembers, seedProjects } from './core'

/** シード生成の基準日（実行日の 0:00） */
export function seedToday(): string {
  return todayJst()
}

/** 稼働メンバー（外注・アルバイト以外の実務層） */
const WORKERS = ['m-03', 'm-04', 'm-05', 'm-06', 'm-07', 'm-08', 'm-09']

/** メンバーが参加している案件（日報エントリの割当先） */
function projectsOf(memberId: string): string[] {
  const list = seedProjects.filter(p => p.memberIds.includes(memberId)).map(p => p.id)
  return list.length > 0 ? list : ['pj-08']
}

const REFLECTIONS = [
  '想定どおり進行。明日はレビューを依頼する',
  '調整に時間を要したが方針は固まった',
  '顧客からのフィードバックを反映して前進',
  '細かい手戻りがあったが概ね順調',
]

const ISSUE_TEXTS = [
  '仕様の確認待ちで一部作業が止まっている',
  'テスト環境の不安定さで検証が遅延気味',
  '顧客側の担当者変更で調整コストが増えている',
  'データ連携の仕様齟齬が見つかり要調整',
]

/** 日報（過去 65 日の平日。提出済みのみ = scope=all の API 挙動と同等） */
export function buildDailyReports(days = 65): DailyReport[] {
  const rows: DailyReport[] = []
  const today = seedToday()
  for (let i = days; i >= 1; i--) {
    const date = addDays(today, -i)
    const dow = weekdayOf(date)
    if (dow === 0 || dow === 6) continue
    for (const m of WORKERS) {
      if (unit(`dr:${m}:${date}`) < 0.15) continue // 15% は未提出日
      const pjs = projectsOf(m)
      const n = unit(`drn:${m}:${date}`) < 0.35 && pjs.length > 1 ? 2 : 1
      const entries: ReportEntry[] = []
      let used = 0
      for (let k = 0; k < n; k++) {
        const pj = pjs[irange(`drp:${m}:${date}:${k}`, 0, pjs.length - 1)]!
        const hours = irange(`drh:${m}:${date}:${k}`, 4, 24) * 0.25
        used += hours
        // 進捗は日が進むほど高くなる決定的カーブ（案件別の位相ずらし付き）
        const phase = (days - i) / days
        const progress = Math.min(95, Math.round(20 + phase * 65 + unit(`drg:${m}:${date}:${k}`) * 10))
        entries.push({ theme: '顧客対応', projectId: pj, task: `${pj} の推進タスク`, hours, progress })
      }
      const hasIssue = unit(`dri:${m}:${date}`) < 0.28
      rows.push({
        id: `dr-${m}-${date}`,
        authorKind: 'human',
        memberId: m,
        aiEmployeeId: null,
        date,
        entries,
        reflection: pick(`drr:${m}:${date}`, REFLECTIONS),
        issues: hasIssue ? pick(`drit:${m}:${date}`, ISSUE_TEXTS) : '',
        tomorrow: '継続タスクの推進',
        status: 'submitted',
        submittedAt: `${date}T18:00:00+09:00`,
      })
    }
  }
  return rows
}

/** 直近の月曜（today を含む週の月曜） */
function mondayOf(dateKey: string): string {
  const dow = weekdayOf(dateKey)
  return addDays(dateKey, dow === 0 ? -6 : 1 - dow)
}

/** 週報（過去 8 週・提出済み） */
export function buildWeeklyReports(weeks = 8): WeeklyReport[] {
  const rows: WeeklyReport[] = []
  const thisMonday = mondayOf(seedToday())
  for (let w = weeks; w >= 1; w--) {
    const weekStart = addDays(thisMonday, -7 * w)
    for (const m of WORKERS) {
      if (unit(`wr:${m}:${weekStart}`) < 0.25) continue
      rows.push({
        id: `wr-${m}-${weekStart}`,
        memberId: m,
        weekStart,
        goalReview: '主要タスクを計画どおり消化',
        mainWork: `${projectsOf(m)[0]} を中心に推進`,
        issues: unit(`wri:${m}:${weekStart}`) < 0.3 ? pick(`writ:${m}:${weekStart}`, ISSUE_TEXTS) : '',
        nextWeek: '継続テーマの深掘り',
        status: 'submitted',
      })
    }
  }
  return rows
}

/** 月報（過去 2 ヶ月・提出済み） */
export function buildMonthlyReports(): MonthlyReport[] {
  const rows: MonthlyReport[] = []
  const today = seedToday()
  for (let back = 2; back >= 1; back--) {
    const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - back, 1)
    const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
    for (const m of WORKERS) {
      if (unit(`mr:${m}:${monthStart}`) < 0.3) continue
      rows.push({
        id: `mr-${m}-${monthStart}`,
        memberId: m,
        monthStart,
        goalReview: '月次目標を概ね達成',
        mainWork: `${projectsOf(m)[0]} の推進と定例運営`,
        issues: '',
        nextWeek: '来月の重点テーマ整理',
        status: 'submitted',
      })
    }
  }
  return rows
}

const CUSTOMER_IDS = ['c-01', 'c-02', 'c-03', 'c-04', 'c-05', 'c-06', 'c-07', 'c-08']

const SUPPORT_TITLES = [
  '帳票出力でレイアウトが崩れる',
  '在庫数の表示が実棚と合わない',
  'ユーザー追加の手順を知りたい',
  'CSV 取込でエラーになる',
  '週次レポートの集計条件を変えたい',
  'ログイン後に画面が真っ白になる',
]

/** サポート活動（過去 75 日・c-01/c-02/c-03/c-05 中心） */
export function buildSupportActivities(count = 26): SupportActivity[] {
  const rows: SupportActivity[] = []
  const today = seedToday()
  const targets = ['c-01', 'c-01', 'c-02', 'c-03', 'c-03', 'c-05'] // 重み付き
  for (let i = 0; i < count; i++) {
    const back = irange(`sup:${i}:d`, 1, 75)
    const receivedDate = addDays(today, -back)
    const status = back > 20 ? '解決' : pick(`sup:${i}:st`, SUPPORT_ACTIVITY_STATUSES)
    rows.push({
      id: `sup-${String(i + 1).padStart(4, '0')}`,
      memberId: pick(`sup:${i}:m`, WORKERS),
      villageId: 'vil-02',
      receivedDate,
      receivedTime: `${irange(`sup:${i}:h`, 9, 17)}:00`,
      firstContactMethod: pick(`sup:${i}:fc`, SUPPORT_FIRST_CONTACT_METHODS),
      companyId: pick(`sup:${i}:c`, targets),
      inquirerName: '',
      targetSystem: pick(`sup:${i}:sys`, ['SCM プラットフォーム', '売上分析スイート', 'AI 分析基盤']),
      targetLocation: '',
      category: pick(`sup:${i}:cat`, SUPPORT_ACTIVITY_CATEGORIES),
      title: pick(`sup:${i}:t`, SUPPORT_TITLES),
      body: '詳細は問い合わせ原文を参照（デモデータ）',
      priority: pick(`sup:${i}:p`, SUPPORT_ACTIVITY_PRIORITIES),
      status,
      staffMemberId: pick(`sup:${i}:s`, WORKERS),
      response: status === '解決' ? '回避手順を案内し恒久対応をリリース済み' : '調査中',
      cause: '',
      resolution: status === '解決' ? '設定値の見直しで解消' : '',
      completedDate: status === '解決' ? addDays(receivedDate, irange(`sup:${i}:cd`, 1, 5)) : null,
      completedTime: null,
      knowledgeNote: '',
      links: [],
      createdAt: `${receivedDate}T10:00:00+09:00`,
      active: true,
    })
  }
  return rows
}

const DEAL_TITLES = [
  '生産管理システム刷新',
  '需要予測モジュール追加',
  '保守契約更新',
  'データ分析ダッシュボード構築',
  '業務改善フェーズ2',
  'EC 連携オプション導入',
]

/** 営業活動（過去 90 日。テクノパーツ（c-08）に停滞商談を作る = 分析デモの題材） */
export function buildSalesActivities(count = 14): SalesActivity[] {
  const rows: SalesActivity[] = []
  const today = seedToday()
  for (let i = 0; i < count; i++) {
    const back = irange(`sal:${i}:d`, 3, 90)
    const createdAt = `${addDays(today, -back)}T11:00:00+09:00`
    const companyId = i < 3 ? 'c-08' : pick(`sal:${i}:c`, CUSTOMER_IDS)
    const phase = i === 0 ? '提案' : i === 1 ? '見積' : pick(`sal:${i}:ph`, SALES_ACTIVITY_PHASES)
    const open = phase !== '受注' && phase !== '失注'
    // i=0,1（c-08）は Next Action 期限超過の停滞商談にする
    const nextActionDate = !open
      ? null
      : i <= 1
        ? addDays(today, -irange(`sal:${i}:na`, 5, 15))
        : unit(`sal:${i}:hasna`) < 0.3 ? null : addDays(today, irange(`sal:${i}:na2`, 1, 20))
    rows.push({
      id: `sal-${String(i + 1).padStart(4, '0')}`,
      memberId: pick(`sal:${i}:m`, WORKERS),
      villageId: 'vil-02',
      companyId,
      contactId: null,
      approachGroup: '',
      title: `${pick(`sal:${i}:t`, DEAL_TITLES)}（${companyId}）`,
      dealType: pick(`sal:${i}:dt`, SALES_ACTIVITY_DEAL_TYPES),
      staffMemberId: pick(`sal:${i}:s`, ['m-03', 'm-04', 'm-05']),
      phase,
      amount: irange(`sal:${i}:a`, 200, 4800) * 10_000,
      probability: open ? irange(`sal:${i}:pr`, 2, 9) * 10 : phase === '受注' ? 100 : 0,
      expectedCloseDate: open ? addDays(today, irange(`sal:${i}:ec`, 10, 90)) : null,
      customerIssue: '基幹業務の属人化と数値の見えにくさ',
      proposal: 'データ基盤整備と業務プロセスの標準化を段階導入',
      nextAction: open ? '提案書の改訂と次回定例の設定' : '',
      nextActionDate,
      links: [],
      createdAt,
      active: true,
    })
  }
  return rows
}

/** ビジネスパートナー活動（過去 60 日） */
export function buildPartnerActivities(count = 9): PartnerActivity[] {
  const rows: PartnerActivity[] = []
  const today = seedToday()
  for (let i = 0; i < count; i++) {
    const back = irange(`par:${i}:d`, 2, 60)
    rows.push({
      id: `par-${String(i + 1).padStart(4, '0')}`,
      memberId: pick(`par:${i}:m`, WORKERS),
      villageId: 'vil-02',
      partnerCompanyId: pick(`par:${i}:pc`, ['c-04', 'c-06']),
      partnerContactId: null,
      approachCompanyId: pick(`par:${i}:ac`, CUSTOMER_IDS),
      approachGroup: '',
      partnerName: '',
      theme: pick(`par:${i}:t`, ['共同提案の推進', '顧客紹介の相互連携', 'イベント共催の企画', '技術提携の検討']),
      relatedCompany: '',
      activityType: pick(`par:${i}:at`, PARTNER_ACTIVITY_TYPES),
      status: pick(`par:${i}:st`, PARTNER_ACTIVITY_STATUSES),
      summary: 'パートナー連携のデモデータ',
      currentState: '次回打ち合わせの日程調整中',
      nextAction: '論点整理メモの共有',
      nextActionDate: unit(`par:${i}:na`) < 0.5 ? addDays(today, irange(`par:${i}:nad`, 1, 14)) : null,
      staffMemberId: pick(`par:${i}:s`, WORKERS),
      relatedMeeting: '',
      relatedSalesActivityId: null,
      memo: '',
      links: [],
      createdAt: `${addDays(today, -back)}T14:00:00+09:00`,
      active: true,
    })
  }
  return rows
}

/** 顧客活動ログ（過去 80 日） */
export function buildCustomerLogs(count = 22): CustomerLog[] {
  const rows: CustomerLog[] = []
  const today = seedToday()
  for (let i = 0; i < count; i++) {
    const back = irange(`clg:${i}:d`, 1, 80)
    const logDate = addDays(today, -back)
    // c-07（シーサイドホテルズ）は接点が古い顧客にする = フォローアップ提案のデモ題材
    const companyId = i === 0 ? 'c-07' : pick(`clg:${i}:c`, CUSTOMER_IDS)
    rows.push({
      id: `clg-${String(i + 1).padStart(4, '0')}`,
      memberId: pick(`clg:${i}:m`, WORKERS),
      logDate: companyId === 'c-07' ? addDays(today, -irange(`clg:${i}:old`, 35, 60)) : logDate,
      logTime: null,
      endTime: null,
      companyId,
      contactId: null,
      staffMemberId: pick(`clg:${i}:s`, WORKERS),
      tags: [pick(`clg:${i}:tag`, CUSTOMER_LOG_TAG_PRESETS)],
      method: pick(`clg:${i}:me`, CUSTOMER_LOG_METHOD_PRESETS),
      title: '',
      body: '定例・訪問メモ（デモデータ）',
      createdAt: `${logDate}T16:00:00+09:00`,
      active: true,
    })
  }
  return rows
}

/** 月次売上（過去 24 ヶ月 + 当月。Home の buildSalesMonthly と同一ロジック） */
export function buildSalesMonthly(): SalesMonthly[] {
  const rows: SalesMonthly[] = []
  const today = seedToday()
  const [y0, m0] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const customers = seedCompanies.filter(c => c.kind === 'customer')
  for (let back = 24; back >= 0; back--) {
    const d = new Date(y0, m0 - 1 - back, 1)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    for (const pj of seedProjects.filter(p => p.type !== 'internal')) {
      if (month < pj.startDate.slice(0, 7)) continue
      if (pj.endDate && month > pj.endDate.slice(0, 7)) continue
      const base = pj.budget > 0 ? pj.budget / 14 : 900000
      const seasonal = 1 + 0.18 * Math.sin((d.getMonth() + 1) / 12 * Math.PI * 2)
      const noise = 0.82 + unit(`sales:${pj.id}:${month}`) * 0.36
      const growth = 1 + (24 - back) * 0.006
      const amount = Math.round(base * seasonal * noise * growth / 10000) * 10000
      const costRate = 0.55 + unit(`cost:${pj.id}:${month}`) * 0.15
      const company = customers.find(c => c.id === pj.companyId)
      rows.push({ month, projectType: pj.type, companyId: company?.id ?? pj.companyId, amount, cost: Math.round(amount * costRate) })
    }
  }
  return rows
}

// seedMembers は WORKERS の妥当性の参照元（未使用警告の回避を兼ねた整合チェック）
if (import.meta.dev) {
  for (const w of WORKERS) {
    if (!seedMembers.some(m => m.id === w)) {
      console.warn(`[seed] WORKERS の ${w} が seedMembers に存在しません`)
    }
  }
}
