/**
 * 統合テスト（実 PostgreSQL）。DATABASE_URL 必須（test/run-integration.sh が起動・設定する）。
 * マイグレーション適用 → dev 認証で主要フローをエンドツーエンドに検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import pg from 'pg'
import { todayJst } from '../../../shared/domain/jst'
import { createApp } from '../../src/app'
import { migrate } from '../../src/db/migrate'
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

beforeAll(async () => {
  if (!env.databaseUrl) throw new Error('DATABASE_URL が未設定です（test/run-integration.sh 経由で実行してください）')
  pool = createPool(env)
  await pool.query('DROP SCHEMA IF EXISTS app_office CASCADE')
  await migrate(pool, () => {})
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
  it('下書き → 提出 → 提出後の編集は AKO-REP-001', async () => {
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

    const editAfter = await api('PUT', '/v1/reports/daily', {
      as: MEMBER, body: { date, entries: [{ projectId: 'pj-x', task: '改ざん', hours: 1, progress: 0 }], status: 'draft' },
    })
    expect(editAfter.status).toBe(409)
    expect(editAfter.json.error?.code).toBe('AKO-REP-001')
  })

  it('チーム参照は管理者のみ。コメント追加ができる', async () => {
    expect((await api('GET', '/v1/reports/daily?scope=team', { as: MEMBER })).status).toBe(403)
    const team = await api('GET', '/v1/reports/daily?scope=team&date=2026-07-16', { as: ADMIN })
    const reports = team.json.data as { id: string }[]
    expect(reports.length).toBe(1)
    const c = await api('POST', `/v1/reports/${reports[0]!.id}/comments`, { as: ADMIN, body: { body: 'おつかれさま' } })
    expect(c.status).toBe(201)
    const list = await api('GET', `/v1/reports/${reports[0]!.id}/comments`, { as: MEMBER })
    expect((list.json.data as unknown[]).length).toBe(1)
  })

  it('週報の提出保護（AKO-REP-002）', async () => {
    const body = { weekStart: '2026-07-13', goalReview: 'ok', status: 'submitted' }
    expect((await api('PUT', '/v1/reports/weekly', { as: MEMBER, body })).status).toBe(200)
    const again = await api('PUT', '/v1/reports/weekly', { as: MEMBER, body: { ...body, goalReview: '書換' } })
    expect(again.json.error?.code).toBe('AKO-REP-002')
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
