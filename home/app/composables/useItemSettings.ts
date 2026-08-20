/**
 * 項目カスタマイズ（F-31）
 * 基本項目カタログ（コード = 静的 SoT）に、テナント差分（itemSettings）を重ねて
 * フォーム/一覧/検索フィルタの項目構成を解決する。基本項目は非表示化のみ（削除不可）。
 * F-16 の表示項目 deny は本モックでは扱わない（本実装で優先適用）。
 *
 * デュアルモード（Phase B = 0031）: API モードの差分 SoT はサーバー（item_settings =
 * PUT /v1/akebono/item-settings の複合キー (entity, itemKey) 部分 upsert・
 * POST /item-settings/reset のエンティティ単位リセット = カタログ既定へ戻す取消フロー。原則9.5）。
 * 解決（resolve）は両モード共通で tbl() のキャッシュを読む。
 */
import type { ItemSetting } from '~/types/akebono'
import type { IndustryType } from '~/types/akebono'
import type { Result } from '~/types/domain'

/** フィルタ種別（未指定 = フィルタ不可）。ref = マスタ参照（autocomplete）・text = 正規化部分一致・enum = 固定選択・date/number = 範囲 */
export type FilterKind = 'text' | 'ref' | 'enum' | 'date' | 'number'
/** ref 種別のとき参照するマスタ種別（AppFilterBar のオプション解決キー） */
export type FilterRefKind = 'company' | 'segment' | 'sku' | 'warehouse' | 'category' | 'taxRate' | 'unit'

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
  /** フィルタ種別（未指定 = 検索フィルタに使えない項目 = variantAxes 等の複合項目） */
  filterKind?: FilterKind
  /** ref 種別のとき参照するマスタ種別 */
  filterRef?: FilterRefKind
  /** 検索フィルタの既定表示（未指定 = false。settings/items で ON/OFF 可） */
  filterDefault?: boolean
}

