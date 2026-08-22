/**
 * 監査ログの表示・フィルタカタログ（純粋関数・home と API サービスで共有 = 原則6）
 *
 * SoT 宣言:
 * - 監査ログの記録: API モード = audit_logs テーブル（api/src/lib/audit.ts が書込・全データ変更操作が対象）/
 *   モックモード = useMockDb の auditLogs（useMasterCrud がマスタ・設定操作のみ書込）
 * - action / entity の語彙 → 表示ラベル・操作対象ページの対応は本ファイルが SoT。
 *   両モード（設定画面の監査ログパネル）と API のサーバーサイドフィルタ（f.page の entity 展開）が
 *   同じカタログを読むことで、フィルタ結果の食い違いを作らない
 * - entity キーは API の書込値（snake_case のテーブル名）で正規化する。モックの書込値は
 *   コレクション名（camelCase。例 externalLinks）のため、normalizeAuditEntity が読替える（原則7 =
 *   既存モックデータをそのまま表示・絞込できる）
 *
 * メンテナンス:
 * - action の追加時: `grep -rn "action: '" api/src --include="*.ts"` で洗い出して AUDIT_ACTION_META へ追記
 * - entity の追加時: `grep -rn "entity: '" api/src --include="*.ts"` と api/src/masters/registry.ts の
 *   def.table（マスタ CRUD は table 名が entity になる）で洗い出して AUDIT_ENTITY_META へ追記。
 *   ページパスは home/app/utils/nav-map.ts・menu-registry.ts の実パスに対応付ける
 * - 未知の action / entity は生値で表示される（フォールバック = 表示が壊れない）
 */

/** 監査ログ 1 行（API 応答 = camelCase / モック AuditLog と構造互換。id は API = bigserial 由来の文字列/数値） */
export interface AuditLogRow {
  id: string | number
  actorId: string
  action: string
  entity: string
  entityId: string
  detail: string
  at: string
}

// ---------- 操作内容（action） ----------

/**
 * 操作内容ラベル。create/update/archive/restore の訳語は旧・設定画面の AUDIT_ACTION_LABELS を踏襲（原則7）。
 * approved/rejected/withdrawn は承認系ルートの動的 action（body.action）・periodic-grant は定期付与ジョブで、
 * いずれも実書込があるため網羅する
 */
export const AUDIT_ACTION_META: Record<string, { label: string }> = {
  'create': { label: '追加' },
  'update': { label: '更新' },
  'archive': { label: '無効化' },
  'restore': { label: '再有効化' },
  'delete': { label: '削除' },
  'import': { label: '取込' },
  'upsert': { label: '更新（upsert）' },
  'run': { label: '実行' },
  'reindex': { label: '再インデックス' },
  'grant': { label: '付与' },
  'connect': { label: '連携' },
  'disconnect': { label: '連携解除' },
  'approved': { label: '承認' },
  'rejected': { label: '却下' },
  'withdrawn': { label: '取下げ' },
  'periodic-grant': { label: '定期付与' },
}

/** action → 表示ラベル（未知は生値のまま = 表示が壊れない） */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_META[action]?.label ?? action
}

// ---------- 操作対象ページ（page） ----------

/**
 * ページパス → 表示名（カタログ内で完結させる。home の utils（page-label 等）には依存しない = shared は純粋）。
 * 名称は nav-map / menu-registry の表示名に一致させる（ドキュメントとしての整合）
 */
