/**
 * ノート API（バッチ7c・オペレーター指示 2026-07-19 #4）。
 * - kind='poipoi'（ぽいぽいポスト = 本人 + 管理者が参照。C3 + 管理者閲覧 = チーム改善のフィードバック用途。
 *   バッチ7e で「ぽいぽいメモ」から改称・管理者の全ポスト閲覧を追加）/ kind='minutes'（議事録 = 全員参照。C2）
 * - プロジェクト・顧客・業務種別は任意の紐付け。記録系 = 追記のみ
 * - アップロード（.md/.txt/.pdf/.docx = lib/extract-text 再利用）は原本を note_files へ保全
 * - 書込後は検索インデックスを再生成（poipoi は owner スコープ付きで AI が参照 = search-index 側）
 * - 機能ガード: poipoi / minutes（F-16）
 * - 議事録の Google Meet 連携（2026-08-03 ③b）: カレンダー OAuth（drive.readonly）を共用して Drive 上の
 *   Meet AI メモ（Google ドキュメント）/ 録画（動画）を選び、議事録へ参照リンク（meet_file_id 等）を保持する。
 *   保管フォルダは tenant 既定（app_configs 'meet-default-folder'）を初期表示し、違う場合のみ選び直す。
 * エラー: AKO-NOTE-001 非対応形式 / 002 サイズ超過 / 003 抽出不能（KNW と同型）/
 *         004 Meet(Drive) API 失敗 / 005 保管フォルダ未指定。未接続は Drive 共通の AKO-DOC-006。
 */
import { Hono } from 'hono'
import type pg from 'pg'
import type { NotifyRecipientTarget } from '../../../shared/domain/notify-recipients'
import { addedNotifyRecipientIds, parseNotifyRecipients, resolveNotifyRecipientIds } from '../../../shared/domain/notify-recipients'
import { canUseFeature } from '../../../shared/domain/permissions'
import type { NoteKind, NoteOrigin } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { extractDocumentText } from '../lib/extract-text'
import { newId } from '../lib/ids'
import { notify } from '../lib/notify'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { scheduleSearchRebuild } from '../lib/search-index'
import { capCp } from '../lib/text'
import { googleOauthEnabled } from './calendar'
// Google Meet 連携（議事録）は Drive 連携（カレンダー OAuth + drive.readonly）を共用（原則3）
import { driveForbiddenHint, driveTokenState, DRIVE_FILES_URL, googleErrorDetail, requireDriveToken } from './documents'

/** テナント既定の通知先（app_configs 'poipoi-notify-recipients'）を取得する。壊れは空扱い（原則4） */
async function tenantPoipoiTargets(db: pg.Pool): Promise<NotifyRecipientTarget[]> {
  const { rows: cfg } = await db.query<{ value: unknown }>(
    `SELECT value FROM app_configs WHERE key = 'poipoi-notify-recipients'`)
  // configs は JSON.stringify した値を jsonb 保存するため、文字列で保存された設定は文字列で返る。
  // parseNotifyRecipients は文字列・配列の両方を受ける（原則4: 壊れていても空扱いで主フローを止めない）
  return parseNotifyRecipients(cfg[0]?.value ?? '')
}

/** ぽいぽいポスト登録・通知先編集時に、宛先メンバーへ原文を通知する。
 *  宛先 = ポスト単位の上書き（notify_targets）があればそれ・無ければテナント設定（改善要望 2026-08-21）。
 *  「ロール/役職/個人」指定を解決した在籍メンバー（投稿者本人は除外）。非ブロッキング（原則4）。
 *  オペレーター指示 2026-08-03。API モードのみサーバー発火（mock は useNotes が発火）。
 *  onlyMemberIds 指定時はその id のみへ配信（通知先編集で追加された宛先だけへ届ける = 再通知の重複防止）。 */
