/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { AkebonoWish, AuditLog } from '~/types/domain'
import type { ImprovementItem, ImprovementNote, ImprovementRequest, ImprovementRequestComment } from '~/types/improvement'
import { addDays } from '~/utils/format'
import { seedToday } from './history'

const today = seedToday()

export const seedAkebonoWishes: AkebonoWish[] = [
  { id: 'aw-0001', memberId: 'm-04', body: '顧客ごとの提案履歴と結果を横断検索できるようにしてほしい。過去の勝ちパターンを再利用したい。', at: `${addDays(today, -3)}T15:20:00+09:00` },
  { id: 'aw-0002', memberId: 'm-05', body: 'AI 社員に開発タスクのコードレビューまで任せられるようになると嬉しい。', at: `${addDays(today, -1)}T11:05:00+09:00` },
]

/**
 * 改善要望のデモ（F-42。各ページの「要望を送る」から集まった生要望）。
 * 受付箱ステータス（改修依頼 2026-08-21）ごとに 1 件以上のデモを置く:
 * - imreq-0001〜0003/0007 = 改善対応（planned）で集約済み（itemId 付き）→ カンバン/ガントの初期表示
 * - imreq-0004 = 改善対応・未集約（「AI で集約」の動作を体験できる）
 * - imreq-0005 = 検討中（reviewing）/ imreq-0008 = 未確認（unconfirmed = 起票直後の初期値）
 * - imreq-0006 = 対応見送り（dismissed。コメントで理由を残すデモ）
 * - imreq-0009 = 運用対応（operational。運用案内コメント付き）/ imreq-0010 = 継続検討（deferred + 再検討日）
 * - imreq-0011 = 集約先 item が対応済（done）→ 表示は「対応済み」（addressed 導出のデモ）
 */
