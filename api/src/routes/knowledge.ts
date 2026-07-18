/**
 * ナレッジのドキュメント取込（オペレーター指示 2026-07-18 #3: .md/.txt/.pdf/.docx のアップロード蓄積）。
 * - 既存の knowledge_articles スキーマは不変（SoT）。抽出テキストを body へ格納し、
 *   アップロード原本は knowledge_files へ保全（監査・再抽出用。原則7 = 既存マスタを崩さない）
 * - 抽出: .md/.txt = UTF-8 / .pdf = pdf-parse / .docx = mammoth（.doc 旧形式は非対応と明示）
 * - 取込後は検索インデックスを自動再生成（AI が探索・解釈しやすい最適化データへ反映）
 * エラー: AKO-KNW-001（非対応形式）/ AKO-KNW-002（サイズ超過）/ AKO-KNW-003（テキスト抽出不能）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { extractDocumentText } from '../lib/extract-text'
import { newId } from '../lib/ids'
import { scheduleSearchRebuild } from '../lib/search-index'
import { capCp } from '../lib/text'

/** 原本サイズ上限（10MB。base64 で約 13.4MB） */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** 抽出テキストの格納上限（コードポイント。検索・文脈供給には十分で DB 肥大を防ぐ） */
const BODY_CAP = 20_000

const KNOWLEDGE_DOMAINS = new Set(['industry', 'company', 'contact', 'relation', 'project'])

const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Markdown の先頭見出し（# ...）をタイトル候補として拾う */
function firstHeading(ext: string, text: string): string {
  if (ext !== 'md') return ''
  const m = text.match(/^#{1,3}\s+(.+)$/m)
  return m?.[1]?.trim() ?? ''
}

export function knowledgeRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // ドキュメントアップロード取込（管理者のみ = ナレッジマスタの変更権限と同一）
  app.post('/import', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as {
      filename?: string; contentBase64?: string; domain?: string; targetId?: string
      title?: string; tags?: unknown
    }
    const filename = String(body.filename ?? '').trim()
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
    if (!EXT_MIME[ext]) {
      throw err('AKO-KNW-001',
        `対応形式は .md / .txt / .pdf / .docx です${ext === 'doc' ? '（旧形式 .doc は .docx へ変換してください）' : ''}`, 400)
    }
    const domain = String(body.domain ?? '')
    if (!KNOWLEDGE_DOMAINS.has(domain)) {
      throw err('AKO-GEN-001', 'domain を指定してください（industry / company / contact / relation / project）', 400)
    }
    const contentBase64 = String(body.contentBase64 ?? '')
    if (!contentBase64) throw err('AKO-GEN-001', 'contentBase64 を指定してください', 400)
    if (contentBase64.length > MAX_FILE_BYTES * 1.4) {
      throw err('AKO-KNW-002', 'ファイルが大きすぎます（10MB 以下にしてください）', 400)
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw err('AKO-KNW-002', 'ファイルが空か大きすぎます（10MB 以下にしてください）', 400)
    }

    const raw = await extractDocumentText(ext, bytes)
    const text = (raw ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) {
      throw err('AKO-KNW-003',
        'ファイルからテキストを抽出できませんでした（画像のみの PDF 等は非対応です）', 422)
    }

    const title = capCp(
      String(body.title ?? '').trim() || firstHeading(ext, text) || filename.replace(/\.[^.]+$/, ''), 200)
    const tags = (Array.isArray(body.tags) ? body.tags.map(String) : []).slice(0, 10)
    const knowledgeId = newId('ka')
    // ナレッジ記事（SoT）→ 原本の順に保存。原本保存の失敗は記事を残したまま報告（非ブロッキングではなく
    // 同一トランザクションで両方を確定する = 中途半端な取込を作らない）
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO knowledge_articles (id, domain, target_id, title, body, tags, source, source_ref_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', NULL)`,
        [knowledgeId, domain, String(body.targetId ?? ''), title, capCp(text, BODY_CAP), JSON.stringify(tags)])
      await client.query(
        `INSERT INTO knowledge_files (id, knowledge_id, filename, mime, size_bytes, bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId('kf'), knowledgeId, filename, EXT_MIME[ext], bytes.length, bytes, user.id])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'import', entity: 'knowledge_articles', entityId: knowledgeId,
      detail: `ドキュメント取込（${filename} → ナレッジ「${capCp(title, 40)}」）`,
    })
    scheduleSearchRebuild(pool, env, 'knowledge:import')
    const { rows } = await pool.query(
      `SELECT id, domain, target_id AS "targetId", title, body, tags, source, active
       FROM knowledge_articles WHERE id = $1`, [knowledgeId])
    return c.json({ data: rows[0] }, 201)
  })

  // ナレッジの添付原本メタ一覧（認証済みなら参照可 = ナレッジ本文と同じ可視性）
  app.get('/:knowledgeId/files', async (c) => {
    const { rows } = await pool.query(
      `SELECT id, knowledge_id AS "knowledgeId", filename, mime, size_bytes AS "sizeBytes",
              uploaded_by AS "uploadedBy", created_at AS "createdAt"
       FROM knowledge_files WHERE knowledge_id = $1 ORDER BY created_at, id`,
      [c.req.param('knowledgeId')])
    return c.json({ data: rows })
  })

  // 原本ダウンロード（base64 JSON。10MB 上限のため許容）
  app.get('/files/:id', async (c) => {
    const { rows } = await pool.query<{ filename: string; mime: string; bytes: Buffer }>(
      `SELECT filename, mime, bytes FROM knowledge_files WHERE id = $1`, [c.req.param('id')])
    const f = rows[0]
    if (!f) throw err('AKO-GEN-002', 'ファイルが見つかりません', 404)
    return c.json({ data: { filename: f.filename, mime: f.mime, contentBase64: f.bytes.toString('base64') } })
  })

  return app
}
