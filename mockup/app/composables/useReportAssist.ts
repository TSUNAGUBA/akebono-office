/**
 * 日報 AI アシスト（F-06-7・モック）
 * 参照設計:
 * - tokutake ぽいぽいポスト: 低摩擦の断片投稿（ぽいぽいメモ）で日中に材料をためる
 * - akebono-ai-manager: テンプレ＋文脈のヒアリング（checkin 方式）→ ログ集約 → ドラフト生成 →
 *   「確認するだけ」フロー（本モックでは既存フォームへ流し込み、確認・修正して提出）
 * 原則:
 * - ヒアリングログは記録系（追記のみ）。ドラフト生成は何度でも再実行可能（フォームを埋めるだけで保存しない）
 * - 提出済みの日報は上書きしない（ai-manager の confirmed_by_user 保護と同型。
 *   判定は useReports.reportOn の結果を用い、呼び出し側（reports.vue）で生成 UI を無効化する）
 */
import type { Ref } from 'vue'
import type { DraftContext, ReportDraft } from '../../../shared/domain/report-draft'
import { heuristicReportDraft, WRAPUP_KEYS } from '../../../shared/domain/report-draft'
import type { CalendarEvent, HearingLog, Note, ReportInputMode, Result } from '~/types/domain'

export type { ReportDraft }

export interface AssistQuestion {
  key: string
  calendarEventId: string | null
  question: string
  /** ワンタップ回答チップ（自由記述も可） */
  chips: string[]
  answered: boolean
}


// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一。日付キー単位の遅延ロード） ----------

const apiAssistLogs = ref<HearingLog[]>([])

function loadAssistLogs(date: string, force = false): Promise<void> {
  return apiLoadOnce(`ras:${date}`, async () => {
    const rows = await apiFetch<HearingLog[]>('/v1/assist/logs', { query: { date } })
    const map = new Map(apiAssistLogs.value.map(l => [l.id, l]))
    for (const l of rows) map.set(l.id, l)
    apiAssistLogs.value = [...map.values()]
  }, force)
}

onApiReset(() => {
  apiAssistLogs.value = []
})

