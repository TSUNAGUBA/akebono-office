/**
 * エスカレーション（akebono-ai-manager の思想を踏襲）
 * シグナル検知 → 起票（暗黙の情報共有）→ 管理者アクション → ナレッジ還流
 * - 起票は dedupeKey + クールダウンで冪等
 * - 起票・還流は補助処理: 失敗しても主フローを止めない
 *
 * デュアルモード（バッチ3a）:
 * - API モード: SoT は /v1/escalations。一覧は管理者のみ参照可（サーバー側ガード）。
 *   起票・解決はサーバーが冪等性・クレーム・通知・ナレッジ還流を担い、成功後にキャッシュを取り直す（原則6）
 */
import type { Ref } from 'vue'
import type { Escalation, EscalationReason, KnowledgeDomain, Result } from '~/types/domain'
import { ESCALATION_REASON_LABELS } from '~/utils/labels'

export interface EscalationSignal {
  reason: EscalationReason
  targetMemberId?: string
  targetAiEmployeeId?: string
  context: string
  dedupeKey: string
}

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiEscalations = ref<Escalation[]>([])

function loadEscalations(force = false): Promise<void> {
  return apiLoadOnce('esc:list', async () => {
    apiEscalations.value = await apiFetch<Escalation[]>('/v1/escalations')
  }, force)
}

// ログイン確立・切替時に取り直す（管理者のみ。一般ユーザーは 403 になるため空のまま）
onApiReset(() => {
  apiEscalations.value = []
  if (useApiMe().value?.role === 'admin') void loadEscalations(true)
})

export function useEscalations() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser, isAdmin } = useCurrentUser()
  const { notifyAdmins, notify } = useNotifications()
  const isApi = useApiMode()
  // API モードはキャッシュをバッキングにし、以降の射影ロジックを共通利用する
  const escalations = isApi ? (apiEscalations as Ref<Escalation[]>) : tbl('escalations')
  const rules = tbl('escalationRules')
  if (isApi && isAdmin.value) void loadEscalations()

  /** API モード時、参照されたら管理者一覧を遅延ロードする（初期化順序に依存しない自己修復） */
  function touchList(): void {
    if (isApi && isAdmin.value) void loadEscalations()
  }

  const open = computed(() => {
    touchList()
    return escalations.value.filter(e => e.status === 'open').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
  })
  const resolved = computed(() => {
    touchList()
    return escalations.value.filter(e => e.status === 'resolved').sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
  })
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
  async function raise(signal: EscalationSignal): Promise<Result> {
    if (isApi) {
      // サーバーがルール判定・クールダウン・管理者通知を担う（AKO-ESC-001/002 は非致命の想定エラー）
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/escalations', {
        method: 'POST',
        body: {
          reason: signal.reason,
          targetMemberId: signal.targetMemberId,
          context: signal.context,
          dedupeKey: signal.dedupeKey,
        },
      }))
      if (res.ok && isAdmin.value) void loadEscalations(true)
      return res
    }
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
   * @param knowledgeTarget 裁定のナレッジ還流先（domain + targetId）。省略時はフォールバック先へ還流する
   */
  async function resolve(
    id: string,
    type: 'answer' | 'ruling' | 'no_action',
    body: string,
    reflectToKnowledge = false,
    knowledgeTarget?: { domain: KnowledgeDomain; targetId: string },
  ): Promise<Result> {
    if (isApi) {
      // クレーム（open → resolved）・ナレッジ還流・本人通知はサーバーが担う → 成功後にキャッシュを取り直す
      const res = await apiResult(() => apiFetch<{ id: string; knowledgeReflected: boolean }>(
        `/v1/escalations/${id}/resolution`,
        { method: 'POST', body: { type, body, reflectKnowledge: reflectToKnowledge, knowledgeTarget } },
      ))
      if (res.ok) {
        await loadEscalations(true)
        if (reflectToKnowledge) void loadApiCollection('knowledge', true)
      }
      return res
    }
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
      // 還流先が未指定の呼び出し元（旧 I/F）向けフォールバック: 自社 PJ「AKEBONO Office 開発」へ還流する
      const reflectTarget = knowledgeTarget ?? { domain: 'project' as const, targetId: 'pj-08' }
      try {
        const knowledge = tbl('knowledge')
        knowledge.value = [...knowledge.value, {
          id: nextId('knowledge', 'k'),
          domain: reflectTarget.domain,
          targetId: reflectTarget.targetId,
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

  /**
   * 一覧の取り直し（inbox 表示時に呼ぶ）。
   * 起票はサーバー側（日報提出・36協定・チャットボット）でも発生するため、
   * キャッシュ済みでも表示タイミングで最新化する。モックモードは no-op
   */
  async function refresh(): Promise<void> {
    if (isApi && isAdmin.value) await loadEscalations(true)
  }

  return { open, resolved, openCount, refluxRate, raise, resolve, byId, refresh }
}
