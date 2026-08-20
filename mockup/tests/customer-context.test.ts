/**
 * 顧客コンテキスト（改修依頼 2026-08-20）の単体テスト。
 * shared/domain/customer-context は API（routes/customer-contexts.ts）とモック（useCustomerContext）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 * - 入力検証: 定性情報（3 項目すべて空は不可）・メモ本文・採用ソース
 * - AI リサーチの決定的ヒューリスティック: 候補リスト生成（3〜4 件・example.com のデモ URL・
 *   「デモ」明記・ヒント反映）と定性情報の構築（同一入力 = 同一出力・採用順に依存しない）
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_CONTEXT_SOURCES_MAX,
  CUSTOMER_CONTEXT_TEXT_CAP,
  customerContextError, customerContextNoteError, customerContextSourcesError,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeCustomerContext,
} from '../../shared/domain/customer-context'

describe('customerContextError（定性情報の検証）', () => {
  it('いずれかの項目があれば null', () => {
    expect(customerContextError({ vision: 'ビジョン', challenges: '', strategyNotes: '' })).toBeNull()
    expect(customerContextError({ vision: '', challenges: '課題', strategyNotes: '' })).toBeNull()
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: 'メモ' })).toBeNull()
  })
  it('3 項目すべて空（空白のみ含む）はエラー', () => {
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: '' })).not.toBeNull()
    expect(customerContextError({ vision: '  ', challenges: '\n', strategyNotes: ' ' })).not.toBeNull()
  })
  it('normalizeCustomerContext は trim + コードポイント cap', () => {
    const long = 'あ'.repeat(CUSTOMER_CONTEXT_TEXT_CAP + 10)
    const n = normalizeCustomerContext({ vision: `  ${long}  `, challenges: ' x ', strategyNotes: '' })
    expect([...n.vision].length).toBe(CUSTOMER_CONTEXT_TEXT_CAP)
    expect(n.challenges).toBe('x')
  })
})

describe('customerContextNoteError（メモの検証）', () => {
  it('本文必須（空白のみは不可）', () => {
    expect(customerContextNoteError('メモ本文')).toBeNull()
    expect(customerContextNoteError('')).toBe('メモ本文を入力してください')
    expect(customerContextNoteError('   ')).toBe('メモ本文を入力してください')
  })
})

describe('customerContextSourcesError（採用ソースの検証）', () => {
  it('1 件以上・http(s)・上限件数', () => {
    expect(customerContextSourcesError([{ title: 'a', uri: 'https://example.com/a' }])).toBeNull()
    expect(customerContextSourcesError([])).not.toBeNull()
    expect(customerContextSourcesError([{ title: 'a', uri: 'ftp://example.com' }])).not.toBeNull()
    const many = Array.from({ length: CUSTOMER_CONTEXT_SOURCES_MAX + 1 }, (_, i) => ({ title: `${i}`, uri: `https://example.com/${i}` }))
    expect(customerContextSourcesError(many)).not.toBeNull()
  })
})

describe('heuristicResearchCandidates（決定的な候補リスト生成）', () => {
  it('決定性: 同一入力は常に同一出力', () => {
    const a = heuristicResearchCandidates('アケボノ商事', { address: '東京都' })
    const b = heuristicResearchCandidates('アケボノ商事', { address: '東京都' })
    expect(a).toEqual(b)
  })
  it('3〜4 件・https のダミー URL（example.com 系）・タイトルに「デモ」明記', () => {
    for (const name of ['アケボノ商事', 'トクタケ製靴', 'みなみ食品']) {
      const cands = heuristicResearchCandidates(name)
      expect(cands.length).toBeGreaterThanOrEqual(3)
      expect(cands.length).toBeLessThanOrEqual(4)
      for (const c of cands) {
        expect(c.uri).toMatch(/^https:\/\/[a-z.]*example\.com\//)
        expect(c.title).toContain('デモ')
        expect(c.title).toContain(name)
        expect(c.snippet.length).toBeGreaterThan(0)
      }
    }
  })
  it('ヒント（住所・電話・キーワード）が候補の抜粋へ反映される', () => {
    const cands = heuristicResearchCandidates('アケボノ商事', {
      address: '東京都中央区', phone: '03-1234-5678', keywords: '小売 SCM',
    })
    const joined = cands.map(c => c.snippet).join('\n')
    expect(joined).toContain('東京都中央区')
    expect(joined).toContain('03-1234-5678')
    expect(joined).toContain('小売 SCM')
  })
  it('会社が違えば候補 URL も変わる（ハッシュベース）', () => {
    const a = heuristicResearchCandidates('アケボノ商事')[0]!
    const b = heuristicResearchCandidates('トクタケ製靴')[0]!
    expect(a.uri).not.toBe(b.uri)
  })
})

describe('heuristicContextBuild（決定的な定性情報の構築）', () => {
  const sources = [
    { title: '公式サイト', uri: 'https://example.com/company/a/' },
    { title: 'ニュース記事', uri: 'https://news.example.com/articles/b' },
  ]
  const empty = { vision: '', challenges: '', strategyNotes: '' }

  it('決定性: 同一入力は常に同一出力・採用ソースの並び順に依存しない', () => {
    const a = heuristicContextBuild('アケボノ商事', sources, empty)
    const b = heuristicContextBuild('アケボノ商事', sources, empty)
    const reversed = heuristicContextBuild('アケボノ商事', [...sources].reverse(), empty)
    expect(a).toEqual(b)
    expect(a).toEqual(reversed)
  })

  it('3 項目とも空でない値を構築し、補足メモに採用ソース名を含める', () => {
    const built = heuristicContextBuild('アケボノ商事', sources, empty)
    expect(built.vision.length).toBeGreaterThan(0)
    expect(built.challenges.length).toBeGreaterThan(0)
    expect(built.vision).toContain(`${sources.length} 件`)
    expect(built.strategyNotes).toContain('公式サイト')
    expect(built.strategyNotes).toContain('ニュース記事')
    // 経営課題は箇条書き（行頭「・」）
    for (const line of built.challenges.split('\n')) expect(line.startsWith('・')).toBe(true)
  })

  it('既存の登録値がある場合は補足メモで復元可能性（リサーチノート）を案内する', () => {
    const withCurrent = heuristicContextBuild('アケボノ商事', sources, { ...empty, vision: '既存ビジョン' })
    expect(withCurrent.strategyNotes).toContain('復元')
  })
})
