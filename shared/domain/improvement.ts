/**
 * 改善要望（F-42）のドメイン純関数（フロント/API 共有 = パリティの SoT）。
 *
 * 概要（オペレーター指示 2026-08-11 → ステータス管理の再編 = 改修依頼 2026-08-21）:
 * - 各ページから改善・改修の要望を記録する（improvement_requests = 追記系。SoT）。
 * - **受付箱（生要望）のステータス**が一次のライフサイクルを持つ:
 *   未確認（初期）→ 検討中 →（改善対応 / 運用対応 / 継続検討 / 対応見送り）。
 *   「改善対応」の要望のみが AI 集約の対象になり、集約後は改修案件（item）の進捗に連動して
 *   「対応済み」→（起票者確認 or 手動で）「解決済み」となる。
 * - **改修案件（改修単位）のステータス**は 未対応 → 対応中（担当者アサイン可）→ 対応済 の 3 状態
 *   （従来の 7 値語彙は保存値として下位互換で受理し、表示・遷移は 3 状態へ正規化 = 原則7。0073 と同方式）。
 * - AI は Vertex AI（api/src/lib/llm）を一次に使い、失敗時は本モジュールの決定的
 *   ヒューリスティック（heuristicClusterRequests）へフォールバックする（モックは常にこちら）。
 * - フィルター結果を、コーディング AI エージェント向けの詳細プロンプト（buildCodingPrompt）へ出力する。
 *
 * データフロー整合性（原則6）:
 * - SoT = improvement_requests（生の要望・追記のみ・巻き戻さない）。
 * - improvement_items は要望から導出する集約キャッシュだが、**人手で付与したステータスは記録系**であり
 *   再集約で巻き戻してはならない（原則2）。このため集約は「未集約の要望のみ」を対象にし、
 *   既存 item は未対応（todo。旧 triage 含む = 着手・決着前）のものにのみ追記する。着手済み item は不変。
 * - 集約済み要望の「改善対応/対応済み」は**保存せず item から導出**する（improvementInboxStatusOf）。
 *   同期パスを持たない = 二重管理によるズレを作らない（原則6）。
 */

import { isRealDateKey } from './jst'
import type { Result } from './types'

// ---------- 改修案件（item）のステータス（改修依頼 2026-08-21: 未対応/対応中/対応済 の 3 状態へ再編） ----------

/**
 * 改修単位（改修案件）の**保存値**。新規の書込は 'todo' | 'in_progress' | 'done' のみを使う。
 * 旧語彙（triage/accepted/operational/deferred/resolved/rejected = 〜2026-08-20 の対応方針語彙）は
 * 既存データの保存値として受理し、表示・遷移判定は improvementItemViewOf で 3 状態へ正規化する
 * （保存値は書き換えない = 原則7。運用対応・継続検討・対応見送りの判断は受付箱ステータスへ移管）。
 */
export type ImprovementStatus =
  | 'todo' | 'in_progress' | 'done'
  | 'triage' | 'accepted' | 'operational' | 'deferred' | 'resolved' | 'rejected'

/** 改修案件の表示・遷移ステータス（3 状態）。実施が決定し AI 集約が完了した案件に適用する */
export type ImprovementItemView = 'todo' | 'in_progress' | 'done'

export const IMPROVEMENT_ITEM_VIEWS: ImprovementItemView[] = ['todo', 'in_progress', 'done']

/** 改修案件ステータスの表示メタ。ラベルの SoT はここ。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_ITEM_STATUS_META: Record<
  ImprovementItemView,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' | 'brand' }
> = {
  todo: { label: '未対応', tone: 'warn' },
  in_progress: { label: '対応中', tone: 'brand' },
  done: { label: '対応済', tone: 'ok' },
}

/**
 * 保存値 → 3 状態への正規化（旧語彙の読替え = 原則7）。
 * - triage（未判定）/ accepted（改善対応 = 実施決定・未着手）/ deferred（継続検討）→ 未対応
 * - in_progress → 対応中
 * - resolved（解決済み）/ operational（運用対応で決着）/ rejected（見送りで決着）→ 対応済（決着済み）
 * 旧 operational/rejected の要望側の見え方は inboxStatusFromItem が個別に写像する（運用対応/対応見送り）。
 */
export function improvementItemViewOf(status: ImprovementStatus): ImprovementItemView {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'done' || status === 'resolved' || status === 'operational' || status === 'rejected') return 'done'
  return 'todo'
}

/** 未決着（対応済でない）か。集約解除の可否・「未完了」フィルタの判定に使う */
export function isOpenItemStatus(status: ImprovementStatus): boolean {
  return improvementItemViewOf(status) !== 'done'
}

/**
 * AI 集約の追記先にできる item か = 未対応（todo。旧 triage/accepted/deferred の読替え含む）。
 * 着手済み（対応中）・決着済み（対応済）には追記しない = 人手の進捗・記録を汚さない（原則2）。
 * mock（heuristicClusterRequests / normalizeClusterPlan）と API（generate の SQL・LLM への
 * openItems 提示）で共有する単一の判定点（原則6）。
 */
export function isClusterAppendTarget(status: ImprovementStatus): boolean {
  return improvementItemViewOf(status) === 'todo'
}

/**
 * 改修案件の状態遷移（3 状態。フロントのボタン活性と API の遷移検証を一致させる）。
 * 取消可能性（原則9.5）: 対応中 → 未対応（着手の取消）、対応済 → 対応中（reopen）を許可し、
 * 「誤って決着にしたら詰む」導線を作らない。未対応 → 対応済 の直行も許可する
 * （着手記録を経ない小さな改修の下位互換 = 旧 accepted → resolved 直行と同じ意図 = 原則7）。
 */
export const IMPROVEMENT_ITEM_NEXT: Record<ImprovementItemView, ImprovementItemView[]> = {
  todo: ['in_progress', 'done'],
  in_progress: ['done', 'todo'],
  done: ['in_progress'],
}

