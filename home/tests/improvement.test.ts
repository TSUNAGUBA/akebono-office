/**
 * 改善要望（F-42）の権限ゲートと集約・ステータス・プロンプトの純ロジック。
 * canManageImprovements = deny-by-default（管理者は常時可・明示 allow で付与）。
 * ステータス管理の再編（改修依頼 2026-08-21）:
 * - 受付箱 = 未確認 → 検討中 → 改善対応/運用対応/継続検討/対応見送り（+ 案件連動の対応済み・解決の記録）
 * - 改修案件 = 未対応 → 対応中 → 対応済（旧 7 値語彙は読替え = 原則7）
 */
import { describe, expect, it } from 'vitest'
import { canManageImprovements, type PermissionSubject } from '../../shared/domain/permissions'
import type { PermissionRule } from '../../shared/domain/types'
import {
  buildCodingPrompt, buildUnclusterNoteBody, canInboxTransition, canTransition, clusterTargetRequests,
  heuristicClusterRequests,
  IMPROVEMENT_ASSESS_META,
  IMPROVEMENT_FILTER_OPTIONS,
  IMPROVEMENT_INBOX_FILTER_OPTIONS,
  IMPROVEMENT_INBOX_STATUS_META,
  IMPROVEMENT_INBOX_STATUSES,
  IMPROVEMENT_ITEM_STATUS_META,
  IMPROVEMENT_ITEM_VIEWS,
  IMPROVEMENT_REQUEST_TAG_META,
  improvementCommentError, improvementImagesError, improvementInboxStatusError,
  improvementInboxStatusOf,
  improvementItemViewOf,
  improvementLinksError,
  improvementResolveError,
  inboxStatusFromItem,
  isClusterAppendTarget,
  isOpenItemStatus,
  matchesImprovementFilter, matchesInboxFilter, normalizeImprovementLinks, normalizeImprovementTags,
  planInboxStatusBulk, PROMPT_NAVIGATOR_PREAMBLE, promptRequestTag, requestAdoptionOf,
  improvementEditChangedLabel,
  improvementEditError,
  improvementRequestEditFields,
  improvementRevisitError,
  improvementUnclusterError,
  OPERATIONAL_NOTE_MAX,
  operationalNoteBody,
  operationalNoteCapError,
} from '../../shared/domain/improvement'
import { fmtDateTimeSec } from '~/utils/format'

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r', subjectKind: p.subjectKind ?? 'role', subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'improvements', field: p.field ?? null, effect: p.effect ?? 'allow',
    active: p.active ?? true,
  }
}
const admin: PermissionSubject = { memberId: 'm-admin', title: '', role: 'admin' }
const member: PermissionSubject = { memberId: 'm-1', title: '主任', role: 'member' }

