/**
 * データ基盤（改善要望 2026-08-22: 3 カテゴリ = 自社コンテキスト / ナレッジ / ログ）の
 * ナレッジ・ログ系デモシード（モックモード用。決定的・今日基準の相対日付・乱数不使用）。
 * API モードでは使われない（共通 API の実データ = /v1/notes・/v1/media/weekly-reports・
 * /v1/akebono/payment-notices・/v1/akebono/dashboard-insights/list・/v1/internal-supports を読む）。
 */
import type { InternalSupport, Note } from '~/types/domain'
import { mediaWeekStartOf, type MediaWeeklyReport } from '../../../../shared/domain/media-weekly-report'
import { addMonths } from '../../../../shared/domain/intelligence'
import type { ConsignmentReport, EcReport } from '~/types/foundation'
import { addDays, todayJst } from '~/utils/format'

const iso = (date: string, time: string): string => `${date}T${time}:00+09:00`

/** 議事録（Note kind='minutes'。全員参照 C2 = Home /minutes と同じ可視性） */
export function buildMinutes(): Note[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const row = (id: string, back: number, time: string, title: string, body: string,
    memberId: string, projectId: string | null): Note => ({
    id, memberId, kind: 'minutes', title, body, projectId, companyId: null,
    workCategoryId: null, source: 'text', createdAt: iso(d(back), time), active: true,
  })
  return [
    row('min-0001', 1, '15:00', '週次定例（プロジェクト進捗）',
      '## 決定事項\n- SCM 導入の第2フェーズは 9 月着手で確定\n- テスト環境の増強を先行実施\n\n## 持ち越し\n- データ移行のリハーサル日程', 'm-03', 'pj-01'),
    row('min-0002', 3, '10:30', '経営会議（月次レビュー）',
      '## 議題\n- 月次売上と受注パイプラインの確認\n- サポート問い合わせの傾向共有\n\n## 決定事項\n- 停滞商談のフォロー体制を強化する', 'm-01', null),
    row('min-0003', 7, '14:00', 'アケボノ商事 定例打ち合わせ',
      '- CSV 取込エラーの恒久対策を提示し合意\n- 次回は在庫分析レポートのデモを実施', 'm-04', 'pj-01'),
  ]
}

/** メディアレポート（AI 週次レポート。Home /media/reports の保管形と同形） */
export function buildMediaReports(): MediaWeeklyReport[] {
  const today = todayJst()
  const thisWeek = mediaWeekStartOf(today)
  const week = (back: number): string => addDays(thisWeek, -7 * back)
  const report = (id: string, back: number, sessions: string, focus: string): MediaWeeklyReport => ({
    id,
    channelId: 'mch-01',
    weekStart: week(back),
    periodFrom: week(back),
    periodTo: addDays(week(back), 6),
    content: {
      executiveSummary: [
        `セッションは週合計 ${sessions}。${focus}`,
        'CV への貢献は資料請求ページ経由が中心。',
      ],
      changes: [
        { direction: 'up', label: 'オーガニック流入', value: '+12.4%', detail: '主要 3 記事の検索順位改善による' },
      ],
      hypotheses: ['比較系キーワードの需要増が流入を押し上げている'],
      ratings: [],
      actions: [
        {
          title: '比較記事の内部リンク強化', reason: '流入増の受け皿となる CV 導線が弱い',
          expectedEffect: '資料請求 CVR の改善', priority: 'high', decision: '未判断',
        },
      ],
    },
    llm: false,
    generatedAt: iso(addDays(week(back), 7), '06:00'),
  })
  return [
    report('mwr-0001', 1, '1,240', '前週比 +8% と堅調。'),
    report('mwr-0002', 2, '1,148', '4 週平均と同水準。'),
  ]
}

/** ECレポート（AKEBONO ダッシュボードの AI 分析レポート。/list エンドポイントの返却形と同形） */
export function buildEcReports(): EcReport[] {
  const today = todayJst()
  const month = today.slice(0, 7)
  return [
    {
      id: 'di-0001',
      scope: 'segment',
      segmentId: 'seg-ec',
      segmentName: 'EC',
      periodKey: month,
      insight: {
        executiveSummary: `${month} の EC 売上は前月比 +6%。定期便の継続率が伸びを支えています。`,
        findings: [
          { kind: 'win', title: '定期便の継続率が改善', detail: '解約率が前月比で 1.2pt 低下' },
          { kind: 'opportunity', title: 'ギフト需要の取りこぼし', detail: 'ギフト包装オプションの選択率が低い' },
        ],
        actions: [
          { title: 'ギフト導線の見直し', detail: '商品ページにギフト訴求を追加する', priority: 'mid' },
        ],
      },
      llm: false,
      generatedAt: iso(addDays(today, -2), '07:00'),
      generatedByName: '葛西 大輔',
    },
  ]
}

/** 委託販売レポート（支払通知書 = 委託精算の確定レポート） */
export function buildConsignmentReports(): ConsignmentReport[] {
  const today = todayJst()
  const month = today.slice(0, 7)
  // 前月は共有 addMonths で導出（1 月の年繰り下がりを正しく扱う = 原則3。レビュー R1）
  const prev = addMonths(month, -1)
  return [
    {
      id: 'pn-0001', code: 'PN-2026-0012', companyId: 'c-02', segmentId: 'seg-consign',
      periodFrom: `${prev}-01`, periodTo: `${prev}-28`, status: 'confirmed',
      payableAmount: 128_400,
      lines: [
        { id: 'pnl-01', description: '委託販売 手芸雑貨（12 点）', amount: 96_000 },
        { id: 'pnl-02', description: '委託販売 アクセサリー（4 点）', amount: 32_400 },
      ],
    },
    {
      id: 'pn-0002', code: 'PN-2026-0011', companyId: 'c-04', segmentId: 'seg-consign',
      periodFrom: `${prev}-01`, periodTo: `${prev}-28`, status: 'issued',
      payableAmount: 54_000,
      lines: [{ id: 'pnl-03', description: '委託販売 木工小物（6 点）', amount: 54_000 }],
    },
  ]
}

/** 社内サポート活動（Home F-57 と同形。Intelligence のナレッジ「社内サポート」の材料） */
export function buildInternalSupports(): InternalSupport[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const row = (id: string, back: number, time: string | null, performer: string, target: string,
    task: string, method: string, feedback: string): InternalSupport => ({
    id, memberId: performer, activityDate: d(back), activityTime: time,
    performerMemberId: performer, targetMemberId: target,
    taskDescription: task, method, feedback,
    createdAt: iso(d(back), time ?? '18:00'), updatedAt: iso(d(back), time ?? '18:00'), active: true,
  })
  return [
    row('isp-0001', 1, '15:00', 'm-03', 'm-06',
      '顧客向け提案資料の構成づくり。論点整理と根拠データの見せ方をレビューしながら一緒に作成。',
      'ペアワーク', '構成テンプレートを共有。次回から自走できる見込み。'),
    row('isp-0002', 3, '10:00', 'm-05', 'm-08',
      '深夜バッチ障害の一次対応手順。実際のログを使ってエスカレーション判断まで確認。',
      'Web会議', '一次対応チェックリストを整備。次のオンコール当番から一人で対応予定。'),
    row('isp-0003', 6, null, 'm-04', 'm-07',
      'サポート問い合わせ記録の書き方（内容・状況・対応の 3 区分）。過去の良い記録例で説明。',
      'チャット', ''),
  ]
}
