/**
 * 商品マスタ管理（F-21）
 * 商品（親）+ SKU（バリアント 2 軸）+ 画像（セクション別）。
 * SKU 展開なし商品は既定 SKU 1 件を透過生成（XA-1）。
 * 全トランザクションは SKU 単位で本商品から派生する。
 *
 * デュアルモード（Phase C = 0032）: API モードの SoT はサーバー（products / product_skus /
 * product_images）。書込は /v1/akebono/products 系エンドポイント → 影響コレクションを再ロード
 * （SoT 書込 → キャッシュ反映 = 原則6）。読み取り・導出（skuLabel・thumbnailOf 等）は両モード共通。
 * モックモードの挙動は不変（同期実装を Promise で包むだけ）。
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
  const isApi = useApiMode()

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
  /**
   * 一覧・選択肢の SKU 識別（商品名 ＋ SKU 詳細）。バリアント SKU は skuLabel が軸値のみで
   * 「どの商品か」が分からないため、商品名を主・SKU 詳細（軸値・コード）を従に分けて返す
   * （在庫一覧の商品識別性を改善。オペレーター報告 2026-08-10）。
   */
  function skuIdentity(sku: ProductSku): { productName: string; detail: string } {
    const productName = productById(sku.productId)?.name ?? sku.code
    const axis = [sku.axis1Value, sku.axis2Value].filter(Boolean).join(' / ')
    // 既定 SKU は商品そのもの = コードのみ。バリアントは軸値＋コード
    const detail = sku.isDefault ? sku.code : (axis ? `${axis}・${sku.code}` : sku.code)
    return { productName, detail }
  }
  /** SKU の完全ラベル「商品名（詳細）」。ドロップダウン表示・検索一致に使う（商品名で識別できる） */
  function skuFullLabel(sku: ProductSku): string {
    const { productName, detail } = skuIdentity(sku)
    return `${productName}（${detail}）`
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
  async function saveProduct(input: Partial<Product> & { id?: string }): Promise<Result> {
    const code = String(input.code ?? '').trim()
    if (!code) return { ok: false, error: { code: 'AKO-PRD-001', message: '商品コードは必須です' } }
    if (!String(input.name ?? '').trim()) return { ok: false, error: { code: 'AKO-PRD-001', message: '商品名は必須です' } }
    if (!input.segmentId) return { ok: false, error: { code: 'AKO-PRD-001', message: '事業セグメントは必須です' } }
    if (isApi) {
      // 作成 = 既定 SKU も生成されるため両コレクションを再取得。更新 = 部分 PATCH（送ったキーのみ）
      const res = input.id
        ? await apiWrite<Product>(`/v1/akebono/products/${input.id}`, { method: 'PATCH', body: { ...input, id: undefined }, reload: ['products'] })
        : await apiWrite<Product>('/v1/akebono/products', { body: input, reload: ['products', 'productSkus'] })
      return res.ok ? { ok: true, id: res.data.id } : res
    }
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

  async function archiveProduct(id: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/products/${id}/archive`, { reload: ['products'] })
    products.value = products.value.map(p => p.id === id ? { ...p, active: false } : p)
    commit()
    return { ok: true, id }
  }
  async function restoreProduct(id: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/products/${id}/restore`, { reload: ['products'] })
    products.value = products.value.map(p => p.id === id ? { ...p, active: true } : p)
    commit()
    return { ok: true, id }
  }

  // ---------- SKU ----------
  /** 既定 SKU が無ければ生成（展開なし商品向け。モックモード専用 = API は商品作成時にサーバーが生成） */
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
  async function saveMatrix(productId: string, axis1Values: string[], axis2Values: string[]): Promise<Result> {
    const a1 = axis1Values.map(v => v.trim()).filter(Boolean)
    const a2 = axis2Values.length > 0 ? axis2Values.map(v => v.trim()).filter(Boolean) : ['']
    if (a1.length === 0) return { ok: false, error: { code: 'AKO-PRD-003', message: '軸1の値を 1 つ以上入力してください' } }
    if (isApi) {
      const res = await apiWrite<{ created: number }>(`/v1/akebono/products/${productId}/skus/matrix`, {
        body: { axis1Values: a1, axis2Values: axis2Values }, reload: ['productSkus'],
      })
      return res.ok ? { ok: true, id: `${res.data.created}` } : res
    }
    const product = productById(productId)
    if (!product) return { ok: false, error: { code: 'AKO-GEN-002', message: '商品が見つかりません' } }

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

  async function saveSku(input: Partial<ProductSku> & { id: string }): Promise<Result> {
    if (isApi) {
      return apiWrite(`/v1/akebono/product-skus/${input.id}`, {
        method: 'PATCH', body: { ...input, id: undefined }, reload: ['productSkus'],
      })
    }
    const idx = skus.value.findIndex(s => s.id === input.id)
    if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: 'SKU が見つかりません' } }
    skus.value = skus.value.map(s => s.id === input.id ? { ...s, ...input } as ProductSku : s)
    commit()
    return { ok: true, id: input.id }
  }

  // ---------- 画像（F-21-3。セクション別・追加/並び替え/アーカイブ） ----------
  const activeSections = computed(() => sections.value.filter(s => s.active !== false).slice().sort((a, b) => a.displayOrder - b.displayOrder))

  async function addImage(productId: string, input: { sectionId: string; skuId?: string | null; filename: string; mime: string; dataUrl?: string | null }): Promise<Result & { persisted?: boolean }> {
    if (isApi) {
      const res = await apiWrite<ProductImage>(`/v1/akebono/products/${productId}/images`, {
        body: input, reload: ['productImages'],
      })
      // API はサーバー保管のため localStorage 容量問題なし（persisted は常に true）
      return res.ok ? { ok: true, id: res.data.id, persisted: true } : res
    }
    const id = nextId('productImages', 'pimg')
    const order = imagesOf(productId).filter(i => i.sectionId === input.sectionId).length + 1
    const created: ProductImage = {
      id, productId, skuId: input.skuId ?? null, sectionId: input.sectionId, displayOrder: order,
      filename: input.filename, mime: input.mime, dataUrl: input.dataUrl ?? null, active: true,
    }
    images.value = [...images.value, created]
    // 画像は data URI で嵩むため、容量超過で永続化に失敗しうる。成功可否を呼び出し側へ返す
    const persisted = commit()
    return { ok: true, id, persisted }
  }
  async function archiveImage(id: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/product-images/${id}/archive`, { reload: ['productImages'] })
    images.value = images.value.map(i => i.id === id ? { ...i, active: false } : i)
    commit()
    return { ok: true, id }
  }
  async function restoreImage(id: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/product-images/${id}/restore`, { reload: ['productImages'] })
    images.value = images.value.map(i => i.id === id ? { ...i, active: true } : i)
    commit()
    return { ok: true, id }
  }
  async function setImageSection(id: string, sectionId: string): Promise<Result> {
    if (isApi) return apiWrite(`/v1/akebono/product-images/${id}`, { method: 'PATCH', body: { sectionId }, reload: ['productImages'] })
    images.value = images.value.map(i => i.id === id ? { ...i, sectionId } : i)
    commit()
    return { ok: true, id }
  }

  return {
    products, activeProducts, skus, images,
    productById, skuById, productOfSku, skusOf, activeSkus, imagesOf, activeSections,
    skuLabel, skuIdentity, skuFullLabel, sellPriceOf, costOf, thumbnailOf, supplierName,
    saveProduct, archiveProduct, restoreProduct, ensureDefaultSku, saveMatrix, saveSku,
    addImage, archiveImage, restoreImage, setImageSection,
  }
}
