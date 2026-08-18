/**
 * 活動記録 3 種のシード（サポート/営業/ビジネスパートナー活動。改修依頼 2026-08-18・F-43/F-44/F-45）。
 * デモ用・決定的・今日基準の相対日付。記録者（member）・会社（company）は core シードの id を参照する。
 * チーム共有の記録系（全員が閲覧・編集できる）のため、記録者は m-03/m-04/m-05 に分散させる。
 */
import type { PartnerActivity, SalesActivity, SupportActivity } from '~/types/domain'
import { addDays } from '~/utils/format'

export function buildSupportActivities(): SupportActivity[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const iso = (back: number, time: string): string => `${d(back)}T${time}:00+09:00`

  const rows: Array<Omit<SupportActivity, 'createdAt' | 'updatedAt'> & { back: number; at: string }> = [
    {
      id: 'sup-0001', memberId: 'm-04', back: 0, at: '10:30',
      receivedDate: d(0), receivedTime: '10:30', companyId: 'c-01', inquirerName: '山田様',
      targetSystem: '在庫管理システム', category: 'データ', title: 'CSVが取り込めない',
      body: '受注CSVをアップロードするとエラーになる。昨日までは正常に取り込めていたとのこと。',
      priority: '高', status: '対応中', staffMemberId: 'm-04',
      response: 'CSVの日付フォーマットを確認中。エラーログの提供を依頼。',
      cause: '', resolution: '', completedDate: null, completedTime: null,
      knowledgeNote: '日付形式を自動変換できないか',
    },
    {
      id: 'sup-0002', memberId: 'm-04', back: 2, at: '14:00',
      receivedDate: d(2), receivedTime: '14:00', companyId: 'c-02', inquirerName: '宇野様',
      targetSystem: '売上分析スイート', category: '操作', title: '週次レポートの出力手順',
      body: '週次ダッシュボードのPDF出力方法がわからない。',
      priority: '通常', status: '解決', staffMemberId: 'm-04',
      response: '画面共有で出力手順を案内。操作マニュアルの該当ページを送付。',
      cause: 'マニュアルの記載箇所がわかりにくい', resolution: '手順書 v2.3 の該当ページを案内し解決',
      completedDate: d(2), completedTime: '15:00',
      knowledgeNote: 'よくある質問としてFAQに追加する',
    },
    {
      id: 'sup-0003', memberId: 'm-05', back: 4, at: '09:15',
      receivedDate: d(4), receivedTime: '09:15', companyId: 'c-04', inquirerName: '北原様',
      targetSystem: '配送連携API', category: '不具合', title: '連携APIのタイムアウト',
      body: '深夜バッチの配送データ連携が断続的にタイムアウトする。',
      priority: '緊急', status: '顧客確認待ち', staffMemberId: 'm-05',
      response: 'リトライ間隔の調整パッチを適用。先方システム部に動作確認を依頼中。',
      cause: '先方ネットワークのメンテナンス時間帯と重複', resolution: '',
      completedDate: null, completedTime: null,
      knowledgeNote: 'バッチ時間帯の顧客メンテナンス予定を事前共有してもらう運用に',
    },
    {
      id: 'sup-0004', memberId: 'm-03', back: 6, at: '16:45',
      receivedDate: d(6), receivedTime: '16:45', companyId: 'c-03', inquirerName: '徳丸様',
      targetSystem: 'AIアシスタント', category: '要望', title: '入力補助の強化要望',
      body: '現場メンバーの入力負担を減らすため、音声入力に対応してほしい。',
      priority: '低', status: '保留', staffMemberId: 'm-03',
      response: '要望として開発チームへ連携。優先度を検討中。',
      cause: '', resolution: '', completedDate: null, completedTime: null,
      knowledgeNote: '要望管理へ起票済み。同種の要望が増えたら優先度を上げる',
    },
    {
      id: 'sup-0005', memberId: 'm-05', back: 8, at: '11:00',
      receivedDate: d(8), receivedTime: '11:00', companyId: 'c-05', inquirerName: '南様',
      targetSystem: '生産管理システム', category: '設定', title: '新工場の拠点追加設定',
      body: '第二工場の稼働開始に伴い、拠点マスタの追加設定をお願いしたい。',
      priority: '通常', status: '未対応', staffMemberId: 'm-05',
      response: '', cause: '', resolution: '', completedDate: null, completedTime: null,
      knowledgeNote: '',
    },
  ]

  return rows.map(r => ({
    ...r,
    createdAt: iso(r.back, r.at),
    updatedAt: iso(r.back, r.at),
    active: true,
  }))
}

