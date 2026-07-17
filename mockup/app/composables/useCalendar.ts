/**
 * カレンダー連携（F-06-8）
 * - source='google' の予定は Google が SoT（本アプリはキャッシュ）。同期で upsert、アプリ側からは編集・削除しない
 * - source='app' の予定は本アプリが SoT。pushToGoogle で Google へ反映（モックではフラグ更新+トースト）
 * - 同期はべき等: 決定的 id（gcal-…）による upsert で、再実行してもアプリ発予定・ヒアリングログを壊さない
 *
 * デュアルモード（バッチ3e）:
 * - API モード: SoT は /v1/calendar（トークンはサーバーで暗号化保管）。connect は Google OAuth 2.0 の
 *   同意画面へのフルリダイレクト（復帰は ?calendar=connected / error クエリ）。
 *   予定は日付キーの遅延ロードキャッシュ。enabled=false（OAuth 未設定）のときは連携 UI 自体を出さない
 */
import type { CalendarEvent, Result } from '~/types/domain'
import { buildCalendarEvents } from '~/data/seed/history'

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiCalStatus = ref<{ enabled: boolean; connected: boolean }>({ enabled: false, connected: false })
const apiCalEvents = ref<CalendarEvent[]>([])

function loadCalStatus(force = false): Promise<void> {
  return apiLoadOnce('cal:status', async () => {
    apiCalStatus.value = await apiFetch<{ enabled: boolean; connected: boolean }>('/v1/calendar/status')
  }, force)
}

function loadCalEvents(date: string, force = false): Promise<void> {
  return apiLoadOnce(`cal:${date}`, async () => {
    const rows = await apiFetch<CalendarEvent[]>('/v1/calendar/events', { query: { date } })
    // 日付単位の置換マージ（他の日付のキャッシュは保持）
    apiCalEvents.value = [...apiCalEvents.value.filter(e => e.date !== date), ...rows]
  }, force)
}

// ログイン確立・切替時に取り直す
onApiReset(() => {
  apiCalStatus.value = { enabled: false, connected: false }
  apiCalEvents.value = []
})

