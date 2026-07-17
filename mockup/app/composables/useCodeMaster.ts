/**
 * 汎用区分マスタ（F-13-2）: 選択肢群をコード種別単位で管理。
 * 各画面のセレクトはここを参照する（選択肢のハードコード禁止）。
 */
export function useCodeMaster() {
  const crud = useMasterCrudAsync('codeMaster', 'cm')

  function itemsOf(category: string): { value: string; label: string }[] {
    return crud.activeList.value
      .filter(i => i.category === category)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(i => ({ value: i.label, label: i.label }))
  }

  function labelOf(category: string, code: string): string {
    return crud.activeList.value.find(i => i.category === category && i.code === code)?.label ?? code
  }

  const categories = computed(() => {
    const set = new Set(crud.list.value.map(i => i.category))
    return [...set].sort()
  })

  return { ...crud, itemsOf, labelOf, categories }
}
