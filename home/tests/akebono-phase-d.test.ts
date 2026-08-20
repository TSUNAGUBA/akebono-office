/**
 * Phase D のモック新規ロジックの単体テスト（監査-3）。
 * 委託精算取消のガード（cancelConsignment の下流確定状態判断）と、出荷→売上の明細組み立て
 * （useOutbound postSales の売上生成 + SR コード累積採番）を、両モード共有の純関数として検証する。
 */
import { describe, expect, it } from 'vitest'
import { buildShipmentSaleLines, consignmentCancelBlockReason } from '~/utils/akebono'

describe('consignmentCancelBlockReason（委託精算取消の下流確定状態ガード = MAJOR-1）', () => {
  it('入金なし・通知は下書きのみ → null（取消可能）', () => {
    expect(consignmentCancelBlockReason(
      [{ paid: 0 }, { paid: 0 }],
      [{ status: 'draft' }],
    )).toBeNull()
    expect(consignmentCancelBlockReason([], [])).toBeNull()
  })

  it('有効入金のあるマージン請求（部分入金含む）があれば paid', () => {
    expect(consignmentCancelBlockReason([{ paid: 0 }, { paid: 1 }], [{ status: 'draft' }])).toBe('paid')
    expect(consignmentCancelBlockReason([{ paid: 5000 }], [])).toBe('paid')
  })

  it('確定済み/支払済みの支払通知があれば confirmed', () => {
    expect(consignmentCancelBlockReason([{ paid: 0 }], [{ status: 'confirmed' }])).toBe('confirmed')
    expect(consignmentCancelBlockReason([{ paid: 0 }], [{ status: 'paid' }])).toBe('confirmed')
  })

  it('入金と確定が両方あるときは paid を優先（入金取消の導線を先に案内）', () => {
    expect(consignmentCancelBlockReason([{ paid: 100 }], [{ status: 'confirmed' }])).toBe('paid')
  })
})

describe('buildShipmentSaleLines（出荷実績 → 売上明細の組み立て + SR コード累積採番）', () => {
  const resolve = (skuId: string) => ({
    unitPrice: skuId === 'sku-a' ? 1500 : 800,
    costPrice: skuId === 'sku-a' ? 600 : 300,
    billingType: 'one_time' as string | null,
    supplierCompanyId: skuId === 'sku-a' ? 'c-art-a' : null,
  })

  it('明細ごとに amount = round(qty × unitPrice)・sourceRef = obr:<明細行id>・属性（供給元含む）を注入', () => {
    const out = buildShipmentSaleLines(
      [{ id: 'obr-1-0', skuId: 'sku-a', qty: 3 }],
      resolve, [],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      skuId: 'sku-a', qty: 3, unitPrice: 1500, amount: 4500, costPrice: 600,
      billingType: 'one_time', supplierCompanyId: 'c-art-a', sourceRef: 'obr:obr-1-0',
    })
  })

  it('供給元未設定（null）の SKU はスナップショットも null（分析はライブ解決へフォールバック）', () => {
    const out = buildShipmentSaleLines(
      [{ id: 'obr-2-0', skuId: 'sku-b', qty: 1 }],
      resolve, [],
    )
    expect(out[0]!.supplierCompanyId).toBeNull()
  })

  it('同一出荷の複数行で SR コードが重複しない（累積採番。空既存 → SR-0001, SR-0002）', () => {
    const out = buildShipmentSaleLines(
      [{ id: 'obr-1-0', skuId: 'sku-a', qty: 1 }, { id: 'obr-1-1', skuId: 'sku-b', qty: 2 }],
      resolve, [],
    )
    expect(out.map(s => s.code)).toEqual(['SR-0001', 'SR-0002'])
    expect(out[1]).toMatchObject({ skuId: 'sku-b', unitPrice: 800, amount: 1600, sourceRef: 'obr:obr-1-1' })
  })

  it('既存コードの続きから採番する（SR-0005 があれば SR-0006, SR-0007）', () => {
    const out = buildShipmentSaleLines(
      [{ id: 'x-0', skuId: 'sku-b', qty: 1 }, { id: 'x-1', skuId: 'sku-b', qty: 1 }],
      resolve, ['SR-0005', 'SR-0003'],
    )
    expect(out.map(s => s.code)).toEqual(['SR-0006', 'SR-0007'])
  })
})
