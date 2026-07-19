/**
 * ノート（ぽいぽいメモ / 議事録。バッチ7c・オペレーター指示 2026-07-19 #4）
 * - poipoi = 本人メモ（本人のみ参照 = C3）/ minutes = 議事録（全員参照 = C2）。記録系 = 追記のみ
 * - プロジェクト・顧客・業務種別は任意の紐付け
 * - デュアルモード: API = /v1/notes（SoT。AI 検索インデックスへ自動反映）/ モック = notes コレクション
 * - アップロード（.md/.txt/.pdf/.docx）は API モードのみ（抽出はサーバー。モックは .md/.txt をクライアント読取）
 */
import type { Note, NoteKind, Result } from '~/types/domain'

const apiNotes = ref<Record<string, Note[]>>({})

function loadNotes(kind: NoteKind, force = false): Promise<void> {
  return apiLoadOnce(`notes:${kind}`, async () => {
    const rows = await apiFetch<Note[]>('/v1/notes', { query: { kind } })
    apiNotes.value = { ...apiNotes.value, [kind]: rows }
  }, force)
}

onApiReset(() => {
  apiNotes.value = {}
})

export interface NoteInput {
  kind: NoteKind
  title: string
  body: string
  projectId: string | null
  companyId: string | null
  workCategoryId: string | null
}

export function useNotes(kind: NoteKind) {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const mockNotes = tbl('notes')
  if (isApi) void loadNotes(kind)

  /** 一覧（新しい順。poipoi は本人のみ） */
  const list = computed<Note[]>(() => {
    if (isApi) return apiNotes.value[kind] ?? []
    return (mockNotes.value as Note[])
      .filter(n => n.kind === kind && (kind === 'minutes' || n.memberId === currentUser.value.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })

  /** テキスト登録 */
  async function add(input: Omit<NoteInput, 'kind'>): Promise<Result> {
    const body = input.body.trim()
    if (!body) return { ok: false, error: { code: 'AKO-GEN-001', message: '本文を入力してください' } }
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/notes', { method: 'POST', body: { ...input, kind } }))
      if (res.ok) await loadNotes(kind, true)
      return res
    }
    const id = nextId('notes', 'nt')
    mockNotes.value = [...(mockNotes.value as Note[]), {
      id,
      memberId: currentUser.value.id,
      kind,
      title: input.title.trim() || ([...body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).filter(Boolean)][0] ?? 'メモ').slice(0, 40),
      body,
      projectId: input.projectId,
      companyId: input.companyId,
      workCategoryId: input.workCategoryId,
      source: 'text',
      createdAt: nowJstIso(),
    }]
    commit()
    return { ok: true, id }
  }

  /** ドキュメント取込（API = サーバー抽出（.md/.txt/.pdf/.docx）/ モック = .md/.txt のみクライアント読取） */
  async function importFile(file: File, meta: Omit<NoteInput, 'kind' | 'body'>): Promise<Result> {
    if (file.size > 10 * 1024 * 1024) {
      return { ok: false, error: { code: 'AKO-NOTE-002', message: 'ファイルは 10MB 以下にしてください' } }
    }
    if (isApi) {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const res = await apiResult(() => apiFetch('/v1/notes/import', {
        method: 'POST',
        body: { ...meta, kind, filename: file.name, contentBase64: btoa(bin) },
      }))
      if (res.ok) await loadNotes(kind, true)
      return res
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'md' && ext !== 'txt') {
      return { ok: false, error: { code: 'AKO-NOTE-001', message: 'モックモードは .md / .txt のみ対応です（.pdf / .docx は API モードで）' } }
    }
    const text = (await file.text()).trim()
    if (!text) return { ok: false, error: { code: 'AKO-NOTE-003', message: 'ファイルからテキストを抽出できませんでした' } }
    return add({ ...meta, title: meta.title || file.name.replace(/\.[^.]+$/, ''), body: text })
  }

  async function refresh(): Promise<void> {
    if (isApi) await loadNotes(kind, true)
  }

  return { list, add, importFile, refresh }
}
