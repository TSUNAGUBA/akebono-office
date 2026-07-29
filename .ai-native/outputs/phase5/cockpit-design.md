# ダッシュボード・コックピット設計（F-01 改訂: 夜明けの管制塔）

- **作成:** 2026-07-29 ナビゲーター（壁打ち: オペレーター × ユーザー・運用サポート × UXコンセプトデザイナー）
- **ステータス:** オペレーター承認済み（コンセプト = 第4案「夜明けの管制塔」/ スコープ = Phase 1+2 一括 / 事業計器 = Member×セグメント紐付け新設 / メタファー = 控えめ・構造で語る）
- **SoT:** 本書はダッシュボード（`/`）コックピット化の設計 SoT。画面全体の設計は `screen-design.md`、データは `data-design.md`、I/F は `api-design.md` を本書に合わせて改訂する

## 1. コンセプト

現行ダッシュボード（カード型メニュー16枚 + 通知5件）は「玄関」であり、ユーザーに何も要求しない = コミット感が生まれない。本改訂は「**完了という状態を定義する**」ことで、開くたびに『今日を操縦している』感覚を作る。

3層構造（時間スケールの異なる3つのコミット）:

| 層 | 由来 | 時間軸 | 内容 |
|---|---|---|---|
| フレーム（今日の状態） | 案1「一日一便」 | 今日 | punchState × 時刻で変形するステータスストリップ + 今日の完了メーター |
| エンジン（次の一手） | 案2「次の一手」 | いま | 優先順位付きアクションキュー。全消化で「本日の予定完了」 |
| 地平線（着地予報） | 案3「着地予報」 | 週・月 | 目標に対する着地予測1行 + 展開で滑走路ボード |

ペルソナ分析の共通骨格「①私の今日 → ②動かすべきキュー → ③私の文脈の計器 → ④入口」に対応する。メタファーは**控えめ**: ラベルは業務語（「今日のブリーフィング」「今日の残り」「本日の予定はすべて完了」）、lucide アイコン（Sunrise / Navigation / ListChecks 等）と構造で夜明け=AKEBONO の物語を支える。絵文字禁止・色は既存トークンのみ。

### 禁じ手（ペルソナ分析より）

1. 全員に経営数字を見せない（権限 F-16 と役割ゲートを全セクションに適用。権限がない枠は**枠ごと出さない**）
2. カードメニューは廃止せず**格下げ**（下部へ移動。カテゴリチップ・カスタマイズは現行維持）
3. 開くたびに AI 生成を走らせない（週次インサイト・業態レポートは**保存済みのみ**表示。生成は各ページの明示操作）
4. バッジのインフレ禁止（ゼロが正常。非ゼロは必ずアクション可能）
5. 未提出者の名前を本人以外の一般メンバーに出さない（フォロー情報は hr / admin のみ）
6. 自動並べ替えで導線を日々変えない（並びはロール既定で固定）
7. 誤操作導線を作らない（打刻は既存 WidgetsPunchClock を再利用 = 既存の修正申請フローが取消手段。原則9.5）

## 2. データモデル変更

### 2.1 Member.segmentIds（人×事業セグメント紐付け。新設）

```ts
// shared/domain/types.ts — Member に追加
/**
 * 担当する事業セグメント（businessSegments 参照。F-01 コックピットの事業計器の出し分けに使用）。
 * 空配列 = 未設定（下位互換: 従来どおり業態スイッチャの選択に従う）。SoT は members マスタ。
 */
segmentIds?: string[]
```

- 既定 `[]`。**任意フィールドで下位互換**（BusinessSegment.appName 等の前例に従う。原則7）。既存データへのパッチ不要（undefined = 未設定として扱う）
- マスタ UI: `/masters/members` のフォームに `UiMultiCombobox`（選択肢 = active な businessSegments）を追加
- API: `api/src/masters/registry.ts` の members スキーマへ `segmentIds: z.array(z.string()).default([])` を追加。マイグレーション `0035`: `ALTER TABLE members ADD COLUMN IF NOT EXISTS segment_ids jsonb NOT NULL DEFAULT '[]'`
- **Zod v4 注意（CLAUDE.md）:** members の patchSchema は `.partial()`。`.default([])` 付きフィールドは部分更新で既定値が注入されるため、PATCH ハンドラが「body に実在するキーのみ」を更新対象にフィルタしていること（`Object.hasOwn`）を確認し、なければ同修正を適用する。回帰テストは「送っていないフィールドが保持されること」をアサート
- シード（`data/seed/core.ts`）: m-04 → `['seg-01']`（うつわ=陶磁器委託販売の営業・管理）、m-05/m-06/m-09/m-12 → `['seg-02']`（SI）、m-07 → `['seg-03']`、m-08 → `['seg-04']`、他は `[]`。**SEED_VERSION を +1**

