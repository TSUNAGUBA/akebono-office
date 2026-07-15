/**
 * エスカレーション（akebono-ai-manager の思想を踏襲）
 * シグナル検知 → 起票（暗黙の情報共有）→ 管理者アクション → ナレッジ還流
 * - 起票は dedupeKey + クールダウンで冪等
 * - 起票・還流は補助処理: 失敗しても主フローを止めない
 */
import type { Escalation, EscalationReason, Result } from '~/types/domain'
import { ESCALATION_REASON_LABELS } from '~/utils/labels'

export interface EscalationSignal {
  reason: EscalationReason
  targetMemberId?: string
  targetAiEmployeeId?: string
  context: string
  dedupeKey: string
}

export function useEscalations() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const { notifyAdmins, notify } = useNotifications()
  const escalations = tbl('escalations')
  const rules = tbl('escalationRules')

  const open = computed(() =>
    escalations.value.filter(e => e.status === 'open').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)))
  const resolved = computed(() =>
    escalations.value.filter(e => e.status === 'resolved').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)))
  const openCount = computed(() => open.value.length)
  const refluxRate = computed(() => {
    const rulings = resolved.value.filter(e => e.resolution?.type === 'ruling')
    if (rulings.length === 0) return null
    return rulings.filter(e => e.knowledgeReflected).length / rulings.length
  })

  /**
   * シグナルから起票する。ルール無効・クールダウン中は起票しない（no-op）。
   * 例外を投げない（補助処理）。
   */
  function raise(signal: EscalationSignal): Result {
    try {
      const rule = rules.value.find(r => r.key === signal.reason)
      if (rule && !rule.enabled) {
        return { ok: false, error: { code: 'AKO-ESC-002', message: 'このシグナルは設定で無効化されています' } }
      }
      const cooldownDays = rule?.cooldownDays ?? 3
      // JST の日付キーで比較（raisedAt は "YYYY-MM-DD..." 形式のため辞書順比較で日単位判定できる）
      const cutoff = addDays(todayJst(), -cooldownDays)
      const dup = escalations.value.find(e =>
        e.dedupeKey.split(':').slice(0, 2).join(':') === signal.dedupeKey.split(':').slice(0, 2).join(':')
        && e.reason === signal.reason
        && e.raisedAt >= cutoff)
      if (dup) {
        return { ok: false, error: { code: 'AKO-ESC-001', message: 'クールダウン期間中のため重複起票をスキップしました' } }
      }
      const id = nextId('escalations', 'esc')
      escalations.value = [...escalations.value, {
        id,
        reason: signal.reason,
        targetMemberId: signal.targetMemberId ?? null,
        targetAiEmployeeId: signal.targetAiEmployeeId ?? null,
        context: signal.context,
        status: 'open',
        resolution: null,
        knowledgeReflected: false,
        dedupeKey: signal.dedupeKey,
        raisedAt: nowJstIso(),
      }]
      commit()
      // 管理者への暗黙の情報共有（通知失敗は起票を巻き戻さない）
      notifyAdmins('escalation', `エスカレーション: ${ESCALATION_REASON_LABELS[signal.reason]}`, signal.context, '/inbox')
      return { ok: true, id }
    } catch {
      return { ok: false, error: { code: 'AKO-ESC-999', message: '起票に失敗しました（主フローは継続します）' } }
    }
  }

  /**
   * 管理者アクション（回答送信 / 裁定記録 / 対応不要）
   * open → resolved のガードで二重解決を防止（クレームファースト）。
   */
  function resolve(
    id: string,
    type: 'answer' | 'ruling' | 'no_action',
    body: string,
    reflectToKnowledge = false,
  ): Result {
    const target = escalations.value.find(e => e.id === id)
    if (!target || target.status !== 'open') {
      return { ok: false, error: { code: 'AKO-ESC-003', message: 'このエスカレーションは既に解決済みです' } }
    }
    if ((type === 'answer' || type === 'ruling') && !body.trim()) {
      return { ok: false, error: { code: 'AKO-GEN-001', message: '内容を入力してください' } }
    }
    const resolvedAt = nowJstIso()
    let knowledgeReflected = false

    // 裁定のナレッジ還流（補助処理・非ブロッキング）
    if (type === 'ruling' && reflectToKnowledge) {
      try {
        const knowledge = tbl('knowledge')
        knowledge.value = [...knowledge.value, {
          id: nextId('knowledge', 'k'),
          domain: 'project',
          targetId: 'pj-08',
          title: `裁定: ${target.context.slice(0, 24)}${target.context.length > 24 ? '…' : ''}`,
          body,
          tags: ['裁定'],
          source: 'escalation',
          sourceRefId: id,
          updatedAt: resolvedAt,
          active: true,
        }]
        knowledgeReflected = true
      } catch {
        knowledgeReflected = false // 還流失敗でも解決は成立させる
      }
    }

    escalations.value = escalations.value.map(e => e.id === id
      ? {
          ...e,
          status: 'resolved' as const,
          resolution: { type, body, resolvedBy: currentUser.value.id, at: resolvedAt },
          knowledgeReflected,
        }
      : e)
    commit()

    // 回答送信は本人へ届ける（補助処理）
    if (type === 'answer' && target.targetMemberId) {
      notify(target.targetMemberId, 'escalation', '管理者からの回答', body, '/inbox')
    }
    return { ok: true, id }
  }

  function byId(id: string): Escalation | undefined {
    return escalations.value.find(e => e.id === id)
  }

  return { open, resolved, openCount, refluxRate, raise, resolve, byId }
}
