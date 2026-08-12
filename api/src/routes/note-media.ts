/**
 * note（note.com）連携 API（F-40 メディア分析の拡張。オペレーター指示 2026-08-12）。
 * メディアチャンネル単位で「記事原稿 → note 下書きプッシュ → 公開後の反応収集 → AI フィードバック →
 * 次の記事（既存の記事生成 fromInsightId へ接続）」の PDCA ループを回す。routes/media.ts と同じ
 * 設計（管理者 = 連携・外部書込 / 全ロール = 参照・生成、論理削除 = 原則9.5、LLM フォールバック = 原則4）。
 *
 * **非公式 API の前提:** note に公式 API はない（lib/note-api.ts 冒頭参照）。
 * - 書込は**下書き作成まで**。公開は人間が note 管理画面で行う（自動公開しない = 誤公開の不可逆を作らない）
 * - 反応収集は公開エンドポイント（Cookie 不要）。セッション Cookie は下書きプッシュにのみ必要
 * - 仕様変更で失敗した場合は AKO-MEDIA-033（note 応答の抜粋付き）で運用者が自己診断できるようにする
 *
 * SoT（原則6）: 原稿 = note_posts（本アプリ）/ 公開状態・反応数 = note（note_metrics は日次スナップショット、
 * posts.status/published_at は同期による導出）。AI フィードバックは media_insights（scope='note'）へ保管し、
 * 記事生成の fromInsightId ヒント（insightHintsOf）と互換にする（原則3）。
 *
 * エラー: AKO-MEDIA-030 note 連携未設定 / 031 連携入力不正 / 032 対象の note 投稿なし /
 *         033 note API 呼び出し失敗（仕様変更の可能性）/ 034 セッション Cookie 未設定・復号不可 /
 *         035 タイトル・本文未入力 / 036 Cookie 保存不可（TOKEN_ENCRYPTION_KEY 未設定）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { addDays, todayJst } from '../../../shared/domain/jst'
import {
  foldNoteSnapshots, heuristicNoteFeedback, type NoteFeedback, noteHtmlOf,
  type NoteMetricsSummary, type NoteSnapshotRow,
} from '../../../shared/domain/note-media'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { fetchCreatorContents, type NoteContentItem, NOTE_SESSION_COOKIE, pushDraft } from '../lib/note-api'
import { capCp } from '../lib/text'
import { channelIdOf, findings, mediaActions, strArr } from './media'

// ---------- 入力検証・部分更新（純粋関数・単体テスト対象） ----------

export interface NoteConnectionInput {
  urlname?: string
  /** undefined = 変更なし / '' = クリア / 非空 = 設定 */
  sessionCookie?: string
}

/**
 * 連携設定の入力（body に実在するキーのみ = 送っていないフィールドの保持。Zod v4 注意への構造的対応）。
 * sessionCookie は「_note_session_v5=xxx」形式の貼り付けも許容し、値部分だけを取り出す。
 */
export function noteConnectionInputOf(body: Record<string, unknown>): NoteConnectionInput {
  const out: NoteConnectionInput = {}
  if (Object.hasOwn(body, 'urlname')) {
    const v = String(body.urlname ?? '').trim().replace(/^@/, '')
    if (!/^[a-z0-9_]{1,50}$/i.test(v)) {
      throw err('AKO-MEDIA-031', 'urlname は note のクリエイター ID（note.com/xxx の xxx。英数字と _）を指定してください', 400)
    }
    out.urlname = v
  }
  if (Object.hasOwn(body, 'sessionCookie')) {
    let v = String(body.sessionCookie ?? '').trim()
    const prefix = `${NOTE_SESSION_COOKIE}=`
    if (v.startsWith(prefix)) v = v.slice(prefix.length).replace(/;.*$/, '').trim()
    if (v.length > 4000) throw err('AKO-MEDIA-031', 'sessionCookie が長すぎます（Cookie の値部分のみを貼り付けてください）', 400)
    out.sessionCookie = v
  }
  return out
}

export interface NotePostPatch {
  title?: string
  body?: string
  noteKey?: string
}

