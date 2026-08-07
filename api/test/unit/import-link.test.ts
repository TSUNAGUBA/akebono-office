import { describe, expect, it } from 'vitest'
import {
  IMPORT_REF_TARGETS, VARIANT_IMPORT_FIELDS,
  importRefTargetOf, isValidLookupField, lookupKeyLabel, validateImportMapping, variantAxisLabelsOf,
} from '../../../shared/domain/import-link'

const f = (targetItemKey: string, sourceField = 'col', lookupField: string | null = null) =>
  ({ sourceField, targetItemKey, lookupField })

describe('importRefTargetOf（取込対象 × 対象項目 → 参照先マスタ）', () => {
  it('参照項目はカタログを返し、非参照項目・未知の対象は null', () => {
    expect(importRefTargetOf('sales_record', 'companyId')?.refEntity).toBe('company')
    expect(importRefTargetOf('sales_record', 'skuId')?.refEntity).toBe('sku')
    expect(importRefTargetOf('product', 'segmentId')?.refEntity).toBe('segment')
    expect(importRefTargetOf('product_variant', 'categoryId')?.refEntity).toBe('category')
    expect(importRefTargetOf('sales_record', 'qty')).toBeNull()
    expect(importRefTargetOf('unknown_entity', 'companyId')).toBeNull()
  })
  it('カタログの参照項目は全取込対象で定義されている（product/product_variant/company/sales_record/inventory）', () => {
    expect(Object.keys(IMPORT_REF_TARGETS).sort())
      .toEqual(['company', 'inventory', 'product', 'product_variant', 'sales_record'])
  })
})

describe('isValidLookupField / lookupKeyLabel（突合キーの検証・表示名）', () => {
  it('マスタのカタログ項目のみ許可（セグメントに custom は不可）', () => {
    const seg = importRefTargetOf('product', 'segmentId')!
    expect(isValidLookupField(seg, 'id')).toBe(true)
    expect(isValidLookupField(seg, 'name')).toBe(true)
    expect(isValidLookupField(seg, 'code')).toBe(false)
    expect(isValidLookupField(seg, 'custom.extCode')).toBe(false)
  })
  it('取引先は custom.<key> を許可（allowCustom）・裸の custom. は不可', () => {
    const company = importRefTargetOf('sales_record', 'companyId')!
    expect(isValidLookupField(company, 'custom.extCode')).toBe(true)
    expect(isValidLookupField(company, 'custom.')).toBe(false)
    expect(isValidLookupField(company, 'aliases')).toBe(false)
  })
  it('SKU は id / code / janCode を許可', () => {
    const sku = importRefTargetOf('inventory', 'skuId')!
    expect(isValidLookupField(sku, 'code')).toBe(true)
    expect(isValidLookupField(sku, 'janCode')).toBe(true)
    expect(isValidLookupField(sku, 'name')).toBe(false)
  })
  it('表示名: カタログ項目はラベル・custom はカスタム項目名', () => {
    const company = importRefTargetOf('sales_record', 'companyId')!
    expect(lookupKeyLabel(company, 'name')).toBe('名称')
    expect(lookupKeyLabel(company, 'custom.extCode')).toBe('カスタム項目「extCode」')
  })
})

describe('variantAxisLabelsOf（バリアント軸ラベル = 軸値に割り当てた列の論理名）', () => {
  it('axis1Value / axis2Value の sourceField を軸ラベルにする（未割当は null）', () => {
    expect(variantAxisLabelsOf([f('code', 'skuid'), f('axis1Value', ' カラー '), f('axis2Value', 'サイズ')]))
      .toEqual({ axis1Label: 'カラー', axis2Label: 'サイズ' })
    expect(variantAxisLabelsOf([f('code', 'skuid'), f('axis1Value', '色')]))
      .toEqual({ axis1Label: '色', axis2Label: null })
    expect(variantAxisLabelsOf([f('code', 'skuid')])).toEqual({ axis1Label: null, axis2Label: null })
  })
})

describe('validateImportMapping（保存前検証 = モック↔API parity）', () => {
  it('突合キー: 非参照項目への設定・参照先で使えないキーはエラー', () => {
    expect(validateImportMapping('sales_record', [f('qty', 'qty', 'name')])).toContain('突合キーを設定できません')
    expect(validateImportMapping('sales_record', [f('companyId', 'customer', 'code')])).toContain('使えません')
    expect(validateImportMapping('sales_record', [f('companyId', 'customer', 'custom.extCode')])).toBeNull()
    expect(validateImportMapping('sales_record', [f('skuId', 'sku', 'janCode')])).toBeNull()
    expect(validateImportMapping('sales_record', [f('companyId', 'customer')])).toBeNull()
  })
  it('product_variant: グルーピングキー（productCode）と SKU コード（code）は必須', () => {
    expect(validateImportMapping('product_variant', [f('code', 'skuid')])).toContain('商品コード')
    expect(validateImportMapping('product_variant', [f('productCode', '商品id')])).toContain('SKUコード')
    expect(validateImportMapping('product_variant', [f('productCode', '商品id'), f('code', 'skuid')])).toBeNull()
  })
  it('product_variant: 軸2 のみのマッピングはエラー（軸1 が先）・対象項目の重複はエラー', () => {
    expect(validateImportMapping('product_variant', [
      f('productCode', '商品id'), f('code', 'skuid'), f('axis2Value', 'サイズ'),
    ])).toContain('バリアント軸1')
    expect(validateImportMapping('product_variant', [
      f('productCode', '商品id'), f('code', 'skuid'), f('axis1Value', 'カラー'), f('axis1Value', '色'),
    ])).toContain('複数行')
  })
  it('参照項目の重複割当は全対象で拒否（値 = 最後の行・突合キーの組が不定になるため）', () => {
    expect(validateImportMapping('sales_record', [
      f('companyId', '会社名'), f('companyId', '外部コード', 'custom.extCode'),
    ])).toContain('複数行')
    expect(validateImportMapping('product', [f('segmentId', 'seg1'), f('segmentId', 'seg2')])).toContain('複数行')
  })
  it('非参照項目の重複・product_variant 以外の構造は従来どおり許容（下位互換）', () => {
    expect(validateImportMapping('product', [f('name', '商品名'), f('name', '商品名2')])).toBeNull()
    expect(validateImportMapping('sku', [f('code', 'sku'), f('code', 'sku2')])).toBeNull()
  })
  it('バリアント項目カタログはグルーピングキー・固有ID・軸1/2 を含む', () => {
    const keys = VARIANT_IMPORT_FIELDS.map(x => x.key)
    for (const k of ['productCode', 'productName', 'segmentId', 'code', 'axis1Value', 'axis2Value']) {
      expect(keys).toContain(k)
    }
  })
})