### 2.2 goals（目標マスタ。新設）

```ts
// shared/domain/types.ts
export type GoalMetric = 'segment_sales' | 'report_rate'
export interface Goal {
  id: string
  metric: GoalMetric
  /** metric='segment_sales' のとき対象業態。'report_rate' は null（全社） */
  segmentId: string | null
  /** 月次目標値。segment_sales = 円 / report_rate = %（0-100） */
  monthlyValue: number
  note: string
  active: boolean
  /**
   * 登録日時（API 行のみ = goals.created_at の ISO 文字列。モックシードは持たない）。
   * API の一覧は id（UUID）順で登録順と一致しないため、「重複目標は最新 1 件 = 後勝ち」の
   * 判定は本フィールドがあれば createdAt 降順で決定的に行う（utils/cockpit.ts latestGoal。
   * 無ければ従来どおり配列末尾 = モック互換）
   */
  createdAt?: string
}
```

- モック: `useMockDb` コレクション `goals` + シード（下記）。API: 汎用マスタ CRUD に乗せる（`MIGRATED_MASTERS` に `goals: 'goals'` を追加、registry にスキーマ・テーブル宣言、マイグレーション 0035 で `goals` テーブル作成）。書込は `useMasterCrudAsync('goals', 'g')`
- 管理画面: `/masters/goals`（マスタハブのカード + nav-map 登録。カテゴリは `biz`）。論理削除（archive/restore）= 取消フロー（原則9.5）
- バリデーション: `metric='segment_sales'` は segmentId 必須 / `report_rate` は segmentId null・値 0-100。同一 (metric, segmentId) の active 重複は登録時に警告（後勝ちで評価は最新 1 件を使用）
- シード: seg-01〜04 の segment_sales（既存 salesRecords / akebono 売上シードの月次規模と整合させ、予報が ok / warn 混在になる値）+ report_rate 90%
- **API モードで goals が空でも壊れない**: 予報層は「目標未設定」1 行 + `/masters/goals` への導線（admin のみ）へフォールバック

### 2.3 着地予報エンジン（純関数。新設）

`shared/domain/landing-forecast.ts`（`portfolio-insight.ts` の前例に従い決定的・副作用なし。API と共有可能な形）:

```ts
export type ForecastKind = 'amount' | 'rate'
export interface ForecastInput {
  id: string            // 'seg-01-sales' | 'report-rate' | 'my-overtime' | 'my-hours' など
  label: string
  kind: ForecastKind
  current: number       // 月初(または期間開始)から今日までの実績
  target: number        // 目標(着地で達成したい値)。上限型(残業)は limit として扱う
  inverse?: boolean     // true = 小さいほど良い(残業など)。予測 >= target で warn
  unit: 'currency' | 'percent' | 'hours'
  elapsedWorkingDays: number
  totalWorkingDays: number
}
export interface ForecastResult {
  id: string; label: string
  projected: number     // 着地予測。kind='amount': current / elapsed * total（elapsed=0 は current）
                        // kind='rate': current をそのまま着地見込みとする（率は外挿しない）
  target: number; achieved: boolean   // inverse を考慮した達成判定
  progressRatio: number // current / target（バー描画用。0-1 超過は 1 にクランプしない: バーは min(1) でクランプし数値はそのまま）
  projectedRatio: number
  tone: 'ok' | 'warn'   // achieved → ok / それ以外 warn（serious/crit は使わない = インフレ防止）
  reason: string        // 「残り N 営業日・日割りペース◯◯」の 1 行根拠（予報の透明性）
}
export function buildForecast(input: ForecastInput): ForecastResult
export function summarizeForecasts(results: ForecastResult[]): { headline: string; tone: 'ok' | 'warn'; warnCount: number }
```

- 営業日は既存 `shared/domain/business-day.ts` の `workingDayRuleOf` / `isWorkingDay` を再利用（原則3）。祝日リストは呼び出し側が渡す
- 予報が外れるリスクへの対処: `reason` に算定根拠を必ず出す。率は外挿しない。トーンは ok/warn の 2 値のみ
- ユニットテスト必須（`mockup/tests/landing-forecast.test.ts`）: 月初 elapsed=0 / 全営業日経過 / inverse(残業) / rate / 0 target のゼロ除算

## 3. 画面構成（`/` = pages/index.vue 再構成）

モバイル(375px) = この縦順そのまま 1 カラム。①②は全幅、③の KPI カードは 2 列グリッド（lg〜 = 4 列。実装 = `grid-cols-2 lg:grid-cols-4`）。

