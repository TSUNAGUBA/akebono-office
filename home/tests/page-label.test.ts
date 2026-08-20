/**
 * ページパス → 名称の解決（改善要望の表示。パスだけでなく名称も出す）。
 */
import { describe, expect, it } from 'vitest'
import { pageDisplay, resolvePageLabel } from '../app/utils/page-label'

describe('resolvePageLabel', () => {
  it('トップ機能・マスタ・前方一致で名称を解決', () => {
    expect(resolvePageLabel('/inbox')).toBe('通知・エスカレーション')
    expect(resolvePageLabel('/timecard')).toBe('タイムカード')
    expect(resolvePageLabel('/masters/members')).toBe('メンバー')
    // 2 階層目のサブページも nav-map の導線ラベルで固有名に解決（改善要望 2026-08-17。従来は前方一致で 'AKEBONO'）
    expect(resolvePageLabel('/akebono/sales')).toBe('売上管理')
    expect(resolvePageLabel('/akebono/unknown-sub')).toBe(resolvePageLabel('/akebono')) // 未知のサブページは前方一致
  })
  it('未知のパスはパスそのもの', () => {
    expect(resolvePageLabel('/totally/unknown')).toBe('/totally/unknown')
    expect(resolvePageLabel('')).toBe('')
  })
})

describe('pageDisplay', () => {
  it('名称（パス）形式・未解決はパスのみ', () => {
    expect(pageDisplay('/inbox')).toBe('通知・エスカレーション（/inbox）')
    expect(pageDisplay('/totally/unknown')).toBe('/totally/unknown')
  })
})
