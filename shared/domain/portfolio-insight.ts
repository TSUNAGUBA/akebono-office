/**
 * 事業セグメント（業態）ダッシュボード & 会社全体ダッシュボードの AI レポート/インサイト。
 *
 * Akebono 業務の各セグメント（業態）について、業務（売上・受注）× メディア（GA 流入・CV）を統合し、
 * - セグメント単位（heuristicSegmentInsight）: 現状レポート（ナラティブ）+ インサイト（好調/課題/機会 + 次アクション）
 * - 会社全体（heuristicCompanyInsight）: 全セグメントのロールアップからの経営レポート + インサイト
 * を決定的に導く。ダッシュボード画面はサマリー（KPI・チャート）+ この AI レポート/インサイトを並べて表示する。
 *
 * - 集計（SegmentSummary / CompanySummary）はフロント（モック）/ API で同一型
 * - 洞察は API = Vertex AI（構造化出力）→ 失敗時ヒューリスティック / モック = heuristic のみ（原則4）
 * - ヒューリスティックは metrics のみから決定的に生成する（推測で事実を作らない）
 * - Finding / Action の型はメディアインサイトと共有する（原則3: 同義の型を重複させない）
 */
import type { MediaAction, MediaFinding } from './media-insight'

export type { MediaAction, MediaFinding }

/** ダッシュボードの月次トレンド 1 点（業務 × メディア。古い順で並べる） */
export interface DashboardMonthPoint {
  month: string
  salesAmount: number
  orders: number
  /** GA 連携セグメントの合算（未連携分は含まない） */
  sessions: number
  conversions: number
}

/** セグメント（業態）1 件の現状スナップショット（対象月 = 直前の完了月） */
export interface SegmentSnapshot {
  segmentId: string
  segmentName: string
  industryLabel: string
  /** GA 連携済みか（未連携ならメディア指標は 0・レポートで連携を促す） */
  mediaConnected: boolean
  // ---- 業務（対象月） ----
  salesAmount: number
  prevSalesAmount: number
  orders: number
  /** 平均受注額（売上 / 受注件数） */
  aov: number
  // ---- メディア（対象月・GA 連携時のみ有効。未連携は 0） ----
  sessions: number
  prevSessions: number
  conversions: number
  conversionRate: number
  articleCount: number
}

/** 1 セグメントのダッシュボード集計（サマリー + AI 生成の入力） */
export interface SegmentSummary {
  periodMonth: string
  /** メディア機能トグルが有効か（false = メディア軸は対象外。「未連携」ではなく「非対象」として扱う） */
  mediaAvailable: boolean
  snapshot: SegmentSnapshot
  /** 直近数ヶ月のトレンド（古い順） */
  trend: DashboardMonthPoint[]
}

/** 会社全体（全セグメント横断）のダッシュボード集計 */
export interface CompanySummary {
  periodMonth: string
  /** メディア機能トグルが有効か（false = メディア軸は対象外） */
  mediaAvailable: boolean
  segmentCount: number
  /** GA 連携済みセグメント数 */
  connectedCount: number
  totalSales: number
  prevTotalSales: number
  totalOrders: number
  totalSessions: number
  prevTotalSessions: number
  totalConversions: number
  /** セグメント別スナップショット（売上降順で渡す想定だが順序は非依存に計算する） */
  snapshots: SegmentSnapshot[]
  /** 会社全体の月次トレンド（古い順） */
  trend: DashboardMonthPoint[]
}

/** AI レポート（executiveSummary = ナラティブ）+ AI インサイト（findings + actions） */
export interface DashboardInsight {
  /** AI レポート本文（マークダウン） */
  executiveSummary: string
  /** 好調 / 課題 / 機会 の所見 */
  findings: MediaFinding[]
  /** 次に起こすべきアクション */
  actions: MediaAction[]
}

/**
 * 保管されるダッシュボードインサイト（導出キャッシュ = 再生成で上書き。週次/メディアインサイトと同思想）。
 * scope='segment'（業態単位・segmentId 参照）/ 'company'（会社全体・segmentId=null）。
 */
