/**
 * Akebonoメニュー（業務アプリ群）シードデータ（決定的）
 * SoT: .ai-native/outputs/phase5/akebono-menu-design.md
 *
 * デモシナリオ（自社 = TSUNAGUBA の複合業態）:
 * - 陶磁器委託販売（seg-01・小売系）: 作家から委託仕入 → 自社倉庫 → 店舗へ納品（預け在庫）
 *   → 店舗売上 → 店舗へマージン請求 + 作家へ支払
 * - SI 事業（seg-02・情報サービス）/ SaaS 事業（seg-03・情報サービス）: サービス品目の売上
 * - アパレル（seg-04・小売）: カラー×サイズの SKU 展開の代表例（他社展開シナリオ）
 *
 * 在庫は InventoryTransaction（台帳）が SoT。ここでは台帳行と、それを生んだ入荷/出荷実績を
 * 整合させて投入する（refLineId で対応。冪等キー = refType × refLineId × kind）。
 */
import type { Company } from '~/types/domain'
import type {
  AkebonoAppConfig, BusinessSegment, ConsignmentTerm, ImportMapping, ImportRun, ImportSource,
  InboundPlan, InboundResult, InventoryTransaction, Invoice, ItemSetting, OutboundPlan,
  OutboundResult, PaymentNotice, PaymentReceipt, PaymentTerm, Product, ProductCategory,
  ProductImage, ProductImageSection, ProductSku, ProductionOrder, PurchaseOrder, PurchaseRecord,
  SalesRecord, TaxRate, Unit, VariantAxisTemplate, Warehouse,
} from '~/types/akebono'
import { AKEBONO_APP_KEYS } from '~/utils/akebono'

// ---------- 日付ヘルパー（今日基準・決定的） ----------

const TODAY = todayJst() // YYYY-MM-DD
const CUR_MONTH = TODAY.slice(0, 7)

/** YYYY-MM を delta ヶ月ずらす（文字列演算・TZ 非依存） */
function monthOffset(month: string, delta: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 + delta
  const ny = y + Math.floor(m / 12)
  const nm = ((m % 12) + 12) % 12
  return `${ny}-${String(nm + 1).padStart(2, '0')}`
}
/** その月の 15 日（YYYY-MM-DD）。売上・仕入の代表日 */
function midOf(month: string): string {
  return `${month}-15`
}
function isoAt(date: string, hh = 10): string {
  return `${date}T${String(hh).padStart(2, '0')}:00:00+09:00`
}

const M0 = CUR_MONTH
const M1 = monthOffset(CUR_MONTH, -1)
const M2 = monthOffset(CUR_MONTH, -2)
const M3 = monthOffset(CUR_MONTH, -3)

// ---------- 取引先（Akebono 拡張。作家・店舗・卸） ----------

export const seedAkebonoCompanies: Company[] = [
  {
    id: 'c-ak-01', kind: 'customer', name: '山田陶房', aliases: ['山田', 'やまだとうぼう'],
    industryIds: [], primaryIndustryId: null, size: '個人', location: '岐阜県',
    description: '陶磁器作家。茶碗・湯呑を中心に委託納品', ownerMemberId: 'm-03', fiscalStartMonth: null,
    active: true, custom: {}, partnerRoles: ['consignor_artist'], paymentTermId: 'pt-01', billingTermId: null,
  },
  {
    id: 'c-ak-02', kind: 'customer', name: '佐藤窯', aliases: ['佐藤', 'さとうがま'],
    industryIds: [], primaryIndustryId: null, size: '個人', location: '佐賀県',
    description: '白磁の花器・皿の作家', ownerMemberId: 'm-03', fiscalStartMonth: null,
    active: true, custom: {}, partnerRoles: ['consignor_artist'], paymentTermId: 'pt-01', billingTermId: null,
  },
  {
    id: 'c-ak-03', kind: 'customer', name: '銀座ギャラリー店', aliases: ['銀座', 'ぎんざ'],
    industryIds: [], primaryIndustryId: null, size: '小規模', location: '東京都',
    description: '陶磁器を扱うセレクトショップ。委託販売先', ownerMemberId: 'm-04', fiscalStartMonth: null,
    active: true, custom: {}, partnerRoles: ['store', 'customer'], paymentTermId: null, billingTermId: 'pt-02',
  },
  {
    id: 'c-ak-04', kind: 'customer', name: '横浜クラフト店', aliases: ['横浜', 'よこはま'],
    industryIds: [], primaryIndustryId: null, size: '小規模', location: '神奈川県',
    description: '工芸品店。委託販売先', ownerMemberId: 'm-04', fiscalStartMonth: null,
    active: true, custom: {}, partnerRoles: ['store', 'customer'], paymentTermId: null, billingTermId: 'pt-02',
  },
  {
    id: 'c-ak-06', kind: 'customer', name: 'あさひ繊維卸', aliases: ['あさひ', 'アサヒ繊維'],
    industryIds: [], primaryIndustryId: null, size: '100-300名', location: '大阪府',
    description: 'アパレル生地・製品の卸。仕入先', ownerMemberId: 'm-05', fiscalStartMonth: null,
    active: true, custom: {}, partnerRoles: ['supplier'], paymentTermId: 'pt-01', billingTermId: null,
  },
]

