/**
 * AI業務アシスタント（F-14）: タスク計画・AI コメント・振り返り・インサイト
 * フロー: 前日の終わりに翌日のタスクへ 目的/達成条件/段取り を登録
 *       → AI コメント（モック: 決定的ヒューリスティック。本実装は LLM）を受けて修正
 *       → 当日の終わりに 結果/所感 を記録（status='done'。以後編集不可 = 記録系保護）
 *       → 日報ドラフト（useReportAssist.generateDraft）へ自動反映可能になる
 * 蓄積データは管理者インサイト（計画数・完了率・振り返り記入率）の元ネタ。
 */
import type { Ref } from 'vue'
import { heuristicPlanReview } from '../../../shared/domain/task-plan-review'
import type { Result, TaskPlan } from '~/types/domain'

export interface PlanInput {
  id?: string
  date: string
  calendarEventId: string | null
  title: string
  purpose: string
  doneCriteria: string
  approach: string
}

export interface MemberInsight {
  memberId: string
  name: string
  planned: number
  done: number
  /** 完了率（結果記録済み / 対象日が過去のタスク計画） */
  doneRate: number | null
  /** 振り返り（reflection）記入率 */
  reflectionRate: number | null
}


// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiTaskPlans = ref<TaskPlan[]>([])
const apiInsights = ref<MemberInsight[]>([])

/** 自分の計画（±31 日）の一括ハイドレーション */
function loadTaskPlans(force = false): Promise<void> {
  return apiLoadOnce('tpl:list', async () => {
    apiTaskPlans.value = await apiFetch<TaskPlan[]>('/v1/task-plans')
  }, force)
}

function loadInsights(force = false): Promise<void> {
  return apiLoadOnce('tpl:insights', async () => {
    apiInsights.value = await apiFetch<MemberInsight[]>('/v1/task-plans/insights', { query: { days: '7' } })
  }, force)
}

onApiReset(() => {
  apiTaskPlans.value = []
  apiInsights.value = []
})