export interface DashboardInsightRecord {
  id: string
  scope: 'segment' | 'company'
  segmentId: string | null
  /** 対象期間キー（例: '2026-06'） */
  periodKey: string
  metrics: unknown
  insight: unknown
  llm: boolean
  generatedBy: string
  generatedAt: string
}

// ---------- しきい値（マジックナンバーを命名。原則: しきい値はコード内に明示） ----------

/** 前月比 +10% 以上で「好調」、−10% 以下で「課題」とみなす */
const GROWTH_STRONG = 0.1
const DECLINE = -0.1
/** CVR 1% 未満は改善余地ありとみなす（メディアインサイトと同一基準） */
const CVR_LOW = 0.01
/** 1 セグメントが会社売上の 50% 以上を占めると集中リスクとみなす */
const CONCENTRATION = 0.5

// ---------- 表示ヘルパ ----------

const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`
const signed = (r: number): string => `${r >= 0 ? '+' : ''}${pct(r)}`
const man = (n: number): string => `${(Math.round(n / 1000) / 10).toLocaleString('ja-JP')}万円`
const int = (n: number): string => Math.round(n).toLocaleString('ja-JP')
const delta = (cur: number, prev: number): number => (prev > 0 ? (cur - prev) / prev : 0)

/**
 * 決定的なセグメントダッシュボードインサイト生成（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * 業務（売上・受注）とメディア（流入・CV）の現状から、AI レポートとインサイト・次アクションを導く。
 */
export function heuristicSegmentInsight(s: SegmentSummary): DashboardInsight {
  const m = s.snapshot
  const findings: MediaFinding[] = []
  const actions: MediaAction[] = []

  const salesDelta = delta(m.salesAmount, m.prevSalesAmount)
  const sessionDelta = delta(m.sessions, m.prevSessions)

  // ---- 業務（売上）の所見 ----
  if (m.prevSalesAmount > 0 && salesDelta >= GROWTH_STRONG) {
    findings.push({
      kind: 'win',
      title: `売上が前月比 ${signed(salesDelta)}（${man(m.salesAmount)}）`,
      detail: `${s.periodMonth} の売上は好調です。伸びを牽引した商材・チャネルを特定し、翌月の重点配分に反映します。`,
    })
  } else if (m.prevSalesAmount > 0 && salesDelta <= DECLINE) {
    findings.push({
      kind: 'issue',
      title: `売上が前月比 ${signed(salesDelta)}（${man(m.salesAmount)}）`,
      detail: '前月から減速しています。受注件数と平均受注額のどちらが落ちたかを切り分け、要因に応じた打ち手を講じます。',
    })
    actions.push({
      title: '売上減速の要因分解（件数 × 単価）',
      detail: `受注 ${m.orders} 件・平均受注額 ${m.aov > 0 ? man(m.aov) : '—'}。件数減ならメディア流入・CVR を、単価減なら商品構成・値引きを点検します。`,
      priority: 'high',
    })
  } else {
    findings.push({
      kind: 'win',
      title: `売上は横ばい（${man(m.salesAmount)}・前月比 ${signed(salesDelta)}）`,
      detail: '大きな変動はありません。安定基盤を維持しつつ、メディア流入の底上げで次の成長余地を作ります。',
    })
  }

  // ---- メディアの所見（メディア機能が有効なときのみ。無効時はメディア軸を一切扱わない = 誤誘導を出さない） ----
  if (s.mediaAvailable && !m.mediaConnected) {
    findings.push({
      kind: 'opportunity',
      title: 'メディア分析が未接続（Google Analytics 未連携）',
      detail: 'この業態のオウンドメディアを GA 連携すると、流入と売上を突き合わせた PDCA・記事別インサイトが使えます。',
    })
    actions.push({
      title: 'メディア分析を接続して業務 × メディアの PDCA を開始',
      detail: 'メディア設定から GA を連携すると、セッション・CV と売上の相関、記事別の改善提案が本ダッシュボードに加わります。',
      priority: 'mid',
    })
  } else if (s.mediaAvailable && m.mediaConnected) {
    if (m.prevSessions > 0 && sessionDelta >= GROWTH_STRONG) {
      findings.push({
        kind: 'win',
        title: `メディア流入が前月比 ${signed(sessionDelta)}（${int(m.sessions)} セッション）`,
        detail: '集客が伸びています。伸長セクション・記事を軸に内部リンクと CV 導線を強化し、売上へ確実に接続します。',
      })
    } else if (m.prevSessions > 0 && sessionDelta <= DECLINE) {
      findings.push({
        kind: 'issue',
        title: `メディア流入が前月比 ${signed(sessionDelta)}（${int(m.sessions)} セッション）`,
        detail: '集客が減速しています。検索順位の低下・公開ペースの鈍化を疑い、記事の追加・リライトで回復を図ります。',
      })
    }
    if (m.sessions > 0 && m.conversionRate < CVR_LOW) {
      findings.push({
        kind: 'issue',
        title: `CVR が ${pct(m.conversionRate)} と低水準`,
        detail: '流入はあるものの成果化できていません。CTA の配置・フォーム改善・オファー見直しで転換率を引き上げます。',
      })
      actions.push({
        title: 'CVR 改善（CTA・フォーム・オファー）',
        detail: `セッション ${int(m.sessions)} に対し CV ${int(m.conversions)} 件（CVR ${pct(m.conversionRate)}）。CV 直前の離脱要因を特定して改善します。`,
        priority: 'high',
      })
    } else if (m.sessions > 0) {
      findings.push({
        kind: 'opportunity',
        title: `セッションあたり売上を伸ばす余地（CVR ${pct(m.conversionRate)}）`,
        detail: '流入と売上の連動は取れています。高 CVR セクションへの送客を増やし、1 セッションあたりの売上を高めます。',
      })
    }
  }

  // ---- コンテンツ量の所見（記事在庫。メディア対象かつ連携時のみ） ----
  if (s.mediaAvailable && m.mediaConnected && m.articleCount > 0 && m.articleCount < 5) {
    actions.push({
      title: 'コンテンツ本数を増やして流入の土台を作る',
      detail: `公開記事は ${m.articleCount} 本。テーマを広げた記事追加で検索接点を増やし、流入の基盤を厚くします。`,
      priority: 'mid',
    })
  }

  // 少なくとも 1 つはアクションを提示する（空にしない）
  if (actions.length === 0) {
    actions.push({
      title: '好調要因を横展開し、次月の重点を決める',
      detail: '売上・流入ともに安定しています。伸びているセクション/商材を他チャネルへ横展開し、次サイクルの重点仮説を立てます。',
      priority: 'low',
    })
  }

  // 段落区切り（空行）を保持するため、任意行は条件付きで push する
  const summaryLines = [
    `## ${m.segmentName} のダッシュボードレポート（${s.periodMonth}）`,
    '',
    `**業務**: 売上 ${man(m.salesAmount)}（前月比 ${signed(salesDelta)}）、受注 ${m.orders} 件、平均受注額 ${m.aov > 0 ? man(m.aov) : '—'}。`,
  ]
  if (s.mediaAvailable) {
    const mediaLine = m.mediaConnected
      ? `メディアは ${int(m.sessions)} セッション / CV ${int(m.conversions)} 件（CVR ${pct(m.conversionRate)}）。`
      : 'メディアは未接続で、GA 連携により流入 × 売上の分析が可能になります。'
    summaryLines.push('', `**メディア**: ${mediaLine}`)
  }
  // メディアが対象のときは締めもメディアに言及、非対象のときは業務のみの締めにする（誤誘導しない）
  const closing = s.mediaAvailable
    ? (salesDelta >= GROWTH_STRONG
        ? '売上は伸長基調です。牽引要因を維持しつつ、メディア流入を売上へ橋渡しする導線を強化する局面です。'
        : salesDelta <= DECLINE
          ? '売上は減速しています。件数と単価の要因分解を起点に、メディア流入・CVR の改善で立て直します。'
          : '売上は安定しています。メディア流入の底上げと CVR 改善で、次の成長の起点を作ります。')
    : (salesDelta >= GROWTH_STRONG
        ? '売上は伸長基調です。牽引した商材・チャネルを特定し、翌月の重点配分に反映する局面です。'
        : salesDelta <= DECLINE
          ? '売上は減速しています。受注件数と平均受注額の要因分解を起点に立て直します。'
          : '売上は安定しています。商品構成・受注単価の見直しで次の成長の起点を作ります。')
  summaryLines.push('', closing)
  const executiveSummary = summaryLines.join('\n')

  return { executiveSummary, findings, actions }
}