// ---------- マスタ ----------

export const seedBusinessSegments: BusinessSegment[] = [
  { id: 'seg-01', name: '陶磁器委託販売', industryType: 'retail', displayOrder: 1, active: true },
  { id: 'seg-02', name: 'SI 事業', industryType: 'it_service', displayOrder: 2, active: true },
  { id: 'seg-03', name: 'SaaS 事業', industryType: 'it_service', displayOrder: 3, active: true },
  { id: 'seg-04', name: 'アパレル', industryType: 'retail', displayOrder: 4, active: true },
]

export const seedWarehouses: Warehouse[] = [
  { id: 'wh-01', name: '自社倉庫（本社）', kind: 'own', companyId: null, displayOrder: 1, active: true },
  { id: 'wh-02', name: '銀座ギャラリー店（預け）', kind: 'store_deposit', companyId: 'c-ak-03', displayOrder: 2, active: true },
  { id: 'wh-03', name: '横浜クラフト店（預け）', kind: 'store_deposit', companyId: 'c-ak-04', displayOrder: 3, active: true },
]

export const seedUnits: Unit[] = [
  { id: 'unit-01', name: '個', displayOrder: 1, active: true },
  { id: 'unit-02', name: '点', displayOrder: 2, active: true },
  { id: 'unit-03', name: '式', displayOrder: 3, active: true },
  { id: 'unit-04', name: '人日', displayOrder: 4, active: true },
  { id: 'unit-05', name: 'ライセンス', displayOrder: 5, active: true },
]

export const seedTaxRates: TaxRate[] = [
  { id: 'tax-10', name: '標準税率（10%）', rate: 0.10, displayOrder: 1, active: true },
  { id: 'tax-08', name: '軽減税率（8%）', rate: 0.08, displayOrder: 2, active: true },
  { id: 'tax-00', name: '非課税（0%）', rate: 0, displayOrder: 3, active: true },
]

export const seedPaymentTerms: PaymentTerm[] = [
  { id: 'pt-01', name: '月末締め翌月末払い', closingDay: 31, payMonthOffset: 1, payDay: 31, active: true },
  { id: 'pt-02', name: '20日締め翌月10日払い', closingDay: 20, payMonthOffset: 1, payDay: 10, active: true },
]

export const seedConsignmentTerms: ConsignmentTerm[] = [
  // 陶磁器委託販売（seg-01）: 店舗行（マージン請求設定）+ 作家行（支払設定）
  {
    id: 'ct-01', companyId: 'c-ak-03', segmentId: 'seg-01', role: 'store',
    marginRate: 0.30, payoutMethod: null, payoutRate: null, liabilityTiming: null,
    taxRateId: 'tax-10', taxIncluded: false, rounding: 'floor', validFrom: '2026-01-01', active: true,
  },
  {
    id: 'ct-02', companyId: 'c-ak-04', segmentId: 'seg-01', role: 'store',
    marginRate: 0.35, payoutMethod: null, payoutRate: null, liabilityTiming: null,
    taxRateId: 'tax-10', taxIncluded: false, rounding: 'floor', validFrom: '2026-01-01', active: true,
  },
  {
    id: 'ct-03', companyId: 'c-ak-01', segmentId: 'seg-01', role: 'consignor_artist',
    marginRate: null, payoutMethod: 'sales_rate', payoutRate: 0.60, liabilityTiming: 'on_sale',
    taxRateId: 'tax-10', taxIncluded: false, rounding: 'floor', validFrom: '2026-01-01', active: true,
  },
  {
    id: 'ct-04', companyId: 'c-ak-02', segmentId: 'seg-01', role: 'consignor_artist',
    marginRate: null, payoutMethod: 'sales_rate', payoutRate: 0.55, liabilityTiming: 'on_sale',
    taxRateId: 'tax-10', taxIncluded: false, rounding: 'floor', validFrom: '2026-01-01', active: true,
  },
]

