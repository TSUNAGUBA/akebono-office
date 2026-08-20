/**
 * 議事録の Google Meet 連携（AI メモ/録画リンク。オペレーター指示 2026-08-03 ③b）。
 * ドキュメント管理の「ドライブから取込」と同型で **API モード限定**（実 Google Drive 連携が必要なため）。
 * 連携認証は AI アシスタントのカレンダー連携（drive.readonly スコープを含む）を再利用する
 * （別途の connect は持たない = documents のドライブ取込と同じ導線）。モックモードは available=false で UI を隠す。
 * サーバ: /v1/notes/meet/*（status / folders / files / file-text / default-folder）。
 */
import type { Result } from '~/types/domain'

export interface MeetStatus {
  available: boolean
  connected: boolean
  driveScope: boolean
  defaultFolder: { id: string; name: string } | null
}
export interface MeetFolder { id: string; name: string }
export interface MeetFile {
  id: string; name: string; mimeType: string; webViewLink: string; modifiedTime: string
  fileKind: 'notes' | 'recording' | 'other'
}

export function useMeetLink() {
  const isApi = useApiMode()
  const toast = useToast()
  const { currentUser } = useCurrentUser()

  const status = useState<MeetStatus | null>('notes-meet-status', () => null)
  const isAdmin = computed(() => currentUser.value.role === 'admin')

  /** 連携状態を取得（モックは available=false = UI 非表示。documents のドライブ取込と同じ扱い） */
  async function refreshStatus(): Promise<MeetStatus> {
    if (!isApi) {
      status.value = { available: false, connected: false, driveScope: false, defaultFolder: null }
      return status.value
    }
    try {
      status.value = await apiFetch<MeetStatus>('/v1/notes/meet/status')
    } catch {
      status.value = { available: false, connected: false, driveScope: false, defaultFolder: null }
    }
    return status.value
  }

  /** 保管フォルダの一覧（既定の設定・連携先の変更用） */
  async function listFolders(q = ''): Promise<MeetFolder[]> {
    if (!isApi) return []
    return apiFetch<MeetFolder[]>('/v1/notes/meet/folders', { query: q ? { q } : {} })
  }

  /** 選択フォルダ内のファイル一覧（folderId 未指定はサーバ側で既定フォルダを使用） */
  async function listFiles(folderId?: string, q = ''): Promise<MeetFile[]> {
    if (!isApi) return []
    const query: Record<string, string> = {}
    if (folderId) query.folderId = folderId
    if (q) query.q = q
    return apiFetch<MeetFile[]>('/v1/notes/meet/files', { query })
  }

  /** AI メモ（Google ドキュメント）の本文テキストを取得（議事録本文へ取り込む材料） */
  async function fetchFileText(fileId: string): Promise<string> {
    if (!isApi) return ''
    const { text } = await apiFetch<{ text: string }>('/v1/notes/meet/file-text', { query: { fileId } })
    return text
  }

  /** 既定の保管フォルダを設定/クリア（管理者のみ。id 空でクリア）。成功で status を更新 */
  async function setDefaultFolder(folder: { id: string; name: string } | null): Promise<Result> {
    if (!isApi) return { ok: false, error: { code: 'AKO-GEN-001', message: 'API モードでのみ設定できます' } }
    try {
      await apiFetch('/v1/notes/meet/default-folder', { method: 'PUT', body: folder ?? { id: '', name: '' } })
      await refreshStatus()
      toast.show(folder ? '既定の保管フォルダを設定しました' : '既定フォルダをクリアしました', 'ok')
      return { ok: true }
    } catch (e) {
      toast.show(`既定フォルダの設定に失敗しました（${(e as Error).message}）`, 'crit')
      return { ok: false, error: { code: 'AKO-GEN-002', message: (e as Error).message } }
    }
  }

  return { status, isAdmin, refreshStatus, listFolders, listFiles, fetchFileText, setDefaultFolder }
}
