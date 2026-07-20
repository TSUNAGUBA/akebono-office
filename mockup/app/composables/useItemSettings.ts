/**
 * 項目カスタマイズ（F-31）
 * 基本項目カタログ（コード = シード SoT）に、テナント差分（itemSettings）を重ねて
 * フォーム/一覧の項目構成を解決する。基本項目は非表示化のみ（削除不可）。
 * F-16 の表示項目 deny は本モックでは扱わない（本実装で優先適用）。
 */
import type { ItemSetting } from '~/types/akebono'
import type { IndustryType } from '~/types/akebono'
import type { Result } from '~/types/domain'

export interface CatalogItem {
  itemKey: string
  label: string
  /** 業種タイプ別の既定表示（未指定 = 全業種で表示）。基本項目 = 削除不可 */
  formDefault: boolean
  listDefault: boolean
  required: boolean
  /** この項目が特に効く業種（バッジ表示用） */
  industryHint?: IndustryType
  /** 必須固定（カスタマイズで必須解除できない整合必須項目） */
  requiredFixed?: boolean
}

/** 基本項目カタログ（代表エンティティ。SoT） */
export const ITEM_CATALOG: Record<string, CatalogItem[]> = {
  product: [
    { itemKey: 'code', label: '商品コード', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'name', label: '商品名', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'categoryId', label: '商品カテゴリ', formDefault: true, listDefault: true, required: false },
    { itemKey: 'defaultSupplierCompanyId', label: '既定仕入先', formDefault: true, listDefault: false, required: false },
    { itemKey: 'listPrice', label: '標準売価', formDefault: true, listDefault: true, required: false },
    { itemKey: 'standardCost', label: '標準原価', formDefault: true, listDefault: false, required: false },
    { itemKey: 'taxRateId', label: '税区分', formDefault: true, listDefault: false, required: false },
    { itemKey: 'unitId', label: '単位', formDefault: true, listDefault: false, required: false },
    { itemKey: 'variantAxes', label: 'バリアント軸（カラー×サイズ 等）', formDefault: true, listDefault: false, required: false, industryHint: 'retail' },
    { itemKey: 'billingType', label: '課金区分（買切/月額/従量）', formDefault: false, listDefault: false, required: false, industryHint: 'it_service' },
    { itemKey: 'description', label: '説明', formDefault: true, listDefault: false, required: false },
  ],
  sales_record: [
    { itemKey: 'salesDate', label: '売上日', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'companyId', label: '得意先', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'skuId', label: 'SKU', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'qty', label: '数量', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'unitPrice', label: '単価', formDefault: true, listDefault: true, required: true, requiredFixed: true },
    { itemKey: 'channel', label: 'チャネル', formDefault: true, listDefault: false, required: false, industryHint: 'retail' },
  ],
}

export const ITEM_ENTITY_LABELS: Record<string, string> = {
  product: '商品マスタ',
  sales_record: '売上明細',
}

export interface ResolvedItem extends CatalogItem {
  formVisible: boolean
  listVisible: boolean
  labelDisplay: string
  overridden: boolean
}

export function useItemSettings() {
  const { tbl, commit, nextId } = useMockDb()
  const settings = tbl('itemSettings')
  const appKey = 'akebono'

  function settingOf(entity: string, itemKey: string): ItemSetting | undefined {
    return settings.value.find(s => s.entity === entity && s.itemKey === itemKey)
  }

  /** エンティティの項目構成を解決（カタログ既定 + テナント差分） */
  function resolve(entity: string): ResolvedItem[] {
    const catalog = ITEM_CATALOG[entity] ?? []
    return catalog.map((c) => {
      const ov = settingOf(entity, c.itemKey)
      return {
        ...c,
        formVisible: ov?.formVisible ?? c.formDefault,
        listVisible: ov?.listVisible ?? c.listDefault,
        labelDisplay: ov?.labelOverride ?? c.label,
        overridden: Boolean(ov),
      }
    })
  }

  function upsert(entity: string, itemKey: string, patch: Partial<Pick<ItemSetting, 'formVisible' | 'listVisible' | 'formRequired' | 'labelOverride'>>): Result {
    const existing = settingOf(entity, itemKey)
    if (existing) {
      settings.value = settings.value.map(s => s.id === existing.id ? { ...s, ...patch } : s)
    } else {
      settings.value = [...settings.value, {
        id: nextId('itemSettings', 'is'), appKey, entity, itemKey,
        formVisible: patch.formVisible ?? null, formRequired: patch.formRequired ?? null,
        listVisible: patch.listVisible ?? null, displayOrder: null, labelOverride: patch.labelOverride ?? null,
      }]
    }
    commit()
    return { ok: true }
  }

  /** 業種の基本項目へ戻す（取消フロー = 原則 9.5。当該エンティティの差分を全削除） */
  function resetEntity(entity: string): Result {
    settings.value = settings.value.filter(s => s.entity !== entity)
    commit()
    return { ok: true }
  }

  return { settings, resolve, upsert, resetEntity, entities: Object.keys(ITEM_CATALOG) }
}
