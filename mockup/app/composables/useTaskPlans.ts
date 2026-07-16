/**
 * AI業務アシスタント（F-14）: タスク計画・AI コメント・振り返り・インサイト
 * フロー: 前日の終わりに翌日のタスクへ 目的/達成条件/段取り を登録
 *       → AI コメント（モック: 決定的ヒューリスティック。本実装は LLM）を受けて修正
 *       → 当日の終わりに 結果/所感 を記録（status='done'。以後編集不可 = 記録系保護）
 *       → 日報ドラフト（useReportAssist.generateDraft）へ自動反映可能になる
 * 蓄積データは管理者インサイト（計画数・完了率・振り返り記入率）の元ネタ。
 */
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

/** 達成条件が測定可能かの簡易判定（数値・完了語・成果物語のいずれかを含む） */
const MEASURABLE_HINTS = /[0-9０-９]|完了|完成|合意|承認|提出|レビュー|できている|されている|終わっている/
/** 段取りのステップ表現 */
const STEP_HINTS = /[①②③④⑤]|→|\n|1\.|2\./

export function useTaskPlans() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const plans = tbl('taskPlans')
  const members = tbl('members')

  function plansOf(memberId: string, date: string): TaskPlan[] {
    return plans.value
      .filter(p => p.memberId === memberId && p.date === date)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * 計画の作成・更新（本人のみ）。結果記録済み（done）の計画は編集不可（記録保護）。
   * 更新時は AI コメントを保持する（内容を大きく変えたら「AI コメントをもらう」で再取得）。
   */
  function upsertPlan(input: PlanInput): Result {
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
  function removePlan(planId: string): Result {
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
  function aiReview(planId: string): Result {
    const p = plans.value.find(x => x.id === planId)
    if (!p || p.memberId !== currentUser.value.id) {
      return { ok: false, error: { code: 'AKO-TPL-003', message: '自分の計画のみレビューを受けられます' } }
    }
    if (p.status === 'done') {
      return { ok: false, error: { code: 'AKO-TPL-004', message: '結果記録済みの計画はレビュー対象外です' } }
    }
    const good: string[] = []
    const advice: string[] = []

    if (!p.purpose) {
      advice.push('目的が未記入です。「なぜやるか」を一言でも書くと、当日の判断がぶれにくくなります。')
    } else if (p.purpose.length < 8) {
      advice.push('目的をもう一歩具体化しましょう。誰の・何の状態を変えるのかまで書くのがおすすめです。')
    } else {
      good.push('目的が明確です。')
    }

    if (!p.doneCriteria) {
      advice.push('達成条件が未記入です。「〜が完成している」「〜が合意されている」のように終了状態で書きましょう。')
    } else if (!MEASURABLE_HINTS.test(p.doneCriteria)) {
      advice.push('達成条件を検証可能な形にしましょう（数値・成果物・合意など、第三者が判定できる表現）。')
    } else {
      good.push('達成条件が検証可能で良いです。')
    }

    if (!p.approach) {
      advice.push('段取りが未記入です。最初の 30 分に着手することだけでも決めておくと立ち上がりが速くなります。')
    } else if (!STEP_HINTS.test(p.approach)) {
      advice.push('段取りをステップに分解しましょう（① ② ③ や矢印区切り）。分解すると詰まりどころが事前に見えます。')
    } else {
      good.push('段取りがステップに分解されています。')
    }

    if (advice.length === 0) {
      advice.push('計画に大きな穴はありません。想定外が起きたときに「どこまでで切り上げるか」の撤退ラインだけ意識しておきましょう。')
    }

    const comment = [...good, ...advice].join('\n')
    plans.value = plans.value.map(x => x.id === planId
      ? { ...x, aiComment: comment, aiCommentAt: nowJstIso() }
      : x)
    commit()
    return { ok: true, id: planId }
  }

  /** 結果・所感の記録（本人のみ・1 回で確定。以後は編集不可 = 記録系） */
  function recordResult(planId: string, input: { outcome: string; reflection: string }): Result {
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

  return { plans, plansOf, upsertPlan, removePlan, aiReview, recordResult, insights }
}
