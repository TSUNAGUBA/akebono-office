/**
 * Akebonoメニュー 純関数ユーティリティ（Vue 非依存・単体テスト対象）
 * SoT: .ai-native/outputs/phase5/akebono-menu-design.md §1.3 / §3
 *
 * 計算ポリシー（在庫残高・委託精算・税）は「設定データ + 純関数」で実装し、コード分岐を作らない
 * （第 2 巡決定 = 設定化）。ここに集約し、composable/画面はここを呼ぶ。
 */
import type {
  BillingType, ConsignmentTerm, IndustryType, InventoryTransaction, InventoryTxnKind,
  InvoiceStatus, PayoutMethod, PlanStatus, PoStatus, ProductionStatus,
  Rounding, SalesRecord, SettlementSnapshot, PartnerRole,
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

// ---------- 在庫残高（台帳からの導出。SoT = InventoryTransaction） ----------

export interface StockBalanceKey {
  skuId: string
  warehouseId: string
}

/** 台帳から SKU × 倉庫の残高を畳み込む（warehouse 実証方式: Σqty） */
export function foldBalances(txns: InventoryTransaction[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const t of txns) {
    const key = `${t.skuId}::${t.warehouseId}`
    map.set(key, (map.get(key) ?? 0) + t.qty)
  }
  return map
}

export function balanceKey(skuId: string, warehouseId: string): string {
  return `${skuId}::${warehouseId}`
}

/** 特定 SKU の全倉庫合計残高 */
export function totalStockOf(txns: InventoryTransaction[], skuId: string): number {
  return txns.filter(t => t.skuId === skuId).reduce((s, t) => s + t.qty, 0)
}

// ---------- 税計算（設定注入型純関数） ----------

export function roundBy(value: number, mode: Rounding): number {
  if (mode === 'ceil') return Math.ceil(value)
  if (mode === 'round') return Math.round(value)
  return Math.floor(value)
}

/**
 * 税額を算出する。
 * - taxIncluded=false（外税）: tax = round(amount * rate)
 * - taxIncluded=true（内税）: tax = round(amount - amount / (1 + rate))
 */
export function calcTax(amount: number, rate: number, included: boolean, rounding: Rounding): number {
  if (rate <= 0) return 0
  const raw = included ? amount - amount / (1 + rate) : amount * rate
  return roundBy(raw, rounding)
}

// ---------- 委託精算（第 2 巡決定 = 設定化） ----------

/** 委託条件（store 行 + consignor_artist 行）からスナップショットを作る */
export function buildSettlementSnapshot(
  storeTerm: ConsignmentTerm | undefined,
  artistTerm: ConsignmentTerm | undefined,
  taxRate: number,
): SettlementSnapshot {
  return {
    payoutMethod: artistTerm?.payoutMethod ?? null,
    payoutRate: artistTerm?.payoutRate ?? null,
    marginRate: storeTerm?.marginRate ?? null,
    taxRate,
    taxIncluded: (artistTerm ?? storeTerm)?.taxIncluded ?? false,
    rounding: (artistTerm ?? storeTerm)?.rounding ?? 'floor',
  }
}

/**
 * 作家への支払額を算定する（決定 #5 + 第 2 巡）。
 * - sales_rate: 売価 × 販売数 × 作家率
 * - purchase_cost: 仕入単価（解決済み） × 販売数
 * unitCostResolver は purchase_cost 方式のとき SKU の単価を返す
 * （①直近仕入実績 → ② SKU 原価 → ③ 商品標準原価 のフォールバックは呼び出し側で解決して渡す）。
 */
export function calcPayoutAmount(
  record: Pick<SalesRecord, 'skuId' | 'qty' | 'amount'>,
  snapshot: SettlementSnapshot,
  unitCostResolver: (skuId: string) => number,
): number {
  if (snapshot.payoutMethod === 'purchase_cost') {
    return roundBy(unitCostResolver(record.skuId) * record.qty, snapshot.rounding)
  }
  // sales_rate（既定）: 売上金額 × 作家率
  const rate = snapshot.payoutRate ?? 0
  return roundBy(record.amount * rate, snapshot.rounding)
}

/** 店舗へのマージン請求額（当社取り分 = 売上 × マージン率。決定 #5 案 1） */
export function calcStoreMargin(salesAmount: number, snapshot: SettlementSnapshot): number {
  const rate = snapshot.marginRate ?? 0
  return roundBy(salesAmount * rate, snapshot.rounding)
}

// ---------- 採番 ----------

/** 接頭辞連番の次番号（決定 #14。既存 nextId と同型だが伝票用に prefix を明示） */
export function nextCode(existing: string[], prefix: string): string {
  let max = 0
  for (const c of existing) {
    if (c.startsWith(`${prefix}-`)) {
      const n = Number(c.slice(prefix.length + 1))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// ---------- 業種プリセット（§3.3） ----------

/** アプリキー */
export const AKEBONO_APP_KEYS = [
  'products', 'production', 'purchase-orders', 'purchases',
  'inbounds', 'outbounds', 'inventory', 'sales', 'billing',
] as const
export type AkebonoAppKey = (typeof AKEBONO_APP_KEYS)[number]

/** 業種プリセット（●=既定 ON）。§3.3 の表を機械化 */
export const INDUSTRY_PRESET: Record<IndustryType, AkebonoAppKey[]> = {
  retail: ['products', 'purchase-orders', 'purchases', 'inventory', 'sales', 'billing'],
  maker: ['products', 'production', 'purchase-orders', 'purchases', 'inventory', 'sales', 'billing'],
  logistics: ['products', 'inbounds', 'outbounds', 'inventory', 'sales', 'billing'],
  it_service: ['products', 'production', 'purchase-orders', 'purchases', 'sales', 'billing'],
  other: ['products', 'sales', 'billing'],
}

/** 複数セグメントの業種タイプから使用アプリ既定（和集合） */
export function presetAppsFor(industryTypes: IndustryType[]): AkebonoAppKey[] {
  const set = new Set<AkebonoAppKey>()
  for (const it of industryTypes) for (const app of INDUSTRY_PRESET[it]) set.add(app)
  return AKEBONO_APP_KEYS.filter(k => set.has(k))
}