export const AUDIT_PAGE_NAMES: Record<string, string> = {
  '/settings': '設定',
  '/masters/members': 'メンバー',
  '/masters/departments': '部署・組織図',
  '/masters/leave-types': '休暇種別',
  '/masters/holidays': '祝日',
  '/masters/customers': '顧客(会社)',
  '/masters/contacts': '顧客(人)',
  '/masters/relations-company': '顧客関係(会社)',
  '/masters/relations-contact': '顧客関係(人)',
  '/masters/relation-types': '関係種別',
  '/masters/industries': '業界',
  '/masters/villages': '事業区分（Village）',
  '/masters/projects': 'プロジェクト',
  '/masters/decision-themes': '判断テーマ',
  '/masters/work-categories': '業務種別',
  '/masters/knowledge': 'ナレッジ',
  '/masters/permissions': '権限設定',
  '/attendance': '勤怠管理',
  '/workflow': '稟議',
  '/reports': '日報',
  '/ai-assistant': 'AI業務アシスタント',
  '/poipoi': 'ぽいぽいポスト・議事録',
  '/customer-log': '顧客活動',
  '/customer-context': '顧客コンテキスト',
  '/sales-approach': '営業アプローチリスト',
  '/internal-support': '社内サポート活動',
  '/customer-dashboard': '顧客別ダッシュボード',
  '/support-activity': 'サポート活動',
  '/sales-activity': '営業活動',
  '/partner-activity': 'ビジネスパートナー活動',
  '/improvements': '改善要望',
  '/support/documents': 'ドキュメント管理',
  '/ai-company/roles': 'ロール設定',
  '/ai-company/employees': 'AI 社員の管理',
  '/media': 'メディア分析',
  '/media/reports': 'メディア AIレポート',
  '/media/measures': 'メディア改善施策',
  '/media/articles': 'AI 記事生成',
  '/media/settings': 'チャンネル設定',
  '/profile': 'プロフィール',
  '/sales': '売上管理',
  '/akebono/dashboard': '業態別ダッシュボード',
  '/akebono/products': '商品マスタ',
  '/akebono/inventory': '在庫管理',
  '/akebono/inbounds': '入荷管理',
  '/akebono/outbounds': '出荷管理',
  '/akebono/purchase-orders': '発注管理',
  '/akebono/purchases': '仕入管理',
  '/akebono/production': '生産管理',
  '/akebono/sales': '売上管理（AKEBONO）',
  '/akebono/billing': '請求管理',
  '/akebono/masters': '共通マスタ（AKEBONO）',
  '/akebono/imports': 'データ取込',
  '/akebono/settings/segments': '業態アプリ設定',
  '/akebono/settings/items': '項目カスタマイズ',
}

/** ページ絞り込みの「その他」を表す番兵値（実パスは必ず '/' 始まりのため衝突しない） */
export const AUDIT_PAGE_OTHER = 'other'

/** ページパス → 表示名（未知パスはパスそのもの・空/その他は「その他」） */
export function auditPageName(page: string): string {
  if (!page || page === AUDIT_PAGE_OTHER) return 'その他'
  return AUDIT_PAGE_NAMES[page] ?? page
}

// ---------- 操作対象データ（entity） ----------

export interface AuditEntityMeta {
  /** 日本語ラベル */
  label: string
  /** 操作対象ページのパス（'' = 対応ページが特定できない = 「その他」扱い） */
  page: string
}

/**
 * entity（audit_logs.entity = 書込テーブル名）→ 日本語ラベル + 操作対象ページ。
 * キーは API の書込値（snake_case）。モックの camelCase は normalizeAuditEntity が読替える
 */
