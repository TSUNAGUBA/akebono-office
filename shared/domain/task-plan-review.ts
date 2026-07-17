/**
 * タスク計画の AI レビュー（F-14）: 決定的ヒューリスティック（フロントエンドと API サービスで共有）
 * - モックモード: これが唯一のレビュー生成
 * - API モード: Vertex AI（LLM）失敗時のフォールバック（グレースフルデグラデーション = 原則4）
 * 観点: 目的の具体性 / 達成条件の検証可能性 / 段取りのステップ分解
 */

/** 達成条件が測定可能かの簡易判定（数値・完了語・成果物語のいずれかを含む） */
const MEASURABLE_HINTS = /[0-9０-９]|完了|完成|合意|承認|提出|レビュー|できている|されている|終わっている/
/** 段取りのステップ表現 */
const STEP_HINTS = /[①②③④⑤]|→|\n|1\.|2\./

export interface PlanReviewInput {
  purpose: string
  doneCriteria: string
  approach: string
}

/** 計画レビューコメントの生成（良い点 → 改善提案の順で結合した複数行テキスト） */
export function heuristicPlanReview(p: PlanReviewInput): string {
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

  return [...good, ...advice].join('\n')
}
