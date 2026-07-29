/**
 * ダッシュボード・コックピットの材料収集（F-01 改訂「夜明けの管制塔」。SoT: cockpit-design.md §3）
 * 各 composable から材料を集め、純関数（utils/cockpit.ts / shared/domain/landing-forecast.ts）へ渡して
 * phase / moves / meter / instruments / forecasts を computed で提供する。
 *
 * 設計上の約束:
 * - 開いた時に AI 生成・重い再取得を発生させない（週次インサイトは保存済みの load のみ・
 *   売上系は既存キャッシュ / 移行済みコレクションの参照のみ。禁じ手 #3）
 * - 権限ゲート: 一手・計器・予報はすべて isEnabled × canPath × ロール条件を満たすときのみ
 *   （権限がない枠は枠ごと出さない。禁じ手 #1）
 * - 祝日・シフト・goals 等が未ロードでも空落ちしない（空配列 = 出さないへフォールバック）
 * - トーンは ok / warn の 2 値のみ（バッジインフレ禁止。禁じ手 #4）
 */
import type { Goal } from '~/types/domain'
import type { BusinessSegment } from '~/types/akebono'
import {
  DEFAULT_WORKING_DAY_RULE, isWorkingDay, workingDayRuleOf, type WorkingDayRule,
} from '../../../shared/domain/business-day'
import {
  buildForecast, summarizeForecasts, type ForecastInput, type ForecastResult,
} from '../../../shared/domain/landing-forecast'
import { segmentAppName } from '~/utils/akebono'
import {
  buildMeter, buildMoves, fmtCockpitValue, latestGoal, phaseOf,
  type CockpitInstrumentGroup, type CockpitInstrumentItem, type CockpitMovesInput,
} from '~/utils/cockpit'
import { addDays, daysInMonth, fmtDate } from '~/utils/format'

/** 予報 1 本の表示ビュー（結果 + 描画・導線に必要な入力の一部） */
export interface CockpitForecastView extends ForecastResult {
  unit: ForecastInput['unit']
  /** 月初から今日までの実績（バー・値表示用） */
  current: number
  inverse: boolean
  /** 針路修正の遷移先 */
  to: string
}

export interface CockpitWeeklyLine {
  text: string
  weekStart: string
  to: string
}

/** 36 協定の月間上限（法定外残業 45h/月。着地予報の上限型 target） */
const MONTHLY_OT_LIMIT_HOURS = 45
/** 予報の最大本数（ロール別 1〜4 本。§3.3） */
const MAX_FORECASTS = 4