export const seedVariantAxisTemplates: VariantAxisTemplate[] = [
  { id: 'vat-01', name: 'アパレル（カラー×サイズ）', axis1Label: 'カラー', axis2Label: 'サイズ', industryTypes: ['retail'], displayOrder: 1, active: true },
  { id: 'vat-02', name: '食品（容量×味）', axis1Label: '容量', axis2Label: '味', industryTypes: ['maker', 'other'], displayOrder: 2, active: true },
  { id: 'vat-03', name: '雑貨（柄×入数）', axis1Label: '柄', axis2Label: '入数', industryTypes: ['retail', 'other'], displayOrder: 3, active: true },
]

export const seedProductCategories: ProductCategory[] = [
  { id: 'pcat-01', name: '陶磁器', parentId: null, displayOrder: 1, active: true },
  { id: 'pcat-02', name: '食器', parentId: 'pcat-01', displayOrder: 1, active: true },
  { id: 'pcat-03', name: '花器', parentId: 'pcat-01', displayOrder: 2, active: true },
  { id: 'pcat-04', name: 'アパレル', parentId: null, displayOrder: 2, active: true },
  { id: 'pcat-05', name: 'トップス', parentId: 'pcat-04', displayOrder: 1, active: true },
  { id: 'pcat-06', name: 'ボトムス', parentId: 'pcat-04', displayOrder: 2, active: true },
  { id: 'pcat-07', name: 'サービス', parentId: null, displayOrder: 3, active: true },
]

export const seedProductImageSections: ProductImageSection[] = [
  { id: 'pis-01', name: '製品画像', isThumbnailPriority: true, isSeed: true, displayOrder: 1, active: true },
  { id: 'pis-02', name: 'サンプル画像', isThumbnailPriority: false, isSeed: true, displayOrder: 2, active: true },
]

// ---------- 商品・SKU・画像 ----------

export const seedProducts: Product[] = [
  {
    id: 'prd-01', code: 'TJ-0001', name: '藍染め茶碗', segmentId: 'seg-01', categoryId: 'pcat-02',
    defaultSupplierCompanyId: 'c-ak-01', listPrice: 4800, standardCost: 2880, taxRateId: 'tax-10', unitId: 'unit-02',
    billingType: null, variantAxis1Label: null, variantAxis2Label: null,
    description: '山田陶房の手びねり茶碗。藍の釉薬が特徴', active: true, custom: {},
  },
  {
    id: 'prd-02', code: 'TJ-0002', name: '白磁花器', segmentId: 'seg-01', categoryId: 'pcat-03',
    defaultSupplierCompanyId: 'c-ak-02', listPrice: 12000, standardCost: 6600, taxRateId: 'tax-10', unitId: 'unit-02',
    billingType: null, variantAxis1Label: null, variantAxis2Label: null,
    description: '佐藤窯の白磁花器', active: true, custom: {},
  },
  {
    id: 'prd-03', code: 'AP-0001', name: 'リネンシャツ', segmentId: 'seg-04', categoryId: 'pcat-05',
    defaultSupplierCompanyId: 'c-ak-06', listPrice: 8900, standardCost: 4200, taxRateId: 'tax-10', unitId: 'unit-01',
    billingType: null, variantAxis1Label: 'カラー', variantAxis2Label: 'サイズ',
    description: 'カラー×サイズ展開のリネンシャツ', active: true, custom: {},
  },
  {
    id: 'prd-04', code: 'AP-0002', name: 'コットンパンツ', segmentId: 'seg-04', categoryId: 'pcat-06',
    defaultSupplierCompanyId: 'c-ak-06', listPrice: 7500, standardCost: 3600, taxRateId: 'tax-10', unitId: 'unit-01',
    billingType: null, variantAxis1Label: 'カラー', variantAxis2Label: 'サイズ',
    description: 'ベージュのコットンパンツ', active: true, custom: {},
  },
  {
    id: 'prd-05', code: 'SI-0001', name: '業務システム構築（SI案件）', segmentId: 'seg-02', categoryId: 'pcat-07',
    defaultSupplierCompanyId: null, listPrice: 5000000, standardCost: 3000000, taxRateId: 'tax-10', unitId: 'unit-03',
    billingType: 'one_time', variantAxis1Label: null, variantAxis2Label: null,
    description: '受託開発（買い切り）', active: true, custom: {},
  },
  {
    id: 'prd-06', code: 'SA-0001', name: 'Akebono SaaS スタンダード', segmentId: 'seg-03', categoryId: 'pcat-07',
    defaultSupplierCompanyId: null, listPrice: 30000, standardCost: 6000, taxRateId: 'tax-10', unitId: 'unit-05',
    billingType: 'monthly', variantAxis1Label: null, variantAxis2Label: null,
    description: '固定月額のSaaS', active: true, custom: {},
  },
  {
    id: 'prd-07', code: 'SA-0002', name: 'Akebono API（従量）', segmentId: 'seg-03', categoryId: 'pcat-07',
    defaultSupplierCompanyId: null, listPrice: 5, standardCost: 1, taxRateId: 'tax-10', unitId: 'unit-05',
    billingType: 'usage', variantAxis1Label: null, variantAxis2Label: null,
    description: 'API 呼び出し従量課金（1 コールあたり）', active: true, custom: {},
  },
]

