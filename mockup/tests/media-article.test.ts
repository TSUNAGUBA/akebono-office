/**
 * AI 記事生成（決定的テンプレート合成）の回帰テスト。
 * 目的・質・雰囲気の指定が出力へ反映されること、決定的であることを検証する。
 */
import { describe, expect, it } from 'vitest'
import { generateArticleDraft, type ArticleGenInput } from '../../shared/domain/media-article'

const base: ArticleGenInput = {
  topic: '作家ものの器の選び方',
  keyword: '陶磁器 選び方',
  purpose: 'seo',
  quality: 'standard',
  tone: 'friendly',
  audience: '器好きの30代',
  siteName: 'テストメディア',
  segmentName: '陶磁器委託販売',
}

describe('generateArticleDraft', () => {
  it('決定的（同じ入力なら同じ出力）', () => {
    expect(generateArticleDraft(base)).toEqual(generateArticleDraft(base))
  })

  it('タイトルにお題を含む', () => {
    expect(generateArticleDraft(base).title).toContain('作家ものの器の選び方')
  })

  it('記事の質でセクション数が変わる（draft=3 / standard=5+ / premium=7）', () => {
    expect(generateArticleDraft({ ...base, quality: 'draft' }).outline).toHaveLength(3)
    expect(generateArticleDraft({ ...base, quality: 'premium' }).outline).toHaveLength(7)
    expect(generateArticleDraft({ ...base, quality: 'standard' }).outline.length).toBeGreaterThanOrEqual(5)
  })

  it('本文はマークダウン見出しで始まる', () => {
    expect(generateArticleDraft(base).body.startsWith('# ')).toBe(true)
  })

  it('質が高いほど推定文字数が多い', () => {
    const d = generateArticleDraft({ ...base, quality: 'draft' }).estWordCount
    const s = generateArticleDraft({ ...base, quality: 'standard' }).estWordCount
    const p = generateArticleDraft({ ...base, quality: 'premium' }).estWordCount
    expect(d).toBeLessThan(s)
    expect(s).toBeLessThan(p)
  })

  it('品質スコアは 0〜100 で、premium は draft より高い', () => {
    const d = generateArticleDraft({ ...base, quality: 'draft' }).qualityScore
    const p = generateArticleDraft({ ...base, quality: 'premium' }).qualityScore
    expect(d).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(100)
    expect(p).toBeGreaterThan(d)
  })

  it('お題が空でもキーワードから補完してタイトルを作る', () => {
    const r = generateArticleDraft({ ...base, topic: '' })
    expect(r.title).toContain('陶磁器 選び方')
  })

  it('分析ヒントを与えると本文に反映される', () => {
    const r = generateArticleDraft({ ...base, insightHints: ['サービス配下のCVRが高い'] })
    expect(r.body).toContain('アクセス分析')
  })

  it('CV 目的では CTA を含む', () => {
    const r = generateArticleDraft({ ...base, purpose: 'conversion' })
    expect(r.body).toContain('お問い合わせ')
  })

  it('提案キーワードにベースキーワードを含む', () => {
    expect(generateArticleDraft(base).suggestedKeywords).toContain('陶磁器 選び方')
  })
})