describe('canManageImprovements（deny-by-default）', () => {
  it('管理者は常時可（ルール無しでも）', () => {
    expect(canManageImprovements([], admin)).toBe(true)
  })
  it('一般は既定で不可（ルール無し = deny）', () => {
    expect(canManageImprovements([], member)).toBe(false)
  })
  it('個人 allow を付与すると閲覧可（明示許可）', () => {
    const rules = [rule({ subjectKind: 'member', subjectId: 'm-1', resource: 'improvements', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(true)
  })
  it('役職 allow でも付与できる', () => {
    const rules = [rule({ subjectKind: 'title', subjectId: '主任', resource: 'improvements', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(true)
  })
  it('無関係リソースの allow では付与されない', () => {
    const rules = [rule({ subjectKind: 'member', subjectId: 'm-1', resource: 'sales', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(false)
  })
})

describe('改修案件の 3 状態（未対応/対応中/対応済 = 改修依頼 2026-08-21）', () => {
  it('カンバン列（IMPROVEMENT_ITEM_VIEWS）は 3 ステータス・ラベルが新語彙', () => {
    expect(IMPROVEMENT_ITEM_VIEWS).toEqual(['todo', 'in_progress', 'done'])
    expect(IMPROVEMENT_ITEM_STATUS_META.todo.label).toBe('未対応')
    expect(IMPROVEMENT_ITEM_STATUS_META.in_progress.label).toBe('対応中')
    expect(IMPROVEMENT_ITEM_STATUS_META.done.label).toBe('対応済')
  })
  it('旧語彙の保存値は 3 状態へ正規化される（保存値不変の読替え = 原則7）', () => {
    expect(improvementItemViewOf('triage')).toBe('todo')
    expect(improvementItemViewOf('accepted')).toBe('todo')
    expect(improvementItemViewOf('deferred')).toBe('todo')
    expect(improvementItemViewOf('in_progress')).toBe('in_progress')
    expect(improvementItemViewOf('resolved')).toBe('done')
    expect(improvementItemViewOf('operational')).toBe('done')
    expect(improvementItemViewOf('rejected')).toBe('done')
    expect(improvementItemViewOf('todo')).toBe('todo')
    expect(improvementItemViewOf('done')).toBe('done')
  })
  it('遷移: 未対応 → 対応中 → 対応済 が主経路。対応済 → 対応中の reopen・対応中 → 未対応の差し戻し可（原則9.5）', () => {
    expect(canTransition('todo', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'done')).toBe(true)
    expect(canTransition('todo', 'done')).toBe(true) // 着手記録を経ない直行も許可（原則7）
    expect(canTransition('done', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'todo')).toBe(true)
    expect(canTransition('done', 'todo')).toBe(false)
  })
  it('旧語彙の保存値も正規化して遷移判定できる（triage の item を対応中にできる）', () => {
    expect(canTransition('triage', 'in_progress')).toBe(true)
    expect(canTransition('accepted', 'done')).toBe(true)
    expect(canTransition('resolved', 'in_progress')).toBe(true) // 旧・解決済み = 対応済 → reopen
  })
  it('フィルタ: open = 未完了（未対応 + 対応中）。旧語彙にも効く', () => {
    expect(matchesImprovementFilter('todo', 'open')).toBe(true)
    expect(matchesImprovementFilter('in_progress', 'open')).toBe(true)
    expect(matchesImprovementFilter('done', 'open')).toBe(false)
    expect(matchesImprovementFilter('triage', 'open')).toBe(true) // 旧 triage = 未対応
    expect(matchesImprovementFilter('resolved', 'done')).toBe(true) // 旧 resolved = 対応済
    expect(IMPROVEMENT_FILTER_OPTIONS.map(o => o.value)).toEqual(['all', 'open', 'todo', 'in_progress', 'done'])
  })
  it('isOpenItemStatus = 対応済（旧決着語彙含む）以外が未決着', () => {
    expect(isOpenItemStatus('todo')).toBe(true)
    expect(isOpenItemStatus('in_progress')).toBe(true)
    expect(isOpenItemStatus('done')).toBe(false)
    expect(isOpenItemStatus('operational')).toBe(false)
    expect(isOpenItemStatus('rejected')).toBe(false)
  })
})

describe('受付箱ステータス（unconfirmed → reviewing → 各対応方針 = 改修依頼 2026-08-21）', () => {
  it('表示ステータスは 8 種・ラベルは要件の語彙', () => {
    expect(IMPROVEMENT_INBOX_STATUSES).toEqual([
      'unconfirmed', 'reviewing', 'planned', 'operational', 'deferred', 'dismissed', 'addressed', 'resolved',
    ])
    expect(IMPROVEMENT_INBOX_STATUS_META.unconfirmed.label).toBe('未確認')
    expect(IMPROVEMENT_INBOX_STATUS_META.reviewing.label).toBe('検討中')
    expect(IMPROVEMENT_INBOX_STATUS_META.planned.label).toBe('改善対応')
    expect(IMPROVEMENT_INBOX_STATUS_META.operational.label).toBe('運用対応')
    expect(IMPROVEMENT_INBOX_STATUS_META.deferred.label).toBe('継続検討')
    expect(IMPROVEMENT_INBOX_STATUS_META.dismissed.label).toBe('対応見送り')
    expect(IMPROVEMENT_INBOX_STATUS_META.addressed.label).toBe('対応済み')
    expect(IMPROVEMENT_INBOX_STATUS_META.resolved.label).toBe('解決済み')
    expect(IMPROVEMENT_INBOX_FILTER_OPTIONS[0]).toEqual({ value: 'all', label: 'すべて' })
  })
  it('遷移機械: 未確認 → 検討中 → 各対応方針。各決着 → 検討中の見直し可（原則9.5）', () => {
    expect(canInboxTransition('unconfirmed', 'reviewing')).toBe(true)
    expect(canInboxTransition('unconfirmed', 'planned')).toBe(false) // 検討を経る
    expect(canInboxTransition('reviewing', 'planned')).toBe(true)
    expect(canInboxTransition('reviewing', 'operational')).toBe(true)
    expect(canInboxTransition('reviewing', 'deferred')).toBe(true)
    expect(canInboxTransition('reviewing', 'dismissed')).toBe(true)
    expect(canInboxTransition('reviewing', 'unconfirmed')).toBe(true) // 差し戻し
    expect(canInboxTransition('planned', 'reviewing')).toBe(true)
    expect(canInboxTransition('operational', 'reviewing')).toBe(true)
    expect(canInboxTransition('dismissed', 'reviewing')).toBe(true)
    expect(canInboxTransition('deferred', 'planned')).toBe(true) // 再検討の結論
    expect(canInboxTransition('deferred', 'deferred')).toBe(true) // 再検討日の変更（リスケジュール）
    expect(canInboxTransition('planned', 'operational')).toBe(false) // 検討中を経る
  })
  it('improvementInboxStatusOf: 新語彙の保存値はそのまま・初期は未確認', () => {
    expect(improvementInboxStatusOf({ status: 'unconfirmed', itemId: null })).toBe('unconfirmed')
    expect(improvementInboxStatusOf({ status: 'reviewing', itemId: null })).toBe('reviewing')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: null })).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'deferred', itemId: null })).toBe('deferred')
  })
  it('improvementInboxStatusOf: 旧データは選別状態から読替え（原則7）', () => {
    // 旧 open + 未選別 = 未確認 / 採用 = 改善対応 / 不採用 = 対応見送り
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'pending', itemId: null })).toBe('unconfirmed')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'adopted', itemId: null })).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'declined', itemId: null })).toBe('dismissed')
    // status 未定義（さらに旧いデータ）も同じ読替え
    expect(improvementInboxStatusOf({ itemId: null })).toBe('unconfirmed')
    // 旧・進捗タグ resolved/dismissed は 解決済み/対応見送り
    expect(improvementInboxStatusOf({ status: 'resolved', itemId: null })).toBe('resolved')
    expect(improvementInboxStatusOf({ status: 'dismissed', itemId: null })).toBe('dismissed')
  })
  it('improvementInboxStatusOf: 集約済みは item 連動（改善対応 → 案件対応済で対応済み）', () => {
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' }, 'todo')).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' }, 'in_progress')).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' }, 'done')).toBe('addressed')
    // 旧語彙の item にも連動（resolved = 対応済み / rejected = 対応見送り / operational = 運用対応）
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'adopted', itemId: 'imp-1' }, 'resolved')).toBe('addressed')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'adopted', itemId: 'imp-1' }, 'rejected')).toBe('dismissed')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'adopted', itemId: 'imp-1' }, 'operational')).toBe('operational')
    // item 不明（linkedItemStatus 無し）は改善対応（案件進行中）
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' })).toBe('planned')
    // API 応答の linkedItemStatus（行内埋め込み）でも解決できる
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1', linkedItemStatus: 'done' })).toBe('addressed')
  })
  it('improvementInboxStatusOf: 解決の記録（resolvedAt）は連動より優先（最終状態）', () => {
    expect(improvementInboxStatusOf({ status: 'operational', itemId: null, resolvedAt: '2026-08-21T10:00:00+09:00' })).toBe('resolved')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1', resolvedAt: '2026-08-21T10:00:00+09:00' }, 'done')).toBe('resolved')
  })
  it('inboxStatusFromItem の写像（連動の SoT）', () => {
    expect(inboxStatusFromItem('done')).toBe('addressed')
    expect(inboxStatusFromItem('resolved')).toBe('addressed')
    expect(inboxStatusFromItem('todo')).toBe('planned')
    expect(inboxStatusFromItem('in_progress')).toBe('planned')
    expect(inboxStatusFromItem('operational')).toBe('operational')
    expect(inboxStatusFromItem('deferred')).toBe('deferred')
    expect(inboxStatusFromItem('rejected')).toBe('dismissed')
  })
  it('matchesInboxFilter: all は全通過・個別は一致のみ', () => {
    expect(matchesInboxFilter('unconfirmed', 'all')).toBe(true)
    expect(matchesInboxFilter('planned', 'planned')).toBe(true)
    expect(matchesInboxFilter('planned', 'reviewing')).toBe(false)
  })
})

