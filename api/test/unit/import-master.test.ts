import { describe, expect, it } from 'vitest'
import {
  MASTER_IMPORT_DEFS, MASTER_IMPORT_ENTITIES, masterImportDefOf, parseMasterFieldValue,
  type MasterImportField,
} from '../../../shared/domain/import-master'
import { validateImportMapping } from '../../../shared/domain/import-link'

const f = (targetItemKey: string, sourceField = 'col') => ({ sourceField, targetItemKey })
const field = (over: Partial<MasterImportField>): MasterImportField =>
  ({ key: 'x', label: 'X', column: 'x', kind: 'text', ...over })

describe('MASTER_IMPORT_DEFS（共通マスタ取込カタログ）', () => {
  it('8 マスタを宣言し、各 def は name 項目を必ず持つ（突合キー）', () => {
    expect(MASTER_IMPORT_ENTITIES.sort()).toEqual([
      'master_axis_template', 'master_category', 'master_image_section', 'master_payment_term',
      'master_segment', 'master_tax_rate', 'master_unit', 'master_warehouse',
    ])
    for (const def of Object.values(MASTER_IMPORT_DEFS)) {
      expect(def.fields.some(x => x.key === 'name')).toBe(true)
      expect(def.table).toBeTruthy()
      expect(def.idPrefix).toBeTruthy()
      expect(def.collection).toBeTruthy()
    }
  })
  it('DB で NOT NULL・既定値なしの列は requiredOnCreate（空 INSERT で 23502 を出さない = MINOR-1）', () => {
    // 倉庫の kind / セグメントの業種 / 税率 / 締め日 / 軸ラベルは新規作成に必須
    expect(MASTER_IMPORT_DEFS.master_warehouse!.fields.find(f => f.key === 'kind')?.requiredOnCreate).toBe(true)
    expect(MASTER_IMPORT_DEFS.master_segment!.fields.find(f => f.key === 'industryType')?.requiredOnCreate).toBe(true)
    expect(MASTER_IMPORT_DEFS.master_tax_rate!.fields.find(f => f.key === 'rate')?.requiredOnCreate).toBe(true)
    expect(MASTER_IMPORT_DEFS.master_payment_term!.fields.find(f => f.key === 'closingDay')?.requiredOnCreate).toBe(true)
    expect(MASTER_IMPORT_DEFS.master_axis_template!.fields.find(f => f.key === 'axis1Label')?.requiredOnCreate).toBe(true)
    expect(MASTER_IMPORT_DEFS.master_axis_template!.fields.find(f => f.key === 'axis2Label')?.requiredOnCreate).toBe(true)
  })
  it('entity 値はキーと一致し、委託条件は対象外', () => {
    for (const [key, def] of Object.entries(MASTER_IMPORT_DEFS)) expect(def.entity).toBe(key)
    expect(masterImportDefOf('master_segment')?.table).toBe('business_segments')
    expect(masterImportDefOf('consignment_terms')).toBeNull()
    expect(masterImportDefOf('unknown')).toBeNull()
  })
})

describe('validateImportMapping（master_* = 名称の割当が必須・重複禁止）', () => {
  it('name 未割当はエラー、割当済みは OK', () => {
    expect(validateImportMapping('master_segment', [f('industryType', '業種')])).toContain('名称')
    expect(validateImportMapping('master_segment', [f('name', 'セグメント名')])).toBeNull()
  })
  it('同一対象項目の重複割当はエラー（値が最後の行勝ちで不定になるため）', () => {
    expect(validateImportMapping('master_unit', [f('name', '単位1'), f('name', '単位2')])).toContain('複数行')
  })
})

describe('parseMasterFieldValue（種別・値域の検証）', () => {
  it('空セルは null（更新では変更しない・新規では未設定）', () => {
    expect(parseMasterFieldValue(field({ kind: 'text' }), '  ')).toEqual({ ok: true, value: null })
    expect(parseMasterFieldValue(field({ kind: 'number' }), '')).toEqual({ ok: true, value: null })
  })
  it('number/int: 値域と整数性を検証', () => {
    expect(parseMasterFieldValue(field({ kind: 'number', min: 0, max: 1 }), '0.1')).toEqual({ ok: true, value: 0.1 })
    expect(parseMasterFieldValue(field({ kind: 'number', min: 0, max: 1 }), '1.5')).toMatchObject({ ok: false })
    expect(parseMasterFieldValue(field({ kind: 'int', min: 1, max: 31 }), '15')).toEqual({ ok: true, value: 15 })
    expect(parseMasterFieldValue(field({ kind: 'int' }), '1.5')).toMatchObject({ ok: false })
    expect(parseMasterFieldValue(field({ kind: 'number' }), 'abc')).toMatchObject({ ok: false })
  })
  it('bool: 和名・英語・記号を受理し、不明は隔離', () => {
    expect(parseMasterFieldValue(field({ kind: 'bool' }), 'あり')).toEqual({ ok: true, value: true })
    expect(parseMasterFieldValue(field({ kind: 'bool' }), 'false')).toEqual({ ok: true, value: false })
    expect(parseMasterFieldValue(field({ kind: 'bool' }), 'たぶん')).toMatchObject({ ok: false })
  })
  it('enum: 内部値と和名の双方を内部値へ写像、未知は隔離', () => {
    const industry = field({ kind: 'enum', enumMap: { retail: 'retail', 小売業: 'retail', maker: 'maker' } })
    expect(parseMasterFieldValue(industry, '小売業')).toEqual({ ok: true, value: 'retail' })
    expect(parseMasterFieldValue(industry, 'retail')).toEqual({ ok: true, value: 'retail' })
    expect(parseMasterFieldValue(industry, '製造')).toMatchObject({ ok: false })
  })
  it('multiEnum: カンマ/読点区切りを写像し重複除去、未知は隔離、区切りのみは null（既存値を潰さない）', () => {
    const types = field({ kind: 'multiEnum', enumMap: { retail: 'retail', 小売業: 'retail', maker: 'maker', メーカー業: 'maker' } })
    expect(parseMasterFieldValue(types, '小売業、メーカー業')).toEqual({ ok: true, value: ['retail', 'maker'] })
    expect(parseMasterFieldValue(types, 'retail,retail')).toEqual({ ok: true, value: ['retail'] })
    expect(parseMasterFieldValue(types, '小売業,不明')).toMatchObject({ ok: false })
    // 区切り文字だけで実値が無いセルは null（更新で industry_types を空配列に潰さない = NIT-6）
    expect(parseMasterFieldValue(types, '、,')).toEqual({ ok: true, value: null })
  })
  it('text: maxLen でコードポイント切詰め（サロゲート安全）', () => {
    expect(parseMasterFieldValue(field({ kind: 'text', maxLen: 3 }), 'あいうえお')).toEqual({ ok: true, value: 'あいう' })
  })
})
