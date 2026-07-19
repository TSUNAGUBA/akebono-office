/**
 * ドキュメント管理（F-09-3）: フォルダツリー構築・横断検索・CRUD。
 *
 * デュアルモード（バッチ7l = 本実装。オペレーター指示 2026-07-19 #14）:
 * - モックモード: 従来どおり useMasterCrud('documents')（メタのみ・実バイナリなし）
 * - API モード: SoT は /v1/documents（メタ = documents テーブル・実体 = Cloud Storage / DB フォールバック）。
 *   実ファイルのアップロード・ダウンロード（署名 URL → base64 縮退）・Google ドライブ取込に対応。
 *   取込済みファイルは検索インデックス（search_docs）経由でチャットボット等の AI 参照対象になる
 * - 取消フロー（原則 9.5）: アーカイブ = 論理削除 → 復元可能（archivedFiles + restore）
 */
import type { Ref } from 'vue'
import type { DocumentNode, Result } from '~/types/domain'
import { irange } from '~/utils/rng'

export interface FolderRow {
  folder: DocumentNode
  depth: number
  hasChildren: boolean
  fileCount: number
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  sizeBytes: number | null
  modifiedTime: string
  webViewLink: string
  exportable: boolean
}

export interface DriveImportResult {
  imported: { id: string; name: string }[]
  failed: { fileId: string; name: string; reason: string }[]
}

// API モードのキャッシュ（SPA・モジュールスコープ単一）
const apiDocs = ref<DocumentNode[]>([])

function loadDocs(force = false): Promise<void> {
  return apiLoadOnce('documents', async () => {
    apiDocs.value = await apiFetch<DocumentNode[]>('/v1/documents')
  }, force)
}

onApiReset(() => {
  apiDocs.value = []
})

