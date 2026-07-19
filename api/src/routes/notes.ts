/**
 * ノート API（バッチ7c・オペレーター指示 2026-07-19 #4）。
 * - kind='poipoi'（ぽいぽいメモ = 本人のみ参照。C3）/ kind='minutes'（議事録 = 全員参照。C2）
 * - プロジェクト・顧客・業務種別は任意の紐付け。記録系 = 追記のみ
 * - アップロード（.md/.txt/.pdf/.docx = lib/extract-text 再利用）は原本を note_files へ保全
 * - 書込後は検索インデックスを再生成（poipoi は owner スコープ付きで AI が参照 = search-index 側）
 * - 機能ガード: poipoi / minutes（F-16）
 * エラー: AKO-NOTE-001 非対応形式 / 002 サイズ超過 / 003 抽出不能（KNW と同型）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { canUseFeature } from '../../../shared/domain/permissions'
import type { NoteKind } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { extractDocumentText } from '../lib/extract-text'
import { newId } from '../lib/ids'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { scheduleSearchRebuild } from '../lib/search-index'
import { capCp } from '../lib/text'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const BODY_CAP = 20_000

const NOTE_COLS = `id, member_id AS "memberId", kind, title, body, project_id AS "projectId",
  company_id AS "companyId", work_category_id AS "workCategoryId", source, created_at AS "createdAt"`

const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function kindOf(v: unknown): NoteKind {
  if (v === 'poipoi' || v === 'minutes') return v
  throw err('AKO-GEN-001', 'kind を指定してください（poipoi / minutes）', 400)
}

/** 機能ガード（F-16。poipoi / minutes の deny を尊重） */
async function guardFeature(pool: pg.Pool, user: AuthUser, kind: NoteKind): Promise<void> {
  const rules = await activePermissionRules(pool)
  if (rules.length > 0 && !canUseFeature(rules, subjectOf(user), kind === 'poipoi' ? 'poipoi' : 'minutes')) {
    throw err('AKO-PRM-001', 'この機能を利用する権限がありません', 403)
  }
}

/** 任意の紐付け id（空文字は null 化。存在チェックは FK が担い 400 で報告） */
function refOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

/** タイトル導出: 指定 > 本文の先頭行（40 字） */
function titleFrom(specified: unknown, body: string): string {
  const t = typeof specified === 'string' ? specified.trim() : ''
  if (t) return capCp(t, 200)
  const first = body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'メモ'
  return capCp(first, 40)
}