export const AUDIT_ENTITY_META: Record<string, AuditEntityMeta> = {
  // ---- CRM / HR マスタ（/v1/masters/* = registry def.table） ----
  members: { label: 'メンバー', page: '/masters/members' },
  departments: { label: '部署', page: '/masters/departments' },
  leave_types: { label: '休暇種別', page: '/masters/leave-types' },
  public_holidays: { label: '祝日', page: '/masters/holidays' },
  companies: { label: '顧客(会社)', page: '/masters/customers' },
  contacts: { label: '顧客(人)', page: '/masters/contacts' },
  company_relations: { label: '顧客関係(会社)', page: '/masters/relations-company' },
  contact_relations: { label: '顧客関係(人)', page: '/masters/relations-contact' },
  relation_types: { label: '関係種別', page: '/masters/relation-types' },
  industries: { label: '業界', page: '/masters/industries' },
  villages: { label: '事業区分（Village）', page: '/masters/villages' },
  projects: { label: 'プロジェクト', page: '/masters/projects' },
  decision_themes: { label: '判断テーマ', page: '/masters/decision-themes' },
  work_categories: { label: '業務種別', page: '/masters/work-categories' },
  knowledge_articles: { label: 'ナレッジ記事', page: '/masters/knowledge' },
  permission_rules: { label: '権限ルール', page: '/masters/permissions' },
  // ---- 設定（/settings で編集する 4 種 + アプリ設定 key-value） ----
  app_configs: { label: 'アプリ設定', page: '/settings' },
  custom_field_defs: { label: 'カスタム項目', page: '/settings' },
  code_masters: { label: '汎用区分マスタ', page: '/settings' },
  external_links: { label: '外部リンク', page: '/settings' },
  // ---- 勤怠・稟議 ----
  attendance_rules: { label: '勤怠ルール', page: '/attendance' },
  attendance_routes: { label: '勤怠承認経路', page: '/attendance' },
  attendance_fix_requests: { label: '打刻修正申請', page: '/attendance' },
  direct_requests: { label: '直行/直帰申請', page: '/attendance' },
  leave_requests: { label: '休暇申請', page: '/attendance' },
  leave_grants: { label: '休暇付与', page: '/attendance' },
  workflow_routes: { label: '承認経路（稟議）', page: '/workflow' },
  delegate_settings: { label: '承認委任設定', page: '/workflow' },
  // ---- 日報・AI・ノート ----
  daily_reports: { label: '日報', page: '/reports' },
  task_plan: { label: 'AI業務アシスタントの計画', page: '/ai-assistant' },
  // ノート（ぽいぽいポスト / 議事録）は同一 entity のため主画面 = ぽいぽいポストへ寄せる（設計判断）
  notes: { label: 'ノート（ぽいぽいポスト・議事録）', page: '/poipoi' },
  // ---- 顧客・活動記録 ----
  customer_logs: { label: '顧客活動', page: '/customer-log' },
  customer_contexts: { label: '顧客コンテキスト', page: '/customer-context' },
  customer_context_notes: { label: '顧客コンテキストのメモ', page: '/customer-context' },
  sales_approaches: { label: '営業アプローチ', page: '/sales-approach' },
  internal_supports: { label: '社内サポート活動', page: '/internal-support' },
  support_activities: { label: 'サポート活動', page: '/support-activity' },
  sales_activities: { label: '営業活動（案件）', page: '/sales-activity' },
  sales_activity_logs: { label: '営業活動ログ', page: '/sales-activity' },
  partner_activities: { label: 'ビジネスパートナー活動（案件）', page: '/partner-activity' },
  partner_activity_logs: { label: 'ビジネスパートナー活動ログ', page: '/partner-activity' },
  // ---- 改善要望 ----
  improvement_requests: { label: '改善要望', page: '/improvements' },
  improvement_request_comments: { label: '改善要望コメント', page: '/improvements' },
  improvement_items: { label: '改修単位', page: '/improvements' },
  improvement_notes: { label: '改修単位のメモ', page: '/improvements' },
  // ---- ドキュメント・AI カンパニー・メディア ----
  documents: { label: 'ドキュメント', page: '/support/documents' },
  ai_roles: { label: 'AI ロール', page: '/ai-company/roles' },
  ai_employees: { label: 'AI 社員', page: '/ai-company/employees' },
  media_channels: { label: 'メディアチャンネル', page: '/media/settings' },
  media_ga_tokens: { label: 'GA 連携', page: '/media/settings' },
  media_articles: { label: 'メディア記事', page: '/media/articles' },
  media_generated_articles: { label: 'AI 生成記事', page: '/media/articles' },
  media_external_articles: { label: '外部投稿記事', page: '/media' },
  // AI 週次レポート・改善施策（改善要望 2026-08-21・F-55/F-56）
  media_weekly_reports: { label: 'AI週次レポート', page: '/media/reports' },
  media_measures: { label: 'メディア改善施策', page: '/media/measures' },
  // ---- AKEBONO Intelligence（0090。改善要望 2026-08-22 = 記録ストアの本実装。別アプリのため page 遷移なし） ----
  intel_insights: { label: 'Intelligence インサイト', page: '' },
  intel_actions: { label: 'Intelligence アクション', page: '' },
  intel_cycles: { label: 'Intelligence 分析サイクル', page: '' },
  // 旧ローカル記録の一括移行（entityId = 対象メンバー id。個別行 id ではない = バッチ操作）
  intel_store: { label: 'Intelligence 記録ストア（移行）', page: '' },
  // ---- 売上・個人設定・検索 ----
  sales_monthly: { label: '月次売上', page: '/sales' },
  mart_load_runs: { label: '売上データ更新', page: '/sales' },
  user_chat_links: { label: 'チャット通知連携', page: '/profile' },
  search_docs: { label: '検索インデックス', page: '' },
  // ---- AKEBONO 設定・共通マスタ ----
  business_segments: { label: '業態', page: '/akebono/settings/segments' },
  akebono_app_configs: { label: '業態アプリ設定', page: '/akebono/settings/segments' },
  item_settings: { label: '項目カスタマイズ', page: '/akebono/settings/items' },
  warehouses: { label: '倉庫', page: '/akebono/masters' },
  units: { label: '単位', page: '/akebono/masters' },
  tax_rates: { label: '税率', page: '/akebono/masters' },
  payment_terms: { label: '支払条件', page: '/akebono/masters' },
  consignment_terms: { label: '委託条件', page: '/akebono/masters' },
  variant_axis_templates: { label: 'バリエーション軸テンプレート', page: '/akebono/masters' },
  product_categories: { label: '商品カテゴリ', page: '/akebono/masters' },
  product_image_sections: { label: '商品画像セクション', page: '/akebono/masters' },
  // ---- AKEBONO 記録系 ----
  products: { label: '商品', page: '/akebono/products' },
  product_skus: { label: '商品 SKU', page: '/akebono/products' },
  product_images: { label: '商品画像', page: '/akebono/products' },
  inventory_transactions: { label: '在庫トランザクション', page: '/akebono/inventory' },
  inbound_plans: { label: '入荷予定', page: '/akebono/inbounds' },
  inbound_results: { label: '入荷実績', page: '/akebono/inbounds' },
  outbound_plans: { label: '出荷指示', page: '/akebono/outbounds' },
  outbound_results: { label: '出荷実績', page: '/akebono/outbounds' },
  purchase_orders: { label: '発注', page: '/akebono/purchase-orders' },
  purchase_records: { label: '仕入', page: '/akebono/purchases' },
  production_orders: { label: '生産指示', page: '/akebono/production' },
  sales_records: { label: '売上（AKEBONO）', page: '/akebono/sales' },
  invoices: { label: '請求書', page: '/akebono/billing' },
  payment_receipts: { label: '入金', page: '/akebono/billing' },
  payment_notices: { label: '支払通知', page: '/akebono/billing' },
  import_sources: { label: '取込元', page: '/akebono/imports' },
  import_mappings: { label: '取込マッピング', page: '/akebono/imports' },
  import_runs: { label: '取込実行', page: '/akebono/imports' },
  dashboard_insights: { label: 'ダッシュボード AI レポート', page: '/akebono/dashboard' },
}