export function useReportAssist() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { eventsOf } = useCalendar()
  const { nextWorkingDayFor } = useBusinessDay()
  const isApi = useApiMode()
  // API モードは assist_logs キャッシュをバッキング（questionsFor 等の射影は共通）
  const hearingLogs = isApi ? (apiAssistLogs as Ref<HearingLog[]>) : tbl('hearingLogs')
  const taskPlans = tbl('taskPlans')
  const projects = tbl('projects')
  const companies = tbl('companies')

  // ---------- 入力方式設定（F-13） ----------

  // 設定の SoT は useAppSettings（API モードは /v1/configs、モックモードは appConfigs テーブル）
  const settings = useAppSettings()
  const inputMode = computed<ReportInputMode>(() => {
    const v = settings.getConfig('reportInputMode', 'both')
    return v === 'form' || v === 'assist' || v === 'both' ? v : 'both'
  })

  // ---------- ログ参照 ----------

  function logsOf(memberId: string, date: string): HearingLog[] {
    if (isApi) void loadAssistLogs(date)
    return hearingLogs.value
      .filter(l => l.memberId === memberId && l.date === date)
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  // ---------- ヒアリング（テンプレ＋文脈のハイブリッド。ai-manager 方式） ----------

  /** その日のヒアリング設問。予定 1 件につき 1 問 + まとめ 3 問（回答済みは answered=true） */
  function questionsFor(memberId: string, date: string): AssistQuestion[] {
    const logs = logsOf(memberId, date)
    const answeredEventIds = new Set(logs.filter(l => l.kind === 'qa' && l.calendarEventId).map(l => l.calendarEventId))
    const answeredKeys = new Set(logs.filter(l => l.kind === 'qa' && !l.calendarEventId).map(l => l.question.split('|')[0]))

    const qs: AssistQuestion[] = eventsOf(memberId, date).map(e => ({
      key: `ev:${e.id}`,
      calendarEventId: e.id,
      question: e.title.includes('定例') || e.title.includes('会')
        ? `${e.from} の「${e.title}」はどうでしたか？決まったこと・持ち帰りを一言で`
        : `${e.from}〜${e.to} の「${e.title}」の進み具合は？`,
      chips: ['予定どおり完了', '概ね順調', '課題あり（後述）'],
      answered: answeredEventIds.has(e.id),
    }))

    qs.push(
      {
        key: WRAPUP_KEYS.focus, calendarEventId: null,
        question: `${WRAPUP_KEYS.focus}|今日いちばん時間を使った・集中したことは何ですか？`,
        chips: [], answered: answeredKeys.has(WRAPUP_KEYS.focus),
      },
      {
        key: WRAPUP_KEYS.issue, calendarEventId: null,
        question: `${WRAPUP_KEYS.issue}|困りごと・課題はありますか？（提出時に管理者へ共有されます）`,
        chips: ['特になし'], answered: answeredKeys.has(WRAPUP_KEYS.issue),
      },
      {
        key: WRAPUP_KEYS.tomorrow, calendarEventId: null,
        question: `${WRAPUP_KEYS.tomorrow}|明日やる予定を一言で`,
        chips: [], answered: answeredKeys.has(WRAPUP_KEYS.tomorrow),
      },
    )
    return qs
  }

  /** 設問の表示用文言（wrap 系はキー接頭辞を隠す） */
  function displayQuestion(q: AssistQuestion): string {
    return q.question.includes('|') ? q.question.split('|').slice(1).join('|') : q.question
  }

  /**
   * 回答を記録する（追記のみ・答え直しは新しい回答が優先される）
   * @param date 記録対象日（省略時は本日。過去日の日報を書くケースに対応）
   */
  async function recordAnswer(q: AssistQuestion, answer: string, date?: string): Promise<Result> {
    const text = answer.trim()
    if (!text) return { ok: false, error: { code: 'AKO-RAS-001', message: '回答を入力してください' } }
    if (isApi) {
      const d = date ?? todayJst()
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/assist/answers', {
        method: 'POST',
        body: { date: d, question: q.question, calendarEventId: q.calendarEventId, answer: text },
      }))
      if (res.ok) await loadAssistLogs(d, true)
      return res
    }
    hearingLogs.value = [...hearingLogs.value, {
      id: nextId('hearingLogs', 'hl'),
      memberId: currentUser.value.id,
      date: date ?? todayJst(),
      kind: 'qa',
      calendarEventId: q.calendarEventId,
      question: q.question,
      answer: text,
      at: nowJstIso(),
    }]
    commit()
    return { ok: true }
  }

  /**
   * ぽいぽいメモ（低摩擦の断片投稿。tokutake ぽいぽいポスト方式）
   * @param date 記録対象日（省略時は本日）
   */
  async function poipoiMemo(text: string, date?: string): Promise<Result> {
    const t = text.trim().slice(0, 2000)
    if (!t) return { ok: false, error: { code: 'AKO-RAS-002', message: 'メモを入力してください' } }
    if (isApi) {
      const d = date ?? todayJst()
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/assist/memos', {
        method: 'POST', body: { date: d, text: t },
      }))
      if (res.ok) await loadAssistLogs(d, true)
      return res
    }
    hearingLogs.value = [...hearingLogs.value, {
      id: nextId('hearingLogs', 'hl'),
      memberId: currentUser.value.id,
      date: date ?? todayJst(),
      kind: 'memo',
      calendarEventId: null,
      question: '',
      answer: t,
      at: nowJstIso(),
    }]
    commit()
    return { ok: true }
  }

  // ---------- ドラフト生成（モック LLM: 決定的ヒューリスティック整形） ----------

  /**
   * 蓄積ログ + カレンダー予定 + タスク計画の結果（F-14）から日報ドラフトを生成する（保存しない）。
   * 生成ロジックの SoT は shared/domain/report-draft（API のフォールバックと同一実装）。
   * API モードはサーバー生成（Vertex AI → 失敗時サーバー側で同一ヒューリスティック）
   */
  async function generateDraft(memberId: string, date: string): Promise<ReportDraft> {
    if (isApi) {
      try {
        return await apiFetch<ReportDraft>('/v1/assist/report-draft', { method: 'POST', body: { date } })
      } catch {
        // API 断でもフォームを空で返さない（材料 = ローカルキャッシュのヒューリスティック）
      }
    }
    // ぽいぽいポスト（独立メニュー = notes コレクション。バッチ7c）も材料へ合流（memo 形式）
    const poipoiNotes = (tbl('notes').value as Note[])
      .filter(n => n.kind === 'poipoi' && n.memberId === memberId && n.active !== false
        && n.createdAt.slice(0, 10) === date)
      .map(n => ({
        id: n.id, memberId, date, kind: 'memo' as const,
        calendarEventId: null, question: '', answer: n.body, at: n.createdAt,
      }))
    const ctx: DraftContext = {
      events: eventsOf(memberId, date),
      logs: [...logsOf(memberId, date), ...poipoiNotes],
      dayPlans: taskPlans.value
        .filter(tp => tp.memberId === memberId && tp.date === date)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      // 翌営業日はメンバーの勤怠ルール（営業曜日）+ 祝日マスタで解決（オペレーター報告 2026-07-18 #4）
      nextDayPlans: taskPlans.value.filter(tp => tp.memberId === memberId && tp.date === nextWorkingDayFor(memberId, date)),
      projects: projects.value.filter(x => x.active),
      companies: companies.value.filter(x => x.active),
    }
    return heuristicReportDraft(ctx, date)
  }

  return {
    inputMode, logsOf, questionsFor, displayQuestion, recordAnswer, poipoiMemo,
    generateDraft,
  }
}
