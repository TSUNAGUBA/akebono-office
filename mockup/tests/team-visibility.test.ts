/**
 * チームタブの表示メンバー判定（バッチ7k: utils/team-visibility.ts）。
 * - 設定未設定の既定: マトリクス = 社員・契約・アルバイト / タイムライン = 全員（従来どおり）
 * - 設定あり: マトリクス・タイムラインとも「選択メンバー + 自分」で統一
 */
import { describe, expect, it } from 'vitest'
import {
  isDefaultTeamVisible, matrixVisible, parseTeamVisibleIds, timelineVisibleWith,
} from '../app/utils/team-visibility'

describe('parseTeamVisibleIds', () => {
  it('未設定・空文字は null（既定表示）', () => {
    expect(parseTeamVisibleIds('')).toBeNull()
  })

  it('JSON 配列を Set にする（文字列以外の要素は無視）', () => {
    expect(parseTeamVisibleIds('["m1","m2"]')).toEqual(new Set(['m1', 'm2']))
    expect(parseTeamVisibleIds('["m1", 2, null]')).toEqual(new Set(['m1']))
  })

  it('空配列・非配列・不正 JSON は null（既定表示へフォールバック）', () => {
    expect(parseTeamVisibleIds('[]')).toBeNull()
    expect(parseTeamVisibleIds('{"a":1}')).toBeNull()
    expect(parseTeamVisibleIds('[2, null]')).toBeNull()
    expect(parseTeamVisibleIds('not json')).toBeNull()
  })
})

describe('isDefaultTeamVisible', () => {
  it('社員・契約・アルバイトは既定表示の対象', () => {
    expect(isDefaultTeamVisible('employee')).toBe(true)
    expect(isDefaultTeamVisible('contract')).toBe(true)
    expect(isDefaultTeamVisible('parttime')).toBe(true)
  })

  it('取締役・外注は既定表示の対象外（設定で選択したときのみ表示）', () => {
    expect(isDefaultTeamVisible('director')).toBe(false)
    expect(isDefaultTeamVisible('outsource')).toBe(false)
  })
})

describe('matrixVisible', () => {
  const emp = { id: 'm1', employmentType: 'employee' as const }
  const dir = { id: 'd1', employmentType: 'director' as const }
  const out = { id: 'o1', employmentType: 'outsource' as const }

  it('設定未設定は雇用区分の既定に従う（取締役・外注は自分でも非表示 = 従来どおり）', () => {
    expect(matrixVisible(null, emp, 'm1')).toBe(true)
    expect(matrixVisible(null, dir, 'x')).toBe(false)
    expect(matrixVisible(null, out, 'x')).toBe(false)
    expect(matrixVisible(null, dir, 'd1')).toBe(false)
  })

  it('設定ありは選択メンバーのみ表示（取締役・外注も選択すれば表示 = バッチ7k）', () => {
    const ids = new Set(['d1'])
    expect(matrixVisible(ids, dir, 'x')).toBe(true)
    expect(matrixVisible(ids, emp, 'x')).toBe(false)
    expect(matrixVisible(ids, out, 'x')).toBe(false)
  })

  it('設定ありでも自分は常に表示（自分の提出状況を見失わない）', () => {
    const ids = new Set(['d1'])
    expect(matrixVisible(ids, emp, 'm1')).toBe(true)
  })
})

describe('timelineVisibleWith', () => {
  it('設定未設定は全員表示（従来どおり。参照権限 F-16-6 は呼び出し側で別途適用）', () => {
    expect(timelineVisibleWith(null, 'anyone', 'me', true)).toBe(true)
    expect(timelineVisibleWith(null, 'retired', 'me', false)).toBe(true)
  })

  it('設定ありは選択メンバー + 自分のみ表示（在籍中の取締役・外注も選択どおり = バッチ7k）', () => {
    const ids = new Set(['m1'])
    expect(timelineVisibleWith(ids, 'm1', 'me', true)).toBe(true)
    expect(timelineVisibleWith(ids, 'd1', 'me', true)).toBe(false)
    expect(timelineVisibleWith(ids, 'me', 'me', true)).toBe(true)
  })

  it('候補に出ない在籍外（退職者等）は設定の影響外 = 常に表示（PR #61 R1 M-1）', () => {
    const ids = new Set(['m1'])
    expect(timelineVisibleWith(ids, 'retired', 'me', false)).toBe(true)
  })
})