/** 改修案件の遷移が許可されているか（保存値は正規化してから判定する） */
export function canTransition(from: ImprovementStatus, to: ImprovementItemView): boolean {
  return (IMPROVEMENT_ITEM_NEXT[improvementItemViewOf(from)] ?? []).includes(to)
}

// ---------- 一覧フィルター（改修案件。3 状態 + 未完了/すべて） ----------

export type ImprovementFilter = 'all' | 'open' | ImprovementItemView

/** フィルターの選択肢（UI と共有。all = すべて / open = 未完了 = 未対応 + 対応中。
 *  個別ステータスのラベルは IMPROVEMENT_ITEM_STATUS_META（SoT）から引き、語彙のズレを作らない = 原則5） */
export const IMPROVEMENT_FILTER_OPTIONS: { value: ImprovementFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'open', label: '未完了' },
  ...IMPROVEMENT_ITEM_VIEWS.map(s => ({ value: s, label: IMPROVEMENT_ITEM_STATUS_META[s].label })),
]

/** 改修単位がフィルターに一致するか（保存値は 3 状態へ正規化して判定 = 旧語彙にも効く） */
export function matchesImprovementFilter(status: ImprovementStatus, filter: ImprovementFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'open') return isOpenItemStatus(status)
  return improvementItemViewOf(status) === filter
}

/**
 * フィルター値の正規化（下位互換 = 原則7。改修依頼 2026-08-21 の 3 状態化で旧語彙のフィルター値
 * 〔外部スクリプト・ブックマーク経由〕が常に 0 件になるのを防ぐ）。旧ステータス値は保存値と同じ
 * 読み替え（improvementItemViewOf）で 3 状態視点へ・旧 committed（改善対応+対応中 = 未完了）は open へ。
 * 未知値はそのまま返す（matchesImprovementFilter が 0 件を返す = 従来と同じ安全側）。
 */
export function normalizeImprovementFilter(raw: string): ImprovementFilter {
  if (raw === 'all' || raw === 'open' || (IMPROVEMENT_ITEM_VIEWS as readonly string[]).includes(raw)) {
    return raw as ImprovementFilter
  }
  if (raw === 'committed') return 'open'
  const legacy: readonly string[] = ['triage', 'accepted', 'operational', 'deferred', 'resolved', 'rejected']
  if (legacy.includes(raw)) return improvementItemViewOf(raw as ImprovementStatus)
  return raw as ImprovementFilter
}

// ---------- 型 ----------

// ---------- 受付箱（request）のステータス（改修依頼 2026-08-21: 選別〔採用/不採用〕+ 進捗タグを一本化） ----------

/**
 * 生要望（受付箱）ステータスの**保存値**。新規の書込は新語彙（unconfirmed〜dismissed）のみを使う。
 * - unconfirmed 未確認（起票時に自動設定される初期ステータス）
 * - reviewing   検討中（未確認から手動遷移）
 * - planned     改善対応（検討中から手動遷移。**AI 集約の対象**）
 * - operational 運用対応（検討中から手動遷移。遷移時に運用対応方法を起票者へ自動通知）
 * - deferred    継続検討（検討中から手動遷移。再検討日必須・到来でリマインド通知）
 * - dismissed   対応見送り（検討中から手動遷移。旧「見送り」進捗タグと同値 = 原則7）
 * 旧語彙（open = 進捗タグ未対応 / resolved = 起票者の解決フラグ）は既存データの保存値として受理し、
 * improvementInboxStatusOf が新語彙へ読み替える（保存値は書き換えない = 原則7）。
 * 「対応済み（addressed）」「解決済み（resolved）」は表示ステータスであり、addressed は保存しない
 * （集約先 item の進捗から導出 = 原則6）。解決済みは resolvedAt（解決の記録）で表す。
 */
export type ImprovementRequestStatus =
  | 'unconfirmed' | 'reviewing' | 'planned' | 'operational' | 'deferred' | 'dismissed'
  | 'open' | 'resolved'

/** 保存してよい新語彙の基底ステータス（addressed/resolved は保存しない = 導出・記録） */
export const IMPROVEMENT_INBOX_BASES = ['unconfirmed', 'reviewing', 'planned', 'operational', 'deferred', 'dismissed'] as const
export type ImprovementInboxBase = (typeof IMPROVEMENT_INBOX_BASES)[number]

/** 受付箱の表示ステータス（基底 + 導出の 対応済み/解決済み）。カンバン列・フィルタ・バッジの軸 */
export type ImprovementInboxStatus = ImprovementInboxBase | 'addressed' | 'resolved'

export const IMPROVEMENT_INBOX_STATUSES: ImprovementInboxStatus[] = [
  'unconfirmed', 'reviewing', 'planned', 'operational', 'deferred', 'dismissed', 'addressed', 'resolved',
]

/** 受付箱ステータスの表示メタ。ラベルの SoT はここ。tone は UI の Tone 値と対応 */
export const IMPROVEMENT_INBOX_STATUS_META: Record<
  ImprovementInboxStatus,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' | 'brand' }
> = {
  unconfirmed: { label: '未確認', tone: 'neutral' },
  reviewing: { label: '検討中', tone: 'info' },
  planned: { label: '改善対応', tone: 'brand' },
  operational: { label: '運用対応', tone: 'ok' },
  deferred: { label: '継続検討', tone: 'info' },
  dismissed: { label: '対応見送り', tone: 'warn' },
  addressed: { label: '対応済み', tone: 'ok' },
  resolved: { label: '解決済み', tone: 'neutral' },
}

