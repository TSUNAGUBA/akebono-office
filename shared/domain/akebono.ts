/**
 * Akebono 記録系ドメインの純関数（フロント/API 共有。Phase C = 0032）。
 * 元は mockup/app/utils/akebono.ts のモック専用実装だったものを、記録系の API 化に伴い
 * サーバー（routes/akebono-trade / akebono-billing）と共有するためここへ移設した
 * （mockup/app/utils/akebono.ts は本モジュールを再エクスポートし既存 import を不変に保つ = 原則3・7）。
 *
 * 計算ポリシー（在庫残高・委託精算・税）は「設定データ + 純関数」で実装し、コード分岐を作らない。
 * 型は構造的最小（mockup の型と互換）で定義し、mockup 型・DB 行のどちらからも渡せる。
 */

export type AkebonoRounding = 'floor' | 'ceil' | 'round'
export type AkebonoPayoutMethod = 'sales_rate' | 'purchase_cost'

/** 委託精算の設定スナップショット（発行時点で凍結） */
export interface AkebonoSettlementSnapshot {
  payoutMethod: AkebonoPayoutMethod | null
  payoutRate: number | null
  marginRate: number | null
  taxRate: number | null
  taxIncluded: boolean
  rounding: AkebonoRounding
}

/** 委託条件（必要属性のみの構造型） */
export interface AkebonoConsignmentTermLike {
  payoutMethod?: AkebonoPayoutMethod | null
  payoutRate?: number | null
  marginRate?: number | null
  taxIncluded?: boolean
  rounding?: AkebonoRounding
}

// ---------- 在庫残高（台帳からの導出。SoT = InventoryTransaction） ----------

export interface AkebonoTxnLike {
  skuId: string
  warehouseId: string
  qty: number
}

/** 台帳から SKU × 倉庫の残高を畳み込む（warehouse 実証方式: Σqty） */
export function foldBalances(txns: AkebonoTxnLike[]): Map<string, number> {
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
export function totalStockOf(txns: AkebonoTxnLike[], skuId: string): number {
  return txns.filter(t => t.skuId === skuId).reduce((s, t) => s + t.qty, 0)
}

// ---------- 税計算（設定注入型純関数） ----------

export function roundBy(value: number, mode: AkebonoRounding): number {
  if (mode === 'ceil') return Math.ceil(value)
  if (mode === 'round') return Math.round(value)
  return Math.floor(value)
}

/**
 * 税額を算出する。
 * - taxIncluded=false（外税）: tax = round(amount * rate)
 * - taxIncluded=true（内税）: tax = round(amount - amount / (1 + rate))
 */
export function calcTax(amount: number, rate: number, included: boolean, rounding: AkebonoRounding): number {
  if (rate <= 0) return 0
  const raw = included ? amount - amount / (1 + rate) : amount * rate
  return roundBy(raw, rounding)
}

// ---------- 委託精算（第 2 巡決定 = 設定化） ----------

/** 委託条件（store 行 + consignor_artist 行）からスナップショットを作る */
export function buildSettlementSnapshot(
  storeTerm: AkebonoConsignmentTermLike | undefined,
  artistTerm: AkebonoConsignmentTermLike | undefined,
  taxRate: number,
): AkebonoSettlementSnapshot {
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
 * - sales_rate: 売上金額 × 作家率
 * - purchase_cost: 仕入単価（解決済み） × 販売数
 * unitCostResolver は purchase_cost 方式のとき SKU の単価を返す
 * （①直近仕入実績 → ② SKU 原価 → ③ 商品標準原価 のフォールバックは呼び出し側で解決して渡す）。
 */
export function calcPayoutAmount(
  record: { skuId: string; qty: number; amount: number },
  snapshot: AkebonoSettlementSnapshot,
  unitCostResolver: (skuId: string) => number,
): number {
  if (snapshot.payoutMethod === 'purchase_cost') {
    return roundBy(unitCostResolver(record.skuId) * record.qty, snapshot.rounding)
  }
  const rate = snapshot.payoutRate ?? 0
  return roundBy(record.amount * rate, snapshot.rounding)
}

/**
 * 当社が店舗へ請求する額（決定 #5 案 1 の三者精算）。
 * marginRate = 店舗が保有する取り分率。当社の店舗宛請求額 = 売上 × (1 − 店舗取り分率)。
 */
export function calcStoreMargin(salesAmount: number, snapshot: AkebonoSettlementSnapshot): number {
  const storeShare = snapshot.marginRate ?? 0
  return roundBy(salesAmount * (1 - storeShare), snapshot.rounding)
}

// ---------- 取引ロール ----------

/** 取引先の取引ロール（未設定の下位互換: 顧客 = ['customer'] / 自社 = []） */
export function partnerRolesOf(company: { kind: string; partnerRoles?: string[] | null }): string[] {
  if (company.partnerRoles && company.partnerRoles.length > 0) return company.partnerRoles
  return company.kind === 'customer' ? ['customer'] : []
}

export function hasPartnerRole(company: { kind: string; partnerRoles?: string[] | null }, role: string): boolean {
  return partnerRolesOf(company).includes(role)
}

// ---------- 採番 ----------

/** 接頭辞連番の次番号（決定 #14。伝票 code 用）。モックのみ使用（API は akebono_doc_seqs で原子的採番） */
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

// ---------- 状態機械（発注・生産。フロントのボタン活性と API の遷移検証を一致させる） ----------

export const PO_STATUS_NEXT: Record<string, string[]> = {
  draft: ['ordered', 'canceled'],
  ordered: ['partially_received', 'closed', 'canceled'],
  partially_received: ['closed', 'canceled'],
  closed: [],
  canceled: [],
}

export const PRODUCTION_STATUS_NEXT: Record<string, string[]> = {
  draft: ['instructed', 'canceled'],
  instructed: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
}

/** 月末日（YYYY-MM-DD。閏年考慮・Date 非依存） */
export function monthEndOf(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const isLeap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 31
  return `${month}-${String(days).padStart(2, '0')}`
}
