/** ドメイン別シードデータ（このファイルは担当機能の実装者が所有・拡充する） */
import type { DecisionLog, DecisionTheme } from '~/types/domain'

/**
 * 判断テーマ（F-02 の主役データ）
 * ①意味（semantics）②関係（links: マスタ実データ参照）③制約と打ち手（actions）
 * ✗ の打ち手は制約により潰れ、○/△ のみ選択肢 A/B/C に昇格する。
 */
export const seedDecisionThemes: DecisionTheme[] = [
  {
    id: 'dt-01',
    title: 'グランメディア PoC（pj-06）を再開するか',
    category: 'project',
    objective: '保留中の記事生成 AI PoC の扱いを決め、受注確度と開発部稼働のバランスを最適化する',
    semantics: [
      { key: '予算消化率', value: '62%（¥248万 / ¥400万）' },
      { key: '経過週', value: '18 週 / 計画 21 週' },
      { key: '先方温度感', value: '中（編集長は前向き・役員は費用対効果に懐疑的）' },
      { key: '記事品質スコア', value: '3.2 / 5.0（目標 4.0）' },
      { key: '残予算', value: '¥152万' },
      { key: '正式導入の受注確度', value: '40%' },
    ],
    links: [
      { label: '顧客: グランメディア', to: '/masters/customers', info: 'Web メディア運営（50-100名・東京都）。記事生成 AI の PoC 先。編集部の予算改定は毎年 10 月' },
      { label: 'PJ: グランメディア 記事生成 AI PoC', to: '/masters/projects', info: 'pj-06 / 受託開発 / 保留中。予算 ¥400万・担当 澤村。2026-06 末で計画期間満了' },
      { label: '担当: 倉持 慎（編集長）', to: '/masters/contacts', info: 'PoC の評価者。記事構成案の品質を最重視。現場負担の増加には敏感' },
    ],
    actions: [
      { name: '増員して再開（フルスコープ）', status: 'ng', slot: null, why: '制約: 開発部の稼働が逼迫（トクタケ AI 分析が佳境）で増員余力がない' },
      { name: '縮小して再開（構成案生成に限定）', status: 'ok', slot: 'A', why: '' },
      { name: 'クローズして関係維持', status: 'ok', slot: 'B', why: '' },
      { name: '追加ヒアリングで判断材料を集める', status: 'warn', slot: 'C', why: '判断の先送りで先方温度感が低下するリスク' },
    ],
    options: [
      {
        slot: 'A', recommended: true, title: '縮小して再開（週 1 日稼働・構成案生成に限定）',
        prediction: [
          '残予算 ¥152万 の範囲内で 6 週間の追加検証が可能',
          '品質スコア 3.2 → 3.8 到達の見込み（構成案特化で改善余地が大きい）',
          '正式導入の受注確度 40% → 55%',
        ],
        basis: '残予算と澤村の空き稼働（週 1 日）から算出。評価者の倉持氏が構成案品質を最重視している点をスコープに反映',
      },
      {
        slot: 'B', recommended: false, title: 'クローズして関係を維持する',
        prediction: [
          '追加コストゼロで撤退でき当期損失は最小',
          '編集部予算の改定（10 月）後に再提案の余地は残る',
          '受注確度はいったん 0%（再提案時に再構築）',
        ],
        basis: '先方の予算サイクルと、クローズしても関係が悪化しない温度感（編集長は前向き）を考慮',
      },
      {
        slot: 'C', recommended: false, title: '追加ヒアリングで判断材料を集める',
        prediction: [
          '判断は約 3 週間後ろ倒しになる',
          '温度感の低下により受注確度 40% → 30% へ低下するリスク',
        ],
        basis: '先方役員の懐疑は「費用対効果の実証不足」が原因のため、ヒアリングのみでは解消しにくい',
      },
    ],
    whyRecommend: '制約（開発部稼働逼迫）を満たしつつ受注確度を上げられる唯一の打ち手が A。残予算内で完結するためダウンサイドはクローズ（B）と同水準に抑えられ、アップサイド（正式導入受注）だけが上乗せされる。',
    scenarioParams: [
      { key: 'effortDays', label: '投入工数', min: 2, max: 12, step: 1, default: 6, unit: '人日' },
      { key: 'pocUnitPrice', label: 'PoC 単価', min: 8, max: 20, step: 1, default: 12, unit: '万円/人日' },
    ],
  },
  {
    id: 'dt-02',
    title: '提供システム保守料金の改定',
    category: 'business',
    objective: '原価上昇の転嫁方法を決め、解約リスクを抑えながら保守事業の粗利率を維持する',
    semantics: [
      { key: '対象契約数', value: '3 件（アケボノ商事・ウンドゥアパレル・トクタケ製靴）' },
      { key: '保守売上（年）', value: '¥2,640万' },
      { key: '粗利率', value: '38%（3 年前は 41%）' },
      { key: '直近 CPI', value: '前年比 +2.8%' },
      { key: '料金改定の未実施期間', value: '3 年' },
      { key: 'SLA 満足度', value: '3 社平均 4.4 / 5.0' },
    ],
    links: [
      { label: '顧客: アケボノ商事', to: '/masters/customers', info: 'c-01 / SCM 保守。契約更改は 9 ヶ月先で期中改定条項なし。1,000 万円超は経営会議マター' },
      { label: '顧客: ウンドゥアパレル', to: '/masters/customers', info: 'c-02 / 売上分析スイート保守。更改 4 ヶ月先。宇野本部長がスポンサーで関係良好' },
      { label: '顧客: トクタケ製靴', to: '/masters/customers', info: 'c-03 / AI 分析基盤保守。更改 6 ヶ月先。現場負担を増やさないことが絶対条件の社風' },
    ],
    actions: [
      { name: '一律 10% 値上げ（即時）', status: 'ng', slot: null, why: '制約: アケボノ商事（c-01）の契約更改が 9 ヶ月先で、期中改定の条項がない' },
      { name: 'CPI 連動条項の追加（次回更改から）', status: 'ok', slot: 'A', why: '' },
      { name: '次回更改時に個別交渉', status: 'ok', slot: 'B', why: '' },
      { name: '据え置き', status: 'warn', slot: 'C', why: '原価上昇を吸収し続け、粗利率が年約 1pt ずつ低下' },
    ],
    options: [
      {
        slot: 'A', recommended: true, title: 'CPI 連動条項の追加（次回更改から自動改定）',
        prediction: [
          '3 年累計で保守売上 +約 8%（CPI +2.8%/年 前提）',
          '交渉コストは条項合意の初回のみ',
          '解約リスク最小（業界標準の条項でロジックが明快）',
        ],
        basis: '直近 CPI +2.8% と過去 3 年の平均インフレ率から試算。3 社とも SLA 満足度 4.4 と高く、根拠ある改定は受容余地が大きい',
      },
      {
        slot: 'B', recommended: false, title: '次回更改時に個別交渉で改定',
        prediction: [
          '+5〜12% と交渉次第で改定幅に振れがある',
          '営業工数は 3 社 × 2〜3 回の交渉が必要',
          '交渉決裂時は据え置き（C）と同じ結果に落ちる',
        ],
        basis: '個別事情（トクタケの社風・アケボノの稟議プロセス）を織り込める反面、再現性がなく毎回交渉コストが発生する',
      },
      {
        slot: 'C', recommended: false, title: '据え置き（現行料金を維持）',
        prediction: [
          '解約リスクはゼロ',
          '粗利率 38% → 約 35% へ低下（2 年後見込み）',
          '将来まとめて値上げする際の交渉難度が上がる',
        ],
        basis: '過去 3 年の粗利率低下トレンド（41% → 38%）の外挿',
      },
    ],
    whyRecommend: '✗ の一律値上げは c-01 の契約制約で実行不能。CPI 連動（A）は一度の条項合意で継続的に原価上昇を転嫁でき、解約リスクと交渉コストの両方を最小化できる。個別交渉（B）は改定幅の期待値は近いが再現性に欠ける。',
    scenarioParams: [
      { key: 'revisionRate', label: '改定率', min: 0, max: 15, step: 1, default: 3, unit: '%' },
      { key: 'churnRate', label: '想定解約率', min: 0, max: 20, step: 1, default: 2, unit: '%' },
    ],
  },
  {
    id: 'dt-03',
    title: '開発メンバー 1 名の増員',
    category: 'business',
    objective: '開発部の稼働逼迫を解消する要員調達手段を決め、納期リスクとコストのバランスを最適化する',
    semantics: [
      { key: '開発部稼働率', value: '108%（供給 3.5 人月に対し需要 3.8 人月）' },
      { key: '受注残', value: '¥5,200万（pj-01 / pj-03 中心）' },
      { key: '残業状況', value: '36 協定アラートが 2 名で点灯中' },
      { key: '採用リードタイム', value: '約 3 ヶ月' },
      { key: '外注単価相場', value: '¥95万/月' },
      { key: '自社の定着率', value: '90%（過去 3 年）' },
    ],
    links: [
      { label: 'PJ: アケボノ商事 SCM 導入', to: '/masters/projects', info: 'pj-01 / 予算 ¥4,800万 / 2026-12 まで。開発 3 名 + 外注 1 名で進行中' },
      { label: 'PJ: トクタケ AI 分析基盤開発', to: '/masters/projects', info: 'pj-03 / 予算 ¥3,600万 / 2026-09 納期。現在が実装の佳境' },
      { label: '採用稟議（稟議申請）', to: '/workflow', info: '採用は稟議区分「採用」。取締役 → 社長の 2 段階承認が必要' },
    ],
    actions: [
      { name: '正社員を 1 名採用', status: 'ok', slot: 'A', why: '' },
      { name: '外注（業務委託）を増強', status: 'ok', slot: 'B', why: '' },
      { name: '現体制で継続', status: 'warn', slot: 'C', why: '残業増による 36 協定リスクと品質低下の懸念' },
      { name: 'オフショア開発の活用', status: 'ng', slot: null, why: '制約: ブリッジ人材確保と体制構築に約 6 ヶ月・初期コスト約 ¥300万 が必要で、必要時期（今四半期）に間に合わない' },
    ],
    options: [
      {
        slot: 'A', recommended: true, title: '正社員を 1 名採用する',
        prediction: [
          '月額コスト約 ¥75万（給与 + 間接費）で外注比 約 ¥240万/年 のコスト優位',
          '戦力化は約 3 ヶ月後から。長期的にナレッジが社内蓄積',
          '36 協定アラート 2 名 → 0 名 へ解消見込み',
        ],
        basis: '採用市場の相場と自社定着率 90% から試算。pj-01 / pj-03 とも 1 年超続く案件で長期要員が適合',
      },
      {
        slot: 'B', recommended: false, title: '外注（業務委託）を増強する',
        prediction: [
          '月額 ¥95万 で翌月から稼働開始できる',
          '案件終了時に契約で柔軟に調整可能',
          'ナレッジは社内に残りにくい',
        ],
        basis: '外注単価相場と既存パートナー（外川氏ルート）の即応性。立ち上がりの速さが最大の利点',
      },
      {
        slot: 'C', recommended: false, title: '現体制のまま継続する',
        prediction: [
          '追加コストはゼロ',
          '残業 +15h/人月 で 36 協定リスクがさらに上昇',
          'pj-03（9 月納期）の遅延確率 35%',
        ],
        basis: '現在の稼働率 108% と残業トレンドの外挿。品質・コンプライアンス両面のリスクが顕在化しつつある',
      },
    ],
    whyRecommend: '両 PJ とも 1 年超の継続案件のため、月額コストが低くナレッジが蓄積する正社員採用（A）が最適。戦力化までの 3 ヶ月は外注スポット（B の部分適用）で補う前提。オフショアはリードタイム制約で今回の解決策にならない。',
    scenarioParams: [
      { key: 'monthlyCost', label: '月額人件費', min: 60, max: 120, step: 5, default: 75, unit: '万円' },
      { key: 'utilization', label: '稼働率', min: 50, max: 100, step: 5, default: 85, unit: '%' },
    ],
  },
]

export const seedDecisionLogs: DecisionLog[] = []

// ---------- 業務支援（ドキュメント） ----------