```
① CockpitStrip（フレーム + 地平線 1 行）
   挨拶・氏名・日付（既存 UiPageHeader 相当を内包） + フェーズバッジ + 今日の完了メーター(細バー)
   └ 着地予報 1 行（「今週の見通し: 順調」/「針路修正 N 件」。タップで ④ を開閉）
② CockpitMoves（エンジン = 次の一手）
   最優先 1 件を大カード（理由 1 行 + 実行ボタン。punch 系は WidgetsPunchClock flat を埋込）
   続く手 2〜4 件をコンパクト行で。全消化時は ok トーンの完了表示（ゼロを祝う）
③ CockpitInstruments（役割と文脈の計器。該当のみ表示・空枠は出さない）
   - 自分の計器（全員・punchRequired 考慮): 今月実働 / 有給残 / （36協定の自分の状態）
   - シフト計器（parttime × shift 有効): 今日・次のシフト / 希望提出締切
   - 労務計器（hr/admin): 承認キュー内訳（打刻修正・休暇・稟議）/ 36協定該当者数 / 年5日未達数
   - 経営計器（sales 権限): 今月売上・前年比（useSales の保存値。リンク → /sales, /akebono/company）
   - 事業計器（segmentIds 設定者 or 業態選択中): 担当業態の今月売上スナップ + 業態アプリ直行
   - 週次インサイト 1 行（保存済み personal の headline のみ。リンク → /reports の週次）
④ CockpitForecast（滑走路ボード。①の予報行タップで開閉。既定: 閉）
   ロール別の滑走路バー 2〜4 本（CSS のみ: 実績塗り + 予測マーカー + 目標ティック）
   針路修正 1 件（最も乖離が大きい warn の対処導線。実行 = 該当ページへ遷移）
   最大 4 本への切り詰めは「自分の予報（my-overtime / my-hours）を最低 1 本確保 →
   残り枠を 業態売上 → 提出率 の順で充当」（業態数が多くても自分の勤怠着地は消えない）
⑤ AKEBONO 業務（業態別アプリ。現行 AkebonoSegmentApps を維持）
⑥ すべての機能（現行カードメニュー + カテゴリチップをそのまま格下げ配置）
⑦ 通知フィード（現行のタブ構成を維持）
```

### 3.1 フェーズ導出（utils/cockpit.ts 純関数）

```
入力: punchRequired, punchState('before'|'working'|'breaking'|'done'), jst 時刻
- punchRequired=false → フェーズ表示なし（'none'。ストリップは挨拶+日付+完了メーターのみ）
- before → 'morning'（出勤前）/ working → 'active'（勤務中）/ breaking → 'break'（休憩中）/ done → 'closed'（退勤済み）
ラベルは業務語: 出勤前 / 勤務中 / 休憩中 / 退勤済み。アイコン: Sunrise / Sun / Coffee / MoonStar
```

完了メーター = 「今日の一手（②の対象）のうち完了した割合」。moves 総数 0 の日は満タン表示ではなく非表示（分母 0 を祝わない）。

### 3.2 次の一手（優先順位エンジン。utils/cockpit.ts 純関数 + useCockpit で材料収集）

供給源と優先順（上から。各項目は**表示条件をすべて満たすときのみ**キュー入り）:

| # | 一手 | 条件（ゲート） | アクション |
|---|---|---|---|
| 1 | 未退勤の打刻（退勤忘れ） | punchRequired ∧ 前営業日以前に IN があり OUT なし | /timecard へ（修正申請導線） |
| 2 | 出勤打刻 | punchRequired ∧ punchState='before' ∧ 当日シフトあり or シフト非対象 | PunchClock 埋込 |
| 3 | 退勤打刻 | punchRequired ∧ punchState='working'∧ 17時以降 | PunchClock 埋込 |
| 4 | 承認する（稟議・件数束ね） | pendingFor(me) > 0 ∧ canPath('/workflow') | /workflow |
| 5 | 勤怠承認（打刻修正・休暇。件数束ね） | (hr ∨ admin) ∧ 未処理 fixRequests + pendingRequests > 0 | /attendance |
| 6 | 日報を書く | punchRequired ∧ 非 parttime ∧ canPath('/reports') ∧ 当日分未提出 ∧ 12時以降 | /reports |
| 7 | シフト希望を出す | shift 有効 ∧ 募集中期間あり ∧ 自分の希望未提出 ∧ 締切前 | /shift |
| 8 | エスカレーション対応 | (hr ∨ admin) ∧ open エスカレーションあり | /inbox |
| 9 | 有給5日義務 | obligation で残necessary > 残月数ペース超過（useLeave.obligation 流用） | /attendance（休暇タブ） |

