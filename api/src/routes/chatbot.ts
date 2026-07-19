/**
 * チャットボット応答 API（F-09-2）。mockup useChatbot の LLM 一次応答レイヤ。
 * - 一次応答: Vertex AI（構造化出力）。サーバーが DB の全移行済みドメイン
 *   （勤怠・有給・休暇種別・日報・ワークフロー・シフト・意思決定・タスク計画・カレンダー・
 *   エスカレーション・メンバー/部署・会社（自社/顧客 = 業界・担当・関係性込み）・顧客担当者・
 *   人の関係・業界逆引き・プロジェクト・ナレッジ・外部リンク・AI カンパニー・売上・稼働状況・AKEBONO）
 *   を文脈化して回答（バッチ5d/6a/6b/6c/6d + オペレーター報告 2026-07-18 #2 の供給漏れ是正）
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
import { findCompanyIn, SELF_COMPANY_PATTERN } from '../../../shared/domain/name-match'
import { aiReferenceScope, canUseFeature, canViewField, stripDeniedFields } from '../../../shared/domain/permissions'
import type { PermissionRule, PunchRecord, ReportEntry } from '../../../shared/domain/types'
import type { AuthUser } from '../auth'
import { daySummary } from '../domain/attendance'
import type { Env } from '../env'
import { err } from '../lib/errors'
import { capCp } from '../lib/text'
import { newId } from '../lib/ids'
import { generateJson } from '../lib/llm'
import { activePermissionRules, subjectOf } from '../lib/permissions'
import { searchDocsFor, TITLE_CHECKS } from '../lib/search-index'
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
 * 言及エンティティの解決（今回の質問 → 履歴の新しい順、の優先順）。
 * オペレーター報告 2026-07-18 #3「履歴中の別会社が今回の質問の会社に勝つ」の修正と同じ優先順を、
 * 会社ブロックと混入防止フィルタで共通化する。照合は findCompanyIn の正規化・最長一致を再利用
 * （プロジェクト名にも法人格除去・空白/全半角正規化は無害）
 */
function findMentionedIn<T extends { name: string; aliases?: string[] | null }>(
  question: string,
  historyUserTexts: string[],
  rows: T[],
): T | undefined {
  return findCompanyIn(question, rows)
    ?? [...historyUserTexts].reverse().map(t => findCompanyIn(t, rows)).find(Boolean)
}

/**
 * 質問に関連しそうな社内文脈を収集する（バッチ5d: DB の全移行済みドメイン）。
 * - ドメインごとに権限（F-16 canUseFeature）で生成可否を判定 = チャットボットの参照範囲も権限に従う
 * - マスタ由来の文脈は stripDeniedFields で表示項目 deny を反映（補助マスタ = 業界・関係種別・
 *   休暇種別・部署・外部リンク・意思決定テーマ等も対象。JOIN で取り込む単一項目は canViewField で判定）
 * - 本人スコープ（C3）維持。他メンバーの日報は提出済みのみ（scope=all と同じ基準）
 * - ブロック単位の収集失敗は全体を止めない（原則4 = 部分的な文脈でも回答を試みる）
 * - キーワード判定は「今回の質問 + 直近のユーザー発言（historyUserTexts）」を対象にする
 *   （オペレーター報告 2026-07-18: フォローアップ質問（「じゃあ去年は？」等）にキーワードが
 *   含まれず文脈が供給されない → 低確信度 → フォールバックの連鎖を解消。権限判定・本人スコープは
 *   従来どおりで、対象データの範囲は変わらない = 話題の継続性だけを補う）
 */
