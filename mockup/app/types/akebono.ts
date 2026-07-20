/**
 * Akebonoメニュー（業務アプリ群）ドメイン型定義
 * SoT: .ai-native/outputs/phase5/akebono-menu-design.md §3
 *
 * 設計原則（同 §3.1）:
 * - PK はサロゲート（prefix-#### text）。自然キー（商品コード等）は一意制約に限定しリレーションに使わない
 * - データ 3 分類: 設定系（更新可・論理削除）/ 記録系（追記のみ・訂正は赤黒）/ 確定系（発行後不変）
 * - 在庫は InventoryTransaction（台帳・追記のみ）が SoT。残高は導出
 * - v1 から tenant 概念は単一（定数）。モックでは省略（決定 #11 は本実装の物理列。モックは単一テナント前提）
 */
import type { CustomValues } from './domain'

// ---------- 区分値 ----------

/** 業種タイプ（メニュープリセット・基本項目の既定を決める軸。§3.2） */
export type IndustryType = 'retail' | 'maker' | 'logistics' | 'it_service' | 'other'

export const INDUSTRY_TYPES: IndustryType[] = ['retail', 'maker', 'logistics', 'it_service', 'other']

/** 取引先の取引ロール（Company.partnerRoles。§3.3 / F-30-1） */
export type PartnerRole = 'customer' | 'supplier' | 'consignor_artist' | 'store' | 'subcontractor'

/** 課金区分（情報サービス業のサービス品目。null = 物販。F-21-1） */
export type BillingType = 'one_time' | 'monthly' | 'usage'

/** 倉庫種別（F-30-3） */
export type WarehouseKind = 'own' | 'store_deposit' | 'external'

/** 委託精算の支払算定方式（第 2 巡決定・設定化） */
export type PayoutMethod = 'sales_rate' | 'purchase_cost'
/** 委託仕入の債務確定タイミング（第 2 巡決定・設定化） */
export type LiabilityTiming = 'on_sale' | 'on_receipt'
/** 端数処理 */
export type Rounding = 'floor' | 'ceil' | 'round'
/** 委託条件の適用ロール（店舗行 = マージン請求設定 / 作家行 = 支払設定。§3.3） */
export type ConsignmentRole = 'store' | 'consignor_artist'

/** 仕入区分（F-24-1） */
export type PurchaseType = 'outright' | 'consignment'

/** 発注ステータス（F-23-1） */
export type PoStatus = 'draft' | 'ordered' | 'partially_received' | 'closed' | 'canceled'
/** 生産指示ステータス（F-22-1） */
export type ProductionStatus = 'draft' | 'instructed' | 'in_progress' | 'completed' | 'canceled'
/** 入荷予定・出荷指示ステータス（F-25/F-26） */
export type PlanStatus = 'pending' | 'partial' | 'completed' | 'canceled'
/** 請求・支払通知ステータス（F-29） */
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void'
export type PaymentNoticeStatus = 'draft' | 'confirmed' | 'paid'
/** 請求種別（F-29-2/4） */
export type InvoiceType = 'sales' | 'consignment_margin'

/** 在庫トランザクションの種別（§3.4。台帳の増減理由） */
export type InventoryTxnKind =
  | 'inbound' | 'outbound' | 'purchase_in'
  | 'adjust' | 'transfer_in' | 'transfer_out'
  | 'production_in' | 'stocktake'

/** 在庫調整の理由（F-27-2） */
export type InventoryAdjustReason =
  | 'defective' | 'lost' | 'found' | 'sample' | 'stocktake' | 'other'

// ---------- マスタ系（設定系・論理削除） ----------

/** 事業セグメント（業態。§3.2 / F-30-2） */
export interface BusinessSegment {
  id: string
  name: string
  industryType: IndustryType
  displayOrder: number
  active: boolean
}

/** 倉庫・保管場所（F-30-3。店舗預けは kind='store_deposit' + companyId=店舗） */
export interface Warehouse {
  id: string
  name: string
  kind: WarehouseKind
  /** store_deposit のとき紐付く店舗（Company 参照） */
  companyId: string | null
  displayOrder: number
  active: boolean
}

/** 単位（F-30-4） */
export interface Unit {
  id: string
  name: string
  displayOrder: number
  active: boolean
}

