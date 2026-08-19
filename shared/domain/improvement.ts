/**
 * 改善要望（F-42）のドメイン純関数（フロント/API 共有 = パリティの SoT）。
 *
 * 概要（オペレーター指示 2026-08-11）:
 * - 各ページから改善・改修の要望を記録する（investRequest = 追記系。SoT）。
 * - 要望は AI が「改修単位（ImprovementItem）」へ集約する（既存要望も含めて分解・まとめ）。
 *   AI は Vertex AI（api/src/lib/llm）を一次に使い、失敗時は本モジュールの決定的
 *   ヒューリスティック（heuristicClusterRequests）へフォールバックする（モックは常にこちら）。
 * - 改修単位は単一ステータス（未判定 → 対応する → 解決済み／対応しない）で管理し、
 *   解決済/未解決・対応可否でフィルターできる。
 * - フィルター結果を、コーディング AI エージェント向けの詳細プロンプト（buildCodingPrompt）へ出力する。
 *
 * データフロー整合性（原則6）:
 * - SoT = improvement_requests（生の要望・追記のみ・巻き戻さない）。
 * - improvement_items は要望から導出する集約キャッシュだが、**人手で付与したステータスは記録系**であり
 *   再集約で巻き戻してはならない（原則2）。このため集約は「未集約の要望のみ」を対象にし、
 *   既存 item は status='triage'（未判定・人手未対応）のものにのみ追記する。判定済み item は不変。
 */

import { isRealDateKey } from './jst'
import type { Result } from './types'

// ---------- ステータス（単一ステータスで一元管理。原則: 状態機械で活性と遷移検証を一致させる） ----------

/**
 * 改修単位の状態。
 * - triage   未判定（AI 集約直後。対応可否を人手で判定する前）
 * - accepted 対応する（対応可・未着手）
 * - in_progress 対応中（着手済み・未解決。改修依頼 2026-08-18 で「対応する」と「解決済み」の間に追加）
 * - resolved 解決済み（改修完了）
 * - rejected 対応しない（対応不可・見送り）
 */
export type ImprovementStatus = 'triage' | 'accepted' | 'in_progress' | 'resolved' | 'rejected'

export const IMPROVEMENT_STATUSES: ImprovementStatus[] = ['triage', 'accepted', 'in_progress', 'resolved', 'rejected']

/** ステータスの表示メタ（label・トーン・「未解決か」）。ラベルの SoT はここ。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_STATUS_META: Record<
  ImprovementStatus,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' | 'brand'; open: boolean }
> = {
  triage: { label: '未判定', tone: 'neutral', open: true },
  accepted: { label: '対応する', tone: 'info', open: true },
  in_progress: { label: '対応中', tone: 'brand', open: true },
  resolved: { label: '解決済み', tone: 'ok', open: false },
  rejected: { label: '対応しない', tone: 'warn', open: false },
}

/** 「未解決」= まだ改修が必要な状態（未判定・対応する・対応中）。解決済み/対応しないは決着済み */
export function isOpenStatus(status: ImprovementStatus): boolean {
  return IMPROVEMENT_STATUS_META[status]?.open ?? false
}

/**
 * 状態遷移（フロントのボタン活性と API の遷移検証を一致させる）。
 * 取消可能性（原則9.5）: 解決済み → 対応する（解決の取消 = reopen）、対応しない → 未判定/対応する
 * （見送りの撤回）、対応中 → 対応する（着手の取消 = 差し戻し）を許可し、
 * 「誤って解決/見送り/着手にしたら詰む」導線を作らない。
 * 対応中の追加（2026-08-18）: 対応する → 対応中 → 解決済み が主経路。従来の 対応する → 解決済み の
 * 直行も許可する（着手記録を経ない小さな改修の下位互換 = 原則7）。
 */
export const IMPROVEMENT_STATUS_NEXT: Record<ImprovementStatus, ImprovementStatus[]> = {
  triage: ['accepted', 'rejected'],
  accepted: ['in_progress', 'resolved', 'rejected', 'triage'],
  in_progress: ['resolved', 'accepted', 'rejected'],
  resolved: ['accepted'],
  rejected: ['triage', 'accepted'],
}

/** 遷移が許可されているか */
export function canTransition(from: ImprovementStatus, to: ImprovementStatus): boolean {
  return (IMPROVEMENT_STATUS_NEXT[from] ?? []).includes(to)
}

// ---------- 一覧フィルター（解決済/未解決 + 対応可否を 1 つの選択で束ねる） ----------

export type ImprovementFilter = 'all' | 'open' | 'committed' | 'triage' | 'accepted' | 'in_progress' | 'resolved' | 'rejected'

/** フィルターの選択肢（UI と共有。all = すべて / open = 未解決 / committed = 実装決定・未完了 = 対応する + 対応中） */
export const IMPROVEMENT_FILTER_OPTIONS: { value: ImprovementFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'open', label: '未解決' },
  { value: 'committed', label: '対応する・対応中' },
  { value: 'triage', label: '未判定' },
  { value: 'accepted', label: '対応する' },
  { value: 'in_progress', label: '対応中' },
  { value: 'resolved', label: '解決済み' },
  { value: 'rejected', label: '対応しない' },
]

/** 改修単位がフィルターに一致するか */
export function matchesImprovementFilter(status: ImprovementStatus, filter: ImprovementFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'open') return isOpenStatus(status)
  // committed = 「実装が決まっていて未完了」（対応中の追加 2026-08-18 で accepted 単独から拡張。ガント既定の意図を維持）
  if (filter === 'committed') return status === 'accepted' || status === 'in_progress'
  return status === filter
}

// ---------- 型 ----------

// ---------- 要望（request）単位のステータス（2026-08-17。改修単位のステータスとは独立） ----------

/**
 * 生要望のステータス。改修単位（item）のステータスが「改修 1 件」の進捗を表すのに対し、
 * こちらは**元となった要望 1 件ずつ**の対応状況を表す（部分的に対応済みの改修単位を表現できる）。
 * - open      未対応（既定。旧データ = status 未定義も open として扱う）
 * - resolved  対応済み（この要望の内容は反映済み）
 * - dismissed 見送り（この要望の内容は対応しない）
 * 遷移は自由（軽量な進捗タグ。誤操作はいつでも戻せる = 原則9.5）。
 */
export type ImprovementRequestStatus = 'open' | 'resolved' | 'dismissed'

