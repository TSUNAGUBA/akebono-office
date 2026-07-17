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

  // ---------- API モード: /v1/me（Firebase or dev 認証）が正 ----------
  if (useApiMode()) {
    const me = useApiMe()
    const currentUserId = computed(() => me.value?.id ?? '')
    const currentUser = computed<Member>(() => {
      const found = members.value.find(m => m.id === me.value?.id)
      if (found) return found
      // メンバーキャッシュ未ロード時のフォールバック（/v1/me の情報から合成）
      return {
        id: me.value?.id ?? '',
        name: me.value?.name ?? '',
        email: me.value?.email ?? '',
        employmentType: 'employee',
        departmentId: '',
        title: '',
        role: me.value?.role ?? 'member',
        hireDate: '',
        weeklyDays: 5,
        weeklyHours: 40,
        punchRequired: true,
        googleCalendarConnected: false,
        attendanceRuleId: null,
        birthDate: null,
        active: true,
        custom: {},
      } as unknown as Member
    })
    const isAdmin = computed(() => me.value?.role === 'admin')
    const isHrOrAdmin = computed(() => me.value?.role === 'admin' || me.value?.role === 'hr')
    // 実認証のためユーザー切替（デモ機能）は無効
    const switchableUsers = computed<Member[]>(() => [])
    const switchUser = (_id: string): void => { /* API モードでは切替不可 */ }
    return { currentUser, currentUserId, isAdmin, isHrOrAdmin, switchableUsers, switchUser }
  }

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
  /** 人事ロール（タイムカード・休暇管理・休暇付与の権限。管理者は常に含む） */
  const isHrOrAdmin = computed(() =>
    currentUser.value.role === 'admin' || currentUser.value.role === 'hr')

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

  return { currentUser, currentUserId, isAdmin, isHrOrAdmin, switchableUsers, switchUser }
}