/** note 投稿の部分更新（送ったキーのみ。手動公開した記事の紐付けは noteKey の設定で行う） */
export function notePostPatchOf(body: Record<string, unknown>): NotePostPatch {
  const out: NotePostPatch = {}
  if (Object.hasOwn(body, 'title')) {
    const v = capCp(String(body.title ?? '').trim(), 120)
    if (!v) throw err('AKO-MEDIA-035', 'タイトルを入力してください', 400)
    out.title = v
  }
  if (Object.hasOwn(body, 'body')) out.body = capCp(String(body.body ?? ''), 50000)
  if (Object.hasOwn(body, 'noteKey')) {
    const v = String(body.noteKey ?? '').trim()
    if (v && !/^[a-z0-9]{1,30}$/i.test(v)) {
      throw err('AKO-MEDIA-031', 'noteKey は note 記事 URL（note.com/xxx/n/{key}）の {key} 部分を指定してください', 400)
    }
    out.noteKey = v
  }
  return out
}

/** note の publishAt 生値（例: 2026-08-01T09:00:00+09:00）→ YYYY-MM-DD。読めなければ null */
export function publishedDateOf(publishAt: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(publishAt)
  return m ? m[1]! : null
}

interface PostRow {
  id: string
  status: string
  noteKey: string
}

/**
 * 同期時の公開検知（純粋関数・単体テスト対象）: note_key が note の公開記事一覧と一致した
 * 未公開投稿（pushed のほか、手動公開の記事を noteKey で紐付けた local_draft も対象）を published へ。
 * published からの巻き戻しはしない（記録保護 = 原則2。note 側の一覧から消えても、
 * 削除かページ打ち切りかを区別できないため状態は保持する）。
 */
export function publishedPostUpdates(
  posts: PostRow[], contents: NoteContentItem[],
): { id: string; publishedAt: string | null; noteUrl: string }[] {
  const byKey = new Map(contents.map(c => [c.key, c]))
  return posts
    .filter(p => p.status !== 'published' && p.noteKey && byKey.has(p.noteKey))
    .map((p) => {
      const c = byKey.get(p.noteKey)!
      return { id: p.id, publishedAt: publishedDateOf(c.publishAt), noteUrl: c.noteUrl }
    })
}

// ---------- LLM フィードバックの正規化（純粋関数・単体テスト対象） ----------

/** LLM 出力 → NoteFeedback（欠落・型崩れは null = ヒューリスティックへフォールバック。正規化は media.ts と共通） */
export function normalizeNoteFeedback(res: unknown): NoteFeedback | null {
  const r = res as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !String(r.executiveSummary ?? '').trim()) return null
  return {
    executiveSummary: capCp(String(r.executiveSummary), 1200),
    articles: findings(r.articles),
    actions: mediaActions(r.actions),
    nextTopics: strArr(r.nextTopics, 5, 100).filter(Boolean),
  }
}

// ---------- 連携行・Cookie ----------

interface ConnectionRow {
  channelId: string
  urlname: string
  sessionCookieEnc: string
  connectedAt: string
}

