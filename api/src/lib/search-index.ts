/**
 * AI 検索最適化基盤（オペレーター報告 2026-07-18 #3: チャットボット精度）。
 *
 * - SoT は各マスタ・ナレッジ本体。search_docs は「AI が探索・解釈しやすい形」へフラット化した
 *   派生キャッシュで、常に全再生成できる（SoT → キャッシュの一方向 = 原則6）
 * - 更新経路: ①マスタ書込後の自動再生成（scheduleSearchRebuild = デバウンス・非ブロッキング = 原則4）
 *   ②起動時の自動再生成（手動ステップを残さない = 原則1） ③POST /v1/search/reindex（手動回復パス）
 * - 冪等: (source_kind, source_id) 一意の upsert + 消えたソース行の削除。body_hash 不変ならスキップ
 *   （埋め込み API の無駄呼び出しを防ぐ）
 * - 埋め込み: Vertex AI（無効環境は null = 字句検索のみ）。字句照合は文字バイグラムの被覆率
 *   （日本語の分かち書き不要・pg 拡張に依存しない = 環境可搬性の設計判断）
 * - 権限: 照合は生データ・描画は segments の (entity, field) チェックを canViewField で通過した行のみ
 *   （「照合は生・表示は剥がし後」の既存パターンを検索にも適用）
 */
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { bigramCoverage } from '../../../shared/domain/text-match'
import type { Env } from '../env'
import { capCp } from './text'
import { cosineSimilarity, embedDocuments, embedQuery } from './embeddings'
import { newId } from './ids'

/** 表示可否チェック（renderer が canViewField で全チェック通過した行のみ描画する） */
export interface SegmentCheck {
  entity: string
  field: string
}

export interface SearchSegment {
  text: string
  checks: SegmentCheck[]
}

export interface SearchDocInput {
  sourceKind: 'company' | 'contact' | 'industry' | 'knowledge' | 'project' | 'note' | 'document'
  sourceId: string
  title: string
  aliases: string[]
  segments: SearchSegment[]
  /** 参照可能な所有者（null/未設定 = 全員。poipoi メモは本人のみ = C3） */
  ownerMemberId?: string | null
  /** 紐付け（AI 文脈の混入防止: 質問が特定の顧客/PJ に解決されたとき、別対象に紐付くノートを除外） */
  links?: { companyId?: string; projectId?: string }
}

export interface SearchDocRow extends SearchDocInput {
  id: string
  body: string
  embedding: number[] | null
}

/** 検索ドキュメントの見出しに対する表示可否（kind → タイトルのフィールド） */
export const TITLE_CHECKS: Record<SearchDocInput['sourceKind'], SegmentCheck> = {
  note: { entity: 'notes', field: 'title' },
  document: { entity: 'documents', field: 'name' },
  company: { entity: 'companies', field: 'name' },
  contact: { entity: 'contacts', field: 'name' },
  industry: { entity: 'industries', field: 'name' },
  knowledge: { entity: 'knowledge', field: 'title' },
  project: { entity: 'projects', field: 'name' },
}

const seg = (text: string, ...checks: SegmentCheck[]): SearchSegment => ({ text, checks })
const c = (entity: string, field: string): SegmentCheck => ({ entity, field })

function bodyOf(doc: SearchDocInput): string {
  return [doc.title, ...doc.aliases, ...doc.segments.map(s => s.text)].filter(Boolean).join('\n')
}

