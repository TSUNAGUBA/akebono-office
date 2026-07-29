/**
 * コックピット純関数（app/utils/cockpit.ts）の回帰テスト。
 * cockpit-design §3.1（フェーズ導出・完了メーター）/ §3.2（次の一手の優先順位・ゲート）/
 * §3.3 の 5 ペルソナ相当（ロール × 時刻 × 状態の代表ケース）+ ゼロ状態 + メーター分母 0
 */
import { describe, expect, it } from 'vitest'
import type { Goal } from '~/types/domain'
import {
  buildMeter, buildMoves, latestGoal, obligationBehindPace, phaseOf,
  type CockpitMovesInput, type CockpitObligation,
} from '~/utils/cockpit'

function input(over: Partial<CockpitMovesInput> = {}): CockpitMovesInput {
  return {
    punchRequired: false,
    punchState: 'before',
    hour: 9,
    unclosedDates: [],
    shiftManaged: false,
    hasTodayShift: false,
    canWorkflow: true,
    workflowPending: 0,
    hrOrAdmin: false,
    canAttendance: true,
    fixRequestPending: 0,
    leaveRequestPending: 0,
    reportTarget: false,
    reportSubmittedToday: false,
    shiftStaff: false,
    openWishPeriods: 0,
    submittedWishPeriods: 0,
    nearestWishDeadline: null,
    canInbox: true,
    openEscalations: 0,
    obligation: null,
    ...over,
  }
}

function ids(i: CockpitMovesInput): string[] {
  return buildMoves(i).map(m => m.id)
}

describe('phaseOf（§3.1 フェーズ導出）', () => {
  it('punchRequired=false は状態によらず none（ストリップは挨拶+日付+メーターのみ）', () => {
    expect(phaseOf(false, 'before').key).toBe('none')
    expect(phaseOf(false, 'working').key).toBe('none')
    expect(phaseOf(false, 'done').key).toBe('none')
  })

  it('punchState をフェーズへ写像（業務語ラベル + lucide アイコン）', () => {
    expect(phaseOf(true, 'before')).toMatchObject({ key: 'morning', label: '出勤前', icon: 'Sunrise' })
    expect(phaseOf(true, 'working')).toMatchObject({ key: 'active', label: '勤務中', icon: 'Sun' })
    expect(phaseOf(true, 'breaking')).toMatchObject({ key: 'break', label: '休憩中', icon: 'Coffee' })
    expect(phaseOf(true, 'done')).toMatchObject({ key: 'closed', label: '退勤済み', icon: 'MoonStar' })
  })
})

describe('buildMoves（§3.3 の 5 ペルソナ相当）', () => {
  it('代表・取締役（m-01 相当: punch 対象外 admin）: 稟議承認 + エスカレーションのみ', () => {
    const i = input({
      punchRequired: false, hrOrAdmin: true,
      workflowPending: 2, openEscalations: 1,
    })
    expect(ids(i)).toEqual(['approve-workflow', 'escalations'])
    const wf = buildMoves(i)[0]!
    expect(wf.count).toBe(2)
    expect(wf.to).toBe('/workflow')
    expect(wf.embed).toBeUndefined()
  })

  it('うつわ営業・管理（m-04 相当）: 朝 = 出勤打刻（PunchClock 埋込）→ 昼 = 日報 → 夕 = 退勤 + 日報', () => {
    const base = { punchRequired: true, reportTarget: true }
    const morning = input({ ...base, punchState: 'before', hour: 9 })
    expect(ids(morning)).toEqual(['punch-in'])
    expect(buildMoves(morning)[0]!.embed).toBe('punch')

    const noon = input({ ...base, punchState: 'working', hour: 13 })
    expect(ids(noon)).toEqual(['write-report'])

    const evening = input({ ...base, punchState: 'working', hour: 18 })
    expect(ids(evening)).toEqual(['punch-out', 'write-report'])
    expect(buildMoves(evening)[0]!.embed).toBe('punch')
  })

  it('SI 開発者（m-06 相当）: 退勤済み・日報提出済みなら 0 件（ゼロを祝う）', () => {
    const i = input({
      punchRequired: true, reportTarget: true,
      punchState: 'done', hour: 19, reportSubmittedToday: true,
    })
    expect(ids(i)).toEqual([])
  })

  it('アルバイト（m-11 相当）: 当日シフトあり = 打刻 + シフト希望 / シフトなし = 希望のみ', () => {
    const base = {
      punchRequired: true, shiftManaged: true, shiftStaff: true,
      openWishPeriods: 1, nearestWishDeadline: '2026-08-05',
    }
    const withShift = input({ ...base, hasTodayShift: true })
    expect(ids(withShift)).toEqual(['punch-in', 'shift-wish'])
    const wish = buildMoves(withShift)[1]!
    expect(wish.to).toBe('/shift')
    expect(wish.reason).toContain('8/5')

    // 当日シフトなし = 出勤打刻はキュー入りしない（誤打刻の導線を作らない）
    const noShift = input({ ...base, hasTodayShift: false })
    expect(ids(noShift)).toEqual(['shift-wish'])
  })

  it('人事（m-10 相当: hr × parttime）: 勤怠承認（打刻修正 + 休暇の件数束ね）', () => {
    const i = input({
      punchRequired: true, shiftManaged: true, shiftStaff: true, hasTodayShift: false,
      hrOrAdmin: true, fixRequestPending: 2, leaveRequestPending: 1,
    })
    expect(ids(i)).toEqual(['approve-attendance'])
    const m = buildMoves(i)[0]!
    expect(m.count).toBe(3)
    expect(m.reason).toContain('打刻修正 2')
    expect(m.reason).toContain('休暇 1')
    expect(m.to).toBe('/attendance?tab=requests')
  })
})