export const seedProductSkus: ProductSku[] = [
  { id: 'sku-01-0', productId: 'prd-01', code: 'TJ-0001', janCode: null, axis1Value: null, axis2Value: null, sellPrice: null, costPrice: null, isDefault: true, active: true },
  { id: 'sku-02-0', productId: 'prd-02', code: 'TJ-0002', janCode: null, axis1Value: null, axis2Value: null, sellPrice: null, costPrice: null, isDefault: true, active: true },
  // リネンシャツ: カラー[ホワイト/ネイビー] × サイズ[M/L]
  { id: 'sku-03-1', productId: 'prd-03', code: 'AP-0001-WH-M', janCode: '4900000000031', axis1Value: 'ホワイト', axis2Value: 'M', sellPrice: null, costPrice: null, isDefault: false, active: true },
  { id: 'sku-03-2', productId: 'prd-03', code: 'AP-0001-WH-L', janCode: '4900000000048', axis1Value: 'ホワイト', axis2Value: 'L', sellPrice: null, costPrice: null, isDefault: false, active: true },
  { id: 'sku-03-3', productId: 'prd-03', code: 'AP-0001-NV-M', janCode: '4900000000055', axis1Value: 'ネイビー', axis2Value: 'M', sellPrice: null, costPrice: null, isDefault: false, active: true },
  { id: 'sku-03-4', productId: 'prd-03', code: 'AP-0001-NV-L', janCode: '4900000000062', axis1Value: 'ネイビー', axis2Value: 'L', sellPrice: null, costPrice: null, isDefault: false, active: true },
  // コットンパンツ: カラー[ベージュ] × サイズ[M/L]
  { id: 'sku-04-1', productId: 'prd-04', code: 'AP-0002-BE-M', janCode: '4900000000079', axis1Value: 'ベージュ', axis2Value: 'M', sellPrice: null, costPrice: null, isDefault: false, active: true },
  { id: 'sku-04-2', productId: 'prd-04', code: 'AP-0002-BE-L', janCode: '4900000000086', axis1Value: 'ベージュ', axis2Value: 'L', sellPrice: null, costPrice: null, isDefault: false, active: true },
  // サービス品目（既定 SKU）
  { id: 'sku-05-0', productId: 'prd-05', code: 'SI-0001', janCode: null, axis1Value: null, axis2Value: null, sellPrice: null, costPrice: null, isDefault: true, active: true },
  { id: 'sku-06-0', productId: 'prd-06', code: 'SA-0001', janCode: null, axis1Value: null, axis2Value: null, sellPrice: null, costPrice: null, isDefault: true, active: true },
  { id: 'sku-07-0', productId: 'prd-07', code: 'SA-0002', janCode: null, axis1Value: null, axis2Value: null, sellPrice: null, costPrice: null, isDefault: true, active: true },
]

