/**
 * 顧客コンテキスト（改修依頼 2026-08-20）の純ロジック単体テスト（API 側）。
 * shared/domain/customer-context は API（routes/customer-contexts.ts）とモック（useCustomerContext）の
 * **パリティの SoT**。検証順・メッセージ・ヒューリスティックの決定性を API 側からも固定する
 * （home/tests/customer-context.test.ts と対）。
 */
import { describe, expect, it } from 'vitest'
import {
  customerContextError, customerContextNoteError, customerContextSourcesError,
  extractPhoneFromSnippets,
  groundResearchPhone,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeCustomerContext, restoreContextFromSnapshot,
} from '../../../shared/domain/customer-context'

describe('顧客コンテキストの入力検証（API パリティ）', () => {
  it('定性情報: いずれかの項目があれば null・すべて空はエラー（事業メモ = 2026-08-21 追加も対象）', () => {
    expect(customerContextError({ vision: 'v', challenges: '', strategyNotes: '' })).toBeNull()
    // 事業メモのみでも保存できる（4 項目のいずれか）
    expect(customerContextError({ vision: '', challenges: '', strategyNotes: '', businessNotes: '昨季売上高: 10 億円' })).toBeNull()
    expect(customerContextError({ vision: ' ', challenges: '', strategyNotes: '' }))
      .toBe('ビジョン・経営課題・補足メモ・事業メモのいずれかを入力してください')
  })
  it('メモ本文は必須', () => {
    expect(customerContextNoteError('本文')).toBeNull()
    expect(customerContextNoteError(' ')).toBe('メモ本文を入力してください')
  })
  it('採用ソースは 1 件以上・http(s) のみ', () => {
    expect(customerContextSourcesError([{ title: 't', uri: 'http://example.com' }])).toBeNull()
    expect(customerContextSourcesError([])).toBe('採用する情報源を 1 件以上選択してください')
    expect(customerContextSourcesError([{ title: 't', uri: 'javascript:alert(1)' }]))
      .toBe('情報源の URL が正しくありません（http/https のみ）')
  })
  it('正規化は trim（部分更新のマージ値にも適用される = 空白だけの上書きを防ぐ）。businessNotes 未定義 = ""（原則7）', () => {
    expect(normalizeCustomerContext({ vision: ' v ', challenges: '', strategyNotes: '' }).vision).toBe('v')
    // 旧データ（businessNotes 未定義）は '' へ正規化（下位互換 = 原則7）
    expect(normalizeCustomerContext({ vision: 'v', challenges: '', strategyNotes: '' }).businessNotes).toBe('')
    expect(normalizeCustomerContext({ vision: '', challenges: '', strategyNotes: '', businessNotes: ' b ' }).businessNotes).toBe('b')
  })
})

describe('AI リサーチのヒューリスティック（LLM 無効時のフォールバック = 原則4）', () => {
  it('候補リストは決定的で 3〜4 件・example.com のデモ URL', () => {
    const a = heuristicResearchCandidates('テクノパーツ工業', { keywords: '生産管理' })
    const b = heuristicResearchCandidates('テクノパーツ工業', { keywords: '生産管理' })
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThanOrEqual(3)
    expect(a.length).toBeLessThanOrEqual(4)
    for (const c of a) {
      expect(c.uri).toMatch(/^https:\/\/[a-z.]*example\.com\//)
      expect(c.title).toContain('デモ')
    }
  })
  it('構築は決定的で採用ソースの並び順に依存しない', () => {
    const sources = [
      { title: 'B', uri: 'https://example.com/b' },
      { title: 'A', uri: 'https://example.com/a' },
    ]
    const empty = { vision: '', challenges: '', strategyNotes: '', businessNotes: '' }
    const x = heuristicContextBuild('テクノパーツ工業', sources, empty)
    const y = heuristicContextBuild('テクノパーツ工業', [...sources].reverse(), empty)
    expect(x).toEqual(y)
    expect(x.vision.length).toBeGreaterThan(0)
    expect(x.challenges.length).toBeGreaterThan(0)
    expect(x.strategyNotes).toContain('A')
    expect(x.strategyNotes).toContain('B')
    // 事業メモ（2026-08-21）: デモは実数値を創作しない定型ファクト（「デモ」明記）を決定的に返す
    expect(x.businessNotes.length).toBeGreaterThan(0)
    expect(x.businessNotes).toContain('デモ')
  })

  it('電話番号（第3弾）: 抜粋に実在する記載だけを提案・無ければ空（創作しない = API フォールバックでも安全）', () => {
    const empty = { vision: '', challenges: '', strategyNotes: '', businessNotes: '' }
    const sources = [{ title: 'A', uri: 'https://example.com/a' }]
    expect(heuristicContextBuild('テクノパーツ工業', sources, empty).phone).toBe('')
    const withSnippet = [{ title: 'A', uri: 'https://example.com/a', snippet: '代表電話: 052-000-1234' }]
    expect(heuristicContextBuild('テクノパーツ工業', withSnippet, empty).phone).toBe('052-000-1234')
    expect(extractPhoneFromSnippets(['本文に番号なし'])).toBe('')
  })

  it('groundResearchPhone（LLM 事後検証・レビュー R1）: ソースに実在する値のみ採用・幻覚は抽出 → 空へ', () => {
    const src = [{ title: '会社概要', uri: 'https://example.com/a', snippet: '代表電話: 052-000-1234' }]
    expect(groundResearchPhone('052-000-1234', src)).toBe('052-000-1234')
    expect(groundResearchPhone('090-9999-9999', src)).toBe('052-000-1234') // 幻覚 → 実在記載へフォールバック
    expect(groundResearchPhone('090-9999-9999', [{ title: 'A', uri: 'https://example.com/b' }])).toBe('')
  })
})

describe('restoreContextFromSnapshot（反映取消の復元値 = API/mock 共通の単一実装）', () => {
  it('旧スナップショット（businessNotes キーなし）は現在の事業メモを保持・新スナップショットの \'\' は \'\' へ復元（原則7）', () => {
    const legacy = restoreContextFromSnapshot({ vision: 'v', challenges: 'c', strategyNotes: '' }, '現在の事業メモ')
    expect(legacy).toEqual({ vision: 'v', challenges: 'c', strategyNotes: '', businessNotes: '現在の事業メモ' })
    const explicit = restoreContextFromSnapshot(
      { vision: 'v', challenges: '', strategyNotes: '', businessNotes: '' }, '現在の事業メモ')
    expect(explicit.businessNotes).toBe('')
  })
})
