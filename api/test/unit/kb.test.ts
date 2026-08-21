/**
 * AI ナレッジベース（shared/domain/kb）の検証。
 * - ドキュメントのメタ整合（id 一意・命名規則・カテゴリ整合・pagePaths・related の実在）
 * - kbFindRelated の決定性と代表クエリの妥当性（RAG・改善要望 AI 判定の知識源としての最低品質）
 * home/tests/kb.test.ts と同一 SoT を両側から import して検証する（パリティ）。
 */
import { describe, expect, it } from 'vitest'
import {
  KB_DOCS, KB_FAQ_DOCS, KB_MIN_SCORE, KB_OPS_GUIDE_DOCS, KB_SPEC_DOCS, KB_USER_GUIDE_DOCS,
  kbDocById, kbFindRelated, kbSearchText, type KbCategory,
} from '../../../shared/domain/kb/index'

const PREFIX_OF: Record<KbCategory, string> = {
  'spec': 'sp',
  'user-guide': 'ug',
  'ops-guide': 'og',
  'troubleshooting': 'ts',
  'faq': 'faq',
}

describe('KB ドキュメントのメタ整合', () => {
  it('id が命名規則 kb-{sp|ug|og|ts|faq}-{3桁} に従い一意', () => {
    const ids = KB_DOCS.map(d => d.id)
    for (const id of ids) expect(id).toMatch(/^kb-(sp|ug|og|ts|faq)-\d{3}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('category と id プレフィクスが整合', () => {
    for (const d of KB_DOCS) {
      expect(d.id.startsWith('kb-' + PREFIX_OF[d.category] + '-')).toBe(true)
    }
  })

  it('KB_DOCS は全カテゴリの結合（id 昇順）', () => {
    const total = KB_SPEC_DOCS.length + KB_USER_GUIDE_DOCS.length + KB_OPS_GUIDE_DOCS.length + KB_FAQ_DOCS.length
    expect(KB_DOCS.length).toBe(total)
    const ids = KB_DOCS.map(d => d.id)
    expect(ids).toEqual([...ids].sort())
    // 規模の目安（1 doc = 1 トピック。カテゴリごとに空でない）
    expect(KB_DOCS.length).toBeGreaterThanOrEqual(35)
    expect(KB_SPEC_DOCS.length).toBeGreaterThan(0)
    expect(KB_USER_GUIDE_DOCS.length).toBeGreaterThan(0)
    expect(KB_OPS_GUIDE_DOCS.length).toBeGreaterThan(0)
    expect(KB_FAQ_DOCS.some(d => d.category === 'troubleshooting')).toBe(true)
    expect(KB_FAQ_DOCS.some(d => d.category === 'faq')).toBe(true)
  })

  it('pagePaths は "/" 始まりの実在形式・keywords は 5〜12 語', () => {
    for (const d of KB_DOCS) {
      for (const p of d.pagePaths) {
        expect(p.startsWith('/')).toBe(true)
        expect(p).not.toMatch(/\s/)
      }
      expect(d.keywords.length).toBeGreaterThanOrEqual(5)
      expect(d.keywords.length).toBeLessThanOrEqual(12)
    }
  })

  it('body が非空で最低長を満たし、メタが固定値', () => {
    for (const d of KB_DOCS) {
      expect(d.title.length).toBeGreaterThan(0)
      expect(d.body.trim().length).toBeGreaterThanOrEqual(150)
      expect(d.body).toContain('# ')
      expect(d.version).toBe('1.0')
      expect(d.lastUpdated).toBe('2026-08-21')
      expect(['end-user', 'ops-admin', 'both']).toContain(d.audience)
      expect(d.feature.length).toBeGreaterThan(0)
    }
  })

  it('related の参照先が実在し自己参照しない', () => {
    for (const d of KB_DOCS) {
      for (const rid of d.related) {
        expect(kbDocById(rid), d.id + ' -> ' + rid).toBeDefined()
        expect(rid).not.toBe(d.id)
      }
    }
  })
})

describe('kbDocById', () => {
  it('実在 id で取得でき、未知 id は undefined', () => {
    const first = KB_DOCS[0]!
    expect(kbDocById(first.id)?.id).toBe(first.id)
    expect(kbDocById('kb-sp-999')).toBeUndefined()
    expect(kbDocById('')).toBeUndefined()
  })
})

describe('kbFindRelated（決定的な字句検索）', () => {
  it('空クエリ・空白のみは []', () => {
    expect(kbFindRelated('')).toEqual([])
    expect(kbFindRelated('   ')).toEqual([])
  })

  it('同一入力 → 同一出力（決定性）', () => {
    const a = kbFindRelated('日報 提出 方法')
    const b = kbFindRelated('日報 提出 方法')
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('score 降順・閾値未満は除外・limit 既定 5', () => {
    const hits = kbFindRelated('勤怠 打刻 労働時間')
    expect(hits.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    }
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(KB_MIN_SCORE)
    expect(kbFindRelated('勤怠 打刻 労働時間', 2).length).toBeLessThanOrEqual(2)
  })

  it('無関係な文字列は根拠として返さない', () => {
    expect(kbFindRelated('zzqqxxwwvv')).toEqual([])
  })

  it('「打刻 忘れた」→ troubleshooting の該当 doc が最上位', () => {
    const hits = kbFindRelated('打刻 忘れた')
    expect(hits[0]?.doc.id).toBe('kb-ts-001')
    expect(hits[0]?.doc.category).toBe('troubleshooting')
  })

  it('「改善要望 送り方」→ user-guide の該当 doc が最上位', () => {
    const hits = kbFindRelated('改善要望 送り方')
    expect(hits[0]?.doc.id).toBe('kb-ug-007')
    expect(hits[0]?.doc.category).toBe('user-guide')
  })

  it('「休暇 申請」→ user-guide の休暇申請 doc が最上位', () => {
    const hits = kbFindRelated('休暇 申請')
    expect(hits[0]?.doc.id).toBe('kb-ug-004')
  })
})

describe('kbSearchText（RAG 素材化）', () => {
  it('タイトルと本文を含む索引用テキストを返す', () => {
    const doc = kbDocById('kb-sp-001')!
    const text = kbSearchText(doc)
    expect(text).toContain(doc.title)
    expect(text).toContain(doc.body)
  })
})
