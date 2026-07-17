/**
 * チャットボット応答 API（F-09-3）。mockup useChatbot の LLM 一次応答レイヤ。
 * - 一次応答: Vertex AI（構造化出力）。サーバーで本人の勤怠・有給・顧客・ナレッジを文脈化して回答
 * - セッション管理（オペレーター指示 2026-07-17）: 会話は chat_sessions / chat_messages（DB）が SoT。
 *   同一セッション内は直近履歴を LLM へ渡すマルチターン。過去セッションの再開・新規開始に対応。
 *   セッションは本人のみ参照可（C3）。メッセージは追記のみ（記録系保護 = 原則2）
 * - フォールバック: LLM 無効・失敗・低確信度は { fallback: true, sessionId } を返し、クライアントが
 *   既存の決定的ルーティング応答（移行済みドメインは API モードでも実データ参照）へ縮退し、
 *   その応答を POST /sessions/:id/messages で追記する（履歴の忠実性）（原則4）
 * - 未移行ドメイン（ドキュメント・稼働状況）の質問は文脈に含めず、クライアント側の
 *   モック応答が引き続き担う（implementation-status の SoT どおり）
 * エラー: AKO-CHT-001（セッションが見つからない・他人のセッション）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { nowJstIso } from '../../../shared/domain/jst'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { balanceOf, PAID_LEAVE_TYPE_ID } from './leave'

interface ChatAnswer {
  content: string
  sources: string[]
  suggestions: string[]
  confidence: number
}

/** コードポイント単位の切詰め（サロゲートペアを境界で壊さない） */
function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}

const MESSAGE_COLS = `id, session_id AS "sessionId", role, content, sources, suggestions, at`
/** マルチターン文脈に含める直近メッセージ数と 1 件あたりの上限（トークン量の抑制） */
const HISTORY_LIMIT = 12
const HISTORY_MSG_CAP = 500

/** セッションの本人所有チェック（なし・他人は AKO-CHT-001。存在を漏らさない = 404 に統一） */
async function requireOwnSession(pool: pg.Pool, sessionId: string, memberId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_sessions WHERE id = $1 AND member_id = $2`, [sessionId, memberId])
  if (rows.length === 0) throw err('AKO-CHT-001', 'チャットセッションが見つかりません', 404)
}

/** 質問に関連しそうな社内文脈を収集する（本人スコープのデータ + 共有マスタの要約） */
async function buildContext(pool: pg.Pool, memberId: string, question: string): Promise<string> {
  const parts: string[] = []
  const q = question.toLowerCase()

  // 有給・勤怠（本人分のみ = C3 保護。他人の数値は文脈に入れない）
  // 残数は leave ドメインの SoT 計算（FIFO 引当・失効・保有上限）を再利用する（原則3）
  if (/有給|休暇|残業|勤怠|労働/.test(question)) {
    const b = await balanceOf(pool, memberId, PAID_LEAVE_TYPE_ID)
    parts.push(`## 本人の有給（法定有給。詳細は /attendance の有給タブ）
残数 ${b.remaining} 日 / 今年度の消化 ${b.usedThisFiscalYear} 日${
  b.nextExpire ? ` / 直近の失効 ${b.nextExpire.date}（${b.nextExpire.days} 日）` : ''}`)
  }

  // 顧客（名前一致時のみ概要 + 関連ナレッジ。ORDER BY で照合対象を決定的にする）
  const { rows: companies } = await pool.query<{
    id: string; name: string; aliases: string[]; description: string; location: string; size: string
  }>(
    `SELECT id, name, aliases, description, location, size FROM companies
     WHERE kind = 'customer' AND active = true ORDER BY id LIMIT 100`)
  const company = companies.find(c => [c.name, ...c.aliases].some(n => n && q.includes(n.toLowerCase())))
  if (company) {
    const { rows: ks } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND domain = 'company' AND target_id = $1 LIMIT 3`, [company.id])
    const { rows: pjs } = await pool.query<{ name: string; status: string }>(
      `SELECT name, status FROM projects WHERE active = true AND company_id = $1 LIMIT 5`, [company.id])
    parts.push(`## 顧客「${company.name}」
${company.description}（${company.location}・規模 ${company.size}）
プロジェクト: ${pjs.map(p => `${p.name}（${p.status}）`).join(' / ') || 'なし'}
${ks.map(k => `ナレッジ「${k.title}」(${k.id}): ${[...k.body].slice(0, 200).join('')}`).join('\n')}`)
  }

  // ナレッジ全文検索（タイトル・本文の部分一致。上位 3 件。% _ はリテラル扱いにエスケープ）
  const terms = question.replace(/[？?。、！!]/g, ' ').split(/\s+/).filter(t => t.length >= 2).slice(0, 5)
  if (terms.length > 0) {
    const { rows: hits } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND (${terms.map((_, i) => `title ILIKE $${i + 1} ESCAPE '\\' OR body ILIKE $${i + 1} ESCAPE '\\'`).join(' OR ')})
       ORDER BY id LIMIT 3`,
      terms.map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`))
    if (hits.length > 0) {
      parts.push(`## 関連ナレッジ\n${hits.map(k => `「${k.title}」(${k.id}): ${[...k.body].slice(0, 200).join('')}`).join('\n')}`)
    }
  }

  // 静的ガイド（稟議・申請）
  if (/稟議|申請|承認|ワークフロー/.test(question)) {
    parts.push(`## 稟議・申請ガイド
/workflow の「新規申請」から区分（購買・契約・経費・採用・出張・その他）と金額・内容を入力。
区分×金額帯で承認経路（マネージャー→取締役→社長など）が自動設定され、承認者へ通知される。差戻し時は修正して再申請可能。`)
  }
  return parts.join('\n\n')
}

