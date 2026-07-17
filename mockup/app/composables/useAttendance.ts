/**
 * 勤怠（打刻・日次/月次集計・36 協定アラート・修正申請）
 * - モックモード: 集計ロジックは utils/attendance-calc.ts の純粋関数に委譲する
 * - API モード（バッチ2b-2）: 集計はサーバーサイド（/v1/attendance/*）。月単位のサマリキャッシュを
 *   SoT とし、日次・週次は月キャッシュから射影する（60h 超判定の月累計を保つ = サーバーと同一）。
 *   書込（打刻・修正申請・承認）は API を呼んでからキャッシュを取り直す（原則6）。
 *   未ロード時はゼロサマリを返し、到着後にリアクティブに追従する。
 */
import type { Ref } from 'vue'
import type { AttendanceFixRequest, PunchKind, PunchRecord, Result } from '~/types/domain'
import {
  calcWorkedMinutes, effectivePunches, judgeArticle36, requiredBreakMinutes, splitBuckets,
  type Article36Alert, type MonthOtRecord,
} from '~/utils/attendance-calc'
import { daysInMonth, weekdayOf } from '~/utils/format'
import { PUNCH_KIND_LABELS } from '~/utils/labels'

export type PunchState = 'before' | 'working' | 'breaking' | 'done'

export interface DaySummary {
  date: string
  workMinutes: number
  breakMinutes: number
  nightMinutes: number
  buckets: ReturnType<typeof splitBuckets>
  breakShortage: number
  punches: PunchRecord[]
}

export interface MonthSummaryData {
  days: DaySummary[]
  total: ReturnType<typeof splitBuckets>
  workDays: number
}

export interface TimecardApiRow {
  memberId: string
  name: string
  departmentId: string
  date: string
  inAt: string | null
  outAt: string | null
  workMinutes: number
  breakMinutes: number
}

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiMonths = ref<Record<string, MonthSummaryData>>({})
const apiAlertsMap = ref<Record<string, Article36Alert[]>>({})
const apiRawDays = ref<Record<string, PunchRecord[]>>({})
const apiPunchState = ref<{ state: PunchState; punches: PunchRecord[] }>({ state: 'before', punches: [] })
const apiFixRequests = ref<AttendanceFixRequest[]>([])
const apiTimecards = ref<Record<string, TimecardApiRow[]>>({})

function loadMonth(memberId: string, month: string, force = false): Promise<void> {
  return apiLoadOnce(`att:month:${memberId}:${month}`, async () => {
    const data = await apiFetch<MonthSummaryData>('/v1/attendance/month', { query: { memberId, month } })
    apiMonths.value = { ...apiMonths.value, [`${memberId}:${month}`]: data }
  }, force)
}

function loadAlerts(memberId: string, endMonth: string, force = false): Promise<void> {
  return apiLoadOnce(`att:alerts:${memberId}:${endMonth}`, async () => {
    const data = await apiFetch<Article36Alert[]>('/v1/attendance/alerts', { query: { memberId, endMonth } })
    apiAlertsMap.value = { ...apiAlertsMap.value, [`${memberId}:${endMonth}`]: data }
  }, force)
}

/** 修正履歴（置換済みの旧打刻を含む生列）が必要な日のみ ?raw=1 で取得する */
function loadRawDay(memberId: string, date: string, force = false): Promise<void> {
  return apiLoadOnce(`att:raw:${memberId}:${date}`, async () => {
    const data = await apiFetch<DaySummary & { rawPunches: PunchRecord[] }>(
      '/v1/attendance/day', { query: { memberId, date, raw: '1' } })
    apiRawDays.value = { ...apiRawDays.value, [`${memberId}:${date}`]: data.rawPunches }
  }, force)
}

function loadPunchState(force = false): Promise<void> {
  return apiLoadOnce('att:state', async () => {
    apiPunchState.value = await apiFetch<{ state: PunchState; punches: PunchRecord[] }>('/v1/attendance/state')
  }, force)
}