export const seedProductImages: ProductImage[] = [
  { id: 'pimg-01', productId: 'prd-01', skuId: null, sectionId: 'pis-01', displayOrder: 1, filename: 'aizome-chawan.jpg', mime: 'image/jpeg', dataUrl: null, active: true },
  { id: 'pimg-02', productId: 'prd-01', skuId: null, sectionId: 'pis-02', displayOrder: 1, filename: 'aizome-sample.jpg', mime: 'image/jpeg', dataUrl: null, active: true },
  { id: 'pimg-03', productId: 'prd-02', skuId: null, sectionId: 'pis-01', displayOrder: 1, filename: 'hakuji-kaki.jpg', mime: 'image/jpeg', dataUrl: null, active: true },
  { id: 'pimg-04', productId: 'prd-03', skuId: null, sectionId: 'pis-01', displayOrder: 1, filename: 'linen-shirt.jpg', mime: 'image/jpeg', dataUrl: null, active: true },
  { id: 'pimg-05', productId: 'prd-03', skuId: 'sku-03-3', sectionId: 'pis-01', displayOrder: 2, filename: 'linen-navy.jpg', mime: 'image/jpeg', dataUrl: null, active: true },
]

// ---------- 在庫台帳 + 入荷/出荷/仕入 実績 ----------

/** 入荷予定 + 実績（仕入・卸から） */
export const seedInboundPlans: InboundPlan[] = [
  { id: 'ibp-01', code: 'IBP-0001', poId: null, warehouseId: 'wh-01', dueDate: midOf(M3), status: 'completed', lines: [{ id: 'ibpl-01', skuId: 'sku-01-0', qty: 20 }] },
  { id: 'ibp-02', code: 'IBP-0002', poId: null, warehouseId: 'wh-01', dueDate: midOf(M3), status: 'completed', lines: [{ id: 'ibpl-02', skuId: 'sku-02-0', qty: 10 }] },
  { id: 'ibp-03', code: 'IBP-0003', poId: 'po-01', warehouseId: 'wh-01', dueDate: midOf(M2), status: 'completed', lines: [
    { id: 'ibpl-03', skuId: 'sku-03-1', qty: 30 }, { id: 'ibpl-04', skuId: 'sku-03-2', qty: 30 },
    { id: 'ibpl-05', skuId: 'sku-03-3', qty: 20 }, { id: 'ibpl-06', skuId: 'sku-03-4', qty: 20 },
  ] },
  { id: 'ibp-04', code: 'IBP-0004', poId: null, warehouseId: 'wh-01', dueDate: midOf(M0), status: 'pending', lines: [
    { id: 'ibpl-07', skuId: 'sku-04-1', qty: 25 }, { id: 'ibpl-08', skuId: 'sku-04-2', qty: 25 },
  ] },
]

export const seedInboundResults: InboundResult[] = [
  { id: 'ibr-01', code: 'IBR-0001', planId: 'ibp-01', warehouseId: 'wh-01', receivedAt: isoAt(midOf(M3)), lines: [{ id: 'ibrl-01', planLineId: 'ibpl-01', skuId: 'sku-01-0', qty: 20 }] },
  { id: 'ibr-02', code: 'IBR-0002', planId: 'ibp-02', warehouseId: 'wh-01', receivedAt: isoAt(midOf(M3)), lines: [{ id: 'ibrl-02', planLineId: 'ibpl-02', skuId: 'sku-02-0', qty: 10 }] },
  { id: 'ibr-03', code: 'IBR-0003', planId: 'ibp-03', warehouseId: 'wh-01', receivedAt: isoAt(midOf(M2)), lines: [
    { id: 'ibrl-03', planLineId: 'ibpl-03', skuId: 'sku-03-1', qty: 30 }, { id: 'ibrl-04', planLineId: 'ibpl-04', skuId: 'sku-03-2', qty: 30 },
    { id: 'ibrl-05', planLineId: 'ibpl-05', skuId: 'sku-03-3', qty: 20 }, { id: 'ibrl-06', planLineId: 'ibpl-06', skuId: 'sku-03-4', qty: 20 },
  ] },
]

/** 出荷指示 + 実績（陶磁器を店舗へ納品 = 預け在庫へ移動） */
export const seedOutboundPlans: OutboundPlan[] = [
  { id: 'obp-01', code: 'OBP-0001', companyId: 'c-ak-03', warehouseId: 'wh-01', segmentId: 'seg-01', dueDate: midOf(M2), status: 'completed', lines: [{ id: 'obpl-01', skuId: 'sku-01-0', qty: 8 }] },
  { id: 'obp-02', code: 'OBP-0002', companyId: 'c-ak-04', warehouseId: 'wh-01', segmentId: 'seg-01', dueDate: midOf(M2), status: 'completed', lines: [{ id: 'obpl-02', skuId: 'sku-02-0', qty: 4 }] },
  { id: 'obp-03', code: 'OBP-0003', companyId: 'c-ak-03', warehouseId: 'wh-01', segmentId: 'seg-01', dueDate: midOf(M0), status: 'pending', lines: [{ id: 'obpl-03', skuId: 'sku-01-0', qty: 5 }] },
]

