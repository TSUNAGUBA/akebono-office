/**
 * 通知リンクの本アプリ内パスへの写像（R1 レビュー指摘 #1）。
 * API モードの通知はサーバー（共通 API）が AKEBONO Office のパスで発行するため、
 * 本アプリ（Company）で開ける通知はパスを写像し、開けない通知（Office 側ドメイン）は null を返す
 * （呼び出し側が「Office 側の機能」である旨を案内する。壊れた遷移 = 404 を作らない）。
 *
 * - `/ai-company?task=X` → `/tasks?task=X`（AI タスク通知 = 本アプリの中核導線）
 * - `/inbox?tab=escalations&open=X` → `/?open=X`（エスカレーションはダッシュボードの対応パネルへ）
 * - 本アプリ内パス（モックモードの notify が発行）はそのまま通す
 * - それ以外（Office の勤怠・稟議・日報等）→ null
 *
 * 注意: Office の `/reports`（日報・週報）と本アプリの `/reports`（AI 日次報告）はパスが同名で
 * 意味が異なるため、`/reports` は写像対象に含めない（API モードの `/reports` 通知は Office 側の
 * 日報コメント等 = 本アプリでは開けない扱いが正）。モックモードの notify は `/reports` リンクを発行しない。
 */

/** 本アプリ内で直接開けるパス（モックモードの notify が発行するリンクの受理リスト） */
const COMPANY_PATHS = new Set(['/', '/tasks', '/activity', '/tokens', '/employees', '/roles'])

export function resolveNotificationLink(link: string): string | null {
  if (!link) return null
  const qIndex = link.indexOf('?')
  const path = qIndex >= 0 ? link.slice(0, qIndex) : link
  const queryRaw = qIndex >= 0 ? link.slice(qIndex + 1) : ''
  const query = queryRaw ? `?${queryRaw}` : ''

  if (path === '/ai-company') return `/tasks${query}`
  if (path === '/inbox') {
    const params = new URLSearchParams(queryRaw)
    if (params.get('tab') === 'escalations') {
      const open = params.get('open')
      return open ? `/?open=${encodeURIComponent(open)}` : '/'
    }
    return null
  }
  if (COMPANY_PATHS.has(path)) return link
  return null
}
