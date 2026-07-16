/**
 * 汎用マスタ CRUD（全マスタ画面が共用する唯一の書込経路）
 * - 論理削除のみ（active=false）。物理削除しない
 * - 変更は監査ログへ記録（補助処理・非ブロッキング）
 */
import type { MockDbShape } from '~/data/seed'
import type { Result } from '~/types/domain'

interface BaseEntity {
  id: string
  active?: boolean
}

type MasterCollections = {
  [K in keyof MockDbShape]: MockDbShape[K] extends BaseEntity[] ? K : never
}[keyof MockDbShape]

export function useMasterCrud<K extends MasterCollections>(name: K, idPrefix: string) {
  type Row = MockDbShape[K][number] & BaseEntity
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const rows = tbl(name)

  const list = computed(() => rows.value as Row[])
  const activeList = computed(() => (rows.value as Row[]).filter(r => r.active !== false))

  function byId(id: string): Row | undefined {
    return (rows.value as Row[]).find(r => r.id === id)
  }

  function audit(action: string, entityId: string, detail: string): void {
    try {
      const logs = tbl('auditLogs')
      logs.value = [...logs.value, {
        id: nextId('auditLogs', 'aud'),
        actorId: currentUser.value.id,
        action,
        entity: String(name),
        entityId,
        detail,
        at: nowJstIso(),
      }]
    } catch {
      // 監査ログ失敗は主フローを止めない
    }
  }

  /** 追加 or 更新（id があれば更新）。バリデーションは呼び出し側の責務 */
  function save(entity: Partial<Row> & { id?: string }): Result {
    const all = rows.value as Row[]
    if (entity.id) {
      const idx = all.findIndex(r => r.id === entity.id)
      if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
      const updated = { ...all[idx], ...entity } as Row
      rows.value = [...all.slice(0, idx), updated, ...all.slice(idx + 1)] as MockDbShape[K]
      audit('update', entity.id, `${String(name)} を更新`)
      commit()
      return { ok: true, id: entity.id }
    }
    const id = nextId(name, idPrefix)
    const created = { active: true, ...entity, id } as Row
    rows.value = [...all, created] as MockDbShape[K]
    audit('create', id, `${String(name)} を追加`)
    commit()
    return { ok: true, id }
  }

  /** 論理削除（無効化） */
  function archive(id: string): Result {
    const all = rows.value as Row[]
    const idx = all.findIndex(r => r.id === id)
    if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    const updated = { ...all[idx], active: false } as Row
    rows.value = [...all.slice(0, idx), updated, ...all.slice(idx + 1)] as MockDbShape[K]
    // 監査ログは commit 前に追記する（commit 後だとリロードで監査証跡だけが消える）
    audit('archive', id, `${String(name)} を無効化`)
    commit()
    return { ok: true, id }
  }

  /** 再有効化 */
  function restore(id: string): Result {
    const all = rows.value as Row[]
    const idx = all.findIndex(r => r.id === id)
    if (idx < 0) return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    const updated = { ...all[idx], active: true } as Row
    rows.value = [...all.slice(0, idx), updated, ...all.slice(idx + 1)] as MockDbShape[K]
    audit('restore', id, `${String(name)} を再有効化`)
    commit()
    return { ok: true, id }
  }

  return { list, activeList, byId, save, archive, restore }
}
