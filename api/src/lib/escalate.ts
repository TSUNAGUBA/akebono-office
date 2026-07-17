/**
 * エスカレーション起票（mockup useEscalations.raise の API 版）。
 * - ルール（app_configs 'escalationRules'）の enabled / cooldownDays を尊重
 * - dedupeKey の先頭 2 セグメント + reason + クールダウン期間で重複起票を抑止（冪等）
 * - 補助処理として呼ばれる前提: 例外を投げず結果を返す（開発原則4）
 */
import type pg from 'pg'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import type { EscalationReason } from '../../../shared/domain/types'
import { newId } from './ids'
import { notifyAdmins } from './notify'

export const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  issue_reported: '課題の報告',
  stalled_task: 'タスク停滞',
  overload: '過負荷',
  low_confidence: 'AI確信度低',
  overtime_alert: '残業アラート',
}

/** ルール未設定時の既定クールダウン（日）。mockup と同一 */
const DEFAULT_COOLDOWN_DAYS = 3

export interface EscalationSignal {
  reason: EscalationReason
  targetMemberId?: string | null
  targetAiEmployeeId?: string | null
  context: string
  dedupeKey: string
}

export type RaiseResult =
  | { raised: true; id: string }
  | { raised: false; code: 'AKO-ESC-001' | 'AKO-ESC-002' | 'AKO-ESC-999' }

interface StoredRule {
  key?: string
  enabled?: boolean
  cooldownDays?: number
}

async function ruleFor(db: pg.Pool | pg.PoolClient, reason: EscalationReason): Promise<StoredRule | undefined> {
  const { rows } = await db.query<{ value: unknown }>(
    `SELECT value FROM app_configs WHERE key = 'escalationRules'`)
  const list = rows[0]?.value
  if (!Array.isArray(list)) return undefined
  return (list as StoredRule[]).find(r => r && typeof r === 'object' && r.key === reason)
}

/** 起票する（クールダウン中 = AKO-ESC-001 / ルール無効 = AKO-ESC-002。いずれも非致命） */
export async function raiseEscalation(
  db: pg.Pool | pg.PoolClient,
  signal: EscalationSignal,
): Promise<RaiseResult> {
  try {
    const rule = await ruleFor(db, signal.reason)
    if (rule && rule.enabled === false) return { raised: false, code: 'AKO-ESC-002' }
    const cooldownDays = typeof rule?.cooldownDays === 'number' ? rule.cooldownDays : DEFAULT_COOLDOWN_DAYS
    const cutoff = addDays(todayJst(), -cooldownDays)
    // mockup と同一: dedupeKey の先頭 2 セグメント（例 issue:m-01）+ reason + クールダウン期間で判定
    const prefix = signal.dedupeKey.split(':').slice(0, 2).join(':')
    const recent = await db.query<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM escalations WHERE reason = $1 AND raised_at >= $2',
      [signal.reason, cutoff])
    if (recent.rows.some(r => r.dedupe_key.split(':').slice(0, 2).join(':') === prefix)) {
      return { raised: false, code: 'AKO-ESC-001' }
    }

    const id = newId('esc')
    await db.query(
      `INSERT INTO escalations (id, reason, target_member_id, target_ai_employee_id, context, dedupe_key, raised_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, signal.reason, signal.targetMemberId ?? null, signal.targetAiEmployeeId ?? null,
        signal.context, signal.dedupeKey, nowJstIso()])
    // 管理者への暗黙の情報共有（通知失敗は起票を巻き戻さない）
    await notifyAdmins(db, 'escalation',
      `エスカレーション: ${ESCALATION_REASON_LABELS[signal.reason]}`, signal.context, '/inbox')
    return { raised: true, id }
  } catch (e) {
    console.warn('raiseEscalation failed (non-blocking):', (e as Error).message)
    return { raised: false, code: 'AKO-ESC-999' }
  }
}
