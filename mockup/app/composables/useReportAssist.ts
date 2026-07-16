/**
 * 日報 AI アシスト（F-06-6・モック）
 * 参照設計:
 * - tokutake ぽいぽいポスト: 低摩擦の断片投稿（ぽいぽいメモ）で日中に材料をためる
 * - akebono-ai-manager: テンプレ＋文脈のヒアリング（checkin 方式）→ ログ集約 → ドラフト生成 →
 *   「確認するだけ」フロー（本モックでは既存フォームへ流し込み、確認・修正して提出）
 * 原則:
 * - ヒアリングログは記録系（追記のみ）。ドラフト生成は何度でも再実行可能（フォームを埋めるだけで保存しない）
 * - 提出済みの日報は上書きしない（ai-manager の confirmed_by_user 保護と同型）
 */
import type { CalendarEvent, DailyReport, HearingLog, ReportEntry, ReportInputMode, Result } from '~/types/domain'

export interface AssistQuestion {
  key: string
  calendarEventId: string | null
  question: string
  /** ワンタップ回答チップ（自由記述も可） */
  chips: string[]
  answered: boolean
}

/** ドラフト生成結果（フォームへ流し込む値。保存はしない） */
export interface ReportDraft {
  entries: ReportEntry[]
  reflection: string
  issues: string
  tomorrow: string
  /** 生成根拠の説明（確認画面に表示し、AI の推定を検証可能にする） */
  basis: string[]
}

const WRAPUP_KEYS = {
  focus: 'wrap:focus',
  issue: 'wrap:issue',
  tomorrow: 'wrap:tomorrow',
} as const

const NEGATIVE_HINTS = ['課題', '困り', '遅れ', 'ブロック', '未完', 'トラブル', '手戻り', '懸念']

