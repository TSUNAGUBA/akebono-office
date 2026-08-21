/**
 * 顧客コンテキスト（改修依頼 2026-08-20）の単体テスト。
 * shared/domain/customer-context は API（routes/customer-contexts.ts）とモック（useCustomerContext）の
 * **パリティの SoT**。ここでの検証が両者の挙動を同時に固定する。
 * - 入力検証: 定性情報（4 項目すべて空は不可。事業メモ = 2026-08-21 追加）・メモ本文・採用ソース
 * - 反映取消の復元値構築（restoreContextFromSnapshot = 旧スナップショットは現在の事業メモを保持）
 * - AI リサーチの決定的ヒューリスティック: 候補リスト生成（3〜4 件・example.com のデモ URL・
 *   「デモ」明記・ヒント反映）と定性情報の構築（同一入力 = 同一出力・採用順に依存しない）
 */
import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_CONTEXT_SOURCES_MAX,
  CUSTOMER_CONTEXT_TEXT_CAP,
  customerContextError, customerContextNoteError, customerContextSourcesError,
  extractPhoneFromSnippets,
  groundResearchPhone,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeContextPhone,
  normalizeCustomerContext, restoreContextFromSnapshot,
} from '../../shared/domain/customer-context'

describe('customerContextError（定性情報の検証）', () => {
  it('いずれかの項目があれば null（事業メモ = 2026-08-21 追加も対象）', () => {
    expect(customerContextError({ vision: 'ビジョン', challenges: '', strategyNotes: '' })).toBeNull()
    expect(customerContextError({ vision: '', challenges: '課題', strategyNotes: '' })).toBeNull()
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: 'メモ' })).toBeNull()
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: '', businessNotes: '昨季売上高: 10 億円' })).toBeNull()
  })
  it('4 項目すべて空（空白のみ含む）はエラー（メッセージに事業メモを含む）', () => {
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: '' }))
      .toBe('ビジョン・経営課題・補足メモ・事業メモのいずれかを入力してください')
    expect(customerContextError({ vision: '  ', challenges: '\n', strategyNotes: ' ', businessNotes: ' ' })).not.toBeNull()
  })
  it('normalizeCustomerContext は trim + コードポイント cap。businessNotes 未定義 = ""（旧データ互換 = 原則7）', () => {
    const long = 'あ'.repeat(CUSTOMER_CONTEXT_TEXT_CAP + 10)
    const n = normalizeCustomerContext({ vision: `  ${long}  `, challenges: ' x ', strategyNotes: '' })
    expect([...n.vision].length).toBe(CUSTOMER_CONTEXT_TEXT_CAP)
    expect(n.challenges).toBe('x')
    expect(n.businessNotes).toBe('') // 未定義（旧データ・旧クライアント）は '' へ
    expect(normalizeCustomerContext({ vision: '', challenges: '', strategyNotes: '', businessNotes: ` ${long} ` }).businessNotes.length)
      .toBe(CUSTOMER_CONTEXT_TEXT_CAP)
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
  const empty = { vision: '', challenges: '', strategyNotes: '', businessNotes: '' }

  it('決定性: 同一入力は常に同一出力・採用ソースの並び順に依存しない', () => {
    const a = heuristicContextBuild('アケボノ商事', sources, empty)
    const b = heuristicContextBuild('アケボノ商事', sources, empty)
    const reversed = heuristicContextBuild('アケボノ商事', [...sources].reverse(), empty)
    expect(a).toEqual(b)
    expect(a).toEqual(reversed)
  })

  it('4 項目とも空でない値を構築し、補足メモに採用ソース名を含める', () => {
    const built = heuristicContextBuild('アケボノ商事', sources, empty)
    expect(built.vision.length).toBeGreaterThan(0)
    expect(built.challenges.length).toBeGreaterThan(0)
    expect(built.vision).toContain(`${sources.length} 件`)
    expect(built.strategyNotes).toContain('公式サイト')
    expect(built.strategyNotes).toContain('ニュース記事')
    // 経営課題は箇条書き（行頭「・」）
    for (const line of built.challenges.split('\n')) expect(line.startsWith('・')).toBe(true)
    // 事業メモ（2026-08-21）: 実数値を創作しない定型ファクト（「デモ」明記）の箇条書き
    expect(built.businessNotes.length).toBeGreaterThan(0)
    expect(built.businessNotes).toContain('デモ')
    for (const line of built.businessNotes.split('\n')) expect(line.startsWith('・')).toBe(true)
  })

  it('既存の登録値がある場合は補足メモで復元可能性（リサーチノート）を案内する', () => {
    const withCurrent = heuristicContextBuild('アケボノ商事', sources, { ...empty, vision: '既存ビジョン' })
    expect(withCurrent.strategyNotes).toContain('復元')
  })

  it('電話番号（第3弾）: 採用ソースの抜粋に実在する記載だけを提案し、無ければ空（創作しない）', () => {
    // 抜粋なし = 電話番号は提案しない（LLM フォールバックでも架空の番号をマスタへ書かない安全側）
    expect(heuristicContextBuild('アケボノ商事', sources, empty).phone).toBe('')
    // 会社概要の抜粋に代表電話がある（= 調査ヒントに電話番号を入れたデモ経路）→ そのまま抽出
    const withPhone = [
      { title: '公式サイト', uri: 'https://example.com/company/a/' },
      { title: '会社概要', uri: 'https://example.com/company/a/about', snippet: '会社概要ページ（デモ）。代表電話: 03-0000-0100。' },
    ]
    expect(heuristicContextBuild('アケボノ商事', withPhone, empty).phone).toBe('03-0000-0100')
  })
})

