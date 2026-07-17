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
      // API モードでは監査ログの SoT はサーバー（audit_logs）。モック書込でキャッシュを汚さない
      if (useApiMode()) return
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

  /** 物理削除（関係エッジ専用の例外。data-design §1.1 の設計判断。監査ログ必須） */
  function remove(id: string): Result {
    const all = rows.value as Row[]
    if (!all.some(r => r.id === id)) {
      return { ok: false, error: { code: 'AKO-GEN-002', message: '対象が見つかりません' } }
    }
    rows.value = all.filter(r => r.id !== id) as MockDbShape[K]
    audit('delete', id, `${String(name)} を物理削除（関係エッジ）`)
    commit()
    return { ok: true, id }
  }

  return { list, activeList, byId, save, archive, restore, remove }
}

// ---------- API 対応の非同期版（バッチ2a: マスタ・設定画面が使用） ----------

export interface MasterCrudAsync<Row extends BaseEntity> {
  list: ComputedRef<Row[]>
  activeList: ComputedRef<Row[]>
  byId: (id: string) => Row | undefined
  save: (entity: Partial<Row> & { id?: string }) => Promise<Result>
  archive: (id: string) => Promise<Result>
  restore: (id: string) => Promise<Result>
  /** 物理削除（関係エッジ専用） */
  remove: (id: string) => Promise<Result>
}

/**
 * useMasterCrud の非同期・デュアルモード版。
 * - モックモード: 従来の同期実装を Promise で包むだけ（挙動不変）
 * - API モード（マイグレーション済みコレクション）: /v1/masters/* を呼び、レスポンスで
 *   キャッシュを更新する（SoT 書込 → キャッシュ反映の順序。原則6）。バリデーション・
 *   ガード（循環・法定有給保護等）はサーバーが担い、エラーは Result で返る（画面 I/F 不変）
 * 未移行コレクション（documents / workflowRoutes 等）は API モードでも従来のモック実装で動く。
 */
export function useMasterCrudAsync<K extends MasterCollections>(name: K, idPrefix: string):
MasterCrudAsync<MockDbShape[K][number] & BaseEntity> {
  type Row = MockDbShape[K][number] & BaseEntity
  const sync = useMasterCrud(name, idPrefix)
  if (!(useApiMode() && isMigratedCollection(name as string))) {
    return {
      list: sync.list as ComputedRef<Row[]>,
      activeList: sync.activeList as ComputedRef<Row[]>,
      byId: sync.byId,
      save: async e => sync.save(e),
      archive: async id => sync.archive(id),
      restore: async id => sync.restore(id),
      remove: async id => sync.remove(id),
    }
  }

  const entity = apiEntityOf(name as string)
  const rows = apiCollection<Row>(name as string)
  const list = computed(() => rows.value)
  const activeList = computed(() => rows.value.filter(r => r.active !== false))

  function byId(id: string): Row | undefined {
    return rows.value.find(r => r.id === id)
  }

  return {
    list,
    activeList,
    byId,
    save: e => apiResult(async () => {
      const { id, ...body } = e
      const saved = id
        ? await apiFetch<Row & { id: string }>(`/v1/masters/${entity}/${id}`, { method: 'PATCH', body })
        : await apiFetch<Row & { id: string }>(`/v1/masters/${entity}`, { method: 'POST', body })
      setApiRow(name as string, saved)
      return saved
    }),
    archive: id => apiResult(async () => {
      await apiFetch(`/v1/masters/${entity}/${id}/archive`, { method: 'POST' })
      patchApiRow(name as string, id, { active: false })
      return { id }
    }),
    restore: id => apiResult(async () => {
      await apiFetch(`/v1/masters/${entity}/${id}/restore`, { method: 'POST' })
      patchApiRow(name as string, id, { active: true })
      return { id }
    }),
    remove: id => apiResult(async () => {
      await apiFetch(`/v1/masters/${entity}/${id}`, { method: 'DELETE' })
      removeApiRow(name as string, id)
      return { id }
    }),
  }
}
