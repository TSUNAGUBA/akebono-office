/**
 * 顧客コンテキスト（改修依頼 2026-08-20）の入力検証 + AI リサーチの決定的ヒューリスティック。
 * API サービス / home モックモードで共有する = パリティの SoT（customer-log.ts / activity.ts と同じ設計）。
 * - 検証の返り値は「エラーメッセージ | null」。API 側は AKO-CTX-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - ヒューリスティック（候補リスト生成・定性情報の構築）は決定的（hashStrShared。Math.random 禁止）:
 *   モックモードの唯一のロジック / API モードの LLM（generateGroundedText / generateJson）
 *   失敗時のフォールバック（原則4）。候補 URL は example.com 系のダミーで「デモ」を明記する。
 */
import { hashStrShared } from './ai-tasks'
import { capCodePoints } from './customer-log'

/** 定性情報 4 項目（ビジョン・経営課題・補足メモ・事業メモ）それぞれの上限（コードポイント） */
export const CUSTOMER_CONTEXT_TEXT_CAP = 4000
/** Memo（時系列メモ）本文の上限（顧客活動 BODY_CAP と同値） */
export const CUSTOMER_CONTEXT_NOTE_CAP = 20_000
/** AI リサーチの検索ヒント（住所・電話・キーワード）の上限 */
export const CUSTOMER_CONTEXT_HINT_CAP = 200
/** AI リサーチで一度に採用できる情報源の上限 */
export const CUSTOMER_CONTEXT_SOURCES_MAX = 8

/** 定性情報の入力（customer_contexts の更新対象 4 項目。事業メモは改修依頼 2026-08-21 で追加） */
export interface CustomerContextInput {
  vision: string
  challenges: string
  strategyNotes: string
  /** 事業メモ（昨季売上高・社員数・店舗数・配送センター〔自社/他社・地域〕等の事業に関する事実） */
  businessNotes: string
}

/** 定性情報の正規化（trim + コードポイント cap = 保存形。API/モック共通。
 *  businessNotes は旧データ（未定義）を '' として受ける = 原則7） */
export function normalizeCustomerContext(
  input: Omit<CustomerContextInput, 'businessNotes'> & { businessNotes?: string },
): CustomerContextInput {
  return {
    vision: capCodePoints(input.vision.trim(), CUSTOMER_CONTEXT_TEXT_CAP),
    challenges: capCodePoints(input.challenges.trim(), CUSTOMER_CONTEXT_TEXT_CAP),
    strategyNotes: capCodePoints(input.strategyNotes.trim(), CUSTOMER_CONTEXT_TEXT_CAP),
    businessNotes: capCodePoints((input.businessNotes ?? '').trim(), CUSTOMER_CONTEXT_TEXT_CAP),
  }
}

/**
 * 定性情報の検証（正規化後の値で判定 = 空白のみの通過を防ぐ）。
 * 4 項目すべて空の保存は不可（「空の行」を作らない。項目単位の削除は他項目が残っていれば可能）
 */
export function customerContextError(input: Parameters<typeof normalizeCustomerContext>[0]): string | null {
  const n = normalizeCustomerContext(input)
  if (!n.vision && !n.challenges && !n.strategyNotes && !n.businessNotes) {
    return 'ビジョン・経営課題・補足メモ・事業メモのいずれかを入力してください'
  }
  return null
}

/**
 * 反映取消（revert）の復元値を構築する（API/モック共通の単一実装 = 原則3/6）。
 * 事業メモ（0084 = 2026-08-21 追加）が無い旧スナップショット（before に businessNotes キーなし）の
 * 復元は現在の事業メモを保持する（旧ノートの取消で新項目を消さない = 原則7）。
 * before に businessNotes: '' が保存された新ノートは '' へ復元する（キー有無で判定 = undefined のみ保持）。
 */
export function restoreContextFromSnapshot(
  before: { vision?: unknown; challenges?: unknown; strategyNotes?: unknown; businessNotes?: unknown },
  currentBusinessNotes: string,
): CustomerContextInput {
  return normalizeCustomerContext({
    vision: String(before.vision ?? ''),
    challenges: String(before.challenges ?? ''),
    strategyNotes: String(before.strategyNotes ?? ''),
    businessNotes: before.businessNotes === undefined
      ? currentBusinessNotes
      : String(before.businessNotes ?? ''),
  })
}

/** Memo（時系列メモ）の検証（本文必須。cap 後判定） */
export function customerContextNoteError(body: string): string | null {
  if (!capCodePoints(body.trim(), CUSTOMER_CONTEXT_NOTE_CAP)) return 'メモ本文を入力してください'
  return null
}

// ---------- 電話番号（会社マスタへの AI 反映 = 改修依頼 2026-08-21 第3弾） ----------

/** 電話番号の入力上限（companies.phone / contacts.phone と同じ自由入力。過大入力だけ抑止） */
export const CUSTOMER_CONTEXT_PHONE_CAP = 40

/** 電話番号の正規化（trim + cap。形式検証はしない = マスタの自由入力と同じ扱い） */
export function normalizeContextPhone(v: unknown): string {
  return capCodePoints(String(v ?? '').trim(), CUSTOMER_CONTEXT_PHONE_CAP)
}

