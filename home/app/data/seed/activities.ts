/**
 * 活動記録 3 種のシード（サポート/営業/ビジネスパートナー活動。改修依頼 2026-08-18・F-43/F-44/F-45）
 * + 活動ログ（案件ヘッダー + 活動ログ構造。改修依頼 2026-08-20・Units 2+4）。
 * デモ用・決定的・今日基準の相対日付（Math.random 禁止 = ~/utils/rng の決定的乱数のみ）。
 * 記録者（member）・会社（company）は core シードの id を参照する。
 * チーム共有の記録系（全員が閲覧・編集できる）のため、記録者は m-03/m-04/m-05 に分散させる。
 */
import { ACTIVITY_LOG_KINDS, type ActivityLog, type PartnerActivity, type SalesActivity, type SupportActivity } from '~/types/domain'
import { addDays } from '~/utils/format'
import { pick } from '~/utils/rng'

export function buildSupportActivities(): SupportActivity[] {
  const today = todayJst()
  const d = (back: number): string => addDays(today, -back)
  const iso = (back: number, time: string): string => `${d(back)}T${time}:00+09:00`

  const rows: Array<Omit<SupportActivity, 'createdAt' | 'updatedAt'> & { back: number; at: string }> = [
    {
      id: 'sup-0001', memberId: 'm-04', back: 0, at: '10:30',
      receivedDate: d(0), receivedTime: '10:30', villageId: 'vil-01', firstContactMethod: 'メール',
      companyId: 'c-01', inquirerName: '山田様',
      targetSystem: '在庫管理システム', targetLocation: 'CSV取込画面', category: 'データ', title: 'CSVが取り込めない',
      body: '内容：受注CSVをアップロードするとエラーになる。\n状況：昨日までは正常に取り込めていたとのこと。\n対応：CSVの日付フォーマットを確認中。',
      priority: '高', status: '対応中', staffMemberId: 'm-04',
      response: 'CSVの日付フォーマットを確認中。エラーログの提供を依頼。',
      cause: '', resolution: '', completedDate: null, completedTime: null,
      knowledgeNote: '日付形式を自動変換できないか', links: [],
    },
    {
      id: 'sup-0002', memberId: 'm-04', back: 2, at: '14:00',
      receivedDate: d(2), receivedTime: '14:00', villageId: 'vil-01', firstContactMethod: '電話',
      companyId: 'c-02', inquirerName: '宇野様',
      targetSystem: '売上分析スイート', targetLocation: 'ダッシュボード > PDF出力', category: '操作', title: '週次レポートの出力手順',
      body: '週次ダッシュボードのPDF出力方法がわからない。',
      priority: '通常', status: '解決', staffMemberId: 'm-04',
      response: '画面共有で出力手順を案内。操作マニュアルの該当ページを送付。',
      cause: 'マニュアルの記載箇所がわかりにくい', resolution: '手順書 v2.3 の該当ページを案内し解決',
      completedDate: d(2), completedTime: '15:00',
      knowledgeNote: 'よくある質問としてFAQに追加する', links: [],
    },
    {
      id: 'sup-0003', memberId: 'm-05', back: 4, at: '09:15',
      receivedDate: d(4), receivedTime: '09:15', villageId: 'vil-02', firstContactMethod: 'チャット',
      companyId: 'c-04', inquirerName: '北原様',
      targetSystem: '配送連携API', targetLocation: '深夜バッチ連携', category: '不具合', title: '連携APIのタイムアウト',
      body: '深夜バッチの配送データ連携が断続的にタイムアウトする。',
      priority: '緊急', status: '顧客確認待ち', staffMemberId: 'm-05',
      response: 'リトライ間隔の調整パッチを適用。先方システム部に動作確認を依頼中。',
      cause: '先方ネットワークのメンテナンス時間帯と重複', resolution: '',
      completedDate: null, completedTime: null,
      knowledgeNote: 'バッチ時間帯の顧客メンテナンス予定を事前共有してもらう運用に', links: [],
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
      villageId: 'vil-01', companyId: 'c-01', contactId: 'p-01', approachGroup: '大手小売DX',
      title: '在庫管理DXプロジェクト', dealType: '新規', staffMemberId: 'm-03',
      phase: '提案', amount: 1_500_000, probability: 60, expectedCloseDate: f(40),
      customerIssue: 'CSV加工に毎週3時間かかっている',
      proposal: 'CSV取込・変換の自動化と在庫最適化モジュールの導入',
      nextAction: 'デモ実施', nextActionDate: f(7), links: [],
    },
    {
      id: 'deal-0002', memberId: 'm-04', back: 3, at: '10:30',
      villageId: 'vil-01', companyId: 'c-02', contactId: 'p-04', approachGroup: '既存深耕',
      title: '売上分析スイート更新', dealType: '更新', staffMemberId: 'm-04',
      phase: '見積', amount: 800_000, probability: 80, expectedCloseDate: f(20),
      customerIssue: '前年同週比の分析に手作業が発生',
      proposal: '週次ダッシュボードへの前年比較機能の追加',
      nextAction: '見積書の提出', nextActionDate: f(3), links: [],
    },
    {
      id: 'deal-0003', memberId: 'm-05', back: 5, at: '13:00',
      villageId: 'vil-01', companyId: 'c-08', contactId: 'p-12', approachGroup: '製造業DX',
      title: '生産管理システム刷新', dealType: '新規', staffMemberId: 'm-05',
      phase: 'ヒアリング', amount: 5_000_000, probability: 30, expectedCloseDate: f(90),
      customerIssue: '現行システムの保守期限切れ。紙運用との二重管理',
      proposal: 'RFP作成支援から要件定義・段階導入まで伴走',
      nextAction: '要件優先度のすり合わせMTG', nextActionDate: f(10), links: [],
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

// ---------- 活動ログ（案件ヘッダーにぶら下がる時系列の記録。改修依頼 2026-08-20・Units 2+4） ----------

/** ログ行の共通整形（createdAt/updatedAt = 活動日の 17:30 固定 = 決定的） */
function logRow(
  seq: number, prefix: 'slog' | 'plog', activityId: string, back: number,
  fields: Pick<ActivityLog, 'memberId' | 'kind' | 'title' | 'body'> & Partial<Pick<ActivityLog, 'nextAction' | 'nextActionDate'>>,
): ActivityLog {
  const day = addDays(todayJst(), -back)
  const at = `${day}T17:30:00+09:00`
  return {
    id: `${prefix}-${String(seq).padStart(4, '0')}`,
    activityId,
    memberId: fields.memberId,
    loggedOn: day,
    kind: fields.kind,
    title: fields.title,
    body: fields.body,
    nextAction: fields.nextAction ?? '',
    nextActionDate: fields.nextActionDate ?? null,
    links: [],
    createdAt: at,
    updatedAt: at,
    active: true,
  }
}

/**
 * 営業活動の活動ログ。deal-0001 は 26 件（20件/ページのページングが**実際に発生**するデモ = 2 ページ目あり）。
 * 生成内容は rng（決定的）でトピック・種別・記録者を選ぶ。他案件は 2〜4 件の手書きログ。
 */
export function buildSalesActivityLogs(): ActivityLog[] {
  const today = todayJst()
  const f = (fwd: number): string => addDays(today, fwd)
  const rows: ActivityLog[] = []
  let seq = 0
  const next = (): number => ++seq

  // deal-0001（在庫管理DXプロジェクト）: 2 日おきに 26 件（back = 0, 2, 4, ... 50）
  const topics = ['要件ヒアリング', '見積条件の調整', 'デモ環境の準備', '進捗共有', '技術質問への回答', '推進体制の確認', '日程調整', '課題の整理'] as const
  const members = ['m-03', 'm-04', 'm-05'] as const
  for (let i = 25; i >= 0; i--) {
    const key = `slog-deal1-${i}`
    const topic = pick(`${key}-topic`, topics)
    rows.push(logRow(next(), 'slog', 'deal-0001', i * 2, {
      memberId: pick(`${key}-member`, members),
      kind: pick(`${key}-kind`, ACTIVITY_LOG_KINDS),
      title: `${topic}（第${26 - i}回）`,
      body: `${topic}を実施。先方担当者と論点を確認し、次回までの持ち帰り事項を整理した。`,
      ...(i === 0 ? { nextAction: 'デモ実施の最終確認', nextActionDate: f(7) } : {}),
    }))
  }

  // deal-0002（売上分析スイート更新）: 3 件
  rows.push(
    logRow(next(), 'slog', 'deal-0002', 10, { memberId: 'm-04', kind: '訪問', title: '更新要件のヒアリング', body: '前年比較機能の要件を確認。既存ダッシュボードの課題を整理した。' }),
    logRow(next(), 'slog', 'deal-0002', 6, { memberId: 'm-04', kind: 'Web会議', title: '機能デモと概算提示', body: '前年比較のプロトタイプをデモ。概算金額に前向きな反応。' }),
    logRow(next(), 'slog', 'deal-0002', 2, { memberId: 'm-04', kind: 'メール', title: '見積ドラフトの送付', body: '見積ドラフトを送付し、社内確認を依頼した。', nextAction: '見積書の提出', nextActionDate: f(3) }),
  )

  // deal-0003（生産管理システム刷新）: 2 件
  rows.push(
    logRow(next(), 'slog', 'deal-0003', 5, { memberId: 'm-05', kind: '訪問', title: '現行システムの棚卸し', body: '現行の紙運用と二重管理の実態をヒアリング。保守期限を確認した。' }),
    logRow(next(), 'slog', 'deal-0003', 1, { memberId: 'm-05', kind: 'Web会議', title: 'RFP 骨子のすり合わせ', body: 'RFP の章立てと評価軸をすり合わせ。次回は要件優先度を確定する。', nextAction: '要件優先度のすり合わせMTG', nextActionDate: f(10) }),
  )

  // deal-0004（DX構想策定支援・受注済み）: 2 件
  rows.push(
    logRow(next(), 'slog', 'deal-0004', 8, { memberId: 'm-03', kind: '訪問', title: '最終提案とクロージング', body: '取締役会向けの最終提案を実施。予算・体制の合意を得た。' }),
    logRow(next(), 'slog', 'deal-0004', 2, { memberId: 'm-03', kind: 'メール', title: '発注書の受領', body: '発注書を受領し受注確定。キックオフ日程の候補を送付した。', nextAction: 'キックオフ日程の確定', nextActionDate: f(5) }),
  )

  // deal-0005（冷凍ライン歩留まり分析・初回）: 1 件のみ（AI集約「ログ 1 件」の表示確認用）
  rows.push(
    logRow(next(), 'slog', 'deal-0005', 14, { memberId: 'm-04', kind: '電話', title: '初回コンタクト', body: '歩留まり目標未達の背景を電話でヒアリング。分析観点の提示を約束した。', nextAction: '分析観点の提示', nextActionDate: f(14) }),
  )

  return rows
}

/** ビジネスパートナー活動の活動ログ（各案件 2〜4 件・決定的） */
export function buildPartnerActivityLogs(): ActivityLog[] {
  const today = todayJst()
  const f = (fwd: number): string => addDays(today, fwd)
  const rows: ActivityLog[] = []
  let seq = 0
  const next = (): number => ++seq

  // pact-0001（フローラ社との協業検討）: 3 件
  rows.push(
    logRow(next(), 'plog', 'pact-0001', 12, { memberId: 'm-03', kind: '訪問', title: '協業テーマの初回協議', body: '花き流通データ連携の協業可能性を協議。双方の狙いを確認した。' }),
    logRow(next(), 'plog', 'pact-0001', 6, { memberId: 'm-03', kind: 'Web会議', title: 'データ提供範囲の調整', body: '提供データの範囲と契約形態を調整中。法務確認を依頼した。' }),
    logRow(next(), 'plog', 'pact-0001', 2, { memberId: 'm-03', kind: 'メール', title: '3者MTG の日程打診', body: '3者MTG の候補日を打診。先方の回答待ち。', nextAction: '3者MTG', nextActionDate: f(20) }),
  )

  // pact-0002（製造業DX案件の紹介）: 2 件
  rows.push(
    logRow(next(), 'plog', 'pact-0002', 5, { memberId: 'm-05', kind: '訪問', title: '紹介案件の御礼と進捗共有', body: '紹介いただいた生産管理刷新案件の進捗を共有。毎週の共有を約束した。' }),
    logRow(next(), 'plog', 'pact-0002', 1, { memberId: 'm-05', kind: 'メール', title: '週次の進捗レポート送付', body: 'RFP 作成支援の進捗レポートを送付した。', nextAction: '紹介元への進捗共有', nextActionDate: f(12) }),
  )

  // pact-0003（AI人材育成プログラム）: 2 件
  rows.push(
    logRow(next(), 'plog', 'pact-0003', 10, { memberId: 'm-05', kind: 'Web会議', title: '共同プログラム構想の情報交換', body: '自治体向け AI 人材育成の構想を意見交換。来期予算化を待つ方針。' }),
    logRow(next(), 'plog', 'pact-0003', 4, { memberId: 'm-05', kind: '電話', title: '予算化タイミングの確認', body: '来期予算の検討状況を確認。年度末に再度連絡することで合意。', nextAction: '来期予算の確定状況を確認', nextActionDate: f(30) }),
  )

  // pact-0004（ホテル業界の紹介ネットワーク・完了）: 2 件
  rows.push(
    logRow(next(), 'plog', 'pact-0004', 15, { memberId: 'm-03', kind: '訪問', title: '取締役の紹介を受領', body: 'シーサイドホテルズ取締役を紹介いただき、DX構想支援の商談が発生。' }),
    logRow(next(), 'plog', 'pact-0004', 3, { memberId: 'm-03', kind: 'その他', title: '受注の御礼（会食）', body: '紹介案件の受注を報告し御礼。今後も業界内の紹介が期待できる関係。' }),
  )

  return rows
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
      nextActionNote: '流通データの提供範囲と守秘条件を先に固めてから臨む',
      staffMemberId: 'm-03', relatedMeeting: `${f(20).slice(5).replace('-', '/')} フローラMTG`,
      relatedSalesActivityId: null, memo: '案件化したら商談へリンクする',
    },
    {
      id: 'pact-0002', memberId: 'm-05', back: 5, at: '14:30',
      villageId: 'vil-01', partnerCompanyId: 'c-08', partnerContactId: 'p-12', approachCompanyId: null,
      approachGroup: '製造業パートナー',
      partnerName: 'テクノパーツ工業', theme: '製造業DX案件の紹介', relatedCompany: '',
      activityType: '案件支援', status: '案件化',
      summary: 'テクノパーツ社の生産管理システム刷新案件を紹介いただき案件化',
      currentState: '商談フェーズへ移行済み（ヒアリング中）。RFP作成を支援',
      nextAction: '紹介元への進捗共有', nextActionDate: f(12),
      staffMemberId: 'm-05', relatedMeeting: '',
      relatedSalesActivityId: 'deal-0003', memo: '紹介経由の商談は進捗を毎週共有する約束', links: [],
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
      villageId: 'vil-01', partnerCompanyId: 'c-01', partnerContactId: 'p-01', approachCompanyId: 'c-07',
      approachGroup: '紹介ネットワーク',
      partnerName: 'アケボノ商事', theme: 'ホテル業界の紹介ネットワーク', relatedCompany: 'シーサイドホテルズ',
      activityType: '紹介', status: '完了',
      summary: 'シーサイドホテルズ取締役の紹介を受け、DX構想支援の商談につながった',
      currentState: '紹介案件は受注済み。お礼と進捗報告済み',
      nextAction: '', nextActionDate: null,
      staffMemberId: 'm-03', relatedMeeting: '',
      relatedSalesActivityId: 'deal-0004', memo: '今後も業界内の紹介が期待できる関係', links: [],
    },
  ]

  return rows.map(r => ({
    ...r,
    createdAt: iso(r.back, r.at),
    updatedAt: iso(r.back, r.at),
    active: true,
  }))
}
