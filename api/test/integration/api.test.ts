/**
 * 統合テスト（実 PostgreSQL）。DATABASE_URL 必須（test/run-integration.sh が起動・設定する）。
 * マイグレーション適用 → dev 認証で主要フローをエンドツーエンドに検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import pg from 'pg'
import { addDays, todayJst } from '../../../shared/domain/jst'
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

  it('申請一覧: 全件参照は管理者・人事のみ（承認は管理者のみのまま）', async () => {
    expect((await api('GET', '/v1/attendance/fix-requests?scope=all', { as: MEMBER })).status).toBe(403)
    const hrList = await api('GET', '/v1/attendance/fix-requests?scope=all', { as: HR })
    expect(hrList.status).toBe(200)
    expect((hrList.json.data as unknown[]).length).toBeGreaterThanOrEqual(1)
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

  it('経路マスタ: 上限 <= 下限・順序重複はサーバー側でも拒否（AKO-GEN-001）', async () => {
    const bad = await api('POST', '/v1/masters/workflow-routes', {
      as: ADMIN,
      body: {
        category: 'contract', minAmount: 100000, maxAmount: 100000,
        steps: [{ order: 1, approverRole: 'manager' }, { order: 1, approverRole: 'director' }],
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
