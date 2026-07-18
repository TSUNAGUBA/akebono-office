/**
 * チャットボット応答 API（F-09-2）。mockup useChatbot の LLM 一次応答レイヤ。
 * - 一次応答: Vertex AI（構造化出力）。サーバーが DB の全移行済みドメイン
 *   （勤怠・有給・日報・ワークフロー・シフト・意思決定・タスク計画・カレンダー・エスカレーション・
 *   メンバー/部署・顧客・プロジェクト・ナレッジ・AI カンパニー・売上・稼働状況・AKEBONO）を文脈化して回答
 *   （バッチ5d/6a/6b/6c/6d・オペレーター指示 2026-07-17）
 * - 参照範囲は権限（F-16）に従う: ドメインごとに canUseFeature で文脈生成の可否を判定し、
 *   マスタ由来の文脈は stripDeniedFields で表示項目レベルの deny を反映する（5c の共有ロジックを再利用）
 * - 本人スコープ（C3）は維持: 勤怠・有給・シフト・タスク計画・カレンダー・エスカレーションは本人分のみ。
 *   他メンバーの日報は「提出済みのみ」（全員の日報タブ = scope=all と同じ基準）
 * - セッション管理（オペレーター指示 2026-07-17）: 会話は chat_sessions / chat_messages（DB）が SoT。
 *   同一セッション内は直近履歴を LLM へ渡すマルチターン。過去セッションの再開・新規開始に対応。
 *   セッションは本人のみ参照可（C3）。メッセージは追記のみ（記録系保護 = 原則2）
 * - フォールバック: LLM 無効・失敗・低確信度は { fallback: true, sessionId } を返し、クライアントが
 *   既存の決定的ルーティング応答（移行済みドメインは API モードでも実データ参照）へ縮退し、
 *   その応答を POST /sessions/:id/messages で追記する（履歴の忠実性）（原則4）
 * - 未移行ドメイン（ドキュメント）の質問は文脈に含めず、クライアント側のモック応答が
 *   引き続き担う（implementation-status の SoT どおり。売上 = 6b・稼働状況 = 6c で移行済み = 文脈対象）
 * エラー: AKO-CHT-001（セッションが見つからない・他人のセッション）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { fiscalMonthsOf, fiscalYearOf } from '../../../shared/domain/fiscal'
import { nowJstIso, todayJst } from '../../../shared/domain/jst'
import { canUseFeature, stripDeniedFields } from '../../../shared/domain/permissions'
import type { PermissionRule, PunchRecord, ReportEntry } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import { daySummary } from '../domain/attendance'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { capCp } from '../lib/text'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { balanceOf, PAID_LEAVE_TYPE_ID } from './leave'
import { selfFiscalStartMonth } from './sales'

interface ChatAnswer {
  content: string
  sources: string[]
  suggestions: string[]
  confidence: number
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

/** エントリ要約（業務テーマ → 旧 projectId データは task で代替。表示 3 件まで） */
function entriesSummary(entries: unknown): string {
  if (!Array.isArray(entries)) return ''
  return (entries as ReportEntry[]).slice(0, 3).map(e => e.theme || e.task).filter(Boolean).join(' / ')
}

/**
 * 質問に関連しそうな社内文脈を収集する（バッチ5d: DB の全移行済みドメイン）。
 * - ドメインごとに権限（F-16 canUseFeature）で生成可否を判定 = チャットボットの参照範囲も権限に従う
 * - マスタ由来の文脈は stripDeniedFields で表示項目 deny を反映
 * - 本人スコープ（C3）維持。他メンバーの日報は提出済みのみ（scope=all と同じ基準）
 * - ブロック単位の収集失敗は全体を止めない（原則4 = 部分的な文脈でも回答を試みる）
 */
