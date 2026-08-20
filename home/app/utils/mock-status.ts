/**
 * API モードで「まだモックデータで動くページ」の一覧。
 * SoT は `.ai-native/outputs/phase7/implementation-status.md` §2（バッチ計画）で、
 * 本マップはその表示用ミラー。ドメインを API 接続したらここから削除する（原則5）。
 * ページヘッダー・カードメニュー・メニュー一覧のモックバッジ表示に使う。
 *
 * バッチ6d（AKEBONO F-03）で当時の全ドメインの接続が完了し一旦空になった。
 * Phase C（Akebono 記録系の API 化 = 2026-07-29）でモック残存が「データ取込（F-32）」のみとなり
 * 一時登録したが、Phase D（2026-07-29）で取込（F-32）・ダッシュボード AI レポート保管（F-41）を
 * API 化し**再び空**になった = API モードで localStorage 保管のまま日次消失するモックコレクションは無い
 * （currentSegment も 2026-07-30 に per-user で DB 永続化した = 端末間同期。user_preferences。
 *  API モードで localStorage 依存の個人状態はゼロになった。implementation-status §41 参照）。
 */
const MOCK_PAGE_PATHS = new Set<string>([])

/** このパスのページが API モードでもモックデータ動作か（バッジ表示判定） */
export function isMockPage(path: string): boolean {
  return MOCK_PAGE_PATHS.has(path)
}