/**
 * 受付箱の状態遷移（基底ステータスのみ。管理権限者の操作）。
 * 取消可能性（原則9.5）: 各決着（改善対応/運用対応/対応見送り）→ 検討中（判断の見直し）、
 * 検討中 → 未確認（差し戻し）を許可し、「誤操作したら詰む」導線を作らない。
 * 継続検討 → 継続検討（再検討日の変更 = リスケジュール）は遷移検証側で個別に許可する。
 * 改善対応（planned）は未集約の間だけ戻せる（集約済みは「集約の解除」= uncluster が先 = 記録保護）。
 * 解決済み（resolvedAt）は別の記録系操作（resolve/unresolve）で扱い、この機械には含めない。
 */
export const IMPROVEMENT_INBOX_NEXT: Record<ImprovementInboxBase, ImprovementInboxBase[]> = {
  unconfirmed: ['reviewing'],
  reviewing: ['planned', 'operational', 'deferred', 'dismissed', 'unconfirmed'],
  planned: ['reviewing'],
  operational: ['reviewing'],
  deferred: ['reviewing', 'planned', 'operational', 'dismissed'],
  dismissed: ['reviewing'],
}

/** 受付箱の一覧・カンバン・ガント共通のステータス絞り込み（all + 表示ステータス。UI と共有 = 原則3/5） */
export type ImprovementInboxFilter = 'all' | ImprovementInboxStatus

export const IMPROVEMENT_INBOX_FILTER_OPTIONS: { value: ImprovementInboxFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  ...IMPROVEMENT_INBOX_STATUSES.map(s => ({ value: s, label: IMPROVEMENT_INBOX_STATUS_META[s].label })),
]

/** 要望（表示ステータス解決済み）が受付箱フィルタに一致するか */
export function matchesInboxFilter(status: ImprovementInboxStatus, filter: ImprovementInboxFilter): boolean {
  return filter === 'all' || status === filter
}

/** 受付箱の遷移が許可されているか（deferred → deferred は再検討日の変更として許可） */
export function canInboxTransition(from: ImprovementInboxStatus, to: ImprovementInboxBase): boolean {
  if (from === 'deferred' && to === 'deferred') return true
  return ((IMPROVEMENT_INBOX_NEXT as Record<string, ImprovementInboxBase[]>)[from] ?? []).includes(to)
}

/**
 * 集約先 item の保存ステータス → 要望の表示ステータス（連動 = 導出。原則6）。
 * - done/resolved（対応済・解決済み）→ 対応済み（addressed。起票者確認 → 解決済みへ）
 * - 旧 operational / deferred / rejected（item 側で決着していた旧データ）→ 対応する受付箱語彙へ読替え（原則7）
 * - それ以外（todo/in_progress/triage/accepted）→ 改善対応（改修案件として進行中）
 */
export function inboxStatusFromItem(itemStatus: ImprovementStatus): ImprovementInboxStatus {
  if (itemStatus === 'done' || itemStatus === 'resolved') return 'addressed'
  if (itemStatus === 'operational') return 'operational'
  if (itemStatus === 'deferred') return 'deferred'
  if (itemStatus === 'rejected') return 'dismissed'
  return 'planned'
}

// ---------- 旧・選別（採用/不採用）の読替え（〜2026-08-20 のデータ互換。原則7） ----------

/** 旧・選別状態（保存値の互換のためだけに残す型。新規の書込は行わない） */
export type ImprovementRequestAdoption = 'pending' | 'adopted' | 'declined'

/**
 * 旧データの選別状態の解決（下位互換 = 原則7）。adoption 未定義は、
 * 集約済み（itemId あり）= 採用相当 / 未集約 = 未選別 として扱う。
 * improvementInboxStatusOf が旧 status（open）+ 選別状態を新語彙へ写像するために使う。
 */
export function requestAdoptionOf(r: { adoption?: ImprovementRequestAdoption | null; itemId?: string | null }): ImprovementRequestAdoption {
  if (r.adoption === 'pending' || r.adoption === 'adopted' || r.adoption === 'declined') return r.adoption
  return r.itemId ? 'adopted' : 'pending'
}

/** improvementInboxStatusOf に渡す構造的最小型（mock 行・DB 行・API 応答行のどれでも渡せる） */
export interface InboxStatusInput {
  status?: ImprovementRequestStatus | null
  adoption?: ImprovementRequestAdoption | null
  itemId?: string | null
  /** 解決済みにした時刻（新語彙の解決記録）。null/未定義 = 未解決 */
  resolvedAt?: string | null
  /** 集約先 item の保存ステータス（API 応答の linkedItemStatus / mock はローカル items から解決して渡す） */
  linkedItemStatus?: ImprovementStatus | null
}

/**
 * 受付箱の表示ステータスの解決（**唯一の判定点** = 原則6。一覧・カンバン・ガント・遷移検証で共有）。
 * 優先順:
 * 1. 解決済み（resolvedAt あり / 旧 status='resolved'）= 最終状態（連動より優先。起票者の確認記録）
 * 2. 旧 status='dismissed'（見送り進捗タグ）= 対応見送り
 * 3. 集約済み（itemId あり）= 集約先 item から導出（inboxStatusFromItem。item 不明時は改善対応）
 * 4. 新語彙の保存値はそのまま
 * 5. 旧データ（open/未定義）は旧・選別状態から読替え（採用 = 改善対応 / 不採用 = 対応見送り / 未選別 = 未確認）
 */
export function improvementInboxStatusOf(r: InboxStatusInput, linkedItemStatus?: ImprovementStatus | null): ImprovementInboxStatus {
  if (r.resolvedAt || r.status === 'resolved') return 'resolved'
  if (r.status === 'dismissed') return 'dismissed'
  if (r.itemId) {
    const item = linkedItemStatus ?? r.linkedItemStatus
    return item ? inboxStatusFromItem(item) : 'planned'
  }
  if (r.status && (IMPROVEMENT_INBOX_BASES as readonly string[]).includes(r.status)) {
    return r.status as ImprovementInboxBase
  }
  // 旧データ（status='open' / 未定義）: 選別状態から読替え（原則7）
  const adoption = requestAdoptionOf(r)
  if (adoption === 'adopted') return 'planned'
  if (adoption === 'declined') return 'dismissed'
  return 'unconfirmed'
}