export function useTaskPlans() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { isAdmin } = useCurrentUser()
  const isApi = useApiMode()
  // API モードはキャッシュをバッキングにし、射影（plansOf 等）を共通利用する
  const plans = isApi ? (apiTaskPlans as Ref<TaskPlan[]>) : tbl('taskPlans')
  const members = tbl('members')
  if (isApi) {
    void loadTaskPlans()
    if (isAdmin.value) void loadInsights()
  }

  /** 表示時の取り直し（AI業務アシスタントページ表示時に呼ぶ） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await Promise.all([loadTaskPlans(true), isAdmin.value ? loadInsights(true) : Promise.resolve()])
  }

  function plansOf(memberId: string, date: string): TaskPlan[] {
    return plans.value
      .filter(p => p.memberId === memberId && p.date === date)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * 計画の作成・更新（本人のみ）。結果記録済み（done）の計画は編集不可（記録保護）。
   * 更新時は AI コメントを保持する（内容を大きく変えたら「AI コメントをもらう」で再取得）。
   */
  async function upsertPlan(input: PlanInput): Promise<Result> {
    if (isApi) {
      // 検証・本人ガード・記録保護はサーバーが担う → 成功後にキャッシュを取り直す（原則6）
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/task-plans', {
        method: 'PUT', body: input,
      }))
      if (res.ok) await loadTaskPlans(true)
      return res
    }
    if (!input.title.trim()) {
      return { ok: false, error: { code: 'AKO-TPL-001', message: 'タスク名を入力してください' } }
    }
    if (!input.date) {
      return { ok: false, error: { code: 'AKO-TPL-002', message: '実施予定日を選択してください' } }
    }
    const now = nowJstIso()
    if (input.id) {
      const existing = plans.value.find(p => p.id === input.id)
      if (!existing || existing.memberId !== currentUser.value.id) {
        return { ok: false, error: { code: 'AKO-TPL-003', message: '自分の計画のみ編集できます' } }
      }
      if (existing.status === 'done') {
        return { ok: false, error: { code: 'AKO-TPL-004', message: '結果記録済みの計画は編集できません' } }
      }
      plans.value = plans.value.map(p => p.id === input.id
        ? {
            ...p,
            date: input.date,
            calendarEventId: input.calendarEventId,
            title: input.title.trim(),
            purpose: input.purpose.trim(),
            doneCriteria: input.doneCriteria.trim(),
            approach: input.approach.trim(),
            updatedAt: now,
          }
        : p)
      commit()
      return { ok: true, id: input.id }
    }
    const id = nextId('taskPlans', 'tp')
    plans.value = [...plans.value, {
      id,
      memberId: currentUser.value.id,
      date: input.date,
      calendarEventId: input.calendarEventId,
      title: input.title.trim(),
      purpose: input.purpose.trim(),
      doneCriteria: input.doneCriteria.trim(),
      approach: input.approach.trim(),
      aiComment: '',
      aiCommentAt: null,
      status: 'planned',
      outcome: '',
      reflection: '',
      resultAt: null,
      createdAt: now,
      updatedAt: now,
    }]
    commit()
    return { ok: true, id }
  }

  /** 計画の削除（本人・planned のみ。done は記録のため削除不可） */
  async function removePlan(planId: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/task-plans/${planId}/remove`, { method: 'POST' }))
      if (res.ok) await loadTaskPlans(true)
      return res
    }
    const p = plans.value.find(x => x.id === planId)
    if (!p || p.memberId !== currentUser.value.id) {
      return { ok: false, error: { code: 'AKO-TPL-003', message: '自分の計画のみ削除できます' } }
    }
    if (p.status === 'done') {
      return { ok: false, error: { code: 'AKO-TPL-004', message: '結果記録済みの計画は削除できません' } }
    }
    plans.value = plans.value.filter(x => x.id !== planId)
    commit()
    return { ok: true, id: planId }
  }

  /**
   * AI レビューコメントの生成（モック: 決定的ヒューリスティック整形。本実装は LLM 構造化出力 +
   * 失敗時は本ヒューリスティックへフォールバック）。何度でも再取得できる（コメントの上書きのみ）。
   */
  async function aiReview(planId: string): Promise<Result> {
    if (isApi) {
      // 生成は Vertex AI（サーバー）。失敗時はサーバー側で同一ヒューリスティックへフォールバック
      const res = await apiResult(() => apiFetch(`/v1/task-plans/${planId}/ai-review`, { method: 'POST' }))
      if (res.ok) await loadTaskPlans(true)
      return res
    }
    const p = plans.value.find(x => x.id === planId)
    if (!p || p.memberId !== currentUser.value.id) {
      return { ok: false, error: { code: 'AKO-TPL-003', message: '自分の計画のみレビューを受けられます' } }
    }
    if (p.status === 'done') {
      return { ok: false, error: { code: 'AKO-TPL-004', message: '結果記録済みの計画はレビュー対象外です' } }
    }
    // レビュー文言の SoT は shared/domain/task-plan-review（API のフォールバックと同一実装）
    const comment = heuristicPlanReview({ purpose: p.purpose, doneCriteria: p.doneCriteria, approach: p.approach })
    plans.value = plans.value.map(x => x.id === planId
      ? { ...x, aiComment: comment, aiCommentAt: nowJstIso() }
      : x)
    commit()
    return { ok: true, id: planId }
  }

  /** 結果・所感の記録（本人のみ・1 回で確定。以後は編集不可 = 記録系） */
  async function recordResult(planId: string, input: { outcome: string; reflection: string }): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/task-plans/${planId}/result`, {
        method: 'POST', body: input,
      }))
      if (res.ok) await loadTaskPlans(true)
      return res
    }
    const p = plans.value.find(x => x.id === planId)
    if (!p || p.memberId !== currentUser.value.id) {
      return { ok: false, error: { code: 'AKO-TPL-003', message: '自分の計画のみ記録できます' } }
    }
    if (p.status === 'done') {
      return { ok: false, error: { code: 'AKO-TPL-004', message: 'この計画は記録済みです' } }
    }
    if (!input.outcome.trim()) {
      return { ok: false, error: { code: 'AKO-TPL-005', message: '結果を入力してください' } }
    }
    const now = nowJstIso()
    plans.value = plans.value.map(x => x.id === planId
      ? {
          ...x,
          status: 'done',
          outcome: input.outcome.trim(),
          reflection: input.reflection.trim(),
          resultAt: now,
          updatedAt: now,
        }
      : x)
    commit()
    return { ok: true, id: planId }
  }

  /**
   * 管理者向けインサイト（直近 days 日）: メンバー別の計画数・完了率・振り返り記入率。
   * 完了率の分母は「対象日が今日以前」の計画のみ（未来の計画は未完了扱いにしない）。
   */
  function insights(days = 7): MemberInsight[] {
    // API モードはサーバー集計（直近 7 日固定。他人の計画はクライアントへ出さない = 本人スコープ維持）
    if (isApi) return apiInsights.value
    const today = todayJst()
    const from = addDays(today, -(days - 1))
    return members.value
      .filter(m => m.active && m.employmentType !== 'outsource')
      .map((m) => {
        const mine = plans.value.filter(p => p.memberId === m.id && p.date >= from && p.date <= today)
        const dueMine = mine.filter(p => p.date <= today)
        const done = dueMine.filter(p => p.status === 'done')
        return {
          memberId: m.id,
          name: m.name,
          planned: mine.length,
          done: done.length,
          doneRate: dueMine.length > 0 ? done.length / dueMine.length : null,
          reflectionRate: done.length > 0
            ? done.filter(p => p.reflection.trim() !== '').length / done.length
            : null,
        }
      })
      .filter(x => x.planned > 0)
      .sort((a, b) => b.planned - a.planned)
  }

  return { plans, plansOf, upsertPlan, removePlan, aiReview, recordResult, insights, refresh }
}