export async function buildContext(
  pool: pg.Pool,
  user: AuthUser,
  question: string,
  rules: PermissionRule[],
  historyUserTexts: string[] = [],
  env?: Env,
): Promise<string> {
  const parts: string[] = []
  // 精密ブロックが描画済みのエンティティ（検索リトリーバルとの二重供給防止）
  const renderedKeys = new Set<string>()
  // 話題判定用コーパス（質問 + 直近のユーザー発言）。LLM へ渡す質問文自体は変更しない
  const topic = [question, ...historyUserTexts].join('\n')
  const subject = subjectOf(user)
  const can = (feature: string): boolean => canUseFeature(rules, subject, feature)
  // AI 参照範囲（バッチ7g・オペレーター指示 2026-07-19 #8/#9: 'all' = 権限範囲内のすべてのデータ /
  // 'own' = 自分の登録データのみ。権限設定の field='ai-scope' ルールで区分ごとに設定・機能 deny が最優先）
  const aiScope = (feature: string): 'all' | 'own' => aiReferenceScope(rules, subject, feature)
  const strip = <T extends Record<string, unknown>>(entity: string, rows: T[]): T[] =>
    stripDeniedFields(rules, subject, entity, rows)
  // JOIN で取り込んだ他エンティティ由来の単一項目（relation_types.label 等）の表示可否。
  // 行キーが元エンティティの項目名と異なる場合は strip では剥がれないため、こちらで判定する
  const canField = (entity: string, field: string): boolean =>
    canViewField(rules, subject, entity, field)
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
    !!name && (topic.includes(name) || topic.includes(name.replace(/\s+/g, ''))
      || name.split(/\s+/).some(p =>
        p.length >= 2 && (topic.includes(`${p}さん`) || topic.includes(`${p}氏`))))

  // 人の関係（contact_relations。端点は顧客担当者または自社メンバー = PR #29 仕様。
  // 相手の表示名には contacts / members の表示項目 deny を反映する）
  const personRelations = async (endpointId: string): Promise<string[]> => {
    const { rows: relRows } = await pool.query<{ fromId: string; toId: string; label: string; notes: string }>(
      `SELECT r.from_contact_id AS "fromId", r.to_contact_id AS "toId", rt.label, r.notes
       FROM contact_relations r JOIN relation_types rt ON rt.id = r.relation_type_id
       WHERE r.from_contact_id = $1 OR r.to_contact_id = $1
       ORDER BY r.created_at DESC LIMIT 5`, [endpointId])
    if (relRows.length === 0) return []
    // 関係種別ラベル（relation-types.label）・関係メモ（contact-relations.notes）にも表示項目 deny を反映
    const rels = strip('contact-relations', strip('relation-types', relRows))
    const otherIds = [...new Set(rels.map(r => (r.fromId === endpointId ? r.toId : r.fromId)))]
    const { rows: cons } = await pool.query<Record<string, unknown> & { id: string }>(
      `SELECT id, name FROM contacts WHERE active = true AND id = ANY($1)`, [otherIds])
    const { rows: mems } = await pool.query<Record<string, unknown> & { id: string }>(
      `SELECT id, name FROM members WHERE active = true AND id = ANY($1)`, [otherIds])
    const conName = new Map(strip('contacts', cons).filter(x => x.name).map(x => [x.id, String(x.name)]))
    const memName = new Map(strip('members', mems).filter(x => x.name).map(x => [x.id, `${String(x.name)}（自社）`]))
    return rels
      .map((r) => {
        const otherId = r.fromId === endpointId ? r.toId : r.fromId
        const other = conName.get(otherId) ?? memName.get(otherId)
        if (!other) return null
        return `${r.fromId === endpointId ? '→' : '←'} ${other}${r.label ? `: ${r.label}` : ''}${
          r.notes ? `（${capCp(r.notes, 60)}）` : ''}`
      })
      .filter((x): x is string => !!x)
  }

  // 有給・当月勤怠（既定 = 本人分のみ（C3）。AI 参照範囲 'all' の対象者にはチーム全体のサマリーも供給）
  if (can('attendance') && /有給|休暇|残業|勤怠|労働|打刻/.test(topic)) {
    if (aiScope('attendance') === 'all') {
      await block(async () => {
        const { rows } = await pool.query<PunchRecord & { memberName: string }>(
          `SELECT p.id, p.member_id AS "memberId", p.date::text AS date, p.kind, p.at, p.source,
                  p.fixed_from AS "fixedFrom", p.fix_reason AS "fixReason", p.approved_by AS "approvedBy",
                  m.name AS "memberName"
           FROM punch_records p JOIN members m ON m.id = p.member_id AND m.active = true
           WHERE to_char(p.date, 'YYYY-MM') = $1 ORDER BY p.at, p.created_at LIMIT 8000`, [today.slice(0, 7)])
        if (rows.length === 0) return
        const byMember = new Map<string, { name: string; byDate: Map<string, PunchRecord[]> }>()
        for (const r of rows) {
          const m = byMember.get(r.memberId) ?? { name: r.memberName, byDate: new Map() }
          const list = m.byDate.get(r.date) ?? []
          list.push(r)
          m.byDate.set(r.date, list)
          byMember.set(r.memberId, m)
        }
        const lines: string[] = []
        for (const [, m] of [...byMember.entries()].slice(0, 30)) {
          let work = 0
          for (const [d, recs] of m.byDate) work += daySummary(recs, undefined, d).workMinutes
          lines.push(`- ${m.name}: 出勤 ${m.byDate.size} 日 / 総労働 ${Math.round(work / 6) / 10} 時間`)
        }
        parts.push(`## チーム全体の当月勤怠（${today.slice(0, 7)}。AI 参照範囲 = すべて）\n${lines.join('\n')}`)
      })
    }
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
         FROM punch_records WHERE member_id = $1 AND to_char(date, 'YYYY-MM') = $2 ORDER BY at, created_at`,
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
    // 休暇種別マスタ（「どんな休暇がある？」に回答。申請時に選択できる種別の一覧）
    if (/休暇|有給/.test(topic)) {
      await block(async () => {
        const { rows } = await pool.query<{ name: string; description: string; isStatutory: boolean }>(
          `SELECT name, description, is_statutory AS "isStatutory" FROM leave_types
           WHERE active = true ORDER BY display_order, id LIMIT 10`)
        // 表示項目 deny を反映（name deny 時は種別を特定できないため行ごと出さない）
        const types = strip('leave-types', rows).filter(t => t.name)
        if (types.length === 0) return
        parts.push(`## 休暇種別（/attendance の有給タブから申請）\n${types.map(t =>
          `- ${t.name}${t.isStatutory ? '（法定）' : ''}${t.description ? `: ${capCp(t.description, 60)}` : ''}`).join('\n')}`)
      })
    }
  }

  // 本人の日報（下書き含む = 本人スコープ）
  if (can('reports') && /日報|週報|振り返り|所感|提出/.test(topic)) {
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
      // 部署名にも departments の表示項目 deny を反映する
      deptName = strip('departments', deps)[0]?.name ?? ''
    }
    // 自社メンバーも顧客関係(人)の端点になれる（PR #29）ため関係を併記する
    const relLines = await personRelations(matched.id)
    parts.push(`## メンバー「${displayName}」
