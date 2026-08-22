/**
 * メディア分析の AI 週次レポート・改善施策 API（改善要望 2026-08-21・F-55/F-56）。
 * /v1/media 配下に追加マウントする（既存 routes/media.ts と分割 = ファイル肥大の抑制。パスは重複しない）。
 *
 * - AI 週次レポート: チャンネル × 週開始（月曜）で一意。生成は決定的ヒューリスティック
 *   （shared/domain/media-weekly-report = モックと同一関数・同一入力形 = パリティ）。
 *   **生成済みの週は再生成しない**（アクションの判断が巻き戻らない = 原則2）。
 *   自動生成 = ①一覧を開いたときに直前の完了週を冪等生成（手動ステップを残さない = 原則1）
 *   ②Cloud Scheduler の週次ジョブ（POST /jobs/media-weekly-reports = runMediaWeeklyReports）。
 * - 推奨アクションの判断（実行する / 継続検討 / 対象外）はレポート jsonb 内に記録。
 *   「実行する」は改善施策（media_measures）を自動起票する（部分一意 index で二重起票を防ぐ = 冪等）。
 * - 改善施策: チーム共有（認証済み全員が閲覧・編集可 = 活動記録と同じ所有モデル。設定系の requireAdmin とは別物）。
 *   取消/復元 = 論理削除（原則9.5）。効果検証の AI 評価は決定的ヒューリスティック + ユーザー編集可。
 * エラー: AKO-MREP-001 入力不正 / 002 不在 / 003 未完了週の生成。改善施策は AKO-MMEA-001/002。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, nowJstIso, todayJst } from '../../../shared/domain/jst'
import {
  MEDIA_REPORT_DECISIONS, MEDIA_MEASURE_NAME_CAP, MEDIA_MEASURE_TEXT_CAP,
  emptyVerification, heuristicMeasureEvaluation, heuristicWeeklyMediaReport,
  measureDraftFromAction, measureVerificationError, mediaMeasureError, mediaWeekEndOf, mediaWeekStartOf,
  type MediaMeasureInput, type MediaMeasureVerification, type MediaReportDecision, type MediaWeeklyReportContent,
} from '../../../shared/domain/media-weekly-report'
import { capCodePoints } from '../../../shared/domain/customer-log'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { runListQuery } from '../lib/list-query'
import { fetchMediaMetrics } from './media'

const REPORT_COLS = `mwr.id, mwr.channel_id AS "channelId", mwr.week_start::text AS "weekStart",
  mwr.period_from::text AS "periodFrom", mwr.period_to::text AS "periodTo", mwr.content, mwr.llm,
  to_char(mwr.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt"`

const MEASURE_COLS = `mm.id, mm.channel_id AS "channelId", mm.member_id AS "memberId", mm.name,
  mm.background, mm.content, mm.target, mm.expected_change AS "expectedChange",
  mm.assignee_member_id AS "assigneeMemberId", mm.due_date::text AS "dueDate", mm.status,
  mm.source_report_id AS "sourceReportId", mm.source_action_index AS "sourceActionIndex",
  mm.source_label AS "sourceLabel", mm.verification, mm.active,
  to_char(mm.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
  to_char(mm.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

function str(v: unknown, cap: number): string {
  return capCodePoints(String(v ?? '').trim(), cap)
}

function strOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s || null
}

async function findReport(pool: pg.Pool, id: string): Promise<Record<string, unknown> & { content: MediaWeeklyReportContent }> {
  const { rows } = await pool.query(`SELECT ${REPORT_COLS} FROM media_weekly_reports mwr WHERE id = $1`, [id])
  if (!rows[0]) throw err('AKO-MREP-002', 'AI 週次レポートが見つかりません', 404)
  return rows[0] as Record<string, unknown> & { content: MediaWeeklyReportContent }
}

async function findMeasure(pool: pg.Pool, id: string): Promise<Record<string, unknown> & { verification: MediaMeasureVerification }> {
  const { rows } = await pool.query(`SELECT ${MEASURE_COLS} FROM media_measures mm WHERE id = $1`, [id])
  if (!rows[0]) throw err('AKO-MMEA-002', '改善施策が見つかりません', 404)
  return rows[0] as Record<string, unknown> & { verification: MediaMeasureVerification }
}

/**
 * 週次レポートの冪等生成（存在すればそれを返す・無ければ GA 集計から生成して保存）。
 * weekStart は月曜・完了済みの週（週の終了日 <= 前日 = GA 集計の基準日を越えない）のみ。
 */
