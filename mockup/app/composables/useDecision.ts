/**
 * 意思決定支援（F-02）
 * テーマ取得・シナリオ予測（決定的な線形モデル）・判断の記録。
 * - 予測は入力パラメータに対して単調な線形式で、直感に反しない向きに設計する
 * - 判断ログは追記のみ（記録系保護）
 */
import type { DecisionLog, DecisionSlot, DecisionTheme, Result } from '~/types/domain'
import type { Tone } from '~/types/ui'
import { hashStr } from '~/utils/rng'

// ---------- 画面固有ラベル（labels.ts にない区分は担当ファイルで定義） ----------

export const DECISION_CATEGORY_LABELS: Record<DecisionTheme['category'], string> = {
  business: '事業',
  project: 'プロジェクト',
}

export const DECISION_CATEGORY_TONES: Record<DecisionTheme['category'], Tone> = {
  business: 'brand',
  project: 'info',
}

/** シナリオ予測の KPI（画面の KPI カードにそのまま渡せる形） */
export interface ScenarioKpi {
  label: string
  value: string
  sub?: string
}

function manYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('ja-JP')}万`
}

export function useDecision() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()

  const decisionThemes = tbl('decisionThemes')
  const decisionLogs = tbl('decisionLogs')

  const themes = computed<DecisionTheme[]>(() => decisionThemes.value)

  const logs = computed<DecisionLog[]>(() =>
    [...decisionLogs.value].sort((a, b) => b.at.localeCompare(a.at)))

  function themeById(id: string): DecisionTheme | undefined {
    return decisionThemes.value.find(t => t.id === id)
  }

  function logsOf(themeId: string): DecisionLog[] {
    return logs.value.filter(l => l.themeId === themeId)
  }

  /**
   * シナリオ予測（決定的な簡易線形モデル）
   * params は scenarioParams.key → 値。テーマ ID ごとに調整済みの式を使い、
   * 未知テーマは hashStr 由来の係数で単調な汎用式にフォールバックする。
   */
  function predict(theme: DecisionTheme, params: Record<string, number>): ScenarioKpi[] {
    const v = (key: string): number =>
      params[key] ?? theme.scenarioParams.find(p => p.key === key)?.default ?? 0

    if (theme.id === 'dt-01') {
      // 投入工数 × PoC 単価 → 追加売上。原価は 7.2 万円/人日
      const days = v('effortDays')
      const price = v('pocUnitPrice')
      const sales = days * price
      const cost = days * 7.2
      const profit = sales - cost
      const winRate = Math.min(70, 40 + Math.round(days * 2.5))
      return [
        { label: 'PoC 追加売上', value: manYen(sales), sub: `${days}人日 × ${manYen(price)}` },
        { label: '追加コスト', value: manYen(cost), sub: '稼働原価 ¥7.2万/人日' },
        { label: '追加利益', value: manYen(profit), sub: profit >= 0 ? '黒字レンジ' : '赤字レンジ' },
        { label: '正式導入の受注確度', value: `${winRate}%`, sub: '現状 40%' },
      ]
    }

    if (theme.id === 'dt-02') {
      // 保守売上 2,640 万円/年 を基準に改定率・解約率で線形変化
      const base = 2640
      const rate = v('revisionRate')
      const churn = v('churnRate')
      const sales = base * (1 + rate / 100) * (1 - churn / 100)
      const cost = base * 0.62 * (1 - churn / 100)
      const profit = sales - cost
      const baseProfit = base * 0.38
      return [
        { label: '改定後の保守売上（年）', value: manYen(sales), sub: `現状 ${manYen(base)}` },
        { label: '粗利（年）', value: manYen(profit), sub: `現状 ${manYen(baseProfit)}` },
        { label: '粗利増減', value: `${profit - baseProfit >= 0 ? '+' : ''}${manYen(profit - baseProfit)}`, sub: '対 現状' },
        { label: '粗利率', value: `${(profit / sales * 100).toFixed(1)}%`, sub: '現状 38.0%' },
      ]
    }

    if (theme.id === 'dt-03') {
      // 標準単価 130 万円/人月 × 稼働率 − 月額人件費
      const cost = v('monthlyCost')
      const util = v('utilization')
      const sales = 130 * util / 100
      const profit = sales - cost
      return [
        { label: '月間追加売上', value: manYen(sales), sub: `単価 ¥130万/人月 × 稼働率 ${util}%` },
        { label: '月間コスト', value: manYen(cost), sub: '給与 + 間接費' },
        { label: '月間利益', value: manYen(profit), sub: profit >= 0 ? '黒字レンジ' : '赤字レンジ' },
        { label: '年間利益インパクト', value: manYen(profit * 12), sub: '12 ヶ月換算' },
      ]
    }

    // 汎用フォールバック（単調な線形式。係数はテーマ ID から決定的に導出）
    const [p1, p2] = theme.scenarioParams
    const k1 = 5 + hashStr(`${theme.id}:${p1?.key ?? 'a'}`) % 6
    const k2 = 3 + hashStr(`${theme.id}:${p2?.key ?? 'b'}`) % 4
    const sales = (p1 ? v(p1.key) : 0) * k1 + (p2 ? v(p2.key) : 0) * k2
    const cost = sales * 0.6
    return [
      { label: '予測売上', value: manYen(sales) },
      { label: '予測コスト', value: manYen(cost) },
      { label: '予測利益', value: manYen(sales - cost) },
    ]
  }

  /** 判断を記録する（decisionLogs へ追記のみ） */
  function record(themeId: string, slot: DecisionSlot, reason: string): Result {
    const theme = themeById(themeId)
    if (!theme) return { ok: false, error: { code: 'AKO-DEC-001', message: '判断テーマが見つかりません' } }
    if (!theme.options.some(o => o.slot === slot)) {
      return { ok: false, error: { code: 'AKO-DEC-002', message: '選択肢が見つかりません' } }
    }
    if (!reason.trim()) {
      return { ok: false, error: { code: 'AKO-DEC-003', message: '判断理由を入力してください' } }
    }
    const id = nextId('decisionLogs', 'dl')
    decisionLogs.value = [...decisionLogs.value, {
      id,
      themeId,
      chosenSlot: slot,
      reason: reason.trim(),
      decidedBy: currentUser.value.id,
      at: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  return { themes, logs, themeById, logsOf, predict, record }
}
