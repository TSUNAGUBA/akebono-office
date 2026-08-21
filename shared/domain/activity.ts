/**
 * 活動記録（サポート/営業/ビジネスパートナー = 改修依頼 2026-08-18・F-43/F-44/F-45）の入力検証。
 * API サービス / home モックモードで共有する = パリティの SoT（customer-log.ts と同じ設計）。
 * - 返り値は「エラーメッセージ | null」。API 側は AKO-SUP/SAL/PTN-001（400）へ変換して throw し、
 *   モック側は Result のエラーへ変換する（エラーコードの付与は各層の責務）。
 * - 検証順は各 xxxActivityError() 内の並びが規約（API・モックとも同一順で適用する）。
 * - 区分値（種別・優先度・ステータス等）のプリセットは shared/domain/types.ts が SoT（「値=ラベル」方式）。
 */
import { capCodePoints, customerLogCompanyError } from './customer-log'
import { improvementLinksError, normalizeImprovementLinks } from './improvement'
import { isRealDateKey } from './jst'
import type { ActivityDigestProposal } from './types'
import {
  ACTIVITY_LOG_KINDS,
  PARTNER_ACTIVITY_STATUSES, PARTNER_ACTIVITY_TYPES,
  SALES_ACTIVITY_DEAL_TYPES, SALES_ACTIVITY_PHASES,
  SUPPORT_ACTIVITY_CATEGORIES, SUPPORT_ACTIVITY_PRIORITIES, SUPPORT_ACTIVITY_STATUSES,
  SUPPORT_FIRST_CONTACT_METHODS,
} from './types'

/** 件名・商談名・テーマ名等の短文上限（コードポイント。customer-log TITLE_CAP と同値） */
export const ACTIVITY_TITLE_CAP = 200
/** 問い合わせ内容・対応内容等の長文上限（コードポイント。customer-log BODY_CAP と同値） */
export const ACTIVITY_BODY_CAP = 20_000
/** 自由入力の名前系（問い合わせ者・対象システム・パートナー・関連企業・関連MTG）の上限 */
export const ACTIVITY_NAME_CAP = 120
/** 商談金額の上限（円。桁あふれ・非現実値の防止） */
export const SALES_AMOUNT_MAX = 1_000_000_000_000

/** 参考リンク URL の検証（改修依頼 2026-08-19 第4弾。改善要望の links と同一ルール = http(s)・件数・長さ）。
 *  正規化は normalizeImprovementLinks（trim・空/重複除去）を各層で使い、本関数で形式検証する（パリティ = 原則3） */
export function activityLinksError(links: string[]): string | null {
  return improvementLinksError(links)
}
export { normalizeImprovementLinks as normalizeActivityLinks }

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 日付（YYYY-MM-DD・実在日）。required=false は空/null を許容する */
export function activityDateError(s: string | null, label: string, required: boolean): string | null {
  if (!s) return required ? `${label}を選択してください` : null
  if (!isRealDateKey(s)) return `${label}が正しくありません`
  return null
}

/** 時刻（HH:MM・任意。空 = null 扱いは呼び出し側） */
export function activityTimeError(s: string | null, label: string): string | null {
  if (!s) return null
  if (!TIME_RE.test(s)) return `${label}は HH:MM 形式で入力してください`
  return null
}

/** 区分値（プリセット集合のいずれか）。required=false は空を許容する */
export function activityEnumError(
  v: string, allowed: readonly string[], label: string, required = true,
): string | null {
  if (!v) return required ? `${label}を選択してください` : null
  if (!allowed.includes(v)) return `${label}の値が正しくありません`
  return null
}

/** 必須の短文（cap 後に空でないこと。cap 前判定だと空白のみが通過する） */
export function activityRequiredTextError(s: string, label: string): string | null {
  if (!capCodePoints(s.trim(), ACTIVITY_TITLE_CAP)) return `${label}を入力してください`
  return null
}