/** 税区分（F-30-5。適用開始日は履歴保持だがモックは単一） */
export interface TaxRate {
  id: string
  name: string
  /** 税率（0.10 = 10%） */
  rate: number
  displayOrder: number
  active: boolean
}

/** 回収・支払条件（F-30-6） */
export interface PaymentTerm {
  id: string
  name: string
  /** 締め日（1-31。31 = 末日） */
  closingDay: number
  /** 支払月オフセット（0 = 当月 / 1 = 翌月 / 2 = 翌々月） */
  payMonthOffset: number
  /** 支払日（1-31。31 = 末日） */
  payDay: number
  active: boolean
}

/** 委託条件（F-30-7。取引先×セグメント×ロール単位。第 2 巡で設定化） */
export interface ConsignmentTerm {
  id: string
  companyId: string
  segmentId: string
  /** 適用ロール: store 行はマージン請求設定 / consignor_artist 行は支払設定（§3.3） */
  role: ConsignmentRole
  /** マージン率（store 行。0.30 = 30%） */
  marginRate: number | null
  /** 支払算定方式（consignor_artist 行） */
  payoutMethod: PayoutMethod | null
  /** sales_rate 方式の作家率（0.60 = 60%） */
  payoutRate: number | null
  /** 債務確定タイミング（consignor_artist 行） */
  liabilityTiming: LiabilityTiming | null
  /** 税区分（TaxRate 参照） */
  taxRateId: string | null
  /** 内税 = true / 外税 = false */
  taxIncluded: boolean
  rounding: Rounding
  /** 適用開始日（YYYY-MM-DD。履歴保持） */
  validFrom: string
  active: boolean
}

/** バリアント軸テンプレート（F-30-8。業種タイプ別の軸ラベルの組） */
export interface VariantAxisTemplate {
  id: string
  name: string
  axis1Label: string
  axis2Label: string
  industryTypes: IndustryType[]
  displayOrder: number
  active: boolean
}

/** 商品カテゴリ（F-21-4。自己参照階層） */
export interface ProductCategory {
  id: string
  name: string
  parentId: string | null
  displayOrder: number
  active: boolean
}

/** 商品画像セクション（F-21-6。決定 #10。画像の区分を設定化） */
export interface ProductImageSection {
  id: string
  name: string
  /** サムネイル優先（常に 1 件のみ = 部分一意。既定シード = 製品画像） */
  isThumbnailPriority: boolean
  /** 既定シード（削除不可・名称変更可） */
  isSeed: boolean
  displayOrder: number
  active: boolean
}

// ---------- 商品（F-21） ----------

/** 商品（親）。F-21-1 */
export interface Product {
  id: string
  code: string
  name: string
  segmentId: string
  categoryId: string | null
  /** 既定仕入先（作家等。Company 参照） */
  defaultSupplierCompanyId: string | null
  listPrice: number
  standardCost: number
  taxRateId: string | null
  unitId: string | null
  /** 課金区分（情報サービス。null = 物販） */
  billingType: BillingType | null
  /** バリアント軸ラベル（SKU 展開時。null = 展開なし = 既定 SKU 1 件） */
  variantAxis1Label: string | null
  variantAxis2Label: string | null
  description: string
  active: boolean
  custom: CustomValues
}

/** SKU（単品）。汎用バリアント 2 軸（undeux ADR-008）。F-21-2 */
export interface ProductSku {
  id: string
  productId: string
  code: string
  janCode: string | null
  axis1Value: string | null
  axis2Value: string | null
  /** SKU 別売価（null = 商品の listPrice を使用） */
  sellPrice: number | null
  /** SKU 別原価（null = 商品の standardCost を使用） */
  costPrice: number | null
  /** 既定 SKU（展開なし商品に自動生成。UI では非表示扱い。productId ごとに 1 件） */
  isDefault: boolean
  active: boolean
}

/** 商品画像（F-21-3。複数 + セクション。実体はモックでは data URI か色プレースホルダ） */
export interface ProductImage {
  id: string
  productId: string
  /** SKU 単位の紐付け（任意。null = 商品共通） */
  skuId: string | null
  sectionId: string
  displayOrder: number
  filename: string
  mime: string
  /** モック: 画像 data URI（未指定は色プレースホルダを描画） */
  dataUrl: string | null
  active: boolean
}

