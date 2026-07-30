/**
 * 勤怠承認経路の解決（純粋関数・Vue 非依存）。
 * 稟議の approval-route.ts と同型だが、金額帯ではなく「区分（direct/fix）」だけで経路を選ぶ。
 * フロント（useAttendance）と API（routes/attendance.ts）で共有し、両モードの挙動を一致させる。
 */
import type {
  AttendanceRequestCategory, AttendanceRoute, AttendanceRouteStep, DirectType, PunchKind,
} from './types'

/**
 * 区分に合致する有効な経路の承認ステップ（order 昇順）を返す。
 * 該当が無ければ null（呼び出し側は管理者 1 名の単段承認へフォールバックする）。
 * 同一区分に複数の有効経路がある場合はステップ数が多い（= より厳格な）定義を採用する
 * （運用ミスで複数登録されても「緩い方が勝つ」事故を避ける決定的タイブレーク）。
 */
export function resolveAttendanceRoute(
  routes: AttendanceRoute[],
  category: AttendanceRequestCategory,
): AttendanceRouteStep[] | null {
  const candidates = routes
    .filter(r => r.active && r.category === category && r.steps.length > 0)
    .sort((a, b) => b.steps.length - a.steps.length || a.id.localeCompare(b.id))
  const hit = candidates[0]
  if (!hit) return null
  return [...hit.steps].sort((a, b) => a.order - b.order)
}

/**
 * 直行/直帰の種別が「打刻修正を申請できる打刻種別」を返す。
 * chokkou（直行）= 出勤(in) / chokki（直帰）= 退勤(out) / both（直行直帰）= 両方。
 * 直行/直帰は所定の休憩・退勤/出勤以外の打刻には影響しない（in/out のみ対象）。
 */
export function directKindsOf(type: DirectType): PunchKind[] {
  if (type === 'chokkou') return ['in']
  if (type === 'chokki') return ['out']
  return ['in', 'out']
}
