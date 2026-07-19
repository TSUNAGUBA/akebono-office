/**
 * 日報ドラフト生成（F-06-7）: 決定的ヒューリスティック（フロントエンドと API サービスで共有)
 * - モックモード: これが唯一の生成ロジック
 * - API モード: Vertex AI（LLM 構造化出力）失敗時のフォールバック（原則4）
 * 材料 = カレンダー予定（未連携なら空）+ ヒアリングログ + タスク計画（F-14）。
 * 生成結果は保存しない（フォームへ流し込み → 利用者が確認・修正して既存の提出フローへ）
 */
import { hhmmToMin } from './jst'
import type { CalendarEvent, HearingLog, ReportEntry, TaskPlan } from './types'

export interface ReportDraft {
  entries: ReportEntry[]
  reflection: string
  issues: string
  tomorrow: string
  /** 生成根拠の説明（確認画面に表示し、AI の推定を検証可能にする） */
  basis: string[]
}

export const WRAPUP_KEYS = {
  focus: 'wrap:focus',
  issue: 'wrap:issue',
  tomorrow: 'wrap:tomorrow',
} as const

export const NEGATIVE_HINTS = ['課題', '困り', '遅れ', 'ブロック', '未完', 'トラブル', '手戻り', '懸念']

export interface DraftContext {
  /** 対象日の予定（カレンダー未連携なら空配列） */
  events: CalendarEvent[]
  /** 対象日のヒアリングログ（at 昇順） */
  logs: HearingLog[]
  /** 対象日のタスク計画（createdAt 昇順） */
  dayPlans: TaskPlan[]
  /** 翌営業日のタスク計画（明日の予定の材料） */
  nextDayPlans: TaskPlan[]
  /** 有効なプロジェクト（呼び出し側で active フィルタ済み） */
  projects: { id: string; name: string; companyId: string }[]
  companies: { id: string; name: string; aliases: string[] }[]
}

/** テキスト（予定タイトル・タスク名）からプロジェクトを推定（PJ 名/会社名・エイリアスの一致） */
function inferProjectIdFromText(ctx: DraftContext, text: string): string | null {
  const title = text.toLowerCase()
  for (const p of ctx.projects) {
    if (title.includes(p.name.slice(0, 8).toLowerCase())) return p.id
    const company = ctx.companies.find(c => c.id === p.companyId)
    if (company && [company.name, ...company.aliases].some(n => n && title.includes(n.toLowerCase()))) return p.id
  }
  return null
}

/** 予定からのプロジェクト推定（projectId 明示 → タイトル一致） */
function inferProjectId(ctx: DraftContext, e: CalendarEvent): string | null {
  if (e.projectId) return e.projectId
  return inferProjectIdFromText(ctx, e.title)
}

/** 0.25h 刻みへ丸め */
export function toQuarterHours(minutes: number): number {
  return Math.max(0.25, Math.round(minutes / 15) / 4)
}

/** 業務テーマ（自由入力）の生成: 推定プロジェクト名 → なければタイトル先頭の名詞句相当（先頭 20 字） */
function themeOf(ctx: DraftContext, projectId: string | null, title: string): string {
  if (projectId) {
    const p = ctx.projects.find(x => x.id === projectId)
    if (p) return p.name
  }
  return [...title].slice(0, 20).join('')
}

