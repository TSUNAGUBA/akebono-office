/**
 * ドキュメント管理（F-09-3）: フォルダツリー構築・横断検索・CRUD。
 * 書込は useMasterCrud('documents') に集約（論理削除 + 監査ログを既存パターンで踏襲）。
 * DocumentNode 型に active は無いが、useMasterCrud の BaseEntity（active?: boolean）で
 * 論理削除フラグを付与する（アーカイブ = active:false。物理削除しない）。
 */
import type { DocumentNode, Result } from '~/types/domain'
import { irange } from '~/utils/rng'

export interface FolderRow {
  folder: DocumentNode
  depth: number
  hasChildren: boolean
  fileCount: number
}

export function useDocuments() {
  const crud = useMasterCrud('documents', 'doc')
  const { currentUser } = useCurrentUser()

  const activeFolders = computed(() => crud.activeList.value.filter(d => d.kind === 'folder'))
  const activeFiles = computed(() => crud.activeList.value.filter(d => d.kind === 'file'))

  function childFolders(parentId: string | null): DocumentNode[] {
    return activeFolders.value.filter(f => f.parentId === parentId)
  }

  /** フォルダを parentId で階層化し、深さ付きで平坦化する（開閉判定は呼び出し側） */
  const folderRows = computed<FolderRow[]>(() => {
    const rows: FolderRow[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const f of childFolders(parentId)) {
        const children = childFolders(f.id)
        rows.push({
          folder: f,
          depth,
          hasChildren: children.length > 0,
          fileCount: activeFiles.value.filter(x => x.parentId === f.id).length,
        })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return rows
  })

  /** フォルダのフルパス表示（例: 議事録 / アケボノ商事 SCM 定例） */
  function folderPath(folderId: string | null): string {
    if (!folderId) return 'ルート'
    const names: string[] = []
    let cur = crud.byId(folderId)
    let guard = 0
    while (cur && guard < 10) {
      names.unshift(cur.name)
      cur = cur.parentId ? crud.byId(cur.parentId) : undefined
      guard++
    }
    return names.join(' / ')
  }

  /** フォルダ直下のファイル一覧（folderId=null で全件） */
  function filesIn(folderId: string | null): DocumentNode[] {
    const list = folderId ? activeFiles.value.filter(f => f.parentId === folderId) : activeFiles.value
    return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 名前・タグ・summary の横断検索 + タグフィルタ（検索時はツリー選択を無視して全体検索） */
  function searchFiles(query: string, tags: string[]): DocumentNode[] {
    const q = query.trim().toLowerCase()
    return filesIn(null).filter((f) => {
      if (tags.length > 0 && !tags.some(t => f.tags.includes(t))) return false
      if (!q) return true
      return f.name.toLowerCase().includes(q)
        || f.summary.toLowerCase().includes(q)
        || f.tags.some(t => t.toLowerCase().includes(q))
    })
  }

  /** アップロード（モック）。サイズは名前から決定的に生成する */
  function addFile(input: { name: string; parentId: string | null; tags: string[]; summary: string }): Result {
    const name = input.name.trim()
    if (!name) return { ok: false, error: { code: 'AKO-DOC-001', message: 'ファイル名を入力してください' } }
    const kb = irange(`docsize:${name}`, 120, 5200)
    return crud.save({
      parentId: input.parentId,
      kind: 'file',
      name,
      tags: input.tags,
      updatedAt: nowJstIso(),
      updatedBy: currentUser.value.id,
      size: kb >= 1000 ? `${(kb / 1000).toFixed(1)}MB` : `${kb}KB`,
      summary: input.summary.trim(),
    })
  }

  function addFolder(name: string, parentId: string | null): Result {
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: { code: 'AKO-DOC-002', message: 'フォルダ名を入力してください' } }
    if (childFolders(parentId).some(f => f.name === trimmed)) {
      return { ok: false, error: { code: 'AKO-DOC-003', message: '同名のフォルダが既にあります' } }
    }
    return crud.save({
      parentId,
      kind: 'folder',
      name: trimmed,
      tags: [],
      updatedAt: nowJstIso(),
      updatedBy: currentUser.value.id,
      size: null,
      summary: '',
    })
  }

  /** 名称変更・タグ編集・概要編集（更新者・更新日時を同時に記録） */
  function updateFile(id: string, patch: Partial<Pick<DocumentNode, 'name' | 'tags' | 'summary' | 'parentId'>>): Result {
    if (patch.name !== undefined && !patch.name.trim()) {
      return { ok: false, error: { code: 'AKO-DOC-001', message: 'ファイル名を入力してください' } }
    }
    // undefined のキーで既存値を潰さないよう、指定されたキーのみ明示的に組み立てる
    const clean: Partial<DocumentNode> & { id: string } = {
      id,
      updatedAt: nowJstIso(),
      updatedBy: currentUser.value.id,
    }
    if (patch.name !== undefined) clean.name = patch.name.trim()
    if (patch.tags !== undefined) clean.tags = patch.tags
    if (patch.summary !== undefined) clean.summary = patch.summary
    if (patch.parentId !== undefined) clean.parentId = patch.parentId
    return crud.save(clean)
  }

  return {
    ...crud,
    activeFolders,
    activeFiles,
    folderRows,
    folderPath,
    filesIn,
    searchFiles,
    addFile,
    addFolder,
    updateFile,
  }
}
