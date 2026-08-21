/**
 * 入力サポート「AIで整形」（改修依頼 2026-08-20 → RAG 対応 2026-08-21 第3弾）。デュアルモード:
 * - mock  = shared/domain/text-assist の決定的ヒューリスティックを直接呼ぶ（即時・useReportAssist と同型）
 * - API   = POST /v1/assist/format-text（Vertex → 同ヒューリスティックへサーバー側フォールバック）。
 *   LLM 整形時は AI 知識ベース（shared/domain/kb = 仕様書・操作/運用マニュアル・FAQ）を RAG 参照し、
 *   応答 refs に参照ドキュメント（id + title）が入る（ルールベース時は空 = 資料を使わないため）。
 *   ネットワーク断など API 呼び出し自体の失敗は、共有ヒューリスティックでローカルにフォールバックする
 *   （整形は補助機能 = 断でも結果を返すグレースフルデグラデーション。原則4）
 * 応答の llm: true = LLM 整形 / false = ルールベース（UI がトーストのフィードバックに使う）。
 */
import { FORMAT_TEXT_CAP, heuristicFormatRequestText } from '../../../shared/domain/text-assist'

/** RAG の参照ドキュメント（LLM 整形時のみ。UI の「参照した資料」表示用） */
export interface TextAssistRef { id: string; title: string }

export type TextAssistResult =
  | { ok: true; text: string; llm: boolean; refs: TextAssistRef[] }
  | { ok: false; error: { code: string; message: string } }

export function useTextAssist() {
  const isApi = useApiMode()

  /** テキストを整形する（保存しない = 何度でもやり直せる）。上限超過は API と同じコードで前置検証 */
  async function formatText(text: string): Promise<TextAssistResult> {
    if ([...text].length > FORMAT_TEXT_CAP) {
      return { ok: false, error: { code: 'AKO-RAS-003', message: `整形できるテキストは ${FORMAT_TEXT_CAP} 文字までです` } }
    }
    if (!text.trim()) return { ok: true, text, llm: false, refs: [] } // 空入力はそのまま返す（shared と同じ規約）
    if (isApi) {
      try {
        const data = await apiFetch<{ text: string; llm: boolean; refs?: TextAssistRef[] }>('/v1/assist/format-text', {
          method: 'POST', body: { text }, timeoutMs: 60_000,
        })
        return {
          ok: true,
          text: String(data.text ?? text),
          llm: Boolean(data.llm),
          // refs が無い旧 API 応答（配信窓）も空で受ける（原則7）
          refs: Array.isArray(data.refs) ? data.refs.map(r => ({ id: String(r.id), title: String(r.title) })) : [],
        }
      } catch {
        // API 断（コールドスタート・ネットワーク等）はローカルのヒューリスティックで代替する（原則4）
        return { ok: true, text: heuristicFormatRequestText(text), llm: false, refs: [] }
      }
    }
    return { ok: true, text: heuristicFormatRequestText(text), llm: false, refs: [] }
  }

  return { formatText }
}
