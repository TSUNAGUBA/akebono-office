/**
 * ダッシュボード・コックピットの純関数（F-01 改訂「夜明けの管制塔」。SoT: cockpit-design.md §3.1/§3.2）
 * - フェーズ導出（punchState × punchRequired → 今日の状態バッジ）
 * - 次の一手ビルダー buildMoves（§3.2 の優先順位表 1〜9。入力はプリミティブな材料オブジェクト =
 *   composable 非依存でユニットテスト可能。材料収集は useCockpit が担う）
 * - 完了メーター buildMeter（今日の一手のうち完了した割合。分母 0 は非表示 = 分母 0 を祝わない）
 * 決定的・副作用なし。時刻は JST 壁時計の hour（0-23）を呼び出し側から受け取る（Date#getHours 禁止）。
 */
import { fmtDate } from '~/utils/format'

// ---------- フェーズ導出（§3.1） ----------

export type CockpitPunchState = 'before' | 'working' | 'breaking' | 'done'
export type CockpitPhaseKey = 'none' | 'morning' | 'active' | 'break' | 'closed'

export interface CockpitPhase {
  key: CockpitPhaseKey
  /** 業務語ラベル（出勤前 / 勤務中 / 休憩中 / 退勤済み。'none' は空） */
  label: string
  /** lucide アイコン名（'none' は空） */
  icon: string
  tone: 'neutral' | 'ok' | 'warn' | 'info'
}

const PHASES: Record<CockpitPunchState, CockpitPhase> = {
  before: { key: 'morning', label: '出勤前', icon: 'Sunrise', tone: 'neutral' },
  working: { key: 'active', label: '勤務中', icon: 'Sun', tone: 'ok' },
  breaking: { key: 'break', label: '休憩中', icon: 'Coffee', tone: 'warn' },
  done: { key: 'closed', label: '退勤済み', icon: 'MoonStar', tone: 'info' },
}

/** punchRequired=false はフェーズ表示なし（'none'）。それ以外は punchState をフェーズへ写像する */
export function phaseOf(punchRequired: boolean, state: CockpitPunchState): CockpitPhase {
  if (!punchRequired) return { key: 'none', label: '', icon: '', tone: 'neutral' }
  return PHASES[state]
}

// ---------- 次の一手（§3.2） ----------

/** 年5日取得義務のスナップショット（useLeave.obligation の射影。composable 非依存） */
export interface CockpitObligation {
  applicable: boolean
  achieved: boolean
  taken: number
  required: number
  /** 期限までの残日数（負値 = 期限超過） */
  daysLeft: number
  deadline: string
}

export interface CockpitMovesInput {
  // 打刻（フェーズと共通の材料）
  punchRequired: boolean
  punchState: CockpitPunchState
  /** JST 壁時計の時（0-23）。呼び出し側が jstClock() から渡す */
  hour: number
  /** 前営業日以前で「IN あり・OUT なし」の日付（退勤忘れ） */
  unclosedDates: string[]
  /** シフト管理の対象者か（parttime × shift 機能有効。出勤打刻は当日シフトの有無で出し分け） */
  shiftManaged: boolean
  hasTodayShift: boolean
  // 承認（稟議）
  canWorkflow: boolean
  workflowPending: number
  // 勤怠承認（hr/admin）
  hrOrAdmin: boolean
  canAttendance: boolean
  fixRequestPending: number
  leaveRequestPending: number
  // 日報
  /** punchRequired × 非 parttime × canPath('/reports') を呼び出し側で解決済み */
  reportTarget: boolean
  reportSubmittedToday: boolean
  // シフト希望
  /** parttime × shift 有効 × canPath('/shift') を呼び出し側で解決済み */
  shiftStaff: boolean
  /** 募集中（open・締切前）で自分の希望が未提出の期間数 */
  openWishPeriods: number
  /** 募集中（open・締切前）で自分の希望を提出済みの期間数（メーター分母用） */
  submittedWishPeriods: number
  nearestWishDeadline: string | null
  // エスカレーション（hr/admin）
  canInbox: boolean
  openEscalations: number
  // 有給5日義務
  obligation: CockpitObligation | null
}

export interface CockpitMove {
  id: string
  kind: 'punch' | 'approval' | 'report' | 'shift' | 'escalation' | 'leave'
  title: string
  /** 理由 1 行（なぜ今この一手か） */
  reason: string
  to: string
  /** lucide アイコン名 */
  icon: string
  /** 実行ボタンの文言（embed 系は未使用） */
  cta: string
  count?: number
  /** 'punch' = WidgetsPunchClock（flat）を埋め込む（新規の書込パスを作らない。原則9.5） */
  embed?: 'punch'
}