// ---------- 伝票系（発注・生産・入荷・仕入・出荷） ----------

export interface OrderLine {
  id: string
  skuId: string
  qty: number
  unitPrice: number
}

/** 発注（F-23）。ヘッダ + 明細。received は入荷実績から導出 */
export interface PurchaseOrder {
  id: string
  code: string
  companyId: string
  segmentId: string
  status: PoStatus
  orderDate: string
  dueDate: string
  lines: OrderLine[]
  note: string
}

/** 生産実績（F-22-2。追記のみ） */
export interface ProductionResult {
  id: string
  completedQty: number
  defectQty: number
  completedAt: string
}

/** 生産指示（F-22-1）+ 実績（埋め込み・追記のみ） */
export interface ProductionOrder {
  id: string
  code: string
  skuId: string
  qty: number
  /** 完成入庫先の倉庫 */
  warehouseId: string
  dueDate: string
  status: ProductionStatus
  results: ProductionResult[]
}

export interface StockLine {
  id: string
  /** 参照元の予定明細（直接登録は null） */
  planLineId: string | null
  skuId: string
  qty: number
}

/** 入荷予定（F-25-1。設定系。発注参照 or 手動起票） */
export interface InboundPlan {
  id: string
  code: string
  poId: string | null
  warehouseId: string
  dueDate: string
  status: PlanStatus
  lines: { id: string; skuId: string; qty: number }[]
}

/** 入荷実績（F-25-2。記録系・追記のみ・部分実績可） */
export interface InboundResult {
  id: string
  code: string
  planId: string | null
  warehouseId: string
  receivedAt: string
  lines: StockLine[]
}

/** 仕入計上（F-24。記録系・訂正は赤黒） */
export interface PurchaseRecord {
  id: string
  code: string
  companyId: string
  segmentId: string
  purchaseDate: string
  purchaseType: PurchaseType
  /** 入荷実績からの生成時の参照 */
  inboundResultId: string | null
  lines: { id: string; skuId: string; qty: number; costPrice: number }[]
  /** 赤黒訂正の元伝票 */
  correctionOf: string | null
}

/** 出荷指示（F-26-1。設定系。単独 DELETE 禁止 = 取消はステータス） */
export interface OutboundPlan {
  id: string
  code: string
  companyId: string
  warehouseId: string
  segmentId: string
  dueDate: string
  status: PlanStatus
  lines: { id: string; skuId: string; qty: number }[]
}

/** 出荷実績（F-26-2。記録系・追記のみ・部分実績可・指示参照 or 直接登録） */
export interface OutboundResult {
  id: string
  code: string
  planId: string | null
  /** 直接登録時は必須（指示参照時は plan から解決） */
  warehouseId: string | null
  companyId: string | null
  shippedAt: string
  lines: StockLine[]
}

/** 在庫トランザクション（§3.4。在庫の SoT・追記のみ） */
export interface InventoryTransaction {
  id: string
  skuId: string
  warehouseId: string
  /** 増減（+ 入庫 / − 出庫） */
  qty: number
  kind: InventoryTxnKind
  reason: InventoryAdjustReason | null
  /** 発生元の種別（'inbound_result' / 'outbound_result' / 'purchase' / 'production' / 'adjust' / 'transfer' / 'stocktake'） */
  refType: string
  /** 発生元の明細行 id（冪等キー = UNIQUE(refType, refLineId, kind)） */
  refLineId: string
  occurredAt: string
}

// ---------- 売上・請求（確定系 / 記録系） ----------

/** 売上明細（F-28。売上の SoT。記録系・訂正は赤黒） */
export interface SalesRecord {
  id: string
  code: string
  salesDate: string
  /** 得意先 */
  companyId: string
  segmentId: string
  skuId: string
  qty: number
  unitPrice: number
  amount: number
  costPrice: number | null
  channel: string | null
  billingType: BillingType | null
  /** 発生源（manual = 手入力 / shipment = 出荷実績から / import = 取込 / monthly_bulk = 月次一括） */
  sourceKind: 'manual' | 'shipment' | 'import' | 'monthly_bulk'
  sourceRef: string | null
  /** 請求済みリンク（Invoice.id） */
  invoiceId: string | null
  /** 赤黒訂正の元明細 */
  correctionOf: string | null
  active: boolean
}

