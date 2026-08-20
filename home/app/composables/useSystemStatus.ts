/**
 * 提供システム稼働状況（F-11）
 * - 現在状態: 未解決インシデントの impact を状態へ写像し、最悪値ロールアップ
 * - uptime%: uptimeDaily（過去 90 日）の停止分から算出
 * - インシデント: updates は記録系（追記のみ）。status / resolvedAt はその射影として更新
 * - ライフサイクルは investigating → identified → monitoring → resolved の正順のみ許可
 *
 * デュアルモード（バッチ6c）:
 * - モックモード: 従来どおり useMockDb（uptime はシードの決定的モック）
 * - API モード: SoT は /v1/status（services + incidents + 90 日 uptime の一括ハイドレーション）。
 *   uptime はサーバーがインシデントから導出（shared/domain/uptime）。
 *   登録・状況更新は API 書込 → キャッシュ取り直し（原則6）。通知はサーバー発火
 * 影響度→状態の写像・最悪値ロールアップは shared/domain/uptime を API と共有（原則3）
 */
import {
  IMPACT_TO_STATE, STATE_SEVERITY, worstOf, type ServiceState,
} from '../../../shared/domain/uptime'
import type {
  IncidentImpact, IncidentStatus, Result, ServiceIncident, SystemService, UptimeDaily,
} from '~/types/domain'
import type { Tone } from '~/types/ui'
import { INCIDENT_STATUS_LABELS } from '~/utils/labels'

export type { ServiceState }
export { IMPACT_TO_STATE }

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

// ---------- API モードのキャッシュ（SPA・モジュールスコープ単一） ----------

const apiServices = ref<SystemService[]>([])
const apiIncidents = ref<ServiceIncident[]>([])
const apiUptime = ref<UptimeDaily[]>([])

function loadStatus(force = false): Promise<void> {
  return apiLoadOnce('status:all', async () => {
    const data = await apiFetch<{
      services: SystemService[]
      incidents: ServiceIncident[]
      uptime: UptimeDaily[]
    }>('/v1/status')
    apiServices.value = data.services
    apiIncidents.value = data.incidents
    apiUptime.value = data.uptime
  }, force)
}

onApiReset(() => {
  apiServices.value = []
  apiIncidents.value = []
  apiUptime.value = []
})

export function useSystemStatus() {
  const { tbl, commit, nextId } = useMockDb()
  const { notifyAdmins } = useNotifications()
  const isApi = useApiMode()
  const servicesTbl = isApi ? apiServices : tbl('systemServices')
  const incidents = isApi ? apiIncidents : tbl('serviceIncidents')
  const uptimeDaily = isApi ? apiUptime : tbl('uptimeDaily')
  if (isApi) void loadStatus()

  /** 最新状態の取り直し（ページ表示時に呼ぶ。他管理者の登録・更新の取り込み） */
  async function refresh(): Promise<void> {
    if (!isApi) return
    await loadStatus(true)
  }

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
      worst = worstOf(worst, IMPACT_TO_STATE[i.impact])
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

  /** インシデント登録（管理者操作）。成功後に管理者へ通知（API モードはサーバー発火・非ブロッキング） */
  async function createIncident(input: {
    serviceId: string
    title: string
    impact: IncidentImpact
    body: string
  }): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch<{ id: string }>('/v1/status/incidents', {
        method: 'POST', body: input,
      }))
      if (res.ok) await loadStatus(true)
      return res
    }
    const svc = serviceById(input.serviceId)
    if (!svc) {
      return { ok: false, error: { code: 'AKO-STS-001', message: '対象サービスが見つかりません' } }
    }
    if (!input.title.trim()) {
      return { ok: false, error: { code: 'AKO-STS-002', message: 'タイトルを入力してください' } }
    }
    const now = nowJstIso()
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
  async function addIncidentUpdate(id: string, status: IncidentStatus, body: string): Promise<Result> {
    if (isApi) {
      const res = await apiResult(() => apiFetch<{ id: string }>(`/v1/status/incidents/${id}/updates`, {
        method: 'POST', body: { status, body },
      }))
      if (res.ok) await loadStatus(true)
      return res
    }
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
    const now = nowJstIso()
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
    refresh,
  }
}