- 表示は最大 5 件（1 大カード + 4 行）。6 件目以降は「ほか N 件」で /inbox 等へ
- **すべて遷移 or 既存ウィジェット再利用**（新規の書込パスを作らない = 誤操作・取消の新規リスクなし。原則9.5）
- 「後で」ボタンは作らない（キュー順は決定的・毎回同じ。ノイズ項目はゲート条件で絞る設計を優先）
- 純関数部（`buildMoves(input): Move[]`）はユニットテスト（`mockup/tests/cockpit.test.ts`）: ロール×時刻×状態の代表ケース + ゼロ状態

### 3.3 ロール適応マトリクス（例）

| ペルソナ | ① | ② 主な一手 | ③ 計器 | ④ 予報 |
|---|---|---|---|---|
| 代表・取締役（punch対象外・admin） | フェーズなし | 稟議承認・エスカレーション | 経営計器・週次1行 | 全社: 業態別売上着地 |
| うつわ営業・管理（m-04: seg-01） | フル | 打刻・日報・（承認） | 自分・事業計器(seg-01) | seg-01 売上着地 + 自分の残業 |
| SI開発者（m-06: seg-02） | フル | 打刻・日報 | 自分の計器・週次1行 | 自分の残業着地のみ |
| アルバイト（m-11） | フル | 打刻・シフト希望 | 自分・シフト計器 | 自分の今月勤務時間着地 |
| 人事（m-10: hr） | フル | 勤怠承認・日報 | 自分・労務計器 | 提出率着地 + 年5日 |

予報の本数はロールで 1〜4 本。**warn が 1 本もない日は「順調」1 行だけ**（見なくていい日を明示する）。

## 4. 実装ファイル一覧

| 区分 | ファイル | 内容 |
|---|---|---|
| 型 | `shared/domain/types.ts` | Member.segmentIds / Goal / GoalMetric |
| 純関数 | `shared/domain/landing-forecast.ts` | 予報エンジン（新設） |
| 純関数 | `mockup/app/utils/cockpit.ts` | フェーズ導出・一手ビルダー（新設） |
| composable | `mockup/app/composables/useCockpit.ts` | 材料収集 → moves / instruments / forecasts（新設） |
| UI | `mockup/app/components/widgets/CockpitStrip.vue` / `CockpitMoves.vue` / `CockpitInstruments.vue` / `CockpitForecast.vue` | 新設（RunwayBar は CockpitForecast 内ローカル） |
| ページ | `mockup/app/pages/index.vue` | §3 の構成へ再構成（メニュー・通知・AKEBONO セクションのロジックは現行を維持） |
| マスタUI | `mockup/app/pages/masters/goals.vue` | 新設（MasterShell + useMasterCrudAsync） |
| マスタUI | `mockup/app/pages/masters/members.vue` | segmentIds 入力を追加 |
| 登録 | `mockup/app/utils/menu-registry.ts` / `nav-map.ts` | masters エリアに goals カード + 導線 |
| シード | `mockup/app/data/seed/core.ts`（segmentIds）/ goals シード / `useMockDb.ts`（コレクション + SEED_VERSION+1） | |
| API | `api/src/masters/registry.ts` / `api/db/migrations/0035_cockpit_goals.sql` | members.segment_ids 列 + goals テーブル |
| テスト | `mockup/tests/landing-forecast.test.ts` / `mockup/tests/cockpit.test.ts` | 新設 |
| ドキュメント | `screen-design.md` / `data-design.md` / `api-design.md` / `functional-requirements.md`(F-01) / `phase7/implementation-status.md` / `mockup/CONVENTIONS.md`（UI在庫・早見表） | 本書と整合させる（原則5） |

## 5. 品質ゲート（Push 前）

1. `npm run build` / `npx nuxi typecheck`（mockup）+ API のテスト（`api` で vitest）が通る
2. デモユーザー m-01（役員 admin）/ m-04（うつわ）/ m-06（SI）/ m-10（hr）/ m-11（アルバイト）で切替え、§3.3 どおりの出し分けになる
3. 375px で縦 1 カラム・親指圏・横スクロールなし
4. 権限 deny（timecard/reports/workflow など）のユーザーで該当セクション・一手が消える
5. API モード相当（goals 空・インサイト未生成・業態 0 件）で空落ちせずフォールバック表示
6. CLAUDE.md セルフチェック 11 項目 + 独立ロール（コードレビュアー・システム監査官）の反復レビューで指摘ゼロ