/**
 * AI 集約の対象要望（未集約・有効・**改善対応**）を選ぶ（改修依頼 2026-08-21:
 * 集約対象は「改善対応」ステータスの要望のみ。旧データは 採用済み+open = 改善対応 と読替え）。
 * mock の集約と API の generate SQL
 * （`item_id IS NULL AND archived_at IS NULL AND (status='planned' OR (status='open' AND adoption='adopted'))`）の
 * 条件を共有する定義（両モード同挙動 = 原則6。「改善対応のみ集約」フローの単一の判定点）。
 */
export function clusterTargetRequests<T extends InboxStatusInput & { archivedAt?: string | null }>(requests: T[]): T[] {
  return requests.filter(r => !r.itemId && !r.archivedAt && improvementInboxStatusOf(r) === 'planned')
}

// ---------- 継続検討（deferred）の再検討日（改修依頼 2026-08-20 → 受付箱へ移管 2026-08-21） ----------

/**
 * 再検討日（revisitOn）の検証。継続検討（deferred）への遷移は再検討日が必須（実在日）。
 * deferred 以外への遷移では revisitOn を要求しない（渡された場合のみ形式検証。保存値は保持 =
 * クリアしない = 履歴保全）。mock（useImprovements.setRequestStatus）と API
 * （POST /requests/:id/status）の双方で使い、判定のパリティを保つ（原則6）。エラーメッセージ | null。
 */
export function improvementRevisitError(status: ImprovementInboxStatus, revisitOn: string): string | null {
  const v = revisitOn.trim()
  if (status === 'deferred' && !v) return '継続検討にするには再検討日を設定してください'
  if (v && !isRealDateKey(v)) return '再検討日が正しくありません（YYYY-MM-DD の実在日で指定してください）'
  return null
}

/**
 * 受付箱ステータス変更（基底遷移）の可否ガード（1 件）。判定順 = 存在（404）→ 取消済み（409）→
 * 集約済み（409。集約済みの進捗は item 連動 = 直接変更しない。外すには「集約の解除」が先）→
 * 解決済み（409。解決の取消 = unresolve が先）→ 遷移検証（409）。
 * mock の setRequestStatus・一括変更（planInboxStatusBulk）・API ルートの 3 か所で共有し、
 * ガード条件とメッセージの分散コピーを作らない（原則3/6）。
 */
export function improvementInboxStatusError(
  target: InboxStatusInput & { archivedAt?: string | null } | undefined,
  to: ImprovementInboxBase,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (target.archivedAt) return { code: 'AKO-REQ-019', message: '取消済みの要望はステータスを変更できません（先に復元してください）' }
  if (target.itemId) {
    return { code: 'AKO-REQ-013', message: '集約済みの要望のステータスは改修案件に連動します（対象から外す場合は「集約の解除」または要望の取消を使ってください）' }
  }
  const from = improvementInboxStatusOf(target)
  if (from === 'resolved') {
    return { code: 'AKO-REQ-025', message: '解決済みの要望はステータスを変更できません（先に「解決済みを取り消す」で戻してください）' }
  }
  if (from !== to && !canInboxTransition(from, to)) {
    return {
      code: 'AKO-REQ-006',
      message: `「${IMPROVEMENT_INBOX_STATUS_META[from].label}」から「${IMPROVEMENT_INBOX_STATUS_META[to].label}」へは変更できません`,
    }
  }
  return null
}

/**
 * 受付箱ステータスの一括変更（複数選択 → まとめて遷移 = 旧・一括選別の後継）の対象仕分け（純関数）。
 * ids を重複除去し、「適用できる id」と「適用できない件数の最後の理由」へ仕分ける。
 * 判定は improvementInboxStatusError を 1 件ずつ適用（機械外の遷移・集約済み・取消済みは失敗に数える）。
 * 同一ステータスの行は no-op として適用可に含める（冪等 = 原則2。deferred → deferred は
 * 一括では再検討日を変えないため対象外 = noop に含める）。
 * mock の一括更新と単体テストで共有する（API モードは既存 1 件エンドポイントの逐次呼びで
 * サーバー側が同じ判定を行う = 原則6）。
 */
export function planInboxStatusBulk(
  ids: string[],
  requests: (InboxStatusInput & { id: string; archivedAt?: string | null })[],
  to: ImprovementInboxBase,
): { targets: string[]; applicable: string[]; lastError: { code: string; message: string } | null } {
  const targets = [...new Set(ids)]
  const byId = new Map(requests.map(r => [r.id, r]))
  const applicable: string[] = []
  let lastError: { code: string; message: string } | null = null
  for (const id of targets) {
    const guard = improvementInboxStatusError(byId.get(id), to)
    if (guard) {
      lastError = guard
      continue
    }
    applicable.push(id)
  }
  return { targets, applicable, lastError }
}

/**
 * 解決済み（resolve）の可否ガード。解決済みにできるのは表示ステータスが
 * 「運用対応」（起票者が運用案内を確認して解決）または「対応済み」（改修完了を確認して解決）のときのみ。
 * 権限（起票者本人 or 管理権限者）の判定は呼び出し側（API/mock UI ゲート）。
 */
export function improvementResolveError(
  target: (InboxStatusInput & { archivedAt?: string | null }) | undefined,
  linkedItemStatus?: ImprovementStatus | null,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (target.archivedAt) return { code: 'AKO-REQ-019', message: '取消済みの要望は解決済みにできません（先に復元してください）' }
  const from = improvementInboxStatusOf(target, linkedItemStatus)
  if (from === 'resolved') return null // 冪等（再実行しても壊れない = 原則2）
  if (from !== 'operational' && from !== 'addressed') {
    return { code: 'AKO-REQ-026', message: '解決済みにできるのは「運用対応」または「対応済み」の要望のみです' }
  }
  return null
}

