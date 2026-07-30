import { describe, expect, it } from 'vitest'
import { directKindsOf, resolveAttendanceRoute } from '../../../shared/domain/attendance-route'
import type { AttendanceRoute } from '../../../shared/domain/types'

const step = (order: number, approverRole: AttendanceRoute['steps'][number]['approverRole']) => ({
  order, approverRole, approverMemberId: null, mode: 'serial' as const,
})

const route = (id: string, category: AttendanceRoute['category'], steps: AttendanceRoute['steps'], active = true): AttendanceRoute => ({
  id, category, steps, active,
})

describe('resolveAttendanceRoute（勤怠承認経路の解決）', () => {
  it('区分に合致する有効経路のステップを order 昇順で返す', () => {
    const routes = [route('ar-1', 'direct', [step(2, 'hr'), step(1, 'manager')])]
    expect(resolveAttendanceRoute(routes, 'direct')?.map(s => s.approverRole)).toEqual(['manager', 'hr'])
  })

  it('区分違い・無効・空ステップは対象外', () => {
    const routes = [
      route('ar-1', 'fix', [step(1, 'manager')]),
      route('ar-2', 'direct', [step(1, 'manager')], false),
      route('ar-3', 'direct', []),
    ]
    expect(resolveAttendanceRoute(routes, 'direct')).toBeNull()
    expect(resolveAttendanceRoute(routes, 'fix')?.length).toBe(1)
  })

  it('該当なしは null（呼び出し側は管理者単段へフォールバック）', () => {
    expect(resolveAttendanceRoute([], 'direct')).toBeNull()
  })

  it('同一区分に複数の有効経路があればステップ数が多い方を採用（緩い方が勝たない）', () => {
    const routes = [
      route('ar-b', 'direct', [step(1, 'manager')]),
      route('ar-a', 'direct', [step(1, 'manager'), step(2, 'director')]),
    ]
    expect(resolveAttendanceRoute(routes, 'direct')?.length).toBe(2)
  })
})

describe('directKindsOf（直行/直帰が解禁する打刻種別）', () => {
  it('直行=出勤 / 直帰=退勤 / 直行直帰=両方', () => {
    expect(directKindsOf('chokkou')).toEqual(['in'])
    expect(directKindsOf('chokki')).toEqual(['out'])
    expect(directKindsOf('both')).toEqual(['in', 'out'])
  })
})
