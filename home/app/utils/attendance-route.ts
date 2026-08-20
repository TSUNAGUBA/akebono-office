/**
 * 勤怠承認経路の解決（純粋関数）。実体は shared/domain/attendance-route.ts（API と共有）。
 * 既存 import パス互換のための再エクスポート。
 */
export { resolveAttendanceRoute, directKindsOf } from '../../../shared/domain/attendance-route'