export function buildSalesActivities(): SalesActivity[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const f = (fwd: number): string => addDays(today, fwd)
  const iso = (back: number, time: string): string => `${d(back)}T${time}:00+09:00`

  const rows: Array<Omit<SalesActivity, 'createdAt' | 'updatedAt'> & { back: number; at: string }> = [
    {
      id: 'deal-0001', memberId: 'm-03', back: 1, at: '15:00',
      companyId: 'c-01', title: '在庫管理DXプロジェクト', dealType: '新規', staffMemberId: 'm-03',
      phase: '提案', amount: 1_500_000, probability: 60, expectedCloseDate: f(40),
      customerIssue: 'CSV加工に毎週3時間かかっている',
      proposal: 'CSV取込・変換の自動化と在庫最適化モジュールの導入',
      nextAction: 'デモ実施', nextActionDate: f(7),
    },
    {
      id: 'deal-0002', memberId: 'm-04', back: 3, at: '10:30',
      companyId: 'c-02', title: '売上分析スイート更新', dealType: '更新', staffMemberId: 'm-04',
      phase: '見積', amount: 800_000, probability: 80, expectedCloseDate: f(20),
      customerIssue: '前年同週比の分析に手作業が発生',
      proposal: '週次ダッシュボードへの前年比較機能の追加',
      nextAction: '見積書の提出', nextActionDate: f(3),
    },
    {
      id: 'deal-0003', memberId: 'm-05', back: 5, at: '13:00',
      companyId: 'c-08', title: '生産管理システム刷新', dealType: '新規', staffMemberId: 'm-05',
      phase: 'ヒアリング', amount: 5_000_000, probability: 30, expectedCloseDate: f(90),
      customerIssue: '現行システムの保守期限切れ。紙運用との二重管理',
      proposal: 'RFP作成支援から要件定義・段階導入まで伴走',
      nextAction: '要件優先度のすり合わせMTG', nextActionDate: f(10),
    },
    {
      id: 'deal-0004', memberId: 'm-03', back: 9, at: '11:00',
      companyId: 'c-07', title: 'DX構想策定支援', dealType: '追加', staffMemberId: 'm-03',
      phase: '受注', amount: 1_200_000, probability: 100, expectedCloseDate: d(2),
      customerIssue: '業務の可視化が進んでおらずDXの起点が定まらない',
      proposal: '現状業務の可視化ワークショップ（3ヶ月）',
      nextAction: 'キックオフ日程の確定', nextActionDate: f(5),
    },
    {
      id: 'deal-0005', memberId: 'm-04', back: 14, at: '16:00',
      companyId: 'c-05', title: '冷凍ライン歩留まり分析', dealType: '新規', staffMemberId: 'm-04',
      phase: '初回', amount: null, probability: 10, expectedCloseDate: null,
      customerIssue: '冷凍ラインの歩留まりが目標未達',
      proposal: '',
      nextAction: '分析観点の提示', nextActionDate: f(14),
    },
  ]

  return rows.map(r => ({
    ...r,
    createdAt: iso(r.back, r.at),
    updatedAt: iso(r.back, r.at),
    active: true,
  }))
}

export function buildPartnerActivities(): PartnerActivity[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const f = (fwd: number): string => addDays(today, fwd)
  const iso = (back: number, time: string): string => `${d(back)}T${time}:00+09:00`

  const rows: Array<Omit<PartnerActivity, 'createdAt' | 'updatedAt'> & { back: number; at: string }> = [
    {
      id: 'pact-0001', memberId: 'm-03', back: 2, at: '10:00',
      partnerName: '川上さん', theme: 'フローラ社との協業検討', relatedCompany: 'フローラ',
      activityType: '共創', status: '進行中',
      summary: 'フローラ社との花き流通データ連携について協業の可能性を検討',
      currentState: '先方担当者と初回協議済み。データ提供範囲を調整中',
      nextAction: '3者MTG', nextActionDate: f(20),
      staffMemberId: 'm-03', relatedMeeting: `${f(20).slice(5).replace('-', '/')} フローラMTG`,
      relatedSalesActivityId: null, memo: '案件化したら商談へリンクする',
    },
    {
      id: 'pact-0002', memberId: 'm-05', back: 5, at: '14:30',
      partnerName: '西村さん', theme: '製造業DX案件の紹介', relatedCompany: 'テクノパーツ',
      activityType: '案件支援', status: '案件化',
      summary: 'テクノパーツ社の生産管理システム刷新案件を紹介いただき案件化',
      currentState: '商談フェーズへ移行済み（ヒアリング中）。RFP作成を支援',
      nextAction: '紹介元への進捗共有', nextActionDate: f(12),
      staffMemberId: 'm-05', relatedMeeting: '',
      relatedSalesActivityId: 'deal-0003', memo: '紹介経由の商談は進捗を毎週共有する約束',
    },
    {
      id: 'pact-0003', memberId: 'm-05', back: 10, at: '11:00',
      partnerName: '田代さん', theme: 'AI人材育成プログラム', relatedCompany: '',
      activityType: '情報交換', status: '検討',
      summary: '自治体向けAI人材育成の共同プログラム構想の情報交換',
      currentState: '先方の予算化タイミング（来期）を待つ',
      nextAction: '来期予算の確定状況を確認', nextActionDate: f(30),
      staffMemberId: 'm-05', relatedMeeting: '',
      relatedSalesActivityId: null, memo: '',
    },
    {
      id: 'pact-0004', memberId: 'm-03', back: 15, at: '09:30',
      partnerName: '曙さん', theme: 'ホテル業界の紹介ネットワーク', relatedCompany: 'シーサイドホテルズ',
      activityType: '紹介', status: '完了',
      summary: 'シーサイドホテルズ取締役の紹介を受け、DX構想支援の商談につながった',
      currentState: '紹介案件は受注済み。お礼と進捗報告済み',
      nextAction: '', nextActionDate: null,
      staffMemberId: 'm-03', relatedMeeting: '',
      relatedSalesActivityId: 'deal-0004', memo: '今後も業界内の紹介が期待できる関係',
    },
  ]

  return rows.map(r => ({
    ...r,
    createdAt: iso(r.back, r.at),
    updatedAt: iso(r.back, r.at),
    active: true,
  }))
}
