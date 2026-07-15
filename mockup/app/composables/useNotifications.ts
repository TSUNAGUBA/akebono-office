/**
 * 通知（発行・既読・バッジ数）
 * 発行は補助処理: 失敗しても呼び出し元の主フローを止めない（開発原則 4）。
 */
import type { AppNotification, NotificationKind } from '~/types/domain'

export function useNotifications() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUserId } = useCurrentUser()
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
        at: new Date().toISOString(),
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

  function markRead(id: string): void {
    notifications.value = notifications.value.map(n => n.id === id ? { ...n, read: true } : n)
    commit()
  }

  function markAllRead(): void {
    notifications.value = notifications.value.map(n =>
      n.memberId === currentUserId.value ? { ...n, read: true } : n)
    commit()
  }

  return { mine, unreadCount, notify, notifyAdmins, markRead, markAllRead }
}
