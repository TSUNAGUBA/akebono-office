/**
 * 統合テスト（実 PostgreSQL）。DATABASE_URL 必須（test/run-integration.sh が起動・設定する）。
 * マイグレーション適用 → dev 認証で主要フローをエンドツーエンドに検証する。
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import pg from 'pg'
import { addDays, todayJst } from '../../../shared/domain/jst'
import { createApp } from '../../src/app'
import { migrate } from '../../src/db/migrate'
import { activePermissionRules, clearPermissionCache } from '../../src/lib/permissions'
import { createPool } from '../../src/db/pool'
import type { Env } from '../../src/env'

const env: Env = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  dbSsl: 'disable',
  dbSslCa: '',
  port: 0,
  authMode: 'dev',
  firebaseProjectId: '',
  corsOrigins: [],
  migrateOnStart: false,
  vertexProjectId: '', // LLM 無効 = 全 AI 機能はヒューリスティックへフォールバック
  vertexLocation: 'global',
  vertexModel: 'gemini-2.5-flash',
  vertexEmbeddingModel: 'text-multilingual-embedding-002', // 無効環境 = 埋め込みなし（字句検索のみ）
  googleOauthClientId: '', // カレンダー連携無効（AKO-CAL-007 経路を検証）
  googleOauthClientSecret: '',
  tokenEncryptionKey: 'test-encryption-key',
  storageBucket: '',
}

let pool: pg.Pool
let app: Hono

const ADMIN = 'm-admin'
const HR = 'm-hr'
const MEMBER = 'm-member'

async function api(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown } = {},
): Promise<{ status: number; json: { data?: unknown; error?: { code: string; message: string } } }> {
  const res = await app.request(path, {
    method,
    headers: {
      ...(opts.as ? { 'x-dev-member-id': opts.as } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, json: await res.json() as never }
}

interface AiTaskRow {
  id: string
  status: string
  decomposition: { title: string; done: boolean }[]
  questions: { status: string; question: string }[]
  outputs: { step: number; title: string; body: string }[]
}

/**
 * AI タスクが条件を満たすまでポーリング（バッチ7i: 承認・回答後の自動実行は fire-and-forget のため、
 * 状態遷移を待ってから検証する。LLM 無効環境はヒューリスティック = 通常 1〜2 周で収束）
 */
async function waitAiTask(
  taskId: string,
  pred: (t: AiTaskRow) => boolean,
  tries = 100,
): Promise<AiTaskRow> {
  let last: AiTaskRow | undefined
  for (let i = 0; i < tries; i++) {
    const list = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as AiTaskRow[]
    last = list.find(x => x.id === taskId)
    if (last && pred(last)) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`AI task ${taskId} が期待状態に達しません（最終: ${last?.status}）`)
}

/**
 * 通知が届くまでポーリング（AI カンパニーの完了・連携通知は fire-and-forget = トランザクション確定後に
 * 発行されるため、タスク status が done でも通知はわずかに遅れて着信する。status を待つ waitAiTask と
 * 同様に結果整合性を吸収する = CI フレーク防止。原則4: 通知は非ブロッキングで主要フローを止めない）
 */
async function waitNotification(
  as: string,
  pred: (n: { kind: string; title: string }) => boolean,
  tries = 100,
): Promise<void> {
  let count = 0
  for (let i = 0; i < tries; i++) {
    const notes = (await api('GET', '/v1/notifications', { as })).json.data as { kind: string; title: string }[]
    count = notes.length
    if (notes.some(pred)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`期待した通知が届きません（最新 ${count} 件を確認）`)
}

beforeAll(async () => {
  if (!env.databaseUrl) throw new Error('DATABASE_URL が未設定です（test/run-integration.sh 経由で実行してください）')
  pool = createPool(env)
  await pool.query('DROP SCHEMA IF EXISTS app_office CASCADE')
  await migrate(pool, () => {})
  // 権限の運用デフォルト（0025 = バッチ7f）は「未設定環境の初期値」であり、既存の権限テスト群は
  // クリーンな状態（未設定 = 全 allow）を前提に自分でルールを出し入れする。テストでは一旦無効化し、
  // デフォルト自体の検証はバッチ7f の describe が再有効化して行う
  await pool.query(`UPDATE permission_rules SET active = false WHERE id LIKE 'pr-def-%'`)
  app = createApp(env, pool)
  // テストメンバー（admin / hr / 一般）
  await pool.query(`
    INSERT INTO members (id, name, email, role, employment_type) VALUES
      ('${ADMIN}', '管理 太郎', 'admin@example.com', 'admin', 'employee'),
      ('${HR}', '人事 花子', 'hr@example.com', 'hr', 'employee'),
      ('${MEMBER}', '一般 次郎', 'member@example.com', 'member', 'employee')`)
})

afterAll(async () => {
  await pool?.end()
})

describe('認証', () => {
  it('未認証は 401（AKO-AUTH-001）', async () => {
    const r = await api('GET', '/v1/me')
    expect(r.status).toBe(401)
    expect(r.json.error?.code).toBe('AKO-AUTH-001')
  })
  it('未登録メンバーは 403（AKO-AUTH-002）', async () => {
    const r = await api('GET', '/v1/me', { as: 'm-unknown' })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('AKO-AUTH-002')
  })
  it('/healthz は認証不要', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
  })

  it('プロフィール画像を登録・削除できる（PUT /v1/me/profile。バッチ5e）', async () => {
    const avatar = `data:image/jpeg;base64,${'A'.repeat(200)}`
    const put = await api('PUT', '/v1/me/profile', { as: MEMBER, body: { avatar } })
    expect(put.status).toBe(200)
    const me = await api('GET', '/v1/me', { as: MEMBER })
    expect((me.json.data as { avatar: string }).avatar).toBe(avatar)

    // 不正形式・サイズ超過は 400。空文字で削除できる
    expect((await api('PUT', '/v1/me/profile', { as: MEMBER, body: { avatar: 'https://evil/x.png' } })).status).toBe(400)
    // サブタイプ allowlist: SVG（スクリプト混入可能）と base64 なしの生データは拒否
    expect((await api('PUT', '/v1/me/profile', {
      as: MEMBER, body: { avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    })).status).toBe(400)
    expect((await api('PUT', '/v1/me/profile', {
      as: MEMBER, body: { avatar: 'data:image/png,rawtext' },
    })).status).toBe(400)
    expect((await api('PUT', '/v1/me/profile', {
      as: MEMBER, body: { avatar: `data:image/jpeg;base64,${'A'.repeat(300_001)}` },
    })).status).toBe(400)
    const del = await api('PUT', '/v1/me/profile', { as: MEMBER, body: { avatar: '' } })
    expect(del.status).toBe(200)
    expect(((await api('GET', '/v1/me', { as: MEMBER })).json.data as { avatar: string }).avatar).toBe('')
  })

  it('UI 設定を端末間同期用に保存・取得できる（PUT /v1/me/preferences/:key + /v1/me の prefs。0039）', async () => {
    // 初期は空（未設定）
    const me0 = await api('GET', '/v1/me', { as: MEMBER })
    expect((me0.json.data as { prefs: Record<string, unknown> }).prefs).toEqual({})

    // 保存 → 別リクエストの /v1/me でも保持（= DB 永続化 = 端末間同期の土台）
    const put = await api('PUT', '/v1/me/preferences/currentSegmentId', { as: MEMBER, body: { value: 'seg-02' } })
    expect(put.status).toBe(200)
    expect((put.json.data as { value: string }).value).toBe('seg-02')
    const me1 = await api('GET', '/v1/me', { as: MEMBER })
    expect((me1.json.data as { prefs: { currentSegmentId?: string } }).prefs.currentSegmentId).toBe('seg-02')

    // upsert（冪等）: 同一キーの再保存は上書き（巻き戻さない = 原則2）
    await api('PUT', '/v1/me/preferences/currentSegmentId', { as: MEMBER, body: { value: 'seg-03' } })
    const me2 = await api('GET', '/v1/me', { as: MEMBER })
    expect((me2.json.data as { prefs: { currentSegmentId?: string } }).prefs.currentSegmentId).toBe('seg-03')

    // per-user 分離: HR が同一キーに別の値を保存しても MEMBER の値は独立して保持される
    const hrMe0 = await api('GET', '/v1/me', { as: HR })
    expect((hrMe0.json.data as { prefs: Record<string, unknown> }).prefs.currentSegmentId).toBeUndefined()
    await api('PUT', '/v1/me/preferences/currentSegmentId', { as: HR, body: { value: 'seg-09' } })
    expect(((await api('GET', '/v1/me', { as: HR })).json.data as { prefs: { currentSegmentId?: string } }).prefs.currentSegmentId).toBe('seg-09')
    expect(((await api('GET', '/v1/me', { as: MEMBER })).json.data as { prefs: { currentSegmentId?: string } }).prefs.currentSegmentId).toBe('seg-03')

    // 不正キー（先頭が英字でない）・value 欠落・サイズ超過は 400
    expect((await api('PUT', '/v1/me/preferences/1bad', { as: MEMBER, body: { value: 'x' } })).status).toBe(400)
    expect((await api('PUT', '/v1/me/preferences/currentSegmentId', { as: MEMBER, body: {} })).status).toBe(400)
    expect((await api('PUT', '/v1/me/preferences/currentSegmentId', {
      as: MEMBER, body: { value: 'A'.repeat(4097) },
    })).status).toBe(400)
  })
})

describe('打刻（状態機械）', () => {
  it('in → break_start → break_end → out が通り、二重打刻は AKO-ATT-001', async () => {
    expect((await api('POST', '/v1/attendance/punches', { as: MEMBER, body: { kind: 'out' } })).json.error?.code)
      .toBe('AKO-ATT-001') // 未出勤で退勤は不可
    for (const kind of ['in', 'break_start', 'break_end', 'out']) {
      const r = await api('POST', '/v1/attendance/punches', { as: MEMBER, body: { kind } })
      expect(r.status, kind).toBe(201)
    }
    const again = await api('POST', '/v1/attendance/punches', { as: MEMBER, body: { kind: 'in' } })
    expect(again.status).toBe(409)
    expect(again.json.error?.code).toBe('AKO-ATT-001')
    const state = await api('GET', '/v1/attendance/state', { as: MEMBER })
    expect((state.json.data as { state: string }).state).toBe('done')
  })

  it('日次サマリが分単位で返る（既定ルール 9:00-18:00 休憩 60 分）', async () => {
    const r = await api('GET', `/v1/attendance/day?date=${todayJst()}`, { as: MEMBER })
    const d = r.json.data as { workMinutes: number; punches: unknown[] }
    expect(r.status).toBe(200)
    expect(d.punches.length).toBe(4)
    expect(d.workMinutes).toBeGreaterThanOrEqual(0)
  })

  it('他人の勤怠参照は一般ユーザー不可・人事は可', async () => {
    expect((await api('GET', `/v1/attendance/day?memberId=${ADMIN}`, { as: MEMBER })).status).toBe(403)
    expect((await api('GET', `/v1/attendance/day?memberId=${MEMBER}`, { as: HR })).status).toBe(200)
  })

  it('月次サマリと 36 協定アラートが返る（当月）', async () => {
    const month = todayJst().slice(0, 7)
    const m = await api('GET', `/v1/attendance/month?month=${month}`, { as: MEMBER })
    expect(m.status).toBe(200)
    const data = m.json.data as { days: { date: string; punches: unknown[] }[]; workDays: number }
    expect(data.days.length).toBeGreaterThanOrEqual(28)
    // 当日の打刻（in/break_start/break_end/out）が月次へ反映されている
    // （同一分内の打刻のため workMinutes は 0 = workDays には数えない）
    expect(data.days.find(d => d.date === todayJst())?.punches.length).toBe(4)
    const a = await api('GET', '/v1/attendance/alerts', { as: MEMBER })
    expect(a.status).toBe(200)
    expect(Array.isArray(a.json.data)).toBe(true)
  })

  it('タイムカードは管理者/人事のみ。当日分の行が返る', async () => {
    expect((await api('GET', '/v1/attendance/timecard', { as: MEMBER })).status).toBe(403)
    const today = todayJst()
    const r = await api('GET', `/v1/attendance/timecard?from=${today}&to=${today}`, { as: HR })
    expect(r.status).toBe(200)
    const rows = r.json.data as { memberId: string; inAt: string | null }[]
    expect(rows.some(x => x.memberId === MEMBER && x.inAt)).toBe(true)
  })

  it('期間上限（62 日）を超えるタイムカード照会は 400', async () => {
    const r = await api('GET', '/v1/attendance/timecard?from=2026-01-01&to=2026-12-31', { as: HR })
    expect(r.status).toBe(400)
  })
})

describe('打刻修正申請', () => {
  it('理由なしは AKO-ATT-002。承認で修正打刻が有効になり元打刻は保全される', async () => {
    const today = todayJst()
    const noReason = await api('POST', '/v1/attendance/fix-requests', {
      as: MEMBER, body: { date: today, kind: 'out', requestedAt: `${today}T19:00:00+09:00`, reason: ' ' },
    })
    expect(noReason.json.error?.code).toBe('AKO-ATT-002')

    const created = await api('POST', '/v1/attendance/fix-requests', {
      as: MEMBER, body: { date: today, kind: 'out', requestedAt: `${today}T19:00:00+09:00`, reason: '退勤打刻忘れ' },
    })
    expect(created.status).toBe(201)
    const fixId = (created.json.data as { id: string }).id

    // 一般ユーザーは承認不可（AKO-ATT-004）
    expect((await api('POST', `/v1/attendance/fix-requests/${fixId}/decision`, { as: MEMBER, body: { action: 'approved' } })).json.error?.code)
      .toBe('AKO-ATT-004')

    const approved = await api('POST', `/v1/attendance/fix-requests/${fixId}/decision`, { as: ADMIN, body: { action: 'approved' } })
    expect(approved.status).toBe(200)

    // 二重処理は AKO-ATT-003
    expect((await api('POST', `/v1/attendance/fix-requests/${fixId}/decision`, { as: ADMIN, body: { action: 'approved' } })).json.error?.code)
      .toBe('AKO-ATT-003')

    // 有効打刻の out は修正後時刻。生打刻（raw）には元の out も残る（記録系保護）
    const day = await api('GET', `/v1/attendance/day?date=${today}&raw=1`, { as: MEMBER })
    const d = day.json.data as { punches: { kind: string; at: string }[]; rawPunches: unknown[] }
    const outs = d.punches.filter(p => p.kind === 'out')
    expect(outs.length).toBe(1)
    expect(outs[0]?.at).toBe(`${today}T19:00:00+09:00`)
    expect(d.rawPunches.length).toBe(5)
  })

  it('申請一覧: 全件参照は管理者・人事のみ（承認は管理者のみのまま）', async () => {
    expect((await api('GET', '/v1/attendance/fix-requests?scope=all', { as: MEMBER })).status).toBe(403)
    const hrList = await api('GET', '/v1/attendance/fix-requests?scope=all', { as: HR })
    expect(hrList.status).toBe(200)
    expect((hrList.json.data as unknown[]).length).toBeGreaterThanOrEqual(1)
  })
})

describe('勤怠承認ワークフロー（直行/直帰 + 経路設定。0040）', () => {
  const d1 = addDays(todayJst(), -10)
  const d2 = addDays(todayJst(), -11)

  it('経路なし: 直行/直帰は管理者単段承認。承認済みの日だけ打刻修正が解禁される（AKO-ATT-005 ゲート）', async () => {
    const cr = await api('POST', '/v1/attendance/direct-requests', {
      as: MEMBER, body: { date: d1, type: 'chokkou', reason: '客先へ直行' },
    })
    expect(cr.status).toBe(201)
    const drId = (cr.json.data as { id: string }).id

    // 申請者以外の一般ユーザーは承認不可（経路なし = 管理者のみ）
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: MEMBER, body: { action: 'approved' } })).status).toBe(403)

    // 未承認の直行/直帰に紐づく打刻修正はゲートで拒否（AKO-ATT-005）
    const blocked = await api('POST', '/v1/attendance/fix-requests', {
      as: MEMBER, body: { date: d1, kind: 'in', requestedAt: `${d1}T09:00:00+09:00`, reason: '直行の出勤', directRequestId: drId },
    })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error?.code).toBe('AKO-ATT-005')

    // 管理者が承認 → approved
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: ADMIN, body: { action: 'approved' } })).status).toBe(200)

    // 承認済みなら紐づく打刻修正を申請できる（種別 in は chokkou で許可）
    const fx = await api('POST', '/v1/attendance/fix-requests', {
      as: MEMBER, body: { date: d1, kind: 'in', requestedAt: `${d1}T09:00:00+09:00`, reason: '直行の出勤打刻', directRequestId: drId },
    })
    expect(fx.status).toBe(201)
    const fxId = (fx.json.data as { id: string }).id
    // 経路未設定の打刻修正は従来どおり管理者単段で承認 → 修正打刻が追記される
    expect((await api('POST', `/v1/attendance/fix-requests/${fxId}/decision`, { as: ADMIN, body: { action: 'approved' } })).status).toBe(200)
    const day = await api('GET', `/v1/attendance/day?memberId=${MEMBER}&date=${d1}&raw=1`, { as: ADMIN })
    const raw = (day.json.data as { rawPunches: { kind: string; source: string }[] }).rawPunches
    expect(raw.some(p => p.kind === 'in' && p.source === 'fix')).toBe(true)
  })

  it('経路あり: 直行/直帰は経路の多段承認（manager→hr）で approved になる', async () => {
    const route = await api('POST', '/v1/masters/attendance-routes', {
      as: ADMIN,
      body: {
        category: 'direct',
        steps: [
          { order: 1, approverType: 'role', approverRole: 'admin' },
          { order: 2, approverType: 'role', approverRole: 'hr' },
        ],
        active: true,
      },
    })
    expect(route.status).toBe(201)

    const cr = await api('POST', '/v1/attendance/direct-requests', { as: MEMBER, body: { date: d2, type: 'both', reason: '終日客先' } })
    const drId = (cr.json.data as { id: string }).id

    // step1 の承認者はロール admin（= m-admin）。HR は現ステップ承認者でも管理者でもないので不可
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: HR, body: { action: 'approved' } })).status).toBe(403)
    // step1 承認 → step2 へ前進
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: ADMIN, body: { action: 'approved' } })).status).toBe(200)
    // step2 の承認者は hr（= m-hr）→ 最終承認で approved
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: HR, body: { action: 'approved' } })).status).toBe(200)

    const list = await api('GET', '/v1/attendance/direct-requests?scope=all', { as: ADMIN })
    const dr = (list.json.data as { id: string; status: string; currentStep: number }[]).find(x => x.id === drId)
    expect(dr?.status).toBe('approved')

    // 二重処理は AKO-ATT-003
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: HR, body: { action: 'approved' } })).status).toBe(409)
  })

  it('取下げは申請者本人のみ（原則9.5）', async () => {
    const cr = await api('POST', '/v1/attendance/direct-requests', { as: MEMBER, body: { date: addDays(todayJst(), -12), type: 'chokki', reason: 'x' } })
    const drId = (cr.json.data as { id: string }).id
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: HR, body: { action: 'withdrawn' } })).status).toBe(403)
    expect((await api('POST', `/v1/attendance/direct-requests/${drId}/actions`, { as: MEMBER, body: { action: 'withdrawn' } })).status).toBe(200)
  })
})

describe('休暇（付与・残数・申請・承認）', () => {
  it('一般ユーザーの付与は AKO-LEV-004', async () => {
    const r = await api('POST', '/v1/leave/grants', {
      as: MEMBER, body: { memberId: MEMBER, leaveTypeId: 'lt-paid', days: 10 },
    })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('AKO-LEV-004')
  })

  it('付与は冪等（同一メンバー × 種別 × 付与日はスキップ）', async () => {
    const body = { memberId: MEMBER, leaveTypeId: 'lt-paid', days: 10, grantDate: '2026-04-01' }
    const first = await api('POST', '/v1/leave/grants', { as: HR, body })
    expect(first.status).toBe(201)
    expect((first.json.data as { skipped: boolean }).skipped).toBe(false)
    const second = await api('POST', '/v1/leave/grants', { as: HR, body })
    expect(second.status).toBe(200)
    expect((second.json.data as { skipped: boolean }).skipped).toBe(true)
    const bal = await api('GET', '/v1/leave/balance', { as: MEMBER })
    expect((bal.json.data as { remaining: number }).remaining).toBe(10)
  })

  it('一括付与も冪等（granted / skipped 件数を返す）', async () => {
    const body = { memberIds: [ADMIN, HR, MEMBER], leaveTypeId: 'lt-paid', days: 5, grantDate: '2026-07-01' }
    const first = await api('POST', '/v1/leave/grants/bulk', { as: ADMIN, body })
    expect(first.json.data).toEqual({ granted: 3, skipped: 0 })
    const second = await api('POST', '/v1/leave/grants/bulk', { as: ADMIN, body })
    expect(second.json.data).toEqual({ granted: 0, skipped: 3 })
  })

  it('残数超過の申請は AKO-LEV-001。承認フロー + 二重処理ガード（AKO-LEV-002/003）', async () => {
    const over = await api('POST', '/v1/leave/requests', {
      as: MEMBER, body: { date: '2026-08-01', unit: 'full', reason: '', leaveTypeId: 'lt-paid' },
    })
    expect(over.status).toBe(201) // 残 15 日あるので成立

    const reqId = (over.json.data as { id: string }).id
    expect((await api('POST', `/v1/leave/requests/${reqId}/decision`, { as: MEMBER, body: { action: 'approved' } })).json.error?.code)
      .toBe('AKO-LEV-003')
    expect((await api('POST', `/v1/leave/requests/${reqId}/decision`, { as: HR, body: { action: 'approved' } })).status).toBe(200)
    expect((await api('POST', `/v1/leave/requests/${reqId}/decision`, { as: HR, body: { action: 'rejected' } })).json.error?.code)
      .toBe('AKO-LEV-002')

    const bal = await api('GET', '/v1/leave/balance', { as: MEMBER })
    expect((bal.json.data as { remaining: number }).remaining).toBe(14) // 15 - 1
  })
})

describe('日報', () => {
  it('下書き → 提出 → 提出済みは本人編集可（提出時刻維持）・下書き戻しは AKO-REP-001', async () => {
    const date = '2026-07-16'
    const draft = await api('PUT', '/v1/reports/daily', {
      as: MEMBER, body: { date, entries: [], reflection: 'メモ', status: 'draft' },
    })
    expect(draft.status).toBe(200)

    const submitNoEntries = await api('PUT', '/v1/reports/daily', {
      as: MEMBER, body: { date, entries: [], status: 'submitted' },
    })
    expect(submitNoEntries.json.error?.code).toBe('AKO-GEN-001')

    const submit = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ projectId: 'pj-x', task: '実装', hours: 8, progress: 80 }], status: 'submitted' },
    })
    expect(submit.status).toBe(200)

    // 下書きへ戻す操作は拒否（提出済み = 確定の意味を保つ）
    const toDraft = await api('PUT', '/v1/reports/daily', {
      as: MEMBER, body: { date, entries: [{ projectId: 'pj-x', task: '改ざん', hours: 1, progress: 0 }], status: 'draft' },
    })
    expect(toDraft.status).toBe(409)
    expect(toDraft.json.error?.code).toBe('AKO-REP-001')

    // 提出済みのまま本人が編集可（オペレーター指示 2026-07-17）。初回提出時刻は維持される
    const before = await api('GET', `/v1/reports/daily?date=${date}`, { as: MEMBER })
    const submittedAt = (before.json.data as { submittedAt: string }[])[0]!.submittedAt
    const edit = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ projectId: 'pj-x', task: '実装（修正）', hours: 7.5, progress: 90 }], status: 'submitted' },
    })
    expect(edit.status).toBe(200)
    const after = await api('GET', `/v1/reports/daily?date=${date}`, { as: MEMBER })
    const row = (after.json.data as { status: string; submittedAt: string; entries: { task: string }[] }[])[0]!
    expect(row.status).toBe('submitted')
    expect(row.entries[0]!.task).toBe('実装（修正）')
    expect(row.submittedAt).toBe(submittedAt)
  })

  it('業務テーマ（theme）で提出できる。テーマも旧 projectId もないエントリは提出不可（バッチ5e）', async () => {
    const date = '2026-07-17'
    const ok = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ theme: '社内改善', task: '業務フロー整理', hours: 2, progress: 50 }], status: 'submitted' },
    })
    expect(ok.status).toBe(200)
    const saved = await api('GET', `/v1/reports/daily?date=${date}`, { as: MEMBER })
    const entry = (saved.json.data as { entries: { theme?: string; projectId?: string }[] }[])[0]!.entries[0]!
    expect(entry.theme).toBe('社内改善')

    const bad = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ task: 'テーマなし', hours: 1, progress: 0 }], status: 'submitted' },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.code).toBe('AKO-GEN-001')
  })

  it('scope=all は全メンバーが参照でき、提出済みの日報のみを返す（バッチ5e: 全員の日報タブ）', async () => {
    // HR の下書きは scope=all に現れない（下書きは本人以外に見せない）
    const draft = await api('PUT', '/v1/reports/daily', {
      as: HR, body: { date: '2026-07-02', entries: [{ theme: '下書き', task: '未提出', hours: 1, progress: 0 }], status: 'draft' },
    })
    expect(draft.status).toBe(200)
    // month なしの全履歴ダンプは 400（期間必須）
    expect((await api('GET', '/v1/reports/daily?scope=all', { as: HR })).status).toBe(400)
    const all = await api('GET', '/v1/reports/daily?scope=all&month=2026-07', { as: HR })
    expect(all.status).toBe(200)
    const rows = all.json.data as { status: string; memberId: string | null; date: string }[]
    expect(rows.length).toBeGreaterThanOrEqual(2) // MEMBER の 07-16 と 07-17
    expect(rows.every(r => r.status === 'submitted')).toBe(true)
    expect(rows.some(r => r.memberId === MEMBER)).toBe(true)
    expect(rows.some(r => r.date === '2026-07-02')).toBe(false)
  })

  it('チーム参照は全員可（バッチ7h で公開: 一般 = 提出済みのみ・期間指定必須）。コメント追加ができる', async () => {
    // バッチ7h（オペレーター指示 2026-07-19 #10 ①）でチームタブを全員へ公開。
    // 一般メンバーは提出済みのみ返る（他人の下書き秘匿は バッチ7h describe で検証）。
    // scope=all と同じく期間なしの全履歴ダンプは 400（PR #57 R1 M-2）
    expect((await api('GET', '/v1/reports/daily?scope=team', { as: MEMBER })).status).toBe(400)
    expect((await api('GET', '/v1/reports/daily?scope=team&month=2026-07', { as: MEMBER })).status).toBe(200)
    const team = await api('GET', '/v1/reports/daily?scope=team&date=2026-07-16', { as: ADMIN })
    const reports = team.json.data as { id: string }[]
    expect(reports.length).toBe(1)
    const c = await api('POST', `/v1/reports/${reports[0]!.id}/comments`, { as: ADMIN, body: { body: 'おつかれさま' } })
    expect(c.status).toBe(201)
    const list = await api('GET', `/v1/reports/${reports[0]!.id}/comments`, { as: MEMBER })
    expect((list.json.data as unknown[]).length).toBe(1)
  })

  it('from/to の期間指定で日報を絞り込める（自分・チーム両スコープ）', async () => {
    for (const [date, task] of [['2026-06-29', '前月末'], ['2026-07-01', '月初']] as const) {
      const r = await api('PUT', '/v1/reports/daily', {
        as: HR, body: { date, entries: [{ projectId: 'pj-x', task, hours: 1, progress: 10 }], status: 'draft' },
      })
      expect(r.status, date).toBe(200)
    }
    const mine = await api('GET', '/v1/reports/daily?from=2026-06-28&to=2026-06-30', { as: HR })
    expect((mine.json.data as { date: string }[]).map(r => r.date)).toEqual(['2026-06-29'])

    const team = await api('GET', '/v1/reports/daily?scope=team&from=2026-06-01&to=2026-06-30', { as: ADMIN })
    const teamRows = team.json.data as { date: string }[]
    expect(teamRows.length).toBeGreaterThanOrEqual(1)
    expect(teamRows.every(r => r.date >= '2026-06-01' && r.date <= '2026-06-30')).toBe(true)

    expect((await api('GET', '/v1/reports/daily?from=20260629', { as: HR })).json.error?.code).toBe('AKO-GEN-001')
  })

  it('コメントは日報作成者へ通知され、リアクションはトグルできる', async () => {
    const team = await api('GET', '/v1/reports/daily?scope=team&date=2026-07-16', { as: ADMIN })
    const reportId = (team.json.data as { id: string }[])[0]!.id
    const c = await api('POST', `/v1/reports/${reportId}/comments`, { as: ADMIN, body: { body: 'リアクション対象' } })
    expect(c.status).toBe(201)
    const commentId = (c.json.data as { id: string }).id

    // 作成者（MEMBER）へ kind 'comment' の通知が届く
    const notes = (await api('GET', '/v1/notifications?unread=1', { as: MEMBER })).json.data as { kind: string }[]
    expect(notes.some(n => n.kind === 'comment')).toBe(true)

    // リアクション: 付与 → 同じ絵文字の再送で解除（トグル）
    const on = await api('POST', `/v1/reports/comments/${commentId}/reactions`, { as: MEMBER, body: { emoji: '👍' } })
    expect(on.status).toBe(200)
    expect((on.json.data as { reactions: unknown[] }).reactions).toEqual([{ memberId: MEMBER, emoji: '👍' }])
    const off = await api('POST', `/v1/reports/comments/${commentId}/reactions`, { as: MEMBER, body: { emoji: '👍' } })
    expect((off.json.data as { reactions: unknown[] }).reactions).toEqual([])

    expect((await api('POST', '/v1/reports/comments/rc-nope/reactions', { as: MEMBER, body: { emoji: '👍' } })).status).toBe(404)
    expect((await api('POST', `/v1/reports/comments/${commentId}/reactions`, { as: MEMBER, body: {} })).json.error?.code)
      .toBe('AKO-GEN-001')
  })

  it('週報の提出保護（AKO-REP-002）。主要業務なしの提出は AKO-GEN-001', async () => {
    const noMain = await api('PUT', '/v1/reports/weekly', { as: MEMBER, body: { weekStart: '2026-07-13', status: 'submitted' } })
    expect(noMain.status).toBe(400)
    expect(noMain.json.error?.code).toBe('AKO-GEN-001')

    const body = { weekStart: '2026-07-13', goalReview: 'ok', mainWork: '実装', status: 'submitted' }
    expect((await api('PUT', '/v1/reports/weekly', { as: MEMBER, body })).status).toBe(200)
    const again = await api('PUT', '/v1/reports/weekly', { as: MEMBER, body: { ...body, goalReview: '書換' } })
    expect(again.json.error?.code).toBe('AKO-REP-002')
  })
})

// バッチ4（オペレーター指示 2026-08-03）: 日報「本日の課題の種別」・週報の新規項目・ぽいぽいポストの宛先通知
describe('バッチ4: 日報/週報の項目拡張 + ぽいぽいポスト通知', () => {
  afterAll(async () => {
    // 宛先設定を空へ戻す（後続の 7c 等が作るぽいぽいポストで通知が発火しないように）
    await api('PUT', '/v1/configs/poipoi-notify-recipients', { as: ADMIN, body: { value: '' } })
  })

  it('日報: 本日の課題の種別（issueCategory）を保存・取得できる。プリセット外は空へ正規化', async () => {
    // issues 本文は空にする（課題エスカレーションの cooldown で後続テストへ影響させない）。issueCategory は独立に保存される
    const date = '2026-08-03'
    const ok = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ theme: '改善', task: '手順整理', hours: 1, progress: 0 }], issueCategory: '業務手順', status: 'submitted' },
    })
    expect(ok.status).toBe(200)
    const saved = await api('GET', `/v1/reports/daily?date=${date}`, { as: MEMBER })
    expect((saved.json.data as { issueCategory: string }[])[0]!.issueCategory).toBe('業務手順')

    // プリセット外の種別は '' に正規化（提出済みのまま本人編集）
    const bad = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date, entries: [{ theme: '改善', task: '手順整理', hours: 1, progress: 0 }], issueCategory: '謎の種別', status: 'submitted' },
    })
    expect(bad.status).toBe(200)
    const after = await api('GET', `/v1/reports/daily?date=${date}`, { as: MEMBER })
    expect((after.json.data as { issueCategory: string }[])[0]!.issueCategory).toBe('')
  })

  it('週報: goodPoints / teamShareKind / teamShareNote を保存・取得。種別プリセット外は空へ正規化', async () => {
    const weekStart = '2026-08-10'
    const base = {
      weekStart, mainWork: '実装', goalReview: '達成度80%', goodPoints: '朝会が機能した',
      teamShareKind: '相談したい', teamShareNote: '来週の優先度を相談したい', status: 'draft' as const,
    }
    expect((await api('PUT', '/v1/reports/weekly', { as: MEMBER, body: base })).status).toBe(200)
    const saved = await api('GET', '/v1/reports/weekly', { as: MEMBER })
    const row = (saved.json.data as { weekStart: string; goodPoints: string; teamShareKind: string; teamShareNote: string }[])
      .find(r => r.weekStart === weekStart)!
    expect(row.goodPoints).toBe('朝会が機能した')
    expect(row.teamShareKind).toBe('相談したい')
    expect(row.teamShareNote).toBe('来週の優先度を相談したい')

    // プリセット外の種別は '' へ正規化（draft のまま更新）
    expect((await api('PUT', '/v1/reports/weekly', { as: MEMBER, body: { ...base, teamShareKind: '謎' } })).status).toBe(200)
    const after = await api('GET', '/v1/reports/weekly', { as: MEMBER })
    expect((after.json.data as { weekStart: string; teamShareKind: string }[]).find(r => r.weekStart === weekStart)!.teamShareKind).toBe('')
  })

  it('ぽいぽいポスト: 設定なしでは通知は飛ばない', async () => {
    await api('PUT', '/v1/configs/poipoi-notify-recipients', { as: ADMIN, body: { value: '' } })
    const before = (await api('GET', '/v1/notifications', { as: ADMIN })).json.data as unknown[]
    const post = await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'poipoi', body: '宛先未設定のポスト' } })
    expect(post.status).toBe(201)
    const after = (await api('GET', '/v1/notifications', { as: ADMIN })).json.data as { kind: string }[]
    expect(after.length).toBe(before.length)
    expect(after.some(n => n.kind === 'poipoi')).toBe(false)
  })

  it('ぽいぽいポスト: 宛先（ロール）へ原文を通知し、投稿者本人は除外する', async () => {
    // 宛先 = admin ロール + member ロール。投稿者は MEMBER（member ロール）= 本人除外の検証を兼ねる
    await api('PUT', '/v1/configs/poipoi-notify-recipients', {
      as: ADMIN,
      body: { value: JSON.stringify([{ type: 'role', role: 'admin' }, { type: 'role', role: 'member' }]) },
    })
    const post = await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'poipoi', body: '改善アイデア: 朝会を短縮する' } })
    expect(post.status).toBe(201)
    // ADMIN（role=admin）は通知を受け取り、本文に原文プレビュー・リンクは /poipoi
    const adminNotes = (await api('GET', '/v1/notifications?unread=1', { as: ADMIN })).json.data as { kind: string; body: string; link: string }[]
    const n = adminNotes.find(x => x.kind === 'poipoi' && x.body.includes('朝会を短縮する'))
    expect(n).toBeTruthy()
    expect(n!.link).toBe('/poipoi')
    // 投稿者 MEMBER（role=member だが本人）は自分のポスト通知を受け取らない
    const memberNotes = (await api('GET', '/v1/notifications', { as: MEMBER })).json.data as { kind: string; body: string }[]
    expect(memberNotes.some(x => x.kind === 'poipoi' && x.body.includes('朝会を短縮する'))).toBe(false)
  })
})

describe('マスタ CRUD', () => {
  it('一般ユーザーは参照可・変更不可（AKO-AUTH-003）', async () => {
    expect((await api('GET', '/v1/masters/departments', { as: MEMBER })).status).toBe(200)
    expect((await api('POST', '/v1/masters/departments', { as: MEMBER, body: { name: 'X' } })).json.error?.code)
      .toBe('AKO-AUTH-003')
  })

  it('部署: 追加 → 所属者ありの無効化は AKO-DEP-001 → 配属変更後に無効化可', async () => {
    const dep = await api('POST', '/v1/masters/departments', { as: ADMIN, body: { name: '開発部' } })
    expect(dep.status).toBe(201)
    const depId = ((dep.json.data as { id: string }).id)
    await api('PATCH', `/v1/masters/members/${MEMBER}`, { as: ADMIN, body: { departmentId: depId } })

    const blocked = await api('POST', `/v1/masters/departments/${depId}/archive`, { as: ADMIN })
    expect(blocked.json.error?.code).toBe('AKO-DEP-001')

    await api('PATCH', `/v1/masters/members/${MEMBER}`, { as: ADMIN, body: { departmentId: '' } })
    expect((await api('POST', `/v1/masters/departments/${depId}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('POST', `/v1/masters/departments/${depId}/restore`, { as: ADMIN })).status).toBe(200)
  })

  it('汎用区分の初期データ（役職等）がマイグレーションで投入される', async () => {
    const rows = (await api('GET', '/v1/masters/code-masters', { as: MEMBER })).json.data as
      { category: string; label: string }[]
    const titles = rows.filter(r => r.category === 'title')
    expect(titles.length).toBeGreaterThanOrEqual(7)
    expect(titles.some(t => t.label === 'マネージャー')).toBe(true)
  })

  it('部分 PATCH は未指定フィールドを上書きしない（zod v4 .partial() の既定値注入の回帰防止）', async () => {
    // 実障害の再現経路: 部署配属（departmentId のみの PATCH）で email が空・role が member に巻き戻った
    const r = await api('PATCH', `/v1/masters/members/${HR}`, { as: ADMIN, body: { title: '人事部長' } })
    expect(r.status).toBe(200)
    const rows = (await api('GET', '/v1/masters/members', { as: ADMIN })).json.data as
      { id: string; name: string; email: string; role: string; title: string }[]
    const hr = rows.find(m => m.id === HR)!
    expect(hr.title).toBe('人事部長')
    expect(hr.email).toBe('hr@example.com')
    expect(hr.role).toBe('hr')
    expect(hr.name).toBe('人事 花子')
  })

  it('部署: 循環する親子は AKO-DEP-003', async () => {
    const a = (await api('POST', '/v1/masters/departments', { as: ADMIN, body: { name: 'A' } })).json.data as { id: string }
    const b = (await api('POST', '/v1/masters/departments', { as: ADMIN, body: { name: 'B', parentId: a.id } })).json.data as { id: string }
    const cycle = await api('PATCH', `/v1/masters/departments/${a.id}`, { as: ADMIN, body: { parentId: b.id } })
    expect(cycle.status).toBe(409)
    expect(cycle.json.error?.code).toBe('AKO-DEP-003')
  })

  it('休暇種別: 法定有給の編集・無効化は AKO-LEV-008。人事は非法定の追加可', async () => {
    expect((await api('PATCH', '/v1/masters/leave-types/lt-paid', { as: ADMIN, body: { name: '書換' } })).json.error?.code)
      .toBe('AKO-LEV-008')
    expect((await api('POST', '/v1/masters/leave-types/lt-paid/archive', { as: ADMIN })).json.error?.code)
      .toBe('AKO-LEV-008')
    const summer = await api('POST', '/v1/masters/leave-types', {
      as: HR, body: { name: '夏季休暇', grantMethod: 'manual', expiryMonths: 3 },
    })
    expect(summer.status).toBe(201)
  })

  it('関係エッジ: 物理削除できる（他マスタは 405）', async () => {
    const rel = await api('POST', '/v1/masters/company-relations', {
      as: ADMIN, body: { fromCompanyId: 'c-1', toCompanyId: 'c-2', relationTypeId: 'rt-1' },
    })
    expect(rel.status).toBe(201)
    const relId = (rel.json.data as { id: string }).id
    expect((await api('DELETE', `/v1/masters/company-relations/${relId}`, { as: ADMIN })).status).toBe(200)
    expect((await api('DELETE', `/v1/masters/departments/${relId}`, { as: ADMIN })).status).toBe(405)
  })

  it('関係種別: 未使用のみ物理削除可・使用中は AKO-RTM-001（無効化を案内）', async () => {
    const rt = await api('POST', '/v1/masters/relation-types', {
      as: ADMIN, body: { label: '削除テスト種別', direction: 'directed', appliesTo: 'company' },
    })
    expect(rt.status).toBe(201)
    const rtId = (rt.json.data as { id: string }).id
    const rel = await api('POST', '/v1/masters/company-relations', {
      as: ADMIN, body: { fromCompanyId: 'c-1', toCompanyId: 'c-2', relationTypeId: rtId },
    })
    expect(rel.status).toBe(201)
    const relId = (rel.json.data as { id: string }).id

    // 関係エッジから参照中は削除不可
    const denied = await api('DELETE', `/v1/masters/relation-types/${rtId}`, { as: ADMIN })
    expect(denied.status).toBe(409)
    expect(denied.json.error?.code).toBe('AKO-RTM-001')

    // エッジを消せば削除できる
    expect((await api('DELETE', `/v1/masters/company-relations/${relId}`, { as: ADMIN })).status).toBe(200)
    expect((await api('DELETE', `/v1/masters/relation-types/${rtId}`, { as: ADMIN })).status).toBe(200)
  })

  it('勤怠ルール: defaultFor は区分ごとに 1 ルール（保存時排他）', async () => {
    const flex = await api('POST', '/v1/masters/attendance-rules', {
      as: ADMIN, body: { name: 'フレックス', appliesTo: ['employee'], defaultFor: ['employee'] },
    })
    expect(flex.status).toBe(201)
    const std = await api('GET', '/v1/masters/attendance-rules?includeInactive=1', { as: ADMIN })
    const rules = std.json.data as { id: string; defaultFor: string[] }[]
    const standard = rules.find(r => r.id === 'ar-standard')
    expect(standard?.defaultFor.includes('employee')).toBe(false) // 排他で外れる
  })
})

describe('通知', () => {
  it('休暇申請で管理者へ、承認で申請者へ通知される。本人のみ参照・既読化できる', async () => {
    const before = await api('GET', '/v1/notifications', { as: ADMIN })
    const beforeCount = (before.json.data as unknown[]).length

    const req = await api('POST', '/v1/leave/requests', {
      as: MEMBER, body: { date: '2026-09-01', unit: 'full', leaveTypeId: 'lt-paid' },
    })
    expect(req.status).toBe(201)
    const adminAfter = await api('GET', '/v1/notifications', { as: ADMIN })
    const adminNotes = adminAfter.json.data as { id: string; kind: string; title: string; read: boolean }[]
    expect(adminNotes.length).toBe(beforeCount + 1)
    expect(adminNotes[0]?.kind).toBe('approval')

    const reqId = ((req.json.data as { id: string }).id)
    await api('POST', `/v1/leave/requests/${reqId}/decision`, { as: HR, body: { action: 'rejected' } })
    const memberNotes = (await api('GET', '/v1/notifications?unread=1', { as: MEMBER })).json.data as { id: string; title: string }[]
    expect(memberNotes.some(n => n.title.includes('却下'))).toBe(true)

    // 他人の通知は既読化できない・本人は既読化できる
    const target = memberNotes[0]!
    expect((await api('POST', `/v1/notifications/${target.id}/read`, { as: ADMIN })).status).toBe(404)
    expect((await api('POST', `/v1/notifications/${target.id}/read`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', '/v1/notifications/read-all', { as: MEMBER })).status).toBe(200)
    const unread = (await api('GET', '/v1/notifications?unread=1', { as: MEMBER })).json.data as unknown[]
    expect(unread.length).toBe(0)
  })

  it('同一秒の通知でも新しい順が決定的（created_at タイブレーク = CI フレーク再発防止）', async () => {
    // at（JST テキスト）は秒精度のため、同一秒に 2 件入ると従来は順序不定だった
    // （実障害: 一括付与の system 通知と休暇申請の approval 通知が同一秒で先頭が入れ替わる）
    const at = '2026-07-18T09:00:00+09:00'
    await pool.query(
      `INSERT INTO notifications (id, member_id, kind, title, at) VALUES ('nt-tie-1', $1, 'system', '先に挿入', $2)`,
      [ADMIN, at])
    await pool.query(
      `INSERT INTO notifications (id, member_id, kind, title, at) VALUES ('nt-tie-2', $1, 'approval', '後に挿入', $2)`,
      [ADMIN, at])
    const notes = (await api('GET', '/v1/notifications', { as: ADMIN })).json.data as { id: string }[]
    const first = notes.findIndex(n => n.id === 'nt-tie-1')
    const second = notes.findIndex(n => n.id === 'nt-tie-2')
    expect(second).toBeGreaterThanOrEqual(0)
    expect(second).toBeLessThan(first) // 同一秒なら後から挿入した方が先頭側（挿入順の新しい順）
    await pool.query(`DELETE FROM notifications WHERE id IN ('nt-tie-1', 'nt-tie-2')`) // 後続テストの件数へ影響させない
  })

  it('日報リマインドは管理者のみ実行でき、対象者へ通知される', async () => {
    expect((await api('POST', '/v1/reports/remind', { as: MEMBER, body: { memberId: HR, date: '2026-07-15' } })).status).toBe(403)
    expect((await api('POST', '/v1/reports/remind', { as: ADMIN, body: { memberId: HR, date: '2026-07-15' } })).status).toBe(200)
    const notes = (await api('GET', '/v1/notifications?unread=1', { as: HR })).json.data as { kind: string }[]
    expect(notes.some(n => n.kind === 'reminder')).toBe(true)
  })
})

describe('周期有給付与', () => {
  it('入社日基準で付与され、再実行は全件スキップ（冪等）。一般ユーザーは実行不可', async () => {
    // 勤続 1.6 年（付与 2 回到来: 0.5 年で 10 日 / 1.5 年で 11 日）のメンバーを追加
    const hire = new Date()
    hire.setMonth(hire.getMonth() - 19)
    const hireKey = `${hire.getFullYear()}-${String(hire.getMonth() + 1).padStart(2, '0')}-${String(hire.getDate()).padStart(2, '0')}`
    const created = await api('POST', '/v1/masters/members', {
      as: ADMIN,
      body: { name: '周期 付与子', email: 'periodic@example.com', hireDate: hireKey, weeklyDays: 5, weeklyHours: 40 },
    })
    expect(created.status).toBe(201)
    const newMemberId = (created.json.data as { id: string }).id

    expect((await api('POST', '/v1/leave/periodic-grants/run', { as: MEMBER })).json.error?.code).toBe('AKO-LEV-004')

    const first = await api('POST', '/v1/leave/periodic-grants/run', { as: HR })
    expect(first.status).toBe(200)
    const r1 = first.json.data as { granted: number; skipped: number }
    expect(r1.granted).toBeGreaterThanOrEqual(2) // 新メンバーの 2 回分（既存メンバーは hireDate なし）

    const grants = (await api('GET', `/v1/leave/grants?memberId=${newMemberId}`, { as: HR })).json.data as { days: number; kind: string; grantedBy: string | null }[]
    expect(grants.length).toBe(2)
    expect(grants.map(g => g.days).sort()).toEqual([10, 11])
    expect(grants.every(g => g.kind === 'normal' && g.grantedBy === null)).toBe(true)

    const second = await api('POST', '/v1/leave/periodic-grants/run', { as: HR })
    const r2 = second.json.data as { granted: number; skipped: number }
    expect(r2.granted).toBe(0)
    expect(r2.skipped).toBeGreaterThanOrEqual(2)
  })

  it('/jobs エンドポイントは CRON_SECRET 必須', async () => {
    const res = await app.request('/jobs/periodic-leave-grants', { method: 'POST' })
    expect(res.status).toBe(401) // CRON_SECRET 未設定時は常に拒否
  })
})

describe('設定・監査', () => {
  it('設定の upsert は管理者のみ・冪等。全員が参照可', async () => {
    expect((await api('PUT', '/v1/configs/reportInputMode', { as: MEMBER, body: { value: 'form' } })).status).toBe(403)
    expect((await api('PUT', '/v1/configs/reportInputMode', { as: ADMIN, body: { value: 'form' } })).status).toBe(200)
    expect((await api('PUT', '/v1/configs/reportInputMode', { as: ADMIN, body: { value: 'form' } })).status).toBe(200)
    const r = await api('GET', '/v1/configs', { as: MEMBER })
    expect((r.json.data as Record<string, unknown>).reportInputMode).toBe('form')
  })

  it('監査ログにマスタ操作が記録されている（管理者のみ参照可）', async () => {
    expect((await api('GET', '/v1/configs/audit-logs', { as: MEMBER })).status).toBe(403)
    const r = await api('GET', '/v1/configs/audit-logs', { as: ADMIN })
    const logs = r.json.data as { action: string; entity: string }[]
    expect(logs.some(l => l.entity === 'departments' && l.action === 'create')).toBe(true)
    expect(logs.some(l => l.entity === 'company_relations' && l.action === 'delete')).toBe(true)
  })
})

describe('エスカレーション', () => {
  it('日報の課題提出で起票され管理者へ通知。クールダウンで重複起票しない', async () => {
    const submit = await api('PUT', '/v1/reports/daily', {
      as: HR,
      body: {
        date: '2026-07-18',
        entries: [{ projectId: 'pj-x', task: '実装', hours: 8, progress: 50 }],
        issues: '仕様が未確定でブロック中',
        status: 'submitted',
      },
    })
    expect(submit.status).toBe(200)
    expect((submit.json.data as { escalated: boolean }).escalated).toBe(true)

    // 一覧は管理者のみ
    expect((await api('GET', '/v1/escalations', { as: MEMBER })).status).toBe(403)
    const list = (await api('GET', '/v1/escalations', { as: ADMIN })).json.data as
      { id: string; reason: string; status: string; targetMemberId: string }[]
    const esc = list.find(e => e.reason === 'issue_reported' && e.targetMemberId === HR)
    expect(esc?.status).toBe('open')

    // 起票で管理者へ kind 'escalation' の通知
    const adminNotes = (await api('GET', '/v1/notifications', { as: ADMIN })).json.data as { kind: string }[]
    expect(adminNotes.some(n => n.kind === 'escalation')).toBe(true)

    // 同一メンバーはクールダウン中の再起票をスキップ（AKO-ESC-001）
    const dup = await api('POST', '/v1/escalations', {
      as: HR, body: { reason: 'issue_reported', context: '別件', dedupeKey: `issue:${HR}:2026-07-19` },
    })
    expect(dup.status).toBe(409)
    expect(dup.json.error?.code).toBe('AKO-ESC-001')
  })

  it('裁定 + ナレッジ還流 → 二重解決は AKO-ESC-003。回答は本人へ通知', async () => {
    const list = (await api('GET', '/v1/escalations', { as: ADMIN })).json.data as
      { id: string; reason: string; status: string; targetMemberId: string }[]
    const esc = list.find(e => e.reason === 'issue_reported' && e.targetMemberId === HR)!

    // member は解決不可
    expect((await api('POST', `/v1/escalations/${esc.id}/resolution`, { as: MEMBER, body: { type: 'no_action' } })).status).toBe(403)

    const res = await api('POST', `/v1/escalations/${esc.id}/resolution`, {
      as: ADMIN,
      body: { type: 'ruling', body: '仕様は A 案で確定とする', reflectKnowledge: true, knowledgeTarget: { domain: 'project', targetId: 'pj-x' } },
    })
    expect(res.status).toBe(200)
    expect((res.json.data as { knowledgeReflected: boolean }).knowledgeReflected).toBe(true)

    const again = await api('POST', `/v1/escalations/${esc.id}/resolution`, { as: ADMIN, body: { type: 'no_action' } })
    expect(again.status).toBe(409)
    expect(again.json.error?.code).toBe('AKO-ESC-003')

    // ナレッジへ還流された記事が存在（source=escalation・sourceRefId 一致）
    const ka = (await api('GET', '/v1/masters/knowledge', { as: ADMIN })).json.data as
      { source: string; sourceRefId: string | null; tags: string[] }[]
    expect(ka.some(k => k.source === 'escalation' && k.sourceRefId === esc.id)).toBe(true)

    // 回答フロー: 別メンバーの起票 → answer 解決 → 本人へ通知
    const raised = await api('POST', '/v1/escalations', {
      as: MEMBER, body: { reason: 'issue_reported', context: '承認フローの相談', dedupeKey: `issue:${MEMBER}:2026-07-20` },
    })
    expect(raised.status).toBe(201)
    const raisedId = (raised.json.data as { id: string }).id
    expect((await api('POST', `/v1/escalations/${raisedId}/resolution`, {
      as: ADMIN, body: { type: 'answer', body: '来週の定例で決めましょう' },
    })).status).toBe(200)
    const memberNotes = (await api('GET', '/v1/notifications', { as: MEMBER })).json.data as { kind: string; title: string }[]
    expect(memberNotes.some(n => n.kind === 'escalation' && n.title === '管理者からの回答')).toBe(true)
  })
})

describe('ワークフロー・稟議', () => {
  let wfId = ''

  it('下書き保存 → 提出（経路凍結・step1 承認者へ通知）。経路なしは AKO-WFL-003', async () => {
    // 経路マスタ（マイグレーション seed）が参照できる
    const routes = (await api('GET', '/v1/masters/workflow-routes', { as: MEMBER })).json.data as
      { id: string; category: string }[]
    expect(routes.filter(r => r.category === 'purchase').length).toBeGreaterThanOrEqual(3)

    // 該当経路なし（purchase 以外は未定義）
    const noRoute = await api('POST', '/v1/workflows/submit', {
      as: MEMBER, body: { category: 'trip', title: '出張申請', amount: 30000 },
    })
    expect(noRoute.status).toBe(409)
    expect(noRoute.json.error?.code).toBe('AKO-WFL-003')

    // 下書き → 下書き更新 → 提出（10 万未満 = manager 1 段。承認者 = admin 社員）
    const draft = await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: { category: 'purchase', title: 'モニター購入', amount: 50000 },
    })
    expect(draft.status).toBe(201)
    wfId = (draft.json.data as { id: string }).id
    expect((await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: { id: wfId, category: 'purchase', title: 'モニター購入（2台）', amount: 90000 },
    })).status).toBe(200)

    const submit = await api('POST', '/v1/workflows/submit', {
      as: MEMBER, body: { id: wfId, category: 'purchase', title: 'モニター購入（2台）', amount: 90000 },
    })
    expect(submit.status).toBe(200)
    const list = (await api('GET', '/v1/workflows', { as: HR })).json.data as
      { id: string; status: string; currentStep: number; routeSnapshot: unknown[] }[]
    const mine = list.find(r => r.id === wfId)!
    expect(mine.status).toBe('in_review')
    expect(mine.currentStep).toBe(1)
    expect(mine.routeSnapshot.length).toBe(1)

    // step1 承認者（ADMIN）へ通知が届く
    const notes = (await api('GET', '/v1/notifications?unread=1', { as: ADMIN })).json.data as { title: string }[]
    expect(notes.some(n => n.title === '承認依頼: モニター購入（2台）')).toBe(true)
  })

  it('承認権限ガード → 承認で決裁 + 申請者へ通知。二重承認は AKO-WFL-001', async () => {
    // 申請者本人（承認者ではない）は承認できない
    expect((await api('POST', `/v1/workflows/${wfId}/actions`, { as: MEMBER, body: { action: 'approve' } })).json.error?.code)
      .toBe('AKO-WFL-001')
    // HR も承認者ではない
    expect((await api('POST', `/v1/workflows/${wfId}/actions`, { as: HR, body: { action: 'approve' } })).status).toBe(403)

    expect((await api('POST', `/v1/workflows/${wfId}/actions`, { as: ADMIN, body: { action: 'approve' } })).status).toBe(200)
    const list = (await api('GET', '/v1/workflows', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(list.find(r => r.id === wfId)?.status).toBe('approved')

    // 決裁済みへの再操作は不可
    expect((await api('POST', `/v1/workflows/${wfId}/actions`, { as: ADMIN, body: { action: 'approve' } })).json.error?.code)
      .toBe('AKO-WFL-001')

    // 申請者へ決裁通知 + 証跡（submit → approve）
    const memberNotes = (await api('GET', '/v1/notifications?unread=1', { as: MEMBER })).json.data as { title: string }[]
    expect(memberNotes.some(n => n.title === '決裁: モニター購入（2台）')).toBe(true)
    const logs = (await api('GET', `/v1/workflows/${wfId}/logs`, { as: MEMBER })).json.data as { action: string }[]
    expect(logs.map(l => l.action)).toEqual(['submit', 'approve'])
  })

  it('差戻し（コメント必須）→ 再申請。代理承認は delegateForId を記録', async () => {
    const submit = await api('POST', '/v1/workflows/submit', {
      as: HR, body: { category: 'purchase', title: '書籍購入', amount: 20000 },
    })
    const id = (submit.json.data as { id: string }).id

    // コメントなしの差戻しは AKO-WFL-002
    expect((await api('POST', `/v1/workflows/${id}/actions`, { as: ADMIN, body: { action: 'remand' } })).json.error?.code)
      .toBe('AKO-WFL-002')
    expect((await api('POST', `/v1/workflows/${id}/actions`, {
      as: ADMIN, body: { action: 'remand', comment: '見積書を添付してください' },
    })).status).toBe(200)

    // 再申請（remanded → in_review）
    expect((await api('POST', '/v1/workflows/submit', {
      as: HR, body: { id, category: 'purchase', title: '書籍購入', amount: 20000 },
    })).status).toBe(200)

    // 代理承認: ADMIN が MEMBER を代理人に設定 → MEMBER が承認できる
    expect((await api('POST', '/v1/workflows/delegates', {
      as: ADMIN, body: { delegateMemberId: MEMBER, from: '2026-01-01', to: '2099-12-31' },
    })).status).toBe(201)
    expect((await api('POST', `/v1/workflows/${id}/actions`, { as: MEMBER, body: { action: 'approve' } })).status).toBe(200)
    const logs = (await api('GET', `/v1/workflows/${id}/logs`, { as: HR })).json.data as
      { action: string; actorId: string; delegateForId: string | null }[]
    const approveLog = logs.find(l => l.action === 'approve')!
    expect(approveLog.actorId).toBe(MEMBER)
    expect(approveLog.delegateForId).toBe(ADMIN)
  })

  it('取下げは申請者本人のみ', async () => {
    const submit = await api('POST', '/v1/workflows/submit', {
      as: HR, body: { category: 'purchase', title: '取下げテスト', amount: 10000 },
    })
    const id = (submit.json.data as { id: string }).id
    expect((await api('POST', `/v1/workflows/${id}/actions`, { as: MEMBER, body: { action: 'withdraw' } })).status).toBe(403)
    expect((await api('POST', `/v1/workflows/${id}/actions`, { as: HR, body: { action: 'withdraw' } })).status).toBe(200)
    const list = (await api('GET', '/v1/workflows', { as: HR })).json.data as { id: string; status: string }[]
    expect(list.find(r => r.id === id)?.status).toBe('withdrawn')
  })

  it('他人の下書きは一覧に出ない（本人と管理者のみ。未提出の情報露出防止）', async () => {
    const draft = await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: { category: 'purchase', title: '下書き秘匿テスト', amount: 12000 },
    })
    const draftId = (draft.json.data as { id: string }).id
    const visibleTo = async (as: string): Promise<boolean> => {
      const list = (await api('GET', '/v1/workflows', { as })).json.data as { id: string }[]
      return list.some(r => r.id === draftId)
    }
    expect(await visibleTo(MEMBER)).toBe(true)
    expect(await visibleTo(ADMIN)).toBe(true)
    expect(await visibleTo(HR)).toBe(false)
  })

  it('添付の実ファイル（監査指摘 2026-07-30 ②): 保存 → 一覧/DL・差分同期・下書きは本人と管理者のみ参照', async () => {
    const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
    // 対応外形式・名前のみ添付との共存を検証しつつ下書き保存
    const badExt = await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: {
        category: 'purchase', title: '添付テスト', amount: 30000,
        files: [{ filename: 'evil.exe', contentBase64: b64('x') }],
      },
    })
    expect(badExt.status).toBe(400)
    expect(badExt.json.error?.code).toBe('AKO-WFL-004')

    const draft = await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: {
        category: 'purchase', title: '添付テスト', amount: 30000,
        attachments: ['名前のみ旧添付.pdf'],
        files: [
          { filename: '見積書.pdf', contentBase64: b64('%PDF-1.4 見積内容') },
          { filename: '仕様.txt', contentBase64: b64('仕様メモ') },
        ],
        keepFileIds: [],
      },
    })
    expect(draft.status).toBe(201)
    const id = (draft.json.data as { id: string }).id

    // ファイル一覧: 実体 2 件・attachments は名前のみ + 実ファイル名の合成
    type FileRow = { id: string; filename: string; sizeBytes: number }
    const files = (await api('GET', `/v1/workflows/${id}/files`, { as: MEMBER })).json.data as FileRow[]
    expect(files.map(f => f.filename).sort()).toEqual(['仕様.txt', '見積書.pdf'])
    const row = ((await api('GET', '/v1/workflows', { as: MEMBER })).json.data as { id: string; attachments: string[] }[])
      .find(r => r.id === id)!
    expect(row.attachments).toEqual(['名前のみ旧添付.pdf', '見積書.pdf', '仕様.txt'])

    // 下書きの添付は他人（HR）から見えない（一覧の可視性と同一 = 404）
    expect((await api('GET', `/v1/workflows/${id}/files`, { as: HR })).status).toBe(404)
    // 管理者は参照できる
    expect((await api('GET', `/v1/workflows/${id}/files`, { as: ADMIN })).status).toBe(200)

    // 原本ダウンロード（base64 ラウンドトリップ）
    const pdf = files.find(f => f.filename === '見積書.pdf')!
    const dl = await api('GET', `/v1/workflows/${id}/files/${pdf.id}`, { as: MEMBER })
    expect((dl.json.data as { contentBase64: string; mime: string }).mime).toBe('application/pdf')
    expect(Buffer.from((dl.json.data as { contentBase64: string }).contentBase64, 'base64').toString('utf8'))
      .toBe('%PDF-1.4 見積内容')

    // 差分同期: 1 件だけ keep + 新規 1 件 → 落とした方は削除される
    const keep = files.find(f => f.filename === '仕様.txt')!
    await api('PUT', '/v1/workflows/draft', {
      as: MEMBER, body: {
        id, category: 'purchase', title: '添付テスト', amount: 30000,
        attachments: ['名前のみ旧添付.pdf'],
        files: [{ filename: '比較表.md', contentBase64: b64('# 比較') }],
        keepFileIds: [keep.id],
      },
    })
    const after = (await api('GET', `/v1/workflows/${id}/files`, { as: MEMBER })).json.data as FileRow[]
    expect(after.map(f => f.filename).sort()).toEqual(['仕様.txt', '比較表.md'])
    expect((await api('GET', `/v1/workflows/${id}/files/${pdf.id}`, { as: MEMBER })).status).toBe(404)

    // 提出後は全員参照可（C2）+ 添付はそのまま
    await api('POST', '/v1/workflows/submit', {
      as: MEMBER, body: {
        id, category: 'purchase', title: '添付テスト', amount: 30000,
        attachments: ['名前のみ旧添付.pdf'], keepFileIds: after.map(f => f.id),
      },
    })
    expect(((await api('GET', `/v1/workflows/${id}/files`, { as: HR })).json.data as FileRow[]).length).toBe(2)

    // files / keepFileIds を送らない旧クライアントの保存は実体に触れない（下位互換 = 原則7）
    const legacy = await api('PUT', '/v1/workflows/draft', {
      as: HR, body: { category: 'expense', title: '旧クライアント', amount: 5000, attachments: ['領収書.pdf'] },
    })
    const legacyId = (legacy.json.data as { id: string }).id
    const legacyRow = ((await api('GET', '/v1/workflows', { as: HR })).json.data as { id: string; attachments: string[] }[])
      .find(r => r.id === legacyId)!
    expect(legacyRow.attachments).toEqual(['領収書.pdf'])
    expect(((await api('GET', `/v1/workflows/${legacyId}/files`, { as: HR })).json.data as FileRow[]).length).toBe(0)
  })

  it('経路マスタ: 上限 <= 下限・順序重複はサーバー側でも拒否（AKO-GEN-001）', async () => {
    const bad = await api('POST', '/v1/masters/workflow-routes', {
      as: ADMIN,
      body: {
        category: 'contract', minAmount: 100000, maxAmount: 100000,
        steps: [
          { order: 1, approverType: 'role', approverRole: 'admin' },
          { order: 1, approverType: 'role', approverRole: 'hr' },
        ],
      },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.message).toContain('上限金額')

    // PATCH（部分更新）でも既存行とマージした結果で検証される
    const badPatch = await api('PATCH', '/v1/masters/workflow-routes/wr-01', {
      as: ADMIN, body: { maxAmount: 0 },
    })
    expect(badPatch.status).toBe(400)
    expect(badPatch.json.error?.message).toContain('上限金額')
  })
})

describe('シフト', () => {
  let periodId = ''
  const YOUNG = 'm-young'
  const start = addDays(todayJst(), 7)
  const end = addDays(todayJst(), 13)

  it('募集期間の作成は管理者のみ（AKO-SFT-008）。入力検証は AKO-SFT-007', async () => {
    // 年少者（16 歳前後）スタッフを直接シード（深夜割当ガードの検証用）
    const y = Number(todayJst().slice(0, 4)) - 16
    await pool.query(
      `INSERT INTO members (id, name, email, role, employment_type, birth_date)
       VALUES ($1, '若手 三郎', 'young@example.com', 'member', 'parttime', $2) ON CONFLICT (id) DO NOTHING`,
      [YOUNG, `${y}-01-15`])

    expect((await api('POST', '/v1/shifts/periods', {
      as: MEMBER, body: { label: 'x', startDate: start, endDate: end, wishDeadline: todayJst() },
    })).json.error?.code).toBe('AKO-SFT-008')
    expect((await api('POST', '/v1/shifts/periods', {
      as: ADMIN, body: { label: '検証期間', startDate: start, endDate: end, wishDeadline: addDays(start, 1) },
    })).json.error?.code).toBe('AKO-SFT-007') // 締切が開始日より後

    const created = await api('POST', '/v1/shifts/periods', {
      as: ADMIN, body: { label: '検証期間', startDate: start, endDate: end, wishDeadline: todayJst() },
    })
    expect(created.status).toBe(201)
    periodId = (created.json.data as { id: string }).id
  })

  it('状態機械: 正順のみ遷移可（AKO-SFT-002）。希望は open 中のみ（AKO-SFT-003）', async () => {
    // draft のまま希望提出は不可
    expect((await api('PUT', '/v1/shifts/wishes', {
      as: YOUNG, body: { periodId, date: start, wish: 'want' },
    })).json.error?.code).toBe('AKO-SFT-003')
    // 順序飛ばし（draft → adjusting）は不可
    expect((await api('POST', `/v1/shifts/periods/${periodId}/transition`, {
      as: ADMIN, body: { next: 'adjusting' },
    })).json.error?.code).toBe('AKO-SFT-002')
    expect((await api('POST', `/v1/shifts/periods/${periodId}/transition`, {
      as: ADMIN, body: { next: 'open' },
    })).status).toBe(200)

    // 希望提出（本人スコープ）: 上書き = 設定系。期間外日付は AKO-SFT-007
    expect((await api('PUT', '/v1/shifts/wishes', {
      as: YOUNG, body: { periodId, date: addDays(end, 1), wish: 'want' },
    })).json.error?.code).toBe('AKO-SFT-007')
    expect((await api('PUT', '/v1/shifts/wishes', {
      as: YOUNG, body: { periodId, date: start, wish: 'want', from: '10:00', to: '15:00' },
    })).status).toBe(200)
    expect((await api('PUT', '/v1/shifts/wishes', {
      as: YOUNG, body: { periodId, date: addDays(start, 1), wish: 'ng' },
    })).status).toBe(200)

    // 本人には自分の希望のみ・他人には見えない（スコープ）
    const mine = (await api('GET', '/v1/shifts', { as: YOUNG })).json.data as { wishes: { date: string }[] }
    expect(mine.wishes.length).toBe(2)
    const other = (await api('GET', '/v1/shifts', { as: MEMBER })).json.data as { wishes: unknown[] }
    expect(other.wishes.length).toBe(0)

    // 取消 → 再取消は AKO-SFT-005
    expect((await api('POST', '/v1/shifts/wishes/clear', {
      as: YOUNG, body: { periodId, date: addDays(start, 1) },
    })).status).toBe(200)
    expect((await api('POST', '/v1/shifts/wishes/clear', {
      as: YOUNG, body: { periodId, date: addDays(start, 1) },
    })).json.error?.code).toBe('AKO-SFT-005')
  })

  it('割当は調整中のみ（AKO-SFT-004）。年少者の深夜は AKO-SFT-001・休憩不足は警告', async () => {
    // open 中の割当は不可
    expect((await api('POST', '/v1/shifts/assignments', {
      as: ADMIN, body: { periodId, memberId: YOUNG, date: start, from: '10:00', to: '15:00' },
    })).json.error?.code).toBe('AKO-SFT-004')
    expect((await api('POST', `/v1/shifts/periods/${periodId}/transition`, { as: ADMIN, body: { next: 'closed' } })).status).toBe(200)
    expect((await api('POST', `/v1/shifts/periods/${periodId}/transition`, { as: ADMIN, body: { next: 'adjusting' } })).status).toBe(200)

    // 年少者（16 歳）の深夜帯は割当不可（労基法61条）
    expect((await api('POST', '/v1/shifts/assignments', {
      as: ADMIN, body: { periodId, memberId: YOUNG, date: start, from: '21:00', to: '23:30' },
    })).json.error?.code).toBe('AKO-SFT-001')

    // 8h 超は休憩警告（W01）付きで割当可
    const long = await api('POST', '/v1/shifts/assignments', {
      as: ADMIN, body: { periodId, memberId: YOUNG, date: start, from: '09:00', to: '19:00' },
    })
    expect(long.status).toBe(200)
    expect(((long.json.data as { warnings: { code: string }[] }).warnings).some(w => w.code === 'AKO-SFT-W01')).toBe(true)

    // 必要人数の設定（upsert）→ 0 で削除
    expect((await api('PUT', '/v1/shifts/demands', {
      as: ADMIN, body: { periodId, date: start, from: '10:00', to: '17:00', required: 2 },
    })).status).toBe(200)
    expect((await api('PUT', '/v1/shifts/demands', {
      as: ADMIN, body: { periodId, date: addDays(start, 1), from: '10:00', to: '17:00', required: 1 },
    })).status).toBe(200)
    expect((await api('PUT', '/v1/shifts/demands', {
      as: ADMIN, body: { periodId, date: addDays(start, 1), required: 0 },
    })).status).toBe(200)
    // 小数の required は切り捨てて 0 扱い = 削除パス（CHECK (required > 0) 違反の 500 にしない）
    expect((await api('PUT', '/v1/shifts/demands', {
      as: ADMIN, body: { periodId, date: addDays(start, 1), from: '10:00', to: '17:00', required: 0.5 },
    })).status).toBe(200)
    const bundle = (await api('GET', '/v1/shifts', { as: ADMIN })).json.data as { demands: { date: string }[] }
    expect(bundle.demands.filter(d => d.date === start).length).toBe(1)
    expect(bundle.demands.filter(d => d.date === addDays(start, 1)).length).toBe(0)
  })

  it('確定・公開で割当が confirmed + 本人へ通知。確定後変更は本人合意で確定（AKO-SFT-006 ガード）', async () => {
    expect((await api('POST', `/v1/shifts/periods/${periodId}/transition`, {
      as: ADMIN, body: { next: 'published' },
    })).status).toBe(200)
    const mine = (await api('GET', '/v1/shifts', { as: YOUNG })).json.data as
      { assignments: { id: string; status: string; consentAt: string | null }[] }
    const a = mine.assignments[0]!
    expect(a.status).toBe('confirmed')
    const notes = (await api('GET', '/v1/notifications?unread=1', { as: YOUNG })).json.data as { title: string }[]
    expect(notes.some(n => n.title === 'シフトが確定しました')).toBe(true)

    // published 後の割当変更は不可（確定後変更のフローのみ）
    expect((await api('POST', '/v1/shifts/assignments', {
      as: ADMIN, body: { periodId, memberId: YOUNG, date: start, from: '10:00', to: '16:00' },
    })).json.error?.code).toBe('AKO-SFT-004')

    // 合意待ちがない状態の consent は AKO-SFT-006
    expect((await api('POST', `/v1/shifts/assignments/${a.id}/consent`, { as: YOUNG })).json.error?.code)
      .toBe('AKO-SFT-006')

    // 変更申請（管理者）→ 本人以外の合意は不可 → 本人合意で confirmed + consentAt 記録
    expect((await api('POST', `/v1/shifts/assignments/${a.id}/request-change`, {
      as: ADMIN, body: { from: '10:00', to: '16:00' },
    })).status).toBe(200)
    expect((await api('POST', `/v1/shifts/assignments/${a.id}/consent`, { as: MEMBER })).json.error?.code)
      .toBe('AKO-SFT-006')
    expect((await api('POST', `/v1/shifts/assignments/${a.id}/consent`, { as: YOUNG })).status).toBe(200)

    const after = (await api('GET', '/v1/shifts', { as: YOUNG })).json.data as
      { assignments: { id: string; status: string; consentAt: string | null; from: string; to: string }[] }
    const done = after.assignments.find(x => x.id === a.id)!
    expect(done.status).toBe('confirmed')
    expect(done.from).toBe('10:00')
    expect(done.to).toBe('16:00')
    expect(done.consentAt).toBeTruthy()
    // 管理者へ合意通知
    const adminNotes = (await api('GET', '/v1/notifications?unread=1', { as: ADMIN })).json.data as { title: string }[]
    expect(adminNotes.some(n => n.title === 'シフト変更に本人が合意')).toBe(true)
  })
})

describe('タスク計画（AI業務アシスタント）', () => {
  let planId = ''
  const today = todayJst()

  it('作成・更新は本人のみ。入力検証（AKO-TPL-001/002）', async () => {
    expect((await api('PUT', '/v1/task-plans', { as: MEMBER, body: { title: '', date: today } })).json.error?.code)
      .toBe('AKO-TPL-001')
    expect((await api('PUT', '/v1/task-plans', { as: MEMBER, body: { title: 'x', date: '' } })).json.error?.code)
      .toBe('AKO-TPL-002')
    const created = await api('PUT', '/v1/task-plans', {
      as: MEMBER,
      body: { title: '請求書テンプレの整備', date: today, purpose: '経理の手作業を減らすため', doneCriteria: '', approach: '' },
    })
    expect(created.status).toBe(201)
    planId = (created.json.data as { id: string }).id

    // 他人の計画は編集不可（403 AKO-TPL-003）・一覧にも出ない（本人スコープ）
    expect((await api('PUT', '/v1/task-plans', {
      as: HR, body: { id: planId, title: '乗っ取り', date: today },
    })).json.error?.code).toBe('AKO-TPL-003')
    const hrList = (await api('GET', '/v1/task-plans', { as: HR })).json.data as { id: string }[]
    expect(hrList.some(p => p.id === planId)).toBe(false)
  })

  it('AI レビューは LLM 無効環境でヒューリスティックへフォールバック（モックと同一文言）', async () => {
    const r = await api('POST', `/v1/task-plans/${planId}/ai-review`, { as: MEMBER })
    expect(r.status).toBe(200)
    const comment = (r.json.data as { aiComment: string }).aiComment
    expect(comment).toContain('目的が明確です。')
    expect(comment).toContain('達成条件が未記入です。')
    // 他人はレビュー不可
    expect((await api('POST', `/v1/task-plans/${planId}/ai-review`, { as: HR })).status).toBe(403)
  })

  it('結果記録後も本人は訂正できる（編集・再記録・後追い AI コメント・削除。オペレーター指示 2026-07-21）', async () => {
    expect((await api('POST', `/v1/task-plans/${planId}/result`, { as: MEMBER, body: { outcome: '' } })).json.error?.code)
      .toBe('AKO-TPL-005')
    expect((await api('POST', `/v1/task-plans/${planId}/result`, {
      as: MEMBER, body: { outcome: 'テンプレ完成。経理へ共有済み', reflection: '想定より早く終わった' },
    })).status).toBe(200)
    // done でも誤記の訂正ができる: 再記録・本文編集・後追い AI コメント（いずれも 200）。
    // タイトルは下流テスト（日報ドラフト）が参照するため保持し、本文編集は purpose の訂正で検証する
    expect((await api('POST', `/v1/task-plans/${planId}/result`, {
      as: MEMBER, body: { outcome: 'テンプレ完成。経理へ共有済み（訂正）' },
    })).status).toBe(200)
    expect((await api('PUT', '/v1/task-plans', {
      as: MEMBER, body: { id: planId, title: '請求書テンプレの整備', date: today, purpose: '経理の手作業を減らす（訂正）' },
    })).status).toBe(200)
    expect((await api('POST', `/v1/task-plans/${planId}/ai-review`, { as: MEMBER })).status).toBe(200)
    // 他人は依然として操作不可（本人ガード AKO-TPL-003）
    expect((await api('POST', `/v1/task-plans/${planId}/result`, { as: HR, body: { outcome: 'x' } })).json.error?.code)
      .toBe('AKO-TPL-003')
    // インサイト: 管理者のみ。MEMBER の完了が集計される
    expect((await api('GET', '/v1/task-plans/insights', { as: MEMBER })).status).toBe(403)
    const ins = (await api('GET', '/v1/task-plans/insights', { as: ADMIN })).json.data as
      { memberId: string; planned: number; done: number; doneRate: number | null }[]
    const mine = ins.find(x => x.memberId === MEMBER)!
    expect(mine.planned).toBeGreaterThanOrEqual(1)
    expect(mine.done).toBeGreaterThanOrEqual(1)
    // done でも取消（削除）できる（原則9.5 = 取消フロー）。planId は下流テストが参照するため消さず、
    // 使い捨ての done 計画を新規作成して削除できることを検証する
    const throwaway = await api('PUT', '/v1/task-plans', {
      as: MEMBER, body: { title: '取消検証用', date: today, purpose: '', doneCriteria: '', approach: '' },
    })
    const throwawayId = (throwaway.json.data as { id: string }).id
    expect((await api('POST', `/v1/task-plans/${throwawayId}/result`, { as: MEMBER, body: { outcome: '完了' } })).status).toBe(200)
    expect((await api('POST', `/v1/task-plans/${throwawayId}/remove`, { as: MEMBER })).status).toBe(200)
  })

  it('他メンバーの計画は権限（ai-assistant + member:<id>）で許可された対象者のみ readonly 参照可', async () => {
    // 既定 = 参照不可。許可ルール未設定の HR は MEMBER の計画を memberId 指定で取得できない（AKO-PRM-002）
    const denied = await api('GET', `/v1/task-plans?memberId=${MEMBER}`, { as: HR })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-002')
    // 自分自身の memberId 指定は常に可（本人スコープと同じ）
    expect((await api('GET', `/v1/task-plans?memberId=${MEMBER}`, { as: MEMBER })).status).toBe(200)
  })

  it('許可パス: allow ルール保持者は対象メンバーの計画/ログを 200 で取得・無関係な第三者指定は 403', async () => {
    // MEMBER が今日の計画を 1 件持つように用意（前テストで作った計画は削除済みのため作り直す）
    await api('PUT', '/v1/task-plans', {
      as: MEMBER, body: { title: '参照許可パス検証', date: today, purpose: 'p', doneCriteria: '', approach: '' },
    })
    // HR に「MEMBER の AI業務アシスタントを参照可」を付与（resource='ai-assistant' + field='member:<MEMBER>' allow）
    await pool.query(
      `INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
       VALUES ('pr-test-assist-view', 'member', $1, 'ai-assistant', $2, 'allow', true)
       ON CONFLICT (id) DO UPDATE SET active = true`,
      [HR, `member:${MEMBER}`])
    clearPermissionCache()
    try {
      const plans = await api('GET', `/v1/task-plans?memberId=${MEMBER}`, { as: HR })
      expect(plans.status).toBe(200)
      const rows = plans.json.data as { memberId: string }[]
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows.every(p => p.memberId === MEMBER)).toBe(true) // 対象メンバーの行のみ
      // ヒアリングログも同じ許可で 200
      expect((await api('GET', `/v1/assist/logs?memberId=${MEMBER}`, { as: HR })).status).toBe(200)
      // 許可対象は MEMBER のみ。無関係な第三者（ADMIN）指定は依然 403
      expect((await api('GET', `/v1/task-plans?memberId=${ADMIN}`, { as: HR })).json.error?.code).toBe('AKO-PRM-002')
    } finally {
      await pool.query(`DELETE FROM permission_rules WHERE id = 'pr-test-assist-view'`)
      clearPermissionCache()
    }
  })
})

describe('日報 AI アシスト', () => {
  const today = todayJst()

  it('回答・メモは追記のみ（本人スコープ）。空入力は AKO-RAS-001/002', async () => {
    expect((await api('POST', '/v1/assist/answers', { as: MEMBER, body: { answer: '' } })).json.error?.code)
      .toBe('AKO-RAS-001')
    expect((await api('POST', '/v1/assist/memos', { as: MEMBER, body: { text: ' ' } })).json.error?.code)
      .toBe('AKO-RAS-002')
    expect((await api('POST', '/v1/assist/answers', {
      as: MEMBER, body: { date: today, question: 'wrap:issue|困りごと・課題はありますか？', answer: 'レビュー待ちで遅れ気味' },
    })).status).toBe(201)
    expect((await api('POST', '/v1/assist/answers', {
      as: MEMBER, body: { date: today, question: 'wrap:tomorrow|明日やる予定を一言で', answer: '締め処理の自動化' },
    })).status).toBe(201)
    expect((await api('POST', '/v1/assist/memos', {
      as: MEMBER, body: { date: today, text: '午後は問い合わせ対応が多かった' },
    })).status).toBe(201)
    const mine = (await api('GET', `/v1/assist/logs?date=${today}`, { as: MEMBER })).json.data as unknown[]
    expect(mine.length).toBe(3)
    const others = (await api('GET', `/v1/assist/logs?date=${today}`, { as: HR })).json.data as unknown[]
    expect(others.length).toBe(0)
  })

  it('ドラフト生成: LLM 無効環境はヒューリスティック（計画結果・回答・メモを反映。保存しない）', async () => {
    const r = await api('POST', '/v1/assist/report-draft', { as: MEMBER, body: { date: today } })
    expect(r.status).toBe(200)
    const d = r.json.data as {
      entries: { task: string }[]; reflection: string; issues: string; tomorrow: string; basis: string[]
    }
    // タスク計画（done）の結果がエントリへ
    expect(d.entries.some(e => e.task.includes('請求書テンプレの整備'))).toBe(true)
    // メモ → 所感 / 課題回答 → issues / 明日回答 → tomorrow
    expect(d.reflection).toContain('午後は問い合わせ対応が多かった')
    expect(d.issues).toContain('レビュー待ちで遅れ気味')
    expect(d.tomorrow).toBe('締め処理の自動化')
    expect(d.basis.length).toBeGreaterThan(0)
  })
})

describe('意思決定支援', () => {
  it('テーマは移行済みマスタ（マイグレーション seed）。判断記録の検証と追記・全員参照', async () => {
    const themes = (await api('GET', '/v1/masters/decision-themes', { as: MEMBER })).json.data as
      { id: string; options: { slot: string }[] }[]
    expect(themes.length).toBeGreaterThanOrEqual(3)
    const theme = themes.find(t => t.id === 'dt-01')!
    expect(theme.options.length).toBeGreaterThan(0)

    // 検証: 理由必須 → テーマなし → 選択肢なし
    expect((await api('POST', '/v1/decisions/logs', {
      as: MEMBER, body: { themeId: 'dt-01', slot: theme.options[0]!.slot, reason: ' ' },
    })).json.error?.code).toBe('AKO-DEC-003')
    expect((await api('POST', '/v1/decisions/logs', {
      as: MEMBER, body: { themeId: 'dt-zzz', slot: 'A', reason: 'x' },
    })).json.error?.code).toBe('AKO-DEC-001')
    expect((await api('POST', '/v1/decisions/logs', {
      as: MEMBER, body: { themeId: 'dt-01', slot: 'Z', reason: 'x' },
    })).json.error?.code).toBe('AKO-DEC-002')

    // 記録（追記のみ）→ 全員が参照可・decidedBy が記録される
    const created = await api('POST', '/v1/decisions/logs', {
      as: MEMBER, body: { themeId: 'dt-01', slot: theme.options[0]!.slot, reason: 'PoC 単価が採算ラインを超えるため' },
    })
    expect(created.status).toBe(201)
    const logs = (await api('GET', '/v1/decisions/logs', { as: HR })).json.data as
      { themeId: string; decidedBy: string; reason: string }[]
    const mine = logs.find(l => l.themeId === 'dt-01')!
    expect(mine.decidedBy).toBe(MEMBER)
    expect(mine.reason).toContain('採算ライン')
  })
})

describe('チャットボット応答', () => {
  it('LLM 無効環境は fallback: true + セッション自動作成。空質問は 400', async () => {
    expect((await api('POST', '/v1/chatbot/ask', { as: MEMBER, body: { question: ' ' } })).status).toBe(400)
    const r = await api('POST', '/v1/chatbot/ask', { as: MEMBER, body: { question: '有給の残りは何日？' } })
    expect(r.status).toBe(200)
    const data = r.json.data as { fallback: boolean; sessionId: string }
    expect(data.fallback).toBe(true)
    expect(data.sessionId).toMatch(/^cs-/)
  })

  it('セッション管理: マルチターン追記・本人のみ参照・フォールバック応答の追記・再開', async () => {
    // 1 問目 → セッション作成（タイトルは最初の質問）+ user メッセージ永続化
    const first = await api('POST', '/v1/chatbot/ask', { as: HR, body: { question: '経費精算のルールを教えて' } })
    const sessionId = (first.json.data as { sessionId: string }).sessionId

    // フォールバック応答（クライアントの決定的ルーティング結果）を追記
    const bot = await api('POST', `/v1/chatbot/sessions/${sessionId}/messages`, {
      as: HR, body: { content: '経費精算規程をご確認ください', sources: ['ドキュメント管理'], suggestions: ['稟議を申請するには？'] },
    })
    expect(bot.status).toBe(201)

    // 2 問目を同一セッションへ（マルチターン）
    const second = await api('POST', '/v1/chatbot/ask', { as: HR, body: { question: 'その上限額は？', sessionId } })
    expect((second.json.data as { sessionId: string }).sessionId).toBe(sessionId)

    // セッション一覧: 本人には見え、タイトルは最初の質問。他人には見えない
    const mine = (await api('GET', '/v1/chatbot/sessions', { as: HR })).json.data as
      { id: string; title: string; messageCount: number }[]
    const s = mine.find(x => x.id === sessionId)
    expect(s?.title).toBe('経費精算のルールを教えて')
    expect(s?.messageCount).toBe(3) // user + assistant + user
    const others = (await api('GET', '/v1/chatbot/sessions', { as: MEMBER })).json.data as { id: string }[]
    expect(others.some(x => x.id === sessionId)).toBe(false)

    // メッセージの再開取得: 本人は時系列で取得、他人は AKO-CHT-001（404）
    const msgs = (await api('GET', `/v1/chatbot/sessions/${sessionId}/messages`, { as: HR })).json.data as
      { role: string; content: string }[]
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1]!.content).toBe('経費精算規程をご確認ください')
    const denied = await api('GET', `/v1/chatbot/sessions/${sessionId}/messages`, { as: MEMBER })
    expect(denied.status).toBe(404)
    expect(denied.json.error?.code).toBe('AKO-CHT-001')
    // 他人のセッションへの ask・追記も拒否
    expect((await api('POST', '/v1/chatbot/ask', { as: MEMBER, body: { question: 'x', sessionId } })).status).toBe(404)
    expect((await api('POST', `/v1/chatbot/sessions/${sessionId}/messages`, { as: MEMBER, body: { content: 'x' } })).status).toBe(404)
  })

  it('回復経路（監査指摘 2026-07-30 ④）: /ask 不達時のセッション明示作成 + role=user の追記で初回送信が永続する', async () => {
    // /ask が届かなかった新規会話をクライアントが回復する経路: POST /sessions → 質問（role=user）→ 応答を追記
    expect((await api('POST', '/v1/chatbot/sessions', { as: MEMBER, body: { title: '' } })).status).toBe(400)
    const created = await api('POST', '/v1/chatbot/sessions', { as: MEMBER, body: { title: '通信断からの回復テスト' } })
    expect(created.status).toBe(201)
    const sid = (created.json.data as { id: string }).id
    expect((await api('POST', `/v1/chatbot/sessions/${sid}/messages`, {
      as: MEMBER, body: { role: 'user', content: '通信断からの回復テスト' },
    })).status).toBe(201)
    expect((await api('POST', `/v1/chatbot/sessions/${sid}/messages`, {
      as: MEMBER, body: { content: 'フォールバック応答', sources: [], suggestions: [] },
    })).status).toBe(201)
    const msgs = (await api('GET', `/v1/chatbot/sessions/${sid}/messages`, { as: MEMBER })).json.data as
      { role: string; content: string }[]
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0]!.content).toBe('通信断からの回復テスト')
    // 不正 role は assistant へ倒す（role 汚染を防ぐ）
    await api('POST', `/v1/chatbot/sessions/${sid}/messages`, { as: MEMBER, body: { role: 'system', content: 'x' } })
    const after = (await api('GET', `/v1/chatbot/sessions/${sid}/messages`, { as: MEMBER })).json.data as { role: string }[]
    expect(after[2]!.role).toBe('assistant')
    // 他人はセッションを作れても他人のセッションへは追記できない（既存ガードの適用確認）
    expect((await api('POST', `/v1/chatbot/sessions/${sid}/messages`, {
      as: HR, body: { role: 'user', content: 'x' },
    })).status).toBe(404)
  })

  it('文脈収集は全ドメインを参照し、権限（F-16）に従う（バッチ5d: buildContext 直接検証）', async () => {
    const { buildContext } = await import('../../src/routes/chatbot')
    const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
    const hrUser = { id: HR, name: '人事 花子', email: 'hr@example.com', role: 'hr' as const, title: '', avatar: '' }

    // 本人の日報（既存テストで提出済み 07-16/17 あり）: ルール未設定 = allow で文脈に含まれる
    const withReports = await buildContext(pool, memberUser, '最近の日報を振り返りたい', [])
    expect(withReports).toContain('本人の直近の日報')

    // reports deny の member ロールには日報文脈が生成されない（機能単位の権限準拠）
    const denyReports = [{
      id: 'pm-t1', subjectKind: 'role' as const, subjectId: 'member', resource: 'reports', field: null,
      effect: 'deny' as const, active: true,
    }]
    const denied = await buildContext(pool, memberUser, '最近の日報を振り返りたい', denyReports)
    expect(denied).not.toContain('本人の直近の日報')
    // 同じルールでも HR（別ロール）には影響しない。他人（一般 次郎）の日報は提出済みのみが含まれる
    // （HR 本人の下書きは本人スコープとして含まれてよい。他人の下書きは固有テーマの不在で検証する）
    const draft = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: { date: '2026-07-10', entries: [{ theme: '未提出の秘密テーマ', task: '下書き作業', hours: 1, progress: 0 }], status: 'draft' },
    })
    expect(draft.status).toBe(200)
    const hrView = await buildContext(pool, hrUser, '一般 次郎 さんの日報の状況は？', denyReports)
    expect(hrView).toContain('一般 次郎 さんの日報（提出済みのみ）')
    expect(hrView).not.toContain('未提出の秘密テーマ') // 他人の下書きは含まれない

    // 表示項目レベル: members.email の deny がメンバー文脈へ反映される（フィールド剥がし）
    const withEmail = await buildContext(pool, hrUser, '一般 次郎 さんの連絡先は？', [])
    expect(withEmail).toContain('member@example.com')
    const emailDeny = [{
      id: 'pm-t2', subjectKind: 'role' as const, subjectId: 'hr', resource: 'members', field: 'email',
      effect: 'deny' as const, active: true,
    }]
    const noEmail = await buildContext(pool, hrUser, '一般 次郎 さんの連絡先は？', emailDeny)
    expect(noEmail).toContain('メンバー「一般 次郎」')
    expect(noEmail).not.toContain('member@example.com')

    // ワークフロー: 本人の申請が文脈に含まれる（既存テストで MEMBER の申請あり）。deny で消える
    const wf = await buildContext(pool, memberUser, '自分の稟議の状況を教えて', [])
    expect(wf).toContain('稟議・申請ガイド')
    const wfDeny = [{
      id: 'pm-t3', subjectKind: 'member' as const, subjectId: MEMBER, resource: 'workflow', field: null,
      effect: 'deny' as const, active: true,
    }]
    const wfDenied = await buildContext(pool, memberUser, '自分の稟議の状況を教えて', wfDeny)
    expect(wfDenied).not.toContain('稟議・申請ガイド')
  })

  it('フォローアップ質問でも直近のユーザー発言から文脈が供給される（オペレーター報告 2026-07-18）', async () => {
    const { buildContext } = await import('../../src/routes/chatbot')
    const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }

    // キーワードを含まないフォローアップ単体では有給文脈は生成されない（従来挙動の確認）
    const without = await buildContext(pool, memberUser, 'じゃあ去年は何日使った？', [])
    expect(without).not.toContain('本人の有給')

    // 直近のユーザー発言（履歴）に「有給」があれば話題を引き継いで文脈が供給される
    const withHistory = await buildContext(pool, memberUser, 'じゃあ去年は何日使った？', [],
      ['有給の残りは何日？'])
    expect(withHistory).toContain('本人の有給')

    // 権限 deny は履歴由来のコーパスに対しても従来どおり効く（参照範囲は拡がらない）
    const denyAtt = [{
      id: 'pm-mt', subjectKind: 'role' as const, subjectId: 'member', resource: 'attendance', field: null,
      effect: 'deny' as const, active: true,
    }]
    expect(await buildContext(pool, memberUser, 'じゃあ去年は何日使った？', denyAtt,
      ['有給の残りは何日？'])).not.toContain('本人の有給')

    // /ask 経由でも履歴が渡ることを確認（LLM 無効環境 = fallback だがユーザー発言は永続され、
    // 次のターンの buildContext へ届く経路をセッション実データで検証）
    const ask1 = await api('POST', '/v1/chatbot/ask', { as: MEMBER, body: { question: '有給の残りは何日？' } })
    expect(ask1.status).toBe(200)
    const sessionId = (ask1.json.data as { sessionId: string }).sessionId
    const { rows: history } = await pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY seq`, [sessionId])
    const historyUserTexts = history.filter(m => m.role === 'user').map(m => m.content)
    expect(historyUserTexts).toContain('有給の残りは何日？')
    expect(await buildContext(pool, memberUser, 'じゃあ去年は？', [], historyUserTexts))
      .toContain('本人の有給')
  })
})

describe('チャットボット文脈の供給網羅（オペレーター報告 2026-07-18 #2: 業界・関係性ほか）', () => {
  const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']
  let custId = ''
  let contactId = ''
  let ctxSelfId = ''

  afterAll(async () => {
    // 後続の売上 ETL テストは「有効な自社は 1 社」を前提にするため、本 describe の自社を後片付けする
    await api('POST', `/v1/masters/companies/${ctxSelfId}/archive`, { as: ADMIN })
  })

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
    // 業界 → 顧客（業界 + 担当付き）→ 自社 → 関係種別 → 会社間/人の関係 → 外部リンク → 部署 を API で整備
    const ind = await api('POST', '/v1/masters/industries', { as: ADMIN, body: { name: 'アパレル' } })
    const indId = (ind.json.data as { id: string }).id
    const self = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { kind: 'self', name: 'ツナグバ本社', fiscalStartMonth: 4 },
    })
    const selfId = (self.json.data as { id: string }).id
    ctxSelfId = selfId
    const cust = await api('POST', '/v1/masters/companies', {
      as: ADMIN,
      body: {
        kind: 'customer', name: 'CTX商事', aliases: ['シーティーエックス'],
        industryIds: [indId], primaryIndustryId: indId, ownerMemberId: ADMIN,
        description: 'アパレル向け商社', location: '東京', size: '100名',
      },
    })
    custId = (cust.json.data as { id: string }).id
    const rtCompany = await api('POST', '/v1/masters/relation-types', {
      as: ADMIN, body: { label: '販売代理店', appliesTo: 'company' },
    })
    await api('POST', '/v1/masters/company-relations', {
      as: ADMIN,
      body: {
        fromCompanyId: selfId, toCompanyId: custId,
        relationTypeId: (rtCompany.json.data as { id: string }).id, notes: '主要取引',
      },
    })
    const contact = await api('POST', '/v1/masters/contacts', {
      as: ADMIN, body: { companyId: custId, name: '文脈 花子', title: '購買部長', keyPerson: 3 },
    })
    contactId = (contact.json.data as { id: string }).id
    const rtContact = await api('POST', '/v1/masters/relation-types', {
      as: ADMIN, body: { label: '窓口', appliesTo: 'contact' },
    })
    // 端点は顧客担当者 + 自社メンバー（PR #29 仕様）
    await api('POST', '/v1/masters/contact-relations', {
      as: ADMIN,
      body: { fromContactId: contactId, toContactId: MEMBER, relationTypeId: (rtContact.json.data as { id: string }).id },
    })
    await api('POST', '/v1/masters/external-links', {
      as: ADMIN, body: { title: '勤怠システム', url: 'https://example.com/kintai', description: '打刻ポータル' },
    })
    await api('POST', '/v1/masters/projects', {
      as: ADMIN, body: { name: '文脈PJ', companyId: custId, type: 'development', status: 'active' },
    })
    const dep = await api('POST', '/v1/masters/departments', { as: ADMIN, body: { name: '文脈開発部' } })
    await api('PATCH', `/v1/masters/members/${MEMBER}`, {
      as: ADMIN, body: { departmentId: (dep.json.data as { id: string }).id },
    })
  })

  it('顧客の業界・自社担当・先方担当者・会社間の関係が文脈に載る（報告の主訴 ①②）', async () => {
    const ctx = await buildContext(pool, adminUser, 'CTX商事の業界と関係性を教えて', [])
    expect(ctx).toContain('顧客「CTX商事」')
    expect(ctx).toContain('業界: アパレル（主）')
    expect(ctx).toContain('自社担当: 管理 太郎')
    expect(ctx).toContain('先方担当者: 文脈 花子（購買部長）')
    expect(ctx).toContain('会社間の関係:')
    expect(ctx).toContain('ツナグバ本社: 販売代理店（主要取引）')
    expect(ctx).toContain('プロジェクト: 文脈PJ（active）')
    // 別名（aliases）でも照合できる
    expect(await buildContext(pool, adminUser, 'シーティーエックスの業界は？', [])).toContain('業界: アパレル（主）')
  })

  it('「自社」キーワードで自社ブロック（会計年度・関係）が載る', async () => {
    const ctx = await buildContext(pool, adminUser, '自社について教えて', [])
    expect(ctx).toContain('自社「ツナグバ本社」')
    expect(ctx).toContain('会計年度: 4 月始まり')
    expect(ctx).toContain('CTX商事: 販売代理店')
  })

  it('業界の逆引き（業界マスタ × 顧客）が載る。companies.name の deny では顧客名が剥がれる', async () => {
    const ctx = await buildContext(pool, adminUser, '業界別の顧客を教えて', [])
    expect(ctx).toContain('業界別の顧客')
    expect(ctx).toContain('- アパレル: CTX商事')
    // 表示項目 deny: 顧客名が剥がれ「該当顧客なし」になる（参照範囲は拡がらない）
    const nameDeny = [{
      id: 'pm-ctx1', subjectKind: 'role' as const, subjectId: 'member', resource: 'companies', field: 'name',
      effect: 'deny' as const, active: true,
    }]
    const denied = await buildContext(pool, memberUser, '業界別の顧客を教えて', nameDeny)
    expect(denied).toContain('- アパレル: 該当顧客なし')
    expect(denied).not.toContain('CTX商事')
  })

  it('人の関係（顧客担当者 ⇄ 自社メンバー）が双方のブロックに載る', async () => {
    const fromContact = await buildContext(pool, adminUser, '文脈 花子さんはどんな人？', [])
    expect(fromContact).toContain('顧客担当者「文脈 花子」')
    expect(fromContact).toContain('人の関係:')
    expect(fromContact).toContain('一般 次郎（自社）: 窓口')
    const fromMember = await buildContext(pool, adminUser, '一般 次郎さんの顧客との関係は？', [])
    expect(fromMember).toContain('メンバー「一般 次郎」')
    expect(fromMember).toContain('文脈 花子: 窓口')
  })

  it('休暇種別・外部リンク・部署（所属メンバー展開）が文脈に載る', async () => {
    const leave = await buildContext(pool, memberUser, 'どんな休暇の種類がありますか？', [])
    expect(leave).toContain('休暇種別')
    expect(leave).toContain('- 有給休暇（法定）')

    const links = await buildContext(pool, memberUser, '勤怠システムのリンクを教えて', [])
    expect(links).toContain('外部リンク')
    expect(links).toContain('- 勤怠システム: https://example.com/kintai')

    const dept = await buildContext(pool, adminUser, '文脈開発部には誰がいますか？', [])
    expect(dept).toContain('部署・組織')
    expect(dept).toContain('「文脈開発部」の所属: 一般 次郎')
  })

  it('補助マスタの表示項目 deny も文脈へ反映される（PR #41 レビュー指摘: strip 網羅）', async () => {
    const deny = (id: string, subjectId: string, resource: string, field: string) => [{
      id, subjectKind: 'role' as const, subjectId, resource, field, effect: 'deny' as const, active: true,
    }]
    // companies.fiscalStartMonth: 自社の会計年度が載らない（ブロック自体は残る）
    const noFiscal = await buildContext(pool, adminUser, '自社について教えて',
      deny('pm-aux1', 'admin', 'companies', 'fiscalStartMonth'))
    expect(noFiscal).toContain('自社「ツナグバ本社」')
    expect(noFiscal).not.toContain('会計年度')
    // companies.primaryIndustryId: （主）マークが消える（業界名自体は載る）
    const noPrimary = await buildContext(pool, adminUser, 'CTX商事の業界は？',
      deny('pm-aux2', 'admin', 'companies', 'primaryIndustryId'))
    expect(noPrimary).toContain('業界: アパレル')
    expect(noPrimary).not.toContain('アパレル（主）')
    // industries.name: 会社ブロックの業界行・業界逆引きブロックごと消える（description 等は残る）
    const noInd = await buildContext(pool, adminUser, 'CTX商事の業界別の状況を教えて',
      deny('pm-aux3', 'admin', 'industries', 'name'))
    expect(noInd).toContain('顧客「CTX商事」')
    expect(noInd).not.toContain('業界: アパレル')
    expect(noInd).not.toContain('業界別の顧客')
    // relation-types.label: 関係ラベルが消える（相手名は残る）
    const noLabel = await buildContext(pool, adminUser, 'CTX商事との関係を教えて',
      deny('pm-aux4', 'admin', 'relation-types', 'label'))
    expect(noLabel).toContain('会社間の関係:')
    expect(noLabel).toContain('ツナグバ本社')
    expect(noLabel).not.toContain('販売代理店')
    // company-relations.notes: 関係メモが消える（ラベルは残る）
    const noNotes = await buildContext(pool, adminUser, 'CTX商事との関係を教えて',
      deny('pm-aux5', 'admin', 'company-relations', 'notes'))
    expect(noNotes).toContain('ツナグバ本社: 販売代理店')
    expect(noNotes).not.toContain('主要取引')
    // leave-types.name: 種別を特定できないため休暇種別ブロックごと消える（本人の有給は残る）
    const noLeave = await buildContext(pool, memberUser, 'どんな休暇の種類がありますか？',
      deny('pm-aux6', 'member', 'leave-types', 'name'))
    expect(noLeave).not.toContain('## 休暇種別')
    // external-links.url: タイトルのみ表示に縮退する
    const noUrl = await buildContext(pool, memberUser, '勤怠システムのリンクを教えて',
      deny('pm-aux7', 'member', 'external-links', 'url'))
    expect(noUrl).toContain('- 勤怠システム')
    expect(noUrl).not.toContain('https://example.com/kintai')
    // departments.name: 部署ブロックごと消え、メンバーブロックの部署も未所属になる
    const noDept = await buildContext(pool, adminUser, '文脈開発部の一般 次郎さんについて教えて',
      deny('pm-aux8', 'admin', 'departments', 'name'))
    expect(noDept).not.toContain('部署・組織')
    expect(noDept).toContain('部署 未所属')
    // projects.name: 会社ブロックの関連プロジェクト名が消え「なし」へ縮退（一覧ブロックと同一パターン）
    const noPj = await buildContext(pool, adminUser, 'CTX商事について教えて',
      deny('pm-aux9', 'admin', 'projects', 'name'))
    expect(noPj).toContain('顧客「CTX商事」')
    expect(noPj).not.toContain('文脈PJ')
    expect(noPj).toContain('プロジェクト: なし')
    // decision-themes.category deny: 種別括弧が既定値（PJ）で捏造表示されず省略される
    const noCat = await buildContext(pool, memberUser, '意思決定のテーマを教えて',
      deny('pm-aux10', 'member', 'decision-themes', 'category'))
    expect(noCat).toContain('意思決定支援')
    expect(noCat).not.toContain('(PJ)')
    expect(noCat).not.toContain('(事業)')
  })
})

describe('AI カンパニー（F-08）', () => {
  let roleId = ''
  let empId = ''
  let taskId = ''

  it('ロール・AI 社員は汎用マスタ（管理者のみ変更）。初期データはマイグレーションが投入する', async () => {
    // 0015 マイグレーションがシード投入した AI 社員（アキ = ai-01）が存在する
    const seeded = (await api('GET', '/v1/masters/ai-employees', { as: MEMBER })).json.data as { id: string; name: string }[]
    expect(seeded.some(e => e.id === 'ai-01' && e.name === 'アキ')).toBe(true)

    const role = await api('POST', '/v1/masters/ai-roles', {
      as: ADMIN, body: { name: 'テスト班', mission: '調査と要約', modelTier: 'standard' },
    })
    expect(role.status).toBe(201)
    roleId = (role.json.data as { id: string }).id
    const emp = await api('POST', '/v1/masters/ai-employees', { as: ADMIN, body: { name: 'テスト社員', roleId } })
    expect(emp.status).toBe(201)
    empId = (emp.json.data as { id: string }).id
    expect((await api('POST', '/v1/masters/ai-roles', { as: MEMBER, body: { name: 'x' } })).status).toBe(403)

    // status は派生値: マスタ PATCH では変更できない（送っても無視され idle のまま。他フィールドは更新される）
    const patched = await api('PATCH', `/v1/masters/ai-employees/${empId}`, { as: ADMIN, body: { name: 'テスト社員2', status: 'working' } })
    expect(patched.status).toBe(200)
    expect((patched.json.data as { name: string; status: string }).name).toBe('テスト社員2')
    expect((patched.json.data as { status: string }).status).toBe('idle')
  })

  it('タスク依頼 → 分解 → 承認 → 進行 → 完了（状態機械・活動ログ・依頼者へ通知・status 同期）', async () => {
    const req = await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER,
      body: { aiEmployeeId: empId, title: '市場動向の調査', description: '競合 3 社の動向を比較し、来期の重点領域の示唆をまとめてください' },
    })
    expect(req.status).toBe(201)
    taskId = (req.json.data as { id: string }).id
    // 存在しない AI 社員は 404・件名なしは 400
    expect((await api('POST', '/v1/ai-company/tasks', { as: MEMBER, body: { aiEmployeeId: 'ai-x', title: 'x' } })).status).toBe(404)
    expect((await api('POST', '/v1/ai-company/tasks', { as: MEMBER, body: { aiEmployeeId: empId, title: ' ' } })).status).toBe(400)

    // 提案中は進行不可（AKO-AIC-005）。AI 社員は承認待ち状態へ同期される
    expect((await api('POST', `/v1/ai-company/tasks/${taskId}/progress`, { as: MEMBER })).status).toBe(409)
    const emps = (await api('GET', '/v1/masters/ai-employees', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(emps.find(e => e.id === empId)?.status).toBe('waiting_approval')

    // 承認 → 全自動実行（バッチ7i: 「進める」の連打なしで done まで走り切る）+ 依頼者へ通知
    expect((await api('POST', `/v1/ai-company/tasks/${taskId}/approve`, { as: MEMBER })).status).toBe(200)
    const doneTask = await waitAiTask(taskId, t => t.status === 'done')
    expect(doneTask.decomposition.every(s => s.done)).toBe(true)
    // 十分な依頼内容（内部情報の参照なし）には質問しない（バッチ7i: 質問は必要時のみ）
    expect(doneTask.questions.length).toBe(0)
    // 完了後の再進行は 409
    expect((await api('POST', `/v1/ai-company/tasks/${taskId}/progress`, { as: MEMBER })).status).toBe(409)

    const logs = (await api('GET', '/v1/ai-company/logs', { as: MEMBER })).json.data as { kind: string; taskId: string | null }[]
    const kinds = new Set(logs.filter(l => l.taskId === taskId).map(l => l.kind))
    expect(kinds.has('plan') && kinds.has('execute') && kinds.has('report')).toBe(true)
    // 完了報告通知は fire-and-forget（トランザクション確定後に発行 = 原則4）のため、着信を待ってから検証する
    await waitNotification(MEMBER, n => n.kind === 'ai_report' && n.title.includes('市場動向の調査'))
    expect(emps.length).toBeGreaterThan(0)
  })

  it('低確信度の依頼はエスカレーション対象（confidence=low）。ブロック/中止の状態機械', async () => {
    const low = await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER, body: { aiEmployeeId: empId, title: '調査して', description: 'どう?' },
    })
    expect((low.json.data as { confidence: string }).confidence).toBe('low')
    const lowId = (low.json.data as { id: string }).id
    // proposed からのブロックは不可 → 承認後にブロック ↔ 再開 → 中止。中止済みの再中止は 409
    expect((await api('POST', `/v1/ai-company/tasks/${lowId}/block`, { as: MEMBER })).status).toBe(409)
    expect((await api('POST', `/v1/ai-company/tasks/${lowId}/approve`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', `/v1/ai-company/tasks/${lowId}/block`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', `/v1/ai-company/tasks/${lowId}/cancel`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', `/v1/ai-company/tasks/${lowId}/cancel`, { as: MEMBER })).status).toBe(409)
  })

  it('日次報告の生成は並行実行でも冪等（部分一意 + ON CONFLICT）で、全員の日報（scope=all）に AI 日報が載る', async () => {
    const today = todayJst()
    // 並行 2 連発でも同一 AI 社員 × 同一日の報告は 1 件のみ（重複作成なし = DB 保証）
    const [a, b] = await Promise.all([
      api('POST', '/v1/ai-company/daily-reports', { as: ADMIN, body: { date: today } }),
      api('POST', '/v1/ai-company/daily-reports', { as: ADMIN, body: { date: today } }),
    ])
    const createdTotal = (a.json.data as { created: number }).created + (b.json.data as { created: number }).created
    expect(createdTotal).toBeGreaterThanOrEqual(1)
    const all = (await api('GET', `/v1/reports/daily?scope=all&month=${today.slice(0, 7)}`, { as: MEMBER })).json.data as
      { authorKind: string; aiEmployeeId: string | null; entries: { theme?: string }[] }[]
    const aiReports = all.filter(r => r.authorKind === 'ai' && r.aiEmployeeId === empId)
    expect(aiReports.length).toBe(1) // 並行でも重複しない
    expect(aiReports[0]!.entries[0]!.theme).toBe('AI カンパニー')
    // 逐次の再生成もスキップ（冪等）
    const again = await api('POST', '/v1/ai-company/daily-reports', { as: ADMIN, body: { date: today } })
    expect((again.json.data as { created: number }).created).toBe(0)
    expect((again.json.data as { skipped: number }).skipped).toBeGreaterThanOrEqual(1)
  })

  it('ai-company の機能 deny で 403（F-16 準拠）', async () => {
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'ai-company', effect: 'deny' },
    })
    expect(rule.status).toBe(201)
    const denied = await api('GET', '/v1/ai-company/tasks', { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', '/v1/ai-company/tasks', { as: ADMIN })).status).toBe(200)
    const id = (rule.json.data as { id: string }).id
    expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
  })
})

describe('カレンダー連携', () => {
  const today = todayJst()
  let taskId = ''

  it('OAuth 設定なしでは enabled=false・同期は AKO-CAL-007。コールバックはエラーリダイレクト', async () => {
    const st = (await api('GET', '/v1/calendar/status', { as: MEMBER })).json.data as
      { enabled: boolean; connected: boolean }
    expect(st.enabled).toBe(false)
    expect(st.connected).toBe(false)
    expect((await api('POST', '/v1/calendar/sync', { as: MEMBER, body: { date: today } })).json.error?.code)
      .toBe('AKO-CAL-007')
    // コールバックは認証なしで到達し、設定なしはフロントへエラーリダイレクト（500 にしない）
    const cb = await app.request('/v1/calendar/oauth/callback?state=x&code=y')
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toContain('calendar=error')
  })

  it('アプリ発タスク: 入力検証（AKO-CAL-002/003）→ 作成（未連携 push は warning）→ 本人のみ参照 → 削除', async () => {
    expect((await api('POST', '/v1/calendar/events', {
      as: MEMBER, body: { date: today, from: '10:00', to: '11:00', title: '' },
    })).json.error?.code).toBe('AKO-CAL-002')
    expect((await api('POST', '/v1/calendar/events', {
      as: MEMBER, body: { date: today, from: '11:00', to: '10:00', title: 'x' },
    })).json.error?.code).toBe('AKO-CAL-003')

    const created = await api('POST', '/v1/calendar/events', {
      as: MEMBER, body: { date: today, from: '14:00', to: '15:00', title: '請求書レビュー', pushToGoogle: true },
    })
    expect(created.status).toBe(201)
    const data = created.json.data as { id: string; warning?: string }
    taskId = data.id
    expect(data.warning).toContain('未連携')

    const mine = (await api('GET', `/v1/calendar/events?date=${today}`, { as: MEMBER })).json.data as
      { id: string; source: string }[]
    expect(mine.some(e => e.id === taskId)).toBe(true)
    const others = (await api('GET', `/v1/calendar/events?date=${today}`, { as: HR })).json.data as unknown[]
    expect(others.length).toBe(0)
  })

  it('同期 upsert は Google 反映済みの app 発予定を上書きしない（SoT 分離の回帰・3e レビュー指摘）', async () => {
    await pool.query(
      `INSERT INTO calendar_events (id, member_id, date, from_time, to_time, title, source, google_event_id, synced_to_google)
       VALUES ('cal-app-sot', $1, $2, '10:00', '11:00', 'アプリのタスク', 'app', 'gev-app-sot', true)`,
      [MEMBER, today])
    // /sync と同一の upsert（Google 側で編集された想定の値が衝突するケース）
    await pool.query(
      `INSERT INTO calendar_events (id, member_id, date, from_time, to_time, title, source, google_event_id, synced_to_google)
       VALUES ('cal-new-sot', $1, $2, '10:30', '12:00', 'Google側で編集された題名', 'google', 'gev-app-sot', true)
       ON CONFLICT (member_id, google_event_id) WHERE google_event_id IS NOT NULL
       DO UPDATE SET date = EXCLUDED.date, from_time = EXCLUDED.from_time,
         to_time = EXCLUDED.to_time, title = EXCLUDED.title, updated_at = now()
       WHERE calendar_events.source = 'google'`,
      [MEMBER, today])
    const { rows } = await pool.query(
      `SELECT from_time, title FROM calendar_events WHERE id = 'cal-app-sot'`)
    expect(rows[0]?.from_time).toBe('10:00')
    expect(rows[0]?.title).toBe('アプリのタスク')
  })

  it('google 発の予定は削除不可（AKO-CAL-006 = SoT 分離）。app 発は削除可', async () => {
    await pool.query(
      `INSERT INTO calendar_events (id, member_id, date, from_time, to_time, title, source, google_event_id, synced_to_google)
       VALUES ('cal-test-google', $1, $2, '09:00', '10:00', '定例', 'google', 'gev-1', true)`,
      [MEMBER, today])
    expect((await api('POST', '/v1/calendar/events/cal-test-google/remove', { as: MEMBER })).json.error?.code)
      .toBe('AKO-CAL-006')
    expect((await api('POST', `/v1/calendar/events/${taskId}/remove`, { as: MEMBER })).status).toBe(200)
    // ドラフト生成の材料にカレンダー予定（google 発）が使われる
    const d = (await api('POST', '/v1/assist/report-draft', { as: MEMBER, body: { date: today } })).json.data as
      { entries: { task: string }[]; basis: string[] }
    expect(d.entries.some(e => e.task.includes('定例'))).toBe(true)
    expect(d.basis.some(b => b.includes('カレンダー予定'))).toBe(true)
  })
})

describe('権限制御（F-16）', () => {
  let denyId = ''
  let allowId = ''
  let fieldId = ''

  it('ロール deny で機能 API が 403（AKO-PRM-001）。他ロールには影響しない', async () => {
    const r = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'decision', effect: 'deny' },
    })
    expect(r.status).toBe(201)
    denyId = (r.json.data as { id: string }).id
    const denied = await api('GET', '/v1/decisions/logs', { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', '/v1/decisions/logs', { as: ADMIN })).status).toBe(200)
    // ガード対象外のデータ面（マスタ・設定・通知）は deny 中も利用できる
    expect((await api('GET', '/v1/masters/members', { as: MEMBER })).status).toBe(200)
    expect((await api('GET', '/v1/notifications', { as: MEMBER })).status).toBe(200)
  })

  it('個人の allow がロールの deny を上書きする（レイヤ優先: 個人 > 役職 > ロール）', async () => {
    const r = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'member', subjectId: MEMBER, resource: 'decision', effect: 'allow' },
    })
    expect(r.status).toBe(201)
    allowId = (r.json.data as { id: string }).id
    expect((await api('GET', '/v1/decisions/logs', { as: MEMBER })).status).toBe(200)
  })

  it('表示項目 deny でマスタ応答からフィールドが剥がれる（対象レイヤのみ）。無効化で復帰する', async () => {
    const r = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'members', field: 'email', effect: 'deny' },
    })
    expect(r.status).toBe(201)
    fieldId = (r.json.data as { id: string }).id
    const mine = (await api('GET', '/v1/masters/members', { as: MEMBER })).json.data as { email?: string }[]
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(m => m.email === undefined)).toBe(true)
    const admin = (await api('GET', '/v1/masters/members', { as: ADMIN })).json.data as { email?: string }[]
    expect(admin.some(m => typeof m.email === 'string')).toBe(true)

    // 後続テストへ影響しないよう全ルールを無効化（キャッシュは変更 API が即時クリア）
    for (const id of [denyId, allowId, fieldId]) {
      expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
    }
    expect((await api('GET', '/v1/decisions/logs', { as: MEMBER })).status).toBe(200)
    const restored = (await api('GET', '/v1/masters/members', { as: MEMBER })).json.data as { email?: string }[]
    expect(restored.some(m => typeof m.email === 'string')).toBe(true)
  })

  it('subjectKind と subjectId のペア整合を検証する（不整合ルールの登録を防ぐ）', async () => {
    // ロール層の対象は admin / hr / member のみ
    const badRole = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'ceo', resource: 'decision', effect: 'deny' },
    })
    expect(badRole.status).toBe(400)
    // PATCH で subjectKind だけを変えるとペアが崩れるため拒否（subjectId と同時指定が必要）
    const created = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'decision', effect: 'allow' },
    })
    expect(created.status).toBe(201)
    const id = (created.json.data as { id: string }).id
    const badPatch = await api('PATCH', `/v1/masters/permission-rules/${id}`, {
      as: ADMIN, body: { subjectKind: 'title' },
    })
    expect(badPatch.status).toBe(400)
    const goodPatch = await api('PATCH', `/v1/masters/permission-rules/${id}`, {
      as: ADMIN, body: { subjectKind: 'member', subjectId: MEMBER },
    })
    expect(goodPatch.status).toBe(200)
    // 部分更新の回帰: 更新した subject ペアが反映され、送っていない resource / effect が保持されること
    const patched = goodPatch.json.data as { subjectKind: string; subjectId: string; resource: string; effect: string }
    expect(patched.subjectKind).toBe('member')
    expect(patched.subjectId).toBe(MEMBER)
    expect(patched.resource).toBe('decision')
    expect(patched.effect).toBe('allow')
    expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
  })
})

describe('売上管理（F-15）+ mart ETL（バッチ6b）', () => {
  let selfId = ''
  let customerId = ''

  beforeAll(async () => {
    // 自社（10 月始まり = 会計年度の非正規化検証用）と顧客を用意
    const self = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { kind: 'self', name: '自社（売上テスト）', fiscalStartMonth: 10 },
    })
    selfId = (self.json.data as { id: string }).id
    const customer = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { kind: 'customer', name: '売上テスト顧客' },
    })
    customerId = (customer.json.data as { id: string }).id
  })

  it('管理者が月次実績を一括登録でき、同一キー（month × company × type）の再登録は上書き（冪等）', async () => {
    const r = await api('POST', '/v1/sales', {
      as: ADMIN,
      body: {
        rows: [
          { month: '2026-06', companyId: customerId, projectType: 'development', amount: 1200000, cost: 700000 },
          { month: '2026-07', companyId: customerId, projectType: 'operation', amount: 800000, cost: 300000 },
        ],
      },
    })
    expect(r.status).toBe(201)
    expect((r.json.data as { upserted: number }).upserted).toBe(2)

    // 同一キーの再登録 → 行は増えず金額が更新される
    const again = await api('POST', '/v1/sales', {
      as: ADMIN,
      body: { rows: [{ month: '2026-06', companyId: customerId, projectType: 'development', amount: 1500000, cost: 900000 }] },
    })
    expect(again.status).toBe(201)
    const list = (await api('GET', '/v1/sales', { as: MEMBER })).json.data as {
      month: string; companyId: string; projectType: string; amount: number; cost: number
    }[]
    const mine = list.filter(x => x.companyId === customerId)
    expect(mine).toHaveLength(2)
    const jun = mine.find(x => x.month === '2026-06')
    expect(jun?.amount).toBe(1500000)
    expect(jun?.cost).toBe(900000)
  })

  it('登録は管理者のみ（AKO-AUTH-003）。入力不正・未登録顧客は 400', async () => {
    const denied = await api('POST', '/v1/sales', {
      as: MEMBER,
      body: { rows: [{ month: '2026-06', companyId: customerId, projectType: 'development', amount: 1, cost: 0 }] },
    })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-AUTH-003')

    expect((await api('POST', '/v1/sales', { as: ADMIN, body: { rows: [] } })).json.error?.code).toBe('AKO-SAL-003')
    expect((await api('POST', '/v1/sales', {
      as: ADMIN, body: { rows: [{ month: '2026-13', companyId: customerId, projectType: 'development', amount: 1, cost: 0 }] },
    })).json.error?.code).toBe('AKO-SAL-001')
    expect((await api('POST', '/v1/sales', {
      as: ADMIN, body: { rows: [{ month: '2026-06', companyId: customerId, projectType: 'unknown', amount: 1, cost: 0 }] },
    })).json.error?.code).toBe('AKO-SAL-001')
    expect((await api('POST', '/v1/sales', {
      as: ADMIN, body: { rows: [{ month: '2026-06', companyId: customerId, projectType: 'development', amount: -1, cost: 0 }] },
    })).json.error?.code).toBe('AKO-SAL-001')
    expect((await api('POST', '/v1/sales', {
      as: ADMIN, body: { rows: [{ month: '2026-06', companyId: 'c-unknown', projectType: 'development', amount: 1, cost: 0 }] },
    })).json.error?.code).toBe('AKO-SAL-002')
  })

  it('mart ETL は冪等（2 回実行しても fact 行は増えない）。margin・会計期が非正規化される', async () => {
    const run1 = await api('POST', '/v1/sales/etl/run', { as: ADMIN })
    expect(run1.status).toBe(200)
    const first = run1.json.data as { runId: string; loaded: number }
    expect(first.loaded).toBeGreaterThanOrEqual(2)

    const run2 = await api('POST', '/v1/sales/etl/run', { as: ADMIN })
    const second = run2.json.data as { runId: string; loaded: number }
    expect(second.runId).not.toBe(first.runId)

    const { rows: facts } = await pool.query<{
      sourceTxnId: string; dimDateKey: number; margin: string; fiscalYear: number
      fiscalQuarter: number; fiscalMonth: number; loadRunId: string
    }>(`SELECT source_txn_id AS "sourceTxnId", dim_date_key AS "dimDateKey", margin::text AS margin,
          fiscal_year AS "fiscalYear", fiscal_quarter AS "fiscalQuarter", fiscal_month AS "fiscalMonth",
          load_run_id AS "loadRunId"
        FROM fact_sales WHERE customer_company_id = $1 ORDER BY dim_date_key`, [customerId])
    // 冪等: 同一 source_txn_id は 1 行のまま・load_run_id は最新実行へ更新
    expect(facts).toHaveLength(2)
    expect(facts.every(f => f.loadRunId === second.runId)).toBe(true)
    // margin = amount - cost / dim_date_key = 月初日 / 会計期は自社 10 月始まりで非正規化
    const jun = facts.find(f => f.dimDateKey === 20260601)
    expect(jun?.margin).toBe('600000') // 1,500,000 - 900,000
    expect(jun?.fiscalYear).toBe(2025) // 10 月始まり: 2026-06 は 2025 年度
    expect(jun?.fiscalMonth).toBe(9)   // 10 月起点で 6 月は 9 ヶ月目
    expect(jun?.fiscalQuarter).toBe(3)

    // 実行履歴（監査列の発行元）が記録される
    const runs = (await api('GET', '/v1/sales/etl/runs', { as: ADMIN })).json.data as {
      id: string; status: string; rowsLoaded: number
    }[]
    expect(runs.some(r => r.id === second.runId && r.status === 'done' && r.rowsLoaded >= 2)).toBe(true)
    // ETL の実行・履歴は管理者のみ
    expect((await api('POST', '/v1/sales/etl/run', { as: MEMBER })).status).toBe(403)
    expect((await api('GET', '/v1/sales/etl/runs', { as: MEMBER })).status).toBe(403)
  })

  it('機能ガード: sales の deny で /v1/sales が 403（AKO-PRM-001）。解除で復帰', async () => {
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'sales', effect: 'deny' },
    })
    expect(rule.status).toBe(201)
    const id = (rule.json.data as { id: string }).id
    const denied = await api('GET', '/v1/sales', { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', '/v1/sales', { as: ADMIN })).status).toBe(200)
    expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', '/v1/sales', { as: MEMBER })).status).toBe(200)
  })

  it('取込件数の上限超過（501 件）は AKO-SAL-003', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      month: '2026-01', companyId: customerId, projectType: 'development', amount: i, cost: 0,
    }))
    const r = await api('POST', '/v1/sales', { as: ADMIN, body: { rows } })
    expect(r.status).toBe(400)
    expect(r.json.error?.code).toBe('AKO-SAL-003')
    // 金額の上限超過（bigint オーバーフロー防止の番兵）も AKO-SAL-001 で返る
    const tooBig = await api('POST', '/v1/sales', {
      as: ADMIN,
      body: { rows: [{ month: '2026-01', companyId: customerId, projectType: 'development', amount: 1e16, cost: 0 }] },
    })
    expect(tooBig.status).toBe(400)
    expect(tooBig.json.error?.code).toBe('AKO-SAL-001')
  })

  it('/jobs/sales-mart-etl は CRON_SECRET で保護され、実行すると ETL が走る（周期有給付与と同型）', async () => {
    // CRON_SECRET 未設定 = 無効（401）
    const disabled = await app.request('/jobs/sales-mart-etl', { method: 'POST' })
    expect(disabled.status).toBe(401)
    process.env.CRON_SECRET = 'test-cron-key'
    try {
      const wrongKey = await app.request('/jobs/sales-mart-etl', {
        method: 'POST', headers: { 'x-cron-key': 'wrong' },
      })
      expect(wrongKey.status).toBe(401)
      const ok = await app.request('/jobs/sales-mart-etl', {
        method: 'POST', headers: { 'x-cron-key': 'test-cron-key' },
      })
      expect(ok.status).toBe(200)
      const body = await ok.json() as { data: { runId: string; loaded: number } }
      expect(body.data.loaded).toBeGreaterThanOrEqual(2)
    } finally {
      delete process.env.CRON_SECRET
    }
  })

  it('チャットボット文脈に売上サマリが載る（can(sales) 準拠。バッチ6b: buildContext 直接検証）', async () => {
    const { buildContext } = await import('../../src/routes/chatbot')
    const { selfFiscalStartMonth } = await import('../../src/routes/sales')
    const { fiscalMonthsOf, fiscalYearOf } = await import('../../../shared/domain/fiscal')
    const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
    const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }

    // buildContext は実時計（todayJst）で当月を決めるため、期待値は実データから相対導出する
    // （固定月の期待値は実行日でずれる時限性がある）。当月の実績を登録して文脈生成を保証する
    const currentMonth = todayJst().slice(0, 7)
    const reg = await api('POST', '/v1/sales', {
      as: ADMIN,
      body: { rows: [{ month: currentMonth, companyId: customerId, projectType: 'internal', amount: 400000, cost: 100000 }] },
    })
    expect(reg.status).toBe(201)
    const fsm = await selfFiscalStartMonth(pool)
    const fyMonths = new Set(fiscalMonthsOf(fiscalYearOf(currentMonth, fsm), fsm).filter(m => m <= currentMonth))
    const all = (await api('GET', '/v1/sales', { as: ADMIN })).json.data as { month: string; amount: number }[]
    const manYen = (n: number): string => `${Math.round(n / 10000).toLocaleString('ja-JP')}万円`
    const fyAmount = all.filter(r => fyMonths.has(r.month)).reduce((s, r) => s + r.amount, 0)
    const curAmount = all.filter(r => r.month === currentMonth).reduce((s, r) => s + r.amount, 0)

    // ルール未設定 = allow: 年度累計と当月の集計値が文脈に含まれる
    const ctx = await buildContext(pool, adminUser, '今月の売上はどう？', [])
    expect(ctx).toContain('売上サマリ')
    expect(ctx).toContain(`年度累計売上 ${manYen(fyAmount)}`)
    expect(ctx).toContain(`当月（${currentMonth}）売上 ${manYen(curAmount)}`)

    // sales deny の member ロールには売上文脈が生成されない
    const denySales = [{
      id: 'pm-sal', subjectKind: 'role' as const, subjectId: 'member', resource: 'sales', field: null,
      effect: 'deny' as const, active: true,
    }]
    expect(await buildContext(pool, memberUser, '今月の売上はどう？', denySales)).not.toContain('売上サマリ')
    // 同じルールでも admin（別ロール）には影響しない
    expect(await buildContext(pool, adminUser, '今月の売上はどう？', denySales)).toContain('売上サマリ')
  })

  it('自社の会計年度設定を後片付けしても ETL は既定 4 月始まりで動く（フォールバック）', async () => {
    // 自社を無効化 → fiscalStartMonth 参照は既定 4 月へフォールバック
    expect((await api('POST', `/v1/masters/companies/${selfId}/archive`, { as: ADMIN })).status).toBe(200)
    const run = await api('POST', '/v1/sales/etl/run', { as: ADMIN })
    expect(run.status).toBe(200)
    const { rows } = await pool.query<{ fiscalYear: number }>(
      `SELECT fiscal_year AS "fiscalYear" FROM fact_sales WHERE customer_company_id = $1 AND dim_date_key = 20260601`,
      [customerId])
    expect(rows[0]?.fiscalYear).toBe(2026) // 4 月始まり: 2026-06 は 2026 年度
  })
})

describe('提供システム稼働状況（F-11・バッチ6c）', () => {
  let incidentId = ''

  it('GET /v1/status: シード 3 サービス + 90 日分の uptime（記録なしは operational 埋め）を返す', async () => {
    const r = await api('GET', '/v1/status', { as: MEMBER })
    expect(r.status).toBe(200)
    const data = r.json.data as {
      services: { id: string; components: { id: string }[] }[]
      incidents: unknown[]
      uptime: { serviceId: string; date: string; downMinutes: number; worstState: string }[]
    }
    expect(data.services.map(s => s.id)).toEqual(['svc-01', 'svc-02', 'svc-03'])
    expect(data.services[0]!.components.length).toBeGreaterThan(0)
    // 全サービス × 90 日の密な配列（インシデントなし = 全日 operational）
    expect(data.uptime).toHaveLength(3 * 90)
    expect(data.uptime.every(u => u.worstState === 'operational' && u.downMinutes === 0)).toBe(true)
  })

  it('インシデント登録は管理者のみ。サービス不在 404 / タイトル未入力 400', async () => {
    const denied = await api('POST', '/v1/status/incidents', {
      as: MEMBER, body: { serviceId: 'svc-01', title: 'x', impact: 'minor' },
    })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-AUTH-003')
    expect((await api('POST', '/v1/status/incidents', {
      as: ADMIN, body: { serviceId: 'svc-99', title: 'x', impact: 'minor' },
    })).json.error?.code).toBe('AKO-STS-001')
    expect((await api('POST', '/v1/status/incidents', {
      as: ADMIN, body: { serviceId: 'svc-01', title: '  ', impact: 'minor' },
    })).json.error?.code).toBe('AKO-STS-002')
    expect((await api('POST', '/v1/status/incidents', {
      as: ADMIN, body: { serviceId: 'svc-01', title: 'x', impact: 'huge' },
    })).json.error?.code).toBe('AKO-STS-006')

    const created = await api('POST', '/v1/status/incidents', {
      as: ADMIN,
      body: { serviceId: 'svc-01', title: 'API 応答遅延', impact: 'major', body: '応答時間の悪化を検知。' },
    })
    expect(created.status).toBe(201)
    incidentId = (created.json.data as { id: string }).id
    const status = (await api('GET', '/v1/status', { as: MEMBER })).json.data as {
      incidents: { id: string; status: string; updates: { status: string; body: string }[]; resolvedAt: string | null }[]
      uptime: { serviceId: string; date: string; worstState: string }[]
    }
    const inc = status.incidents.find(i => i.id === incidentId)
    expect(inc?.status).toBe('investigating')
    expect(inc?.updates).toHaveLength(1)
    expect(inc?.updates[0]?.body).toBe('応答時間の悪化を検知。')
    // 発生と同時に当日の uptime へ反映（開始直後のため停止分は 0 でも状態は写像される）。
    // 深夜 0 時跨ぎ実行でも壊れないよう「昨日または今日」のどちらかで判定する（6c レビュー指摘対応）
    const recentDays = [addDays(todayJst(), -1), todayJst()]
    expect(status.uptime.some(u =>
      u.serviceId === 'svc-01' && recentDays.includes(u.date) && u.worstState === 'partial_outage')).toBe(true)
    // 管理者へ通知される（非ブロッキングの成功経路）
    const { rows: nt } = await pool.query(
      `SELECT 1 FROM notifications WHERE title LIKE 'インシデント発生%' LIMIT 1`)
    expect(nt.length).toBe(1)
  })

  it('状況更新は正順のみ（スキップ可・逆行 409）・説明必須・resolved で resolvedAt 記録', async () => {
    // 説明未入力
    expect((await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: ADMIN, body: { status: 'identified', body: ' ' },
    })).json.error?.code).toBe('AKO-STS-005')
    // 不在 404
    expect((await api('POST', `/v1/status/incidents/inc-none/updates`, {
      as: ADMIN, body: { status: 'identified', body: 'x' },
    })).json.error?.code).toBe('AKO-STS-003')
    // 正順スキップ（investigating → monitoring）は可
    const skip = await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: ADMIN, body: { status: 'monitoring', body: '暫定対処を適用し経過観察に移行。' },
    })
    expect(skip.status).toBe(200)
    // 逆行は 409（AKO-STS-004）
    const back = await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: ADMIN, body: { status: 'identified', body: '巻き戻し' },
    })
    expect(back.status).toBe(409)
    expect(back.json.error?.code).toBe('AKO-STS-004')
    // 一般メンバーは更新不可
    expect((await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: MEMBER, body: { status: 'resolved', body: 'x' },
    })).status).toBe(403)
    // 解決
    const resolve = await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: ADMIN, body: { status: 'resolved', body: '応答時間の回復を確認しました。' },
    })
    expect(resolve.status).toBe(200)
    const status = (await api('GET', '/v1/status', { as: MEMBER })).json.data as {
      incidents: { id: string; status: string; updates: unknown[]; resolvedAt: string | null }[]
    }
    const inc = status.incidents.find(i => i.id === incidentId)
    expect(inc?.status).toBe('resolved')
    expect(inc?.resolvedAt).toBeTruthy()
    expect(inc?.updates).toHaveLength(3) // 初報 + monitoring + resolved（追記のみ）
    // 解決済みへの再操作は 409
    expect((await api('POST', `/v1/status/incidents/${incidentId}/updates`, {
      as: ADMIN, body: { status: 'resolved', body: 'x' },
    })).status).toBe(409)
  })

  it('uptime 集計: 過去のインシデントから日次 downMinutes を導出。再計算は冪等（管理者 + 日次ジョブ）', async () => {
    // 一昨日 10:00〜12:30 の解決済みインシデント（150 分・major）を SoT へ直接投入して再計算
    const day = addDays(todayJst(), -2)
    await pool.query(
      `INSERT INTO service_incidents (id, service_id, title, impact, status, updates, started_at, resolved_at)
       VALUES ('inc-hist-1', 'svc-02', '分析画面の停止', 'major', 'resolved', '[]',
               '${day}T10:00:00+09:00', '${day}T12:30:00+09:00')`)
    const run1 = await api('POST', '/v1/status/uptime/recompute', { as: ADMIN, body: {} })
    expect(run1.status).toBe(200)
    const readRow = async (): Promise<{ downMinutes: number; worstState: string } | undefined> => {
      const status = (await api('GET', '/v1/status', { as: MEMBER })).json.data as {
        uptime: { serviceId: string; date: string; downMinutes: number; worstState: string }[]
      }
      return status.uptime.find(u => u.serviceId === 'svc-02' && u.date === day)
    }
    expect(await readRow()).toMatchObject({ downMinutes: 150, worstState: 'partial_outage' })
    // 再実行しても値・行数が変わらない（冪等 = DELETE→INSERT の窓再計算）
    expect((await api('POST', '/v1/status/uptime/recompute', { as: ADMIN, body: {} })).status).toBe(200)
    expect(await readRow()).toMatchObject({ downMinutes: 150, worstState: 'partial_outage' })
    const { rows: cnt } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM uptime_daily WHERE service_id = 'svc-02' AND date = $1::date`, [day])
    expect(cnt[0]?.n).toBe('1')
    // 再計算は管理者のみ
    expect((await api('POST', '/v1/status/uptime/recompute', { as: MEMBER, body: {} })).status).toBe(403)

    // 日次ジョブ（CRON_SECRET 保護。周期有給付与・sales ETL と同型）
    expect((await app.request('/jobs/uptime-rollup', { method: 'POST' })).status).toBe(401)
    process.env.CRON_SECRET = 'test-cron-key'
    try {
      const job = await app.request('/jobs/uptime-rollup', {
        method: 'POST', headers: { 'x-cron-key': 'test-cron-key' },
      })
      expect(job.status).toBe(200)
    } finally {
      delete process.env.CRON_SECRET
    }
  })

  it('機能ガード: status の deny で /v1/status が 403（AKO-PRM-001）。チャットボット文脈も消える', async () => {
    const { buildContext } = await import('../../src/routes/chatbot')
    const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
    const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }

    // ルール未設定 = allow: 稼働状況ブロックが生成され、解決済みでないインシデントが載る
    await api('POST', '/v1/status/incidents', {
      as: ADMIN, body: { serviceId: 'svc-03', title: 'AI 生成の失敗率上昇', impact: 'minor' },
    })
    const ctx = await buildContext(pool, adminUser, 'システムの稼働状況は？', [])
    expect(ctx).toContain('提供システムの稼働状況')
    expect(ctx).toContain('AI 生成の失敗率上昇')
    expect(ctx).toContain('AKEBONO SCM: 正常稼働') // svc-01 は解決済みのため正常

    const denyStatus = [{
      id: 'pm-sts', subjectKind: 'role' as const, subjectId: 'member', resource: 'status', field: null,
      effect: 'deny' as const, active: true,
    }]
    expect(await buildContext(pool, memberUser, 'システムの稼働状況は？', denyStatus)).not.toContain('提供システムの稼働状況')

    // API ガード（DB ルール経由）
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'status', effect: 'deny' },
    })
    expect(rule.status).toBe(201)
    const id = (rule.json.data as { id: string }).id
    const denied = await api('GET', '/v1/status', { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', '/v1/status', { as: ADMIN })).status).toBe(200)
    expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', '/v1/status', { as: MEMBER })).status).toBe(200)
  })
})

describe('AKEBONO 要望ボックス（F-03・バッチ6d）', () => {
  it('要望を投稿でき、全員が新しい順で参照できる（記録系 = 追記のみ）', async () => {
    const first = await api('POST', '/v1/akebono/wishes', {
      as: MEMBER, body: { body: '過去の提案書から勝ちパターンを提示してほしい' },
    })
    expect(first.status).toBe(201)
    const second = await api('POST', '/v1/akebono/wishes', {
      as: HR, body: { body: '  採用面接の候補者比較を支援してほしい  ' },
    })
    expect(second.status).toBe(201)

    // 別ロール（admin）からも全件が見える（社内 C2 = モックと同一の可視性）。
    // 同秒投稿の並びは id タイブレークで不定のため、順序は at の非増加のみを検証する
    const list = (await api('GET', '/v1/akebono/wishes', { as: ADMIN })).json.data as {
      id: string; memberId: string; body: string; at: string
    }[]
    expect(list.length).toBeGreaterThanOrEqual(2)
    const hrWish = list.find(w => w.body === '採用面接の候補者比較を支援してほしい') // trim 済みで格納
    expect(hrWish?.memberId).toBe(HR)
    expect(list.some(w => w.body === '過去の提案書から勝ちパターンを提示してほしい')).toBe(true)
    expect(list.every((w, i, a) => i === 0 || String(a[i - 1]?.at) >= w.at)).toBe(true)
  })

  it('本文未入力は AKO-AKB-001。過長は 2000 コードポイントへ切詰め', async () => {
    expect((await api('POST', '/v1/akebono/wishes', { as: MEMBER, body: { body: '   ' } }))
      .json.error?.code).toBe('AKO-AKB-001')
    expect((await api('POST', '/v1/akebono/wishes', { as: MEMBER, body: {} }))
      .json.error?.code).toBe('AKO-AKB-001')
    const long = await api('POST', '/v1/akebono/wishes', { as: MEMBER, body: { body: 'あ'.repeat(3000) } })
    expect(long.status).toBe(201)
    const id = (long.json.data as { id: string }).id
    const list = (await api('GET', '/v1/akebono/wishes', { as: MEMBER })).json.data as { id: string; body: string }[]
    expect([...list.find(w => w.id === id)?.body ?? '']).toHaveLength(2000)
  })

  it('機能ガード: akebono の deny で /v1/akebono が 403（AKO-PRM-001）。チャットボット文脈も消える', async () => {
    const { buildContext } = await import('../../src/routes/chatbot')
    const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
    const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }

    // ルール未設定 = allow: AKEBONO ブロックが生成され、直近の要望が載る
    const ctx = await buildContext(pool, adminUser, 'AKEBONO はいつ使える？', [])
    expect(ctx).toContain('AKEBONO（/akebono）')
    expect(ctx).toContain('採用面接の候補者比較')
    // 顧客「アケボノ商事」・サービス「AKEBONO SCM」への言及ではプロダクトブロックを出さない
    // （顧客/稼働状況ブロックとの文脈ノイズ防止 = 6d レビュー指摘対応）
    expect(await buildContext(pool, adminUser, 'アケボノ商事について教えて', []))
      .not.toContain('AKEBONO（/akebono）')
    expect(await buildContext(pool, adminUser, 'AKEBONO SCM は動いてる？', []))
      .not.toContain('AKEBONO（/akebono）')

    const denyAkebono = [{
      id: 'pm-akb', subjectKind: 'role' as const, subjectId: 'member', resource: 'akebono', field: null,
      effect: 'deny' as const, active: true,
    }]
    expect(await buildContext(pool, memberUser, 'AKEBONO はいつ使える？', denyAkebono)).not.toContain('AKEBONO（/akebono）')

    // API ガード（DB ルール経由）
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'akebono', effect: 'deny' },
    })
    expect(rule.status).toBe(201)
    const id = (rule.json.data as { id: string }).id
    const denied = await api('GET', '/v1/akebono/wishes', { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', '/v1/akebono/wishes', { as: ADMIN })).status).toBe(200)
    expect((await api('POST', `/v1/masters/permission-rules/${id}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', '/v1/akebono/wishes', { as: MEMBER })).status).toBe(200)
  })
})

describe('営業日・祝日基盤（オペレーター報告 2026-07-18 #4）', () => {
  it('祝日マスタ: 管理者のみ追加・削除でき、日付重複は 409。一覧は日付順で全員参照可', async () => {
    expect((await api('POST', '/v1/masters/holidays', { as: MEMBER, body: { date: '2026-12-23', name: 'x' } })).status).toBe(403)
    const created = await api('POST', '/v1/masters/holidays', { as: ADMIN, body: { date: '2026-12-23', name: '創立記念日' } })
    expect(created.status).toBe(201)
    const dupe = await api('POST', '/v1/masters/holidays', { as: ADMIN, body: { date: '2026-12-23', name: '重複' } })
    expect(dupe.status).toBe(409)
    const list = (await api('GET', '/v1/masters/holidays', { as: MEMBER })).json.data as
      { id: string; date: string; name: string; source: string }[]
    const mine = list.find(h => h.date === '2026-12-23')
    expect(mine?.name).toBe('創立記念日')
    expect(mine?.source).toBe('manual')
    // 物理削除できる（誤登録の取り消し）
    expect((await api('DELETE', `/v1/masters/holidays/${mine!.id}`, { as: ADMIN })).status).toBe(200)
    const after = (await api('GET', '/v1/masters/holidays', { as: ADMIN })).json.data as { date: string }[]
    expect(after.some(h => h.date === '2026-12-23')).toBe(false)
  })

  it('公式 CSV 取込: upsert（冪等）で管理者のみ。Shift_JIS も UTF-8 も受け付ける', async () => {
    expect((await api('POST', '/v1/holidays/import', { as: MEMBER, body: { csvText: '2026/1/1,元日' } })).status).toBe(403)
    const csv = '国民の祝日・休日月日,国民の祝日・休日名称\n2026/1/1,元日\n2026/7/20,海の日'
    const first = await api('POST', '/v1/holidays/import', { as: ADMIN, body: { csvText: csv } })
    expect(first.status).toBe(200)
    expect((first.json.data as { total: number; upserted: number })).toEqual({ total: 2, upserted: 2 })
    // 再取込は変更なし = upserted 0（冪等）。名称変更があればその行だけ更新
    const again = await api('POST', '/v1/holidays/import', { as: ADMIN, body: { csvText: csv } })
    expect((again.json.data as { upserted: number }).upserted).toBe(0)
    const renamed = await api('POST', '/v1/holidays/import', {
      as: ADMIN, body: { csvText: '2026/1/1,元日（改定）' },
    })
    expect((renamed.json.data as { upserted: number }).upserted).toBe(1)
    // Shift_JIS バイト列（csvBase64）も自動判定で取り込める（内閣府 CSV の実エンコーディング）
    const sjis = 'jZGWr4LMj2qT+oFFi3iT+oyOk/osjZGWr4LMj2qT+oFFi3iT+pa8j8wNCjIwMjYvMi8yMyyTVo1jkmGQtpP6DQo='
    const viaSjis = await api('POST', '/v1/holidays/import', { as: ADMIN, body: { csvBase64: sjis } })
    expect(viaSjis.status).toBe(200)
    const list = (await api('GET', '/v1/masters/holidays', { as: ADMIN })).json.data as { date: string; name: string; source: string }[]
    expect(list.find(h => h.date === '2026-02-23')?.name).toBe('天皇誕生日')
    expect(list.find(h => h.date === '2026-01-01')?.source).toBe('official')
    // 解析 0 件は AKO-HOL-002
    const empty = await api('POST', '/v1/holidays/import', { as: ADMIN, body: { csvText: 'ヘッダのみ' } })
    expect(empty.status).toBe(400)
    expect(empty.json.error?.code).toBe('AKO-HOL-002')
  })

  it('勤怠ルールの営業日定義（workingWeekdays / holidayAware）を保存・検証できる', async () => {
    const created = await api('POST', '/v1/masters/attendance-rules', {
      as: ADMIN,
      body: { name: '外注（週末稼働）', appliesTo: ['outsource'], workingWeekdays: [0, 3, 6], holidayAware: false },
    })
    expect(created.status).toBe(201)
    const row = created.json.data as { id: string; workingWeekdays: number[]; holidayAware: boolean }
    expect(row.workingWeekdays).toEqual([0, 3, 6])
    expect(row.holidayAware).toBe(false)
    // 既存ルール（列追加前からのデータ）は既定値で下位互換
    const std = ((await api('GET', '/v1/masters/attendance-rules', { as: ADMIN })).json.data as
      { id: string; workingWeekdays: number[]; holidayAware: boolean }[]).find(r => r.id === 'ar-standard')
    expect(std?.workingWeekdays).toEqual([1, 2, 3, 4, 5])
    expect(std?.holidayAware).toBe(true)
    // 不正な曜日・空配列は 400
    expect((await api('POST', '/v1/masters/attendance-rules', {
      as: ADMIN, body: { name: 'x', appliesTo: ['outsource'], workingWeekdays: [7] },
    })).status).toBe(400)
    expect((await api('PATCH', `/v1/masters/attendance-rules/${row.id}`, {
      as: ADMIN, body: { workingWeekdays: [] },
    })).status).toBe(400)
    await api('POST', `/v1/masters/attendance-rules/${row.id}/archive`, { as: ADMIN })
  })

  it('日報ドラフトの「明日の予定」は祝日を飛ばした翌営業日の計画を拾う（メンバー別ルール準拠）', async () => {
    // 2026-07-17（金）を基準日に、月曜 7/20 を祝日化 → 翌営業日は火曜 7/21。
    // 祝日は本テスト内で自前登録する（upsert 冪等のため他テストと順序独立。-t フィルタ実行でも成立）
    await api('POST', '/v1/holidays/import', { as: ADMIN, body: { csvText: '2026/7/20,海の日' } })
    await api('PUT', '/v1/task-plans', {
      as: MEMBER, body: { title: '祝日の計画（拾われない）', date: '2026-07-20' },
    })
    await api('PUT', '/v1/task-plans', {
      as: MEMBER, body: { title: '祝日明けの計画（拾われる）', date: '2026-07-21' },
    })
    const draft = (await api('POST', '/v1/assist/report-draft', {
      as: MEMBER, body: { date: '2026-07-17' },
    })).json.data as { tomorrow: string }
    expect(draft.tomorrow).toContain('祝日明けの計画（拾われる）')
    expect(draft.tomorrow).not.toContain('祝日の計画（拾われない）')
  })
})

describe('AI 検索最適化基盤 + ナレッジのドキュメント取込（オペレーター報告 2026-07-18 #3）', () => {
  const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']
  let srchSelfId = ''
  let indId = ''

  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
    const ind = await api('POST', '/v1/masters/industries', { as: ADMIN, body: { name: '検索小売業' } })
    indId = (ind.json.data as { id: string }).id
    const self = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { kind: 'self', name: '検索つなぐば株式会社', fiscalStartMonth: 4 },
    })
    srchSelfId = (self.json.data as { id: string }).id
    const cust = await api('POST', '/v1/masters/companies', {
      as: ADMIN,
      body: { kind: 'customer', name: '検索シマテスト株式会社', industryIds: [indId], primaryIndustryId: indId },
    })
    const rt = await api('POST', '/v1/masters/relation-types', {
      as: ADMIN, body: { label: '検索取引先', appliesTo: 'company' },
    })
    await api('POST', '/v1/masters/company-relations', {
      as: ADMIN,
      body: {
        fromCompanyId: srchSelfId, toCompanyId: (cust.json.data as { id: string }).id,
        relationTypeId: (rt.json.data as { id: string }).id,
      },
    })
    await api('POST', '/v1/masters/knowledge', {
      as: ADMIN,
      body: {
        domain: 'industry', targetId: indId, title: '検索小売業の困りごと',
        body: '検索小売業の顧客は在庫回転とシーズン切替の値引きで困る傾向がある。棚割りの最適化も課題。',
        tags: ['商習慣'],
      },
    })
  })

  afterAll(async () => {
    // 「有効な自社は 1 社」前提のテストが将来追加されても壊さないよう後片付け
    await api('POST', `/v1/masters/companies/${srchSelfId}/archive`, { as: ADMIN })
  })

  it('検索インデックスの再生成は管理者のみ・冪等（2 回目は upserted 0）', async () => {
    expect((await api('POST', '/v1/search/reindex', { as: MEMBER })).status).toBe(403)
    const first = await api('POST', '/v1/search/reindex', { as: ADMIN })
    expect(first.status).toBe(200)
    const r1 = first.json.data as { docs: number; upserted: number; deleted: number; embedded: number }
    expect(r1.docs).toBeGreaterThan(0)
    expect(r1.embedded).toBe(0) // LLM 無効環境 = 埋め込みなし（字句検索のみ）
    const again = await api('POST', '/v1/search/reindex', { as: ADMIN })
    expect((again.json.data as { upserted: number; deleted: number })).toMatchObject({ upserted: 0, deleted: 0 })
  })

  it('名寄せ照合: 法人格省略（「検索つなぐば」）・「弊社」で自社ブロックが供給される', async () => {
    const byShortName = await buildContext(pool, adminUser, '検索つなぐばの取引先は?', [])
    expect(byShortName).toContain('自社「検索つなぐば株式会社」')
    expect(byShortName).toContain('検索シマテスト株式会社: 検索取引先')
    const bySelfWord = await buildContext(pool, adminUser, '弊社の取引先を教えて', [])
    expect(bySelfWord).toContain('自社「検索つなぐば株式会社」')
    expect((await buildContext(pool, adminUser, '当社の会計年度は?', []))).toContain('会計年度: 4 月始まり')
  })

  it('会社照合は今回の質問を履歴より優先する（履歴中の別会社に負けない）', async () => {
    const ctx = await buildContext(pool, adminUser, '検索シマテスト株式会社について教えて', [],
      ['検索つなぐばの取引先は?'])
    expect(ctx).toContain('顧客「検索シマテスト株式会社」')
    expect(ctx).not.toContain('## 自社「検索つなぐば株式会社」')
    // 逆: 今回の質問に会社名がなければ履歴（新しい順）から引き継ぐ
    const followUp = await buildContext(pool, adminUser, 'そこの担当は誰?', [], ['検索シマテスト株式会社について教えて'])
    expect(followUp).toContain('顧客「検索シマテスト株式会社」')
  })

  it('検索リトリーバル: キーワードに乗らない解釈型の質問をナレッジで補足する（字句バイグラム）', async () => {
    const ctx = await buildContext(pool, memberUser, '検索小売はどんなところで困る傾向がある?', [])
    expect(ctx).toContain('関連情報（社内データ検索）')
    expect(ctx).toContain('在庫回転とシーズン切替の値引きで困る傾向')
    // 表示項目 deny: knowledge.body を deny すると本文セグメントが描画されない（タイトルは残る）
    const bodyDeny = [{
      id: 'pm-srch1', subjectKind: 'role' as const, subjectId: 'member', resource: 'knowledge', field: 'body',
      effect: 'deny' as const, active: true,
    }]
    const noBody = await buildContext(pool, memberUser, '検索小売はどんなところで困る傾向がある?', bodyDeny)
    expect(noBody).not.toContain('在庫回転とシーズン切替')
    // knowledge.title を deny するとドキュメントごと描画されない
    const titleDeny = [{
      id: 'pm-srch2', subjectKind: 'role' as const, subjectId: 'member', resource: 'knowledge', field: 'title',
      effect: 'deny' as const, active: true,
    }]
    const noTitle = await buildContext(pool, memberUser, '検索小売業の困りごとを教えて', titleDeny)
    expect(noTitle).not.toContain('検索小売業の困りごと')
  })

  it('ドキュメント取込: .md（見出し→タイトル）・原本の保存とダウンロード', async () => {
    const md = '# 検索輸入商材の商習慣\n\n検索輸入商材は船便リードタイムが長く、発注精度が利益を左右する。'
    expect((await api('POST', '/v1/knowledge/import', {
      as: MEMBER, body: { filename: 'a.md', contentBase64: b64(md), domain: 'industry', targetId: indId },
    })).status).toBe(403)
    const created = await api('POST', '/v1/knowledge/import', {
      as: ADMIN, body: { filename: 'trade.md', contentBase64: b64(md), domain: 'industry', targetId: indId, tags: ['商習慣'] },
    })
    expect(created.status).toBe(201)
    const article = created.json.data as { id: string; title: string; body: string; source: string }
    expect(article.title).toBe('検索輸入商材の商習慣')
    expect(article.body).toContain('船便リードタイム')
    expect(article.source).toBe('manual')
    // 原本メタと本体のラウンドトリップ
    const files = (await api('GET', `/v1/knowledge/${article.id}/files`, { as: MEMBER })).json.data as
      { id: string; filename: string; sizeBytes: number }[]
    expect(files).toHaveLength(1)
    expect(files[0]!.filename).toBe('trade.md')
    const dl = (await api('GET', `/v1/knowledge/files/${files[0]!.id}`, { as: MEMBER })).json.data as
      { filename: string; contentBase64: string }
    expect(Buffer.from(dl.contentBase64, 'base64').toString('utf8')).toBe(md)
    // 取込後の再インデックスで検索リトリーバルに載る（デバウンスを待たず手動再生成 = 手動回復パス）
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const ctx = await buildContext(pool, memberUser, '検索輸入商材の商習慣を教えて', [])
    expect(ctx).toContain('船便リードタイム')
  })

  it('ドキュメント取込: .txt / .pdf / .docx から抽出できる。非対応形式・抽出不能はエラー', async () => {
    const txt = await api('POST', '/v1/knowledge/import', {
      as: ADMIN,
      body: { filename: 'note.txt', contentBase64: b64('検索テキスト取込のメモ'), domain: 'industry', targetId: indId },
    })
    expect(txt.status).toBe(201)
    expect((txt.json.data as { title: string }).title).toBe('note') // 拡張子除去のファイル名

    const pdfBytes = readFileSync(new URL('../fixtures/sample.pdf', import.meta.url))
    const pdf = await api('POST', '/v1/knowledge/import', {
      as: ADMIN,
      body: { filename: 'sample.pdf', contentBase64: pdfBytes.toString('base64'), domain: 'industry', targetId: indId },
    })
    expect(pdf.status).toBe(201)
    expect((pdf.json.data as { body: string }).body).toContain('retail inventory issues')

    const docxBytes = readFileSync(new URL('../fixtures/sample.docx', import.meta.url))
    const docx = await api('POST', '/v1/knowledge/import', {
      as: ADMIN,
      body: { filename: 'sample.docx', contentBase64: docxBytes.toString('base64'), domain: 'company', targetId: srchSelfId },
    })
    expect(docx.status).toBe(201)
    expect((docx.json.data as { body: string }).body).toContain('DOCX取込テスト')

    // 旧 .doc は変換を案内・未知拡張子も 400
    const doc = await api('POST', '/v1/knowledge/import', {
      as: ADMIN, body: { filename: 'legacy.doc', contentBase64: b64('x'), domain: 'industry', targetId: indId },
    })
    expect(doc.status).toBe(400)
    expect(doc.json.error?.code).toBe('AKO-KNW-001')
    // 壊れた PDF はテキスト抽出不能（AKO-KNW-003）
    const broken = await api('POST', '/v1/knowledge/import', {
      as: ADMIN, body: { filename: 'broken.pdf', contentBase64: b64('not a pdf'), domain: 'industry', targetId: indId },
    })
    expect(broken.status).toBe(422)
    expect(broken.json.error?.code).toBe('AKO-KNW-003')
    // domain 不正
    expect((await api('POST', '/v1/knowledge/import', {
      as: ADMIN, body: { filename: 'a.md', contentBase64: b64('x'), domain: 'general' },
    })).status).toBe(400)
  })

  it('検索リトリーバルの segments チェックは各セグメントの含有情報を網羅する（PR #45 レビュー R1）', async () => {
    // 会社ドキュメントに役職付き担当者・説明を持たせ、会社名を出さない曖昧質問で検索経路を通す
    const cust2 = await api('POST', '/v1/masters/companies', {
      as: ADMIN,
      body: { kind: 'customer', name: '検索卸山商店', description: '検索卸業務の専門商社', industryIds: [indId] },
    })
    const cust2Id = (cust2.json.data as { id: string }).id
    await api('POST', '/v1/masters/contacts', {
      as: ADMIN, body: { companyId: cust2Id, name: '検索 部長子', title: '検索仕入部長' },
    })
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const deny = (id: string, resource: string, field: string) => [{
      id, subjectKind: 'role' as const, subjectId: 'member', resource, field,
      effect: 'deny' as const, active: true,
    }]
    const q = '検索卸業務を専門にしている先はある?'
    const open = await buildContext(pool, memberUser, q, [])
    expect(open).toContain('検索仕入部長') // 検索経路（関連情報）で役職まで供給される
    // contacts.title deny → 役職を含む担当者セグメントは行ごと消える（漏えいしない）
    const noTitle = await buildContext(pool, memberUser, q, deny('pm-r1a', 'contacts', 'title'))
    expect(noTitle).not.toContain('検索仕入部長')
    // companies.industryIds deny → 業界セグメント（所属の開示）が消える
    const noInd = await buildContext(pool, memberUser, q, deny('pm-r1b', 'companies', 'industryIds'))
    expect(noInd).not.toContain('業界: 検索小売業')
    // projects.type deny → プロジェクトドキュメントの種別セグメントが消える
    await api('POST', '/v1/masters/projects', {
      as: ADMIN, body: { name: '検索棚割最適化', companyId: cust2Id, type: 'development', objective: '検索棚割の改善' },
    })
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const pjQ = '検索棚割の改善はどう進んでいる?'
    expect(await buildContext(pool, memberUser, pjQ, [])).toContain('種別: development')
    expect(await buildContext(pool, memberUser, pjQ, deny('pm-r1c', 'projects', 'type')))
      .not.toContain('種別: development')
  })

  it('ナレッジ原本の参照も表示項目 deny に従う（PR #45 レビュー R3: deny の迂回防止）', async () => {
    const created = await api('POST', '/v1/knowledge/import', {
      as: ADMIN,
      body: { filename: 'secret.md', contentBase64: b64('# 検索機密メモ\n検索原本の中身'), domain: 'industry', targetId: indId },
    })
    const kid = (created.json.data as { id: string }).id
    const files = (await api('GET', `/v1/knowledge/${kid}/files`, { as: MEMBER })).json.data as { id: string }[]
    expect(files).toHaveLength(1)
    // knowledge.body deny → 原本ダウンロードは 403（原本は抽出テキストの上位互換のため）
    const bodyDeny = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'knowledge', field: 'body', effect: 'deny' },
    })
    const ruleId = (bodyDeny.json.data as { id: string }).id
    const denied = await api('GET', `/v1/knowledge/files/${files[0]!.id}`, { as: MEMBER })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-001')
    expect((await api('GET', `/v1/knowledge/files/${files[0]!.id}`, { as: ADMIN })).status).toBe(200)
    await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
    // knowledge.title deny → 添付メタ一覧（ファイル名）も空
    const titleDeny = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'knowledge', field: 'title', effect: 'deny' },
    })
    const titleRuleId = (titleDeny.json.data as { id: string }).id
    expect((await api('GET', `/v1/knowledge/${kid}/files`, { as: MEMBER })).json.data).toEqual([])
    await api('POST', `/v1/masters/permission-rules/${titleRuleId}/archive`, { as: ADMIN })
  })
})

describe('バッチ7b: カレンダー同期対象の選択 + AI 社員間の依頼・連携（オペレーター指示 2026-07-19 #3）', () => {
  it('カレンダー選択: 入力検証と未連携ガード（Google API 依存部は対象外）', async () => {
    // OAuth 未設定環境（テスト Env）では機能自体が無効 = AKO-CAL-007
    const noOauth = await api('PUT', '/v1/calendar/calendars', {
      as: MEMBER, body: { calendarIds: ['primary'] },
    })
    expect(noOauth.status).toBe(409)
    expect(noOauth.json.error?.code).toBe('AKO-CAL-007')
    expect((await api('GET', '/v1/calendar/calendars', { as: MEMBER })).status).toBe(409)
  })

  describe('AI 社員間の連携（マネージャーロール = delegate 権限）', () => {
    let mgrId = ''
    let researcherId = ''
    let writerId = ''
    let workerRoleIds: string[] = []

    const emp = async (name: string, roleId: string): Promise<string> => {
      const r = await api('POST', '/v1/masters/ai-employees', {
        as: ADMIN, body: { name, roleId, deskPosition: { x: 1, y: 1 } },
      })
      return (r.json.data as { id: string }).id
    }

    beforeAll(async () => {
      const mgrRole = await api('POST', '/v1/masters/ai-roles', {
        as: ADMIN,
        body: {
          name: '連携マネージャー', mission: 'ユーザー依頼を引き受け AI 社員へ分担する',
          systemPrompt: '-', permissions: ['delegate'], modelTier: 'pro',
        },
      })
      const research = await api('POST', '/v1/masters/ai-roles', {
        as: ADMIN,
        body: {
          name: '連携リサーチャー', mission: '市場・業界の調査と情報収集を担当',
          systemPrompt: '-', permissions: ['knowledge:read'], modelTier: 'standard',
        },
      })
      const writer = await api('POST', '/v1/masters/ai-roles', {
        as: ADMIN,
        body: {
          name: '連携ライター', mission: '資料・ドラフト文書の作成を担当',
          systemPrompt: '-', permissions: ['documents:write'], modelTier: 'standard',
        },
      })
      workerRoleIds = [research, writer].map(r => (r.json.data as { id: string }).id)
      mgrId = await emp('連携マネ子', (mgrRole.json.data as { id: string }).id)
      researcherId = await emp('連携リサ', workerRoleIds[0]!)
      writerId = await emp('連携ライト', workerRoleIds[1]!)
    })

    afterAll(async () => {
      // 後続テストの候補集合を汚さないよう AI 社員を無効化（タスク・ログは記録系のため残す）
      for (const id of [mgrId, researcherId, writerId]) {
        await api('POST', `/v1/masters/ai-employees/${id}/archive`, { as: ADMIN })
      }
    })

    it('マネージャーへの依頼は承認時に他 AI 社員へ分担連携される（1 回の承認で一挙に引き受け）', async () => {
      const created = await api('POST', '/v1/ai-company/tasks', {
        as: MEMBER,
        body: {
          aiEmployeeId: mgrId, title: '新市場の調査と提案資料の作成',
          description: '市場動向の調査を行い、収集した情報をもとに提案資料のドラフトを作成する。',
        },
      })
      expect(created.status).toBe(201)
      const taskId = (created.json.data as { id: string }).id
      expect((await api('POST', `/v1/ai-company/tasks/${taskId}/approve`, { as: MEMBER })).status).toBe(200)

      const tasks = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as {
        id: string; aiEmployeeId: string; status: string; parentTaskId: string | null
        requesterAiEmployeeId: string | null; decomposition: { title: string }[]
      }[]
      const children = tasks.filter(t => t.parentTaskId === taskId)
      expect(children.length).toBeGreaterThan(0)
      for (const child of children) {
        expect(child.requesterAiEmployeeId).toBe(mgrId) // 依頼元 = マネージャー AI
        // 人間の再承認は不要（親の承認で開始）。バッチ7i の自動実行が既に完了させていることもある
        expect(['in_progress', 'done']).toContain(child.status)
        expect(child.aiEmployeeId).not.toBe(mgrId) // 分担先は自分以外（シード済み AI 社員も候補に含まれる）
      }
      // 分担ステップの合計 = 親の分解ステップ数（取りこぼしなし）
      const parent = tasks.find(t => t.id === taskId)!
      expect(children.reduce((n, ch) => n + ch.decomposition.length, 0)).toBe(parent.decomposition.length)
      // 連携の活動ログ（依頼・受領）が両者に記録される
      const logs = (await api('GET', '/v1/ai-company/logs', { as: MEMBER })).json.data as
        { aiEmployeeId: string; summary: string }[]
      expect(logs.some(l => l.aiEmployeeId === mgrId && l.summary.includes('分担を依頼'))).toBe(true)
      expect(logs.some(l => l.aiEmployeeId !== mgrId && l.summary.includes('分担を受領'))).toBe(true)
    })

    it('全分担の完了（バッチ7i: 承認時の自動実行）で親タスクが自動完了し、依頼者へ統合報告が通知される', async () => {
      const tasks = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as {
        id: string; parentTaskId: string | null; aiEmployeeId: string
      }[]
      const parent = tasks.find(t => t.parentTaskId === null && t.aiEmployeeId === mgrId)!
      // 分担は承認時の自動実行で走り切る（手動の「進める」は不要）→ 親のロールアップ完了を待つ
      const after = await waitAiTask(parent.id, t => t.status === 'done')
      expect(after.decomposition.every(s => s.done)).toBe(true)
      // 連携完了報告通知も fire-and-forget（確定後に発行 = 原則4）のため、着信を待ってから検証する
      await waitNotification(MEMBER, n => n.title.startsWith('AI 連携完了報告'))
    })

    it('分担先のブロックはマネージャーへエスカレーションされ、依頼者へ通知される', async () => {
      // バッチ7i: 承認すると分担は自動実行で即完了し得るため、ブロック経路の検証は
      // 未承認の親 + SQL で用意した実行中の子で決定的にセットアップする
      //（分担の作成経路そのものは上のテストで検証済み。検証対象はブロック API の挙動）
      const created = await api('POST', '/v1/ai-company/tasks', {
        as: MEMBER,
        body: { aiEmployeeId: mgrId, title: '業界レポートの調査', description: '対象業界の動向を調査してまとめる。' },
      })
      const taskId = (created.json.data as { id: string }).id
      const childId = 'at-7i-block-child'
      await pool.query(
        `INSERT INTO ai_tasks (id, ai_employee_id, requester_id, title, description, decomposition, status,
           confidence, created_at, requester_ai_employee_id, parent_task_id)
         SELECT $1, ai_employee_id, requester_id, '業界レポートの調査（分担: 検証）', description,
                '[{"title":"調査","done":false}]'::jsonb, 'in_progress', 'mid', created_at, ai_employee_id, id
         FROM ai_tasks WHERE id = $2`, [childId, taskId])
      expect((await api('POST', `/v1/ai-company/tasks/${childId}/block`, { as: MEMBER })).status).toBe(200)
      const logs = (await api('GET', '/v1/ai-company/logs', { as: MEMBER })).json.data as
        { aiEmployeeId: string; taskId: string | null; summary: string }[]
      expect(logs.some(l => l.aiEmployeeId === mgrId && l.taskId === taskId && l.summary.includes('分担先で'))).toBe(true)
      const notifs = (await api('GET', '/v1/notifications', { as: MEMBER })).json.data as { title: string }[]
      expect(notifs.some(n => n.title.startsWith('AI 連携ブロック'))).toBe(true)
      // 親の中止で未完了の分担も連鎖して中止される
      expect((await api('POST', `/v1/ai-company/tasks/${taskId}/cancel`, { as: MEMBER })).status).toBe(200)
      const after = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as
        { id: string; status: string }[]
      expect(after.find(t => t.id === childId)!.status).toBe('cancelled')
    })

    it('中止された分担は「完了待ち」に数えない（残りの完了で親が統合完了する。PR #48 レビュー指摘）', async () => {
      // バッチ7i: 承認経由だと分担が自動実行で即完了し得るため、SQL で
      // 「実行中の親 + 分担 2 件（片方を中止）」を決定的にセットアップしてロールアップを検証する
      const created = await api('POST', '/v1/ai-company/tasks', {
        as: MEMBER,
        body: {
          aiEmployeeId: mgrId, title: '競合の調査と比較資料の作成',
          description: '競合各社の動向を調査し、収集した情報から比較資料のドラフトを作成する。',
        },
      })
      const taskId = (created.json.data as { id: string }).id
      const parentRow = ((await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as
        { id: string; decomposition: { title: string }[] }[]).find(t => t.id === taskId)!
      await pool.query(`UPDATE ai_tasks SET status = 'in_progress' WHERE id = $1`, [taskId])
      const mkChild = (id: string, steps: { title: string }[]) => pool.query(
        `INSERT INTO ai_tasks (id, ai_employee_id, requester_id, title, description, decomposition, status,
           confidence, created_at, requester_ai_employee_id, parent_task_id)
         SELECT $1, ai_employee_id, requester_id, $3, description, $4::jsonb, 'in_progress', 'mid',
                created_at, ai_employee_id, id
         FROM ai_tasks WHERE id = $2`,
        [id, taskId, `競合の調査と比較資料の作成（分担: 検証${id.slice(-1)}）`,
          JSON.stringify(steps.map(s => ({ title: s.title, done: false })))])
      // 子A = 先頭ステップのみ / 子B = 全ステップ（B の完了 + A の中止で親が統合完了する想定）
      await mkChild('at-7i-rollup-a', parentRow.decomposition.slice(0, 1))
      await mkChild('at-7i-rollup-b', parentRow.decomposition)
      await api('POST', `/v1/ai-company/tasks/at-7i-rollup-a/cancel`, { as: MEMBER })
      // 手動の「進める」1 回で残ステップは自動実行が引き継ぐ（バッチ7i）
      expect((await api('POST', `/v1/ai-company/tasks/at-7i-rollup-b/progress`, { as: MEMBER })).status).toBe(200)
      // 中止された分担（子A）が残り（子B）の統合完了をブロックしない = 親が done へ
      const after = await waitAiTask(taskId, t => t.status === 'done')
      expect(after.decomposition.every(s => s.done)).toBe(true)
    })

    it('delegate 権限のないロールの AI 社員への依頼は連携しない（従来どおり単独実行）', async () => {
      const created = await api('POST', '/v1/ai-company/tasks', {
        as: MEMBER,
        body: { aiEmployeeId: researcherId, title: '単独での市場調査', description: '連携せず単独で調査を行う。' },
      })
      const taskId = (created.json.data as { id: string }).id
      await api('POST', `/v1/ai-company/tasks/${taskId}/approve`, { as: MEMBER })
      const tasks = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as
        { parentTaskId: string | null }[]
      expect(tasks.some(t => t.parentTaskId === taskId)).toBe(false)
    })
  })
})

describe('バッチ7c: ぽいぽいポスト/議事録 + 業務種別マスタ + AI 参照統合（オペレーター指示 2026-07-19 #4）', () => {
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']
  let wcId = ''

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
    const wc = await api('POST', '/v1/masters/work-categories', { as: ADMIN, body: { name: 'ノート検証会議' } })
    wcId = (wc.json.data as { id: string }).id
  })

  it('業務種別マスタ: 追加・一覧・論理削除（汎用マスタ CRUD）', async () => {
    const list = (await api('GET', '/v1/masters/work-categories', { as: MEMBER })).json.data as { id: string; name: string }[]
    expect(list.some(w => w.id === wcId && w.name === 'ノート検証会議')).toBe(true)
    expect((await api('POST', '/v1/masters/work-categories', { as: MEMBER, body: { name: 'x' } })).status).toBe(403)
  })

  it('ぽいぽいポスト: 登録・本人のみ参照（C3）・任意の紐付け', async () => {
    const created = await api('POST', '/v1/notes', {
      as: MEMBER,
      body: { kind: 'poipoi', body: 'ノート検証: A社の見積は単価見直しが必要そう', workCategoryId: wcId },
    })
    expect(created.status).toBe(201)
    const note = created.json.data as { id: string; title: string; workCategoryId: string }
    expect(note.title).toContain('ノート検証')
    expect(note.workCategoryId).toBe(wcId)
    // 本人には見える・他人には見えない
    const mine = (await api('GET', '/v1/notes?kind=poipoi', { as: MEMBER })).json.data as { id: string }[]
    expect(mine.some(n => n.id === note.id)).toBe(true)
    const others = (await api('GET', '/v1/notes?kind=poipoi', { as: ADMIN })).json.data as { id: string }[]
    expect(others.some(n => n.id === note.id)).toBe(false)
    // 不正 kind・存在しない紐付け
    expect((await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'other', body: 'x' } })).status).toBe(400)
    expect((await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'poipoi', body: 'x', projectId: 'p-nope' },
    })).status).toBe(400)
  })

  it('議事録: 全員参照・.md 取込（原本保全 + ラウンドトリップ）・poipoi 原本の本人ガード', async () => {
    const md = '# ノート検証定例 7/19\n決定事項: 検索インデックスの運用開始。'
    const b64 = Buffer.from(md, 'utf8').toString('base64')
    const created = await api('POST', '/v1/notes/import', {
      as: ADMIN, body: { kind: 'minutes', filename: 'minutes-0719.md', contentBase64: b64, workCategoryId: wcId },
    })
    expect(created.status).toBe(201)
    const note = created.json.data as { id: string; title: string; source: string }
    expect(note.source).toBe('upload')
    expect(note.title).toContain('ノート検証定例')
    // 議事録は他メンバーにも見える
    const list = (await api('GET', '/v1/notes?kind=minutes', { as: MEMBER })).json.data as { id: string }[]
    expect(list.some(n => n.id === note.id)).toBe(true)
    // 原本ラウンドトリップ
    const files = (await api('GET', `/v1/notes/${note.id}/files`, { as: MEMBER })).json.data as { id: string }[]
    expect(files).toHaveLength(1)
    const dl = (await api('GET', `/v1/notes/files/${files[0]!.id}`, { as: MEMBER })).json.data as { contentBase64: string }
    expect(Buffer.from(dl.contentBase64, 'base64').toString('utf8')).toBe(md)
    // poipoi の取込原本は本人 + 管理者（バッチ7e で管理者のオリジナル閲覧を追加。他メンバーは 403 のまま）
    const p = await api('POST', '/v1/notes/import', {
      as: MEMBER, body: { kind: 'poipoi', filename: 'memo.txt', contentBase64: Buffer.from('ノート検証の秘密メモ').toString('base64') },
    })
    const pid = (p.json.data as { id: string }).id
    const pFiles = (await api('GET', `/v1/notes/${pid}/files`, { as: MEMBER })).json.data as { id: string }[]
    expect((await api('GET', `/v1/notes/${pid}/files`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', `/v1/notes/files/${pFiles[0]!.id}`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', `/v1/notes/${pid}/files`, { as: HR })).status).toBe(403)
    // 非対応形式
    expect((await api('POST', '/v1/notes/import', {
      as: MEMBER, body: { kind: 'poipoi', filename: 'x.doc', contentBase64: 'eA==' },
    })).json.error?.code).toBe('AKO-NOTE-001')
  })

  it('議事録の Google Meet 連携（③b）: 未設定 env は status=false・未接続は AKO-DOC-006・既定フォルダは管理者のみ・meet リンクの往復と検証', async () => {
    // OAuth 未設定（テスト env）: status は available/connected=false（UI 非表示 = documents ドライブ取込と同型）
    const st = (await api('GET', '/v1/notes/meet/status', { as: MEMBER })).json.data as
      { available: boolean; connected: boolean; driveScope: boolean }
    expect(st).toMatchObject({ available: false, connected: false, driveScope: false })
    // フォルダ/ファイル一覧は未接続で AKO-DOC-006（Drive 共通の再接続導線を共用）
    expect((await api('GET', '/v1/notes/meet/folders', { as: MEMBER })).json.error?.code).toBe('AKO-DOC-006')
    expect((await api('GET', '/v1/notes/meet/files', { as: MEMBER })).json.error?.code).toBe('AKO-DOC-006')
    // 既定保管フォルダ: member は 403 / admin は設定 → 応答に反映 → id 空でクリア
    expect((await api('PUT', '/v1/notes/meet/default-folder', {
      as: MEMBER, body: { id: 'f1', name: 'Meet Recordings' },
    })).status).toBe(403)
    const set = await api('PUT', '/v1/notes/meet/default-folder', { as: ADMIN, body: { id: 'f1', name: 'Meet Recordings' } })
    expect(set.json.data).toEqual({ id: 'f1', name: 'Meet Recordings' })
    const cleared = await api('PUT', '/v1/notes/meet/default-folder', { as: ADMIN, body: { id: '' } })
    expect(cleared.json.data).toBeNull()
    // 議事録の Meet リンク往復（webViewLink は *.google.com のみ受理）
    const linked = await api('POST', '/v1/notes', { as: ADMIN, body: {
      kind: 'minutes', body: 'Meet 連携テスト議事録',
      meetFileId: 'gdoc-1', meetFileName: 'AIメモ 7/20', meetWebLink: 'https://docs.google.com/document/d/gdoc-1/edit',
    } })
    expect((linked.json.data as { meetFileId: string; meetFileName: string; meetWebLink: string })).toMatchObject({
      meetFileId: 'gdoc-1', meetFileName: 'AIメモ 7/20', meetWebLink: 'https://docs.google.com/document/d/gdoc-1/edit',
    })
    // 不正 webViewLink（非 google ドメイン）は null 化・id 無しは name/link も null（不整合を持ち込まない）
    const bad = await api('POST', '/v1/notes', { as: ADMIN, body: {
      kind: 'minutes', body: '不正リンク', meetFileId: 'gdoc-2', meetWebLink: 'https://evil.example.com/x',
    } })
    expect((bad.json.data as { meetFileId: string; meetWebLink: string | null }))
      .toMatchObject({ meetFileId: 'gdoc-2', meetWebLink: null })
    const noId = await api('POST', '/v1/notes', { as: ADMIN, body: {
      kind: 'minutes', body: 'id 無し', meetFileName: 'orphan', meetWebLink: 'https://docs.google.com/x',
    } })
    expect((noId.json.data as { meetFileId: string | null; meetFileName: string | null }))
      .toMatchObject({ meetFileId: null, meetFileName: null })
  })

  it('AI 参照統合: 議事録は全員の検索文脈へ・ぽいぽいポストは本人のみ（owner スコープ = C3）', async () => {
    expect((await api('POST', '/v1/search/reindex', { as: ADMIN })).status).toBe(200)
    // 議事録（minutes）は他メンバーの文脈にも載る
    const other = await buildContext(pool, memberUser, 'ノート検証定例の決定事項は?', [])
    expect(other).toContain('検索インデックスの運用開始')
    // poipoi は本人の文脈のみ（他人には載らない）
    const own = await buildContext(pool, memberUser, 'ノート検証の秘密メモの内容は?', [])
    expect(own).toContain('ノート検証の秘密メモ')
    // バッチ7g で既定の AI 参照範囲が「すべて」へ変更（オペレーター指示 2026-07-19 #8 = 他メンバーの
    // 投稿も参照）。ai-scope ルールで自分のみへ制限できることは 7g のテストが検証する
    const notOwn = await buildContext(pool, adminUser, 'ノート検証の秘密メモの内容は?', [])
    expect(notOwn).toContain('ノート検証の秘密メモ')
  })

  it('機能ガード（F-16）: minutes の deny で API も検索文脈も閉じる。GET の kind 不正は 400', async () => {
    expect((await api('GET', '/v1/notes?kind=other', { as: MEMBER })).status).toBe(400)
    const deny = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN, body: { subjectKind: 'role', subjectId: 'member', resource: 'minutes', effect: 'deny' },
    })
    const ruleId = (deny.json.data as { id: string }).id
    expect((await api('GET', '/v1/notes?kind=minutes', { as: MEMBER })).status).toBe(403)
    expect((await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'minutes', body: 'x' } })).status).toBe(403)
    // 検索リトリーバル経由でも議事録が文脈に載らない（機能 deny の一貫性）
    const rules = [{
      id: ruleId, subjectKind: 'role' as const, subjectId: 'member', resource: 'minutes', field: null,
      effect: 'deny' as const, active: true,
    }]
    const ctx = await buildContext(pool, memberUser, 'ノート検証定例の決定事項は?', rules)
    expect(ctx).not.toContain('検索インデックスの運用開始')
    await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
  })

  it('日報ドラフト: 独立メニューのぽいぽいポストが材料へ合流する（AI業務アシスタント統合）', async () => {
    const today = todayJst()
    await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'poipoi', body: 'ノート検証ドラフト材料: B社ヒアリングの論点整理を実施' },
    })
    const draft = await api('POST', '/v1/assist/report-draft', { as: MEMBER, body: { date: today } })
    expect(draft.status).toBe(200)
    expect(JSON.stringify(draft.json.data)).toContain('ノート検証ドラフト材料')
  })
})

describe('バッチ7d: ノートの取消 + 紐付けによる AI 文脈の混入防止（オペレーター指示 2026-07-19 #5）', () => {
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']
  let coAId = ''
  let coBId = ''

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
    const a = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { kind: 'customer', name: '混入検証アルファ株式会社' } })
    coAId = (a.json.data as { id: string }).id
    const b = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { kind: 'customer', name: '混入検証ベータ株式会社' } })
    coBId = (b.json.data as { id: string }).id
  })

  it('取消（論理削除）: 本人/管理者の権限・一覧と検索文脈から除外・冪等', async () => {
    const created = await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'minutes', title: '取消検証議事録', body: '取消検証: 誤アップロードの内容' },
    })
    const noteId = (created.json.data as { id: string }).id
    // 取消前は検索文脈に載る（除外ロジックの検証がトートロジーにならないための正の対照）
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    expect(await buildContext(pool, memberUser, '取消検証議事録の内容は?', [])).toContain('誤アップロードの内容')
    // 他人（登録者でも管理者でもない）は取消不可 → 管理者は可
    expect((await api('POST', `/v1/notes/${noteId}/archive`, { as: HR })).status).toBe(403)
    expect((await api('POST', `/v1/notes/${noteId}/archive`, { as: ADMIN })).status).toBe(200)
    // 冪等（再実行は warning 付き no-op）
    const again = await api('POST', `/v1/notes/${noteId}/archive`, { as: ADMIN })
    expect(again.status).toBe(200)
    expect((again.json.data as { warning?: string }).warning).toBeTruthy()
    // 一覧から消える
    const list = (await api('GET', '/v1/notes?kind=minutes', { as: MEMBER })).json.data as { id: string }[]
    expect(list.some(n => n.id === noteId)).toBe(false)
    // 検索文脈からも消える
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    expect(await buildContext(pool, memberUser, '取消検証議事録の内容は?', [])).not.toContain('誤アップロードの内容')
    // 登録者本人（非管理者）も取消できる
    const own = await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'minutes', title: '本人取消', body: '本人が取り消す議事録' } })
    expect((await api('POST', `/v1/notes/${(own.json.data as { id: string }).id}/archive`, { as: MEMBER })).status).toBe(200)
    // poipoi は本人のみ取消可（管理者でも不可）
    const p = await api('POST', '/v1/notes', { as: MEMBER, body: { kind: 'poipoi', body: '取消検証の個人メモ' } })
    const pid = (p.json.data as { id: string }).id
    expect((await api('POST', `/v1/notes/${pid}/archive`, { as: ADMIN })).status).toBe(403)
    expect((await api('POST', `/v1/notes/${pid}/archive`, { as: MEMBER })).status).toBe(200)
  })

  it('復元（取消の取消）: 権限は取消と同一・includeArchived の可視範囲・冪等', async () => {
    const created = await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'minutes', title: '復元検証議事録', body: '復元検証: 一度取り消してから戻す' },
    })
    const noteId = (created.json.data as { id: string }).id
    await api('POST', `/v1/notes/${noteId}/archive`, { as: MEMBER })
    // 取消済みは includeArchived=1 で登録者本人には見えるが、無関係の他人には見えない
    const mine = (await api('GET', '/v1/notes?kind=minutes&includeArchived=1', { as: MEMBER })).json.data as { id: string; active: boolean }[]
    expect(mine.find(n => n.id === noteId)?.active).toBe(false)
    const others = (await api('GET', '/v1/notes?kind=minutes&includeArchived=1', { as: HR })).json.data as { id: string }[]
    expect(others.some(n => n.id === noteId)).toBe(false)
    // 復元は他人不可 → 本人可 → 一覧へ戻る
    expect((await api('POST', `/v1/notes/${noteId}/restore`, { as: HR })).status).toBe(403)
    expect((await api('POST', `/v1/notes/${noteId}/restore`, { as: MEMBER })).status).toBe(200)
    const back = (await api('GET', '/v1/notes?kind=minutes', { as: HR })).json.data as { id: string }[]
    expect(back.some(n => n.id === noteId)).toBe(true)
    // 冪等（取消されていないノートの復元は warning 付き no-op）
    const again = await api('POST', `/v1/notes/${noteId}/restore`, { as: MEMBER })
    expect(again.status).toBe(200)
    expect((again.json.data as { warning?: string }).warning).toBeTruthy()
  })

  it('取消済みノートの原本ファイルは復元権限者のみ参照できる', async () => {
    const md = Buffer.from('# 原本取消検証\n誤アップロードされた機密込みの本文', 'utf8').toString('base64')
    const imported = await api('POST', '/v1/notes/import', {
      as: MEMBER, body: { kind: 'minutes', filename: 'gohon.md', contentBase64: md },
    })
    const noteId = (imported.json.data as { id: string }).id
    // 取消前は全員（minutes）参照可
    expect((await api('GET', `/v1/notes/${noteId}/files`, { as: HR })).status).toBe(200)
    await api('POST', `/v1/notes/${noteId}/archive`, { as: MEMBER })
    // 取消後: 無関係の他人 403 / 登録者本人・管理者は監査・復元のため参照可
    expect((await api('GET', `/v1/notes/${noteId}/files`, { as: HR })).status).toBe(403)
    const files = (await api('GET', `/v1/notes/${noteId}/files`, { as: MEMBER })).json.data as { id: string }[]
    expect(files.length).toBe(1)
    expect((await api('GET', `/v1/notes/files/${files[0]!.id}`, { as: HR })).status).toBe(403)
    expect((await api('GET', `/v1/notes/files/${files[0]!.id}`, { as: ADMIN })).status).toBe(200)
  })

  it('取消済みぽいぽいポストは日報ドラフト材料に混ざらない', async () => {
    const today = todayJst()
    const p = await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'poipoi', body: 'ドラフト取消検証XYZ: 誤登録した内容' },
    })
    await api('POST', `/v1/notes/${(p.json.data as { id: string }).id}/archive`, { as: MEMBER })
    const draft = await api('POST', '/v1/assist/report-draft', { as: MEMBER, body: { date: today } })
    expect(draft.status).toBe(200)
    expect(JSON.stringify(draft.json.data)).not.toContain('ドラフト取消検証XYZ')
  })

  it('混入防止: 別の顧客に紐付く議事録は、特定顧客の質問の文脈へ混ざらない', async () => {
    // 同じ語彙（値引き交渉）を含む議事録を A 社・B 社に紐付けて登録
    await api('POST', '/v1/notes', {
      as: MEMBER,
      body: { kind: 'minutes', title: '混入検証アルファ定例', body: '混入検証: アルファ社と値引き交渉、次回リミット提示。', companyId: coAId },
    })
    await api('POST', '/v1/notes', {
      as: MEMBER,
      body: { kind: 'minutes', title: '混入検証ベータ定例', body: '混入検証: ベータ社と値引き交渉、継続協議とする。', companyId: coBId },
    })
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const ctx = await buildContext(pool, memberUser, '混入検証アルファの値引き交渉の状況は?', [])
    expect(ctx).toContain('次回リミット提示') // A 社紐付けは載る
    expect(ctx).not.toContain('継続協議とする') // B 社紐付けは混ざらない
    // 特定顧客に解決されない一般質問では、両社の紐付きノートが通常どおり候補になる
    // （A 側だけの一致では「フィルタなしでも B は載らない」可能性が残るため、両方を明示的に確認）
    const generic = await buildContext(pool, memberUser, '混入検証の値引き交渉のメモはある?', [])
    expect(generic).toContain('次回リミット提示')
    expect(generic).toContain('継続協議とする')
  })

  it('混入防止: 会社解決は履歴より今回の質問を優先する（2026-07-18 #3 と同じ優先順）', async () => {
    // 履歴に別会社（正規化名がより長いアルファ）が居ても、今回の質問のベータを優先して解決する。
    // topic 連結への最長一致だとアルファに解決され、ベータ紐付けノートが誤除外される回帰を防ぐ
    const ctx = await buildContext(pool, memberUser, '混入検証ベータの値引き交渉は?', [],
      ['混入検証アルファの状況を教えて'])
    expect(ctx).toContain('継続協議とする') // 今回の質問（ベータ）の紐付けは載る
    expect(ctx).not.toContain('次回リミット提示') // 履歴の会社（アルファ）の紐付けは除外される
  })
})

describe('バッチ7e: ぽいぽいポスト（管理者の全ポスト閲覧。オペレーター指示 2026-07-19 #6）', () => {
  it('scope=all は管理者のみ。全メンバーの active ポストが見え、取消済みは含まれない', async () => {
    const p = await api('POST', '/v1/notes', {
      as: MEMBER, body: { kind: 'poipoi', body: '7e 管理者閲覧検証: メンバーの気づきポスト' },
    })
    const pid = (p.json.data as { id: string }).id
    // 非管理者（本人・HR）は 403
    expect((await api('GET', '/v1/notes?kind=poipoi&scope=all', { as: MEMBER })).status).toBe(403)
    expect((await api('GET', '/v1/notes?kind=poipoi&scope=all', { as: HR })).status).toBe(403)
    // 管理者は他メンバーのポストのオリジナル本文を閲覧できる
    const all = (await api('GET', '/v1/notes?kind=poipoi&scope=all', { as: ADMIN })).json.data as
      { id: string; memberId: string; body: string }[]
    const mine = all.find(n => n.id === pid)
    expect(mine?.memberId).toBe(MEMBER)
    expect(mine?.body).toContain('メンバーの気づきポスト')
    // 取消済みは scope=all からも消える（取消は本人のみ = C3 の取消権限は不変）
    expect((await api('POST', `/v1/notes/${pid}/archive`, { as: ADMIN })).status).toBe(403)
    expect((await api('POST', `/v1/notes/${pid}/archive`, { as: MEMBER })).status).toBe(200)
    const all2 = (await api('GET', '/v1/notes?kind=poipoi&scope=all', { as: ADMIN })).json.data as { id: string }[]
    expect(all2.some(n => n.id === pid)).toBe(false)
  })

  it('poipoi の原本ファイルは本人 + 管理者が参照できる（他メンバーは不可）', async () => {
    const md = Buffer.from('# 7e ポスト原本\n改善アイデアの下書き', 'utf8').toString('base64')
    const imp = await api('POST', '/v1/notes/import', {
      as: MEMBER, body: { kind: 'poipoi', filename: 'idea.md', contentBase64: md },
    })
    const nid = (imp.json.data as { id: string }).id
    expect((await api('GET', `/v1/notes/${nid}/files`, { as: HR })).status).toBe(403)
    const files = (await api('GET', `/v1/notes/${nid}/files`, { as: ADMIN })).json.data as { id: string }[]
    expect(files.length).toBe(1)
    expect((await api('GET', `/v1/notes/files/${files[0]!.id}`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', `/v1/notes/files/${files[0]!.id}`, { as: HR })).status).toBe(403)
  })
})

describe('バッチ7f: 権限デフォルト + AI 社員の増減 + AI カンパニーの実遂行（オペレーター指示 2026-07-19 #7）', () => {
  // 1x1 の最小 PNG（バイナリ添付の検証用）
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  it('権限の運用デフォルト（0025）: member/hr は売上・意思決定が deny、管理者は allow、マスタ参照 API は影響なし', async () => {
    // migration が投入したデフォルト（beforeAll で無効化済み）を再有効化して振る舞いを検証する
    const { rowCount } = await pool.query(
      `UPDATE permission_rules SET active = true WHERE id LIKE 'pr-def-%'`)
    expect(rowCount).toBe(6)
    clearPermissionCache() // 直接 SQL での切替はキャッシュを経由しないため明示的にクリア
    try {
      expect((await api('GET', '/v1/sales', { as: MEMBER })).status).toBe(403)
      expect((await api('GET', '/v1/sales', { as: HR })).status).toBe(403)
      expect((await api('GET', '/v1/sales', { as: ADMIN })).status).toBe(200)
      expect((await api('GET', '/v1/decisions/logs', { as: MEMBER })).status).toBe(403)
      expect((await api('GET', '/v1/decisions/logs', { as: ADMIN })).status).toBe(200)
      // masters deny は管理 UI の非表示のみ（/v1/masters はデータ面 = 機能ガード対象外。参照データ供給は維持）
      expect((await api('GET', '/v1/masters/companies', { as: MEMBER })).status).toBe(200)
    } finally {
      await pool.query(`UPDATE permission_rules SET active = false WHERE id LIKE 'pr-def-%'`)
      clearPermissionCache()
    }
  })

  it('AI 社員の増減: 追加（増員）→ 無効化（減員）で依頼不可 → 復元で再開', async () => {
    const role = await api('POST', '/v1/masters/ai-roles', {
      as: ADMIN, body: { name: '7f検証ロール', mission: '実遂行の検証', systemPrompt: '', permissions: [], modelTier: 'lite' },
    })
    const roleId = (role.json.data as { id: string }).id
    const emp = await api('POST', '/v1/masters/ai-employees', {
      as: ADMIN, body: { name: '7f検証社員', roleId, deskPosition: { x: 3, y: 2 } },
    })
    const empId = (emp.json.data as { id: string }).id
    // 減員 = 論理削除 → 新規依頼は 404
    expect((await api('POST', `/v1/masters/ai-employees/${empId}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER, body: { aiEmployeeId: empId, title: '減員後の依頼' },
    })).json.error?.code).toBe('AKO-AIC-001')
    // 復元（取消可能性 = 原則 9.5）で依頼可能へ戻る
    expect((await api('POST', `/v1/masters/ai-employees/${empId}/restore`, { as: ADMIN })).status).toBe(200)
    expect((await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER, body: { aiEmployeeId: empId, title: '復元後の依頼', description: '復元検証のための依頼です。分解して進めてください。' },
    })).status).toBe(201)
  })

  it('実遂行: 情報不足の依頼は依頼者へ質問 → 回答（権限ガードあり）→ 遂行で成果物 → 完了で統合報告', async () => {
    const role = await api('POST', '/v1/masters/ai-roles', {
      as: ADMIN, body: { name: '7f遂行ロール', mission: '調査と資料作成', systemPrompt: '', permissions: [], modelTier: 'standard' },
    })
    const emp = await api('POST', '/v1/masters/ai-employees', {
      as: ADMIN, body: { name: '7f遂行社員', roleId: (role.json.data as { id: string }).id, deskPosition: { x: 0, y: 3 } },
    })
    const empId = (emp.json.data as { id: string }).id
    // 添付付きの依頼（.md = 抽出・.png = 画像原本）。説明が薄い（20 字未満）= ヒューリスティックが確認を要求する
    const created = await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER,
      body: {
        aiEmployeeId: empId,
        title: '7f実遂行検証タスク',
        description: '急ぎで頼む',
        attachments: [
          { filename: 'ref.md', contentBase64: Buffer.from('# 参考資料\n単価テーブル: A=100, B=200', 'utf8').toString('base64') },
          { filename: 'shot.png', contentBase64: PNG_1PX.toString('base64') },
        ],
      },
    })
    expect(created.status).toBe(201)
    const taskId = (created.json.data as { id: string }).id
    // 添付メタがタスク行へ埋め込まれる
    const listed = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as {
      id: string; files: { filename: string }[]; questions: unknown[]
    }[]
    expect(listed.find(t => t.id === taskId)?.files.map(f => f.filename).sort()).toEqual(['ref.md', 'shot.png'])

    await api('POST', `/v1/ai-company/tasks/${taskId}/approve`, { as: MEMBER })
    // 承認 → 自動実行（バッチ7i）: 情報不足（10 字未満）→ 依頼者へ自動で質問してブロック（人間のアクション要求）
    const blocked = await waitAiTask(taskId, t => t.status === 'blocked')
    expect(blocked.questions.length).toBe(1)
    expect(blocked.questions[0]!.status).toBe('open')
    // 回答待ちの間は進められない
    expect((await api('POST', `/v1/ai-company/tasks/${taskId}/progress`, { as: MEMBER })).json.error?.code).toBe('AKO-AIC-014')
    // 回答は依頼者本人（または管理者）のみ
    expect((await api('POST', `/v1/ai-company/tasks/${taskId}/answer`, {
      as: HR, body: { answer: '勝手に回答' },
    })).json.error?.code).toBe('AKO-AIC-013')
    // 依頼者の回答（添付付き）で実行が自動再開する（「進める」の連打不要 = バッチ7i）
    const ans = await api('POST', `/v1/ai-company/tasks/${taskId}/answer`, {
      as: MEMBER,
      body: {
        answer: '目的はコスト削減比較です。A/B 単価の比較表を期待しています',
        attachments: [{ filename: 'note.txt', contentBase64: Buffer.from('締切は今週金曜').toString('base64') }],
      },
    })
    expect(ans.status).toBe(200)
    // 自動再開は fire-and-forget のため、応答時点の状態は in_progress（または既に done）
    expect(['in_progress', 'done']).toContain((ans.json.data as { status: string }).status)
    expect((ans.json.data as { questions: { status: string; answer: string }[] }).questions[0]!.status).toBe('answered')

    // 全ステップの自動遂行 → 各ステップの成果物 + 統合報告
    const done = await waitAiTask(taskId, t => t.status === 'done')
    const outputs = done.outputs
    expect(outputs.length).toBeGreaterThan(1)
    // ステップ成果物は材料（回答・添付抽出テキスト）に基づく（LLM 無効 = 決定的ヒューリスティック）
    expect(outputs[0]!.body).toContain('コスト削減')
    // 統合報告（step = -1）が末尾に生成される
    expect(outputs.some(o => o.step === -1 && o.title === '統合報告')).toBe(true)
  })

  it('添付バリデーション: 非対応形式は AKO-AIC-010・6 件以上は AKO-AIC-011。原本は依頼者 + 管理者のみDL可', async () => {
    const emps = (await api('GET', '/v1/masters/ai-employees', { as: ADMIN })).json.data as { id: string; active: boolean }[]
    const empId = emps.find(e => e.active)!.id
    expect((await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER,
      body: { aiEmployeeId: empId, title: 'x', attachments: [{ filename: 'v.exe', contentBase64: 'eA==' }] },
    })).json.error?.code).toBe('AKO-AIC-010')
    expect((await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER,
      body: {
        aiEmployeeId: empId, title: 'x',
        attachments: Array.from({ length: 6 }, (_, i) => ({ filename: `${i}.txt`, contentBase64: 'eA==' })),
      },
    })).json.error?.code).toBe('AKO-AIC-011')
    // 原本ダウンロードの権限（依頼者 or 管理者）
    const created = await api('POST', '/v1/ai-company/tasks', {
      as: MEMBER,
      body: {
        aiEmployeeId: empId, title: '7f原本DL検証', description: '添付原本の権限検証のための依頼です。よろしくお願いします。',
        attachments: [{ filename: 'dl.txt', contentBase64: Buffer.from('原本テキスト').toString('base64') }],
      },
    })
    const createdId = (created.json.data as { id: string }).id
    const allTasks = (await api('GET', '/v1/ai-company/tasks', { as: MEMBER })).json.data as {
      id: string; files: { id: string }[]
    }[]
    const files = allTasks.find(t => t.id === createdId)!.files
    expect((await api('GET', `/v1/ai-company/files/${files[0]!.id}`, { as: HR })).status).toBe(403)
    expect((await api('GET', `/v1/ai-company/files/${files[0]!.id}`, { as: MEMBER })).status).toBe(200)
    expect((await api('GET', `/v1/ai-company/files/${files[0]!.id}`, { as: ADMIN })).status).toBe(200)
  })
})

describe('バッチ7g: AI 参照範囲の権限化 + 週次 AI インサイト（オペレーター指示 2026-07-19 #8/#9）', () => {
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  const adminUser = { id: ADMIN, name: '管理 太郎', email: 'admin@example.com', role: 'admin' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
  })

  it('ぽいぽいポストの AI 参照は既定で他メンバーの投稿も対象（投稿者名付き）・ai-scope ルールで自分のみへ制限可', async () => {
    // HR が投稿 → MEMBER のチャットボット文脈に載る（バッチ7g 以前は本人のみ = 見えなかった）
    await api('POST', '/v1/notes', {
      as: HR, body: { kind: 'poipoi', body: '7gスコープ検証: 受注プロセスの改善アイデアあり' },
    })
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const ctx = await buildContext(pool, memberUser, '7gスコープ検証の改善アイデアは?', [])
    expect(ctx).toContain('受注プロセスの改善アイデア')
    expect(ctx).toContain('人事 花子') // 投稿者セグメント
    // role=member へ ai-scope 'own'（deny）を設定すると他メンバーの投稿は文脈から消える
    const ruleRes = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'member', resource: 'poipoi', field: 'ai-scope', effect: 'deny' },
    })
    const ruleId = (ruleRes.json.data as { id: string }).id
    clearPermissionCache()
    try {
      const rules = await activePermissionRules(pool)
      const own = await buildContext(pool, memberUser, '7gスコープ検証の改善アイデアは?', rules)
      expect(own).not.toContain('受注プロセスの改善アイデア')
      // 管理者（ロール外）は既定 all のまま
      const adm = await buildContext(pool, adminUser, '7gスコープ検証の改善アイデアは?', rules)
      expect(adm).toContain('受注プロセスの改善アイデア')
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('勤怠の AI 参照は既定 own（チームサマリーなし）・ai-scope all の付与でチーム全体を供給', async () => {
    // 当月の打刻を作る（チームサマリーの材料）
    await api('POST', '/v1/attendance/punches', { as: MEMBER, body: { kind: 'in' } })
    const before = await buildContext(pool, adminUser, '今月の労働時間は?', [])
    expect(before).not.toContain('チーム全体の当月勤怠')
    const ruleRes = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'admin', resource: 'attendance', field: 'ai-scope', effect: 'allow' },
    })
    const ruleId = (ruleRes.json.data as { id: string }).id
    clearPermissionCache()
    try {
      const rules = await activePermissionRules(pool)
      const after = await buildContext(pool, adminUser, '今月の労働時間は?', rules)
      expect(after).toContain('チーム全体の当月勤怠')
      expect(after).toContain('一般 次郎') // 打刻したメンバーが載る
      // ルール対象外（member ロール）は own のまま
      const member = await buildContext(pool, memberUser, '今月の労働時間は?', rules)
      expect(member).not.toContain('チーム全体の当月勤怠')
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('ai-scope all でも members.name の表示 deny があればチームブロックを供給しない（R1 C-1）', async () => {
    const mk = async (body: Record<string, string>): Promise<string> => {
      const res = await api('POST', '/v1/masters/permission-rules', { as: ADMIN, body })
      return (res.json.data as { id: string }).id
    }
    const scopeId = await mk({ subjectKind: 'role', subjectId: 'admin', resource: 'attendance', field: 'ai-scope', effect: 'allow' })
    const nameId = await mk({ subjectKind: 'role', subjectId: 'admin', resource: 'members', field: 'name', effect: 'deny' })
    clearPermissionCache()
    try {
      const rules = await activePermissionRules(pool)
      const ctx = await buildContext(pool, adminUser, '今月の労働時間は?', rules)
      expect(ctx).not.toContain('チーム全体の当月勤怠')
      expect(ctx).not.toContain('一般 次郎')
    } finally {
      await api('POST', `/v1/masters/permission-rules/${scopeId}/archive`, { as: ADMIN })
      await api('POST', `/v1/masters/permission-rules/${nameId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('週次 AI インサイト: 生成（POST）で保管・取得（GET）は保存済みのみ・売上は配信時マスク（バッチ7j 仕様）', async () => {
    const today = todayJst()
    // 今週の月曜（weekStartOf と同一ロジック）
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
    const weekStart = addDays(today, -dow)
    expect((await api('GET', '/v1/reports/weekly-insight?weekStart=bad', { as: MEMBER })).status).toBe(400)
    // 暦上不正な日付・月曜以外は 400（PR #56 R1 M-1: 以前は pg 側で 500 / 黙って週ずれ集計）
    expect((await api('GET', '/v1/reports/weekly-insight?weekStart=2026-02-31', { as: MEMBER })).status).toBe(400)
    expect((await api('GET', `/v1/reports/weekly-insight?weekStart=${addDays(weekStart, 1)}`, { as: MEMBER })).status).toBe(400)
    expect((await api('POST', '/v1/reports/weekly-insight', { as: MEMBER, body: { weekStart: 'bad' } })).status).toBe(400)
    // 未生成の週は company / personal とも null（GET は生成しない = バッチ7j）
    const pastWeek = addDays(weekStart, -7 * 30)
    const empty = await api('GET', `/v1/reports/weekly-insight?weekStart=${pastWeek}`, { as: MEMBER })
    expect((empty.json.data as { company: unknown; personal: unknown }).company).toBeNull()
    // 生成（POST）→ 全体共通 + 個別（ログインユーザー向け）が保管され返る
    const r = await api('POST', '/v1/reports/weekly-insight', { as: MEMBER, body: { weekStart } })
    expect(r.status).toBe(200)
    interface Bundle {
      company: {
        metrics: {
          weekStart: string; asOf: string; businessDaysElapsed: number; membersActive: number
          dailySubmissions: { date: string }[]; salesMonthAmount: number | null
        }
        insight: { executiveSummary: string; swot: { strengths: string[] } }
        llm: boolean
        generatedAt: string
      } | null
      personal: {
        metrics: { memberId: string; businessDaysElapsed: number }
        insight: { summary: string; focus: string[]; actions: string[] }
      } | null
    }
    const data = r.json.data as Bundle
    expect(data.company).not.toBeNull()
    expect(data.company!.metrics.weekStart).toBe(weekStart)
    // 集計基準日 = min(weekEnd, 前日)（日報は前日分までが正常 = バッチ7j）
    const weekEnd = addDays(weekStart, 6)
    const yesterday = addDays(today, -1)
    expect(data.company!.metrics.asOf).toBe(yesterday < weekEnd ? yesterday : weekEnd)
    expect(data.company!.metrics.businessDaysElapsed).toBeGreaterThanOrEqual(0)
    expect(data.company!.metrics.membersActive).toBeGreaterThan(0)
    expect(data.company!.metrics.dailySubmissions.length).toBe(7)
    expect(data.company!.metrics.salesMonthAmount).not.toBeNull() // ルールなし = 供給
    expect(data.company!.insight.executiveSummary).toContain('週次サマリー')
    expect(data.company!.llm).toBe(false) // テスト環境は LLM 無効 = ヒューリスティック
    expect(data.personal!.metrics.memberId).toBe(MEMBER)
    expect(data.personal!.insight.summary).toContain('さん')
    // generatedAt はリポジトリ規約の JST ISO（PR #59 R1 C-1: timestamptz の生形式で表示が壊れる回帰防止）
    expect(data.company!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/)
    // GET は保存済みをそのまま返す（再生成まで不変 = generatedAt が一致）
    const stored = await api('GET', `/v1/reports/weekly-insight?weekStart=${weekStart}`, { as: MEMBER })
    expect((stored.json.data as Bundle).company!.generatedAt).toBe(data.company!.generatedAt)
    // 再生成（POST）は上書き（generatedAt が更新される = 導出キャッシュの upsert）。
    // generatedAt は秒精度（規約の JST ISO）のため、同一秒内の再生成では差が出ない = 1.1 秒待つ
    await new Promise(resolve => setTimeout(resolve, 1100))
    const regen = await api('POST', '/v1/reports/weekly-insight', { as: MEMBER, body: { weekStart } })
    expect((regen.json.data as Bundle).company!.generatedAt).not.toBe(data.company!.generatedAt)
    // 個別は本人の分のみ（ADMIN はまだ生成していない = personal null・全体は共有される）
    const asAdmin = await api('GET', `/v1/reports/weekly-insight?weekStart=${weekStart}`, { as: ADMIN })
    expect((asAdmin.json.data as Bundle).company).not.toBeNull()
    expect((asAdmin.json.data as Bundle).personal).toBeNull()
    // 売上 deny（運用デフォルトの member ルール）を有効化すると保存済み全体の配信時マスクで null
    await pool.query(`UPDATE permission_rules SET active = true WHERE id = 'pr-def-01'`)
    clearPermissionCache()
    try {
      const masked = await api('GET', `/v1/reports/weekly-insight?weekStart=${weekStart}`, { as: MEMBER })
      expect((masked.json.data as Bundle).company!.metrics.salesMonthAmount).toBeNull()
      // 権限のある管理者には保存済みの売上がそのまま配信される
      const adm = await api('GET', `/v1/reports/weekly-insight?weekStart=${weekStart}`, { as: ADMIN })
      expect((adm.json.data as Bundle).company!.metrics.salesMonthAmount).not.toBeNull()
    } finally {
      await pool.query(`UPDATE permission_rules SET active = false WHERE id = 'pr-def-01'`)
      clearPermissionCache()
    }
  })

  it('前日まで前提: 当日提出の日報は提出数（reportSubmitted）に数えない（バッチ7j）', async () => {
    const today = todayJst()
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
    const weekStart = addDays(today, -dow)
    const before = await api('POST', '/v1/reports/weekly-insight', { as: MEMBER, body: { weekStart } })
    const n1 = (before.json.data as { company: { metrics: { reportSubmitted: number } } }).company.metrics.reportSubmitted
    // 検証用メンバーを新設し、当日分の日報を提出（既存メンバーの当日提出と混ざらない）
    const mem = await api('POST', '/v1/masters/members', {
      as: ADMIN,
      body: { name: '7j検証 太郎', email: 'w7j@example.com', role: 'member', employmentType: 'employee' },
    })
    const memId = ((mem.json.data as { id: string }).id)
    expect((await api('PUT', '/v1/reports/daily', {
      as: memId,
      body: { date: today, entries: [{ theme: '7j検証', task: '当日分', hours: 1, progress: 50 }], status: 'submitted' },
    })).status).toBe(200)
    const after = await api('POST', '/v1/reports/weekly-insight', { as: MEMBER, body: { weekStart } })
    // 当日（today）は asOf（前日）より後 = 提出数に数えない（未提出として悲観評価もしない）
    const n2 = (after.json.data as { company: { metrics: { reportSubmitted: number } } }).company.metrics.reportSubmitted
    expect(n2).toBe(n1)
  })
})

describe('バッチ7h: チーム参照の公開 + 日報参照権限 F-16-6（オペレーター指示 2026-07-19 #10）', () => {
  const memberUser = { id: MEMBER, name: '一般 次郎', email: 'member@example.com', role: 'member' as const, title: '', avatar: '' }
  let buildContext: (typeof import('../../src/routes/chatbot'))['buildContext']

  beforeAll(async () => {
    ;({ buildContext } = await import('../../src/routes/chatbot'))
  })

  it('scope=team は全員可: 一般 = 提出済みのみ（他人の下書きを返さない）・管理者 = 下書き含む', async () => {
    const date = '2026-06-01'
    const draft = await api('PUT', '/v1/reports/daily', {
      as: HR, body: { date, entries: [{ theme: '7hチーム検証', task: '下書き', hours: 1, progress: 10 }], status: 'draft' },
    })
    expect(draft.status).toBe(200)
    const member = await api('GET', `/v1/reports/daily?scope=team&date=${date}`, { as: MEMBER })
    expect(member.status).toBe(200)
    const memberRows = member.json.data as { status: string }[]
    expect(memberRows.every(r => r.status === 'submitted')).toBe(true)
    const admin = await api('GET', `/v1/reports/daily?scope=team&date=${date}`, { as: ADMIN })
    expect((admin.json.data as { status: string; memberId: string | null }[]).some(r => r.status === 'draft' && r.memberId === HR)).toBe(true)
  })

  it('日報参照権限: role deny で対象者の日報が scope=all/team・チャットボット文脈・週次集計から除外される', async () => {
    const date = '2026-06-02' // 週初め 2026-06-01（月曜）の週
    await api('PUT', '/v1/reports/daily', {
      as: HR, body: { date, entries: [{ theme: '7h参照権限', task: '提出済み作業', hours: 2, progress: 100 }], status: 'submitted' },
    })
    // ルールなし: MEMBER から見える（正の対照）
    const before = await api('GET', '/v1/reports/daily?scope=all&month=2026-06', { as: MEMBER })
    expect((before.json.data as { memberId: string | null }[]).some(r => r.memberId === HR)).toBe(true)
    const ctxBefore = await buildContext(pool, memberUser, '人事 花子さんの日報は?', await activePermissionRules(pool))
    expect(ctxBefore).toContain('人事 花子 さんの日報')

    const ruleRes = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'member', resource: 'reports', field: `member:${HR}`, effect: 'deny' },
    })
    const ruleId = (ruleRes.json.data as { id: string }).id
    clearPermissionCache()
    try {
      const after = await api('GET', '/v1/reports/daily?scope=all&month=2026-06', { as: MEMBER })
      expect((after.json.data as { memberId: string | null }[]).some(r => r.memberId === HR)).toBe(false)
      const team = await api('GET', `/v1/reports/daily?scope=team&date=${date}`, { as: MEMBER })
      expect((team.json.data as { memberId: string | null }[]).some(r => r.memberId === HR)).toBe(false)
      // 管理者（ロール対象外）は不変
      const adm = await api('GET', '/v1/reports/daily?scope=all&month=2026-06', { as: ADMIN })
      expect((adm.json.data as { memberId: string | null }[]).some(r => r.memberId === HR)).toBe(true)
      // 自分の日報（scope=mine）は影響を受けない
      const mine = await api('GET', `/v1/reports/daily?month=2026-06`, { as: HR })
      expect((mine.json.data as { memberId: string | null }[]).some(r => r.memberId === HR)).toBe(true)
      // チャットボット文脈にも供給されない
      const ctx = await buildContext(pool, memberUser, '人事 花子さんの日報は?', await activePermissionRules(pool))
      expect(ctx).not.toContain('人事 花子 さんの日報')
      // 週次集計（バッチ7j: 保管された全体レポートの配信時マスク）からも除外される
      await api('POST', '/v1/reports/weekly-insight', { as: ADMIN, body: { weekStart: '2026-06-01' } })
      interface CompanyMetrics { company: { metrics: { memberHours: { name: string }[] } } }
      const insight = await api('GET', '/v1/reports/weekly-insight?weekStart=2026-06-01', { as: MEMBER })
      const names = (insight.json.data as CompanyMetrics).company.metrics.memberHours.map(x => x.name)
      expect(names).not.toContain('人事 花子')
      const admInsight = await api('GET', '/v1/reports/weekly-insight?weekStart=2026-06-01', { as: ADMIN })
      const admNames = (admInsight.json.data as CompanyMetrics).company.metrics.memberHours.map(x => x.name)
      expect(admNames).toContain('人事 花子')
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('コメントスレッドにも参照ガード（PR #57 R1 M-3）: 他人の下書きは 404・参照 deny 対象者は提出済みでも 404', async () => {
    const admin = await api('GET', '/v1/reports/daily?scope=team&from=2026-06-01&to=2026-06-02', { as: ADMIN })
    const rows = admin.json.data as { id: string; status: string; memberId: string | null }[]
    const draft = rows.find(r => r.memberId === HR && r.status === 'draft')
    const submitted = rows.find(r => r.memberId === HR && r.status === 'submitted')
    expect(draft && submitted).toBeTruthy()
    // 他人の下書きのコメントは存在秘匿（404）。管理者・提出済みは参照可
    expect((await api('GET', `/v1/reports/${draft!.id}/comments`, { as: MEMBER })).status).toBe(404)
    expect((await api('GET', `/v1/reports/${draft!.id}/comments`, { as: ADMIN })).status).toBe(200)
    expect((await api('GET', `/v1/reports/${submitted!.id}/comments`, { as: MEMBER })).status).toBe(200)
    const ruleRes = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'member', resource: 'reports', field: `member:${HR}`, effect: 'deny' },
    })
    const ruleId = (ruleRes.json.data as { id: string }).id
    clearPermissionCache()
    try {
      expect((await api('GET', `/v1/reports/${submitted!.id}/comments`, { as: MEMBER })).status).toBe(404)
      expect((await api('POST', `/v1/reports/${submitted!.id}/comments`, { as: MEMBER, body: { body: '見えないはず' } })).status).toBe(404)
      // 本人は deny があっても自分の日報のコメントを参照できる
      expect((await api('GET', `/v1/reports/${submitted!.id}/comments`, { as: HR })).status).toBe(200)
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })
})

describe('バッチ7l: ドキュメント管理の本実装（オペレーター指示 2026-07-19 #14）', () => {
  let folderId = ''
  let fileId = ''
  const fileBody = 'アケボノ商事向け提案書の骨子。\n\n- SCM プラットフォームの導入効果\n- 月次レポート自動化の提案'

  it('フォルダ作成 → 同名重複は 409・親不正は 400', async () => {
    const res = await api('POST', '/v1/documents/folders', { as: MEMBER, body: { name: '提案資料' } })
    expect(res.status).toBe(201)
    folderId = (res.json.data as { id: string }).id
    const dup = await api('POST', '/v1/documents/folders', { as: MEMBER, body: { name: '提案資料' } })
    expect(dup.status).toBe(409)
    expect(dup.json.error?.code).toBe('AKO-DOC-003')
    const bad = await api('POST', '/v1/documents/folders', { as: MEMBER, body: { name: 'x', parentId: 'doc-nai' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.code).toBe('AKO-DOC-005')
  })

  it('アップロード（DB フォールバック保管）→ 一覧 → base64 ダウンロードの往復', async () => {
    const res = await api('POST', '/v1/documents/files', {
      as: MEMBER,
      body: {
        filename: '提案骨子.md',
        contentBase64: Buffer.from(fileBody).toString('base64'),
        parentId: folderId,
        tags: ['提案書'],
        summary: 'アケボノ商事向けの提案骨子',
      },
    })
    expect(res.status).toBe(201)
    const created = res.json.data as { id: string; extracted: boolean }
    fileId = created.id
    expect(created.extracted).toBe(true)

    const list = (await api('GET', '/v1/documents', { as: MEMBER })).json.data as Record<string, unknown>[]
    const row = list.find(r => r.id === fileId)!
    expect(row).toBeTruthy()
    expect(row.parentId).toBe(folderId)
    expect(row.kind).toBe('file')
    expect(row.hasText).toBe(true)
    expect(row.downloadable).toBe(true)
    expect(String(row.size)).toMatch(/KB|MB/)

    const dl = await api('GET', `/v1/documents/files/${fileId}`, { as: MEMBER })
    expect(dl.status).toBe(200)
    const data = dl.json.data as { filename: string; contentBase64: string }
    expect(data.filename).toBe('提案骨子.md')
    expect(Buffer.from(data.contentBase64, 'base64').toString('utf8')).toBe(fileBody)
  })

  it('署名 URL は DB 保管では null（クライアントは base64 経路へ縮退）', async () => {
    const res = await api('POST', `/v1/documents/files/${fileId}/url`, { as: MEMBER })
    expect(res.status).toBe(200)
    expect((res.json.data as { url: string | null }).url).toBeNull()
  })

  it('検索インデックスへ document ソースとして載る（AI 参照対象）', async () => {
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const { rows } = await pool.query(
      `SELECT title, body FROM search_docs WHERE source_kind = 'document' AND source_id = $1`, [fileId])
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('提案骨子.md')
    expect(String(rows[0].body)).toContain('SCM プラットフォーム')
  })

  it('メタ更新（名称・タグ）と移動、フォルダの循環移動は 400', async () => {
    const sub = await api('POST', '/v1/documents/folders', { as: MEMBER, body: { name: '2026', parentId: folderId } })
    const subId = (sub.json.data as { id: string }).id
    expect((await api('PATCH', `/v1/documents/${fileId}`, {
      as: MEMBER, body: { name: '提案骨子_v2.md', parentId: subId },
    })).status).toBe(200)
    const cyc = await api('PATCH', `/v1/documents/${folderId}`, { as: MEMBER, body: { parentId: subId } })
    expect(cyc.status).toBe(400)
    expect(cyc.json.error?.code).toBe('AKO-DOC-005')
  })

  it('アーカイブで検索インデックスから消え、復元で戻る（原則 9.5）', async () => {
    expect((await api('POST', `/v1/documents/${fileId}/archive`, { as: MEMBER })).status).toBe(200)
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const gone = await pool.query(
      `SELECT 1 FROM search_docs WHERE source_kind = 'document' AND source_id = $1`, [fileId])
    expect(gone.rows).toHaveLength(0)

    expect((await api('POST', `/v1/documents/${fileId}/restore`, { as: MEMBER })).status).toBe(200)
    await api('POST', '/v1/search/reindex', { as: ADMIN })
    const back = await pool.query(
      `SELECT 1 FROM search_docs WHERE source_kind = 'document' AND source_id = $1`, [fileId])
    expect(back.rows).toHaveLength(1)
  })

  it('documents.summary の表示項目 deny で原本・URL が 403（deny の迂回防止）', async () => {
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'member', resource: 'documents', field: 'summary', effect: 'deny' },
    })
    expect(rule.status).toBe(201)
    const ruleId = (rule.json.data as { id: string }).id
    clearPermissionCache()
    try {
      expect((await api('GET', `/v1/documents/files/${fileId}`, { as: MEMBER })).status).toBe(403)
      expect((await api('POST', `/v1/documents/files/${fileId}/url`, { as: MEMBER })).status).toBe(403)
      // 管理者は対象外・一覧の summary は剥がされる
      expect((await api('GET', `/v1/documents/files/${fileId}`, { as: ADMIN })).status).toBe(200)
      const list = (await api('GET', '/v1/documents', { as: MEMBER })).json.data as Record<string, unknown>[]
      const row = list.find(r => r.id === fileId)!
      expect(row.summary ?? '').toBe('')
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('documents 機能ガード: ロール deny で /v1/documents 全体が 403', async () => {
    const rule = await api('POST', '/v1/masters/permission-rules', {
      as: ADMIN,
      body: { subjectKind: 'role', subjectId: 'member', resource: 'documents', effect: 'deny' },
    })
    const ruleId = (rule.json.data as { id: string }).id
    clearPermissionCache()
    try {
      const res = await api('GET', '/v1/documents', { as: MEMBER })
      expect(res.status).toBe(403)
      expect(res.json.error?.code).toBe('AKO-PRM-001')
      expect((await api('GET', '/v1/documents', { as: ADMIN })).status).toBe(200)
    } finally {
      await api('POST', `/v1/masters/permission-rules/${ruleId}/archive`, { as: ADMIN })
      clearPermissionCache()
    }
  })

  it('ドライブ連携: OAuth 未設定環境では 409（AKO-DOC-006）・status は available=false', async () => {
    const status = await api('GET', '/v1/documents/drive/status', { as: MEMBER })
    expect(status.status).toBe(200)
    expect((status.json.data as { available: boolean }).available).toBe(false)
    const files = await api('GET', '/v1/documents/drive/files', { as: MEMBER })
    expect(files.status).toBe(409)
    expect(files.json.error?.code).toBe('AKO-DOC-006')
    const imp = await api('POST', '/v1/documents/drive/import', { as: MEMBER, body: { fileIds: ['x'] } })
    expect(imp.status).toBe(409)
  })

  it('サイズ超過は AKO-DOC-004・空 body は 400', async () => {
    const big = 'A'.repeat(11 * 1024 * 1024)
    const res = await api('POST', '/v1/documents/files', {
      as: MEMBER, body: { filename: 'big.txt', contentBase64: Buffer.from(big).toString('base64') },
    })
    expect([400, 413]).toContain(res.status)
    const empty = await api('POST', '/v1/documents/files', { as: MEMBER, body: { filename: 'empty.txt', contentBase64: '' } })
    expect(empty.status).toBe(400)
  })
})

describe('オペレーター指示 2026-07-22: 明日の予定・全員の週報・全員のタイムカード権限・稟議の目的/内容', () => {
  it('日報の明日の予定（tomorrow_plans）は正規化（空行除去・0.25h 刻み・最大 3 件）して保存され GET で往復する', async () => {
    const put = await api('PUT', '/v1/reports/daily', {
      as: MEMBER,
      body: {
        date: '2026-03-02',
        entries: [{ theme: 'テスト', task: '実装', hours: 2, progress: 50 }],
        reflection: '', issues: '', tomorrow: '',
        tomorrowPlans: [
          { theme: 'A', purpose: 'P1', task: 'T1', hours: 1.1 }, // 1.1 → 1.0（0.25h 刻み）
          { theme: 'B', purpose: '', task: 'T2', hours: 2 },
          { theme: '', purpose: '', task: '', hours: 3 }, // 空行 → 除去
          { theme: 'C', purpose: 'P3', task: 'T3', hours: 3 },
          { theme: 'D', purpose: 'P4', task: 'T4', hours: 4 }, // 上限 3 件で切り捨て
        ],
        status: 'submitted',
      },
    })
    expect(put.status).toBe(200)
    const list = await api('GET', '/v1/reports/daily?month=2026-03', { as: MEMBER })
    const row = (list.json.data as { date: string; tomorrowPlans: unknown }[]).find(r => r.date === '2026-03-02')
    expect(row?.tomorrowPlans).toEqual([
      { theme: 'A', purpose: 'P1', task: 'T1', hours: 1 },
      { theme: 'B', purpose: '', task: 'T2', hours: 2 },
      { theme: 'C', purpose: 'P3', task: 'T3', hours: 3 },
    ])
  })

  it('全員の週報（scope=all）は提出済みのみ・weekStart で単週に絞り込み・F-16-6 deny を適用する', async () => {
    const ws = '2026-03-02' // 月曜
    await api('PUT', '/v1/reports/weekly', {
      as: HR, body: { weekStart: ws, goalReview: '', mainWork: 'HR 週次', issues: '', nextWeek: '', status: 'submitted' },
    })
    await api('PUT', '/v1/reports/weekly', {
      as: ADMIN, body: { weekStart: ws, goalReview: '', mainWork: '下書き', issues: '', nextWeek: '', status: 'draft' },
    })
    expect((await api('GET', '/v1/reports/weekly?scope=all&weekStart=bad', { as: MEMBER })).status).toBe(400)

    const r = await api('GET', `/v1/reports/weekly?scope=all&weekStart=${ws}`, { as: MEMBER })
    expect(r.status).toBe(200)
    const rows = r.json.data as { memberId: string; status: string; weekStart: string }[]
    expect(rows.some(x => x.memberId === HR && x.status === 'submitted')).toBe(true)
    expect(rows.some(x => x.status === 'draft')).toBe(false) // 下書きは本人以外に見せない
    expect(rows.every(x => x.weekStart === ws)).toBe(true) // 単週絞り込み

    // F-16-6: member ロールへ HR の参照 deny → 一覧から消える（日報と同じ参照対象ルール）
    await pool.query(
      `INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
       VALUES ('pr-test-wk-view', 'role', 'member', 'reports', 'member:${HR}', 'deny', true)`)
    clearPermissionCache()
    try {
      const denied = await api('GET', `/v1/reports/weekly?scope=all&weekStart=${ws}`, { as: MEMBER })
      expect((denied.json.data as { memberId: string }[]).some(x => x.memberId === HR)).toBe(false)
      // 管理者側は影響なし（レイヤ = role member のみ）
      const adminView = await api('GET', `/v1/reports/weekly?scope=all&weekStart=${ws}`, { as: ADMIN })
      expect((adminView.json.data as { memberId: string }[]).some(x => x.memberId === HR)).toBe(true)
    } finally {
      await pool.query(`DELETE FROM permission_rules WHERE id = 'pr-test-wk-view'`)
      clearPermissionCache()
    }
  })

  it('全員のタイムカードは権限表で制御（既定 = 管理者/人事・allow で一般へ付与・deny で人事から剥奪 = AKO-ATT-004）', async () => {
    const today = todayJst()
    const path = `/v1/attendance/timecard?from=${today}&to=${today}`
    // 既定（ルールなし）= 従来のロールガードと同値
    expect((await api('GET', path, { as: MEMBER })).status).toBe(403)
    expect((await api('GET', path, { as: HR })).status).toBe(200)
    expect((await api('GET', path, { as: ADMIN })).status).toBe(200)

    await pool.query(
      `INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active) VALUES
        ('pr-test-tc-member', 'role', 'member', 'attendance', 'timecard-all', 'allow', true),
        ('pr-test-tc-hr', 'role', 'hr', 'attendance', 'timecard-all', 'deny', true)`)
    clearPermissionCache()
    try {
      expect((await api('GET', path, { as: MEMBER })).status).toBe(200) // allow ルールで一般へ付与
      const hrDenied = await api('GET', path, { as: HR })
      expect(hrDenied.status).toBe(403) // deny ルールで人事の既定を剥奪
      expect(hrDenied.json.error?.code).toBe('AKO-ATT-004')
      expect((await api('GET', path, { as: ADMIN })).status).toBe(200) // 他ロールへは波及しない
    } finally {
      await pool.query(`DELETE FROM permission_rules WHERE id IN ('pr-test-tc-member', 'pr-test-tc-hr')`)
      clearPermissionCache()
    }
  })

  it('稟議の目的・内容が下書き保存で往復する（新規の body は空 = purpose/content が正）', async () => {
    const draft = await api('PUT', '/v1/workflows/draft', {
      as: MEMBER,
      body: { category: 'other', title: '目的内容の検証', amount: 0, purpose: '目的テスト', content: '# 現状と課題\n・検証', attachments: [] },
    })
    expect(draft.status).toBe(201)
    const id = (draft.json.data as { id: string }).id
    const list = await api('GET', '/v1/workflows', { as: MEMBER })
    const row = (list.json.data as { id: string; purpose: string; content: string; body: string }[]).find(x => x.id === id)
    expect(row?.purpose).toBe('目的テスト')
    expect(row?.content).toBe('# 現状と課題\n・検証')
    expect(row?.body).toBe('')
  })
})

describe('メディア分析 F-40（独立チャンネル + 任意の業態連携。GA/設定/記事/生成/インサイト/外部記事）', () => {
  let LINKED = '' // 連携チャンネル（segmentId = 'seg-media-linked'）
  let SOLO = ''   // 単体チャンネル（segmentId = null）

  it('チャンネル作成: name 必須（020）・作成は管理者のみ・連携/単体を一覧で区別', async () => {
    // name 無しは AKO-MEDIA-020
    const bad = await api('POST', '/v1/media/channels', { as: ADMIN, body: { segmentId: 'seg-media-linked' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.code).toBe('AKO-MEDIA-020')
    // 作成は管理者のみ
    const denied = await api('POST', '/v1/media/channels', { as: MEMBER, body: { name: 'x' } })
    expect(denied.status).toBe(403)
    // 連携チャンネル（業態連携あり）
    const linked = await api('POST', '/v1/media/channels', { as: ADMIN, body: { name: '連携メディア', segmentId: 'seg-media-linked' } })
    expect(linked.status).toBe(201)
    LINKED = (linked.json.data as { id: string; segmentId: string | null }).id
    expect((linked.json.data as { segmentId: string | null }).segmentId).toBe('seg-media-linked')
    // 単体チャンネル（連携は必須でない）
    const solo = await api('POST', '/v1/media/channels', { as: ADMIN, body: { name: '単体メディア' } })
    expect(solo.status).toBe(201)
    SOLO = (solo.json.data as { id: string; segmentId: string | null }).id
    expect((solo.json.data as { segmentId: string | null }).segmentId).toBeNull()
    // 一覧に両方出る（GA 未設定 = gaConnected false）
    const list = await api('GET', '/v1/media/channels', { as: MEMBER })
    const rows = list.json.data as { id: string; segmentId: string | null; gaConnected: boolean }[]
    expect(rows.find(c => c.id === LINKED)).toMatchObject({ segmentId: 'seg-media-linked', gaConnected: false })
    expect(rows.find(c => c.id === SOLO)).toMatchObject({ segmentId: null, gaConnected: false })
  })

  it('GA 未設定環境: status は enabled=false・集計/同意 URL は AKO-MEDIA-005', async () => {
    const status = await api('GET', `/v1/media/status?channelId=${LINKED}`, { as: MEMBER })
    expect(status.status).toBe(200)
    expect(status.json.data).toMatchObject({ enabled: false, connected: false })
    const metrics = await api('GET', `/v1/media/metrics?channelId=${LINKED}`, { as: MEMBER })
    expect(metrics.status).toBe(409)
    expect(metrics.json.error?.code).toBe('AKO-MEDIA-005')
    const url = await api('GET', `/v1/media/oauth/url?channelId=${LINKED}`, { as: ADMIN })
    expect(url.status).toBe(409)
    expect(url.json.error?.code).toBe('AKO-MEDIA-005')
  })

  it('チャンネル設定: 部分更新は送ったキーのみ上書き = 送っていないフィールドが保持される（Zod v4 注意の回帰）', async () => {
    // 全設定を保存
    const first = await api('PUT', '/v1/media/settings', {
      as: ADMIN,
      body: {
        channelId: LINKED, siteName: '暮らしの器マガジン', siteUrl: 'https://example.com',
        analysisGoal: 'conversion', targetAudience: '30〜50 代', defaultTone: 'friendly',
        keywords: ['器', '選び方'],
      },
    })
    expect(first.status).toBe(200)
    // siteName のみ送る部分更新
    const patch = await api('PUT', '/v1/media/settings', {
      as: ADMIN, body: { channelId: LINKED, siteName: '暮らしの器マガジン（改）' },
    })
    expect(patch.status).toBe(200)
    const got = await api('GET', `/v1/media/settings?channelId=${LINKED}`, { as: MEMBER })
    const row = got.json.data as { siteName: string; siteUrl: string; analysisGoal: string; targetAudience: string; defaultTone: string; keywords: string[]; segmentId: string | null }
    expect(row.siteName).toBe('暮らしの器マガジン（改）')
    // 送っていないフィールドが既定値で上書きされていないこと（部分更新の要）
    expect(row.siteUrl).toBe('https://example.com')
    expect(row.analysisGoal).toBe('conversion')
    expect(row.targetAudience).toBe('30〜50 代')
    expect(row.defaultTone).toBe('friendly')
    expect(row.keywords).toEqual(['器', '選び方'])
    expect(row.segmentId).toBe('seg-media-linked') // 連携も保持
  })

  it('設定・チャンネル編集は管理者のみ（AKO-AUTH-003）・不正な区分値は AKO-GEN-001・未存在は 021', async () => {
    const denied = await api('PUT', '/v1/media/settings', { as: MEMBER, body: { channelId: LINKED, siteName: 'x' } })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-AUTH-003')
    const bad = await api('PUT', '/v1/media/settings', { as: ADMIN, body: { channelId: LINKED, analysisGoal: 'hack' } })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.code).toBe('AKO-GEN-001')
    const missing = await api('PUT', '/v1/media/settings', { as: ADMIN, body: { channelId: 'mc-nope', siteName: 'x' } })
    expect(missing.status).toBe(404)
    expect(missing.json.error?.code).toBe('AKO-MEDIA-021')
  })

  it('記事インベントリ: 手動登録（管理者）→ 一覧 → 取消（論理削除）→ 復元（原則9.5）', async () => {
    const denied = await api('POST', '/v1/media/articles', {
      as: MEMBER, body: { channelId: LINKED, path: '/x', title: 'x', section: 'ブログ', publishedAt: '2026-01-01' },
    })
    expect(denied.status).toBe(403)
    const created = await api('POST', '/v1/media/articles', {
      as: ADMIN,
      body: { channelId: LINKED, path: '/blog/utsuwa', title: '器の選び方', section: 'ブログ', publishedAt: '2026-01-10', wordCount: 2000 },
    })
    expect(created.status).toBe(201)
    const articleId = (created.json.data as { id: string }).id
    const list = await api('GET', `/v1/media/articles?channelId=${LINKED}`, { as: MEMBER })
    expect((list.json.data as { id: string }[]).some(a => a.id === articleId)).toBe(true)
    // 取消 → 既定一覧から消える（includeInactive では見える）→ 復元
    expect((await api('POST', `/v1/media/articles/${articleId}/deactivate`, { as: ADMIN })).status).toBe(200)
    const afterDeact = await api('GET', `/v1/media/articles?channelId=${LINKED}`, { as: MEMBER })
    expect((afterDeact.json.data as { id: string }[]).some(a => a.id === articleId)).toBe(false)
    const withInactive = await api('GET', `/v1/media/articles?channelId=${LINKED}&includeInactive=1`, { as: MEMBER })
    expect((withInactive.json.data as { id: string }[]).some(a => a.id === articleId)).toBe(true)
    expect((await api('POST', `/v1/media/articles/${articleId}/restore`, { as: ADMIN })).status).toBe(200)
  })

  it('記事の手動登録は同一パスの重複を 409（AKO-MEDIA-008）で拒否・取消後は再登録可・復元は衝突で 409（m5 = 冪等）', async () => {
    const body = { channelId: LINKED, path: '/blog/dup-check', title: '重複検証', section: 'ブログ', publishedAt: '2026-02-01' }
    const first = await api('POST', '/v1/media/articles', { as: ADMIN, body })
    expect(first.status).toBe(201)
    const firstId = (first.json.data as { id: string }).id
    const dup = await api('POST', '/v1/media/articles', { as: ADMIN, body })
    expect(dup.status).toBe(409)
    expect(dup.json.error?.code).toBe('AKO-MEDIA-008')
    expect((await api('POST', `/v1/media/articles/${firstId}/deactivate`, { as: ADMIN })).status).toBe(200)
    const second = await api('POST', '/v1/media/articles', { as: ADMIN, body })
    expect(second.status).toBe(201)
    const restore = await api('POST', `/v1/media/articles/${firstId}/restore`, { as: ADMIN })
    expect(restore.status).toBe(409)
    expect(restore.json.error?.code).toBe('AKO-MEDIA-008')
  })

  it('単体チャンネルでも記事生成が動く（要件1）→ 採用 → 二重採用 no-op → 採用取消 → 取消 → 復元', async () => {
    // 未連携（単体）チャンネルでも AI 記事生成・採用が利用できること（連携は必須でない）
    const gen = await api('POST', '/v1/media/articles/generate', {
      as: MEMBER,
      body: {
        channelId: SOLO, topic: '器の手入れ', keyword: '陶磁器 手入れ',
        purpose: 'seo', quality: 'standard', tone: 'friendly', segmentName: '単体メディア',
      },
    })
    expect(gen.status).toBe(201)
    const article = gen.json.data as { id: string; title: string; body: string; llm: boolean; adoptedArticleId: string | null; channelId: string }
    expect(article.llm).toBe(false) // LLM 無効環境 = 決定的フォールバック（原則4）
    expect(article.channelId).toBe(SOLO)
    expect(article.body).toContain('器の手入れ')
    expect(article.adoptedArticleId).toBeNull()

    const empty = await api('POST', '/v1/media/articles/generate', {
      as: MEMBER, body: { channelId: SOLO, topic: '', keyword: '', purpose: 'seo', quality: 'draft', tone: 'formal' },
    })
    expect(empty.status).toBe(400)
    expect(empty.json.error?.code).toBe('AKO-MEDIA-011')

    const adopt = await api('POST', `/v1/media/generated/${article.id}/adopt`, { as: MEMBER, body: { section: 'ブログ' } })
    expect(adopt.status).toBe(200)
    const adoptedId = (adopt.json.data as { articleId: string }).articleId
    const inv = await api('GET', `/v1/media/articles?channelId=${SOLO}`, { as: MEMBER })
    const invRow = (inv.json.data as { id: string; origin: string; generatedArticleId: string }[]).find(a => a.id === adoptedId)
    expect(invRow?.origin).toBe('generated')
    expect(invRow?.generatedArticleId).toBe(article.id)

    const again = await api('POST', `/v1/media/generated/${article.id}/adopt`, { as: MEMBER, body: { section: 'ブログ' } })
    expect(again.status).toBe(200)
    expect((again.json.data as { warning?: string }).warning).toBeTruthy()
    expect((again.json.data as { articleId: string }).articleId).toBe(adoptedId)

    expect((await api('POST', `/v1/media/generated/${article.id}/unadopt`, { as: MEMBER })).status).toBe(200)
    const unadoptTwice = await api('POST', `/v1/media/generated/${article.id}/unadopt`, { as: MEMBER })
    expect(unadoptTwice.status).toBe(400)
    expect(unadoptTwice.json.error?.code).toBe('AKO-MEDIA-014')

    expect((await api('POST', `/v1/media/generated/${article.id}/remove`, { as: MEMBER })).status).toBe(200)
    const listAll = await api('GET', `/v1/media/generated?channelId=${SOLO}`, { as: MEMBER })
    const g = (listAll.json.data as { id: string; active: boolean }[]).find(x => x.id === article.id)
    expect(g?.active).toBe(false)
    expect((await api('POST', `/v1/media/generated/${article.id}/restore`, { as: MEMBER })).status).toBe(200)
  })

  it('外部投稿記事: CRUD（追加は管理者のみ・title/body 必須 = 023）・取消/復元（原則9.5）', async () => {
    // 追加は管理者のみ
    const denied = await api('POST', '/v1/media/external-articles', { as: MEMBER, body: { channelId: LINKED, title: 't', body: 'b' } })
    expect(denied.status).toBe(403)
    // title / body 必須（AKO-MEDIA-023）
    const noBody = await api('POST', '/v1/media/external-articles', { as: ADMIN, body: { channelId: LINKED, title: 'タイトルのみ' } })
    expect(noBody.status).toBe(400)
    expect(noBody.json.error?.code).toBe('AKO-MEDIA-023')
    // 正常登録
    const created = await api('POST', '/v1/media/external-articles', {
      as: ADMIN,
      body: { channelId: LINKED, title: '外部寄稿の器コラム', source: '暮らしメディア', publishedAt: '2026-03-01', body: '外部媒体へ投稿した記事の原文です。', notes: 'メモ' },
    })
    expect(created.status).toBe(201)
    const xid = (created.json.data as { id: string }).id
    const list = await api('GET', `/v1/media/external-articles?channelId=${LINKED}`, { as: MEMBER })
    expect((list.json.data as { id: string; title: string }[]).find(x => x.id === xid)?.title).toBe('外部寄稿の器コラム')
    // 編集
    const patched = await api('PATCH', `/v1/media/external-articles/${xid}`, {
      as: ADMIN, body: { title: '外部寄稿の器コラム（改）', body: '更新した原文', source: '', publishedAt: '' },
    })
    expect(patched.status).toBe(200)
    expect((patched.json.data as { title: string; publishedAt: string | null }).title).toBe('外部寄稿の器コラム（改）')
    // 取消 → 既定一覧から消える（includeInactive で見える）→ 復元
    expect((await api('POST', `/v1/media/external-articles/${xid}/archive`, { as: ADMIN })).status).toBe(200)
    const afterArch = await api('GET', `/v1/media/external-articles?channelId=${LINKED}`, { as: MEMBER })
    expect((afterArch.json.data as { id: string }[]).some(x => x.id === xid)).toBe(false)
    const withInactive = await api('GET', `/v1/media/external-articles?channelId=${LINKED}&includeInactive=1`, { as: MEMBER })
    expect((withInactive.json.data as { id: string }[]).some(x => x.id === xid)).toBe(true)
    expect((await api('POST', `/v1/media/external-articles/${xid}/restore`, { as: ADMIN })).status).toBe(200)
    // 未存在は 024
    const missing = await api('POST', '/v1/media/external-articles/mx-nope/archive', { as: ADMIN })
    expect(missing.status).toBe(404)
    expect(missing.json.error?.code).toBe('AKO-MEDIA-024')
  })

  it('統合インサイト: 連携チャンネルはサーバー組み立てで生成・保管（upsert）。単体は AKO-MEDIA-022、scope=media は GA 未設定で 409', async () => {
    // 連携チャンネル（seg-media-linked。売上なし + GA 未連携 = 全軸 0 の器で生成）
    const gen = await api('POST', '/v1/media/insights/generate', {
      as: MEMBER, body: { channelId: LINKED, scope: 'integrated' },
    })
    expect(gen.status).toBe(200)
    const view = gen.json.data as { llm: boolean; periodKey: string; warning: string | null; metrics: { salesAmount: number; siteName: string } }
    expect(view.llm).toBe(false) // LLM 無効 = heuristicIntegratedInsight
    expect(view.periodKey).toMatch(/^\d{4}-\d{2}$/)
    expect(view.metrics.salesAmount).toBe(0)
    expect(view.metrics.siteName).toBe('暮らしの器マガジン（改）') // channel から解決
    expect(view.warning).toBeNull()

    // クライアントが metrics を送っても無視される（申告値は保管されない = 改ざん余地なし）
    const regen = await api('POST', '/v1/media/insights/generate', {
      as: MEMBER,
      body: { channelId: LINKED, scope: 'integrated', metrics: { salesAmount: 99999999, periodMonth: '2026-06' } },
    })
    expect(regen.status).toBe(200)
    expect((regen.json.data as { metrics: { salesAmount: number } }).metrics.salesAmount).toBe(0)
    // 再生成は upsert 上書き（レコードは 1 行のまま）
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM media_insights WHERE channel_id = $1 AND scope = 'integrated'`, [LINKED])
    expect(rows[0].n).toBe(1)

    const got = await api('GET', `/v1/media/insights?channelId=${LINKED}&scope=integrated`, { as: MEMBER })
    expect((got.json.data as { periodKey: string }).periodKey).toBe(view.periodKey)

    // 単体チャンネルは統合分析不可（連携必須。AKO-MEDIA-022）
    const soloIntegrated = await api('POST', '/v1/media/insights/generate', {
      as: MEMBER, body: { channelId: SOLO, scope: 'integrated' },
    })
    expect(soloIntegrated.status).toBe(400)
    expect(soloIntegrated.json.error?.code).toBe('AKO-MEDIA-022')
    const soloGet = await api('GET', `/v1/media/integrated?channelId=${SOLO}`, { as: MEMBER })
    expect(soloGet.status).toBe(400)
    expect(soloGet.json.error?.code).toBe('AKO-MEDIA-022')

    // scope=media はサーバーが GA から集計する = GA 未設定環境では 409（AKO-MEDIA-005）
    const media = await api('POST', '/v1/media/insights/generate', {
      as: MEMBER, body: { channelId: LINKED, scope: 'media' },
    })
    expect(media.status).toBe(409)
    expect(media.json.error?.code).toBe('AKO-MEDIA-005')
  })

  it('チャンネルの取消・復元（原則9.5。管理者のみ）', async () => {
    const denied = await api('POST', `/v1/media/channels/${SOLO}/archive`, { as: MEMBER })
    expect(denied.status).toBe(403)
    expect((await api('POST', `/v1/media/channels/${SOLO}/archive`, { as: ADMIN })).status).toBe(200)
    const list = await api('GET', '/v1/media/channels', { as: MEMBER })
    expect((list.json.data as { id: string }[]).some(c => c.id === SOLO)).toBe(false)
    const withInactive = await api('GET', '/v1/media/channels?includeInactive=1', { as: MEMBER })
    expect((withInactive.json.data as { id: string }[]).some(c => c.id === SOLO)).toBe(true)
    expect((await api('POST', `/v1/media/channels/${SOLO}/restore`, { as: ADMIN })).status).toBe(200)
    const missing = await api('POST', '/v1/media/channels/mc-nope/restore', { as: ADMIN })
    expect(missing.status).toBe(404)
    expect(missing.json.error?.code).toBe('AKO-MEDIA-021')
  })

  it('下位互換: channel.id = 旧 segment_id 値のチャンネルは、その値を channel_id に持つ子行（記事）を解決する', async () => {
    // 0048 の設計（channel.id = 旧 segment_id）の下位互換を検証する。旧 segment_id 値をそのまま id/連携先に
    // 持つチャンネルと、その値を channel_id に持つ子行（記事 = 列名 rename 後の既存データ相当）を直接投入し、
    // API がその値で子行を解決できることを確認する（child 行の UPDATE 不要 = 移行の要）。
    await pool.query(
      `INSERT INTO media_channels (id, name, segment_id, site_name) VALUES ('seg-01', '暮らしの器マガジン', 'seg-01', '暮らしの器マガジン')`)
    await pool.query(
      `INSERT INTO media_articles (id, channel_id, path, title, section, published_at)
       VALUES ('ma-compat-1', 'seg-01', '/legacy', '既存記事', 'ブログ', '2026-01-01')`)
    const list = await api('GET', '/v1/media/articles?channelId=seg-01', { as: MEMBER })
    expect((list.json.data as { id: string }[]).some(a => a.id === 'ma-compat-1')).toBe(true)
    const setting = await api('GET', '/v1/media/settings?channelId=seg-01', { as: MEMBER })
    expect((setting.json.data as { segmentId: string | null }).segmentId).toBe('seg-01')
  })
})

describe('Phase B: Akebono 設定系の API 永続化（業態マスタ・共通マスタ・アプリ設定・項目カスタマイズ）', () => {
  it('業態マスタ: モック互換シード（seg-01〜04）が投入され、部分 PATCH は未送信フィールドを保持する', async () => {
    const list = await api('GET', '/v1/masters/business-segments', { as: MEMBER })
    const rows = list.json.data as { id: string; name: string; industryType: string }[]
    expect(rows.map(r => r.id)).toEqual(expect.arrayContaining(['seg-01', 'seg-02', 'seg-03', 'seg-04']))
    expect(rows.find(r => r.id === 'seg-01')?.name).toBe('陶磁器委託販売')

    // 業態アプリ設定の部分パッチ（segments.vue 相当）= 送っていない name / industryType が保持されること
    const patch = await api('PATCH', '/v1/masters/business-segments/seg-01', {
      as: ADMIN, body: { appName: '器アプリ', defaultVariantAxis1Label: '窯元' },
    })
    expect(patch.status).toBe(200)
    const updated = patch.json.data as { name: string; industryType: string; appName: string; defaultVariantAxis1Label: string; defaultUnitId: string }
    expect(updated.appName).toBe('器アプリ')
    expect(updated.defaultVariantAxis1Label).toBe('窯元')
    expect(updated.name).toBe('陶磁器委託販売') // 未送信フィールドの保持（Zod v4 注意の回帰）
    expect(updated.industryType).toBe('retail')
    expect(updated.defaultUnitId).toBe('unit-02')
  })

  it('業態マスタ: アイコン画像は data:image base64 のみ許可（SVG 等は 400）・書込は管理者のみ', async () => {
    const bad = await api('PATCH', '/v1/masters/business-segments/seg-01', {
      as: ADMIN, body: { appIconImage: 'data:image/svg+xml;base64,PHN2Zz4=' },
    })
    expect(bad.status).toBe(400)
    const good = await api('PATCH', '/v1/masters/business-segments/seg-01', {
      as: ADMIN, body: { appIconImage: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    expect(good.status).toBe(200)
    const denied = await api('PATCH', '/v1/masters/business-segments/seg-01', {
      as: MEMBER, body: { appName: 'x' },
    })
    expect(denied.status).toBe(403)
  })

  it('共通マスタ 8 種: シード投入 + CRUD が汎用マスタとして動く（単位を追加 → 更新 → 無効化 → 復元）', async () => {
    const units = await api('GET', '/v1/masters/units', { as: MEMBER })
    expect((units.json.data as unknown[]).length).toBeGreaterThanOrEqual(5)
    const taxes = await api('GET', '/v1/masters/tax-rates', { as: MEMBER })
    expect((taxes.json.data as { id: string }[]).map(t => t.id)).toEqual(expect.arrayContaining(['tax-10', 'tax-08', 'tax-00']))

    const created = await api('POST', '/v1/masters/units', { as: ADMIN, body: { name: '箱', displayOrder: 9 } })
    expect(created.status).toBe(201)
    const id = (created.json.data as { id: string }).id
    expect((await api('PATCH', `/v1/masters/units/${id}`, { as: ADMIN, body: { name: '箱（12入）' } })).status).toBe(200)
    expect((await api('POST', `/v1/masters/units/${id}/archive`, { as: ADMIN })).status).toBe(200)
    expect((await api('POST', `/v1/masters/units/${id}/restore`, { as: ADMIN })).status).toBe(200)
  })

  it('画像セクション: 既定シード（is_seed）は無効化不可（AKO-AKB-002）・名称変更は可', async () => {
    const rename = await api('PATCH', '/v1/masters/product-image-sections/pis-01', {
      as: ADMIN, body: { name: '完成品画像' },
    })
    expect(rename.status).toBe(200)
    const archive = await api('POST', '/v1/masters/product-image-sections/pis-01/archive', { as: ADMIN })
    expect(archive.status).toBe(409)
    expect(archive.json.error?.code).toBe('AKO-AKB-002')
    // 追加分（is_seed=false）は無効化できる
    const created = await api('POST', '/v1/masters/product-image-sections', {
      as: ADMIN, body: { name: '着用画像' },
    })
    expect(created.status).toBe(201)
    const id = (created.json.data as { id: string }).id
    expect((await api('POST', `/v1/masters/product-image-sections/${id}/archive`, { as: ADMIN })).status).toBe(200)
  })

  it('画像セクション: POST の isSeed=true は 409（AKO-AKB-002）= 取消不能行を作らせない（レビュー B-1）', async () => {
    // 作れてしまうと archive が AKO-AKB-002 で恒久拒否・PATCH も isSeed を omit しており
    // SQL 直接操作でしか戻せない = 原則9.5 違反。leave-types の isStatutory ガードと同型
    const seedCreate = await api('POST', '/v1/masters/product-image-sections', {
      as: ADMIN, body: { name: '不正な既定シード', isSeed: true },
    })
    expect(seedCreate.status).toBe(409)
    expect(seedCreate.json.error?.code).toBe('AKO-AKB-002')
    // isSeed 省略（既定 false）の作成は従来どおり通る
    const normal = await api('POST', '/v1/masters/product-image-sections', {
      as: ADMIN, body: { name: '通常セクション' },
    })
    expect(normal.status).toBe(201)
    expect((normal.json.data as { isSeed: boolean }).isSeed).toBe(false)
  })

  it('業態×アプリ設定: バッチ upsert（複合キー・冪等）→ GET 反映。書込は管理者のみ・不正 rows は 400', async () => {
    const rows = [
      { segmentId: 'seg-01', appKey: 'products', enabled: true, labelOverride: null, source: 'preset' },
      { segmentId: 'seg-01', appKey: 'media', enabled: false, labelOverride: '器メディア', source: 'manual' },
      // 同一キーの重複行は後勝ちで畳まれる（ON CONFLICT の二重更新エラーにならない）
      { segmentId: 'seg-01', appKey: 'media', enabled: true, labelOverride: '器メディア', source: 'manual' },
    ]
    const put = await api('PUT', '/v1/akebono/app-configs', { as: ADMIN, body: { rows } })
    expect(put.status).toBe(200)
    const saved = put.json.data as { appKey: string; enabled: boolean; labelOverride: string | null }[]
    expect(saved).toHaveLength(2)
    expect(saved.find(r => r.appKey === 'media')).toMatchObject({ enabled: true, labelOverride: '器メディア' })

    // 再送は同じ結果（冪等）・更新は上書き
    const again = await api('PUT', '/v1/akebono/app-configs', {
      as: ADMIN,
      body: { rows: [{ segmentId: 'seg-01', appKey: 'media', enabled: false, labelOverride: null, source: 'manual' }] },
    })
    expect(again.status).toBe(200)
    const got = await api('GET', '/v1/akebono/app-configs', { as: MEMBER })
    const media = (got.json.data as { segmentId: string; appKey: string; enabled: boolean }[])
      .find(r => r.segmentId === 'seg-01' && r.appKey === 'media')
    expect(media?.enabled).toBe(false)

    expect((await api('PUT', '/v1/akebono/app-configs', { as: MEMBER, body: { rows } })).status).toBe(403)
    expect((await api('PUT', '/v1/akebono/app-configs', { as: ADMIN, body: { rows: [] } })).status).toBe(400)
  })

  it('項目カスタマイズ: 複合キーの部分 upsert（未送信フィールド保持）→ エンティティ単位リセット', async () => {
    const first = await api('PUT', '/v1/akebono/item-settings', {
      as: ADMIN, body: { entity: 'product', itemKey: 'listPrice', labelOverride: '販売価格' },
    })
    expect(first.status).toBe(200)
    // formVisible のみ送る部分更新 → labelOverride が保持されること
    const second = await api('PUT', '/v1/akebono/item-settings', {
      as: ADMIN, body: { entity: 'product', itemKey: 'listPrice', formVisible: false },
    })
    expect(second.status).toBe(200)
    const row = second.json.data as { formVisible: boolean; labelOverride: string; listVisible: boolean | null }
    expect(row.formVisible).toBe(false)
    expect(row.labelOverride).toBe('販売価格')
    expect(row.listVisible).toBeNull()

    // 別エンティティの差分はリセットの影響を受けない
    await api('PUT', '/v1/akebono/item-settings', {
      as: ADMIN, body: { entity: 'sales_record', itemKey: 'channel', listVisible: true },
    })
    const reset = await api('POST', '/v1/akebono/item-settings/reset', { as: ADMIN, body: { entity: 'product' } })
    expect(reset.status).toBe(200)
    expect((reset.json.data as { deleted: number }).deleted).toBe(1)
    const rest = await api('GET', '/v1/akebono/item-settings', { as: MEMBER })
    const rows = rest.json.data as { entity: string }[]
    expect(rows.some(r => r.entity === 'product')).toBe(false)
    expect(rows.some(r => r.entity === 'sales_record')).toBe(true)

    expect((await api('PUT', '/v1/akebono/item-settings', { as: MEMBER, body: { entity: 'product', itemKey: 'x', formVisible: true } })).status).toBe(403)
    expect((await api('PUT', '/v1/akebono/item-settings', { as: ADMIN, body: { entity: 'product', itemKey: 'x' } })).status).toBe(400)
  })
})

describe('Phase C: Akebono 記録系の API 永続化（商品・伝票・在庫・売上・請求・委託精算・統合メトリクス）', () => {
  // recentMonthKeys(6, 1) の最終月 = 直前の完了月（統合メトリクスの対象月）
  const prevMonth = (() => {
    const t = todayJst()
    const y = Number(t.slice(0, 4))
    const m = Number(t.slice(5, 7))
    const pm = m === 1 ? 12 : m - 1
    return `${m === 1 ? y - 1 : y}-${String(pm).padStart(2, '0')}`
  })()

  let storeId = ''
  let artistId = ''
  let productId = ''
  let defaultSkuId = ''

  it('商品: 作成で既定 SKU を自動生成・コード重複は 409・部分 PATCH は未送信フィールドを保持・マトリクス生成で既定 SKU 無効化', async () => {
    // 取引先（店舗・作家）を先に登録（companies の Akebono 拡張 partnerRoles = 0032 で物理列化）
    const store = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { name: '銀座テスト店', partnerRoles: ['store', 'customer'] },
    })
    expect(store.status).toBe(201)
    storeId = (store.json.data as { id: string }).id
    expect((store.json.data as { partnerRoles: string[] }).partnerRoles).toEqual(['store', 'customer'])
    const artist = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { name: 'テスト作家', partnerRoles: ['consignor_artist'] },
    })
    artistId = (artist.json.data as { id: string }).id

    const created = await api('POST', '/v1/akebono/products', {
      as: MEMBER,
      body: {
        code: 'CUP-001', name: '湯呑み', segmentId: 'seg-01', listPrice: 2400, standardCost: 800,
        taxRateId: 'tax-10', unitId: 'unit-02', defaultSupplierCompanyId: artistId, description: 'テスト商品',
      },
    })
    expect(created.status).toBe(201)
    productId = (created.json.data as { id: string }).id
    // 既定 SKU が自動生成される（XA-1）
    const skus = await api('GET', '/v1/akebono/product-skus', { as: MEMBER })
    const mine = (skus.json.data as { id: string; productId: string; isDefault: boolean; code: string }[])
      .filter(s => s.productId === productId)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.isDefault).toBe(true)
    expect(mine[0]!.code).toBe('CUP-001')
    defaultSkuId = mine[0]!.id

    // 同一セグメント × 有効行のコード重複は 409（AKO-PRD-002）
    const dup = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'CUP-001', name: '重複', segmentId: 'seg-01' },
    })
    expect(dup.status).toBe(409)
    expect(dup.json.error?.code).toBe('AKO-PRD-002')

    // 部分 PATCH: 送ったキーのみ更新（listPrice を変えても name / standardCost は保持）
    const patched = await api('PATCH', `/v1/akebono/products/${productId}`, {
      as: MEMBER, body: { listPrice: 2600 },
    })
    expect(patched.status).toBe(200)
    const prow = patched.json.data as { name: string; listPrice: number; standardCost: number; taxRateId: string }
    expect(prow.listPrice).toBe(2600)
    expect(prow.name).toBe('湯呑み')
    expect(prow.standardCost).toBe(800)
    expect(prow.taxRateId).toBe('tax-10')

    // SKU マトリクス生成（2 × 2）→ 既定 SKU は無効化・再実行は冪等（既存組合せはスキップ）
    const matrix = await api('POST', `/v1/akebono/products/${productId}/skus/matrix`, {
      as: MEMBER, body: { axis1Values: ['青', '白'], axis2Values: ['大', '小'] },
    })
    expect(matrix.status).toBe(200)
    expect((matrix.json.data as { created: number }).created).toBe(4)
    const again = await api('POST', `/v1/akebono/products/${productId}/skus/matrix`, {
      as: MEMBER, body: { axis1Values: ['青', '白'], axis2Values: ['大', '小'] },
    })
    expect((again.json.data as { created: number }).created).toBe(0)
    const skus2 = (await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as
      { productId: string; isDefault: boolean; active: boolean }[]
    const mine2 = skus2.filter(s => s.productId === productId)
    expect(mine2).toHaveLength(5)
    expect(mine2.find(s => s.isDefault)!.active).toBe(false)
  })

  it('商品画像: data URI の allowlist 検証（SVG 拒否 = AKO-PRD-004）・追加・セクション変更・取消/復元', async () => {
    const bad = await api('POST', `/v1/akebono/products/${productId}/images`, {
      as: MEMBER, body: { sectionId: 'pis-01', filename: 'x.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error?.code).toBe('AKO-PRD-004')

    const img = await api('POST', `/v1/akebono/products/${productId}/images`, {
      as: MEMBER, body: { sectionId: 'pis-01', filename: 'cup.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    expect(img.status).toBe(201)
    const imgId = (img.json.data as { id: string }).id
    expect((img.json.data as { displayOrder: number }).displayOrder).toBe(1)

    // 不存在セクションは 404
    expect((await api('POST', `/v1/akebono/products/${productId}/images`, {
      as: MEMBER, body: { sectionId: 'pis-none', filename: 'a.png', mime: 'image/png' },
    })).status).toBe(404)

    expect((await api('PATCH', `/v1/akebono/product-images/${imgId}`, { as: MEMBER, body: { sectionId: 'pis-02' } })).status).toBe(200)
    expect((await api('POST', `/v1/akebono/product-images/${imgId}/archive`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', `/v1/akebono/product-images/${imgId}/restore`, { as: MEMBER })).status).toBe(200)
  })

  it('発注 → 入荷予定 → 入荷実績（部分 → 完了）: 在庫台帳へ入庫・予定ステータス再計算・実績ありの予定取消は 409', async () => {
    const po = await api('POST', '/v1/akebono/purchase-orders', {
      as: MEMBER,
      body: {
        companyId: artistId, segmentId: 'seg-01', orderDate: todayJst(), dueDate: todayJst(),
        // 項目カスタマイズ（F-31）: custom を保存し GET で返す
        custom: { memo: '至急', priority: 3 },
        lines: [{ skuId: defaultSkuId, qty: 10, unitPrice: 800 }],
      },
    })
    expect(po.status).toBe(201)
    const poRow = po.json.data as { id: string; code: string; status: string; custom?: Record<string, unknown>; lines: { id: string }[] }
    expect(poRow.code).toMatch(/^PO-\d{4}$/)
    expect(poRow.status).toBe('ordered')
    expect(poRow.custom).toEqual({ memo: '至急', priority: 3 })

    // 状態機械: closed からの遷移は 409
    expect((await api('POST', `/v1/akebono/purchase-orders/${poRow.id}/status`, { as: MEMBER, body: { status: 'closed' } })).status).toBe(200)
    const bad = await api('POST', `/v1/akebono/purchase-orders/${poRow.id}/status`, { as: MEMBER, body: { status: 'ordered' } })
    expect(bad.status).toBe(409)
    expect(bad.json.error?.code).toBe('AKO-POR-003')

    const plan = await api('POST', '/v1/akebono/inbound-plans', {
      as: MEMBER,
      body: { poId: poRow.id, warehouseId: 'wh-01', dueDate: todayJst(), lines: [{ skuId: defaultSkuId, qty: 10 }] },
    })
    expect(plan.status).toBe(201)
    const planRow = plan.json.data as { id: string; lines: { id: string }[] }

    // 部分実績（4/10）→ partial + 在庫 +4
    const r1 = await api('POST', '/v1/akebono/inbound-results', {
      as: MEMBER,
      body: { planId: planRow.id, lines: [{ planLineId: planRow.lines[0]!.id, skuId: defaultSkuId, qty: 4 }] },
    })
    expect(r1.status).toBe(201)
    let plans = (await api('GET', '/v1/akebono/inbound-plans', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(plans.find(p => p.id === planRow.id)!.status).toBe('partial')

    // 実績ありの予定は取消不可
    const cancel = await api('POST', `/v1/akebono/inbound-plans/${planRow.id}/cancel`, { as: MEMBER })
    expect(cancel.status).toBe(409)
    expect(cancel.json.error?.code).toBe('AKO-INB-003')

    // 残り（6/10）→ completed + 在庫 +10
    await api('POST', '/v1/akebono/inbound-results', {
      as: MEMBER,
      body: { planId: planRow.id, lines: [{ planLineId: planRow.lines[0]!.id, skuId: defaultSkuId, qty: 6 }] },
    })
    plans = (await api('GET', '/v1/akebono/inbound-plans', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(plans.find(p => p.id === planRow.id)!.status).toBe('completed')
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number; kind: string }[]
    const balance = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    expect(balance).toBe(10)
  })

  it('在庫: 調整・倉庫間移動（不足は 409）・棚卸差分', async () => {
    // 調整 −2 → 残 8
    expect((await api('POST', '/v1/akebono/inventory/adjust', {
      as: MEMBER, body: { skuId: defaultSkuId, warehouseId: 'wh-01', qty: -2, reason: 'defective' },
    })).status).toBe(201)
    // 移動: 残高不足は 409
    const ng = await api('POST', '/v1/akebono/inventory/transfer', {
      as: MEMBER, body: { skuId: defaultSkuId, fromWarehouseId: 'wh-01', toWarehouseId: 'wh-02', qty: 100 },
    })
    expect(ng.status).toBe(409)
    expect(ng.json.error?.code).toBe('AKO-INV-004')
    // 移動 3 → wh-01: 5 / wh-02: 3
    expect((await api('POST', '/v1/akebono/inventory/transfer', {
      as: MEMBER, body: { skuId: defaultSkuId, fromWarehouseId: 'wh-01', toWarehouseId: 'wh-02', qty: 3 },
    })).status).toBe(201)
    // 棚卸: wh-01 実棚 6（理論 5）→ +1 調整
    const st = await api('POST', '/v1/akebono/inventory/stocktake', {
      as: MEMBER, body: { warehouseId: 'wh-01', counts: [{ skuId: defaultSkuId, actualQty: 6 }] },
    })
    expect(st.status).toBe(200)
    expect((st.json.data as { adjusted: number }).adjusted).toBe(1)
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number }[]
    const w1 = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    const w2 = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-02').reduce((s, t) => s + t.qty, 0)
    expect(w1).toBe(6)
    expect(w2).toBe(3)
    // 実棚数は負値も可（マイナス在庫を許容 = 2026-08-10）。wh-01 実棚 −3（理論 6）→ −9 調整・残高 −3
    const stNeg = await api('POST', '/v1/akebono/inventory/stocktake', {
      as: MEMBER, body: { warehouseId: 'wh-01', counts: [{ skuId: defaultSkuId, actualQty: -3 }] },
    })
    expect(stNeg.status).toBe(200)
    expect((stNeg.json.data as { adjusted: number }).adjusted).toBe(1)
    const txns2 = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number }[]
    const w1neg = txns2.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    expect(w1neg).toBe(-3)
    // 後続テスト（この describe は台帳を跨いで状態を共有）のため wh-01 を元の 6 へ戻す（実棚 6 → +9 調整）
    expect((await api('POST', '/v1/akebono/inventory/stocktake', {
      as: MEMBER, body: { warehouseId: 'wh-01', counts: [{ skuId: defaultSkuId, actualQty: 6 }] },
    })).status).toBe(200)
  })

  it('仕入: warehouseId 指定（入荷管理 OFF 経路）で在庫入庫・赤黒訂正で在庫も戻る・再訂正は 409', async () => {
    const pur = await api('POST', '/v1/akebono/purchase-records', {
      as: MEMBER,
      body: {
        companyId: artistId, segmentId: 'seg-01', purchaseDate: todayJst(), purchaseType: 'consignment',
        warehouseId: 'wh-01', lines: [{ skuId: defaultSkuId, qty: 5, costPrice: 700 }],
      },
    })
    expect(pur.status).toBe(201)
    const purId = (pur.json.data as { id: string }).id
    const correct = await api('POST', `/v1/akebono/purchase-records/${purId}/correct`, { as: MEMBER })
    expect(correct.status).toBe(201)
    const rev = correct.json.data as { correctionOf: string; lines: { qty: number }[] }
    expect(rev.correctionOf).toBe(purId)
    expect(rev.lines[0]!.qty).toBe(-5)
    // 入庫 +5 と戻し −5 が相殺 = 残高不変（6）
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number }[]
    const w1 = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    expect(w1).toBe(6)
    // 二重訂正は 409
    const dup = await api('POST', `/v1/akebono/purchase-records/${purId}/correct`, { as: MEMBER })
    expect(dup.status).toBe(409)
    expect(dup.json.error?.code).toBe('AKO-PCH-003')
  })

  it('出荷: 在庫不足は 409・実績で出庫 + 店舗預け倉庫へ移動（partner_roles=store + store_deposit）', async () => {
    // wh-02 を銀座テスト店の預け倉庫に付け替え（0031 シードの c-ak-03 参照を実取引先へ = 運用手順の検証）
    expect((await api('PATCH', '/v1/masters/warehouses/wh-02', { as: ADMIN, body: { companyId: storeId } })).status).toBe(200)
    const ng = await api('POST', '/v1/akebono/outbound-results', {
      as: MEMBER,
      body: { warehouseId: 'wh-01', companyId: storeId, lines: [{ skuId: defaultSkuId, qty: 100 }] },
    })
    expect(ng.status).toBe(409)
    expect(ng.json.error?.code).toBe('AKO-OUT-004')

    const r = await api('POST', '/v1/akebono/outbound-results', {
      as: MEMBER,
      body: { warehouseId: 'wh-01', companyId: storeId, lines: [{ skuId: defaultSkuId, qty: 2 }] },
    })
    expect(r.status).toBe(201)
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number; kind: string }[]
    const w1 = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    const w2 = txns.filter(t => t.skuId === defaultSkuId && t.warehouseId === 'wh-02').reduce((s, t) => s + t.qty, 0)
    expect(w1).toBe(4) // 6 − 2
    expect(w2).toBe(5) // 3 + 2（店舗預けへ transfer_in）
  })

  it('売上: 原価・課金区分をサーバーが解決・赤黒訂正・請求済み明細の訂正は 409 / 請求: 締め → 発行 → 入金 → 赤伝', async () => {
    // 対象月（直前の完了月）の売上 3 件 + 赤黒 1 件は後続の委託精算・統合メトリクスで使う（未請求のまま残す）。
    // 請求フローの検証は前々月・前々々月のデータで行い、両者を混在させない
    const monthBack = (base: string): string => {
      const y = Number(base.slice(0, 4))
      const m = Number(base.slice(5, 7))
      const pm = m === 1 ? 12 : m - 1
      return `${m === 1 ? y - 1 : y}-${String(pm).padStart(2, '0')}`
    }
    const prevPrev = monthBack(prevMonth)
    const prevPrev2 = monthBack(prevPrev)

    const s1 = await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevMonth}-10`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 2, unitPrice: 2600 },
    })
    expect(s1.status).toBe(201)
    const row1 = s1.json.data as { id: string; amount: number; costPrice: number; code: string }
    expect(row1.amount).toBe(5200)
    expect(row1.costPrice).toBe(800) // SKU 原価 null → 商品 standardCost
    expect(row1.code).toMatch(/^SR-\d{4}$/)

    // F-31（項目カスタマイズ全アプリ化）: 追加カスタム項目が custom jsonb として保存・返却される（往復）。
    // 金額集計（締め・統合メトリクス）へ影響させないため unitPrice=0（amount=0）で検証する
    const custom = { giftReady: true, memo: '要ラッピング' }
    const withCustom = await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevMonth}-12`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 1, unitPrice: 0, custom },
    })
    expect(withCustom.status).toBe(201)
    expect((withCustom.json.data as { custom: Record<string, unknown> }).custom).toEqual(custom)
    await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevMonth}-15`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 1, unitPrice: 2600 },
    })

    // 赤黒訂正: 相殺行が追記され、再訂正は 409
    const s3 = await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevMonth}-20`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 1, unitPrice: 1000 },
    })
    const row3 = s3.json.data as { id: string }
    const corrected = await api('POST', `/v1/akebono/sales-records/${row3.id}/correct`, { as: MEMBER })
    expect(corrected.status).toBe(201)
    expect((corrected.json.data as { amount: number }).amount).toBe(-1000)
    expect((await api('POST', `/v1/akebono/sales-records/${row3.id}/correct`, { as: MEMBER })).status).toBe(409)

    // ---- 請求フロー（前々月データ）----
    const b1 = (await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevPrev}-10`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 2, unitPrice: 2600 },
    })).json.data as { id: string }
    await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevPrev}-15`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 1, unitPrice: 2600 },
    })

    // 対象なしの締めは 404（AKO-BIL-001）
    const none = await api('POST', '/v1/akebono/billing/close', {
      as: MEMBER, body: { companyId: artistId, periodFrom: `${prevPrev}-01`, periodTo: `${prevPrev}-28` },
    })
    expect(none.status).toBe(404)
    expect(none.json.error?.code).toBe('AKO-BIL-001')

    // 締め（洗い替え）: 7800 + 税 10%（代表税率 = 商品の taxRateId）780 = 8580
    const close = await api('POST', '/v1/akebono/billing/close', {
      as: MEMBER, body: { companyId: storeId, periodFrom: `${prevPrev}-01`, periodTo: `${prevPrev}-28` },
    })
    expect(close.status).toBe(201)
    const closed = close.json.data as { invoice: { id: string; totalAmount: number; status: string; code: string }; count: number }
    expect(closed.invoice.status).toBe('draft')
    expect(closed.count).toBe(2)
    expect(closed.invoice.totalAmount).toBe(8580)
    expect(closed.invoice.code).toMatch(/^INV-\d{4}$/)
    // 再締めは洗い替え（draft は 1 枚のまま）
    const reclose = await api('POST', '/v1/akebono/billing/close', {
      as: MEMBER, body: { companyId: storeId, periodFrom: `${prevPrev}-01`, periodTo: `${prevPrev}-28` },
    })
    expect(reclose.status).toBe(201)
    const drafts = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { status: string; invoiceType: string }[]
    expect(drafts.filter(v => v.status === 'draft' && v.invoiceType === 'sales')).toHaveLength(1)
    const invoiceId = (reclose.json.data as { invoice: { id: string } }).invoice.id

    // 発行 → 対象売上に invoiceId・請求済み明細の赤黒訂正は 409
    expect((await api('POST', `/v1/akebono/invoices/${invoiceId}/issue`, { as: MEMBER })).status).toBe(200)
    const sales = (await api('GET', '/v1/akebono/sales-records', { as: MEMBER })).json.data as { id: string; invoiceId: string | null }[]
    expect(sales.find(r => r.id === b1.id)!.invoiceId).toBe(invoiceId)
    const ng = await api('POST', `/v1/akebono/sales-records/${b1.id}/correct`, { as: MEMBER })
    expect(ng.status).toBe(409)
    expect(ng.json.error?.code).toBe('AKO-SLS-003')

    // 入金: 部分 → issued のまま / 全額 → paid / paid の赤伝は 409
    expect((await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId, amount: 5000, method: '振込' },
    })).status).toBe(201)
    let invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(invs.find(v => v.id === invoiceId)!.status).toBe('issued')
    expect((await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId, amount: 3580, method: '振込' },
    })).status).toBe(201)
    invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { id: string; status: string }[]
    expect(invs.find(v => v.id === invoiceId)!.status).toBe('paid')
    const paidVoid = await api('POST', `/v1/akebono/invoices/${invoiceId}/void`, { as: MEMBER })
    expect(paidVoid.status).toBe(409)
    expect(paidVoid.json.error?.code).toBe('AKO-BIL-003')

    // 赤伝（前々々月の請求）: void + マイナス請求の追記 + 売上リンク解除
    const c1 = (await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER,
      body: { salesDate: `${prevPrev2}-05`, companyId: storeId, segmentId: 'seg-01', skuId: defaultSkuId, qty: 1, unitPrice: 500 },
    })).json.data as { id: string }
    const close2 = await api('POST', '/v1/akebono/billing/close', {
      as: MEMBER, body: { companyId: storeId, periodFrom: `${prevPrev2}-01`, periodTo: `${prevPrev2}-28` },
    })
    const inv2 = (close2.json.data as { invoice: { id: string; totalAmount: number } }).invoice
    expect((await api('POST', `/v1/akebono/invoices/${inv2.id}/issue`, { as: MEMBER })).status).toBe(200)
    const voided = await api('POST', `/v1/akebono/invoices/${inv2.id}/void`, { as: MEMBER })
    expect(voided.status).toBe(201)
    expect((voided.json.data as { totalAmount: number }).totalAmount).toBe(-inv2.totalAmount)
    expect((voided.json.data as { creditFor: string }).creditFor).toBe(inv2.id)
    const sales2 = (await api('GET', '/v1/akebono/sales-records', { as: MEMBER })).json.data as { id: string; invoiceId: string | null }[]
    expect(sales2.find(r => r.id === c1.id)!.invoiceId).toBeNull()
  })

  it('委託精算: 店舗マージン請求 + 作家支払通知（スナップショット凍結）・再締めは対象なし 404・通知確定', async () => {
    // 委託条件（店舗 30% / 作家 60%）を実取引先で登録
    expect((await api('POST', '/v1/masters/consignment-terms', {
      as: ADMIN,
      body: { companyId: storeId, segmentId: 'seg-01', role: 'store', marginRate: 0.30, taxRateId: 'tax-10', validFrom: '2026-01-01' },
    })).status).toBe(201)
    expect((await api('POST', '/v1/masters/consignment-terms', {
      as: ADMIN,
      body: { companyId: artistId, segmentId: 'seg-01', role: 'consignor_artist', payoutMethod: 'sales_rate', payoutRate: 0.60, liabilityTiming: 'on_sale', taxRateId: 'tax-10', validFrom: '2026-01-01' },
    })).status).toBe(201)

    const close = await api('POST', '/v1/akebono/consignment/close', {
      as: MEMBER, body: { segmentId: 'seg-01', month: prevMonth },
    })
    expect(close.status).toBe(201)
    // 委託精算バッチ id（settlementId = 0037）が付随する。件数は 1/1（取消フローの対象特定に使う）
    expect(close.json.data).toMatchObject({ invoices: 1, notices: 1 })
    expect((close.json.data as { settlementId: string }).settlementId).toMatch(/^cst-/)

    const invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as
      { id: string; invoiceType: string; status: string; totalAmount: number; snapshot: { marginRate: number } | null }[]
    const margin = invs.find(v => v.invoiceType === 'consignment_margin')!
    expect(margin.status).toBe('issued')
    // 対象売上 = 7800（5200 + 2600 + 1000 − 1000。qty>0 のみ対象のため訂正行は除外 = 8800？）
    // → consignableSales は qty > 0 の未請求行 = s1 + s2 + s3 = 8800。店舗取り分 30% → 請求 6160 + 税 616 = 6776
    expect(margin.totalAmount).toBe(6776)
    expect(margin.snapshot?.marginRate).toBe(0.30)

    const notices = (await api('GET', '/v1/akebono/payment-notices', { as: MEMBER })).json.data as
      { id: string; status: string; payableAmount: number; snapshot: { payoutRate: number } }[]
    expect(notices).toHaveLength(1)
    // 作家支払 = 売上 × 60%（明細ごと floor）= 3120 + 1560 + 600 = 5280
    expect(notices[0]!.payableAmount).toBe(5280)
    expect(notices[0]!.snapshot.payoutRate).toBe(0.60)

    // 再締め = 対象なし（精算リンク済み = 冪等）
    const again = await api('POST', '/v1/akebono/consignment/close', {
      as: MEMBER, body: { segmentId: 'seg-01', month: prevMonth },
    })
    expect(again.status).toBe(404)
    expect(again.json.error?.code).toBe('AKO-BIL-006')

    // 支払通知の確定 → 再確定は 409
    expect((await api('POST', `/v1/akebono/payment-notices/${notices[0]!.id}/confirm`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', `/v1/akebono/payment-notices/${notices[0]!.id}/confirm`, { as: MEMBER })).status).toBe(409)
  })

  it('統合メトリクス: サーバー組み立て（売上軸 = sales_records・赤黒は元月へ帰属・GA 未連携はメディア軸 0）+ 生成はメトリクス受領なし', async () => {
    // 統合分析は seg-01 と連携したメディアチャンネル経由で行う（売上軸 = channel.segmentId で解決）
    const ch = await api('POST', '/v1/media/channels', { as: ADMIN, body: { name: 'seg-01 統合検証', segmentId: 'seg-01' } })
    const CH = (ch.json.data as { id: string }).id
    const res = await api('GET', `/v1/media/integrated?channelId=${CH}&months=6`, { as: MEMBER })
    expect(res.status).toBe(200)
    const data = res.json.data as {
      metrics: { periodMonth: string; salesAmount: number; orders: number; sessions: number }
      mediaConnected: boolean
      mediaFailed: boolean
    }
    // テスト env は GOOGLE_OAUTH 無効 = GA 未連携（メディア軸 0 が正・失敗ではない）
    expect(data.mediaConnected).toBe(false)
    expect(data.mediaFailed).toBe(false)
    expect(data.metrics.periodMonth).toBe(prevMonth)
    // 売上軸 = 8800 − 1000（赤黒相殺は元月 = prevMonth へ帰属）= 7800・件数 = 3 − 1 = 2
    expect(data.metrics.salesAmount).toBe(7800)
    expect(data.metrics.orders).toBe(2)
    expect(data.metrics.sessions).toBe(0)

    // scope=integrated の生成はサーバー組み立て（metrics ボディ不要・段階版の旧受領は廃止）
    const gen = await api('POST', '/v1/media/insights/generate', {
      as: MEMBER, body: { channelId: CH, scope: 'integrated' },
    })
    expect(gen.status).toBe(200)
    const stored = gen.json.data as { periodKey: string; metrics: { salesAmount: number }; insight: { executiveSummary: string } }
    expect(stored.periodKey).toBe(prevMonth)
    expect(stored.metrics.salesAmount).toBe(7800)
    expect(stored.insight.executiveSummary.length).toBeGreaterThan(0)
  })
})

describe('Phase C レビュー 1 巡目: 並行性ガード（C-1）・入金取消と受理ガード（C-2）・復元衝突（C-3）', () => {
  const month = '2026-03' // 他スイートと重ならない過去月（会計・統合メトリクスの窓外でも請求フローは検証可能）
  let companyId = ''
  let skuId = ''

  it('準備: 取引先・商品（既定 SKU）・在庫 10 を作る', async () => {
    const company = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: '並行テスト商店' } })
    companyId = (company.json.data as { id: string }).id
    const product = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'RACE-001', name: '並行テスト品', segmentId: 'seg-02', listPrice: 1000, taxRateId: 'tax-10' },
    })
    const productId = (product.json.data as { id: string }).id
    const skus = (await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[]
    skuId = skus.find(s => s.productId === productId)!.id
    expect((await api('POST', '/v1/akebono/inbound-results', {
      as: MEMBER, body: { warehouseId: 'wh-01', lines: [{ skuId, qty: 10 }] },
    })).status).toBe(201)
  })

  it('C-1a: 残高 10 へ qty=10 の並行出荷 2 発 → 片方 201・片方 409（advisory lock で直列化 = 残高マイナスなし）', async () => {
    const post = (): ReturnType<typeof api> => api('POST', '/v1/akebono/outbound-results', {
      as: MEMBER, body: { warehouseId: 'wh-01', companyId, lines: [{ skuId, qty: 10 }] },
    })
    const [a, b] = await Promise.all([post(), post()])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const failed = a.status === 409 ? a : b
    expect(failed.json.error?.code).toBe('AKO-OUT-004')
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number }[]
    const balance = txns.filter(t => t.skuId === skuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    expect(balance).toBe(0) // −10 が 1 回だけ = マイナス残高なし
  })

  it('C-1b: 同一キーの draft 請求は部分一意 INDEX（0033）が拒否・並行 close でも draft は 1 枚', async () => {
    // 売上 2 件（請求フローの材料）
    for (const day of ['05', '06']) {
      expect((await api('POST', '/v1/akebono/sales-records', {
        as: MEMBER, body: { salesDate: `${month}-${day}`, companyId, segmentId: 'seg-02', skuId, qty: 1, unitPrice: 1000 },
      })).status).toBe(201)
    }
    // 部分一意 INDEX の直接検証（DB 制約 = 最終防衛）
    const dup = await pool.query(
      `INSERT INTO invoices (id, code, company_id, period_from, period_to, invoice_type, status)
       VALUES ('inv-t1', 'T-1', $1, '2026-03-01', '2026-03-31', 'sales', 'draft'),
              ('inv-t2', 'T-2', $1, '2026-03-01', '2026-03-31', 'sales', 'draft')`,
      [companyId]).then(() => null).catch(e => e as { code?: string })
    expect(dup?.code).toBe('23505')

    // 並行 close: advisory lock で直列化 → いずれの結果でも同一キーの draft は 1 枚
    const close = (): ReturnType<typeof api> => api('POST', '/v1/akebono/billing/close', {
      as: MEMBER, body: { companyId, periodFrom: `${month}-01`, periodTo: `${month}-28` },
    })
    const results = await Promise.all([close(), close()])
    for (const r of results) expect([201, 409]).toContain(r.status)
    const invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as
      { companyId: string; status: string; invoiceType: string }[]
    expect(invs.filter(v => v.companyId === companyId && v.status === 'draft' && v.invoiceType === 'sales')).toHaveLength(1)
  })

  it('C-2: 入金は発行済みのみ受理（draft/void は 409）・取消 = 監査列付き論理取消で paid → issued 再計算・二重取消 409', async () => {
    const invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as
      { id: string; companyId: string; status: string; totalAmount: number }[]
    const draft = invs.find(v => v.companyId === companyId && v.status === 'draft')!
    // draft への入金は 409
    const onDraft = await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId: draft.id, amount: 100, method: '振込' },
    })
    expect(onDraft.status).toBe(409)
    expect(onDraft.json.error?.code).toBe('AKO-BIL-004')

    // 発行 → 部分入金 + 残額入金 = paid
    expect((await api('POST', `/v1/akebono/invoices/${draft.id}/issue`, { as: MEMBER })).status).toBe(200)
    const r1 = await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId: draft.id, amount: 1000, method: '振込' },
    })
    expect(r1.status).toBe(201)
    const receiptId = (r1.json.data as { id: string }).id
    expect((await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId: draft.id, amount: draft.totalAmount - 1000, method: '振込' },
    })).status).toBe(201)
    let inv = ((await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { id: string; status: string }[])
      .find(v => v.id === draft.id)!
    expect(inv.status).toBe('paid')

    // 取消（原則9.5）: voidedAt が付き、有効入金が全額を割るので paid → issued へ戻る
    const cancel = await api('POST', `/v1/akebono/payment-receipts/${receiptId}/cancel`, { as: MEMBER })
    expect(cancel.status).toBe(200)
    expect((cancel.json.data as { voidedAt: string | null }).voidedAt).toBeTruthy()
    inv = ((await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { id: string; status: string }[])
      .find(v => v.id === draft.id)!
    expect(inv.status).toBe('issued')
    // 二重取消は 409
    const twice = await api('POST', `/v1/akebono/payment-receipts/${receiptId}/cancel`, { as: MEMBER })
    expect(twice.status).toBe(409)
    expect(twice.json.error?.code).toBe('AKO-BIL-009')

    // 再入金で paid へ戻せる（取消済みは集計から除外されている）
    expect((await api('POST', '/v1/akebono/payment-receipts', {
      as: MEMBER, body: { invoiceId: draft.id, amount: 1000, method: '振込' },
    })).status).toBe(201)
    inv = ((await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as { id: string; status: string }[])
      .find(v => v.id === draft.id)!
    expect(inv.status).toBe('paid')
  })

  it('C-3: 論理削除 → 同コード再登録後の復元は 409（AKO-PRD-002）+ 対処案内（500 にしない）', async () => {
    const p1 = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'RESTORE-1', name: '初代', segmentId: 'seg-02' },
    })
    const id1 = (p1.json.data as { id: string }).id
    expect((await api('POST', `/v1/akebono/products/${id1}/archive`, { as: MEMBER })).status).toBe(200)
    expect((await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'RESTORE-1', name: '二代目', segmentId: 'seg-02' },
    })).status).toBe(201)
    const restore = await api('POST', `/v1/akebono/products/${id1}/restore`, { as: MEMBER })
    expect(restore.status).toBe(409)
    expect(restore.json.error?.code).toBe('AKO-PRD-002')
  })
})

describe('Phase C レビュー 2 巡目（外部ボット PR #84 Codex・P1×3・P2×1 = スケール境界の取得ロジック）', () => {
  // 直前の完了月（統合メトリクス = /media/integrated?months=6 の対象月・当月は endBackMonths=1 で窓外）
  const prevMonth = (() => {
    const t = todayJst()
    const y = Number(t.slice(0, 4))
    const m = Number(t.slice(5, 7))
    const pm = m === 1 ? 12 : m - 1
    return `${m === 1 ? y - 1 : y}-${String(pm).padStart(2, '0')}`
  })()

  it('P1-1: 委託精算の原価解決は仕入総数の窓に依らない（対象 SKU の直近仕入が「他 SKU の新しい仕入」の後でも拾う）', async () => {
    const store = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'Codex 店', partnerRoles: ['store', 'customer'] } })
    const storeId = (store.json.data as { id: string }).id
    const artist = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'Codex 作家', partnerRoles: ['consignor_artist'] } })
    const artistId = (artist.json.data as { id: string }).id

    // 対象商品（標準原価 900 = フォールバック値。SKU 原価は null なので仕入実績が無いと 900 になる）
    const prod = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'PC-TARGET', name: '原価対象', segmentId: 'seg-03', standardCost: 900, defaultSupplierCompanyId: artistId, taxRateId: 'tax-10' },
    })
    const targetProductId = (prod.json.data as { id: string }).id
    const other = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'PC-OTHER', name: '別SKU', segmentId: 'seg-03', standardCost: 100 },
    })
    const otherProductId = (other.json.data as { id: string }).id
    const skus = (await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[]
    const targetSkuId = skus.find(s => s.productId === targetProductId)!.id
    const otherSkuId = skus.find(s => s.productId === otherProductId)!.id

    // 対象 SKU の仕入（古い日付・costPrice 650）
    expect((await api('POST', '/v1/akebono/purchase-records', {
      as: MEMBER, body: { companyId: artistId, segmentId: 'seg-03', purchaseDate: '2026-02-01', purchaseType: 'consignment', lines: [{ skuId: targetSkuId, qty: 10, costPrice: 650 }] },
    })).status).toBe(201)
    // 別 SKU の仕入を「対象より新しい日付」で複数投入。5 件では旧実装の LIMIT 500 窓は押し出せないため
    // 本テストは「窓サイズ」そのものではなく、絞り込み後の per-line 単価抽出（他 SKU=111 や標準原価=900 を
    // 誤って拾わず対象明細の 650 を返すこと）を決定的に検証する。窓非依存性は lines @> 絞り込み +
    // migration 0034 の GIN によりクエリ構造上保証される（500+ 行生成は非現実的なため構造で担保）。
    for (let i = 0; i < 5; i++) {
      expect((await api('POST', '/v1/akebono/purchase-records', {
        as: MEMBER, body: { companyId: artistId, segmentId: 'seg-03', purchaseDate: todayJst(), purchaseType: 'outright', lines: [{ skuId: otherSkuId, qty: 1, costPrice: 111 }] },
      })).status).toBe(201)
    }

    // 委託条件: 店舗 30% / 作家 = purchase_cost（仕入単価 × 数量）
    expect((await api('POST', '/v1/masters/consignment-terms', {
      as: ADMIN, body: { companyId: storeId, segmentId: 'seg-03', role: 'store', marginRate: 0.30, taxRateId: 'tax-10', validFrom: '2026-01-01' },
    })).status).toBe(201)
    expect((await api('POST', '/v1/masters/consignment-terms', {
      as: ADMIN, body: { companyId: artistId, segmentId: 'seg-03', role: 'consignor_artist', payoutMethod: 'purchase_cost', taxRateId: 'tax-10', validFrom: '2026-01-01' },
    })).status).toBe(201)

    // 対象 SKU の店舗売上（精算対象・qty>0・未請求）
    expect((await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER, body: { salesDate: `${prevMonth}-10`, companyId: storeId, segmentId: 'seg-03', skuId: targetSkuId, qty: 2, unitPrice: 3000 },
    })).status).toBe(201)

    const close = await api('POST', '/v1/akebono/consignment/close', { as: MEMBER, body: { segmentId: 'seg-03', month: prevMonth } })
    expect(close.status).toBe(201)
    const notices = (await api('GET', '/v1/akebono/payment-notices', { as: MEMBER })).json.data as { segmentId: string; payableAmount: number }[]
    const notice = notices.find(n => n.segmentId === 'seg-03')!
    // 作家支払 = 仕入単価 650 × 数量 2 = 1300。標準原価 900 へ誤フォールバックすると 1800。
    // 対象 SKU を含む明細を lines @> で絞り込み、その明細の costPrice 650 を拾う（他 SKU の単価も標準原価も拾わない）
    expect(notice.payableAmount).toBe(1300)
  })

  it('P1-2: 在庫残高はサーバー全量集約（inventory-balances）= 台帳明細の表示打ち切りに依らず正しい・0 残高は返さない', async () => {
    const prod = await api('POST', '/v1/akebono/products', { as: MEMBER, body: { code: 'BAL-1', name: '残高品', segmentId: 'seg-03' } })
    const pid = (prod.json.data as { id: string }).id
    const skuId = ((await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[])
      .find(s => s.productId === pid)!.id

    // 入庫 100 + 微小調整 6 件（明細行を増やす）+ 移動 5（wh-01 → wh-02）
    expect((await api('POST', '/v1/akebono/inbound-results', { as: MEMBER, body: { warehouseId: 'wh-01', lines: [{ skuId, qty: 100 }] } })).status).toBe(201)
    for (let i = 0; i < 6; i++) {
      expect((await api('POST', '/v1/akebono/inventory/adjust', { as: MEMBER, body: { skuId, warehouseId: 'wh-01', qty: 1, reason: 'found' } })).status).toBe(201)
    }
    expect((await api('POST', '/v1/akebono/inventory/transfer', { as: MEMBER, body: { skuId, fromWarehouseId: 'wh-01', toWarehouseId: 'wh-02', qty: 5 } })).status).toBe(201)

    const balances = (await api('GET', '/v1/akebono/inventory-balances', { as: MEMBER })).json.data as { skuId: string; warehouseId: string; qty: number }[]
    const w1 = balances.find(b => b.skuId === skuId && b.warehouseId === 'wh-01')
    const w2 = balances.find(b => b.skuId === skuId && b.warehouseId === 'wh-02')
    expect(w1?.qty).toBe(101) // 100 + 6 − 5
    expect(w2?.qty).toBe(5)
    // 全量集約は台帳明細（表示用）の Σ と一致する（小規模フィクスチャでは両者一致 = 集約の正しさ確認）。
    // 表示打ち切り（LIMIT 20000）非依存性はエンドポイントが LIMIT 無しの GROUP BY 集約であること = クエリ
    // 構造で担保される（2 万行超のフィクスチャ生成は非現実的なため境界そのものは本テストでは突かない）。
    const txns = (await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })).json.data as { skuId: string; warehouseId: string; qty: number }[]
    const foldW1 = txns.filter(t => t.skuId === skuId && t.warehouseId === 'wh-01').reduce((s, t) => s + t.qty, 0)
    expect(w1?.qty).toBe(foldW1)

    // 残高 0 のキーは返さない（HAVING SUM(qty) <> 0）: +3 → −3
    const prod0 = await api('POST', '/v1/akebono/products', { as: MEMBER, body: { code: 'BAL-0', name: 'ゼロ品', segmentId: 'seg-03' } })
    const pid0 = (prod0.json.data as { id: string }).id
    const skuId0 = ((await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[])
      .find(s => s.productId === pid0)!.id
    expect((await api('POST', '/v1/akebono/inventory/adjust', { as: MEMBER, body: { skuId: skuId0, warehouseId: 'wh-01', qty: 3, reason: 'found' } })).status).toBe(201)
    expect((await api('POST', '/v1/akebono/inventory/adjust', { as: MEMBER, body: { skuId: skuId0, warehouseId: 'wh-01', qty: -3, reason: 'lost' } })).status).toBe(201)
    const balances2 = (await api('GET', '/v1/akebono/inventory-balances', { as: MEMBER })).json.data as { skuId: string; warehouseId: string }[]
    expect(balances2.find(b => b.skuId === skuId0 && b.warehouseId === 'wh-01')).toBeUndefined()
  })

  it('P1-3: 統合メトリクスは対象月窓で取得し、赤黒訂正（元伝票が窓内・訂正日は当月=窓外）を元月へ帰属して相殺する', async () => {
    const store = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'Codex 統合店', partnerRoles: ['store', 'customer'] } })
    const storeId = (store.json.data as { id: string }).id
    const prod = await api('POST', '/v1/akebono/products', { as: MEMBER, body: { code: 'INT-1', name: '統合品', segmentId: 'seg-04', standardCost: 0 } })
    const pid = (prod.json.data as { id: string }).id
    const skuId = ((await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[])
      .find(s => s.productId === pid)!.id

    // 対象月（窓内）に 2 件。うち 1 件を赤黒訂正（訂正行の salesDate = 当月 = 窓外）
    const s1 = await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER, body: { salesDate: `${prevMonth}-10`, companyId: storeId, segmentId: 'seg-04', skuId, qty: 1, unitPrice: 5000 },
    })
    const s1Id = (s1.json.data as { id: string }).id
    expect((await api('POST', '/v1/akebono/sales-records', {
      as: MEMBER, body: { salesDate: `${prevMonth}-12`, companyId: storeId, segmentId: 'seg-04', skuId, qty: 1, unitPrice: 2000 },
    })).status).toBe(201)
    const corrected = await api('POST', `/v1/akebono/sales-records/${s1Id}/correct`, { as: MEMBER })
    expect(corrected.status).toBe(201)
    // 訂正行の salesDate は当月（= 窓外）。元伝票（prevMonth）の月へ帰属して相殺されなければならない
    expect((corrected.json.data as { salesDate: string }).salesDate.slice(0, 7)).not.toBe(prevMonth)

    const ch = await api('POST', '/v1/media/channels', { as: ADMIN, body: { name: 'seg-04 統合検証', segmentId: 'seg-04' } })
    const CH = (ch.json.data as { id: string }).id
    const res = await api('GET', `/v1/media/integrated?channelId=${CH}&months=6`, { as: MEMBER })
    expect(res.status).toBe(200)
    const data = res.json.data as { metrics: { periodMonth: string; salesAmount: number; orders: number } }
    expect(data.metrics.periodMonth).toBe(prevMonth)
    // 5000 − 5000（訂正を元月 prevMonth へ帰属して相殺）+ 2000 = 2000・件数 = 2 − 1 = 1。
    // 訂正行の salesDate（当月 = 窓外）で単純に月フィルタすると相殺行が落ち 7000 / 2 件になる回帰を検出する
    expect(data.metrics.salesAmount).toBe(2000)
    expect(data.metrics.orders).toBe(1)
  })

  it('P2-4: 商品 PATCH は segmentId を反映する（参照存在検証 + 移動先の同コード衝突は AKO-PRD-002 409）', async () => {
    const a = await api('POST', '/v1/akebono/products', { as: MEMBER, body: { code: 'MOVE-1', name: '移動品A', segmentId: 'seg-03' } })
    const aId = (a.json.data as { id: string }).id
    // segmentId を PATCH で更新（旧実装は無視 = 成功を返すのに旧セグメントのまま = モックと乖離）
    const moved = await api('PATCH', `/v1/akebono/products/${aId}`, { as: MEMBER, body: { segmentId: 'seg-04' } })
    expect(moved.status).toBe(200)
    expect((moved.json.data as { segmentId: string }).segmentId).toBe('seg-04')
    const listed = ((await api('GET', '/v1/akebono/products', { as: MEMBER })).json.data as { id: string; segmentId: string }[]).find(p => p.id === aId)!
    expect(listed.segmentId).toBe('seg-04')
    // 不存在セグメントは 404（requireRef）
    const bad = await api('PATCH', `/v1/akebono/products/${aId}`, { as: MEMBER, body: { segmentId: 'seg-none' } })
    expect(bad.status).toBe(404)
    // seg-03 で同コードを再登録（A は seg-04 へ移動済み = seg-03 の MOVE-1 は空き）→ seg-04 へ移動で A と衝突
    const d = await api('POST', '/v1/akebono/products', { as: MEMBER, body: { code: 'MOVE-1', name: '移動品D', segmentId: 'seg-03' } })
    expect(d.status).toBe(201)
    const dId = (d.json.data as { id: string }).id
    const conflict = await api('PATCH', `/v1/akebono/products/${dId}`, { as: MEMBER, body: { segmentId: 'seg-04' } })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error?.code).toBe('AKO-PRD-002')
  })
})

describe('Phase D: データ取込（F-32）・ダッシュボード保管（F-41）・委託精算取消・出荷→売上（localStorage 依存の解消）', () => {
  // ---------- データ取込（F-32）: 設定系（取込元/マッピング）+ 記録系（実行履歴） ----------
  describe('データ取込 F-32', () => {
    let sourceId = ''

    it('取込元: 書込は管理者のみ（member は 403）・作成 + 論理削除/復元で名称保持', async () => {
      // member の書込は 403（管理者ゲート）。参照は全員可
      expect((await api('POST', '/v1/akebono/import-sources', {
        as: MEMBER, body: { name: 'x', method: 'file_csv', encoding: 'utf8', targetEntity: 'product' },
      })).status).toBe(403)
      const created = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: '売上CSV', method: 'file_csv', encoding: 'sjis', targetEntity: 'sales_record' },
      })
      expect(created.status).toBe(201)
      sourceId = (created.json.data as { id: string }).id
      expect((created.json.data as { name: string; encoding: string; targetEntity: string }))
        .toMatchObject({ name: '売上CSV', encoding: 'sjis', targetEntity: 'sales_record' })
      // 名前必須（AKO-IMP-001）
      expect((await api('POST', '/v1/akebono/import-sources', { as: ADMIN, body: { name: '  ' } })).json.error?.code)
        .toBe('AKO-IMP-001')
      // 論理削除 → 復元で active と名称が保持される（原則9.5）
      expect((await api('POST', `/v1/akebono/import-sources/${sourceId}/archive`, { as: ADMIN })).status).toBe(200)
      const restored = await api('POST', `/v1/akebono/import-sources/${sourceId}/restore`, { as: ADMIN })
      expect((restored.json.data as { active: boolean; name: string })).toMatchObject({ active: true, name: '売上CSV' })
    })

    it('マッピング: 版管理（新版で旧 active は superseded・旧版の項目は履歴として保持）+ 空項目は 400', async () => {
      // 空項目は AKO-IMP-003
      expect((await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId, fields: [{ sourceField: '', targetItemKey: '' }] },
      })).json.error?.code).toBe('AKO-IMP-003')
      const v1 = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId, fields: [{ sourceField: 'code', targetItemKey: 'code', transform: 'trim' }] },
      })
      expect(v1.status).toBe(201)
      expect((v1.json.data as { version: number; status: string })).toMatchObject({ version: 1, status: 'active' })
      const v2 = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId, fields: [
          { sourceField: 'price', targetItemKey: 'unitPrice', transform: 'number' },
          { sourceField: 'name', targetItemKey: 'name', transform: '' },
        ] },
      })
      expect((v2.json.data as { version: number }).version).toBe(2)
      const all = (await api('GET', '/v1/akebono/import-mappings', { as: MEMBER })).json.data as
        { id: string; sourceId: string; version: number; status: string; fields: { sourceField: string }[] }[]
      const mine = all.filter(m => m.sourceId === sourceId)
      // 旧版は superseded・新版が active・旧版の項目（履歴）はそのまま保持される
      expect(mine.find(m => m.version === 1)).toMatchObject({ status: 'superseded' })
      expect(mine.find(m => m.version === 1)!.fields[0]!.sourceField).toBe('code')
      expect(mine.find(m => m.version === 2)).toMatchObject({ status: 'active' })
      expect(mine.filter(m => m.status === 'active')).toHaveLength(1)
    })

    it('方式別設定 config: method 別に正規化・PUT で更新・認証情報は管理者のみ・マッピングは方式別ロケータを保持', async () => {
      // CSV: hasHeader/delimiter を保持し API 系の項目は落とす
      const csv = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: 'CSV設定', method: 'file_csv', encoding: 'utf8', targetEntity: 'product',
          config: { hasHeader: false, delimiter: '\t', endpoint: 'https://drop.me' },
        },
      })
      const csvId = (csv.json.data as { id: string }).id
      expect((csv.json.data as { config: Record<string, unknown> }).config).toEqual({ hasHeader: false, delimiter: '\t' })

      // API: endpoint/authType/authValue/jsonRootPath を保持
      const apiSrc = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: 'API設定', method: 'api_pull', encoding: 'utf8', targetEntity: 'sku',
          config: { endpoint: 'https://api.example.com/skus', authType: 'bearer', authValue: 'tok', jsonRootPath: 'data.items' },
        },
      })
      const apiId = (apiSrc.json.data as { id: string }).id
      expect((apiSrc.json.data as { config: Record<string, unknown> }).config)
        .toEqual({ endpoint: 'https://api.example.com/skus', authType: 'bearer', authValue: 'tok', jsonRootPath: 'data.items' })

      // 認証情報（authValue）は管理者のみ実値・非管理者はマスク（M-1: 秘匿値の最小権限。参照自体は全員可）
      type SrcRow = { id: string; config: { authValue?: string } }
      const listMember = (await api('GET', '/v1/akebono/import-sources', { as: MEMBER })).json.data as SrcRow[]
      const listAdmin = (await api('GET', '/v1/akebono/import-sources', { as: ADMIN })).json.data as SrcRow[]
      expect(listMember.find(s => s.id === apiId)!.config.authValue).toBe('')
      expect(listAdmin.find(s => s.id === apiId)!.config.authValue).toBe('tok')

      // PUT /config: member は 403・不正 authType は none に落ち authValue は空へ
      expect((await api('PUT', `/v1/akebono/import-sources/${apiId}/config`, {
        as: MEMBER, body: { config: { endpoint: 'x' } },
      })).status).toBe(403)
      const upd = await api('PUT', `/v1/akebono/import-sources/${apiId}/config`, {
        as: ADMIN, body: { config: { endpoint: 'https://api.example.com/v2', authType: 'bogus', authValue: 'ignored' } },
      })
      expect((upd.json.data as { config: Record<string, unknown> }).config)
        .toEqual({ endpoint: 'https://api.example.com/v2', authType: 'none', authValue: '' })

      // マッピング: CSV 列番号のロケータが版に保持される
      const map = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: csvId, fields: [
          { sourceField: '商品コード', targetItemKey: 'code', columnIndex: 0 },
          { sourceField: '単価', targetItemKey: 'unitPrice', transform: 'number', columnIndex: 2 },
        ] },
      })
      const fields = (map.json.data as { fields: { sourceField: string; columnIndex: number | null; byteStart: number | null }[] }).fields
      expect(fields.map(f => f.columnIndex)).toEqual([0, 2])
      expect(fields.every(f => f.byteStart === null)).toBe(true)

      // 固定長: バイト範囲ロケータの往復（columnIndex は null）
      const fx = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: '固定長取込', method: 'file_fixed', encoding: 'sjis', targetEntity: 'inventory' },
      })
      const fxMap = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: (fx.json.data as { id: string }).id, fields: [
          { sourceField: '数量', targetItemKey: 'qty', byteStart: 11, byteEnd: 20 },
        ] },
      })
      const fxf = (fxMap.json.data as { fields: { byteStart: number | null; byteEnd: number | null; columnIndex: number | null }[] }).fields[0]!
      expect([fxf.byteStart, fxf.byteEnd, fxf.columnIndex]).toEqual([11, 20, null])

      // JSON: jsonKey ロケータの往復
      const js = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: 'JSON取込', method: 'file_json', encoding: 'utf8', targetEntity: 'product' },
      })
      const jsMap = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: (js.json.data as { id: string }).id, fields: [
          { sourceField: 'code', targetItemKey: 'code', jsonKey: 'code' },
        ] },
      })
      expect((jsMap.json.data as { fields: { jsonKey: string | null }[] }).fields[0]!.jsonKey).toBe('code')
    })

    it('取込実行: 有効マッピングなしは 409・ファイル未添付は 400（実取込 = 監査指摘 2026-07-30 ①）', async () => {
      // マッピングの無い別の取込元では実行不可（AKO-IMP-002）
      const bare = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: 'マッピングなし', method: 'file_json', encoding: 'utf8', targetEntity: 'company' },
      })
      const bareId = (bare.json.data as { id: string }).id
      expect((await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: bareId } })).json.error?.code)
        .toBe('AKO-IMP-002')
      // ファイル方式でファイル未添付は AKO-IMP-004（sourceId = 売上CSV には v2 マッピングあり）
      expect((await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId } })).json.error?.code)
        .toBe('AKO-IMP-004')
    })

    it('実取込（商品 CSV）: 作成 + 再実行で upsert・不正行は隔離して残りを反映（原則4）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: '商品CSV実取込', method: 'file_csv', encoding: 'utf8', targetEntity: 'product',
          config: { hasHeader: true, delimiter: ',' },
        },
      })
      const srcId = (src.json.data as { id: string }).id
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: 'code', targetItemKey: 'code', columnIndex: 0 },
          { sourceField: 'name', targetItemKey: 'name', columnIndex: 1 },
          { sourceField: 'segment', targetItemKey: 'segmentId', columnIndex: 2 },
          { sourceField: 'price', targetItemKey: 'listPrice', transform: 'number', columnIndex: 3 },
        ] },
      })
      // 3 行: 2 行は正常（セグメントは id / 名称のどちらでも解決）・1 行はセグメント未登録 = 隔離
      const csv = 'code,name,segment,price\nIMP-P1,取込商品1,seg-01,"1,200"\nIMP-P2,取込商品2,陶磁器委託販売,800\nIMP-NG,不正行,存在しない業態,100\n'
      const r1 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, filename: 'products.csv', contentBase64: b64(csv) },
      })
      expect(r1.status).toBe(201)
      const run1 = r1.json.data as { status: string; counts: Record<string, number>; errors: { message: string }[] }
      expect(run1.status).toBe('applied')
      expect(run1.counts).toMatchObject({ staged: 3, applied: 2, failed: 1 })
      expect(run1.errors[0]!.message).toContain('存在しない業態')
      // 実反映: 商品 + 既定 SKU が作られている
      type ProductRow = { id: string; code: string; name: string; segmentId: string; listPrice: number }
      const products = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      const p1 = products.find(p => p.code === 'IMP-P1')
      expect(p1).toMatchObject({ name: '取込商品1', segmentId: 'seg-01', listPrice: 1200 })
      expect(products.find(p => p.code === 'IMP-P2')).toMatchObject({ segmentId: 'seg-01' })
      const skus = (await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as { code: string; productId: string }[]
      expect(skus.some(s => s.productId === p1!.id && s.code === 'IMP-P1')).toBe(true)
      // 再実行 = upsert（新規は増えない・値の更新のみ）
      const csv2 = 'code,name,segment,price\nIMP-P1,取込商品1改,seg-01,1500\n'
      const r2 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv2) },
      })
      expect((r2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 1, failed: 0 })
      const after = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      expect(after.filter(p => p.code === 'IMP-P1')).toHaveLength(1)
      expect(after.find(p => p.code === 'IMP-P1')).toMatchObject({ name: '取込商品1改', listPrice: 1500 })
    })

    it('実取込（売上 JSON）: SKU コード解決 + 同一内容の再実行はスキップ（フィンガープリント冪等 = 原則2）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      // 取込先の得意先（会社）を用意
      const comp = await api('POST', '/v1/masters/companies', {
        as: ADMIN, body: { kind: 'customer', name: '取込テスト商店', primaryIndustryId: '', industryIds: [] },
      })
      const companyId = (comp.json.data as { id: string }).id
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: '売上JSON実取込', method: 'file_json', encoding: 'utf8', targetEntity: 'sales_record',
          config: { jsonRootPath: 'rows' },
        },
      })
      const srcId = (src.json.data as { id: string }).id
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: 'date', targetItemKey: 'salesDate', transform: 'date', jsonKey: 'date' },
          { sourceField: 'customer', targetItemKey: 'companyId', jsonKey: 'customer' },
          { sourceField: 'segment', targetItemKey: 'segmentId', jsonKey: 'segment' },
          { sourceField: 'sku', targetItemKey: 'skuId', jsonKey: 'sku' },
          { sourceField: 'qty', targetItemKey: 'qty', jsonKey: 'qty' },
          { sourceField: 'price', targetItemKey: 'unitPrice', jsonKey: 'price' },
        ] },
      })
      // SKU は商品 CSV 実取込で作られた既定 SKU（IMP-P1）をコードで解決する。
      // 末尾 2 行は**正当な同一内容行**（同日・同 SKU・同数量・同単価）= 出現序数で区別され両方反映される
      const payload = { rows: [
        { date: '2026/07/01', customer: '取込テスト商店', segment: 'seg-01', sku: 'IMP-P1', qty: 2, price: 1500 },
        { date: '2026-07-02', customer: companyId, segment: 'seg-01', sku: 'IMP-P1', qty: 1, price: 1500 },
        { date: '2026-07-03', customer: '未登録商店', segment: 'seg-01', sku: 'IMP-P1', qty: 1, price: 100 },
        { date: '2026-07-04', customer: companyId, segment: 'seg-01', sku: 'IMP-P1', qty: 3, price: 900 },
        { date: '2026-07-04', customer: companyId, segment: 'seg-01', sku: 'IMP-P1', qty: 3, price: 900 },
      ] }
      const r1 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(JSON.stringify(payload)) },
      })
      expect((r1.json.data as { counts: Record<string, number> }).counts)
        .toMatchObject({ staged: 5, applied: 4, skipped: 0, failed: 1 })
      type SalesRow = { sourceKind: string; sourceRef: string | null; amount: number; companyId: string }
      const sales = (await api('GET', '/v1/akebono/sales-records', { as: ADMIN })).json.data as SalesRow[]
      const imported = sales.filter(s => s.sourceKind === 'import' && s.companyId === companyId)
      expect(imported).toHaveLength(4)
      expect(imported.every(s => (s.sourceRef ?? '').startsWith('import:'))).toBe(true)
      // 同一ファイルの再実行 = 全行スキップ（売上の二重計上なし。同一内容行の序数も再現される = 冪等）
      const r2 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(JSON.stringify(payload)) },
      })
      expect((r2.json.data as { counts: Record<string, number> }).counts)
        .toMatchObject({ staged: 5, applied: 0, skipped: 4, failed: 1 })
      const salesAfter = (await api('GET', '/v1/akebono/sales-records', { as: ADMIN })).json.data as SalesRow[]
      expect(salesAfter.filter(s => s.sourceKind === 'import' && s.companyId === companyId)).toHaveLength(4)
    })

    it('実取込（棚卸 CSV）: 実物理在庫数を絶対値として理論差分を計上・マイナス可・再取込は冪等（オペレーター指示 2026-08-10）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      // IMP-P1 の既定 SKU（商品 CSV 実取込で作成済み）を対象に wh-02 の棚卸を取り込む
      const skus = (await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as { id: string; code: string }[]
      const skuId = skus.find(s => s.code === 'IMP-P1')!.id
      const balOf = async (): Promise<number> => {
        const txns = (await api('GET', '/v1/akebono/inventory-transactions?limit=20000', { as: ADMIN })).json.data as
          { skuId: string; warehouseId: string; qty: number }[]
        return txns.filter(t => t.skuId === skuId && t.warehouseId === 'wh-02').reduce((s, t) => s + t.qty, 0)
      }
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: '棚卸CSV実取込', method: 'file_csv', encoding: 'utf8', targetEntity: 'inventory',
          config: { hasHeader: true, delimiter: ',' },
        },
      })
      const srcId = (src.json.data as { id: string }).id
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: 'sku', targetItemKey: 'skuId', columnIndex: 0 },
          { sourceField: 'warehouse', targetItemKey: 'warehouseId', columnIndex: 1 },
          { sourceField: 'qty', targetItemKey: 'qty', columnIndex: 2 },
          { sourceField: 'kind', targetItemKey: 'kind', columnIndex: 3 },
        ] },
      })
      // 棚卸: 実物理在庫数 50 を取込む → 理論在庫に依らず残高が 50 になる（差分計上 = 手動棚卸と同一意味論）
      const csv = `sku,warehouse,qty,kind\n${skuId},wh-02,50,stocktake\n`
      const r1 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv) },
      })
      expect(r1.status).toBe(201)
      expect((r1.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 1, failed: 0 })
      expect(await balOf()).toBe(50)
      // 同一ファイル再取込 = 冪等（差分 0 でスキップ・二重計上なし = 原則2）
      const r2 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv) },
      })
      expect((r2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 0, skipped: 1, failed: 0 })
      expect(await balOf()).toBe(50)
      // マイナス実棚数も可: -5 を取込む → 残高 -5（50 → -5 の差分 -55 を計上）
      const csvNeg = `sku,warehouse,qty,kind\n${skuId},wh-02,-5,stocktake\n`
      const rNeg = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csvNeg) },
      })
      expect((rNeg.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 1, failed: 0 })
      expect(await balOf()).toBe(-5)
      // 調整（adjust）取込は従来どおり増減数（デルタ）: −5 に +10 → 残高 5・同一ファイル再取込はスキップ（冪等）
      const csvAdj = `sku,warehouse,qty,kind\n${skuId},wh-02,10,adjust\n`
      const rAdj = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csvAdj) } })
      expect((rAdj.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 1, failed: 0 })
      expect(await balOf()).toBe(5)
      const rAdj2 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csvAdj) } })
      expect((rAdj2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 1, applied: 0, skipped: 1 })
      expect(await balOf()).toBe(5)
      // 同一 SKU×倉庫が同一ファイルに複数行: 実棚数へ収束し最終行が最終残高を決定（20 → 7 で残高 7）
      const csvMulti = `sku,warehouse,qty,kind\n${skuId},wh-02,20,stocktake\n${skuId},wh-02,7,stocktake\n`
      const rMulti = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csvMulti) } })
      expect((rMulti.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 2, applied: 2, failed: 0 })
      expect(await balOf()).toBe(7)
    })

    it('API 接続（pull）: https 以外・内部アドレスは SSRF ガードで拒否（AKO-IMP-007）', async () => {
      const mk = async (endpoint: string): Promise<string> => {
        const s = await api('POST', '/v1/akebono/import-sources', {
          as: ADMIN, body: {
            name: `pull:${endpoint.slice(0, 24)}`, method: 'api_pull', encoding: 'utf8', targetEntity: 'company',
            config: { endpoint, authType: 'none' },
          },
        })
        const sid = (s.json.data as { id: string }).id
        await api('POST', '/v1/akebono/import-mappings', {
          as: ADMIN, body: { sourceId: sid, fields: [{ sourceField: 'name', targetItemKey: 'name', jsonKey: 'name' }] },
        })
        return sid
      }
      const plain = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: await mk('http://example.com/feed') },
      })
      expect(plain.json.error?.code).toBe('AKO-IMP-007')
      expect(plain.json.error?.message).toContain('https')
      const internal = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: await mk('https://127.0.0.1/feed') },
      })
      expect(internal.json.error?.code).toBe('AKO-IMP-007')
      expect(internal.json.error?.message).toContain('内部ネットワーク')
      const meta = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: await mk('https://169.254.169.254/computeMetadata/v1/') },
      })
      expect(meta.json.error?.code).toBe('AKO-IMP-007')
      // IPv6 リテラル（角括弧付き）も接続前に遮断（レビュー M-1 回帰）
      const v6 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: await mk('https://[::1]/feed') },
      })
      expect(v6.json.error?.code).toBe('AKO-IMP-007')
      expect(v6.json.error?.message).toContain('内部ネットワーク')
    })

    it('無効化した取込元では実行できない（AKO-IMP-005）', async () => {
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: '無効化テスト', method: 'file_csv', encoding: 'utf8', targetEntity: 'product' },
      })
      const srcId = (src.json.data as { id: string }).id
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [{ sourceField: 'code', targetItemKey: 'code', columnIndex: 0 }] },
      })
      await api('POST', `/v1/akebono/import-sources/${srcId}/archive`, { as: ADMIN })
      const res = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: Buffer.from('code\nX-1\n').toString('base64') },
      })
      expect(res.json.error?.code).toBe('AKO-IMP-005')
    })

    it('Google スプレッドシート（sheets_pull）: 未設定は status=false・URL/一覧は AKO-SHEETS-001・コールバックはエラーリダイレクト・config 往復・未連携実行は AKO-SHEETS-001', async () => {
      // OAuth 未設定（テスト env）: status は enabled/connected=false（カレンダー/GA と同型）
      const st = (await api('GET', '/v1/akebono/sheets/status', { as: MEMBER })).json.data as
        { enabled: boolean; connected: boolean }
      expect(st).toMatchObject({ enabled: false, connected: false })
      // 同意 URL・ブック一覧は未設定で AKO-SHEETS-001（連携設定が先）
      expect((await api('GET', '/v1/akebono/sheets/oauth/url', { as: ADMIN })).json.error?.code).toBe('AKO-SHEETS-001')
      expect((await api('GET', '/v1/akebono/sheets/spreadsheets', { as: ADMIN })).json.error?.code).toBe('AKO-SHEETS-001')
      // コールバックは認証なしで到達し、未設定はフロントへエラーリダイレクト（500 にしない）
      const cb = await app.request('/v1/akebono/sheets/oauth/callback?state=x&code=y')
      expect(cb.status).toBe(302)
      expect(cb.headers.get('location')).toContain('sheets=error')

      // 取込元 sheets_pull: config が正規化されて往復（開始列は大文字化・既定補完・他方式項目は落とす）
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: 'スプレッドシート取込', method: 'sheets_pull', encoding: 'utf8', targetEntity: 'product',
          config: { spreadsheetId: 'ss-1', spreadsheetName: '商品台帳', sheetName: '商品', headerRow: 2, startColumn: 'b', endpoint: 'x' },
        },
      })
      expect(src.status).toBe(201)
      const srcId = (src.json.data as { id: string }).id
      expect((src.json.data as { method: string; config: Record<string, unknown> })).toMatchObject({
        method: 'sheets_pull',
        config: { spreadsheetId: 'ss-1', spreadsheetName: '商品台帳', sheetName: '商品', headerRow: 2, startColumn: 'B' },
      })
      // マッピング（Sheets は CSV と同じ columnIndex ロケータを保持）
      const map = await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: '商品コード', targetItemKey: 'code', columnIndex: 0 },
          { sourceField: '商品名', targetItemKey: 'name', columnIndex: 1 },
        ] },
      })
      expect((map.json.data as { fields: { columnIndex: number | null }[] }).fields.map(f => f.columnIndex)).toEqual([0, 1])
      // 実行: 未連携のため AKO-SHEETS-001（実取込エンジンが fetchSheetRows で検出。ファイル添付は不要）
      const run = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId } })
      expect(run.json.error?.code).toBe('AKO-SHEETS-001')
    })

    it('バリアント軸取込（product_variant）: グルーピングキーで商品へ束ね SKU を展開・軸ラベル = 列名・再実行は冪等（0053）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: 'アパレルCSV', method: 'file_csv', encoding: 'utf8', targetEntity: 'product_variant',
          config: { hasHeader: true, delimiter: ',' },
        },
      })
      expect(src.status).toBe(201)
      const srcId = (src.json.data as { id: string }).id
      // 構造検証: グルーピングキー（productCode）欠落・軸2 のみは保存時に AKO-IMP-008
      expect((await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [{ sourceField: 'skuid', targetItemKey: 'code', columnIndex: 1 }] },
      })).json.error?.code).toBe('AKO-IMP-008')
      expect((await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: '商品id', targetItemKey: 'productCode', columnIndex: 0 },
          { sourceField: 'skuid', targetItemKey: 'code', columnIndex: 1 },
          { sourceField: 'サイズ', targetItemKey: 'axis2Value', columnIndex: 3 },
        ] },
      })).json.error?.code).toBe('AKO-IMP-008')
      // 例のアパレル形式: 商品id = グルーピングキー / skuid = 固有 ID / カラー・サイズ = バリアント軸
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: '商品id', targetItemKey: 'productCode', columnIndex: 0 },
          { sourceField: 'skuid', targetItemKey: 'code', columnIndex: 1 },
          { sourceField: 'カラー', targetItemKey: 'axis1Value', columnIndex: 2 },
          { sourceField: 'サイズ', targetItemKey: 'axis2Value', columnIndex: 3 },
          { sourceField: '商品名', targetItemKey: 'productName', columnIndex: 4 },
          { sourceField: 'セグメント', targetItemKey: 'segmentId', columnIndex: 5 },
          { sourceField: '売価', targetItemKey: 'sellPrice', transform: 'number', columnIndex: 6 },
        ] },
      })
      const csv = '商品id,skuid,カラー,サイズ,商品名,セグメント,売価\n'
        + 'VAR-P1,VAR-P1-RD-S,赤,S,バリアントT,seg-01,"1,000"\n'
        + 'VAR-P1,VAR-P1-RD-M,赤,M,バリアントT,seg-01,1100\n'
        + 'VAR-P1,VAR-P1-BL-S,青,S,バリアントT,seg-01,1000\n'
        + 'VAR-P2,,青,M,固有ID欠落,seg-01,900\n'
      const r1 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, filename: 'variants.csv', contentBase64: b64(csv) },
      })
      expect(r1.status).toBe(201)
      const run1 = r1.json.data as { status: string; counts: Record<string, number>; errors: { message: string }[] }
      expect(run1.counts).toMatchObject({ staged: 4, applied: 3, failed: 1 })
      expect(run1.errors[0]!.message).toContain('SKUコード')
      // 商品: グループ 1 商品・軸ラベルは列の論理名（カラー / サイズ）
      type ProductRow = { id: string; code: string; name: string; segmentId: string; variantAxis1Label: string | null; variantAxis2Label: string | null }
      const products = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      const p1 = products.find(p => p.code === 'VAR-P1')!
      expect(p1).toMatchObject({ name: 'バリアントT', segmentId: 'seg-01', variantAxis1Label: 'カラー', variantAxis2Label: 'サイズ' })
      expect(products.some(p => p.code === 'VAR-P2')).toBe(false) // 固有 ID 欠落グループは商品も作らない
      // SKU: 3 件・軸値と価格・新規商品は既定 SKU を作らない
      type SkuRow = { id: string; productId: string; code: string; axis1Value: string | null; axis2Value: string | null; sellPrice: number | null; isDefault: boolean; active: boolean }
      const skus = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === p1.id)
      expect(skus).toHaveLength(3)
      expect(skus.find(s => s.code === 'VAR-P1-RD-M')).toMatchObject({ axis1Value: '赤', axis2Value: 'M', sellPrice: 1100 })
      expect(skus.every(s => !s.isDefault)).toBe(true)
      // 再実行 = 冪等（商品・SKU が増えない = upsert）
      const r2 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv) } })
      expect((r2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 4, applied: 3, failed: 1 })
      const productsAfter = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      expect(productsAfter.filter(p => p.code === 'VAR-P1')).toHaveLength(1)
      const skusAfter = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === p1.id)
      expect(skusAfter).toHaveLength(3)
      // 既存商品（既定 SKU あり）へ実 SKU を取り込むと既定 SKU は無効化（SKU マトリクス生成と同一挙動）
      const prd = await api('POST', '/v1/akebono/products', {
        as: ADMIN, body: { code: 'VAR-P3', name: '既存商品', segmentId: 'seg-01' },
      })
      const p3Id = (prd.json.data as { id: string }).id
      const csv2 = '商品id,skuid,カラー,サイズ,商品名,セグメント,売価\nVAR-P3,VAR-P3-RD,赤,,既存商品,seg-01,500\n'
      await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv2) } })
      const p3Skus = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === p3Id)
      expect(p3Skus.find(s => s.isDefault)!.active).toBe(false)
      expect(p3Skus.find(s => s.code === 'VAR-P3-RD')).toMatchObject({ axis1Value: '赤', axis2Value: null, active: true })
      // 別商品に登録済みの SKU コードは隔離（グルーピングキーと固有 ID の整合を守る）
      const csv3 = '商品id,skuid,カラー,サイズ,商品名,セグメント,売価\nVAR-P4,VAR-P1-RD-S,赤,S,衝突商品,seg-01,100\n'
      const r3 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv3) } })
      const run3 = r3.json.data as { counts: Record<string, number>; errors: { message: string }[] }
      expect(run3.counts).toMatchObject({ applied: 0, failed: 1 })
      expect(run3.errors[0]!.message).toContain('別の商品')
    })

    it('バリアント軸取込: 商品レベルの作家（既定仕入先）・税区分・単位も突合して商品へ反映（作家 = 名称で解決・未解決はグループ隔離）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      // 作家（既定仕入先 = consignor_artist）を実取引先として登録
      const artist = await api('POST', '/v1/masters/companies', {
        as: ADMIN, body: { name: 'バリアント作家', partnerRoles: ['consignor_artist'] },
      })
      const artistId = (artist.json.data as { id: string }).id
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: '作家付きバリアントCSV', method: 'file_csv', encoding: 'utf8', targetEntity: 'product_variant',
          config: { hasHeader: true, delimiter: ',' },
        },
      })
      const srcId = (src.json.data as { id: string }).id
      // 作家 = 既定仕入先を名称で突合（連携キー未指定 = ID または名称の自動判定）・税区分/単位は ID で突合
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: '商品id', targetItemKey: 'productCode', columnIndex: 0 },
          { sourceField: 'skuid', targetItemKey: 'code', columnIndex: 1 },
          { sourceField: 'カラー', targetItemKey: 'axis1Value', columnIndex: 2 },
          { sourceField: '商品名', targetItemKey: 'productName', columnIndex: 3 },
          { sourceField: 'セグメント', targetItemKey: 'segmentId', columnIndex: 4 },
          { sourceField: '作家', targetItemKey: 'defaultSupplierCompanyId', columnIndex: 5 },
          { sourceField: '税区分', targetItemKey: 'taxRateId', columnIndex: 6 },
          { sourceField: '単位', targetItemKey: 'unitId', columnIndex: 7 },
        ] },
      })
      const csv = '商品id,skuid,カラー,商品名,セグメント,作家,税区分,単位\n'
        + 'VARW-1,VARW-1-RD,赤,作家皿,seg-01,バリアント作家,tax-10,unit-02\n'
        + 'VARW-2,VARW-2-RD,赤,未知作家皿,seg-01,存在しない作家,tax-10,unit-02\n'
      const r = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, filename: 'v.csv', contentBase64: b64(csv) },
      })
      expect(r.status).toBe(201)
      const run = r.json.data as { counts: Record<string, number>; errors: { message: string }[] }
      expect(run.counts).toMatchObject({ applied: 1, failed: 1 })
      expect(run.errors[0]!.message).toContain('既定仕入先') // 作家未解決グループは隔離
      type ProductRow = { code: string; defaultSupplierCompanyId: string | null; taxRateId: string | null; unitId: string | null }
      const products = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      expect(products.find(p => p.code === 'VARW-1'))
        .toMatchObject({ defaultSupplierCompanyId: artistId, taxRateId: 'tax-10', unitId: 'unit-02' })
      expect(products.some(p => p.code === 'VARW-2')).toBe(false) // 作家未解決グループは商品も作らない
    })

    it('バリアント軸取込の境界: 既定 SKU コード衝突の冪等・未送信フィールド保持・グループ内重複・グループ隔離（独立レビュー是正）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: {
          name: 'バリアント境界CSV', method: 'file_csv', encoding: 'utf8', targetEntity: 'product_variant',
          config: { hasHeader: true, delimiter: ',' },
        },
      })
      const srcId = (src.json.data as { id: string }).id
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: '商品id', targetItemKey: 'productCode', columnIndex: 0 },
          { sourceField: 'skuid', targetItemKey: 'code', columnIndex: 1 },
          { sourceField: 'カラー', targetItemKey: 'axis1Value', columnIndex: 2 },
          { sourceField: 'サイズ', targetItemKey: 'axis2Value', columnIndex: 3 },
          { sourceField: '商品名', targetItemKey: 'productName', columnIndex: 4 },
          { sourceField: 'セグメント', targetItemKey: 'segmentId', columnIndex: 5 },
          { sourceField: '売価', targetItemKey: 'sellPrice', transform: 'number', columnIndex: 6 },
          { sourceField: 'JAN', targetItemKey: 'janCode', columnIndex: 7 },
        ] },
      })
      // 既定 SKU（コード = 商品コード）を持つ既存商品を用意（ベース行を含むバリアント表の現実ケース）
      const prd = await api('POST', '/v1/akebono/products', {
        as: ADMIN, body: { code: 'VAR2-P1', name: 'ベース行商品', segmentId: 'seg-01' },
      })
      const pId = (prd.json.data as { id: string }).id
      const header = '商品id,skuid,カラー,サイズ,商品名,セグメント,売価,JAN\n'
      // 行1 = 既定 SKU とコード衝突（実 SKU として新規作成される）・行3/4 = グループ内重複（後勝ち更新）・
      // 行5 = 新規商品グループでセグメント未解決（グループ全行隔離・商品を作らない）
      const csv1 = header
        + 'VAR2-P1,VAR2-P1,赤,S,,,1000,4900000000010\n'
        + 'VAR2-P1,VAR2-P1-BL,青,M,,,1200,\n'
        + 'VAR2-P1,VAR2-P1-GD,金,L,,,1300,\n'
        + 'VAR2-P1,VAR2-P1-GD,金,L,,,1350,\n'
        + 'VAR2-NG,VAR2-NG-1,赤,S,NG商品,未知セグメント,100,\n'
      const r1 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv1) } })
      const run1 = r1.json.data as { counts: Record<string, number>; errors: { message: string }[] }
      expect(run1.counts).toMatchObject({ staged: 5, applied: 4, failed: 1 })
      expect(run1.errors[0]!.message).toContain('事業セグメント')
      type SkuRow = { id: string; productId: string; code: string; janCode: string | null; axis1Value: string | null; axis2Value: string | null; sellPrice: number | null; isDefault: boolean; active: boolean }
      type ProductRow = { id: string; code: string; name: string }
      const skus1 = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === pId)
      // 既定 SKU は無効化・実 SKU 3 件（衝突行 VAR2-P1 は既定 SKU の更新ではなく新規の実 SKU）・重複行は 1 件に収束（後勝ち 1350）
      expect(skus1.find(s => s.isDefault)!.active).toBe(false)
      const real1 = skus1.filter(s => !s.isDefault)
      expect(real1).toHaveLength(3)
      expect(real1.find(s => s.code === 'VAR2-P1')).toMatchObject({ axis1Value: '赤', axis2Value: 'S', janCode: '4900000000010', active: true })
      expect(real1.find(s => s.code === 'VAR2-P1-GD')).toMatchObject({ sellPrice: 1350 })
      // グループ全行隔離の商品は作られない（status=failed の run がデータを変えない不変条件の系）
      const products1 = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      expect(products1.some(p => p.code === 'VAR2-NG')).toBe(false)
      // 商品名は空セルのため既存値を保持
      expect(products1.find(p => p.id === pId)!.name).toBe('ベース行商品')
      // 同一ファイル再実行 = 冪等（SKU が増えない・衝突行は実 SKU への更新に収束）
      const r2 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv1) } })
      expect((r2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 5, applied: 4, failed: 1 })
      const skus2 = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === pId)
      expect(skus2.filter(s => !s.isDefault)).toHaveLength(3)
      expect(skus2.filter(s => s.code === 'VAR2-P1' && s.active)).toHaveLength(1)
      // 未送信フィールドの保持（CLAUDE.md Zod v4 節の回帰方針）: JAN 空のファイルを再取込しても jan_code が消えない
      const csv2 = header + 'VAR2-P1,VAR2-P1,赤,S,,,1000,\n'
      await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv2) } })
      const skus3 = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).filter(s => s.productId === pId)
      expect(skus3.find(s => s.code === 'VAR2-P1' && !s.isDefault)).toMatchObject({ janCode: '4900000000010', axis1Value: '赤' })
      // 別商品の**既定 SKU** コード（= 他商品の商品コード）と衝突する行は隔離（第 2 巡監査 MINOR-A の回帰）
      await api('POST', '/v1/akebono/products', {
        as: ADMIN, body: { code: 'VAR2-OTHER', name: '別商品', segmentId: 'seg-01' },
      })
      const csv3 = header + 'VAR2-NEW,VAR2-OTHER,赤,S,誤マッピング商品,seg-01,100,\n'
      const r4 = await api('POST', '/v1/akebono/import-runs', { as: ADMIN, body: { sourceId: srcId, contentBase64: b64(csv3) } })
      const run4 = r4.json.data as { counts: Record<string, number>; errors: { message: string }[] }
      expect(run4.counts).toMatchObject({ staged: 1, applied: 0, failed: 1 })
      expect(run4.errors[0]!.message).toContain('別の商品')
      // 全行隔離のためグループの商品も作られない
      const products2 = (await api('GET', '/v1/akebono/products', { as: ADMIN })).json.data as ProductRow[]
      expect(products2.some(p => p.code === 'VAR2-NEW')).toBe(false)
    })

    it('マスタ間連携キー（突合キー）: 取引先カスタム項目・SKU JAN で突合して取込・複数一致は隔離（0053）', async () => {
      const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
      // 突合先: custom.extCode を持つ取引先と、JAN コードを振った SKU
      const compA = await api('POST', '/v1/masters/companies', {
        as: ADMIN, body: { kind: 'customer', name: '連携商店A', primaryIndustryId: '', industryIds: [], custom: { extCode: 'EXT-001' } },
      })
      const companyId = (compA.json.data as { id: string }).id
      const prd = await api('POST', '/v1/akebono/products', {
        as: ADMIN, body: { code: 'LNK-P1', name: '連携商品', segmentId: 'seg-01' },
      })
      const prdId = (prd.json.data as { id: string }).id
      type SkuRow = { id: string; productId: string }
      const defSku = ((await api('GET', '/v1/akebono/product-skus', { as: ADMIN })).json.data as SkuRow[]).find(s => s.productId === prdId)!
      await api('PATCH', `/v1/akebono/product-skus/${defSku.id}`, { as: ADMIN, body: { janCode: '4900000000001' } })
      const src = await api('POST', '/v1/akebono/import-sources', {
        as: ADMIN, body: { name: '売上（外部コード連携）', method: 'file_json', encoding: 'utf8', targetEntity: 'sales_record' },
      })
      const srcId = (src.json.data as { id: string }).id
      // 突合キーの検証: 参照先マスタで使えないキーは保存時に AKO-IMP-008
      expect((await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: 'customer', targetItemKey: 'companyId', jsonKey: 'customer', lookupField: 'code' },
        ] },
      })).json.error?.code).toBe('AKO-IMP-008')
      // companyId = 取引先カスタム項目（custom.extCode）・skuId = JAN コードで突合
      await api('POST', '/v1/akebono/import-mappings', {
        as: ADMIN, body: { sourceId: srcId, fields: [
          { sourceField: 'date', targetItemKey: 'salesDate', jsonKey: 'date' },
          { sourceField: 'customer', targetItemKey: 'companyId', jsonKey: 'customer', lookupField: 'custom.extCode' },
          { sourceField: 'segment', targetItemKey: 'segmentId', jsonKey: 'segment' },
          { sourceField: 'jan', targetItemKey: 'skuId', jsonKey: 'jan', lookupField: 'janCode' },
          { sourceField: 'qty', targetItemKey: 'qty', jsonKey: 'qty' },
          { sourceField: 'price', targetItemKey: 'unitPrice', jsonKey: 'price' },
        ] },
      })
      const payload = [
        { date: '2026-08-01', customer: 'EXT-001', segment: 'seg-01', jan: '4900000000001', qty: 2, price: 800 },
        { date: '2026-08-02', customer: 'EXT-404', segment: 'seg-01', jan: '4900000000001', qty: 1, price: 800 },
      ]
      const r1 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(JSON.stringify(payload)) },
      })
      const run1 = r1.json.data as { counts: Record<string, number>; errors: { message: string }[] }
      expect(run1.counts).toMatchObject({ staged: 2, applied: 1, failed: 1 })
      expect(run1.errors[0]!.message).toContain('突合キー')
      type SalesRow = { sourceKind: string; companyId: string; skuId: string; amount: number }
      const sales = (await api('GET', '/v1/akebono/sales-records', { as: ADMIN })).json.data as SalesRow[]
      const mine = sales.filter(s => s.sourceKind === 'import' && s.companyId === companyId)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ skuId: defSku.id, amount: 1600 })
      // 突合キーの複数一致（同じ extCode の取引先を追加）= 一意に解決できず隔離
      await api('POST', '/v1/masters/companies', {
        as: ADMIN, body: { kind: 'customer', name: '連携商店B', primaryIndustryId: '', industryIds: [], custom: { extCode: 'EXT-001' } },
      })
      const r2 = await api('POST', '/v1/akebono/import-runs', {
        as: ADMIN, body: { sourceId: srcId, contentBase64: b64(JSON.stringify(payload)) },
      })
      expect((r2.json.data as { counts: Record<string, number> }).counts).toMatchObject({ staged: 2, applied: 0, failed: 2 })
    })
  })

  // ---------- ダッシュボード AI レポート保管（F-41）: 導出キャッシュ upsert ----------
  describe('ダッシュボード保管 F-41', () => {
    it('セグメント: 未生成は null → 生成で保管（GA 未連携はメディア軸 0・llm=false）→ 再生成は upsert（同一行）', async () => {
      const seg = 'seg-04'
      expect((await api('GET', `/v1/akebono/dashboard-insights?scope=segment&segmentId=${seg}`, { as: MEMBER })).json.data)
        .toBeNull()
      const gen = await api('POST', '/v1/akebono/dashboard-insights/generate', {
        as: MEMBER, body: { scope: 'segment', segmentId: seg },
      })
      expect(gen.status).toBe(200)
      const row = gen.json.data as {
        id: string; llm: boolean; periodKey: string
        metrics: { mediaAvailable: boolean; snapshot: { mediaConnected: boolean } }
        insight: { executiveSummary: string }
      }
      expect(row.llm).toBe(false) // vertexProjectId 未設定 = ヒューリスティック
      expect(row.metrics.snapshot.mediaConnected).toBe(false) // GA 未連携（テスト env）
      expect(row.insight.executiveSummary.length).toBeGreaterThan(0)
      const stored = await api('GET', `/v1/akebono/dashboard-insights?scope=segment&segmentId=${seg}`, { as: MEMBER })
      expect((stored.json.data as { id: string }).id).toBe(row.id)
      // 再生成は upsert = 同一行（id が変わらない = 重複行を作らない）
      const regen = await api('POST', '/v1/akebono/dashboard-insights/generate', {
        as: MEMBER, body: { scope: 'segment', segmentId: seg },
      })
      expect((regen.json.data as { id: string }).id).toBe(row.id)
    })

    it('会社全体: scope=company で全業態ロールアップを生成・保管（segmentId 不要）', async () => {
      const gen = await api('POST', '/v1/akebono/dashboard-insights/generate', { as: MEMBER, body: { scope: 'company' } })
      expect(gen.status).toBe(200)
      const row = gen.json.data as { metrics: { segmentCount: number; connectedCount: number }; insight: { executiveSummary: string } }
      expect(row.metrics.segmentCount).toBeGreaterThan(0)
      expect(row.metrics.connectedCount).toBe(0) // GA 未連携
      const stored = await api('GET', '/v1/akebono/dashboard-insights?scope=company', { as: MEMBER })
      expect(stored.json.data).not.toBeNull()
      // scope 不正は 400
      expect((await api('POST', '/v1/akebono/dashboard-insights/generate', { as: MEMBER, body: { scope: 'x' } })).status).toBe(400)
    })

    it('会社全体はサーバー側でも売上権限を要求（監査-4。売上 deny の member は 403・admin は 200）', async () => {
      // 運用デフォルト（member/hr は売上 deny）を再有効化してサーバーゲートを検証（batch7f と同型）
      await pool.query(`UPDATE permission_rules SET active = true WHERE id LIKE 'pr-def-%'`)
      clearPermissionCache()
      try {
        expect((await api('GET', '/v1/akebono/dashboard-insights?scope=company', { as: MEMBER })).json.error?.code).toBe('AKO-PRM-001')
        expect((await api('POST', '/v1/akebono/dashboard-insights/generate', { as: MEMBER, body: { scope: 'company' } })).status).toBe(403)
        // 業態単位（scope=segment）は業態の日常業務ビュー = 全ロール可（売上 deny でも 200）
        expect((await api('GET', '/v1/akebono/dashboard-insights?scope=segment&segmentId=seg-04', { as: MEMBER })).status).toBe(200)
        // 管理者は会社全体も可
        expect((await api('POST', '/v1/akebono/dashboard-insights/generate', { as: ADMIN, body: { scope: 'company' } })).status).toBe(200)
      } finally {
        await pool.query(`UPDATE permission_rules SET active = false WHERE id LIKE 'pr-def-%'`)
        clearPermissionCache()
      }
    })
  })

  // ---------- 委託精算の取消（原則9.5）: 冪等・二重取消ガード・再締め ----------
  describe('委託精算の取消', () => {
    const seg = 'seg-04'
    const month = '2026-05'
    let storeId = ''
    let artistId = ''
    let skuId = ''
    let saleId = ''
    let marginId = ''

    it('締め → 取消（マージン赤伝・支払通知の論理取消・売上リンク解除）→ 二重取消 409 → 再締め可能', async () => {
      const store = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'PD店', partnerRoles: ['store', 'customer'] } })
      storeId = (store.json.data as { id: string }).id
      const artist = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'PD作家', partnerRoles: ['consignor_artist'] } })
      artistId = (artist.json.data as { id: string }).id
      const product = await api('POST', '/v1/akebono/products', {
        as: MEMBER, body: { code: 'PD-01', name: 'PD皿', segmentId: seg, listPrice: 1000, standardCost: 400, taxRateId: 'tax-10', defaultSupplierCompanyId: artistId },
      })
      const productId = (product.json.data as { id: string }).id
      skuId = ((await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[])
        .find(s => s.productId === productId)!.id
      await api('POST', '/v1/masters/consignment-terms', { as: ADMIN, body: { companyId: storeId, segmentId: seg, role: 'store', marginRate: 0.30, taxRateId: 'tax-10', validFrom: '2026-01-01' } })
      await api('POST', '/v1/masters/consignment-terms', { as: ADMIN, body: { companyId: artistId, segmentId: seg, role: 'consignor_artist', payoutMethod: 'sales_rate', payoutRate: 0.60, liabilityTiming: 'on_sale', taxRateId: 'tax-10', validFrom: '2026-01-01' } })
      const sale = await api('POST', '/v1/akebono/sales-records', {
        as: MEMBER, body: { salesDate: `${month}-10`, companyId: storeId, segmentId: seg, skuId, qty: 2, unitPrice: 1000 },
      })
      saleId = (sale.json.data as { id: string }).id

      const close = await api('POST', '/v1/akebono/consignment/close', { as: MEMBER, body: { segmentId: seg, month } })
      expect(close.status).toBe(201)
      expect((close.json.data as { invoices: number; notices: number })).toMatchObject({ invoices: 1, notices: 1 })
      // 売上に精算リンクが張られる
      const linked = ((await api('GET', '/v1/akebono/sales-records', { as: MEMBER })).json.data as { id: string; invoiceId: string | null }[])
        .find(r => r.id === saleId)!
      expect(linked.invoiceId).not.toBeNull()
      marginId = linked.invoiceId!

      // --- 取消 ---
      const cancel = await api('POST', '/v1/akebono/consignment/cancel', { as: MEMBER, body: { segmentId: seg, month } })
      expect(cancel.status).toBe(200)
      expect((cancel.json.data as { credited: number; voidedNotices: number; unlinked: number }))
        .toMatchObject({ credited: 1, voidedNotices: 1, unlinked: 1 })
      const invs = (await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as
        { id: string; status: string; invoiceType: string; totalAmount: number; creditFor: string | null }[]
      // 元マージンは void・赤伝（マイナス請求）が追記されている
      expect(invs.find(v => v.id === marginId)!.status).toBe('void')
      const credit = invs.find(v => v.creditFor === marginId)!
      expect(credit.totalAmount).toBeLessThan(0)
      // 支払通知は論理取消（voidedAt 設定）
      const notices = (await api('GET', '/v1/akebono/payment-notices', { as: MEMBER })).json.data as
        { id: string; companyId: string; voidedAt: string | null; status: string }[]
      const voided = notices.find(n => n.companyId === artistId)!
      expect(voided.voidedAt).not.toBeNull()
      // 取消済み通知の確定は 409
      expect((await api('POST', `/v1/akebono/payment-notices/${voided.id}/confirm`, { as: MEMBER })).json.error?.code).toBe('AKO-BIL-007')
      // 売上リンクは解除（再締め可能）
      expect(((await api('GET', '/v1/akebono/sales-records', { as: MEMBER })).json.data as { id: string; invoiceId: string | null }[])
        .find(r => r.id === saleId)!.invoiceId).toBeNull()

      // --- 二重取消ガード（既に取消済み = 409 AKO-BIL-010）---
      expect((await api('POST', '/v1/akebono/consignment/cancel', { as: MEMBER, body: { segmentId: seg, month } })).json.error?.code)
        .toBe('AKO-BIL-010')

      // --- 再締め（取消後は同月を再度締められる = 冪等の再開）---
      const reclose = await api('POST', '/v1/akebono/consignment/close', { as: MEMBER, body: { segmentId: seg, month } })
      expect(reclose.status).toBe(201)
      expect((reclose.json.data as { invoices: number })).toMatchObject({ invoices: 1 })
    })

    it('MAJOR-1: 入金済みマージン・確定済み通知を含むと取消拒否（AKO-BIL-011）→ 入金取消後は取消可能', async () => {
      // 直前の it の再締めで seg-04/2026-05 の新バッチが有効。現行 issued マージンへ部分入金する
      const marginNow = ((await api('GET', '/v1/akebono/invoices', { as: MEMBER })).json.data as
        { id: string; invoiceType: string; status: string; creditFor: string | null; segmentId: string | null; periodFrom: string }[])
        .find(v => v.invoiceType === 'consignment_margin' && v.status === 'issued' && !v.creditFor && v.segmentId === seg && v.periodFrom === `${month}-01`)!
      const rcpt = await api('POST', '/v1/akebono/payment-receipts', { as: MEMBER, body: { invoiceId: marginNow.id, amount: 100, method: '振込' } })
      expect(rcpt.status).toBe(201)
      const rcptId = (rcpt.json.data as { id: string }).id
      // 有効入金があると取消拒否（片側反転による孤児入金を防ぐ）
      expect((await api('POST', '/v1/akebono/consignment/cancel', { as: MEMBER, body: { segmentId: seg, month } })).json.error?.code)
        .toBe('AKO-BIL-011')
      // 入金を取消すれば取消可能に戻る
      expect((await api('POST', `/v1/akebono/payment-receipts/${rcptId}/cancel`, { as: MEMBER })).status).toBe(200)
      expect((await api('POST', '/v1/akebono/consignment/cancel', { as: MEMBER, body: { segmentId: seg, month } })).status).toBe(200)

      // 確定済み支払通知のブロック: 再締め → 通知確定 → 取消は AKO-BIL-011
      expect((await api('POST', '/v1/akebono/consignment/close', { as: MEMBER, body: { segmentId: seg, month } })).status).toBe(201)
      const notice = ((await api('GET', '/v1/akebono/payment-notices', { as: MEMBER })).json.data as
        { id: string; segmentId: string; periodFrom: string; status: string; voidedAt: string | null }[])
        .find(n => n.segmentId === seg && n.periodFrom === `${month}-01` && n.status === 'draft' && !n.voidedAt)!
      expect((await api('POST', `/v1/akebono/payment-notices/${notice.id}/confirm`, { as: MEMBER })).status).toBe(200)
      expect((await api('POST', '/v1/akebono/consignment/cancel', { as: MEMBER, body: { segmentId: seg, month } })).json.error?.code)
        .toBe('AKO-BIL-011')
    })
  })

  // ---------- 出荷実績 → 売上自動計上（sourceKind='shipment'）: 二重計上防止 ----------
  describe('出荷 → 売上自動計上', () => {
    const seg = 'seg-04'
    let customerId = ''
    let depositStoreId = ''
    let depositWhId = ''
    let skuId = ''

    it('顧客出荷は売上を自動計上（源=shipment・在庫減）・店舗預けは計上不可 409', async () => {
      const cust = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'PD顧客', partnerRoles: ['customer'] } })
      customerId = (cust.json.data as { id: string }).id
      const product = await api('POST', '/v1/akebono/products', {
        as: MEMBER, body: { code: 'PD-SHIP', name: 'PD出荷品', segmentId: seg, listPrice: 1500, standardCost: 600, taxRateId: 'tax-10' },
      })
      const productId = (product.json.data as { id: string }).id
      skuId = ((await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as { id: string; productId: string }[])
        .find(s => s.productId === productId)!.id
      // 在庫を積む（wh-01 = 自社倉庫。found で +10）
      await api('POST', '/v1/akebono/inventory/adjust', { as: MEMBER, body: { skuId, warehouseId: 'wh-01', qty: 10, reason: 'found' } })

      // 顧客への直接出荷 + 売上自動計上
      const ship = await api('POST', '/v1/akebono/outbound-results', {
        as: MEMBER, body: { warehouseId: 'wh-01', companyId: customerId, segmentId: seg, postSales: true, lines: [{ skuId, qty: 3 }] },
      })
      expect(ship.status).toBe(201)
      const sales = (await api('GET', '/v1/akebono/sales-records', { as: MEMBER })).json.data as
        { skuId: string; sourceKind: string; qty: number; unitPrice: number; amount: number; sourceRef: string | null; companyId: string }[]
      const shipmentSales = sales.filter(s => s.sourceKind === 'shipment' && s.companyId === customerId)
      expect(shipmentSales).toHaveLength(1)
      expect(shipmentSales[0]!).toMatchObject({ qty: 3, unitPrice: 1500, amount: 4500, skuId })
      expect(shipmentSales[0]!.sourceRef).toMatch(/^obr:/)
      // 在庫が 10 → 7 に減っている
      const bal = ((await api('GET', '/v1/akebono/inventory-balances', { as: MEMBER })).json.data as { skuId: string; warehouseId: string; qty: number }[])
        .find(b => b.skuId === skuId && b.warehouseId === 'wh-01')!
      expect(bal.qty).toBe(7)

      // 店舗預けの出荷は売上計上できない（409 AKO-OUT-005）= 二重の売上導線を作らない
      const store = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { name: 'PD預け店', partnerRoles: ['store'] } })
      depositStoreId = (store.json.data as { id: string }).id
      const wh = await api('POST', '/v1/masters/warehouses', { as: ADMIN, body: { name: 'PD預け倉庫', kind: 'store_deposit', companyId: depositStoreId } })
      depositWhId = (wh.json.data as { id: string }).id
      const ng = await api('POST', '/v1/akebono/outbound-results', {
        as: MEMBER, body: { warehouseId: 'wh-01', companyId: depositStoreId, segmentId: seg, postSales: true, lines: [{ skuId, qty: 1 }] },
      })
      expect(ng.status).toBe(409)
      expect(ng.json.error?.code).toBe('AKO-OUT-005')
      // ロールバックされ在庫は 7 のまま（部分適用を作らない）
      const bal2 = ((await api('GET', '/v1/akebono/inventory-balances', { as: MEMBER })).json.data as { skuId: string; warehouseId: string; qty: number }[])
        .find(b => b.skuId === skuId && b.warehouseId === 'wh-01')!
      expect(bal2.qty).toBe(7)
      expect(depositWhId).toBeTruthy()
    })

    it('二重計上防止: source_ref 部分一意 INDEX（0038）が同一出荷明細の売上重複を拒否（DB 制約 = 最終防衛。m2）', async () => {
      // 同一 source_ref + source_kind='shipment' の 2 行は 23505（ルートは AKO-OUT-005 409 へ変換）
      const dup = await pool.query(
        `INSERT INTO sales_records (id, code, sales_date, company_id, segment_id, sku_id, qty, unit_price, amount, source_kind, source_ref)
         VALUES ('sr-d1', 'SRD-1', '2026-07-01', $1, $2, $3, 1, 100, 100, 'shipment', 'obr:dup-x'),
                ('sr-d2', 'SRD-2', '2026-07-01', $1, $2, $3, 1, 100, 100, 'shipment', 'obr:dup-x')`,
        [customerId, seg, skuId]).then(() => null).catch(e => e as { code?: string })
      expect(dup?.code).toBe('23505')
    })
  })
})

describe('顧客ログ', () => {
  let companyId = ''
  let otherCompanyId = ''
  let contactId = ''
  let logId = ''
  const today = todayJst()

  beforeAll(async () => {
    const co = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { kind: 'customer', name: '顧客ログ商事' } })
    companyId = (co.json.data as { id: string }).id
    const co2 = await api('POST', '/v1/masters/companies', { as: ADMIN, body: { kind: 'customer', name: '別顧客社' } })
    otherCompanyId = (co2.json.data as { id: string }).id
    const ct = await api('POST', '/v1/masters/contacts', { as: ADMIN, body: { companyId, name: '窓口 太郎', keyPerson: 2 } })
    contactId = (ct.json.data as { id: string }).id
  })

  it('登録の入力検証（AKO-CLG-001）と会社/担当者の不整合（AKO-CLG-003）', async () => {
    // 会話内容なし・会社なし・日付不正・時刻不正はいずれも AKO-CLG-001
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId, body: '' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId: '', body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: '2026-13-40', companyId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, logTime: '25:99', companyId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    // 担当者が選択会社に属さない → AKO-CLG-003
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId: otherCompanyId, contactId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-003')
  })

  it('本人が登録・一覧取得できる（他人の記録は本人スコープで見えない）', async () => {
    const created = await api('POST', '/v1/customer-logs', {
      as: MEMBER, body: { logDate: today, logTime: '14:30', companyId, contactId, title: '初回商談', body: '価格感の確認。次回見積提示。' },
    })
    expect(created.status).toBe(201)
    logId = (created.json.data as { id: string }).id
    const mine = (await api('GET', '/v1/customer-logs', { as: MEMBER })).json.data as { id: string }[]
    expect(mine.some(l => l.id === logId)).toBe(true)
    // HR は本人スコープのため MEMBER の記録が既定一覧に出ない
    const hr = (await api('GET', '/v1/customer-logs', { as: HR })).json.data as { id: string }[]
    expect(hr.some(l => l.id === logId)).toBe(false)
    // from/to に実在しない日（2026-02-30）を渡しても 500 にならない（::date キャストの 22007 回避 = フィルタ無視）
    const badDate = await api('GET', '/v1/customer-logs?from=2026-02-30&to=2026-13-40', { as: MEMBER })
    expect(badDate.status).toBe(200)
    expect((badDate.json.data as { id: string }[]).some(l => l.id === logId)).toBe(true)
  })

  it('編集は本人のみ・部分更新は未指定項目を保持する（原則7・CLAUDE.md 部分更新原則）', async () => {
    // 他人は編集不可（403 AKO-CLG-002）
    expect((await api('PATCH', `/v1/customer-logs/${logId}`, { as: HR, body: { body: '乗っ取り' } })).status).toBe(403)
    // body だけ更新 → companyId/contactId/logDate/logTime/title は保持される
    const upd = await api('PATCH', `/v1/customer-logs/${logId}`, { as: MEMBER, body: { body: '価格合意。契約手続きへ。' } })
    expect(upd.status).toBe(200)
    const row = upd.json.data as { body: string; companyId: string; contactId: string; logTime: string; title: string }
    expect(row.body).toBe('価格合意。契約手続きへ。')
    expect(row.companyId).toBe(companyId)
    expect(row.contactId).toBe(contactId)
    expect(row.logTime).toBe('14:30')
    expect(row.title).toBe('初回商談')
  })

  it('取消・復元は本人のみ・冪等（原則9.5）', async () => {
    expect((await api('POST', `/v1/customer-logs/${logId}/archive`, { as: HR })).status).toBe(403)
    expect((await api('POST', `/v1/customer-logs/${logId}/archive`, { as: MEMBER })).status).toBe(200)
    // 取消済みは既定一覧（active のみ）から外れ、includeArchived=1 でのみ見える
    expect(((await api('GET', '/v1/customer-logs', { as: MEMBER })).json.data as { id: string }[]).some(l => l.id === logId)).toBe(false)
    expect(((await api('GET', '/v1/customer-logs?includeArchived=1', { as: MEMBER })).json.data as { id: string }[]).some(l => l.id === logId)).toBe(true)
    // 二重取消は冪等（200 + warning）
    expect((await api('POST', `/v1/customer-logs/${logId}/archive`, { as: MEMBER })).status).toBe(200)
    // 復元で一覧へ戻る
    expect((await api('POST', `/v1/customer-logs/${logId}/restore`, { as: MEMBER })).status).toBe(200)
    expect(((await api('GET', '/v1/customer-logs', { as: MEMBER })).json.data as { id: string }[]).some(l => l.id === logId)).toBe(true)
  })

  it('項目拡張: 開始/終了時刻・属性タグ・自社担当者・担当者メモ必須（2026-07-31 拡張・議事録メモは 2026-08-03 廃止）', async () => {
    // 終了のみ / 終了 <= 開始 / 終了の書式不正はいずれも AKO-CLG-001
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, endTime: '15:00', companyId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, logTime: '15:00', endTime: '15:00', companyId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, logTime: '15:00', endTime: '99:99', companyId, body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    // 担当者メモ（body）が空は AKO-CLG-001（議事録メモ廃止後は body 単独必須）
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId, body: '' } })).json.error?.code).toBe('AKO-CLG-001')
    // 廃止済みの minutesMemo を送っても body が空なら弾く（未知キーは無視・保管もされない）
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId, body: '', minutesMemo: '無視される' } })).json.error?.code).toBe('AKO-CLG-001')
    // タグ上限（10 件）超過は AKO-CLG-001
    expect((await api('POST', '/v1/customer-logs', {
      as: MEMBER, body: { logDate: today, companyId, body: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
    })).json.error?.code).toBe('AKO-CLG-001')
    // 担当者メモ + 開始/終了 + タグ（trim・重複除去）+ 自社担当者の明示指定
    const created = await api('POST', '/v1/customer-logs', {
      as: MEMBER,
      body: {
        logDate: today, logTime: '10:00', endTime: '10:45', companyId, contactId,
        tags: ['商談', '商談', ' 取材 '], body: '担当者メモで登録', staffMemberId: HR,
      },
    })
    expect(created.status).toBe(201)
    const row = created.json.data as {
      logTime: string; endTime: string; tags: string[]; staffMemberId: string; body: string
    }
    expect(row.logTime).toBe('10:00')
    expect(row.endTime).toBe('10:45')
    expect(row.tags).toEqual(['商談', '取材'])
    expect(row.staffMemberId).toBe(HR)
    expect(row.body).toBe('担当者メモで登録')
    expect('minutesMemo' in row).toBe(false) // 廃止 = 応答に含まれない
    // 自社担当者の未指定はログインユーザー（既定 = 記録者）
    const defaulted = await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId, body: '既定担当者の確認' } })
    expect((defaulted.json.data as { staffMemberId: string }).staffMemberId).toBe(MEMBER)
    // 実在しない自社担当者は 400（FK → AKO-CLG-001）
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, companyId, body: 'x', staffMemberId: 'm-nope' } })).json.error?.code).toBe('AKO-CLG-001')
  })

  it('部分更新: 新項目（タグ・終了時刻・自社担当者・担当者メモ）も送っていないフィールドが保持される', async () => {
    const created = await api('POST', '/v1/customer-logs', {
      as: MEMBER,
      body: {
        logDate: today, logTime: '09:00', endTime: '09:30', companyId, contactId,
        tags: ['イベント'], staffMemberId: HR, title: '保持確認', body: '担当者メモ',
      },
    })
    const id = (created.json.data as { id: string }).id
    const upd = await api('PATCH', `/v1/customer-logs/${id}`, { as: MEMBER, body: { title: '保持確認（更新）' } })
    expect(upd.status).toBe(200)
    const row = upd.json.data as {
      logTime: string; endTime: string; tags: string[]; staffMemberId: string; body: string
    }
    expect(row.logTime).toBe('09:00')
    expect(row.endTime).toBe('09:30')
    expect(row.tags).toEqual(['イベント'])
    expect(row.staffMemberId).toBe(HR)
    expect(row.body).toBe('担当者メモ')
    // マージ後の全体検証: 開始時刻だけを終了時刻より後へ動かす更新は 400（AKO-CLG-001）
    expect((await api('PATCH', `/v1/customer-logs/${id}`, { as: MEMBER, body: { logTime: '10:00' } })).json.error?.code).toBe('AKO-CLG-001')
    // 検証順パリティ（2 巡目 MINOR-1 回帰）: 範囲不正 + タグ上限超過の同時指定は「範囲エラーが先」
    // （shared/domain/customer-log の宣言順 = POST・モックと同一）
    const both = await api('PATCH', `/v1/customer-logs/${id}`, {
      as: MEMBER,
      body: { logTime: '10:00', endTime: '09:00', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
    })
    expect(both.json.error?.message).toBe('終了時間は開始時間より後にしてください')
  })

  it('コンボボックス新規登録: 未登録の会社・担当者はマスタ登録して反映・既存名は名寄せ（一般メンバーでも可）', async () => {
    const created = await api('POST', '/v1/customer-logs', {
      as: MEMBER,
      body: { logDate: today, newCompanyName: '新規コンボ商事', newContactName: '新規 花子', body: '新規マスタ経由の記録' },
    })
    expect(created.status).toBe(201)
    const row = created.json.data as { companyId: string; contactId: string }
    expect(row.companyId).toBeTruthy()
    expect(row.contactId).toBeTruthy()
    // マスタへ登録されている（会社 = kind 'customer' / 担当者 = その会社所属）
    const co = await pool.query(`SELECT kind, name FROM companies WHERE id = $1`, [row.companyId])
    expect(co.rows[0]).toEqual({ kind: 'customer', name: '新規コンボ商事' })
    const ct = await pool.query(`SELECT company_id AS cid, name FROM contacts WHERE id = $1`, [row.contactId])
    expect(ct.rows[0]).toEqual({ cid: row.companyId, name: '新規 花子' })
    // 正規化名（法人格・空白除去）の一致は既存へ名寄せ = 重複マスタを作らない
    const merged = await api('POST', '/v1/customer-logs', {
      as: MEMBER,
      body: { logDate: today, newCompanyName: '株式会社 新規コンボ商事', newContactName: '新規花子', body: '名寄せの確認' },
    })
    expect(merged.status).toBe(201)
    expect((merged.json.data as { companyId: string }).companyId).toBe(row.companyId)
    expect((merged.json.data as { contactId: string }).contactId).toBe(row.contactId)
    // 会社もどちらも未指定・法人格のみ（正規化で空）は AKO-CLG-001（意味のないマスタを作らない）
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, newCompanyName: '   ', body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    expect((await api('POST', '/v1/customer-logs', { as: MEMBER, body: { logDate: today, newCompanyName: '株式会社', body: 'x' } })).json.error?.code).toBe('AKO-CLG-001')
    // 別名（aliases）でも既存へ名寄せされる（マスタの別名運用と整合）
    const aliased = await api('POST', '/v1/masters/companies', {
      as: ADMIN, body: { kind: 'customer', name: 'エイリアス電機', aliases: ['アリデン'] },
    })
    const aliasedId = (aliased.json.data as { id: string }).id
    const byAlias = await api('POST', '/v1/customer-logs', {
      as: MEMBER, body: { logDate: today, newCompanyName: 'アリデン', body: '別名で名寄せ' },
    })
    expect((byAlias.json.data as { companyId: string }).companyId).toBe(aliasedId)
    // PATCH でも新規登録名を反映できる（会社を新規名へ変更 → 旧担当者は所属不整合で 400）
    const logIdForPatch = (created.json.data as { id: string }).id
    expect((await api('PATCH', `/v1/customer-logs/${logIdForPatch}`, {
      as: MEMBER, body: { newCompanyName: '第二コンボ物産' },
    })).json.error?.code).toBe('AKO-CLG-003')
    const moved = await api('PATCH', `/v1/customer-logs/${logIdForPatch}`, {
      as: MEMBER, body: { newCompanyName: '第二コンボ物産', contactId: '', newContactName: '' },
    })
    expect(moved.status).toBe(200)
    const movedRow = moved.json.data as { companyId: string; contactId: string | null }
    expect(movedRow.companyId).not.toBe(row.companyId)
    expect(movedRow.contactId).toBeNull()
  })

  it('他メンバーの記録は権限（customer-log + member:<id>）で許可された対象者のみ readonly 参照可', async () => {
    // 既定 = 参照不可（AKO-PRM-002）。自分の memberId 指定は常に可
    const denied = await api('GET', `/v1/customer-logs?memberId=${MEMBER}`, { as: HR })
    expect(denied.status).toBe(403)
    expect(denied.json.error?.code).toBe('AKO-PRM-002')
    expect((await api('GET', `/v1/customer-logs?memberId=${MEMBER}`, { as: MEMBER })).status).toBe(200)
    // HR に「MEMBER の顧客ログを参照可」を付与
    await pool.query(
      `INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
       VALUES ('pr-test-clog-view', 'member', $1, 'customer-log', $2, 'allow', true)
       ON CONFLICT (id) DO UPDATE SET active = true`,
      [HR, `member:${MEMBER}`])
    clearPermissionCache()
    try {
      const view = await api('GET', `/v1/customer-logs?memberId=${MEMBER}`, { as: HR })
      expect(view.status).toBe(200)
      const rows = view.json.data as { memberId: string }[]
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect(rows.every(l => l.memberId === MEMBER)).toBe(true) // 対象メンバーの行のみ
      // 参照権限は編集権限を与えない（他人の記録は依然 403）
      expect((await api('PATCH', `/v1/customer-logs/${logId}`, { as: HR, body: { body: 'x' } })).status).toBe(403)
      // 無関係な第三者（ADMIN）指定は依然 403
      expect((await api('GET', `/v1/customer-logs?memberId=${ADMIN}`, { as: HR })).json.error?.code).toBe('AKO-PRM-002')
    } finally {
      await pool.query(`DELETE FROM permission_rules WHERE id = 'pr-test-clog-view'`)
      clearPermissionCache()
    }
  })
})

describe('日報・週報の既読管理（オペレーター指示 2026-07-31。SoT = report_reads）', () => {
  const today = todayJst()
  const month = today.slice(0, 7)
  // 過去の固定週（月曜）を使う（当該週の週報は他テストと衝突しない）
  const weekStart = '2020-01-06'
  let dailyId = ''
  let weeklyId = ''

  beforeAll(async () => {
    // HR が日報・週報を提出 → MEMBER が既読管理する
    const daily = await api('PUT', '/v1/reports/daily', {
      as: HR,
      body: {
        date: today, status: 'submitted', reflection: '', issues: '', tomorrow: '', tomorrowPlans: [],
        entries: [{ theme: '既読テスト', projectId: '', task: '既読対象の作業', hours: 1, progress: 0 }],
      },
    })
    dailyId = (daily.json.data as { id: string }).id
    const weekly = await api('PUT', '/v1/reports/weekly', {
      as: HR,
      body: { weekStart, status: 'submitted', goalReview: '', mainWork: '既読テストの主要業務', issues: '', nextWeek: '' },
    })
    weeklyId = (weekly.json.data as { id: string }).id
  })

  it('GET /reads は kind と期間の指定が必須（全履歴ダンプを許容しない）', async () => {
    expect((await api('GET', '/v1/reports/reads', { as: MEMBER })).json.error?.code).toBe('AKO-GEN-001')
    expect((await api('GET', '/v1/reports/reads?kind=daily', { as: MEMBER })).json.error?.code).toBe('AKO-GEN-001')
    expect((await api('GET', '/v1/reports/reads?kind=weekly', { as: MEMBER })).json.error?.code).toBe('AKO-GEN-001')
    // 実在しない日付（2026-02-30）は ::date キャストの 500 を出さず 400
    expect((await api('GET', '/v1/reports/reads?kind=weekly&weekStart=2026-02-30', { as: MEMBER })).json.error?.code).toBe('AKO-GEN-001')
    expect((await api('GET', `/v1/reports/reads?kind=daily&month=${month}`, { as: MEMBER })).status).toBe(200)
  })

  it('既読にする → 一覧へ載る。再実行しても readAt は巻き戻らない（冪等 = 原則2）', async () => {
    // 初期状態: 未読
    const before = (await api('GET', `/v1/reports/reads?kind=daily&month=${month}`, { as: MEMBER })).json.data as string[]
    expect(before.includes(dailyId)).toBe(false)
    // 既読
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'daily', reportId: dailyId } })).status).toBe(200)
    const after = (await api('GET', `/v1/reports/reads?kind=daily&month=${month}`, { as: MEMBER })).json.data as string[]
    expect(after.includes(dailyId)).toBe(true)
    // 初回既読時刻を保持（再 PUT で read_at が更新されない）
    const t1 = (await pool.query(`SELECT read_at FROM report_reads WHERE member_id = $1 AND report_kind = 'daily' AND report_id = $2`, [MEMBER, dailyId])).rows[0].read_at
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'daily', reportId: dailyId } })).status).toBe(200)
    const t2 = (await pool.query(`SELECT read_at FROM report_reads WHERE member_id = $1 AND report_kind = 'daily' AND report_id = $2`, [MEMBER, dailyId])).rows[0].read_at
    expect(String(t2)).toBe(String(t1))
    // 既読は本人ごとに独立（ADMIN の一覧には出ない）
    const admin = (await api('GET', `/v1/reports/reads?kind=daily&month=${month}`, { as: ADMIN })).json.data as string[]
    expect(admin.includes(dailyId)).toBe(false)
    // 週報も同様
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'weekly', reportId: weeklyId } })).status).toBe(200)
    const weeklyReads = (await api('GET', `/v1/reports/reads?kind=weekly&weekStart=${weekStart}`, { as: MEMBER })).json.data as string[]
    expect(weeklyReads.includes(weeklyId)).toBe(true)
  })

  it('未読に戻せる（既読付与の取消フロー = 原則9.5・冪等）', async () => {
    expect((await api('DELETE', `/v1/reports/reads/daily/${dailyId}`, { as: MEMBER })).status).toBe(200)
    const after = (await api('GET', `/v1/reports/reads?kind=daily&month=${month}`, { as: MEMBER })).json.data as string[]
    expect(after.includes(dailyId)).toBe(false)
    // 行がなくても成功（冪等）
    expect((await api('DELETE', `/v1/reports/reads/daily/${dailyId}`, { as: MEMBER })).status).toBe(200)
    // kind 不正は 400
    expect((await api('DELETE', `/v1/reports/reads/nope/${dailyId}`, { as: MEMBER })).json.error?.code).toBe('AKO-GEN-001')
  })

  it('存在しない・参照できない対象は既読にできない（404 = 存在を秘匿）', async () => {
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'daily', reportId: 'dr-nope' } })).status).toBe(404)
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'weekly', reportId: 'wr-nope' } })).status).toBe(404)
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'nope', reportId: dailyId } })).json.error?.code).toBe('AKO-GEN-001')
    // kind の取り違え（daily に週報 id / weekly に日報 id）は対象不在として 404（別種の親を参照させない）
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'daily', reportId: weeklyId } })).status).toBe(404)
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'weekly', reportId: dailyId } })).status).toBe(404)
    // 下書き週報は本人以外は既読にできない（存在を秘匿 = 404）
    const draft = await api('PUT', '/v1/reports/weekly', {
      as: HR, body: { weekStart: '2020-01-13', status: 'draft', goalReview: '', mainWork: '下書き', issues: '', nextWeek: '' },
    })
    const draftId = (draft.json.data as { id: string }).id
    expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'weekly', reportId: draftId } })).status).toBe(404)
    // F-16-6 の参照 deny 対象者の日報・週報は既読にできない（一覧フィルタと同じ基準）
    await pool.query(
      `INSERT INTO permission_rules (id, subject_kind, subject_id, resource, field, effect, active)
       VALUES ('pr-test-read-deny', 'member', $1, 'reports', $2, 'deny', true)
       ON CONFLICT (id) DO UPDATE SET active = true`,
      [MEMBER, `member:${HR}`])
    clearPermissionCache()
    try {
      expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'daily', reportId: dailyId } })).status).toBe(404)
      expect((await api('PUT', '/v1/reports/reads', { as: MEMBER, body: { kind: 'weekly', reportId: weeklyId } })).status).toBe(404)
    } finally {
      await pool.query(`DELETE FROM permission_rules WHERE id = 'pr-test-read-deny'`)
      clearPermissionCache()
    }
  })
})

describe('サーバーページング + 検索（q/limit/offset/total）と在庫調整の取消（反対仕訳・原則9.5）', () => {
  let skuId = ''

  const balOf = async (warehouseId: string): Promise<number> => {
    const bals = (await api('GET', '/v1/akebono/inventory-balances', { as: MEMBER })).json.data as
      { skuId: string; warehouseId: string; qty: number }[]
    return bals.find(b => b.skuId === skuId && b.warehouseId === warehouseId)?.qty ?? 0
  }
  const txnsOf = async (): Promise<{ id: string; skuId: string; warehouseId: string; qty: number; refType: string; kind: string }[]> =>
    (await api('GET', '/v1/akebono/inventory-transactions?limit=1000', { as: MEMBER })).json.data as never

  it('セットアップ: 商品と既定 SKU を作成', async () => {
    const created = await api('POST', '/v1/akebono/products', {
      as: MEMBER, body: { code: 'PGN-001', name: 'ページング検証', segmentId: 'seg-01', taxRateId: 'tax-10', unitId: 'unit-02' },
    })
    expect(created.status).toBe(201)
    const pid = (created.json.data as { id: string }).id
    const skus = (await api('GET', '/v1/akebono/product-skus', { as: MEMBER })).json.data as
      { id: string; productId: string }[]
    skuId = skus.find(s => s.productId === pid)!.id
    expect(skuId).toBeTruthy()
  })

  it('下位互換: パラメータ無しの一覧は bare 配列（total 兄弟キー無し）', async () => {
    const resp = await api('GET', '/v1/akebono/inventory-transactions', { as: MEMBER })
    expect(Array.isArray(resp.json.data)).toBe(true)
    expect((resp.json as { total?: number }).total).toBeUndefined()
  })

  it('limit/offset/total: 総件数を返し、offset に依らず total は一定・ページ跨ぎで重複しない', async () => {
    for (const qty of [1, 2, 3]) {
      expect((await api('POST', '/v1/akebono/inventory/adjust', {
        as: MEMBER, body: { skuId, warehouseId: 'wh-01', qty, reason: 'found' },
      })).status).toBe(201)
    }
    const p1 = await api('GET', '/v1/akebono/inventory-transactions?limit=2&offset=0', { as: MEMBER })
    expect((p1.json.data as unknown[]).length).toBe(2)
    const total1 = (p1.json as { total: number }).total
    expect(total1).toBeGreaterThanOrEqual(3)
    const p2 = await api('GET', '/v1/akebono/inventory-transactions?limit=2&offset=2', { as: MEMBER })
    expect((p2.json as { total: number }).total).toBe(total1)
    const ids1 = (p1.json.data as { id: string }[]).map(r => r.id)
    const ids2 = (p2.json.data as { id: string }[]).map(r => r.id)
    expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0)
  })

  it('検索 q: kind/reason/refType の部分一致で total が縮み、返却行はすべて一致する', async () => {
    expect((await api('POST', '/v1/akebono/inventory/stocktake', {
      as: MEMBER, body: { warehouseId: 'wh-02', counts: [{ skuId, actualQty: 7 }] },
    })).json.data).toMatchObject({ adjusted: 1 })
    const all = await api('GET', '/v1/akebono/inventory-transactions?limit=1000', { as: MEMBER })
    const totalAll = (all.json as { total: number }).total
    const stk = await api('GET', '/v1/akebono/inventory-transactions?limit=1000&q=stocktake', { as: MEMBER })
    const totalStk = (stk.json as { total: number }).total
    expect(totalStk).toBeGreaterThanOrEqual(1)
    expect(totalStk).toBeLessThan(totalAll)
    for (const r of stk.json.data as { kind: string; reason: string | null; refType: string }[]) {
      expect(`${r.kind}${r.reason ?? ''}${r.refType}`.includes('stocktake')).toBe(true)
    }
  })

  it('在庫調整の取消: 反対仕訳で残高が戻る／二重取消は 409／反対仕訳の再取消は 400', async () => {
    const before = await balOf('wh-01')
    expect((await api('POST', '/v1/akebono/inventory/adjust', {
      as: MEMBER, body: { skuId, warehouseId: 'wh-01', qty: 20, reason: 'found' },
    })).status).toBe(201)
    expect(await balOf('wh-01')).toBe(before + 20)
    const target = (await txnsOf()).find(t => t.skuId === skuId && t.warehouseId === 'wh-01' && t.refType === 'adjust' && t.qty === 20)!
    expect(target).toBeTruthy()
    const rev = await api('POST', '/v1/akebono/inventory/reverse', { as: MEMBER, body: { transactionId: target.id } })
    expect(rev.status).toBe(200)
    expect((rev.json.data as { reversed: number }).reversed).toBe(1)
    expect(await balOf('wh-01')).toBe(before)
    const rev2 = await api('POST', '/v1/akebono/inventory/reverse', { as: MEMBER, body: { transactionId: target.id } })
    expect(rev2.status).toBe(409)
    expect(rev2.json.error?.code).toBe('AKO-INV-008')
    const revTxn = (await txnsOf()).find(t => t.refType === 'reverse' && t.skuId === skuId && t.warehouseId === 'wh-01')!
    expect(revTxn).toBeTruthy()
    const rev3 = await api('POST', '/v1/akebono/inventory/reverse', { as: MEMBER, body: { transactionId: revTxn.id } })
    expect(rev3.status).toBe(400)
    expect(rev3.json.error?.code).toBe('AKO-INV-007')
  })

  it('倉庫間移動の取消: 出/入の 2 行をまとめて反対仕訳し残高が戻る', async () => {
    expect((await api('POST', '/v1/akebono/inventory/adjust', {
      as: MEMBER, body: { skuId, warehouseId: 'wh-01', qty: 6, reason: 'found' },
    })).status).toBe(201)
    const from0 = await balOf('wh-01')
    const to0 = await balOf('wh-02')
    expect((await api('POST', '/v1/akebono/inventory/transfer', {
      as: MEMBER, body: { skuId, fromWarehouseId: 'wh-01', toWarehouseId: 'wh-02', qty: 2 },
    })).status).toBe(201)
    expect(await balOf('wh-01')).toBe(from0 - 2)
    expect(await balOf('wh-02')).toBe(to0 + 2)
    const leg = (await txnsOf()).find(t => t.refType === 'transfer' && t.skuId === skuId)!
    const rev = await api('POST', '/v1/akebono/inventory/reverse', { as: MEMBER, body: { transactionId: leg.id } })
    expect(rev.status).toBe(200)
    expect((rev.json.data as { reversed: number }).reversed).toBe(2)
    expect(await balOf('wh-01')).toBe(from0)
    expect(await balOf('wh-02')).toBe(to0)
  })
})