async function connectionRow(pool: pg.Pool, channelId: string): Promise<ConnectionRow | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT channel_id AS "channelId", urlname, session_cookie_enc AS "sessionCookieEnc",
            to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "connectedAt"
     FROM note_connections WHERE channel_id = $1`, [channelId])
  return rows[0] ?? null
}

// ---------- 同期（チャンネル単位。ルート + ジョブで共用） ----------

export interface NoteSyncResult {
  channelId: string
  fetched: number
  snapshotDate: string
  publishedDetected: number
  warning?: string
}

/**
 * 1 チャンネルの反応同期: note の公開記事一覧 → 当日スナップショット upsert + 公開検知。
 * 冪等（原則2）: 同日再実行は当日行の更新のみ。過去日のスナップショットへは触れない。
 * 公開検知は pushed → published の一方向（巻き戻しなし = 記録保護）。
 */
export async function runNoteSyncChannel(pool: pg.Pool, channelId: string): Promise<NoteSyncResult> {
  const conn = await connectionRow(pool, channelId)
  if (!conn) throw err('AKO-MEDIA-030', 'note 連携が未設定です。メディア設定から note のクリエイター ID（urlname）を登録してください', 409)
  const fetched = await fetchCreatorContents(conn.urlname)
  if (!fetched.ok) {
    throw err('AKO-MEDIA-033',
      `note からの記事一覧取得に失敗しました（HTTP ${fetched.status}${fetched.detail ? ` / note 応答: ${fetched.detail}` : ''}）。`
      + '時間をおいて再試行してください。繰り返し失敗する場合は note の仕様変更の可能性があります', 502)
  }
  const { items, warning } = fetched.value
  const snapshotDate = todayJst()
  for (const item of items) {
    await pool.query(
      `INSERT INTO note_metrics (id, channel_id, note_key, snapshot_date, title, like_count, comment_count)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7)
       ON CONFLICT (channel_id, note_key, snapshot_date) DO UPDATE SET
         title = EXCLUDED.title, like_count = EXCLUDED.like_count,
         comment_count = EXCLUDED.comment_count, fetched_at = now()`,
      [newId('nm'), channelId, item.key, snapshotDate, item.title, item.likeCount, item.commentCount])
  }
  const { rows: posts } = await pool.query<PostRow>(
    `SELECT id, status, note_key AS "noteKey" FROM note_posts WHERE channel_id = $1 AND active = true`, [channelId])
  const updates = publishedPostUpdates(posts, items)
  for (const u of updates) {
    await pool.query(
      `UPDATE note_posts SET status = 'published', published_at = $2::date, note_url = $3, updated_at = now()
       WHERE id = $1 AND status <> 'published'`,
      [u.id, u.publishedAt, u.noteUrl])
  }
  return { channelId, fetched: items.length, snapshotDate, publishedDetected: updates.length, warning }
}

/** 全連携チャンネルの同期（Cloud Scheduler ジョブ用）。チャンネル単位の失敗は他を止めない（原則4） */
export async function runNoteSyncAll(
  pool: pg.Pool,
): Promise<{ synced: NoteSyncResult[]; failed: { channelId: string; error: string }[] }> {
  const { rows } = await pool.query<{ channelId: string }>(
    `SELECT c.channel_id AS "channelId" FROM note_connections c
     JOIN media_channels ch ON ch.id = c.channel_id AND ch.active = true ORDER BY c.channel_id`)
  const synced: NoteSyncResult[] = []
  const failed: { channelId: string; error: string }[] = []
  for (const { channelId } of rows) {
    try {
      synced.push(await runNoteSyncChannel(pool, channelId))
    } catch (e) {
      console.warn(`note sync failed (channel ${channelId}):`, (e as Error).message)
      failed.push({ channelId, error: capCp((e as Error).message, 200) })
    }
  }
  return { synced, failed }
}

// ---------- フィードバック生成の材料・LLM ----------

async function summaryOf(
  pool: pg.Pool, channelId: string, days: number,
): Promise<NoteMetricsSummary> {
  const periodTo = todayJst()
  const periodFrom = addDays(periodTo, -(days - 1))
  const { rows } = await pool.query<NoteSnapshotRow>(
    `SELECT note_key AS "noteKey", to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate",
            title, like_count AS "likeCount", comment_count AS "commentCount", view_count AS "viewCount"
     FROM note_metrics
     WHERE channel_id = $1 AND snapshot_date >= $2::date AND snapshot_date <= $3::date
     ORDER BY snapshot_date`, [channelId, periodFrom, periodTo])
  return foldNoteSnapshots(rows, periodFrom, periodTo)
}

async function llmNoteFeedback(
  env: Env, summary: NoteMetricsSummary,
  materials: { title: string; excerpt: string }[],
  channel: { analysisGoal: string; targetAudience: string },
): Promise<NoteFeedback | null> {
  if (!env.vertexProjectId) return null
  const materialBlock = materials.length === 0
    ? ''
    : `\n\n# 公開済み記事の原文抜粋（${materials.length} 件）\n`
      + materials.map((m, i) => `## ${i + 1}. ${m.title}\n${m.excerpt}`).join('\n\n')
  const res = await generateJson<Record<string, unknown>>(env, {
    system: 'あなたは note（note.com）で発信するコンテンツマーケティングのコンサルタント AI です。'
      + '記事ごとの反応（スキ・コメントの実数と期間内増分）から、何が読者に刺さったかの分析と'
      + '「次に書くべき記事」の提案を日本語で出力します。'
      + `発信の目的: ${channel.analysisGoal || 'leadgen'} / 想定読者: ${channel.targetAudience || '未設定'}。`
      + '集計値・提供された原文にある事実のみを根拠にし、推測で数値・事実を作らないこと。'
      + 'executiveSummary は 3〜5 文。articles の kind は win / issue / opportunity、'
      + 'actions の priority は high / mid / low（最大 各 5 件）。'
      + 'nextTopics は次の記事のテーマ案（記事のお題としてそのまま使える具体的な文。最大 5 件）。',
    prompt: `# note 反応集計（${summary.periodFrom}〜${summary.periodTo}）\n${JSON.stringify(summary, null, 1)}${materialBlock}`,
    schema: {
      type: 'object',
      properties: {
        executiveSummary: { type: 'string' },
        articles: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } },
            required: ['kind', 'title', 'detail'],
          },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, detail: { type: 'string' }, priority: { type: 'string' } },
            required: ['title', 'detail', 'priority'],
          },
        },
        nextTopics: { type: 'array', items: { type: 'string' } },
      },
      required: ['executiveSummary', 'articles', 'actions', 'nextTopics'],
    },
    maxTokens: 3000,
  })
  return normalizeNoteFeedback(res)
}