部署 ${deptName || '未所属'} / 役職 ${String(m.title ?? '') || 'なし'}${m.email ? ` / メール ${String(m.email)}` : ''}${
  relLines.length > 0 ? `\n人の関係: ${relLines.join(' / ')}` : ''}`)
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
  if (can('workflow') && /稟議|申請|承認|ワークフロー|決裁/.test(topic)) {
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
  if (can('shift') && /シフト|出勤/.test(topic)) {
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
  if (can('decision') && /意思決定|判断|テーマ|選択肢/.test(topic)) {
    await block(async () => {
      const { rows: themes } = await pool.query<{ id: string; title: string; category: string }>(
        `SELECT id, title, category FROM decision_themes WHERE active = true ORDER BY id LIMIT 10`)
      const { rows: logs } = await pool.query<{ themeTitle: string; chosenSlot: string; reason: string; at: string }>(
        `SELECT t.title AS "themeTitle", l.chosen_slot AS "chosenSlot", l.reason, l.at
         FROM decision_logs l JOIN decision_themes t ON t.id = l.theme_id ORDER BY l.at DESC, l.id LIMIT 3`)
      // テーマ名にも decision-themes の表示項目 deny を反映（title deny 時はテーマを特定できないため出さない）
      const shownThemes = strip('decision-themes', themes).filter(t => t.title)
      if (shownThemes.length === 0) return
      const shownLogs = canField('decision-themes', 'title') ? logs : []
      parts.push(`## 意思決定支援（/decision）
