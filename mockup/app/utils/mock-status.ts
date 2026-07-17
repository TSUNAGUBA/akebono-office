/**
 * API モードで「まだモックデータで動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase7/implementation-status.md` §2（バッチ計画）で、
 * 本マップはその表示用ミラー。ドメインを API 接続したらここから削除する（原則5）。
 * ページヘッダー・カードメニュー・メニュー一覧のモックバッジ表示に使う。
 */
const MOCK_PAGE_PATHS = new Set<string>([
  '/decision',
  '/akebono',
  '/ai-company',
  '/shift',
  '/sales',
  '/status',
  '/ai-assistant',
  '/support/chatbot',
])

/** このパスのページが API モードでもモックデータ動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
