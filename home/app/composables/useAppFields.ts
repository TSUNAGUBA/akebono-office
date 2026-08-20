/**
 * アプリ項目の統一解決（F-31 汎用化。オペレーター指示 2026-07-30）。
 * 「既定項目カタログ（ITEM_CATALOG）＋テナント差分（ItemSetting）」と「カスタム項目（CustomFieldDef）」を
 * 1 つに束ね、全 Akebono 業務アプリの項目構成を単一エンジンで返す。
 *
 * 消費者:
 *   - 各アプリのフォーム/一覧（既定項目の表示・ラベル差分 + 追加カスタム項目の描画）
 *   - データ取込・連携（F-32）のマッピング右辺 = appFields(targetEntity) の候補一覧
 *
 * 既存の 2 エンジン（useItemSettings = 既定項目の差分 / useCustomFields = 追加項目）を破棄せず統合レイヤで束ねる。
 */
import type { CustomFieldEntity, CustomFieldType } from '~/types/domain'
import type { FieldDef } from '~/types/ui'

export interface AppField {
  /** 既定項目 = itemKey / カスタム項目 = `custom.<key>`（レコードの custom 配下に保存） */
  key: string
  label: string
  source: 'builtin' | 'custom'
  required: boolean
  /** カスタム項目のみ（既定項目は undefined） */
  fieldType?: CustomFieldType
}

export function useAppFields() {
  const items = useItemSettings()
  const cf = useCustomFields()

  /** 既定項目の解決（カタログ + ItemSetting 差分。表示/ラベル/必須を含む） */
  function builtinResolved(entity: string) {
    return items.resolve(entity)
  }

  /** そのエンティティのカスタム項目定義（有効・displayOrder 昇順） */
  function customDefs(entity: string) {
    return cf.defsFor(entity as CustomFieldEntity)
  }

  /** アプリフォームのカスタム項目部分（UiSchemaForm 用 FieldDef。key = `custom.<key>`） */
  function customFormSchema(entity: string): FieldDef[] {
    return cf.formSchemaFor(entity as CustomFieldEntity)
  }

  /**
   * 統一項目一覧（既定[指定スコープで表示]＋カスタム）。取込右辺・汎用一覧で使う。
   * scope: 'form' = フォーム表示項目 / 'list' = 一覧表示項目 / 'all' = 全項目（既定は非表示も含む）。
   */
  function appFields(entity: string, opts: { scope?: 'form' | 'list' | 'all' } = {}): AppField[] {
    const scope = opts.scope ?? 'all'
    const builtins: AppField[] = items.resolve(entity)
      .filter(r => scope === 'all' ? true : scope === 'form' ? r.formVisible : r.listVisible)
      .map(r => ({ key: r.itemKey, label: r.labelDisplay, source: 'builtin', required: r.required }))
    const customs: AppField[] = cf.defsFor(entity as CustomFieldEntity).map(d => ({
      key: `custom.${d.key}`, label: d.label, source: 'custom', required: d.required, fieldType: d.fieldType,
    }))
    return [...builtins, ...customs]
  }

  /**
   * 必須カスタム項目の未入力チェック（全アプリのフォーム保存前検証で使う = DRY）。
   * 最初に見つかった未入力の必須項目ラベルを返す（無ければ null）。
   */
  function missingRequiredCustom(entity: string, custom: Record<string, unknown> | undefined): string | null {
    const c = custom ?? {}
    for (const d of cf.defsFor(entity as CustomFieldEntity)) {
      if (!d.required) continue
      const v = c[d.key]
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return d.label
    }
    return null
  }

  return {
    appFields, builtinResolved, customDefs, customFormSchema, missingRequiredCustom,
    /** カスタマイズ対象エンティティ（ITEM_CATALOG のキー = 全 Akebono 業務アプリ） */
    entities: items.entities,
    entityLabels: ITEM_ENTITY_LABELS,
  }
}
