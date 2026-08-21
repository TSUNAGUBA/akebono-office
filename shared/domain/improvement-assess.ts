/**
 * 受付箱の AI 判定（改修依頼 2026-08-21）。要望 1 件ごとに、ナレッジベース
 * （shared/domain/kb = アプリ仕様・運用/操作マニュアル）を RAG として
 * 「既存機能に備わっているか？」「使い方の工夫で叶えられるか？」「改修が必要か？」を判定し、
 * 根拠と推奨アクション（IMPROVEMENT_ASSESS_META.recommended）を提示する。
 *
 * デュアルモード（原則6 パリティ）:
 * - API = Vertex AI（generateJson + IMPROVEMENT_ASSESS_LLM_SCHEMA）→ normalizeAssessment で検証・正規化。
 *   無効環境・失敗時は heuristicAssessRequest へフォールバック。
 * - mock = 常に heuristicAssessRequest（決定的 = 同一入力 → 同一判定。Date・乱数不使用）。
 * 判定結果の保管形式は shared/domain/improvement.ts の ImprovementRequestAssessment（assessedAt・llm は
 * 呼び出し側が付与する = 本モジュールは純関数のみ）。
 */

import {
  IMPROVEMENT_ASSESS_VERDICTS,
  type ImprovementAssessVerdict,
} from './improvement'
import { kbDocById, kbFindRelated, type KbDoc } from './kb'

/** 判定の根拠・説明の上限（保存・表示とも。LLM 出力もこの長さへ切り詰める） */
export const IMPROVEMENT_ASSESS_REASON_CAP = 1_000

/** RAG として LLM / ヒューリスティックへ渡す関連ドキュメント数 */
export const IMPROVEMENT_ASSESS_DOC_LIMIT = 5

/** 判定の材料（要望本文 + 対象ページ・対象箇所を 1 つの検索クエリへ統合） */
export function assessQueryOf(input: { body: string; pageLabel?: string; targetSpot?: string }): string {
  return [input.pageLabel ?? '', input.targetSpot ?? '', input.body].map(s => s.trim()).filter(Boolean).join(' ')
}

/** 判定に使う関連ドキュメント（決定的。API の LLM プロンプトと mock ヒューリスティックで共有 = 原則6） */
export function assessRelatedDocs(input: { body: string; pageLabel?: string; targetSpot?: string }): { doc: KbDoc; score: number }[] {
  return kbFindRelated(assessQueryOf(input), IMPROVEMENT_ASSESS_DOC_LIMIT)
}

/** LLM への出力スキーマ（generateJson の responseSchema） */
export const IMPROVEMENT_ASSESS_LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...IMPROVEMENT_ASSESS_VERDICTS] },
    reason: { type: 'string' },
    docIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reason'],
}

/** コードポイント単位の切り詰め（improvement.ts の capCodePoints と同義。循環 import を避けるローカル実装） */
function capCp(s: string, n: number): string {
  const cps = [...s]
  return cps.length > n ? cps.slice(0, n).join('') : s
}

/**
 * LLM の判定出力を検証・正規化する。verdict は allowlist・docIds は実在 doc のみ・reason は上限で
 * 切り詰め。使えない出力（verdict 不正・reason 空）は null（呼び出し側でヒューリスティックへ）。
 */
export function normalizeAssessment(
  raw: unknown,
): { verdict: ImprovementAssessVerdict; reason: string; docIds: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const verdict = String(obj.verdict ?? '') as ImprovementAssessVerdict
  if (!IMPROVEMENT_ASSESS_VERDICTS.includes(verdict)) return null
  const reason = capCp(String(obj.reason ?? '').trim(), IMPROVEMENT_ASSESS_REASON_CAP)
  if (!reason) return null
  const docIds = Array.isArray(obj.docIds)
    ? [...new Set(obj.docIds.map(v => String(v ?? '')).filter(id => kbDocById(id) !== undefined))]
    : []
  return { verdict, reason, docIds }
}

/**
 * 決定的な簡易判定（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * ナレッジベースとの字句一致の強さで区分する（閾値は bigramCoverage 合成スコアの経験値。
 * 詳細な意味判定は LLM に任せ、簡易判定は「マニュアルに強い手掛かりがあるか」だけを見る設計判断）:
 * - 強い一致（>= 0.30）= 該当機能・手順がマニュアルに載っている可能性が高い → existing（既存機能で対応可）
 * - 中程度（>= 0.15）= 関連する機能・運用がある → workaround（使い方の工夫・運用で対応できる可能性）
 * - 一致が弱い/無い = マニュアルに手掛かりなし → improvement（改修が必要）
 * - 本文が短すぎて判定材料が無い（10 文字未満）→ unknown（人手判断）
 */
export function heuristicAssessRequest(
  input: { body: string; pageLabel?: string; targetSpot?: string },
): { verdict: ImprovementAssessVerdict; reason: string; docIds: string[] } {
  const body = input.body.trim()
  if ([...body].length < 10) {
    return {
      verdict: 'unknown',
      reason: '要望本文が短く、マニュアルとの照合材料が不足しています。内容を確認のうえ人手で判定してください。',
      docIds: [],
    }
  }
  const hits = assessRelatedDocs(input)
  const top = hits[0]
  const titles = (n: number): string => hits.slice(0, n).map(h => `「${h.doc.title}」`).join('・')
  if (top && top.score >= 0.30) {
    return {
      verdict: 'existing',
      reason: capCp(
        `マニュアル ${titles(2)} に該当する機能・手順の記載があります。既存機能で対応できる可能性が高いため、`
        + '該当ページの案内（運用対応）を検討してください（簡易判定 = 字句一致に基づく参考情報です）。',
        IMPROVEMENT_ASSESS_REASON_CAP,
      ),
      docIds: hits.slice(0, 2).map(h => h.doc.id),
    }
  }
  if (top && top.score >= 0.15) {
    return {
      verdict: 'workaround',
      reason: capCp(
        `マニュアル ${titles(3)} に関連する機能・運用の記載があります。使い方の工夫（運用対応）で要望を`
        + '叶えられる可能性があります（簡易判定 = 字句一致に基づく参考情報です）。',
        IMPROVEMENT_ASSESS_REASON_CAP,
      ),
      docIds: hits.slice(0, 3).map(h => h.doc.id),
    }
  }
  return {
    verdict: 'improvement',
    reason: 'マニュアル・仕様に該当する機能の記載が見つかりませんでした。既存機能では対応できない可能性が高く、'
      + '改修（改善対応）の検討を推奨します（簡易判定 = 字句一致に基づく参考情報です）。',
    docIds: top ? [top.doc.id] : [],
  }
}
