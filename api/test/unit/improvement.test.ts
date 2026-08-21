import { describe, expect, it } from 'vitest'
import {
  buildCodingPrompt,
  canInboxTransition,
  canTransition,
  type ClusterOpenItem,
  type ClusterRequestInput,
  clusterTargetRequests,
  heuristicClusterRequests,
  improvementBodyError,
  improvementCommentError,
  IMPROVEMENT_COMMENT_CAP,
  IMPROVEMENT_IMAGE_MAX_CHARS,
  IMPROVEMENT_IMAGES_MAX,
  IMPROVEMENT_INBOX_NEXT,
  IMPROVEMENT_INBOX_STATUS_META,
  IMPROVEMENT_INBOX_STATUSES,
  IMPROVEMENT_ITEM_NEXT,
  IMPROVEMENT_ITEM_STATUS_META,
  IMPROVEMENT_ITEM_VIEWS,
  IMPROVEMENT_LINKS_MAX,
  IMPROVEMENT_NOTE_CAP,
  improvementImagesError,
  improvementInboxStatusError,
  improvementInboxStatusOf,
  improvementItemViewOf,
  improvementLinksError,
  improvementNoteError,
  improvementRequestEditFields,
  improvementResolveError,
  improvementRevisitError,
  inboxStatusFromItem,
  isClusterAppendTarget,
  isInternalPagePath,
  isOpenItemStatus,
  matchesImprovementFilter,
  IMPROVEMENT_REQUEST_TAG_META,
  normalizeClusterPlan,
  normalizeImprovementPagePath,
  normalizeImprovementImages,
  normalizeImprovementLinks,
  normalizeImprovementTags,
  OPERATIONAL_NOTE_MAX,
  operationalNoteBody,
  operationalNoteCapError,
  planInboxStatusBulk,
  promptRequestTag,
  requestAdoptionOf,
} from '../../../shared/domain/improvement'
import {
  assessRelatedDocs,
  heuristicAssessRequest,
  normalizeAssessment,
} from '../../../shared/domain/improvement-assess'
import { improvementRequestInputOf } from '../../src/routes/improvements'

const reqs: ClusterRequestInput[] = [
  { id: 'r1', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '合計金額を大きく表示してほしい' },
  { id: 'r2', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '税込/税抜の切替がほしい' },
  { id: 'r3', pagePath: '/timecard', pageLabel: 'タイムカード', body: '打刻の取消を可能にしてほしい' },
]

describe('改修案件の 3 状態機械（canTransition / IMPROVEMENT_ITEM_NEXT = 改修依頼 2026-08-21）', () => {
  it('未対応 → 対応中 → 対応済 が主経路。直行・reopen・差し戻しを許可（原則7/9.5）', () => {
    expect(IMPROVEMENT_ITEM_NEXT.todo).toEqual(['in_progress', 'done'])
    expect(IMPROVEMENT_ITEM_NEXT.in_progress).toEqual(['done', 'todo'])
    expect(IMPROVEMENT_ITEM_NEXT.done).toEqual(['in_progress'])
    expect(canTransition('todo', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'done')).toBe(true)
    expect(canTransition('done', 'in_progress')).toBe(true) // reopen
    expect(canTransition('done', 'todo')).toBe(false)
  })
  it('旧 7 値語彙の保存値は正規化して判定する（改修依頼 2026-08-21 の読替え = 原則7）', () => {
    expect(improvementItemViewOf('triage')).toBe('todo')
    expect(improvementItemViewOf('accepted')).toBe('todo')
    expect(improvementItemViewOf('deferred')).toBe('todo')
    expect(improvementItemViewOf('in_progress')).toBe('in_progress')
    expect(improvementItemViewOf('resolved')).toBe('done')
    expect(improvementItemViewOf('operational')).toBe('done')
    expect(improvementItemViewOf('rejected')).toBe('done')
    expect(canTransition('triage', 'in_progress')).toBe(true)
    expect(canTransition('operational', 'in_progress')).toBe(true) // 旧決着 = 対応済ビュー → reopen
    expect(isOpenItemStatus('deferred')).toBe(true)
    expect(isOpenItemStatus('rejected')).toBe(false)
  })
  it('表示メタは新語彙（未対応/対応中/対応済）', () => {
    expect(IMPROVEMENT_ITEM_VIEWS).toEqual(['todo', 'in_progress', 'done'])
    expect(IMPROVEMENT_ITEM_STATUS_META.todo.label).toBe('未対応')
    expect(IMPROVEMENT_ITEM_STATUS_META.in_progress.label).toBe('対応中')
    expect(IMPROVEMENT_ITEM_STATUS_META.done.label).toBe('対応済')
  })
})

