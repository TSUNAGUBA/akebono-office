/**
 * note 連携の純粋関数の単体テスト。
 * - noteConnectionInputOf / notePostPatchOf: 部分更新は「body に実在するキーのみ」（Object.hasOwn。
 *   CLAUDE.md の Zod v4 注意への回帰テスト = 送っていないフィールドが更新対象に含まれないこと）
 * - normalizeNoteContents: 非公式 API 応答の型崩れ防御（仕様変更時に落ちずに空へ縮退）
 * - publishedPostUpdates: 公開検知は pushed → published の一方向（巻き戻しなし = 記録保護）
 * - foldNoteSnapshots / heuristicNoteFeedback: 期間内デルタの算出とフォールバックの決定性
 * - noteHtmlOf: マークダウン → note エディタ HTML（エスケープ含む）
 * - normalizeNoteFeedback: LLM 出力の欠落・型崩れは null = ヒューリスティックへフォールバック
 */
import { describe, expect, it } from 'vitest'
import { normalizeNoteContents } from '../../src/lib/note-api'
import { insightHintsOf } from '../../src/routes/media'
import {
  normalizeNoteFeedback, noteConnectionInputOf, notePostPatchOf,
  publishedDateOf, publishedPostUpdates,
} from '../../src/routes/note-media'
import {
  foldNoteSnapshots, heuristicNoteFeedback, noteHtmlOf, type NoteSnapshotRow,
} from '../../../shared/domain/note-media'

describe('noteConnectionInputOf（連携設定の入力）', () => {
  it('body に実在するキーのみを返す（未送信フィールドの保持）', () => {
    const input = noteConnectionInputOf({ urlname: 'tsunaguba' })
    expect(input).toEqual({ urlname: 'tsunaguba' })
    expect(Object.hasOwn(input, 'sessionCookie')).toBe(false)
  })

  it('urlname は @ 前置を剥がし、不正形式は AKO-MEDIA-031', () => {
    expect(noteConnectionInputOf({ urlname: '@yama_da1' }).urlname).toBe('yama_da1')
    expect(() => noteConnectionInputOf({ urlname: 'a b' })).toThrowError(/urlname/)
    expect(() => noteConnectionInputOf({ urlname: '' })).toThrowError(/urlname/)
    expect(() => noteConnectionInputOf({ urlname: 'https://note.com/x' })).toThrowError(/urlname/)
  })

  it('sessionCookie は「名前=値」貼り付けから値部分を抽出し、空は明示的クリアとして通す', () => {
    expect(noteConnectionInputOf({ sessionCookie: '_note_session_v5=abc123; Path=/' }).sessionCookie).toBe('abc123')
    expect(noteConnectionInputOf({ sessionCookie: ' raw-value ' }).sessionCookie).toBe('raw-value')
    expect(noteConnectionInputOf({ sessionCookie: '' }).sessionCookie).toBe('')
  })
})

describe('notePostPatchOf（記事原稿の部分更新）', () => {
  it('送ったキーのみ返す = 未指定フィールドは更新対象に含まれない', () => {
    const patch = notePostPatchOf({ title: ' 新タイトル ' })
    expect(patch).toEqual({ title: '新タイトル' })
    expect(Object.hasOwn(patch, 'body')).toBe(false)
    expect(Object.hasOwn(patch, 'noteKey')).toBe(false)
  })

  it('title の空更新は AKO-MEDIA-035 / body の空は「明示的な空」として通す', () => {
    expect(() => notePostPatchOf({ title: '  ' })).toThrowError(/タイトル/)
    expect(notePostPatchOf({ body: '' })).toEqual({ body: '' })
  })

  it('noteKey は英数字のみ・空はリンク解除として通す', () => {
    expect(notePostPatchOf({ noteKey: 'n4d7f8b9bd84a' })).toEqual({ noteKey: 'n4d7f8b9bd84a' })
    expect(notePostPatchOf({ noteKey: '' })).toEqual({ noteKey: '' })
    expect(() => notePostPatchOf({ noteKey: 'n/abc' })).toThrowError(/noteKey/)
  })
})

