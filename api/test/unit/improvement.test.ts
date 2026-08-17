import { describe, expect, it } from 'vitest'
import {
  buildCodingPrompt,
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
  IMPROVEMENT_LINKS_MAX,
  IMPROVEMENT_NOTE_CAP,
  IMPROVEMENT_REQUEST_ADOPTION_META,
  IMPROVEMENT_REQUEST_STATUS_META,
  improvementImagesError,
  improvementLinksError,
  improvementNoteError,
  IMPROVEMENT_STATUS_NEXT,
  matchesImprovementFilter,
  normalizeClusterPlan,
  normalizeImprovementImages,
  normalizeImprovementLinks,
  requestAdoptionOf,
  requestStatusOf,
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

describe('要望ステータス（requestStatusOf / buildCodingPrompt の再生成反映。2026-08-17）', () => {
  it('status 未定義（旧データ）は open として扱う（下位互換 = 原則7）', () => {
    expect(requestStatusOf({})).toBe('open')
    expect(requestStatusOf({ status: null })).toBe('open')
    expect(requestStatusOf({ status: 'resolved' })).toBe('resolved')
    expect(IMPROVEMENT_REQUEST_STATUS_META.open.label).toBe('未対応')
  })
  it('resolved / dismissed の要望は【対応済み】【見送り】として明記され、注意書きが入る', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [
        { pageLabel: 'X', pagePath: '/x', body: '直したい A' },
        { pageLabel: 'X', pagePath: '/x', body: '直したい B', status: 'resolved' },
        { pageLabel: 'X', pagePath: '/x', body: '直したい C', status: 'dismissed' },
      ],
    }])
    expect(prompt).toContain('【対応済み】 直したい B')
    expect(prompt).toContain('【見送り】 直したい C')
    expect(prompt).not.toContain('【未対応】') // open は無印
    expect(prompt).toContain('再改修しないこと')
  })
  it('全要望が open なら注意書き・タグを出さない（従来プロンプトと同一 = 下位互換）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('【')
    expect(prompt).not.toContain('再改修しないこと')
  })
})

describe('要望の選別（requestAdoptionOf。2026-08-17 第 2 弾）', () => {
  it('adoption 未定義（旧データ）は集約済みなら adopted・未集約なら pending（下位互換 = 原則7）', () => {
    expect(requestAdoptionOf({})).toBe('pending')
    expect(requestAdoptionOf({ adoption: null, itemId: null })).toBe('pending')
    expect(requestAdoptionOf({ itemId: 'imp-1' })).toBe('adopted')
  })
  it('adoption 明示値を優先する（不正値は無視して補完）', () => {
    expect(requestAdoptionOf({ adoption: 'declined', itemId: null })).toBe('declined')
    expect(requestAdoptionOf({ adoption: 'pending', itemId: null })).toBe('pending')
    expect(requestAdoptionOf({ adoption: 'bogus' as never, itemId: 'imp-1' })).toBe('adopted')
  })
  it('選別メタは 未選別/採用/不採用 のラベルと tone を持つ', () => {
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.pending.label).toBe('未選別')
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.adopted).toMatchObject({ label: '採用', tone: 'ok' })
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.declined).toMatchObject({ label: '不採用', tone: 'warn' })
  })
  it('clusterTargetRequests は未集約・有効・採用済みのみ選ぶ（mock 集約と generate SQL の共有条件 = 原則6）', () => {
    const rows = [
      { id: 'a', itemId: null, archivedAt: null, adoption: 'adopted' as const },
      { id: 'b', itemId: null, archivedAt: null, adoption: 'pending' as const },
      { id: 'c', itemId: null, archivedAt: null, adoption: 'declined' as const },
      { id: 'd', itemId: 'imp-1', archivedAt: null, adoption: 'adopted' as const }, // 集約済みは対象外
      { id: 'e', itemId: null, archivedAt: '2026-08-17T00:00:00+09:00', adoption: 'adopted' as const }, // 取消済みは対象外
      { id: 'f', itemId: null, archivedAt: null }, // 旧データ（adoption 未定義 = 未選別扱い）も対象外
    ]
    expect(clusterTargetRequests(rows).map(r => r.id)).toEqual(['a'])
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
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい', links: ['https://ref.example/doc'], imageCount: 2 }],
    }])
    expect(prompt).toContain('参考リンク: https://ref.example/doc')
    expect(prompt).toContain('添付画像 2 件')
  })
  it('添付が無ければ言及しない（旧呼び出しの下位互換）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('参考リンク')
    expect(prompt).not.toContain('添付画像')
  })
})

describe('improvementRequestInputOf', () => {
  it('trim + ページ情報を保持・空本文は AKO-REQ-001・添付未指定は空配列', () => {
    expect(improvementRequestInputOf({ body: ' 直したい ', pagePath: '/x', pageLabel: 'X' }))
      .toEqual({ body: '直したい', pagePath: '/x', pageLabel: 'X', links: [], images: [] })
    let code = ''
    try { improvementRequestInputOf({ body: '  ' }) } catch (e) { code = (e as { code?: string }).code ?? '' }
    expect(code).toBe('AKO-REQ-001')
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
