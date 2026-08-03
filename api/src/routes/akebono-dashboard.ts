/**
 * セグメント別 / 会社全体ダッシュボードの AI レポート・インサイト API（F-41。Phase D = 0036）。
 *
 * media_insights（0030）/ weekly_insights（0026）と同型の**導出キャッシュ upsert**。
 * - 集計材料はサーバー組み立て（Phase C の buildIntegratedMetrics = 売上軸 sales_records +
 *   メディア軸 GA）を消費する。クライアントからメトリクスを受領しない（改ざん余地なし）。
 * - 洞察は Vertex AI（generateJson）→ 失敗時は shared/domain/portfolio-insight の決定的
 *   ヒューリスティックへフォールバック（原則4。llm フラグで区別）。
 * - scope='segment'（segment_id 参照）/ 'company'（会社全体・segment_id='' の番兵）で 1 レコード = upsert。
 * - 認可: 参照・生成とも認証済み全員（mockup ダッシュボードと同じ可視性。generated_by を記録）。
 *   akebono featureGuard の配下。会社全体の閲覧導線はフロントが売上権限でゲート（他入口と一貫）。
 * - M1（虚偽データ由来の保管禁止）: GA 連携済みで月次が取得できない場合は生成しない（AKO-MEDIA-004）。
 *   会社全体は 1 業態でも取得失敗があれば生成しない（欠けた業態の「流入ゼロ」混入を防ぐ）。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { todayJst } from '../../../shared/domain/jst'
import {
  heuristicCompanyInsight, heuristicSegmentInsight,
  type CompanySummary, type DashboardInsight, type DashboardMonthPoint,
  type MediaAction, type MediaFinding, type SegmentSnapshot, type SegmentSummary,
} from '../../../shared/domain/portfolio-insight'
import { canUseFeature } from '../../../shared/domain/permissions'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { buildSegmentIntegratedMetrics } from './media'

/** 集計・トレンドの対象月数（mockup useDashboardInsight の MONTHS と一致） */
const MONTHS = 6

/** 業種タイプ表示名（mockup utils/akebono の INDUSTRY_TYPE_LABELS と一致 = 両モードで同一ラベル） */
const INDUSTRY_TYPE_LABELS: Record<string, string> = {
  retail: '小売業',
  maker: 'メーカー業',
  logistics: '物流・倉庫業',
  it_service: '情報サービス業',
  other: 'その他',
}

/** 保管済みレコードの参照列（media_insights と同形式。generatedByName は members から解決） */
const INSIGHT_COLS = `di.id, di.period_key AS "periodKey", di.metrics, di.insight, di.llm,
  to_char(di.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt",
  m.name AS "generatedByName"`

/**
 * メディア機能トグル（'media' = m13）がサーバー視点で有効か。
 * app_configs の featureToggles 配列に 'media' があればその enabled、無ければシード既定 true
 * （mockup seedFeatureToggles の media = enabled:true と一致 = クライアント isEnabled('media') と同値）。
 */
