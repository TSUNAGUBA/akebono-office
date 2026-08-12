/**
 * note（note.com）連携のドメインロジック（F-40 メディア分析の拡張）。
 * - 反応スナップショット（note_metrics）の集計（期間内の増分 = デルタ算出）
 * - AI フィードバックのヒューリスティック生成（LLM 失敗・無効環境のフォールバック = 原則4。
 *   media-insight.ts と同じく「集計にある事実のみから決定的に生成する」）
 * - 記事マークダウン → note エディタ用 HTML の変換（記事生成 media-article.ts と同じサブセット）
 *
 * フィードバックは MediaInsight と同じ骨格（executiveSummary / articles / actions）に
 * nextTopics を加えた形にする。media_insights（scope='note'）へそのまま保管でき、
 * 記事生成の fromInsightId ヒント抽出（insightHintsOf）とも互換になる（原則3）。
 */
import type { MediaAction, MediaFinding } from './media-insight'

/** note_metrics の 1 スナップショット行（API から渡す整形済みの形） */
export interface NoteSnapshotRow {
  noteKey: string
  /** YYYY-MM-DD */
  snapshotDate: string
  title: string
  likeCount: number
  commentCount: number
  /** 欠測（Cookie なし等で取得不可）は null。0 と区別する */
  viewCount: number | null
}

/** 記事別の集計（期間末の実数 + 期間内の増分） */
export interface NoteArticleStat {
  noteKey: string
  title: string
  likeCount: number
  commentCount: number
  viewCount: number | null
  /** 期間内の増分（期間内最初のスナップショットとの差。1 点しかない場合は 0） */
  likeDelta: number
  commentDelta: number
  /** 期間内のスナップショット数（1 = デルタ判定不能） */
  snapshots: number
}

export interface NoteMetricsSummary {
  periodFrom: string
  periodTo: string
  totalLikes: number
  totalComments: number
  totalLikeDelta: number
  totalCommentDelta: number
  /** 期間内増分の大きい順（同数はスキ実数順） */
  articles: NoteArticleStat[]
}

/** note の AI フィードバック（MediaInsight 互換の骨格 + 次記事のテーマ案） */
export interface NoteFeedback {
  executiveSummary: string
  /** 記事・テーマへのインサイト（insightHintsOf 互換: kind = win / issue / opportunity） */
  articles: MediaFinding[]
  /** 次に起こすべきアクション */
  actions: MediaAction[]
  /** 次の記事のテーマ案（記事生成のお題にそのまま使える文） */
  nextTopics: string[]
}

/**
 * スナップショット行 → 期間集計。行の期間フィルタは呼び出し側（SQL）で済んでいる前提だが、
 * from/to の再チェックも行う（多重防御）。デルタ = 期間内の最古スナップショットとの差。
 */
export function foldNoteSnapshots(
  rows: NoteSnapshotRow[], periodFrom: string, periodTo: string,
): NoteMetricsSummary {
  const byKey = new Map<string, NoteSnapshotRow[]>()
  for (const r of rows) {
    if (r.snapshotDate < periodFrom || r.snapshotDate > periodTo) continue
    const list = byKey.get(r.noteKey) ?? []
    list.push(r)
    byKey.set(r.noteKey, list)
  }
  const articles: NoteArticleStat[] = []
  for (const [noteKey, list] of byKey) {
    list.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
    const first = list[0]!
    const last = list[list.length - 1]!
    articles.push({
      noteKey,
      title: last.title || first.title,
      likeCount: last.likeCount,
      commentCount: last.commentCount,
      viewCount: last.viewCount,
      likeDelta: list.length > 1 ? last.likeCount - first.likeCount : 0,
      commentDelta: list.length > 1 ? last.commentCount - first.commentCount : 0,
      snapshots: list.length,
    })
  }
  articles.sort((a, b) => (b.likeDelta - a.likeDelta) || (b.likeCount - a.likeCount) || a.noteKey.localeCompare(b.noteKey))
  return {
    periodFrom,
    periodTo,
    totalLikes: articles.reduce((s, a) => s + a.likeCount, 0),
    totalComments: articles.reduce((s, a) => s + a.commentCount, 0),
    totalLikeDelta: articles.reduce((s, a) => s + a.likeDelta, 0),
    totalCommentDelta: articles.reduce((s, a) => s + a.commentDelta, 0),
    articles,
  }
}

/**
 * ヒューリスティックフィードバック（LLM 失敗・無効環境のフォールバック）。
 * 集計にある事実のみから決定的に生成する（推測で数値・事実を作らない）。
 */
