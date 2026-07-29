/**
 * API モードで「まだモックデータで動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase7/implementation-status.md` §2（バッチ計画）で、
 * 本マップはその表示用ミラー。ドメインを API 接続したらここから削除する（原則5）。
 * ページヘッダー・カードメニュー・メニュー一覧のモックバッジ表示に使う。
 *
 * バッチ6d（AKEBONO F-03）で当時の全ドメインの接続が完了し一旦空になった。
 * Phase C（Akebono 記録系の API 化 = 2026-07-29）でモック残存が「データ取込（F-32）」のみとなり、
 * 正直な表示のため本マップへ登録した（それまで Akebono 記録系ページの未登録は表示漏れだった）。
 */
const MOCK_PAGE_PATHS = new Set<string>([
  // F-32 データ取込: importSources / importMappings / importRuns が未移行のモックコレクション（Phase D 予定）
  '/akebono/imports',
])

/** このパスのページが API モードでもモックデータ動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