/** 商談金額（任意。0 以上の整数・上限あり） */
export function salesAmountError(n: number | null): string | null {
  if (n === null) return null
  if (!Number.isSafeInteger(n) || n < 0) return '商談金額は 0 以上の整数（円）で入力してください'
  if (n > SALES_AMOUNT_MAX) return '商談金額が大きすぎます'
  return null
}

/** 受注確度（任意。0〜100 の整数 %） */
export function salesProbabilityError(n: number | null): string | null {
  if (n === null) return null
  if (!Number.isInteger(n) || n < 0 || n > 100) return '受注確度は 0〜100 の整数（%）で入力してください'
  return null
}

// ---------- サポート活動 ----------

export interface SupportActivityInput {
  /** 事業区分（Village 参照 id・任意）。newVillageName とどちらか / 空 = 未設定 */
  villageId: string
  /** Village コンボの自由入力名（未登録ならマスタへ新規登録して反映） */
  newVillageName: string
  receivedDate: string
  receivedTime: string | null
  /** 最初の問い合わせ手段（SUPPORT_FIRST_CONTACT_METHODS・任意。改修依頼 2026-08-19 第4弾） */
  firstContactMethod: string
  /** 既存の顧客(会社) id。newCompanyName とどちらか必須 */
  companyId: string
  /** コンボボックスの自由入力名（未登録ならマスタへ新規登録して反映） */
  newCompanyName: string
  inquirerName: string
  targetSystem: string
  /** 対象箇所（自由入力・任意。改修依頼 2026-08-19 第4弾） */
  targetLocation: string
  category: string
  title: string
  body: string
  priority: string
  status: string
  staffMemberId: string
  response: string
  cause: string
  resolution: string
  completedDate: string | null
  completedTime: string | null
  knowledgeNote: string
  /** 参考リンク URL（複数可・任意。改修依頼 2026-08-19 第4弾） */
  links: string[]
}

/**
 * サポート活動の入力検証（宣言順 = API/モック共通の適用順）。
 * 受付日 → 受付時刻 → 最初の問い合わせ手段 → 種別 → 件名 → 内容 → 優先度 → ステータス →
 * 完了日 → 完了時刻（完了日必須）→ 参考リンク → 会社
 */
export function supportActivityError(input: SupportActivityInput): string | null {
  return activityDateError(input.receivedDate, '受付日', true)
    ?? activityTimeError(input.receivedTime, '受付時刻')
    ?? activityEnumError(input.firstContactMethod, SUPPORT_FIRST_CONTACT_METHODS, '最初の問い合わせ手段', false)
    ?? activityEnumError(input.category, SUPPORT_ACTIVITY_CATEGORIES, '問い合わせ種別')
    ?? activityRequiredTextError(input.title, '件名')
    ?? (input.body.trim() ? null : '問い合わせ内容を入力してください')
    ?? activityEnumError(input.priority, SUPPORT_ACTIVITY_PRIORITIES, '優先度')
    ?? activityEnumError(input.status, SUPPORT_ACTIVITY_STATUSES, 'ステータス')
    ?? activityDateError(input.completedDate, '完了日', false)
    ?? activityTimeError(input.completedTime, '完了時刻')
    ?? (input.completedTime && !input.completedDate ? '完了時刻を入力する場合は完了日も入力してください' : null)
    ?? activityLinksError(input.links)
    ?? customerLogCompanyError(input.companyId, input.newCompanyName)
}

// ---------- 営業活動 ----------