describe('improvementInboxStatusError / planInboxStatusBulk（受付箱ステータスの共有ガードと一括仕分け）', () => {
  const rows = [
    { id: 'a', status: 'unconfirmed' as const, itemId: null, archivedAt: null },
    { id: 'b', status: 'reviewing' as const, itemId: null, archivedAt: null },
    { id: 'c', status: 'planned' as const, itemId: 'imp-1', archivedAt: null }, // 集約済み = 対象外
    { id: 'd', status: 'unconfirmed' as const, itemId: null, archivedAt: '2026-08-21T00:00:00+09:00' }, // 取消済み
    { id: 'e', status: 'operational' as const, itemId: null, archivedAt: null, resolvedAt: '2026-08-21T00:00:00+09:00' }, // 解決済み
  ]
  it('判定順 = 存在 → 取消済み → 集約済み → 解決済み → 遷移検証', () => {
    expect(improvementInboxStatusError(undefined, 'reviewing')?.code).toBe('AKO-REQ-002')
    expect(improvementInboxStatusError(rows[3], 'reviewing')?.code).toBe('AKO-REQ-019')
    expect(improvementInboxStatusError(rows[2], 'reviewing')?.code).toBe('AKO-REQ-013')
    expect(improvementInboxStatusError(rows[4], 'reviewing')?.code).toBe('AKO-REQ-025')
    expect(improvementInboxStatusError(rows[0], 'planned')?.code).toBe('AKO-REQ-006') // 未確認 → 改善対応は不可
    expect(improvementInboxStatusError(rows[0], 'reviewing')).toBeNull()
    expect(improvementInboxStatusError(rows[1], 'planned')).toBeNull()
  })
  it('同一ステータスへの再送はガードを通す（no-op = 冪等・原則2）', () => {
    expect(improvementInboxStatusError(rows[0], 'unconfirmed')).toBeNull()
  })
  it('一括仕分け: 重複除去し、適用できる id のみ（部分成功 = 原則4）', () => {
    const plan = planInboxStatusBulk(['a', 'a', 'b'], rows, 'reviewing')
    expect(plan.targets).toEqual(['a', 'b'])
    expect(plan.applicable).toEqual(['a', 'b'])
    expect(plan.lastError).toBeNull()
  })
  it('一括仕分け: 集約済み・取消済み・解決済み・機械外遷移はスキップし最後の理由を返す', () => {
    const plan = planInboxStatusBulk(['a', 'c', 'd', 'e'], rows, 'planned')
    expect(plan.applicable).toEqual([]) // a は 未確認 → 改善対応が機械外
    expect(plan.lastError).not.toBeNull()
    const plan2 = planInboxStatusBulk(['b', 'nope'], rows, 'planned')
    expect(plan2.applicable).toEqual(['b'])
    expect(plan2.lastError?.code).toBe('AKO-REQ-002')
  })
})

