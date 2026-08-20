/**
 * 項目カスタマイズ一覧ヘルパー（F-31 全アプリ展開 2026-08-10）の純関数テスト。
 * fmtCustomValue = カスタム項目値の一覧表示整形（型別・空値）。
 */
import { describe, expect, it } from 'vitest'
import { fmtCustomValue } from '~/composables/useAppListView'
import { fmtDate } from '~/utils/format'
import type { CustomFieldDef, CustomFieldType } from '~/types/domain'

const def = (fieldType: CustomFieldType): CustomFieldDef => ({
  id: 'cf-1', entity: 'product', key: 'k', label: 'L', fieldType, options: [], required: false, displayOrder: 1, active: true,
})

describe('fmtCustomValue（カスタム項目値の一覧表示整形）', () => {
  it('空値は「—」（null / undefined / 空文字 / 空配列）', () => {
    expect(fmtCustomValue(def('text'), '')).toBe('—')
    expect(fmtCustomValue(def('text'), null)).toBe('—')
    expect(fmtCustomValue(def('number'), undefined)).toBe('—')
    expect(fmtCustomValue(def('multiselect'), [])).toBe('—')
  })
  it('型別に整形する', () => {
    expect(fmtCustomValue(def('boolean'), true)).toBe('はい')
    expect(fmtCustomValue(def('boolean'), false)).toBe('いいえ')
    expect(fmtCustomValue(def('multiselect'), ['赤', '青'])).toBe('赤・青')
    expect(fmtCustomValue(def('date'), '2026-08-10')).toBe(fmtDate('2026-08-10'))
    expect(fmtCustomValue(def('number'), 12300)).toBe('12300')
    expect(fmtCustomValue(def('select'), 'A')).toBe('A')
    expect(fmtCustomValue(def('text'), 'abc')).toBe('abc')
  })
})
