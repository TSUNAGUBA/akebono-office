/**
 * 依頼者への質問ポリシー（バッチ7i: shared/domain/ai-tasks.heuristicNeedsInput）。
 * 質問は「自社・顧客のドメイン情報が不可欠」「依頼内容が実質空」のみに限定し、
 * 一般的な依頼は自力（Web 調査・材料）で遂行する（オペレーター指示 2026-07-19 #11）
 */
import { describe, expect, it } from 'vitest'
import { heuristicNeedsInput } from '../../../shared/domain/ai-tasks'

describe('heuristicNeedsInput（質問は必要時のみ）', () => {
  it('依頼内容が実質空（10 字未満）のときのみ具体化を確認する', () => {
    expect(heuristicNeedsInput('急ぎで頼む', 0)).toBeTruthy()
    expect(heuristicNeedsInput('競合3社の動向を調査して比較表にまとめる', 0)).toBeNull()
  })

  it('疑問形でも遂行対象が明確なら質問しない（旧仕様: ? を含むと質問 → 7i で廃止）', () => {
    expect(heuristicNeedsInput('市場規模はどの程度か? 調査してレポートにまとめてください', 0)).toBeNull()
  })

  it('自社・顧客固有の参照があり内容が薄い（30 字未満）ときは対象を確認する', () => {
    expect(heuristicNeedsInput('顧客向けの提案資料を作って', 0)).toBeTruthy()
    expect(heuristicNeedsInput('顧客 A 社向けの提案資料を、添付の過去資料の構成を踏襲して作成してください', 0)).toBeNull()
  })

  it('一度回答を得た依頼には再質問しない（質問ループを作らない）', () => {
    expect(heuristicNeedsInput('急ぎ', 1)).toBeNull()
    expect(heuristicNeedsInput('顧客向けの資料', 2)).toBeNull()
  })
})
