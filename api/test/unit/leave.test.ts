/** 休暇残数 FIFO・失効・40 日上限（法定のみ）・年5日義務・失効日算出の単体テスト */
import { describe, expect, it } from 'vitest'
import type { LeaveGrant, LeaveRequest, LeaveType } from '../../../shared/domain/types'
import { calcLeaveBalance, calcObligation, expireDateFor } from '../../src/domain/leave'

const statutory: LeaveType = {
  id: 'lt-paid', name: '有給休暇', grantMethod: 'periodic', expiryMonths: 24,
  isStatutory: true, description: '', displayOrder: 1, active: true,
}
const special: LeaveType = {
  id: 'lt-summer', name: '夏季休暇', grantMethod: 'manual', expiryMonths: 3,
  isStatutory: false, description: '', displayOrder: 2, active: true,
}

function grant(over: Partial<LeaveGrant>): LeaveGrant {
  return {
    id: 'g', memberId: 'm-01', leaveTypeId: 'lt-paid', grantDate: '2025-04-01',
    days: 10, kind: 'normal', expireDate: '2027-04-01', grantedBy: null, ...over,
  }
}

function req(over: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: 'r', memberId: 'm-01', leaveTypeId: 'lt-paid', date: '2025-06-01',
    unit: 'full', status: 'approved', reason: '', decidedBy: 'm-99', ...over,
  }
}

describe('calcLeaveBalance', () => {
  it('FIFO で古い付与から引当てる', () => {
    const b = calcLeaveBalance(
      [grant({ id: 'g1', grantDate: '2024-04-01', days: 5, expireDate: '2026-04-01' }),
        grant({ id: 'g2', grantDate: '2025-04-01', days: 10 })],
      [req({ date: '2025-05-01' }), req({ date: '2025-05-02', unit: 'half' })],
      statutory, '2025-06-01',
    )
    expect(b.allocations[0]?.consumed).toBe(1.5)
    expect(b.remaining).toBe(13.5)
  })

  it('失効した付与は残数に含めない・nextExpire は未失効の最古', () => {
    const b = calcLeaveBalance(
      [grant({ id: 'g1', grantDate: '2023-04-01', days: 10, expireDate: '2025-04-01' }),
        grant({ id: 'g2', grantDate: '2024-04-01', days: 10, expireDate: '2026-04-01' })],
      [], statutory, '2025-06-01',
    )
    expect(b.remaining).toBe(10)
    expect(b.nextExpire).toEqual({ date: '2026-04-01', days: 10 })
  })

  it('取得日時点で失効している付与へは引当てない（失効前の消化のみ引当）', () => {
    const b = calcLeaveBalance(
      [grant({ id: 'g1', grantDate: '2023-04-01', days: 10, expireDate: '2025-04-01' })],
      [req({ date: '2025-05-01' })], // 失効後の消化 → 引当先なし = 防御的に無視
      statutory, '2025-06-01',
    )
    expect(b.remaining).toBe(0)
    expect(b.allocations[0]?.consumed).toBe(0)
  })

  it('保有上限 40 日は法定有給のみ適用', () => {
    const grants = [
      grant({ id: 'g1', grantDate: '2024-04-01', days: 30, expireDate: '2026-04-01' }),
      grant({ id: 'g2', grantDate: '2025-04-01', days: 30, expireDate: '2027-04-01' }),
    ]
    expect(calcLeaveBalance(grants, [], statutory, '2025-06-01').remaining).toBe(40)
    expect(calcLeaveBalance(
      grants.map(g => ({ ...g, leaveTypeId: 'lt-summer' })), [], special, '2025-06-01',
    ).remaining).toBe(60)
  })

  it('今年度（4 月起算）の取得日数を数える', () => {
    const b = calcLeaveBalance(
      [grant({ days: 10 })],
      [req({ date: '2025-03-31' }), req({ date: '2025-04-01' }), req({ date: '2025-05-01', unit: 'half' })],
      statutory, '2025-06-01',
    )
    expect(b.usedThisFiscalYear).toBe(1.5)
  })
})

describe('calcObligation', () => {
  it('10 日以上の直近付与から 1 年で 5 日未達なら warn（期限 3 ヶ月前）', () => {
    const o = calcObligation(
      [grant({ grantDate: '2024-10-01', days: 10 })],
      [req({ date: '2024-11-01' })],
      '2025-08-01',
    )
    expect(o.applicable).toBe(true)
    expect(o.deadline).toBe('2025-10-01')
    expect(o.taken).toBe(1)
    expect(o.achieved).toBe(false)
    expect(o.warn).toBe(true)
  })

  it('10 日未満の付与のみなら対象外', () => {
    const o = calcObligation([grant({ days: 5 })], [], '2025-06-01')
    expect(o.applicable).toBe(false)
  })
})

describe('expireDateFor', () => {
  it('期限なし（null）は 9999-12-31', () => {
    expect(expireDateFor(null, '2025-07-01')).toBe('9999-12-31')
  })
  it('月数を加算する（JS setMonth 規約 = mockup と同一）', () => {
    expect(expireDateFor(3, '2025-07-01')).toBe('2025-10-01')
    expect(expireDateFor(24, '2025-04-01')).toBe('2027-04-01')
  })
})