export interface SalesActivityInput {
  /** 事業区分（Village 参照 id・任意）。newVillageName とどちらか / 空 = 未設定 */
  villageId: string
  newVillageName: string
  companyId: string
  newCompanyName: string
  /** 担当（Contact 参照 id・任意）。newContactName とどちらか / 空 = 未設定。選択会社に所属 */
  contactId: string
  /** 担当コンボの自由入力名（未登録なら選択会社の contacts へ新規登録して反映） */
  newContactName: string
  /** アプローチグループ（自由入力・任意。改修依頼 2026-08-19 第4弾） */
  approachGroup: string
  title: string
  dealType: string
  staffMemberId: string
  phase: string
  amount: number | null
  probability: number | null
  expectedCloseDate: string | null
  customerIssue: string
  proposal: string
  nextAction: string
  nextActionDate: string | null
  /** 参考リンク URL（複数可・任意。改修依頼 2026-08-19 第4弾） */
  links: string[]
}

/**
 * 営業活動の入力検証（宣言順 = API/モック共通の適用順）。
 * 商談名 → 種別 → フェーズ → 金額 → 確度 → 受注予定日 → Next Action日 → 参考リンク → 会社
 * （担当 contactId の所属検証はデータ層の責務 = API は FK/所属チェック・モックは composable）
 */
export function salesActivityError(input: SalesActivityInput): string | null {
  return activityRequiredTextError(input.title, '商談名')
    ?? activityEnumError(input.dealType, SALES_ACTIVITY_DEAL_TYPES, '商談種別')
    ?? activityEnumError(input.phase, SALES_ACTIVITY_PHASES, '商談フェーズ')
    ?? salesAmountError(input.amount)
    ?? salesProbabilityError(input.probability)
    ?? activityDateError(input.expectedCloseDate, '受注予定日', false)
    ?? activityDateError(input.nextActionDate, 'Next Action日', false)
    ?? activityLinksError(input.links)
    ?? customerLogCompanyError(input.companyId, input.newCompanyName)
}

// ---------- ビジネスパートナー活動 ----------

export interface PartnerActivityInput {
  /** 事業区分（Village 参照 id・任意）。newVillageName とどちらか / 空 = 未設定 */
  villageId: string
  newVillageName: string
  /** パートナー会社（顧客(会社) 参照 id・必須）。newPartnerCompanyName とどちらか。改修依頼 2026-08-19 第4弾 */
  partnerCompanyId: string
  newPartnerCompanyName: string
  /** パートナー担当（Contact 参照 id・任意）。newPartnerContactName とどちらか。パートナー会社に所属 */
  partnerContactId: string
  newPartnerContactName: string
  /** アプローチ企業（顧客(会社) 参照 id・任意）。newApproachCompanyName とどちらか */
  approachCompanyId: string
  newApproachCompanyName: string
  /** アプローチグループ（自由入力・任意） */
  approachGroup: string
  theme: string
  activityType: string
  status: string
  /** 背景・目的（任意）。フィールド名は summary のまま維持しラベルのみ変更（改修依頼 2026-08-20） */
  summary: string
  /** 取組内容（任意。改修依頼 2026-08-20 で追加） */
  initiatives: string
  currentState: string
  nextAction: string
  nextActionDate: string | null
  /** Next Action メモ（自由入力・任意。改善要望 2026-08-21 = BP のみの項目） */
  nextActionNote: string
  staffMemberId: string
  relatedMeeting: string
  relatedSalesActivityId: string | null
  memo: string
  /** 参考リンク URL（複数可・任意。改修依頼 2026-08-19 第4弾） */
  links: string[]
}

/**
 * ビジネスパートナー活動の入力検証（宣言順 = API/モック共通の適用順）。改修依頼 2026-08-19 第4弾:
 * パートナーは自由入力 → 顧客(会社)マスタ参照へ変更（partnerCompanyId 必須）。
 * パートナー会社 → テーマ名 → 活動区分 → ステータス → Next Action日 → 参考リンク
 * （担当・関連商談・アプローチ企業の実在/所属検証はデータ層の責務 = API は FK/所属チェック・モックは composable）
 */
