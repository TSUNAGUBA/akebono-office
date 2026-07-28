import { describe, expect, it } from 'vitest'
import type { BusinessSegment } from '~/types/akebono'
import {
  AKEBONO_APP_KEYS, INDUSTRY_DEFAULT_ICON, INDUSTRY_PRESET, presetAppConfigsForSegments,
  presetAppsForSegment, resolveDefaultSegmentId, segmentAppName, segmentFieldDefaults,
  segmentIconKey,
} from '~/utils/akebono'

/** マルチ業態（現在業態コンテキスト + 業態ごとアプリ設定）の純関数リグレッション */

const seg = (id: string, industryType: BusinessSegment['industryType']): BusinessSegment => ({
  id, name: id, industryType, displayOrder: 1, active: true,
})

describe('resolveDefaultSegmentId（現在業態の解決）', () => {
  const active = [seg('seg-01', 'retail'), seg('seg-02', 'it_service')]

  it('有効な業態が指定されていればそれを返す', () => {
    expect(resolveDefaultSegmentId('seg-02', active)).toBe('seg-02')
  })

  it('未選択（空/null/undefined）は先頭業態にフォールバックする', () => {
    expect(resolveDefaultSegmentId('', active)).toBe('seg-01')
    expect(resolveDefaultSegmentId(null, active)).toBe('seg-01')
    expect(resolveDefaultSegmentId(undefined, active)).toBe('seg-01')
  })

  it('無効化・削除された id は先頭業態にフォールバックする（保存済み id の陳腐化に耐える）', () => {
    expect(resolveDefaultSegmentId('seg-99', active)).toBe('seg-01')
  })

  it('業態が 1 つも無ければ空文字を返す', () => {
    expect(resolveDefaultSegmentId('seg-01', [])).toBe('')
  })
})

describe('presetAppsForSegment（業態単独のプリセット）', () => {
  it('業種タイプ単独のプリセットを返す（和集合ではない）', () => {
    expect(presetAppsForSegment(seg('s', 'retail'))).toEqual(INDUSTRY_PRESET.retail)
    // 情報サービス業は在庫・入荷・出荷を含まない
    expect(presetAppsForSegment(seg('s', 'it_service'))).not.toContain('inventory')
    expect(presetAppsForSegment(seg('s', 'it_service'))).not.toContain('inbounds')
    // 小売業は生産を含まない
    expect(presetAppsForSegment(seg('s', 'retail'))).not.toContain('production')
  })
})

describe('presetAppConfigsForSegments（業態ごと初期アプリ設定）', () => {
  const segments = [seg('seg-01', 'retail'), seg('seg-02', 'it_service')]
  const configs = presetAppConfigsForSegments(segments)

  it('業態 × 全アプリキーの行を生成する（一意キー = segmentId × appKey）', () => {
    expect(configs).toHaveLength(segments.length * AKEBONO_APP_KEYS.length)
    const keys = new Set(configs.map(c => `${c.segmentId}::${c.appKey}`))
    expect(keys.size).toBe(configs.length) // 重複なし
  })

  it('各業態で、その業種プリセットに含まれるアプリだけが enabled になる', () => {
    for (const s of segments) {
      const preset = new Set(presetAppsForSegment(s))
      for (const appKey of AKEBONO_APP_KEYS) {
        const cfg = configs.find(c => c.segmentId === s.id && c.appKey === appKey)!
        expect(cfg.enabled).toBe(preset.has(appKey))
      }
    }
  })

  it('業態ごとに enabled 構成が異なりうる（小売と情報サービスで在庫の扱いが違う）', () => {
    const retailInv = configs.find(c => c.segmentId === 'seg-01' && c.appKey === 'inventory')!
    const itInv = configs.find(c => c.segmentId === 'seg-02' && c.appKey === 'inventory')!
    expect(retailInv.enabled).toBe(true)
    expect(itInv.enabled).toBe(false)
  })
})

describe('segmentAppName（業態アプリの表示名）', () => {
  it('appName があればそれを優先する', () => {
    expect(segmentAppName({ name: '陶磁器委託販売', appName: '工芸品ショップ' })).toBe('工芸品ショップ')
  })
  it('appName 未設定（null/空白）は業態名にフォールバックする', () => {
    expect(segmentAppName({ name: '陶磁器委託販売', appName: null })).toBe('陶磁器委託販売')
    expect(segmentAppName({ name: '陶磁器委託販売', appName: '   ' })).toBe('陶磁器委託販売')
    expect(segmentAppName({ name: '陶磁器委託販売' })).toBe('陶磁器委託販売')
  })
})

describe('segmentIconKey（業態アプリのアイコン解決）', () => {
  it('appIcon があればそれを使う', () => {
    expect(segmentIconKey({ industryType: 'retail', appIcon: 'Shirt' })).toBe('Shirt')
  })
  it('appIcon 未設定は業種タイプ既定アイコンにフォールバックする', () => {
    expect(segmentIconKey({ industryType: 'retail', appIcon: null })).toBe(INDUSTRY_DEFAULT_ICON.retail)
    expect(segmentIconKey({ industryType: 'it_service', appIcon: '  ' })).toBe(INDUSTRY_DEFAULT_ICON.it_service)
    expect(segmentIconKey({ industryType: 'logistics' })).toBe(INDUSTRY_DEFAULT_ICON.logistics)
  })
})

describe('segmentFieldDefaults（商品登録の既定値）', () => {
  it('業態に設定された既定値を取り出す', () => {
    const s: BusinessSegment = {
      ...seg('seg-x', 'retail'),
      defaultUnitId: 'unit-01', defaultBillingType: 'monthly',
      defaultVariantAxis1Label: 'カラー', defaultVariantAxis2Label: 'サイズ',
    }
    expect(segmentFieldDefaults(s)).toEqual({
      unitId: 'unit-01', billingType: 'monthly', variantAxis1Label: 'カラー', variantAxis2Label: 'サイズ',
    })
  })
  it('未設定は null（物販・SKU 展開なし相当）', () => {
    expect(segmentFieldDefaults(seg('seg-y', 'other'))).toEqual({
      unitId: null, billingType: null, variantAxis1Label: null, variantAxis2Label: null,
    })
  })
  it('segment が null/undefined でも安全に空既定を返す（原則7）', () => {
    const empty = { unitId: null, billingType: null, variantAxis1Label: null, variantAxis2Label: null }
    expect(segmentFieldDefaults(null)).toEqual(empty)
    expect(segmentFieldDefaults(undefined)).toEqual(empty)
  })
})