// ---------- 要望のタグ（壁打ち/お任せ。投稿時の任意の意思表示 = 改修依頼 2026-08-18） ----------

/**
 * 生要望のタグ（投稿時にどちらか 1 つを選ぶ二者択一の意思表示。改修依頼 2026-08-20）。
 * - entrust    お任せ: 受け取った内容を開発側の解釈で進めてよい（既定）
 * - brainstorm 壁打ち: 起票した内容について、壁打ち（対話での要件整理）を経て案件化したい
 * UI（ImprovementsTagToggle）は常に要素数 1 の配列で保存する。型は配列（ImprovementRequestTag[]）のまま =
 * 旧データ（tags 未定義 = タグ無し／複数付与）とも下位互換（表示は全件バッジ・編集時に 1 件へ正規化 = 原則7）。
 */
export type ImprovementRequestTag = 'brainstorm' | 'entrust'

// 表示順の SoT（ImprovementsTagToggle・TagBadges はこの配列順で描画）。改修依頼 2026-08-19 第4弾: 左から
// 「お任せ」「壁打ち」。投稿フォームの既定選択は「お任せ」（entrust）= ImprovementSubmit 側で初期値を設定。
// 改修依頼 2026-08-20: タグは二者択一トグル（どちらか 1 つのみ）= 保存値は常に要素数 1 の配列
export const IMPROVEMENT_REQUEST_TAGS: ImprovementRequestTag[] = ['entrust', 'brainstorm']

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

// ---------- AI 判定（受付箱の要望ごとの 既存機能/運用工夫/改修要 判定 = 改修依頼 2026-08-21） ----------

/**
 * AI 判定の区分。ナレッジベース（shared/domain/kb = アプリ仕様・運用/操作マニュアル）を RAG として
 * 「既存機能に備わっているか？」「使い方の工夫で要望を叶えられるか？」「改修が必要か？」を判定する。
 * - existing    既存機能で対応可能（該当機能の案内 → 推奨 = 運用対応）
 * - workaround  使い方の工夫で対応可能（運用での回避策あり → 推奨 = 運用対応）
 * - improvement 改修が必要（→ 推奨 = 改善対応）
 * - unknown     判定できず（情報不足 → 推奨 = 検討中で人手判断）
 */
export type ImprovementAssessVerdict = 'existing' | 'workaround' | 'improvement' | 'unknown'

export const IMPROVEMENT_ASSESS_VERDICTS: ImprovementAssessVerdict[] = ['existing', 'workaround', 'improvement', 'unknown']

/** AI 判定の表示メタ + 推奨アクション（受付箱の基底ステータス）。ラベルの SoT はここ */
export const IMPROVEMENT_ASSESS_META: Record<
  ImprovementAssessVerdict,
  { label: string; tone: 'neutral' | 'info' | 'ok' | 'warn' | 'brand'; recommended: ImprovementInboxBase }
> = {
  existing: { label: '既存機能で対応可', tone: 'ok', recommended: 'operational' },
  workaround: { label: '運用の工夫で対応可', tone: 'info', recommended: 'operational' },
  improvement: { label: '改修が必要', tone: 'brand', recommended: 'planned' },
  unknown: { label: '判定不能（人手判断）', tone: 'neutral', recommended: 'reviewing' },
}

/** 保管する AI 判定（生成→保管→再判定で上書き。要望本文の編集後は再判定を促す表示に使う） */
export interface ImprovementRequestAssessment {
  verdict: ImprovementAssessVerdict
  /** 判定の根拠・説明（マニュアルの該当箇所への言及を含む） */
  reason: string
  /** 参照したナレッジベース doc id（根拠の提示・追跡用） */
  docIds: string[]
  /** LLM による判定か（false = 決定的ヒューリスティック = モック/フォールバック） */
  llm: boolean
  /** 判定時刻（JST ISO） */
  assessedAt: string
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
  /** 対象箇所（ページ内のどこか = 自由入力・任意。改修依頼 2026-08-19 第4弾）。旧データは未定義 = 無し（原則7） */
  targetSpot?: string
  /** 要望本文 */
  body: string
  /** 受付箱ステータス（保存値。表示は improvementInboxStatusOf で解決。旧値 open/resolved も受理 = 原則7） */
  status?: ImprovementRequestStatus
  /** 旧・選別状態（〜2026-08-20 のデータ互換のためだけに保持。新規の書込なし = 原則7） */
  adoption?: ImprovementRequestAdoption
  /** 継続検討（deferred）の再検討日（YYYY-MM-DD。deferred への遷移で必須・到来でリマインド通知）。
   *  deferred 以外へ戻してもクリアしない（履歴保全）。旧データは未定義 = 無し（原則7） */
  revisitOn?: string | null
  /** 解決済みにした時刻（起票者確認 or 管理者操作の記録）。null/未定義 = 未解決。
   *  解決の取消（unresolve）で null へ戻せる（原則9.5） */
  resolvedAt?: string | null
  /** 集約先 item の保存ステータス（API の GET /requests が JOIN で返す導出値。mock は未定義 =
   *  ローカル items から解決する。一般利用者も自分の要望の「対応済み」を判別できる = 原則6 導出） */
  linkedItemStatus?: ImprovementStatus | null
  /** AI 判定（既存機能/運用工夫/改修要 の判定と根拠・推奨アクション = 改修依頼 2026-08-21。
   *  生成→保管→再判定で上書き。null/未定義 = 未判定 */
  aiAssessment?: ImprovementRequestAssessment | null
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
  /** 保存ステータス（新規書込は todo/in_progress/done。旧 7 値語彙も受理し表示は 3 状態へ正規化 = 原則7） */
  status: ImprovementStatus
  /** 担当者（対応中への遷移時にアサイン可 = 改修依頼 2026-08-21。null/未定義 = 未アサイン。
   *  変更・解除はいつでも可（原則9.5）。一覧・カンバン・ドロワーに表示する */
  assigneeMemberId?: string | null
  /** 担当者名（スナップショット。閲覧時のマスタ参照を避ける） */
  assigneeName?: string | null
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
  /**
   * 再検討日（YYYY-MM-DD。継続検討〔deferred〕への遷移で必須 = improvementRevisitError）。
   * deferred 以外への遷移でもクリアしない（履歴保全。表示は deferred のときのみ）。
   * 旧データは未定義 = 無し（原則7）。改修依頼 2026-08-20。
   */
  revisitOn?: string | null
}