export function partnerActivityError(input: PartnerActivityInput): string | null {
  if (customerLogCompanyError(input.partnerCompanyId, input.newPartnerCompanyName)) return 'パートナー会社を選択してください'
  return activityRequiredTextError(input.theme, 'テーマ名')
    ?? activityEnumError(input.activityType, PARTNER_ACTIVITY_TYPES, '活動区分')
    ?? activityEnumError(input.status, PARTNER_ACTIVITY_STATUSES, 'ステータス')
    ?? activityDateError(input.nextActionDate, 'Next Action日', false)
    ?? activityLinksError(input.links)
}

// ---------- 活動ログ（案件ヘッダー + 活動ログ構造。改修依頼 2026-08-20） ----------

export interface ActivityLogInput {
  /** 活動日（YYYY-MM-DD・必須） */
  loggedOn: string
  /** 活動種別（ACTIVITY_LOG_KINDS・必須） */
  kind: string
  /** 件名（必須） */
  title: string
  /** 内容（任意・BODY_CAP） */
  body: string
  /** Next Action（任意） */
  nextAction: string
  /** Next Action日（YYYY-MM-DD・任意） */
  nextActionDate: string | null
  /** 参考リンク URL（複数可・任意） */
  links: string[]
}

/**
 * 活動ログの入力検証（宣言順 = API/モック共通の適用順。営業/パートナーの両案件で同一）。
 * 活動日 → 活動種別 → 件名 → Next Action日 → 参考リンク
 */
export function activityLogError(input: ActivityLogInput): string | null {
  return activityDateError(input.loggedOn, '活動日', true)
    ?? activityEnumError(input.kind, ACTIVITY_LOG_KINDS, '活動種別')
    ?? activityRequiredTextError(input.title, '件名')
    ?? activityDateError(input.nextActionDate, 'Next Action日', false)
    ?? activityLinksError(input.links)
}

// ---------- AI集約（活動ログの時系列集約。純ロジックの SoT） ----------

/** 集約対象の案件ヘッダー情報（営業 = 商談名/フェーズ・パートナー = テーマ名/ステータスを写像） */
export interface ActivityDigestHeader {
  /** 案件名（商談名 / テーマ名） */
  title: string
  /** 現在ステータス（商談フェーズ / 活動ステータス） */
  status: string
  /** 案件ヘッダーの Next Action（任意。ログ側に無いときのフォールバック） */
  nextAction?: string
  nextActionDate?: string | null
  /** 現在状況（BP のみ。基本情報の更新提案の現在値比較・LLM 材料に使う。改善要望 2026-08-21） */
  currentState?: string
  /** Next Action メモ（BP のみ。同上） */
  nextActionNote?: string
}

/** 集約対象のログ材料（ActivityLog のサブセット。API 行 / モック行の両方が満たす） */
export interface ActivityDigestLog {
  loggedOn: string
  createdAt: string
  kind: string
  title: string
  body: string
  nextAction?: string
  nextActionDate?: string | null
}

export interface ActivityDigestResult {
  summary: string
  highlights: string[]
  /**
   * 基本情報の更新提案（BP 活動のみ = 呼び出し側が opts.propose で有効化。改善要望 2026-08-21）。
   * 現在値と異なる抽出値のみを持つ。提案なし・無効時は undefined
   */
  proposal?: ActivityDigestProposal
}

const fmtDate = (s: string): string => s.replace(/-/g, '/')

/** ログの時系列昇順（活動日 → 登録時刻 → 件名。決定的タイブレーク = 同一入力は常に同一順） */
export function sortLogsChronologically<T extends ActivityDigestLog>(logs: readonly T[]): T[] {
  return [...logs].sort((a, b) =>
    a.loggedOn.localeCompare(b.loggedOn)
    || a.createdAt.localeCompare(b.createdAt)
    || a.title.localeCompare(b.title))
}

/**
 * 決定的な AI集約（LLM 無効・失敗時のフォールバック / モックの唯一のロジック。乱数禁止）。
 * ログを時系列（活動日 → 登録時刻）昇順で走査し、期間・件数・活動種別の内訳・直近の動き・
 * 次のアクションを「経緯 → 現在地 → 次アクション」の順の要約文へ整形する。
 * 空ログでも壊れず「未登録」の案内文を返す（生成日時・件数の付与は呼び出し側の責務 = 純関数）。
 */