describe('normalizeNoteContents（非公式 API 応答の防御的パース）', () => {
  it('正常応答から key / title / 反応数を取り出す', () => {
    const { items, isLastPage } = normalizeNoteContents({
      data: {
        contents: [
          { key: 'n1abc', name: ' 記事A ', likeCount: 12, commentCount: 3, publishAt: '2026-08-01T09:00:00+09:00', noteUrl: 'https://note.com/x/n/n1abc' },
          { key: 'n2def', name: '記事B', likeCount: '5', commentCount: null },
        ],
        isLastPage: false,
      },
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'n1abc', title: '記事A', likeCount: 12, commentCount: 3 })
    expect(items[1]).toMatchObject({ key: 'n2def', likeCount: 5, commentCount: 0 })
    expect(isLastPage).toBe(false)
  })

  it('型崩れ（仕様変更）は空 + 最終ページ扱いへ縮退する（無限ページング防止）', () => {
    expect(normalizeNoteContents(null)).toEqual({ items: [], isLastPage: true })
    expect(normalizeNoteContents({ data: { contents: 'broken' } })).toEqual({ items: [], isLastPage: true })
    // key のない要素は捨てる
    expect(normalizeNoteContents({ data: { contents: [{ name: 'no key' }], isLastPage: true } }).items).toEqual([])
  })
})

describe('publishedPostUpdates（同期の公開検知）', () => {
  const contents = [
    { key: 'nAAA', title: 'A', likeCount: 1, commentCount: 0, publishAt: '2026-08-10T12:00:00+09:00', noteUrl: 'https://note.com/x/n/nAAA' },
  ]

  it('note_key の一致した未公開投稿が published 対象（手動紐付けの local_draft 含む・既公開は巻き戻さない）', () => {
    const updates = publishedPostUpdates(
      [
        { id: 'p1', status: 'pushed', noteKey: 'nAAA' },
        { id: 'p2', status: 'pushed', noteKey: 'nZZZ' },     // note 側に未公開
        { id: 'p3', status: 'local_draft', noteKey: 'nAAA' }, // 手動公開の記事を noteKey で紐付けたケース
        { id: 'p4', status: 'published', noteKey: 'nAAA' },   // 既公開は再更新しない
        { id: 'p5', status: 'pushed', noteKey: '' },          // キー未採番
      ],
      contents)
    expect(updates).toEqual([
      { id: 'p1', publishedAt: '2026-08-10', noteUrl: 'https://note.com/x/n/nAAA' },
      { id: 'p3', publishedAt: '2026-08-10', noteUrl: 'https://note.com/x/n/nAAA' },
    ])
  })

  it('publishAt が読めない場合は publishedAt=null（欠測 ≠ 巻き戻し）', () => {
    expect(publishedDateOf('')).toBeNull()
    expect(publishedDateOf('broken')).toBeNull()
    expect(publishedDateOf('2026-08-10T12:00:00+09:00')).toBe('2026-08-10')
  })
})

const snap = (noteKey: string, snapshotDate: string, likeCount: number, commentCount = 0, title = 'T'): NoteSnapshotRow =>
  ({ noteKey, snapshotDate, title, likeCount, commentCount, viewCount: null })

describe('foldNoteSnapshots（期間集計）', () => {
  it('期間内の最古と最新の差をデルタとして算出し、増分の大きい順に並べる', () => {
    const summary = foldNoteSnapshots([
      snap('a', '2026-08-01', 10), snap('a', '2026-08-10', 15, 2, '記事A'),
      snap('b', '2026-08-01', 30), snap('b', '2026-08-10', 31, 0, '記事B'),
    ], '2026-08-01', '2026-08-12')
    expect(summary.articles.map(a => a.noteKey)).toEqual(['a', 'b'])
    expect(summary.articles[0]).toMatchObject({ likeCount: 15, likeDelta: 5, commentDelta: 2, title: '記事A' })
    expect(summary.totalLikes).toBe(46)
    expect(summary.totalLikeDelta).toBe(6)
  })

  it('スナップショット 1 点のみの記事はデルタ 0（デルタ判定不能を増分と誤認しない）', () => {
    const summary = foldNoteSnapshots([snap('a', '2026-08-10', 100)], '2026-08-01', '2026-08-12')
    expect(summary.articles[0]).toMatchObject({ likeCount: 100, likeDelta: 0, snapshots: 1 })
  })

  it('期間外の行は無視する（多重防御）', () => {
    const summary = foldNoteSnapshots([
      snap('a', '2026-07-01', 1), snap('a', '2026-08-05', 8),
    ], '2026-08-01', '2026-08-12')
    expect(summary.articles[0]).toMatchObject({ likeDelta: 0, snapshots: 1 })
  })
})

