/**
 * 入力サポート「AIで整形」（改修依頼 2026-08-20）の決定的整形ロジック（フロント/API 共有 = パリティの SoT）。
 *
 * - API（POST /v1/assist/format-text）は Vertex AI（generateJson）を一次に使い、失敗時は本モジュールの
 *   heuristicFormatRequestText へフォールバックする（グレースフルデグラデーション = 原則4）。
 * - mock モードは常に本ヒューリスティックを直接呼ぶ（report-draft の heuristicReportDraft と同型 = 原則3）。
 * - 決定的（同じ入力 → 同じ出力。乱数・時刻に依存しない）。意味は変えず「読みやすさ」だけを整える。
 */

import type { KbDoc } from './kb'
import { kbFindRelated } from './kb'

/** 整形対象テキストの入力上限（API は超過を 400 AKO-RAS-003 で弾く。要望本文 4,000 字の余裕を持った上限） */
export const FORMAT_TEXT_CAP = 8_000

/** 「AIで整形」の RAG 参照ドキュメント数の上限（改修依頼 2026-08-21 第3弾） */
export const FORMAT_KB_REFS_MAX = 3

/**
 * 「AIで整形」の RAG 参照ドキュメントを選ぶ（改修依頼 2026-08-21 第3弾）。
 * 参照元 = AI 知識ベース（shared/domain/kb = アプリ仕様書・操作マニュアル・運用マニュアル・FAQ）。
 * kbFindRelated（決定的字句検索 = チャットボットのモック照合と同一ロジック・原則3/6）で
 * 要望テキストに関連する上位 FORMAT_KB_REFS_MAX 件を返す。関連ドキュメントが無ければ空配列
 * （LLM は参照なしで整形 = RAG は補助であり整形自体を止めない・原則4）。
 */
export function formatTextKbRefs(text: string): KbDoc[] {
  return kbFindRelated(text, FORMAT_KB_REFS_MAX).map(r => r.doc)
}

/** 節ラベル（要望テンプレ IMPROVEMENT_BODY_TEMPLATE の見出し。全角/半角コロンの両方を受ける） */
const SECTION_LABEL_RE = /^(要望|現状|改善)[：:]\s*(.*)$/

/** 箇条書きの行頭マーク（・ / - / *）。内容が続く行のみ正規化対象（'---' 等の罫線は触らない） */
const BULLET_RE = /^[・\-*]\s+(.+)$|^・(.+)$/

/**
 * 決定的な整形（LLM 失敗時のフォールバック / mock の唯一のロジック）。
 * - trim（行末空白・先頭/末尾の空行を除去）・連続空行は 1 行に圧縮
 * - 箇条書きの行頭マーク（・ / - / *）を「- 」へ統一
 * - 「要望：/現状：/改善：」ラベル行があれば節として整形（各節の前に空行・コロンは全角へ統一）
 * - ラベルが無ければ文単位（。！？）で改行を整理する
 * - 空入力はそのまま返す。文字数 CAP（FORMAT_TEXT_CAP / 本文 CAP）超過分も切らない
 *   （切り詰めは送信時の検証が担う = 整形で無言のデータ喪失を作らない）
 */
export function heuristicFormatRequestText(input: string): string {
  if (!input.trim()) return input
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/g, ''))
  const hasSections = lines.some(l => SECTION_LABEL_RE.test(l.trim()))
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      out.push('')
      continue
    }
    // 箇条書きの正規化（・ / - / * → '- '）
    const bullet = BULLET_RE.exec(t)
    const bulletBody = bullet?.[1] ?? bullet?.[2]
    if (bulletBody) {
      out.push(`- ${bulletBody.trim()}`)
      continue
    }
    // ラベル行（要望：/現状：/改善：）は節の見出しとして整形（節の前に空行・コロンは全角へ統一）
    const section = SECTION_LABEL_RE.exec(t)
    if (hasSections && section) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(section[2] ? `${section[1]}：${section[2].trim()}` : `${section[1]}：`)
      continue
    }
    if (hasSections) {
      out.push(t)
      continue
    }
    // ラベルが無いテキストは文単位で改行を整理する（。！？ の直後で改行。末尾の句点では改行しない）
    for (const sentence of t.replace(/([。！？])\s*(?=[^\s])/g, '$1\n').split('\n')) {
      const s = sentence.trim()
      if (s) out.push(s)
    }
  }
  // 連続空行の圧縮 + 先頭/末尾の空行除去
  const compact: string[] = []
  for (const l of out) {
    if (l === '' && (compact.length === 0 || compact[compact.length - 1] === '')) continue
    compact.push(l)
  }
  while (compact.length > 0 && compact[compact.length - 1] === '') compact.pop()
  return compact.join('\n')
}