export async function buildContext(
  pool: pg.Pool,
  user: AuthUser,
  question: string,
  rules: PermissionRule[],
): Promise<string> {
  const parts: string[] = []
  const q = question.toLowerCase()
  const subject = subjectOf(user)
  const can = (feature: string): boolean => canUseFeature(rules, subject, feature)
  const strip = <T extends Record<string, unknown>>(entity: string, rows: T[]): T[] =>
    stripDeniedFields(rules, subject, entity, rows)
  const today = todayJst()
  const block = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      console.warn('chat context block failed (non-blocking):', (e as Error).message)
    }
  }

  // 質問に含まれる人名の照合（フルネーム・空白除去・「◯◯さん/氏」形の名前パーツ。ORDER BY id で決定的）。
  // パーツ単独の照合は敬称付きに限定する（「勤怠管理」→ メンバー「管理 太郎」のような一般語との偽ヒット防止）
  const nameHit = (name: string): boolean =>
    !!name && (question.includes(name) || question.includes(name.replace(/\s+/g, ''))
      || name.split(/\s+/).some(p =>
        p.length >= 2 && (question.includes(`${p}さん`) || question.includes(`${p}氏`))))

  // 有給・当月勤怠（本人分のみ = C3 保護。残数は leave ドメインの SoT 計算を再利用 = 原則3）
  if (can('attendance') && /有給|休暇|残業|勤怠|労働|打刻/.test(question)) {
    await block(async () => {
      const b = await balanceOf(pool, user.id, PAID_LEAVE_TYPE_ID)
      parts.push(`## 本人の有給（法定有給。詳細は /attendance の有給タブ）
残数 ${b.remaining} 日 / 今年度の消化 ${b.usedThisFiscalYear} 日${
  b.nextExpire ? ` / 直近の失効 ${b.nextExpire.date}（${b.nextExpire.days} 日）` : ''}`)
    })
    await block(async () => {
      const { rows } = await pool.query<PunchRecord>(
        `SELECT id, member_id AS "memberId", date::text AS date, kind, at, source,
                fixed_from AS "fixedFrom", fix_reason AS "fixReason", approved_by AS "approvedBy"
         FROM punch_records WHERE member_id = $1 AND to_char(date, 'YYYY-MM') = $2 ORDER BY at`,
        [user.id, today.slice(0, 7)])
      if (rows.length === 0) return
      const byDate = new Map<string, PunchRecord[]>()
      for (const r of rows) {
        const list = byDate.get(r.date) ?? []
        list.push(r)
        byDate.set(r.date, list)
      }
      let work = 0
      for (const [d, recs] of byDate) work += daySummary(recs, undefined, d).workMinutes
      parts.push(`## 本人の当月勤怠（${today.slice(0, 7)}）
出勤 ${byDate.size} 日 / 総労働 ${Math.round(work / 6) / 10} 時間`)
    })
  }

  // 本人の日報（下書き含む = 本人スコープ）
  if (can('reports') && /日報|週報|振り返り|所感|提出/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ date: string; entries: unknown; issues: string; status: string }>(
        `SELECT date::text AS date, entries, issues, status FROM daily_reports
         WHERE author_kind = 'human' AND member_id = $1 ORDER BY date DESC LIMIT 5`, [user.id])
      if (rows.length === 0) return
      parts.push(`## 本人の直近の日報\n${rows.map(r =>
        `- ${r.date} [${r.status === 'submitted' ? '提出済' : '下書き'}] ${entriesSummary(r.entries) || '—'}${r.issues ? '・課題あり' : ''}`).join('\n')}`)
    })
  }

  // メンバー照合（ディレクトリ情報 + そのメンバーの提出済み日報。表示項目 deny を反映）
  await block(async () => {
    const { rows: memberRows } = await pool.query<Record<string, unknown> & { id: string; name: string }>(
      `SELECT id, name, title, role, email, employment_type AS "employmentType", department_id AS "departmentId"
       FROM members WHERE active = true ORDER BY id LIMIT 300`)
    const matched = memberRows.find(m => nameHit(m.name))
    if (!matched) return
    // 見出しにも剥がし後の値を使う（name の field deny 時は本人を特定できないためブロックごと出さない）
    const [m] = strip('members', [matched])
    if (!m?.name) return
    const displayName = String(m.name)
    let deptName = ''
    if (m.departmentId) {
      const { rows: deps } = await pool.query<{ name: string }>(
        `SELECT name FROM departments WHERE id = $1`, [String(m.departmentId)])
      deptName = deps[0]?.name ?? ''
    }
    parts.push(`## メンバー「${displayName}」
部署 ${deptName || '未所属'} / 役職 ${String(m.title ?? '') || 'なし'}${m.email ? ` / メール ${String(m.email)}` : ''}`)
    // 他メンバーの日報は提出済みのみ（全員の日報タブ = scope=all と同じ基準）
    if (can('reports') && matched.id !== user.id) {
      const { rows } = await pool.query<{ date: string; entries: unknown; issues: string }>(
        `SELECT date::text AS date, entries, issues FROM daily_reports
         WHERE author_kind = 'human' AND member_id = $1 AND status = 'submitted'
         ORDER BY date DESC LIMIT 3`, [matched.id])
      if (rows.length > 0) {
        parts.push(`## ${displayName} さんの日報（提出済みのみ）\n${rows.map(r =>
          `- ${r.date} ${entriesSummary(r.entries) || '—'}${r.issues ? '・課題あり' : ''}`).join('\n')}`)
      }
    }
  })

  // ワークフロー（本人の申請 + 静的ガイド）
  if (can('workflow') && /稟議|申請|承認|ワークフロー|決裁/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ id: string; title: string; status: string; amount: string }>(
        `SELECT id, title, status, amount::text AS amount FROM workflow_requests
         WHERE requester_id = $1 ORDER BY updated_at DESC LIMIT 5`, [user.id])
      if (rows.length > 0) {
        parts.push(`## 本人の稟議・申請\n${rows.map(w => `- ${w.id}「${capCp(w.title, 60)}」: ${w.status}（${w.amount} 円）`).join('\n')}`)
      }
    })
    parts.push(`## 稟議・申請ガイド
/workflow の「新規申請」から区分（購買・契約・経費・採用・出張・その他）と金額・内容を入力。
区分×金額帯で承認経路（マネージャー→取締役→社長など）が自動設定され、承認者へ通知される。差戻し時は修正して再申請可能。`)
  }

  // シフト（本人の今後の割当）
  if (can('shift') && /シフト|出勤/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ date: string; from: string; to: string; status: string }>(
        `SELECT date::text AS date, from_time AS "from", to_time AS "to", status FROM shift_assignments
         WHERE member_id = $1 AND date >= $2::date ORDER BY date LIMIT 7`, [user.id, today])
      if (rows.length > 0) {
        parts.push(`## 本人の今後のシフト\n${rows.map(s =>
          `- ${s.date} ${s.from}〜${s.to}（${s.status === 'confirmed' ? '確定' : s.status === 'change_requested' ? '変更依頼中' : '仮'}）`).join('\n')}`)
      }
    })
  }

  // 意思決定支援（テーマ一覧 + 直近の判断ログ）
  if (can('decision') && /意思決定|判断|テーマ|選択肢/.test(question)) {
    await block(async () => {
      const { rows: themes } = await pool.query<{ id: string; title: string; category: string }>(
        `SELECT id, title, category FROM decision_themes WHERE active = true ORDER BY id LIMIT 10`)
      const { rows: logs } = await pool.query<{ themeTitle: string; chosenSlot: string; reason: string; at: string }>(
        `SELECT t.title AS "themeTitle", l.chosen_slot AS "chosenSlot", l.reason, l.at
         FROM decision_logs l JOIN decision_themes t ON t.id = l.theme_id ORDER BY l.at DESC LIMIT 3`)
      if (themes.length === 0) return
      parts.push(`## 意思決定支援（/decision）
テーマ: ${themes.map(t => `「${t.title}」(${t.category === 'business' ? '事業' : 'PJ'})`).join(' / ')}${
  logs.length > 0 ? `\n直近の判断: ${logs.map(l => `「${l.themeTitle}」→ 案${l.chosenSlot}（${capCp(l.reason, 60)}）`).join(' / ')}` : ''}`)
    })
  }

  // タスク計画・当日予定（本人分のみ）
  if (can('ai-assistant') && /タスク|計画|予定|会議|ミーティング|カレンダー/.test(question)) {
    await block(async () => {
      const { rows: plans } = await pool.query<{ title: string; status: string; outcome: string }>(
        `SELECT title, status, outcome FROM task_plans
         WHERE member_id = $1 AND date = $2::date ORDER BY created_at LIMIT 10`, [user.id, today])
      const { rows: events } = await pool.query<{ from: string; to: string; title: string }>(
        `SELECT from_time AS "from", to_time AS "to", title FROM calendar_events
         WHERE member_id = $1 AND date = $2::date ORDER BY from_time LIMIT 10`, [user.id, today])
      const lines = [
        ...events.map(e => `- 予定 ${e.from}〜${e.to}「${capCp(e.title, 60)}」`),
        ...plans.map(p => `- タスク「${capCp(p.title, 60)}」: ${p.status === 'done' ? `完了（${capCp(p.outcome, 40)}）` : '計画中'}`),
      ]
      if (lines.length > 0) parts.push(`## 本人の本日の予定・タスク計画（${today}）\n${lines.join('\n')}`)
    })
  }

  // エスカレーション（本人が対象 かつ 本人の日報課題由来 = issue_reported のみ。
  // 他者起票（overload/stalled 等）の context は管理者向け内部メモを含み得るため、
  // GET /v1/escalations（管理者のみ）の可視性から逸脱しない範囲に限定する）
  if (/課題|エスカレ|困り/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ context: string; raisedAt: string }>(
        `SELECT context, raised_at AS "raisedAt" FROM escalations
         WHERE target_member_id = $1 AND status = 'open' AND reason = 'issue_reported'
         ORDER BY raised_at DESC LIMIT 3`, [user.id])
      if (rows.length > 0) {
        parts.push(`## 本人に関する対応中エスカレーション\n${rows.map(e => `- ${capCp(e.context, 100)}（${e.raisedAt.slice(0, 10)}）`).join('\n')}`)
      }
    })
  }

  // AI カンパニー（タスクボードの状況。バッチ6a で移行済みドメイン）
  if (can('ai-company') && /AI ?社員|AI ?カンパニー|AI ?タスク/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ title: string; status: string; empName: string }>(
        `SELECT t.title, t.status, e.name AS "empName"
         FROM ai_tasks t JOIN ai_employees e ON e.id = t.ai_employee_id
         ORDER BY t.created_at DESC LIMIT 8`)
      if (rows.length === 0) return
      const label: Record<string, string> = {
        proposed: '承認待ち', approved: '承認済', in_progress: '実行中', blocked: 'ブロック中', done: '完了', cancelled: '中止',
      }
      parts.push(`## AI カンパニーのタスク（/ai-company）\n${rows.map(t =>
        `- ${t.empName}「${capCp(t.title, 60)}」: ${label[t.status] ?? t.status}`).join('\n')}`)
    })
  }

  // 売上（バッチ6b で移行済みドメイン。年度累計・当月・前年同月比のサマリのみ = 明細は /sales へ誘導）
  if (can('sales') && /売上|売り上げ|粗利|業績|セールス/.test(question)) {
    await block(async () => {
      const fsm = await selfFiscalStartMonth(pool)
      const currentMonth = today.slice(0, 7)
      const fy = fiscalYearOf(currentMonth, fsm)
      const months = fiscalMonthsOf(fy, fsm).filter(m => m <= currentMonth)
      const prevMonth = `${Number(currentMonth.slice(0, 4)) - 1}-${currentMonth.slice(5, 7)}`
      const { rows } = await pool.query<{ month: string; amount: string; cost: string }>(
        `SELECT month, sum(amount)::text AS amount, sum(cost)::text AS cost
         FROM sales_monthly WHERE month = ANY($1) GROUP BY month`,
        [[...months, prevMonth]])
      if (rows.length === 0) return
      const of = (m: string): { amount: number; cost: number } => {
        const r = rows.find(x => x.month === m)
        return { amount: Number(r?.amount ?? 0), cost: Number(r?.cost ?? 0) }
      }
      const fyAmount = months.reduce((s, m) => s + of(m).amount, 0)
      const fyCost = months.reduce((s, m) => s + of(m).cost, 0)
      const cur = of(currentMonth)
      const prev = of(prevMonth)
      const yoy = prev.amount > 0 ? ` / 前年同月比 ${((cur.amount - prev.amount) / prev.amount * 100).toFixed(1)}%` : ''
      const marginRate = fyAmount > 0 ? `（粗利率 ${((fyAmount - fyCost) / fyAmount * 100).toFixed(1)}%）` : ''
      parts.push(`## 売上サマリ（/sales・${fy}年度）
年度累計売上 ${Math.round(fyAmount / 10000).toLocaleString('ja-JP')}万円${marginRate}
当月（${currentMonth}）売上 ${Math.round(cur.amount / 10000).toLocaleString('ja-JP')}万円${yoy}`)
    })
  }

  // 稼働状況（バッチ6c で移行済みドメイン。全体状態 + 対応中インシデント。詳細は /status へ誘導）
  if (can('status') && /稼働|障害|システム|メンテ|止まっ|落ち/.test(question)) {
    await block(async () => {
      const { rows: services } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM system_services WHERE active = true ORDER BY id`)
      if (services.length === 0) return
      const { rows: open } = await pool.query<{
        serviceId: string; title: string; impact: string; status: string; startedAt: string
      }>(
        `SELECT service_id AS "serviceId", title, impact, status, started_at AS "startedAt"
         FROM service_incidents WHERE status <> 'resolved' ORDER BY started_at DESC LIMIT 10`)
      const stateLabel: Record<string, string> = {
        minor: '性能低下', major: '一部障害', critical: '重大障害',
      }
      const statusLabel: Record<string, string> = {
        investigating: '調査中', identified: '原因特定', monitoring: '経過観察',
      }
      const nameOf = new Map(services.map(s => [s.id, s.name]))
      const lines = services.map((s) => {
        const incs = open.filter(i => i.serviceId === s.id)
        if (incs.length === 0) return `- ${s.name}: 正常稼働`
        return incs.map(i =>
          `- ${nameOf.get(i.serviceId)}: ${stateLabel[i.impact] ?? i.impact}「${capCp(i.title, 60)}」（${statusLabel[i.status] ?? i.status}・${i.startedAt.slice(0, 16)}〜）`).join('\n')
      })
      parts.push(`## 提供システムの稼働状況（/status）\n${lines.join('\n')}${
        open.length === 0 ? '\n現在、対応中の障害はありません。' : ''}`)
    })
  }

  // AKEBONO（バッチ6d で移行済みドメイン。構想状況 + 直近の要望 = 詳細は /akebono へ誘導）。
  // 顧客「アケボノ商事」・サービス「AKEBONO SCM」・アプリ名「AKEBONO Office」への言及では
  // 発火しない（顧客/稼働状況ブロックとの文脈ノイズ防止 = 6d レビュー指摘対応）
  if (can('akebono') && /AKEBONO(?!\s*(SCM|Office))|アケボノ(?!商事)|あけぼの|要望/i.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<{ body: string; at: string }>(
        `SELECT body, at FROM akebono_wishes ORDER BY at DESC LIMIT 3`)
      parts.push(`## AKEBONO（/akebono）
次世代の AI ネイティブ会社基盤として要件定義中（Phase 2）。要望ボックスで「こうなってほしい」を受付中。${
  rows.length > 0
    ? `\n直近の要望: ${rows.map(w => `「${capCp(w.body, 60)}」（${w.at.slice(0, 10)}）`).join(' / ')}`
    : '\nまだ要望はありません。'}`)
    })
  }

  // 顧客(会社)（名前一致時のみ概要 + 関連ナレッジ。照合は生データ・整形は表示項目 deny 反映後）
  await block(async () => {
    const { rows: companies } = await pool.query<Record<string, unknown> & { id: string; name: string; aliases: string[] }>(
      `SELECT id, name, aliases, description, location, size FROM companies
       WHERE kind = 'customer' AND active = true ORDER BY id LIMIT 100`)
    const company = companies.find(c => [c.name, ...c.aliases].some(n => n && q.includes(n.toLowerCase())))
    if (!company) return
    // 見出しにも剥がし後の値を使う（name deny 時はブロックごと出さない）
    const [cs] = strip('companies', [company])
    if (!cs?.name) return
    const { rows: ks } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND domain = 'company' AND target_id = $1 LIMIT 3`, [company.id])
    const { rows: pjs } = await pool.query<{ name: string; status: string }>(
      `SELECT name, status FROM projects WHERE active = true AND company_id = $1 LIMIT 5`, [company.id])
    parts.push(`## 顧客「${String(cs.name)}」
${String(cs.description ?? '')}（${String(cs.location ?? '')}・規模 ${String(cs.size ?? '')}）
プロジェクト: ${pjs.map(p => `${p.name}（${p.status}）`).join(' / ') || 'なし'}
${strip('knowledge', ks).map(k => `ナレッジ「${String(k.title ?? '')}」(${k.id}): ${capCp(String(k.body ?? ''), 200)}`).join('\n')}`)
  })

  // 顧客(人)（名前一致時のみ。表示項目 deny 反映）
  await block(async () => {
    const { rows: contacts } = await pool.query<Record<string, unknown> & { id: string; name: string; companyId: string }>(
      `SELECT id, name, company_id AS "companyId", dept, title, key_person AS "keyPerson", email, phone
       FROM contacts WHERE active = true ORDER BY id LIMIT 300`)
    const matched = contacts.find(p => nameHit(p.name))
    if (!matched) return
    // 見出しにも剥がし後の値を使う（name deny 時はブロックごと出さない）
    const [p] = strip('contacts', [matched])
    if (!p?.name) return
    const { rows: comp } = await pool.query<{ name: string }>(
      `SELECT name FROM companies WHERE id = $1`, [matched.companyId])
    parts.push(`## 顧客担当者「${String(p.name)}」
所属 ${comp[0]?.name ?? '不明'}${p.dept ? ` ${String(p.dept)}` : ''} / 役職 ${String(p.title ?? '') || 'なし'}${
  p.keyPerson ? ` / キーパーソン度 ${String(p.keyPerson)}` : ''}${p.email ? ` / メール ${String(p.email)}` : ''}`)
  })

  // プロジェクト一覧（キーワード時。表示項目 deny 反映）
  if (/プロジェクト|案件/.test(question)) {
    await block(async () => {
      const { rows } = await pool.query<Record<string, unknown> & { id: string; name: string; companyId: string | null }>(
        `SELECT id, name, status, company_id AS "companyId" FROM projects WHERE active = true ORDER BY id LIMIT 10`)
      if (rows.length === 0) return
      const { rows: comps } = await pool.query<Record<string, unknown> & { id: string }>(
        `SELECT id, name FROM companies ORDER BY id LIMIT 200`)
      // 会社名の参照にも companies の表示項目 deny を反映する
      const compName = new Map(strip('companies', comps)
        .filter(c => c.name).map(c => [c.id, String(c.name)]))
      const stripped = strip('projects', rows)
      parts.push(`## プロジェクト一覧\n${stripped.map(p =>
        `- ${String(p.name ?? '')}（${String(p.status ?? '')}${p.companyId ? `・${compName.get(String(p.companyId)) ?? ''}` : ''}）`).join('\n')}`)
    })
  }

  // ナレッジ全文検索（タイトル・本文の部分一致。上位 3 件。% _ はリテラル扱いにエスケープ）
  await block(async () => {
    const terms = question.replace(/[？?。、！!]/g, ' ').split(/\s+/).filter(t => t.length >= 2).slice(0, 5)
    if (terms.length === 0) return
    const { rows: hits } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND (${terms.map((_, i) => `title ILIKE $${i + 1} ESCAPE '\\' OR body ILIKE $${i + 1} ESCAPE '\\'`).join(' OR ')})
       ORDER BY id LIMIT 3`,
      terms.map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`))
    if (hits.length > 0) {
      parts.push(`## 関連ナレッジ\n${strip('knowledge', hits).map(k =>
        `「${String(k.title ?? '')}」(${k.id}): ${capCp(String(k.body ?? ''), 200)}`).join('\n')}`)
    }
  })

  return parts.join('\n\n')
}