export function heuristicNoteFeedback(summary: NoteMetricsSummary): NoteFeedback {
  const n = summary.articles.length
  const articles: MediaFinding[] = []
  const actions: MediaAction[] = []
  const nextTopics: string[] = []

  const top = summary.articles[0]
  if (top && (top.likeDelta > 0 || top.likeCount > 0)) {
    articles.push({
      kind: 'win',
      title: `「${top.title}」が最も反応を得ている`,
      detail: `スキ ${top.likeCount} 件（期間内 +${top.likeDelta}）・コメント ${top.commentCount} 件。読者の関心が最も高いテーマ。`,
    })
    actions.push({
      title: '反応上位テーマの深掘り記事を出す',
      detail: `「${top.title}」の続編・実践編で関心の高い読者層への接触を増やす。`,
      priority: 'high',
    })
    nextTopics.push(`「${top.title}」の深掘り・続編`)
  }
  const stale = summary.articles.filter(a => a.snapshots > 1 && a.likeDelta === 0 && a.commentDelta === 0)
  if (stale.length > 0 && n > 1) {
    articles.push({
      kind: 'issue',
      title: `期間内に反応が動かなかった記事が ${stale.length} 件`,
      detail: `${stale.slice(0, 3).map(a => `「${a.title}」`).join('・')} は期間内のスキ・コメント増がゼロ。タイトル・導入の見直し候補。`,
    })
    actions.push({
      title: '反応の止まった記事のタイトル・導入を見直す',
      detail: '既存記事の冒頭にまとめ・結論を追加し、反応上位記事から内部リンクを張る。',
      priority: 'mid',
    })
  }
  if (summary.totalComments > 0) {
    articles.push({
      kind: 'opportunity',
      title: `コメント ${summary.totalComments} 件は読者との接点`,
      detail: 'コメントへの返信・言及は次記事の題材とフォロー関係の起点になる。',
    })
  }
  actions.push({
    title: '記事末尾の CTA（問い合わせ導線）を確認する',
    detail: '各記事の末尾に顧問・相談の導線（プロフィール・問い合わせリンク）があるかを点検する。',
    priority: summary.totalLikeDelta > 0 ? 'high' : 'mid',
  })
  for (const a of summary.articles.slice(1, 3)) {
    if (a.likeDelta > 0) nextTopics.push(`「${a.title}」に関連する実践・事例`)
  }

  const head = n === 0
    ? `期間 ${summary.periodFrom}〜${summary.periodTo} に反応データがありません。まず記事を公開し、同期（反応収集）を実行してください。`
    : `期間 ${summary.periodFrom}〜${summary.periodTo} の公開記事 ${n} 件で、スキ計 ${summary.totalLikes} 件（期間内 +${summary.totalLikeDelta}）・コメント計 ${summary.totalComments} 件。`
  return {
    executiveSummary: head + (top && top.likeDelta > 0 ? ` 最も反応が伸びたのは「${top.title}」。` : ''),
    articles,
    actions,
    nextTopics,
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** インライン記法（**強調** のみ）。エスケープ済みテキストに適用する */
const inlineHtml = (s: string): string =>
  s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/**
 * 記事マークダウン（media-article.ts の生成サブセット: # 見出し・箇条書き・引用・**強調**・段落）→
 * note エディタ用 HTML。note の本文見出しは h2/h3 のみのため # → h2、##/### → h3 に写像する。
 * 表・画像・リンク・HTML は対象外（生成側も使わない）。入力の HTML はエスケープする。
 */
export function noteHtmlOf(markdown: string): string {
  const out: string[] = []
  let list: string[] = []
  const flushList = () => {
    if (list.length > 0) {
      out.push(`<ul>${list.map(li => `<li>${li}</li>`).join('')}</ul>`)
      list = []
    }
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (!trimmed) {
      flushList()
      continue
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (m) {
      flushList()
      const tag = m[1]!.length === 1 ? 'h2' : 'h3'
      out.push(`<${tag}>${inlineHtml(escapeHtml(m[2]!))}</${tag}>`)
      continue
    }
    if (/^[-*]\s+/.test(trimmed)) {
      list.push(inlineHtml(escapeHtml(trimmed.replace(/^[-*]\s+/, ''))))
      continue
    }
    if (trimmed.startsWith('> ')) {
      flushList()
      out.push(`<blockquote>${inlineHtml(escapeHtml(trimmed.slice(2)))}</blockquote>`)
      continue
    }
    flushList()
    out.push(`<p>${inlineHtml(escapeHtml(trimmed))}</p>`)
  }
  flushList()
  return out.join('')
}
