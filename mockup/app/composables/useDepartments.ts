/**
 * 部署（F-10-9）: 参照ヘルパーと組織図ツリーの導出
 * - CRUD は useMasterCrud('departments') が唯一の書込経路（部署マスタ画面）
 * - メンバーの所属は Member.departmentId が SoT。組織図は departments 階層 + 所属から導出する
 */
import type { Department, Member } from '~/types/domain'

export interface DeptNode {
  dept: Department
  manager: Member | null
  members: Member[]
  children: DeptNode[]
}

export function useDepartments() {
  const { tbl } = useMockDb()
  const departments = tbl('departments')
  const members = tbl('members')

  const activeDepartments = computed(() =>
    departments.value
      .filter(d => d.active)
      .sort((a, b) => a.displayOrder - b.displayOrder))

  /** セレクト用オプション（階層をインデントで表現） */
  const options = computed(() => {
    const result: { value: string; label: string }[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const d of activeDepartments.value.filter(x => x.parentId === parentId)) {
        result.push({ value: d.id, label: `${'　'.repeat(depth)}${d.name}` })
        walk(d.id, depth + 1)
      }
    }
    walk(null, 0)
    return result
  })

  function nameOf(departmentId: string): string {
    return departments.value.find(d => d.id === departmentId)?.name ?? '未所属'
  }

  /** 部署の所属メンバー（在籍のみ・責任者を先頭に） */
  function membersOf(departmentId: string): Member[] {
    const managerId = departments.value.find(d => d.id === departmentId)?.managerId
    return members.value
      .filter(m => m.active && m.departmentId === departmentId)
      .sort((a, b) => Number(b.id === managerId) - Number(a.id === managerId) || a.id.localeCompare(b.id))
  }

  /**
   * 組織図ツリー（有効な部署のみ）。親が無効化された部署はトップレベルに繰り上げて
   * 表示から漏らさない（マスタ操作でツリーが壊れても全部署が見える防御）。
   */
  const tree = computed<DeptNode[]>(() => {
    const actives = activeDepartments.value
    const ids = new Set(actives.map(d => d.id))
    const nodeOf = (d: Department): DeptNode => ({
      dept: d,
      manager: members.value.find(m => m.id === d.managerId && m.active) ?? null,
      members: membersOf(d.id),
      children: actives.filter(c => c.parentId === d.id).map(nodeOf),
    })
    return actives
      .filter(d => d.parentId === null || !ids.has(d.parentId))
      .map(nodeOf)
  })

  return { departments, activeDepartments, options, nameOf, membersOf, tree }
}