export function chatbotRoutes(pool: pg.Pool, env: Env): Hono {
  const app = new Hono()

  // セッション一覧（本人のみ・新しい順・直近 100 件）。
  // 表示時刻の規約どおり timestamptz は JST のウォールクロック文字列へ変換して返す（configs.ts の監査ログと同じパターン）
  app.get('/sessions', async (c) => {
    const user = c.get('user')
    const { rows } = await pool.query(
      `SELECT s.id, s.title,
              to_char(s.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "createdAt",
              to_char(s.updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS"+09:00"') AS "updatedAt",
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
    // 参照範囲は権限ルール（F-16）に従う（バッチ5d）。ルール取得失敗は 500（フェイルクローズ = featureGuard と同方向）
    const rules = await activePermissionRules(pool)
    const context = await buildContext(pool, user, question, rules)
    const res = await generateJson<ChatAnswer>(env, {
      system: 'あなたは社内業務アシスタント（AKEBONO Office のチャットボット）です。与えられた社内文脈だけを'
        + '根拠に、日本語の丁寧語で簡潔に回答します。文脈にない事実は述べず、その場合は confidence を低くして'
        + '「わからない」と伝えてください。会話履歴がある場合は文脈を引き継いで回答します'
        + '（「それ」「さっきの」等の指示語は履歴から解決）。sources は使用した文脈の見出し'
        + '（例: 本人の有給・本人の直近の日報・本人の稟議・顧客「◯◯」・ナレッジ タイトル）、suggestions は関連する次の質問を 2 件、'
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
