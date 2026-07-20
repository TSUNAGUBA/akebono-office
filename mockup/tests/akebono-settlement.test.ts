import { describe, expect, it } from 'vitest'
import type { InventoryTransaction, SettlementSnapshot } from '~/types/akebono'
import {
  balanceKey, calcPayoutAmount, calcStoreMargin, calcTax, foldBalances,
  nextCode, presetAppsFor, roundBy,
} from '~/utils/akebono'

/** 委託精算の三者精算（決定#5 + 第2巡設定化）の整合を守るテスト（資金計算のリグレッション防止） */
describe('委託精算の資金計算', () => {
  const snapshot = (over: Partial<SettlementSnapshot> = {}): SettlementSnapshot => ({
    payoutMethod: 'sales_rate', payoutRate: 0.60, marginRate: 0.30,
    taxRate: 0.10, taxIncluded: false, rounding: 'floor', ...over,
  })

  it('店舗宛請求 = 売上 × (1 − 店舗取り分率)（当社の受取額）', () => {
    // 銀座: 売上 14,400・店舗取り分 30% → 当社請求 70% = 10,080
    expect(calcStoreMargin(14400, snapshot({ marginRate: 0.30 }))).toBe(10080)
    // 横浜: 売上 12,000・店舗取り分 35% → 当社請求 65% = 7,800
    expect(calcStoreMargin(12000, snapshot({ marginRate: 0.35 }))).toBe(7800)
  })

  it('作家支払（売上連動）= 売上金額 × 作家率', () => {
    expect(calcPayoutAmount({ skuId: 's', qty: 3, amount: 14400 }, snapshot({ payoutRate: 0.60 }), () => 0)).toBe(8640)
  })

  it('作家支払（仕入単価×数量）= 単価解決 × 数量', () => {
    expect(calcPayoutAmount({ skuId: 's', qty: 3, amount: 14400 }, snapshot({ payoutMethod: 'purchase_cost' }), () => 2880)).toBe(8640)
  })

  it('三者精算が閉じる: 当社粗利 = 店舗請求 − 作家支払 ≥ 0（店舗率 + 作家率 ≤ 1）', () => {
    // 銀座: 店舗30% + 作家60% + 当社10%
    const s = snapshot({ marginRate: 0.30, payoutRate: 0.60 })
    const billed = calcStoreMargin(14400, s) // 10,080（当社受取）
    const payout = calcPayoutAmount({ skuId: 's', qty: 3, amount: 14400 }, s, () => 0) // 8,640（作家支払）
    const grossProfit = billed - payout
    expect(grossProfit).toBe(1440) // 売上の 10%
    expect(grossProfit).toBeGreaterThanOrEqual(0)
  })
})

describe('税計算（設定注入）', () => {
  it('外税: tax = floor(amount × rate)', () => {
    expect(calcTax(10080, 0.10, false, 'floor')).toBe(1008)
  })
  it('内税: tax = 税込額に含まれる税（二重計上しない前提の内訳）', () => {
    // 11,088 の内税10% = 11,088 − 11,088/1.1 = 1,008
    expect(calcTax(11088, 0.10, true, 'floor')).toBe(1008)
  })
  it('非課税は 0', () => {
    expect(calcTax(10000, 0, false, 'floor')).toBe(0)
  })
  it('端数処理', () => {
    expect(roundBy(1.9, 'floor')).toBe(1)
    expect(roundBy(1.1, 'ceil')).toBe(2)
    expect(roundBy(1.5, 'round')).toBe(2)
  })
})

describe('在庫残高の畳み込み（台帳 SoT からの導出）', () => {
  const tx = (skuId: string, warehouseId: string, qty: number): InventoryTransaction => ({
    id: `x-${skuId}-${warehouseId}-${qty}`, skuId, warehouseId, qty, kind: 'inbound',
    reason: null, refType: 't', refLineId: `r-${qty}`, occurredAt: '2026-07-01T00:00:00+09:00',
  })
  it('SKU × 倉庫ごとに Σqty', () => {
    const bal = foldBalances([tx('a', 'w1', 20), tx('a', 'w1', -8), tx('a', 'w2', 8), tx('b', 'w1', 10)])
    expect(bal.get(balanceKey('a', 'w1'))).toBe(12)
    expect(bal.get(balanceKey('a', 'w2'))).toBe(8)
    expect(bal.get(balanceKey('b', 'w1'))).toBe(10)
  })
})

describe('採番（派生 id・重複防止のリグレッション）', () => {
  it('nextCode は既存の最大連番 + 1 を返す（混在フォーマットも安全）', () => {
    expect(nextCode([], 'adj')).toBe('adj-0001')
    expect(nextCode(['adj-0001', 'adj-0003'], 'adj')).toBe('adj-0004')
    // 非対象・NaN 形式は無視される（'inv-01' 2桁 → 1 と解釈）
    expect(nextCode(['inv-01'], 'inv')).toBe('inv-0002')
    expect(nextCode(['sku-03-1'], 'sku')).toBe('sku-0001')
  })
})

describe('業種プリセット（和集合）', () => {
  it('小売 + 情報サービスの和集合', () => {
    const apps = presetAppsFor(['retail', 'it_service'])
    expect(apps).toContain('products')
    expect(apps).toContain('sales')
    expect(apps).toContain('billing')
    expect(apps).toContain('purchase-orders') // 小売
    expect(apps).toContain('production') // 情報サービス（工数）
    expect(apps).not.toContain('inbounds') // どちらのプリセットにもない
  })
})