/** 日本の電話番号らしい並び（0 始まり + ハイフン区切り）。国際表記等は対象外の意図的な最小実装 */
const PHONE_RE = /0\d{1,4}[-ー]\d{1,4}[-ー]\d{3,4}/

/**
 * 採用ソースの抜粋（snippet）から電話番号を抽出する（決定的。最初に見つかった 1 件）。
 * **抜粋に実在する記載だけを返し、無ければ ''**（電話番号の創作は絶対にしない =
 * LLM フォールバック時でも会社マスタへ架空の番号を書かない安全側の設計）。
 */
export function extractPhoneFromSnippets(snippets: readonly (string | undefined)[]): string {
  for (const s of snippets) {
    const m = PHONE_RE.exec(String(s ?? ''))
    if (m) return normalizeContextPhone(m[0].replace(/ー/g, '-'))
  }
  return ''
}

/**
 * AI 構築の提案値（定性情報 4 項目 + 会社マスタへの電話番号提案）。
 * phone = 情報源から取得できた代表電話（'' = 取得なし → 反映しても会社マスタの電話番号は変更しない）
 */
export interface CustomerContextBuildProposal extends CustomerContextInput {
  phone: string
}

/** AI リサーチの検索ヒント（社名は自動 = 呼び出し側が付与。住所/電話/キーワードは任意） */
export interface CustomerResearchHints {
  address?: string
  phone?: string
  keywords?: string
}

/** リサーチ候補（Web 検索結果のリスト表示 1 件分） */
export interface CustomerResearchCandidate {
  title: string
  uri: string
  snippet: string
}

/** 採用ソースの検証（1 件以上・http(s) URL・上限件数） */
export function customerContextSourcesError(sources: readonly { title?: unknown; uri?: unknown }[]): string | null {
  if (!Array.isArray(sources) || sources.length === 0) return '採用する情報源を 1 件以上選択してください'
  if (sources.length > CUSTOMER_CONTEXT_SOURCES_MAX) return `採用できる情報源は ${CUSTOMER_CONTEXT_SOURCES_MAX} 件までです`
  for (const s of sources) {
    const uri = String(s?.uri ?? '')
    if (!/^https?:\/\/.+/.test(uri)) return '情報源の URL が正しくありません（http/https のみ）'
  }
  return null
}

// ---------- 決定的ヒューリスティック（モックの唯一のロジック / LLM 失敗時のフォールバック） ----------

/** 36 進の短いハッシュ文字列（ダミー URL のパス生成用。決定的） */
function slugOf(key: string): string {
  return hashStrShared(key).toString(36)
}

/** キーから配列要素を決定的に選択（home utils/rng pick と同義。shared 側の自己完結実装） */
function pickBy<T>(key: string, arr: readonly T[]): T {
  return arr[hashStrShared(key) % arr.length] as T
}

const VISION_THEMES = [
  '現場の知見とデジタル技術を掛け合わせた持続的な事業成長',
  '地域・取引先とともに歩む共創型の事業基盤づくり',
  'データドリブンな意思決定による顧客体験の刷新',
  '本業の強みを核にした新規領域への段階的な展開',
] as const

const CHALLENGE_POOL = [
  '基幹業務の属人化と後継人材の育成',
  'データ活用・可視化の基盤整備の遅れ',
  '販路の多角化と新規顧客の開拓',
  '現場と経営の間の情報連携の強化',
  '人材の採用・定着と働き方の見直し',
  '既存システムの老朽化への対応',
] as const

const NEWS_TOPICS = [
  '業務効率化の取り組みが業界メディアで紹介',
  '新サービス展開に関するインタビュー記事',
  '地域連携プロジェクトの発表',
  'DX 推進体制の強化に関する報道',
] as const

/** 事業メモのデモ用ファクト（決定的に 2 件選ぶ。実数値を創作しない = 「デモ」明記の定型文） */
const BUSINESS_FACT_POOL = [
  '昨季売上高: 情報源に記載なし（デモ）',
  '従業員数: 会社概要ページに記載あり（デモ・数値は原文を参照）',
  '店舗・拠点: 主要拠点の一覧が公式サイトに掲載（デモ）',
  '物流: 配送センターの利用形態（自社/他社）は記事中に言及あり（デモ）',
  '主要取引先: 会社概要ページに記載あり（デモ）',
] as const

/**
 * リサーチ候補の決定的生成（モックモード / LLM 無効・失敗時のフォールバック = 原則4）。
 * 会社名から 3〜4 件の候補を生成する。URL は example.com 系のダミーで、タイトルに「デモ」を明記
 * （実在サイトと誤認させない）。ヒント（住所・電話・キーワード）は該当候補の抜粋へ反映する。
 */
