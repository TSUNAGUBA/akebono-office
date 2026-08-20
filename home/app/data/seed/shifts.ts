/**
 * シフト（F-05）シードデータ（このファイルは担当機能の実装者が所有・拡充する）
 * - sp-0001: 希望受付中の期間（m-10 が 5 日分・m-11 が 3 日分の希望を提出済み）
 * - sp-0002: 公開済みの直近期間（確定割当あり。本人合意フロー検証用の change_requested を 1 件含む）
 * - demands: 受付中期間の平日に必要 1〜2 名（水・金は 2 名体制）
 */
import type { ShiftAssignment, ShiftDemand, ShiftPeriod, ShiftWish } from '~/types/domain'
import { addDays, weekdayOf } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedShiftPeriods: ShiftPeriod[] = [
  { id: 'sp-0001', label: '今月後半シフト', startDate: addDays(today, 3), endDate: addDays(today, 16), wishDeadline: addDays(today, 1), status: 'open' },
  // 直近の公開済み期間（終了間際まで数日残し、確定シフトタブに未来日の割当が見えるようにする）
  { id: 'sp-0002', label: '今月前半シフト', startDate: addDays(today, -11), endDate: addDays(today, 2), wishDeadline: addDays(today, -14), status: 'published' },
]

export const seedShiftWishes: ShiftWish[] = [
  // m-10 村瀬 光: 5 日分提出済み
  { id: 'sw-0001', periodId: 'sp-0001', memberId: 'm-10', date: addDays(today, 3), wish: 'want', from: '10:00', to: '15:00' },
  { id: 'sw-0002', periodId: 'sp-0001', memberId: 'm-10', date: addDays(today, 4), wish: 'want', from: '10:00', to: '16:00' },
  { id: 'sw-0003', periodId: 'sp-0001', memberId: 'm-10', date: addDays(today, 6), wish: 'ng', from: null, to: null },
  { id: 'sw-0004', periodId: 'sp-0001', memberId: 'm-10', date: addDays(today, 8), wish: 'either', from: null, to: null },
  { id: 'sw-0005', periodId: 'sp-0001', memberId: 'm-10', date: addDays(today, 10), wish: 'want', from: '13:00', to: '18:00' },
  // m-11 有田 望（17 歳・深夜割当不可の検証対象）: 3 日分提出済み
  { id: 'sw-0006', periodId: 'sp-0001', memberId: 'm-11', date: addDays(today, 3), wish: 'want', from: '16:00', to: '20:00' },
  { id: 'sw-0007', periodId: 'sp-0001', memberId: 'm-11', date: addDays(today, 5), wish: 'ng', from: null, to: null },
  { id: 'sw-0008', periodId: 'sp-0001', memberId: 'm-11', date: addDays(today, 7), wish: 'either', from: null, to: null },
]

export const seedShiftAssignments: ShiftAssignment[] = [
  // 公開済み期間の確定割当（m-10 村瀬）
  { id: 'sa-0001', periodId: 'sp-0002', memberId: 'm-10', date: addDays(today, -9), from: '10:00', to: '15:00', status: 'confirmed', consentAt: null },
  { id: 'sa-0002', periodId: 'sp-0002', memberId: 'm-10', date: addDays(today, -7), from: '10:00', to: '16:00', status: 'confirmed', consentAt: null },
  { id: 'sa-0003', periodId: 'sp-0002', memberId: 'm-10', date: addDays(today, -4), from: '13:00', to: '18:00', status: 'confirmed', consentAt: null },
  { id: 'sa-0004', periodId: 'sp-0002', memberId: 'm-10', date: addDays(today, -2), from: '10:00', to: '15:00', status: 'confirmed', consentAt: null },
  // 確定後変更の申請中（10:00-15:00 → 11:00-16:00 へ変更依頼。m-10 本人の合意待ち）
  { id: 'sa-0005', periodId: 'sp-0002', memberId: 'm-10', date: addDays(today, 1), from: '11:00', to: '16:00', status: 'change_requested', consentAt: null },
  // 公開済み期間の確定割当（m-11 有田: 17 歳のため深夜帯に掛からない時間帯のみ）
  { id: 'sa-0006', periodId: 'sp-0002', memberId: 'm-11', date: addDays(today, -8), from: '16:00', to: '20:00', status: 'confirmed', consentAt: null },
  { id: 'sa-0007', periodId: 'sp-0002', memberId: 'm-11', date: addDays(today, -5), from: '16:00', to: '21:00', status: 'confirmed', consentAt: null },
  { id: 'sa-0008', periodId: 'sp-0002', memberId: 'm-11', date: addDays(today, 2), from: '16:00', to: '20:00', status: 'confirmed', consentAt: null },
]

/** 受付中期間（sp-0001）の平日に必要人数を設定（水・金は 2 名、それ以外の平日は 1 名） */
function buildOpenPeriodDemands(): ShiftDemand[] {
  const rows: ShiftDemand[] = []
  let seq = 0
  for (let offset = 3; offset <= 16; offset++) {
    const date = addDays(today, offset)
    const dow = weekdayOf(date)
    if (dow === 0 || dow === 6) continue // 土日は募集なし
    seq++
    rows.push({
      id: `sd-${String(seq).padStart(4, '0')}`,
      periodId: 'sp-0001',
      date,
      from: '10:00',
      to: '17:00',
      required: dow === 3 || dow === 5 ? 2 : 1,
    })
  }
  return rows
}

export const seedShiftDemands: ShiftDemand[] = buildOpenPeriodDemands()
