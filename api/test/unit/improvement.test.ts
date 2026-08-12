import { describe, expect, it } from 'vitest'
import {
  buildCodingPrompt,
  canTransition,
  type ClusterOpenItem,
  type ClusterRequestInput,
  heuristicClusterRequests,
  improvementBodyError,
  IMPROVEMENT_NOTE_CAP,
  improvementNoteError,
  IMPROVEMENT_STATUS_NEXT,
  matchesImprovementFilter,
  normalizeClusterPlan,
} from '../../../shared/domain/improvement'
import { improvementRequestInputOf } from '../../src/routes/improvements'

const reqs: ClusterRequestInput[] = [
  { id: 'r1', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '合計金額を大きく表示してほしい' },
  { id: 'r2', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '税込/税抜の切替がほしい' },
  { id: 'r3', pagePath: '/timecard', pageLabel: 'タイムカード', body: '打刻の取消を可能にしてほしい' },
]

describe('canTransition / IMPROVEMENT_STATUS_NEXT', () => {
  it('triage からは対応する/対応しないへ遷移できる', () => {
    expect(IMPROVEMENT_STATUS_NEXT.triage).toEqual(['accepted', 'rejected'])
    expect(canTransition('triage', 'accepted')).toBe(true)
    expect(canTransition('triage', 'resolved')).toBe(false)
  })
  it('解決済み → 対応する（reopen）が可能（取消可能性 = 原則9.5）', () => {
    expect(canTransition('resolved', 'accepted')).toBe(true)
  })
})

describe('matchesImprovementFilter', () => {
  it('open は未判定・対応するのみ一致（解決済/対応しないは除外）', () => {
    expect(matchesImprovementFilter('triage', 'open')).toBe(true)
    expect(matchesImprovementFilter('accepted', 'open')).toBe(true)
    expect(matchesImprovementFilter('resolved', 'open')).toBe(false)
    expect(matchesImprovementFilter('rejected', 'open')).toBe(false)
  })
  it('all はすべて一致・個別ステータスは一致判定', () => {
    expect(matchesImprovementFilter('rejected', 'all')).toBe(true)
    expect(matchesImprovementFilter('resolved', 'resolved')).toBe(true)
    expect(matchesImprovementFilter('resolved', 'rejected')).toBe(false)
  })
})

describe('improvementBodyError', () => {
  it('空はエラー・通常は null', () => {
    expect(improvementBodyError('   ')).toBeTruthy()
    expect(improvementBodyError('直したい')).toBeNull()
  })
})

describe('heuristicClusterRequests', () => {
  it('ページ単位でまとめ、既存 triage item があれば追記・無ければ新規作成', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'triage', pagePaths: ['/akebono/sales'] }]
    const plan = heuristicClusterRequests(open, reqs)
    // 売上ページ（r1,r2）は既存 triage item へ追記
    expect(plan.appends).toEqual([{ itemId: 'i-sales', requestIds: ['r1', 'r2'] }])
    // タイムカード（r3）は新規作成
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r3'])
    expect(plan.creates[0]!.pagePaths).toEqual(['/timecard'])
  })
  it('判定済み（accepted）item には追記せず新規作成する（ステータス保護 = 原則2）', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'accepted', pagePaths: ['/akebono/sales'] }]
    const plan = heuristicClusterRequests(open, reqs.slice(0, 2))
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r1', 'r2'])
  })
})