describe('improvementResolveError（解決の記録の可否 = 運用対応/対応済みのみ）', () => {
  it('運用対応・対応済み（item 連動）は解決できる', () => {
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: null })).toBeNull()
    expect(improvementResolveError({ status: 'planned', itemId: 'imp-1', archivedAt: null }, 'done')).toBeNull()
  })
  it('未確認・検討中・改善対応（未完了）は解決できない（AKO-REQ-026）', () => {
    expect(improvementResolveError({ status: 'unconfirmed', itemId: null, archivedAt: null })?.code).toBe('AKO-REQ-026')
    expect(improvementResolveError({ status: 'planned', itemId: 'imp-1', archivedAt: null }, 'todo')?.code).toBe('AKO-REQ-026')
  })
  it('取消済みは AKO-REQ-019・解決済みの再実行は no-op（冪等）', () => {
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: '2026-08-21T00:00:00+09:00' })?.code).toBe('AKO-REQ-019')
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: null, resolvedAt: '2026-08-21T00:00:00+09:00' })).toBeNull()
  })
})

describe('集約（AI 集約の対象 = 改善対応のみ。改修依頼 2026-08-21）', () => {
  it('clusterTargetRequests = 未集約・有効・改善対応のみ（旧データは 採用+open を読替え）', () => {
    expect(clusterTargetRequests([
      { id: 'a', itemId: null, archivedAt: null, status: 'planned' as const },
      { id: 'b', itemId: null, archivedAt: null, status: 'open' as const, adoption: 'adopted' as const }, // 旧・採用
      { id: 'c', itemId: null, archivedAt: null, status: 'unconfirmed' as const },
      { id: 'd', itemId: null, archivedAt: null, status: 'reviewing' as const },
      { id: 'e', itemId: null, archivedAt: null, status: 'operational' as const },
      { id: 'f', itemId: 'imp-1', archivedAt: null, status: 'planned' as const }, // 集約済み
      { id: 'g', itemId: null, archivedAt: '2026-08-21T00:00:00+09:00', status: 'planned' as const }, // 取消済み
      { id: 'h', itemId: null, archivedAt: null, status: 'open' as const, adoption: 'declined' as const }, // 旧・不採用
    ]).map(r => r.id)).toEqual(['a', 'b'])
  })
  it('追記先は未対応の item のみ（isClusterAppendTarget。旧 triage/accepted/deferred も読替えで対象）', () => {
    expect(isClusterAppendTarget('todo')).toBe(true)
    expect(isClusterAppendTarget('triage')).toBe(true)
    expect(isClusterAppendTarget('accepted')).toBe(true)
    expect(isClusterAppendTarget('deferred')).toBe(true)
    expect(isClusterAppendTarget('in_progress')).toBe(false)
    expect(isClusterAppendTarget('done')).toBe(false)
    expect(isClusterAppendTarget('resolved')).toBe(false)
  })
  it('未対応 item へ追記し、新規ページは作成する', () => {
    const plan = heuristicClusterRequests(
      [{ id: 'i1', status: 'todo', pagePaths: ['/a'] }],
      [
        { id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x' },
        { id: 'r2', pagePath: '/b', pageLabel: 'B', body: 'y' },
      ],
    )
    expect(plan.appends).toEqual([{ itemId: 'i1', requestIds: ['r1'] }])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r2'])
  })
  it('着手済み（対応中/対応済）の item には追記しない（原則2）', () => {
    const plan = heuristicClusterRequests(
      [{ id: 'i1', status: 'in_progress', pagePaths: ['/a'] }],
      [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x' }],
    )
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates).toHaveLength(1)
  })
})

describe('プロンプト（buildCodingPrompt）', () => {
  it('プロンプトに対象パスと元要望が含まれ、現在の状態は 3 状態ラベル', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/a'],
      requests: [{ pageLabel: 'A', pagePath: '/a', body: '直したい' }],
    }])
    expect(prompt).toContain('/a')
    expect(prompt).toContain('直したい')
    expect(prompt).toContain('- **現在の状態:** 未対応')
  })
  it('旧語彙の item も正規化ラベルで出力される（原則7）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/a'], requests: [],
    }])
    expect(prompt).toContain('- **現在の状態:** 未対応')
  })
  it('プロンプト冒頭にナビゲーター定型文が必ず入る（改修依頼 2026-08-18）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/a'], requests: [],
    }])
    expect(prompt.startsWith(PROMPT_NAVIGATOR_PREAMBLE)).toBe(true)
    expect(prompt).toContain('あなたはナビゲーターです。')
    expect(prompt).toContain('改修後は指摘事項がなくなるまでコードレビューとシステム監査を繰り返してください。')
    expect(prompt.indexOf('あなたはナビゲーターです。')).toBeLessThan(prompt.indexOf('# 改善要望に基づく改修依頼'))
  })
  it('要望の添付（参考リンク・画像件数）がプロンプトに加味される（2026-08-17）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/a'],
      requests: [{ pageLabel: 'A', pagePath: '/a', body: '直したい', links: ['https://ref.example'], imageCount: 1 }],
    }])
    expect(prompt).toContain('参考リンク: https://ref.example')
    expect(prompt).toContain('添付画像 1 件')
  })
  it('対象箇所（targetSpot）は対象ページに併記される（改修依頼 2026-08-21）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/a'],
      requests: [{ pageLabel: 'A', pagePath: '/a', targetSpot: '一覧の合計欄', body: '直したい' }],
    }])
    expect(prompt).toContain('［A / 一覧の合計欄］')
  })
  it('promptRequestTag: 解決済み・対応見送りの要望に注記が付く（受付箱ステータスの反映）', () => {
    expect(promptRequestTag({ status: 'resolved' })).toBe('解決済み')
    expect(promptRequestTag({ status: 'planned', resolvedAt: '2026-08-21T00:00:00+09:00' })).toBe('解決済み')
    expect(promptRequestTag({ status: 'dismissed' })).toBe('対応見送り')
    expect(promptRequestTag({ status: 'planned' })).toBe('')
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/a'],
      requests: [
        { pageLabel: 'A', pagePath: '/a', body: '反映済みの要望', status: 'resolved' },
        { pageLabel: 'A', pagePath: '/a', body: '見送りの要望', status: 'dismissed' },
        { pageLabel: 'A', pagePath: '/a', body: '通常の要望' },
      ],
    }])
    expect(prompt).toContain('【解決済み】 反映済みの要望')
    expect(prompt).toContain('【対応見送り】 見送りの要望')
    expect(prompt).toContain('- 【要望】 ［A］ 通常の要望')
    expect(prompt).toContain('【解決済み】の要望は反映済みのため再改修しないこと')
  })
  it('buildCodingPrompt は要望とコメントを時系列統合して反映する（改修依頼 2026-08-19 第4弾）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい', createdAt: '2026-08-19T10:00:00+09:00',
        comments: [{ body: '配色の範囲を確認したい', createdAt: '2026-08-19T11:00:00+09:00' }] }],
    }])
    expect(prompt).toContain('- 【要望】 ［X］ 直したい')
    expect(prompt).toContain('- 【コメント】 配色の範囲を確認したい')
    expect(prompt.indexOf('直したい')).toBeLessThan(prompt.indexOf('配色の範囲を確認したい'))
  })
  it('buildCodingPrompt は壁打ち/お任せタグをプロンプトに含めない（人間運用用 = 改修依頼 2026-08-19）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [
        { pageLabel: 'X', pagePath: '/x', body: '直したい A', ...({ tags: ['entrust'] } as object) },
        { pageLabel: 'X', pagePath: '/x', body: '直したい B', ...({ tags: ['brainstorm', 'entrust'] } as object) },
      ],
    }])
    expect(prompt).not.toContain('〔')
    expect(prompt).not.toContain('タグの読み方')
    expect(prompt).toContain('直したい A')
    expect(prompt).toContain('直したい B')
  })
})