/** 基本項目カタログ（代表エンティティ。SoT）。filterKind/filterRef/filterDefault = 検索フィルタのメタ */
export const ITEM_CATALOG: Record<string, CatalogItem[]> = {
  product: [
    { itemKey: 'code', label: '商品コード', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'name', label: '商品名', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'segment', filterDefault: true },
    { itemKey: 'categoryId', label: '商品カテゴリ', formDefault: true, listDefault: true, required: false, filterKind: 'ref', filterRef: 'category', filterDefault: false },
    { itemKey: 'defaultSupplierCompanyId', label: '既定仕入先', formDefault: true, listDefault: false, required: false, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'listPrice', label: '標準売価', formDefault: true, listDefault: true, required: false, filterKind: 'number', filterDefault: false },
    { itemKey: 'standardCost', label: '標準原価', formDefault: true, listDefault: false, required: false, filterKind: 'number', filterDefault: false },
    { itemKey: 'taxRateId', label: '税区分', formDefault: true, listDefault: false, required: false, filterKind: 'ref', filterRef: 'taxRate', filterDefault: false },
    { itemKey: 'unitId', label: '単位', formDefault: true, listDefault: false, required: false, filterKind: 'ref', filterRef: 'unit', filterDefault: false },
    { itemKey: 'variantAxes', label: 'バリアント軸（カラー×サイズ 等）', formDefault: true, listDefault: false, required: false, industryHint: 'retail' },
    { itemKey: 'billingType', label: '課金区分（買切/月額/従量）', formDefault: false, listDefault: false, required: false, industryHint: 'it_service', filterKind: 'enum', filterDefault: false },
    { itemKey: 'description', label: '説明', formDefault: true, listDefault: false, required: false, filterKind: 'text', filterDefault: false },
  ],
  sales_record: [
    { itemKey: 'salesDate', label: '売上日', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'date', filterDefault: true },
    { itemKey: 'companyId', label: '得意先', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'segment', filterDefault: true },
    { itemKey: 'skuId', label: 'SKU', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'sku', filterDefault: true },
    { itemKey: 'qty', label: '数量', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'number', filterDefault: false },
    { itemKey: 'unitPrice', label: '単価', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'number', filterDefault: false },
    { itemKey: 'channel', label: 'チャネル', formDefault: true, listDefault: false, required: false, industryHint: 'retail', filterKind: 'text', filterDefault: false },
  ],
  sku: [
    { itemKey: 'code', label: 'SKUコード', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'janCode', label: 'JANコード', formDefault: true, listDefault: true, required: false, filterKind: 'text', filterDefault: true },
    { itemKey: 'axis1Value', label: 'バリアント軸1', formDefault: true, listDefault: true, required: false, industryHint: 'retail', filterKind: 'text', filterDefault: false },
    { itemKey: 'axis2Value', label: 'バリアント軸2', formDefault: true, listDefault: true, required: false, industryHint: 'retail', filterKind: 'text', filterDefault: false },
    { itemKey: 'sellPrice', label: 'SKU売価', formDefault: true, listDefault: false, required: false, filterKind: 'number', filterDefault: false },
    { itemKey: 'costPrice', label: 'SKU原価', formDefault: true, listDefault: false, required: false, filterKind: 'number', filterDefault: false },
  ],
  purchase_order: [
    { itemKey: 'code', label: '発注番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'companyId', label: '仕入先', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'segment', filterDefault: true },
    { itemKey: 'orderDate', label: '発注日', formDefault: true, listDefault: true, required: true, filterKind: 'date', filterDefault: true },
    { itemKey: 'dueDate', label: '納期', formDefault: true, listDefault: true, required: false, filterKind: 'date', filterDefault: false },
    { itemKey: 'note', label: '備考', formDefault: true, listDefault: false, required: false, filterKind: 'text', filterDefault: false },
  ],
  production_order: [
    { itemKey: 'code', label: '生産指示番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'skuId', label: 'SKU', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'sku', filterDefault: true },
    { itemKey: 'qty', label: '指示数量', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'number', filterDefault: false },
    { itemKey: 'warehouseId', label: '完成入庫先', formDefault: true, listDefault: false, required: true, filterKind: 'ref', filterRef: 'warehouse', filterDefault: true },
    { itemKey: 'dueDate', label: '完成予定', formDefault: true, listDefault: true, required: false, filterKind: 'date', filterDefault: true },
  ],
  purchase_record: [
    { itemKey: 'code', label: '仕入番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'companyId', label: '仕入先', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'segment', filterDefault: true },
    { itemKey: 'purchaseDate', label: '仕入日', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'date', filterDefault: true },
    { itemKey: 'purchaseType', label: '仕入区分', formDefault: true, listDefault: true, required: false, filterKind: 'enum', filterDefault: true },
  ],
  inbound: [
    { itemKey: 'code', label: '入荷番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'warehouseId', label: '入荷倉庫', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'warehouse', filterDefault: true },
    { itemKey: 'receivedAt', label: '入荷日時', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'date', filterDefault: true },
  ],
  outbound: [
    { itemKey: 'code', label: '出荷番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'companyId', label: '出荷先', formDefault: true, listDefault: true, required: false, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'warehouseId', label: '出荷倉庫', formDefault: true, listDefault: true, required: false, filterKind: 'ref', filterRef: 'warehouse', filterDefault: true },
    { itemKey: 'shippedAt', label: '出荷日時', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'date', filterDefault: true },
  ],
  inventory: [
    { itemKey: 'skuId', label: 'SKU', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'sku', filterDefault: true },
    { itemKey: 'warehouseId', label: '倉庫', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'warehouse', filterDefault: true },
    { itemKey: 'qty', label: '増減数', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'number', filterDefault: false },
    { itemKey: 'kind', label: '区分', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'enum', filterDefault: true },
    { itemKey: 'reason', label: '理由', formDefault: true, listDefault: false, required: false, filterKind: 'enum', filterDefault: false },
    { itemKey: 'occurredAt', label: '発生日時', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'date', filterDefault: true },
  ],
  invoice: [
    { itemKey: 'code', label: '請求番号', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'text', filterDefault: true },
    { itemKey: 'companyId', label: '請求先', formDefault: true, listDefault: true, required: true, requiredFixed: true, filterKind: 'ref', filterRef: 'company', filterDefault: true },
    { itemKey: 'segmentId', label: '事業セグメント', formDefault: true, listDefault: false, required: false, filterKind: 'ref', filterRef: 'segment', filterDefault: false },
    { itemKey: 'periodFrom', label: '対象期間（開始）', formDefault: true, listDefault: true, required: true, filterKind: 'date', filterDefault: true },
    { itemKey: 'periodTo', label: '対象期間（終了）', formDefault: true, listDefault: true, required: true, filterKind: 'date', filterDefault: true },
    { itemKey: 'invoiceType', label: '請求種別', formDefault: true, listDefault: true, required: false, filterKind: 'enum', filterDefault: true },
  ],
}

export const ITEM_ENTITY_LABELS: Record<string, string> = {
  product: '商品マスタ',
  sku: 'SKU',
  sales_record: '売上明細',
  purchase_order: '発注',
  production_order: '生産指示',
  purchase_record: '仕入計上',
  inbound: '入荷実績',
  outbound: '出荷実績',
  inventory: '在庫トランザクション',
  invoice: '請求',
}

export interface ResolvedItem extends CatalogItem {
  formVisible: boolean
  listVisible: boolean
  filterVisible: boolean
  labelDisplay: string
  overridden: boolean
}

export function useItemSettings() {
  const { tbl, commit, nextId } = useMockDb()
  const settings = tbl('itemSettings')
  const isApi = useApiMode()
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
        // フィルタ非対応項目（filterKind 未指定）は常に false。差分は filterKind を持つ項目のみ効く
        filterVisible: c.filterKind ? (ov?.filterVisible ?? c.filterDefault ?? false) : false,
        labelDisplay: ov?.labelOverride ?? c.label,
        overridden: Boolean(ov),
      }
    })
  }

  /** 検索フィルタに表示する項目（filterVisible かつ filterKind を持つもの。表示順はカタログ順） */
  function filterableItems(entity: string): ResolvedItem[] {
    return resolve(entity).filter(r => r.filterVisible && r.filterKind)
  }

  /** 差分の upsert（渡したキーのみ更新 = 未送信フィールドは保持。API モードはサーバーが hasOwn で保証） */
  async function upsert(entity: string, itemKey: string, patch: Partial<Pick<ItemSetting, 'formVisible' | 'listVisible' | 'filterVisible' | 'formRequired' | 'labelOverride'>>): Promise<Result> {
    if (isApi) {
      try {
        const row = await apiFetch<ItemSetting>('/v1/akebono/item-settings', {
          method: 'PUT', body: { entity, itemKey, ...patch },
        })
        // SoT 書込 → キャッシュ反映（複合キー一意のためサーバー採番 id で置換 or 追加）
        const rest = settings.value.filter(s => !(s.entity === entity && s.itemKey === itemKey))
        settings.value = [...rest, row]
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    const existing = settingOf(entity, itemKey)
    if (existing) {
      settings.value = settings.value.map(s => s.id === existing.id ? { ...s, ...patch } : s)
    } else {
      settings.value = [...settings.value, {
        id: nextId('itemSettings', 'is'), appKey, entity, itemKey,
        formVisible: patch.formVisible ?? null, formRequired: patch.formRequired ?? null,
        listVisible: patch.listVisible ?? null, filterVisible: patch.filterVisible ?? null,
        displayOrder: null, labelOverride: patch.labelOverride ?? null,
      }]
    }
    commit()
    return { ok: true }
  }

  /** 業種の基本項目へ戻す（取消フロー = 原則 9.5。当該エンティティの差分を全削除） */
  async function resetEntity(entity: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/akebono/item-settings/reset', {
        method: 'POST', body: { entity },
      }))
      if (res.ok) settings.value = settings.value.filter(s => s.entity !== entity)
      return res
    }
    settings.value = settings.value.filter(s => s.entity !== entity)
    commit()
    return { ok: true }
  }

  return { settings, resolve, filterableItems, upsert, resetEntity, entities: Object.keys(ITEM_CATALOG) }
}
