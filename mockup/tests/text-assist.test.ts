/**
 * 「AIで整形」（改修依頼 2026-08-20）の決定的整形（shared/domain/text-assist）。
 * mock モードの唯一のロジックであり、API モードの LLM 失敗時フォールバックでもある（両モード parity）。
 */
import { describe, expect, it } from 'vitest'
import { FORMAT_TEXT_CAP, heuristicFormatRequestText } from '../../shared/domain/text-assist'

describe('heuristicFormatRequestText（決定的整形）', () => {
  it('空・空白のみの入力はそのまま返す', () => {
    expect(heuristicFormatRequestText('')).toBe('')
    expect(heuristicFormatRequestText('   ')).toBe('   ')
  })

  it('決定的（同じ入力 → 同じ出力。乱数・時刻に依存しない）', () => {
    const input = '要望：ボタンを大きく\n現状：小さい\n改善：+2px'
    expect(heuristicFormatRequestText(input)).toBe(heuristicFormatRequestText(input))
  })

  it('連続空行は 1 行に圧縮（段落の区切りは残す）・行末空白と先頭/末尾の空行を除去する', () => {
    expect(heuristicFormatRequestText('\n\nA。  \n\n\n\nB。\n\n')).toBe('A。\n\nB。')
  })

  it('箇条書きの行頭マーク（・ / - / *）を「- 」へ統一する', () => {
    expect(heuristicFormatRequestText('・項目い\n- 項目ろ\n* 項目は')).toBe('- 項目い\n- 項目ろ\n- 項目は')
  })

  it('要望：/現状：/改善：のラベル行があれば節として整形する（節の前に空行・半角コロンは全角へ統一）', () => {
    const out = heuristicFormatRequestText('要望: ボタンを大きくしたい\n現状：小さくて押しにくい\n改善：+2px にする')
    expect(out).toBe('要望：ボタンを大きくしたい\n\n現状：小さくて押しにくい\n\n改善：+2px にする')
  })

  it('ラベル行の下に続く内容行は文分割せず保持する（節として整形）', () => {
    const out = heuristicFormatRequestText('要望：\n一覧を見やすく。合計も出す。\n改善：\n・強調表示')
    expect(out).toBe('要望：\n一覧を見やすく。合計も出す。\n\n改善：\n- 強調表示')
  })

  it('ラベルが無いテキストは文単位（。！？）で改行を整理する', () => {
    expect(heuristicFormatRequestText('一覧が見づらい。合計も欲しい！できれば早めに？お願いします'))
      .toBe('一覧が見づらい。\n合計も欲しい！\nできれば早めに？\nお願いします')
    // 末尾の句点では余計な空行を作らない
    expect(heuristicFormatRequestText('直したい。')).toBe('直したい。')
  })

  it('CAP（FORMAT_TEXT_CAP / 本文 4000 字）超過分も切らない（切り詰めは送信時の検証が担う）', () => {
    const long = `要望：${'あ'.repeat(FORMAT_TEXT_CAP)}`
    expect([...heuristicFormatRequestText(long)].length).toBeGreaterThan(FORMAT_TEXT_CAP)
  })

  it('CRLF 改行も LF として扱う', () => {
    expect(heuristicFormatRequestText('要望：A\r\n現状：B')).toBe('要望：A\n\n現状：B')
  })
})