function loadFixRequests(force = false): Promise<void> {
  return apiLoadOnce('att:fix', async () => {
    const role = useApiMe().value?.role
    apiFixRequests.value = await apiFetch<AttendanceFixRequest[]>(
      '/v1/attendance/fix-requests', { query: role === 'admin' || role === 'hr' ? { scope: 'all' } : {} })
  }, force)
}

function loadTimecard(from: string, to: string, departmentId: string, force = false): Promise<void> {
  const key = `${from}:${to}:${departmentId}`
  return apiLoadOnce(`att:tc:${key}`, async () => {
    const data = await apiFetch<TimecardApiRow[]>('/v1/attendance/timecard', {
      query: { from, to, ...(departmentId ? { departmentId } : {}) },
    })
    apiTimecards.value = { ...apiTimecards.value, [key]: data }
  }, force)
}

// ログイン確立・切替時に取り直す（キーの解除は resetApiData が一括で行う）
onApiReset(() => {
  apiMonths.value = {}
  apiAlertsMap.value = {}
  apiRawDays.value = {}
  apiPunchState.value = { state: 'before', punches: [] }
  apiFixRequests.value = []
  apiTimecards.value = {}
  // 打刻ウィジェット・申請バッジは即時性が要るため認証確立時に取り直す
  void loadPunchState(true)
  void loadFixRequests(true)
})

