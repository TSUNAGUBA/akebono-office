/**
 * メディア分析の AI 週次レポート・改善施策（改善要望 2026-08-21・F-55/F-56）。
 * - AI 週次レポート: チャンネル × 週開始（月曜）で一意。生成は決定的ヒューリスティック
 *   （shared/domain/media-weekly-report = API と同一関数・同一入力形 = パリティ）。
 *   モック = 訪問時に直近の完了週分を遅延生成（冪等 = 生成済み週は再生成しない → 判断が巻き戻らない・原則2）/
 *   API = サーバー生成（一覧を開いたとき直前の完了週を冪等生成 + 週次ジョブ /jobs/media-weekly-reports）。
 * - 推奨アクションの判断（実行する / 継続検討 / 対象外）はレポート内に記録し、「実行する」は
 *   改善施策（mediaMeasures）を自動起票する（同一アクションの二重起票は防ぐ = 冪等）。
 * - 改善施策: チーム共有（全員が閲覧・編集可）・取消/復元 = 原則9.5。効果検証の AI 評価は
 *   決定的ヒューリスティック（実施前後の週次比較）+ ユーザー編集可。
 */
import {
  emptyVerification, heuristicMeasureEvaluation, heuristicWeeklyMediaReport,
  measureDraftFromAction, measureVerificationError, mediaMeasureError, mediaWeekEndOf, mediaWeekStartOf,
  MEDIA_MEASURE_NAME_CAP, MEDIA_MEASURE_TEXT_CAP, MEDIA_REPORT_DECISIONS,
  type MediaMeasure, type MediaMeasureVerification, type MediaReportDecision, type MediaWeeklyReport,
} from '../../../shared/domain/media-weekly-report'
import { capCodePoints as capCp } from '../../../shared/domain/customer-log'
import { deriveMediaMetrics, type MediaMetrics } from '../../../shared/domain/media-metrics'
import type { Result } from '~/types/domain'
import type { Tone } from '~/types/ui'

/** モックで遅延生成する完了週の数（直近 8 週 = デモで一覧・ページングが体感できる分量） */
const MOCK_REPORT_WEEKS = 8

/** ステータス・効果判定・優先度の表示トーン（単一ドメイン固有のためここに定義 = 規約6） */
export const MEDIA_MEASURE_STATUS_TONES: Record<string, Tone> = {
  実施予定: 'info', 実施中: 'brand', 効果観測中: 'warn', 評価待ち: 'serious', 完了: 'ok',
}
export const MEDIA_MEASURE_EVALUATION_TONES: Record<string, Tone> = {
  効果あり: 'ok', 判断保留: 'warn', 効果なし: 'crit',
}
export const MEDIA_REPORT_DECISION_TONES: Record<string, Tone> = {
  未判断: 'warn', 実行する: 'ok', 継続検討: 'info', 対象外: 'neutral',
}