export async function mediaFeatureEnabled(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM app_configs WHERE key = 'featureToggles'`)
  const toggles = rows[0]?.value
  if (Array.isArray(toggles)) {
    const t = toggles.find(x => x && typeof x === 'object' && (x as { key?: string }).key === 'media') as
      { enabled?: unknown } | undefined
    if (t && typeof t.enabled === 'boolean') return t.enabled
  }
  return true
}

interface SnapshotBuild {
  snapshot: SegmentSnapshot
  trend: DashboardMonthPoint[]
  periodMonth: string
  mediaFailed: boolean
}

/**
 * セグメント 1 件のスナップショット + トレンド（業務 × メディア）をサーバーで組み立てる。
 * メディア軸は「機能トグル有効 && GA 連携済み」のときのみ有効（それ以外は 0 = 事実を作らない）。
 * mockup useDashboardInsight.snapshotFor と同一の意味論（connected の判定・0 埋め）。
 */
async function buildSnapshot(
  pool: pg.Pool, env: Env, segmentId: string, mediaAvailable: boolean,
): Promise<SnapshotBuild> {
  // F-41 は業態基点。業態に連携したメディアチャンネル（あれば）から統合メトリクスを組み立てる
  const built = await buildSegmentIntegratedMetrics(pool, env, segmentId, MONTHS, false)
  const im = built.metrics
  const { rows: segRows } = await pool.query<{ name: string; industryType: string }>(
    `SELECT name, industry_type AS "industryType" FROM business_segments WHERE id = $1`, [segmentId])
  // 記事数は業態に連携したチャンネル配下の記事を合算（0048 で media_articles は channel_id keying へ移行）
  const { rows: artRows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM media_articles a
       JOIN media_channels c ON c.id = a.channel_id
      WHERE c.segment_id = $1 AND c.active AND a.active`, [segmentId])
  // メディア機能トグルが無効なら GA 連携済みでもメディア軸を無効化（指標・レポート・全社ロールアップを一貫）
  const connected = mediaAvailable && built.mediaConnected
  const snapshot: SegmentSnapshot = {
    segmentId,
    segmentName: segRows[0]?.name ?? im.segmentName ?? 'セグメント',
    industryLabel: segRows[0] ? INDUSTRY_TYPE_LABELS[segRows[0].industryType] ?? '' : '',
    mediaConnected: connected,
    salesAmount: im.salesAmount,
    prevSalesAmount: im.prevSalesAmount,
    orders: im.orders,
    aov: im.aov,
    sessions: connected ? im.sessions : 0,
    prevSessions: connected ? im.prevSessions : 0,
    conversions: connected ? im.conversions : 0,
    conversionRate: connected ? im.conversionRate : 0,
    articleCount: artRows[0]?.count ?? 0,
  }
  const trend: DashboardMonthPoint[] = im.trend.map(t => ({
    month: t.month,
    salesAmount: t.salesAmount,
    orders: t.orders,
    sessions: connected ? t.sessions : 0,
    conversions: connected ? t.conversions : 0,
  }))
  // メディア軸を無効化しているとき（トグル off・未連携）は GA 取得失敗を「生成不可」に昇格させない
  // （メディアを見ない業態を GA 障害で止めない）。連携済みかつトグル有効のときのみ mediaFailed を伝播
  return { snapshot, trend, periodMonth: im.periodMonth, mediaFailed: connected && built.mediaFailed }
}

// ---------- LLM（Vertex AI）→ 失敗・無効環境は null = ヒューリスティックへフォールバック（原則4） ----------

const FINDING_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { kind: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
    required: ['kind', 'title', 'detail'],
  },
}
const ACTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { title: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string' } },
    required: ['title', 'detail', 'priority'],
  },
}
const FINDING_KINDS = new Set(['win', 'issue', 'opportunity'])
const PRIORITIES = new Set(['high', 'mid', 'low'])

/** LLM 出力 → DashboardInsight（欠落・型崩れは null = ヒューリスティックへフォールバック） */
export function normalizeDashboardInsight(res: unknown): DashboardInsight | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const executiveSummary = String(r.executiveSummary ?? '').trim()
  if (!executiveSummary) return null
  const findings: MediaFinding[] = (Array.isArray(r.findings) ? r.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map(f => ({
      kind: FINDING_KINDS.has(String(f.kind)) ? String(f.kind) as MediaFinding['kind'] : 'opportunity',
      title: String(f.title ?? '').trim(),
      detail: String(f.detail ?? '').trim(),
    }))
    .filter(f => f.title.length > 0)
    .slice(0, 6)
  const actions: MediaAction[] = (Array.isArray(r.actions) ? r.actions : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map(a => ({
      title: String(a.title ?? '').trim(),
      detail: String(a.detail ?? '').trim(),
      priority: PRIORITIES.has(String(a.priority)) ? String(a.priority) as MediaAction['priority'] : 'mid',
    }))
    .filter(a => a.title.length > 0)
    .slice(0, 6)
  return { executiveSummary, findings, actions }
}

async function llmDashboardInsight(
  env: Env, scope: 'segment' | 'company', metrics: SegmentSummary | CompanySummary,
): Promise<DashboardInsight | null> {
  if (!env.vertexProjectId) return null
  const scopeLabel = scope === 'segment' ? '業態（セグメント）単位' : '会社全体（全業態横断）'
  const res = await generateJson<Record<string, unknown>>(env, {
    system: 'あなたは事業会社の経営参謀 AI です。業務（売上・受注）とオウンドメディア（GA 流入・CV）を統合した'
      + `${scopeLabel}のダッシュボード集計から、経営レポート（ナラティブ）とインサイト（好調/課題/機会）・`
      + '次アクションを日本語で出力します。集計値にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'executiveSummary は 3〜5 文（マークダウン可）。kind は win / issue / opportunity、'
      + 'priority は high / mid / low。各 title は 40 字以内・detail は具体的かつ簡潔に（各最大 5 件）。',
    prompt: `# ${scopeLabel}ダッシュボード集計\n${JSON.stringify(metrics, null, 1)}`,
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        findings: FINDING_SCHEMA,
        actions: ACTION_SCHEMA,
      },
      required: ['executiveSummary', 'findings', 'actions'],
    },
    maxTokens: 3000,
  })
  return normalizeDashboardInsight(res)
}

