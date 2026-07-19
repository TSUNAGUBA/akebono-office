/**
 * ノート API（バッチ7c・オペレーター指示 2026-07-19 #4）。
 * - kind='poipoi'（ぽいぽいポスト = 本人 + 管理者が参照。C3 + 管理者閲覧 = チーム改善のフィードバック用途。
 *   バッチ7e で「ぽいぽいメモ」から改称・管理者の全ポスト閲覧を追加）/ kind='minutes'（議事録 = 全員参照。C2）
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

// createdAt は JST ウォールクロック文字列で返す（表示時刻の規約 = configs/sales/chatbot と同一パターン。
// フロントは文字列を直接パースするため UTC の "Z" ISO を返すと日付キー比較・表示が最大 9 時間ずれる）
const NOTE_COLS = `id, member_id AS "memberId", kind, title, body, project_id AS "projectId",
  company_id AS "companyId", work_category_id AS "workCategoryId", source, active,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

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

/** 取消・復元の権限（poipoi = 本人のみ（C3）/ minutes = 登録者または管理者）。取消済み原本の参照も同条件 */
function canUndoNote(note: { kind: NoteKind; memberId: string }, user: AuthUser): boolean {
  return note.memberId === user.id || (note.kind === 'minutes' && user.role === 'admin')
}

/** タイトル導出: 指定 > 本文の先頭行（40 字） */
function titleFrom(specified: unknown, body: string): string {
  const t = typeof specified === 'string' ? specified.trim() : ''
  if (t) return capCp(t, 200)
  const first = body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'ノート'
  return capCp(first, 40)
}