export function useCalendar() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  // API モードはキャッシュをバッキングにし、以降の射影ロジックを共通利用する
  const events = isApi ? apiCalEvents : tbl('calendarEvents')
  const members = tbl('members')
  if (isApi) void loadCalStatus()

  // ---------- アカウント連携（モック: 擬似 OAuth / API: Google OAuth 2.0 リダイレクト） ----------

  /** カレンダー連携機能が利用可能か（API モードで OAuth 未設定なら false = UI 非表示） */
  const isEnabled = computed(() => isApi ? apiCalStatus.value.enabled : true)

  /** 現在ユーザーが Google カレンダー連携済みか */
  const isConnected = computed(() =>
    isApi ? apiCalStatus.value.connected : currentUser.value.googleCalendarConnected)

  /**
   * 連携する。API モードは Google の同意画面へフルリダイレクト（このページから離れる。
   * 復帰後の状態反映は refreshStatus / ?calendar= クエリの処理で行う）。
   * モックは擬似 OAuth 同意後に呼ばれ、連携直後に当日分を初回同期する
   */
  async function connect(): Promise<Result & { synced?: number }> {
    if (isApi) {
      try {
        const { url } = await apiFetch<{ url: string }>('/v1/calendar/oauth/url')
        window.location.href = url
        return { ok: true }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    members.value = members.value.map(m =>
      m.id === currentUser.value.id ? { ...m, googleCalendarConnected: true } : m)
    commit()
    return syncFromGoogle(currentUser.value.id, todayJst())
  }

  /** 連携を解除する（同期済みキャッシュは保持。以後の同期・反映は不可になる） */
  async function disconnect(): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch('/v1/calendar/disconnect', { method: 'POST' }))
      if (res.ok) await loadCalStatus(true)
      return res
    }
    members.value = members.value.map(m =>
      m.id === currentUser.value.id ? { ...m, googleCalendarConnected: false } : m)
    commit()
    return { ok: true }
  }

  /** OAuth 復帰後などの状態・当日予定の取り直し */
  async function refreshStatus(): Promise<void> {
    if (!isApi) return
    await Promise.all([loadCalStatus(true), loadCalEvents(todayJst(), true)])
  }

  function eventsOf(memberId: string, date: string): CalendarEvent[] {
    if (isApi) void loadCalEvents(date) // 参照キー単位の遅延ロード（本人分のみサーバーが返す）
    return events.value
      .filter(e => e.memberId === memberId && e.date === date)
      .sort((a, b) => a.from.localeCompare(b.from))
  }

  /**
   * Google カレンダーから同期（モック）。
   * 決定的シードを「Google 側の最新状態」とみなし、google 発予定のみ upsert する。
   * アプリ発（source='app'）の予定には触れない（SoT の分離）。
   */
  async function syncFromGoogle(memberId: string, date: string): Promise<Result & { synced?: number }> {
    if (isApi) {
      try {
        const r = await apiFetch<{ synced: number }>('/v1/calendar/sync', { method: 'POST', body: { date } })
        await loadCalEvents(date, true)
        return { ok: true, synced: r.synced }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    try {
      const member = members.value.find(m => m.id === memberId)
      if (!member?.googleCalendarConnected) {
        return { ok: false, error: { code: 'AKO-CAL-007', message: 'Google カレンダーが未連携です。連携してから同期してください' } }
      }
      const latest = buildCalendarEvents().filter(e => e.memberId === memberId && e.date === date)
      const keepIds = new Set(latest.map(e => e.id))
      events.value = [
        // 対象日の google 発予定を最新状態へ置き換え（その他・アプリ発はそのまま）
        ...events.value.filter(e =>
          !(e.memberId === memberId && e.date === date && e.source === 'google' && !keepIds.has(e.id))),
      ].map(e => (e.source === 'google' && keepIds.has(e.id))
        ? latest.find(l => l.id === e.id) ?? e
        : e)
      // 新規分の追加
      const existingIds = new Set(events.value.map(e => e.id))
      const added = latest.filter(e => !existingIds.has(e.id))
      if (added.length > 0) events.value = [...events.value, ...added]
      commit()
      return { ok: true, synced: latest.length }
    } catch {
      return { ok: false, error: { code: 'AKO-CAL-001', message: 'カレンダー同期に失敗しました（モック）' } }
    }
  }

  /**
   * タスク（アプリ発予定）の追加。pushToGoogle=true で Google へも反映（モック）。
   * Google 反映は補助処理: 未連携でもタスク作成自体は成立させ、warning で知らせる
   */
  async function addTask(input: {
    date: string; from: string; to: string; title: string
    projectId: string | null; pushToGoogle: boolean
  }): Promise<Result & { warning?: string }> {
    if (isApi) {
      try {
        const r = await apiFetch<{ id: string; warning?: string }>('/v1/calendar/events', {
          method: 'POST', body: input,
        })
        await loadCalEvents(input.date, true)
        return { ok: true, id: r.id, warning: r.warning }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    if (!input.title.trim()) {
      return { ok: false, error: { code: 'AKO-CAL-002', message: 'タスク名を入力してください' } }
    }
    if (!input.from || !input.to || input.from >= input.to) {
      return { ok: false, error: { code: 'AKO-CAL-003', message: '開始・終了時刻を正しく入力してください' } }
    }
    const canPush = input.pushToGoogle && isConnected.value
    const id = nextId('calendarEvents', 'cal')
    events.value = [...events.value, {
      id,
      memberId: currentUser.value.id,
      date: input.date,
      from: input.from,
      to: input.to,
      title: input.title.trim(),
      source: 'app',
      syncedToGoogle: canPush,
      projectId: input.projectId,
    }]
    commit()
    return {
      ok: true,
      id,
      warning: input.pushToGoogle && !canPush
        ? 'Google カレンダーが未連携のため、タスクはアプリ内のみに登録しました'
        : undefined,
    }
  }

  /** アプリ発予定を後から Google へ反映（モック: フラグ更新のみ）。反映済みへの再実行は no-op + warning（冪等） */
  async function pushToGoogle(eventId: string): Promise<Result & { warning?: string }> {
    if (isApi) {
      try {
        const r = await apiFetch<{ id: string; warning?: string }>(`/v1/calendar/events/${eventId}/push`, { method: 'POST' })
        const target = apiCalEvents.value.find(e => e.id === eventId)
        if (target) await loadCalEvents(target.date, true)
        return { ok: true, id: r.id, warning: r.warning }
      } catch (e) {
        return { ok: false, error: apiErrorOf(e) }
      }
    }
    if (!isConnected.value) {
      return { ok: false, error: { code: 'AKO-CAL-007', message: 'Google カレンダーが未連携です。連携してから反映してください' } }
    }
    const target = events.value.find(e => e.id === eventId)
    if (!target || target.source !== 'app') {
      return { ok: false, error: { code: 'AKO-CAL-004', message: 'アプリで登録したタスクのみ Google へ反映できます' } }
    }
    if (target.syncedToGoogle) {
      // AKO-CAL-005 は欠番（反映済みへの再実行はエラーではなく no-op に変更）
      return { ok: true, id: eventId, warning: 'すでに Google へ反映済みです（変更はありません）' }
    }
    events.value = events.value.map(e => e.id === eventId ? { ...e, syncedToGoogle: true } : e)
    commit()
    return { ok: true, id: eventId }
  }

  /** アプリ発予定の削除（google 発は Google が SoT のため削除不可） */
  async function removeTask(eventId: string): Promise<Result> {
    if (isApi) {
      const cached = apiCalEvents.value.find(e => e.id === eventId)
      const res = await apiResult(() => apiFetch(`/v1/calendar/events/${eventId}/remove`, { method: 'POST' }))
      if (res.ok && cached) await loadCalEvents(cached.date, true)
      return res
    }
    const target = events.value.find(e => e.id === eventId)
    if (!target || target.source !== 'app') {
      return { ok: false, error: { code: 'AKO-CAL-006', message: 'Google 由来の予定は本アプリから削除できません（Google 側で変更→同期）' } }
    }
    events.value = events.value.filter(e => e.id !== eventId)
    commit()
    return { ok: true, id: eventId }
  }

  return {
    events, eventsOf, syncFromGoogle, addTask, pushToGoogle, removeTask,
    isConnected, isEnabled, connect, disconnect, refreshStatus,
  }
}
