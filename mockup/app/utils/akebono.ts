/**
 * Akebonoメニュー 純関数ユーティリティ（Vue 非依存・単体テスト対象）
 * SoT: .ai-native/outputs/phase5/akebono-menu-design.md §1.3 / §3
 *
 * 計算ポリシー（在庫残高・委託精算・税）は「設定データ + 純関数」で実装し、コード分岐を作らない
 * （第 2 巡決定 = 設定化）。ここに集約し、composable/画面はここを呼ぶ。
 */
import type {
  AkebonoAppConfig, BillingType, BusinessSegment, IndustryType,
  InventoryTxnKind, InvoiceStatus, PayoutMethod, PlanStatus,
  PoStatus, ProductionStatus, PartnerRole,
} from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { Tone } from '~/types/ui'

// ---------- ラベル（区分値の表示。SoT） ----------

export const INDUSTRY_TYPE_LABELS: Record<IndustryType, string> = {
  retail: '小売業',
  maker: 'メーカー業',
  logistics: '物流・倉庫業',
  it_service: '情報サービス業',
  other: 'その他',
}

export const PARTNER_ROLE_LABELS: Record<PartnerRole, string> = {
  customer: '得意先',
  supplier: '仕入先',
  consignor_artist: '委託仕入先（作家）',
  store: '店舗',
  subcontractor: '外注先',
}

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  one_time: '買い切り',
  monthly: '固定月額',
  usage: '従量課金',
}

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  sales_rate: '売上連動（売価 × 作家率）',
  purchase_cost: '仕入単価 × 販売数',
}

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: '下書き',
  ordered: '発注済み',
  partially_received: '一部入荷',
  closed: '完了',
  canceled: '取消',
}

export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  draft: '下書き',
  instructed: '指示済み',
  in_progress: '進行中',
  completed: '完了',
  canceled: '取消',
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  pending: '未処理',
  partial: '一部',
  completed: '完了',
  canceled: '取消',
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: '下書き',
  issued: '発行済み',
  paid: '入金済み',
  void: '無効（赤伝）',
}

export const INVENTORY_KIND_LABELS: Record<InventoryTxnKind, string> = {
  inbound: '入荷',
  outbound: '出荷',
  purchase_in: '仕入入庫',
  adjust: '調整',
  transfer_in: '移動入',
  transfer_out: '移動出',
  production_in: '生産入庫',
  stocktake: '棚卸調整',
}

export const ADJUST_REASON_LABELS: Record<string, string> = {
  defective: '破損',
  lost: '紛失',
  found: '発見',
  sample: 'サンプル出庫',
  stocktake: '棚卸差異',
  other: 'その他',
}

/** ステータス → バッジトーン（U-2: 状態はバッジ色で直感表示） */
export function planStatusTone(status: PlanStatus): Tone {
  return status === 'completed' ? 'ok' : status === 'partial' ? 'info' : status === 'canceled' ? 'neutral' : 'warn'
}

export function poStatusTone(status: PoStatus): Tone {
  if (status === 'closed') return 'ok'
  if (status === 'partially_received') return 'info'
  if (status === 'canceled') return 'neutral'
  if (status === 'ordered') return 'brand'
  return 'warn'
}

export function invoiceStatusTone(status: InvoiceStatus): Tone {
  if (status === 'paid') return 'ok'
  if (status === 'issued') return 'brand'
  if (status === 'void') return 'neutral'
  return 'warn'
}

export function productionStatusTone(status: ProductionStatus): Tone {
  if (status === 'completed') return 'ok'
  if (status === 'in_progress') return 'brand'
  if (status === 'instructed') return 'info'
  if (status === 'canceled') return 'neutral'
  return 'warn'
}

// ---------- 取引ロール ----------

/** 取引先の取引ロール（未設定の下位互換: 顧客 = ['customer'] / 自社 = []） */
export function partnerRolesOf(company: Pick<Company, 'kind' | 'partnerRoles'>): string[] {
  if (company.partnerRoles && company.partnerRoles.length > 0) return company.partnerRoles
  return company.kind === 'customer' ? ['customer'] : []
}

export function hasPartnerRole(company: Pick<Company, 'kind' | 'partnerRoles'>, role: PartnerRole): boolean {
  return partnerRolesOf(company).includes(role)
}

// ---------- 在庫残高・税・委託精算・採番（Phase C で shared/domain/akebono へ移設し API と共有） ----------
// 既存 import（composable・テスト）を不変に保つため再エクスポートする（原則3・7）。
// 実装・詳細コメントの SoT は shared/domain/akebono.ts

export {
  balanceKey, buildSettlementSnapshot, calcPayoutAmount, calcStoreMargin, calcTax,
  foldBalances, nextCode, roundBy, totalStockOf,
} from '../../../shared/domain/akebono'

export interface StockBalanceKey {
  skuId: string
  warehouseId: string
}

// ---------- 業種プリセット（§3.3） ----------

/** アプリキー（media = メディア分析。各業態と 1:1 で対になるため全業種の既定 ON。2026-07-28） */
export const AKEBONO_APP_KEYS = [
  'products', 'production', 'purchase-orders', 'purchases',
  'inbounds', 'outbounds', 'inventory', 'sales', 'billing', 'media',
] as const
export type AkebonoAppKey = (typeof AKEBONO_APP_KEYS)[number]

