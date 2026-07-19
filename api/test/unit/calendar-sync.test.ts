import { describe, expect, it } from 'vitest'
import { mergeCalendarFetches } from '../../src/routes/calendar'

const ev = (id: string, from = '10:00'): { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string } } => ({
  id,
  summary: id,
  start: { dateTime: `2026-07-19T${from}:00+09:00` },
  end: { dateTime: `2026-07-19T${from.slice(0, 2)}:30:00+09:00` },
})

describe('mergeCalendarFetches（複数カレンダー同期の統合。PR #48 レビューで純関数化）', () => {
  it('複数カレンダーを統合し、同一イベント id は重複排除する（招待で両方に現れるケース）', () => {
    const r = mergeCalendarFetches([
      { ok: true, items: [ev('e1'), ev('e2')] },
      { ok: true, items: [ev('e2'), ev('e3')] },
    ])
    expect(r.timed.map(i => i.id)).toEqual(['e1', 'e2', 'e3'])
    expect(r.failedCals).toBe(0)
    expect(r.truncated).toBe(false)
  })

  it('終日予定（dateTime なし）は対象外', () => {
    const r = mergeCalendarFetches([
      { ok: true, items: [{ id: 'allday' }, ev('e1')] },
    ])
    expect(r.timed.map(i => i.id)).toEqual(['e1'])
  })

  it('一部カレンダーの失敗・打ち切りはフラグ化される（削除フェーズ抑止の判定材料）', () => {
    const r = mergeCalendarFetches([
      { ok: true, items: [ev('e1')] },
      { ok: false },
      { ok: true, items: [ev('e2')], truncated: true },
    ])
    expect(r.failedCals).toBe(1)
    expect(r.truncated).toBe(true)
    expect(r.timed).toHaveLength(2)
  })

  it('見つからないカレンダー（共有解除）は失敗ではなく「予定ゼロ」= 削除フェーズを抑止しない', () => {
    const r = mergeCalendarFetches([
      { ok: true, items: [ev('e1')] },
      { ok: true, missing: true, items: [] },
    ])
    expect(r.failedCals).toBe(0)
    expect(r.missingCals).toBe(1)
    expect(r.timed).toHaveLength(1)
  })
})
