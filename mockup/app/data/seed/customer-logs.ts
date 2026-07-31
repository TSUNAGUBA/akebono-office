/**
 * 顧客ログのシード（デモ用・決定的・今日基準の相対日付）。
 * 記録者（member）・会社（company）・担当者（contact）は core シードの id を参照する。
 * 既定デモユーザー m-03（葛西）の記録を含め、権限デモ用に他メンバー（m-04/m-05）の記録も置く。
 * 属性タグ・開始/終了時刻・自社担当者・担当者メモ/議事録メモは 2026-07-31 の項目拡張
 * （旧データの body は担当者メモとして継続 = 原則7 の互換方針をシードにも反映）。
 */
import type { CustomerLog } from '~/types/domain'
import { addDays } from '~/utils/format'

export function buildCustomerLogs(): CustomerLog[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const iso = (back: number, time: string): string => `${d(back)}T${time}:00+09:00`

  const rows: Array<Omit<CustomerLog, 'createdAt' | 'updatedAt'> & { back: number; at: string }> = [
    {
      id: 'clog-0001', memberId: 'm-03', back: 1, at: '14:30',
      logDate: d(1), logTime: '14:30', endTime: '15:30', companyId: 'c-01', contactId: 'p-01',
      staffMemberId: 'm-03', tags: ['商談'],
      title: 'SCM 追加提案の打診',
      body: '曙執行役員へ在庫最適化モジュールの追加提案を打診。効果は数字で示すと刺さるとのこと。来月の役員会前に ROI 試算を持参する約束。競合の動きも気にされていた。',
      minutesMemo: '・在庫最適化モジュールの追加提案を打診\n・次回: 役員会前に ROI 試算を持参\n・競合動向のヒアリング継続',
    },
    {
      id: 'clog-0002', memberId: 'm-03', back: 3, at: '10:00',
      logDate: d(3), logTime: null, endTime: null, companyId: 'c-04', contactId: 'p-08',
      staffMemberId: 'm-03', tags: ['定例'],
      title: '',
      body: '北都物流・北原部長と定例。アケボノ商事向けの配送データ連携でAPI仕様の確認。先方システム部の対応が来週にずれる見込み。',
      minutesMemo: '',
    },
    {
      id: 'clog-0003', memberId: 'm-04', back: 1, at: '11:15',
      logDate: d(1), logTime: '11:15', endTime: null, companyId: 'c-02', contactId: 'p-04',
      staffMemberId: 'm-04', tags: ['商談'],
      title: '売上分析スイートの更新要望',
      body: 'ウンドゥ・宇野本部長より週次ダッシュボードに前年同週比の追加要望。MD部の堂島課長と実データで擦り合わせ予定。',
      minutesMemo: '',
    },
    {
      id: 'clog-0004', memberId: 'm-04', back: 5, at: '16:00',
      logDate: d(5), logTime: '16:00', endTime: '17:00', companyId: 'c-05', contactId: 'p-09',
      staffMemberId: 'm-04', tags: ['取材'],
      title: '',
      body: 'みなみ食品・南工場長と現場改善のヒアリング。冷凍ラインの歩留まりデータを提供いただけることに。次回、分析観点を提示する。',
      minutesMemo: '・冷凍ラインの歩留まりデータ提供に合意\n・次回: 分析観点の提示',
    },
    {
      id: 'clog-0005', memberId: 'm-05', back: 2, at: '11:00',
      logDate: d(2), logTime: '11:00', endTime: null, companyId: 'c-03', contactId: 'p-06',
      staffMemberId: 'm-05', tags: [],
      title: 'AI活用の現場負担への懸念',
      body: 'トクタケ・徳丸室長。AI導入に前向きだが現場の入力負担増を最も懸念。既存フローに溶け込む形を設計する必要あり。桜井主任にも一度ヒアリングを。',
      minutesMemo: '',
    },
    {
      id: 'clog-0006', memberId: 'm-05', back: 4, at: '',
      logDate: d(4), logTime: null, endTime: null, companyId: 'c-08', contactId: 'p-12',
      staffMemberId: 'm-05', tags: ['商談'],
      title: 'RFP作成支援',
      body: 'テクノパーツ・真鍋部長より生産管理システム刷新のRFP作成を支援。要件の優先度整理まで完了。提案は来月頭。',
      minutesMemo: '',
    },
    {
      id: 'clog-0007', memberId: 'm-03', back: 6, at: '15:30',
      logDate: d(6), logTime: '15:30', endTime: '16:15', companyId: 'c-07', contactId: 'p-11',
      staffMemberId: 'm-03', tags: ['イベント'],
      title: 'DX構想キックオフ',
      body: 'シーサイドホテルズ・汐見取締役とDX構想のキックオフ。曙氏の紹介案件。まず現状業務の可視化から着手する方針で合意。',
      minutesMemo: '・DX構想キックオフ（紹介: 曙氏）\n・現状業務の可視化から着手で合意',
    },
  ]

  return rows.map(r => ({
    id: r.id,
    memberId: r.memberId,
    logDate: r.logDate,
    logTime: r.logTime,
    endTime: r.endTime,
    companyId: r.companyId,
    contactId: r.contactId,
    staffMemberId: r.staffMemberId,
    tags: r.tags,
    title: r.title,
    body: r.body,
    minutesMemo: r.minutesMemo,
    createdAt: iso(r.back, r.at || '09:00'),
    updatedAt: iso(r.back, r.at || '09:00'),
    active: true,
  }))
}