テーマ: ${shownThemes.map(t => `「${t.title}」${t.category ? `(${t.category === 'business' ? '事業' : 'PJ'})` : ''}`).join(' / ')}${
  shownLogs.length > 0 ? `\n直近の判断: ${shownLogs.map(l => `「${l.themeTitle}」→ 案${l.chosenSlot}（${capCp(l.reason, 60)}）`).join(' / ')}` : ''}`)
    })
  }

  // タスク計画・当日予定（既定 = 本人分のみ。AI 参照範囲 'all' の対象者にはチーム全体の本日計画も供給）
  if (can('ai-assistant') && /タスク|計画|予定|会議|ミーティング|カレンダー/.test(topic)) {
    if (aiScope('ai-assistant') === 'all') {
      await block(async () => {
        const { rows } = await pool.query<{ name: string; title: string; status: string }>(
          `SELECT m.name, t.title, t.status FROM task_plans t
           JOIN members m ON m.id = t.member_id AND m.active = true
           WHERE t.date = $1::date ORDER BY m.id, t.created_at LIMIT 50`, [today])
        if (rows.length === 0) return
        parts.push(`## チーム全体の本日のタスク計画（${today}。AI 参照範囲 = すべて）\n${rows.map(r =>
          `- ${r.name}:「${capCp(r.title, 50)}」${r.status === 'done' ? '（完了）' : ''}`).join('\n')}`)
      })
    }
    await block(async () => {
      const { rows: plans } = await pool.query<{ title: string; status: string; outcome: string }>(
        `SELECT title, status, outcome FROM task_plans
         WHERE member_id = $1 AND date = $2::date ORDER BY created_at, id LIMIT 10`, [user.id, today])
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
  if (/課題|エスカレ|困り/.test(topic)) {
    await block(async () => {
      const { rows } = await pool.query<{ context: string; raisedAt: string }>(
        `SELECT context, raised_at AS "raisedAt" FROM escalations
         WHERE target_member_id = $1 AND status = 'open' AND reason = 'issue_reported'
         ORDER BY raised_at DESC, created_at DESC LIMIT 3`, [user.id])
      if (rows.length > 0) {
        parts.push(`## 本人に関する対応中エスカレーション\n${rows.map(e => `- ${capCp(e.context, 100)}（${e.raisedAt.slice(0, 10)}）`).join('\n')}`)
      }
    })
  }

  // AI カンパニー（タスクボードの状況。バッチ6a で移行済みドメイン）
  if (can('ai-company') && /AI ?社員|AI ?カンパニー|AI ?タスク/.test(topic)) {
    await block(async () => {
      const { rows } = await pool.query<{ title: string; status: string; empName: string }>(
        `SELECT t.title, t.status, e.name AS "empName"
         FROM ai_tasks t JOIN ai_employees e ON e.id = t.ai_employee_id
         ORDER BY t.created_at DESC, t.id LIMIT 8`)
      if (rows.length === 0) return
      const label: Record<string, string> = {
        proposed: '承認待ち', approved: '承認済', in_progress: '実行中', blocked: 'ブロック中', done: '完了', cancelled: '中止',
      }
      // 担当 AI 社員名（ai-employees.name の JOIN 参照）にも表示項目 deny を反映
      const empNameOk = canField('ai-employees', 'name')
      parts.push(`## AI カンパニーのタスク（/ai-company）\n${rows.map(t =>
        `- ${empNameOk ? t.empName : 'AI社員'}「${capCp(t.title, 60)}」: ${label[t.status] ?? t.status}`).join('\n')}`)
    })
  }

  // 売上（バッチ6b で移行済みドメイン。年度累計・当月・前年同月比のサマリのみ = 明細は /sales へ誘導）
  if (can('sales') && /売上|売り上げ|粗利|業績|セールス/.test(topic)) {
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
  if (can('status') && /稼働|障害|システム|メンテ|止まっ|落ち/.test(topic)) {
    await block(async () => {
      const { rows: services } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM system_services WHERE active = true ORDER BY id`)
      if (services.length === 0) return
      const { rows: open } = await pool.query<{
        serviceId: string; title: string; impact: string; status: string; startedAt: string
      }>(
        `SELECT service_id AS "serviceId", title, impact, status, started_at AS "startedAt"
         FROM service_incidents WHERE status <> 'resolved' ORDER BY started_at DESC, id LIMIT 10`)
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
  if (can('akebono') && /AKEBONO(?!\s*(SCM|Office))|アケボノ(?!商事)|あけぼの|要望/i.test(topic)) {
    await block(async () => {
      const { rows } = await pool.query<{ body: string; at: string }>(
        `SELECT body, at FROM akebono_wishes ORDER BY at DESC, id LIMIT 3`)
      parts.push(`## AKEBONO（/akebono）
次世代の AI ネイティブ会社基盤として要件定義中（Phase 2）。要望ボックスで「こうなってほしい」を受付中。${
  rows.length > 0
    ? `\n直近の要望: ${rows.map(w => `「${capCp(w.body, 60)}」（${w.at.slice(0, 10)}）`).join(' / ')}`
    : '\nまだ要望はありません。'}`)
    })
  }

  // 会社（自社・顧客）: 名前一致 or「自社」キーワードで概要 + 業界 + 担当 + 担当者 + 関係性 + PJ + ナレッジ
  // （オペレーター報告 2026-07-18 #2: 業界・関係性が DB にあるのに文脈へ渡っていなかった供給漏れの是正。
  //  照合は生データ・整形は表示項目 deny 反映後 = 従来パターン）
  await block(async () => {
    const { rows: companies } = await pool.query<Record<string, unknown> & {
      id: string; kind: string; name: string; aliases: string[]
      industryIds: string[]; primaryIndustryId: string; ownerMemberId: string
    }>(
      `SELECT id, kind, name, aliases, industry_ids AS "industryIds",
              primary_industry_id AS "primaryIndustryId", owner_member_id AS "ownerMemberId",
              description, location, size, fiscal_start_month AS "fiscalStartMonth"
       FROM companies WHERE active = true ORDER BY id LIMIT 1000`)
    // 照合は正規化名寄せ（法人格・空白除去 = 「つなぐば」→「つなぐば株式会社」）+ 最長一致。
    // 優先順: 今回の質問 → 直近のユーザー発言（新しい順）→ 自社キーワード
    // （オペレーター報告 2026-07-18 #3: 履歴中の別会社が今回の質問の会社に勝つ誤りを解消 = findMentionedIn）
    const company = findMentionedIn(question, historyUserTexts, companies)
      ?? (SELF_COMPANY_PATTERN.test(topic) ? companies.find(c => c.kind === 'self') : undefined)
    if (!company) return
    renderedKeys.add(`company:${company.id}`)
    // 見出しにも剥がし後の値を使う（name deny 時はブロックごと出さない）
    const [cs] = strip('companies', [company])
    if (!cs?.name) return
    const isSelf = company.kind === 'self'
    // 空フィールドは出力しない（「規模 ()」等のテンプレート残骸を作らない）
    const profile = [
      cs.description ? String(cs.description) : '',
      [cs.location ? String(cs.location) : '', cs.size ? `規模 ${String(cs.size)}` : ''].filter(Boolean).join('・'),
    ].filter(Boolean).join(' / ')
    const lines: string[] = profile ? [profile] : []
    // 業界（primary に（主）マーク。業界名にも industries の表示項目 deny を反映。
    // （主）判定も剥がし後の値を使う = primaryIndustryId deny 時はマークを出さない）
    if (cs.industryIds !== undefined && company.industryIds.length > 0) {
      const { rows: inds } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM industries WHERE id = ANY($1) AND active = true ORDER BY display_order, id`,
        [company.industryIds])
      const named = strip('industries', inds).filter(i => i.name)
        .map(i => i.id === cs.primaryIndustryId ? `${i.name}（主）` : i.name)
      if (named.length > 0) lines.push(`業界: ${named.join('・')}`)
    }
    // 自社担当（ownerMemberId → メンバー名。members の表示項目 deny を反映）
    if (cs.ownerMemberId !== undefined && company.ownerMemberId) {
      const { rows: owners } = await pool.query<Record<string, unknown> & { id: string }>(
        `SELECT id, name FROM members WHERE id = $1`, [company.ownerMemberId])
      const [o] = strip('members', owners)
      if (o?.name) lines.push(`自社担当: ${String(o.name)}`)
    }
    // 剥がし後の値を使う（companies.fiscalStartMonth deny 時は出さない）
    if (isSelf && cs.fiscalStartMonth) lines.push(`会計年度: ${String(cs.fiscalStartMonth)} 月始まり`)
    // 先方担当者（contacts。表示項目 deny を反映）
    const { rows: cons } = await pool.query<Record<string, unknown> & { id: string }>(
      `SELECT id, name, title, key_person AS "keyPerson" FROM contacts
       WHERE active = true AND company_id = $1 ORDER BY key_person DESC, id LIMIT 5`, [company.id])
    const conNames = strip('contacts', cons)
      .filter(p => p.name)
      .map(p => `${String(p.name)}${p.title ? `（${String(p.title)}）` : ''}`)
    if (conNames.length > 0) lines.push(`先方担当者: ${conNames.join(' / ')}`)
    // 関係性（company_relations 双方向 + 関係種別ラベル。相手名にも companies の deny を反映し、
    // ラベル（relation-types.label）・メモ（company-relations.notes）にも表示項目 deny を反映）
    const { rows: relRows } = await pool.query<{
      fromCompanyId: string; toCompanyId: string; label: string; notes: string
    }>(
      `SELECT r.from_company_id AS "fromCompanyId", r.to_company_id AS "toCompanyId",
              rt.label, r.notes
       FROM company_relations r JOIN relation_types rt ON rt.id = r.relation_type_id
       WHERE r.from_company_id = $1 OR r.to_company_id = $1
       ORDER BY r.created_at DESC LIMIT 5`, [company.id])
    if (relRows.length > 0) {
      const rels = strip('company-relations', strip('relation-types', relRows))
      const compName = new Map(strip('companies', companies).filter(c => c.name).map(c => [c.id, String(c.name)]))
      const relLines = rels
        .map((r) => {
          const otherId = r.fromCompanyId === company.id ? r.toCompanyId : r.fromCompanyId
          const other = compName.get(otherId)
          if (!other) return null
          const direction = r.fromCompanyId === company.id ? '→' : '←'
          return `${direction} ${other}${r.label ? `: ${r.label}` : ''}${r.notes ? `（${capCp(r.notes, 60)}）` : ''}`
        })
        .filter(Boolean)
      if (relLines.length > 0) lines.push(`会社間の関係: ${relLines.join(' / ')}`)
    }
    // プロジェクト名にも projects の表示項目 deny を反映（プロジェクト一覧ブロックと同じパターン）
    const { rows: pjRows } = await pool.query<{ name: string; status: string }>(
      `SELECT name, status FROM projects WHERE active = true AND company_id = $1 LIMIT 5`, [company.id])
    const pjs = strip('projects', pjRows).filter(p => p.name)
    lines.push(`プロジェクト: ${pjs.map(p => `${p.name}${p.status ? `（${p.status}）` : ''}`).join(' / ') || 'なし'}`)
    const { rows: ks } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND domain = 'company' AND target_id = $1 LIMIT 3`, [company.id])
    for (const k of strip('knowledge', ks)) {
      lines.push(`ナレッジ「${String(k.title ?? '')}」(${k.id}): ${capCp(String(k.body ?? ''), 200)}`)
    }
    parts.push(`## ${isSelf ? '自社' : '顧客'}「${String(cs.name)}」\n${lines.join('\n')}`)
  })

  // 業界の逆引き（業界マスタ × 顧客。「アパレル業界の顧客は？」等に回答）
  if (/業界/.test(topic)) {
    await block(async () => {
      const { rows: indRows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM industries WHERE active = true ORDER BY display_order, id LIMIT 20`)
      // 業界名にも industries の表示項目 deny を反映（name deny 時は行ごと出さない）
      const inds = strip('industries', indRows).filter(i => i.name)
      if (inds.length === 0) return
      const { rows: comps } = await pool.query<Record<string, unknown> & { id: string; industryIds: string[] }>(
        `SELECT id, name, industry_ids AS "industryIds" FROM companies
         WHERE kind = 'customer' AND active = true ORDER BY id LIMIT 100`)
      const stripped = strip('companies', comps).filter(c => c.name)
      const lines = inds.map((i) => {
        // industryIds が deny で剥がれた顧客は該当なし扱い（?? [] = 偶発 throw でブロックごと消えるのを防ぐ）
        const names = stripped
          .filter(c => ((c.industryIds as string[] | undefined) ?? []).includes(i.id))
          .map(c => String(c.name))
        return `- ${i.name}: ${names.join('・') || '該当顧客なし'}`
      })
      parts.push(`## 業界別の顧客（業界マスタ）\n${lines.join('\n')}`)
    })
  }

  // 部署（一覧 + 部署名一致時は所属メンバー。「◯◯部には誰がいる？」等に回答。
  // 「部署」等の一般語がなくても部署名そのものの言及で発火する）
  await block(async () => {
      const { rows: deps } = await pool.query<{ id: string; name: string; managerId: string | null; members: string }>(
        `SELECT d.id, d.name, d.manager_id AS "managerId",
                (SELECT count(*)::text FROM members m WHERE m.department_id = d.id AND m.active = true) AS members
         FROM departments d WHERE d.active = true ORDER BY d.display_order, d.id LIMIT 50`)
      if (deps.length === 0) return
      if (!/部署|組織|チーム|所属/.test(topic) && !deps.some(d => topic.includes(d.name))) return
      // 照合は生データ・表示は剥がし後（departments.name deny 時はブロックごと出さない = 従来パターン）
      const strippedDeps = strip('departments', deps).filter(d => d.name)
      if (strippedDeps.length === 0) return
      const { rows: allMembers } = await pool.query<Record<string, unknown> & { id: string; departmentId: string }>(
        `SELECT id, name, title, department_id AS "departmentId" FROM members
         WHERE active = true ORDER BY id LIMIT 300`)
      const strippedMembers = strip('members', allMembers)
      const nameOfMember = new Map(strippedMembers.filter(m => m.name).map(m => [m.id, String(m.name)]))
      const lines = strippedDeps.map(d =>
        `- ${d.name}（${d.members} 名${d.managerId && nameOfMember.get(d.managerId) ? `・責任者 ${nameOfMember.get(d.managerId)}` : ''}）`)
      // 部署名が話題に含まれる場合は所属メンバーも展開（「開発部」より「文脈開発部」を優先 = 最長一致）
      const hit = deps
        .filter(d => topic.includes(d.name))
        .sort((a, b) => b.name.length - a.name.length)[0]
      const hitShown = hit && strippedDeps.find(d => d.id === hit.id)
      if (hitShown) {
        const names = strippedMembers
          .filter(m => m.departmentId === hitShown.id && m.name)
          .map(m => `${String(m.name)}${m.title ? `（${String(m.title)}）` : ''}`)
        lines.push(`「${hitShown.name}」の所属: ${names.join(' / ') || 'なし'}`)
      }
      parts.push(`## 部署・組織（/masters の部署・組織図）\n${lines.join('\n')}`)
  })

  // 顧客(人)（名前一致時のみ。表示項目 deny 反映）
  await block(async () => {
    const { rows: contacts } = await pool.query<Record<string, unknown> & { id: string; name: string; companyId: string }>(
      `SELECT id, name, company_id AS "companyId", dept, title, key_person AS "keyPerson", email, phone
       FROM contacts WHERE active = true ORDER BY id LIMIT 300`)
    const matched = contacts.find(p => nameHit(p.name))
    if (!matched) return
    renderedKeys.add(`contact:${matched.id}`)
    // 見出しにも剥がし後の値を使う（name deny 時はブロックごと出さない）
    const [p] = strip('contacts', [matched])
    if (!p?.name) return
    const { rows: comp } = await pool.query<{ name: string }>(
      `SELECT name FROM companies WHERE id = $1`, [matched.companyId])
    const relLines = await personRelations(matched.id)
    // 所属会社名にも companies の表示項目 deny を反映する
    const compDisplayName = strip('companies', comp)[0]?.name
    parts.push(`## 顧客担当者「${String(p.name)}」
所属 ${compDisplayName ?? '不明'}${p.dept ? ` ${String(p.dept)}` : ''} / 役職 ${String(p.title ?? '') || 'なし'}${
  p.keyPerson ? ` / キーパーソン度 ${String(p.keyPerson)}` : ''}${p.email ? ` / メール ${String(p.email)}` : ''}${
  relLines.length > 0 ? `\n人の関係: ${relLines.join(' / ')}` : ''}`)
  })

  // プロジェクト一覧（キーワード時。表示項目 deny 反映）
  if (/プロジェクト|案件/.test(topic)) {
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

  // 外部リンク（「◯◯のリンクは？」「ログインページは？」に回答）
  if (/リンク|URL|ログインページ/i.test(topic)) {
    await block(async () => {
      const { rows } = await pool.query<{ title: string; url: string; description: string }>(
        `SELECT title, url, description FROM external_links
         WHERE active = true ORDER BY display_order, id LIMIT 10`)
      // 表示項目 deny を反映（title deny 時はリンクを特定できないため行ごと出さない）
      const links = strip('external-links', rows).filter(l => l.title)
      if (links.length === 0) return
      parts.push(`## 外部リンク（/support）\n${links.map(l =>
        `- ${l.title}${l.url ? `: ${l.url}` : ''}${l.description ? `（${capCp(l.description, 60)}）` : ''}`).join('\n')}`)
    })
  }

  // ナレッジ全文検索（タイトル・本文の部分一致。上位 3 件。% _ はリテラル扱いにエスケープ）
  await block(async () => {
    const terms = topic.replace(/[？?。、！!]/g, ' ').split(/\s+/).filter(t => t.length >= 2).slice(0, 5)
    if (terms.length === 0) return
    const { rows: hits } = await pool.query<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM knowledge_articles
       WHERE active = true AND (${terms.map((_, i) => `title ILIKE $${i + 1} ESCAPE '\\' OR body ILIKE $${i + 1} ESCAPE '\\'`).join(' OR ')})
       ORDER BY id LIMIT 3`,
      terms.map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`))
    if (hits.length > 0) {
      for (const k of hits) renderedKeys.add(`knowledge:${k.id}`)
      parts.push(`## 関連ナレッジ\n${strip('knowledge', hits).map(k =>
        `「${String(k.title ?? '')}」(${k.id}): ${capCp(String(k.body ?? ''), 200)}`).join('\n')}`)
    }
  })

  // 検索リトリーバル（AI 検索最適化基盤 = search_docs。キーワード一致で拾えない曖昧・解釈型の質問を
  // 字句バイグラム + 埋め込み（LLM 無効環境は字句のみ）で補足する。精密ブロック描画済みは除外。
  // 照合は生データ・描画は segments の表示項目チェック（canViewField）通過行のみ = 既存パターン）
  await block(async () => {
    // ぽいぽいポストの AI 参照範囲（'all' = 他メンバーの投稿も参照 = 既定。'own' 設定時は本人のみ）
    const hits = await searchDocsFor(pool, env, question, user.id, 4, aiScope('poipoi') === 'all')
    // 混入防止（オペレーター指示 2026-07-19 #5）: 質問が特定の顧客/プロジェクトに解決された場合、
    // 「別の顧客/プロジェクトに紐付くノート」は関係のない情報として文脈から除外する。
    // 紐付けなしのノートは対象外（全般メモとして従来どおりスコア勝負）
    const noteHits = hits.some(h => h.sourceKind === 'note')
    let mentionedCompanyId: string | null = null
    let mentionedProjectId: string | null = null
    if (noteHits) {
      // 会社ブロックと同じ「今回の質問 → 履歴（新しい順）→ 自社キーワード」の優先順で解決する。
      // topic（連結）への最長一致だと履歴中の別会社が今回の質問の会社に勝ち、関係あるノートを誤除外する
      // （オペレーター報告 2026-07-18 #3 で修正済みのパターンをここで再導入しない）
      const { rows: cos } = await pool.query<{ id: string; name: string; aliases: string[]; kind: string }>(
        `SELECT id, name, aliases, kind FROM companies WHERE active = true ORDER BY id LIMIT 1000`)
      mentionedCompanyId = (findMentionedIn(question, historyUserTexts, cos)
        ?? (SELF_COMPANY_PATTERN.test(topic) ? cos.find(x => x.kind === 'self') : undefined))?.id ?? null
      // プロジェクトも同じ優先順 + 正規化・最長一致（生 includes の「最初の一致」では別 PJ の誤除外が起きる）
      const { rows: pjs } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE active = true ORDER BY id LIMIT 1000`)
      mentionedProjectId = findMentionedIn(question, historyUserTexts, pjs)?.id ?? null
    }
    const lines: string[] = []
    for (const h of hits) {
      if (renderedKeys.has(`${h.sourceKind}:${h.sourceId}`)) continue
      // ノートは機能ガード（F-16）にも従う: poipoi（owner あり）= 'poipoi' / 議事録 = 'minutes'
      // （reports 等のドメイン文脈と同じ「deny で文脈から消える」挙動に統一）
      if (h.sourceKind === 'note' && !can(h.ownerMemberId ? 'poipoi' : 'minutes')) continue
      if (h.sourceKind === 'note') {
        if (mentionedCompanyId && h.links.companyId && h.links.companyId !== mentionedCompanyId) continue
        if (mentionedProjectId && h.links.projectId && h.links.projectId !== mentionedProjectId) continue
      }
      const titleCheck = TITLE_CHECKS[h.sourceKind]
      if (!canField(titleCheck.entity, titleCheck.field)) continue
      const segLines = (h.segments ?? [])
        .filter(s => (s.checks ?? []).every(ch => canField(ch.entity, ch.field)))
        .map(s => s.text)
      lines.push(`### ${h.title}\n${capCp(segLines.join('\n'), 600)}`)
    }
    if (lines.length > 0) parts.push(`## 関連情報（社内データ検索）\n${lines.join('\n')}`)
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
    // 文脈収集の話題判定にはフォローアップ対応のため直近のユーザー発言も渡す（各 200 cp・3 件まで）
    const historyUserTexts = history
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => capCp(m.content, 200))
    const context = await buildContext(pool, user, question, rules, historyUserTexts, env)
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