describe('normalizeClusterPlan', () => {
  it('無効 id を捨て、未割当要望はヒューリスティックで補完する', () => {
    const open: ClusterOpenItem[] = []
    const raw = {
      creates: [
        { title: 'x', summary: 's', detail: 'd', pagePaths: ['/akebono/sales'], requestIds: ['r1', 'bogus'] },
      ],
    }
    const plan = normalizeClusterPlan(raw, reqs, open)!
    expect(plan).not.toBeNull()
    const assigned = new Set<string>()
    for (const cr of plan.creates) cr.requestIds.forEach(id => assigned.add(id))
    for (const ap of plan.appends) ap.requestIds.forEach(id => assigned.add(id))
    // r1 は create に入り、取りこぼした r2/r3 も補完される。bogus は落ちる
    expect(assigned.has('r1')).toBe(true)
    expect(assigned.has('r2')).toBe(true)
    expect(assigned.has('r3')).toBe(true)
    expect(assigned.has('bogus')).toBe(false)
  })
  it('append 先が triage でない場合はその append を捨てる（保護）', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-acc', status: 'accepted', pagePaths: ['/x'] }]
    const raw = { appends: [{ itemId: 'i-acc', requestIds: ['r1'] }], creates: [] }
    const plan = normalizeClusterPlan(raw, [reqs[0]!], open)!
    expect(plan.appends).toHaveLength(0)
    // r1 は補完で create に回る
    expect(plan.creates.some(cr => cr.requestIds.includes('r1'))).toBe(true)
  })
})

describe('buildCodingPrompt', () => {
  it('対象パス・元要望・受入基準を含む決定的なプロンプトを生成', () => {
    const prompt = buildCodingPrompt([{
      title: '売上ページの表示改善',
      summary: '合計と税表示',
      detail: '合計金額を強調し、税込/税抜トグルを追加する',
      status: 'accepted',
      pagePaths: ['/akebono/sales'],
      requests: [{ pageLabel: 'AKEBONO 売上', pagePath: '/akebono/sales', body: '合計を大きく' }],
    }])
    expect(prompt).toContain('/akebono/sales')
    expect(prompt).toContain('合計を大きく')
    expect(prompt).toContain('受入基準')
    // 決定的（同入力 → 同出力）
    const again = buildCodingPrompt([{
      title: '売上ページの表示改善', summary: '合計と税表示',
      detail: '合計金額を強調し、税込/税抜トグルを追加する', status: 'accepted',
      pagePaths: ['/akebono/sales'],
      requests: [{ pageLabel: 'AKEBONO 売上', pagePath: '/akebono/sales', body: '合計を大きく' }],
    }])
    expect(prompt).toEqual(again)
  })
})

describe('improvementNoteError', () => {
  it('空はエラー・上限超過はエラー・通常は null', () => {
    expect(improvementNoteError('  ')).not.toBeNull()
    expect(improvementNoteError('保留理由: 影響大のため見送り')).toBeNull()
    expect(improvementNoteError('あ'.repeat(IMPROVEMENT_NOTE_CAP))).toBeNull()
    expect(improvementNoteError('あ'.repeat(IMPROVEMENT_NOTE_CAP + 1))).not.toBeNull()
  })
})

describe('buildCodingPrompt（メモの加味）', () => {
  it('時系列メモを含める・reject は「対応しない理由」として明示', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'rejected', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
      notes: [
        { body: '既存 UiKpiCard を流用できそう', kind: 'note' },
        { body: '影響範囲が大きいため次期対応', kind: 'reject' },
      ],
    }])
    expect(prompt).toContain('担当者メモ')
    expect(prompt).toContain('既存 UiKpiCard を流用できそう')
    expect(prompt).toContain('［対応しない理由］ 影響範囲が大きいため次期対応')
  })
  it('メモが無い/空ならメモ節を出さない', () => {
    const noNotes = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(noNotes).not.toContain('担当者メモ')
    const emptyNotes = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
      notes: [{ body: '   ', kind: 'note' }],
    }])
    expect(emptyNotes).not.toContain('担当者メモ')
  })
})

describe('improvementRequestInputOf', () => {
  it('trim + ページ情報を保持・空本文は AKO-REQ-001', () => {
    expect(improvementRequestInputOf({ body: ' 直したい ', pagePath: '/x', pageLabel: 'X' }))
      .toEqual({ body: '直したい', pagePath: '/x', pageLabel: 'X' })
    let code = ''
    try { improvementRequestInputOf({ body: '  ' }) } catch (e) { code = (e as { code?: string }).code ?? '' }
    expect(code).toBe('AKO-REQ-001')
  })
})
