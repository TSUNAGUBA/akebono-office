/**
 * 検索用テキスト正規化（フロント）。実装 SoT は shared/domain/text-match（API PG の akebono_norm と一致）。
 * オートコンプリートのオプション絞り込み・フィルタの部分一致で大文字小文字・全角半角を吸収する。
 */
export { normalizeSearch, normalizedIncludes } from '../../../shared/domain/text-match'
