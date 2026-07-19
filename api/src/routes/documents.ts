/**
 * ドキュメント管理 F-09-3 本実装（バッチ7l・オペレーター指示 2026-07-19 #14）。
 * - メタデータの SoT = documents テーブル。実体の SoT = Cloud Storage（STORAGE_BUCKET）
 *   または document_blobs（bytea フォールバック）。実体を先に保存 → メタを確定（SoT 順序 = 原則6）
 * - テキスト抽出（lib/extract-text = ナレッジ取込と共通）は補助処理: 失敗してもアップロードは成立
 *   （抽出テキストなし = 検索インデックス非対象。原則4）
 * - 取消フロー（原則 9.5）: アーカイブ = 論理削除（実体は保持）→ 復元可能。監査ログ付き
 * - Google ドライブ取込: カレンダーと同じ OAuth 連携トークン（drive.readonly スコープ）を共用。
 *   旧スコープのトークンは「再接続が必要」を案内（AKO-DOC-006）
 * - 書込後は検索インデックスを自動再生成 → チャットボット等の AI 参照へ流入
 * エラー: AKO-DOC-001（名前必須）/ 002（フォルダ名必須）/ 003（同名フォルダ）/ 004（サイズ・形式）/
 *         005（親フォルダ不正）/ 006（ドライブ連携未接続・要再接続）/ 007（ドライブ取込失敗）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { canViewField, stripDeniedFields } from '../../../shared/domain/permissions'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { extractDocumentText } from '../lib/extract-text'
import { newId } from '../lib/ids'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { scheduleSearchRebuild } from '../lib/search-index'
import { deleteObject, gcsEnabled, getObject, putObject, sanitizeFilename, signedDownloadUrl } from '../lib/storage'
import { capCp } from '../lib/text'
import { accessTokenFor, DRIVE_SCOPE, googleOauthEnabled } from './calendar'

/** 原本サイズ上限（10MB。base64 で約 13.4MB = ナレッジ取込と同一） */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** 抽出テキストの格納上限（コードポイント。ナレッジ取込と同一） */
const EXTRACT_CAP = 20_000
/** ドライブ取込の 1 回あたり上限件数 */
const MAX_DRIVE_IMPORT = 10

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

/** テキスト抽出対象の拡張子（extract-text.ts 対応分。それ以外も保管・ダウンロードは可能） */
const EXTRACT_EXTS = new Set(['md', 'txt', 'pdf', 'docx', 'pptx'])

/** Google ドキュメント形式のエクスポート先（→ 抽出可能な形式へ変換して取込む） */
const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx',
  },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx',
  },
}

const ROW_SELECT = `
  id, parent_id AS "parentId", kind, name, tags, summary, mime,
  size_bytes AS "sizeBytes", storage, source, drive_web_link AS "driveWebLink",
  (extracted_text <> '') AS "hasText", active,
  updated_by AS "updatedBy",
  to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt"`

