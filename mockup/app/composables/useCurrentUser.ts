/**
 * 擬似ログイン（デモ用ユーザー切替）
 * 本番では SSO（Google Workspace）の Provider に差し替える。
 */
import type { Member } from '~/types/domain'

const STORAGE_KEY = 'ako.currentUser.v1'
const DEFAULT_USER_ID = 'm-03' // 管理者（マネージャー）を既定にして全機能を見せる

export function useCurrentUser() {
  const { tbl } = useMockDb()
  const members = tbl('members')

  const currentUserId = useState<string>('ako-current-user', () => {
    if (import.meta.client) {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) return saved
      } catch { /* noop */ }
    }
    return DEFAULT_USER_ID
  })

  const currentUser = computed<Member>(() => {
    return members.value.find(m => m.id === currentUserId.value)
      ?? members.value.find(m => m.id === DEFAULT_USER_ID)
      ?? members.value[0]!
  })

  const isAdmin = computed(() => currentUser.value.role === 'admin')

  /** 切替可能なデモユーザー（外注以外の在籍者） */
  const switchableUsers = computed(() =>
    members.value.filter(m => m.active && m.employmentType !== 'outsource'),
  )

  function switchUser(id: string): void {
    if (!members.value.some(m => m.id === id)) return
    currentUserId.value = id
    if (import.meta.client) {
      try { localStorage.setItem(STORAGE_KEY, id) } catch { /* noop */ }
    }
  }

  return { currentUser, currentUserId, isAdmin, switchableUsers, switchUser }
}
