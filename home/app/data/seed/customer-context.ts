/**
 * 顧客コンテキストのシード（改修依頼 2026-08-20: トップ層メニュー「顧客コンテキスト」）。
 * デモ用・決定的・今日基準の相対日付（Math.random 禁止 = ~/utils/rng の決定的乱数のみ）。
 * 会社（c-01/c-02/c-03）・記録者（m-03/m-04/m-05）は core シードの id を参照する。
 * - customerContexts: 定性情報（1社1行。ビジョン・経営課題・補足メモ）
 * - customerContextNotes: 時系列メモ（note）+ AI リサーチ反映の自動追記例（research =
 *   payload に採用ソース〔example.com のデモ URL〕と反映前の値を保持 = 「反映を取り消す」の体験用）
 */
import type { CustomerContext, CustomerContextNote } from '~/types/domain'
import { heuristicResearchCandidates } from '../../../../shared/domain/customer-context'
import { addDays, todayJst } from '~/utils/format'
import { pick } from '~/utils/rng'

export function buildCustomerContexts(): CustomerContext[] {
  const today = todayJst()
  const iso = (back: number, time: string): string => `${addDays(today, -back)}T${time}:00+09:00`
  return [
    {
      id: 'cctx-0001',
      companyId: 'c-01', // アケボノ商事
      vision: '「全国の店舗網とデジタルをつなぎ、地域の暮らしを支える小売プラットフォームになる」を中期ビジョンに掲げる。',
      challenges: '・店舗網拡大に伴う SCM の複雑化と在庫最適化\n・本部と店舗の情報連携（週次 CSV 運用からの脱却）\n・データ活用人材の育成',
      strategyNotes: '2026 年度は物流（北都物流との連携含む）とデータ基盤への投資を優先する方針。SCM プラットフォームの追加提案の余地が大きい。',
      updatedByMemberId: 'm-03',
      updatedByName: '葛西 大輔',
      active: true,
      createdAt: iso(20, '10:00'),
      updatedAt: iso(3, '17:30'),
    },
    {
      id: 'cctx-0002',
      companyId: 'c-02', // ウンドゥアパレル
      vision: '「作り手の想いが届く婦人服ブランドとして、店舗と EC の垣根をなくす」ことを目指す。',
      challenges: '・EC 比率向上に向けた在庫の一元管理\n・前年比較・週次分析の手作業依存',
      strategyNotes: '売上分析スイートの更新商談が進行中。分析の自動化が刺さっている。',
      updatedByMemberId: 'm-04',
      updatedByName: '三浦 彩',
      active: true,
      createdAt: iso(15, '11:00'),
      updatedAt: iso(6, '09:45'),
    },
  ]
}

export function buildCustomerContextNotes(): CustomerContextNote[] {
  const today = todayJst()
  const iso = (back: number, time: string): string => `${addDays(today, -back)}T${time}:00+09:00`
  // research ノートの採用ソース例は shared の決定的ヒューリスティックから 2 件採用（デモ URL・再現性あり）
  const sources = heuristicResearchCandidates('アケボノ商事').slice(0, 2).map(s => ({ title: s.title, uri: s.uri }))
  const notes: CustomerContextNote[] = [
    {
      id: 'cnote-0001',
      companyId: 'c-01',
      memberId: 'm-03',
      memberName: '葛西 大輔',
      kind: 'note',
      body: '経営企画室の山田様と面談。次年度の投資計画では物流とデータ基盤が最優先とのこと。SCM 追加提案は 10 月の予算編成前に持ち込みたい。',
      payload: null,
      archivedAt: null,
      createdAt: iso(10, '14:30'),
    },
    {
      id: 'cnote-0002',
      companyId: 'c-01',
      memberId: 'm-04',
      memberName: '三浦 彩',
      kind: 'note',
      body: `サポート窓口経由の情報: 店舗側で CSV 取込の運用負荷への不満が強い（${pick('cnote-freq:c-01', ['週次', '毎日', '月次'] as const)}運用）。定性情報の「経営課題」と整合。`,
      payload: null,
      archivedAt: null,
      createdAt: iso(7, '09:20'),
    },
    {
      id: 'cnote-0003',
      companyId: 'c-01',
      memberId: 'm-03',
      memberName: '葛西 大輔',
      kind: 'research',
      body: `AI リサーチの結果を反映（採用 ${sources.length} 件: ${sources.map(s => s.title).join(' / ')}）`,
      payload: {
        sources,
        before: {
          vision: '',
          challenges: '・店舗網拡大に伴う SCM の複雑化',
          strategyNotes: '',
        },
      },
      archivedAt: null,
      createdAt: iso(3, '17:30'),
    },
    {
      id: 'cnote-0004',
      companyId: 'c-02',
      memberId: 'm-04',
      memberName: '三浦 彩',
      kind: 'note',
      body: '宇野様より: 分析レポートの社内展開が好評。役員会でも週次ダッシュボードが使われ始めた。更新契約の追い風。',
      payload: null,
      archivedAt: null,
      createdAt: iso(6, '16:00'),
    },
    {
      id: 'cnote-0005',
      companyId: 'c-03', // トクタケ製靴（定性情報は未登録 = 「登録」導線のデモ）
      memberId: 'm-05',
      memberName: '小野寺 岳',
      kind: 'note',
      body: '展示会で徳丸様と立ち話。介護施設向けの新ラインを検討中とのこと。定性情報が未整理なので AI リサーチで下書きを作ると良さそう。',
      payload: null,
      archivedAt: null,
      createdAt: iso(4, '18:10'),
    },
  ]
  return notes
}
