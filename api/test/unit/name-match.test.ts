import { describe, expect, it } from 'vitest'
import {
  findCompanyIn, mentionsCompanyName, normalizeCompanyName, SELF_COMPANY_PATTERN,
} from '../../../shared/domain/name-match'
import { bigramCoverage } from '../../../shared/domain/text-match'

describe('name-match（会社名の正規化照合。オペレーター報告 2026-07-18 #3）', () => {
  it('法人格・空白・全角英数を正規化する', () => {
    expect(normalizeCompanyName('つなぐば株式会社')).toBe('つなぐば')
    expect(normalizeCompanyName('株式会社 アン・ドゥー')).toBe('アン・ドゥー'.toLowerCase())
    expect(normalizeCompanyName('（株）ＡＳ−ＵＰ')).toBe('as−up')
    expect(normalizeCompanyName('㈱テスト 商事')).toBe('テスト商事')
  })

  it('質問文が会社へ言及しているか（実障害:「つなぐばの取引先は?」）', () => {
    expect(mentionsCompanyName('つなぐばの取引先は?', 'つなぐば株式会社')).toBe(true)
    expect(mentionsCompanyName('株式会社しまむらについて', 'しまむら')).toBe(true)
    expect(mentionsCompanyName('今日の天気は?', 'つなぐば株式会社')).toBe(false)
    // 正規化後 2 文字未満は誤爆防止で不一致
    expect(mentionsCompanyName('あについて', '株式会社あ')).toBe(false)
  })

  it('findCompanyIn は最長一致で決定的に選ぶ', () => {
    const companies = [
      { name: 'アパレル商事', aliases: [] },
      { name: 'アパレル商事東京株式会社', aliases: [] },
      { name: '株式会社しまむら', aliases: ['シマムラ'] },
    ]
    expect(findCompanyIn('アパレル商事東京の担当は?', companies)?.name).toBe('アパレル商事東京株式会社')
    expect(findCompanyIn('アパレル商事の担当は?', companies)?.name).toBe('アパレル商事')
    expect(findCompanyIn('シマムラとの取引', companies)?.name).toBe('株式会社しまむら') // 別名でも照合
    expect(findCompanyIn('該当なしの質問', companies)).toBeUndefined()
  })

  it('自社キーワード（弊社・当社を含む）', () => {
    for (const t of ['弊社の取引先は?', '当社の売上', '自社について', 'わが社の方針', 'うちの会社は']) {
      expect(SELF_COMPANY_PATTERN.test(t)).toBe(true)
    }
    expect(SELF_COMPANY_PATTERN.test('顧客の会社について')).toBe(false)
  })
})

describe('text-match（バイグラム被覆率）', () => {
  it('分かち書きなしの日本語で部分的な語彙一致を検出する', () => {
    const doc = '小売業の顧客は在庫回転とシーズン切替の値引きで困る傾向がある'
    expect(bigramCoverage('小売はどんなところで困る傾向がある?', doc)).toBeGreaterThan(0.2)
    expect(bigramCoverage('有給の残りは何日?', doc)).toBeLessThan(0.15)
  })

  it('境界: 2 文字未満・空文字は 0', () => {
    expect(bigramCoverage('あ', 'ドキュメント')).toBe(0)
    expect(bigramCoverage('', 'ドキュメント')).toBe(0)
    expect(bigramCoverage('クエリ', '')).toBe(0)
  })
})
