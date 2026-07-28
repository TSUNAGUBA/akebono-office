/**
 * 業務（Akebono）× メディア分析の統合インサイト（PDCA 支援）。
 * セグメント（業態）の売上・受注（salesRecords 集計）とメディアの GA メトリクスを突き合わせ、
 * 人が判断し PDCA サイクルを回すための「現状分析・相関・次アクション」を導く。
 *
 * - 集計（IntegratedMetrics）はフロント（モック）/ API で同一型
 * - 洞察は API = Vertex AI → 失敗時 heuristicIntegratedInsight / モック = heuristic のみ（原則4）
 * - ヒューリスティックは metrics のみから決定的に生成する
 */

export interface IntegratedTrendPoint {
  month: string
  sessions: number
  conversions: number
  salesAmount: number
  orders: number
}

export interface IntegratedMetrics {
  segmentId: string
  segmentName: string
  siteName: string
  /** 対象月（最新の集計月） */
  periodMonth: string
  // メディア（対象月）
  sessions: number
  conversions: number
  conversionRate: number
  prevSessions: number
  prevConversions: number
  // 業務（対象月・当該セグメントの売上明細集計）
  salesAmount: number
  orders: number
  prevSalesAmount: number
  /** 平均受注額（売上 / 受注件数） */
  aov: number
  /** セッションあたり売上（円）= 売上 / セッション */
  salesPerSession: number
  /** 簡易ファネル（対象月） */
  funnel: { sessions: number; engaged: number; conversions: number; orders: number }
  /** 直近数ヶ月のトレンド（古い順） */
  trend: IntegratedTrendPoint[]
}

export interface IntegratedInsight {
  executiveSummary: string
  /** メディア → 業務の関連（相関の読み） */
  correlation: string[]
  /** PDCA の 4 象限 */
  pdca: { plan: string[]; do: string[]; check: string[]; act: string[] }
  actions: { title: string; detail: string; priority: 'high' | 'mid' | 'low' }[]
  risks: { title: string; severity: 'high' | 'mid' | 'low'; mitigation: string }[]
}

