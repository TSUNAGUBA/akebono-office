/**
 * 商品マスタ管理（F-21）
 * 商品（親）+ SKU（バリアント 2 軸）+ 画像（セクション別）。
 * SKU 展開なし商品は既定 SKU 1 件を透過生成（XA-1）。
 * 全トランザクションは SKU 単位で本商品から派生する。
 */
import type { Product, ProductImage, ProductSku } from '~/types/akebono'
import type { Company } from '~/types/domain'
import type { Result } from '~/types/domain'

export function useProducts() {
  const { tbl, commit, nextId } = useMockDb()
  const products = tbl('products')
  const skus = tbl('productSkus')
  const images = tbl('productImages')
  const sections = tbl('productImageSections')
  const companies = tbl('companies')

  const activeProducts = computed(() => products.value.filter(p => p.active !== false))

  function productById(id: string): Product | undefined {
    return products.value.find(p => p.id === id)
  }
  function skuById(id: string): ProductSku | undefined {
    return skus.value.find(s => s.id === id)
  }
  function productOfSku(skuId: string): Product | undefined {
    const sku = skuById(skuId)
    return sku ? productById(sku.productId) : undefined
  }
  function skusOf(productId: string): ProductSku[] {
    return skus.value.filter(s => s.productId === productId && s.active !== false)
  }
  function activeSkus(): ProductSku[] {
    return skus.value.filter(s => s.active !== false)
  }
  function imagesOf(productId: string): ProductImage[] {
    return images.value.filter(i => i.productId === productId && i.active !== false)
      .slice().sort((a, b) => a.displayOrder - b.displayOrder)
  }

  /** SKU の表示ラベル（軸値。既定 SKU は商品名相当） */
  function skuLabel(sku: ProductSku): string {
    if (sku.isDefault) return productById(sku.productId)?.name ?? sku.code
    const parts = [sku.axis1Value, sku.axis2Value].filter(Boolean)
    return parts.length > 0 ? parts.join(' / ') : sku.code
  }
  /** SKU の売価（未設定は商品の listPrice） */
  function sellPriceOf(sku: ProductSku): number {
    return sku.sellPrice ?? productById(sku.productId)?.listPrice ?? 0
  }
  /** SKU の原価（未設定は商品の standardCost） */
  function costOf(sku: ProductSku): number {
    return sku.costPrice ?? productById(sku.productId)?.standardCost ?? 0
  }

  /** サムネイル画像（サムネイル優先セクション → 無ければ他セクション先頭） */
  function thumbnailOf(productId: string): ProductImage | null {
    const imgs = imagesOf(productId)
    if (imgs.length === 0) return null
    const prioritySectionIds = sections.value.filter(s => s.isThumbnailPriority && s.active !== false).map(s => s.id)
    const priority = imgs.filter(i => prioritySectionIds.includes(i.sectionId))
    return (priority[0] ?? imgs[0]) ?? null
  }

  function supplierName(product: Product): string {
    return (companies.value as Company[]).find(c => c.id === product.defaultSupplierCompanyId)?.name ?? '—'
  }

  // ---------- 商品 CRUD ----------
  function saveProduct(input: Partial<Product> & { id?: string }): Result {
    const code = String(input.code ?? '').trim()
    if (!code) return { ok: false, error: { code: 'AKO-PRD-001', message: '商品コードは必須です' } }
    if (!String(input.name ?? '').trim()) return { ok: false, error: { code: 'AKO-PRD-001', message: '商品名は必須です' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-PRD-001', message: '事業セグメントは必須です' } }
    // コード一意（同一セグメント内・有効行。論理削除は除外 = 再利用可）
    const dup = products.value.find(p =>
      p.id !== input.id && p.active !== false && p.segmentId === input.segmentId && p.code === code)
    if (dup) return { ok: false, error: { code: 'AKO-PRD-002', message: `商品コード ${code} は既に使われています` } }

    if (input.id) {
      const idx = products.value.findIndex(p => p.id === input.id)
      if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
      products.value = products.value.map(p => p.id === input.id ? { ...p, ...input, code } as Product : p)
      commit()
      return { ok: true, id: input.id }
    }
    const id = nextId('products', 'prd')
    const created: Product = {
      id, code, name: String(input.name), segmentId: String(input.segmentId),
      categoryId: input.categoryId ?? null, defaultSupplierCompanyId: input.defaultSupplierCompanyId ?? null,
      listPrice: Number(input.listPrice ?? 0), standardCost: Number(input.standardCost ?? 0),
      taxRateId: input.taxRateId ?? null, unitId: input.unitId ?? null, billingType: input.billingType ?? null,
      variantAxis1Label: input.variantAxis1Label ?? null, variantAxis2Label: input.variantAxis2Label ?? null,
      description: String(input.description ?? ''), active: true, custom: input.custom ?? {},
    }
    products.value = [...products.value, created]
    // 既定 SKU を自動生成（展開なし = UI では非表示扱い。XA-1）
    ensureDefaultSku(id, code)
    commit()
    return { ok: true, id }
  }

  function archiveProduct(id: string): Result {
    products.value = products.value.map(p => p.id === id ? { ...p, active: false } : p)
    commit()
    return { ok: true, id }
  }
  function restoreProduct(id: string): Result {
    products.value = products.value.map(p => p.id === id ? { ...p, active: true } : p)
    commit()
    return { ok: true, id }
  }

  // ---------- SKU ----------
  /** 既定 SKU が無ければ生成（展開なし商品向け） */
  function ensureDefaultSku(productId: string, productCode: string): void {
    if (skus.value.some(s => s.productId === productId && s.isDefault)) return
    const id = nextId('productSkus', 'sku')
    const created: ProductSku = {
      id, productId, code: productCode, janCode: null, axis1Value: null, axis2Value: null,
      sellPrice: null, costPrice: null, isDefault: true, active: true,
    }
    skus.value = [...skus.value, created]
  }

  /** SKU マトリクス保存（軸1値 × 軸2値 の全組合せを upsert。既存はコードで突合） */
  function saveMatrix(productId: string, axis1Values: string[], axis2Values: string[]): Result {
    const product = productById(productId)
    if (!product) return { ok: false, error: { code: 'AKO-GEN-002', message: '商品が見つかりません' } }
    const a1 = axis1Values.map(v => v.trim()).filter(Boolean)
    const a2 = axis2Values.length > 0 ? axis2Values.map(v => v.trim()).filter(Boolean) : ['']
    if (a1.length === 0) return { ok: false, error: { code: 'AKO-PRD-003', message: '軸1の値を 1 つ以上入力してください' } }

    const existing = skus.value.filter(s => s.productId === productId)
    const next = [...skus.value]
    let created = 0
    // ループ内で書き戻さないため nextId は同一 id を反復する。基準連番を 1 度取り、ローカルで進める
    let seq = Number(nextId('productSkus', 'sku').slice(4))
    for (const v1 of a1) {
      for (const v2 of a2) {
        const axis2 = v2 === '' ? null : v2
        const already = existing.find(s => s.axis1Value === v1 && s.axis2Value === axis2)
        if (already) continue
        const suffix = [v1, v2].filter(Boolean).join('-')
        const id = `sku-${String(seq).padStart(4, '0')}`
        seq++
        next.push({
          id, productId, code: `${product.code}-${suffix}`, janCode: null,
          axis1Value: v1, axis2Value: axis2, sellPrice: null, costPrice: null, isDefault: false, active: true,
        })
        created++
      }
    }
    // マトリクス化したら既定 SKU は無効化（展開ありへ移行）
    skus.value = next.map(s => (s.productId === productId && s.isDefault && created > 0) ? { ...s, active: false } : s)
    commit()
    return { ok: true, id: `${created}` }
  }

  function saveSku(input: Partial<ProductSku> & { id: string }): Result {
    const idx = skus.value.findIndex(s => s.id === input.id)
    if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: 'SKU が見つかりません' } }
    skus.value = skus.value.map(s => s.id === input.id ? { ...s, ...input } as ProductSku : s)
    commit()
    return { ok: true, id: input.id }
  }

  // ---------- 画像（F-21-3。セクション別・追加/並び替え/アーカイブ） ----------
  const activeSections = computed(() => sections.value.filter(s => s.active !== false).slice().sort((a, b) => a.displayOrder - b.displayOrder))

  function addImage(productId: string, input: { sectionId: string; skuId?: string | null; filename: string; mime: string; dataUrl?: string | null }): Result {
    const id = nextId('productImages', 'pimg')
    const order = imagesOf(productId).filter(i => i.sectionId === input.sectionId).length + 1
    const created: ProductImage = {
      id, productId, skuId: input.skuId ?? null, sectionId: input.sectionId, displayOrder: order,
      filename: input.filename, mime: input.mime, dataUrl: input.dataUrl ?? null, active: true,
    }
    images.value = [...images.value, created]
    commit()
    return { ok: true, id }
  }
  function archiveImage(id: string): Result {
    images.value = images.value.map(i => i.id === id ? { ...i, active: false } : i)
    commit()
    return { ok: true, id }
  }
  function restoreImage(id: string): Result {
    images.value = images.value.map(i => i.id === id ? { ...i, active: true } : i)
    commit()
    return { ok: true, id }
  }
  function setImageSection(id: string, sectionId: string): Result {
    images.value = images.value.map(i => i.id === id ? { ...i, sectionId } : i)
    commit()
    return { ok: true, id }
  }

  return {
    products, activeProducts, skus, images,
    productById, skuById, productOfSku, skusOf, activeSkus, imagesOf, activeSections,
    skuLabel, sellPriceOf, costOf, thumbnailOf, supplierName,
    saveProduct, archiveProduct, restoreProduct, ensureDefaultSku, saveMatrix, saveSku,
    addImage, archiveImage, restoreImage, setImageSection,
  }
}