describe('heuristicNoteFeedback（決定的フォールバック）', () => {
  it('集計から決定的に生成し、反応上位を win / 停滞記事を issue にする', () => {
    const summary = foldNotesForFeedback()
    const fb = heuristicNoteFeedback(summary)
    expect(fb.executiveSummary).toContain('スキ計')
    expect(fb.articles.some(f => f.kind === 'win' && f.title.includes('記事A'))).toBe(true)
    expect(fb.articles.some(f => f.kind === 'issue')).toBe(true)
    expect(fb.actions.length).toBeGreaterThan(0)
    expect(fb.nextTopics[0]).toContain('記事A')
    // 決定性: 同じ入力からは同じ出力
    expect(heuristicNoteFeedback(summary)).toEqual(fb)
  })

  it('データなしでも生成が案内文で成立する（例外にしない = 原則4）', () => {
    const fb = heuristicNoteFeedback(foldNoteSnapshots([], '2026-08-01', '2026-08-12'))
    expect(fb.executiveSummary).toContain('反応データがありません')
    expect(fb.actions.length).toBeGreaterThan(0)
  })

  function foldNotesForFeedback() {
    return foldNoteSnapshots([
      snap('a', '2026-08-01', 10, 1, '記事A'), snap('a', '2026-08-10', 20, 3, '記事A'),
      snap('b', '2026-08-01', 5, 0, '記事B'), snap('b', '2026-08-10', 5, 0, '記事B'),
    ], '2026-08-01', '2026-08-12')
  }
})

describe('noteHtmlOf（マークダウン → note エディタ HTML）', () => {
  it('見出し・箇条書き・引用・強調・段落を変換する（# → h2 / ##・### → h3）', () => {
    const html = noteHtmlOf('# タイトル\n\n本文の**強調**です。\n\n## 見出し\n- 項目1\n- 項目2\n\n> 引用文')
    expect(html).toBe(
      '<h2>タイトル</h2><p>本文の<strong>強調</strong>です。</p><h3>見出し</h3>'
      + '<ul><li>項目1</li><li>項目2</li></ul><blockquote>引用文</blockquote>')
  })

  it('HTML はエスケープする（本文由来のタグ注入を防ぐ）', () => {
    expect(noteHtmlOf('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('リスト末尾・空行の扱い（リストは閉じてから次のブロックへ）', () => {
    expect(noteHtmlOf('- a\n段落')).toBe('<ul><li>a</li></ul><p>段落</p>')
    expect(noteHtmlOf('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
  })
})

describe('normalizeNoteFeedback（LLM 出力の防御）', () => {
  it('executiveSummary 欠落・型崩れは null（ヒューリスティックへフォールバック）', () => {
    expect(normalizeNoteFeedback(null)).toBeNull()
    expect(normalizeNoteFeedback({})).toBeNull()
    expect(normalizeNoteFeedback({ executiveSummary: '  ' })).toBeNull()
  })

  it('kind / priority の不正値は既定へ丸め、件数上限を適用する', () => {
    const fb = normalizeNoteFeedback({
      executiveSummary: '要約',
      articles: [{ kind: 'hack', title: 'A', detail: 'd' }, { title: '', detail: 'skip' }],
      actions: [{ title: 'act', detail: 'd', priority: 'urgent' }],
      nextTopics: ['t1', '', 42, ...Array.from({ length: 10 }, (_, i) => `x${i}`)],
    })
    expect(fb).not.toBeNull()
    expect(fb!.articles).toEqual([{ kind: 'opportunity', title: 'A', detail: 'd' }])
    expect(fb!.actions[0]!.priority).toBe('mid')
    expect(fb!.nextTopics.length).toBeLessThanOrEqual(5)
    expect(fb!.nextTopics[0]).toBe('t1')
  })
})

describe('insightHintsOf × note フィードバック（記事生成 fromInsightId の接続点）', () => {
  it('nextTopics を最優先でヒント化する（win のみのフィードバックでもヒントが空にならない）', () => {
    expect(insightHintsOf({
      articles: [{ kind: 'win', title: '勝ち記事' }],
      nextTopics: ['「記事A」の深掘り・続編', 'テーマ案2'],
    })).toEqual(['「記事A」の深掘り・続編', 'テーマ案2'])
  })

  it('nextTopics + issue/opportunity は合計 3 件まで（topics 優先）', () => {
    expect(insightHintsOf({
      articles: [{ kind: 'issue', title: '課題' }, { kind: 'opportunity', title: '機会' }],
      nextTopics: ['t1', 't2'],
    })).toEqual(['t1', 't2', '課題'])
  })

  it('nextTopics を持たない media インサイトは従来挙動のまま（下位互換）', () => {
    expect(insightHintsOf({ articles: [{ kind: 'opportunity', title: '機会' }, { kind: 'win', title: '勝ち' }] }))
      .toEqual(['機会'])
  })
})
