/**
 * 顧客コンテキスト API（改修依頼 2026-08-20: トップ層メニュー「顧客コンテキスト」。0076）。
 * home useCustomerContext の API 版。
 * - customer_contexts: 設定系（1社1行 = company_id UNIQUE の upsert。全員が上書き更新可・監査ログ）。
 *   部分更新は「リクエスト body に実在するキーのみ」を更新対象へフィルタ（Object.hasOwn = CLAUDE.md 部分更新原則）。
 * - customer_context_notes: 記録系（追記のみ + 論理取消/復元 = archived_at。原則9.5）。
 * - AI リサーチ（Web 調査）: 調査（generateGroundedText = 候補リスト）→ 構築（generateJson = 定性情報の提案値）
 *   の 2 段構成（ai-company.ts の Web 調査メモパターンと同型。グラウンディングと構造化出力は併用しない）。
 *   LLM 無効・失敗時は shared/domain/customer-context の決定的ヒューリスティックへフォールバック
 *   （原則4。応答の llm フラグで区別）。
 *   反映（apply）は「定性情報の upsert + research ノートの自動追記（採用ソース + 反映前の値 = payload.before）」を
 *   同一トランザクションで行い、取消（revert）は payload.before から復元 + payload.revertedAt の追記
 *   （ノートは archive しない = 監査可能な取消。原則9.5）。
 * - 検証は shared/domain/customer-context の純関数（モックとパリティ = SoT）。
 * - 機能ガード: customer-context（F-16。既定 allow = lib/permissions PATH_FEATURES）。
 *
 * app.ts へのマウント（本ユニットでは行わない。authMiddleware の**後**に登録する）:
 *   app.route('/v1/customer-contexts', customerContextsRoutes(pool, env))
 *
 * エラー: AKO-CTX-001 入力不正（400）/ 002 会社なし（404）/ 003 メモなし（404）/
 *         004 リサーチノート不正 = payload.before なし（400）/（090 = モック専用の保存容量エラー）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import {
  CUSTOMER_CONTEXT_HINT_CAP as HINT_CAP,
  CUSTOMER_CONTEXT_NOTE_CAP as NOTE_CAP,
  CUSTOMER_CONTEXT_SOURCES_MAX as SOURCES_MAX,
  type CustomerContextInput, customerContextError, customerContextNoteError,
  customerContextSourcesError,
  type CustomerResearchCandidate, type CustomerResearchHints,
  heuristicContextBuild, heuristicResearchCandidates,
  normalizeCustomerContext,
} from '../../../shared/domain/customer-context'
import { capCodePoints } from '../../../shared/domain/customer-log'
import type { CustomerContextNotePayload, CustomerContextResearchSource } from '../../../shared/domain/types'
import type { Env } from '../env'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateGroundedText, generateJson } from '../lib/llm'
import { runListQuery } from '../lib/list-query'

// created_at/updated_at は JST ウォールクロック文字列で返す（activities / customer-logs と同一規約）
function jstStamp(col: string, alias: string): string {
  return `to_char(${col} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "${alias}"`
}

const CTX_COLS = `cc.id, cc.company_id AS "companyId", cc.vision, cc.challenges,
  cc.strategy_notes AS "strategyNotes", cc.business_notes AS "businessNotes",
  cc.updated_by_member_id AS "updatedByMemberId",
  cc.updated_by_name AS "updatedByName", cc.active,
  ${jstStamp('cc.created_at', 'createdAt')}, ${jstStamp('cc.updated_at', 'updatedAt')}`

const NOTE_COLS = `cn.id, cn.company_id AS "companyId", cn.member_id AS "memberId",
  cn.member_name AS "memberName", cn.kind, cn.body, cn.payload,
  ${jstStamp('cn.archived_at', 'archivedAt')}, ${jstStamp('cn.created_at', 'createdAt')}`

/** shared 検証（メッセージ | null）を AKO-CTX-001（400）へ変換する */
function assertValid(message: string | null): void {
  if (message) throw err('AKO-CTX-001', message, 400)
}

