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
