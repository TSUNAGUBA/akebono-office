/**
 * 権限制御の API 側 enforcement（F-16・オペレーター指示 2026-07-17）。
 * 判定ロジックは shared/domain/permissions.ts（フロントと共有）。ここは
 * ルールのロード（短期キャッシュ）・URL → 機能キーの対応・ガード middleware を担う。
 *
 * 設計判断:
 * - /v1/masters・/v1/configs・/v1/notifications・/v1/escalations はガード対象外。マスタ参照・設定値・
 *   通知（ヘッダーバッジのポーリング）・エスカレーション起票（チャットボット/日報からの補助処理）は
 *   全ページ横断の「データ面」であり、機能 deny でアプリ全体が壊れるため。masters/settings/inbox の
 *   機能 deny はフロントのメニュー・ページ非表示で enforcement する（変更系は既存ロールガードが基底）
 * - フィールドレベルは masters GET レスポンスの剥がし（stripMasterFields）で enforcement する
 */
import type { MiddlewareHandler } from 'hono'
import type pg from 'pg'
import {
  canUseFeature, type PermissionSubject, stripDeniedFields,
} from '../../../shared/domain/permissions'
import type { PermissionRule } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import { err } from './errors'

const RULE_COLS = `id, subject_kind AS "subjectKind", subject_id AS "subjectId",
  resource, field, effect, active`

/**
 * ルールの短期キャッシュ（ハイドレーションのバースト対策。変更時は clearPermissionCache）。
 * クリアはプロセスローカル: Cloud Run の複数インスタンス構成では他インスタンスは
 * TTL 経過（最大 10 秒）で追随する。権限変更の伝播遅延として許容する設計判断。
 */
let cache: { at: number; rules: PermissionRule[] } | null = null
const CACHE_TTL_MS = 10_000

export function clearPermissionCache(): void {
  cache = null
}

export async function activePermissionRules(pool: pg.Pool): Promise<PermissionRule[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rules
  // LIMIT を付けない: 部分ロードは deny ルールの無音欠落（fail-open）になる。
  // 管理者が手動管理する小規模テーブルであり全件ロードが安全側
  const { rows } = await pool.query<PermissionRule>(
    `SELECT ${RULE_COLS} FROM permission_rules WHERE active = true`)
  cache = { at: Date.now(), rules: rows }
  return rows
}

export function subjectOf(user: AuthUser): PermissionSubject {
  return { memberId: user.id, title: user.title ?? '', role: user.role }
}

/** URL プレフィックス → 機能キー（対応しないパスはガード対象外） */
const PATH_FEATURES: [string, string][] = [
  ['/v1/attendance', 'attendance'],
  ['/v1/leave', 'attendance'],
  ['/v1/reports', 'reports'],
  ['/v1/workflows', 'workflow'],
  ['/v1/shifts', 'shift'],
  ['/v1/task-plans', 'ai-assistant'],
  ['/v1/assist', 'ai-assistant'],
  ['/v1/calendar', 'ai-assistant'],
  ['/v1/decisions', 'decision'],
  ['/v1/chatbot', 'chatbot'],
  ['/v1/ai-company', 'ai-company'],
  ['/v1/sales', 'sales'],
  ['/v1/status', 'status'],
  ['/v1/akebono', 'akebono'],
  ['/v1/documents', 'documents'],
]

/** 機能単位の利用ガード（authMiddleware の後段。deny は AKO-PRM-001 403） */
export function featureGuard(pool: pg.Pool): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    const hit = PATH_FEATURES.find(([p]) => path === p || path.startsWith(`${p}/`))
    if (!hit) return next()
    const rules = await activePermissionRules(pool)
    if (rules.length === 0) return next() // ルール未設定 = 既定 allow（下位互換）
    const user = c.get('user')
    if (!canUseFeature(rules, subjectOf(user), hit[1])) {
      throw err('AKO-PRM-001', 'この機能を利用する権限がありません（管理者にお問い合わせください）', 403)
    }
    return next()
  }
}

/** マスタ GET レスポンスの表示項目剥がし（resource = エンティティキー・field = 項目名のルール） */
export async function stripMasterFields<T extends Record<string, unknown>>(
  pool: pg.Pool,
  user: AuthUser,
  entity: string,
  rows: T[],
): Promise<T[]> {
  const rules = await activePermissionRules(pool)
  if (rules.length === 0) return rows
  return stripDeniedFields(rules, subjectOf(user), entity, rows)
}