export const seedOutboundResults: OutboundResult[] = [
  { id: 'obr-01', code: 'OBR-0001', planId: 'obp-01', warehouseId: 'wh-01', companyId: 'c-ak-03', shippedAt: isoAt(midOf(M2)), lines: [{ id: 'obrl-01', planLineId: 'obpl-01', skuId: 'sku-01-0', qty: 8 }] },
  { id: 'obr-02', code: 'OBR-0002', planId: 'obp-02', warehouseId: 'wh-01', companyId: 'c-ak-04', shippedAt: isoAt(midOf(M2)), lines: [{ id: 'obrl-02', planLineId: 'obpl-02', skuId: 'sku-02-0', qty: 4 }] },
]

/**
 * 在庫台帳（SoT）。入荷実績で +、出荷実績で −（自社倉庫）、店舗預けは transfer_in で店舗倉庫へ +。
 * refLineId は各実績明細の id（冪等キー）。
 */
export const seedInventoryTransactions: InventoryTransaction[] = [
  // 入荷（+ 自社倉庫）
  { id: 'itx-01', skuId: 'sku-01-0', warehouseId: 'wh-01', qty: 20, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-01', occurredAt: isoAt(midOf(M3)) },
  { id: 'itx-02', skuId: 'sku-02-0', warehouseId: 'wh-01', qty: 10, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-02', occurredAt: isoAt(midOf(M3)) },
  { id: 'itx-03', skuId: 'sku-03-1', warehouseId: 'wh-01', qty: 30, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-03', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-04', skuId: 'sku-03-2', warehouseId: 'wh-01', qty: 30, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-04', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-05', skuId: 'sku-03-3', warehouseId: 'wh-01', qty: 20, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-05', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-06', skuId: 'sku-03-4', warehouseId: 'wh-01', qty: 20, kind: 'inbound', reason: null, refType: 'inbound_result', refLineId: 'ibrl-06', occurredAt: isoAt(midOf(M2)) },
  // 出荷（− 自社倉庫）+ 店舗預けへ移動（+ 店舗倉庫）
  { id: 'itx-07', skuId: 'sku-01-0', warehouseId: 'wh-01', qty: -8, kind: 'outbound', reason: null, refType: 'outbound_result', refLineId: 'obrl-01', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-08', skuId: 'sku-01-0', warehouseId: 'wh-02', qty: 8, kind: 'transfer_in', reason: null, refType: 'outbound_result', refLineId: 'obrl-01', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-09', skuId: 'sku-02-0', warehouseId: 'wh-01', qty: -4, kind: 'outbound', reason: null, refType: 'outbound_result', refLineId: 'obrl-02', occurredAt: isoAt(midOf(M2)) },
  { id: 'itx-10', skuId: 'sku-02-0', warehouseId: 'wh-03', qty: 4, kind: 'transfer_in', reason: null, refType: 'outbound_result', refLineId: 'obrl-02', occurredAt: isoAt(midOf(M2)) },
  // 店舗売上に伴う店舗預け在庫の減（売上計上時の引き落とし。陶磁器の販売実績）
  { id: 'itx-11', skuId: 'sku-01-0', warehouseId: 'wh-02', qty: -3, kind: 'adjust', reason: 'other', refType: 'store_sale', refLineId: 'ssl-01', occurredAt: isoAt(midOf(M1)) },
  { id: 'itx-12', skuId: 'sku-02-0', warehouseId: 'wh-03', qty: -1, kind: 'adjust', reason: 'other', refType: 'store_sale', refLineId: 'ssl-02', occurredAt: isoAt(midOf(M1)) },
]

/** 仕入計上（陶磁器 = 委託 / アパレル = 買取） */
export const seedPurchaseRecords: PurchaseRecord[] = [
  { id: 'pur-01', code: 'PUR-0001', companyId: 'c-ak-01', segmentId: 'seg-01', purchaseDate: midOf(M3), purchaseType: 'consignment', inboundResultId: 'ibr-01', warehouseId: null, lines: [{ id: 'purl-01', skuId: 'sku-01-0', qty: 20, costPrice: 2880 }], correctionOf: null },
  { id: 'pur-02', code: 'PUR-0002', companyId: 'c-ak-02', segmentId: 'seg-01', purchaseDate: midOf(M3), purchaseType: 'consignment', inboundResultId: 'ibr-02', warehouseId: null, lines: [{ id: 'purl-02', skuId: 'sku-02-0', qty: 10, costPrice: 6600 }], correctionOf: null },
  { id: 'pur-03', code: 'PUR-0003', companyId: 'c-ak-06', segmentId: 'seg-04', purchaseDate: midOf(M2), purchaseType: 'outright', inboundResultId: 'ibr-03', warehouseId: null, lines: [
    { id: 'purl-03', skuId: 'sku-03-1', qty: 30, costPrice: 4200 }, { id: 'purl-04', skuId: 'sku-03-2', qty: 30, costPrice: 4200 },
    { id: 'purl-05', skuId: 'sku-03-3', qty: 20, costPrice: 4200 }, { id: 'purl-06', skuId: 'sku-03-4', qty: 20, costPrice: 4200 },
  ], correctionOf: null },
]

/** 発注（アパレル卸への発注） */
export const seedPurchaseOrders: PurchaseOrder[] = [
  { id: 'po-01', code: 'PO-0001', companyId: 'c-ak-06', segmentId: 'seg-04', status: 'closed', orderDate: midOf(M3), dueDate: midOf(M2), note: 'リネンシャツ初回発注', lines: [
    { id: 'pol-01', skuId: 'sku-03-1', qty: 30, unitPrice: 4200 }, { id: 'pol-02', skuId: 'sku-03-2', qty: 30, unitPrice: 4200 },
    { id: 'pol-03', skuId: 'sku-03-3', qty: 20, unitPrice: 4200 }, { id: 'pol-04', skuId: 'sku-03-4', qty: 20, unitPrice: 4200 },
  ] },
  { id: 'po-02', code: 'PO-0002', companyId: 'c-ak-06', segmentId: 'seg-04', status: 'ordered', orderDate: midOf(M0), dueDate: midOf(M0), note: 'コットンパンツ発注', lines: [
    { id: 'pol-05', skuId: 'sku-04-1', qty: 25, unitPrice: 3600 }, { id: 'pol-06', skuId: 'sku-04-2', qty: 25, unitPrice: 3600 },
  ] },
]

/** 生産指示（メーカー業デモ用。自社は生産なしだが全域表示のため 1 件） */
export const seedProductionOrders: ProductionOrder[] = [
  { id: 'mfg-01', code: 'MFG-0001', skuId: 'sku-04-1', qty: 10, warehouseId: 'wh-01', dueDate: midOf(M0), status: 'in_progress', results: [] },
]

// ---------- 売上明細（SoT） ----------

export const seedSalesRecords: SalesRecord[] = [
  // 陶磁器: 店舗（得意先）での販売実績
  { id: 'sr-01', code: 'SR-0001', salesDate: midOf(M1), companyId: 'c-ak-03', segmentId: 'seg-01', skuId: 'sku-01-0', qty: 3, unitPrice: 4800, amount: 14400, costPrice: 2880, channel: '店舗', billingType: null, sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  { id: 'sr-02', code: 'SR-0002', salesDate: midOf(M1), companyId: 'c-ak-04', segmentId: 'seg-01', skuId: 'sku-02-0', qty: 1, unitPrice: 12000, amount: 12000, costPrice: 6600, channel: '店舗', billingType: null, sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  { id: 'sr-03', code: 'SR-0003', salesDate: midOf(M2), companyId: 'c-ak-03', segmentId: 'seg-01', skuId: 'sku-01-0', qty: 2, unitPrice: 4800, amount: 9600, costPrice: 2880, channel: '店舗', billingType: null, sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  // SI 案件（買い切り）
  { id: 'sr-04', code: 'SR-0004', salesDate: midOf(M2), companyId: 'c-01', segmentId: 'seg-02', skuId: 'sku-05-0', qty: 1, unitPrice: 5000000, amount: 5000000, costPrice: 3000000, channel: null, billingType: 'one_time', sourceKind: 'manual', sourceRef: null, invoiceId: 'inv-01', correctionOf: null, active: true },
  // SaaS（固定月額）
  { id: 'sr-05', code: 'SR-0005', salesDate: midOf(M2), companyId: 'c-02', segmentId: 'seg-03', skuId: 'sku-06-0', qty: 1, unitPrice: 30000, amount: 30000, costPrice: 6000, channel: null, billingType: 'monthly', sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  { id: 'sr-06', code: 'SR-0006', salesDate: midOf(M1), companyId: 'c-02', segmentId: 'seg-03', skuId: 'sku-06-0', qty: 1, unitPrice: 30000, amount: 30000, costPrice: 6000, channel: null, billingType: 'monthly', sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  { id: 'sr-07', code: 'SR-0007', salesDate: midOf(M0), companyId: 'c-02', segmentId: 'seg-03', skuId: 'sku-06-0', qty: 1, unitPrice: 30000, amount: 30000, costPrice: 6000, channel: null, billingType: 'monthly', sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
  // SaaS 従量
  { id: 'sr-08', code: 'SR-0008', salesDate: midOf(M1), companyId: 'c-03', segmentId: 'seg-03', skuId: 'sku-07-0', qty: 12000, unitPrice: 5, amount: 60000, costPrice: 1, channel: null, billingType: 'usage', sourceKind: 'manual', sourceRef: null, invoiceId: null, correctionOf: null, active: true },
]

// ---------- 請求・支払通知・入金 ----------

export const seedInvoices: Invoice[] = [
  // SI 案件の通常請求（発行済み）
  { id: 'inv-01', code: 'INV-0001', companyId: 'c-01', segmentId: 'seg-02', periodFrom: `${M2}-01`, periodTo: `${M2}-31`, invoiceType: 'sales', status: 'issued', issuedAt: isoAt(`${M2}-28`), totalAmount: 5500000, creditFor: null, lines: [{ id: 'invl-01', description: '業務システム構築（SI案件）', amount: 5000000 }, { id: 'invl-02', description: '消費税（10%）', amount: 500000 }], snapshot: null, sourceRecordIds: ['sr-04'] },
]

export const seedPaymentNotices: PaymentNotice[] = []
export const seedPaymentReceipts: PaymentReceipt[] = []

// ---------- 取込 ----------

export const seedImportSources: ImportSource[] = [
  { id: 'imp-01', name: '店舗売上CSV（銀座）', method: 'file_csv', encoding: 'utf8', targetEntity: 'sales_record', schedule: 'manual', active: true },
  { id: 'imp-02', name: '旧販売管理システム（固定長）', method: 'file_fixed', encoding: 'sjis', targetEntity: 'product', schedule: 'manual', active: true },
]

export const seedImportMappings: ImportMapping[] = [
  { id: 'impm-01', sourceId: 'imp-01', version: 1, status: 'active', createdAt: isoAt(midOf(M1)), fields: [
    { id: 'impf-01', sourceField: '売上日', targetItemKey: 'salesDate', transform: 'dateFormat' },
    { id: 'impf-02', sourceField: '商品コード', targetItemKey: 'skuCode', transform: 'trim' },
    { id: 'impf-03', sourceField: '数量', targetItemKey: 'qty', transform: 'numberFormat' },
    { id: 'impf-04', sourceField: '単価', targetItemKey: 'unitPrice', transform: 'numberFormat' },
  ] },
]

export const seedImportRuns: ImportRun[] = [
  { id: 'impr-01', code: 'RUN-0001', sourceId: 'imp-01', mappingVersion: 1, startedAt: isoAt(midOf(M1)), finishedAt: isoAt(midOf(M1), 11), status: 'applied', counts: { staged: 24, applied: 23, skipped: 0, failed: 1 }, errors: [{ rowNo: 12, rawText: '2026-06-15,UNKNOWN-XX,2,4800', message: '商品コード UNKNOWN-XX がマスタ未登録（AKO-IMP-010）' }] },
]

// ---------- 項目カスタマイズ（既定 = 空） ----------

export const seedItemSettings: ItemSetting[] = []

// ---------- アプリ使用/不使用（全域を有効 = デモ全体像確認。§3.3 の自社プリセット + 陶磁器の出荷） ----------

export const seedAkebonoAppConfigs: AkebonoAppConfig[] = AKEBONO_APP_KEYS.map(appKey => ({
  appKey,
  enabled: true,
  labelOverride: null,
  source: 'preset' as const,
}))