describe('matchesImprovementFilter（3 状態 + open = 未完了）', () => {
  it('open は未対応・対応中のみ一致（対応済は除外。旧語彙も正規化して判定）', () => {
    expect(matchesImprovementFilter('todo', 'open')).toBe(true)
    expect(matchesImprovementFilter('in_progress', 'open')).toBe(true)
    expect(matchesImprovementFilter('done', 'open')).toBe(false)
    expect(matchesImprovementFilter('triage', 'open')).toBe(true)
    expect(matchesImprovementFilter('rejected', 'open')).toBe(false)
  })
  it('all はすべて一致・個別ステータスは正規化一致', () => {
    expect(matchesImprovementFilter('rejected', 'all')).toBe(true)
    expect(matchesImprovementFilter('resolved', 'done')).toBe(true)
    expect(matchesImprovementFilter('accepted', 'todo')).toBe(true)
    expect(matchesImprovementFilter('in_progress', 'todo')).toBe(false)
  })
})

describe('受付箱ステータス（improvementInboxStatusOf / 遷移機械 = 改修依頼 2026-08-21）', () => {
  it('表示ステータスは 8 種・遷移は 未確認 → 検討中 → 各対応方針', () => {
    expect(IMPROVEMENT_INBOX_STATUSES).toEqual([
      'unconfirmed', 'reviewing', 'planned', 'operational', 'deferred', 'dismissed', 'addressed', 'resolved',
    ])
    expect(IMPROVEMENT_INBOX_NEXT.unconfirmed).toEqual(['reviewing'])
    expect(IMPROVEMENT_INBOX_NEXT.reviewing).toEqual(['planned', 'operational', 'deferred', 'dismissed', 'unconfirmed'])
    expect(canInboxTransition('deferred', 'deferred')).toBe(true) // 再検討日の変更
    expect(canInboxTransition('planned', 'reviewing')).toBe(true) // 見直し（原則9.5）
    expect(canInboxTransition('unconfirmed', 'operational')).toBe(false)
    expect(IMPROVEMENT_INBOX_STATUS_META.operational.label).toBe('運用対応')
    expect(IMPROVEMENT_INBOX_STATUS_META.addressed.label).toBe('対応済み')
  })
  it('resolver: 新語彙はそのまま・旧データは選別読替え・集約済みは item 連動・解決の記録は最優先', () => {
    expect(improvementInboxStatusOf({ status: 'unconfirmed', itemId: null })).toBe('unconfirmed')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'pending', itemId: null })).toBe('unconfirmed')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'adopted', itemId: null })).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'open', adoption: 'declined', itemId: null })).toBe('dismissed')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' }, 'in_progress')).toBe('planned')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1' }, 'done')).toBe('addressed')
    expect(improvementInboxStatusOf({ status: 'planned', itemId: 'imp-1', resolvedAt: '2026-08-21T09:00:00+09:00' }, 'done')).toBe('resolved')
    expect(improvementInboxStatusOf({ status: 'resolved', itemId: null })).toBe('resolved')
    expect(inboxStatusFromItem('rejected')).toBe('dismissed')
    expect(inboxStatusFromItem('deferred')).toBe('deferred')
    expect(inboxStatusFromItem('operational')).toBe('operational')
  })
  it('improvementInboxStatusError: 存在 → 取消済み → 集約済み → 解決済み → 遷移検証の順', () => {
    expect(improvementInboxStatusError(undefined, 'reviewing')?.code).toBe('AKO-REQ-002')
    expect(improvementInboxStatusError({ status: 'unconfirmed', itemId: null, archivedAt: '2026-08-21T00:00:00+09:00' }, 'reviewing')?.code).toBe('AKO-REQ-019')
    expect(improvementInboxStatusError({ status: 'planned', itemId: 'imp-1', archivedAt: null }, 'reviewing')?.code).toBe('AKO-REQ-013')
    expect(improvementInboxStatusError({ status: 'operational', itemId: null, archivedAt: null, resolvedAt: '2026-08-21T00:00:00+09:00' }, 'reviewing')?.code).toBe('AKO-REQ-025')
    expect(improvementInboxStatusError({ status: 'unconfirmed', itemId: null, archivedAt: null }, 'planned')?.code).toBe('AKO-REQ-006')
    expect(improvementInboxStatusError({ status: 'reviewing', itemId: null, archivedAt: null }, 'planned')).toBeNull()
  })
  it('improvementResolveError: 運用対応/対応済みのみ解決できる・再実行は冪等', () => {
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: null })).toBeNull()
    expect(improvementResolveError({ status: 'planned', itemId: 'imp-1', archivedAt: null }, 'done')).toBeNull()
    expect(improvementResolveError({ status: 'reviewing', itemId: null, archivedAt: null })?.code).toBe('AKO-REQ-026')
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: null, resolvedAt: '2026-08-21T00:00:00+09:00' })).toBeNull()
    expect(improvementResolveError({ status: 'operational', itemId: null, archivedAt: '2026-08-21T00:00:00+09:00' })?.code).toBe('AKO-REQ-019')
  })
  it('planInboxStatusBulk: 重複除去・部分成功の仕分け（API の逐次 1 件判定と同一 = 原則6）', () => {
    const rows = [
      { id: 'a', status: 'unconfirmed' as const, itemId: null, archivedAt: null },
      { id: 'b', status: 'planned' as const, itemId: 'imp-1', archivedAt: null },
    ]
    const plan = planInboxStatusBulk(['a', 'a', 'b', 'nope'], rows, 'reviewing')
    expect(plan.targets).toEqual(['a', 'b', 'nope'])
    expect(plan.applicable).toEqual(['a'])
    expect(plan.lastError?.code).toBe('AKO-REQ-002')
  })
})