/**
 * 生要望へのコメント（記録系・追記のみ = 改善要望 2026-08-17 第 2 弾）。
 * 対応方針の検討過程・見送り理由・確認事項・運用案内などのやり取りを要望単位で時系列に残す。
 * 一覧参照は改善要望の管理権限者のみ。**例外: 投稿者本人は「自分の要望 + requestId 指定」で
 * 運用案内（kind='ops'）のみ取得できる**（R2 監査 2026-08-21 = 通知 OFF でも案内を読める到達経路。
 * 一般コメント〔kind='comment'〕の本人向け閲覧は引き続き未提供 = 意図的な情報開示方針）。
 * 追加・取消は管理権限者 + 投稿者本人。取消は archivedAt（論理削除 = 原則9.5）。
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
  /**
   * コメント種別（0083・R3 監査 2026-08-21）: 'ops' = 運用対応遷移の自動記録（運用案内 = 起票者本人へ
   * 開示する行の判別キー）/ 'comment'（未定義含む = 旧データ互換〔原則7〕）= 手動コメント（管理検討）。
   * 判別を kind で行うため、管理者が「運用案内: 」で始まる手動コメントを書いても本人へは開示されない
   */
  kind?: 'ops' | 'comment'
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
/** 対象箇所（ページ内のどこか = 自由入力・任意。改修依頼 2026-08-19 第4弾） */
export const IMPROVEMENT_TARGET_SPOT_CAP = 120

/** 投稿フォームの本文テンプレ既定値（改修依頼 2026-08-19 第4弾。要望/現状/改善の型に沿って書きやすくする）。
 *  テンプレのみ（内容未入力）の投稿は送信ガードで弾く = 見出しだけの空要望を作らない */
export const IMPROVEMENT_BODY_TEMPLATE = '要望：\n現状：\n改善：\n'
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

/** 要望編集で更新できる項目（改修依頼 2026-08-19: 登録時の項目をすべて編集可能に →
 *  2026-08-21: 対象箇所（targetSpot）も編集可能に〔受付箱の一覧・詳細で表示/編集する改修〕）。
 *  投稿元（pagePath/pageLabel）は記録として不変・編集対象外。
 *  **部分更新**: body は常に必須だが tags/links/images/targetSpot はリクエストに実在するキーのみ返す
 *  （送っていない項目は呼び出し側で保持する = CLAUDE.md「部分更新で未指定列を保持する」原則）。 */
export interface ImprovementRequestEditFields {
  body: string
  tags?: ImprovementRequestTag[]
  links?: string[]
  images?: ImprovementRequestImage[]
  /** 対象箇所（自由入力・任意。'' = クリア） */
  targetSpot?: string
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
  raw: { body?: unknown; tags?: unknown; links?: unknown; images?: unknown; targetSpot?: unknown },
): { ok: true; value: ImprovementRequestEditFields } | { ok: false; error: { code: string; message: string } } {
  const text = String(raw.body ?? '').trim()
  const bodyMsg = improvementBodyError(text)
  if (bodyMsg) return { ok: false, error: { code: 'AKO-REQ-001', message: bodyMsg } }
  const value: ImprovementRequestEditFields = { body: capCodePoints(text, IMPROVEMENT_BODY_CAP) }
  // 実在キー判定は `hasOwn && !== undefined`: API 経路は JSON 化で undefined キーが落ちる（hasOwn=false）が、
  // mock 経路はオブジェクトを直接渡すため { tags: undefined } が hasOwn=true になり得る。両経路を揃え、
  // 明示的 undefined は「未指定 = 現行値保持」として扱う（空配列 [] のみが「全削除」= パリティ・部分更新の鉄則）
  if (Object.hasOwn(raw, 'tags') && raw.tags !== undefined) value.tags = normalizeImprovementTags(raw.tags)
  if (Object.hasOwn(raw, 'links') && raw.links !== undefined) {
    const links = normalizeImprovementLinks(raw.links)
    const linksMsg = improvementLinksError(links)
    if (linksMsg) return { ok: false, error: { code: 'AKO-REQ-009', message: linksMsg } }
    value.links = links
  }
  if (Object.hasOwn(raw, 'images') && raw.images !== undefined) {
    const images = normalizeImprovementImages(raw.images)
    const imagesMsg = improvementImagesError(images)
    if (imagesMsg) return { ok: false, error: { code: 'AKO-REQ-010', message: imagesMsg } }
    value.images = images
  }
  // 対象箇所（任意・上限のみ。空文字 = クリア。投稿時 improvementRequestInputOf と同じ正規化 = 原則6）
  if (Object.hasOwn(raw, 'targetSpot') && raw.targetSpot !== undefined) {
    value.targetSpot = capCodePoints(String(raw.targetSpot ?? '').trim(), IMPROVEMENT_TARGET_SPOT_CAP)
  }
  return { ok: true, value }
}

/**
 * 編集で変更した項目のラベル（監査ログ用。API/モック共通 = パリティ）。本文は常に更新対象、
 * tags/links/images は部分更新で実在したもののみ（improvementRequestEditFields の value に基づく）。
 * 画像実体は肥大するため監査 detail には残さず「どの項目を変更したか」だけを記録する（原則3・レビュー R2）。
 */