export async function ensureWeeklyReport(
  pool: pg.Pool, env: Env, channelId: string, weekStart: string,
): Promise<Record<string, unknown>> {
  if (mediaWeekStartOf(weekStart) !== weekStart) {
    throw err('AKO-MREP-001', '週開始（月曜）の日付を指定してください', 400)
  }
  const weekEnd = mediaWeekEndOf(weekStart)
  if (weekEnd > addDays(todayJst(), -1)) {
    throw err('AKO-MREP-003', 'レポートは完了した週（前日までの集計が揃った週）のみ生成できます', 400)
  }
  const { rows: existing } = await pool.query(
    `SELECT ${REPORT_COLS} FROM media_weekly_reports mwr WHERE channel_id = $1 AND week_start = $2::date`,
    [channelId, weekStart])
  if (existing[0]) return existing[0] as Record<string, unknown>

  // 週の終了日を基準日にした 28 日集計（末尾 7 日 = 対象週）から決定的に生成する。
  // GA の部分失敗（warning あり = 内訳欠落）時は生成しない: 生成済み週は再生成しない設計（原則2）のため、
  // 劣化した集計から作ると誤った内容が恒久保存される（レビュー R1 m-2）。次回の表示/ジョブで自然に再試行する
  const result = await fetchMediaMetrics(pool, env, channelId, 28, false, weekEnd)
  if (result.warning) {
    throw err('AKO-MREP-004',
      `GA 集計が揃っていないためレポートを生成できません（${result.warning}）。時間をおいて再試行してください`, 502)
  }
  const content = heuristicWeeklyMediaReport(result.metrics, weekStart)
  const id = newId('mwr')
  // 同時実行は ON CONFLICT DO NOTHING で片方だけが勝つ（冪等 = 原則2）
  await pool.query(
    `INSERT INTO media_weekly_reports (id, channel_id, week_start, period_from, period_to, content, llm)
     VALUES ($1, $2, $3::date, $4::date, $5::date, $6, false)
     ON CONFLICT (channel_id, week_start) DO NOTHING`,
    [id, channelId, weekStart, weekStart, weekEnd, JSON.stringify(content)])
  const { rows } = await pool.query(
    `SELECT ${REPORT_COLS} FROM media_weekly_reports mwr WHERE channel_id = $1 AND week_start = $2::date`,
    [channelId, weekStart])
  return rows[0] as Record<string, unknown>
}

/** 表示時・ジョブでさかのぼって冪等生成する完了週の数（取り逃した週の回復パス = 原則6-2。
 *  生成済み週は GA を呼ばず即返るため、バックフィルの追加コストは欠番週の分だけ） */
export const REPORT_BACKFILL_WEEKS = 4

/**
 * 週次バッチ（Cloud Scheduler → POST /jobs/media-weekly-reports）。
 * GA 連携済みの全チャンネルについて直近 REPORT_BACKFILL_WEEKS 完了週のレポートを冪等生成する
 * （ジョブ停止・未設定期間があっても直近分は追い付ける = 回復パス）。
 * チャンネル × 週単位の失敗は他を止めない（原則4）。
 */
export async function runMediaWeeklyReports(pool: pg.Pool, env: Env): Promise<{ generated: number; skipped: number; failed: number }> {
  const lastWeekStart = addDays(mediaWeekStartOf(todayJst()), -7)
  const { rows: channels } = await pool.query<{ id: string }>(
    `SELECT mc.id FROM media_channels mc
     JOIN media_ga_tokens t ON t.channel_id = mc.id
     WHERE mc.active = true`)
  let generated = 0; let skipped = 0; let failed = 0
  for (const ch of channels) {
    for (let i = 0; i < REPORT_BACKFILL_WEEKS; i++) {
      const weekStart = addDays(lastWeekStart, -7 * i)
      try {
        const { rows: existing } = await pool.query(
          `SELECT id FROM media_weekly_reports WHERE channel_id = $1 AND week_start = $2::date`,
          [ch.id, weekStart])
        if (existing[0]) { skipped++; continue }
        await ensureWeeklyReport(pool, env, ch.id, weekStart)
        generated++
      } catch (e) {
        failed++
        console.warn(`media weekly report failed (channel=${ch.id}, week=${weekStart}, non-blocking):`, (e as Error).message)
      }
    }
  }
  return { generated, skipped, failed }
}