export function useAttendance() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notifyAdmins } = useNotifications()
  const isApi = useApiMode()
  const punches = tbl('punches')
  // API モードは修正申請一覧をサーバーから取得（表示ロジックは共通）
  const fixRequests = isApi ? (apiFixRequests as Ref<AttendanceFixRequest[]>) : tbl('attendanceFixRequests')
  const rules = tbl('attendanceRules')
  if (isApi) {
    void loadPunchState()
    void loadFixRequests()
  }

  /** API モード: 月キャッシュから日サマリを引く（未ロードならロードを発火して undefined） */
  function monthDayOf(memberId: string, date: string): DaySummary | undefined {
    const month = date.slice(0, 7)
    void loadMonth(memberId, month)
    return apiMonths.value[`${memberId}:${month}`]?.days.find(d => d.date === date)
  }

  function emptyDaySummary(date: string): DaySummary {
    return {
      date,
      workMinutes: 0,
      breakMinutes: 0,
      nightMinutes: 0,
      buckets: splitBuckets({
        workMinutes: 0, scheduledMinutes: 0, nightMinutes: 0,
        isLegalHoliday: false, monthNonStatutoryOtSoFar: 0,
      }),
      breakShortage: 0,
      punches: [],
    }
  }

  /**
   * メンバーに適用する勤怠ルールの解決。
   * 優先順: ①メンバーの個別指定（attendanceRuleId・有効なもののみ）
   *        ②雇用区分の既定ルール（defaultFor。区分ごとに 1 ルールのみ）
   *        ③雇用区分で選択可能なルールの先頭（既定未設定時の防御）
   *        ④先頭ルール（最終フォールバック）
   */
  function ruleFor(memberId: string) {
    const members = tbl('members')
    const m = members.value.find(x => x.id === memberId)
    if (m?.attendanceRuleId) {
      const explicit = rules.value.find(r => r.id === m.attendanceRuleId && r.active)
      if (explicit) return explicit
    }
    if (m) {
      const def = rules.value.find(r => r.active && r.defaultFor.includes(m.employmentType))
      if (def) return def
      const applicable = rules.value.find(r => r.active && r.appliesTo.includes(m.employmentType))
      if (applicable) return applicable
    }
    return rules.value[0]
  }

  /**
   * その日の有効な打刻列を返す（表示射影）。
   * 修正打刻（source==='fix'）が承認された場合、元レコードは削除せず保全し、
   * 置換の解決は effectivePunches（純粋関数・fix の連鎖対応）に委譲する（記録系は追記のみ）。
   */
  function punchesOf(memberId: string, date: string): PunchRecord[] {
    if (isApi) {
      // 自分の今日は打刻ウィジェット用の /state を SoT にする（打刻直後の即時反映）
      if (memberId === currentUser.value.id && date === todayJst()) {
        void loadPunchState()
        return effectivePunches(apiPunchState.value.punches)
      }
      return monthDayOf(memberId, date)?.punches ?? []
    }
    return effectivePunches(punches.value.filter(p => p.memberId === memberId && p.date === date))
  }

  /** 修正で置換された旧打刻も含む生の打刻列（履歴表示用） */
  function punchesRawOf(memberId: string, date: string): PunchRecord[] {
    if (isApi) {
      void loadRawDay(memberId, date)
      return apiRawDays.value[`${memberId}:${date}`] ?? []
    }
    return punches.value
      .filter(p => p.memberId === memberId && p.date === date)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  /** 打刻の状態機械（未出勤→勤務中⇄休憩中→退勤済） */
  function punchState(memberId: string, date: string): PunchState {
    if (isApi && memberId === currentUser.value.id && date === todayJst()) {
      void loadPunchState()
      return apiPunchState.value.state
    }
    const rows = punchesOf(memberId, date)
    const last = rows[rows.length - 1]
    if (!last) return 'before'
    if (last.kind === 'out') return 'done'
    if (last.kind === 'break_start') return 'breaking'
    return 'working'
  }

  const ALLOWED: Record<PunchState, PunchKind[]> = {
    before: ['in'],
    working: ['break_start', 'out'],
    breaking: ['break_end'],
    done: [],
  }

  /** 打刻する（状態機械ガード付き。二重打刻は no-op エラー） */
  async function punch(kind: PunchKind, source: 'web' | 'mobile' = 'web'): Promise<Result> {
    const memberId = currentUser.value.id
    const date = todayJst()
    if (isApi) {
      // 状態機械の最終判定はサーバー（advisory lock で直列化）。成立後に状態と当月を取り直す（原則6）
      const res = await apiResult(() =>
        apiFetch('/v1/attendance/punches', { method: 'POST', body: { kind, source } }))
      if (res.ok) {
        await loadPunchState(true)
        void loadMonth(memberId, date.slice(0, 7), true)
        void loadRawDay(memberId, date, true)
      }
      return res
    }
    const state = punchState(memberId, date)
    if (!ALLOWED[state].includes(kind)) {
      return { ok: false, error: { code: 'AKO-ATT-001', message: `現在の状態では「${PUNCH_KIND_LABELS[kind]}」はできません` } }
    }
    const id = nextId('punches', 'pch-u')
    punches.value = [...punches.value, {
      id, memberId, date, kind,
      at: nowJstIso(),
      source, fixedFrom: null, fixReason: null, approvedBy: null,
    }]
    commit()
    return { ok: true, id }
  }

  /** 日次サマリ（6 バケット分解）。API モードはサーバー集計の月キャッシュから射影する */
  function daySummary(memberId: string, date: string, monthOtSoFar = 0): DaySummary {
    if (isApi) {
      return monthDayOf(memberId, date) ?? emptyDaySummary(date)
    }
    const rows = punchesOf(memberId, date)
    const { workMinutes, breakMinutes, nightMinutes } = calcWorkedMinutes(rows)
    const rule = ruleFor(memberId)
    const scheduled = rule ? Math.max(0, toMin(rule.workEnd) - toMin(rule.workStart) - rule.breakMinutes) : 480
    const isLegalHoliday = weekdayOf(date) === (rule?.legalHolidayWeekday ?? 0)
    const buckets = splitBuckets({
      workMinutes, scheduledMinutes: scheduled, nightMinutes, isLegalHoliday,
      monthNonStatutoryOtSoFar: monthOtSoFar,
    })
    const required = requiredBreakMinutes(workMinutes)
    return {
      date, workMinutes, breakMinutes, nightMinutes, buckets,
      breakShortage: Math.max(0, required - breakMinutes),
      punches: rows,
    }
  }

  /** 月次サマリ（日別 + 合計）。API モードはサーバー集計（60h 超の月累計を含む）を返す */
  function monthSummary(memberId: string, month: string): MonthSummaryData {
    if (isApi) {
      void loadMonth(memberId, month)
      return apiMonths.value[`${memberId}:${month}`]
        ?? { days: [], total: emptyDaySummary('').buckets, workDays: 0 }
    }
    const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))]
    const days: DaySummary[] = []
    let otSoFar = 0
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`
      const s = daySummary(memberId, date, otSoFar)
      otSoFar += s.buckets.nonStatutoryOt + s.buckets.over60Ot
      days.push(s)
    }
    const total = days.reduce((acc, s) => ({
      scheduled: acc.scheduled + s.buckets.scheduled,
      statutoryOt: acc.statutoryOt + s.buckets.statutoryOt,
      nonStatutoryOt: acc.nonStatutoryOt + s.buckets.nonStatutoryOt,
      over60Ot: acc.over60Ot + s.buckets.over60Ot,
      night: acc.night + s.buckets.night,
      legalHoliday: acc.legalHoliday + s.buckets.legalHoliday,
    }), { scheduled: 0, statutoryOt: 0, nonStatutoryOt: 0, over60Ot: 0, night: 0, legalHoliday: 0 })
    return { days, total, workDays: days.filter(s => s.workMinutes > 0).length }
  }

  /**
   * 36 協定アラート（endMonth を最終月とする直近 6 ヶ月）
   * @param endMonth YYYY-MM。省略時は JST の当月（閲覧環境の TZ に依存させない）
   */
  function alerts(memberId: string, endMonth?: string): Article36Alert[] {
    const base = endMonth ?? todayJst().slice(0, 7)
    if (isApi) {
      void loadAlerts(memberId, base)
      return apiAlertsMap.value[`${memberId}:${base}`] ?? []
    }
    const [ey, em] = [Number(base.slice(0, 4)), Number(base.slice(5, 7))]
    const months: MonthOtRecord[] = []
    let over45 = 0
    for (let back = 5; back >= 0; back--) {
      const idx = ey * 12 + (em - 1) - back
      const month = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
      const s = monthSummary(memberId, month)
      const rec = {
        month,
        nonStatutoryOtMin: s.total.nonStatutoryOt + s.total.over60Ot,
        legalHolidayMin: s.total.legalHoliday,
      }
      months.push(rec)
      // 45h ちょうどは「以内」で適法のため、年 6 回カウントも厳密に「超」のみ（judgeArticle36 と統一）
      if (rec.nonStatutoryOtMin > 45 * 60) over45++
    }
    return judgeArticle36(months, over45)
  }

  /** 残業アラートをエスカレーションへ連携（補助処理・冪等） */
  function raiseOvertimeEscalations(memberId: string): void {
    if (isApi) {
      // サーバー側で 36 協定判定 → 起票（dedupe + クールダウンで冪等。失敗は握りつぶす = 補助処理）
      void apiFetch('/v1/escalations/overtime-check', { method: 'POST' }).catch(() => {})
      return
    }
    const found = alerts(memberId)
    if (found.length === 0) return
    const { raise } = useEscalations()
    const month = todayJst().slice(0, 7)
    void raise({
      reason: 'overtime_alert',
      targetMemberId: memberId,
      context: `36協定アラート: ${found.map(a => a.message).join(' / ')}`,
      dedupeKey: `overtime:${memberId}:${month}`,
    })
  }

  /** 打刻修正申請（理由必須・承認後に反映） */
  async function requestFix(input: { date: string; kind: PunchKind; requestedAt: string; reason: string }): Promise<Result> {
    if (!input.reason.trim()) {
      return { ok: false, error: { code: 'AKO-ATT-002', message: '修正理由を入力してください（客観的記録の担保）' } }
    }
    if (isApi) {
      // 管理者通知はサーバーが発火。成立後に申請一覧を取り直す（原則6）
      const res = await apiResult(() =>
        apiFetch('/v1/attendance/fix-requests', { method: 'POST', body: input }))
      if (res.ok) await loadFixRequests(true)
      return res
    }
    const id = nextId('attendanceFixRequests', 'fix')
    fixRequests.value = [...fixRequests.value, {
      id, memberId: currentUser.value.id,
      date: input.date, kind: input.kind, requestedAt: input.requestedAt,
      reason: input.reason, status: 'pending', decidedBy: null,
    }]
    commit()
    notifyAdmins('approval', '打刻修正申請', `${currentUser.value.name} さんから ${input.date} の修正申請`, '/attendance')
    return { ok: true, id }
  }

  /**
   * 修正申請の承認/却下（管理者）。
   * 承認時は修正打刻を追記するのみで元打刻は削除しない（記録系は追記のみ）。
   * 集計・表示への反映は punchesOf の射影（fixedFrom 一致の旧打刻を除外）が担う。
   */
  async function decideFix(fixId: string, action: 'approved' | 'rejected'): Promise<Result> {
    if (currentUser.value.role !== 'admin') {
      return { ok: false, error: { code: 'AKO-ATT-004', message: 'この操作には管理者権限が必要です' } }
    }
    if (isApi) {
      // pending ガード・打刻反映はサーバー（FOR UPDATE）。成立後に一覧と対象日・対象月を取り直す
      const target = apiFixRequests.value.find(f => f.id === fixId)
      const res = await apiResult(() =>
        apiFetch(`/v1/attendance/fix-requests/${fixId}/decision`, { method: 'POST', body: { action } }))
      if (res.ok) {
        await loadFixRequests(true)
        if (target && action === 'approved') {
          void loadRawDay(target.memberId, target.date, true)
          void loadMonth(target.memberId, target.date.slice(0, 7), true)
        }
      }
      return res
    }
    const req = fixRequests.value.find(f => f.id === fixId)
    if (!req || req.status !== 'pending') {
      return { ok: false, error: { code: 'AKO-ATT-003', message: 'この申請は処理済みです' } }
    }
    if (action === 'approved') {
      // 置換対象 = 現在有効な同種打刻（fix の連鎖時も punchesOf が最新のみを返すため正しく繋がる）
      const existing = punchesOf(req.memberId, req.date).find(p => p.kind === req.kind)
      punches.value = [...punches.value, {
        id: nextId('punches', 'pch-u'),
        memberId: req.memberId, date: req.date, kind: req.kind,
        at: req.requestedAt, source: 'fix',
        fixedFrom: existing?.at ?? null, fixReason: req.reason,
        approvedBy: currentUser.value.id,
      }]
    }
    fixRequests.value = fixRequests.value.map(f => f.id === fixId
      ? { ...f, status: action, decidedBy: currentUser.value.id }
      : f)
    commit()
    return { ok: true, id: fixId }
  }

  /**
   * タイムカード一覧（管理者/人事。API モード専用のサーバー集計）。
   * 氏名フィルタは取得済み行へのクライアント絞り込みで行う（入力ごとの再取得を避ける）。
   */
  function timecardApi(from: string, to: string, departmentId: string): TimecardApiRow[] {
    if (!isApi) return []
    void loadTimecard(from, to, departmentId)
    return apiTimecards.value[`${from}:${to}:${departmentId}`] ?? []
  }

  return {
    punches, fixRequests, ruleFor, punchesOf, punchesRawOf, punchState, punch,
    daySummary, monthSummary, alerts, raiseOvertimeEscalations, requestFix, decideFix,
    timecardApi,
  }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
