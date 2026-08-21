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
 * - 機能キー 'timecard'（/timecard = 本人のタイムカードページ。2026-07-22）は専用 API を持たず、
 *   データ面は /v1/attendance（機能キー 'attendance'）に従属する = フロント enforcement のみ。
 *   フロントの canPath は timecard AND attendance で判定し、attendance deny 時はページごと隠す（UI と API の一致）
 * - フィールドレベルは masters GET レスポンスの剥がし（stripMasterFields）で enforcement する
 */
import type { MiddlewareHandler } from 'hono'
import type pg from 'pg'
import {
  canUseFeature, type PermissionSubject, resolveFeatureResource,
  stripDeniedFields, stripDeniedWriteKeys,
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

/** URL プレフィックス → 機能キー（対応しないパスはガード対象外）
 * /v1/media は意図的に未登録: メディア分析は F-16 の機能キー（FEATURE_PERMISSION_KEYS）に存在せず、
 * 利用可否は AKEBONO 業務のアプリ設定（業態別アプリ media + 機能トグル）で制御する設計
 * （フロントの featureKeyOfPath も /media を null = ガード対象外にしており、UI と API の判定を一致させる。
 *  書込系の認可は routes/media.ts の requireAdmin が基底）。
 * 注: 業態別アプリの media トグルは**クライアント側のみの制御（メニュー・ページ非表示）で、
 * サーバーは /v1/media リクエストに対してトグルを検証しない**。トグルはデータ保護でなく画面整理の設定であり、
 * データ面の認可は requireAdmin（書込）+ 認証（参照 = 社内 C2）が担う（設計判断の文書化） */
const PATH_FEATURES: [string, string][] = [
  ['/v1/attendance', 'attendance'],
  ['/v1/leave', 'attendance'],
  // 週報・月報は独立機能キー（改修依頼 2026-08-20 第2バッチ）。/v1/reports より前に置き最長一致
  // （first-match）で解決する。旧 'reports' ルールの継承は 0078 の物理移行で撤去済み。
  // 設計判断: /v1/reports/remind（日報リマインド専用）は従来どおり 'reports' に残す。
  // /v1/reports/reads は下記のとおりパスガード対象外 + ハンドラ内 kind 別判定（レビュー R1 で変更）。
  ['/v1/reports/weekly-insight', 'weekly-report'],
  ['/v1/reports/weekly', 'weekly-report'],
  ['/v1/reports/monthly', 'monthly-report'],
  // reads（既読管理）は kind = daily/weekly/monthly 混在のためパスガード対象外とし、
  // ハンドラ内で kind 別の機能キー（reportReadsFeatureKey）により判定する
  // （'reports' に残すと「日報 deny × 週報 allow」設定で週報の既読管理が全滅する = レビュー R1 対応）
  ['/v1/reports/reads', ''],
  ['/v1/reports', 'reports'],
  ['/v1/workflows', 'workflow'],
  ['/v1/shifts', 'shift'],
  ['/v1/task-plans', 'ai-assistant'],
  // AIで整形（format-text）は改善要望フォーム等の汎用入力サポート = 認証済み全員可（改修依頼 2026-08-20）。
  // /v1/assist 全体の ai-assistant ゲートより先に最長一致で除外する（'' = ガード対象外。レビュー R1 対応）
  ['/v1/assist/format-text', ''],
  ['/v1/assist', 'ai-assistant'],
  ['/v1/calendar', 'ai-assistant'],
  ['/v1/decisions', 'decision'],
  ['/v1/chatbot', 'chatbot'],
  ['/v1/ai-company', 'ai-company'],
  ['/v1/sales', 'sales'],
  ['/v1/status', 'status'],
  ['/v1/akebono', 'akebono'],
  ['/v1/documents', 'documents'],
  ['/v1/customer-logs', 'customer-log'],
  ['/v1/customer-contexts', 'customer-context'],
  ['/v1/support-activities', 'support-activity'],
  ['/v1/sales-activities', 'sales-activity'],
  // 営業アプローチリスト（改善要望 2026-08-21・F-53）
  ['/v1/sales-approaches', 'sales-approach'],
  ['/v1/partner-activities', 'partner-activity'],
]

/** 機能単位の利用ガード（authMiddleware の後段。deny は AKO-PRM-001 403） */
export function featureGuard(pool: pg.Pool): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    const hit = PATH_FEATURES.find(([p]) => path === p || path.startsWith(`${p}/`))
    if (!hit || hit[1] === '') return next() // '' = 明示のガード対象外（認証のみで全員可）
    const rules = await activePermissionRules(pool)
    if (rules.length === 0) return next() // ルール未設定 = 既定 allow（下位互換）
    const user = c.get('user')
    // resolveFeatureResource = フロント usePermissions.can と共通の解決（旧 'reports' からの動的継承は
    // 改善要望 2026-08-21 で撤去・migration 0078 で物理移行済み = 現在は素通し。I/F 互換のため経由を維持）
    const resource = resolveFeatureResource(rules, hit[1])
    if (!canUseFeature(rules, subjectOf(user), resource)) {
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

/**
 * マスタ PATCH body の更新不可項目剥がし（改修依頼 2026-08-18: 項目＞参照/更新の階層制御）。
 * `<項目>:write` の deny、または参照 deny（参照＞更新）の項目を更新対象から取り除く。
 * 全キーが剥がされて更新対象が空になった場合は 403（AKO-PRM-003）を投げる
 * （部分的に剥がれた場合はできたところまで更新する = グレースフルデグラデーション。原則4）
 */
export async function stripMasterWriteKeys<T extends Record<string, unknown>>(
  pool: pg.Pool,
  user: AuthUser,
  entity: string,
  body: T,
): Promise<T> {
  const rules = await activePermissionRules(pool)
  if (rules.length === 0) return body
  const stripped = stripDeniedWriteKeys(rules, subjectOf(user), entity, body)
  if (Object.keys(body).length > 0 && Object.keys(stripped).length === 0) {
    throw err('AKO-PRM-003', '指定した項目を更新する権限がありません（管理者にお問い合わせください）', 403)
  }
  return stripped
}
