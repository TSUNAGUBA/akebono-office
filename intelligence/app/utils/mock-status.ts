/**
 * API モードで「まだモック（フロント SoT）で動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase3/company-intelligence-requirements.md` §5（モック境界の宣言）で、
 * 本マップはその表示用ミラー。共通 API で本実装したらここから削除する（原則5）。
 * ページヘッダーのモックバッジ表示に使う。
 *
 * 2026-08-22（改善要望）: /insights /actions /cycles を削除 = 本実装済み。
 * 分析生成はサーバー実行（Vertex AI → 決定的ヒューリスティックへフォールバック）、
 * 記録ストアはサーバー保存（/v1/intelligence/* = intel_* テーブル）となり、モック境界は解消した。
 * 現在、API モードでモック動作のページはない（空集合。将来のモック機能追加時に再利用する）。
 */
const MOCK_PAGE_PATHS = new Set<string>([])

/** このパスのページが API モードでもモック動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