describe('buildMoves（優先順位とゲート）', () => {
  it('未退勤の打刻（退勤忘れ）は常に最優先（#1）で /timecard へ', () => {
    const i = input({
      punchRequired: true, punchState: 'before', hour: 9,
      unclosedDates: ['2026-07-28'], workflowPending: 1,
    })
    expect(ids(i)).toEqual(['unclosed-punch', 'punch-in', 'approve-workflow'])
    const m = buildMoves(i)[0]!
    expect(m.to).toBe('/timecard')
    expect(m.reason).toContain('7/28')
  })

  it('§3.2 の優先順（1→9）が決定的に保たれる', () => {
    const i = input({
      punchRequired: true, punchState: 'before', hour: 13,
      unclosedDates: ['2026-07-27', '2026-07-25'],
      canWorkflow: true, workflowPending: 1,
      hrOrAdmin: true, fixRequestPending: 1, leaveRequestPending: 0,
      reportTarget: true,
      shiftStaff: true, openWishPeriods: 1,
      openEscalations: 2,
      obligation: { applicable: true, achieved: false, taken: 1, required: 5, daysLeft: 60, deadline: '2026-09-30' },
    })
    expect(ids(i)).toEqual([
      'unclosed-punch', 'punch-in', 'approve-workflow', 'approve-attendance',
      'write-report', 'shift-wish', 'escalations', 'leave-obligation',
    ])
  })

  it('時刻境界: 日報は 12 時以降・退勤打刻は 17 時以降のみキュー入り', () => {
    const report = (hour: number) =>
      ids(input({ punchRequired: true, punchState: 'working', reportTarget: true, hour }))
    expect(report(11)).toEqual([])
    expect(report(12)).toEqual(['write-report'])
    const out = (hour: number) =>
      ids(input({ punchRequired: true, punchState: 'working', hour }))
    expect(out(16)).toEqual([])
    expect(out(17)).toEqual(['punch-out'])
  })

  it('権限ゲート: canPath 相当のフラグが false なら該当の一手は枠ごと消える', () => {
    expect(ids(input({ workflowPending: 3, canWorkflow: false }))).toEqual([])
    expect(ids(input({ hrOrAdmin: false, fixRequestPending: 2, openEscalations: 1 }))).toEqual([])
    expect(ids(input({ hrOrAdmin: true, openEscalations: 1, canInbox: false }))).toEqual([])
    expect(ids(input({
      hrOrAdmin: true, fixRequestPending: 1, canAttendance: false,
      obligation: { applicable: true, achieved: false, taken: 0, required: 5, daysLeft: 30, deadline: '2026-08-28' },
    }))).toEqual([])
  })

  it('ゼロ状態: 材料なしなら一手も 0 件', () => {
    expect(ids(input())).toEqual([])
  })
})

describe('obligationBehindPace（§3.2 #9 の年5日ペース判定）', () => {
  const ob = (over: Partial<CockpitObligation>): CockpitObligation => ({
    applicable: true, achieved: false, taken: 1, required: 5, daysLeft: 60, deadline: '2026-09-30', ...over,
  })

  it('残必要日数 > 残月数（月 1 日ペース）で true', () => {
    expect(obligationBehindPace(ob({}))).toBe(true) // 残 4 日 > 2 ヶ月
    expect(obligationBehindPace(ob({ daysLeft: 300 }))).toBe(false) // 残 4 日 <= 10 ヶ月
    expect(obligationBehindPace(ob({ daysLeft: -5 }))).toBe(true) // 期限超過
  })

  it('達成済み・対象外・null は常に false', () => {
    expect(obligationBehindPace(ob({ achieved: true }))).toBe(false)
    expect(obligationBehindPace(ob({ applicable: false }))).toBe(false)
    expect(obligationBehindPace(ob({ taken: 5 }))).toBe(false)
    expect(obligationBehindPace(null)).toBe(false)
  })
})