/** 添付画像デモ用の極小 PNG（1x1。実運用の縮小 data URI と同形式 = 拡大表示の動作確認用） */
const DEMO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const seedImprovementRequests: ImprovementRequest[] = [
  // imreq-0001 は添付（参考リンク + 画像）+ 対象箇所（targetSpot）のデモ。参照時はリンク = 別タブ / 画像 = 押下で拡大。
  { id: 'imreq-0001', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', targetSpot: '一覧の合計欄', body: '売上一覧で合計金額をもっと大きく目立たせてほしい。月次の締めで一番見る数字なので。', status: 'planned', links: ['https://example.com/monthly-close-manual'], images: [{ filename: 'sales-screenshot.png', mime: 'image/png', dataUrl: DEMO_PNG }], itemId: 'imp-0001', archivedAt: null, createdAt: `${addDays(today, -8)}T10:12:00+09:00` },
  { id: 'imreq-0002', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/akebono/sales', pageLabel: 'AKEBONO 売上', body: '税込・税抜の表示を切り替えられるようにしたい。得意先によって見たい方が違う。', status: 'planned', itemId: 'imp-0001', archivedAt: null, createdAt: `${addDays(today, -7)}T14:40:00+09:00` },
  { id: 'imreq-0003', memberId: 'm-03', memberName: '葛西 大輔', pagePath: '/timecard', pageLabel: 'タイムカード', targetSpot: '出勤・退勤ボタン', body: '打刻を押し間違えたときに取り消せるようにしてほしい。今は修正申請しかなく手間。', status: 'planned', itemId: 'imp-0002', archivedAt: null, createdAt: `${addDays(today, -5)}T09:03:00+09:00` },
  // imreq-0004 = 「お任せ」タグ（開発側の解釈で進めてよい）/ imreq-0005 = 「壁打ち」タグ（壁打ちを経て案件化したい）のデモ = F-42-17
  { id: 'imreq-0004', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/reports', pageLabel: '日報・週報', body: '日報の下書きを前日分からコピーできるようにしてほしい。定型の作業報告が多いので。', status: 'planned', tags: ['entrust'], itemId: null, archivedAt: null, createdAt: `${addDays(today, -2)}T18:30:00+09:00` },
  { id: 'imreq-0005', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/masters/members', pageLabel: 'メンバー管理', body: 'メンバー一覧を部署で絞り込めるようにしてほしい。人数が増えて探しづらい。', status: 'reviewing', tags: ['brainstorm'], itemId: null, archivedAt: null, createdAt: `${addDays(today, -1)}T13:15:00+09:00` },
  { id: 'imreq-0006', memberId: 'm-03', memberName: '葛西 大輔', pagePath: '/settings', pageLabel: '設定', body: '画面の配色を自分好みに完全カスタマイズできるようにしてほしい。', status: 'dismissed', itemId: null, archivedAt: null, createdAt: `${addDays(today, -1)}T16:45:00+09:00` },
  // imreq-0007 = 対応中（in_progress）デモの元要望（カンバンの「対応中」列）
  { id: 'imreq-0007', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/shift', pageLabel: 'シフト表', body: '確定シフトを CSV でダウンロードできるようにしてほしい。給与計算の突合に使いたい。', status: 'planned', itemId: 'imp-0003', archivedAt: null, createdAt: `${addDays(today, -9)}T11:05:00+09:00` },
  // imreq-0008〜0011 = 受付箱ステータス再編（2026-08-21）の各状態デモ
  { id: 'imreq-0008', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/attendance', pageLabel: '勤怠管理', body: '月別の残業時間の推移をグラフでも見られるようにしてほしい。', status: 'unconfirmed', itemId: null, archivedAt: null, createdAt: `${addDays(today, 0)}T09:05:00+09:00` },
  { id: 'imreq-0009', memberId: 'm-05', memberName: '小野寺 岳', pagePath: '/reports', pageLabel: '日報・週報', targetSpot: '週報の一覧', body: '先週の週報をまとめて印刷したい。', status: 'operational', itemId: null, archivedAt: null, createdAt: `${addDays(today, -3)}T10:30:00+09:00` },
  { id: 'imreq-0010', memberId: 'm-03', memberName: '葛西 大輔', pagePath: '/akebono/inventory', pageLabel: 'AKEBONO 在庫', body: '棚卸しの結果を CSV で一括取込できるようにしてほしい。', status: 'deferred', revisitOn: addDays(today, 7), itemId: null, archivedAt: null, createdAt: `${addDays(today, -4)}T15:00:00+09:00` },
  { id: 'imreq-0011', memberId: 'm-04', memberName: '三浦 彩', pagePath: '/inbox', pageLabel: '通知', body: '通知をまとめて既読にしたい。未読が溜まると 1 件ずつ消すのが大変。', status: 'planned', itemId: 'imp-0004', archivedAt: null, createdAt: `${addDays(today, -14)}T09:40:00+09:00` },
]

/** 生要望へのコメント（検討のやり取りデモ。見送り理由・確認事項・運用案内を時系列で残す） */
export const seedImprovementRequestComments: ImprovementRequestComment[] = [
  { id: 'imcmt-0001', requestId: 'imreq-0006', memberId: 'm-01', memberName: '山下 誠', body: 'ブランド統一のため配色の完全カスタマイズは見送ります（ダッシュボードのレイアウト・密度設定で近いことは可能です）。', archivedAt: null, createdAt: `${addDays(today, -1)}T17:10:00+09:00` },
  { id: 'imcmt-0002', requestId: 'imreq-0005', memberId: 'm-01', memberName: '山下 誠', body: '対象は「全員のタイムカード」の絞り込みと同じ部署セレクトの想定で良いですか？', archivedAt: null, createdAt: `${addDays(today, 0)}T09:20:00+09:00` },
  // 運用対応（operational）への遷移で自動記録される運用案内のデモ（実操作では遷移時に必須入力 + 起票者へ通知。
  // kind='ops' = 起票者本人の「解決の記録」にも表示される行の判別キー = 0083）
  { id: 'imcmt-0003', requestId: 'imreq-0009', memberId: 'm-01', memberName: '山下 誠', body: '運用案内: 週報の一覧で対象週を表示し、ブラウザの印刷（Ctrl+P）で PDF 保存・印刷できます。', kind: 'ops', archivedAt: null, createdAt: `${addDays(today, -2)}T11:00:00+09:00` },
]

/**
 * 改修単位のデモ（F-42。AI 集約の結果を模した初期データ）。3 状態（2026-08-21 再編）:
 * imp-0001 = 未対応（todo。対応予定期間あり = ガントにバー表示）／imp-0002 = 未対応（予定未定）／
 * imp-0003 = 対応中（in_progress + 担当者アサインのデモ）／imp-0004 = 対応済（done = カンバン「対応済」列）。
 */
export const seedImprovementItems: ImprovementItem[] = [
  {
    id: 'imp-0001',
    title: '「AKEBONO 売上」の表示改善（合計の強調・税表示切替）',
    summary: '売上一覧で合計金額を大きく強調し、税込/税抜を切り替えられるようにする。',
    detail: '### 対象ページ: AKEBONO 売上（`/akebono/sales`）\n\n**寄せられた要望 2 件:**\n1. 合計金額をもっと大きく目立たせてほしい（月次の締めで一番見る数字）\n2. 税込・税抜の表示を切り替えたい（得意先によって見たい方が違う）',
    status: 'todo',
    pagePaths: ['/akebono/sales'],
    sourceRequestIds: ['imreq-0001', 'imreq-0002'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -6)}T09:00:00+09:00`,
    updatedAt: `${addDays(today, -3)}T09:00:00+09:00`,
    resolvedAt: null,
    planStart: addDays(today, -2),
    planEnd: addDays(today, 9),
  },
  {
    id: 'imp-0002',
    title: '「タイムカード」の打刻取消を可能にする',
    summary: '押し間違えた打刻をその場で取り消せるようにする（修正申請なしで戻せる導線）。',
    detail: '### 対象ページ: タイムカード（`/timecard`）\n\n**寄せられた要望 1 件:**\n1. 打刻を押し間違えたときに取り消せるようにしてほしい（今は修正申請しかなく手間）',
    status: 'todo',
    pagePaths: ['/timecard'],
    sourceRequestIds: ['imreq-0003'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -4)}T09:00:00+09:00`,
    updatedAt: `${addDays(today, -4)}T09:00:00+09:00`,
    resolvedAt: null,
    planStart: null,
    planEnd: null,
  },
  {
    id: 'imp-0003',
    title: '「シフト表」の確定シフト CSV ダウンロード',
    summary: '確定シフトを CSV でダウンロードできるようにする（給与計算の突合用）。',
    detail: '### 対象ページ: シフト表（`/shift`）\n\n**寄せられた要望 1 件:**\n1. 確定シフトを CSV でダウンロードできるようにしてほしい（給与計算の突合に使いたい）',
    status: 'in_progress',
    assigneeMemberId: 'm-03',
    assigneeName: '葛西 大輔',
    pagePaths: ['/shift'],
    sourceRequestIds: ['imreq-0007'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -9)}T12:00:00+09:00`,
    updatedAt: `${addDays(today, -1)}T15:30:00+09:00`,
    resolvedAt: null,
    planStart: addDays(today, -3),
    planEnd: addDays(today, 4),
  },
  {
    id: 'imp-0004',
    title: '「通知」の一括既読',
    summary: '通知一覧に「すべて既読にする」を用意し、未読をまとめて消せるようにする。',
    detail: '### 対象ページ: 通知（`/inbox`）\n\n**寄せられた要望 1 件:**\n1. 通知をまとめて既読にしたい（未読が溜まると 1 件ずつ消すのが大変）',
    status: 'done',
    pagePaths: ['/inbox'],
    sourceRequestIds: ['imreq-0011'],
    llm: false,
    archivedAt: null,
    createdAt: `${addDays(today, -13)}T09:00:00+09:00`,
    updatedAt: `${addDays(today, -10)}T17:00:00+09:00`,
    resolvedAt: `${addDays(today, -10)}T17:00:00+09:00`,
    planStart: addDays(today, -12),
    planEnd: addDays(today, -10),
  },
]

/**
 * 改修単位の時系列メモのデモ（F-42 追補・2026-08-12）。
 * 改修方針の検討過程を 1 件ずつ時系列で残す。AI 改修プロンプト生成時にも加味される。
 */
export const seedImprovementNotes: ImprovementNote[] = [
  {
    id: 'imnote-0001', itemId: 'imp-0001', memberId: 'm-03', memberName: '葛西 大輔',
    body: '合計の強調は既存の UiKpiCard を流用できそう。税込/税抜トグルは会社設定の既定税率を参照する方針で。',
    kind: 'note', archivedAt: null, createdAt: `${addDays(today, -3)}T10:12:00+09:00`,
  },
  {
    id: 'imnote-0002', itemId: 'imp-0001', memberId: 'm-01', memberName: '山下 誠',
    body: '得意先ごとの既定（税込/税抜）は将来対応。まずは画面上のトグルのみで着手する。',
    kind: 'note', archivedAt: null, createdAt: `${addDays(today, -2)}T14:40:00+09:00`,
  },
]

export const seedAuditLogs: AuditLog[] = []