/**
 * 会社全体ダッシュボード（scope=company）は全社の売上を含む C3 = 売上権限（'sales'）をサーバーでも要求する
 * （監査-4。フロントの can('sales') ゲートと一致 = クライアントゲートのみに依存しない。原則6/認可）。
 * ルール未設定は既定 allow（下位互換 = featureGuard と同方針）。業態単位（scope=segment）は業態の日常業務
 * ビュー = 全ロール可（mockup と一致）。
 */
async function requireCompanyDashboardAccess(pool: pg.Pool, user: AuthUser): Promise<void> {
  const rules = await activePermissionRules(pool)
  if (rules.length === 0) return
  if (!canUseFeature(rules, subjectOf(user), 'sales')) {
    throw err('AKO-PRM-001', '会社全体ダッシュボードの閲覧には売上権限が必要です（管理者にお問い合わせください）', 403)
  }
}

export function akebonoDashboardRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---- 保管済みインサイトの取得（未生成は null） ----
  app.get('/dashboard-insights', async (c) => {
    const scope = c.req.query('scope')
    if (scope !== 'segment' && scope !== 'company') {
      throw err('AKO-GEN-001', 'scope は segment / company を指定してください', 400)
    }
    if (scope === 'company') await requireCompanyDashboardAccess(pool, c.get('user'))
    const segmentId = scope === 'segment' ? String(c.req.query('segmentId') ?? '').trim() : ''
    if (scope === 'segment' && !segmentId) throw err('AKO-GEN-001', 'segmentId を指定してください', 400)
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM dashboard_insights di LEFT JOIN members m ON m.id = di.generated_by
       WHERE di.scope = $1 AND di.segment_id = $2`, [scope, segmentId])
    return c.json({ data: rows[0] ?? null })
  })

  // ---- 生成・再生成（生成 → 保管 → 再生成で upsert 上書き = media_insights と同型） ----
  app.post('/dashboard-insights/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const scope = body.scope
    if (scope !== 'segment' && scope !== 'company') {
      throw err('AKO-GEN-001', 'scope は segment / company を指定してください', 400)
    }
    const mediaAvailable = await mediaFeatureEnabled(pool)

    let metrics: SegmentSummary | CompanySummary
    let segmentKey: string

    if (scope === 'segment') {
      const segmentId = String(body.segmentId ?? '').trim()
      if (!segmentId) throw err('AKO-GEN-001', 'segmentId を指定してください', 400)
      const { rows: segRows } = await pool.query(`SELECT 1 FROM business_segments WHERE id = $1`, [segmentId])
      if (segRows.length === 0) throw err('AKO-GEN-002', `事業セグメントが見つかりません（${segmentId}）`, 404)
      const built = await buildSnapshot(pool, env, segmentId, mediaAvailable)
      if (built.mediaFailed) {
        throw err('AKO-MEDIA-004', 'Google Analytics の月次トレンドを取得できないため、レポートを生成できません。時間をおいて再試行してください', 502)
      }
      metrics = {
        periodMonth: built.periodMonth, mediaAvailable, snapshot: built.snapshot, trend: built.trend,
      }
      segmentKey = segmentId
    } else {
      // 会社全体（全業態横断）は売上権限を要求（監査-4）。全業態の GA 月次をそろえ、1 業態でも取得失敗なら生成しない（M1）
      await requireCompanyDashboardAccess(pool, user)
      const { rows: segs } = await pool.query<{ id: string }>(
        `SELECT id FROM business_segments WHERE active ORDER BY display_order, id`)
      const builds = await Promise.all(segs.map(s => buildSnapshot(pool, env, s.id, mediaAvailable)))
      if (builds.some(b => b.mediaFailed)) {
        throw err('AKO-MEDIA-004', '一部の業態で Google Analytics の月次トレンドを取得できないため、レポートを生成できません。時間をおいて再試行してください', 502)
      }
      metrics = buildCompanySummary(builds, mediaAvailable)
      segmentKey = ''
    }

    // 洞察: Vertex AI → 失敗・無効環境はヒューリスティック（llm フラグで区別。原則4）
    const llmRes = await llmDashboardInsight(env, scope, metrics)
    const insight: DashboardInsight = llmRes ?? heuristicOf(scope, metrics)
    const llm = !!llmRes
    const periodKey = metrics.periodMonth
    await pool.query(
      `INSERT INTO dashboard_insights (id, scope, segment_id, period_key, metrics, insight, llm, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (scope, segment_id) DO UPDATE SET
         period_key = EXCLUDED.period_key, metrics = EXCLUDED.metrics, insight = EXCLUDED.insight,
         llm = EXCLUDED.llm, generated_by = EXCLUDED.generated_by, generated_at = now()`,
      [newId('di'), scope, segmentKey, periodKey, JSON.stringify(metrics), JSON.stringify(insight), llm, user.id])
    const { rows } = await pool.query(
      `SELECT ${INSIGHT_COLS}
       FROM dashboard_insights di LEFT JOIN members m ON m.id = di.generated_by
       WHERE di.scope = $1 AND di.segment_id = $2`, [scope, segmentKey])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'dashboard_insights',
      entityId: `${scope}:${segmentKey || 'company'}`, detail: 'ダッシュボード AI レポートを生成',
    })
    return c.json({ data: rows[0] })
  })

  return app
}

/** 会社全体（全業態横断）のロールアップ。全業態は同じ月ウィンドウなので月インデックスで合算する */
function buildCompanySummary(builds: SnapshotBuild[], mediaAvailable: boolean): CompanySummary {
  const snapshots = builds.map(b => b.snapshot)
  const periodMonth = builds[0]?.periodMonth ?? todayJst().slice(0, 7)
  const monthKeys = builds[0]?.trend.map(t => t.month) ?? []
  const trend: DashboardMonthPoint[] = monthKeys.map((month, i) => {
    let salesAmount = 0; let orders = 0; let sessions = 0; let conversions = 0
    for (const b of builds) {
      const pt = b.trend[i]
      if (!pt) continue
      salesAmount += pt.salesAmount
      orders += pt.orders
      sessions += pt.sessions
      conversions += pt.conversions
    }
    return { month, salesAmount, orders, sessions, conversions }
  })
  const sum = (fn: (s: SegmentSnapshot) => number): number => snapshots.reduce((a, s) => a + fn(s), 0)
  return {
    periodMonth,
    mediaAvailable,
    segmentCount: snapshots.length,
    connectedCount: snapshots.filter(s => s.mediaConnected).length,
    totalSales: sum(s => s.salesAmount),
    prevTotalSales: sum(s => s.prevSalesAmount),
    totalOrders: sum(s => s.orders),
    totalSessions: sum(s => s.sessions),
    prevTotalSessions: sum(s => s.prevSessions),
    totalConversions: sum(s => s.conversions),
    snapshots,
    trend,
  }
}

/** llm フラグ判定用: scope に応じたヒューリスティック結果（LLM 出力と参照比較して llm=true/false を決める） */
function heuristicOf(scope: 'segment' | 'company', metrics: SegmentSummary | CompanySummary): DashboardInsight {
  return scope === 'segment'
    ? heuristicSegmentInsight(metrics as SegmentSummary)
    : heuristicCompanyInsight(metrics as CompanySummary)
}