describe('latestGoal（§2.2 重複目標は最新 1 件 = 後勝ち）', () => {
  const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
    id, metric: 'segment_sales', segmentId: 'seg-01', monthlyValue: 100, note: '', active: true, ...over,
  })

  it('createdAt があれば降順で最新を選ぶ（API の id = UUID 順に依存しない）。無ければ配列末尾', () => {
    const newer = goal('g-uuid-b', { monthlyValue: 200, createdAt: '2026-07-29T01:00:00.000Z' })
    const older = goal('g-uuid-a', { monthlyValue: 100, createdAt: '2026-07-01T01:00:00.000Z' })
    // 一覧の並び（id 順）が登録順と逆でも、createdAt が新しい行が選ばれる
    expect(latestGoal([newer, older], 'segment_sales', 'seg-01')?.monthlyValue).toBe(200)
    expect(latestGoal([older, newer], 'segment_sales', 'seg-01')?.monthlyValue).toBe(200)
    // 同時刻は後の行（従来の後勝ちを維持）
    const t = '2026-07-29T01:00:00.000Z'
    expect(latestGoal([goal('g-1', { createdAt: t }), goal('g-2', { createdAt: t })], 'segment_sales', 'seg-01')?.id).toBe('g-2')
    // createdAt なし（モックシード）は従来どおり配列末尾
    expect(latestGoal([goal('g-01'), goal('g-02')], 'segment_sales', 'seg-01')?.id).toBe('g-02')
    // 混在（比較できないペア）は後の行を採用（決定的）
    expect(latestGoal([goal('g-3', { createdAt: t }), goal('g-4')], 'segment_sales', 'seg-01')?.id).toBe('g-4')
    // metric × segmentId の一致行のみが対象。該当なしは undefined
    expect(latestGoal([goal('g-5'), goal('g-6', { metric: 'report_rate', segmentId: null })], 'report_rate', null)?.id).toBe('g-6')
    expect(latestGoal([goal('g-7')], 'report_rate', null)).toBeUndefined()
  })
})

describe('buildMeter（§3.1 完了メーター）', () => {
  it('分母 0 の日は非表示（満タン表示にしない = 分母 0 を祝わない）', () => {
    const m = buildMeter(input())
    expect(m).toEqual({ done: 0, total: 0, ratio: 0, visible: false })
  })

  it('デイリーデューティは完了後も分母に残る（消化が進捗として見える）', () => {
    const base = { punchRequired: true, reportTarget: true }
    // 朝（出勤前）: 出勤のみが対象（退勤は 17 時前・日報は 12 時前）
    expect(buildMeter(input({ ...base, punchState: 'before', hour: 9 })))
      .toMatchObject({ done: 0, total: 1, visible: true })
    // 昼（出勤済み・日報未提出）: 出勤 1/1 + 日報 0/1
    expect(buildMeter(input({ ...base, punchState: 'working', hour: 13 })))
      .toMatchObject({ done: 1, total: 2 })
    // 夜（退勤済み・日報提出済み）: 出勤 + 退勤 + 日報 = 3/3
    const done = buildMeter(input({ ...base, punchState: 'done', hour: 19, reportSubmittedToday: true }))
    expect(done).toMatchObject({ done: 3, total: 3, ratio: 1 })
  })

  it('17 時以降の休憩中は退勤デューティを分母に入れない（一手 0 件 = メーター完了と矛盾させない）', () => {
    const i = input({
      punchRequired: true, reportTarget: true,
      punchState: 'breaking', hour: 18, reportSubmittedToday: true,
    })
    expect(buildMoves(i)).toEqual([]) // 退勤の一手は「勤務中」のみ
    expect(buildMeter(i)).toMatchObject({ done: 2, total: 2, ratio: 1 }) // 出勤 + 日報
  })

  it('キュー型（承認等）は未処理の間だけ分母に入る（件数によらず一手 1 = +1）', () => {
    expect(buildMeter(input({ workflowPending: 5 })))
      .toMatchObject({ done: 0, total: 1, visible: true })
    expect(buildMeter(input({ workflowPending: 0 })))
      .toMatchObject({ total: 0, visible: false })
  })

  it('シフト希望は募集中の全期間へ提出済みで完了になる', () => {
    const staff = { shiftStaff: true, shiftManaged: true }
    expect(buildMeter(input({ ...staff, openWishPeriods: 1 })))
      .toMatchObject({ done: 0, total: 1 })
    expect(buildMeter(input({ ...staff, openWishPeriods: 0, submittedWishPeriods: 1 })))
      .toMatchObject({ done: 1, total: 1, ratio: 1 })
  })
})