export const IMPROVEMENT_REQUEST_STATUSES: ImprovementRequestStatus[] = ['open', 'resolved', 'dismissed']

/** 要望ステータスの表示メタ（label・トーン）。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_REQUEST_STATUS_META: Record<
  ImprovementRequestStatus,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' }
> = {
  open: { label: '未対応', tone: 'info' },
  resolved: { label: '対応済み', tone: 'ok' },
  dismissed: { label: '見送り', tone: 'warn' },
}

/** 要望のステータス（未定義 = 旧データは open。下位互換 = 原則7） */
export function requestStatusOf(r: { status?: ImprovementRequestStatus | null }): ImprovementRequestStatus {
  return r.status ?? 'open'
}

// ---------- 要望の選別（採用/不採用。AI 集約前の取捨選択 = 改善要望 2026-08-17 第 2 弾） ----------

/**
 * 生要望の選別状態。投稿された要望はまず管理者が一覧で確認・取捨選択し、
 * **採用（adopted）された要望のみが AI 集約の対象**になる（未選別・不採用は集約されない）。
 * - pending  未選別（投稿直後。管理者の確認待ち）
 * - adopted  採用（AI 集約の対象）
 * - declined 不採用（集約対象外。理由はコメントで残せる）
 * 遷移は自由（選び直しはいつでも可 = 原則9.5）。ただし集約済み（itemId あり）の要望は選別対象外
 * （既に改修単位へ取り込まれた記録 = 巻き戻さない。外すときは「集約の解除」（F-42-19・uncluster）
 * または要望の取消 = archive を使う）。
 */
export type ImprovementRequestAdoption = 'pending' | 'adopted' | 'declined'

export const IMPROVEMENT_REQUEST_ADOPTIONS: ImprovementRequestAdoption[] = ['pending', 'adopted', 'declined']

/** 選別状態の表示メタ（label・トーン）。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_REQUEST_ADOPTION_META: Record<
  ImprovementRequestAdoption,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' }
> = {
  pending: { label: '未選別', tone: 'neutral' },
  adopted: { label: '採用', tone: 'ok' },
  declined: { label: '不採用', tone: 'warn' },
}

/**
 * 要望の選別状態（下位互換 = 原則7）。旧データ（adoption 未定義）は、
 * 集約済み（itemId あり）= 採用相当 / 未集約 = 未選別 として扱う。
 */
export function requestAdoptionOf(r: { adoption?: ImprovementRequestAdoption | null; itemId?: string | null }): ImprovementRequestAdoption {
  if (r.adoption && IMPROVEMENT_REQUEST_ADOPTIONS.includes(r.adoption)) return r.adoption
  return r.itemId ? 'adopted' : 'pending'
}

/**
 * AI 集約の対象要望（未集約・有効・採用済み）を選ぶ。
 * mock の集約と API の generate SQL（`item_id IS NULL AND archived_at IS NULL AND adoption='adopted'`）の
 * 条件を共有する定義（両モード同挙動 = 原則6。「採用のみ集約」フローの単一の判定点）。
 */
export function clusterTargetRequests<T extends { itemId?: string | null; archivedAt?: string | null; adoption?: ImprovementRequestAdoption | null }>(
  requests: T[],
): T[] {
  return requests.filter(r => !r.itemId && !r.archivedAt && requestAdoptionOf(r) === 'adopted')
}

// ---------- 要望のタグ（壁打ち/お任せ。投稿時の任意の意思表示 = 改修依頼 2026-08-18） ----------

/**
 * 生要望の任意タグ（投稿時に複数付与できる意思表示）。
 * - brainstorm 壁打ち: 起票した内容について、壁打ち（対話での要件整理）を経て案件化したい
 * - entrust    お任せ: 受け取った内容を開発側の解釈で進めてよい
 * 旧データは tags 未定義 = タグ無し（下位互換 = 原則7）。
 */
export type ImprovementRequestTag = 'brainstorm' | 'entrust'

export const IMPROVEMENT_REQUEST_TAGS: ImprovementRequestTag[] = ['brainstorm', 'entrust']

