/**
 * API モードで「まだモック（フロント SoT）で動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase3/company-intelligence-requirements.md` §5（モック境界の宣言）で、
 * 本マップはその表示用ミラー。共通 API で本実装したらここから削除する（原則5）。
 * ページヘッダーのモックバッジ表示に使う。
 *
 * - /tokens: 予算・制限設定の SoT が localStorage（トークン実測値も現状は決定的モック値）
 */
const MOCK_PAGE_PATHS = new Set<string>(['/tokens'])

/** このパスのページが API モードでもモック動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