describe('improvementBodyError', () => {
  it('空はエラー・通常は null', () => {
    expect(improvementBodyError('   ')).toBeTruthy()
    expect(improvementBodyError('直したい')).toBeNull()
  })
})

describe('heuristicClusterRequests', () => {
  it('ページ単位でまとめ、既存の未対応 item があれば追記・無ければ新規作成', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'todo', pagePaths: ['/akebono/sales'] }]
    const plan = heuristicClusterRequests(open, reqs)
    expect(plan.appends).toEqual([{ itemId: 'i-sales', requestIds: ['r1', 'r2'] }])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r3'])
    expect(plan.creates[0]!.pagePaths).toEqual(['/timecard'])
  })
  it('旧 triage/accepted の item も未対応として追記先になる（読替え = 原則7）', () => {
    expect(isClusterAppendTarget('triage')).toBe(true)
    expect(isClusterAppendTarget('accepted')).toBe(true)
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'triage', pagePaths: ['/akebono/sales'] }]
    const plan = heuristicClusterRequests(open, reqs.slice(0, 2))
    expect(plan.appends).toEqual([{ itemId: 'i-sales', requestIds: ['r1', 'r2'] }])
  })
  it('着手済み（対応中/対応済）item には追記せず新規作成する（ステータス保護 = 原則2）', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'in_progress', pagePaths: ['/akebono/sales'] }]
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
    expect(assigned.has('r1')).toBe(true)
    expect(assigned.has('r2')).toBe(true)
    expect(assigned.has('r3')).toBe(true)
    expect(assigned.has('bogus')).toBe(false)
  })
  it('append 先が着手済み（対応中）の場合はその append を捨てる（保護）', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-acc', status: 'in_progress', pagePaths: ['/x'] }]
    const raw = { appends: [{ itemId: 'i-acc', requestIds: ['r1'] }], creates: [] }
    const plan = normalizeClusterPlan(raw, [reqs[0]!], open)!
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates.some(cr => cr.requestIds.includes('r1'))).toBe(true)
  })
  it('「集約の解除」の履歴（excludeItemIds）にある item への LLM append は捨て、補完で新規作成へ回す（F-42-19）', () => {
    const open: ClusterOpenItem[] = [{ id: 'i-sales', status: 'todo', pagePaths: ['/akebono/sales'] }]
    const excluded: ClusterRequestInput = { ...reqs[0]!, excludeItemIds: ['i-sales'] }
    const raw = { appends: [{ itemId: 'i-sales', requestIds: ['r1'] }], creates: [] }
    const plan = normalizeClusterPlan(raw, [excluded], open)!
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates.some(cr => cr.requestIds.includes('r1'))).toBe(true)
  })
})