export function heuristicActivityDigest(
  header: ActivityDigestHeader, logs: readonly ActivityDigestLog[],
  opts?: {
    /** true = 基本情報の更新提案（proposal）も生成する（BP 活動のみ。改善要望 2026-08-21）。
     *  ヒューリスティックの提案は「最新ログの Next Action / Next Action日が現在値と異なる」場合のみ
     *  （確実に写像できるフィールドに限定。現在状況・ステータス等の推測は LLM の責務） */
    propose?: boolean
  },
): ActivityDigestResult {
  if (logs.length === 0) {
    return {
      summary: `「${header.title}」（ステータス: ${header.status}）の活動ログはまだ登録されていません。`
        + '活動ログを登録してから再生成すると、経緯の集約が表示されます。',
      highlights: [],
    }
  }
  const sorted = sortLogsChronologically(logs)
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const period = first.loggedOn === last.loggedOn
    ? fmtDate(first.loggedOn)
    : `${fmtDate(first.loggedOn)}〜${fmtDate(last.loggedOn)}`

  // 活動種別の内訳（プリセット順 + 未知種別は名前順 = 決定的）
  const counts = new Map<string, number>()
  for (const l of sorted) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1)
  const known = ACTIVITY_LOG_KINDS.filter(k => counts.has(k)).map(k => `${k}${counts.get(k)}件`)
  const unknown = [...counts.keys()].filter(k => !(ACTIVITY_LOG_KINDS as readonly string[]).includes(k))
    .sort((a, b) => a.localeCompare(b)).map(k => `${k}${counts.get(k)}件`)
  const kindSummary = [...known, ...unknown].join('・')

  // 直近の動き（最新 1 件 + 内容抜粋）と次のアクション（最新ログの nextAction → 案件ヘッダーへフォールバック）
  const excerpt = capCodePoints(last.body.trim().replace(/\s+/g, ' '), 60)
  const latestNext = [...sorted].reverse().find(l => (l.nextAction ?? '').trim())
  const nextAction = (latestNext?.nextAction ?? header.nextAction ?? '').trim()
  const nextActionDate = (latestNext ? latestNext.nextActionDate : header.nextActionDate) ?? null

  const summary = `「${header.title}」（ステータス: ${header.status}）は、${period}に${sorted.length}件の活動を記録しています。`
    + `内訳は${kindSummary}。`
    + `直近の動きは ${fmtDate(last.loggedOn)} の「${last.title}」（${last.kind}）${excerpt ? `——${excerpt}` : ''}。`
    + (nextAction
      ? `次のアクションは「${nextAction}」${nextActionDate ? `（${fmtDate(nextActionDate)} 予定）` : ''}です。`
      : '次のアクションは未設定です。')

  const highlights = [
    `期間: ${period}（全${sorted.length}件）`,
    `内訳: ${kindSummary}`,
    `直近: ${fmtDate(last.loggedOn)} ${last.title}（${last.kind}）`,
    nextAction ? `次のアクション: ${nextAction}${nextActionDate ? `（${fmtDate(nextActionDate)}）` : ''}` : '',
  ].filter(Boolean).slice(0, 5)

  const result: ActivityDigestResult = { summary, highlights }
  if (opts?.propose && latestNext) {
    const proposal: ActivityDigestProposal = {}
    const pn = (latestNext.nextAction ?? '').trim()
    if (pn && pn !== (header.nextAction ?? '').trim()) proposal.nextAction = pn
    const pd = latestNext.nextActionDate ?? null
    if (pd && pd !== (header.nextActionDate ?? null)) proposal.nextActionDate = pd
    if (Object.keys(proposal).length > 0) result.proposal = proposal
  }
  return result
}