export function useCockpit() {
  const { tbl } = useMockDb()
  const { currentUser, currentUserId, isAdmin, isHrOrAdmin } = useCurrentUser()
  const { canPath, can } = usePermissions()
  const { isEnabled } = useAppSettings()
  const isApi = useApiMode()
  const att = useAttendance()
  const leave = useLeave()
  const shifts = useShifts()
  const { pendingFor } = useWorkflow()
  const escalations = useEscalations()
  const reports = useReports()
  // 権限のないユーザーの確定 403 呼出しを発火させない（useSales は生成時に GET /v1/sales、
  // useMediaAnalytics は tbl('salesRecords') = GET /v1/akebono/sales-records のハイドレーションを
  // 発火する）。API モードで権限（sales / akebono）が無い場合は生成自体をスキップする
  // （null 時は計器・予報が従来の「403 → 空キャッシュ」と同じ空表示へフォールバック =
  // 表示ゲートは不変。モックモードはフェッチが無いため常時生成 = 挙動不変）
  const sales = !isApi || (can('sales') && canPath('/sales')) ? useSales() : null
  const media = !isApi || (isEnabled('akebono') && canPath('/akebono')) ? useMediaAnalytics() : null
  const { activeSegments, currentSegmentId, currentSegment } = useCurrentSegment()
  const weeklyInsight = useWeeklyInsight()
  const holidays = tbl('holidays')
  const goalsTbl = tbl('goals')
  const members = tbl('members')

  // ---------- 時刻（JST 壁時計。1 分ごとに再評価 = 12 時/17 時の境界に追従） ----------

  const tick = ref(0)
  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => { timer = setInterval(() => { tick.value++ }, 60_000) })
  onBeforeUnmount(() => { if (timer) clearInterval(timer) })

  const today = computed(() => { void tick.value; return todayJst() })
  const hour = computed(() => { void tick.value; return Number(jstClock().h) })
  const currentMonth = computed(() => today.value.slice(0, 7))

  // ---------- 営業日（business-day.ts + holidays マスタ。未ロードは空集合 = 全平日扱い） ----------

  const holidaySet = computed(() => new Set(holidays.value.map(h => h.date)))
  const memberRule = computed(() => workingDayRuleOf(att.ruleFor(currentUserId.value)))

  function countWorkingDays(from: string, to: string, rule: WorkingDayRule): number {
    let n = 0
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (isWorkingDay(d, rule, holidaySet.value)) n++
    }
    return n
  }

  const monthStart = computed(() => `${currentMonth.value}-01`)
  const monthEnd = computed(() => {
    const y = Number(currentMonth.value.slice(0, 4))
    const m = Number(currentMonth.value.slice(5, 7))
    return `${currentMonth.value}-${String(daysInMonth(y, m)).padStart(2, '0')}`
  })

  // ---------- 材料（次の一手・メーター） ----------

  const isParttime = computed(() => currentUser.value.employmentType === 'parttime')
  /**
   * 打刻系の共通ゲート（punchRequired × canPath('/timecard')）。timecard（= timecard AND attendance）
   * deny のユーザーには、フェーズ・打刻の一手・完了メーターの打刻デューティ・実働計器・勤怠予報を
   * この 1 箇所で一括して出さない（打刻画面へ到達できないのに打刻導線だけ出さない）
   */
  const punchTarget = computed(() => currentUser.value.punchRequired && canPath('/timecard'))
  const shiftFeature = computed(() => isEnabled('shift') && canPath('/shift'))
  /** シフト管理の対象者（出勤打刻の出し分け・シフト計器の表示条件） */
  const shiftManaged = computed(() => isParttime.value && shiftFeature.value)

  const myAssignments = computed(() =>
    shiftManaged.value ? shifts.myAssignments(currentUserId.value) : [])
  const hasTodayShift = computed(() => myAssignments.value.some(a => a.date === today.value))

  /** 募集中（open・締切前）の期間と自分の提出状態 */
  const wishStatus = computed(() => {
    if (!shiftManaged.value) return { open: 0, submitted: 0, nearest: null as string | null }
    let open = 0
    let submitted = 0
    let nearest: string | null = null
    for (const p of shifts.periods.value) {
      if (p.status !== 'open' || shifts.wishDeadlinePassed(p)) continue
      const mine = shifts.wishes.value.some(w => w.periodId === p.id && w.memberId === currentUserId.value)
      if (mine) {
        submitted++
      } else {
        open++
        if (!nearest || p.wishDeadline < nearest) nearest = p.wishDeadline
      }
    }
    return { open, submitted, nearest }
  })

  /** 前営業日以前（直近 7 日）の「IN あり・OUT なし」= 退勤忘れ（新しい順） */
  const unclosedDates = computed(() => {
    if (!punchTarget.value) return []
    const out: string[] = []
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today.value, -i)
      if (!isWorkingDay(d, memberRule.value, holidaySet.value)) continue
      const rows = att.punchesOf(currentUserId.value, d)
      if (rows.some(p => p.kind === 'in') && !rows.some(p => p.kind === 'out')) out.push(d)
    }
    return out
  })

  const punchStateToday = computed(() => att.punchState(currentUserId.value, today.value))

  const reportTarget = computed(() =>
    currentUser.value.punchRequired && !isParttime.value && canPath('/reports'))
  const reportSubmittedToday = computed(() =>
    reportTarget.value && reports.myReportOn(today.value)?.status === 'submitted')

  const myObligation = computed(() => {
    if (!canPath('/attendance')) return null
    const ob = leave.obligation(currentUserId.value)
    return {
      applicable: ob.applicable, achieved: ob.achieved, taken: ob.taken,
      required: ob.required, daysLeft: ob.daysLeft, deadline: ob.deadline,
    }
  })

  const movesInput = computed<CockpitMovesInput>(() => ({
    punchRequired: punchTarget.value,
    punchState: punchStateToday.value,
    hour: hour.value,
    unclosedDates: unclosedDates.value,
    shiftManaged: shiftManaged.value,
    hasTodayShift: hasTodayShift.value,
    canWorkflow: canPath('/workflow'),
    workflowPending: canPath('/workflow') ? pendingFor(currentUserId.value).length : 0,
    hrOrAdmin: isHrOrAdmin.value,
    canAttendance: canPath('/attendance'),
    fixRequestPending: isHrOrAdmin.value
      ? att.fixRequests.value.filter(f => f.status === 'pending').length
      : 0,
    leaveRequestPending: isHrOrAdmin.value ? leave.pendingRequests.value.length : 0,
    reportTarget: reportTarget.value,
    reportSubmittedToday: reportSubmittedToday.value,
    shiftStaff: shiftManaged.value,
    openWishPeriods: wishStatus.value.open,
    submittedWishPeriods: wishStatus.value.submitted,
    nearestWishDeadline: wishStatus.value.nearest,
    canInbox: canPath('/inbox'),
    openEscalations: isHrOrAdmin.value ? escalations.open.value.length : 0,
    obligation: myObligation.value,
  }))

  const phase = computed(() => phaseOf(punchTarget.value, punchStateToday.value))
  const moves = computed(() => buildMoves(movesInput.value))
  const meter = computed(() => buildMeter(movesInput.value))

  // ---------- 計器（該当データ・権限がない計器は枠ごと非表示） ----------

  /** 事業計器・事業予報の対象業態（segmentIds 優先。未設定は明示的な業態選択のみフォールバック） */
  const targetSegments = computed<BusinessSegment[]>(() => {
    if (!isEnabled('akebono') || !canPath('/akebono')) return []
    const ids = currentUser.value.segmentIds ?? []
    const mine = activeSegments.value.filter(s => ids.includes(s.id))
    if (mine.length > 0) return mine
    // 未設定者は「業態を明示的に選択中」のときのみ現在業態を表示（全員への経営数字の露出を防ぐ）。
    // 保存済みの選択が無効化・削除済みの場合は表示しない（effectiveSegmentId の先頭業態フォールバックに
    // 乗せると、選んでいない業態の売上へすり替わるため。選択 id が有効な業態のときのみ）
    const explicitlySelected = activeSegments.value.some(s => s.id === currentSegmentId.value)
    return explicitlySelected && currentSegment.value ? [currentSegment.value] : []
  })

  /** 業態の当月・前月売上（移行済み salesRecords の月次畳み込み = 両モード共通） */
  function segmentMonthly(segmentId: string): { current: number; prev: number; orders: number } {
    if (!media) return { current: 0, prev: 0, orders: 0 } // akebono 権限なし = 0 の器（表示側は従来どおり）
    const prevMonth = prevMonthOf(currentMonth.value)
    const m = media.businessMonthly(segmentId, [prevMonth, currentMonth.value])
    const cur = m.get(currentMonth.value) ?? { amount: 0, orders: 0 }
    const prev = m.get(prevMonth) ?? { amount: 0, orders: 0 }
    return { current: cur.amount, prev: prev.amount, orders: cur.orders }
  }

  const instruments = computed<CockpitInstrumentGroup[]>(() => {
    const groups: CockpitInstrumentGroup[] = []

    // 自分の計器（全員・punchRequired 考慮）
    const self: CockpitInstrumentItem[] = []
    if (punchTarget.value) {
      const ms = att.monthSummary(currentUserId.value, currentMonth.value)
      const workedMin = ms.days.reduce((s, d) => s + d.workMinutes, 0)
      self.push({
        id: 'my-hours', label: '今月の実働', icon: 'Clock3', to: '/timecard',
        value: `${Math.round(workedMin / 60 * 10) / 10}h`,
        sub: `${ms.workDays} 日出勤`,
      })
    }
    if (canPath('/attendance')) {
      const bal = leave.balance(currentUserId.value)
      if (bal.allocations.length > 0) {
        self.push({
          id: 'my-leave', label: '有給残', icon: 'CalendarHeart', to: '/attendance?tab=leave',
          value: `${bal.remaining} 日`,
          sub: bal.nextExpire
            ? `${fmtDate(bal.nextExpire.date)} に ${bal.nextExpire.days} 日失効予定`
            : `今年度 ${bal.usedThisFiscalYear} 日取得`,
        })
      }
      if (currentUser.value.punchRequired) {
        const myAlerts = att.alerts(currentUserId.value)
        if (myAlerts.length > 0) {
          self.push({
            id: 'my-article36', label: '36協定アラート', icon: 'TriangleAlert', to: '/attendance?tab=monthly',
            value: `${myAlerts.length} 件`,
            sub: myAlerts[0]?.message ?? '',
          })
        }
      }
    }
    if (self.length > 0) groups.push({ id: 'self', label: '自分の計器', items: self })

    // シフト計器（parttime × shift 有効）
    if (shiftManaged.value) {
      const items: CockpitInstrumentItem[] = []
      const upcoming = myAssignments.value.find(a => a.date >= today.value)
      if (upcoming) {
        items.push({
          id: 'shift-next', label: upcoming.date === today.value ? '今日のシフト' : '次のシフト',
          icon: 'CalendarRange', to: '/shift',
          value: upcoming.date === today.value ? '今日' : fmtDate(upcoming.date),
          sub: `${upcoming.from}〜${upcoming.to}`,
        })
      }
      const nearestOpen = shifts.periods.value
        .filter(p => p.status === 'open' && !shifts.wishDeadlinePassed(p))
        .sort((a, b) => a.wishDeadline.localeCompare(b.wishDeadline))[0]
      if (nearestOpen) {
        items.push({
          id: 'shift-deadline', label: '希望提出締切', icon: 'CalendarClock', to: '/shift',
          value: fmtDate(nearestOpen.wishDeadline),
          sub: wishStatus.value.open > 0 ? `${nearestOpen.label}・未提出` : `${nearestOpen.label}・提出済み`,
        })
      }
      if (items.length > 0) groups.push({ id: 'shift', label: 'シフト計器', items })
    }

    // 労務計器（hr / admin。未提出者などの個人名は出さない = 件数のみ）
    if (isHrOrAdmin.value && canPath('/attendance')) {
      const fix = att.fixRequests.value.filter(f => f.status === 'pending').length
      const lv = leave.pendingRequests.value.length
      const wf = canPath('/workflow') ? pendingFor(currentUserId.value).length : 0
      const obligationWarn = members.value
        .filter(m => m.active && leave.obligation(m.id).warn).length
      const items: CockpitInstrumentItem[] = [
        {
          id: 'labor-approvals', label: '承認キュー', icon: 'ClipboardCheck', to: '/attendance?tab=requests',
          value: `${fix + lv + wf} 件`,
          sub: `打刻修正 ${fix}・休暇 ${lv}・稟議 ${wf}`,
        },
      ]
      // 36協定該当者はデータが取得できる場合のみ表示（API モードのエスカレーション一覧は admin のみ =
      // hr は欠測になるため枠ごと非表示。欠測を 0 表示しない。モックモードは従来どおり全員分表示）
      if (!isApi || isAdmin.value) {
        const overtimeTargets = new Set(
          escalations.open.value.filter(e => e.reason === 'overtime_alert').map(e => e.targetMemberId)).size
        items.push({
          id: 'labor-article36', label: '36協定該当者', icon: 'TriangleAlert', to: '/inbox',
          value: `${overtimeTargets} 人`,
          sub: '未対応の残業エスカレーション',
        })
      }
      items.push({
        id: 'labor-obligation', label: '年5日未達', icon: 'CalendarHeart', to: '/attendance?tab=leave-admin',
        value: `${obligationWarn} 人`,
        sub: '期限 3 ヶ月以内・未達',
      })
      groups.push({ id: 'labor', label: '労務計器', items })
    }

    // 経営計器（sales 権限。sales null = F9 の未生成時は権限なしのため枠ごと出ない）
    if (sales && can('sales') && canPath('/sales')) {
      const amount = sales.currentMonthSales.value
      const salesGroup: CockpitInstrumentGroup = {
        id: 'sales',
        label: '経営計器',
        items: [{
          id: 'sales-month', label: '今月売上', icon: 'TrendingUp', to: '/sales',
          value: fmtCockpitValue(amount, 'currency'),
          delta: sales.currentMonthYoY.value,
          // 出典（月次実績 = /sales の登録データ）を明示する
          sub: sales.currentMonthYoY.value !== null ? '前年同月比・月次実績より' : '月次実績より',
        }],
      }
      if (isEnabled('akebono') && canPath('/akebono') && activeSegments.value.length > 0) {
        salesGroup.link = { label: '会社全体ダッシュボード', to: '/akebono/company' }
      }
      groups.push(salesGroup)
    }

    // 事業計器（segmentIds 設定者 or 業態選択中）
    if (targetSegments.value.length > 0) {
      groups.push({
        id: 'segments',
        label: '事業計器',
        items: targetSegments.value.map((s) => {
          const m = segmentMonthly(s.id)
          return {
            id: `segment-${s.id}`, label: segmentAppName(s), icon: 'Store', to: `/akebono?seg=${s.id}`,
            value: fmtCockpitValue(m.current, 'currency'),
            delta: m.prev > 0 ? (m.current - m.prev) / m.prev : null,
            // 出典（取引明細 = AKEBONO 売上記録の月次畳み込み）を明示する
            sub: m.prev > 0 ? '今月売上・前月比・取引明細より' : '今月売上・取引明細より',
          }
        }),
      })
    }

    return groups
  })

  // ---------- 週次インサイト 1 行（保存済み personal のみ。生成は /reports の明示操作） ----------

  const weeklyLine = ref<CockpitWeeklyLine | null>(null)
  /** ロード世代（ユーザー切替の連続ロードで旧応答が後着して上書きしないように） */
  let weeklyLineGen = 0
  async function loadWeeklyLine(): Promise<void> {
    const gen = ++weeklyLineGen
    weeklyLine.value = null
    if (!canPath('/reports')) return
    try {
      const thisWeek = reports.weekStartOf(today.value)
      let bundle = await weeklyInsight.load(thisWeek)
      let weekStart = thisWeek
      if (!bundle.personal) {
        // 今週分が未生成なら先週分へフォールバック（保存済みのみ・生成はしない）
        weekStart = addDays(thisWeek, -7)
        bundle = await weeklyInsight.load(weekStart)
      }
      if (gen !== weeklyLineGen) return // 旧世代の応答は破棄（最新のロード結果のみ反映）
      weeklyLine.value = bundle.personal
        ? { text: bundle.personal.insight.summary, weekStart, to: '/reports?tab=weekly-all' }
        : null
    } catch {
      if (gen === weeklyLineGen) weeklyLine.value = null // 取得失敗は非表示（補助情報。主要フローを止めない）
    }
  }
  watch(currentUserId, () => { void loadWeeklyLine() }, { immediate: true })

  // ---------- 着地予報（landing-forecast への入力組立） ----------

  const activeGoals = computed(() => (goalsTbl.value as Goal[]).filter(g => g.active))
  const goalsEmpty = computed(() => activeGoals.value.length === 0)

  const forecasts = computed<CockpitForecastView[]>(() => {
    // reasonNote = 算定根拠へ追記する分母等の定義（予報の透明性）
    const defs: { input: ForecastInput; to: string; reasonNote?: string }[] = []
    const elapsed = countWorkingDays(monthStart.value, today.value, DEFAULT_WORKING_DAY_RULE)
    const total = countWorkingDays(monthStart.value, monthEnd.value, DEFAULT_WORKING_DAY_RULE)

    // 1. 業態売上の着地（経営 = 全業態 / 事業担当 = 担当業態のみ）
    const salesView = can('sales') && canPath('/sales')
    const segmentPool = salesView ? activeSegments.value : targetSegments.value
    for (const s of segmentPool) {
      // 同一 (metric, segmentId) の active 重複は最新 1 件（後勝ち = §2.2。API の id 順に依存しない）
      const goal = latestGoal(activeGoals.value, 'segment_sales', s.id)
      if (!goal) continue
      defs.push({
        input: {
          id: `${s.id}-sales`, label: `${s.name}の売上`, kind: 'amount', unit: 'currency',
          current: segmentMonthly(s.id).current, target: goal.monthlyValue,
          elapsedWorkingDays: elapsed, totalWorkingDays: total,
        },
        to: isEnabled('akebono') && canPath('/akebono') ? `/akebono?seg=${s.id}` : '/sales',
      })
    }

    // 2. 日報提出率の着地（hr / admin。率は外挿しない）
    if (isHrOrAdmin.value && canPath('/reports')) {
      const goal = latestGoal(activeGoals.value, 'report_rate', null)
      const asOf = addDays(today.value, -1)
      const elapsedToAsOf = asOf >= monthStart.value
        ? countWorkingDays(monthStart.value, asOf, DEFAULT_WORKING_DAY_RULE)
        : 0
      if (goal && elapsedToAsOf > 0) {
        const targets = new Set(members.value
          .filter(m => m.active && m.punchRequired && m.employmentType !== 'parttime')
          .map(m => m.id))
        const submitted = reports.allSubmitted(currentMonth.value)
          .filter(r => r.authorKind === 'human' && r.memberId && targets.has(r.memberId) && r.date <= asOf)
          .length
        const denom = targets.size * elapsedToAsOf
        if (denom > 0) {
          defs.push({
            input: {
              id: 'report-rate', label: '日報提出率', kind: 'rate', unit: 'percent',
              current: Math.min(100, Math.round(submitted / denom * 1000) / 10),
              target: goal.monthlyValue,
              elapsedWorkingDays: elapsedToAsOf, totalWorkingDays: total,
            },
            to: '/reports?tab=team',
            reasonNote: '対象: 打刻対象の社員', // 分母の定義（active × punchRequired × 非アルバイト）
          })
        }
      }
    }

    // 3. 自分の勤怠着地（正社員系 = 残業の上限型 / アルバイト = 勤務時間）
    if (punchTarget.value) {
      const myElapsed = countWorkingDays(monthStart.value, today.value, memberRule.value)
      const myTotal = countWorkingDays(monthStart.value, monthEnd.value, memberRule.value)
      const ms = att.monthSummary(currentUserId.value, currentMonth.value)
      if (isParttime.value) {
        const workedMin = ms.days.reduce((s, d) => s + d.workMinutes, 0)
        defs.push({
          input: {
            id: 'my-hours', label: '自分の勤務時間', kind: 'amount', unit: 'hours',
            current: Math.round(workedMin / 60 * 10) / 10,
            target: currentUser.value.weeklyHours * 4, // 月次目安 = 週所定 × 4 週換算
            elapsedWorkingDays: myElapsed, totalWorkingDays: myTotal,
          },
          to: '/timecard',
        })
      } else {
        const otMin = ms.total.nonStatutoryOt + ms.total.over60Ot
        defs.push({
          input: {
            id: 'my-overtime', label: '自分の残業', kind: 'amount', unit: 'hours',
            current: Math.round(otMin / 60 * 10) / 10,
            target: MONTHLY_OT_LIMIT_HOURS, inverse: true,
            elapsedWorkingDays: myElapsed, totalWorkingDays: myTotal,
          },
          to: '/timecard',
        })
      }
    }

    // 切り詰め: 自分の予報（my-overtime / my-hours）が存在する場合は最低 1 本確保し、
    // 残り枠を組立順（業態売上 → 提出率）で充当する（業態数が多くても自分の勤怠着地が消えない）
    const isMine = (d: { input: ForecastInput }): boolean =>
      d.input.id === 'my-overtime' || d.input.id === 'my-hours'
    const mine = defs.filter(isMine)
    const others = defs.filter(d => !isMine(d))
    const picked = [...others.slice(0, Math.max(0, MAX_FORECASTS - mine.length)), ...mine.slice(0, MAX_FORECASTS)]

    return picked.map((d) => {
      const built = buildForecast(d.input)
      return {
        ...built,
        reason: d.reasonNote ? `${built.reason}（${d.reasonNote}）` : built.reason,
        unit: d.input.unit,
        current: d.input.current,
        inverse: d.input.inverse === true,
        to: d.to,
      }
    })
  })

  const forecastSummary = computed(() => summarizeForecasts(forecasts.value))

  /** 針路修正 1 件 = 最も乖離が大きい warn（対処導線付き。warn なしは null） */
  const courseCorrection = computed<CockpitForecastView | null>(() => {
    const warns = forecasts.value.filter(f => f.tone === 'warn')
    if (warns.length === 0) return null
    return [...warns].sort((a, b) =>
      Math.abs(b.projectedRatio - 1) - Math.abs(a.projectedRatio - 1))[0] ?? null
  })

  return {
    phase, moves, meter, instruments, weeklyLine,
    forecasts, forecastSummary, courseCorrection, goalsEmpty, isAdmin,
  }
}

function prevMonthOf(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
