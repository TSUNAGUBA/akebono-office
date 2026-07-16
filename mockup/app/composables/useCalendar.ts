/**
 * カレンダー連携（F-06-8・モック）
 * - source='google' の予定は Google が SoT（本アプリはキャッシュ）。同期で upsert、アプリ側からは編集・削除しない
 * - source='app' の予定は本アプリが SoT。pushToGoogle で Google へ反映（モックではフラグ更新+トースト）
 * - 同期はべき等: 決定的 id（gcal-…）による upsert で、再実行してもアプリ発予定・ヒアリングログを壊さない
 */
import type { CalendarEvent, Result } from '~/types/domain'
import { buildCalendarEvents } from '~/data/seed/history'

export function useCalendar() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const events = tbl('calendarEvents')
  const members = tbl('members')

  // ---------- アカウント連携（擬似 OAuth。本実装では Google OAuth 2.0 の同意フロー） ----------

  /** 現在ユーザーが Google カレンダー連携済みか */
  const isConnected = computed(() => currentUser.value.googleCalendarConnected)

  /**
   * 連携する（擬似 OAuth 同意後に呼ぶ）。連携直後に当日分を初回同期する。
   * 過去日・未来日は各日付のスケジュールカードの「Google から同期」で個別に取得できるため、初回は当日のみで足りる
   */
  function connect(): Result & { synced?: number } {
    members.value = members.value.map(m =>
      m.id === currentUser.value.id ? { ...m, googleCalendarConnected: true } : m)
    commit()
    return syncFromGoogle(currentUser.value.id, todayJst())
  }

  /** 連携を解除する（同期済みキャッシュは保持。以後の同期・反映は不可になる） */
  function disconnect(): Result {
    members.value = members.value.map(m =>
      m.id === currentUser.value.id ? { ...m, googleCalendarConnected: false } : m)
    commit()
    return { ok: true }
  }

  function eventsOf(memberId: string, date: string): CalendarEvent[] {
    return events.value
      .filter(e => e.memberId === memberId && e.date === date)
      .sort((a, b) => a.from.localeCompare(b.from))
  }

  /**
   * Google カレンダーから同期（モック）。
   * 決定的シードを「Google 側の最新状態」とみなし、google 発予定のみ upsert する。
   * アプリ発（source='app'）の予定には触れない（SoT の分離）。
   */
  function syncFromGoogle(memberId: string, date: string): Result & { synced?: number } {
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
  function addTask(input: {
    date: string; from: string; to: string; title: string
    projectId: string | null; pushToGoogle: boolean
  }): Result & { warning?: string } {
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
  function pushToGoogle(eventId: string): Result & { warning?: string } {
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
  function removeTask(eventId: string): Result {
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
    isConnected, connect, disconnect,
  }
}