export function chatbotRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // セッション一覧（本人のみ・新しい順）
  app.get('/sessions', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query(
      `SELECT s.id, s.title, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM chat_messages m WHERE m.session_id = s.id) AS "messageCount"
       FROM chat_sessions s WHERE s.member_id = $1
       ORDER BY s.updated_at DESC LIMIT 100`, [user.id])
    return c.json({ data: rows })
  })

  // セッションのメッセージ一覧（本人のみ・古い順 = 会話の再開用）
  app.get('/sessions/:id/messages', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('id')
    await requireOwnSession(pool, sessionId, user.id)
    const { rows } = await pool.query(
      `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE session_id = $1 ORDER BY seq LIMIT 500`,
      [sessionId])
    return c.json({ data: rows })
  })

  // フォールバック応答（クライアントの決定的ルーティング結果）の追記（本人のみ・履歴の忠実性のため）
  app.post('/sessions/:id/messages', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('id')
    await requireOwnSession(pool, sessionId, user.id)
    const body = await c.req.json().catch(() => ({})) as {
      content?: string; sources?: unknown; suggestions?: unknown
    }
    const content = capCp(String(body.content ?? '').trim(), 4000)
    if (!content) throw err('AKO-GEN-001', 'content を指定してください', 400)
    const id = newId('cm')
    await pool.query(
      `INSERT INTO chat_messages (id, session_id, role, content, sources, suggestions, at)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6)`,
      [id, sessionId, content,
        JSON.stringify((Array.isArray(body.sources) ? body.sources.map(String) : []).slice(0, 5)),
        JSON.stringify((Array.isArray(body.suggestions) ? body.suggestions.map(String) : []).slice(0, 3)),
        nowJstIso()])
    await pool.query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [sessionId])
    return c.json({ data: { id } }, 201)
  })

  // 質問応答（本人文脈 + セッション履歴のマルチターン。LLM 無効・失敗・低確信度は
  // fallback: true = クライアントの決定的応答へ。sessionId 未指定は新規セッションを開始する）
  app.post('/ask', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { question?: string; sessionId?: string }
    // 2000 字上限（コードポイント単位 = サロゲートペアを境界で壊さない）
    const question = capCp(String(body.question ?? '').trim(), 2000)
    if (!question) throw err('AKO-GEN-001', 'question を指定してください', 400)

    // セッションの解決（指定 = 本人所有チェック / 未指定 = 新規開始。タイトルは最初の質問から）
    let sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
    if (sessionId) {
      await requireOwnSession(pool, sessionId, user.id)
    } else {
      sessionId = newId('cs')
      await pool.query(
        `INSERT INTO chat_sessions (id, member_id, title) VALUES ($1, $2, $3)`,
        [sessionId, user.id, capCp(question, 40)])
    }

    // マルチターン文脈: 今回の質問より前の直近履歴（挿入前に読む）
    const { rows: history } = await pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM chat_messages WHERE session_id = $1
       ORDER BY seq DESC LIMIT ${HISTORY_LIMIT}`, [sessionId])
    history.reverse()

    // ユーザー発言の永続化（記録系 = 追記のみ）+ セッションの最終更新
    await pool.query(
      `INSERT INTO chat_messages (id, session_id, role, content, sources, suggestions, at)
       VALUES ($1, $2, 'user', $3, '[]', '[]', $4)`,
      [newId('cm'), sessionId, question, nowJstIso()])
    await pool.query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [sessionId])

    if (!env.vertexProjectId) return c.json({ data: { fallback: true, sessionId } })

    const historyText = history
      .map(m => `${m.role === 'user' ? '質問者' : 'アシスタント'}: ${capCp(m.content, HISTORY_MSG_CAP)}`)
      .join('\n')
    const context = await buildContext(pool, user.id, question)
    const res = await generateJson<ChatAnswer>(env, {
      system: 'あなたは社内業務アシスタント（AKEBONO Office のチャットボット）です。与えられた社内文脈だけを'
        + '根拠に、日本語の丁寧語で簡潔に回答します。文脈にない事実は述べず、その場合は confidence を低くして'
        + '「わからない」と伝えてください。会話履歴がある場合は文脈を引き継いで回答します'
        + '（「それ」「さっきの」等の指示語は履歴から解決）。sources は使用した文脈の見出し'
        + '（例: 本人の有給・顧客「◯◯」・ナレッジ タイトル）、suggestions は関連する次の質問を 2 件、'
        + 'confidence は回答の確信度 0-1。'
        + '画面パス（/attendance /workflow /reports 等）への案内は文脈にあるもののみ使用。',
      prompt: `質問者: ${user.name}\n`
        + (historyText ? `\n# 会話履歴（直近）\n${historyText}\n` : '')
        + `\n質問: ${question}\n\n# 社内文脈\n${context || '（関連する文脈なし）'}`,
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          suggestions: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['content', 'sources', 'suggestions', 'confidence'],
      },
      maxTokens: 1024,
    })
    // 低確信度・空応答はクライアントの決定的ルーティングへ（誤答よりフォールバックを優先）。
    // confidence 欠落/非数値（NaN）も「確信あり」に倒さずフォールバック側へ
    if (!res || !res.content || !(Number(res.confidence) >= 0.4)) {
      return c.json({ data: { fallback: true, sessionId } })
    }
    const content = capCp(String(res.content), 4000)
    const sources = (Array.isArray(res.sources) ? res.sources.map(String) : []).slice(0, 5)
    const suggestions = (Array.isArray(res.suggestions) ? res.suggestions.map(String) : []).slice(0, 3)
    // LLM 応答の永続化（失敗しても応答自体は返す = 非ブロッキング。次回 GET で欠けは見えるが会話は継続可能）
    try {
      await pool.query(
        `INSERT INTO chat_messages (id, session_id, role, content, sources, suggestions, at)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6)`,
        [newId('cm'), sessionId, content, JSON.stringify(sources), JSON.stringify(suggestions), nowJstIso()])
      await pool.query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [sessionId])
    } catch (e) {
      console.warn('chat message persist failed (non-blocking):', (e as Error).message)
    }
    return c.json({ data: { fallback: false, content, sources, suggestions, sessionId } })
  })

  return app
}