export function improvementEditChangedLabel(fields: ImprovementRequestEditFields): string {
  return ['本文',
    ...(fields.tags !== undefined ? ['タグ'] : []),
    ...(fields.links !== undefined ? ['リンク'] : []),
    ...(fields.images !== undefined ? ['画像'] : []),
    ...(fields.targetSpot !== undefined ? ['対象箇所'] : [])].join('・')
}

/**
 * 集約解除の可否ガード（F-42-19・改修依頼 2026-08-18）。集約済みの要望を改修単位から外し、
 * 「改善対応（集約待ち）」へ戻す = 再度 AI 集約の対象にする操作の共通判定。
 * 判定順 = 存在（404）→ 未集約（409）→ 取消済み（409）→ **解決済み（409）→ 取消済み item（409）→ 決着済み item（409）**。
 * 解決済み（resolvedAt / 旧 status='resolved'）の要望は解除しない（解除しても generate の
 * resolved_at IS NULL 条件で再集約対象にならず「集約待ちに戻る」の案内が嘘になる = R1 レビュー
 * 2026-08-21。先に「解決済み」を取り消してから解除する = 導線は残る〔原則9.5〕）。
 * item（任意）を渡すと、集約先が取消済み（AKO-REQ-022 = 先に復元）または決着済み
 * （解決済み/対応しない）の場合に AKO-REQ-021 を返す:
 * 判定済み item の元要望トレースを黙って書き換えず、実装済み内容を再集約プールへ戻さない（原則2 =
 * レビュー R18）。解除したい場合は先に reopen（ステータスを戻す）してから解除する（導線は残る = 原則9.5）。
 * 管理権限の確認は呼び出し側（API = requireManage）。
 * mock（useImprovements.unclusterRequest）と API ルートで共有し、単体テストで固定する（parity = 原則6）。
 */