export function notesRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（poipoi = 本人のみ / minutes = 全員。新しい順）。
  // includeArchived=1 で取消済みも含める（復元 UI 用。取消済みの可視範囲は復元権限と同じ =
  // poipoi は本人のみ・minutes は登録者または管理者。誤アップロードの内容を全員へ晒し続けない）。
  // LIMIT 300 は active + 取消済みの合算（取消済みが極端に多いと active の表示件数が減るが、
  // SME 規模では実害なしと判断。件数が問題になったらページング導入時に吸収する）
  app.get('/', async (c) => {
    const user = c.get('user')
    const kind = kindOf(c.req.query('kind'))
    await guardFeature(pool, user, kind)
    const includeArchived = c.req.query('includeArchived') === '1'
    // 管理者の全ポスト閲覧（バッチ7e: ぽいぽいポストはフィードバック用途 = 管理者はオリジナルを閲覧できる。
    // active のみ・取消済みは対象外。AI の参照スコープ（owner_member_id = 本人）は変えない）
    if (kind === 'poipoi' && c.req.query('scope') === 'all') {
      if (user.role !== 'admin') throw err('AKO-PRM-001', '全メンバーのポスト閲覧は管理者のみです', 403)
      // LIMIT 300 は通常一覧と同じ設計判断（SME 規模で十分。超えたらページング導入時に吸収）
      const { rows } = await pool.query(
        `SELECT ${NOTE_COLS} FROM notes WHERE kind = 'poipoi' AND active = true
         ORDER BY created_at DESC, id LIMIT 300`)
      return c.json({ data: rows })
    }
    const { rows } = kind === 'poipoi'
      ? await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE kind = 'poipoi' AND member_id = $1
                          ${includeArchived ? '' : 'AND active = true'}
                          ORDER BY created_at DESC, id LIMIT 300`, [user.id])
      : await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE kind = 'minutes'
                          ${includeArchived ? 'AND (active = true OR member_id = $1 OR $2::boolean)' : 'AND active = true'}
                          ORDER BY created_at DESC, id LIMIT 300`,
        includeArchived ? [user.id, user.role === 'admin'] : [])
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
      detail: kind === 'poipoi' ? 'ぽいぽいポストを登録' : '議事録を登録',
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
    // タイトル導出: 指定 > 本文の先頭行 > ファイル名（センチネル比較はしない・常に 200cp cap）
    const specifiedTitle = typeof b.title === 'string' ? b.title.trim() : ''
    const firstLine = text.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
    const title = capCp(specifiedTitle || capCp(firstLine, 40) || filename.replace(/\.[^.]+$/, ''), 200)
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
      detail: `${kind === 'poipoi' ? 'ぽいぽいポスト' : '議事録'}へドキュメント取込（${filename}）`,
    })
    scheduleSearchRebuild(pool, env, `notes:import`)
    const { rows } = await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // 取消（論理削除。本アプリ共通原則: 操作の取消可能性 = オペレーター指示 2026-07-19 #5）。
  // poipoi = 本人のみ / minutes = 登録者または管理者。監査ログへ記録し検索インデックスからも除外。
  // 冪等: UPDATE 自体を active = true 条件で行い、同時実行でも監査ログは 1 回だけ記録される
  app.post('/:noteId/archive', async (c) => {
    const user = c.get('user')
    const noteId = c.req.param('noteId')
    const { rows } = await pool.query<{ kind: NoteKind; memberId: string; title: string }>(
      `SELECT kind, member_id AS "memberId", title FROM notes WHERE id = $1`, [noteId])
    const note = rows[0]
    if (!note) throw err('AKO-GEN-002', 'ノートが見つかりません', 404)
    await guardFeature(pool, user, note.kind)
    if (!canUndoNote(note, user)) throw err('AKO-PRM-001', '登録者本人（議事録は管理者も可）のみ取り消せます', 403)
    const upd = await pool.query(`UPDATE notes SET active = false WHERE id = $1 AND active = true`, [noteId])
    if (upd.rowCount === 0) return c.json({ data: { id: noteId, warning: 'すでに取消済みです' } })
    await audit(pool, {
      actorId: user.id, action: 'archive', entity: 'notes', entityId: noteId,
      detail: `${note.kind === 'poipoi' ? 'ぽいぽいポスト' : '議事録'}「${capCp(note.title, 40)}」を取消`,
    })
    scheduleSearchRebuild(pool, env, 'notes:archive')
    return c.json({ data: { id: noteId } })
  })

  // 復元（取消の取消。取消自体も操作である以上、立ち戻れるようにする = 原則 9.5 の対称性）。権限は取消と同一
  app.post('/:noteId/restore', async (c) => {
    const user = c.get('user')
    const noteId = c.req.param('noteId')
    const { rows } = await pool.query<{ kind: NoteKind; memberId: string; title: string }>(
      `SELECT kind, member_id AS "memberId", title FROM notes WHERE id = $1`, [noteId])
    const note = rows[0]
    if (!note) throw err('AKO-GEN-002', 'ノートが見つかりません', 404)
    await guardFeature(pool, user, note.kind)
    if (!canUndoNote(note, user)) throw err('AKO-PRM-001', '登録者本人（議事録は管理者も可）のみ復元できます', 403)
    const upd = await pool.query(`UPDATE notes SET active = true WHERE id = $1 AND active = false`, [noteId])
    if (upd.rowCount === 0) return c.json({ data: { id: noteId, warning: '取消されていません' } })
    await audit(pool, {
      actorId: user.id, action: 'restore', entity: 'notes', entityId: noteId,
      detail: `${note.kind === 'poipoi' ? 'ぽいぽいポスト' : '議事録'}「${capCp(note.title, 40)}」を復元`,
    })
    scheduleSearchRebuild(pool, env, 'notes:restore')
    return c.json({ data: { id: noteId } })
  })

  // 添付原本メタ一覧（poipoi は本人 + 管理者 = バッチ7e の管理者オリジナル閲覧。
  // 取消済みは復元権限者のみ = 誤アップロード原本を晒し続けない）
  app.get('/:noteId/files', async (c) => {
    const user = c.get('user')
    const { rows: notes } = await pool.query<{ kind: NoteKind; memberId: string; active: boolean }>(
      `SELECT kind, member_id AS "memberId", active FROM notes WHERE id = $1`, [c.req.param('noteId')])
    const note = notes[0]
    if (!note) throw err('AKO-GEN-002', 'ノートが見つかりません', 404)
    await guardFeature(pool, user, note.kind)
    if (note.kind === 'poipoi' && note.memberId !== user.id && user.role !== 'admin') {
      throw err('AKO-PRM-001', '本人のポスト（管理者はチーム改善のための閲覧のみ可）のみ参照できます', 403)
    }
    if (!note.active && !canUndoNote(note, user)) {
      throw err('AKO-PRM-001', '取消済みノートの原本は登録者本人（議事録は管理者も可）のみ参照できます', 403)
    }
    const { rows } = await pool.query(
      `SELECT id, note_id AS "noteId", filename, mime, size_bytes AS "sizeBytes",
              to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"
       FROM note_files WHERE note_id = $1 ORDER BY created_at, id`, [c.req.param('noteId')])
    return c.json({ data: rows })
  })

  // 原本ダウンロード（poipoi は本人 + 管理者。取消済みは復元権限者のみ）
  app.get('/files/:id', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query<{
      filename: string; mime: string; bytes: Buffer; kind: NoteKind; memberId: string; active: boolean
    }>(
      `SELECT f.filename, f.mime, f.bytes, n.kind, n.member_id AS "memberId", n.active
       FROM note_files f JOIN notes n ON n.id = f.note_id WHERE f.id = $1`, [c.req.param('id')])
    const f = rows[0]
    if (!f) throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    await guardFeature(pool, user, f.kind)
    if (f.kind === 'poipoi' && f.memberId !== user.id && user.role !== 'admin') {
      throw err('AKO-PRM-001', '本人のポスト（管理者はチーム改善のための閲覧のみ可）のみ参照できます', 403)
    }
    if (!f.active && !canUndoNote(f, user)) {
      throw err('AKO-PRM-001', '取消済みノートの原本は登録者本人（議事録は管理者も可）のみ参照できます', 403)
    }
    return c.json({ data: { filename: f.filename, mime: f.mime, contentBase64: f.bytes.toString('base64') } })
  })

  return app
}
