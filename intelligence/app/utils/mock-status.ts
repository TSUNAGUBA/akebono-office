/**
 * API モードで「まだモック（フロント SoT）で動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase3/company-intelligence-requirements.md` §5（モック境界の宣言）で、
 * 本マップはその表示用ミラー。共通 API で本実装したらここから削除する（原則5）。
 * ページヘッダーのモックバッジ表示に使う。
 *
 * - /insights /actions /cycles: 分析エンジンが決定的ヒューリスティック（後日 AI 推論 + RAG + WebSearch）で、
 *   生成物・アクション・サイクル記録の SoT が localStorage（端末間同期なし）
 */
const MOCK_PAGE_PATHS = new Set<string>(['/insights', '/actions', '/cycles'])

/** このパスのページが API モードでもモック動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