export function useReportAssist() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { eventsOf } = useCalendar()
  const hearingLogs = tbl('hearingLogs')
  const projects = tbl('projects')
  const companies = tbl('companies')

  // ---------- 入力方式設定（F-13） ----------

  const configs = tbl('appConfigs')
  const inputMode = computed<ReportInputMode>(() => {
    const v = configs.value.find(c => c.key === 'reportInputMode')?.value
    return v === 'form' || v === 'assist' || v === 'both' ? v : 'both'
  })

  // ---------- ログ参照 ----------

  function logsOf(memberId: string, date: string): HearingLog[] {
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

  /** 回答を記録する（追記のみ・答え直しは新しい回答が優先される） */
  function recordAnswer(q: AssistQuestion, answer: string): Result {
    const text = answer.trim()
    if (!text) return { ok: false, error: { code: 'AKO-RAS-001', message: '回答を入力してください' } }
    hearingLogs.value = [...hearingLogs.value, {
      id: nextId('hearingLogs', 'hl'),
      memberId: currentUser.value.id,
      date: todayJst(),
      kind: 'qa',
      calendarEventId: q.calendarEventId,
      question: q.question,
      answer: text,
      at: nowJstIso(),
    }]
    commit()
    return { ok: true }
  }

  /** ぽいぽいメモ（低摩擦の断片投稿。tokutake ぽいぽいポスト方式） */
  function poipoiMemo(text: string): Result {
    const t = text.trim().slice(0, 2000)
    if (!t) return { ok: false, error: { code: 'AKO-RAS-002', message: 'メモを入力してください' } }
    hearingLogs.value = [...hearingLogs.value, {
      id: nextId('hearingLogs', 'hl'),
      memberId: currentUser.value.id,
      date: todayJst(),
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

  /** 予定タイトルからプロジェクトを推定（projectId 明示 → PJ 名/会社名・エイリアスのタイトル一致） */
  function inferProjectId(e: CalendarEvent): string | null {
    if (e.projectId) return e.projectId
    const title = e.title.toLowerCase()
    for (const p of projects.value.filter(x => x.active)) {
      if (title.includes(p.name.slice(0, 8).toLowerCase())) return p.id
      const company = companies.value.find(c => c.id === p.companyId)
      if (company && [company.name, ...company.aliases].some(n => n && title.includes(n.toLowerCase()))) return p.id
    }
    return null
  }

  function eventMinutes(e: CalendarEvent): number {
    const from = Number(e.from.slice(0, 2)) * 60 + Number(e.from.slice(3, 5))
    const to = Number(e.to.slice(0, 2)) * 60 + Number(e.to.slice(3, 5))
    return Math.max(0, to - from)
  }

  /** 0.25h 刻みへ丸め */
  function toQuarterHours(minutes: number): number {
    return Math.max(0.25, Math.round(minutes / 15) / 4)
  }

  /**
   * 蓄積ログ + カレンダー予定から日報ドラフトを生成する（保存しない = 何度でも再生成可）。
   * 本実装では LLM（構造化出力）に置き換え、失敗時は本ヒューリスティックへフォールバックする。
   */
  function generateDraft(memberId: string, date: string): ReportDraft {
    const events = eventsOf(memberId, date)
    const logs = logsOf(memberId, date)
    const basis: string[] = []

    // entries: 予定 → プロジェクト推定 + 工数（予定時間） + 回答による進捗推定
    const entries: ReportEntry[] = events.map((e) => {
      const pid = inferProjectId(e)
      const ans = [...logs].reverse().find(l => l.kind === 'qa' && l.calendarEventId === e.id)?.answer ?? ''
      const negative = NEGATIVE_HINTS.some(h => ans.includes(h))
      const done = /完了|予定どおり/.test(ans)
      if (pid && !e.projectId) basis.push(`「${e.title}」→ タイトルからプロジェクトを推定`)
      return {
        projectId: pid ?? '',
        task: ans && !ans.startsWith('特になし') ? `${e.title}（${ans.slice(0, 40)}）` : e.title,
        hours: toQuarterHours(eventMinutes(e)),
        progress: done ? 100 : negative ? 50 : 80,
      }
    })
    if (events.length > 0) basis.push(`工数はカレンダー予定の時間から算出（${events.length} 件）`)

    // 所感: イベント回答の肯定的な内容 + フォーカス回答 + ぽいぽいメモ
    const focus = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.focus))?.answer
    const memos = logs.filter(l => l.kind === 'memo').map(l => l.answer)
    const reflectionParts = [
      focus ? `今日は${focus}に注力した。` : '',
      ...memos.map(m => `メモ: ${m}`),
    ].filter(Boolean)
    if (memos.length > 0) basis.push(`ぽいぽいメモ ${memos.length} 件を所感へ反映`)

    // 課題: 課題回答（「特になし」以外） + イベント回答のネガティブ表現
    const issueAns = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.issue))?.answer ?? ''
    const negatives = logs
      .filter(l => l.kind === 'qa' && l.calendarEventId && NEGATIVE_HINTS.some(h => l.answer.includes(h)))
      .map((l) => {
        const ev = events.find(e => e.id === l.calendarEventId)
        return ev ? `${ev.title}: ${l.answer}` : l.answer
      })
    const issues = [
      issueAns && issueAns !== '特になし' ? issueAns : '',
      ...negatives,
    ].filter(Boolean).join('\n')
    if (issues) basis.push('課題はヒアリング回答から抽出（提出時に管理者へ共有）')

    const tomorrow = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.tomorrow))?.answer ?? ''

    return {
      entries: entries.length > 0 ? entries : [{ projectId: '', task: '', hours: 1, progress: 0 }],
      reflection: reflectionParts.join('\n'),
      issues,
      tomorrow,
      basis,
    }
  }

  /** その日の提出済み日報（提出済みならドラフト再生成でフォームを上書きしない） */
  function submittedReportOf(memberId: string, date: string): DailyReport | undefined {
    const reports = tbl('dailyReports')
    return reports.value.find(r =>
      r.authorKind === 'human' && r.memberId === memberId && r.date === date && r.status === 'submitted')
  }

  return {
    inputMode, logsOf, questionsFor, displayQuestion, recordAnswer, poipoiMemo,
    generateDraft, submittedReportOf,
  }
}