/** 会社の実在検証（不在は 404）。取消済み（active=false）の会社も参照は許す（記録の閲覧を塞がない） */
async function findCompany(pool: pg.Pool, companyId: string): Promise<{ id: string; name: string }> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM companies WHERE id = $1`, [companyId])
  if (!rows[0]) throw err('AKO-CTX-002', '顧客(会社)が見つかりません', 404)
  return rows[0]
}

/** メモ 1 件の取得（会社スコープ付き。不在は 404。取消済みも返す = 復元 UI 用） */
async function findNote(
  pool: pg.Pool, companyId: string, noteId: string,
): Promise<{ id: string; kind: string; payload: CustomerContextNotePayload | null; archivedAt: string | null }> {
  const { rows } = await pool.query<{ id: string; kind: string; payload: CustomerContextNotePayload | null; archivedAt: string | null }>(
    `SELECT ${NOTE_COLS} FROM customer_context_notes cn WHERE cn.id = $1 AND cn.company_id = $2`,
    [noteId, companyId])
  if (!rows[0]) throw err('AKO-CTX-003', 'メモが見つかりません', 404)
  return rows[0]
}

/** 会社の現在の定性情報（未登録は空値。upsert のマージ元・リサーチの before スナップショット） */
async function currentContextOf(
  db: pg.Pool | pg.PoolClient, companyId: string,
): Promise<CustomerContextInput> {
  const { rows } = await db.query<CustomerContextInput>(
    `SELECT vision, challenges, strategy_notes AS "strategyNotes", business_notes AS "businessNotes"
     FROM customer_contexts WHERE company_id = $1`, [companyId])
  return rows[0] ?? { vision: '', challenges: '', strategyNotes: '', businessNotes: '' }
}

/** メンバー名スナップショット（表示用。不在は空 = 非ブロッキング） */
async function memberNameOf(db: pg.Pool | pg.PoolClient, memberId: string): Promise<string> {
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM members WHERE id = $1`, [memberId])
  return rows[0]?.name ?? ''
}

/** 定性情報の upsert（1社1行。SoT 書込 = 原則6。updated_by はスナップショット） */
async function upsertContext(
  db: pg.Pool | pg.PoolClient,
  companyId: string,
  values: CustomerContextInput,
  by: { memberId: string; name: string },
): Promise<void> {
  await db.query(
    `INSERT INTO customer_contexts
       (id, company_id, vision, challenges, strategy_notes, business_notes, updated_by_member_id, updated_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id) DO UPDATE SET
       vision = EXCLUDED.vision,
       challenges = EXCLUDED.challenges,
       strategy_notes = EXCLUDED.strategy_notes,
       business_notes = EXCLUDED.business_notes,
       updated_by_member_id = EXCLUDED.updated_by_member_id,
       updated_by_name = EXCLUDED.updated_by_name,
       active = true,
       updated_at = now()`,
    [newId('cctx'), companyId, values.vision, values.challenges, values.strategyNotes, values.businessNotes,
      by.memberId, by.name])
}

/** 採用ソースの正規化（title/uri のみに絞る。検証は customerContextSourcesError が済ませている前提） */
function cleanSources(raw: unknown): CustomerContextResearchSource[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, SOURCES_MAX).map(s => ({
    title: capCodePoints(String((s as { title?: unknown })?.title ?? '').trim(), 300),
    uri: capCodePoints(String((s as { uri?: unknown })?.uri ?? '').trim(), 2000),
  }))
}

/** リサーチヒントの正規化（cap。空は undefined へ落とす） */
function cleanHints(b: Record<string, unknown>): CustomerResearchHints {
  const of = (k: string): string | undefined => {
    const v = capCodePoints(String(b[k] ?? '').trim(), HINT_CAP)
    return v || undefined
  }
  return { address: of('address'), phone: of('phone'), keywords: of('keywords') }
}