/** 日報ドラフトの決定的生成（mock useReportAssist.generateDraft と同一ロジック） */
export function heuristicReportDraft(ctx: DraftContext, date: string): ReportDraft {
  const { events, logs, dayPlans } = ctx
  const donePlans = dayPlans.filter(p => p.status === 'done')
  const planByEventId = new Map(dayPlans.filter(p => p.calendarEventId).map(p => [p.calendarEventId, p]))
  const basis: string[] = []

  // entries: 予定 → プロジェクト推定 + 工数（予定時間） + 回答/計画結果による進捗推定
  const entries: ReportEntry[] = events.map((e) => {
    const pid = inferProjectId(ctx, e)
    const plan = planByEventId.get(e.id)
    const ans = plan?.status === 'done'
      ? plan.outcome
      : [...logs].reverse().find(l => l.kind === 'qa' && l.calendarEventId === e.id)?.answer ?? ''
    const negative = NEGATIVE_HINTS.some(h => ans.includes(h))
    const done = plan?.status === 'done' || /完了|予定どおり/.test(ans)
    if (pid && !e.projectId) basis.push(`「${e.title}」→ タイトルから業務テーマを推定`)
    return {
      theme: themeOf(ctx, pid, e.title),
      projectId: pid ?? '',
      task: ans && !ans.startsWith('特になし') ? `${e.title}（${ans.slice(0, 40)}）` : e.title,
      hours: toQuarterHours(Math.max(0, hhmmToMin(e.to) - hhmmToMin(e.from))),
      progress: done ? 100 : negative ? 50 : 80,
    }
  })
  if (events.length > 0) basis.push(`工数はカレンダー予定の時間から算出（${events.length} 件）`)

  // 予定に紐付かない完了タスク（手動計画）もエントリへ（工数は既定 1h → 確認・修正で調整）
  for (const p of donePlans.filter(x => !x.calendarEventId)) {
    const negative = NEGATIVE_HINTS.some(h => p.outcome.includes(h))
    const pid = inferProjectIdFromText(ctx, p.title)
    entries.push({
      theme: themeOf(ctx, pid, p.title),
      projectId: pid ?? '',
      task: `${p.title}（${p.outcome.slice(0, 40)}）`,
      hours: 1,
      progress: negative ? 50 : 100,
    })
  }
  if (donePlans.length > 0) basis.push(`タスク計画の結果 ${donePlans.length} 件を反映（AI業務アシスタント）`)

  // 所感: 計画の所感 + フォーカス回答 + ぽいぽいメモ
  const focus = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.focus))?.answer
  const memos = logs.filter(l => l.kind === 'memo').map(l => l.answer)
  const planReflections = donePlans
    .filter(p => p.reflection)
    .map(p => `${p.title}: ${p.reflection}`)
  const reflectionParts = [
    ...planReflections,
    focus ? `今日は${focus}に注力した。` : '',
    ...memos.map(m => `メモ: ${m}`),
  ].filter(Boolean)
  if (planReflections.length > 0) basis.push(`タスクの所感 ${planReflections.length} 件を所感へ反映`)
  if (memos.length > 0) basis.push(`ぽいぽいポスト ${memos.length} 件を所感へ反映`)

  // 課題: 課題回答（「特になし」以外） + イベント回答/計画結果のネガティブ表現
  const issueAns = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.issue))?.answer ?? ''
  const negatives = logs
    .filter(l => l.kind === 'qa' && l.calendarEventId && NEGATIVE_HINTS.some(h => l.answer.includes(h)))
    .map((l) => {
      const ev = events.find(e => e.id === l.calendarEventId)
      return ev ? `${ev.title}: ${l.answer}` : l.answer
    })
  const planNegatives = donePlans
    .filter(p => NEGATIVE_HINTS.some(h => p.outcome.includes(h)))
    .map(p => `${p.title}: ${p.outcome}`)
  const issues = [
    issueAns && issueAns !== '特になし' ? issueAns : '',
    ...negatives,
    ...planNegatives,
  ].filter(Boolean).join('\n')
  if (issues) basis.push('課題はヒアリング回答・タスク結果から抽出（提出時に管理者へ共有）')

  // 明日の予定: まとめ回答 → なければ翌営業日のタスク計画から
  const tomorrowAns = [...logs].reverse().find(l => l.kind === 'qa' && l.question.startsWith(WRAPUP_KEYS.tomorrow))?.answer ?? ''
  let tomorrow = tomorrowAns
  if (!tomorrow && ctx.nextDayPlans.length > 0) {
    tomorrow = ctx.nextDayPlans.map(p => p.title).join(' / ')
    basis.push('明日の予定は翌営業日のタスク計画から生成')
  }

  return {
    entries: entries.length > 0 ? entries : [{ theme: '', projectId: '', task: '', hours: 1, progress: 0 }],
    reflection: reflectionParts.join('\n'),
    issues,
    tomorrow,
    basis,
  }
}

// 翌営業日の計算は shared/domain/business-day.ts の nextWorkingDay へ移設
// （勤怠ルールの営業曜日 + 祝日マスタ対応。オペレーター報告 2026-07-18 #4）
