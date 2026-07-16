/**
 * カスタム項目（F-13-1）: エンティティごとの任意項目定義を管理し、
 * UiSchemaForm 用の FieldDef へ変換する（他社展開時の汎用化の中核）。
 */
import type { CustomFieldDef, CustomFieldEntity } from '~/types/domain'
import type { FieldDef } from '~/types/ui'

export function useCustomFields() {
  const crud = useMasterCrud('customFieldDefs', 'cf')

  function defsFor(entity: CustomFieldEntity): CustomFieldDef[] {
    return crud.activeList.value
      .filter(d => d.entity === entity)
      .sort((a, b) => a.displayOrder - b.displayOrder)
  }

  /** UiSchemaForm に渡す FieldDef へ変換 */
  function formSchemaFor(entity: CustomFieldEntity): FieldDef[] {
    return defsFor(entity).map(d => ({
      key: `custom.${d.key}`,
      label: d.label,
      type: d.fieldType === 'boolean' ? 'boolean'
        : d.fieldType === 'number' ? 'number'
          : d.fieldType === 'date' ? 'date'
            : d.fieldType === 'select' ? 'select'
              : d.fieldType === 'multiselect' ? 'multiselect'
                : 'text',
      required: d.required,
      options: d.options.map(o => ({ value: o, label: o })),
    }))
  }

  return { ...crud, defsFor, formSchemaFor }
}