/** タグの表示メタ（label・トーン・意味）。ラベルの SoT はここ。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_REQUEST_TAG_META: Record<
  ImprovementRequestTag,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn'; description: string }
> = {
  brainstorm: { label: '壁打ち', tone: 'info', description: '壁打ち（対話での要件整理）を経て案件化したい' },
  entrust: { label: 'お任せ', tone: 'ok', description: '受け取った内容を開発側の解釈で進めてよい' },
}

/** タグ入力の正規化（未知形の入力 → 既知タグのみ・重複除去の allowlist。不正値は落とす） */
export function normalizeImprovementTags(raw: unknown): ImprovementRequestTag[] {
  if (!Array.isArray(raw)) return []
  const out: ImprovementRequestTag[] = []
  for (const v of raw) {
    const s = String(v ?? '') as ImprovementRequestTag
    if (IMPROVEMENT_REQUEST_TAGS.includes(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** 要望への添付画像（縮小済み data URI。参照時は押下で拡大表示） */
export interface ImprovementRequestImage {
  /** 元ファイル名（表示・alt 用） */
  filename: string
  /** MIME タイプ（例: 'image/png'） */
  mime: string
  /** 縮小済み画像の data URI（IMPROVEMENT_IMAGE_DATA_RE / IMPROVEMENT_IMAGE_MAX_CHARS で検証） */
  dataUrl: string
}

/**
 * アプリ内ページパスか（NuxtLink の to に渡してよい形式か。F-42-20 の対象ページリンク化に伴う防御）。
 * '/' 始まりのみ許可し、'//'（プロトコル相対 URL = 外部遷移）・'/\'・空白を含むものは拒否する。
 * '' は対象外（全体/新設ページ = リンクにしない）。表示側 pageLinkOf と登録側の正規化が共に本判定を使う
 */
export function isInternalPagePath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') && !/\s/.test(p)
}

/**
 * 投稿元ページパスの正規化（登録時。API/モック共通）。アプリ内パスのみ保持し、
 * それ以外（'//evil.example' 等）は ''（全体/新設ページ扱い = pageLabel のみ）へ落とす。
 * 表示名 pageLabel は別項目として保持されるため情報は失わない（レビュー R1 監査 MAJOR-1）
 */
export function normalizeImprovementPagePath(pagePath: unknown): string {
  const p = String(pagePath ?? '').trim()
  return isInternalPagePath(p) ? p : ''
}

/**
 * 生の改善要望（SoT・追記系）。各ページの「要望を送る」から作られる。
 * pagePath / pageLabel は投稿元ページを記録し、改修プロンプトの対象ページ特定に使う。
 */
export interface ImprovementRequest {
  id: string
  /** 投稿者 */
  memberId: string
  /** 投稿者名（スナップショット。閲覧時のマスタ参照を避ける） */
  memberName: string
  /** 投稿元ページのパス（例: '/akebono/sales'。空 = 不明） */
  pagePath: string
  /** 投稿元ページの表示名（例: 'AKEBONO 売上'。空 = 不明） */
  pageLabel: string
  /** 要望本文 */
  body: string
  /** 要望単位のステータス（未定義 = open。改修単位のステータスとは独立の進捗タグ = 原則7） */
  status?: ImprovementRequestStatus
  /** 選別状態（未定義 = 旧データ = requestAdoptionOf が補完。採用のみ AI 集約対象 = 原則7） */
  adoption?: ImprovementRequestAdoption
  /** 任意タグ（壁打ち/お任せ。投稿時の意思表示 = 改修依頼 2026-08-18）。旧データは未定義 = 無し（原則7） */
  tags?: ImprovementRequestTag[]
  /**
   * 「集約の解除」（F-42-19）で外した改修単位 id の履歴（蓄積・クリアしない）。次回以降の AI 集約で
   * **これらの item へは再追記しない**（解除した要望が同じ単位へ戻り detail が重複する +
   * 元 item に残した「対象外」メモと矛盾する再流入を防ぐ = レビュー R6。二重解除でも履歴が効く）。
   * 未定義/空 = 制約なし（旧データ互換 = 原則7）。
   */
  excludedItemIds?: string[]
  /** 添付の URL リンク（複数可。参照時は別タブで開く）。旧データは未定義 = 無し（原則7） */
  links?: string[]
  /** 添付画像（複数可。参照時は押下で拡大）。旧データは未定義 = 無し（原則7） */
  images?: ImprovementRequestImage[]
  /** 集約先の改修単位 id（null = 未集約） */
  itemId: string | null
  /** 取消（論理削除）時刻。null = 有効（原則9.5） */
  archivedAt: string | null
  /** 本文の最終編集時刻（改修依頼 2026-08-18）。未定義/null = 未編集（旧データ互換 = 原則7） */
  editedAt?: string | null
  createdAt: string
}

/**
 * AI が集約した改修単位（改修 1 件の粒度）。ステータス・タイトル・改修内容は人手で編集しうる（記録系）。
 */
export interface ImprovementItem {
  id: string
  /** 改修単位の見出し */
  title: string
  /** 要約（一覧・プロンプト冒頭に使う 1〜2 文） */
  summary: string
  /** 改修内容の詳細（対象ページ・機能名・改修方針。マークダウン） */
  detail: string
  status: ImprovementStatus
  /** 対象ページのパス（集約元の要望から集約。重複なし） */
  pagePaths: string[]
  /** 集約元の要望 id（トレーサビリティ） */
  sourceRequestIds: string[]
  /** 直近の集約が LLM 生成か（false = ヒューリスティック/手動） */
  llm: boolean
  /** 取消（論理削除）時刻。null = 有効（原則9.5） */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  /** 解決済みにした時刻（null = 未解決） */
  resolvedAt: string | null
  /** 対応予定の開始日（YYYY-MM-DD・任意。null = 未定）。ガントチャートのバー開始 */
  planStart: string | null
  /** 対応予定の終了日（YYYY-MM-DD・任意。null = 開始日のみ = 単日）。ガントチャートのバー終了 */
  planEnd: string | null
}

/**
 * 生要望へのコメント（記録系・追記のみ = 改善要望 2026-08-17 第 2 弾）。
 * 採用/不採用の検討過程・不採用理由・確認事項などのやり取りを要望単位で時系列に残す。
 * 一覧参照は改善要望の管理権限者のみ / 追加・取消は管理権限者 + 投稿者本人（本人向けの閲覧導線は
 * 未提供 = implementation-status の残課題。現状は管理ページ内の記録）。取消は archivedAt（論理削除 = 原則9.5）。
 */
export interface ImprovementRequestComment {
  id: string
  /** 紐づく生要望 id */
  requestId: string
  /** 記入者 */
  memberId: string
  /** 記入者名（スナップショット。閲覧時のマスタ参照を避ける） */
  memberName: string
  /** コメント本文 */
  body: string
  /** 取消（論理削除）時刻。null = 有効（原則9.5） */
  archivedAt: string | null
  createdAt: string
}

/** 改修案件メモの種別（note = 一般メモ / reject = 「対応しない」判断の理由） */
export type ImprovementNoteKind = 'note' | 'reject'

export const IMPROVEMENT_NOTE_KINDS: ImprovementNoteKind[] = ['note', 'reject']

/**
 * 改修単位に紐づく時系列メモ（記録系・追記のみ）。
 * 改修方針の検討過程・保留理由・「対応しない」の判断理由などを 1 件ずつ時系列で残す。
 * AI 改修プロンプト生成時にも加味される（buildCodingPrompt）。取消は archivedAt（論理削除 = 原則9.5）。
 */
export interface ImprovementNote {
  id: string
  /** 紐づく改修単位 id */
  itemId: string
  /** 記入者 */
  memberId: string
  /** 記入者名（スナップショット。閲覧時のマスタ参照を避ける） */
  memberName: string
  /** メモ本文 */
  body: string
  /** 種別（note = 一般 / reject = 「対応しない」理由） */
  kind: ImprovementNoteKind
  /** 取消（論理削除）時刻。null = 有効（原則9.5） */
  archivedAt: string | null
  createdAt: string
}

// ---------- 入力検証（api = AKO-REQ-*（400）へ変換 / mock = Result のエラーへ変換） ----------

export const IMPROVEMENT_BODY_CAP = 4_000
export const IMPROVEMENT_PAGE_LABEL_CAP = 120
export const IMPROVEMENT_PAGE_PATH_CAP = 200
export const IMPROVEMENT_TITLE_CAP = 200
export const IMPROVEMENT_SUMMARY_CAP = 500
export const IMPROVEMENT_DETAIL_CAP = 20_000
export const IMPROVEMENT_NOTE_CAP = 2_000

/** コードポイント単位で cap（絵文字等を境界で壊さない。customer-log capCodePoints と同義の共有版） */
export function capCodePoints(s: string, n: number): string {
  const cps = [...s]
  return cps.length > n ? cps.slice(0, n).join('') : s
}

/** 要望本文の検証（必須・上限）。エラーメッセージ | null */
export function improvementBodyError(body: string): string | null {
  if (!body.trim()) return '要望の内容を入力してください'
  if ([...body].length > IMPROVEMENT_BODY_CAP) return `要望は ${IMPROVEMENT_BODY_CAP} 文字までで入力してください`
  return null
}

/**
 * 要望本文の編集可否ガード（F-42-16・2026-08-18）。判定順は API ルートと同一
 * （存在 404 → 権限 403 → 取消済み 409 = 権限の無い第三者へ取消状態を漏らさない）。
 * mock（useImprovements.editRequest）が使用し、API と同じ判定を単体テストで固定する。
 */
export function improvementEditError(
  target: { memberId: string; archivedAt: string | null } | undefined,
  userId: string,
  canManage: boolean,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (target.memberId !== userId && !canManage) {
    return { code: 'AKO-PRM-001', message: '要望の編集は投稿者本人または管理権限者のみ可能です' }
  }
  if (target.archivedAt) {
    return { code: 'AKO-REQ-015', message: '取消済みの要望は編集できません（先に復元してください）' }
  }
  return null
}

/** 要望編集で更新できる項目（改修依頼 2026-08-19: 登録時の項目をすべて編集可能に）。
 *  投稿元（pagePath/pageLabel）は記録として不変・編集対象外。
 *  **部分更新**: body は常に必須だが tags/links/images はリクエストに実在するキーのみ返す
 *  （送っていない項目は呼び出し側で保持する = CLAUDE.md「部分更新で未指定列を保持する」原則）。 */
export interface ImprovementRequestEditFields {
  body: string
  tags?: ImprovementRequestTag[]
  links?: string[]
  images?: ImprovementRequestImage[]
}

/**
 * 要望編集の入力を正規化 + 検証する純関数（API/モック共通 = パリティ）。
 * 本文（必須・上限）・タグ（allowlist 正規化）・リンク（形式/件数）・画像（形式/件数/上限）を
 * 投稿時（improvementRequestInputOf）と同一のルールで検証する。エラーは {code,message}
 * （AKO-REQ-001 本文 / AKO-REQ-009 リンク / AKO-REQ-010 画像）、成功は正規化済みフィールドを返す。
 * **部分更新**: リクエスト body に実在するキー（tags/links/images）のみ value に含める。
 * 送っていない項目は更新対象から外し、呼び出し側が現行値を保持する（CLAUDE.md の部分更新の鉄則）。
 * UI（RequestEditForm）は常に全項目を送るため実質的な全項目編集になるが、body だけの編集で
 * 添付が消える事故は起きない。空配列を明示的に送れば「全削除」になる（キーが実在するため）。
 */
export function improvementRequestEditFields(
  raw: { body?: unknown; tags?: unknown; links?: unknown; images?: unknown },
): { ok: true; value: ImprovementRequestEditFields } | { ok: false; error: { code: string; message: string } } {
  const text = String(raw.body ?? '').trim()
  const bodyMsg = improvementBodyError(text)
  if (bodyMsg) return { ok: false, error: { code: 'AKO-REQ-001', message: bodyMsg } }
  const value: ImprovementRequestEditFields = { body: capCodePoints(text, IMPROVEMENT_BODY_CAP) }
  if (Object.hasOwn(raw, 'tags')) value.tags = normalizeImprovementTags(raw.tags)
  if (Object.hasOwn(raw, 'links')) {
    const links = normalizeImprovementLinks(raw.links)
    const linksMsg = improvementLinksError(links)
    if (linksMsg) return { ok: false, error: { code: 'AKO-REQ-009', message: linksMsg } }
    value.links = links
  }
  if (Object.hasOwn(raw, 'images')) {
    const images = normalizeImprovementImages(raw.images)
    const imagesMsg = improvementImagesError(images)
    if (imagesMsg) return { ok: false, error: { code: 'AKO-REQ-010', message: imagesMsg } }
    value.images = images
  }
  return { ok: true, value }
}

/**
 * 選別変更の可否ガード（1 件。F-42-14/18/19）。判定順 = 存在（404）→ **取消済み（409）→ 集約済み（409）**。
 * 取消済みを先に判定する: 取消済み + 集約済みの行で「集約の解除」を案内すると、解除も取消済みで
 * AKO-REQ-018 になり案内が行き止まりになる（正しい最初の一手 = 復元 を先に伝える = レビュー R10）。
 * mock の setRequestAdoption・planAdoptionBulk（一括仕分け）・API ルートの 3 か所で共有し、
 * ガード条件とメッセージの分散コピーを作らない（原則3/6。レビュー R2）。
 */
export function improvementAdoptionError(
  target: { itemId?: string | null; archivedAt?: string | null } | undefined,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (target.archivedAt) return { code: 'AKO-REQ-019', message: '取消済みの要望は選別を変更できません（先に復元してください）' }
  if (target.itemId) return { code: 'AKO-REQ-013', message: '集約済みの要望は選別を変更できません（対象から外す場合は「集約の解除」または要望の取消を使ってください）' }
  return null
}

/**
 * 一括選別（F-42-18・改修依頼 2026-08-18）の対象仕分け（純関数）。ids を重複除去し、
 * 「適用できる id」と「適用できない件数の最後の理由」へ仕分ける。判定は improvementAdoptionError
 * （存在 AKO-REQ-002・取消済み AKO-REQ-019・集約済み AKO-REQ-013）を 1 件ずつ適用。
 * mock の一括更新と単体テストで共有する（API モードは既存 1 件エンドポイントの逐次呼びで
 * サーバー側が同じ判定を行う = 原則6）。done/failed の算定は
 * done = applicable.length / failed = targets.length - done。
 */
export function planAdoptionBulk(
  ids: string[],
  requests: { id: string; itemId?: string | null; archivedAt?: string | null }[],
): { targets: string[]; applicable: string[]; lastError: { code: string; message: string } | null } {
  const targets = [...new Set(ids)]
  const byId = new Map(requests.map(r => [r.id, r]))
  const applicable: string[] = []
  let lastError: { code: string; message: string } | null = null
  for (const id of targets) {
    const guard = improvementAdoptionError(byId.get(id))
    if (guard) {
      lastError = guard
      continue
    }
    applicable.push(id)
  }
  return { targets, applicable, lastError }
}

/**
 * 集約解除の可否ガード（F-42-19・改修依頼 2026-08-18）。集約済みの要望を改修単位から外し、
 * 「採用済み（集約待ち）」へ戻す = 再度 AI 集約の対象にする操作の共通判定。
 * 判定順 = 存在（404）→ 未集約（409）→ 取消済み（409）→ **取消済み item（409）→ 決着済み item（409）**。
 * item（任意）を渡すと、集約先が取消済み（AKO-REQ-022 = 先に復元）または決着済み
 * （解決済み/対応しない）の場合に AKO-REQ-021 を返す:
 * 判定済み item の元要望トレースを黙って書き換えず、実装済み内容を再集約プールへ戻さない（原則2 =
 * レビュー R18）。解除したい場合は先に reopen（ステータスを戻す）してから解除する（導線は残る = 原則9.5）。
 * 管理権限の確認は呼び出し側（API = requireManage）。
 * mock（useImprovements.unclusterRequest）と API ルートで共有し、単体テストで固定する（parity = 原則6）。
 */
export function improvementUnclusterError(
  target: { itemId: string | null; archivedAt: string | null } | undefined,
  item?: { status: ImprovementStatus; archivedAt?: string | null } | null,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (!target.itemId) return { code: 'AKO-REQ-017', message: 'この要望は集約されていません（解除は不要です）' }
  if (target.archivedAt) return { code: 'AKO-REQ-018', message: '取消済みの要望は集約を解除できません（先に復元してください）' }
  // 取消済みの item からも解除しない（論理削除中の記録のトレースを黙って書き換えない = レビュー R24。先に復元）
  if (item?.archivedAt) {
    return { code: 'AKO-REQ-022', message: '取消済みの改修単位からは解除できません（先に改修単位を復元してください）' }
  }
  if (item && !isOpenStatus(item.status)) {
    return { code: 'AKO-REQ-021', message: '決着済み（解決済み/対応しない）の改修単位からは解除できません（先に改修単位のステータスを戻してから解除してください）' }
  }
  return null
}

/**
 * 集約解除（F-42-19）時に**元の改修単位へ残す修正メモの本文**（mock/API 共有 = 同一文言・原則6）。
 * item の detail（人手編集されうるテキスト = 原則2で書き換えない）には解除した要望の記載が残るため、
 * 時系列メモとして「対象から外れた」ことを記録する。メモは buildCodingPrompt の担当者メモに載り、
 * 旧記載の要望をコーディング AI が実装対象に含めないよう伝える。
 */
export function buildUnclusterNoteBody(requestBody: string): string {
  const flat = requestBody.trim().replace(/\s*\n\s*/g, ' ')
  const head = capCodePoints(flat, 60)
  const ellipsis = [...flat].length > 60 ? '…' : ''
  return capCodePoints(
    `【集約の解除】元要望「${head}${ellipsis}」はこの改修単位の対象から外れました（改修内容の記載に残っていても実装対象に含めないこと）`,
    IMPROVEMENT_NOTE_CAP,
  )
}

// ---------- 添付（URL リンク・画像。api = AKO-REQ-009/010（400）/ mock = Result エラー） ----------

export const IMPROVEMENT_LINKS_MAX = 5
export const IMPROVEMENT_LINK_CAP = 500
export const IMPROVEMENT_IMAGES_MAX = 4
/** 画像 data URI の上限文字数（フロント utils/thumb の IMAGE_MAX_CHARS・商品画像 API と一致） */
export const IMPROVEMENT_IMAGE_MAX_CHARS = 400_000
export const IMPROVEMENT_IMAGE_NAME_CAP = 200

/** 添付画像の data URI 形式 allowlist（akebono-trade の商品画像と同一 = 原則3） */
export const IMPROVEMENT_IMAGE_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** リンク入力の正規化（未知形の入力 → trim 済み・空除去・重複除去の string[]。件数上限は error 関数で検証） */
export function normalizeImprovementLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const s = String(v ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 添付リンクの検証（任意・複数）。エラーメッセージ | null */
export function improvementLinksError(links: string[]): string | null {
  if (links.length > IMPROVEMENT_LINKS_MAX) return `リンクは ${IMPROVEMENT_LINKS_MAX} 件までです`
  for (const url of links) {
    if ([...url].length > IMPROVEMENT_LINK_CAP) return `リンク URL は ${IMPROVEMENT_LINK_CAP} 文字までです`
    if (!/^https?:\/\/\S+$/i.test(url)) return 'リンクは http(s):// で始まる URL を入力してください'
  }
  return null
}

/** 画像入力の正規化（未知形の入力 → filename/mime を補完した配列。形式・上限は error 関数で検証） */
export function normalizeImprovementImages(raw: unknown): ImprovementRequestImage[] {
  if (!Array.isArray(raw)) return []
  const out: ImprovementRequestImage[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const dataUrl = String(o.dataUrl ?? '').trim()
    if (!dataUrl) continue
    // mime は data URI から導出（入力の mime は元ファイルの型で、縮小再エンコード後の実体とずれうる = 保存しない）
    const mimeOfDataUrl = /^data:([a-z0-9.+/-]+);/i.exec(dataUrl)?.[1]
    out.push({
      filename: capCodePoints(String(o.filename ?? '').trim() || 'image', IMPROVEMENT_IMAGE_NAME_CAP),
      mime: capCodePoints(mimeOfDataUrl ?? (String(o.mime ?? '').trim() || 'image/*'), 100),
      dataUrl,
    })
  }
  return out
}

/** 添付画像の検証（任意・複数）。エラーメッセージ | null */
export function improvementImagesError(images: ImprovementRequestImage[]): string | null {
  if (images.length > IMPROVEMENT_IMAGES_MAX) return `画像は ${IMPROVEMENT_IMAGES_MAX} 件までです`
  for (const img of images) {
    if (img.dataUrl.length > IMPROVEMENT_IMAGE_MAX_CHARS) return '画像が大きすぎます（縮小しても上限を超えています。別の画像をお試しください）'
    if (!IMPROVEMENT_IMAGE_DATA_RE.test(img.dataUrl)) return '画像の形式が不正です（PNG / JPEG / WebP / GIF のみ添付できます）'
  }
  return null
}

/** 改修単位の見出し検証（編集時。必須・上限） */
export function improvementTitleError(title: string): string | null {
  if (!title.trim()) return '見出しを入力してください'
  if ([...title].length > IMPROVEMENT_TITLE_CAP) return `見出しは ${IMPROVEMENT_TITLE_CAP} 文字までです`
  return null
}

/** メモ本文の検証（追加時。必須・上限）。エラーメッセージ | null */
export function improvementNoteError(body: string): string | null {
  if (!body.trim()) return 'メモの内容を入力してください'
  if ([...body].length > IMPROVEMENT_NOTE_CAP) return `メモは ${IMPROVEMENT_NOTE_CAP} 文字までで入力してください`
  return null
}

export const IMPROVEMENT_COMMENT_CAP = 2_000

/** 生要望コメント本文の検証（追加時。必須・上限）。エラーメッセージ | null */
export function improvementCommentError(body: string): string | null {
  if (!body.trim()) return 'コメントの内容を入力してください'
  if ([...body].length > IMPROVEMENT_COMMENT_CAP) return `コメントは ${IMPROVEMENT_COMMENT_CAP} 文字までで入力してください`
  return null
}

/**
 * 対応予定期間の検証（任意）。開始・終了は空文字（= 未設定/クリア）を許容。
 * 設定する場合は実在日で、終了は開始以降であること。エラーメッセージ | null。
 * 終了のみ指定（開始なし）は不可（バーの起点が定まらない）。
 */
export function improvementPlanError(planStart: string, planEnd: string): string | null {
  const s = planStart.trim()
  const e = planEnd.trim()
  if (s && !isRealDateKey(s)) return '対応予定の開始日が正しくありません'
  if (e && !isRealDateKey(e)) return '対応予定の終了日が正しくありません'
  if (e && !s) return '終了日を設定する場合は開始日も設定してください'
  if (s && e && e < s) return '対応予定の終了日は開始日以降にしてください'
  return null
}

// ---------- 集約（クラスタリング） ----------

/** 集約対象の生要望（構造的最小型 = mock 行・DB 行どちらからも渡せる） */
export interface ClusterRequestInput {
  id: string
  pagePath: string
  pageLabel: string
  body: string
  /** 「集約の解除」で外した item の履歴（そこへは再追記しない = F-42-19）。省略/空 = 制約なし */
  excludeItemIds?: string[] | null
}

/** 集約先候補の既存改修単位（未集約要望の追記先判定に使う） */
export interface ClusterOpenItem {
  id: string
  status: ImprovementStatus
  pagePaths: string[]
}

/**
 * 集約計画（純粋な指示データ。永続化は呼び出し側 = route/composable）。
 * - appends: 既存の未判定 item へ要望を追記する
 * - creates: 新しい改修単位を作る（tempKey は creates 内の一意キー = LLM/呼出側の参照用）
 */
export interface ClusterPlan {
  appends: { itemId: string; requestIds: string[] }[]
  creates: { title: string; summary: string; detail: string; pagePaths: string[]; requestIds: string[] }[]
}

/** 投稿元ページのグルーピングキー（パス優先・空はページ名・どちらも空は '全般'） */
function groupKeyOf(r: ClusterRequestInput): string {
  return r.pagePath.trim() || r.pageLabel.trim() || '全般'
}

/** ページ表示名（パスから引けないときのフォールバックは '全般'） */
function labelOf(reqs: ClusterRequestInput[]): string {
  return reqs.find(r => r.pageLabel.trim())?.pageLabel.trim()
    || reqs.find(r => r.pagePath.trim())?.pagePath.trim()
    || '全般'
}

/** 改修単位の詳細本文（対象ページ + 元要望の列挙）を組み立てる */
export function buildItemDetail(reqs: ClusterRequestInput[]): string {
  const label = labelOf(reqs)
  const paths = [...new Set(reqs.map(r => r.pagePath.trim()).filter(Boolean))]
  const lines: string[] = []
  lines.push(`### 対象ページ: ${label}${paths.length ? `（${paths.map(p => `\`${p}\``).join(' / ')}）` : ''}`)
  lines.push('')
  lines.push(`**寄せられた要望 ${reqs.length} 件:**`)
  reqs.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.body.trim().replace(/\s*\n\s*/g, ' ')}`)
  })
  return capCodePoints(lines.join('\n'), IMPROVEMENT_DETAIL_CAP)
}

/**
 * 決定的な集約（LLM 無効・失敗時のフォールバック / モックの唯一のロジック）。
 * 未集約の要望を投稿元ページ単位でまとめ、同じページを対象にした既存の **未判定（triage）** item が
 * あればそこへ追記、無ければ新しい改修単位を作る。判定済み（accepted/resolved/rejected）item には
 * 触れない = 人手のステータス・編集を巻き戻さない（原則2）。
 */
export function heuristicClusterRequests(
  openItems: ClusterOpenItem[],
  requests: ClusterRequestInput[],
): ClusterPlan {
  const plan: ClusterPlan = { appends: [], creates: [] }
  // 追記先にできるのは未判定の item のみ（判定済みは不変）
  const triageItems = openItems.filter(it => it.status === 'triage')

  // ページ単位にグルーピング（安定順 = requests の登場順）
  const groups = new Map<string, ClusterRequestInput[]>()
  for (const r of requests) {
    const key = groupKeyOf(r)
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }

  for (const [key, reqs] of groups) {
    // 追記先は**要望ごと**に解決する。「集約の解除」で外された要望（excludeItemIds = 解除履歴）は
    // その item 群を避け（F-42-19 = 解除 → 再集約が同じ単位への往復 + detail 重複にならない。
    // 履歴は蓄積のため二重解除でも過去の item へ戻らない = レビュー R6）、
    // 除外の無い要望は従来どおり最初に合致した triage item へ追記する（除外者と同じグループでも
    // 巻き添えで新規作成へ流さない = normalizeClusterPlan の要望単位の除外と同じ規則。レビュー R2）。
    // 追記先が見つからない要望だけをまとめて新規作成する
    const appendsForItem = new Map<string, ClusterRequestInput[]>()
    const rest: ClusterRequestInput[] = []
    for (const r of reqs) {
      const target = triageItems.find(it => it.pagePaths.includes(key) && !(r.excludeItemIds ?? []).includes(it.id))
      if (target) {
        const arr = appendsForItem.get(target.id)
        if (arr) arr.push(r)
        else appendsForItem.set(target.id, [r])
      } else {
        rest.push(r)
      }
    }
    for (const [itemId, rs] of appendsForItem) {
      plan.appends.push({ itemId, requestIds: rs.map(r => r.id) })
    }
    if (rest.length === 0) continue
    const label = labelOf(rest)
    const paths = [...new Set(rest.map(r => r.pagePath.trim()).filter(Boolean))]
    plan.creates.push({
      title: capCodePoints(`「${label}」の改善要望（${rest.length} 件）`, IMPROVEMENT_TITLE_CAP),
      summary: capCodePoints(rest[0]!.body.trim().replace(/\s*\n\s*/g, ' '), IMPROVEMENT_SUMMARY_CAP),
      detail: buildItemDetail(rest),
      pagePaths: paths.length ? paths : [key],
      requestIds: rest.map(r => r.id),
    })
  }
  return plan
}

// ---------- LLM 集約（Vertex AI の構造化 JSON 出力用スキーマ + 正規化） ----------

/**
 * LLM への出力スキーマ（generateJson の responseSchema）。
 * appends/creates とも requestIds で元要望を指す。creates は改修単位の見出し・要約・詳細を LLM が起こす。
 */
export const CLUSTER_LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    appends: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          requestIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['itemId', 'requestIds'],
      },
    },
    creates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
          pagePaths: { type: 'array', items: { type: 'string' } },
          requestIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'detail', 'requestIds'],
      },
    },
  },
  required: ['creates'],
}

/**
 * LLM の集約出力を検証・正規化する。無効な id を捨て、1 要望が二重に割り当てられないようにし、
 * 未割当の要望はヒューリスティックで補完する。全く使えない出力なら null（呼び出し側でフォールバック）。
 */
export function normalizeClusterPlan(
  raw: unknown,
  requests: ClusterRequestInput[],
  openItems: ClusterOpenItem[],
): ClusterPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const reqById = new Map(requests.map(r => [r.id, r]))
  const triageIds = new Set(openItems.filter(it => it.status === 'triage').map(it => it.id))
  const used = new Set<string>()
  const plan: ClusterPlan = { appends: [], creates: [] }

  const takeReqs = (ids: unknown): ClusterRequestInput[] => {
    if (!Array.isArray(ids)) return []
    const out: ClusterRequestInput[] = []
    for (const id of ids) {
      const key = String(id ?? '')
      const r = reqById.get(key)
      if (r && !used.has(key)) {
        used.add(key)
        out.push(r)
      }
    }
    return out
  }

  const rawObj = raw as { appends?: unknown; creates?: unknown }
  for (const a of Array.isArray(rawObj.appends) ? rawObj.appends : []) {
    if (!a || typeof a !== 'object') continue
    const itemId = String((a as { itemId?: unknown }).itemId ?? '')
    if (!triageIds.has(itemId)) continue // 追記先は未判定 item のみ（判定済みは保護）
    const reqs = takeReqs((a as { requestIds?: unknown }).requestIds)
    // 「集約の解除」で外した item（履歴）への再追記は LLM 出力でも禁止（F-42-19）。
    // 除外に当たった要望は未割当へ戻し、末尾のヒューリスティック補完（除外対応済み）で拾う
    const allowed = reqs.filter(r => !(r.excludeItemIds ?? []).includes(itemId))
    for (const r of reqs) {
      if ((r.excludeItemIds ?? []).includes(itemId)) used.delete(r.id)
    }
    if (allowed.length) plan.appends.push({ itemId, requestIds: allowed.map(r => r.id) })
  }
  for (const c of Array.isArray(rawObj.creates) ? rawObj.creates : []) {
    if (!c || typeof c !== 'object') continue
    const obj = c as Record<string, unknown>
    const reqs = takeReqs(obj.requestIds)
    if (!reqs.length) continue
    const title = capCodePoints(String(obj.title ?? '').trim() || `「${labelOf(reqs)}」の改善要望`, IMPROVEMENT_TITLE_CAP)
    const paths = Array.isArray(obj.pagePaths)
      ? [...new Set(obj.pagePaths.map(p => String(p ?? '').trim()).filter(Boolean))]
      : [...new Set(reqs.map(r => r.pagePath.trim()).filter(Boolean))]
    plan.creates.push({
      title,
      summary: capCodePoints(String(obj.summary ?? '').trim() || reqs[0]!.body.trim(), IMPROVEMENT_SUMMARY_CAP),
      detail: capCodePoints(String(obj.detail ?? '').trim() || buildItemDetail(reqs), IMPROVEMENT_DETAIL_CAP),
      pagePaths: paths.length ? paths : [groupKeyOf(reqs[0]!)],
      requestIds: reqs.map(r => r.id),
    })
  }

  // 未割当の要望はヒューリスティックで補完（LLM が取りこぼしても要望を失わない）
  const leftover = requests.filter(r => !used.has(r.id))
  if (leftover.length) {
    const supplement = heuristicClusterRequests(openItems, leftover)
    plan.appends.push(...supplement.appends)
    plan.creates.push(...supplement.creates)
  }

  if (plan.appends.length === 0 && plan.creates.length === 0) return null
  return plan
}

// ---------- 改修プロンプト出力（フィルター結果 → コーディング AI エージェント向けプロンプト） ----------

/** プロンプト化する改修単位（item + 集約元の要望本文 + 時系列メモ） */
export interface PromptItemInput {
  title: string
  summary: string
  detail: string
  status: ImprovementStatus
  pagePaths: string[]
  /** links / imageCount は要望の添付（省略可 = 旧呼び出しの下位互換。リンクはプロンプトに列挙・画像は件数のみ言及）。
   *  status は要望単位のステータス（省略/open 以外は【対応済み】【見送り】として明記 = プロンプト再生成に反映）。
   *  comments は受付箱で記録した要望への時系列コメント（省略/空可。プロンプトに反映 = 改修依頼 2026-08-19）。
   *  注: 投稿時の任意タグ（壁打ち/お任せ）は人間運用の意思表示のためプロンプトには含めない（改修依頼 2026-08-19）。 */
  requests: {
    pageLabel: string; pagePath: string; body: string
    status?: ImprovementRequestStatus; links?: string[]; imageCount?: number
    comments?: string[]
  }[]
  /** 担当者の時系列メモ（改修方針の検討過程・保留/見送り理由。プロンプトに加味する）。時系列（古い順）。省略/空可 */
  notes?: { body: string; kind: ImprovementNoteKind }[]
}

/**
 * プロンプト冒頭のナビゲーター定型文（改修依頼 2026-08-18: 冒頭に必ず記載する）。
 * 受け取ったエージェントに「ロール招集 + レビュー/監査の反復」の進め方を指示する。
 */
export const PROMPT_NAVIGATOR_PREAMBLE =
  'あなたはナビゲーターです。\n'
  + '最適なロールを必要なだけ招集して以下のタスクを進めてください。\n'
  + '改修後は指摘事項がなくなるまでコードレビューとシステム監査を繰り返してください。'

const DEFAULT_PROMPT_INTRO =
  'あなたは本リポジトリ（Nuxt 4 SPA = `mockup/` + Hono/PostgreSQL API = `api/` + 共有ドメイン = `shared/domain/`）を'
  + '改修するコーディングエージェントです。以下の改修単位を、対象ページのパス・機能名・改修内容に従って実装してください。'
  + '各単位には根拠となる利用者の要望を添えています。既存の実装規約（mockup/CONVENTIONS.md・CLAUDE.md）に従い、'
  + 'テストとドキュメントも更新してください。'

/**
 * 改修単位の配列から、コーディング AI エージェント向けの詳細プロンプト（マークダウン）を組み立てる。
 * 迷いを与えないよう、対象ページのパス・機能名（ページ表示名）・改修内容・元の要望・受入基準を明記する。
 * 冒頭にナビゲーター定型文を必ず出力する（改修依頼 2026-08-18）。純粋・決定的（同じ入力 → 同じ出力）。
 */
export function buildCodingPrompt(items: PromptItemInput[], opts?: { intro?: string }): string {
  const out: string[] = []
  out.push(PROMPT_NAVIGATOR_PREAMBLE)
  out.push('')
  out.push('---')
  out.push('')
  out.push('# 改善要望に基づく改修依頼')
  out.push('')
  out.push(opts?.intro ?? DEFAULT_PROMPT_INTRO)
  out.push('')
  out.push(`対象の改修単位: ${items.length} 件`)
  out.push('')
  // 投稿時の任意タグ（壁打ち/お任せ = F-42-17）は人間運用の意思表示のためプロンプトには含めない
  // （改修依頼 2026-08-19。凡例も行頭マークも出さない。タグは受付箱の選別・検討用にのみ使う）
  items.forEach((it, idx) => {
    const label = it.requests.find(r => r.pageLabel.trim())?.pageLabel.trim()
      || it.pagePaths[0]
      || '（対象ページ不明）'
    out.push(`## ${idx + 1}. ${it.title}`)
    out.push('')
    out.push(`- **対象ページ / 機能:** ${label}`)
    if (it.pagePaths.length) out.push(`- **対象パス:** ${it.pagePaths.map(p => `\`${p}\``).join(' , ')}`)
    out.push(`- **現在の状態:** ${IMPROVEMENT_STATUS_META[it.status]?.label ?? it.status}`)
    if (it.summary.trim()) {
      out.push('')
      out.push(`**概要:** ${it.summary.trim()}`)
    }
    if (it.detail.trim()) {
      out.push('')
      out.push('**改修内容:**')
      out.push('')
      out.push(it.detail.trim())
    }
    if (it.requests.length) {
      out.push('')
      out.push('**根拠となった利用者の要望:**')
      if (it.requests.some(r => requestStatusOf(r) !== 'open')) {
        out.push('（【対応済み】の要望は反映済みのため再改修しないこと・【見送り】の要望は実装しないこと）')
      }
      it.requests.forEach((r) => {
        const where = r.pageLabel.trim() || r.pagePath.trim()
        // 要望単位のステータス（open 以外は明記 = 対応済み分の再改修・見送り分の実装を防ぐ）
        const status = requestStatusOf(r)
        const statusTag = status === 'open' ? '' : `【${IMPROVEMENT_REQUEST_STATUS_META[status].label}】 `
        out.push(`- ${where ? `［${where}］ ` : ''}${statusTag}${r.body.trim().replace(/\s*\n\s*/g, ' ')}`)
        // 添付（リンクは参照先として列挙・画像はアプリ内参照のため件数のみ言及）
        const links = (r.links ?? []).map(l => l.trim()).filter(Boolean)
        for (const link of links) out.push(`  - 参考リンク: ${link}`)
        if ((r.imageCount ?? 0) > 0) out.push(`  - 添付画像 ${r.imageCount} 件（改善要望ページの要望詳細で参照可能）`)
        // 受付箱で記録した要望への時系列コメント（改修依頼 2026-08-19。検討経緯を AI に伝える）
        const comments = (r.comments ?? []).map(c => c.trim()).filter(Boolean)
        for (const comment of comments) out.push(`  - コメント: ${comment.replace(/\s*\n\s*/g, ' ')}`)
      })
    }
    // 担当者の時系列メモ（改修方針・保留/見送り理由）。AI がプロンプトを起こす際にこれも加味する
    const notes = (it.notes ?? []).filter(n => n.body.trim())
    if (notes.length) {
      out.push('')
      out.push('**担当者メモ（時系列・改修方針に加味すること）:**')
      notes.forEach((n) => {
        const tag = n.kind === 'reject' ? '［対応しない理由］ ' : ''
        out.push(`- ${tag}${n.body.trim().replace(/\s*\n\s*/g, ' ')}`)
      })
    }
    out.push('')
    out.push('**受入基準:** 対象ページで上記の改修が反映され、`npm run build` / `npx nuxi typecheck` が通り、'
      + 'モバイル幅（375px）で崩れず、主要操作にフィードバックがあること。')
    out.push('')
    out.push('---')
    out.push('')
  })
  return out.join('\n').trimEnd() + '\n'
}

// ---------- Result ヘルパ（呼び出し側のエラー整形の共通化。任意利用） ----------

/** バリデーションエラー（文字列）→ Result エラー（mock 用） */
export function improvementResultError(code: string, message: string): Result {
  return { ok: false, error: { code, message } }
}