/** File → base64（アップロード用。FileReader は SSR 外の操作なのでクライアント前提） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s)
    }
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'))
    reader.readAsDataURL(file)
  })
}

export function useDocuments() {
  const crud = useMasterCrud('documents', 'doc')
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  if (isApi) void loadDocs()

  // 参照系は共通の射影ロジック（API モードはキャッシュ・モックは crud.list をバッキングに使う）
  const rows = isApi ? (apiDocs as Ref<DocumentNode[]>) : (crud.list as Ref<DocumentNode[]>)
  const activeRows = computed(() => rows.value.filter(d => d.active !== false))

  function byId(id: string): DocumentNode | undefined {
    return rows.value.find(d => d.id === id)
  }

  const activeFolders = computed(() => activeRows.value.filter(d => d.kind === 'folder'))
  const activeFiles = computed(() => activeRows.value.filter(d => d.kind === 'file'))
  /** アーカイブ済みファイル（復元 UI 用 = 原則 9.5） */
  const archivedFiles = computed(() =>
    rows.value.filter(d => d.kind === 'file' && d.active === false))

  function childFolders(parentId: string | null): DocumentNode[] {
    return activeFolders.value.filter(f => f.parentId === parentId)
  }

  /** フォルダを parentId で階層化し、深さ付きで平坦化する（開閉判定は呼び出し側） */
  const folderRows = computed<FolderRow[]>(() => {
    const rowsOut: FolderRow[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const f of childFolders(parentId)) {
        const children = childFolders(f.id)
        rowsOut.push({
          folder: f,
          depth,
          hasChildren: children.length > 0,
          fileCount: activeFiles.value.filter(x => x.parentId === f.id).length,
        })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return rowsOut
  })

  /** フォルダのフルパス表示（例: 議事録 / アケボノ商事 SCM 定例） */
  function folderPath(folderId: string | null): string {
    if (!folderId) return 'ルート'
    const names: string[] = []
    let cur = byId(folderId)
    let guard = 0
    while (cur && guard < 10) {
      names.unshift(cur.name)
      cur = cur.parentId ? byId(cur.parentId) : undefined
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

  // ---------- 書込系 ----------

  /** アップロード（モック: メタのみ。サイズは名前から決定的に生成する） */
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

  /** 実ファイルのアップロード（API モード。SoT へ書込 → キャッシュ取り直し = 原則6） */
  async function uploadFile(input: {
    file: File; parentId: string | null; tags: string[]; summary: string
  }): Promise<Result & { extracted?: boolean }> {
    if (input.file.size > 10 * 1024 * 1024) {
      return { ok: false, error: { code: 'AKO-DOC-004', message: 'ファイルが大きすぎます（10MB 以下にしてください）' } }
    }
    try {
      const contentBase64 = await fileToBase64(input.file)
      const data = await apiFetch<{ id: string; extracted: boolean }>('/v1/documents/files', {
        method: 'POST',
        body: {
          filename: input.file.name,
          contentBase64,
          mime: input.file.type || 'application/octet-stream',
          parentId: input.parentId,
          tags: input.tags,
          summary: input.summary.trim(),
        },
      })
      await loadDocs(true)
      return { ok: true, id: data.id, extracted: data.extracted }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  async function addFolder(name: string, parentId: string | null): Promise<Result> {
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: { code: 'AKO-DOC-002', message: 'フォルダ名を入力してください' } }
    if (isApi) {
      const res = await apiResult(() =>
        apiFetch<{ id: string }>('/v1/documents/folders', { method: 'POST', body: { name: trimmed, parentId } }))
      if (res.ok) await loadDocs(true)
      return res
    }
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

  /** 名称変更・タグ編集・概要編集・移動（更新者・更新日時を同時に記録） */
  async function updateFile(
    id: string, patch: Partial<Pick<DocumentNode, 'name' | 'tags' | 'summary' | 'parentId'>>,
  ): Promise<Result> {
    if (patch.name !== undefined && !patch.name.trim()) {
      return { ok: false, error: { code: 'AKO-DOC-001', message: 'ファイル名を入力してください' } }
    }
    if (isApi) {
      const res = await apiResult(() =>
        apiFetch(`/v1/documents/${id}`, { method: 'PATCH', body: patch }))
      if (res.ok) await loadDocs(true)
      return res
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

  /** アーカイブ（論理削除。復元可能 = 原則 9.5） */
  async function archiveDoc(id: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/documents/${id}/archive`, { method: 'POST' }))
      if (res.ok) await loadDocs(true)
      return res
    }
    return crud.archive(id)
  }

  /** 復元（取消フロー） */
  async function restoreDoc(id: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch(`/v1/documents/${id}/restore`, { method: 'POST' }))
      if (res.ok) await loadDocs(true)
      return res
    }
    return crud.restore(id)
  }

  // ---------- ダウンロード（API モード） ----------

  /**
   * ダウンロード。まず署名 URL（Cloud Storage・15 分有効）を試し、
   * フォールバック環境（DB 保管）は base64 を取得して Blob 保存する
   */
  async function downloadFile(id: string): Promise<Result> {
    if (!isApi) {
      return { ok: false, error: { code: 'AKO-DOC-008', message: 'モックモードではファイル本体を保持していません' } }
    }
    try {
      const { url } = await apiFetch<{ url: string | null }>(`/v1/documents/files/${id}/url`, { method: 'POST' })
      if (url) {
        window.open(url, '_blank', 'noopener')
        return { ok: true, id }
      }
      const data = await apiFetch<{ filename: string; mime: string; contentBase64: string }>(
        `/v1/documents/files/${id}`)
      const bin = Uint8Array.from(atob(data.contentBase64), ch => ch.charCodeAt(0))
      const blob = new Blob([bin], { type: data.mime || 'application/octet-stream' })
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = data.filename
      a.click()
      URL.revokeObjectURL(objectUrl)
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  // ---------- Google ドライブ連携（API モード） ----------

  async function driveStatus(): Promise<{ available: boolean; connected: boolean; driveScope: boolean }> {
    if (!isApi) return { available: false, connected: false, driveScope: false }
    try {
      return await apiFetch<{ available: boolean; connected: boolean; driveScope: boolean }>(
        '/v1/documents/drive/status')
    } catch {
      return { available: false, connected: false, driveScope: false }
    }
  }

  async function driveSearch(q: string): Promise<Result & { files?: DriveFile[] }> {
    try {
      const files = await apiFetch<DriveFile[]>('/v1/documents/drive/files', { query: q ? { q } : {} })
      return { ok: true, files }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e) }
    }
  }

  async function driveImport(fileIds: string[], parentId: string | null): Promise<Result & DriveImportResult> {
    try {
      const data = await apiFetch<DriveImportResult>('/v1/documents/drive/import', {
        method: 'POST', body: { fileIds, parentId },
      })
      await loadDocs(true)
      return { ok: true, ...data }
    } catch (e) {
      return { ok: false, error: apiErrorOf(e), imported: [], failed: [] }
    }
  }

  return {
    isApi,
    byId,
    activeFolders,
    activeFiles,
    archivedFiles,
    folderRows,
    folderPath,
    filesIn,
    searchFiles,
    addFile,
    uploadFile,
    addFolder,
    updateFile,
    archive: archiveDoc,
    restore: restoreDoc,
    downloadFile,
    driveStatus,
    driveSearch,
    driveImport,
  }
}