export function mediaReportsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---------- AI 週次レポート ----------

  // 一覧（サーバーページング 20 件 = X-7。週開始の降順）
  app.get('/weekly-reports', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'media_weekly_reports mwr',
      cols: REPORT_COLS,
      orderBy: 'mwr.week_start DESC, mwr.id',
      maxLimit: 1000,
      defaultLimit: 20,
      filterCols: {
        channelId: { col: 'mwr.channel_id', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  // 冪等生成（既定 = 直前の完了週。過去週も weekStart 指定で生成可能。生成済みはそのまま返す = 原則2）。
  // backfill=true は直近 REPORT_BACKFILL_WEEKS 完了週をまとめて冪等生成（一覧表示時の自動生成 = 取り逃した
  // 週の回復パス。週単位の失敗は他の週を止めない = 原則4）
  app.post('/weekly-reports/generate', async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = String(b.channelId ?? '').trim()
    if (!channelId) throw err('AKO-MREP-001', 'channelId を指定してください', 400)
    if (b.backfill === true) {
      const last = addDays(mediaWeekStartOf(todayJst()), -7)
      let ensured = 0; let failed = 0
      let firstError: unknown = null
      for (let i = 0; i < REPORT_BACKFILL_WEEKS; i++) {
        try {
          await ensureWeeklyReport(pool, env, channelId, addDays(last, -7 * i))
          ensured++
        } catch (e) {
          failed++
          if (!firstError) firstError = e
        }
      }
      // 全滅（未連携等）は最初のエラーをそのまま返す = フロントが状態を判定できる
      if (ensured === 0 && firstError) throw firstError
      return c.json({ data: { ensured, failed } })
    }
    const weekStart = typeof b.weekStart === 'string' && b.weekStart
      ? b.weekStart
      : addDays(mediaWeekStartOf(todayJst()), -7)
    const report = await ensureWeeklyReport(pool, env, channelId, weekStart)
    return c.json({ data: report })
  })

  app.get('/weekly-reports/:id', async (c) => {
    return c.json({ data: await findReport(pool, c.req.param('id')) })
  })

  // 推奨アクションの判断（未判断 / 実行する / 継続検討 / 対象外。再選択・未判断へ戻すことも可 = 原則9.5）。
  // 「実行する」は改善施策を自動起票する（起票済みアクションの再起票は部分一意 index が防ぐ = 冪等・原則2）。
  // 更新は jsonb_set で**対象アクションの要素だけ**を差し替える（チーム共有のため、別アクションを
  // 同時判断しても互いの判断が巻き戻らない = content 全文の read-modify-write をしない。レビュー R1 M-2）
  app.patch('/weekly-reports/:id/actions/:index', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const index = Number(c.req.param('index'))
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const decision = String(b.decision ?? '')
    if (!(MEDIA_REPORT_DECISIONS as readonly string[]).includes(decision)) {
      throw err('AKO-MREP-001', '判断の値が正しくありません（未判断 / 実行する / 継続検討 / 対象外）', 400)
    }
    const report = await findReport(pool, id)
    const content = report.content
    const action = Number.isInteger(index) && index >= 0 ? content.actions[index] : undefined
    if (!action) throw err('AKO-MREP-002', '対象の推奨アクションが見つかりません', 404)

    action.decision = decision as MediaReportDecision
    action.decidedAt = nowJstIso()
    action.decidedByMemberId = user.id
    await pool.query(
      `UPDATE media_weekly_reports
       SET content = jsonb_set(content, ARRAY['actions', $2::text], $3::jsonb)
       WHERE id = $1`,
      [id, String(index), JSON.stringify(action)])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_weekly_reports', entityId: id,
      detail: `AI週次レポートの推奨アクション「${capCodePoints(action.title, 40)}」を${decision}に判断`,
    })

    // 「実行する」→ 改善施策の自動起票（AI がレポート内容から詳細を生成 = measureDraftFromAction）
    let measureId: string | null = null
    let measureCreated = false
    if (decision === '実行する') {
      const draft = measureDraftFromAction(
        { id, channelId: String(report.channelId), periodFrom: String(report.periodFrom), periodTo: String(report.periodTo) },
        action, index)
      const newMeasureId = newId('mms')
      const ins = await pool.query(
        `INSERT INTO media_measures
           (id, channel_id, member_id, name, background, content, target, expected_change,
            assignee_member_id, due_date, status, source_report_id, source_action_index, source_label, verification)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13, $14)
         ON CONFLICT (source_report_id, source_action_index) WHERE source_report_id IS NOT NULL AND source_action_index IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [newMeasureId, draft.channelId, user.id, capCodePoints(draft.name, MEDIA_MEASURE_NAME_CAP),
          capCodePoints(draft.background, MEDIA_MEASURE_TEXT_CAP), capCodePoints(draft.content, MEDIA_MEASURE_TEXT_CAP),
          draft.target, draft.expectedChange, user.id, draft.status, draft.sourceReportId,
          draft.sourceActionIndex, draft.sourceLabel, JSON.stringify(draft.verification)])
      if (ins.rows[0]) {
        measureId = String(ins.rows[0].id)
        measureCreated = true
        await audit(pool, {
          actorId: user.id, action: 'create', entity: 'media_measures', entityId: measureId,
          detail: `AI週次レポートから改善施策「${capCodePoints(draft.name, 40)}」を起票`,
        })
      } else {
        // 起票済み（取消済み含む）= 二重起票しない（冪等）。既存の id を返しフロントが文言を出し分ける
        const { rows } = await pool.query(
          `SELECT id FROM media_measures WHERE source_report_id = $1 AND source_action_index = $2`, [id, index])
        measureId = rows[0] ? String(rows[0].id) : null
      }
    }
    return c.json({ data: { report: await findReport(pool, id), measureId, measureCreated } })
  })

  // ---------- 改善施策 ----------

  // 一覧（サーバーページング 20 件 = X-7。フィルタ = 対象メディア / 担当 / ステータス / 効果判定 / 期間）
  app.get('/measures', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'media_measures mm',
      cols: MEASURE_COLS,
      orderBy: 'mm.created_at DESC, mm.id DESC',
      maxLimit: 1000,
      defaultLimit: 20,
      searchCols: ['mm.name', 'mm.background', 'mm.content', 'mm.target'],
      filterCols: {
        channelId: { col: 'mm.channel_id', kind: 'eq' },
        assigneeMemberId: { col: 'mm.assignee_member_id', kind: 'eq' },
        status: { col: 'mm.status', kind: 'enum' },
        evaluation: { col: `mm.verification->>'humanEvaluation'`, kind: 'eq' },
        createdOn: { col: 'mm.created_at', kind: 'date' },
        active: { col: 'mm.active::text', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  app.get('/measures/:id', async (c) => {
    return c.json({ data: await findMeasure(pool, c.req.param('id')) })
  })

  // 編集（全員可 = チーム共有。送られたキーのみ更新 = 部分更新の安全側。verification もキー単位マージ）
  app.patch('/measures/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await findMeasure(pool, id)
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const merged: MediaMeasureInput = {
      channelId: String(cur.channelId),
      name: has('name') ? str(b.name, MEDIA_MEASURE_NAME_CAP) : String(cur.name),
      background: has('background') ? str(b.background, MEDIA_MEASURE_TEXT_CAP) : String(cur.background),
      content: has('content') ? str(b.content, MEDIA_MEASURE_TEXT_CAP) : String(cur.content),
      target: has('target') ? str(b.target, MEDIA_MEASURE_TEXT_CAP) : String(cur.target),
      expectedChange: has('expectedChange') ? str(b.expectedChange, MEDIA_MEASURE_TEXT_CAP) : String(cur.expectedChange),
      assigneeMemberId: has('assigneeMemberId')
        ? (String(b.assigneeMemberId ?? '').trim() || user.id) : String(cur.assigneeMemberId),
      dueDate: has('dueDate') ? strOrNull(b.dueDate) : (cur.dueDate as string | null),
      status: has('status') ? String(b.status ?? '').trim() : String(cur.status),
    }
    const msg = mediaMeasureError(merged)
    if (msg) throw err('AKO-MMEA-001', msg, 400)

    // 効果検証（部分キーのみマージ。文字列項目は cap・humanEvaluation/implementedOn は語彙検証）
    let verification = cur.verification ?? emptyVerification()
    if (has('verification') && b.verification && typeof b.verification === 'object') {
      const v = b.verification as Partial<MediaMeasureVerification>
      const vmsg = measureVerificationError(v)
      if (vmsg) throw err('AKO-MMEA-001', vmsg, 400)
      const textKeys = ['implementedNote', 'comparePeriod', 'kpiName', 'beforeValue', 'afterValue',
        'change', 'goal', 'aiEvaluation', 'learning', 'nextAction'] as const
      const next = { ...emptyVerification(), ...verification }
      for (const k of textKeys) if (Object.hasOwn(v, k)) next[k] = str(v[k], MEDIA_MEASURE_TEXT_CAP)
      if (Object.hasOwn(v, 'implementedOn')) next.implementedOn = strOrNull(v.implementedOn)
      if (Object.hasOwn(v, 'humanEvaluation')) next.humanEvaluation = (v.humanEvaluation ?? '') as MediaMeasureVerification['humanEvaluation']
      verification = next
    }
    try {
      await pool.query(
        `UPDATE media_measures
         SET name = $2, background = $3, content = $4, target = $5, expected_change = $6,
             assignee_member_id = $7, due_date = $8::date, status = $9, verification = $10, updated_at = now()
         WHERE id = $1`,
        [id, merged.name, merged.background, merged.content, merged.target, merged.expectedChange,
          merged.assigneeMemberId, merged.dueDate, merged.status, JSON.stringify(verification)])
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-MMEA-001', '紐付け先（担当メンバー）が見つかりません', 400)
      }
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_measures', entityId: id, detail: '改善施策を編集',
    })
    return c.json({ data: await findMeasure(pool, id) })
  })

  // 効果検証の AI 評価（決定的ヒューリスティック。実施日前後の週次比較 → verification へ保存・編集可）
  app.post('/measures/:id/ai-evaluation', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const cur = await findMeasure(pool, id)
    const verification = { ...emptyVerification(), ...(cur.verification ?? {}) }
    const implementedOn = verification.implementedOn
    // 実施日前後の各 7 日が窓に収まる基準日を選ぶ（実施 +6 日が前日以前ならそこ・以降は前日基準の代替比較）
    const yesterday = addDays(todayJst(), -1)
    const asOf = implementedOn && addDays(implementedOn, 6) <= yesterday ? addDays(implementedOn, 6) : yesterday
    const { metrics } = await fetchMediaMetrics(pool, env, String(cur.channelId), 28, false, asOf === yesterday ? undefined : asOf)
    const evaluated = heuristicMeasureEvaluation({ name: String(cur.name), verification }, metrics)
    const next = { ...verification, ...evaluated }
    await pool.query(
      `UPDATE media_measures SET verification = $2, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(next)])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'media_measures', entityId: id, detail: '改善施策の効果検証を AI 評価',
    })
    return c.json({ data: await findMeasure(pool, id) })
  })

  // 取消/復元（論理削除。全員可・冪等）
  app.post('/measures/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findMeasure(pool, id)
    const upd = await pool.query(
      `UPDATE media_measures SET active = false, updated_at = now() WHERE id = $1 AND active = true`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'media_measures', entityId: id, detail: '改善施策を取消' })
    return c.json({ data: { id } })
  })

  app.post('/measures/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await findMeasure(pool, id)
    const upd = await pool.query(
      `UPDATE media_measures SET active = true, updated_at = now() WHERE id = $1 AND active = false`, [id])
    if (upd.rowCount === 0) return c.json({ data: { id, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'media_measures', entityId: id, detail: '改善施策を復元' })
    return c.json({ data: { id } })
  })

  return app
}