/**
 * 決定的な会社全体ダッシュボードインサイト生成。
 * 全セグメントのロールアップから、経営レポート・セグメント間の所見・全社アクションを導く。
 */
export function heuristicCompanyInsight(c: CompanySummary): DashboardInsight {
  const findings: MediaFinding[] = []
  const actions: MediaAction[] = []

  const salesDelta = delta(c.totalSales, c.prevTotalSales)
  const sessionDelta = delta(c.totalSessions, c.prevTotalSessions)

  // 売上でセグメントを序列化（トップ = 牽引 / ボトム = てこ入れ候補）
  const ranked = [...c.snapshots].sort((a, b) => b.salesAmount - a.salesAmount)
  const top = ranked[0]
  const bottom = ranked.length > 1 ? ranked[ranked.length - 1] : undefined
  const declining = c.snapshots.filter(s => s.prevSalesAmount > 0 && delta(s.salesAmount, s.prevSalesAmount) <= DECLINE)

  // ---- 全社売上トレンド ----
  if (c.prevTotalSales > 0 && salesDelta >= GROWTH_STRONG) {
    findings.push({
      kind: 'win',
      title: `全社売上が前月比 ${signed(salesDelta)}（${man(c.totalSales)}）`,
      detail: `${c.segmentCount} 業態合算で好調です。牽引業態の勝ち筋を他業態へ横展開できないか検討します。`,
    })
  } else if (c.prevTotalSales > 0 && salesDelta <= DECLINE) {
    findings.push({
      kind: 'issue',
      title: `全社売上が前月比 ${signed(salesDelta)}（${man(c.totalSales)}）`,
      detail: '全社で減速しています。減速業態を特定し、全社リソースの再配分で立て直します。',
    })
  } else {
    findings.push({
      kind: 'win',
      title: `全社売上は横ばい（${man(c.totalSales)}・前月比 ${signed(salesDelta)}）`,
      detail: '全社では安定しています。業態間の伸び・減速のばらつきを均し、ポートフォリオ全体の底上げを図ります。',
    })
  }

  // ---- 売上集中リスク（複数業態のときのみ評価。単一業態は「集中」も「分散」も意味を持たない） ----
  if (top && c.totalSales > 0 && c.segmentCount > 1) {
    const share = top.salesAmount / c.totalSales
    if (share >= CONCENTRATION) {
      findings.push({
        kind: 'issue',
        title: `売上が「${top.segmentName}」に集中（全社の ${pct(share)}）`,
        detail: '単一業態への依存度が高く、その業態の変動が全社に直結します。次の柱となる業態の育成が課題です。',
      })
      actions.push({
        title: '第 2 の柱となる業態の育成計画',
        detail: `${top.segmentName} が売上の ${pct(share)} を占めます。伸びしろのある業態へメディア投資・商品拡充を配分し、依存度を下げます。`,
        priority: 'high',
      })
    } else {
      findings.push({
        kind: 'win',
        title: `売上構成のバランスが良好（最大でも ${pct(share)}）`,
        detail: `「${top.segmentName}」を軸に複数業態へ売上が分散しています。ポートフォリオのリスク耐性は高い状態です。`,
      })
    }
  }

  // ---- 減速業態・てこ入れ ----
  if (declining.length > 0) {
    const names = declining.map(s => s.segmentName).join('、')
    actions.push({
      title: `減速業態のてこ入れ（${declining.length} 業態）`,
      detail: `${names} が前月比マイナスです。各業態のダッシュボードで要因を分解し、優先順位を付けて対策します。`,
      priority: 'high',
    })
  } else if (bottom && top && bottom.segmentId !== top.segmentId) {
    findings.push({
      kind: 'opportunity',
      title: `伸びしろのある業態: 「${bottom.segmentName}」`,
      detail: `売上規模が最小の業態です。トップ業態の勝ち筋（商品構成・メディア導線）を移植できないか検討します。`,
    })
  }

  // ---- メディア接続カバレッジ（メディア機能が有効なときのみ扱う） ----
  if (c.mediaAvailable && c.connectedCount < c.segmentCount) {
    findings.push({
      kind: 'opportunity',
      title: `メディア分析の接続は ${c.connectedCount}/${c.segmentCount} 業態`,
      detail: '未接続の業態を GA 連携すると、全社の流入 × 売上の相関把握と、業態横断の集客インサイトが揃います。',
    })
    actions.push({
      title: '未接続業態のメディア連携を完了する',
      detail: `残り ${c.segmentCount - c.connectedCount} 業態を GA 連携し、全社のメディア PDCA を一気通貫にします。`,
      priority: 'mid',
    })
  } else if (c.mediaAvailable && c.segmentCount > 0 && c.totalSessions > 0) {
    findings.push({
      kind: 'win',
      title: `全業態がメディア接続済み（${int(c.totalSessions)} セッション / CV ${int(c.totalConversions)} 件）`,
      detail: `全社の集客は前月比 ${signed(sessionDelta)}。業態横断で高 CVR の勝ちパターンを共有し、全体の転換率を底上げします。`,
    })
  }

  if (actions.length === 0) {
    actions.push({
      title: '好調業態の勝ち筋を全社標準化する',
      detail: '全社・全業態が安定しています。牽引業態の商品構成・メディア導線を型化し、他業態へ展開して底上げします。',
      priority: 'low',
    })
  }

  // 段落区切り（空行）を保持するため filter(Boolean) は使わず、任意行は条件付きで push する
  const summaryLines = [
    `## 会社全体ダッシュボードレポート（${c.periodMonth}）`,
    '',
    `**全社サマリー**: 売上 ${man(c.totalSales)}（前月比 ${signed(salesDelta)}）、受注 ${c.totalOrders} 件、${c.segmentCount} 業態。`,
  ]
  if (c.mediaAvailable) {
    summaryLines.push('', c.connectedCount > 0
      ? `**メディア**: 接続 ${c.connectedCount}/${c.segmentCount} 業態、${int(c.totalSessions)} セッション（前月比 ${signed(sessionDelta)}）/ CV ${int(c.totalConversions)} 件。`
      : `**メディア**: まだどの業態も GA 未連携です。連携すると全社の流入 × 売上分析が可能になります。`)
  }
  if (top) summaryLines.push('', `**牽引業態**: ${top.segmentName}（${man(top.salesAmount)}）。`)
  // メディアが対象のときのみ締めでメディア接続に言及する
  summaryLines.push('', salesDelta >= GROWTH_STRONG
    ? '全社は成長局面です。牽引業態の勝ち筋を型化し、他業態へ横展開して成長を面へ広げます。'
    : salesDelta <= DECLINE
      ? '全社は減速局面です。減速業態のてこ入れと、集中リスクの分散を並行して進めます。'
      : c.mediaAvailable
        ? '全社は安定局面です。業態間のばらつきを均し、メディア接続の拡大で次の成長基盤を作ります。'
        : '全社は安定局面です。業態間のばらつきを均し、牽引業態の勝ち筋を横展開して次の成長基盤を作ります。')
  const executiveSummary = summaryLines.join('\n')

  return { executiveSummary, findings, actions }
}