export function useMediaReports() {
  const { tbl, commit, nextId } = useMockDb()
  const { currentUser } = useCurrentUser()
  const isApi = useApiMode()
  const ma = useMediaAnalytics()
  const { settingFor } = useMediaChannels()
  const reportsTbl = tbl('mediaWeeklyReports')
  const measuresTbl = tbl('mediaMeasures')

  // ---------- モックの決定的メトリクス（基準日指定。レポート生成・AI 評価で使用） ----------
  function mockMetricsAt(channelId: string, asOf: string): MediaMetrics {
    const setting = settingFor(channelId)
    return deriveMediaMetrics(ma.articleInputsFor(channelId), {
      segmentId: channelId,
      siteName: setting?.siteName || setting?.name || 'メディア',
      asOf,
      days: 28,
    })
  }

  // ---------- AI 週次レポート ----------

  /** 完了週の週開始リスト（新しい順。直前の完了週から MOCK_REPORT_WEEKS 週分） */
  function completedWeekStarts(): string[] {
    const last = addDays(mediaWeekStartOf(todayJst()), -7)
    return Array.from({ length: MOCK_REPORT_WEEKS }, (_, i) => addDays(last, -7 * i))
  }

  /**
   * モック: 未生成の完了週レポートを遅延生成する（決定的・冪等 = 生成済み週はスキップ）。
   * 「自動で週次レポートが生成される」のモック実装（API はサーバー生成 + 週次ジョブが担う）。
   */
  function ensureMockReports(channelId: string): void {
    if (isApi || !channelId) return
    const all = reportsTbl.value as MediaWeeklyReport[]
    const existing = new Set(all.filter(r => r.channelId === channelId).map(r => r.weekStart))
    const missing = completedWeekStarts().filter(w => !existing.has(w))
    if (missing.length === 0) return
    const generated: MediaWeeklyReport[] = missing.map((weekStart) => {
      const weekEnd = mediaWeekEndOf(weekStart)
      const metrics = mockMetricsAt(channelId, weekEnd)
      return {
        id: nextId('mediaWeeklyReports', 'mwr'),
        channelId,
        weekStart,
        periodFrom: weekStart,
        periodTo: weekEnd,
        content: heuristicWeeklyMediaReport(metrics, weekStart),
        llm: false,
        generatedAt: nowJstIso(),
      }
    })
    reportsTbl.value = [...all, ...generated]
    commit()
  }

  /** API: 直近の完了週レポートの冪等バックフィル生成（一覧を開いたときの自動生成 = 取り逃した週の回復パス。
   *  セッション中 1 回だけ試行。force = GA 連携直後の再試行用（同一セッションで連携が完了したケース = レビュー R1 m-7） */
  async function ensureLatestReport(channelId: string, force = false): Promise<void> {
    if (!isApi || !channelId) return
    await apiLoadOnce(`media:weekly-report:ensure:${channelId}`, async () => {
      try {
        await apiFetch('/v1/media/weekly-reports/generate', { method: 'POST', body: { channelId, backfill: true } })
        await loadApiCollection('mediaWeeklyReports', true)
      } catch {
        // 未連携（AKO-MEDIA-003）等は生成せず一覧（空/既存分）を表示（非ブロッキング = 原則4）
      }
    }, force)
  }

  /**
   * 未生成分の自動生成（ページ表示時に呼ぶ。computed の中では呼ばない = 算出中の書込を避ける）。
   * モック = 直近の完了週分を同期生成 / API = サーバーへ直近完了週のバックフィル冪等生成を依頼。
   * force = セッション中の再試行（GA 連携直後など）
   */
  async function ensureGenerated(channelId: string, force = false): Promise<void> {
    if (isApi) await ensureLatestReport(channelId, force)
    else ensureMockReports(channelId)
  }

  /** チャンネルのレポート一覧（週開始の降順）。生成は ensureGenerated が担う（本関数は参照のみ） */
  function reportsFor(channelId: string): MediaWeeklyReport[] {
    return (reportsTbl.value as MediaWeeklyReport[])
      .filter(r => r.channelId === channelId)
      .slice()
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
  }

  /** レポートの単件解決（一覧キャッシュから。API は必要時に単件フェッチで補完） */
  function reportById(id: string): MediaWeeklyReport | null {
    return (reportsTbl.value as MediaWeeklyReport[]).find(r => r.id === id) ?? null
  }

  async function fetchReport(id: string): Promise<MediaWeeklyReport | null> {
    const cached = reportById(id)
    if (cached) return cached
    if (!isApi) return null
    try {
      return await apiFetch<MediaWeeklyReport>(`/v1/media/weekly-reports/${id}`)
    } catch {
      return null
    }
  }

  /**
   * 推奨アクションの判断（実行する / 継続検討 / 対象外）。
   * 「実行する」は改善施策を自動起票する（同一アクションの二重起票はしない = 冪等）。
   */
  async function decideAction(
    reportId: string, actionIndex: number, decision: MediaReportDecision,
  ): Promise<Result & { measureId?: string | null; measureCreated?: boolean }> {
    if (!(MEDIA_REPORT_DECISIONS as readonly string[]).includes(decision)) {
      return { ok: false, error: { code: 'AKO-MREP-001', message: '判断の値が正しくありません' } }
    }
    if (isApi) {
      const res = await apiWrite<{ report: MediaWeeklyReport; measureId: string | null; measureCreated?: boolean }>(
        `/v1/media/weekly-reports/${reportId}/actions/${actionIndex}`,
        { method: 'PATCH', body: { decision }, reload: ['mediaWeeklyReports', 'mediaMeasures'] })
      return res.ok
        ? { ok: true, id: reportId, measureId: res.data?.measureId ?? null, measureCreated: res.data?.measureCreated === true }
        : res
    }
    const all = reportsTbl.value as MediaWeeklyReport[]
    const prevReports = all
    const prevMeasures = measuresTbl.value as MediaMeasure[]
    const report = all.find(r => r.id === reportId)
    const action = report?.content.actions[actionIndex]
    if (!report || !action) {
      return { ok: false, error: { code: 'AKO-MREP-002', message: '対象の推奨アクションが見つかりません' } }
    }
    const updatedAction = {
      ...action, decision, decidedAt: nowJstIso(), decidedByMemberId: currentUser.value.id,
    }
    reportsTbl.value = all.map(r => r.id === reportId
      ? {
          ...r,
          content: {
            ...r.content,
            actions: r.content.actions.map((a, i) => (i === actionIndex ? updatedAction : a)),
          },
        }
      : r)
    let measureId: string | null = null
    let measureCreated = false
    if (decision === '実行する') {
      const measures = measuresTbl.value as MediaMeasure[]
      const existing = measures.find(m => m.sourceReportId === reportId && m.sourceActionIndex === actionIndex)
      if (existing) {
        measureId = existing.id
      } else {
        measureCreated = true
        const draft = measureDraftFromAction(report, updatedAction, actionIndex)
        measureId = nextId('mediaMeasures', 'mms')
        measuresTbl.value = [...measures, {
          ...draft,
          id: measureId,
          memberId: currentUser.value.id,
          assigneeMemberId: currentUser.value.id,
          createdAt: nowJstIso(),
          updatedAt: nowJstIso(),
          active: true,
        } satisfies MediaMeasure]
      }
    }
    if (!commit()) {
      // 容量不足はロールバック（登録無反応バグの根本対応と同型 = 活動ログの規約）
      reportsTbl.value = prevReports
      measuresTbl.value = prevMeasures
      return { ok: false, error: { code: 'AKO-MREP-090', message: '保存容量が不足しています' } }
    }
    return { ok: true, id: reportId, measureId, measureCreated }
  }

  // ---------- 改善施策 ----------

  /** 有効な一覧（作成降順 = API の ORDER BY と同一）。channelId 指定で絞り込み */
  function measuresList(channelId?: string): MediaMeasure[] {
    return (measuresTbl.value as MediaMeasure[])
      .filter(m => m.active !== false && (!channelId || m.channelId === channelId))
      .slice()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id))
  }

  function archivedMeasures(): MediaMeasure[] {
    return (measuresTbl.value as MediaMeasure[])
      .filter(m => m.active === false)
      .slice()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  }

  function measureById(id: string): MediaMeasure | null {
    return (measuresTbl.value as MediaMeasure[]).find(m => m.id === id) ?? null
  }

  /** 施策の単件解決（一覧キャッシュ優先。API はキャッシュ未着・上限超過時に単件フェッチで補完 = レビュー R1 m-5） */
  async function fetchMeasure(id: string): Promise<MediaMeasure | null> {
    const cached = measureById(id)
    if (cached) return cached
    if (!isApi) return null
    try {
      return await apiFetch<MediaMeasure>(`/v1/media/measures/${id}`)
    } catch {
      return null
    }
  }

  /**
   * 改善施策の部分更新（送ったキーのみ反映 = 部分更新の安全側。verification もキー単位マージ）。
   * 全員可（チーム共有。訂正履歴は API モードの監査ログ）
   */
  async function saveMeasure(
    id: string,
    patch: Partial<Pick<MediaMeasure, 'name' | 'background' | 'content' | 'target' | 'expectedChange'
      | 'assigneeMemberId' | 'dueDate' | 'status'>> & { verification?: Partial<MediaMeasureVerification> },
  ): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/media/measures/${id}`, {
        method: 'PATCH', body: patch, reload: ['mediaMeasures'],
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = measuresTbl.value as MediaMeasure[]
    const cur = all.find(m => m.id === id)
    if (!cur) return { ok: false, error: { code: 'AKO-MMEA-002', message: '改善施策が見つかりません' } }
    const has = (k: string): boolean => Object.hasOwn(patch, k)
    const merged = {
      channelId: cur.channelId,
      name: has('name') ? capCp((patch.name ?? '').trim(), MEDIA_MEASURE_NAME_CAP) : cur.name,
      background: has('background') ? capCp((patch.background ?? '').trim(), MEDIA_MEASURE_TEXT_CAP) : cur.background,
      content: has('content') ? capCp((patch.content ?? '').trim(), MEDIA_MEASURE_TEXT_CAP) : cur.content,
      target: has('target') ? capCp((patch.target ?? '').trim(), MEDIA_MEASURE_TEXT_CAP) : cur.target,
      expectedChange: has('expectedChange') ? capCp((patch.expectedChange ?? '').trim(), MEDIA_MEASURE_TEXT_CAP) : cur.expectedChange,
      assigneeMemberId: has('assigneeMemberId') ? (patch.assigneeMemberId || currentUser.value.id) : cur.assigneeMemberId,
      dueDate: has('dueDate') ? (patch.dueDate || null) : cur.dueDate,
      status: has('status') ? (patch.status ?? '') : cur.status,
    }
    const msg = mediaMeasureError(merged)
    if (msg) return { ok: false, error: { code: 'AKO-MMEA-001', message: msg } }
    let verification = { ...emptyVerification(), ...cur.verification }
    if (patch.verification) {
      const vmsg = measureVerificationError(patch.verification)
      if (vmsg) return { ok: false, error: { code: 'AKO-MMEA-001', message: vmsg } }
      const v = patch.verification
      const textKeys = ['implementedNote', 'comparePeriod', 'kpiName', 'beforeValue', 'afterValue',
        'change', 'goal', 'aiEvaluation', 'learning', 'nextAction'] as const
      for (const k of textKeys) if (Object.hasOwn(v, k)) verification[k] = capCp((v[k] ?? '').trim(), MEDIA_MEASURE_TEXT_CAP)
      if (Object.hasOwn(v, 'implementedOn')) verification.implementedOn = v.implementedOn || null
      if (Object.hasOwn(v, 'humanEvaluation')) verification.humanEvaluation = v.humanEvaluation ?? ''
    }
    measuresTbl.value = all.map(m => m.id === id
      ? { ...m, ...merged, verification, updatedAt: nowJstIso() }
      : m)
    if (!commit()) {
      measuresTbl.value = all // ロールバック（容量不足で無反応にしない）
      return { ok: false, error: { code: 'AKO-MMEA-090', message: '保存容量が不足しています' } }
    }
    return { ok: true, id }
  }

  /** 効果検証の AI 評価（決定的。実施日前後の週次比較 → verification へ保存・その後も編集可） */
  async function aiEvaluate(id: string): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/media/measures/${id}/ai-evaluation`, { reload: ['mediaMeasures'] })
      return res.ok ? { ok: true, id } : res
    }
    const cur = measureById(id)
    if (!cur) return { ok: false, error: { code: 'AKO-MMEA-002', message: '改善施策が見つかりません' } }
    const verification = { ...emptyVerification(), ...cur.verification }
    const yesterday = addDays(todayJst(), -1)
    const on = verification.implementedOn
    const asOf = on && addDays(on, 6) <= yesterday ? addDays(on, 6) : yesterday
    const evaluated = heuristicMeasureEvaluation({ name: cur.name, verification }, mockMetricsAt(cur.channelId, asOf))
    return saveMeasure(id, { verification: evaluated })
  }

  /** 取消/復元（論理削除。全員可・冪等） */
  async function setMeasureActive(id: string, active: boolean): Promise<Result> {
    if (isApi) {
      const res = await apiWrite(`/v1/media/measures/${id}/${active ? 'restore' : 'archive'}`, {
        reload: ['mediaMeasures'], idempotent: true,
      })
      return res.ok ? { ok: true, id } : res
    }
    const all = measuresTbl.value as MediaMeasure[]
    const target = all.find(m => m.id === id)
    if (!target) return { ok: false, error: { code: 'AKO-MMEA-002', message: '改善施策が見つかりません' } }
    if ((target.active !== false) === active) return { ok: true, id }
    measuresTbl.value = all.map(m => m.id === id ? { ...m, active, updatedAt: nowJstIso() } : m)
    commit()
    return { ok: true, id }
  }

  const archiveMeasure = (id: string): Promise<Result> => setMeasureActive(id, false)
  const restoreMeasure = (id: string): Promise<Result> => setMeasureActive(id, true)

  /** サーバーキャッシュの再取得（API モードのみ） */
  async function refresh(): Promise<void> {
    if (isApi) {
      await Promise.all([
        loadApiCollection('mediaWeeklyReports', true),
        loadApiCollection('mediaMeasures', true),
      ])
    }
  }

  return {
    reportsFor, reportById, fetchReport, ensureGenerated, decideAction,
    measuresList, archivedMeasures, measureById, fetchMeasure, saveMeasure, aiEvaluate,
    archiveMeasure, restoreMeasure, refresh,
  }
}