/** 業種プリセット（●=既定 ON）。§3.3 の表を機械化。media は全業種で既定 ON（1:1 ペアリング） */
export const INDUSTRY_PRESET: Record<IndustryType, AkebonoAppKey[]> = {
  retail: ['products', 'purchase-orders', 'purchases', 'inventory', 'sales', 'billing', 'media'],
  maker: ['products', 'production', 'purchase-orders', 'purchases', 'inventory', 'sales', 'billing', 'media'],
  logistics: ['products', 'inbounds', 'outbounds', 'inventory', 'sales', 'billing', 'media'],
  it_service: ['products', 'production', 'purchase-orders', 'purchases', 'sales', 'billing', 'media'],
  other: ['products', 'sales', 'billing', 'media'],
}

/** 複数セグメントの業種タイプから使用アプリ既定（和集合） */
export function presetAppsFor(industryTypes: IndustryType[]): AkebonoAppKey[] {
  const set = new Set<AkebonoAppKey>()
  for (const it of industryTypes) for (const app of INDUSTRY_PRESET[it]) set.add(app)
  return AKEBONO_APP_KEYS.filter(k => set.has(k))
}

/** 1 業態の使用アプリ既定（その業態の業種タイプ単独のプリセット） */
export function presetAppsForSegment(segment: Pick<BusinessSegment, 'industryType'>): AkebonoAppKey[] {
  return presetAppsFor([segment.industryType])
}

// ---------- 業態コンテキスト（マルチ業態。F-20 拡張） ----------

/**
 * 「現在の業態」を解決する純関数。
 * - 指定 id が有効な業態にあればそれを、無ければ先頭の業態を、業態が無ければ '' を返す。
 * - ヘッダの業態スイッチャ・各アプリの既定業態（毎回選ばせない導線）で共有する。
 */
export function resolveDefaultSegmentId(
  currentId: string | null | undefined,
  activeSegments: Pick<BusinessSegment, 'id'>[],
): string {
  if (currentId && activeSegments.some(s => s.id === currentId)) return currentId
  return activeSegments[0]?.id ?? ''
}

/**
 * 業態ごとの初期アプリ設定を生成する（シード・新規業態の初期化で共有）。
 * 各業態の業種タイプのプリセットに含まれるアプリを enabled=true にする。
 * 一意キー = (segmentId, appKey)。
 */
export function presetAppConfigsForSegments(
  segments: Pick<BusinessSegment, 'id' | 'industryType'>[],
): AkebonoAppConfig[] {
  const configs: AkebonoAppConfig[] = []
  for (const seg of segments) {
    const preset = new Set(presetAppsForSegment(seg))
    for (const appKey of AKEBONO_APP_KEYS) {
      configs.push({
        segmentId: seg.id,
        appKey,
        enabled: preset.has(appKey),
        labelOverride: null,
        source: 'preset',
      })
    }
  }
  return configs
}

// ---------- 業態アプリの表示・入力既定（F-20 拡張。2026-07-28） ----------

/**
 * 業態アプリのアイコン選択肢（lucide キー。トップに並べる業態アプリの識別用）。
 * 画像アップロードを使わない場合はここから選ぶ（原則5: アイコンは lucide のみ）。
 */
export const SEGMENT_ICON_CHOICES = [
  'Sunrise', 'Store', 'ShoppingBag', 'ShoppingCart', 'Factory', 'Truck', 'Boxes',
  'Server', 'Cpu', 'Cloud', 'Palette', 'Shirt', 'Gem', 'Utensils', 'Coffee',
  'Wrench', 'Rocket', 'Building2', 'Package', 'Sparkles',
] as const
export type SegmentIconKey = (typeof SEGMENT_ICON_CHOICES)[number]

/** 業種タイプ別の既定アイコン（appIcon 未設定時のフォールバック） */
export const INDUSTRY_DEFAULT_ICON: Record<IndustryType, SegmentIconKey> = {
  retail: 'Store',
  maker: 'Factory',
  logistics: 'Truck',
  it_service: 'Server',
  other: 'Package',
}

/** 業態アプリのアイコンキーを解決する（未設定 = 業種タイプ既定） */
export function segmentIconKey(segment: Pick<BusinessSegment, 'industryType' | 'appIcon'>): string {
  const key = segment.appIcon?.trim()
  return key || INDUSTRY_DEFAULT_ICON[segment.industryType]
}

/** 業態アプリの表示名を解決する（appName 優先・未設定は業態名） */
export function segmentAppName(segment: Pick<BusinessSegment, 'name' | 'appName'>): string {
  return segment.appName?.trim() || segment.name
}

/** 商品登録フォームで自動適用する既定値（業態設定に集約。通常フォームでは編集不可） */
export interface SegmentFieldDefaults {
  unitId: string | null
  billingType: BillingType | null
  variantAxis1Label: string | null
  variantAxis2Label: string | null
}

/**
 * 業態の商品既定値を取り出す（未設定は null）。
 * 商品登録・編集の通常フォームはこれを既定として使い、個別変更は「カスタマイズ」フォームでのみ許す。
 * segment が無い場合も安全に空既定を返す（原則7）。
 */
export function segmentFieldDefaults(
  segment: Pick<BusinessSegment, 'defaultUnitId' | 'defaultBillingType' | 'defaultVariantAxis1Label' | 'defaultVariantAxis2Label'> | null | undefined,
): SegmentFieldDefaults {
  return {
    unitId: segment?.defaultUnitId ?? null,
    billingType: segment?.defaultBillingType ?? null,
    variantAxis1Label: segment?.defaultVariantAxis1Label ?? null,
    variantAxis2Label: segment?.defaultVariantAxis2Label ?? null,
  }
}