export function heuristicResearchCandidates(
  companyName: string,
  hints: CustomerResearchHints = {},
): CustomerResearchCandidate[] {
  const name = companyName.trim() || '対象企業'
  const slug = slugOf(`ctx-slug:${name}`)
  const address = (hints.address ?? '').trim()
  const phone = (hints.phone ?? '').trim()
  const keywords = (hints.keywords ?? '').trim()
  const candidates: CustomerResearchCandidate[] = [
    {
      title: `${name} 公式サイト（デモ）`,
      uri: `https://example.com/company/${slug}/`,
      snippet: `${name}の公式サイト（デモ用のダミー URL）。企業理念・事業内容・沿革を掲載。`
        + (keywords ? `関連キーワード: ${keywords}。` : ''),
    },
    {
      title: `${name} 会社概要・アクセス（デモ）`,
      uri: `https://example.com/company/${slug}/about`,
      snippet: `会社概要ページ（デモ）。${address ? `所在地: ${address}。` : ''}${phone ? `代表電話: ${phone}。` : ''}`
        + '資本金・従業員数・主要取引先の一覧。',
    },
    {
      title: `${name}: ${pickBy(`ctx-news:${name}`, NEWS_TOPICS)}（デモ）`,
      uri: `https://news.example.com/articles/${slugOf(`ctx-news-uri:${name}`)}`,
      snippet: `業界ニュース記事（デモ）。${name}の${pickBy(`ctx-news:${name}`, NEWS_TOPICS)}。`
        + '経営方針や今後の展望についての言及あり。',
    },
    {
      title: `${name} 代表インタビュー（デモ）`,
      uri: `https://media.example.com/interview/${slugOf(`ctx-interview:${name}`)}`,
      snippet: `代表インタビュー記事（デモ）。「${pickBy(`ctx-vision:${name}`, VISION_THEMES)}」を目指す姿勢と、`
        + `${pickBy(`ctx-challenge:${name}:0`, CHALLENGE_POOL)}への課題認識を語る。`,
    },
  ]
  // 3〜4 件（会社名から決定的に分岐）
  const count = 3 + (hashStrShared(`ctx-cand-count:${name}`) % 2)
  return candidates.slice(0, count)
}

/**
 * 採用ソースからの定性情報の決定的構築（モックモード / LLM 失敗時のフォールバック = 原則4）。
 * 採用ソースの並び順に依存しないよう URI でソートしてから種を作る（同一入力 = 常に同一出力）。
 * current の既存値がある項目は「既存値を尊重しつつ追記」ではなく提案値として全置換候補を返す
 * （差分表示 → 反映確認は UI の責務。反映前の値は research ノートの payload.before に保存される）。
 */
export function heuristicContextBuild(
  companyName: string,
  sources: readonly CustomerContextResearchSourceLike[],
  current: CustomerContextInput,
): CustomerContextBuildProposal {
  const name = companyName.trim() || '対象企業'
  const sorted = [...sources].sort((a, b) => String(a.uri).localeCompare(String(b.uri)))
  const seed = `${name}|${sorted.map(s => s.uri).join(',')}`
  const theme = pickBy(`build-vision:${seed}`, VISION_THEMES)
  // 経営課題は 2〜3 件（重複しないようオフセットをずらして選ぶ）
  const n = 2 + (hashStrShared(`build-ch-count:${seed}`) % 2)
  const start = hashStrShared(`build-ch-start:${seed}`) % CHALLENGE_POOL.length
  const challenges = Array.from({ length: n }, (_, i) => CHALLENGE_POOL[(start + i) % CHALLENGE_POOL.length]!)
  // 事業メモ（改修依頼 2026-08-21）: 売上高・社員数・店舗数・配送センター等の「事業の事実」欄。
  // デモは実数値を創作せず「情報源に記載あり」の定型ファクトを決定的に 2 件選ぶ
  const factStart = hashStrShared(`build-biz-start:${seed}`) % BUSINESS_FACT_POOL.length
  const facts = Array.from({ length: 2 }, (_, i) => BUSINESS_FACT_POOL[(factStart + i) % BUSINESS_FACT_POOL.length]!)
  const titles = sorted.map(s => String(s.title ?? s.uri))
  const hasCurrent = current.vision || current.challenges || current.strategyNotes || current.businessNotes
  return {
    ...normalizeCustomerContext({
      vision: `「${theme}」を掲げ、中期的な事業発展を目指す（採用した ${sorted.length} 件の情報から構築）。`,
      challenges: challenges.map(c => `・${c}`).join('\n'),
      strategyNotes: `参考にした情報源: ${titles.join(' / ')}`
        + (hasCurrent ? '（反映前の値は自動追記されるリサーチノートから復元できます）' : ''),
      businessNotes: facts.map(f => `・${f}`).join('\n'),
    }),
    // 電話番号は採用ソースの抜粋に実在する記載だけを抽出（創作しない。改修依頼 2026-08-21 第3弾。
    // モックデモは調査ヒントに電話番号を入れると会社概要候補の抜粋へ載る → ここで拾える）
    phone: extractPhoneFromSnippets(sorted.map(s => s.snippet)),
  }
}

/** heuristicContextBuild が受け取る採用ソースの最小形（title + uri + 任意の抜粋） */
export interface CustomerContextResearchSourceLike {
  title: string
  uri: string
  snippet?: string
}