/** 調査メモのテキストから、候補タイトルに関係しそうな行を抜粋する（表示用スニペット。決定的） */
function snippetFor(text: string, title: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const tokens = title.split(/[\s・|:：、。()（）「」-]+/).filter(t => [...t].length >= 3)
  const hit = lines.find(l => tokens.some(t => l.includes(t)))
  return capCodePoints((hit ?? lines[0] ?? '').replace(/^[-*・#\s]+/, ''), 160)
}

/**
 * LLM による候補収集（Google 検索グラウンディング）。出典（groundingChunks）を候補リストへ写像し、
 * 抜粋は調査メモ本文から関係行を切り出す。失敗・出典なしは null（呼び出し側でヒューリスティックへ = 原則4）
 */
async function llmResearchCandidates(
  env: Env, companyName: string, hints: CustomerResearchHints,
): Promise<CustomerResearchCandidate[] | null> {
  const hintText = [
    hints.address ? `所在地: ${hints.address}` : '',
    hints.phone ? `電話番号: ${hints.phone}` : '',
    hints.keywords ? `キーワード: ${hints.keywords}` : '',
  ].filter(Boolean).join(' / ')
  const research = await generateGroundedText(env, {
    system: 'あなたは企業リサーチアシスタントです。Google 検索で対象企業の公式サイト・会社情報・報道記事を探し、'
      + '見つかった事実のみを日本語の箇条書きでまとめます。推測や創作をしないこと。'
      + '同名の別企業と混同しないよう、ヒント（所在地・電話番号等）との一致を必ず確認すること。',
    prompt: `対象企業「${companyName}」のホームページ・会社情報・関連記事を調査し、`
      + `ビジョン（理念）・経営課題・事業の近況がわかる要点をまとめてください。`
      + (hintText ? `\nヒント: ${hintText}` : ''),
    maxTokens: 2048,
  })
  if (!research || research.sources.length === 0) return null
  return research.sources.slice(0, SOURCES_MAX).map(s => ({
    title: capCodePoints(s.title, 300),
    uri: capCodePoints(s.uri, 2000),
    snippet: snippetFor(research.text, s.title),
  }))
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    vision: { type: 'string' },
    challenges: { type: 'string' },
    strategyNotes: { type: 'string' },
    businessNotes: { type: 'string' },
  },
  required: ['vision', 'challenges', 'strategyNotes', 'businessNotes'],
}

/** LLM による定性情報の構築（採用ソース → 提案値）。失敗・全項目空は null（ヒューリスティックへ = 原則4） */
async function llmContextBuild(
  env: Env,
  companyName: string,
  sources: CustomerContextResearchSource[],
  current: CustomerContextInput,
): Promise<CustomerContextInput | null> {
  const raw = await generateJson<{ vision?: unknown; challenges?: unknown; strategyNotes?: unknown; businessNotes?: unknown }>(env, {
    system: 'あなたは企業リサーチアシスタントです。採用された Web 情報源に基づき、対象企業の'
      + '「ビジョン（vision）」「経営課題（challenges = 改行区切りの箇条書き）」「補足メモ（strategyNotes）」'
      + '「事業メモ（businessNotes = 昨季売上高・社員数・店舗数・配送センター〔自社/他社・地域〕等の'
      + '事業に関する事実。改行区切りの箇条書き。該当情報が情報源になければ空文字）」を'
      + '日本語で構築します。情報源にある事実のみを根拠にし、推測で事実（数値含む）を作らないこと。'
      + '現在の登録値がある場合は、情報源で裏付けられる内容を優先しつつ有用な既存記述を残すこと。'
      + 'strategyNotes の末尾に参考にした情報源のタイトルを記載すること。',
    prompt: `# 対象企業\n${companyName}\n\n# 採用された情報源\n`
      + sources.map(s => `- ${s.title}: ${s.uri}`).join('\n')
      + `\n\n# 現在の登録値\n${JSON.stringify(current, null, 1)}`,
    schema: BUILD_SCHEMA,
    maxTokens: 2048,
  })
  if (!raw) return null
  const built = normalizeCustomerContext({
    vision: String(raw.vision ?? ''),
    challenges: String(raw.challenges ?? ''),
    strategyNotes: String(raw.strategyNotes ?? ''),
    businessNotes: String(raw.businessNotes ?? ''),
  })
  if (!built.vision && !built.challenges && !built.strategyNotes && !built.businessNotes) return null
  return built
}

export function customerContextsRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // 一覧（全量 GET = useApi の CUSTOM_COLLECTION_ENDPOINTS ハイドレーション互換。1社1行のため件数は顧客数上限）
  app.get('/', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'customer_contexts cc LEFT JOIN companies co ON co.id = cc.company_id',
      cols: CTX_COLS,
      orderBy: 'cc.updated_at DESC, cc.id DESC',
      maxLimit: 1000,
      defaultLimit: 20,
      searchCols: ['co.name', 'cc.vision', 'cc.challenges', 'cc.strategy_notes', 'cc.business_notes'],
      filterCols: {
        companyId: { col: 'cc.company_id', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  // メモ一覧（全量 GET = ハイドレーション互換。/:companyId より先に登録して静的パスを確定させる）
  app.get('/notes', async (c) => {
    const res = await runListQuery(pool, c, {
      table: 'customer_context_notes cn',
      cols: NOTE_COLS,
      orderBy: 'cn.created_at DESC, cn.id DESC',
      maxLimit: 2000,
      defaultLimit: 20,
      searchCols: ['cn.body', 'cn.member_name'],
      filterCols: {
        companyId: { col: 'cn.company_id', kind: 'eq' },
        kind: { col: 'cn.kind', kind: 'enum' },
        active: { col: '(cn.archived_at IS NULL)::text', kind: 'eq' },
      },
    })
    return c.json(res)
  })

  // 単件取得（会社単位。未登録は data: null = クライアントは「登録」導線を出す）
  app.get('/:companyId', async (c) => {
    const companyId = c.req.param('companyId')
    await findCompany(pool, companyId)
    const { rows } = await pool.query(
      `SELECT ${CTX_COLS} FROM customer_contexts cc WHERE cc.company_id = $1`, [companyId])
    return c.json({ data: rows[0] ?? null })
  })

  // 定性情報の upsert（設定系 = 全員が上書き更新可。部分更新 = 送られたキーのみ反映〔Object.hasOwn〕→
  // マージ後に shared 検証。送っていない項目は既存値を保持する = CLAUDE.md 部分更新原則）
  app.put('/:companyId', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    await findCompany(pool, companyId)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const cur = await currentContextOf(pool, companyId)
    const has = (k: string): boolean => Object.hasOwn(b, k)
    const merged = normalizeCustomerContext({
      vision: has('vision') ? String(b.vision ?? '') : cur.vision,
      challenges: has('challenges') ? String(b.challenges ?? '') : cur.challenges,
      strategyNotes: has('strategyNotes') ? String(b.strategyNotes ?? '') : cur.strategyNotes,
      // 事業メモ（改修依頼 2026-08-21）。旧クライアント（未送信）は既存値を保持（部分更新の鉄則 = 原則7）
      businessNotes: has('businessNotes') ? String(b.businessNotes ?? '') : cur.businessNotes,
    })
    assertValid(customerContextError(merged))
    await upsertContext(pool, companyId, merged, { memberId: user.id, name: await memberNameOf(pool, user.id) })
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'customer_contexts', entityId: companyId,
      detail: '顧客コンテキスト（定性情報）を更新',
    })
    const { rows } = await pool.query(
      `SELECT ${CTX_COLS} FROM customer_contexts cc WHERE cc.company_id = $1`, [companyId])
    return c.json({ data: rows[0] })
  })

  // メモの追記（記録系。kind は 'note' 固定 = research ノートは反映フローのみが自動追記する）
  app.post('/:companyId/notes', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    await findCompany(pool, companyId)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const body = capCodePoints(String(b.body ?? '').trim(), NOTE_CAP)
    assertValid(customerContextNoteError(body))
    const id = newId('cnote')
    await pool.query(
      `INSERT INTO customer_context_notes (id, company_id, member_id, member_name, kind, body)
       VALUES ($1, $2, $3, $4, 'note', $5)`,
      [id, companyId, user.id, await memberNameOf(pool, user.id), body])
    await audit(pool, {
      actorId: user.id, action: 'create', entity: 'customer_context_notes', entityId: id,
      detail: '顧客コンテキストのメモを追記',
    })
    const { rows } = await pool.query(`SELECT ${NOTE_COLS} FROM customer_context_notes cn WHERE cn.id = $1`, [id])
    return c.json({ data: rows[0] }, 201)
  })

  // メモの取消/復元（論理取消 = archived_at。全員可・冪等: 条件付き UPDATE で同時実行でも監査ログは 1 回だけ）
  app.post('/:companyId/notes/:noteId/archive', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    const noteId = c.req.param('noteId')
    await findNote(pool, companyId, noteId)
    const upd = await pool.query(
      `UPDATE customer_context_notes SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [noteId])
    if (upd.rowCount === 0) return c.json({ data: { id: noteId, warning: 'すでに取消済みです' } })
    await audit(pool, { actorId: user.id, action: 'archive', entity: 'customer_context_notes', entityId: noteId, detail: '顧客コンテキストのメモを取消' })
    return c.json({ data: { id: noteId } })
  })

  app.post('/:companyId/notes/:noteId/restore', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    const noteId = c.req.param('noteId')
    await findNote(pool, companyId, noteId)
    const upd = await pool.query(
      `UPDATE customer_context_notes SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL`, [noteId])
    if (upd.rowCount === 0) return c.json({ data: { id: noteId, warning: '取消されていません' } })
    await audit(pool, { actorId: user.id, action: 'restore', entity: 'customer_context_notes', entityId: noteId, detail: '顧客コンテキストのメモを復元' })
    return c.json({ data: { id: noteId } })
  })

  // ---------- AI リサーチ（Web 調査 → 構築 → 反映 → 取消の 4 段） ----------

  // ① 調査: 社名（自動）+ ヒント（住所/電話/キーワード）から候補リストを収集する。
  // LLM 無効・失敗は決定的ヒューリスティック（example.com のデモ候補）へフォールバック（原則4）
  app.post('/:companyId/research', async (c) => {
    const companyId = c.req.param('companyId')
    const company = await findCompany(pool, companyId)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const hints = cleanHints(b)
    const llm = await llmResearchCandidates(env, company.name, hints)
    const candidates = llm ?? heuristicResearchCandidates(company.name, hints)
    return c.json({ data: { candidates, llm: llm !== null } })
  })

  // ② 構築: 採用された候補から定性情報の提案値を構築する（反映はしない = 差分確認は UI）。
  // LLM 無効・失敗は決定的ヒューリスティックへフォールバック（原則4）
  app.post('/:companyId/research/build', async (c) => {
    const companyId = c.req.param('companyId')
    const company = await findCompany(pool, companyId)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sources = cleanSources(b.sources)
    assertValid(customerContextSourcesError(sources))
    const current = await currentContextOf(pool, companyId)
    const llm = await llmContextBuild(env, company.name, sources, current)
    const proposal = llm ?? heuristicContextBuild(company.name, sources, current)
    return c.json({ data: { proposal, llm: llm !== null } })
  })

  // ③ 反映: 定性情報の upsert + research ノートの自動追記（採用ソース + 反映前の値 = payload.before）を
  // 同一トランザクションで行う（ノートだけ欠けた「復元できない反映」を作らない = 原則6/9.5）
  app.post('/:companyId/research/apply', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    const company = await findCompany(pool, companyId)
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>
    const sources = cleanSources(b.sources)
    assertValid(customerContextSourcesError(sources))
    const values = normalizeCustomerContext({
      vision: String(b.vision ?? ''),
      challenges: String(b.challenges ?? ''),
      strategyNotes: String(b.strategyNotes ?? ''),
      businessNotes: String(b.businessNotes ?? ''),
    })
    assertValid(customerContextError(values))
    const noteId = newId('cnote')
    const actorName = await memberNameOf(pool, user.id)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await currentContextOf(client, companyId)
      const payload: CustomerContextNotePayload = { sources, before }
      await upsertContext(client, companyId, values, { memberId: user.id, name: actorName })
      await client.query(
        `INSERT INTO customer_context_notes (id, company_id, member_id, member_name, kind, body, payload)
         VALUES ($1, $2, $3, $4, 'research', $5, $6)`,
        [noteId, companyId, user.id, actorName,
          `AI リサーチの結果を反映（採用 ${sources.length} 件: ${sources.map(s => s.title).join(' / ')}）`,
          JSON.stringify(payload)])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'customer_contexts', entityId: companyId,
      detail: `AI リサーチを反映（${company.name}・採用 ${sources.length} 件。取消は research ノートから）`,
    })
    const { rows: ctxRows } = await pool.query(
      `SELECT ${CTX_COLS} FROM customer_contexts cc WHERE cc.company_id = $1`, [companyId])
    const { rows: noteRows } = await pool.query(
      `SELECT ${NOTE_COLS} FROM customer_context_notes cn WHERE cn.id = $1`, [noteId])
    return c.json({ data: { context: ctxRows[0], note: noteRows[0], id: noteId } }, 201)
  })

  // ④ 反映の取消: research ノートの payload.before から定性情報を復元する（原則9.5）。
  // ノートは archive せず payload.revertedAt を追記する（復元も監査可能に残す）。二重取消は警告 no-op（冪等）
  app.post('/:companyId/research/:noteId/revert', async (c) => {
    const user = c.get('user')
    const companyId = c.req.param('companyId')
    const noteId = c.req.param('noteId')
    await findCompany(pool, companyId)
    const note = await findNote(pool, companyId, noteId)
    if (note.kind !== 'research' || !note.payload?.before) {
      throw err('AKO-CTX-004', 'このメモには復元できる反映前の情報がありません', 400)
    }
    if (note.payload.revertedAt) {
      return c.json({ data: { id: noteId, warning: 'すでに取消済みです' } })
    }
    const actorName = await memberNameOf(pool, user.id)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // 事業メモ（2026-08-21 追加）が無い旧スナップショットの復元は現在値を保持する
      // （旧ノートの取消で新項目を消さない = 原則7。現在値の読取は Tx 内 = 復元と原子的）
      const cur = await currentContextOf(client, companyId)
      const before = normalizeCustomerContext({
        vision: String(note.payload.before.vision ?? ''),
        challenges: String(note.payload.before.challenges ?? ''),
        strategyNotes: String(note.payload.before.strategyNotes ?? ''),
        businessNotes: note.payload.before.businessNotes === undefined
          ? cur.businessNotes
          : String(note.payload.before.businessNotes ?? ''),
      })
      // 反映前が全項目空（新規作成の反映だった）の場合も「空へ戻す」= 復元として upsert する
      // （行の物理削除はしない = 監査・再反映の起点を残す設計判断）
      await upsertContext(client, companyId, before, { memberId: user.id, name: actorName })
      await client.query(
        `UPDATE customer_context_notes
         SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('revertedAt', to_char(now() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"'))
         WHERE id = $1`, [noteId])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    await audit(pool, {
      actorId: user.id, action: 'update', entity: 'customer_contexts', entityId: companyId,
      detail: 'AI リサーチの反映を取り消し（反映前の値へ復元）',
    })
    const { rows } = await pool.query(
      `SELECT ${CTX_COLS} FROM customer_contexts cc WHERE cc.company_id = $1`, [companyId])
    return c.json({ data: { id: noteId, context: rows[0] } })
  })

  return app
}
