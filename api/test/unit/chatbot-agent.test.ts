/**
 * エージェント型チャット（改修依頼 2026-08-20）の純ロジック。
 * - functionCallsOf: Vertex 応答パーツからの functionCall 抽出（lib/llm。外部 HTTP はテストしない設計）
 * - splitSuggestions: 回答末尾の「提案:」行の抽出（routes/chatbot）
 */
import { describe, expect, it } from 'vitest'
import { functionCallsOf } from '../../src/lib/llm'
import { splitSuggestions } from '../../src/routes/chatbot'

describe('functionCallsOf（functionCall パーツの抽出）', () => {
  it('functionCall パーツのみを抽出し、args 欠落は {} に補う', () => {
    const calls = functionCallsOf([
      { text: '調べます' },
      { functionCall: { name: 'company_info', args: { name: 'つなぐば' } } },
      { functionCall: { name: 'search_internal' } },
    ])
    expect(calls).toEqual([
      { name: 'company_info', args: { name: 'つなぐば' } },
      { name: 'search_internal', args: {} },
    ])
  })

  it('name のない functionCall・パーツなしは無害に落とす（テキスト回答ラウンドの判定に使うため）', () => {
    expect(functionCallsOf(undefined)).toEqual([])
    expect(functionCallsOf([{ text: '回答です' }])).toEqual([])
    expect(functionCallsOf([{ functionCall: { args: { q: 'x' } } }])).toEqual([])
  })
})

describe('splitSuggestions（回答末尾の提案行）', () => {
  it('最終行の「提案: A | B」を suggestions として本文から切り出す', () => {
    const r = splitSuggestions('有給は残り 10 日です。\n詳細は /attendance で確認できます。\n提案: 今月の勤怠は？ | 休暇種別の一覧は？')
    expect(r.content).toBe('有給は残り 10 日です。\n詳細は /attendance で確認できます。')
    expect(r.suggestions).toEqual(['今月の勤怠は？', '休暇種別の一覧は？'])
  })

  it('全角コロン・全角パイプ・3 件超も許容する（3 件まで）', () => {
    const r = splitSuggestions('回答。\n提案： A ｜ B ｜ C ｜ D')
    expect(r.suggestions).toEqual(['A', 'B', 'C'])
  })

  it('提案行がない・途中行の「提案:」は本文のまま + 空配列（クライアントが既定候補を表示）', () => {
    expect(splitSuggestions('回答のみです。')).toEqual({ content: '回答のみです。', suggestions: [] })
    const mid = splitSuggestions('提案: を含む説明\n最終回答です。')
    expect(mid.content).toBe('提案: を含む説明\n最終回答です。')
    expect(mid.suggestions).toEqual([])
  })
})