describe('buildCodingPrompt', () => {
  it('対象パス・元要望・受入基準を含む決定的なプロンプトを生成（現在の状態は 3 状態ラベル）', () => {
    const prompt = buildCodingPrompt([{
      title: '売上ページの表示改善',
      summary: '合計と税表示',
      detail: '合計金額を強調し、税込/税抜トグルを追加する',
      status: 'todo',
      pagePaths: ['/akebono/sales'],
      requests: [{ pageLabel: 'AKEBONO 売上', pagePath: '/akebono/sales', body: '合計を大きく' }],
    }])
    expect(prompt).toContain('/akebono/sales')
    expect(prompt).toContain('合計を大きく')
    expect(prompt).toContain('受入基準')
    expect(prompt).toContain('- **現在の状態:** 未対応')
    const again = buildCodingPrompt([{
      title: '売上ページの表示改善', summary: '合計と税表示',
      detail: '合計金額を強調し、税込/税抜トグルを追加する', status: 'todo',
      pagePaths: ['/akebono/sales'],
      requests: [{ pageLabel: 'AKEBONO 売上', pagePath: '/akebono/sales', body: '合計を大きく' }],
    }])
    expect(prompt).toEqual(again)
  })
  it('対象箇所（targetSpot）は対象ページに併記される（改修依頼 2026-08-21）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', targetSpot: '一覧の合計欄', body: '直したい' }],
    }])
    expect(prompt).toContain('- 【要望】 ［X / 一覧の合計欄］ 直したい')
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
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
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
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(noNotes).not.toContain('担当者メモ')
    const emptyNotes = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
      notes: [{ body: '   ', kind: 'note' }],
    }])
    expect(emptyNotes).not.toContain('担当者メモ')
  })
})

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('添付リンク（normalizeImprovementLinks / improvementLinksError）', () => {
  it('trim・空除去・重複除去し、http(s) URL のみ許可する', () => {
    expect(normalizeImprovementLinks([' https://a.example ', '', 'https://a.example', 'https://b.example']))
      .toEqual(['https://a.example', 'https://b.example'])
    expect(normalizeImprovementLinks('not-array')).toEqual([])
    expect(improvementLinksError(['https://a.example', 'http://b.example'])).toBeNull()
    expect(improvementLinksError(['ftp://x.example'])).not.toBeNull()
    expect(improvementLinksError(['javascript:alert(1)'])).not.toBeNull()
    expect(improvementLinksError(['https://a b'])).not.toBeNull() // 空白を含む URL は不可
  })
  it('件数・長さの上限を検証する', () => {
    const many = Array.from({ length: IMPROVEMENT_LINKS_MAX + 1 }, (_, i) => `https://example.com/${i}`)
    expect(improvementLinksError(many)).not.toBeNull()
    expect(improvementLinksError(many.slice(0, IMPROVEMENT_LINKS_MAX))).toBeNull()
    expect(improvementLinksError([`https://example.com/${'a'.repeat(600)}`])).not.toBeNull()
  })
})

