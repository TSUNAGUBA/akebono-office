/**
 * 週次インサイトのヒューリスティック（バッチ7j: shared/domain/weekly-insight）。
 * 「前日（asOf）まで・経過営業日基準」の提出評価と、個別インサイトのロール別最適化を検証する
 */
import { describe, expect, it } from 'vitest'
import {
  heuristicPersonalInsight, heuristicWeeklyInsight,
  type PersonalWeeklyMetrics, type WeeklyMetrics,
} from '../../../shared/domain/weekly-insight'

function metrics(p: Partial<WeeklyMetrics>): WeeklyMetrics {
  return {
    weekStart: '2026-07-13',
    weekEnd: '2026-07-19',
    asOf: '2026-07-16',
    businessDaysElapsed: 4,
    reportSubmitted: 0,
    reporters: 0,
    membersActive: 5,
    totalHours: 0,
    memberHours: [],
    themeHours: [],
    dailySubmissions: [],
    issues: [],
    weeklyCount: 0,
    planDone: 0,
    planTotal: 0,
    workflowSubmitted: 0,
    workflowApproved: 0,
    escalationRaised: 0,
    escalationResolved: 0,
    aiTasksDone: 0,
    aiTasksActive: 0,
    minutesCount: 0,
    poipoiCount: 0,
    salesMonthAmount: null,
    ...p,
  }
}

function personal(p: Partial<PersonalWeeklyMetrics>): PersonalWeeklyMetrics {
  return {
    memberId: 'm-1',
    memberName: '一般 次郎',
    role: 'member',
    title: '',
    department: '',
    reportSubmitted: 4,
    businessDaysElapsed: 4,
    totalHours: 30,
    themeHours: [],
    issues: [],
    planDone: 0,
    planTotal: 0,
    weeklySubmitted: true,
    ...p,
  }
}

describe('heuristicWeeklyInsight（前日まで・経過営業日基準）', () => {
  it('提出率は経過営業日 × メンバー数を分母にする（低カバレッジで弱み + リマインド）', () => {
    const low = heuristicWeeklyInsight(metrics({ reportSubmitted: 5 })) // 5/(5*4)=25%
    expect(low.swot.weaknesses.some(w => w.includes('提出率が低い'))).toBe(true)
    expect(low.actions.some(a => a.includes('リマインド'))).toBe(true)
    const high = heuristicWeeklyInsight(metrics({ reportSubmitted: 18 })) // 90%
    expect(high.swot.strengths.some(s => s.includes('日報提出が定着'))).toBe(true)
  })

  it('経過営業日ゼロ（週初め前）は提出系の弱みを出さず、サマリーで明示する', () => {
    const r = heuristicWeeklyInsight(metrics({ asOf: '2026-07-12', businessDaysElapsed: 0 }))
    expect(r.swot.weaknesses.some(w => w.includes('提出率'))).toBe(false)
    expect(r.executiveSummary).toContain('集計対象の営業日がありません')
  })

  it('サマリーに集計基準日（前日まで）を明示する', () => {
    const r = heuristicWeeklyInsight(metrics({ reportSubmitted: 18 }))
    expect(r.executiveSummary).toContain('2026-07-16')
    expect(r.executiveSummary).toContain('前日')
  })
})

describe('heuristicPersonalInsight（ロール・役職・所属で最適化）', () => {
  const company = metrics({ workflowSubmitted: 5, workflowApproved: 2, issues: [
    { member: 'A', issue: 'x' }, { member: 'B', issue: 'y' },
  ] })

  it('管理者には承認滞留・チーム課題への対応アクションが出る', () => {
    const r = heuristicPersonalInsight(personal({ role: 'admin' }), company)
    expect(r.actions.some(a => a.includes('稟議'))).toBe(true)
    expect(r.actions.some(a => a.includes('課題報告'))).toBe(true)
  })

  it('一般メンバーには自身の未提出・週報のアクションが出る（前日まで基準）', () => {
    const r = heuristicPersonalInsight(personal({ reportSubmitted: 2, weeklySubmitted: false }), company)
    expect(r.focus.some(f => f.includes('4 日に対し 2 件'))).toBe(true)
    expect(r.actions.some(a => a.includes('週報'))).toBe(true)
    // 管理者向けアクション（稟議）は一般メンバーには出ない
    expect(r.actions.some(a => a.includes('稟議'))).toBe(false)
  })

  it('サマリーに所属・役職が反映され、遅れがなければ現状維持の文言になる', () => {
    const r = heuristicPersonalInsight(
      personal({ department: '開発部', title: '主任' }),
      metrics({}),
    )
    expect(r.summary).toContain('開発部')
    expect(r.summary).toContain('主任')
    expect(r.focus.length).toBeGreaterThan(0)
  })
})
