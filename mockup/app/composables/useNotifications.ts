/**
 * 通知（発行・既読・バッジ数）
 * - モックモード: 従来どおり useMockDb（発行は補助処理・非ブロッキング。開発原則 4）
 * - API モード: SoT は /v1/notifications。発行はサーバー側（休暇・打刻修正・日報等の各 API が発火）のため
 *   クライアントの notify/notifyAdmins は no-op。未接続のモックドメイン（ワークフロー等）からの通知は
 *   API 化まで表示されない（implementation-status.md に明記）。60 秒ごとにポーリングして新着を反映する。
 */
import type { Ref } from 'vue'
import type { AppNotification, NotificationKind } from '~/types/domain'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiNotes = ref<AppNotification[]>([])
let notesLoaded = false
let notesInflight: Promise<void> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 60_000

async function loadNotifications(force = false): Promise<void> {
  if (!force && (notesLoaded || notesInflight)) return notesInflight ?? undefined
  notesInflight = apiFetch<AppNotification[]>('/v1/notifications')
    .then((rows) => {
      apiNotes.value = rows
      notesLoaded = true
    })
    .catch(() => { /* 未認証等は空のまま（ログイン後の再取得はポーリングが拾う） */ })
    .finally(() => { notesInflight = null })
  return notesInflight
}

function startPolling(): void {
  if (pollTimer || !import.meta.client) return
  pollTimer = setInterval(() => { void loadNotifications(true) }, POLL_INTERVAL_MS)
}

// ログイン確立・切替時に取り直す
onApiReset(() => {
  notesLoaded = false
  void loadNotifications(true)
})

export function useNotifications() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUserId } = useCurrentUser()

  // ---------- API モード ----------
  if (useApiMode()) {
    void loadNotifications()
    startPolling()
    const mine = computed(() => apiNotes.value) as Ref<AppNotification[]>
    const unreadCount = computed(() => apiNotes.value.filter(n => !n.read).length)

    /** API モードの発行はサーバー側の責務（未接続ドメインからの呼び出しは no-op） */
    function notify(_memberId: string, _kind: NotificationKind, _title: string, _body: string, _link: string): void {
      // no-op（発火元ドメインの API 接続時にサーバー発火へ移行する）
    }

    function notifyAdmins(_kind: NotificationKind, _title: string, _body: string, _link: string): void {
      // no-op（同上）
    }

    async function markRead(id: string): Promise<void> {
      try {
        await apiFetch(`/v1/notifications/${id}/read`, { method: 'POST' })
        apiNotes.value = apiNotes.value.map(n => n.id === id ? { ...n, read: true } : n)
      } catch { /* 失敗時は未読のまま（非ブロッキング） */ }
    }

    async function markAllRead(): Promise<void> {
      try {
        await apiFetch('/v1/notifications/read-all', { method: 'POST' })
        apiNotes.value = apiNotes.value.map(n => ({ ...n, read: true }))
      } catch { /* 失敗時はそのまま */ }
    }

    return {
      mine, unreadCount, notify, notifyAdmins,
      markRead, markAllRead, refresh: () => loadNotifications(true),
    }
  }

  // ---------- モックモード（従来どおり） ----------
  const notifications = tbl('notifications')

  const mine = computed(() =>
    notifications.value
      .filter(n => n.memberId === currentUserId.value)
      .sort((a, b) => b.at.localeCompare(a.at)),
  )

  const unreadCount = computed(() => mine.value.filter(n => !n.read).length)

  /** 通知を発行する（対象メンバーへ）。主フローを止めないため例外を投げない */
  function notify(memberId: string, kind: NotificationKind, title: string, body: string, link: string): void {
    try {
      notifications.value = [...notifications.value, {
        id: nextId('notifications', 'nt'),
        memberId, kind, title, body, link,
        read: false,
        at: nowJstIso(),
      }]
      commit()
    } catch {
      // 通知失敗は握りつぶす（補助処理）
    }
  }

  /** 管理者全員へ通知する */
  function notifyAdmins(kind: NotificationKind, title: string, body: string, link: string): void {
    const members = tbl('members')
    for (const m of members.value.filter(x => x.active && x.role === 'admin')) {
      notify(m.id, kind, title, body, link)
    }
  }

  async function markRead(id: string): Promise<void> {
    notifications.value = notifications.value.map(n => n.id === id ? { ...n, read: true } : n)
    commit()
  }

  async function markAllRead(): Promise<void> {
    notifications.value = notifications.value.map(n =>
      n.memberId === currentUserId.value ? { ...n, read: true } : n)
    commit()
  }

  return { mine, unreadCount, notify, notifyAdmins, markRead, markAllRead, refresh: async () => {} }
}
