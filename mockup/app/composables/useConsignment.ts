/**
 * 請求管理 + 委託精算（F-29）
 * - 通常請求: 得意先 × 期間の未請求売上明細を締め → 請求ドラフト（洗い替え冪等）→ 発行（不変）→ 入金消込
 * - 委託精算（決定 #5 + 第 2 巡設定化）: 店舗売上 → 店舗へマージン請求（Invoice consignment_margin）
 *   + 作家へ支払通知（PaymentNotice）。金額は委託条件マスタの設定を注入した純関数で算定し、
 *   発行時点の設定一式をスナップショット（後の設定変更に影響されない）。
 * 確定系: issued/confirmed 以降は不変。訂正は赤伝（creditFor）。
 */
import type {
  ConsignmentTerm, Invoice, PaymentNotice, PaymentReceipt, SalesRecord, SettlementSnapshot,
} from '~/types/akebono'
import type { Company, Result } from '~/types/domain'
import {
  buildSettlementSnapshot, calcPayoutAmount, calcStoreMargin, calcTax, nextCode,
} from '~/utils/akebono'

export function useConsignment() {
  const { tbl, commit, nextId } = useMockDb()
  const invoices = tbl('invoices')
  const notices = tbl('paymentNotices')
  const receipts = tbl('paymentReceipts')
  const sales = tbl('salesRecords')
  const consignmentTerms = tbl('consignmentTerms')
  const purchaseRecords = tbl('purchaseRecords')
  const companies = tbl('companies')
  const taxRates = tbl('taxRates')
  const products = useProducts()

  function companyName(id: string): string {
    return (companies.value as Company[]).find(c => c.id === id)?.name ?? id
  }

  // ---------- 委託条件の解決 ----------
  function termOf(companyId: string, segmentId: string, role: ConsignmentTerm['role']): ConsignmentTerm | undefined {
    return consignmentTerms.value.filter(t => t.active !== false && t.companyId === companyId && t.segmentId === segmentId && t.role === role)
      .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]
  }
  function taxRateValue(id: string | null | undefined): number {
    return taxRates.value.find(t => t.id === id)?.rate ?? 0
  }

  /** purchase_cost 方式の単価解決（①直近仕入実績 → ② SKU 原価 → ③ 商品標準原価） */
  function resolveUnitCost(skuId: string): number {
    // ① 直近仕入実績（該当 SKU の costPrice。日付順で最新）
    let latest: { date: string; cost: number } | null = null
    for (const pr of purchaseRecords.value) {
      for (const l of pr.lines) {
        if (l.skuId === skuId && (!latest || pr.purchaseDate > latest.date)) latest = { date: pr.purchaseDate, cost: l.costPrice }
      }
    }
    if (latest) return latest.cost
    // ② SKU 原価 → ③ 商品標準原価
    const sku = products.skuById(skuId)
    return sku ? products.costOf(sku) : 0
  }

  // ---------- 通常請求（F-29-1/2/3） ----------

  /** 未請求の対象売上明細（得意先 × 期間） */
  function billableSales(companyId: string, periodFrom: string, periodTo: string): SalesRecord[] {
    return sales.value.filter(r => r.active !== false && !r.invoiceId && r.companyId === companyId
      && r.salesDate >= periodFrom && r.salesDate <= periodTo)
  }

  /** 締め（ドラフト生成・洗い替え冪等）。同一得意先×期間の未発行ドラフトは置換 */
  function closeBilling(input: { companyId: string; periodFrom: string; periodTo: string }): Result & { count?: number } {
    const rows = billableSales(input.companyId, input.periodFrom, input.periodTo)
    if (rows.length === 0) return { ok: false, error: { code: 'AKO-BIL-001', message: '対象の未請求売上がありません' } }
    // 既存の未発行ドラフト（同一得意先×期間）を洗い替え
    const filtered = invoices.value.filter(v => !(v.status === 'draft' && v.invoiceType === 'sales'
      && v.companyId === input.companyId && v.periodFrom === input.periodFrom && v.periodTo === input.periodTo))
    const subtotal = rows.reduce((s, r) => s + r.amount, 0)
    // 税は代表税率で概算（明細ごとの税は本実装で対応）
    const rate = taxRateValue(products.productById(products.skuById(rows[0]!.skuId)?.productId ?? '')?.taxRateId)
    const tax = calcTax(subtotal, rate, false, 'floor')
    const id = nextId('invoices', 'inv')
    const lines = rows.map(r => ({
      id: nextId('invoices', 'invl') + '-' + r.id,
      description: `${r.salesDate} ${products.skuById(r.skuId) ? products.skuLabel(products.skuById(r.skuId)!) : r.skuId}（${r.qty}）`,
      amount: r.amount,
    }))
    if (tax > 0) lines.push({ id: nextId('invoices', 'invl') + '-tax', description: `消費税（${(rate * 100).toFixed(0)}%）`, amount: tax })
    const draft: Invoice = {
      id, code: nextCode(invoices.value.map(v => v.code), 'INV'),
      companyId: input.companyId, segmentId: null, periodFrom: input.periodFrom, periodTo: input.periodTo,
      invoiceType: 'sales', status: 'draft', issuedAt: null, totalAmount: subtotal + tax, creditFor: null,
      lines, snapshot: null, sourceRecordIds: rows.map(r => r.id),
    }
    invoices.value = [...filtered, draft]
    commit()
    return { ok: true, id, count: rows.length }
  }

  /** 請求発行（draft → issued。以後不変。対象売上に invoiceId を張る） */
  function issue(invoiceId: string): Result {
    const inv = invoices.value.find(v => v.id === invoiceId)
    if (!inv) return { ok: false, error: { code: 'AKO-GEN-002', message: '請求が見つかりません' } }
    if (inv.status !== 'draft') return { ok: false, error: { code: 'AKO-BIL-002', message: '下書き以外は発行できません' } }
    invoices.value = invoices.value.map(v => v.id === invoiceId ? { ...v, status: 'issued', issuedAt: nowJstIso() } : v)
    sales.value = sales.value.map(r => inv.sourceRecordIds.includes(r.id) ? { ...r, invoiceId } : r)
    commit()
    return { ok: true, id: invoiceId }
  }

  /** 赤伝発行（issued → void + マイナス請求を新規作成。訂正は赤伝） */
  function voidInvoice(invoiceId: string): Result {
    const inv = invoices.value.find(v => v.id === invoiceId)
    if (!inv) return { ok: false, error: { code: 'AKO-GEN-002', message: '請求が見つかりません' } }
    if (inv.status !== 'issued') return { ok: false, error: { code: 'AKO-BIL-003', message: '発行済みのみ赤伝を発行できます' } }
    // 委託マージン請求は作家支払通知と対で発行されるため、単独の赤伝は不可（再締めで作家二重払いになる）。
    // 委託精算のやり直しは対象月の再締め（未実装の取消フローは v2）。ここでは通常請求のみ赤伝可とする
    if (inv.invoiceType !== 'sales') {
      return { ok: false, error: { code: 'AKO-BIL-008', message: '委託マージン請求は単独で赤伝できません（委託精算のやり直しで対応）' } }
    }
    const creditId = nextId('invoices', 'inv')
    const credit: Invoice = {
      ...inv, id: creditId, code: nextCode(invoices.value.map(v => v.code), 'INV'),
      status: 'issued', issuedAt: nowJstIso(), totalAmount: -inv.totalAmount, creditFor: inv.id,
      lines: inv.lines.map(l => ({ ...l, id: l.id + '-c', amount: -l.amount })), sourceRecordIds: [],
    }
    invoices.value = [
      ...invoices.value.map(v => v.id === invoiceId ? { ...v, status: 'void' as const } : v),
      credit,
    ]
    // 対象売上の請求リンクを解除（再請求可能に）
    sales.value = sales.value.map(r => inv.sourceRecordIds.includes(r.id) ? { ...r, invoiceId: null } : r)
    commit()
    return { ok: true, id: creditId }
  }

  // ---------- 入金消込（F-29-3） ----------
  function paidAmountOf(invoiceId: string): number {
    return receipts.value.filter(r => r.invoiceId === invoiceId).reduce((s, r) => s + r.amount, 0)
  }
  function recordReceipt(input: { invoiceId: string; amount: number; method: string }): Result {
    const inv = invoices.value.find(v => v.id === input.invoiceId)
    if (!inv) return { ok: false, error: { code: 'AKO-GEN-002', message: '請求が見つかりません' } }
    if (inv.status === 'draft') return { ok: false, error: { code: 'AKO-BIL-004', message: '未発行の請求には入金できません' } }
    if (!Number.isFinite(input.amount) || input.amount <= 0) return { ok: false, error: { code: 'AKO-BIL-005', message: '入金額を正しく入力してください' } }
    const receipt: PaymentReceipt = { id: nextId('paymentReceipts', 'rcpt'), invoiceId: input.invoiceId, receivedAt: nowJstIso(), amount: Math.round(input.amount), method: input.method }
    receipts.value = [...receipts.value, receipt]
    // 全額消込で paid
    const paid = paidAmountOf(input.invoiceId)
    if (paid >= inv.totalAmount) {
      invoices.value = invoices.value.map(v => v.id === input.invoiceId ? { ...v, status: 'paid' } : v)
    }
    commit()
    return { ok: true, id: receipt.id }
  }

  // ---------- 委託精算（F-29-4。決定 #5 + 第 2 巡設定化） ----------

  /** 対象 = 委託セグメント × 月 の未精算 店舗売上（店舗ロールの得意先） */
  function consignableSales(segmentId: string, month: string): SalesRecord[] {
    const stores = new Set((companies.value as Company[]).filter(c => (c.partnerRoles ?? []).includes('store')).map(c => c.id))
    return sales.value.filter(r => r.active !== false && !r.invoiceId && r.segmentId === segmentId
      && r.salesDate.slice(0, 7) === month && stores.has(r.companyId) && r.qty > 0)
  }

  /**
   * 委託精算の締め（冪等）。店舗ごとにマージン請求（Invoice）、作家ごとに支払通知（PaymentNotice）を発行。
   * 発行時点の設定をスナップショット。対象売上に invoiceId を張り再精算を防ぐ。
   */
  function closeConsignment(input: { segmentId: string; month: string }): Result & { invoices?: number; notices?: number } {
    const rows = consignableSales(input.segmentId, input.month)
    if (rows.length === 0) return { ok: false, error: { code: 'AKO-BIL-006', message: '対象の未精算 店舗売上がありません' } }
    const periodFrom = `${input.month}-01`
    const periodTo = `${input.month}-31`
    const newInvoices: Invoice[] = []
    const newNotices: PaymentNotice[] = []
    // id は蓄積配列を含めて採番する（ループ内で db へ書き戻さないため nextId 単独では重複する）
    const nextInvoiceId = (): string => nextCode([...invoices.value, ...newInvoices].map(v => v.id), 'inv')
    const nextNoticeId = (): string => nextCode([...notices.value, ...newNotices].map(n => n.id), 'pn')
    // 売上明細 → その店舗のマージン請求 id（provenance を正確に保つ）
    const settleByRecord = new Map<string, string>()

    // --- 店舗別マージン請求 ---
    const byStore = new Map<string, SalesRecord[]>()
    for (const r of rows) byStore.set(r.companyId, [...(byStore.get(r.companyId) ?? []), r])
    for (const [storeId, storeRows] of byStore) {
      const storeTerm = termOf(storeId, input.segmentId, 'store')
      const rate = taxRateValue(storeTerm?.taxRateId)
      const snapshot = buildSettlementSnapshot(storeTerm, undefined, rate)
      const salesTotal = storeRows.reduce((s, r) => s + r.amount, 0)
      // 当社が店舗へ請求する額（店舗取り分控除後の送金額 = 売上 × (1 − 店舗取り分率)）
      const billed = calcStoreMargin(salesTotal, snapshot)
      const tax = calcTax(billed, rate, snapshot.taxIncluded, snapshot.rounding)
      // 内税は billed に税込・外税は billed + tax（内税で二重計上しない）
      const total = snapshot.taxIncluded ? billed : billed + tax
      const id = nextInvoiceId()
      const storeShare = Math.round(salesTotal * (snapshot.marginRate ?? 0))
      newInvoices.push({
        id, code: nextCode([...invoices.value, ...newInvoices].map(v => v.code), 'INV'),
        companyId: storeId, segmentId: input.segmentId, periodFrom, periodTo, invoiceType: 'consignment_margin',
        status: 'issued', issuedAt: nowJstIso(), totalAmount: total, creditFor: null,
        lines: [
          { id: `${id}-l1`, description: `委託売上 ${salesTotal.toLocaleString()} 円 − 店舗取り分 ${((snapshot.marginRate ?? 0) * 100).toFixed(0)}%（${storeShare.toLocaleString()} 円）= 当社請求`, amount: billed },
          ...(tax > 0 ? [{ id: `${id}-l2`, description: `消費税（${(rate * 100).toFixed(0)}%${snapshot.taxIncluded ? '・内税' : ''}）`, amount: tax }] : []),
        ],
        snapshot, sourceRecordIds: storeRows.map(r => r.id),
      })
      for (const r of storeRows) settleByRecord.set(r.id, id)
    }

    // --- 作家別支払通知 ---
    const byArtist = new Map<string, SalesRecord[]>()
    for (const r of rows) {
      const product = products.productById(products.skuById(r.skuId)?.productId ?? '')
      const artistId = product?.defaultSupplierCompanyId
      if (!artistId) continue
      byArtist.set(artistId, [...(byArtist.get(artistId) ?? []), r])
    }
    for (const [artistId, artistRows] of byArtist) {
      const artistTerm = termOf(artistId, input.segmentId, 'consignor_artist')
      const rate = taxRateValue(artistTerm?.taxRateId)
      const snapshot = buildSettlementSnapshot(undefined, artistTerm, rate)
      const id = nextNoticeId()
      const lines = artistRows.map((r, idx) => ({
        id: `${id}-${idx}`,
        salesRecordId: r.id,
        description: `${r.salesDate} ${products.skuById(r.skuId) ? products.skuLabel(products.skuById(r.skuId)!) : r.skuId}（${r.qty}）`,
        amount: calcPayoutAmount(r, snapshot, resolveUnitCost),
      }))
      const payable = lines.reduce((s, l) => s + l.amount, 0)
      newNotices.push({
        id, code: nextCode([...notices.value, ...newNotices].map(n => n.code), 'PN'),
        companyId: artistId, segmentId: input.segmentId, periodFrom, periodTo, status: 'draft',
        payableAmount: payable, lines, snapshot,
      })
    }

    invoices.value = [...invoices.value, ...newInvoices]
    notices.value = [...notices.value, ...newNotices]
    // 対象売上に精算リンク（各売上をその店舗のマージン請求 id へ。再精算防止 = 冪等）
    sales.value = sales.value.map(r => settleByRecord.has(r.id) ? { ...r, invoiceId: settleByRecord.get(r.id)! } : r)
    commit()
    return { ok: true, invoices: newInvoices.length, notices: newNotices.length }
  }

  /** 支払通知の確定（draft → confirmed。以後不変） */
  function confirmNotice(id: string): Result {
    const n = notices.value.find(x => x.id === id)
    if (!n) return { ok: false, error: { code: 'AKO-GEN-002', message: '支払通知が見つかりません' } }
    if (n.status !== 'draft') return { ok: false, error: { code: 'AKO-BIL-007', message: '下書き以外は確定できません' } }
    notices.value = notices.value.map(x => x.id === id ? { ...x, status: 'confirmed' } : x)
    commit()
    return { ok: true, id }
  }

  return {
    invoices, notices, receipts,
    companyName, termOf, resolveUnitCost, billableSales, consignableSales, paidAmountOf,
    closeBilling, issue, voidInvoice, recordReceipt, closeConsignment, confirmNotice,
  }
}