const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`
const yen = (n: number): string => `${Math.round(n).toLocaleString('ja-JP')}円`
const man = (n: number): string => `${(Math.round(n / 1000) / 10).toLocaleString('ja-JP')}万円`
const delta = (cur: number, prev: number): number => (prev > 0 ? (cur - prev) / prev : 0)

/** ピアソン相関係数（トレンドの sessions × salesAmount）。データ点 < 3 は null */
function correlationOf(points: IntegratedTrendPoint[]): number | null {
  const pts = points.filter(p => p.sessions > 0 || p.salesAmount > 0)
  const n = pts.length
  if (n < 3) return null
  const xs = pts.map(p => p.sessions)
  const ys = pts.map(p => p.salesAmount)
  const mx = xs.reduce((s, x) => s + x, 0) / n
  const my = ys.reduce((s, y) => s + y, 0) / n
  let num = 0; let dx = 0; let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx; const b = ys[i]! - my
    num += a * b; dx += a * a; dy += b * b
  }
  const den = Math.sqrt(dx * dy)
  return den === 0 ? null : Math.round(num / den * 100) / 100
}

/**
 * 決定的な統合インサイト生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * 現状分析（Check）・改善（Act）・仮説（Plan）・実験（Do）を metrics から導く。
 */
export function heuristicIntegratedInsight(m: IntegratedMetrics): IntegratedInsight {
  const correlation: string[] = []
  const plan: string[] = []
  const doList: string[] = []
  const check: string[] = []
  const act: string[] = []
  const actions: IntegratedInsight['actions'] = []
  const risks: IntegratedInsight['risks'] = []

  const sessionDelta = delta(m.sessions, m.prevSessions)
  const salesDelta = delta(m.salesAmount, m.prevSalesAmount)
  const convDelta = delta(m.conversions, m.prevConversions)
  const corr = correlationOf(m.trend)

  // ---- Check（現状分析） ----
  check.push(`対象月 ${m.periodMonth}: メディアのセッション ${m.sessions.toLocaleString('ja-JP')}（前月比 ${sessionDelta >= 0 ? '+' : ''}${pct(sessionDelta)}）、コンバージョン ${m.conversions}（CVR ${pct(m.conversionRate)}）。`)
  check.push(`業務: 売上 ${man(m.salesAmount)}（前月比 ${salesDelta >= 0 ? '+' : ''}${pct(salesDelta)}）、受注 ${m.orders} 件、平均受注額 ${yen(m.aov)}。`)
  check.push(`セッションあたり売上は ${yen(m.salesPerSession)}。ファネルは セッション ${m.funnel.sessions} → 主体的関与 ${m.funnel.engaged} → CV ${m.funnel.conversions} → 受注 ${m.funnel.orders}。`)

  // ---- 相関（メディア → 業務） ----
  if (corr !== null) {
    if (corr >= 0.5) {
      correlation.push(`セッションと売上の相関が強い（r=${corr}）。メディア流入の増加が売上に結びついています。集客投資の効果が出ている状態です。`)
    } else if (corr <= -0.3) {
      correlation.push(`セッションと売上が逆行（r=${corr}）。流入は増えても売上に転換できていません。導線・提案内容の見直しが必要です。`)
    } else {
      correlation.push(`セッションと売上の相関は弱い（r=${corr}）。流入量よりも記事の質・ターゲット適合・導線が売上を左右している可能性があります。`)
    }
  } else {
    correlation.push('相関を判定するにはデータ期間が不足しています（3 ヶ月以上の蓄積で精度が上がります）。')
  }
  if (sessionDelta >= 0.1 && salesDelta <= 0) {
    correlation.push(`流入は増加（+${pct(sessionDelta)}）だが売上は伸びていません（${pct(salesDelta)}）。集客の「量」は取れているため、転換（CVR・提案）に課題があります。`)
  }
  if (sessionDelta <= -0.1 && salesDelta <= -0.1) {
    correlation.push('流入・売上がともに減少。まず流入の回復（SEO・記事更新）を優先し、次に転換の改善へ進みます。')
  }

  // ---- 相関・状況に応じた PDCA ----
  if (m.conversionRate < 0.01) {
    act.push('主要導線（記事 → サービス/資料請求）の CTA とフォームを見直し、CVR を 1% 以上へ引き上げる。')
    plan.push('CVR 1% を当面の目標に設定し、CTA 文言・配置の A/B テストを計画する。')
    doList.push('上位 PV 記事 3 本に、関連サービスへの CTA を追加して効果を計測する。')
    actions.push({ title: 'CVR 改善（1% 目標）', detail: '集客はあるが転換が弱い。CTA・フォーム・関連導線を改善し、流入を売上に変えます。', priority: 'high' })
  } else {
    act.push('CVR の高いセクション・記事への内部リンクを増やし、成果に近い動線を太くする。')
  }
  if (sessionDelta <= -0.1) {
    act.push('流入減の主因（オーガニック検索の順位低下・記事の陳腐化）を特定し、下降記事をリライトする。')
    plan.push('下降記事の棚卸しと、検索意図に合わせたリライト計画を立てる。')
    risks.push({ title: 'メディア流入の継続的な減少', severity: sessionDelta <= -0.25 ? 'high' : 'mid', mitigation: '主要記事のリライトと内部リンク再設計で自然流入を回復する。' })
  } else if (sessionDelta >= 0.1) {
    plan.push(`伸びている流入（+${pct(sessionDelta)}）を活かし、成果に近いテーマの記事を追加して受注へつなげる。`)
    doList.push('伸長テーマの周辺キーワードで新規記事を作成し、関連サービスへ送客する。')
  }
  if (m.salesPerSession > 0) {
    check.push(`メディア経由の推定寄与: セッションあたり ${yen(m.salesPerSession)} を基準に、流入 +1,000 セッションで売上 +${man(m.salesPerSession * 1000)} 相当が見込めます（相関前提の概算）。`)
  }
  if (m.aov > 0 && salesDelta < 0 && convDelta >= 0) {
    correlation.push('コンバージョン数は維持しているのに売上が減少。単価（AOV）低下の可能性があり、提案商材の見直し余地があります。')
    act.push('平均受注額の低下要因を確認し、アップセル・上位プランへの導線を検討する。')
  }
  if (plan.length === 0) plan.push('現状の目標を維持し、上位記事の更新と内部リンクの整備を継続する。')
  if (doList.length === 0) doList.push('主力記事の関連リンク・CTA を点検し、月次で成果を確認する。')
  if (act.length === 0) act.push('大きな課題は見られないため、現状の運用を継続し月次でモニタリングする。')

  if (actions.length === 0) {
    actions.push({ title: 'メディアと業務の月次レビューを継続', detail: '流入・CVR・売上を同じダッシュボードで確認し、PDCA を回します。', priority: 'mid' })
  }

  const executiveSummary = [
    `**${m.segmentName}**（${m.siteName}）の業務 × メディア統合分析（対象月 ${m.periodMonth}）。`,
    `メディア流入は ${sessionDelta >= 0 ? '増加' : '減少'}（${sessionDelta >= 0 ? '+' : ''}${pct(sessionDelta)}）、売上は ${salesDelta >= 0 ? '増加' : '減少'}（${salesDelta >= 0 ? '+' : ''}${pct(salesDelta)}）。`,
    corr !== null ? `流入と売上の相関は r=${corr}。` : 'データ蓄積が進めば相関の精度が上がります。',
    m.conversionRate < 0.01 ? '転換（CVR）に改善余地があります。' : '転換は一定水準にあります。',
  ].filter(Boolean).join('')

  return {
    executiveSummary,
    correlation,
    pdca: { plan: plan.slice(0, 5), do: doList.slice(0, 5), check: check.slice(0, 6), act: act.slice(0, 5) },
    actions: actions.slice(0, 6),
    risks: risks.slice(0, 4),
  }
}