describe('生要望の旧・選別の読替え（requestAdoptionOf = 下位互換ヘルパ。原則7）', () => {
  it('adoption 未定義の旧データは集約済み = adopted / 未集約 = pending に補完', () => {
    expect(requestAdoptionOf({ itemId: 'imp-1' })).toBe('adopted')
    expect(requestAdoptionOf({ itemId: null })).toBe('pending')
    expect(requestAdoptionOf({ adoption: 'declined', itemId: null })).toBe('declined')
  })
  it('コメント本文の検証（空・上限）', () => {
    expect(improvementCommentError(' ')).not.toBeNull()
    expect(improvementCommentError('確認: 対象は部署セレクトの想定で良いですか？')).toBeNull()
  })
})

describe('添付の検証（投稿フォーム = ImprovementSubmit / useImprovements.submit と共有）', () => {
  it('リンクは http(s) のみ・正規化で空/重複を除く', () => {
    expect(normalizeImprovementLinks([' https://a.example ', '', ' https://a.example'])).toEqual(['https://a.example'])
    expect(improvementLinksError(['https://a.example'])).toBeNull()
    expect(improvementLinksError(['example.com'])).not.toBeNull()
  })
  it('画像は data:image の allowlist（PNG/JPEG/WebP/GIF）のみ', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    expect(improvementImagesError([{ filename: 'a.png', mime: 'image/png', dataUrl: png }])).toBeNull()
    expect(improvementImagesError([{ filename: 'a.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }])).not.toBeNull()
  })
})

describe('要望タグ（壁打ち/お任せ = F-42-17・改修依頼 2026-08-18）', () => {
  it('normalizeImprovementTags は既知タグのみ・重複除去（未知値・非配列は落とす）', () => {
    expect(normalizeImprovementTags(['brainstorm', 'entrust'])).toEqual(['brainstorm', 'entrust'])
    expect(normalizeImprovementTags(['entrust', 'entrust', 'bogus', 1, null])).toEqual(['entrust'])
    expect(normalizeImprovementTags('entrust')).toEqual([])
    expect(normalizeImprovementTags(undefined)).toEqual([])
  })
  it('タグメタは 壁打ち/お任せ のラベルと説明を持つ（ラベル SoT）', () => {
    expect(IMPROVEMENT_REQUEST_TAG_META.brainstorm.label).toBe('壁打ち')
    expect(IMPROVEMENT_REQUEST_TAG_META.entrust.label).toBe('お任せ')
    expect(IMPROVEMENT_REQUEST_TAG_META.entrust.description).toContain('開発側の解釈')
  })
})

describe('fmtDateTimeSec（受付箱のタイムスタンプ = yyyy/MM/dd HH:mm:ss。改修依頼 2026-08-18）', () => {
  it('JST ISO 文字列を秒までゼロ埋めで表示する（TZ 変換しない = 壁時計のまま）', () => {
    expect(fmtDateTimeSec('2026-08-17T09:05:03+09:00')).toBe('2026/08/17 09:05:03')
    expect(fmtDateTimeSec('2026-01-02T23:59:59+09:00')).toBe('2026/01/02 23:59:59')
  })
  it('形式外・時刻の無い文字列はそのまま返す（他フォーマッタと同じフォールバック）', () => {
    expect(fmtDateTimeSec('2026-08-17')).toBe('2026-08-17')
    expect(fmtDateTimeSec('不明')).toBe('不明')
  })
})

describe('improvementEditError（要望本文の編集可否。F-42-16・2026-08-18。API ルートと同一の判定順）', () => {
  const active = { memberId: 'm-a', archivedAt: null }
  const archived = { memberId: 'm-a', archivedAt: '2026-08-18T10:00:00+09:00' }

  it('本人は編集できる（null = 許可）', () => {
    expect(improvementEditError(active, 'm-a', false)).toBeNull()
  })

  it('管理権限者は他人の要望も編集できる', () => {
    expect(improvementEditError(active, 'm-b', true)).toBeNull()
  })

  it('本人でも管理権限者でもない第三者は AKO-PRM-001', () => {
    expect(improvementEditError(active, 'm-b', false)?.code).toBe('AKO-PRM-001')
  })

  it('存在しない要望は AKO-REQ-002', () => {
    expect(improvementEditError(undefined, 'm-a', true)?.code).toBe('AKO-REQ-002')
  })

  it('取消済みは本人・管理権限者でも AKO-REQ-015（先に復元）', () => {
    expect(improvementEditError(archived, 'm-a', false)?.code).toBe('AKO-REQ-015')
    expect(improvementEditError(archived, 'm-b', true)?.code).toBe('AKO-REQ-015')
  })

  it('判定順 = 存在 → 権限 → 取消済み（権限の無い第三者へ取消状態を漏らさない）', () => {
    expect(improvementEditError(archived, 'm-b', false)?.code).toBe('AKO-PRM-001')
  })
})

describe('improvementUnclusterError（集約解除の可否。F-42-19・追加指示 2026-08-18。API ルートと同一判定）', () => {
  it('集約済み・有効な要望は解除できる（null = 許可）', () => {
    expect(improvementUnclusterError({ itemId: 'imp-1', archivedAt: null })).toBeNull()
  })
  it('存在しない要望は AKO-REQ-002', () => {
    expect(improvementUnclusterError(undefined)?.code).toBe('AKO-REQ-002')
  })
  it('未集約の要望は AKO-REQ-017（解除は不要）', () => {
    expect(improvementUnclusterError({ itemId: null, archivedAt: null })?.code).toBe('AKO-REQ-017')
  })
  it('取消済みの要望は AKO-REQ-018（先に復元）。判定順 = 存在 → 未集約 → 取消済み', () => {
    expect(improvementUnclusterError({ itemId: 'imp-1', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-018')
    expect(improvementUnclusterError({ itemId: null, archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-017')
  })
  it('対応済（決着 = 旧 解決済み/対応見送り/運用対応 含む）item の元要望は AKO-REQ-021（記録保護）', () => {
    const active = { itemId: 'imp-1', archivedAt: null }
    expect(improvementUnclusterError(active, { status: 'done' })?.code).toBe('AKO-REQ-021')
    expect(improvementUnclusterError(active, { status: 'resolved' })?.code).toBe('AKO-REQ-021')
    expect(improvementUnclusterError(active, { status: 'rejected' })?.code).toBe('AKO-REQ-021')
    // 未決着（未対応・対応中・旧 triage/accepted）は解除できる。item 省略（旧呼び出し）も許可 = 下位互換
    expect(improvementUnclusterError(active, { status: 'todo' })).toBeNull()
    expect(improvementUnclusterError(active, { status: 'in_progress' })).toBeNull()
    expect(improvementUnclusterError(active, { status: 'triage' })).toBeNull()
    expect(improvementUnclusterError(active)).toBeNull()
  })
  it('取消済み item の元要望は AKO-REQ-022（先に item を復元 = 論理削除中のトレースを書き換えない。R24）', () => {
    const active = { itemId: 'imp-1', archivedAt: null }
    expect(improvementUnclusterError(active, { status: 'todo', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-022')
    expect(improvementUnclusterError(active, { status: 'done', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-022')
  })
  it('解除後の要望は clusterTargetRequests の対象になる（status=planned へ戻す前提の確認）', () => {
    // unclusterRequest は itemId=null + status='planned' へ更新する（mock/API 共通）。
    // その結果行が共有の集約対象判定を満たすことを固定する（再度 AI 集約の対象 = 要望の受入条件）
    expect(clusterTargetRequests([{ id: 'a', itemId: null, archivedAt: null, status: 'planned' as const }])
      .map(r => r.id)).toEqual(['a'])
  })
  it('解除履歴（excludeItemIds）の item へは再追記せず新規作成する（同じ単位への往復 + detail 重複防止）', () => {
    const open = [{ id: 'i1', status: 'todo' as const, pagePaths: ['/a'] }]
    expect(heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x' }]).appends)
      .toEqual([{ itemId: 'i1', requestIds: ['r1'] }])
    const plan = heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] }])
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r1'])
  })
  it('除外は要望単位（同じページの除外なし要望は従来どおり追記 = 巻き添えで新規 item を作らない。レビュー R2）', () => {
    const open = [{ id: 'i1', status: 'todo' as const, pagePaths: ['/a'] }]
    const plan = heuristicClusterRequests(open, [
      { id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] },
      { id: 'r2', pagePath: '/a', pageLabel: 'A', body: 'y' },
    ])
    expect(plan.appends).toEqual([{ itemId: 'i1', requestIds: ['r2'] }])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r1'])
  })
  it('除外された要望も別の未対応 item が同ページを対象にしていればそこへ追記する', () => {
    const open = [
      { id: 'i1', status: 'todo' as const, pagePaths: ['/a'] },
      { id: 'i2', status: 'todo' as const, pagePaths: ['/a'] },
    ]
    const plan = heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] }])
    expect(plan.appends).toEqual([{ itemId: 'i2', requestIds: ['r1'] }])
    expect(plan.creates).toHaveLength(0)
  })
  it('buildUnclusterNoteBody = 元 item へ残す修正メモ（本文の先頭を引用・改行は潰す・「含めないこと」を明記）', () => {
    const note = buildUnclusterNoteBody('タイムカードの\n打刻を取り消せるようにしてほしい')
    expect(note).toContain('【集約の解除】')
    expect(note).toContain('タイムカードの 打刻を取り消せるように')
    expect(note).toContain('実装対象に含めないこと')
    const long = buildUnclusterNoteBody('あ'.repeat(100))
    expect(long).toContain(`「${'あ'.repeat(60)}…」`)
  })
})

describe('継続検討の再検討日 + 運用案内（受付箱へ移管 = 改修依頼 2026-08-21）', () => {
  it('improvementRevisitError: deferred は再検討日必須（実在日）・他ステータスは不要', () => {
    expect(improvementRevisitError('deferred', '')).not.toBeNull()
    expect(improvementRevisitError('deferred', '2026-09-01')).toBeNull()
    expect(improvementRevisitError('deferred', '2026-02-30')).not.toBeNull()
    expect(improvementRevisitError('planned', '')).toBeNull()
  })
  it('運用案内（operational の必須コメント）: 本文組み立てと実効上限の境界', () => {
    expect(OPERATIONAL_NOTE_MAX).toBe(1994)
    expect(operationalNoteBody('設定から変更できます')).toBe('運用案内: 設定から変更できます')
    expect(operationalNoteCapError('あ'.repeat(1994))).toBeNull()
    const over = operationalNoteCapError('あ'.repeat(1995))
    expect(over).not.toBeNull()
    expect(over).toContain('1994')
    expect([...operationalNoteBody('あ'.repeat(1994))].length).toBe(2000)
  })
})

describe('AI 判定のメタ（IMPROVEMENT_ASSESS_META = 改修依頼 2026-08-21）', () => {
  it('区分ラベルと推奨アクション（既存/工夫 → 運用対応・改修要 → 改善対応・不明 → 検討中）', () => {
    expect(IMPROVEMENT_ASSESS_META.existing.recommended).toBe('operational')
    expect(IMPROVEMENT_ASSESS_META.workaround.recommended).toBe('operational')
    expect(IMPROVEMENT_ASSESS_META.improvement.recommended).toBe('planned')
    expect(IMPROVEMENT_ASSESS_META.unknown.recommended).toBe('reviewing')
    expect(IMPROVEMENT_ASSESS_META.improvement.label).toBe('改修が必要')
  })
})

describe('improvementEditChangedLabel（編集の変更項目ラベル = 監査ログ・API/モック共通）', () => {
  it('本文は常に含み、部分更新で送った項目（タグ/リンク/画像/対象箇所）のみ順に並べる', () => {
    const bodyOnly = improvementRequestEditFields({ body: '本文だけ' })
    expect(bodyOnly.ok && improvementEditChangedLabel(bodyOnly.value)).toBe('本文')
    const full = improvementRequestEditFields({ body: 'x', tags: ['entrust'], links: [], images: [], targetSpot: '一覧' })
    expect(full.ok && improvementEditChangedLabel(full.value)).toBe('本文・タグ・リンク・画像・対象箇所')
    const partial = improvementRequestEditFields({ body: 'x', links: ['https://a.example'] })
    expect(partial.ok && improvementEditChangedLabel(partial.value)).toBe('本文・リンク')
  })
  it('対象箇所は部分更新（キー実在時のみ更新・trim + 上限。改修依頼 2026-08-21）', () => {
    const withSpot = improvementRequestEditFields({ body: 'x', targetSpot: ' 一覧のステータス列 ' })
    expect(withSpot.ok && withSpot.value.targetSpot).toBe('一覧のステータス列')
    const noSpot = improvementRequestEditFields({ body: 'x' })
    expect(noSpot.ok && noSpot.value.targetSpot).toBeUndefined()
    const clearSpot = improvementRequestEditFields({ body: 'x', targetSpot: '' })
    expect(clearSpot.ok && clearSpot.value.targetSpot).toBe('')
  })
})
