import { describe, expect, it } from 'vitest'
import { planDelegation } from '../../../shared/domain/ai-tasks'

const CANDIDATES = [
  { id: 'ai-1', name: 'リサ', roleName: 'リサーチャー', mission: '市場・業界の調査と情報収集を担当' },
  { id: 'ai-2', name: 'ライト', roleName: 'ライター', mission: '資料・ドラフト文書の作成を担当' },
]

describe('planDelegation（AI 社員間の連携計画。決定的ヒューリスティック）', () => {
  it('ステップを役割・ミッションとの字句類似で最適な担当へ割り当てる', () => {
    const plan = planDelegation(
      [{ title: '市場動向の調査と情報収集' }, { title: '提案資料のドラフト作成' }],
      CANDIDATES,
    )
    expect(plan).toHaveLength(2)
    expect(plan[0]).toEqual({ title: '市場動向の調査と情報収集', aiEmployeeId: 'ai-1' })
    expect(plan[1]).toEqual({ title: '提案資料のドラフト作成', aiEmployeeId: 'ai-2' })
  })

  it('語彙が全く重ならないステップはラウンドロビンで決定的に分散する', () => {
    const plan = planDelegation(
      [{ title: 'xyz' }, { title: 'qwe' }, { title: 'rty' }],
      CANDIDATES,
    )
    expect(plan.map(p => p.aiEmployeeId)).toEqual(['ai-1', 'ai-2', 'ai-1'])
  })

  it('候補ゼロは空配列（連携なし）・同一入力は同一出力（決定的）', () => {
    expect(planDelegation([{ title: '調査' }], [])).toEqual([])
    const a = planDelegation([{ title: '市場調査' }], CANDIDATES)
    const b = planDelegation([{ title: '市場調査' }], CANDIDATES)
    expect(a).toEqual(b)
  })
})
