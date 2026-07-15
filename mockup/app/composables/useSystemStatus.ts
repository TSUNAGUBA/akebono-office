/**
 * 提供システム稼働状況（F-11）
 * - 現在状態: 未解決インシデントの impact を状態へ写像し、最悪値ロールアップ
 * - uptime%: uptimeDaily（過去 90 日）の停止分から算出
 * - インシデント: updates は記録系（追記のみ）。status / resolvedAt はその射影として更新
 * - ライフサイクルは investigating → identified → monitoring → resolved の正順のみ許可
 */
import type {
  IncidentImpact, IncidentStatus, Result, ServiceIncident, SystemService, UptimeDaily,
} from '~/types/domain'
import type { Tone } from '~/types/ui'
import { INCIDENT_STATUS_LABELS } from '~/utils/labels'

export type ServiceState = UptimeDaily['worstState']

/** 影響度 → 現在状態の写像（minor=性能低下 / major=一部障害 / critical=重大障害） */
export const IMPACT_TO_STATE: Record<IncidentImpact, ServiceState> = {
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
}

/** 状態の深刻度（最悪値ロールアップ用） */
const STATE_SEVERITY: Record<ServiceState, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
}

/** 影響度のトーン（共有 labels.ts は編集しないため本 composable で定義） */
export const INCIDENT_IMPACT_TONES: Record<IncidentImpact, Tone> = {
  minor: 'warn',
  major: 'serious',
  critical: 'crit',
}

/** インシデントの状態遷移の正順 */
export const INCIDENT_STATUS_ORDER: IncidentStatus[] = [
  'investigating', 'identified', 'monitoring', 'resolved',
]

export function useSystemStatus() {
  const { tbl, commit, nextId } = useMockDb()
  const { notifyAdmins } = useNotifications()
  const servicesTbl = tbl('systemServices')
  const incidents = tbl('serviceIncidents')
  const uptimeDaily = tbl('uptimeDaily')

  const services = computed<SystemService[]>(() => servicesTbl.value)

  function serviceById(serviceId: string): SystemService | undefined {
    return servicesTbl.value.find(s => s.id === serviceId)
  }

  /** 未解決インシデント（新しい順） */
  function openIncidentsOf(serviceId: string): ServiceIncident[] {
    return incidents.value
      .filter(i => i.serviceId === serviceId && i.status !== 'resolved')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** サービスの現在状態（未解決インシデントの最悪値。なければ operational） */
  function stateOf(serviceId: string): ServiceState {
    let worst: ServiceState = 'operational'
    for (const i of openIncidentsOf(serviceId)) {
      const s = IMPACT_TO_STATE[i.impact]
      if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s
    }
    return worst
  }

  /** 全サービスの最悪値ロールアップ（全体バナー用） */
  const overallState = computed<ServiceState>(() => {
    let worst: ServiceState = 'operational'
    for (const svc of servicesTbl.value) {
      const s = stateOf(svc.id)
      if (STATE_SEVERITY[s] > STATE_SEVERITY[worst]) worst = s
    }
    return worst
  })

  /** 日別稼働状況（過去 90 日・古い順） */
  function uptimeDaysOf(serviceId: string): UptimeDaily[] {
    return uptimeDaily.value
      .filter(u => u.serviceId === serviceId)
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /** 90 日稼働率（1 - 停止分 / 全分数） */
  function uptimePctOf(serviceId: string): number {
    const days = uptimeDaysOf(serviceId)
    if (days.length === 0) return 1
    const down = days.reduce((s, d) => s + d.downMinutes, 0)
    return 1 - down / (days.length * 24 * 60)
  }

  /** インシデント履歴（新しい順） */
  function incidentsOf(serviceId: string): ServiceIncident[] {
    return incidents.value
      .filter(i => i.serviceId === serviceId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  function incidentById(id: string): ServiceIncident | undefined {
    return incidents.value.find(i => i.id === id)
  }

  /** 現在の状態から遷移可能な次ステータス（正順のみ） */
  function nextStatusesOf(incident: ServiceIncident): IncidentStatus[] {
    const idx = INCIDENT_STATUS_ORDER.indexOf(incident.status)
    return INCIDENT_STATUS_ORDER.slice(idx + 1)
  }

  /** インシデント登録（管理者操作）。成功後に管理者へ通知（非ブロッキング） */
  function createIncident(input: {
    serviceId: string
    title: string
    impact: IncidentImpact
    body: string
  }): Result {
    const svc = serviceById(input.serviceId)
    if (!svc) {
      return { ok: false, error: { code: 'AKO-STS-001', message: '対象サービスが見つかりません' } }
    }
    if (!input.title.trim()) {
      return { ok: false, error: { code: 'AKO-STS-002', message: 'タイトルを入力してください' } }
    }
    const now = new Date().toISOString()
    const id = nextId('serviceIncidents', 'inc')
    incidents.value = [...incidents.value, {
      id,
      serviceId: input.serviceId,
      title: input.title.trim(),
      impact: input.impact,
      status: 'investigating',
      updates: [{
        status: 'investigating',
        body: input.body.trim() || '事象を検知し、調査を開始しました。',
        at: now,
      }],
      startedAt: now,
      resolvedAt: null,
    }]
    commit()
    // 補助処理: 通知失敗は登録を巻き戻さない
    notifyAdmins('system', `インシデント発生: ${svc.name}`, input.title.trim(), `/status/${input.serviceId}`)
    return { ok: true, id }
  }

  /** 状況更新（正順のみ）。updates へ追記し、resolved で resolvedAt を記録 */
  function addIncidentUpdate(id: string, status: IncidentStatus, body: string): Result {
    const target = incidentById(id)
    if (!target) {
      return { ok: false, error: { code: 'AKO-STS-003', message: 'インシデントが見つかりません' } }
    }
    if (!nextStatusesOf(target).includes(status)) {
      return {
        ok: false,
        error: {
          code: 'AKO-STS-004',
          message: `「${INCIDENT_STATUS_LABELS[target.status]}」から「${INCIDENT_STATUS_LABELS[status]}」へは更新できません（正順のみ）`,
        },
      }
    }
    if (!body.trim()) {
      return { ok: false, error: { code: 'AKO-STS-005', message: '状況の説明を入力してください' } }
    }
    const now = new Date().toISOString()
    incidents.value = incidents.value.map(i => i.id === id
      ? {
          ...i,
          status,
          resolvedAt: status === 'resolved' ? now : i.resolvedAt,
          updates: [...i.updates, { status, body: body.trim(), at: now }],
        }
      : i)
    commit()
    const svc = serviceById(target.serviceId)
    // 補助処理: 通知失敗は更新を巻き戻さない
    notifyAdmins(
      'system',
      `インシデント更新: ${svc?.name ?? target.serviceId}（${INCIDENT_STATUS_LABELS[status]}）`,
      body.trim(),
      `/status/${target.serviceId}`,
    )
    return { ok: true, id }
  }

  return {
    services,
    serviceById,
    openIncidentsOf,
    stateOf,
    overallState,
    uptimeDaysOf,
    uptimePctOf,
    incidentsOf,
    incidentById,
    nextStatusesOf,
    createIncident,
    addIncidentUpdate,
  }
}
