/**
 * 着地予報エンジン（F-01 コックピット「地平線」層。SoT: cockpit-design.md §2.3）
 *
 * 月次目標（goals マスタ）に対する「このペースなら月末にどこへ着地するか」を決定的に導く純関数。
 * - kind='amount'（売上・勤務時間等の積み上げ量）: 経過営業日の日割りペースで外挿する
 * - kind='rate'（提出率等の比率）: 外挿しない（現在値をそのまま着地見込みとする = 率の外挿は誤誘導）
 * - inverse=true（残業等の上限型）: 小さいほど良い。予測が target を超えたら warn
 * - トーンは ok / warn の 2 値のみ（serious / crit は使わない = バッジインフレ防止。禁じ手 #4）
 * - reason に算定根拠を必ず 1 行で出す（予報が外れるリスクへの対処 = 予報の透明性）
 *
 * 営業日計算（経過営業日・総営業日）は呼び出し側の責務:
 * business-day.ts の workingDayRuleOf / isWorkingDay + 祝日マスタで数えた値を渡す（原則3）。
 * この層は入力から決定的に計算するだけで、日付・DB・キャッシュに依存しない（API と共有可能）。
 */

export type ForecastKind = 'amount' | 'rate'

export interface ForecastInput {
  id: string            // 'seg-01-sales' | 'report-rate' | 'my-overtime' | 'my-hours' など
  label: string
  kind: ForecastKind
  /** 月初（または期間開始）から今日までの実績 */
  current: number
  /** 目標（着地で達成したい値）。上限型（残業）は limit として扱う */
  target: number
  /** true = 小さいほど良い（残業など）。予測 >= target で warn */
  inverse?: boolean
  unit: 'currency' | 'percent' | 'hours'
  elapsedWorkingDays: number
  totalWorkingDays: number
}

export interface ForecastResult {
  id: string
  label: string
  /**
   * 着地予測。kind='amount': current / elapsed * total（elapsed=0 は current）
   * kind='rate': current をそのまま着地見込みとする（率は外挿しない）
   */
  projected: number
  target: number
  /** inverse を考慮した達成判定 */
  achieved: boolean
  /** current / target（バー描画用。0-1 超過はクランプしない: バーは min(1) でクランプし数値はそのまま） */
  progressRatio: number
  projectedRatio: number
  /** achieved → ok / それ以外 warn（serious/crit は使わない = インフレ防止） */
  tone: 'ok' | 'warn'
  /** 「残り N 営業日・日割りペース◯◯」の 1 行根拠（予報の透明性） */
  reason: string
}

// ---------- 表示ヘルパ（reason 用。portfolio-insight の man()/pct() と同系の丸め） ----------

const round1 = (n: number): number => Math.round(n * 10) / 10

/** 単位付きの値表示（currency = 万円 / percent = % / hours = h） */
function fmtValue(n: number, unit: ForecastInput['unit']): string {
  if (unit === 'currency') return `${(Math.round(n / 1000) / 10).toLocaleString('ja-JP')}万円`
  if (unit === 'percent') return `${round1(n)}%`
  return `${round1(n)}h`
}

/** 目標に対する比率（target=0 のゼロ除算は 0 として扱う = バーは空・達成判定は別途行う） */
function ratioOf(value: number, target: number): number {
  return target > 0 ? value / target : 0
}

/**
 * 1 指標の着地予報を決定的に計算する（副作用なし・同入力 → 同出力）。
 * elapsedWorkingDays は [0, totalWorkingDays] へクランプして日割りの発散を防ぐ。
 */
export function buildForecast(input: ForecastInput): ForecastResult {
  const total = Math.max(0, input.totalWorkingDays)
  const elapsed = Math.min(Math.max(0, input.elapsedWorkingDays), total)
  const remaining = total - elapsed

  // 着地予測: 量は日割り外挿・率は外挿しない（§2.3）。
  // elapsed=0（月初）と elapsed=total（全営業日経過）は外挿せず実績そのもの
  // （後者は数学的に同値だが、浮動小数点誤差で実績とズレた着地を出さないための明示分岐）
  const projected = input.kind === 'amount' && elapsed > 0 && elapsed < total
    ? (input.current / elapsed) * total
    : input.current

  // 達成判定（inverse = 上限型: 予測が上限以下なら達成）
  const achieved = input.inverse ? projected <= input.target : projected >= input.target

  // 根拠の 1 行（予報の透明性。率は「外挿しない」ことを明示する）
  const reason = input.kind === 'rate'
    ? `残り ${remaining} 営業日・率は外挿せず現在値 ${fmtValue(input.current, input.unit)} を着地見込みとします`
    : elapsed > 0
      ? `残り ${remaining} 営業日・日割りペース ${fmtValue(input.current / elapsed, input.unit)}/営業日 → 着地見込み ${fmtValue(projected, input.unit)}`
      : `営業日の経過前のため実績 ${fmtValue(input.current, input.unit)} をそのまま着地見込みとします（残り ${remaining} 営業日）`

  return {
    id: input.id,
    label: input.label,
    projected,
    target: input.target,
    achieved,
    progressRatio: ratioOf(input.current, input.target),
    projectedRatio: ratioOf(projected, input.target),
    tone: achieved ? 'ok' : 'warn',
    reason,
  }
}

/**
 * 予報群の 1 行サマリー（CockpitStrip の地平線行）。
 * warn が 1 本もない日は「順調」だけを示す（見なくていい日を明示する = §3.3）。
 * 空配列は「順調」扱い: 目標未設定のフォールバック表示（「目標未設定」導線）は呼び出し側の責務。
 */
export function summarizeForecasts(results: ForecastResult[]): { headline: string; tone: 'ok' | 'warn'; warnCount: number } {
  const warnCount = results.filter(r => r.tone === 'warn').length
  return warnCount > 0
    ? { headline: `針路修正 ${warnCount} 件`, tone: 'warn', warnCount }
    : { headline: '今週の見通し: 順調', tone: 'ok', warnCount: 0 }
}