/**
 * 年5日義務のペース超過判定（§3.2 #9）: 残り必要日数が「残り月数 ≒ 月1日ペース」を上回ったら
 * 一手に出す（期限超過も含む）。achieved / 対象外は常に false
 */
export function obligationBehindPace(ob: CockpitObligation | null): boolean {
  if (!ob || !ob.applicable || ob.achieved) return false
  const remaining = ob.required - ob.taken
  if (remaining <= 0) return false
  const monthsLeft = Math.max(0, ob.daysLeft) / 30
  return remaining > monthsLeft
}

/**
 * 次の一手キュー（§3.2 の優先順 1〜9。表示条件をすべて満たす項目のみ・順序は決定的）。
 * 表示スライス（1 大カード + 4 行 + 「ほか N 件」）は表示側の責務
 */
export function buildMoves(input: CockpitMovesInput): CockpitMove[] {
  const moves: CockpitMove[] = []
  const punchEligible = input.punchRequired && (!input.shiftManaged || input.hasTodayShift)

  // 1. 未退勤の打刻（退勤忘れ → 修正申請導線）
  if (input.punchRequired && input.unclosedDates.length > 0) {
    const latest = input.unclosedDates[0] ?? ''
    const n = input.unclosedDates.length
    moves.push({
      id: 'unclosed-punch', kind: 'punch', icon: 'AlarmClockOff',
      title: '退勤打刻が漏れています',
      reason: n === 1
        ? `${fmtDate(latest)} の退勤が未記録です。修正申請で補正してください`
        : `${fmtDate(latest)} ほか ${n} 日分の退勤が未記録です。修正申請で補正してください`,
      to: '/timecard', cta: '修正申請へ', count: n,
    })
  }

  // 2. 出勤打刻（当日シフトあり or シフト非対象）
  if (punchEligible && input.punchState === 'before') {
    moves.push({
      id: 'punch-in', kind: 'punch', icon: 'LogIn',
      title: '出勤を打刻する',
      reason: input.shiftManaged ? '本日のシフトがあります。勤務を始めたら打刻してください' : '今日の勤務を始めたら打刻してください',
      to: '/timecard', cta: '打刻する', embed: 'punch',
    })
  }

  // 3. 退勤打刻（17 時以降・勤務中）
  if (punchEligible && input.punchState === 'working' && input.hour >= 17) {
    moves.push({
      id: 'punch-out', kind: 'punch', icon: 'LogOut',
      title: '退勤を打刻する',
      reason: '17 時を過ぎています。勤務を終えたら退勤を打刻してください',
      to: '/timecard', cta: '打刻する', embed: 'punch',
    })
  }

  // 4. 承認する（稟議・件数束ね）
  if (input.canWorkflow && input.workflowPending > 0) {
    moves.push({
      id: 'approve-workflow', kind: 'approval', icon: 'GitPullRequestArrow',
      title: '稟議を承認する',
      reason: `あなたの承認待ちが ${input.workflowPending} 件あります`,
      to: '/workflow', cta: '稟議を開く', count: input.workflowPending,
    })
  }

  // 5. 勤怠承認（打刻修正・休暇。hr/admin）
  const attendanceApprovals = input.fixRequestPending + input.leaveRequestPending
  if (input.hrOrAdmin && input.canAttendance && attendanceApprovals > 0) {
    moves.push({
      id: 'approve-attendance', kind: 'approval', icon: 'ClipboardCheck',
      title: '勤怠の申請を承認する',
      reason: `打刻修正 ${input.fixRequestPending} 件・休暇 ${input.leaveRequestPending} 件が承認待ちです`,
      to: '/attendance?tab=requests', cta: '承認画面へ', count: attendanceApprovals,
    })
  }

  // 6. 日報を書く（12 時以降・当日分未提出）
  if (input.reportTarget && !input.reportSubmittedToday && input.hour >= 12) {
    moves.push({
      id: 'write-report', kind: 'report', icon: 'NotebookPen',
      title: '今日の日報を書く',
      reason: '本日分の日報がまだ提出されていません',
      to: '/reports', cta: '日報を書く',
    })
  }

  // 7. シフト希望を出す（募集中・未提出・締切前）
  if (input.shiftStaff && input.openWishPeriods > 0) {
    moves.push({
      id: 'shift-wish', kind: 'shift', icon: 'CalendarRange',
      title: 'シフト希望を出す',
      reason: input.nearestWishDeadline
        ? `募集中の期間があります（締切 ${fmtDate(input.nearestWishDeadline)}）`
        : '募集中の期間があります',
      to: '/shift', cta: '希望を出す', count: input.openWishPeriods,
    })
  }

  // 8. エスカレーション対応（hr/admin）
  if (input.hrOrAdmin && input.canInbox && input.openEscalations > 0) {
    moves.push({
      id: 'escalations', kind: 'escalation', icon: 'Inbox',
      title: 'エスカレーションに対応する',
      reason: `未対応のエスカレーションが ${input.openEscalations} 件あります`,
      to: '/inbox', cta: '対応する', count: input.openEscalations,
    })
  }

  // 9. 有給5日義務（残必要日数 > 残月数ペース）
  if (input.canAttendance && obligationBehindPace(input.obligation)) {
    const ob = input.obligation!
    moves.push({
      id: 'leave-obligation', kind: 'leave', icon: 'CalendarHeart',
      title: '有給休暇を取得する',
      reason: `年5日義務まであと ${ob.required - ob.taken} 日（期限 ${fmtDate(ob.deadline)}）`,
      to: '/attendance?tab=leave', cta: '休暇を申請',
    })
  }

  return moves
}