async function notifyPoipoiRecipients(
  db: pg.Pool, author: { id: string; name: string }, body: string, noteId: string,
  targetsOverride?: NotifyRecipientTarget[] | null, onlyMemberIds?: string[],
): Promise<void> {
  try {
    const targets = targetsOverride ?? await tenantPoipoiTargets(db)
    if (targets.length === 0) return
    const { rows: members } = await db.query<{ id: string; role: string; title: string; active: boolean }>(
      `SELECT id, role, title, active FROM members`)
    let recipientIds = resolveNotifyRecipientIds(targets, members, author.id)
    if (onlyMemberIds) recipientIds = recipientIds.filter(id => onlyMemberIds.includes(id))
    if (recipientIds.length === 0) return
    const title = `新しい改善のタネ（${author.name}）`
    const preview = capCp(body, 140)
    // リンクは対象ポストの詳細モーダルへのディープリンク（改修依頼 2026-08-18）。
    // 他人のポスト詳細を開けるのは管理者のみ（/poipoi の参照モデル = 本人 + 管理者閲覧）のため、
    // 閲覧権限の無い受信者には従来どおり一覧リンクを送る（開けないリンクを配らない = レビュー R8）
    const roleById = new Map(members.map(m => [m.id, m.role]))
    for (const mid of recipientIds) {
      const link = roleById.get(mid) === 'admin' ? `/poipoi?open=${noteId}` : '/poipoi'
      await notify(db, mid, 'poipoi', title, preview, link)
    }
  } catch (e) {
    console.warn('notifyPoipoiRecipients failed (non-blocking):', (e as Error).message)
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024
const BODY_CAP = 20_000

// createdAt は JST ウォールクロック文字列で返す（表示時刻の規約 = configs/sales/chatbot と同一パターン。
// フロントは文字列を直接パースするため UTC の "Z" ISO を返すと日付キー比較・表示が最大 9 時間ずれる）
const NOTE_COLS = `id, member_id AS "memberId", kind, title, body, project_id AS "projectId",
  company_id AS "companyId", work_category_id AS "workCategoryId", source, active,
  origin, notify_targets AS "notifyTargets",
  meet_file_id AS "meetFileId", meet_file_name AS "meetFileName", meet_web_link AS "meetWebLink",
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

/** 登録経路（poipoi のみ。改善要望 2026-08-21）。'report' 明示のみ日報経路・それ以外は直接投稿。議事録は null */
function originOf(kind: NoteKind, v: unknown): NoteOrigin | null {
  if (kind !== 'poipoi') return null
  return v === 'report' ? 'report' : 'direct'
}

/** Meet 連携ファイル（Drive 参照）の正規化。id が空なら全て null（不整合を持ち込まない）。
 *  webViewLink は https の *.google.com のみ受理（不正 URL を保存しない）。オペレーター指示 2026-08-03 ③b */
function meetLinkOf(b: Record<string, unknown>): { id: string | null; name: string | null; webLink: string | null } {
  const id = typeof b.meetFileId === 'string' ? b.meetFileId.trim().slice(0, 200) : ''
  if (!id) return { id: null, name: null, webLink: null }
  const name = typeof b.meetFileName === 'string' ? capCp(b.meetFileName.trim(), 300) : ''
  const webRaw = typeof b.meetWebLink === 'string' ? b.meetWebLink.trim().slice(0, 1000) : ''
  const webLink = /^https:\/\/[a-z0-9.-]+\.google\.com\//i.test(webRaw) ? webRaw : ''
  return { id, name: name || null, webLink: webLink || null }
}

const MEET_DEFAULT_FOLDER_KEY = 'meet-default-folder'

/** 議事録の Meet 既定保管フォルダ（tenant 設定 = app_configs）。未設定/壊れは null（原則4） */
async function meetDefaultFolder(pool: pg.Pool): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT value FROM app_configs WHERE key = $1`, [MEET_DEFAULT_FOLDER_KEY])
  const raw = rows[0]?.value
  // configs は JSON.stringify した値を jsonb 保存するため、文字列で返る場合と object の両方に対応
  let obj: unknown = raw
  if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch { obj = null } }
  if (obj && typeof obj === 'object' && typeof (obj as { id?: unknown }).id === 'string' && (obj as { id: string }).id) {
    const o = obj as { id: string; name?: unknown }
    return { id: o.id, name: typeof o.name === 'string' ? o.name : '' }
  }
  return null
}

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
    // Meet 連携は議事録専用（poipoi に手製リクエストでリンクを持ち込ませない = レビュー NIT）
    const meet = kind === 'minutes' ? meetLinkOf(b) : { id: null, name: null, webLink: null }
    // 登録経路 + ポスト単位の通知先上書き（poipoi のみ。改善要望 2026-08-21。
    // notifyTargets 未指定 = null = テナント設定を使う / 配列指定 = このポストの宛先で上書き）
    const origin = originOf(kind, b.origin)
    const notifyTargets = kind === 'poipoi' && Array.isArray(b.notifyTargets)
      ? parseNotifyRecipients(b.notifyTargets) : null
    try {
      await pool.query(
        `INSERT INTO notes (id, member_id, kind, title, body, project_id, company_id, work_category_id, source,
           meet_file_id, meet_file_name, meet_web_link, origin, notify_targets)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'text', $9, $10, $11, $12, $13)`,
        [id, user.id, kind, titleFrom(b.title, body), body,
          refOrNull(b.projectId), refOrNull(b.companyId), refOrNull(b.workCategoryId),
          meet.id, meet.name, meet.webLink, origin, notifyTargets ? JSON.stringify(notifyTargets) : null])
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw err('AKO-GEN-001', '紐付け先（プロジェクト・顧客・業務種別）が見つかりません', 400)
      }
      throw e
    }
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'notes', entityId: id,
      detail: kind === 'poipoi' ? '改善のタネを登録' : '議事録を登録',
    })
    // ぽいぽいポストは宛先（ポスト単位の上書き > テナント設定）へ原文を通知（非ブロッキング。オペレーター指示 2026-08-03）
    if (kind === 'poipoi') await notifyPoipoiRecipients(pool, user, body, id, notifyTargets)
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
    const meet = kind === 'minutes' ? meetLinkOf(b) : { id: null, name: null, webLink: null }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // 取込は /poipoi ページからの直接操作のため origin='direct'（poipoi のみ。改善要望 2026-08-21）
      await client.query(
        `INSERT INTO notes (id, member_id, kind, title, body, project_id, company_id, work_category_id, source,
           meet_file_id, meet_file_name, meet_web_link, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'upload', $9, $10, $11, $12)`,
        [id, user.id, kind, title, capCp(text, BODY_CAP),
          refOrNull(b.projectId), refOrNull(b.companyId), refOrNull(b.workCategoryId),
          meet.id, meet.name, meet.webLink, originOf(kind, null)])
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
      detail: `${kind === 'poipoi' ? '改善のタネ' : '議事録'}へドキュメント取込（${filename}）`,
    })
    scheduleSearchRebuild(pool, env, `notes:import`)
    const { rows } = await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // ---------- Google Meet 連携（議事録の AI メモ/録画リンク。カレンダー OAuth + drive.readonly を共用） ----------
  // 連携認証は AI アシスタントのカレンダー連携（drive.readonly を含む）を再利用（documents のドライブ取込と同型）。
  // /meet/* は /:noteId/* より前に登録（静的パス優先。Hono は静的 > パラメータだが順序でも保証する）。
  // エラー: AKO-NOTE-004（Drive API 失敗）/ 005（保管フォルダ未指定）。未接続は requireDriveToken が AKO-DOC-006。

  const escDriveQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  // 連携状態（available = OAuth 構成 / connected + driveScope = カレンダートークンに drive.readonly / 既定フォルダ）
  app.get('/meet/status', async (c) => {
    const user = c.get('user')
    await guardFeature(pool, user, 'minutes') // 議事録機能の F-16 ガードと一貫（deny 主体は連携も不可）
    if (!googleOauthEnabled(env)) {
      return c.json({ data: { available: false, connected: false, driveScope: false, defaultFolder: null } })
    }
    const state = await driveTokenState(pool, user.id)
    return c.json({ data: {
      available: true, connected: state.connected, driveScope: state.driveScope,
      defaultFolder: await meetDefaultFolder(pool),
    } })
  })

  // 保管フォルダの一覧（既定の設定・連携先の変更用。読取のみ・ごみ箱除外）
  app.get('/meet/folders', async (c) => {
    const user = c.get('user')
    await guardFeature(pool, user, 'minutes')
    const token = await requireDriveToken(pool, env, user.id)
    const q = String(c.req.query('q') ?? '').trim().slice(0, 100)
    const conditions = [`mimeType = 'application/vnd.google-apps.folder'`, 'trashed = false']
    if (q) conditions.push(`name contains '${escDriveQ(q)}'`)
    const params = new URLSearchParams({
      q: conditions.join(' and '), pageSize: '50', orderBy: 'modifiedTime desc', fields: 'files(id,name)',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    })
    const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const g = await googleErrorDetail(res)
      throw err('AKO-NOTE-004', `フォルダ一覧の取得に失敗しました（HTTP ${res.status}${g.detail ? ` / ${g.detail}` : ''}）${driveForbiddenHint(res.status, g.raw)}`, 502)
    }
    const body = await res.json() as { files?: { id: string; name: string }[] }
    return c.json({ data: (body.files ?? []).map(f => ({ id: f.id, name: f.name })) })
  })

  // 選択フォルダ内のファイル一覧（Meet の AI メモ = Google ドキュメント / 録画 = 動画。folderId 未指定は既定フォルダ）
  app.get('/meet/files', async (c) => {
    const user = c.get('user')
    await guardFeature(pool, user, 'minutes')
    const token = await requireDriveToken(pool, env, user.id)
    let folderId = String(c.req.query('folderId') ?? '').trim()
    if (!folderId) folderId = (await meetDefaultFolder(pool))?.id ?? ''
    if (!folderId) throw err('AKO-NOTE-005', '保管フォルダを指定してください（既定フォルダが未設定です）', 400)
    const q = String(c.req.query('q') ?? '').trim().slice(0, 100)
    const conditions = [`'${escDriveQ(folderId)}' in parents`, 'trashed = false',
      `mimeType != 'application/vnd.google-apps.folder'`]
    if (q) conditions.push(`name contains '${escDriveQ(q)}'`)
    const params = new URLSearchParams({
      q: conditions.join(' and '), pageSize: '50', orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,webViewLink,modifiedTime)',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    })
    const res = await fetch(`${DRIVE_FILES_URL}?${params}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const g = await googleErrorDetail(res)
      throw err('AKO-NOTE-004', `ファイル一覧の取得に失敗しました（HTTP ${res.status}${g.detail ? ` / ${g.detail}` : ''}）${driveForbiddenHint(res.status, g.raw)}`, 502)
    }
    const body = await res.json() as {
      files?: { id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string }[]
    }
    return c.json({ data: (body.files ?? []).map(f => ({
      id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink ?? '', modifiedTime: f.modifiedTime ?? '',
      // AI メモ = Google ドキュメント / 録画 = 動画 / その他（判別は UI アイコン用）
      fileKind: f.mimeType.startsWith('video/') ? 'recording'
        : f.mimeType === 'application/vnd.google-apps.document' ? 'notes' : 'other',
    })) })
  })

  // AI メモ（Google ドキュメント）を text/plain でエクスポート（議事録本文へ取り込む材料。本文へは UI で反映）
  app.get('/meet/file-text', async (c) => {
    const user = c.get('user')
    await guardFeature(pool, user, 'minutes')
    const token = await requireDriveToken(pool, env, user.id)
    const fileId = String(c.req.query('fileId') ?? '').trim()
    if (!fileId) throw err('AKO-GEN-001', 'fileId を指定してください', 400)
    const res = await fetch(
      `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      const g = await googleErrorDetail(res)
      throw err('AKO-NOTE-004', `AI メモの取得に失敗しました（Google ドキュメント形式のみ本文取込に対応。HTTP ${res.status}${g.detail ? ` / ${g.detail}` : ''}）`, 502)
    }
    const text = (await res.text()).replace(/\r\n/g, '\n').trim()
    return c.json({ data: { text: capCp(text, BODY_CAP) } })
  })

  // 既定の保管フォルダを設定/クリア（管理者のみ = tenant 設定 app_configs。id 空でクリア）
  app.put('/meet/default-folder', async (c) => {
    const user = c.get('user')
    await guardFeature(pool, user, 'minutes')
    if (user.role !== 'admin') throw err('AKO-PRM-001', '既定フォルダの設定は管理者のみです', 403)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const id = typeof b.id === 'string' ? b.id.trim().slice(0, 200) : ''
    const name = typeof b.name === 'string' ? capCp(b.name.trim(), 300) : ''
    if (!id) {
      await pool.query(`DELETE FROM app_configs WHERE key = $1`, [MEET_DEFAULT_FOLDER_KEY])
    } else {
      await pool.query(
        `INSERT INTO app_configs (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [MEET_DEFAULT_FOLDER_KEY, JSON.stringify({ id, name })])
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'app_configs', entityId: MEET_DEFAULT_FOLDER_KEY,
      detail: id ? `Meet 既定保管フォルダを設定（${name || id}）` : 'Meet 既定保管フォルダをクリア',
    })
    return c.json({ data: await meetDefaultFolder(pool) })
  })

  // ポスト単位の通知先の編集（poipoi のみ・投稿者本人または管理者。改善要望 2026-08-21）。
  // 登録後にロール/役職/個人の宛先を変更できる。保存後、変更前の宛先に**含まれていなかった**解決済み
  // メンバーへだけ原文を再通知する（既存宛先への重複通知を作らない = 冪等性・原則2）。通知は非ブロッキング（原則4）。
  // body.targets = NotifyRecipientTarget[]（空配列 = このポストは通知しない / null = テナント設定へ戻す〔取消フロー = 原則9.5〕）
  app.put('/:noteId/notify-targets', async (c) => {
    const user = c.get('user')
    const noteId = c.req.param('noteId')
    const { rows } = await pool.query<{
      kind: NoteKind; memberId: string; body: string; active: boolean; notifyTargets: unknown
    }>(
      `SELECT kind, member_id AS "memberId", body, active, notify_targets AS "notifyTargets"
       FROM notes WHERE id = $1`, [noteId])
    const note = rows[0]
    if (!note) throw err('AKO-GEN-002', 'ノートが見つかりません', 404)
    if (note.kind !== 'poipoi') throw err('AKO-GEN-001', '通知先の編集は改善のタネ（ぽいぽいポスト）のみです', 400)
    await guardFeature(pool, user, 'poipoi')
    if (note.memberId !== user.id && user.role !== 'admin') {
      throw err('AKO-PRM-001', '通知先の編集は投稿者本人または管理者のみです', 403)
    }
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    // targets キーの欠落（JSON 破損含む）は 400: 契約は「配列 = 上書き（空 = 通知しない）/ null = 既定へ戻す」の
    // 2 値であり、欠落を空配列に読み替えると最も強い「通知しない」へ黙って倒れる（レビュー R1 N-2）
    if (!Object.hasOwn(b, 'targets')) throw err('AKO-GEN-001', 'targets を指定してください（配列 or null）', 400)
    const next = b.targets === null ? null : parseNotifyRecipients(b.targets)
    // 変更前の実効宛先（上書きがあればそれ・無ければテナント設定）を解決し、追加分だけ再通知する
    const prevTargets = note.notifyTargets != null
      ? parseNotifyRecipients(note.notifyTargets)
      : await tenantPoipoiTargets(pool)
    const { rows: members } = await pool.query<{ id: string; role: string; title: string; active: boolean }>(
      `SELECT id, role, title, active FROM members`)
    await pool.query(
      `UPDATE notes SET notify_targets = $2 WHERE id = $1`,
      [noteId, next ? JSON.stringify(next) : null])
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'notes', entityId: noteId,
      detail: next === null
        ? '改善のタネの通知先をテナント設定へ戻した'
        : `改善のタネの通知先を編集（宛先 ${next.length} 件）`,
    })
    // 追加された宛先へだけ原文を通知（取消済みポストは再通知しない）
    if (note.active) {
      const nextEffective = next ?? await tenantPoipoiTargets(pool)
      const addedIds = addedNotifyRecipientIds(prevTargets, nextEffective, members, note.memberId)
      if (addedIds.length > 0) {
        const { rows: nameRows } = await pool.query<{ name: string }>(
          `SELECT name FROM members WHERE id = $1`, [note.memberId])
        await notifyPoipoiRecipients(pool, { id: note.memberId, name: nameRows[0]?.name ?? note.memberId },
          note.body, noteId, nextEffective, addedIds)
      }
    }
    const { rows: out } = await pool.query(`SELECT ${NOTE_COLS} FROM notes WHERE id = $1`, [noteId])
    return c.json({ data: out[0] })
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
      detail: `${note.kind === 'poipoi' ? '改善のタネ' : '議事録'}「${capCp(note.title, 40)}」を取消`,
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
      detail: `${note.kind === 'poipoi' ? '改善のタネ' : '議事録'}「${capCp(note.title, 40)}」を復元`,
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
