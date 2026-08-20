/**
 * Google スプレッドシート取込の連携（データ取込・連携 F-32 の取込元方式 sheets_pull。オペレーター指示 2026-08-03）。
 * カレンダー / GA と同じデュアルモード:
 * - API モード: /v1/akebono/sheets/*（OAuth 実連携・Drive/Sheets 実 API）。connect はフルリダイレクト。
 * - モックモード: 疑似同意（即接続）+ 決定的なダミーのブック/シート/列を返す（実 Google 通信なし）。
 * 接続状態はテナント単位の単一接続（サーバは sheets_tokens id='default'）。設定・接続は管理者運用。
 */

/** モックの疑似ブック（決定的） */
const MOCK_SPREADSHEETS = [
  { id: 'mock-sheet-sales', name: '売上実績_2026' },
  { id: 'mock-sheet-products', name: '商品マスタ台帳' },
  { id: 'mock-sheet-inventory', name: '在庫棚卸' },
]
const MOCK_TABS: Record<string, string[]> = {
  'mock-sheet-sales': ['明細', '集計'],
  'mock-sheet-products': ['商品', '廃番'],
  'mock-sheet-inventory': ['棚卸結果'],
}
/** 疑似の列（ヘッダ行）。取込元の左辺候補として使う（右辺 = アプリ項目は useAppFields） */
const MOCK_COLUMNS: Record<string, string[]> = {
  'mock-sheet-sales': ['売上日', '得意先', 'セグメント', 'SKU', '数量', '単価', 'チャネル'],
  'mock-sheet-products': ['商品コード', '商品名', 'セグメント', 'カテゴリ', '定価', '標準原価', '課金区分'],
  'mock-sheet-inventory': ['SKU', '倉庫', '増減数', '区分', '理由', '発生日'],
}

export interface SheetsStatus { enabled: boolean; connected: boolean }

export function useSheetsImport() {
  const isApi = useApiMode()
  const toast = useToast()
  const { currentUser } = useCurrentUser()

  // モックの疑似接続フラグ（端末内・SSR 安全）。API モードでは status を都度取得する
  const mockConnected = useState('ako-sheets-connected', () => false)
  const apiStatus = useState<SheetsStatus | null>('ako-sheets-status', () => null)

  const isAdmin = computed(() => currentUser.value.role === 'admin')

  async function refreshStatus(): Promise<SheetsStatus> {
    if (!isApi) return { enabled: true, connected: mockConnected.value }
    try {
      apiStatus.value = await apiFetch<SheetsStatus>('/v1/akebono/sheets/status')
    } catch {
      apiStatus.value = { enabled: false, connected: false }
    }
    return apiStatus.value
  }

  const status = computed<SheetsStatus>(() =>
    isApi ? (apiStatus.value ?? { enabled: false, connected: false }) : { enabled: true, connected: mockConnected.value })

  /** 連携開始（API = 同意画面へフルリダイレクト / モック = 疑似同意で即接続） */
  async function connect(): Promise<void> {
    if (!isApi) {
      mockConnected.value = true
      toast.show('Google スプレッドシートに連携しました（デモ）', 'ok')
      return
    }
    try {
      const { url } = await apiFetch<{ url: string }>('/v1/akebono/sheets/oauth/url')
      if (import.meta.client) window.location.href = url
    } catch (e) {
      toast.show(`連携 URL の取得に失敗しました（${(e as Error).message}）`, 'crit')
    }
  }

  async function disconnect(): Promise<void> {
    if (!isApi) { mockConnected.value = false; toast.show('連携を解除しました', 'ok'); return }
    try {
      await apiFetch('/v1/akebono/sheets/disconnect', { method: 'POST' })
      await refreshStatus()
      toast.show('連携を解除しました', 'ok')
    } catch (e) {
      toast.show(`解除に失敗しました（${(e as Error).message}）`, 'crit')
    }
  }

  /** 対象スプレッドシートの検索・一覧 */
  async function listSpreadsheets(q = ''): Promise<{ id: string; name: string }[]> {
    if (!isApi) {
      const kw = q.trim()
      return MOCK_SPREADSHEETS.filter(s => !kw || s.name.includes(kw))
    }
    return apiFetch<{ id: string; name: string }[]>('/v1/akebono/sheets/spreadsheets', { query: q ? { q } : {} })
  }

  /** 選択ブックのシート（タブ）一覧 */
  async function listTabs(spreadsheetId: string): Promise<string[]> {
    if (!isApi) return MOCK_TABS[spreadsheetId] ?? ['Sheet1']
    return apiFetch<string[]>(`/v1/akebono/sheets/spreadsheets/${encodeURIComponent(spreadsheetId)}/tabs`)
  }

  /** 開始行/列を指定して列定義（ヘッダ行の各セル）を取得 */
  async function detectColumns(spreadsheetId: string, sheet: string, headerRow: number, startColumn: string): Promise<string[]> {
    if (!isApi) return MOCK_COLUMNS[spreadsheetId] ?? ['列1', '列2', '列3']
    return apiFetch<string[]>(`/v1/akebono/sheets/spreadsheets/${encodeURIComponent(spreadsheetId)}/columns`, {
      query: { sheet, headerRow: String(headerRow), startColumn },
    })
  }

  return { status, isAdmin, refreshStatus, connect, disconnect, listSpreadsheets, listTabs, detectColumns }
}