/** ソース（マスタ・ナレッジ・関係性）から全検索ドキュメントを構築する */
export async function buildSearchDocs(pool: pg.Pool): Promise<SearchDocInput[]> {
  const [companiesQ, contactsQ, industriesQ, projectsQ, knowledgeQ, membersQ, compRelsQ, contRelsQ] = await Promise.all([
    pool.query<{
      id: string; kind: string; name: string; aliases: string[]; industryIds: string[]
      primaryIndustryId: string; size: string; location: string; description: string
      ownerMemberId: string; fiscalStartMonth: number | null
    }>(
      `SELECT id, kind, name, aliases, industry_ids AS "industryIds", primary_industry_id AS "primaryIndustryId",
              size, location, description, owner_member_id AS "ownerMemberId", fiscal_start_month AS "fiscalStartMonth"
       FROM companies WHERE active = true ORDER BY id LIMIT 1000`),
    pool.query<{
      id: string; companyId: string; name: string; dept: string; title: string
      keyPerson: number; email: string; notes: string
    }>(
      `SELECT id, company_id AS "companyId", name, dept, title, key_person AS "keyPerson", email, notes
       FROM contacts WHERE active = true ORDER BY id LIMIT 2000`),
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM industries WHERE active = true ORDER BY display_order, id LIMIT 200`),
    pool.query<{
      id: string; name: string; companyId: string; type: string; status: string
      objective: string; ownerMemberId: string
    }>(
      `SELECT id, name, company_id AS "companyId", type, status, objective, owner_member_id AS "ownerMemberId"
       FROM projects WHERE active = true ORDER BY id LIMIT 1000`),
    pool.query<{ id: string; domain: string; targetId: string; title: string; body: string; tags: string[] }>(
      `SELECT id, domain, target_id AS "targetId", title, body, tags
       FROM knowledge_articles WHERE active = true ORDER BY id LIMIT 3000`),
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM members WHERE active = true ORDER BY id LIMIT 1000`),
    pool.query<{ fromCompanyId: string; toCompanyId: string; label: string; notes: string }>(
      `SELECT r.from_company_id AS "fromCompanyId", r.to_company_id AS "toCompanyId", rt.label, r.notes
       FROM company_relations r JOIN relation_types rt ON rt.id = r.relation_type_id LIMIT 5000`),
    pool.query<{ fromContactId: string; toContactId: string; label: string; notes: string }>(
      `SELECT r.from_contact_id AS "fromContactId", r.to_contact_id AS "toContactId", rt.label, r.notes
       FROM contact_relations r JOIN relation_types rt ON rt.id = r.relation_type_id LIMIT 5000`),
  ])

  const companyName = new Map(companiesQ.rows.map(x => [x.id, x.name]))
  const memberName = new Map(membersQ.rows.map(x => [x.id, x.name]))
  const contactName = new Map(contactsQ.rows.map(x => [x.id, x.name]))
  const industryName = new Map(industriesQ.rows.map(x => [x.id, x.name]))
  const docs: SearchDocInput[] = []

  // ---- 会社（自社・顧客）: プロフィール + 業界 + 担当 + 先方担当者 + 会社間の関係 + PJ + ナレッジ ----
  for (const co of companiesQ.rows) {
    const segments: SearchSegment[] = []
    segments.push(seg(co.kind === 'self' ? '区分: 自社' : '区分: 顧客', c('companies', 'kind')))
    if (co.description) segments.push(seg(`概要: ${co.description}`, c('companies', 'description')))
    if (co.location) segments.push(seg(`所在地: ${co.location}`, c('companies', 'location')))
    if (co.size) segments.push(seg(`規模: ${co.size}`, c('companies', 'size')))
    if (co.kind === 'self' && co.fiscalStartMonth) {
      segments.push(seg(`会計年度: ${co.fiscalStartMonth} 月始まり`, c('companies', 'fiscalStartMonth')))
    }
    const inds = (co.industryIds ?? []).map(id => industryName.get(id)).filter((x): x is string => !!x)
    if (inds.length > 0) {
      segments.push(seg(`業界: ${inds.join('・')}`, c('companies', 'industryIds'), c('industries', 'name')))
      // （主）は primaryIndustryId 由来のため別セグメント（deny 時は主指定だけが消える = 精密ブロックと同じ縮退）
      const primary = industryName.get(co.primaryIndustryId)
      if (primary) {
        segments.push(seg(`主業界: ${primary}`,
          c('companies', 'industryIds'), c('companies', 'primaryIndustryId'), c('industries', 'name')))
      }
    }
    const owner = memberName.get(co.ownerMemberId)
    if (owner) segments.push(seg(`自社担当: ${owner}`, c('companies', 'ownerMemberId'), c('members', 'name')))
    const cons = contactsQ.rows.filter(p => p.companyId === co.id).slice(0, 8)
    if (cons.length > 0) {
      // 役職（contacts.title）も含むためチェックへ追加（deny 時は行ごと消える = フェイルセーフ方向）
      segments.push(seg(`先方担当者: ${cons.map(p => `${p.name}${p.title ? `（${p.title}）` : ''}`).join(' / ')}`,
        c('contacts', 'name'), c('contacts', 'title')))
    }
    const rels = compRelsQ.rows.filter(r => r.fromCompanyId === co.id || r.toCompanyId === co.id).slice(0, 10)
    for (const r of rels) {
      const otherId = r.fromCompanyId === co.id ? r.toCompanyId : r.fromCompanyId
      const other = companyName.get(otherId)
      if (!other) continue
      const checks = [c('companies', 'name'), c('relation-types', 'label')]
      if (r.notes) checks.push(c('company-relations', 'notes'))
      segments.push(seg(
        `会社間の関係: ${r.fromCompanyId === co.id ? '→' : '←'} ${other}: ${r.label}${r.notes ? `（${capCp(r.notes, 80)}）` : ''}`,
        ...checks))
    }
    const pjs = projectsQ.rows.filter(p => p.companyId === co.id).slice(0, 10)
    if (pjs.length > 0) {
      segments.push(seg(`プロジェクト: ${pjs.map(p => `${p.name}（${p.status}）`).join(' / ')}`,
        c('projects', 'name'), c('projects', 'status')))
    }
    const ks = knowledgeQ.rows.filter(k => k.domain === 'company' && k.targetId === co.id).slice(0, 5)
    for (const k of ks) {
      segments.push(seg(`ナレッジ「${k.title}」: ${capCp(k.body, 200)}`, c('knowledge', 'title'), c('knowledge', 'body')))
    }
    docs.push({ sourceKind: 'company', sourceId: co.id, title: co.name, aliases: co.aliases ?? [], segments })
  }

  // ---- 顧客担当者（人）: プロフィール + 所属 + 人の関係 + ナレッジ ----
  for (const p of contactsQ.rows) {
    const segments: SearchSegment[] = []
    const compName = companyName.get(p.companyId)
    if (compName) segments.push(seg(`所属: ${compName}${p.dept ? ` ${p.dept}` : ''}`, c('companies', 'name'), c('contacts', 'dept')))
    if (p.title) segments.push(seg(`役職: ${p.title}`, c('contacts', 'title')))
    if (p.keyPerson) segments.push(seg(`キーパーソン度: ${p.keyPerson}`, c('contacts', 'keyPerson')))
    if (p.notes) segments.push(seg(`メモ: ${capCp(p.notes, 200)}`, c('contacts', 'notes')))
    const rels = contRelsQ.rows.filter(r => r.fromContactId === p.id || r.toContactId === p.id).slice(0, 10)
    for (const r of rels) {
      const otherId = r.fromContactId === p.id ? r.toContactId : r.fromContactId
      const other = contactName.get(otherId) ?? (memberName.get(otherId) ? `${memberName.get(otherId)}（自社）` : undefined)
      if (!other) continue
      const checks = [c('contacts', 'name'), c('members', 'name'), c('relation-types', 'label')]
      if (r.notes) checks.push(c('contact-relations', 'notes'))
      segments.push(seg(
        `人の関係: ${r.fromContactId === p.id ? '→' : '←'} ${other}: ${r.label}${r.notes ? `（${capCp(r.notes, 80)}）` : ''}`,
        ...checks))
    }
    const ks = knowledgeQ.rows.filter(k => k.domain === 'contact' && k.targetId === p.id).slice(0, 5)
    for (const k of ks) {
      segments.push(seg(`ナレッジ「${k.title}」: ${capCp(k.body, 200)}`, c('knowledge', 'title'), c('knowledge', 'body')))
    }
    docs.push({ sourceKind: 'contact', sourceId: p.id, title: p.name, aliases: [], segments })
  }

  // ---- 業界: 顧客の逆引き + 業界ナレッジ ----
  for (const ind of industriesQ.rows) {
    const segments: SearchSegment[] = []
    const customers = companiesQ.rows.filter(co => co.kind === 'customer' && (co.industryIds ?? []).includes(ind.id))
    if (customers.length > 0) {
      // 業界所属（companies.industryIds）の開示でもあるためチェックへ追加（精密な業界逆引きと同じ縮退）
      segments.push(seg(`この業界の顧客: ${customers.map(co => co.name).join('・')}`,
        c('companies', 'name'), c('companies', 'industryIds')))
    }
    const ks = knowledgeQ.rows.filter(k => k.domain === 'industry' && k.targetId === ind.id).slice(0, 5)
    for (const k of ks) {
      segments.push(seg(`ナレッジ「${k.title}」: ${capCp(k.body, 300)}`, c('knowledge', 'title'), c('knowledge', 'body')))
    }
    docs.push({ sourceKind: 'industry', sourceId: ind.id, title: `${ind.name}業界`, aliases: [ind.name], segments })
  }

  // ---- プロジェクト ----
  for (const pj of projectsQ.rows) {
    const segments: SearchSegment[] = []
    segments.push(seg(`状態: ${pj.status} / 種別: ${pj.type}`, c('projects', 'status'), c('projects', 'type')))
    const compName = companyName.get(pj.companyId)
    // PJ→顧客の紐付け（projects.companyId）の開示でもあるためチェックへ追加（R2 レビューの任意指摘）
    if (compName) segments.push(seg(`顧客: ${compName}`, c('companies', 'name'), c('projects', 'companyId')))
    if (pj.objective) segments.push(seg(`目的: ${capCp(pj.objective, 300)}`, c('projects', 'objective')))
    const owner = memberName.get(pj.ownerMemberId)
    if (owner) segments.push(seg(`担当: ${owner}`, c('projects', 'ownerMemberId'), c('members', 'name')))
    const ks = knowledgeQ.rows.filter(k => k.domain === 'project' && k.targetId === pj.id).slice(0, 5)
    for (const k of ks) {
      segments.push(seg(`ナレッジ「${k.title}」: ${capCp(k.body, 200)}`, c('knowledge', 'title'), c('knowledge', 'body')))
    }
    docs.push({ sourceKind: 'project', sourceId: pj.id, title: pj.name, aliases: [], segments })
  }

  // ---- ナレッジ（本文全文 = ドキュメント取込分を含む） ----
  for (const k of knowledgeQ.rows) {
    const segments: SearchSegment[] = []
    const target = k.domain === 'company'
      ? companyName.get(k.targetId)
      : k.domain === 'contact'
        ? contactName.get(k.targetId)
        : k.domain === 'industry'
          ? industryName.get(k.targetId)
          : k.domain === 'project'
            ? projectsQ.rows.find(p => p.id === k.targetId)?.name
            : undefined
    if (target) {
      const entity = k.domain === 'company' ? 'companies' : k.domain === 'contact' ? 'contacts' : k.domain === 'industry' ? 'industries' : 'projects'
      // ナレッジと対象の紐付け（knowledge.targetId）の開示でもあるためチェックへ追加
      segments.push(seg(`対象: ${target}（${k.domain}）`, c(entity, 'name'), c('knowledge', 'targetId')))
    }
    if ((k.tags ?? []).length > 0) segments.push(seg(`タグ: ${(k.tags ?? []).join('・')}`, c('knowledge', 'tags')))
    if (k.body) segments.push(seg(capCp(k.body, 1500), c('knowledge', 'body')))
    docs.push({ sourceKind: 'knowledge', sourceId: k.id, title: k.title, aliases: [], segments })
  }

  // ---- ノート（ぽいぽいポスト = 本人スコープ / 議事録 = 全員。バッチ7c） ----
  const { rows: noteRows } = await pool.query<{
    id: string; memberId: string; kind: string; title: string; body: string
    projectId: string | null; companyId: string | null; workCategoryId: string | null
  }>(
    `SELECT n.id, n.member_id AS "memberId", n.kind, n.title, n.body,
            n.project_id AS "projectId", n.company_id AS "companyId", n.work_category_id AS "workCategoryId"
     FROM notes n WHERE n.active = true ORDER BY n.id LIMIT 5000`)
  const { rows: wcRows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM work_categories WHERE active = true LIMIT 200`)
  const wcName = new Map(wcRows.map(x => [x.id, x.name]))
  const projName = new Map(projectsQ.rows.map(x => [x.id, x.name]))
  const projCompany = new Map(projectsQ.rows.map(x => [x.id, x.companyId]))
  for (const n of noteRows) {
    const segments: SearchSegment[] = []
    segments.push(seg(n.kind === 'poipoi' ? '種別: ぽいぽいポスト' : '種別: 議事録', c('notes', 'kind')))
    const links: string[] = []
    const linkChecks: SegmentCheck[] = []
    const pj = n.projectId ? projName.get(n.projectId) : undefined
    if (pj) { links.push(`プロジェクト: ${pj}`); linkChecks.push(c('projects', 'name')) }
    const co = n.companyId ? companyName.get(n.companyId) : undefined
    if (co) { links.push(`顧客: ${co}`); linkChecks.push(c('companies', 'name')) }
    const wc = n.workCategoryId ? wcName.get(n.workCategoryId) : undefined
    if (wc) { links.push(`業務種別: ${wc}`); linkChecks.push(c('work-categories', 'name')) }
    if (links.length > 0) segments.push(seg(links.join(' / '), ...linkChecks))
    // 投稿者はぽいぽいポストにも載せる（AI 参照範囲 'all' で他メンバーの投稿を参照するとき
    // 誰のフィードバックかが文脈に必要。バッチ7g）
    const author = memberName.get(n.memberId)
    if (author) segments.push(seg(n.kind === 'minutes' ? `登録者: ${author}` : `投稿者: ${author}`, c('members', 'name')))
    if (n.body) segments.push(seg(capCp(n.body, 1500), c('notes', 'body')))
    // 顧客未指定でもプロジェクト経由で顧客を補完する
    // （PJ のみ紐付けたノートが、別顧客の質問の混入防止フィルタを素通りしないように）
    const linkCompanyId = n.companyId ?? (n.projectId ? projCompany.get(n.projectId) ?? null : null)
    docs.push({
      sourceKind: 'note', sourceId: n.id, title: n.title, aliases: [], segments,
      ownerMemberId: n.kind === 'poipoi' ? n.memberId : null,
      links: {
        ...(linkCompanyId ? { companyId: linkCompanyId } : {}),
        ...(n.projectId ? { projectId: n.projectId } : {}),
      },
    })
  }

  // ---- 保管ドキュメント（F-09-3 本実装 = バッチ7l。抽出テキストがあるファイルのみ = AI が解釈できる対象） ----
  const { rows: docRows } = await pool.query<{
    id: string; name: string; tags: string[]; summary: string; extractedText: string
  }>(
    `SELECT id, name, tags, summary, extracted_text AS "extractedText"
     FROM documents
     WHERE active = true AND kind = 'file' AND (extracted_text <> '' OR summary <> '')
     ORDER BY id LIMIT 5000`)
  for (const d of docRows) {
    const segments: SearchSegment[] = []
    const tags = Array.isArray(d.tags) ? d.tags.map(String) : []
    if (tags.length > 0) segments.push(seg(`タグ: ${tags.join('・')}`, c('documents', 'tags')))
    if (d.summary) segments.push(seg(`概要: ${capCp(d.summary, 300)}`, c('documents', 'summary')))
    // 抽出本文の表示可否は summary（本文プレビュー相当）の deny に従う = 原本ダウンロードのガードと同一基準
    if (d.extractedText) segments.push(seg(capCp(d.extractedText, 1500), c('documents', 'summary')))
    docs.push({
      sourceKind: 'document', sourceId: d.id, title: d.name, aliases: [], segments,
      ownerMemberId: null,
    })
  }

  return docs
}

/** search_docs の全再生成（冪等 upsert + 消えたソースの削除 + 変更分のみ埋め込み） */
export async function rebuildSearchIndex(
  pool: pg.Pool,
  env: Env,
): Promise<{ docs: number; upserted: number; deleted: number; embedded: number }> {
  const docs = await buildSearchDocs(pool)
  const { rows: existing } = await pool.query<{
    sourceKind: string; sourceId: string; bodyHash: string; hasEmbedding: boolean; embeddingModel: string
  }>(
    `SELECT source_kind AS "sourceKind", source_id AS "sourceId", body_hash AS "bodyHash",
            (embedding IS NOT NULL) AS "hasEmbedding", embedding_model AS "embeddingModel"
     FROM search_docs`)
  const existingByKey = new Map(existing.map(r => [`${r.sourceKind}:${r.sourceId}`, r]))

  let upserted = 0
  const needEmbedding: { doc: SearchDocInput; body: string; hash: string }[] = []
  for (const doc of docs) {
    const body = bodyOf(doc)
    // ハッシュには segments（表示可否チェック込み）も含める: checks 定義の変更（レビュー指摘の
    // 権限チェック強化等）が本文不変でも既存行へ伝播するように（手動 reindex が回復パスとして機能する）
    const hash = createHash('sha256').update(body).update(JSON.stringify(doc.segments))
      .update(doc.ownerMemberId ?? '').update(JSON.stringify(doc.links ?? {})).digest('hex')
    const prev = existingByKey.get(`${doc.sourceKind}:${doc.sourceId}`)
    if (!prev || prev.bodyHash !== hash) {
      await pool.query(
        `INSERT INTO search_docs (id, source_kind, source_id, title, aliases, body, segments, body_hash, embedding, embedding_model, owner_member_id, links, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, '', $9, $10, now())
         ON CONFLICT (source_kind, source_id) DO UPDATE SET
           title = EXCLUDED.title, aliases = EXCLUDED.aliases, body = EXCLUDED.body,
           segments = EXCLUDED.segments, body_hash = EXCLUDED.body_hash,
           embedding = NULL, embedding_model = '', owner_member_id = EXCLUDED.owner_member_id,
           links = EXCLUDED.links, updated_at = now()`,
        [newId('sd'), doc.sourceKind, doc.sourceId, doc.title, JSON.stringify(doc.aliases),
          body, JSON.stringify(doc.segments), hash, doc.ownerMemberId ?? null,
          JSON.stringify(doc.links ?? {})])
      upserted++
      needEmbedding.push({ doc, body, hash })
    } else if (env.vertexProjectId && (!prev.hasEmbedding || prev.embeddingModel !== env.vertexEmbeddingModel)) {
      needEmbedding.push({ doc, body, hash })
    }
  }

  // 消えたソース行（削除・無効化）の掃除（派生キャッシュのため削除可）
  const currentKeys = new Set(docs.map(d => `${d.sourceKind}:${d.sourceId}`))
  let deleted = 0
  for (const prev of existing) {
    if (!currentKeys.has(`${prev.sourceKind}:${prev.sourceId}`)) {
      await pool.query(`DELETE FROM search_docs WHERE source_kind = $1 AND source_id = $2`,
        [prev.sourceKind, prev.sourceId])
      deleted++
    }
  }

  // 変更分のみ埋め込み（無効環境・失敗は null のまま = 字句検索で動作）
  let embedded = 0
  if (env.vertexProjectId && needEmbedding.length > 0) {
    const vectors = await embedDocuments(env, needEmbedding.map(n => n.body))
    if (vectors) {
      for (let i = 0; i < needEmbedding.length; i++) {
        const v = vectors[i]
        if (!v) continue
        // body_hash 一致を条件にする: 並行する再生成が新しい本文を upsert した後に、
        // 古い本文のベクトルで上書きして恒久化する競合を防ぐ（レビュー指摘 M2）
        const r = await pool.query(
          `UPDATE search_docs SET embedding = $3, embedding_model = $4
           WHERE source_kind = $1 AND source_id = $2 AND body_hash = $5`,
          [needEmbedding[i]!.doc.sourceKind, needEmbedding[i]!.doc.sourceId, JSON.stringify(v),
            env.vertexEmbeddingModel, needEmbedding[i]!.hash])
        embedded += r.rowCount ?? 0
      }
    }
  }
  return { docs: docs.length, upserted, deleted, embedded }
}

// ---------- 更新時の自動再生成（デバウンス・単一飛行・非ブロッキング = 原則4） ----------

/** search_docs の再生成が必要なマスタエンティティ（masters ルートの書込後フックが参照） */
export const SEARCH_RELEVANT_ENTITIES = new Set([
  'companies', 'contacts', 'industries', 'projects', 'knowledge',
  'relation-types', 'company-relations', 'contact-relations', 'members', 'work-categories',
])

let rebuildTimer: NodeJS.Timeout | null = null
let rebuilding = false
let dirty = false

export function scheduleSearchRebuild(pool: pg.Pool, env: Env, reason: string): void {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    void runRebuild(pool, env, reason)
  }, 1500)
  // タイマーは Node プロセスの終了を妨げない（テストランナーのハング防止）
  rebuildTimer.unref?.()
}

async function runRebuild(pool: pg.Pool, env: Env, reason: string): Promise<void> {
  if (rebuilding) {
    dirty = true
    return
  }
  rebuilding = true
  try {
    const r = await rebuildSearchIndex(pool, env)
    if (r.upserted > 0 || r.deleted > 0) {
      console.log(`search index rebuilt (${reason}): ${r.docs} docs, +${r.upserted} ~${r.deleted}- ${r.embedded} embedded`)
    }
  } catch (e) {
    console.warn('search index rebuild failed (non-blocking):', (e as Error).message)
  } finally {
    rebuilding = false
    if (dirty) {
      dirty = false
      scheduleSearchRebuild(pool, env, `${reason}:dirty`)
    }
  }
}

// ---------- 検索（チャットボット文脈の関連情報ブロック） ----------

export interface SearchHit {
  sourceKind: SearchDocInput['sourceKind']
  sourceId: string
  title: string
  segments: SearchSegment[]
  score: number
  /** note の所有者（null = 全員参照 = 議事録。値あり = poipoi = 本人） */
  ownerMemberId: string | null
  /** 紐付け（note のみ。混入防止フィルタ用） */
  links: { companyId?: string; projectId?: string }
}

/**
 * 質問に関連する検索ドキュメントの上位 K 件（字句 + 埋め込みのハイブリッド。埋め込み無効時は字句のみ）。
 * allOwners = true で本人スコープ（owner_member_id）の絞り込みを外す
 * （ぽいぽいポストの AI 参照範囲 'all' = 他メンバーの投稿も参照。バッチ7g・オペレーター指示 2026-07-19 #8）。
 * 不変条件: owner_member_id を持つのは source_kind = 'note'（ぽいぽいポスト）のみ。
 * 将来 owner 付きの別種別を追加しても poipoi の設定で漏れないよう、SQL 側でも note に限定する
 */
export async function searchDocsFor(
  pool: pg.Pool,
  env: Env | undefined,
  question: string,
  forMemberId: string,
  limit = 4,
  allOwners = false,
): Promise<SearchHit[]> {
  const { rows } = await pool.query<{
    sourceKind: SearchDocInput['sourceKind']; sourceId: string; title: string
    aliases: string[]; body: string; segments: SearchSegment[]; embedding: number[] | null
    ownerMemberId: string | null; links: { companyId?: string; projectId?: string } | null
  }>(
    `SELECT source_kind AS "sourceKind", source_id AS "sourceId", title, aliases, body, segments, embedding,
            owner_member_id AS "ownerMemberId", links
     FROM search_docs
     WHERE owner_member_id IS NULL OR owner_member_id = $1 OR ($2::boolean AND source_kind = 'note')
     ORDER BY id LIMIT 3000`, [forMemberId, allOwners])
  // 全件を都度メモリへ載せる設計は SME 規模（〜数千件）前提。上限超過時も ORDER BY id で
  // 決定的な部分集合になる。件数がこの規模を超える場合は pgvector 等への移行を検討する
  if (rows.length === 0) return []
  const qVec = env ? await embedQuery(env, question) : null
  const scored = rows.map((r) => {
    const lex = bigramCoverage(question, `${r.title}\n${(r.aliases ?? []).join('\n')}\n${r.body}`)
    const cos = qVec && r.embedding ? cosineSimilarity(qVec, r.embedding) : 0
    // 字句 0.2 / 埋め込み 0.62 を関連の下限とし、スコアは両者の最大値（片系統でも成立）
    const score = Math.max(lex >= 0.2 ? lex : 0, cos >= 0.62 ? cos : 0)
    return {
      sourceKind: r.sourceKind, sourceId: r.sourceId, title: r.title, segments: r.segments ?? [],
      score, ownerMemberId: r.ownerMemberId ?? null, links: r.links ?? {},
    }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, limit)
}
