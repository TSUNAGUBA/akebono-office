/**
 * チャットボット応答 API（F-09-3）。mockup useChatbot の LLM 一次応答レイヤ。
 * - 一次応答: Vertex AI（構造化出力）。サーバーで本人の勤怠・有給・顧客・ナレッジを文脈化して回答
 * - フォールバック: LLM 無効・失敗・低確信度は { fallback: true } を返し、クライアントが
 *   既存の決定的ルーティング応答（移行済みドメインは API モードでも実データ参照）へ縮退する（原則4）
 * - 会話履歴はクライアント保持（業務記録ではなくセッションローカルという設計判断。docs 参照）
 * - 未移行ドメイン（ドキュメント・稼働状況）の質問は文脈に含めず、クライアント側の
 *   モック応答が引き続き担う（implementation-status の SoT どおり）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { generateJson } from '../lib/llm'
import { balanceOf, PAID_LEAVE_TYPE_ID } from './leave'

interface ChatAnswer {
  content: string
  sources: string[]
  suggestions: string[]
  confidence: number
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
${ks.map(k => `ナレッジ「${k.title}」(${k.id}): ${k.body.slice(0, 200)}`).join('\n')}`)
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
      parts.push(`## 関連ナレッジ\n${hits.map(k => `「${k.title}」(${k.id}): ${k.body.slice(0, 200)}`).join('\n')}`)
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

  // 質問応答（本人文脈。LLM 無効・失敗・低確信度は fallback: true = クライアントの決定的応答へ）
  app.post('/ask', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { question?: string }
    // 2000 字上限（コードポイント単位 = サロゲートペアを境界で壊さない）
    const question = [...String(body.question ?? '').trim()].slice(0, 2000).join('')
    if (!question) throw err('AKO-GEN-001', 'question を指定してください', 400)
    if (!env.vertexProjectId) return c.json({ data: { fallback: true } })

    const context = await buildContext(pool, user.id, question)
    const res = await generateJson<ChatAnswer>(env, {
      system: 'あなたは社内業務アシスタント（AKEBONO Office のチャットボット）です。与えられた社内文脈だけを'
        + '根拠に、日本語の丁寧語で簡潔に回答します。文脈にない事実は述べず、その場合は confidence を低くして'
        + '「わからない」と伝えてください。sources は使用した文脈の見出し（例: 本人の有給・顧客「◯◯」・'
        + 'ナレッジ タイトル）、suggestions は関連する次の質問を 2 件、confidence は回答の確信度 0-1。'
        + '画面パス（/attendance /workflow /reports 等）への案内は文脈にあるもののみ使用。',
      prompt: `質問者: ${user.name}\n質問: ${question}\n\n# 社内文脈\n${context || '（関連する文脈なし）'}`,
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
      return c.json({ data: { fallback: true } })
    }
    return c.json({
      data: {
        fallback: false,
        content: [...String(res.content)].slice(0, 4000).join(''),
        sources: (Array.isArray(res.sources) ? res.sources.map(String) : []).slice(0, 5),
        suggestions: (Array.isArray(res.suggestions) ? res.suggestions.map(String) : []).slice(0, 3),
      },
    })
  })

  return app
}
