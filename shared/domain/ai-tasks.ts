/**
 * AI タスク分解・確信度判定（F-08）: 決定的ヒューリスティック（フロントエンドと API サービスで共有）
 * - モックモード: これが唯一の生成ロジック
 * - API モード: Vertex AI（LLM 構造化出力）失敗時のフォールバック（原則4。report-draft と同型）
 * 乱数は使わず hashStr で決定的に生成する（再現性 = デモ・テストの安定性）
 */
import { bigramCoverage } from './text-match'
import type { AiActivityKind, AiModelTier, AiTask } from './types'

/** 文字列 → 32bit ハッシュ（FNV-1a。mockup utils/rng.ts の hashStr と同一実装 = 生成値の完全一致） */
export function hashStrShared(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const DECOMPOSITION_TEMPLATES: { keywords: string[]; steps: string[] }[] = [
  { keywords: ['調査', 'リサーチ', '動向', '市場'], steps: ['対象範囲と情報源の洗い出し', '一次情報の収集と突合', '論点別の要約整理', '調査レポートのドラフト作成'] },
  { keywords: ['資料', '提案', '議事録', 'ドラフト', '文書'], steps: ['構成案の作成', '既存ナレッジ・過去資料の参照', 'ドラフト作成', '体裁調整とセルフレビュー'] },
  { keywords: ['分析', '集計', 'データ', 'KPI'], steps: ['データ抽出条件の定義', '集計・可視化の実行', '示唆の抽出', '分析サマリーの作成'] },
  { keywords: ['レビュー', 'チェック', '確認', '点検'], steps: ['レビュー観点の整理', '対象の通読と指摘リスト化', '改善提案のまとめ'] },
]

const GENERIC_STEPS: string[][] = [
  ['依頼内容の要件整理', '必要情報の収集', '成果物ドラフトの作成', 'セルフチェックと提出'],
  ['要件の確認と論点整理', '作業の実施', '結果報告のまとめ'],
]

/** タスク分解（キーワードテンプレート → 汎用ステップ。決定的） */
export function decomposeTask(title: string, description: string): { title: string; done: boolean }[] {
  const text = `${title} ${description}`
  const matched = DECOMPOSITION_TEMPLATES.find(t => t.keywords.some(k => text.includes(k)))
  const steps = matched?.steps ?? GENERIC_STEPS[hashStrShared(`decomp:${title}`) % GENERIC_STEPS.length]!
  return steps.map(s => ({ title: s, done: false }))
}

/** 確信度判定（説明が薄い・疑問形は low。それ以外はハッシュで high/mid に決定的分岐） */
export function judgeTaskConfidence(aiEmployeeId: string, title: string, description: string): AiTask['confidence'] {
  const d = description.trim()
  if (d.length < 20 || d.includes('?') || d.includes('？')) return 'low'
  return hashStrShared(`conf:${aiEmployeeId}:${title}`) % 2 === 0 ? 'high' : 'mid'
}

/** 活動ログのトークン/コストの決定的モック値（実 LLM 課金の代替。seq でログごとに変化させる） */
export function mockActivityCost(
  aiEmployeeId: string,
  kind: AiActivityKind,
  seq: number,
  tier: AiModelTier,
): { tokens: number; costUsd: number } {
  const range: Record<AiActivityKind, [number, number]> = {
    plan: [2000, 5000], execute: [8000, 28000], report: [1500, 4000], escalate: [800, 2500], chat: [500, 1500],
  }
  const [lo, hi] = range[kind]
  const tokens = lo + (hashStrShared(`tok:${aiEmployeeId}:${kind}:${seq}`) % (hi - lo + 1))
  const rate: Record<AiModelTier, number> = { lite: 0.6, standard: 1.1, pro: 2.8 }
  return { tokens, costUsd: Number((tokens * rate[tier] / 1_000_000).toFixed(4)) }
}

// ---------- AI 社員間の依頼・連携（マネージャーロール。オペレーター指示 2026-07-19 #3） ----------

/** AiRole.permissions の認識キー: 他の AI 社員への依頼・連携を許可（= マネージャーロールの要件） */
export const DELEGATE_PERMISSION = 'delegate'

export interface DelegationCandidate {
  id: string
  name: string
  roleName: string
  mission: string
}

/**
 * 連携計画（決定的ヒューリスティック。API モードの LLM 失敗時フォールバック / モックモードの唯一のロジック）。
 * 各分解ステップを「ロール名 + ミッションとの字句類似（バイグラム被覆率）が最も高い候補」へ割り当てる。
 * 同点は候補の並び順（呼び出し側で id 順に渡す）で決定的。候補ゼロは空配列 = 連携なし
 */
export function planDelegation(
  steps: { title: string }[],
  candidates: DelegationCandidate[],
): { title: string; aiEmployeeId: string }[] {
  if (candidates.length === 0) return []
  return steps.map((s, i) => {
    let best = candidates[0]!
    let bestScore = -1
    for (const cand of candidates) {
      const score = bigramCoverage(s.title, `${cand.roleName} ${cand.mission}`)
      if (score > bestScore) {
        best = cand
        bestScore = score
      }
    }
    // 全候補スコア 0（語彙が全く重ならない）はラウンドロビンで負荷分散（決定的）
    const target = bestScore > 0 ? best : candidates[i % candidates.length]!
    return { title: s.title, aiEmployeeId: target.id }
  })
}

// ---------- 実遂行（バッチ7f・オペレーター指示 2026-07-19 #7） ----------

/**
 * 依頼者への確認が必要か（決定的ヒューリスティック = LLM 無効環境・モックの唯一のロジック）。
 * 情報不足の依頼（confidence=low と同じ判定基準）は、最初のステップ実行前に一度だけ依頼者へ確認する。
 * 一度回答を得た依頼（answeredCount > 0）には再質問しない = 質問ループを作らない
 */
export function heuristicNeedsInput(description: string, answeredCount: number): string | null {
  if (answeredCount > 0) return null
  const d = description.trim()
  if (d.length < 20 || d.includes('?') || d.includes('？')) {
    return '依頼内容を具体化するため、目的・期待する成果物・前提条件（あれば参考資料も）を教えてください'
  }
  return null
}

/**
 * ステップ実行の成果物（決定的ヒューリスティック = LLM 無効環境・モックのフォールバック）。
 * 依頼文・回答・添付抽出テキストの冒頭を引用した実施記録をマークダウンで生成する。
 * 推測で事実は作らない（materials にある情報の整理のみ）
 */
export function heuristicStepOutput(
  title: string,
  stepTitle: string,
  materials: string,
): string {
  const src = materials.trim()
  const excerpt = src ? [...src.replace(/\s+/g, ' ')].slice(0, 300).join('') : ''
  return [
    `### ${stepTitle}`,
    `依頼「${title}」について本ステップを実施しました。`,
    excerpt ? `**参照した材料（冒頭）:** ${excerpt}` : '**参照した材料:** 依頼本文のみ（追加資料なし）',
    '- 材料の要点を整理し、本ステップの観点で確認しました',
    '- 判断が必要な事項・不足情報は見つかりませんでした（あれば依頼者へ確認します）',
  ].join('\n')
}

/**
 * 統合報告（全ステップ完了時に outputs の成果を集約。決定的 = LLM 追加呼び出しなし・モック/API 共通）。
 * 各ステップの全文は個別の成果物として保存済みのため、ここでは要約（冒頭）のみ再掲する = 二重保存を防ぐ
 */
export function buildFinalReport(
  title: string,
  outputs: { step: number; title: string; body: string }[],
): string {
  const steps = outputs.filter(o => o.step >= 0)
  return [
    `# 「${title}」完了報告`,
    `全 ${steps.length} ステップを遂行しました。要約は以下（全文は各ステップの成果物を参照）。`,
    // 冒頭の見出し行のみ除去（本文中の見出しは保持 = LLM 成果物の構造を壊さない）
    ...steps.map(o => `## ${o.title}\n${[...o.body.replace(/^#{1,6}\s[^\n]*\n?/, '').trim()].slice(0, 300).join('')}`),
  ].join('\n\n')
}