// ---------- 完了メーター（§3.1） ----------

export interface CockpitMeter {
  done: number
  total: number
  /** done / total（total=0 は 0） */
  ratio: number
  /** total=0 の日は非表示（分母 0 を祝わない） */
  visible: boolean
}

/** キュー型（ゼロが正常）の一手 id。デイリーデューティ（完了状態を持つ）以外はこの集合 */
const DUTY_MOVE_IDS = new Set(['punch-in', 'punch-out', 'write-report', 'shift-wish'])

/**
 * 今日の完了メーター = 「今日の一手（buildMoves の対象）のうち完了した割合」。
 * - デイリーデューティ（出勤・退勤・日報・シフト希望）は完了後も分母に残る（消化が進捗として見える）
 * - キュー型（承認・エスカレーション等）はゼロが正常のため、未処理がある間だけ分母に入る
 */
export function buildMeter(input: CockpitMovesInput): CockpitMeter {
  let total = 0
  let done = 0
  const duty = (eligible: boolean, completed: boolean): void => {
    if (!eligible) return
    total++
    if (completed) done++
  }
  const punchEligible = input.punchRequired && (!input.shiftManaged || input.hasTodayShift)
  duty(punchEligible, input.punchState !== 'before')
  // 退勤デューティは「一手として出せる状態」（勤務中 × 17 時以降）か完了時のみ分母に入れる
  // （休憩中は退勤打刻の一手が出ないため、分母に入れると moves=0 と矛盾する）
  duty(
    punchEligible && (input.punchState === 'done' || (input.punchState === 'working' && input.hour >= 17)),
    input.punchState === 'done',
  )
  duty(input.reportTarget && (input.hour >= 12 || input.reportSubmittedToday), input.reportSubmittedToday)
  duty(input.shiftStaff && input.openWishPeriods + input.submittedWishPeriods > 0, input.openWishPeriods === 0)
  // キュー型: 未処理の一手 1 件 = 分母 +1（done は増えない）
  total += buildMoves(input).filter(m => !DUTY_MOVE_IDS.has(m.id)).length
  return { done, total, ratio: total > 0 ? done / total : 0, visible: total > 0 }
}

// ---------- 表示ヘルパ（計器・予報の値表示） ----------

/** 予報・計器の単位付き値表示（landing-forecast の reason と同じ丸め系） */
export function fmtCockpitValue(n: number, unit: 'currency' | 'percent' | 'hours'): string {
  if (unit === 'currency') return `${(Math.round(n / 1000) / 10).toLocaleString('ja-JP')}万円`
  if (unit === 'percent') return `${Math.round(n * 10) / 10}%`
  return `${Math.round(n * 10) / 10}h`
}

// ---------- 計器の型（useCockpit → CockpitInstruments の契約） ----------

export interface CockpitInstrumentItem {
  id: string
  label: string
  value: string
  sub?: string
  delta?: number | null
  inverse?: boolean
  /** lucide アイコン名 */
  icon?: string
  to?: string
}

export interface CockpitInstrumentGroup {
  id: string
  label: string
  /** グループ見出し右のリンク（例: 経営計器 → 会社全体ダッシュボード） */
  link?: { label: string; to: string }
  items: CockpitInstrumentItem[]
}