export interface InvoiceLine {
  id: string
  description: string
  amount: number
}

/** 委託精算の設定スナップショット（発行時点で凍結。§3.4） */
export interface SettlementSnapshot {
  payoutMethod: PayoutMethod | null
  payoutRate: number | null
  marginRate: number | null
  taxRate: number | null
  taxIncluded: boolean
  rounding: Rounding
}

/** 請求（F-29。確定系。issued 以降は不変・訂正は赤伝） */
export interface Invoice {
  id: string
  code: string
  companyId: string
  /** null = 複数セグメント合算（明細はセグメント保持。XA-2 例外） */
  segmentId: string | null
  periodFrom: string
  periodTo: string
  invoiceType: InvoiceType
  status: InvoiceStatus
  issuedAt: string | null
  totalAmount: number
  /** 赤伝の元請求 */
  creditFor: string | null
  lines: InvoiceLine[]
  /** 委託マージン請求時の設定スナップショット（ヘッダ属性に格納。§3.4） */
  snapshot: SettlementSnapshot | null
  /** カバーした売上明細 id（締めの対象。発行時に SalesRecord.invoiceId を張る） */
  sourceRecordIds: string[]
}

export interface PaymentNoticeLine {
  id: string
  salesRecordId: string
  description: string
  amount: number
}

/** 支払通知（F-29-4。作家向け。確定系。発行時点の設定をスナップショット） */
export interface PaymentNotice {
  id: string
  code: string
  /** 作家（Company 参照） */
  companyId: string
  segmentId: string
  periodFrom: string
  periodTo: string
  status: PaymentNoticeStatus
  payableAmount: number
  lines: PaymentNoticeLine[]
  snapshot: SettlementSnapshot
}

/** 入金消込（F-29-3。記録系。部分入金可） */
export interface PaymentReceipt {
  id: string
  invoiceId: string
  receivedAt: string
  amount: number
  method: string
}

// ---------- データ取込（F-32） ----------

export type ImportMethod = 'file_csv' | 'file_fixed' | 'file_json' | 'api_pull'
export type ImportTargetEntity = 'product' | 'sku' | 'company' | 'sales_record' | 'inventory'
export type ImportRunStatus = 'staged' | 'validated' | 'applied' | 'failed' | 'reverted'

export interface ImportSource {
  id: string
  name: string
  method: ImportMethod
  encoding: 'utf8' | 'sjis'
  targetEntity: ImportTargetEntity
  schedule: 'manual' | 'daily'
  active: boolean
}

export interface ImportFieldMap {
  id: string
  /** 取込元の列名 / 固定長項目名 / JSON パス */
  sourceField: string
  /** 対象エンティティの項目キー */
  targetItemKey: string
  /** 変換（trim / upper / dateFormat 等の識別子。空 = 恒等） */
  transform: string
}

export interface ImportMapping {
  id: string
  sourceId: string
  version: number
  status: 'draft' | 'active' | 'superseded'
  fields: ImportFieldMap[]
  createdAt: string
}

export interface ImportRun {
  id: string
  code: string
  sourceId: string
  mappingVersion: number
  startedAt: string
  finishedAt: string | null
  status: ImportRunStatus
  counts: { staged: number; applied: number; skipped: number; failed: number }
  /** エラー行（行番号・原文・理由） */
  errors: { rowNo: number; rawText: string; message: string }[]
}

// ---------- 項目カスタマイズ（F-31） ----------

/** 項目設定の差分（未設定 = カタログ既定。§4） */
export interface ItemSetting {
  id: string
  appKey: string
  entity: string
  itemKey: string
  formVisible: boolean | null
  formRequired: boolean | null
  listVisible: boolean | null
  displayOrder: number | null
  labelOverride: string | null
}

// ---------- アプリ基盤（F-20） ----------

/** アプリの使用/不使用・ラベルオーバーライド（設定系。§2.2） */
export interface AkebonoAppConfig {
  appKey: string
  enabled: boolean
  labelOverride: string | null
  /** preset = プリセット由来 / manual = 管理者が個別設定 */
  source: 'preset' | 'manual'
}
