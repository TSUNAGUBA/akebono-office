/**
 * データ基盤の 3 カテゴリ定義（改善要望 2026-08-22。SoT）。
 * AKEBONO Intelligence が参照する共通基盤データを「自社コンテキスト / ナレッジ / ログ」の
 * 3 カテゴリで定義し、全項目に共通 UI 構造「データ項目 → 一覧 → 詳細」を適用する
 * （/data = カテゴリとデータ項目 → /data/<item> = 一覧 → 行押下 = 詳細ドロワー）。
 *
 * 対象外の判断（担当者メモ 2026-08-22）: 要件のうち AKEBONO Home にデータが存在しないものは
 * 実装から省く。「文化」（自社コンテキスト）は Home に該当エンティティが無いため対象外とし、
 * カテゴリの注記で明示する（存在しないデータをモックで作らない = 事実を作らない）。
 */

export type FoundationCategoryId = 'context' | 'knowledge' | 'log'

export interface FoundationCategoryDef {
  id: FoundationCategoryId
  label: string
  description: string
  /** カテゴリ末尾の注記（対象外の明示等） */
  note?: string
}

export interface FoundationItemDef {
  /** ルートパラメータ（/data/<key>） */
  key: string
  label: string
  description: string
  /** lucide アイコンキー（IconGlyph） */
  icon: string
  /** 所属カテゴリ（月報はナレッジ・ログの両方に属する = 要件の定義どおり） */
  categories: FoundationCategoryId[]
}

export const FOUNDATION_CATEGORIES: FoundationCategoryDef[] = [
  {
    id: 'context',
    label: '自社コンテキスト',
    description: '会社・プロジェクト・メンバーの基礎情報（分析の対象と前提）',
    note: '「文化」は AKEBONO Home に該当データが存在しないため対象外です（担当者メモ 2026-08-22）',
  },
  {
    id: 'knowledge',
    label: 'ナレッジ',
    description: '各業務のレポート・支援記録（分析の知識ソース）',
  },
  {
    id: 'log',
    label: 'ログ',
    description: '日々の記録の時系列（分析の一次ソース）',
  },
]

export const FOUNDATION_ITEMS: FoundationItemDef[] = [
  // ---- 自社コンテキスト ----
  { key: 'company', label: '会社', description: '自社の基本情報', icon: 'Building2', categories: ['context'] },
  { key: 'projects', label: 'プロジェクト', description: '案件の状態・期間・体制', icon: 'FolderKanban', categories: ['context'] },
  { key: 'members', label: 'メンバー', description: '在籍メンバーの基礎情報', icon: 'Users', categories: ['context'] },
  // ---- ナレッジ ----
  { key: 'media-reports', label: 'メディアレポート', description: 'オウンドメディアの AI 週次レポート', icon: 'LineChart', categories: ['knowledge'] },
  { key: 'ec-reports', label: 'ECレポート', description: 'AKEBONO ダッシュボードの AI 分析レポート（EC 等の業態別 + 会社全体）', icon: 'ShoppingCart', categories: ['knowledge'] },
  { key: 'consignment-reports', label: '委託販売レポート', description: '委託精算の確定レポート（支払通知書）', icon: 'Receipt', categories: ['knowledge'] },
  { key: 'internal-supports', label: '社内サポート', description: 'メンバー間フォローアップの記録（AKEBONO Home F-57）', icon: 'HeartHandshake', categories: ['knowledge'] },
  { key: 'monthly-reports', label: '月報', description: '月次のふりかえり（成果・課題・来月のテーマ）', icon: 'CalendarClock', categories: ['knowledge', 'log'] },
  // ---- ログ ----
  { key: 'minutes', label: '議事録', description: '会議の記録', icon: 'NotebookPen', categories: ['log'] },
  { key: 'daily-reports', label: '日報', description: '日々の活動報告（提出済み）', icon: 'NotebookPen', categories: ['log'] },
  { key: 'weekly-reports', label: '週報', description: '週次のふりかえり', icon: 'CalendarDays', categories: ['log'] },
]

export function foundationItemOf(key: string): FoundationItemDef | null {
  return FOUNDATION_ITEMS.find(i => i.key === key) ?? null
}

export function foundationItemsOf(category: FoundationCategoryId): FoundationItemDef[] {
  return FOUNDATION_ITEMS.filter(i => i.categories.includes(category))
}