/** サイズ表示（モックの表示形式と同一: KB / MB） */
function fmtSize(bytes: number | null): string | null {
  if (bytes === null || bytes === undefined) return null
  const kb = bytes / 1024
  return kb >= 1000 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(kb))}KB`
}

interface DocRow {
  id: string
  parentId: string | null
  kind: 'folder' | 'file'
  name: string
  tags: string[]
  summary: string
  mime: string
  sizeBytes: number | null
  storage: 'none' | 'gcs' | 'db'
  source: 'upload' | 'drive'
  driveWebLink: string
  hasText: boolean
  active: boolean
  updatedBy: string
  updatedAt: string
}

function toClient(r: DocRow): Record<string, unknown> {
  const { sizeBytes, storage, hasText, ...rest } = r
  return { ...rest, sizeBytes, size: fmtSize(sizeBytes), hasText, downloadable: storage !== 'none' }
}

/** 拡張子（小文字。なし = ''） */
function extOf(filename: string): string {
  return filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
}

async function extractBestEffort(filename: string, bytes: Buffer): Promise<string> {
  const ext = extOf(filename)
  // csv はプレーンテキストとして扱う（Google スプレッドシートのエクスポート先）
  const effective = ext === 'csv' ? 'txt' : ext
  if (!EXTRACT_EXTS.has(effective)) return ''
  try {
    const raw = await extractDocumentText(effective, bytes)
    return capCp((raw ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), EXTRACT_CAP)
  } catch {
    return ''
  }
}

/** 親フォルダの検証（null = ルート可。存在し kind='folder' かつ有効であること） */
async function assertParentFolder(pool: pg.Pool, parentId: string | null): Promise<void> {
  if (parentId === null) return
  const { rows } = await pool.query<{ kind: string; active: boolean }>(
    `SELECT kind, active FROM documents WHERE id = $1`, [parentId])
  if (!rows[0] || rows[0].kind !== 'folder' || !rows[0].active) {
    throw err('AKO-DOC-005', '親フォルダが見つかりません', 400)
  }
}

/** フォルダ移動の循環検証（自分自身・子孫への移動を拒否） */
export function wouldCycle(
  nodes: { id: string; parentId: string | null }[], id: string, newParentId: string | null,
): boolean {
  if (newParentId === null) return false
  const parentOf = new Map(nodes.map(n => [n.id, n.parentId]))
  let cur: string | null = newParentId
  let guard = 0
  while (cur && guard < 100) {
    if (cur === id) return true
    cur = parentOf.get(cur) ?? null
    guard++
  }
  return false
}

/**
 * 実体の保存先を決める（GCS 優先・未設定/失敗は DB bytea へフォールバック = 原則4）。
 * GCS は実体（SoT）を先に置いてからメタを確定する（原則6）。
 * DB 保管は saveFileRecord が documents 行 + blob を同一トランザクションで確定する
 * （blob は documents(id) への FK のため行より先に入れられない）
 */
async function resolveStorage(env: Env, path: string, bytes: Buffer, mime: string): Promise<'gcs' | 'db'> {
  if (gcsEnabled(env)) {
    const ok = await putObject(env, path, bytes, mime)
    if (ok) return 'gcs'
    console.warn(`document upload: GCS put failed, falling back to DB (${path})`)
  }
  return 'db'
}

interface DriveTokenState {
  connected: boolean
  driveScope: boolean
}

async function driveTokenState(pool: pg.Pool, memberId: string): Promise<DriveTokenState> {
  const { rows } = await pool.query<{ scope: string | null }>(
    `SELECT scope FROM calendar_tokens WHERE member_id = $1`, [memberId])
  if (!rows[0]) return { connected: false, driveScope: false }
  return { connected: true, driveScope: (rows[0].scope ?? '').includes(DRIVE_SCOPE) }
}

async function requireDriveToken(pool: pg.Pool, env: Env, memberId: string): Promise<string> {
  if (!googleOauthEnabled(env)) {
    throw err('AKO-DOC-006', 'Google 連携が未設定です（GOOGLE_OAUTH_* を設定してください）', 409)
  }
  const state = await driveTokenState(pool, memberId)
  if (!state.connected || !state.driveScope) {
    throw err('AKO-DOC-006',
      'Google ドライブ連携が未接続です。AI アシスタントのカレンダー連携から Google に再接続してください（ドライブ読取の許可が追加されます）', 409)
  }
  const token = await accessTokenFor(pool, env, memberId)
  if (!token) {
    throw err('AKO-DOC-006', 'Google 連携の有効期限が切れています。再接続してください', 409)
  }
  return token
}

/** Drive 再取込のスナップショット更新（フォルダ・タグ・概要は保持し内容系のみ更新。blob は保管先に追従） */
async function updateDriveFileRecord(
  pool: pg.Pool, input: {
    id: string; name: string; mime: string; sizeBytes: number
    storage: 'gcs' | 'db'; storagePath: string; driveWebLink: string
    extractedText: string; updatedBy: string
  }, bytes: Buffer,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE documents SET name = $2, mime = $3, size_bytes = $4, storage = $5, storage_path = $6,
              drive_web_link = $7, extracted_text = $8, updated_by = $9, updated_at = now()
       WHERE id = $1`,
      [input.id, input.name, input.mime, input.sizeBytes, input.storage, input.storagePath,
        input.driveWebLink, input.extractedText, input.updatedBy])
    if (input.storage === 'db') {
      await client.query(
        `INSERT INTO document_blobs (document_id, bytes) VALUES ($1, $2)
         ON CONFLICT (document_id) DO UPDATE SET bytes = EXCLUDED.bytes`, [input.id, bytes])
    } else {
      await client.query(`DELETE FROM document_blobs WHERE document_id = $1`, [input.id])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** ファイルレコードの確定。DB 保管は documents 行 + blob を同一トランザクションで保存する */
async function saveFileRecord(
  pool: pg.Pool, input: {
    id: string; parentId: string | null; name: string; tags: string[]; summary: string
    mime: string; sizeBytes: number; storage: 'gcs' | 'db'; storagePath: string
    source: 'upload' | 'drive'; driveFileId?: string; driveWebLink?: string
    extractedText: string; updatedBy: string
  }, bytes: Buffer,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO documents (id, parent_id, kind, name, tags, summary, mime, size_bytes,
                              storage, storage_path, source, drive_file_id, drive_web_link,
                              extracted_text, updated_by)
       VALUES ($1, $2, 'file', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [input.id, input.parentId, input.name, JSON.stringify(input.tags), input.summary,
        input.mime, input.sizeBytes, input.storage, input.storagePath, input.source,
        input.driveFileId ?? '', input.driveWebLink ?? '', input.extractedText, input.updatedBy])
    if (input.storage === 'db') {
      await client.query(
        `INSERT INTO document_blobs (document_id, bytes) VALUES ($1, $2)
         ON CONFLICT (document_id) DO UPDATE SET bytes = EXCLUDED.bytes`, [input.id, bytes])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export function documentsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（フォルダ + ファイルの全メタ。アーカイブ済みも active フラグ付きで返し、表示はクライアントが制御）
  app.get('/', async (c) => {
    const rules = await activePermissionRules(pool)
    const { rows } = await pool.query<DocRow>(`SELECT ${ROW_SELECT} FROM documents ORDER BY created_at, id`)
    const stripped = rules.length > 0
      ? stripDeniedFields(rules, subjectOf(c.get('user')), 'documents', rows.map(toClient))
      : rows.map(toClient)
    return c.json({ data: stripped })
  })

  // フォルダ作成
  app.post('/folders', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { name?: string; parentId?: string | null }
    const name = capCp(String(body.name ?? '').trim(), 100)
    if (!name) throw err('AKO-DOC-002', 'フォルダ名を入力してください', 400)
    const parentId = body.parentId ? String(body.parentId) : null
    await assertParentFolder(pool, parentId)
    const id = newId('doc')
    try {
      // 同名重複は部分一意 index（uq_documents_folder_name）が最終判定（並行作成の TOCTOU 対策）
      await pool.query(
        `INSERT INTO documents (id, parent_id, kind, name, updated_by) VALUES ($1, $2, 'folder', $3, $4)`,
        [id, parentId, name, user.id])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw err('AKO-DOC-003', '同名のフォルダが既にあります', 409)
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'documents', entityId: id,
      detail: `フォルダ作成（${name}）`,
    })
    return c.json({ data: { id } }, 201)
  })

  // ファイルアップロード（base64 JSON = ナレッジ取込・AI タスク添付と同一パターン）
  app.post('/files', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as {
      filename?: string; contentBase64?: string; parentId?: string | null
      tags?: unknown; summary?: string; mime?: string
    }
    // サニタイズ（R1 M-1）: パス区切り・制御文字は storage_path・署名 URL を壊すため除去する
    const filename = sanitizeFilename(capCp(String(body.filename ?? '').trim(), 200))
    if (!body.filename || !String(body.filename).trim()) throw err('AKO-DOC-001', 'ファイル名を入力してください', 400)
    const contentBase64 = String(body.contentBase64 ?? '')
    if (!contentBase64) throw err('AKO-GEN-001', 'contentBase64 を指定してください', 400)
    if (contentBase64.length > MAX_FILE_BYTES * 1.4) {
      throw err('AKO-DOC-004', 'ファイルが大きすぎます（10MB 以下にしてください）', 400)
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw err('AKO-DOC-004', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }
    const parentId = body.parentId ? String(body.parentId) : null
    await assertParentFolder(pool, parentId)
    const tags = (Array.isArray(body.tags) ? body.tags.map(String) : []).slice(0, 10)
    const summary = capCp(String(body.summary ?? '').trim(), 1000)
    const mime = capCp(String(body.mime ?? '').trim(), 100) || 'application/octet-stream'

    const id = newId('doc')
    const storagePath = `documents/${id}/${filename}`
    // GCS は実体（SoT）を先に保存 → メタを確定（原則6）。抽出は補助処理（失敗しても取込成立 = 原則4）
    const storage = await resolveStorage(env, storagePath, bytes, mime)
    const extractedText = await extractBestEffort(filename, bytes)
    try {
      await saveFileRecord(pool, {
        id, parentId, name: filename, tags, summary, mime, sizeBytes: bytes.length,
        storage, storagePath, source: 'upload', extractedText, updatedBy: user.id,
      }, bytes)
    } catch (e) {
      // メタ確定に失敗したら GCS の孤児オブジェクトをベストエフォートで掃除（R1 M-2。エラーはそのまま返す）
      if (storage === 'gcs') void deleteObject(env, storagePath)
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'documents', entityId: id,
      detail: `ファイルアップロード（${filename}）`,
    })
    scheduleSearchRebuild(pool, env, 'documents:upload')
    return c.json({ data: { id, extracted: extractedText !== '' } }, 201)
  })

  // メタ更新（名称・タグ・概要・移動。フォルダ移動は循環を拒否）
  app.patch('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as {
      name?: string; tags?: unknown; summary?: string; parentId?: string | null
    }
    const { rows } = await pool.query<{ kind: string; name: string }>(
      `SELECT kind, name FROM documents WHERE id = $1`, [id])
    const target = rows[0]
    if (!target) throw err('AKO-GEN-002', '対象のドキュメントが見つかりません', 404)

    const sets: string[] = []
    const params: unknown[] = [id]
    const push = (sql: string, v: unknown): void => {
      params.push(v)
      sets.push(`${sql} = $${params.length}`)
    }
    if (body.name !== undefined) {
      const name = capCp(String(body.name).trim(), 200)
      if (!name) {
        throw err(target.kind === 'folder' ? 'AKO-DOC-002' : 'AKO-DOC-001',
          `${target.kind === 'folder' ? 'フォルダ' : 'ファイル'}名を入力してください`, 400)
      }
      push('name', name)
    }
    if (body.tags !== undefined) {
      push('tags', JSON.stringify((Array.isArray(body.tags) ? body.tags.map(String) : []).slice(0, 10)))
    }
    if (body.summary !== undefined) push('summary', capCp(String(body.summary).trim(), 1000))
    if (body.parentId !== undefined) {
      const parentId = body.parentId ? String(body.parentId) : null
      await assertParentFolder(pool, parentId)
      if (target.kind === 'folder') {
        const { rows: all } = await pool.query<{ id: string; parentId: string | null }>(
          `SELECT id, parent_id AS "parentId" FROM documents WHERE kind = 'folder'`)
        if (wouldCycle(all, id, parentId)) {
          throw err('AKO-DOC-005', 'フォルダを自分自身または配下のフォルダへは移動できません', 400)
        }
      }
      params.push(parentId)
      sets.push(`parent_id = $${params.length}`)
    }
    if (sets.length === 0) throw err('AKO-GEN-001', '更新内容を指定してください', 400)
    params.push(user.id)
    try {
      await pool.query(
        `UPDATE documents SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() WHERE id = $1`,
        params)
    } catch (e) {
      // フォルダの改名・移動先での同名重複（部分一意 index。R1 ニット2）
      if ((e as { code?: string }).code === '23505') throw err('AKO-DOC-003', '同名のフォルダが既にあります', 409)
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'documents', entityId: id,
      detail: `ドキュメント更新（${target.name}）`,
    })
    scheduleSearchRebuild(pool, env, 'documents:update')
    return c.json({ data: { id } })
  })

  // アーカイブ（論理削除。実体は保持 = 復元可能。原則 9.5）
  app.post('/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rows } = await pool.query<{ name: string }>(
      `UPDATE documents SET active = false, updated_by = $2, updated_at = now()
       WHERE id = $1 RETURNING name`, [id, user.id])
    if (!rows[0]) throw err('AKO-GEN-002', '対象のドキュメントが見つかりません', 404)
    await audit(pool, {
      actorId: user.id, action: 'archive', entity: 'documents', entityId: id,
      detail: `アーカイブ（${rows[0].name}）`,
    })
    scheduleSearchRebuild(pool, env, 'documents:archive')
    return c.json({ data: { id } })
  })

  // 復元（取消フロー = 原則 9.5）
  app.post('/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    let rows: { name: string }[]
    try {
      rows = (await pool.query<{ name: string }>(
        `UPDATE documents SET active = true, updated_by = $2, updated_at = now()
         WHERE id = $1 RETURNING name`, [id, user.id])).rows
    } catch (e) {
      // 復元先に同名の有効フォルダが既にある場合（部分一意 index）
      if ((e as { code?: string }).code === '23505') {
        throw err('AKO-DOC-003', '同名のフォルダが既にあるため復元できません（先に改名してください）', 409)
      }
      throw e
    }
    if (!rows[0]) throw err('AKO-GEN-002', '対象のドキュメントが見つかりません', 404)
    await audit(pool, {
      actorId: user.id, action: 'restore', entity: 'documents', entityId: id,
      detail: `復元（${rows[0].name}）`,
    })
    scheduleSearchRebuild(pool, env, 'documents:restore')
    return c.json({ data: { id } })
  })

  // 原本ダウンロード（base64 JSON。summary の表示項目 deny があるユーザーは本文相当も不可 = deny 迂回防止）
  app.get('/files/:id', async (c) => {
    await assertBodyViewable(c.get('user'))
    const { rows } = await pool.query<{ name: string; mime: string; storage: string; storagePath: string }>(
      `SELECT name, mime, storage, storage_path AS "storagePath"
       FROM documents WHERE id = $1 AND kind = 'file'`, [c.req.param('id')])
    const f = rows[0]
    if (!f || f.storage === 'none') throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    let bytes: Buffer | null = null
    if (f.storage === 'gcs') {
      bytes = await getObject(env, f.storagePath)
    } else {
      const { rows: blobs } = await pool.query<{ bytes: Buffer }>(
        `SELECT bytes FROM document_blobs WHERE document_id = $1`, [c.req.param('id')])
      bytes = blobs[0]?.bytes ?? null
    }
    if (!bytes) throw err('AKO-GEN-002', 'ファイル実体を取得できませんでした（保管先を確認してください）', 404)
    return c.json({ data: { filename: f.name, mime: f.mime, contentBase64: bytes.toString('base64') } })
  })

  // 期限付きダウンロード URL（GCS モードのみ。フォールバック環境は url: null = base64 経路へ）
  app.post('/files/:id/url', async (c) => {
    await assertBodyViewable(c.get('user'))
    const { rows } = await pool.query<{ name: string; storage: string; storagePath: string }>(
      `SELECT name, storage, storage_path AS "storagePath"
       FROM documents WHERE id = $1 AND kind = 'file'`, [c.req.param('id')])
    const f = rows[0]
    if (!f || f.storage === 'none') throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    if (f.storage !== 'gcs') return c.json({ data: { url: null, expiresAt: null } })
    const url = await signedDownloadUrl(env, f.storagePath, f.name)
    const expiresAt = url ? new Date(Date.now() + 15 * 60_000).toISOString() : null
    return c.json({ data: { url, expiresAt } })
  })

  // ---------- Google ドライブ連携 ----------

  // 連携状態（未接続 / 旧スコープ（要再接続）/ 利用可）
  app.get('/drive/status', async (c) => {
    const user = c.get('user')
    if (!googleOauthEnabled(env)) {
      return c.json({ data: { available: false, connected: false, driveScope: false } })
    }
    const state = await driveTokenState(pool, user.id)
    return c.json({ data: { available: true, connected: state.connected, driveScope: state.driveScope } })
  })

  // ドライブのファイル検索（読取のみ。ごみ箱・フォルダは除外）
  app.get('/drive/files', async (c) => {
    const user = c.get('user')
    const token = await requireDriveToken(pool, env, user.id)
    const q = String(c.req.query('q') ?? '').trim().slice(0, 100)
    const conditions = [`trashed = false`, `mimeType != 'application/vnd.google-apps.folder'`]
    if (q) conditions.push(`name contains '${q.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
    const params = new URLSearchParams({
      q: conditions.join(' and '),
      pageSize: '30',
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
    })
    const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw err('AKO-DOC-007', `ドライブの検索に失敗しました（HTTP ${res.status}）`, 502)
    const body = await res.json() as {
      files?: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; webViewLink?: string }[]
    }
    return c.json({
      data: (body.files ?? []).map(f => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime ?? '',
        webViewLink: f.webViewLink ?? '',
        exportable: Boolean(GOOGLE_EXPORTS[f.mimeType]) || !f.mimeType.startsWith('application/vnd.google-apps'),
      })),
    })
  })

  // ドライブからの取込（コピー保管 + 抽出 + インデックス。部分成功を許容し結果を報告 = 原則4）
  app.post('/drive/import', async (c) => {
    const user = c.get('user')
    const token = await requireDriveToken(pool, env, user.id)
    const body = await c.req.json().catch(() => ({})) as { fileIds?: unknown; parentId?: string | null }
    const fileIds = (Array.isArray(body.fileIds) ? body.fileIds.map(String).filter(Boolean) : [])
      .slice(0, MAX_DRIVE_IMPORT)
    if (fileIds.length === 0) throw err('AKO-GEN-001', 'fileIds を指定してください', 400)
    const parentId = body.parentId ? String(body.parentId) : null
    await assertParentFolder(pool, parentId)

    const imported: { id: string; name: string }[] = []
    const failed: { fileId: string; name: string; reason: string }[] = []
    for (const fileId of fileIds) {
      let name = fileId
      try {
        const metaRes = await fetch(
          `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,webViewLink`,
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
        if (!metaRes.ok) {
          failed.push({ fileId, name, reason: `メタ情報の取得に失敗（HTTP ${metaRes.status}）` })
          continue
        }
        const meta = await metaRes.json() as {
          name: string; mimeType: string; size?: string; webViewLink?: string
        }
        name = meta.name
        const exp = GOOGLE_EXPORTS[meta.mimeType]
        if (!exp && meta.mimeType.startsWith('application/vnd.google-apps')) {
          failed.push({ fileId, name, reason: 'この Google 形式は取込に対応していません' })
          continue
        }
        if (!exp && meta.size && Number(meta.size) > MAX_FILE_BYTES) {
          failed.push({ fileId, name, reason: 'サイズが 10MB を超えています' })
          continue
        }
        const dlUrl = exp
          ? `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exp.mime)}`
          : `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`
        const dlRes = await fetch(dlUrl, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000),
        })
        if (!dlRes.ok) {
          failed.push({ fileId, name, reason: `ダウンロードに失敗（HTTP ${dlRes.status}）` })
          continue
        }
        const bytes = Buffer.from(await dlRes.arrayBuffer())
        if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
          failed.push({ fileId, name, reason: 'ファイルが空か 10MB を超えています' })
          continue
        }
        const filename = sanitizeFilename(
          exp && !name.toLowerCase().endsWith(`.${exp.ext}`) ? `${name}.${exp.ext}` : name)
        // 再取込の冪等化（原則2・R1 ニット4）: 同じ Drive ファイルの有効な取込があれば
        // 別ドキュメントとして複製せず、内容をスナップショット更新する（フォルダ・タグ・概要は保持）
        const { rows: existingRows } = await pool.query<{ id: string; storage: string; storagePath: string }>(
          `SELECT id, storage, storage_path AS "storagePath" FROM documents
           WHERE source = 'drive' AND drive_file_id = $1 AND active = true
           ORDER BY created_at DESC LIMIT 1`, [fileId])
        const existing = existingRows[0]
        const id = existing?.id ?? newId('doc')
        const storagePath = `documents/${id}/${filename}`
        const mime = exp?.mime ?? meta.mimeType
        const storage = await resolveStorage(env, storagePath, bytes, mime)
        const extractedText = await extractBestEffort(filename, bytes)
        try {
          if (existing) {
            await updateDriveFileRecord(pool, {
              id, name: filename, mime, sizeBytes: bytes.length, storage, storagePath,
              driveWebLink: meta.webViewLink ?? '', extractedText, updatedBy: user.id,
            }, bytes)
          } else {
            await saveFileRecord(pool, {
              id, parentId, name: filename, tags: [], summary: '', mime, sizeBytes: bytes.length,
              storage, storagePath, source: 'drive', driveFileId: fileId,
              driveWebLink: meta.webViewLink ?? '', extractedText, updatedBy: user.id,
            }, bytes)
          }
        } catch (e) {
          // メタ確定に失敗したら GCS の孤児オブジェクトをベストエフォートで掃除（R1 M-2）
          if (storage === 'gcs') void deleteObject(env, storagePath)
          throw e
        }
        // 旧実体の掃除（ファイル名変更でパスが変わった場合。失敗しても主フローは続行）
        if (existing?.storage === 'gcs' && existing.storagePath !== storagePath) {
          void deleteObject(env, existing.storagePath)
        }
        await audit(pool, {
          actorId: user.id, action: existing ? 'update' : 'create', entity: 'documents', entityId: id,
          detail: `Google ドライブ取込（${filename}${existing ? ' = 再取込で更新' : ''}）`,
        })
        imported.push({ id, name: filename })
      } catch (e) {
        failed.push({ fileId, name, reason: (e as Error).message || '取込に失敗しました' })
      }
    }
    if (imported.length > 0) scheduleSearchRebuild(pool, env, 'documents:drive-import')
    return c.json({ data: { imported, failed } }, imported.length > 0 ? 201 : 200)
  })

  /** summary（本文プレビュー相当）の表示項目 deny 保有者は原本・URL も不可（deny の迂回防止 = ナレッジと同型） */
  async function assertBodyViewable(user: Parameters<typeof subjectOf>[0]): Promise<void> {
    const rules = await activePermissionRules(pool)
    if (rules.length === 0) return
    if (!canViewField(rules, subjectOf(user), 'documents', 'summary')) {
      throw err('AKO-PRM-001', 'このファイルを参照する権限がありません（管理者にお問い合わせください）', 403)
    }
  }

  return app
}