export function improvementUnclusterError(
  target: {
    itemId: string | null; archivedAt: string | null
    status?: ImprovementRequestStatus | null; resolvedAt?: string | null
  } | undefined,
  item?: { status: ImprovementStatus; archivedAt?: string | null } | null,
): { code: string; message: string } | null {
  if (!target) return { code: 'AKO-REQ-002', message: '対象の要望が見つかりません' }
  if (!target.itemId) return { code: 'AKO-REQ-017', message: 'この要望は集約されていません（解除は不要です）' }
  if (target.archivedAt) return { code: 'AKO-REQ-018', message: '取消済みの要望は集約を解除できません（先に復元してください）' }
  // 解決済みの要望は解除しない（AKO-REQ-025 = ステータス変更ガードと同じ「先に解決の取消」を案内）
  if (target.resolvedAt || target.status === 'resolved') {
    return { code: 'AKO-REQ-025', message: '解決済みの要望は集約を解除できません（先に「解決済み」を取り消してください）' }
  }
  // 取消済みの item からも解除しない（論理削除中の記録のトレースを黙って書き換えない = レビュー R24。先に復元）
  if (item?.archivedAt) {
    return { code: 'AKO-REQ-022', message: '取消済みの改修案件からは解除できません（先に改修案件を復元してください）' }
  }
  // 対応済（決着 = 旧語彙の 運用対応/解決済み/対応見送り 含む）の item からは解除しない（実装済み内容を
  // 再集約プールへ戻さない = 原則2）。解除したい場合は先に item のステータスを戻す（導線は残る = 原則9.5）
  if (item && !isOpenItemStatus(item.status)) {
    return { code: 'AKO-REQ-021', message: '対応済（決着済み）の改修案件からは解除できません（先に改修案件のステータスを戻してから解除してください）' }
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

/** 運用案内（「運用対応」遷移時の必須コメント）のメモ・通知共通の接頭辞（改善要望 2026-08-21） */
export const OPERATIONAL_NOTE_PREFIX = '運用案内: '
/** 運用案内の入力上限（メモ上限から接頭辞分を差し引いた実効値。UI の maxlength・検証メッセージと一致させる） */
export const OPERATIONAL_NOTE_MAX = IMPROVEMENT_NOTE_CAP - [...OPERATIONAL_NOTE_PREFIX].length
/** 運用案内のメモ・通知本文（接頭辞込み。記録 = SoT と通知の本文を常に同一にする） */
export function operationalNoteBody(note: string): string {
  return `${OPERATIONAL_NOTE_PREFIX}${note}`
}
/** 運用案内の上限検証（実効上限でメッセージを出す = 「2000 字以内なのに拒否」の矛盾を作らない）。エラーメッセージ | null */
export function operationalNoteCapError(note: string): string | null {
  if ([...note].length > OPERATIONAL_NOTE_MAX) {
    return `運用案内は ${OPERATIONAL_NOTE_MAX} 文字までで入力してください（メモには「${OPERATIONAL_NOTE_PREFIX.trim()}」の接頭辞込みで記録されます）`
  }
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
 * 未集約の要望を投稿元ページ単位でまとめ、同じページを対象にした既存の **未対応（todo）** item が
 * あればそこへ追記、無ければ新しい改修単位を作る。着手済み・決着済み（対応中/対応済）item には
 * 触れない = 人手のステータス・編集を巻き戻さない（原則2。判定は isClusterAppendTarget = 原則6）。
 */
export function heuristicClusterRequests(
  openItems: ClusterOpenItem[],
  requests: ClusterRequestInput[],
): ClusterPlan {
  const plan: ClusterPlan = { appends: [], creates: [] }
  // 追記先にできるのは未対応の item のみ（着手済み・決着済みは不変）
  const triageItems = openItems.filter(it => isClusterAppendTarget(it.status))

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
  const triageIds = new Set(openItems.filter(it => isClusterAppendTarget(it.status)).map(it => it.id))
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
    if (!triageIds.has(itemId)) continue // 追記先は未対応 item のみ（着手済み・決着済みは保護）
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
   *  status / resolvedAt は要望の受付箱ステータス（解決済み・対応見送りは【解決済み】【対応見送り】として
   *  明記 = プロンプト再生成に反映。判定は promptRequestTag = 原則6）。
   *  targetSpot は対象箇所（ページ内のどこか。省略可 = 旧呼び出しの下位互換。あれば対象ページに併記 =
   *  改修依頼 2026-08-21: 受付箱で表示・編集する対象箇所を改修指示にも反映する）。
   *  createdAt / comments[].createdAt は要望とコメントを 1 本の時系列へ統合するための投稿時刻（省略可 = 下位互換。
   *  省略時は投入順を保持する = 時刻が揃わない旧呼び出しでも決定的。改修依頼 2026-08-19 第4弾）。
   *  comments は受付箱で記録した要望への時系列コメント（省略/空可。要望本文と時系列統合してプロンプトへ反映）。
   *  注: 投稿時の任意タグ（壁打ち/お任せ）は人間運用の意思表示のためプロンプトには含めない（改修依頼 2026-08-19）。 */
  requests: {
    pageLabel: string; pagePath: string; body: string
    targetSpot?: string
    status?: ImprovementRequestStatus | null; resolvedAt?: string | null
    links?: string[]; imageCount?: number
    createdAt?: string
    comments?: { body: string; createdAt?: string }[]
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

/**
 * プロンプト上の要望注記（受付箱ステータスの反映 = 原則6。ラベルは IMPROVEMENT_INBOX_STATUS_META が SoT）。
 * 解決済み（resolvedAt / 旧 status='resolved'）= 反映済みのため再改修しない ／
 * 対応見送り（status='dismissed'）= 実装しない ／ それ以外 = 無印（通常の要望）。
 */
export function promptRequestTag(r: { status?: ImprovementRequestStatus | null; resolvedAt?: string | null }): string {
  if (r.resolvedAt || r.status === 'resolved') return IMPROVEMENT_INBOX_STATUS_META.resolved.label
  if (r.status === 'dismissed') return IMPROVEMENT_INBOX_STATUS_META.dismissed.label
  return ''
}

const DEFAULT_PROMPT_INTRO =
  'あなたは本リポジトリ（Nuxt 4 SPA = `home/` + Hono/PostgreSQL API = `api/` + 共有ドメイン = `shared/domain/`）を'
  + '改修するコーディングエージェントです。以下の改修単位を、対象ページのパス・機能名・改修内容に従って実装してください。'
  + '各単位には根拠となる利用者の要望を添えています。既存の実装規約（home/CONVENTIONS.md・CLAUDE.md）に従い、'
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
    out.push(`- **現在の状態:** ${IMPROVEMENT_ITEM_STATUS_META[improvementItemViewOf(it.status)].label}`)
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
      out.push('**根拠となった利用者の要望（時系列・要望とコメントを統合）:**')
      if (it.requests.some(r => promptRequestTag(r) !== '')) {
        out.push(`（【${IMPROVEMENT_INBOX_STATUS_META.resolved.label}】の要望は反映済みのため再改修しないこと・【${IMPROVEMENT_INBOX_STATUS_META.dismissed.label}】の要望は実装しないこと）`)
      }
      // 要望本文とコメントを 1 本の時系列に統合する（改修依頼 2026-08-19 第4弾）。
      // 従来は「要望（親）＞コメント（子）」の親子構造だったが、要望とコメントを createdAt 昇順で
      // 交互に並べ、検討の流れを時系列で再構成して「要望」として集約する。タイブレーク・時刻欠落は
      // 投入順（seq）で決定的（buildCodingPrompt は決定的関数 = 同入力 → 同出力）。
      interface TimelineEntry { at: string; seq: number; line: string; subs: string[] }
      const timeline: TimelineEntry[] = []
      let seq = 0
      it.requests.forEach((r) => {
        // 対象ページに対象箇所（targetSpot）を併記（改修対象の特定を助ける = 改修依頼 2026-08-21）
        const page = r.pageLabel.trim() || r.pagePath.trim()
        const spot = (r.targetSpot ?? '').trim()
        const where = [page, spot].filter(Boolean).join(' / ')
        // 受付箱ステータス（解決済み・対応見送りは明記 = 反映済み分の再改修・見送り分の実装を防ぐ）
        const tag = promptRequestTag(r)
        const statusTag = tag ? `【${tag}】 ` : ''
        // 添付（リンクは参照先として列挙・画像はアプリ内参照のため件数のみ言及）は該当要望行に付随
        const subs: string[] = []
        for (const link of (r.links ?? []).map(l => l.trim()).filter(Boolean)) subs.push(`  - 参考リンク: ${link}`)
        if ((r.imageCount ?? 0) > 0) subs.push(`  - 添付画像 ${r.imageCount} 件（改善要望ページの要望詳細で参照可能）`)
        timeline.push({
          at: r.createdAt ?? '', seq: seq++, subs,
          line: `- 【要望】 ${where ? `［${where}］ ` : ''}${statusTag}${r.body.trim().replace(/\s*\n\s*/g, ' ')}`,
        })
        // 受付箱で記録した要望への時系列コメント（検討経緯）を同じ時系列へ混ぜる
        for (const c of (r.comments ?? [])) {
          const body = c.body.trim()
          if (!body) continue
          timeline.push({
            at: c.createdAt ?? r.createdAt ?? '', seq: seq++, subs: [],
            line: `- 【コメント】 ${body.replace(/\s*\n\s*/g, ' ')}`,
          })
        }
      })
      // createdAt 昇順（同一書式の JST 文字列で比較 = 1 回のプロンプト生成は同一ソースのため書式一致）。
      // 同時刻・時刻欠落は投入順 seq で安定ソート = 決定的
      timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq))
      for (const t of timeline) { out.push(t.line); for (const s of t.subs) out.push(s) }
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