export function notesRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（poipoi = 本人のみ / minutes = 全員。新しい順）
  app.get('/', async (c) => {
    const user = c.get('user')
    const kind = kindOf(c.req.query('kind'))
    await guardFeature(pool, user, kind)
    const { rows } = kind === 'poipoi'
      ? await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE kind = 'poipoi' AND member_id = $1
                          ORDER BY created_at DESC, id LIMIT 300`, [user.id])
      : await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE kind = 'minutes'
                          ORDER BY created_at DESC, id LIMIT 300`)
    return c.json({ data: rows })
  })

  // テキスト登録
  app.post('/', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const kind = kindOf(b.kind)
    await guardFeature(pool, user, kind)
    const body = capCp(String(b.body ?? '').trim(), BODY_CAP)
    if (!body) throw err('AKO-GEN-001', '本文を入力してください', 400)
    const id = newId('nt')
    try {
      await pool.query(
        `INSERT INTO notes (id, member_id, kind, title, body, project_id, company_id, work_category_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'text')`,
        [id, user.id, kind, titleFrom(b.title, body), body,
          refOrNull(b.projectId), refOrNull(b.companyId), refOrNull(b.workCategoryId)])
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-GEN-001', '紐付け先（プロジェクト・顧客・業務種別）が見つかりません', 400)
      }
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'notes', entityId: id,
      detail: kind === 'poipoi' ? 'ぽいぽいメモを登録' : '議事録を登録',
    })
    scheduleSearchRebuild(pool, env, `notes:${kind}`)
    const { rows } = await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // ドキュメント取込（.md/.txt/.pdf/.docx。knowledge/import と同型）
  app.post('/import', async (c) => {
    const user = c.get('user')
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const kind = kindOf(b.kind)
    await guardFeature(pool, user, kind)
    const filename = String(b.filename ?? '').trim()
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
    if (!EXT_MIME[ext]) {
      throw err('AKO-NOTE-001',
        `対応形式は .md / .txt / .pdf / .docx です${ext === 'doc' ? '（旧形式 .doc は .docx へ変換してください）' : ''}`, 400)
    }
    const contentBase64 = String(b.contentBase64 ?? '')
    if (!contentBase64) throw err('AKO-GEN-001', 'contentBase64 を指定してください', 400)
    if (contentBase64.length > MAX_FILE_BYTES * 1.4) throw err('AKO-NOTE-002', 'ファイルが大きすぎます（10MB 以下にしてください）', 400)
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw err('AKO-NOTE-002', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    const raw = await extractDocumentText(ext, bytes)
    const text = (raw ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) throw err('AKO-NOTE-003', 'ファイルからテキストを抽出できませんでした（画像のみの PDF 等は非対応です）', 422)

    const id = newId('nt')
    const title = titleFrom(b.title, text) === 'メモ' ? filename.replace(/\.[^.]+$/, '') : titleFrom(b.title, text)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO notes (id, member_id, kind, title, body, project_id, company_id, work_category_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'upload')`,
        [id, user.id, kind, title, capCp(text, BODY_CAP),
          refOrNull(b.projectId), refOrNull(b.companyId), refOrNull(b.workCategoryId)])
      await client.query(
        `INSERT INTO note_files (id, note_id, filename, mime, size_bytes, bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('nf'), id, filename, EXT_MIME[ext], bytes.length, bytes, user.id])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-GEN-001', '紐付け先（プロジェクト・顧客・業務種別）が見つかりません', 400)
      }
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'import', entity: 'notes', entityId: id,
      detail: `${kind === 'poipoi' ? 'ぽいぽいメモ' : '議事録'}へドキュメント取込（${filename}）`,
    })
    scheduleSearchRebuild(pool, env, `notes:import`)
    const { rows } = await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // 添付原本メタ一覧（poipoi は本人のみ）
  app.get('/:noteId/files', async (c) => {
    const user = c.get('user')
    const { rows: notes } = await pool.query<{ kind: NoteKind; memberId: string }>(
      `SELECT kind, member_id AS "memberId" FROM notes WHERE id = $1`, [c.req.param('noteId')])
    const note = notes[0]
    if (!note) throw err('AKO-GEN-002', 'ノートが見つかりません', 404)
    if (note.kind === 'poipoi' && note.memberId !== user.id) {
      throw err('AKO-PRM-001', '本人のメモのみ参照できます', 403)
    }
    const { rows } = await pool.query(
      `SELECT id, note_id AS "noteId", filename, mime, size_bytes AS "sizeBytes", created_at AS "createdAt"
       FROM note_files WHERE note_id = $1 ORDER BY created_at, id`, [c.req.param('noteId')])
    return c.json({ data: rows })
  })

  // 原本ダウンロード（poipoi は本人のみ）
  app.get('/files/:id', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{ filename: string; mime: string; bytes: Buffer; kind: NoteKind; memberId: string }>(
      `SELECT f.filename, f.mime, f.bytes, n.kind, n.member_id AS "memberId"
       FROM note_files f JOIN notes n ON n.id = f.note_id WHERE f.id = $1`, [c.req.param('id')])
    const f = rows[0]
    if (!f) throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    if (f.kind === 'poipoi' && f.memberId !== user.id) {
      throw err('AKO-PRM-001', '本人のメモのみ参照できます', 403)
    }
    return c.json({ data: { filename: f.filename, mime: f.mime, contentBase64: f.bytes.toString('base64') } })
  })

  return app
}