/**
 * モックの書込値（コレクション名）のうち、camelCase → snake_case の機械変換では
 * API の entity（テーブル名）に一致しないものの読替え表（原則7 = 既存モックデータの表示互換）
 */
const MOCK_ENTITY_ALIASES: Record<string, string> = {
  codeMaster: 'code_masters',
  knowledge: 'knowledge_articles',
  holidays: 'public_holidays',
}

/** entity の正規化（モックの camelCase コレクション名 → API の snake_case テーブル名） */
export function normalizeAuditEntity(entity: string): string {
  const alias = MOCK_ENTITY_ALIASES[entity]
  if (alias) return alias
  return entity.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)
}

/** entity → メタ（未知 entity は { label: entity, page: '' } = 生値表示・「その他」扱い） */
export function auditEntityMeta(entity: string): AuditEntityMeta {
  return AUDIT_ENTITY_META[normalizeAuditEntity(entity)] ?? { label: entity, page: '' }
}

// ---------- 導出（フィルタ選択肢・サーバーサイド展開） ----------

/**
 * ページ絞り込みの選択肢（カタログから重複除去。label = 「ページ名（パス）」・末尾に「その他」）。
 * 並びはカタログの定義順（マスタ → 業務 → AKEBONO のグルーピングを維持）
 */
export function auditPageOptions(): { value: string; label: string }[] {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const meta of Object.values(AUDIT_ENTITY_META)) {
    if (!meta.page || seen.has(meta.page)) continue
    seen.add(meta.page)
    out.push({ value: meta.page, label: `${auditPageName(meta.page)}（${meta.page}）` })
  }
  out.push({ value: AUDIT_PAGE_OTHER, label: 'その他' })
  return out
}

/**
 * 指定ページに属する entity 配列（API の f.page フィルタを entity IN (...) へ展開する用）。
 * AUDIT_PAGE_OTHER / '' はカタログ上ページ未特定の entity を返す（未知 entity は
 * カタログ外のため列挙不能 = 「その他」の完全な否定条件には auditEntitiesWithPage を使う）
 */
export function auditEntitiesForPage(page: string): string[] {
  const target = page === AUDIT_PAGE_OTHER ? '' : page
  return Object.entries(AUDIT_ENTITY_META)
    .filter(([, meta]) => meta.page === target)
    .map(([entity]) => entity)
}

/**
 * ページが特定できる全 entity（「その他」絞り込みのサーバーサイド否定条件
 * = entity NOT IN (...) 用。カタログ外の未知 entity も「その他」に含められる）
 */
export function auditEntitiesWithPage(): string[] {
  return Object.entries(AUDIT_ENTITY_META)
    .filter(([, meta]) => meta.page !== '')
    .map(([entity]) => entity)
}