// ---------- ルート ----------

const POST_COLS = `id, channel_id AS "channelId", generated_article_id AS "generatedArticleId",
  title, body, status, note_key AS "noteKey", note_url AS "noteUrl",
  to_char(pushed_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "pushedAt",
  to_char(published_at, 'YYYY-MM-DD') AS "publishedAt", created_by AS "createdBy", active,
  to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt"`

export function noteMediaRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ---- 連携状態（全ロール参照可。Cookie 値は返さない = 有無のみ）----
  app.get('/note/status', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const conn = await connectionRow(pool, channelId)
    const cookieStorable = Boolean(env.tokenEncryptionKey)
    const hasCookie = Boolean(
      conn?.sessionCookieEnc && decryptSecret(conn.sessionCookieEnc, env.tokenEncryptionKey) !== null)
    return c.json({
      data: {
        connected: Boolean(conn),
        urlname: conn?.urlname ?? null,
        // hasCookie=false かつ sessionCookieEnc あり = 鍵ローテーション後の復号不能 → 再登録導線
        hasCookie,
        cookieStorable,
        connectedAt: conn?.connectedAt ?? null,
      },
    })
  })

  // ---- 連携の登録・更新（管理者のみ。urlname だけでも反応収集は動く = Cookie は任意）----
  app.put('/note/connection', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const input = noteConnectionInputOf(body)
    // チャンネルの存在検証（PUT /settings と同じ 021。タイポ channelId への幽霊連携 = ジョブ対象外の行を作らない）
    const { rows: chRows } = await pool.query(`SELECT 1 FROM media_channels WHERE id = $1`, [channelId])
    if (!chRows[0]) throw err('AKO-MEDIA-021', '対象のメディアチャンネルが見つかりません', 404)
    const existing = await connectionRow(pool, channelId)
    if (!existing && !input.urlname) {
      throw err('AKO-MEDIA-031', 'urlname は note のクリエイター ID（note.com/xxx の xxx。英数字と _）を指定してください', 400)
    }
    let cookieEnc: string | undefined
    if (input.sessionCookie !== undefined) {
      if (input.sessionCookie === '') {
        cookieEnc = ''
      } else {
        if (!env.tokenEncryptionKey) {
          throw err('AKO-MEDIA-036', 'セッション Cookie を保存できません（TOKEN_ENCRYPTION_KEY が未設定です。管理者はデプロイ設定を確認してください）', 409)
        }
        cookieEnc = encryptSecret(input.sessionCookie, env.tokenEncryptionKey)
      }
    }
    await pool.query(
      `INSERT INTO note_connections (channel_id, urlname, session_cookie_enc, connected_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id) DO UPDATE SET
         urlname = COALESCE($5, note_connections.urlname),
         session_cookie_enc = COALESCE($6, note_connections.session_cookie_enc),
         connected_by = $4, updated_at = now()`,
      [channelId, input.urlname ?? '', cookieEnc ?? '', user.id,
        input.urlname ?? null, cookieEnc ?? null])
    // Cookie 値は監査ログにも残さない（detail は設定の有無のみ）
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'note_connections', entityId: channelId,
      detail: `note 連携を設定: ${input.urlname ?? '(urlname 変更なし)'}${input.sessionCookie !== undefined ? (input.sessionCookie ? ' / Cookie 更新' : ' / Cookie クリア') : ''}`,
    })
    const conn = await connectionRow(pool, channelId)
    return c.json({ data: { channelId, urlname: conn?.urlname, hasCookie: Boolean(conn?.sessionCookieEnc) } })
  })

  // ---- 連携解除（管理者のみ。原稿・スナップショットは残す = 非破壊。再登録で復旧できる = 原則9.5）----
  app.post('/note/disconnect', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    await pool.query(`DELETE FROM note_connections WHERE channel_id = $1`, [channelId])
    await audit(pool, {
      actorId: user.id, action: 'delete', entity: 'note_connections', entityId: channelId,
      detail: 'note 連携を解除',
    })
    return c.json({ data: { ok: true } })
  })

  // ---- 記事原稿の一覧・作成・編集・取消/復元 ----
  app.get('/note/posts', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const includeInactive = c.req.query('includeInactive') === '1'
    const { rows } = await pool.query(
      `SELECT ${POST_COLS} FROM note_posts
       WHERE channel_id = $1 ${includeInactive ? '' : 'AND active = true'}
       ORDER BY created_at DESC, id LIMIT 500`, [channelId])
    return c.json({ data: rows })
  })

  // 作成（全ロール可 = 記事生成スタジオと同じ可視性）。fromGeneratedId で AI 生成記事から取り込む
  app.post('/note/posts', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    let title = capCp(String(body.title ?? '').trim(), 120)
    let markdown = capCp(String(body.body ?? ''), 50000)
    const fromGeneratedId = typeof body.fromGeneratedId === 'string' && body.fromGeneratedId ? body.fromGeneratedId : null
    if (fromGeneratedId) {
      const { rows } = await pool.query<{ payload: { title?: string; body?: string } }>(
        `SELECT payload FROM media_generated_articles WHERE id = $1 AND channel_id = $2 AND active = true`,
        [fromGeneratedId, channelId])
      if (!rows[0]) throw err('AKO-MEDIA-012', '対象の生成記事が見つかりません', 404)
      title = title || capCp(String(rows[0].payload.title ?? '').trim(), 120)
      markdown = markdown || capCp(String(rows[0].payload.body ?? ''), 50000)
    }
    if (!title) throw err('AKO-MEDIA-035', 'タイトルを入力してください', 400)
    const id = newId('np')
    const { rows } = await pool.query(
      `INSERT INTO note_posts (id, channel_id, generated_article_id, title, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${POST_COLS}`,
      [id, channelId, fromGeneratedId, title, markdown, user.id])
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'note_posts', entityId: id,
      detail: `note 記事原稿を作成: ${title}`,
    })
    return c.json({ data: rows[0] }, 201)
  })

  // 編集（送ったキーのみ = 未指定は保持）。noteKey の設定 = 手動公開した note 記事との紐付け
  app.patch('/note/posts/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const patch = notePostPatchOf(body)
    const assigns: string[] = ['updated_at = now()']
    const values: unknown[] = []
    const add = (col: string, val: unknown) => {
      values.push(val)
      assigns.push(`${col} = $${values.length + 1}`)
    }
    if (patch.title !== undefined) add('title', patch.title)
    if (patch.body !== undefined) add('body', patch.body)
    if (patch.noteKey !== undefined) add('note_key', patch.noteKey)
    const { rows } = await pool.query(
      `UPDATE note_posts SET ${assigns.join(', ')} WHERE id = $1 RETURNING ${POST_COLS}`,
      [id, ...values])
    if (!rows[0]) throw err('AKO-MEDIA-032', '対象の note 投稿が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'note_posts', entityId: id, detail: 'note 記事原稿を更新' })
    return c.json({ data: rows[0] })
  })

  // 取消（論理削除）・復元（原則9.5）
  app.post('/note/posts/:id/archive', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE note_posts SET active = false, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-032', '対象の note 投稿が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'note_posts', entityId: id, detail: 'note 記事原稿を取消（論理削除）' })
    return c.json({ data: { id } })
  })

  app.post('/note/posts/:id/restore', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const { rowCount } = await pool.query(
      `UPDATE note_posts SET active = true, updated_at = now() WHERE id = $1`, [id])
    if (rowCount === 0) throw err('AKO-MEDIA-032', '対象の note 投稿が見つかりません', 404)
    await audit(pool, { actorId: user.id, action: 'update', entity: 'note_posts', entityId: id, detail: 'note 記事原稿を復元' })
    return c.json({ data: { id } })
  })

  // ---- note へ下書きプッシュ（管理者のみ = 外部アカウントへの書込。公開はしない）----
  // 再プッシュは同じ下書き（note_draft_id）の更新 = 冪等（下書きを増やさない）。
  // 公開済みの記事はプッシュ不可（note 側の公開記事と原稿の二重管理を作らない）
  app.post('/note/posts/:id/push', async (c) => {
    const user = requireAdmin(c)
    const id = c.req.param('id')
    const { rows } = await pool.query<{ channelId: string; title: string; body: string; status: string; noteDraftId: string }>(
      `SELECT channel_id AS "channelId", title, body, status, note_draft_id AS "noteDraftId"
       FROM note_posts WHERE id = $1 AND active = true`, [id])
    const post = rows[0]
    if (!post) throw err('AKO-MEDIA-032', '対象の note 投稿が見つかりません', 404)
    if (post.status === 'published') {
      throw err('AKO-GEN-002', '公開済みの記事は再プッシュできません（本文の修正は note の管理画面で行ってください）', 409)
    }
    if (!post.title || !post.body.trim()) throw err('AKO-MEDIA-035', 'タイトルと本文を入力してからプッシュしてください', 400)
    const conn = await connectionRow(pool, post.channelId)
    if (!conn) throw err('AKO-MEDIA-030', 'note 連携が未設定です。メディア設定から note のクリエイター ID（urlname）を登録してください', 409)
    const cookie = conn.sessionCookieEnc ? decryptSecret(conn.sessionCookieEnc, env.tokenEncryptionKey) : null
    if (!cookie) {
      throw err('AKO-MEDIA-034',
        'note のセッション Cookie が未設定か無効です。ブラウザで note にログインし、'
        + `Cookie「${NOTE_SESSION_COOKIE}」の値をメディア設定から登録してください`, 409)
    }
    const result = await pushDraft(cookie, {
      draftId: post.noteDraftId || undefined,
      title: post.title,
      htmlBody: noteHtmlOf(post.body),
    })
    if (!result.ok) {
      // 枠確保に成功して本文保存で失敗した場合は draftId を保存し、リトライで同じ下書きを再利用する
      // （失敗のたびに空の下書きが note 側へ溜まらない = 冪等・原則2）
      if (result.draftId && result.draftId !== post.noteDraftId) {
        await pool.query(
          `UPDATE note_posts SET note_draft_id = $2, updated_at = now() WHERE id = $1`,
          [id, result.draftId])
      }
      // 401/403 = Cookie 失効の可能性が高い → 再登録導線を案内。それ以外は仕様変更の可能性を明示
      if (result.status === 401 || result.status === 403) {
        throw err('AKO-MEDIA-034',
          `note の認証に失敗しました（HTTP ${result.status}）。セッション Cookie が失効している可能性があります。`
          + 'ブラウザで note にログインし直し、Cookie を再登録してください', 502)
      }
      throw err('AKO-MEDIA-033',
        `note への下書き送信に失敗しました（HTTP ${result.status}${result.detail ? ` / note 応答: ${result.detail}` : ''}）。`
        + '時間をおいて再試行してください。繰り返し失敗する場合は note の仕様変更の可能性があります', 502)
    }
    // status <> 'published' ガード: プッシュ中に同期が published を検知した場合に巻き戻さない
    // （pushed → published の一方向不変条件を UPDATE 側でも守る）
    const { rows: updated } = await pool.query(
      `UPDATE note_posts SET status = 'pushed', note_draft_id = $2, note_key = COALESCE(NULLIF($3, ''), note_key),
              pushed_at = now(), updated_at = now()
       WHERE id = $1 AND status <> 'published' RETURNING ${POST_COLS}`,
      [id, result.value.draftId, result.value.key])
    if (!updated[0]) {
      throw err('AKO-GEN-002', 'プッシュ中に記事の公開が検知されたため、状態は published のまま保持しました（本文の修正は note の管理画面で行ってください）', 409)
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'note_posts', entityId: id,
      detail: `note へ下書きをプッシュ: ${post.title}`,
    })
    return c.json({
      data: {
        ...updated[0] as Record<string, unknown>,
        warning: 'note の下書きとして送信しました。内容を確認のうえ、公開は note の管理画面から行ってください（自動公開は行いません）',
      },
    })
  })

  // ---- 反応の同期（全ロール可 = 収集は参照系の延長。当日スナップショット upsert = 冪等）----
  app.post('/note/sync', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const result = await runNoteSyncChannel(pool, channelId)
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'note_metrics', entityId: channelId,
      detail: `note 反応を同期: ${result.fetched} 記事（公開検知 ${result.publishedDetected} 件）`,
    })
    return c.json({ data: result })
  })

  // ---- 反応集計（全ロール参照可。スナップショットからの導出 = 期間内デルタ付き）----
  app.get('/note/metrics', async (c) => {
    const channelId = channelIdOf(c.req.query('channelId'))
    const days = Math.min(90, Math.max(7, Math.round(Number(c.req.query('days') ?? 28)) || 28))
    const summary = await summaryOf(pool, channelId, days)
    return c.json({ data: summary })
  })

  // ---- AI フィードバック生成（全ロール可。media_insights scope='note' へ upsert 保管 = 再生成で上書き）----
  // 参照は既存の GET /v1/media/insights?scope=note（routes/media.ts）。
  // 記事生成へは fromInsightId（scope='note' のインサイト id）で接続する = 「反応 → 次の記事」の循環
  app.post('/note/feedback/generate', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const channelId = channelIdOf(body.channelId)
    const daysRaw = Number(body.days ?? 28)
    const days = Math.min(90, Math.max(7, Number.isFinite(daysRaw) ? Math.round(daysRaw) : 28))
    const summary = await summaryOf(pool, channelId, days)
    // 原稿の原文（公開済み優先・最新順）を材料に「何が刺さったか」を内容レベルで分析させる
    const { rows: postRows } = await pool.query<{ title: string; body: string }>(
      `SELECT title, body FROM note_posts
       WHERE channel_id = $1 AND active = true AND body <> ''
       ORDER BY (status = 'published') DESC, created_at DESC LIMIT 10`, [channelId])
    const materials = postRows.map(p => ({ title: p.title, excerpt: capCp(p.body, 1500) }))
    const { rows: chRows } = await pool.query<{ analysisGoal: string; targetAudience: string }>(
      `SELECT analysis_goal AS "analysisGoal", target_audience AS "targetAudience" FROM media_channels WHERE id = $1`,
      [channelId])
    const channel = chRows[0] ?? { analysisGoal: '', targetAudience: '' }
    const llmRes = await llmNoteFeedback(env, summary, materials, channel)
    const feedback = llmRes ?? heuristicNoteFeedback(summary)
    const periodKey = `${summary.periodFrom}_${summary.periodTo}`
    await pool.query(
      `INSERT INTO media_insights (id, channel_id, scope, period_key, metrics, insight, llm, warning, generated_by)
       VALUES ($1, $2, 'note', $3, $4, $5, $6, NULL, $7)
       ON CONFLICT (channel_id, scope) DO UPDATE SET
         period_key = EXCLUDED.period_key, metrics = EXCLUDED.metrics, insight = EXCLUDED.insight,
         llm = EXCLUDED.llm, warning = EXCLUDED.warning, generated_by = EXCLUDED.generated_by, generated_at = now()`,
      [newId('mi'), channelId, periodKey, JSON.stringify(summary), JSON.stringify(feedback), !!llmRes, user.id])
    const { rows } = await pool.query(
      `SELECT mi.id, mi.period_key AS "periodKey", mi.metrics, mi.insight, mi.llm, mi.warning,
              to_char(mi.generated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "generatedAt",
              m.name AS "generatedByName"
       FROM media_insights mi LEFT JOIN members m ON m.id = mi.generated_by
       WHERE mi.channel_id = $1 AND mi.scope = 'note'`, [channelId])
    return c.json({ data: rows[0] })
  })

  return app
}
