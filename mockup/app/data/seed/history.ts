/**
 * 履歴系シードデータ（決定的生成）
 * 「今日」を基準に過去分を生成するが、内容は rng（キー付きハッシュ）で決定的。
 * リロードしても同じ日なら同じ世界が再現される。
 */
import type { CalendarEvent, LeaveGrant, PunchRecord, SalesMonthly, TaskPlan, UptimeDaily } from '~/types/domain'
import { addDays, hhmmToMin, toDateKey, weekdayOf } from '~/utils/format'
import { leaveGrantDays } from '~/utils/attendance-calc'
import { irange, pick, unit } from '~/utils/rng'
import { seedAttendanceRules, seedCompanies, seedMembers, seedProjects, seedSystemServices } from './core'

/** シード生成の基準日（実行日の 0:00） */
export function seedToday(): string {
  return todayJst()
}

/** 過去 N 日分の打刻履歴（今日は含めない = 今日はユーザーが操作する） */
export function buildPunchHistory(days = 45): PunchRecord[] {
  const rows: PunchRecord[] = []
  const today = seedToday()
  const targets = seedMembers.filter(m => m.punchRequired && m.active)
  for (let i = days; i >= 1; i--) {
    const date = addDays(today, -i)
    const dow = weekdayOf(date)
    for (const m of targets) {
      const isParttime = m.employmentType === 'parttime'
      // 土日は原則休み。アルバイトは週所定日数に応じて出勤日を間引く
      if (dow === 0 || dow === 6) continue
      if (isParttime && unit(`${m.id}:${date}:attend`) > m.weeklyDays / 5) continue
      if (!isParttime && unit(`${m.id}:${date}:absent`) < 0.03) continue // まれな休暇

      // 個別割当ルール（時短等）があるメンバーは、そのルールの所定時間で生成する
      const assignedRule = m.attendanceRuleId
        ? seedAttendanceRules.find(r => r.id === m.attendanceRuleId)
        : undefined
      const startHour = isParttime
        ? 10
        : assignedRule
          ? Math.floor(hhmmToMin(assignedRule.workStart) / 60)
          : 9 + (unit(`${m.id}:${date}:st`) > 0.6 ? 1 : 0)
      const startMin = assignedRule
        ? hhmmToMin(assignedRule.workStart) % 60
        : irange(`${m.id}:${date}:sm`, 0, 25)
      // 忙しいメンバー（開発部）はやや残業が多い分布にする。時短者の残業は控えめに
      const busy = m.departmentId === 'dp-04' ? 1.5 : 1 // システム開発部はやや残業多め
      const otMin = isParttime
        ? 0
        : assignedRule
          ? irange(`${m.id}:${date}:ot`, 0, 30)
          : Math.floor(irange(`${m.id}:${date}:ot`, 0, 90) * busy)
      const workHours = isParttime
        ? irange(`${m.id}:${date}:wh`, 4, 6)
        : assignedRule
          ? (hhmmToMin(assignedRule.workEnd) - hhmmToMin(assignedRule.workStart) - assignedRule.breakMinutes) / 60
          : 8
      const breakMin = isParttime ? (workHours > 6 ? 60 : 0) : (assignedRule ? assignedRule.breakMinutes : 60)

      const mk = (h: number, mi: number): string => {
        const hh = String(Math.floor(h + mi / 60)).padStart(2, '0')
        const mm = String(mi % 60).padStart(2, '0')
        return `${date}T${hh}:${mm}:00+09:00`
      }
      const startTotalMin = startHour * 60 + startMin
      const endTotalMin = startTotalMin + workHours * 60 + breakMin + otMin

      rows.push({ id: `pch-${m.id}-${date}-in`, memberId: m.id, date, kind: 'in', at: mk(0, startTotalMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
      if (breakMin > 0) {
        rows.push({ id: `pch-${m.id}-${date}-bs`, memberId: m.id, date, kind: 'break_start', at: mk(0, startTotalMin + 3.5 * 60), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
        rows.push({ id: `pch-${m.id}-${date}-be`, memberId: m.id, date, kind: 'break_end', at: mk(0, startTotalMin + 3.5 * 60 + breakMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
      }
      rows.push({ id: `pch-${m.id}-${date}-out`, memberId: m.id, date, kind: 'out', at: mk(0, endTotalMin), source: 'web', fixedFrom: null, fixReason: null, approvedBy: null })
    }
  }
  return rows
}

/** 有給付与（労基法 39 条テーブルに基づく直近付与分） */
export function buildLeaveGrants(): LeaveGrant[] {
  const rows: LeaveGrant[] = []
  const today = seedToday()
  for (const m of seedMembers.filter(x => x.active && x.employmentType !== 'outsource')) {
    const hire = new Date(`${m.hireDate}T00:00:00`)
    const now = new Date(`${today}T00:00:00`)
    const serviceYears = (now.getTime() - hire.getTime()) / (365.25 * 24 * 3600 * 1000)
    // 直近 2 回分の付与を生成（時効 2 年以内のもの）
    for (let back = 0; back < 2; back++) {
      const grantAtYears = Math.floor((serviceYears - 0.5) * 1) - back
      if (grantAtYears < 0) continue
      const grantServiceYears = grantAtYears + 0.5
      const days = leaveGrantDays(m.weeklyDays, m.weeklyHours, grantServiceYears)
      if (days <= 0) continue
      const grantDate = new Date(hire)
      grantDate.setMonth(grantDate.getMonth() + 6 + grantAtYears * 12)
      const expire = new Date(grantDate)
      expire.setFullYear(expire.getFullYear() + 2)
      rows.push({
        id: `lg-${m.id}-${grantAtYears}`,
        memberId: m.id,
        leaveTypeId: 'lt-paid',
        grantDate: toDateKey(grantDate),
        days,
        kind: m.weeklyHours >= 30 || m.weeklyDays >= 5 ? 'normal' : 'proportional',
        expireDate: toDateKey(expire),
        grantedBy: null, // 周期自動付与
      })
    }
  }
  return rows
}

/**
 * 特別休暇の付与（F-04-9 の一括付与・個別付与デモ）。
 * 実行日基準の相対日付で生成する（シードは日次で再生成されるため、固定日付だと季節によって
 * 申請シードとの整合が崩れる）。
 * - 夏季休暇: 人事（m-10）が対象者（在籍・外注以外）へ 20 日前に一括付与（3 日・3 ヶ月期限）
 * - 結婚特休: 人事が m-06 へ 5 日前に個別付与（5 日・6 ヶ月期限）
 */
export function buildSpecialLeaveGrants(): LeaveGrant[] {
  const today = seedToday()
  const rows: LeaveGrant[] = []
  const summerDate = addDays(today, -20)
  const addMonths = (dateKey: string, months: number): string => {
    const d = new Date(`${dateKey}T00:00:00`)
    d.setMonth(d.getMonth() + months)
    return toDateKey(d)
  }
  for (const m of seedMembers.filter(x => x.active && x.employmentType !== 'outsource')) {
    rows.push({
      id: `lg-summer-${m.id}`,
      memberId: m.id,
      leaveTypeId: 'lt-summer',
      grantDate: summerDate,
      days: 3,
      kind: 'special',
      expireDate: addMonths(summerDate, 3),
      grantedBy: 'm-10',
    })
  }
  const weddingDate = addDays(today, -5)
  rows.push({
    id: 'lg-wedding-m-06',
    memberId: 'm-06',
    leaveTypeId: 'lt-wedding',
    grantDate: weddingDate,
    days: 5,
    kind: 'special',
    expireDate: addMonths(weddingDate, 6),
    grantedBy: 'm-10',
  })
  return rows
}

/** 月次売上（過去 24 ヶ月 + 当月。決定的モック） */
export function buildSalesMonthly(): SalesMonthly[] {
  const rows: SalesMonthly[] = []
  const today = seedToday()
  const [y0, m0] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const customers = seedCompanies.filter(c => c.kind === 'customer')
  for (let back = 24; back >= 0; back--) {
    const d = new Date(y0, m0 - 1 - back, 1)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    for (const pj of seedProjects.filter(p => p.type !== 'internal')) {
      // プロジェクト期間外の月はスキップ
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


/**
 * Google カレンダー予定（モック・決定的生成）= 「Google 側の真実」役。
 * 一昨日〜明後日（offset -2..+2）の平日に、メンバーの参加プロジェクトから定例・作業ブロックを生成する。
 * id は決定的（gcal-{member}-{date}-{n}）で、再同期時のべき等 upsert キーになる。
 * 注意: ここでは連携状態でフィルタしない（未連携メンバーが後から連携→同期しても取得できる必要がある）。
 * キャッシュへの初期投入時のフィルタはシード統合側（seed/index.ts）で行う。
 */
export function buildCalendarEvents(): CalendarEvent[] {
  const rows: CalendarEvent[] = []
  const today = seedToday()
  const targets = seedMembers.filter(m => m.active && m.employmentType !== 'outsource' && m.employmentType !== 'parttime')
  for (let offset = -2; offset <= 2; offset++) {
    const date = addDays(today, offset)
    const dow = weekdayOf(date)
    if (dow === 0 || dow === 6) continue
    for (const m of targets) {
      const myProjects = seedProjects.filter(p => p.active && p.status === 'active' && p.memberIds.includes(m.id))
      let n = 0
      const push = (from: string, to: string, title: string, projectId: string | null): void => {
        rows.push({
          id: `gcal-${m.id}-${date}-${n++}`,
          memberId: m.id, date, from, to, title,
          source: 'google', syncedToGoogle: true, projectId,
        })
      }
      // 定例（プロジェクト起点。日によって 1 件目 or 2 件目を選ぶ）
      const pj = myProjects[irange(`cal:${m.id}:${date}:pj`, 0, Math.max(0, myProjects.length - 1))]
      if (pj && unit(`cal:${m.id}:${date}:mtg`) > 0.25) {
        const company = seedCompanies.find(c => c.id === pj.companyId)
        push('10:00', '11:00', `${company?.name ?? '社内'} 定例`, pj.id)
      }
      // 作業ブロック（タイトルにプロジェクト名を含める = AI のタイトル推定デモ用に projectId は持たせない）
      if (pj) {
        push('13:00', unit(`cal:${m.id}:${date}:long`) > 0.5 ? '16:00' : '15:00', `${pj.name.slice(0, 12)} 作業`, null)
      }
      // 社内予定
      if (unit(`cal:${m.id}:${date}:internal`) > 0.6) {
        push('17:00', '17:30', '社内共有会', null)
      }
    }
  }
  return rows
}

/**
 * タスク計画（AI業務アシスタント F-14 のデモ）。
 * 昨日（直近の過去平日）分は結果記録済み（done）、今日分は計画済み（planned）で生成し、
 * 「前日に計画 → 当日に振り返り → 日報へ反映」の一連の流れを最初から体感できるようにする。
 */
export function buildTaskPlans(): TaskPlan[] {
  const today = seedToday()
  let yesterday = addDays(today, -1)
  while (weekdayOf(yesterday) === 0 || weekdayOf(yesterday) === 6) yesterday = addDays(yesterday, -1)
  const at = (date: string, hhmm: string): string => `${date}T${hhmm}:00+09:00`
  const plan = (
    n: number, memberId: string, date: string, title: string, purpose: string,
    doneCriteria: string, approach: string, aiComment: string,
    result?: { outcome: string; reflection: string },
  ): TaskPlan => ({
    id: `tp-seed-${memberId}-${n}`,
    memberId, date, calendarEventId: null,
    title, purpose, doneCriteria, approach,
    aiComment, aiCommentAt: aiComment ? at(addDays(date, -1), '18:10') : null,
    status: result ? 'done' : 'planned',
    outcome: result?.outcome ?? '',
    reflection: result?.reflection ?? '',
    resultAt: result ? at(date, '18:40') : null,
    createdAt: at(addDays(date, -1), '18:00'),
    updatedAt: result ? at(date, '18:40') : at(addDays(date, -1), '18:15'),
  })
  return [
    plan(1, 'm-03', yesterday,
      'アケボノ商事 定例の論点整理', '在庫精度の改善方針を合意する',
      '改善案 2 案の比較表を提示し、次回までの検証項目が決まっている',
      '①現状データの確認 ②2 案の比較表作成 ③定例で提示・議論',
      '達成条件が測定可能で良い計画です。比較表の評価軸（コスト・期間・精度改善幅）を事前に先方と揃えておくと、当日の合意形成が速くなります。',
      { outcome: '比較表を提示し A 案ベースで合意。検証項目 3 件を次回までに実施することが決定', reflection: '評価軸を事前共有していたため議論がスムーズだった' }),
    plan(2, 'm-03', yesterday,
      '北都物流 KPI 体系のドラフト作成', '庫内オペレーション KPI の初版を作る',
      'KPI ツリーのドラフトが完成しレビュー依頼を出せている',
      '①既存レポートの棚卸し ②KPI ツリー案作成 ③三浦さんへレビュー依頼',
      '段取りが明確です。②では「計測できない KPI を入れない」を制約に置くと手戻りが減ります。',
      { outcome: 'KPI ツリー初版を作成しレビュー依頼済み', reflection: '計測可否の観点を先に入れたことで案が絞れた' }),
    plan(3, 'm-03', today,
      'みなみ食品 受発注フロー現状整理', '標準化対象の業務範囲を確定する',
      '現状フロー図が完成し、標準化対象・対象外の線引きが文書化されている',
      '①ヒアリングメモの整理 ②現状フロー図作成 ③対象範囲の線引き案作成',
      '目的と達成条件の対応が明確です。③の線引きは「例外頻度」を判断基準に入れると説得力が上がります。'),
    plan(4, 'm-03', today,
      'シーサイドホテルズ DX 構想の骨子検討', '提案骨子の方向性を固める',
      '骨子 3 章立てのアウトラインができている',
      '①経営課題の整理 ②類似事例の収集 ③アウトライン作成',
      ''),
    plan(5, 'm-05', yesterday,
      'トクタケ 分析基盤のデータマート設計', 'マート層のテーブル設計を確定する',
      'テーブル定義書がレビュー可能な状態になっている',
      '①要件の再確認 ②テーブル定義書作成 ③セルフレビュー',
      '達成条件が具体的で良いです。冪等キーの設計を定義書に含めると運用時の障害が減ります。',
      { outcome: 'テーブル定義書を作成。冪等キー設計も盛り込みレビュー依頼済み', reflection: 'AI コメントの指摘が有効だった' }),
    plan(6, 'm-05', today,
      'SCM プラットフォーム 性能試験の準備', '負荷試験のシナリオを確定する',
      '試験シナリオ 3 本と合格基準が文書化されている',
      '①ピーク時間帯のアクセスパターン分析 ②シナリオ作成 ③合格基準の設定',
      ''),
  ]
}

/** サービス別の日次稼働状況（過去 90 日。決定的モック） */
export function buildUptimeDaily(): UptimeDaily[] {
  const rows: UptimeDaily[] = []
  const today = seedToday()
  for (const svc of seedSystemServices) {
    for (let i = 90; i >= 1; i--) {
      const date = addDays(today, -i)
      const r = unit(`up:${svc.id}:${date}`)
      let worstState: UptimeDaily['worstState'] = 'operational'
      let downMinutes = 0
      if (r > 0.985) {
        worstState = pick(`upkind:${svc.id}:${date}`, ['partial_outage', 'major_outage'] as const)
        downMinutes = irange(`updown:${svc.id}:${date}`, 30, 240)
      } else if (r > 0.955) {
        worstState = 'degraded'
        downMinutes = irange(`updeg:${svc.id}:${date}`, 5, 45)
      } else if (weekdayOf(date) === 0 && r > 0.87) {
        worstState = 'maintenance'
        downMinutes = 0
      }
      rows.push({ serviceId: svc.id, date, downMinutes, worstState })
    }
  }
  return rows
}