describe('添付画像（normalizeImprovementImages / improvementImagesError）', () => {
  it('filename を補完・mime は data URI から導出し、allowlist・上限を検証する', () => {
    const imgs = normalizeImprovementImages([{ dataUrl: PNG }, { filename: 'a.png', mime: 'image/webp', dataUrl: PNG }])
    expect(imgs).toHaveLength(2)
    expect(imgs[0]).toMatchObject({ filename: 'image', mime: 'image/png' }) // mime は dataUrl の実体から
    expect(imgs[1]!.mime).toBe('image/png') // 入力 mime（縮小前の型）よりも dataUrl を信頼する
    expect(improvementImagesError(imgs)).toBeNull()
    expect(improvementImagesError([{ filename: 'x.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }]))
      .not.toBeNull() // SVG はスクリプト混入リスクがあるため不可（商品画像と同じ allowlist）
    expect(improvementImagesError([{ filename: 'x', mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(IMPROVEMENT_IMAGE_MAX_CHARS)}` }]))
      .not.toBeNull() // 上限超過
  })
  it('件数上限・dataUrl 空の除外', () => {
    expect(normalizeImprovementImages([{ dataUrl: '' }, null, 'x'])).toEqual([])
    const many = Array.from({ length: IMPROVEMENT_IMAGES_MAX + 1 }, () => ({ filename: 'a', mime: 'image/png', dataUrl: PNG }))
    expect(improvementImagesError(many)).not.toBeNull()
    expect(improvementImagesError(many.slice(0, IMPROVEMENT_IMAGES_MAX))).toBeNull()
  })
})

describe('受付箱ステータスのプロンプト反映（promptRequestTag = 改修依頼 2026-08-21）', () => {
  it('解決済み（旧 resolved / resolvedAt）と対応見送り（dismissed）に注記が付く', () => {
    expect(promptRequestTag({ status: 'resolved' })).toBe('解決済み')
    expect(promptRequestTag({ status: 'planned', resolvedAt: '2026-08-21T00:00:00+09:00' })).toBe('解決済み')
    expect(promptRequestTag({ status: 'dismissed' })).toBe('対応見送り')
    expect(promptRequestTag({ status: 'open' })).toBe('')
    expect(promptRequestTag({})).toBe('')
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [
        { pageLabel: 'X', pagePath: '/x', body: '直したい A' },
        { pageLabel: 'X', pagePath: '/x', body: '直したい B', status: 'resolved' },
        { pageLabel: 'X', pagePath: '/x', body: '直したい C', status: 'dismissed' },
      ],
    }])
    expect(prompt).toContain('【解決済み】 直したい B')
    expect(prompt).toContain('【対応見送り】 直したい C')
    expect(prompt).toContain('再改修しないこと')
  })
  it('全要望が通常状態なら注記・注意書きを出さない（【要望】マーク自体は時系列統合で常時付く）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('【解決済み】')
    expect(prompt).not.toContain('【対応見送り】')
    expect(prompt).toContain('- 【要望】 ［X］ 直したい')
    expect(prompt).not.toContain('再改修しないこと')
  })
})

describe('集約対象（clusterTargetRequests = 「改善対応」のみ。改修依頼 2026-08-21）', () => {
  it('未集約・有効・改善対応のみ選ぶ（generate SQL と同一条件 = 原則6。旧データは 採用+open を読替え）', () => {
    const rows = [
      { id: 'a', itemId: null, archivedAt: null, status: 'planned' as const },
      { id: 'b', itemId: null, archivedAt: null, status: 'open' as const, adoption: 'adopted' as const }, // 旧・採用
      { id: 'c', itemId: null, archivedAt: null, status: 'open' as const, adoption: 'declined' as const },
      { id: 'd', itemId: 'imp-1', archivedAt: null, status: 'planned' as const }, // 集約済みは対象外
      { id: 'e', itemId: null, archivedAt: '2026-08-17T00:00:00+09:00', status: 'planned' as const }, // 取消済みは対象外
      { id: 'f', itemId: null, archivedAt: null }, // 旧データ（status/adoption 未定義 = 未確認扱い）も対象外
      { id: 'g', itemId: null, archivedAt: null, status: 'reviewing' as const }, // 検討中は対象外
    ]
    expect(clusterTargetRequests(rows).map(r => r.id)).toEqual(['a', 'b'])
  })
  it('requestAdoptionOf（旧・選別の読替えヘルパ = 原則7）', () => {
    expect(requestAdoptionOf({})).toBe('pending')
    expect(requestAdoptionOf({ itemId: 'imp-1' })).toBe('adopted')
    expect(requestAdoptionOf({ adoption: 'declined', itemId: null })).toBe('declined')
    expect(requestAdoptionOf({ adoption: 'bogus' as never, itemId: 'imp-1' })).toBe('adopted')
  })
})

describe('improvementCommentError（生要望コメント。2026-08-17 第 2 弾）', () => {
  it('空はエラー・上限超過はエラー・通常は null', () => {
    expect(improvementCommentError('  ')).not.toBeNull()
    expect(improvementCommentError('部署セレクトと同じ想定で良いですか？')).toBeNull()
    expect(improvementCommentError('あ'.repeat(IMPROVEMENT_COMMENT_CAP))).toBeNull()
    expect(improvementCommentError('あ'.repeat(IMPROVEMENT_COMMENT_CAP + 1))).not.toBeNull()
  })
})

describe('buildCodingPrompt（添付の加味）', () => {
  it('参考リンクを列挙し、添付画像は件数を言及する', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい', links: ['https://ref.example/doc'], imageCount: 2 }],
    }])
    expect(prompt).toContain('参考リンク: https://ref.example/doc')
    expect(prompt).toContain('添付画像 2 件')
  })
  it('添付が無ければ言及しない（旧呼び出しの下位互換）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('参考リンク')
    expect(prompt).not.toContain('添付画像')
  })
})

describe('要望タグ（壁打ち/お任せ = F-42-17）', () => {
  it('normalizeImprovementTags は allowlist（brainstorm/entrust）のみ・重複除去', () => {
    expect(normalizeImprovementTags(['brainstorm', 'entrust'])).toEqual(['brainstorm', 'entrust'])
    expect(normalizeImprovementTags(['entrust', 'entrust', 'bogus'])).toEqual(['entrust'])
    expect(normalizeImprovementTags('entrust')).toEqual([])
    expect(IMPROVEMENT_REQUEST_TAG_META.brainstorm.label).toBe('壁打ち')
    expect(IMPROVEMENT_REQUEST_TAG_META.entrust.label).toBe('お任せ')
  })
})

describe('buildCodingPrompt: 要望+コメントの時系列統合 + タグ除外（改修依頼 2026-08-19 第4弾）', () => {
  it('要望本文とコメントを createdAt 昇順で 1 本の時系列に統合し【要望】【コメント】で明示する', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [
        { pageLabel: 'X', pagePath: '/x', body: '要望A', createdAt: '2026-08-19T10:00:00+09:00',
          comments: [{ body: 'Aへのコメント', createdAt: '2026-08-19T13:00:00+09:00' }] },
        { pageLabel: 'X', pagePath: '/x', body: '要望B', createdAt: '2026-08-19T11:00:00+09:00',
          comments: [{ body: 'Bへのコメント', createdAt: '2026-08-19T12:00:00+09:00' }] },
      ],
    }])
    expect(prompt).toContain('- 【要望】 ［X］ 要望A')
    expect(prompt).toContain('- 【要望】 ［X］ 要望B')
    expect(prompt).toContain('- 【コメント】 Aへのコメント')
    expect(prompt).toContain('- 【コメント】 Bへのコメント')
    const iA = prompt.indexOf('要望A'); const iB = prompt.indexOf('要望B')
    const iCB = prompt.indexOf('Bへのコメント'); const iCA = prompt.indexOf('Aへのコメント')
    expect(iA).toBeLessThan(iB)
    expect(iB).toBeLessThan(iCB)
    expect(iCB).toBeLessThan(iCA)
  })
  it('createdAt が無い旧呼び出しは投入順を保持する（決定的・下位互換 = 原則7）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい',
        comments: [{ body: 'まず配色の範囲を確認したい' }, { body: '対象は一覧のみで良い' }] }],
    }])
    expect(prompt).toContain('- 【要望】 ［X］ 直したい')
    expect(prompt).toContain('- 【コメント】 まず配色の範囲を確認したい')
    expect(prompt.indexOf('直したい')).toBeLessThan(prompt.indexOf('まず配色の範囲を確認したい'))
    expect(prompt.indexOf('まず配色の範囲を確認したい')).toBeLessThan(prompt.indexOf('対象は一覧のみで良い'))
  })
  it('コメントが無ければ【コメント】行は出ない（下位互換 = 原則7）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('【コメント】')
  })
  it('壁打ち/お任せタグは人間運用のためプロンプトに含めない（凡例も行頭マークも出さない）', () => {
    const withTags = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'todo', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい', ...({ tags: ['entrust', 'brainstorm'] } as object) }],
    }])
    expect(withTags).not.toContain('〔')
    expect(withTags).not.toContain('タグの読み方')
    expect(withTags).not.toContain('お任せ')
    expect(withTags).not.toContain('壁打ち')
    expect(withTags).toContain('直したい')
  })
})

describe('improvementRequestInputOf', () => {
  it('trim + ページ情報を保持・空本文は AKO-REQ-001・添付未指定は空配列', () => {
    expect(improvementRequestInputOf({ body: ' 直したい ', pagePath: '/x', pageLabel: 'X', targetSpot: ' 合計欄 ' }))
      .toEqual({ body: '直したい', pagePath: '/x', pageLabel: 'X', targetSpot: '合計欄', links: [], images: [], tags: [] })
    let code = ''
    try { improvementRequestInputOf({ body: '  ' }) } catch (e) { code = (e as { code?: string }).code ?? '' }
    expect(code).toBe('AKO-REQ-001')
  })
  it('タグは allowlist 正規化して保持する（未知値は落とす = エラーにしない。F-42-17）', () => {
    expect(improvementRequestInputOf({ body: '直したい', tags: ['entrust', 'bogus'] }).tags).toEqual(['entrust'])
    expect(improvementRequestInputOf({ body: '直したい', tags: 'entrust' }).tags).toEqual([])
  })
  it('添付リンク・画像を正規化して保持し、不正は AKO-REQ-009 / AKO-REQ-010', () => {
    const ok = improvementRequestInputOf({
      body: '直したい', links: [' https://a.example '], images: [{ filename: 'a.png', mime: 'image/png', dataUrl: PNG }],
    })
    expect(ok.links).toEqual(['https://a.example'])
    expect(ok.images).toEqual([{ filename: 'a.png', mime: 'image/png', dataUrl: PNG }])
    let code = ''
    try { improvementRequestInputOf({ body: 'x', links: ['ftp://a'] }) } catch (e) { code = (e as { code?: string }).code ?? '' }
    expect(code).toBe('AKO-REQ-009')
    try { improvementRequestInputOf({ body: 'x', images: [{ dataUrl: 'data:text/html;base64,PGI+' }] }) } catch (e) { code = (e as { code?: string }).code ?? '' }
    expect(code).toBe('AKO-REQ-010')
  })
})

describe('improvementRequestEditFields（要望編集の全項目正規化 = 改修依頼 2026-08-19 → 対象箇所 2026-08-21）', () => {
  it('本文・タグ・リンク・画像・対象箇所を正規化して返す（投稿時と同一ルール）', () => {
    const res = improvementRequestEditFields({
      body: ' 直したい ', tags: ['entrust', 'bogus'], links: [' https://a.example '],
      images: [{ filename: 'a.png', mime: 'image/png', dataUrl: PNG }], targetSpot: ' 合計欄 ',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).toEqual({
      body: '直したい', tags: ['entrust'], links: ['https://a.example'],
      images: [{ filename: 'a.png', mime: 'image/png', dataUrl: PNG }], targetSpot: '合計欄',
    })
  })
  it('空本文は AKO-REQ-001 / 不正リンクは AKO-REQ-009 / 不正画像は AKO-REQ-010（throw せず error を返す）', () => {
    const empty = improvementRequestEditFields({ body: '  ' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('AKO-REQ-001')
    const badLink = improvementRequestEditFields({ body: 'x', links: ['ftp://a'] })
    expect(badLink.ok).toBe(false)
    if (!badLink.ok) expect(badLink.error.code).toBe('AKO-REQ-009')
    const badImage = improvementRequestEditFields({ body: 'x', images: [{ dataUrl: 'data:text/html;base64,PGI+' }] })
    expect(badImage.ok).toBe(false)
    if (!badImage.ok) expect(badImage.error.code).toBe('AKO-REQ-010')
  })
  it('部分更新: 省略したキー（tags/links/images/targetSpot）は value に含めない（呼び出し側が現行値を保持）', () => {
    const res = improvementRequestEditFields({ body: '本文だけ' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ body: '本文だけ' })
  })
  it('空配列・空文字を明示的に送れば「全削除・クリア」になる（キーが実在するため value に含まれる）', () => {
    const res = improvementRequestEditFields({ body: 'x', tags: [], links: [], images: [], targetSpot: '' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ body: 'x', tags: [], links: [], images: [], targetSpot: '' })
  })
  it('明示的 undefined は「未指定 = 現行値保持」として扱う（mock 経路の { tags: undefined } を API 経路と揃える = R1 MINOR）', () => {
    const res = improvementRequestEditFields({ body: 'x', tags: undefined, links: undefined, images: undefined, targetSpot: undefined })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toEqual({ body: 'x' })
  })
})

describe('normalizeImprovementPagePath / isInternalPagePath（F-42-20 の対象ページリンク化に伴う防御）', () => {
  it('アプリ内パスのみ保持する', () => {
    expect(normalizeImprovementPagePath('/akebono/sales')).toBe('/akebono/sales')
    expect(normalizeImprovementPagePath('  /shift  ')).toBe('/shift')
    expect(isInternalPagePath('/masters/members')).toBe(true)
  })
  it('プロトコル相対 URL・バックスラッシュ・空白入りは落とす（外部誘導リンクの防止 = R1 監査）', () => {
    expect(normalizeImprovementPagePath('//evil.example')).toBe('')
    expect(normalizeImprovementPagePath('/\\evil.example')).toBe('')
    expect(normalizeImprovementPagePath('/a b')).toBe('')
    expect(normalizeImprovementPagePath('https://evil.example')).toBe('')
    expect(normalizeImprovementPagePath('javascript:alert(1)')).toBe('')
    expect(isInternalPagePath('//evil.example')).toBe(false)
  })
  it("'' と非文字列は ''（全体/新設ページ扱い = 下位互換）", () => {
    expect(normalizeImprovementPagePath('')).toBe('')
    expect(normalizeImprovementPagePath(null)).toBe('')
    expect(normalizeImprovementPagePath(undefined)).toBe('')
  })
})

describe('improvementRevisitError（継続検討の再検討日。mock/API 共有の検証 = 原則6）', () => {
  it('deferred への遷移は再検討日が必須・実在日のみ', () => {
    expect(improvementRevisitError('deferred', '')).not.toBeNull()
    expect(improvementRevisitError('deferred', '  ')).not.toBeNull()
    expect(improvementRevisitError('deferred', '2026-09-01')).toBeNull()
    expect(improvementRevisitError('deferred', '2026-02-30')).not.toBeNull() // 実在しない日付
    expect(improvementRevisitError('deferred', '9/1')).not.toBeNull() // 形式外
  })
  it('deferred 以外は再検討日なしで通る（渡された場合のみ形式検証。保持 = クリアしないは呼び出し側の責務）', () => {
    expect(improvementRevisitError('planned', '')).toBeNull()
    expect(improvementRevisitError('reviewing', '')).toBeNull()
    expect(improvementRevisitError('planned', '2026-09-01')).toBeNull()
    expect(improvementRevisitError('planned', 'bogus')).not.toBeNull()
  })
})

describe('運用案内の本文・上限（operational 遷移の必須コメント。mock/API 共有 = 原則6・改修依頼 2026-08-21）', () => {
  it('実効上限 = コメント/メモ上限 − 接頭辞で、境界とメッセージが一致する', () => {
    expect(OPERATIONAL_NOTE_MAX).toBe(IMPROVEMENT_NOTE_CAP - [...'運用案内: '].length)
    expect(operationalNoteCapError('あ'.repeat(OPERATIONAL_NOTE_MAX))).toBeNull()
    const over = operationalNoteCapError('あ'.repeat(OPERATIONAL_NOTE_MAX + 1))
    expect(over).toContain(String(OPERATIONAL_NOTE_MAX))
    // 接頭辞込みの記録本文がコメント上限に収まる（受付箱コメントとして記録できる）
    expect(improvementCommentError(operationalNoteBody('あ'.repeat(OPERATIONAL_NOTE_MAX)))).toBeNull()
  })
})

describe('AI 判定（improvement-assess = 改修依頼 2026-08-21。API フォールバック = mock と同一ロジック）', () => {
  it('normalizeAssessment: verdict allowlist・reason 必須・docIds は実在 doc のみ', () => {
    expect(normalizeAssessment(null)).toBeNull()
    expect(normalizeAssessment({ verdict: 'bogus', reason: 'x' })).toBeNull()
    expect(normalizeAssessment({ verdict: 'existing', reason: ' ' })).toBeNull()
    const ok = normalizeAssessment({ verdict: 'existing', reason: '打刻修正の機能があります', docIds: ['kb-ug-001', 'kb-nope'] })
    expect(ok).not.toBeNull()
    expect(ok!.verdict).toBe('existing')
    // 実在しない doc id は落とす（捏造防止）。kb-ug-001 の実在は kb.test が保証
    expect(ok!.docIds.every(id => id.startsWith('kb-'))).toBe(true)
    expect(ok!.docIds).not.toContain('kb-nope')
  })
  it('heuristicAssessRequest: 決定的（同一入力 → 同一判定）・短文は unknown', () => {
    const input = { body: '打刻を忘れたときの修正方法を追加してほしい', pageLabel: 'タイムカード' }
    const a = heuristicAssessRequest(input)
    const b = heuristicAssessRequest(input)
    expect(a).toEqual(b)
    expect(['existing', 'workaround', 'improvement', 'unknown']).toContain(a.verdict)
    expect(a.reason.length).toBeGreaterThan(0)
    expect(heuristicAssessRequest({ body: '短い' }).verdict).toBe('unknown')
  })
  it('assessRelatedDocs: 対象ページ・対象箇所も検索クエリに含める（決定的）', () => {
    const hits = assessRelatedDocs({ body: '打刻を忘れた場合の修正がしたい', pageLabel: 'タイムカード' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.score > 0)).toBe(true)
  })
})