describe('電話番号の抽出・正規化（第3弾 = AI 反映の材料）', () => {
  it('extractPhoneFromSnippets: 日本の電話番号らしい並びを最初の 1 件だけ返す・全角ハイフン/長音符も受ける', () => {
    expect(extractPhoneFromSnippets(['代表電話: 03-1234-5678。FAX: 03-1234-5679'])).toBe('03-1234-5678')
    expect(extractPhoneFromSnippets([undefined, 'TEL 011ー000ー0040（代表）'])).toBe('011-000-0040')
    expect(extractPhoneFromSnippets(['TEL 03－1234－5678（全角ハイフン）'])).toBe('03-1234-5678')
    expect(extractPhoneFromSnippets(['電話番号の記載なし', ''])).toBe('')
    expect(extractPhoneFromSnippets([])).toBe('')
  })
  it('extractPhoneFromSnippets: 日付範囲の部分一致を電話番号と誤認しない（前後の数字・区切りを除外）', () => {
    expect(extractPhoneFromSnippets(['受付期間 2026-08-01-2026-08-31'])).toBe('')
    expect(extractPhoneFromSnippets(['注文番号 12303-1234-5678 の件'])).toBe('')
  })
  it('normalizeContextPhone: trim + 上限 cap・非文字列は空へ', () => {
    expect(normalizeContextPhone('  03-1111-2222 ')).toBe('03-1111-2222')
    expect(normalizeContextPhone(undefined)).toBe('')
    expect([...normalizeContextPhone('0'.repeat(100))].length).toBe(40)
  })
})

describe('groundResearchPhone（LLM 提案の事後検証 = 創作防止の構造的担保。レビュー R1）', () => {
  const sources = [
    { title: '会社概要', uri: 'https://example.com/about', snippet: '会社概要ページ。代表電話: 03-1234-5678。' },
    { title: 'ニュース', uri: 'https://example.com/news' },
  ]
  it('LLM の値が採用ソースの title/抜粋に実在する場合のみ採用する', () => {
    expect(groundResearchPhone('03-1234-5678', sources)).toBe('03-1234-5678')
  })
  it('実在しない値（幻覚の可能性）は抜粋からの抽出へフォールバック → 実在する記載を返す', () => {
    expect(groundResearchPhone('06-9999-0000', sources)).toBe('03-1234-5678')
  })
  it('抜粋にも記載がなければ空（電話番号を創作しない）', () => {
    const noPhone = [{ title: 'ニュース', uri: 'https://example.com/news', snippet: '記事本文' }]
    expect(groundResearchPhone('06-9999-0000', noPhone)).toBe('')
    expect(groundResearchPhone('', noPhone)).toBe('')
  })
})

describe('restoreContextFromSnapshot（反映取消の復元値 = API/mock 共通の単一実装）', () => {
  it('スナップショットの値をそのまま復元する（通常の取消）', () => {
    const r = restoreContextFromSnapshot(
      { vision: 'v', challenges: 'c', strategyNotes: 's', businessNotes: 'b' }, '現在の事業メモ')
    expect(r).toEqual({ vision: 'v', challenges: 'c', strategyNotes: 's', businessNotes: 'b' })
  })
  it('旧スナップショット（businessNotes キーなし = 0084 以前）は現在の事業メモを保持する（原則7）', () => {
    const r = restoreContextFromSnapshot({ vision: 'v', challenges: '', strategyNotes: '' }, '現在の事業メモ')
    expect(r.businessNotes).toBe('現在の事業メモ')
    expect(r.vision).toBe('v')
  })
  it('新スナップショットの businessNotes: \'\' は \'\' へ復元する（キー有無で判定 = 空文字は保持しない）', () => {
    const r = restoreContextFromSnapshot(
      { vision: 'v', challenges: '', strategyNotes: '', businessNotes: '' }, '現在の事業メモ')
    expect(r.businessNotes).toBe('')
  })
  it('欠落した他項目は空へ・値は正規化（trim）される', () => {
    const r = restoreContextFromSnapshot({ vision: '  v  ' }, '')
    expect(r).toEqual({ vision: 'v', challenges: '', strategyNotes: '', businessNotes: '' })
  })
})
