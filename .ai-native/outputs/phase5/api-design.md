# Phase 5: I/F 設計（composables 契約と将来 API 移行）

- **作成日:** 2026-07-15（更新: 2026-07-17 Phase 7 バッチ1 で一部 API 実装）
- **作成ロール:** コーディングエージェント
- **位置づけ:** モックアップでは REST API を持たない。**composables の公開シグネチャを I/F 契約**とし、本番実装ではその内部（useMockDb 参照）を API 呼び出しへ差し替える。呼び出し側（pages/components）は変更しない。
- **本実装の状況:** 勤怠・休暇・日報・マスタ・設定の API は `api/` に実装済み（Cloud Run + RDS PostgreSQL）。
  対応表は `.ai-native/outputs/phase7/implementation-status.md`、本番構成は `phase7/production-architecture.md` が SoT。

## 1. I/F ファースト 6 視点の適用

| 視点 | 設計上の回答 |
|---|---|
| 入力 | 各操作関数は明示的な引数（ID・DTO）のみ受け取る。グローバル状態を暗黙参照しない（currentUser を除き、依存は引数化） |
| 出力 | 参照系は `ComputedRef` / `Readonly` を返し、書込系は結果オブジェクト `{ ok, id?, error? }` を返す。例外はプログラミングエラーのみ |
| 責務 | 1 composable = 1 業務領域。横断処理（通知・監査・還流）はイベント的に他 composable の公開関数を呼ぶ（癒着させない） |
| 冪等 | 書込系は状態機械ガード（同一遷移の二重実行は no-op + 警告トースト） |
| 互換 | 契約変更時は本書を先に更新し、呼び出し箇所を Grep で全件確認（開発原則 5・6） |
| エラー | 想定エラーは `error: { code, message }`。code は `AKO-{領域}-{番号}` 体系 |

## 2. 主要 composable 契約（抜粋 — 全量はコード上の型定義が正）

```ts
// useAttendance
punch(kind: PunchKind): Result            // 状態機械ガード付き打刻
ruleFor(memberId): AttendanceRule         // 勤務体系の解決（①Member.attendanceRuleId ②defaultFor ③appliesTo 先頭）
daySummary(memberId, date): AttendanceDaySummary   // 6 バケット集計
monthSummary(memberId, month): MonthSummary        // 月次 + アラート
alerts(memberId, endMonth?): Article36Alert[]      // 36協定判定。endMonth（YYYY-MM）を最終月とする直近6ヶ月。省略時は JST の当月
requestFix(input: FixRequestInput): Result         // 修正申請（理由必須）

// useLeave（F-04-5/9・F-10-10 対応）
balance(memberId, leaveTypeId?): LeaveBalance  // 種別別の残数・失効予定（既定 = 法定有給。上限 40 日は法定のみ）
request(input: { leaveTypeId?, date, unit, reason }): Result  // 種別別残数チェック → pending
decide(requestId, action: 'approved'|'rejected'): Result      // 管理者/人事のみ
grant({ memberId, leaveTypeId, days, grantDate? }): Result & { skipped? }
   // 手動付与（管理者/人事のみ）。同一メンバー×種別×付与日は skipped=true（冪等）。
   // expireDate は種別の expiryMonths から自動算出
bulkGrant({ memberIds, leaveTypeId, days }): Result & { granted?, skipped? }  // 一括付与（重複スキップ・結果件数）
activeLeaveTypes / leaveTypeName(id)     // 休暇種別マスタ参照

// useDepartments（F-10-9）
nameOf(departmentId): string             // 部署名（未所属フォールバック付き）
options: ComputedRef<{value,label}[]>    // 階層インデント付きセレクト用
membersOf(departmentId): Member[]        // 所属メンバー（責任者を先頭）
tree: ComputedRef<DeptNode[]>            // 組織図ツリー（親無効時はトップへ繰り上げ = 表示から漏らさない）
   // CRUD は useMasterCrud('departments')。所属変更は members への save（SoT = Member.departmentId）

// useTaskPlans（F-14）
plansOf(memberId, date): TaskPlan[]       // 他メンバーは F-16-7 の許可があれば readonly 参照（API は ?memberId=）
upsertPlan(input): Result                // 本人のみ。done も訂正可（監査ログ記録・オペレーター指示 2026-07-21）
removePlan(planId): Result               // 本人のみ。done も削除可（取消フロー = 原則9.5・done は監査ログ）
aiReview(planId): Result                 // AI コメント生成（status を問わず後追い取得可・上書きのみ）
recordResult(planId, { outcome, reflection }): Result  // 本人のみ。done も再記録で訂正可（result_at は保持・監査ログ）
refresh(memberId?): Promise<void>        // 表示時の再取得（memberId 指定で他メンバー分を専用キャッシュへ）
insights(days?): MemberInsight[]         // 管理者向け集計（計画数・完了率・振り返り記入率）

// useWorkflow（バッチ3b でデュアルモード化。API モードは /v1/workflows をハイドレーション）
resolveRouteFor(category, amount): WorkflowRouteStep[] | null
   // 職務権限マトリクス解決。純粋関数 resolveRoute(routes, category, amount)
   //（shared/domain/approval-route.ts。フロント/API で共有）を内包。該当経路なしは null（AKO-WFL-003）
saveDraft(input, requestId?): Promise<Result>      // 本人 + draft のみ更新可（API: PUT /draft）
submit(input, requestId?): Promise<Result>         // 採番 + routeSnapshot 凍結（API はサーバー側で経路再解決）
act(requestId, action: Exclude<ApprovalAction, 'submit'>, comment?): Promise<Result>  // 承認/却下/差戻し/取下げ
pendingFor(memberId): WorkflowRequest[]            // 代理設定を考慮（呼び出し側の computed 内で使用）
saveDelegate / removeDelegate                      // 代理承認設定（本人のみ・期間必須）
refresh(): Promise<void>                           // ページ表示時の取り直し（他者の申請・承認の取り込み）

// useAiCompany（バッチ6a でデュアルモード化。API モードは /v1/ai-company をハイドレーション）
requestTask(aiEmployeeId, title, description, files?): Promise<{ ok, id, confidence }>
   // 分解案を生成し proposed で登録（API = Vertex AI → 失敗時 shared/domain/ai-tasks の同一ヒューリスティック。
   //  低確信度はサーバーがエスカレーション起票）。files = 添付（.md/.txt/.pdf/.docx/.pptx/.jpg/.png。バッチ7f）
approveTask / progressTask / blockTask / cancelTask(taskId): Promise<Result>  // 状態機械（API = FOR UPDATE 直列化）
   // バッチ7i: approveTask = 承認と同時に全ステップを自動実行（モック = 同期ループ / API = サーバーの
   //  fire-and-forget + フロントの追跡ポーリング）。progressTask は自動実行が止まった場合の「再開」で、
   //  1 ステップ遂行後の残りは自動実行が引き継ぐ。ブロック解除も自動再開
answerTask(taskId, answer, files?): Promise<Result>  // 依頼者の回答（依頼者 or 管理者のみ。回答で実行を自動再開 = バッチ7i）
generateDailyReports(date): Promise<{ created, skipped }> // 日次報告を UPSERT 生成（既存分はスキップ = 冪等）
aiReportsOn(date): DailyReport[]        // 指定日の AI 日次報告を参照（API モードは全員の日報キャッシュから射影）
evaluateWorkloadSignals(): Promise<{ raised }> // 停滞・過負荷検知（API = POST /workload-check・クールダウン冪等）

// useEscalations
raise(signal: EscalationSignal): Result // dedupeKey + クールダウンで冪等。失敗しても呼び出し元は継続
resolve(id, type: 'answer'|'ruling'|'no_action', body, reflectToKnowledge?, knowledgeTarget?): Result
   // 裁定のナレッジ還流は resolve 内で非ブロッキング実施（専用の useKnowledge は設けない）。
   // knowledgeTarget = { domain, targetId } で還流先を指定。省略時は自社PJ

// useMasterCrud<T>(collectionName)（同期・モック専用。未移行ドメイン内部で使用）
list(filter?): ComputedRef<T[]>
save(entity: Partial<T>): Result        // 追加/更新の統一。監査ログ記録
archive(id): Result                     // 論理削除のみ

// useMasterCrudAsync<T>(collectionName, prefix)（バッチ2a〜。マスタ・設定画面はこちらへ移行済み）
save/archive/restore/remove(…): Promise<Result>  // API モードは /v1/masters/* + キャッシュ反映。
                                                 // モックモードは同期版を Promise で包むだけ（挙動不変）
// PATCH /v1/masters/:entity/:id は**部分更新**: リクエスト body に実在するキーのみ更新する。
// zod v4 の .partial() は .default() フィールドへ既定値を注入するため、サーバー側で入力キーへ
// フィルタしている（部署配属 {departmentId} で email/role が既定値に巻き戻った実障害の再発防止）
// さらに項目の更新権限（改修依頼 2026-08-18 = F-16-9）: `<項目>:write` の deny・参照 deny（参照＞更新）の
// キーを body から剥がしてから更新する（stripMasterWriteKeys）。全キーが更新不可なら 403 AKO-PRM-003・
// 一部のみ不可なら残りを更新（グレースフルデグラデーション = 原則4）

// useCustomFields
defsFor(entity): CustomFieldDef[]
valueOf(entity, id, key): unknown
formSchemaFor(entity): FieldDef[]       // UiSchemaForm に直結
```

```ts
// useCalendar（F-06-8）
isConnected: ComputedRef<boolean>                    // 擬似 OAuth 連携状態（本実装: トークン有無）
connect(): Result & { synced? } / disconnect(): Result  // 画面上の同意フローで完結。connect は当日分を初回同期
syncFromGoogle(memberId, date): Result & { synced }  // google 発のみべき等 upsert（アプリ発に触れない）
addTask({date, from, to, title, projectId, pushToGoogle}): Result & { warning? }  // 反映は補助処理（未連携でも作成は成立）
pushToGoogle(eventId): Result & { warning? }         // アプリ発のみ。反映済みへの再実行は no-op + warning（冪等）
listCalendars(): Result & { calendars? }             // 同期対象カレンダーの一覧（GET /v1/calendar/calendars = Google calendarList + 保存済み選択）
saveCalendars(calendarIds): Result                   // 同期対象の保存（PUT /v1/calendar/calendars。バッチ7b）
removeTask(eventId): Result                          // アプリ発のみ削除可（google 発は Google 側で変更→同期）

// useReportAssist（F-06-7）
inputMode: ComputedRef<'form'|'assist'|'both'>       // 設定（reportInputMode。useAppSettings 経由 = API モードは /v1/configs）
questionsFor(memberId, date): AssistQuestion[]       // 予定 1 件 1 問 + まとめ 3 問（テンプレ+文脈）
recordAnswer(q, answer, date?) / poipoiMemo(text, date?): Result  // 蓄積ログ（追記のみ）。date 省略時は本日（過去日の日報にも対応）
generateDraft(memberId, date): ReportDraft           // 保存しない（フォームへ流し込み→確認・修正→既存 submit）

// useWeeklyInsight（バッチ7g → バッチ7j: 永続化・前日まで前提・全体/個別分離）
load(weekStart): Promise<WeeklyInsightBundle>       // 保存済みのみ取得（生成しない。未生成 = company/personal とも null）
generate(weekStart): Promise<WeeklyInsightBundle>   // 生成・再生成（全体共通 + ログインユーザーの個別を保管 = upsert）
   // WeeklyInsightBundle = { company: { metrics, insight, llm, generatedAt, generatedByName } | null,
   //                         personal: { metrics: PersonalWeeklyMetrics, insight: PersonalWeeklyInsight, llm, generatedAt } | null }
   // API = GET/POST /v1/reports/weekly-insight（保管 = weekly_insights・週 × audience（'company'/'member:<id>'）で一意 upsert）
   // weekStart は実在する週初め（月曜）のみ。暦不正・月曜以外は AKO-GEN-001 400
   // 提出系（reportSubmitted/reporters・提出率評価）は asOf = min(weekEnd, 前日) まで・
   // 経過営業日（public_holidays + 月〜金既定）基準（日報は前日分までが正常な運用 = 当日を未提出として
   // 悲観評価しない。バッチ7j）。工数・テーマ・日別グラフ・課題は週内全量（当日提出分も事実として表示）
   // 全体は保管時に全量集計し、配信時に閲覧者マスク（売上 = sales 権限・memberHours/issues = F-16-6 の memberId 判定）。
   // 全体の洞察本文は個人名・売上に言及しない形で生成（共有保管物のため）。個別は本人権限スコープで生成・本人のみ配信
   // モック = 同一集計・同一ヒューリスティック（shared/domain/weekly-insight）+ weeklyInsights コレクションへ保管
   // 既知の差異（PR #56 R1 M-4）: aiTasksDone の週内判定は API = updated_at（JST）・モック = 最終成果物
   //（無ければ作成）日時での近似（モック AiTask に updatedAt が無いため）
// 提出済み保護: useReports.reportOn の結果（status='submitted'）で呼び出し側が生成 UI を無効化する

// useMenuCategories（バッチ7h・オペレーター指示 2026-07-19 #10 ⑤。F-13-8）
useMenuCategories(area: 'dashboard' | 'masters')
categories: ComputedRef<MenuCategoryDef[]>       // 有効なカテゴリ定義（カスタマイズ済み or menu-registry の既定）
categorize(cards): { id, label, cards }[]        // カード一覧をカテゴリごとにグループ化（未割当は「その他」・空カテゴリは落とす）
save(defs) / reset(): Promise<void>              // SoT = configs `menu-categories-<area>`（JSON。'' = 既定 = 下位互換）
// カード定義の SoT = home/app/utils/menu-registry.ts（バッジ・機能トグル・権限のランタイム反映はページ側）
// ページ間導線（親リンク・関連ドロップダウン）の SoT = home/app/utils/nav-map.ts（レイアウトヘッダーが描画）

// useDashboardLayout（F-13-9・オペレーター指示 2026-08-03。ダッシュボードの表示・配置カスタマイズ）
useDashboardLayout()
effectiveLayout: ComputedRef<DashboardLayout>    // 解決結果（ユーザー > テナント > デフォルト）
resolvedScope:  ComputedRef<'user'|'tenant'|'default'>  // どの層が効いているか（表示用）
activeTemplateId: ComputedRef<string>            // 有効レイアウトの由来テンプレート id
templates: DashboardTemplate[]                   // テンプレート一覧（5 種。SoT = utils/dashboard-layout.ts）
userLayout / tenantLayout: ComputedRef<DashboardLayout|null>  // 各層に保存済みのレイアウト（tenantLayout は下位互換 legacy 込み。ドラフト土台に使用）
tenantLayoutOwn: ComputedRef<DashboardLayout|null>  // テナント新キー自身のみ（legacy を含まない。ハイライト・解除可否の SoT）
hasUserLayout / hasTenantLayout: ComputedRef<boolean>          // hasTenantLayout は legacy 込み（メッセージ表示用）
hasTenantLayoutOwn: ComputedRef<boolean>                       // 新キー自身のみ（解除ボタン活性・ハイライト用。§53 MINOR 対応）
baseLayoutForScope(scope: 'user'|'tenant'): DashboardLayout    // 保存先層自身を土台に取る（pickBaseLayout。tenant は user 層へ落ちない = §53 MAJOR 対応）
applyTemplate(templateId, scope: 'user'|'tenant'): Promise<{ ok }>  // materialize → 該当層へ保存（tenant は管理者のみ）
saveSections(sections: MenuCategoryDef[], scope: 'user'|'tenant'): Promise<{ ok }>
  // 保存先スコープ自身の層の options（baseLayoutForScope。effectiveLayout ではない = §53 MAJOR 対応）を
  // 維持したまま sections を差し替えた DashboardLayout（templateId='custom'）を該当層へ保存（#25）。
  // 保存経路は applyTemplate と共通（persistLayout）。tenant は管理者のみ（非管理者は警告 no-op = 非ブロッキング）。
resetLayout(scope: 'user'|'tenant'): Promise<{ ok }>               // 該当層を解除（新キーのみ・取消フロー・原則9.5）
// 解決・categorize・型・テンプレート・buildCustomLayout の純ロジック SoT = home/app/utils/dashboard-layout.ts
//（planDashboardCards〔固定「AKEBONO 業務」セクション用〕は改善要望 2026-08-21 で廃止 = 業態カードも categorizeCards の通常配置）
// 保存: ユーザー層 = /v1/me/preferences 'dashboardLayout'（saveMePreference。mock=localStorage）
//       テナント層 = /v1/configs 'dashboard-layout'（setConfig）。**新規 API・マイグレーション不要**（既存の汎用 key/value を利用）

// useExternalLinkCards（F-13-3 → ダッシュボードのメニューカテゴリ配置。2026-08-03）
useExternalLinkCards()
externalCards: ComputedRef<MenuCard[]>  // active な外部リンクを MenuCard 化（id=外部リンク id `el-*`・href で別タブ・iconImage を引き継ぎ UiCardMenu が画像優先描画）
// external-links マスタ（POST/PATCH /v1/masters/external-links）は iconImage を受理（0060。data URI = png/jpeg/webp base64・上限 400,000 字・NULL 許容 = 下位互換。business_segments.appIconImage と同 allowlist）

// useAkebonoAppCards（F-01-5 → メニューカテゴリ配置。#24・2026-08-03。useExternalLinkCards と同型）
useAkebonoAppCards()
akebonoCards: ComputedRef<MenuCard[]>
  // active な各業態を MenuCard 化（id=`akebono-seg:<segmentId>`・title=segmentAppName・
  //   description=`<業種ラベル>・<使用アプリ数> アプリ`・icon=業種タイプ別 lucide〔INDUSTRY_CARD_ICON〕・
  //   to=`/akebono?seg=<id>`）。写像の純関数 SoT = utils/akebono.akebonoSegmentCard。**新規 API 不要**
  //   （業態は businessSegments・アプリ数は akebonoAppConfigs〔enabledAppsOf〕の既存経路を利用）

```

## 3. 将来 API 移行マッピング

| composable | 将来のエンドポイント（例） |
|---|---|
| useAttendance | `POST /v1/attendance/punches`・`GET /v1/attendance/state`・`GET /v1/attendance/day`（?raw=1 で修正履歴）・`GET /v1/attendance/month`・`GET /v1/attendance/alerts`・`GET /v1/attendance/timecard`（**2026-07-22: ガードを requireHrOrAdmin → 権限表 canViewAllTimecards（attendance / timecard-all・既定 = 管理者/人事）へ変更。未許可は 403 AKO-ATT-004**）・`POST /v1/attendance/fix-requests`（+ `/decision`）（**実装・フロント接続済み**。月サマリキャッシュから日次・週次を射影）。**直行/直帰（F-04-11。0040）: `POST /v1/attendance/direct-requests`（本人）・`GET /v1/attendance/direct-requests`（本人/`?scope=all` は HR・管理者）・`POST /v1/attendance/direct-requests/:id/actions`（approved/rejected/withdrawn = 多段承認・取下げは本人）。打刻修正は経路対応で多段化（`/decision` が現ステップ承認者 or 管理者・最終ステップで打刻追記）。直行/直帰起因の修正は承認済み申請が前提（`directRequestId` + AKO-ATT-005）。承認経路は `/v1/masters/attendance-routes`（区分×承認ステップ・金額帯なし = 稟議 F-07-5 の勤怠版・未設定は管理者単段フォールバック）** |
| useWorkflow | `GET /v1/workflows`・`GET /v1/workflows/:id/logs`・`PUT /v1/workflows/draft`・`POST /v1/workflows/submit`・`POST /v1/workflows/:id/actions`（クレームファースト: FOR UPDATE クレーム）・**`GET /v1/workflows/:id/files`・`GET /v1/workflows/:id/files/:fileId`（添付の実ファイル = workflow_files〔0045〕。監査指摘 2026-07-30 ②。draft/submit の `files`〔base64 新規〕+ `keepFileIds`〔既存維持〕で差分同期し attachments は表示名一覧へ合成〔名前のみ旧データは互換表示 = 原則7〕。対応形式 .md/.txt/.csv/.pdf/.docx/.xlsx/.pptx/.jpg/.png・10MB・5 件 = AKO-WFL-004。可視性は申請一覧と同一 = 下書きは本人と管理者のみ）**・`GET/POST /v1/workflows/delegates`（+ `/:id/archive`）・承認経路 = `/v1/masters/workflow-routes`（**実装・フロント接続済み**。経路解決・凍結・権限ガード・証跡・通知はサーバーが担い、射影ロジックはモックと共通）。**承認ステップの承認者は役職/ロール/個人（`approverType`。0041）で指定し、解決は共有 `pickApprover` に一元化（稟議・勤怠・API・モックで同一）** |
| useCalendar.syncFromGoogle | Google Calendar API（OAuth 2.0 増分認可・calendar.readonly/events スコープ。Webhook push + 手動再同期の両立）。トークンはサーバー側で暗号化保管（C3 相当・クライアントへ出さない）。アプリの連携解除時はトークン破棄 + Google 側 revoke を呼び、Google 側での取消は次回 API 401 で検知して連携状態へ反映する。**同期対象は選択制（バッチ7b・オペレーター指示 2026-07-19 #3）: 従来の primary 固定を廃し、calendar_tokens.selected_calendar_ids（既定 ["primary"] = 下位互換）に保存した複数カレンダーを横断同期。同一イベント id は重複排除・一部カレンダーの取得失敗は「取れた分だけ同期 + 削除フェーズ抑止 + warning」（原則4）・アプリ発予定の反映先は常に primary。**選択解除したカレンダーの同期済みイベントは日付単位の削除フェーズで掃除される = 過去・未来の日付は該当日を次に同期したときに追随**（per-date 同期設計の帰結）。見つからないカレンダー（共有解除 = 404）は「予定ゼロ」として扱い削除フェーズを抑止しない + warning で選択見直しを案内。部分失敗の warning はフロントがトーストで報告（原則4）。UI = カレンダー連携ゲートの「同期カレンダー」モーダル（モックは擬似一覧 + localStorage・選択に応じて擬似予定を合成）** |
| useReportAssist | `GET /v1/assist/logs`・`POST /v1/assist/answers` `/memos`（追記のみ）・`POST /v1/assist/report-draft`（**実装・フロント接続済み**。Vertex AI 構造化出力 + 出力正規化 → 失敗時は shared/domain/report-draft の同一ヒューリスティック。ドラフトは保存しない）|
| useTextAssist（「AIで整形」F-50 = 改修依頼 2026-08-20 → **RAG 対応 = 改修依頼 2026-08-21 第3弾**） | `POST /v1/assist/format-text`（認証済み全員可・上限 8000cp = AKO-RAS-003・空入力はそのまま返す。**RAG: AI 知識ベース〔shared/domain/kb〕から `formatTextKbRefs`〔kbFindRelated 上位 3 件 = 決定的字句検索・チャットボットのモック照合と同一 = 原則3/6〕で関連ドキュメントを選び、LLM の参照資料として供給 = 画面名・機能名・操作名を正式呼称へ統一〔資料にあるだけで本文に無い機能への言及は禁止〕。応答 `{ text, llm, refs }`・refs = LLM 整形時のみ id+title・フォールバック〔ルールベース〕は空 = 資料を使わないため。関連資料ゼロでも整形は実行 = RAG は補助〔原則4〕**。失敗・無効環境は shared heuristicFormatRequestText へフォールバック = mock と同一。旧クライアント〔refs を知らない〕は refs を無視するだけ = 下位互換〔原則7〕）。結果は保存しない |
| useTaskPlans | `GET/PUT /v1/task-plans`（GET は `?memberId=` で他メンバーを readonly 参照 = F-16-7・canViewMemberTaskPlans で enforcement・未許可 403 AKO-PRM-002）・`POST /:id/remove` `/:id/ai-review` `/:id/result`・`GET /v1/task-plans/insights`（**実装・フロント接続済み**。AI レビュー = Vertex AI 構造化出力 → 失敗時は shared/domain/task-plan-review の同一ヒューリスティック。**誤登録の訂正のため done でも編集・再記録・削除・後追い AI コメント可（2026-07-21）。done の訂正は監査ログ・result_at は FOR UPDATE + COALESCE で初回記録日時を保持**・インサイトはサーバー集計）。`GET /v1/assist/logs` も `?memberId=` で同権限の readonly 参照可 |
| useLeave | `GET/POST /v1/leave/requests`（+ `/decision`）・`GET/POST /v1/leave/grants`（+ `/bulk`。冪等キー: memberId×leaveTypeId×grantDate。権限: admin/hr）（**実装・フロント接続済み**。grants/requests をハイドレーションし残数射影は共通ロジック） |
| useEscalations | `GET/POST /v1/escalations`・`POST /v1/escalations/:id/resolution`・`POST /v1/escalations/overtime-check`（**実装・フロント接続済み**。起票 = dedupe + クールダウン冪等、解決 = open→resolved クレーム + ナレッジ還流 + 本人通知） |
| useShifts | `GET /v1/shifts`（期間・希望・割当・必要人数の一括ハイドレーション。希望・割当は管理者 = 全件 / 本人 = 自分のみ）・`POST /v1/shifts/periods`（+ `/:id/transition` = 正順の状態機械。published 遷移で割当 confirmed 化 + 通知）・`PUT /v1/shifts/wishes`（+ `/clear`。本人のみ・open 中・締切内）・`POST /v1/shifts/assignments`（+ `/:id/unassign` `/:id/request-change` `/:id/consent`）・`PUT /v1/shifts/demands`（**実装・フロント接続済み**。割当バリデーション（労基法34/61条・週40h・希望NG）は shared/domain/shift.ts をフロントのプレビューと共有） |
| useMasterCrud | `GET/POST/PATCH /v1/masters/{entity}`（**実装・フロント接続済み** = useMasterCrudAsync） |
| useAkebonoMasters（Akebono マスタ 9 種 = Phase B） | 業態（`/v1/masters/business-segments`）・倉庫/単位/税区分/支払条件/委託条件/バリアント軸テンプレ/商品カテゴリ/画像セクション（`warehouses`・`units`・`tax-rates`・`payment-terms`・`consignment-terms`・`variant-axis-templates`・`product-categories`・`product-image-sections`）を**汎用マスタ registry へ移行**（**実装・フロント接続済み = Phase B 2026-07-29**。useMasterCrudAsync 化 = モックモードは同期版を包むだけで挙動不変。business-segments の appIconImage は data:image png/jpeg/webp base64 のみ・400,000 文字上限 = プロフィール画像と同じ SVG 拒否。product-image-sections は既定シード（is_seed）の無効化を AKO-AKB-002 409 で拒否・名称変更は可 = 商品画像の整合保護。初期データはモックシードと同一 id を投入（0031 の互換判断コメントが正）） |
| useAkebonoApps（業態×アプリ設定 = Phase B） | `GET /v1/akebono/app-configs`（全員可 = メニュー表示判定）・`PUT /v1/akebono/app-configs`（管理者のみ。**複合キー (segmentId, appKey) のバッチ upsert** = rows 1〜200 件・同一キー重複は後勝ちで畳む・冪等。registry（id 主キー）に合わないための専用 API）（**実装・フロント接続済み = Phase B**。行が無い業態は業種プリセットへフォールバック（コード側既定 = シード不要）。ON/OFF・ラベル・プリセット一括適用は変更行だけを送る。カタログ（アプリキー・依存関係）はフロント静的 SoT = サーバーはキー形式のみ検証） |
| useItemSettings（項目カスタマイズ F-31 = Phase B） | `GET /v1/akebono/item-settings`（全員可 = 項目解決に全画面が使う）・`PUT /v1/akebono/item-settings`（管理者のみ。**複合キー (entity, itemKey) の部分 upsert** = body に実在するキーのみ hasOwn フィルタ・null は「カタログ既定へ戻す」明示値。**filterVisible〔0056 = 検索対象フィルタ〕も同経路**）・`POST /v1/akebono/item-settings/reset`（管理者のみ。エンティティ単位で差分全削除 = カタログ既定へ戻す取消フロー 原則9.5・監査ログ）（**実装・フロント接続済み = Phase B**。カタログ ITEM_CATALOG はフロント静的 SoT・テーブルは差分のみ） |
| 一覧の構造化フィルタ（0056。runListQuery 共通） | 記録系一覧の各 `GET`（sales-records・invoices・purchase-orders・production-orders・inbound-results・purchase-records・outbound-results・inventory-transactions）が **`f.<key>` 系のクエリ**を受ける: text = `f.<key>`（`strpos(akebono_norm(col), akebono_norm($v))>0` = NFKC + 小文字で大文字小文字・全角半角を吸収）・ref/enum = `f.<key>`（完全一致）・date = `f.<key>.from` / `.to`（`col::date` 範囲・timestamp 列は JST 変換）・number = `f.<key>.min` / `.max`。従来の `q`（ILIKE）と併存（後方互換）。どの項目を検索対象にするかは item_settings.filter_visible（**実装・フロント接続済み**。フィルタ UI = AppFilterBar + useAppFilter・両モードで同一ヒット挙動） |
| useProducts（商品 F-21 = Phase C） | `GET /v1/akebono/products`・`/product-skus`・`/product-images`（全員可）・`POST /v1/akebono/products`（既定 SKU を同時生成 = XA-1・コード重複は AKO-PRD-002 409 = 部分一意 INDEX）・`PATCH /:id`（**部分更新 = hasOwn**。**segmentId 移動可** = 参照存在検証 + 移動先の同コード衝突は AKO-PRD-002 409 = 部分一意 INDEX。旧実装は PATCH で segmentId を無視しモックと乖離 = Codex P2-4）・`POST /:id/archive|restore`（復元は部分一意衝突 = 同コード再登録後を AKO-PRD-002 409 + 対処案内。C-3）・`POST /:id/skus/matrix`（既存軸値の組をスキップ = 冪等・生成で既定 SKU 無効化）・`PATCH /product-skus/:id`・`POST /:id/images`（**data URI TEXT・400,000 字・png/jpeg/webp/gif base64 のみ = SVG 拒否 AKO-PRD-004**）+ images の archive/restore・PATCH（セクション変更）（**実装・フロント接続済み = Phase C 2026-07-29**。認可 = 認証済み全員（画面に管理者ゲートなしの日常業務 = 社内 C2）・/v1/akebono は featureGuard 'akebono'（F-16）の対象 = 機能 deny で全体遮断可・個別アプリの表示制御は業態×アプリ設定（クライアント側）） |
| usePurchaseOrders / useProduction（発注 F-23・生産 F-22 = Phase C） | `GET/POST /v1/akebono/purchase-orders`・`POST /:id/status`（状態機械 = shared PO_STATUS_NEXT・FOR UPDATE。違反は AKO-POR-003 409）/ `GET/POST /v1/akebono/production-orders`・`POST /:id/status`・`POST /:id/results`（**実績追記 + 在庫 production_in + 全数完成で completed を 1 トランザクション**。AKO-MFG-001〜004）（**実装・フロント接続済み = Phase C**。伝票コードは akebono_doc_seqs で原子的採番・**項目カスタマイズ（F-31・2026-08-10）: POST は body の `custom` を jsonb 保存し GET/RETURNING で返す**（発注/生産）） |
| useInbound / useOutbound（入荷 F-25・出荷 F-26 = Phase C） | `GET/POST /v1/akebono/inbound-plans`（+ `/:id/cancel` = 実績ありは AKO-INB-003 409）・`GET/POST /v1/akebono/inbound-results`（**記録系・追記のみ**。実績 + 在庫 inbound(+) + 予定ステータス再計算を 1 トランザクション）/ `GET/POST /v1/akebono/outbound-plans`（+ `/:id/cancel`）・`GET/POST /v1/akebono/outbound-results`（在庫不足 AKO-OUT-004 409・出庫(−) + 店舗納品は預け倉庫へ transfer_in(+) = partner_roles=store × store_deposit をサーバーが解決。**Phase D: `postSales` オプションで出荷明細から売上を自動計上**（source_kind='shipment'・source_ref='obr:<明細行id>'・部分一意 INDEX 0038 で二重計上防止・同一トランザクション。店舗預けの出荷は対象外 = AKO-OUT-005。単価は SKU 販売単価 → 商品標準販売単価で解決））（**実装・フロント接続済み = Phase C / postSales = Phase D**・**項目カスタマイズ（F-31・2026-08-10）: POST は body の `custom` を jsonb 保存し GET/RETURNING で返す**（入荷実績/出荷実績。自動起票の売上・在庫は custom 非引継ぎ）） |
| usePurchases / useInventory（仕入 F-24・在庫 F-27 = Phase C) | `GET/POST /v1/akebono/purchase-records`（warehouseId 指定 = 入荷管理 OFF 経路は在庫 purchase_in 同時入庫。判定はアプリ設定を持つクライアント = カタログがフロント静的 SoT のため）・`POST /:id/correct`（**赤黒訂正 = マイナス伝票の追記・元は不変・在庫も戻す・二重訂正 409**）/ `GET /v1/akebono/inventory-transactions`（台帳 = SoT。**表示用の直近明細 = LIMIT 20000 打ち切りあり**）・`GET /v1/akebono/inventory-balances`（**残高 = SUM(qty) の全量集約・GROUP BY sku×倉庫・0 残高は HAVING で除外**。台帳明細の打ち切りに依らず正しい残高 = Codex P1-2。API モードのフロントは残高 = サーバー値・明細 = 表示用に分離。モックモードは従来どおり全件ローカル shared foldBalances で導出）・`POST /v1/akebono/inventory/adjust|transfer|stocktake`（**冪等キー UNIQUE(ref_type, ref_line_id, kind) + ON CONFLICT DO NOTHING**・移動は不足 409・棚卸は差分行のみ計上（**実棚数は負値可 = マイナス在庫を許容。2026-08-10**。残高がマイナスになり得るが `inventory-balances` は `HAVING SUM(qty)<>0` で負残高も返す・出庫/移動は残高チェックで阻止）。**残高チェック → 追記は pg_advisory_xact_lock（SKU × 倉庫キー・ソート取得）で直列化 = 並行出庫の残高マイナス防止（C-1。出荷実績も同じ）**。AKO-INV-001〜004）・**項目カスタマイズ（F-31・2026-08-10）: POST は body の `custom` を jsonb 保存し GET/RETURNING で返す**（仕入/在庫 adjust・transfer。赤黒訂正・自動起票は custom 非引継ぎ = 既定 {}）（**実装・フロント接続済み = Phase C**） |
| useAkebonoSales（売上明細 F-28 = Phase C） | `GET/POST /v1/akebono/sales-records`（原価・課金区分・**供給元〔作家/窯元〕は**サーバーが SKU/商品から解決。**供給元 = supplierCompanyId として計上時に凍結〔0055 = 改修 P3〕**。AKO-SLS-001）・`POST /:id/correct`（赤黒。訂正済み = AKO-SLS-002・**請求済みは AKO-SLS-003 = 請求側で赤伝**。supplierCompanyId は元行から引継ぎ）（**実装・フロント接続済み = Phase C**。書込後は統合メトリクスキャッシュを invalidateIntegratedFor で無効化 = SoT 変化の追随。月次・年度集計・KPI は shared/domain/fiscal + フロント射影のまま。**作家別・販売先別の内訳 = supplierBreakdown/customerBreakdown〔改修 P2〕**） |
| useConsignment（請求・委託精算 F-29 = Phase C） | `GET /v1/akebono/invoices`・`/payment-notices`・`/payment-receipts`・`POST /v1/akebono/billing/close`（得意先 × 期間の未請求売上をドラフト化 = **同一キーの未発行ドラフトを洗い替え（冪等）**。**並行性 C-1**: advisory lock + 0033 の部分一意 INDEX（(company, period, type) WHERE draft）で draft は常に 1 枚 = 23505 は 409 へ変換。AKO-BIL-001）・`POST /invoices/:id/issue`（draft のみ・対象売上へ invoiceId = **未請求行のみ更新 + 件数検証**（他の請求・精算との競合は 409。C-1））・`POST /invoices/:id/void`（**赤伝 = issued のみ・通常請求のみ**（委託マージンは AKO-BIL-008）・マイナス請求追記 + 売上リンク解除）・`POST /payment-receipts`（**発行済み（issued/paid）のみ受理** = void への入金で終端状態を壊さない。部分入金可・全額で paid。AKO-BIL-004/005）・`POST /payment-receipts/:id/cancel`（**入金取消 = 監査列付き論理取消（voided_at/voided_by = 0033）**。有効入金の再集計で paid → issued へ戻す = 原則9.5。二重取消は AKO-BIL-009）・`POST /v1/akebono/consignment/close`（**店舗マージン請求 + 作家支払通知を一括発行・委託条件をスナップショット凍結・対象売上へ精算リンク = 再締めは AKO-BIL-006（冪等）**。**作家帰属 = COALESCE(sales_records.supplier_company_id, products.default_supplier_company_id)〔スナップショット優先・NULL はライブ解決 = 改修 P3〕**。**締め前プレビュー〔当社取り分の可視化〕・委託条件の整合検証〔店舗取り分 + 作家率 > 100% の逆ざや警告 = 非ブロッキング〕はフロント純関数 settlementPreview/settlementIntegrity + shared residualMarginRate〔改修 P1〕**。金額算定 = shared/domain/akebono の純関数をモックと共有。**purchase_cost 方式の原価解決は `lines @> [{"skuId":…}]::jsonb` で対象 SKU を含む仕入の最新 1 件**（旧実装 = 全 SKU 横断の直近 500 件窓で 500 超のとき窓外落ち → 標準原価へ誤フォールバック = Codex P1-1。0034 の GIN が支える）。**並行性 C-1**: advisory lock（業態 × 月）で直列化 + リンクは未請求行のみ更新の件数検証（すり抜けは 409））・**`POST /v1/akebono/consignment/cancel`（Phase D = 委託精算の取消。原則9.5）**: 業態 × 月のバッチ（settlement_id 0037）を特定し ①マージン請求（issued・credit_for IS NULL）を void + 赤伝追記 ②対象売上の invoice_id 解除（再締め可能に）③支払通知を論理取消（voided_at/voided_by）。close と同一 advisory lock で排他・二重取消は AKO-BIL-010。**下流確定状態の保護（レビュー MAJOR-1）: 有効入金のあるマージン請求（部分入金含む）or 確定済み支払通知がバッチに 1 件でもあれば AKO-BIL-011 で拒否**（片側反転による孤児入金・再締めの片側消失を防ぐ。先に入金取消 AKO-BIL-009 を案内。判断は共有純関数 consignmentCancelBlockReason = 両モード同一）・`POST /payment-notices/:id/confirm`（AKO-BIL-007。取消済み通知の確定も 409）（**実装・フロント接続済み = Phase C / 取消 = Phase D**） |
| useReports | `GET/PUT /v1/reports/daily`（month / from-to。**scope=team = 全員可（バッチ7h・指示 #10 ①: 管理者 = 下書き含む全件 / 一般 = 提出済みのみ = 他人の下書きの存在・内容を返さない。date / month / from+to のいずれか必須 = 期間なしダンプ不可）**。**コメントスレッド（GET/POST /:id/comments）にも参照ガード: 他人の下書きは 404（管理者可）・F-16-6 deny 対象者は提出済みでも 404 = 存在秘匿** / **scope=all=提出済みのみ全メンバー参照可・month 必須（バッチ5e: 全員の日報タブ）**。**scope=all/team は日報参照権限 F-16-6（reports + field `member:<id>` の deny）で対象者の日報を応答から除外。チャットボットの他人日報文脈・週次インサイト集計にも同一フィルタ**。チームマトリクスの表示メンバーは configs `teamVisibleMemberIds`（JSON 配列・自分は常に表示。バッチ7k: 候補 = 在籍中の全メンバー・空 = 既定表示（マトリクス = 社員・契約・アルバイト / タイムライン = 全員）・設定ありは両者とも「選択 + 自分」で統一（在籍外 = 退職者等は候補に出ないため設定の影響外 = タイムライン常時表示）= 判定 SoT は utils/team-visibility.ts）∩ F-16-6。composable は teamMemberCandidates（設定 UI の選択肢 = 在籍全メンバー）も公開）・`GET/PUT /v1/reports/weekly`（**`?scope=all&weekStart=YYYY-MM-DD` = 全員の提出済み週報の単週取得（F-06-11 = 2026-07-22）。F-16-6 canViewMemberReports でサーバー側も絞り込み・weekStart 未指定は直近 500 件上限。PUT は tomorrowPlans は対象外 = 日報のみ**）・`GET/POST /v1/reports/:id/comments`・`POST /v1/reports/comments/:id/reactions`（トグル）・`POST /v1/reports/remind`（**実装・フロント接続済み**。月単位の遅延ロードキャッシュ + SoT 書込→再取得。entries は theme（テーマ・自由入力。旧称: 業務テーマ）が正・旧 projectId は互換保持で表示時にプロジェクト名へフォールバック。**PUT /v1/reports/daily は tomorrowPlans（明日の予定・最大 3 件 = 2026-07-22）を受け付け正規化して保存**。**PUT /v1/reports/daily は issueCategory（本日の課題の種別。プリセット外は '' へ正規化 = cleanIssueCategory）を、PUT /v1/reports/weekly は goodPoints / teamShareKind（プリセット外は '' = cleanTeamShareKind）/ teamShareNote を受け付け保存（migration 0049・2026-08-03）。****既読管理（オペレーター指示 2026-07-31 = report_reads 0047）: `GET /v1/reports/reads?kind=daily&month=` / `?kind=weekly&weekStart=`（本人の既読レポート id 一覧。期間必須 = 全履歴ダンプ不可）・`PUT /v1/reports/reads {kind, reportId}`（既読にする。冪等 = ON CONFLICT DO NOTHING で readAt は初回時刻を保持 = 原則2。対象ガード = 日報はコメントスレッドと同じ（他人の下書き 404・F-16-6 deny 404）/ 週報は本人 or 提出済み + F-16-6）・`DELETE /v1/reports/reads/:kind/:reportId`（未読に戻す = 既読付与の取消フロー・原則9.5。冪等）。フロントは全員の日報（月単位）・全員の週報（週単位）と同じ粒度で遅延ロードし、詳細ドロワーを開いた時点で自動既読（他人の提出済みのみ）・「未読に戻す」ボタンで取消。未読は一覧バッジ + 未読件数 + 「未読のみ」フィルタで可視化。自分のレポートは既読管理の対象外。モックは reportReads コレクション**）。**月報（改修依頼 2026-08-19 第4弾・F-06 改訂 = 週報と同型で新設）: `GET/PUT /v1/reports/monthly`〔`?scope=all&monthStart=YYYY-MM-01` = 全員の提出済み月報の単月取得・F-16-6 canViewMemberReports でサーバー側も絞り込み・提出保護 AKO-REP-002〕。既読は `GET /v1/reports/reads?kind=monthly&monthStart=` / `PUT`〔kind=monthly〕/ `DELETE /reads/monthly/:id`〔対象ガード = guardMonthlyReadTarget = 本人 or 提出済み + F-16-6〕。日報/週報/月報は /reports の同一機能キーのままメニューを分割（`?kind=weekly`/`monthly`）し、権限はタブキー拡張〔weekly-team/monthly-mine/monthly-all/monthly-team〕で制御** |
| useNotifications | `GET /v1/notifications`・`POST /v1/notifications/:id/read`・`POST /v1/notifications/read-all`（**実装・フロント接続済み**。60 秒ポーリング。発火はサーバー側 = 未接続ドメインの notify はクライアント no-op）。kind = approval/comment/reminder/ai_report/system/escalation/**poipoi（改善のタネ原文の通知。2026-08-03）** |
| useChatbot | `POST /v1/chatbot/ask`（sessionId 任意 = 未指定は新規セッション開始。**エージェント応答 = 改修依頼 2026-08-20: サーバーが function calling ループで必要データをツール取得してから回答。fallback: true は LLM 無効環境のみ・確信度フォールバック廃止**）・`GET /v1/chatbot/sessions`・**`POST /v1/chatbot/sessions`（セッションの明示作成 = /ask 不達時の回復経路。監査指摘 2026-07-30 ④。クライアントは作成後に messages へ `role: 'user'` で質問を追記し、新規会話の初回送信が通信断で未永続のまま消えることを防ぐ）**・`GET/POST /v1/chatbot/sessions/:id/messages`（POST は `role` 任意 = 'user'/'assistant'。既定 assistant）（**実装・フロント接続済み**。エージェント応答のツール = **DB の全移行済みドメイン（勤怠・有給・日報・ワークフロー・シフト・意思決定・タスク計画・カレンダー・エスカレーション・メンバー/部署・顧客・プロジェクト・ナレッジ・AI カンパニー・売上・稼働状況・AKEBONO）をサーバーで文脈化（バッチ5d/6a/6b/6c/6d）。参照範囲は権限 F-16 に準拠 = ドメインごとに canUseFeature で文脈生成可否を判定・マスタ由来は stripDeniedFields で表示項目 deny を反映・本人スコープ C3 維持・他人の日報は提出済みのみ**+ セッションの直近履歴 12 件（各 500 字）を渡すマルチターン。一覧は直近 100 セッション・メッセージは 1 セッション 500 件まで返却。会話は chat_sessions / chat_messages（DB）が SoT で本人のみ参照可・メッセージは追記のみ。過去セッションの再開・新規開始に対応（オペレーター指示 2026-07-17 = 旧「セッションローカル」設計判断を置換）。決定的ルーティングへの縮退は fallback 指示（LLM 無効環境）のみで、縮退応答も POST messages で履歴へ追記（通信断・タイムアウトは正直なエラー文 = エージェント化 2026-08-20 で確信度フォールバック廃止）。**フォローアップ対応: エージェント経路はモデルが会話履歴から意図を解釈してツールを選ぶ。（レガシー経路 = assist.ts の buildContext キーワード判定は「今回の質問 + 直近のユーザー発言 3 件・各 200 cp」を対象のまま）。フォールバックの決定的ルーティングは「今回の質問 → 該当なしなら直近のユーザー発言を連結して再判定」の 2 段。表示中セッションはタブ内で永続（sessionStorage）しリロード後も自動再開（復元不可 = 404 は新しい会話へフォールバック）**。**供給網羅（オペレーター報告 2026-07-18 #2）: 会社ブロックは自社/顧客の両対応で業界（主マーク）・自社担当・先方担当者・会社間の関係（relation_types ラベル + 双方向）を含む。人の関係（contact_relations = 顧客担当者/自社メンバー端点）は顧客担当者・メンバー両ブロックに併記。業界逆引き（業界 × 顧客一覧）・部署（一覧 + 部署名一致で所属展開・最長一致）・休暇種別・外部リンクの各ブロックを追加。マスタ由来はすべて stripDeniedFields を適用（補助マスタ = 業界・関係種別・休暇種別・部署・外部リンク・意思決定テーマ・AI 社員も対象。JOIN で取り込む単一項目 = 関係種別ラベル等は canViewField で判定。PR #41 レビューで網羅を検証）。フォールバック側はルーティング参照キャッシュのロード完了を待機**。**精度改善（オペレーター報告 2026-07-18 #3 = バッチ7a）: 会社照合は正規化名寄せ（法人格・空白除去 + 最長一致 = shared/domain/name-match）で「つなぐば」「（株）」表記ゆれに対応し、今回の質問 → 履歴（新しい順）→ 自社キーワード（弊社/当社を追加）の優先順。キーワードに乗らない曖昧・解釈型の質問は search_docs の検索リトリーバル（字句バイグラム + Vertex 埋め込み。無効環境は字句のみ）で「関連情報（社内データ検索）」ブロックとして補足（描画は segments の表示項目チェック = canViewField 通過行のみ・精密ブロック描画済みは除外。**source_kind='manual'〔アプリ利用マニュアル = shared/domain/kb・0082〕のみ表示項目チェックの対象外 = 全員参照可の公開マニュアル**）。クライアントフォールバックも同じ名寄せ + 自社/業界回答 + ナレッジ全文の字句照合（最後の砦）へ拡張。空フィールドはテンプレートに出力しない**。**アプリ利用マニュアル（改修依頼 2026-08-21・0082）: ナレッジベース（shared/domain/kb = アプリ仕様・操作/運用マニュアル・FAQ の 50 ドキュメント）を search_docs へ source_kind='manual' で取込み、①エージェントツール `app_manual`（only:['manual'] の検索）②使い方系キーワード（使い方/操作/手順/マニュアル/やり方 等）で発火する manual 文脈ブロックの 2 経路で供給。フォールバック（mock 共通）は kbFindRelated（決定的字句検索）の answerManual = 同一ロジック（原則6）** |
| useDecision | `GET /v1/decisions/logs`・`POST /v1/decisions/logs`（**実装・フロント接続済み**。判断テーマ = `/v1/masters/decision-themes`（汎用マスタ）。判断ログは追記のみ = 記録系保護。テーマ・選択肢・理由の存在チェックはサーバーが強制。シナリオ予測（決定的線形モデル）は表示射影としてクライアント側に維持 = 設計判断） |
| useSales | `GET /v1/sales`（月次実績の一覧。会計年度集計・KPI は shared/domain/fiscal の純粋関数をフロントと共有 = 表示射影はクライアント）・`POST /v1/sales`（管理者のみ。`rows` 1〜500 件の一括 upsert = 冪等キー month × company × projectType）・`POST /v1/sales/etl/run`・`GET /v1/sales/etl/runs`（管理者のみ。mart ETL = sales_monthly → fact_sales（app_office 内の mart 互換テーブル・オペレーター判断 2026-07-18）の一方向・冪等。日次バッチは `POST /jobs/sales-mart-etl`（CRON_SECRET）＝周期有給付与と同型）（**実装・フロント接続済み = バッチ6b**。機能ガード 'sales'（F-16）・実績登録はページの管理者モーダル） |
| useSystemStatus | `GET /v1/status`（services + インシデント（新しい順・直近 500 件）+ 90 日 uptime の一括ハイドレーション。記録のない日は operational 埋め = フロント射影はモックと共通。uptime バーはサーバー導出のため 500 件超でも影響なし）・`POST /v1/status/incidents`（管理者のみ。初報を updates[0] に記録・管理者通知）・`POST /v1/status/incidents/:id/updates`（管理者のみ・正順のみの状態機械 = FOR UPDATE 直列化・updates 追記・resolved で resolvedAt）・`POST /v1/status/uptime/recompute`（管理者のみ = 導出データの手動回復パス）。uptime 日次集計は shared/domain/uptime をフロントと共有し、日次バッチは `POST /jobs/uptime-rollup`（CRON_SECRET）（**実装・フロント接続済み = バッチ6c**。機能ガード 'status'（F-16）） |
| useAkebono | `GET /v1/akebono/wishes`（新しい順・直近 500 件。表示名はフロントが members マスタキャッシュから解決）・`POST /v1/akebono/wishes`（本文必須 = AKO-AKB-001・2000 コードポイントへ切詰め・追記のみ = 記録系）（**実装・フロント接続済み = バッチ6d**。機能ガード 'akebono'（F-16）。プレースホルダ・ロードマップは静的表示 = フロントの責務。**本バッチで mock-status が空 = API モードのモックバッジ全廃**） |
| useAkebonoImports（データ取込 F-32 = Phase D） | `GET /v1/akebono/import-sources`・`/import-mappings`・`/import-runs`（参照は全員）・`POST /v1/akebono/import-sources`（**管理者のみ**。AKO-IMP-001。**config = 方式別設定を method 別に正規化して保持**）+ **`PUT /v1/akebono/import-sources/:id/config`**（方式別設定の更新 = CSV ヘッダ有無/区切り・API エンドポイント/認証・JSON ルートパス。管理者のみ・normalizeSourceConfig で method 別に正規化）+ `/:id/archive` `/:id/restore`（論理削除で取消/復元 = 原則9.5）・`POST /v1/akebono/import-mappings`（**版管理** = 新版を追記し旧 active は superseded・version 採番は advisory lock で直列化・部分一意 INDEX が二重 active を防ぐ。項目 0 行は AKO-IMP-003。**fields は方式別ロケータ = CSV 列番号 columnIndex / 固定長バイト範囲 byteStart·byteEnd / JSON キー jsonKey ＋ 参照項目の突合キー lookupField を保持**。突合キー・バリアント軸取込の構造は保存時に shared/domain/import-link `validateImportMapping` で検証〔不正は AKO-IMP-008・モックと同一関数 = parity。2026-08-07〕）・`POST /v1/akebono/import-runs`（**記録系・追記のみ・実取込 = 監査指摘 2026-07-30 ①**。有効マッピングなしは AKO-IMP-002 409。ファイル方式は `contentBase64`〔10MB〕を受領し encoding〔utf8/sjis〕で復号・API 方式はサーバーが SSRF ガード付き pull〔lib/safe-fetch = https のみ・内部/メタデータアドレス遮断・リダイレクト不追跡・接続にも検証済み lookup を使用 = DNS リバインディング防止〕→ shared/domain/import-run でレコード抽出〔CSV 列番号/ヘッダ名・固定長バイト範囲・JSON ドットパス + transform = trim/number/date/upper/lower。UI は選択式〔IMPORT_TRANSFORMS カタログ = shared/domain/import-run・説明付き・旧自由入力値は「旧設定の値」として可視化。2026-08-07 ②〕〕→ 対象別に反映: product/company = 参照解決付き upsert〔空セルは既存値保持〕・**product_variant = バリアント軸取込〔2026-08-07 = 0053。グルーピングキー productCode で行を商品へ束ね・SKU コード code = 固有 ID で SKU を upsert〔突合は有効 SKU を既定込みで検査し、別商品ヒットは既定/実を問わず隔離・**自商品の**既定 SKU コード衝突行のみ実 SKU 新規作成→無効化で収束〕・axis1Value/axis2Value に割り当てた列の論理名が商品の軸ラベル・新規商品は既定 SKU を作らず・既存商品へ実 SKU 追加時は既定 SKU 無効化 = マトリクス生成と同型・行検証→商品書込の順で全行隔離グループは商品を書かない・商品レベルの失敗はグループ全行隔離・run はエンティティ単位 advisory lock でも直列化〕**・sku = コード一致更新・sales_record = source_ref フィンガープリント冪等の追記〔0046 部分一意〕・inventory = adjust/stocktake のみ ref_line_id フィンガープリントで冪等追記〔**adjust = qty を増減数（デルタ）として追記・stocktake = qty を実物理在庫数（絶対値）として受け理論在庫との差分を計上（実棚数はマイナス可・手動棚卸と同一意味論）。差分計上は棚卸キーの SKU×倉庫 advisory lock（lockInventoryKeys を akebono-trade から再利用・ソート取得で直列化）＋残高の 1 クエリ先読み（N+1 回避）。2026-08-10〕。参照解決は**突合キー lookupField** に対応〔未設定 = 従来の ID → 名称/SKU コード自動・設定時 = 指定項目〔id/name/SKU code/janCode/取引先 custom.<key>〕の有効行完全一致・一意のみ解決 = 0 件/複数一致は隔離。カタログ = shared/domain/import-link・SQL 識別子はカタログ経由のみ = 注入防止〕。エラー行は SAVEPOINT で隔離し残りを反映〔原則4〕・counts = staged/applied/skipped/failed・errors は 50 件まで記録。AKO-IMP-004〜008・上限 5000 行）（**実装・フロント接続済み = Phase D**。機能ガード 'akebono'。取込元は方式別マッピング編集 UI = 左辺=取込元・右辺=対象アプリの有効項目〔useAppFields〕。**`GET /import-sources` は config.authValue〔API トークン/資格情報〕を管理者にのみ実値で返し非管理者にはマスク = 最小権限**。方式別設定・ロケータの正規化は shared/domain/import-parse をフロント/API 共有。デュアルモード = モックモードは従来同期・挙動不変。**Google スプレッドシート取込 = 方式 `sheets_pull`〔0051〕**: config に spreadsheetId/spreadsheetName/sheetName/headerRow/startColumn を保持し、run 時にサーバーが Sheets values API で指定範囲〔開始行=ヘッダ・開始列以降〕を読み取り → rowsToCsv → 既存 CSV 抽出へ流す〔hasHeader:true・区切り ','〕。未連携・対象未設定・API 失敗は AKO-SHEETS-001/003/002。ファイル添付は不要） |
| useSheetsImport（Google スプレッドシート取込の連携 F-32・sheets_pull。**2026-08-03**） | `GET /v1/akebono/sheets/status`（enabled/connected。未設定は enabled=false でフロントが連携 UI を隠す）・`GET /v1/akebono/sheets/oauth/url`（**Google OAuth 2.0・管理者のみ**・spreadsheets.readonly + drive.readonly。state = 一回性 10 分 TTL の DB ノンス + email 突合・AES-256-GCM 暗号化 = calendar と同型）+ `/oauth/callback`（復帰 = `/akebono/imports?sheets=connected|error`。認証前登録）・`POST /v1/akebono/sheets/disconnect`（revoke 非ブロッキング）・`GET /v1/akebono/sheets/spreadsheets?q=`（Drive files.list = ブック検索）・`GET /:id/tabs`（シート〔タブ〕一覧）・`GET /:id/columns?sheet=&headerRow=&startColumn=`（開始行/列を指定して列定義 = ヘッダ行の各セル）。**接続はテナント単位の単一接続**（sheets_tokens id='default'）・書込/参照ブラウズは管理者のみ。実取込は akebono-imports の run が fetchSheetRows を呼ぶ。デュアルモード = モックは疑似同意〔即接続〕+ 決定的なダミーのブック/シート/列 | 
| useDashboardInsight（ダッシュボード AI レポート F-41 = Phase D） | `GET /v1/akebono/dashboard-insights?scope=segment&segmentId=` / `?scope=company`（保管済み or null）・`POST /v1/akebono/dashboard-insights/generate`（**導出キャッシュ upsert = media_insights 同型**。集計材料はサーバー組み立て（**buildSegmentIntegratedMetrics = 業態基点**: 業態に連携したメディアチャンネルを解決し、売上軸 sales_records + メディア軸 GA を突合。連携チャンネルが無ければ売上軸のみ。2026-08-03 の独立チャンネル化で業態→チャンネル解決を追加）・洞察は Vertex AI → 失敗時ヒューリスティック（llm フラグ）・scope=segment/company で 1 レコード。**GA 連携済みで月次が取れない場合は AKO-MEDIA-004 で生成拒否**（company は 1 業態でも失敗で拒否 = M1）。メディア機能トグル（'media'）はサーバーが app_configs から解決）（**実装・フロント接続済み = Phase D**。生成は業態単位 = 全ロール可 / **会社全体（scope=company・全社売上 = C3）は GET/生成ともサーバーが売上権限 'sales' を要求**（canUseFeature = featureGuard と同型・ルール未設定は既定 allow。レビュー監査-4 = クライアントゲートのみに依存しない）） |
| useDocuments | `GET /v1/documents`（フォルダ + ファイルの全メタ。アーカイブ済みも active 付きで返す。stripDeniedFields('documents')）・`POST /v1/documents/folders`・`POST /v1/documents/files`（base64 JSON・10MB。実体 = GCS `documents/<id>/<filename>`（STORAGE_BUCKET 未設定/失敗は document_blobs bytea フォールバック）→ メタ確定の SoT 順序。テキスト抽出（.md/.txt/.pdf/.docx/.pptx/.csv = extract-text 共用）は補助処理 = 失敗しても取込成立）・`PATCH /v1/documents/:id`（名称・タグ・概要・移動。フォルダ循環は AKO-DOC-005）・`POST /:id/archive` `/:id/restore`（論理削除 + 監査ログ = 原則 9.5）・`GET /v1/documents/files/:id`（base64 ダウンロード）・`POST /v1/documents/files/:id/url`（**15 分有効の V4 署名 URL** = IAM signBlob。DB 保管は url null = base64 経路へ縮退。原本・URL は documents.summary の表示項目 deny で 403 = deny 迂回防止）・**ドライブ連携**: `GET /drive/status` `GET /drive/files?q=`（drive.readonly。カレンダーと同一 OAuth トークン共用 = 旧スコープは AKO-DOC-006 で再接続案内）・`POST /drive/import`（1 回 10 件・各 10MB・Google ドキュメント/スプレッドシート/スライドは docx/csv/pptx へエクスポート変換・部分成功を imported/failed で報告 = 原則4）（**実装・フロント接続済み = バッチ7l**。機能ガード 'documents'（F-16）。書込後は検索インデックス自動再生成 = source_kind 'document' としてチャットボットのリトリーバル・AI カンパニーの材料へ流入。チャットボット文脈にはヒットしたドキュメントの署名 URL を添付し「回答に使った場合のみ案内」と指示） |
| usePermissions | ルール = `/v1/masters/permission-rules`（汎用マスタ）。判定は shared/domain/permissions.ts をフロント/API で共有（個人 > 役職 > ロール・同一レイヤは deny 優先・同一レイヤ内は明示キー → 一括キー（マスタ全体 = field null / 全メンバー = member:*）→ の順で参照（バッチ7m）・どのレイヤにも無ければアプリ既定値 = 機能・表示項目は allow）。機能ガード = API middleware（/v1/masters・/v1/configs・/v1/notifications・/v1/escalations はデータ面のため対象外）+ フロントのメニュー/ページ非表示。表示項目レベルはマスタ GET 応答からサーバーが剥がす（マスタ全体 deny はカタログ = shared/domain/permission-catalog の全項目を剥がす）。**改修依頼 2026-08-18 の拡張擬似フィールド（スキーマ不変 = 全て permission_rules.field の予約形式）: `tab:<タブキー>` = タブ利用可否（canUseTab・フロント enforcement = タブ非表示 + 直打ち退避。カタログ = TAB_PERMISSION_CATALOG）／`<項目キー>:write` = 項目の更新可否（canEditField = 参照＞更新の階層・API enforcement = masters PATCH の stripMasterWriteKeys・AKO-PRM-003）／`ai-scope:member:<id>`・`ai-scope:title:<役職>`・`ai-scope:role:<ロール>`・`ai-scope:*` = 登録者単位の AI 参照対象（canAiReferenceOwner / aiAllowedOwnerIds。既定 = 権限表の参照権限〔reports = canViewMemberReports・ai-assistant = canViewMemberTaskPlans・poipoi = all・attendance = own〕・レガシー二値 `ai-scope` はフォールバックとして互換維持。enforcement = チャットボット文脈供給〔勤怠チームサマリー・チームのタスク計画・他メンバー日報・searchDocsFor の noteOwnerIds〕）** |
| useAiCompany | `GET/POST /v1/ai-company/tasks`（+ `/:id/approve|progress|block|cancel` = FOR UPDATE の状態機械・活動ログ・完了通知・AI 社員 status 同期）・`GET /v1/ai-company/logs`・`POST /v1/ai-company/daily-reports`（冪等生成 → daily_reports author_kind='ai'）・`POST /v1/ai-company/workload-check`（停滞/過負荷 → エスカレーション）・ロール/AI 社員 = `/v1/masters/ai-roles`・`ai-employees`（**実装・フロント接続済み = バッチ6a**。分解 = Vertex AI 構造化出力 → 失敗時 shared/domain/ai-tasks。機能ガード 'ai-company'）。**AI 社員間の依頼・連携（バッチ7b・オペレーター指示 2026-07-19 #3): AiRole.permissions の `delegate` 権限（= マネージャーロール）を持つ AI 社員への依頼は、承認と同時に他の有効 AI 社員へ分担を子タスク化（requester_ai_employee_id + parent_task_id。割当 = LLM 構造化出力 → 失敗時 shared planDelegation の字句類似・決定的）。子は即 in_progress（人間の承認は親 1 回のみ = 依頼を一挙に引き受ける）・完了は親へロールアップ（全分担完了で親 done + 統合報告通知）・ブロックは親へエスカレーション + 依頼者通知・親の中止は子へ連鎖。子からの再連携なし = 連鎖の暴走防止**。**実遂行（バッチ7f・オペレーター指示 2026-07-19 #7）: POST /tasks は添付（attachments = .md/.txt/.pdf/.docx/.pptx/.jpg/.png。原本 = ai_task_files・テキスト抽出 + 画像はマルチモーダルで材料化）を受付。「進める」= ステップの実遂行（Vertex AI が成果物を生成 → ai_tasks.outputs へ追記。LLM 無効はヒューリスティック縮退）。人間のアクションが必要なら依頼者へ質問（ai_task_questions）+ blocked + 通知 → `POST /tasks/:id/answer`（依頼者 or 管理者・添付可）で再開。`GET /files/:id`（依頼者 + 管理者）。AI 社員の増減 = /v1/masters/ai-employees（/ai-company/employees 画面）**。**全自動実行 + Web 調査（バッチ7i・オペレーター指示 2026-07-19 #11）: 承認・回答・ブロック解除・手動「進める」を起点に、サーバーが fire-and-forget の自動実行ループ（autoRunTask。上限 12 ステップ・競合 009 は 1 回再試行・停止条件 005/006/014 は静かに終了）で完了・質問・中止まで走り切る（HTTP 応答はブロックしない = 進捗は一覧の再取得・フロントは承認後 3 秒間隔 ×8 回のポーリングで追跡）。各ステップの遂行前に generateGroundedText（Vertex Google 検索グラウンディング。構造化出力と併用しない 2 段構成・失敗は調査なしで続行 = 原則4）でWeb 調査メモ + 出典 URL を材料化し、成果物へ「参考」として出典を明記。依頼者への質問は「自社・顧客のドメイン情報が不可欠」「重要な意思決定が必要」のみに限定（ヒューリスティックは 10 字未満 or 内部参照 + 30 字未満のみ・LLM はプロンプトで限定・上限 3 回）。「進める」ボタンは自動実行が止まった場合の「再開」フォールバックとして残置（サーバー再起動時等 = 冪等・二重実行は状態機械が排他）** |
| プロフィール（/profile） | `GET /v1/me`（avatar + **prefs = 本人の UI 設定**を含む。prefs = user_preferences の本人分オブジェクト。0039）・`PUT /v1/me/profile`（本人のアイコン画像 = data:image/png・jpeg・webp の base64 のみ許可（SVG 等は拒否 = スクリプト混入防止）・300KB 上限・空文字で削除・監査ログ記録。バッチ5e）。パスワード変更は Firebase Auth（reauthenticate → updatePassword）でクライアント完結・Google SSO アカウントは対象外。ログアウト = Firebase signOut + /v1/me キャッシュ破棄 |
| 個人 UI 設定（端末間同期） | `PUT /v1/me/preferences/:key`（本人のみ・upsert = 冪等。key = `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`・value(jsonb) 実バイト 4KB 上限・新規キーは per-user 100 件まで。`currentSegmentId` = **どの端末からログインしても同じ業態で開ける**。オペレーター指示 2026-07-30。`currentChannelId` = メディアチャンネル。**`dashboardLayout` = ダッシュボードの表示・配置レイアウト（F-13-9・2026-08-03。DashboardLayout の JSON）**）。取得は `GET /v1/me` の `prefs`。app_configs（テナント全体）の per-user 版で、監査ログは記録しない（高頻度・非セキュリティな UI 状態）。フロントは useCurrentSegment / useCurrentChannel / useDashboardLayout（API モード = SoT サーバー / モックモード = localStorage）。詳細は implementation-status §41・§51 |
| useBusinessDay | 祝日 = `/v1/masters/holidays`（汎用マスタ。date 一意・物理削除可・日付順）+ `POST /v1/holidays/import`（管理者のみ。内閣府「国民の祝日」CSV = Shift_JIS を取得して date 一意で upsert = 冪等・再取込可。csvText / csvBase64 のオフライン取込にも対応 = 公式サイト障害時の手動アップロード経路）。翌営業日計算は shared/domain/business-day（workingWeekdays / holidayAware = attendance_rules で勤務体系ごとに制御・祝日 Set を注入）をフロント/API（/v1/assist/report-draft の「明日の予定」）で共有（**オペレーター報告 2026-07-18 #4**） |
| useNotes（改善のタネ・議事録） | `GET/POST /v1/notes`（?kind=poipoi/minutes。poipoi = 本人のみ・minutes = 全員。任意で projectId/companyId/workCategoryId。一覧は `active=true` のみ）・`POST /v1/notes/import`（.md/.txt/.pdf/.docx = extract-text 再利用・原本 = note_files。UI は選択で即アップロードせずステージ → 取込ボタン押下で実行 = バッチ7d）・`POST /v1/notes/:noteId/archive`・`/restore`（**取消 = 論理削除 + 監査ログ、復元 = 取消の取消（原則 9.5 の対称性）。どちらも poipoi = 本人 / minutes = 登録者 or 管理者。冪等 = 状態不一致は警告 no-op。取消済みは `GET /v1/notes?includeArchived=1` で復元権限者にのみ見える。バッチ7d**）・`GET /v1/notes/:id/files`・`/files/:id`（poipoi は本人ガード。**取消済みノートの原本は復元権限者のみ** = 誤アップロード原本を晒し続けない）。**管理者の全ポスト閲覧 = `GET /v1/notes?kind=poipoi&scope=all`（管理者のみ 200・active のみ。バッチ7e = フィードバック用途。poipoi 原本も本人 + 管理者が参照可）**。機能ガード poipoi / minutes（F-16）。書込・取消後は検索インデックスへ自動反映（poipoi は owner_member_id = 本人スコープ = C3。ノートの紐付け（companyId/projectId）は search_docs.links に保持し、チャットボット/アシストが**言及された顧客・PJ と異なる紐付けのノートを文脈から除外** = 混入防止。バッチ7c/7d）。業務種別 = `/v1/masters/work-categories`。**POST /v1/notes で kind=poipoi のとき、configs `poipoi-notify-recipients`（ロール/役職/個人）を解決した宛先へ原文プレビューを通知（kind=poipoi・link=/poipoi・投稿者本人は除外・非ブロッキング。解決は共有 resolveNotifyRecipientIds。mock は useNotes が発火・API はサーバー発火。F-12-5・2026-08-03）**。**議事録の Google Meet 連携（③b・2026-08-03。API モード限定 = documents のドライブ取込と同型）: POST/import は meetFileId/meetFileName/meetWebLink を受理し保持（webViewLink は *.google.com のみ・id 空は全 null）。useMeetLink 経由で `GET /v1/notes/meet/status`（available/connected/driveScope/defaultFolder。カレンダートークンの drive.readonly を共用 = driveTokenState）・`GET /meet/folders?q=`（保管フォルダ検索）・`GET /meet/files?folderId=&q=`（フォルダ内の Meet AI メモ〔Google ドキュメント〕/録画〔動画〕。folderId 省略時は既定フォルダ）・`GET /meet/file-text?fileId=`（Google ドキュメントを text/plain エクスポート = 本文取込の材料）・`PUT /meet/default-folder`（管理者のみ = app_configs `meet-default-folder`・id 空でクリア）。未接続は Drive 共通の AKO-DOC-006、Drive API 失敗 AKO-NOTE-004、保管フォルダ未指定 AKO-NOTE-005。連携認証はカレンダー連携を再利用（別 connect なし）**。**改善要望 2026-08-21（0086）: notes に origin（'report' = 日報提出時 / 'direct' = 直接投稿。poipoi のみ・旧行 NULL = バッジ非表示 = 原則7）と notify_targets（ポスト単位の通知先上書き jsonb）を追加。POST は origin/notifyTargets を受理し、通知は「ポスト上書き > テナント設定」で解決。`PUT /v1/notes/:noteId/notify-targets`（poipoi のみ・投稿者本人 or 管理者。body.targets = 配列〔空 = 通知しない〕/ null = テナント設定へ戻す〔原則9.5〕・キー欠落は 400〔欠落を「通知しない」に読み替えない〕。保存後、変更前の実効宛先に含まれなかった解決済みメンバーへだけ原文を再通知 = 共有 addedNotifyRecipientIds・重複通知なし = 原則2・監査ログ）** |
| useCustomerLogs（顧客活動 = 旧「顧客ログ」〔改修依頼 2026-08-18 で改称〕。2026-07-30 → 項目拡張 2026-07-31 → 全員閲覧化 + 活動手段 2026-08-18） | `GET /v1/customer-logs`（既定 = 本人。**`?scope=all` = 全メンバーの有効な記録・`?memberId=` = 指定メンバーの有効な記録。改修依頼 2026-08-18 で権限チェックなしの全員閲覧化 = 旧 canViewMemberCustomerLog / AKO-PRM-002 は廃止・既存の参照対象ルールは migration 0066 で論理無効化**。`?from=&to=&companyId=&contactId=&includeArchived=1`（取消済みは常に本人分のみ = 他人の取消済みは晒さない））・`POST /v1/customer-logs`（本人。logDate 必須・**logTime = 開始時刻（任意・分は 15 分単位から選択 = UI 制約。API は HH:MM 許容 = 旧データ互換）・endTime = 終了時刻（任意・開始必須・開始より後）・tags = 活動目的（旧「属性タグ」。商談/取材/イベント等。最大 10 件・各 30cp・重複除去）・**method = 活動手段（訪問/Web会議/電話/メール/チャット/その他の単一選択・任意・'' = 未設定。プリセット外は 400 = 0066）**・staffMemberId = 自社の担当者（未指定 = ログインユーザー）・body = 担当者メモ（必須。議事録メモ minutesMemo は 2026-08-03 に廃止 = migration 0050）**・会社は `companyId` **または `newCompanyName`（コンボボックス自由入力 = 未登録名なら同一トランザクションで companies へ新規登録・正規化名の完全一致は既存へ名寄せ）**・担当者は `contactId`（会社所属を検証 = AKO-CLG-003）**または `newContactName`（同一会社内の氏名一致で名寄せ・なければ contacts へ新規登録）**。入力不正 = AKO-CLG-001）・`PATCH /v1/customer-logs/:id`（本人のみ・**部分更新 = 送られたキーのみ更新し未指定は現状維持（tags/endTime/staffMemberId/method も同様）**・newCompanyName/newContactName も受付・マージ後に時刻範囲/メモ必須（担当者メモ body 単独）を全体検証・監査ログ）・`POST /:id/archive` `/:id/restore`（取消 = 論理削除 + 監査ログ・復元 = 取消の取消（原則9.5 の対称性）・冪等 = 状態不一致は警告 no-op・本人のみ = AKO-CLG-002）（**実装・フロント接続済み**。機能ガード 'customer-log'（F-16・既定 allow）。**入力検証（日付・時刻・範囲・タグ・メモ・会社指定）のロジック・メッセージ・適用順の SoT = `shared/domain/customer-log`（API/モック共有 = パリティを構造的に担保。2026-07-31 レビューで集約）**。デュアルモード = モックは customerLogs コレクション（コンボボックス新規登録もモック側で同一規則）。書込後は検索インデックスへ自動反映 = source_kind 'customer-log'・segments に活動目的/活動手段/自社担当者/担当者メモを含む・owner_member_id = 記録者（本人スコープ = 他メンバーのログは AI 文脈へ供給しない）・links.companyId で顧客混入防止。**新規マスタ登録は監査ログ（companies/contacts の create）+ フロントは companies/contacts キャッシュを再取得 = SoT → キャッシュ**） |
| useSupportActivities / useSalesActivities / usePartnerActivities（活動記録 3 種 = 改修依頼 2026-08-18・F-43/F-44/F-45） | `GET /v1/support-activities` `/v1/sales-activities` `/v1/partner-activities`（**チーム共有 = 認証済み全員が閲覧可**。lib/list-query の共通実装 = パラメータ無しは全件〔取消済み込み・maxLimit 1000〕の bare 配列 = useApi.loadApiCollection の全件ハイドレーション互換／`q`〔サポート = 件名・内容・顧客名〔companies JOIN〕・問い合わせ者・対象システム、営業 = 商談名・顧客名・課題・提案・Next Action、パートナー = パートナー・テーマ・関連企業・概要・現在状況・Next Action・メモ〕+ `limit/offset` + 構造化フィルタ `f.*`〔status/category/priority/companyId/phase/dealType/activityType/active〕でページ取得 = `total` 付与。既定 limit 20）・`POST /`（**全員可**。検証 = shared/domain/activity を宣言順で適用〔AKO-SUP/SAL/PTN-001〕。サポート/営業の顧客はコンボボックス新規登録対応 = lib/company-resolve〔customer-logs と共通・同一トランザクション + 監査ログ〕。パートナーの relatedSalesActivityId は FK で実在担保〔23503 → 400〕）・`PATCH /:id`（**全員可 = チーム共有・訂正履歴は監査ログ**。部分更新 = 送られたキーのみ更新 → マージ後に全体検証。不在 404 = AKO-SUP/SAL/PTN-002）・`POST /:id/archive` `/:id/restore`（全員可・取消 = 論理削除 + 復元 = 原則9.5・冪等 = 状態不一致は警告 no-op・監査ログ）。機能ガード support-activity / sales-activity / partner-activity（F-16・既定 allow）。デュアルモード = モックは supportActivities/salesActivities/partnerActivities コレクション（CUSTOM_COLLECTION_ENDPOINTS 登録済み = API モードで tbl() はサーバーキャッシュ・一覧は useListView の fetch = apiListPage でサーバーページング）。AI 検索インデックスへは供給しない（安全側の設計判断）。**改修依頼 2026-08-19 第4弾・0071: 3 種に villageId(事業区分 Village 参照)・links(参考リンク) を追加。営業=contactId(担当・顧客人参照)+approachGroup、パートナー=partnerCompanyId(必須)/partnerContactId/approachCompanyId(顧客会社/人参照)+approachGroup、サポート=firstContactMethod/targetLocation を追加。会社/担当/事業区分の自由入力→新規登録は lib/company-resolve / lib/contact-resolve〔選択会社に所属を検証 = {code}-003〕/ lib/village-resolve を runInTx でマスタ解決 → INSERT/UPDATE → コミット後監査の順で処理（SoT 先行の原子性）。検証は shared/domain/activity = mock パリティ**。**改修依頼 2026-08-20・0074: 営業/パートナーを「案件ヘッダー + 活動ログ」構造へ再編。サブルート `GET/POST /v1/{sales|partner}-activities/:id/logs`（活動日降順・limit/offset サーバーページング〔既定 20〕・q/種別フィルタ）・`PATCH /:id/logs/:logId`・`POST /:id/logs/:logId/archive|restore`（取消/復元）・`POST /:id/digest`（活動ログの AI 集約 = LLM generateJson → heuristicActivityDigest フォールバック → ai_digest 上書き保管）。ログ不在 = {code}-004。sales/partner は activityLogRoutes の単一実装（原則3）。フロントは useActivityLogs(kind) が都度フェッチ（コレクションキャッシュ非使用 = ネスト資源の設計判断）。一覧行クリック → `/sales-activity/<id>`・`/partner-activity/<id>` の案件詳細ページへ遷移。mock 書込は commit() 戻り値検査 + 失敗ロールバック（AKO-SAL/PTN-090）・apiFetch は既定 15s タイムアウト** |
| useSalesApproaches（営業アプローチリスト F-53 = 改善要望 2026-08-21・0087） | `GET /v1/sales-approaches`（チーム共有 = 認証済み全員。取消済み込みの全量 = 1社1行のため上限は顧客数。CUSTOM_COLLECTION_ENDPOINTS 登録 = tbl() ハイドレーション）・`POST /`（全員可。検証 = shared/domain/sales-approach を宣言順で適用〔AKO-SAP-001〕・**company_id UNIQUE = 1社1行**〔23505 → AKO-SAP-003 409。取消済みも 1 行 = 復元で再開〕・FK 23503 → 400）・`PATCH /:id`（全員可・部分更新 = Object.hasOwn → マージ後に全体検証。不在 AKO-SAP-002）・`POST /:id/archive|restore`（論理削除 + 復元 = 原則9.5・冪等・監査ログ）。機能ガード sales-approach（F-16・既定 allow）。表示用の基本情報・属性・コンテキスト・活動実績はフロントが各 SoT コレクションから解決（本 API はアプローチ行のみ = 原則6） |
| useInternalSupports（社内サポート活動 F-57 = 改善要望 2026-08-22・0089） | `GET /v1/internal-supports`（チーム共有 = 認証済み全員。取消済み込みの全量 = 件数増加が緩やか。CUSTOM_COLLECTION_ENDPOINTS 登録 = tbl() ハイドレーション。活動日降順 → 作成降順）・`POST /`（全員可。検証 = shared/domain/internal-support を宣言順で適用〔AKO-ISP-001。活動日 → 時刻 → 実施者 → 対象者 → **実施者≠対象者** → 業務内容 → 方法〕・実施者の既定 = ログインユーザー・実施者/対象者の実在 = FK 23503 → 400）・`PATCH /:id`（全員可・部分更新 = Object.hasOwn → マージ後に全体検証。不在 AKO-ISP-002）・`POST /:id/archive|restore`（論理削除 + 復元 = 原則9.5・冪等・監査ログ）。機能ガード internal-support（F-16・既定 allow）。AKEBONO Intelligence が `/v1/internal-supports` を読み取り参照（ナレッジ「社内サポート」） |
| AKEBONO Intelligence（/v1/intelligence = 改善要望 2026-08-22・0090。**モック境界の本実装**） | すべてメンバー単位の所有（member_id スコープ = 旧ユーザー別 localStorage と同じ可視性。他人の記録は 404）。`GET /store`（insights + actions + cycles を 1 リクエストで返す）・`POST /generate`（theme = management/customer/project + targetId。**サーバーが DB からスナップショット収集**〔SELECT は shared/domain/intelligence の EngineData Pick 宣言と同列 = 型が乖離を検出。**呼び出しユーザーの F-16 権限を適用** = 機能 deny のソースは空・日報/週報/月報は canViewMemberReports でも絞る = フロント読み取り層の「403 → 空」と同じ「見える範囲で分析」をサーバーで強制〕→ Vertex AI generateJson で文面・提案を精緻化 → 失敗・無効環境は決定的エンジンへフォールバック〔llm フラグで区別 = akebono-dashboard と同型・原則4〕→ トランザクションで intel_cycles + intel_insights へ記録 + 監査ログ。分析対象データなしはエンジン宣言コード AKI-INS-* を 422 で素通し = モックモードと同一表示）・`POST /actions`・`PATCH /actions/:id`（部分更新 = Object.hasOwn）・`POST /actions/:id/transition`（INTEL_ACTION_STATUS_FLOW 外は AKO-ITL-003）・`/result`・`/feedback`（1〜5）・`/archive|restore`・`POST /insights/:id/archive|restore`（いずれも冪等 + 監査ログ = 原則9.5）・`POST /import`（**旧ローカル記録の移行取込** = サーバー側ストアが空のユーザーのみ〔再実行しても重複しない = 原則2〕。旧 id はユーザー間衝突のため再採番し cycle/insight/proposal/action の参照を張り替え）。エラー: AKO-ITL-001 入力不正 / 002 不在 / 003 遷移不正。PATH_FEATURES ガードなし（/v1/media と同様 = 認証済み全員。記録は本人スコープ） |
| AKEBONO ダッシュボードインサイト一覧（改善要望 2026-08-22） | `GET /v1/akebono/dashboard-insights/list`（AKEBONO Intelligence のナレッジ「ECレポート」参照用。business_segments JOIN で業態名を解決。**scope=company の行は売上権限が無いユーザーには返さない** = 単体 GET の requireCompanyDashboardAccess と同一判定を一覧にも適用） |
| useCustomerContext（顧客コンテキスト F-46 = 改修依頼 2026-08-20・**事業メモ = 0084・改修依頼 2026-08-21 第2弾**） | `GET /v1/customer-contexts`（ハイドレーション互換 = パラメータ無しは bare 配列〔lib/list-query〕。`q` = 会社名/ビジョン/経営課題/補足メモ/**事業メモ**の部分一致・`f.companyId`）・`GET /v1/customer-contexts/notes`（Memo 全量/ページング。`f.companyId`・`f.kind`・`f.active`・limit/offset。`/:companyId` より先に登録 = 静的パス確定。**companies.phone の参照 deny ユーザーには payload.before.companyPhone を伏せる = ノート経由の項目権限迂回防止〔R1 レビュー〕**）・`GET /v1/customer-contexts/:companyId`（単件。未登録は `data: null` = クライアントは「登録」導線を出す）・`PUT /v1/customer-contexts/:companyId`（**1社1行 upsert**〔ON CONFLICT company_id〕・**部分更新 = body に実在するキーのみ**〔`Object.hasOwn` = Zod v4 の `.partial()` 既定値注入バグ回避と同型〕・4 項目〔vision/challenges/strategyNotes/**businessNotes**〕すべて空は AKO-CTX-001・会社なし AKO-CTX-002。検証の SoT = shared/domain/customer-context = mock パリティ〔原則6〕）・`POST /v1/customer-contexts/:companyId/notes` + `POST /:companyId/notes/:noteId/archive|restore`（時系列 Memo の追記と論理取消/復元〔原則9.5〕・冪等 = 状態不一致は警告 no-op・メモなし AKO-CTX-003）・`POST /:companyId/research`（Web 調査 = Vertex 検索グラウンディング generateGroundedText → 失敗時は決定的ヒューリスティック〔原則4〕。候補 = タイトル + URI + 抜粋）・`POST /:companyId/research/build`（採用ソース 1〜8 件〔title + uri + **抜粋 snippet = 第3弾・任意・300cp cap**〕→ generateJson〔BUILD_SCHEMA = **businessNotes 含む 4 項目 + phone**。**phone = 情報源の記載・抜粋に明記がある場合のみ転記・創作禁止をプロンプトで明示**〕→ 決定的フォールバック〔phone = snippet からの正規表現抽出 `extractPhoneFromSnippets` = 実在する記載のみ〕。**LLM の phone は `groundResearchPhone` で事後検証 = 採用ソースの title/抜粋に実在する場合のみ採用・幻覚は抽出 → ''〔創作防止をプロンプト依存にしない構造的担保 = R1 レビュー。調査プロンプトも会社概要の基本情報〔代表電話・所在地等〕の収集を指示 = 抜粋に載る経路を確保〕**。応答 = `{ proposal, llm }`・差分表示の現在値はフロントのキャッシュから）・`POST /:companyId/research/apply`（upsert + research ノート自動追記 = **同一トランザクション**。payload = `{ sources, before }` = 反映前の値を保存。**body にキーが無い項目は現在値を保持** = 事業メモを知らない旧クライアント〔配信窓〕の反映で消さない・原則7。**phone 非空かつ現在値と異なる場合のみ companies.phone を同 Tx で更新し before.companyPhone に変更前を保存 + companies の監査ログ**〔'' = 取得なし → マスタを消さない・第3弾〕。**電話番号の更新は「管理者 + 項目権限〔companies.phone:write が deny でない〕」= マスタ更新経路（requireAdmin + stripMasterWriteKeys）と同じ強度〔canReflectCompanyPhone・R1 レビューで権限バイパスを是正〕。不許可は電話番号だけスキップし定性情報の反映は続行〔原則4〕**）・`POST /:companyId/research/:noteId/revert`（research ノートの before から復元 + `revertedAt` 追記 = ノートは archive しない監査可能な取消〔原則9.5〕。二重取消 no-op = 冪等・before 欠落 AKO-CTX-004。**旧スナップショット〔before.businessNotes キーなし〕は現在の事業メモを保持**〔原則7〕= 復元値の構築は shared `restoreContextFromSnapshot` の単一実装〔mock と共有 = 原則3/6〕。**before.companyPhone キーがあるノートは companies.phone も復元 + 監査ログ・キーなし〔旧ノート・電話番号を変更しなかった反映〕は触らない**〔原則7〕。**復元も「管理者 + 項目権限」が条件〔更新と対称・不許可は電話番号だけスキップ〕・保存時の生値をそのまま書き戻す〔正規化 cap で反映前の値を壊さない = R1 レビュー〕**）。採用ソースの保存形は shared `cleanResearchSources`（title 300 / uri 2000 / snippet 300 cap = mock と共用・原則3/6）。機能ガード customer-context |
| 検索インデックス（AI 検索最適化） | `POST /v1/search/reindex`（管理者のみ。search_docs の全再生成 = 手動回復パス。通常はマスタ書込後の自動再生成（デバウンス・非ブロッキング）+ API 起動時の再生成で追随 = 手動ステップなし）。SoT は各マスタ/ナレッジ本体で search_docs は派生キャッシュ（body_hash 不変はスキップ = 埋め込み API の無駄呼び出しなし。埋め込みは VERTEX_PROJECT_ID 設定時のみ = text-multilingual-embedding-002。無効環境は字句検索のみへ縮退）（**バッチ7a**） |
| ナレッジのドキュメント取込 | `POST /v1/knowledge/import`（管理者のみ。.md/.txt/.pdf/.docx を base64 で受け、テキスト抽出（PDF = pdfjs-dist・DOCX = mammoth）→ knowledge_articles へ記事化（既存スキーマ不変・本文 20,000cp 上限）+ 原本を knowledge_files へ保全（10MB 上限）。タイトルは指定 > md 見出し > ファイル名）・`GET /v1/knowledge/:id/files`（添付メタ）・`GET /v1/knowledge/files/:id`（原本 base64 ダウンロード）。取込後は検索インデックスへ自動反映（**バッチ7a**。UI = /masters/knowledge の「ドキュメント取込」） |
| useMediaChannels / useCurrentChannel / useMediaAnalytics / useMediaInsight / useMediaArticles / useMediaExternalArticles（メディア分析 F-40。**2026-08-03 独立チャンネル化**） | **チャンネル**: `GET /v1/media/channels?includeInactive=`（一覧・GA 接続状態を各行へ合成）・`POST /v1/media/channels`（作成 = name 必須(020)・segmentId 任意）・`PUT/PATCH /v1/media/channels/:id`（編集）・`POST /:id/archive` `/:id/restore`（取消/復元 = 原則9.5）。全て channelId で keying。**GA 連携**: `GET /v1/media/status?channelId=`（enabled/connected/needsProperty）・`GET /v1/media/oauth/url` + `/oauth/callback`（**Google OAuth 2.0・チャンネル単位**・analytics.readonly。state = 一回性 10 分 TTL の DB ノンス + email 突合・AES-256-GCM 暗号化 = calendar と同型。復帰 = `/media/settings?ga=&channel=`）・`GET /v1/media/properties?channelId=`（Admin API accountSummaries）+ `PUT /v1/media/property`（選択で connected 完成）・`POST /v1/media/disconnect`（revoke 非ブロッキング・設定/記事は残す）。**集計**: `GET /v1/media/metrics?channelId=&days=&force=`（GA4 Data API batchRunReports → MediaMetrics 整形 = lib/ga.ts。**conversions 廃止のため keyEvents**。30 分導出キャッシュ・内訳バッチ失敗は総計のみ + warning = 原則4）・`GET /v1/media/monthly?channelId=&months=`。**設定**: `GET/PUT /v1/media/settings?channelId=`（media_channels 該当行の部分更新 = hasOwn フィルタ。未存在は 021）。**記事**: `GET/POST /v1/media/articles?channelId=` + `/:id/deactivate` `/restore`・`POST /v1/media/articles/generate`（Vertex AI → 決定的フォールバック・**未連携チャンネルでも動く**）・`GET /v1/media/generated?channelId=` + `/:id/adopt|unadopt|remove|restore`（採用は冪等）。**外部投稿記事**: `GET/POST /v1/media/external-articles?channelId=` + `PATCH /:id` + `/:id/archive` `/:id/restore`（原文保管 = media インサイトの材料。title/body 必須 = 023）。**統合**: `GET /v1/media/integrated?channelId=&months=&force=`（**連携済みチャンネルのみ** = channel.segmentId で売上軸 sales_records を突合。未連携は 022。売上取得は対象月窓で絞り、窓判定は `COALESCE(元伝票.sales_date, 自身.sales_date)` = 赤黒の元月帰属に一致。GA 未連携は mediaConnected=false・GA 一時障害は mediaFailed=true）。**インサイト**: `GET/POST /v1/media/insights(/generate)?channelId=&scope=`（scope=media は GA 集計 + **外部投稿記事の原文を材料**・scope=integrated は連携済みチャンネルのサーバー組み立て。weekly_insights と同型の upsert 保管。AKO-MEDIA-016 欠番）。**現在チャンネル** = useCurrentChannel（mock = useState+localStorage 'ako.currentChannel.v1' / API = /v1/me pref 'currentChannelId'）。（書込系は admin のみ。shared/domain は不変 = opaque id）。**下位互換**: 旧 media_settings 由来のチャンネルは channel.id = 旧 segment_id（0048 backfill） |
| useMediaReports（AI 週次レポート・改善施策 F-55/F-56 = 改善要望 2026-08-21・0088） | `GET /v1/media/weekly-reports`（lib/list-query = パラメータ無しは全量 bare 配列〔ハイドレーション互換〕・limit/offset + `f.channelId` でページ取得。週開始降順）・`POST /v1/media/weekly-reports/generate`（**冪等生成** = 存在すればそれを返す〔判断を巻き戻さない = 原則2〕。既定 = 直前の完了週・weekStart 指定可〔月曜のみ AKO-MREP-001・未完了週 AKO-MREP-003〕・**backfill=true = 直近 4 完了週の冪等バックフィル〔一覧表示時の自動生成 = 取り逃した週の回復パス〕**。生成 = fetchMediaMetrics(28 日, asOf = 週終了日) → shared heuristicWeeklyMediaReport の決定的生成・ON CONFLICT DO NOTHING。**GA 部分失敗〔warning〕時は AKO-MREP-004 で生成しない = 劣化データの恒久保存防止**）・`GET /weekly-reports/:id`・`PATCH /weekly-reports/:id/actions/:index`（判断 = 未判断/実行する/継続検討/対象外を content jsonb へ記録〔**jsonb_set で対象アクション要素のみ更新 = 同時判断の巻き戻りなし**〕+ 監査ログ。応答に measureCreated = 起票済み判定のトースト出し分け。**「実行する」は media_measures を自動起票** = measureDraftFromAction・(source_report_id, source_action_index) 部分一意 index で二重起票なし）・`GET /v1/media/measures`（q + `f.channelId/assigneeMemberId/status/evaluation〔verification->>'humanEvaluation'〕/createdOn〔date 範囲〕/active`）・`GET /measures/:id`・`PATCH /measures/:id`（全員可・部分更新 + verification のキー単位マージ。検証 = shared mediaMeasureError / measureVerificationError〔AKO-MMEA-001/002〕）・`POST /measures/:id/ai-evaluation`（実施日前後の各 7 日比較 = shared heuristicMeasureEvaluation の決定的生成 → verification 保存・編集可）・`POST /measures/:id/archive|restore`（原則9.5・冪等）。**自動生成**: 一覧表示時の冪等バックフィル（フロント ensureGenerated = backfill・GA 連携直後は force 再試行）+ `POST /jobs/media-weekly-reports`（Cloud Scheduler 週次・共有鍵。GA 連携済み全チャンネル × 直近 4 完了週・チャンネル×週単位の失敗は非ブロッキング = 原則4）。**fetchMediaMetrics に asOfOverride を追加（基準日指定 = キャッシュキー `metrics:{days}:{asOf}`）・MediaMetrics.yoyWeek（前年同期 = 52 週〔364 日〕前の同じ曜日並びの 7 日間の週合計 = 単独 runReport で日別取得 → 合算。失敗は未設定 = 「—」表示 = 原則4/7。基準日つきキャッシュキーの古い行は putCache 時に機会的削除）** |
| 参照系 computed | `GET` + クライアントキャッシュ（表示射影はフロント純粋関数のまま維持） |

## 4. エラーコード起番（台帳: モックアップ + API サービス共通）

> 実装で使用する `AKO-{領域}-{番号}` は**必ず本表へ起番**する（コードとドキュメントの一貫性 = 開発原則5）。
> 「API」列 = api/（Cloud Run）でも使用。API では HTTP ステータス（400/401/403/404/405/409/500）と併用する。

| code | 意味 | API |
|---|---|:---:|
| AKO-GEN-001 | 必須項目未入力・入力形式不正 | ✅ |
| AKO-GEN-002 | 対象が見つからない・操作対象として不正 | ✅ |
| AKO-GEN-003 | 重複データ（一意制約違反） | ✅ |
| AKO-GEN-404 | エンドポイントなし（API のみ） | ✅ |
| AKO-GEN-500 | サーバー内部エラー（API のみ・詳細はログ） | ✅ |
| AKO-GEN-004 | リクエストボディの総量超過（80MB = 添付 10MB × 5 件の base64 を許容。413） | ✅ |
| AKO-GEN-NET | API へ到達できない（フロント側のネットワーク/接続エラー） | ✅ |
| AKO-AUTH-001 | 未認証・認証トークン不正（API のみ） | ✅ |
| AKO-AUTH-002 | 認証済みだが members に未登録（API のみ） | ✅ |
| AKO-AUTH-003 | 権限不足（管理者/人事ロール要求。ドメイン固有コードがある操作はそちらを優先） | ✅ |
| AKO-ATT-001 | 不正な打刻順序（状態機械違反） | ✅ |
| AKO-ATT-002 | 修正理由未入力 | ✅ |
| AKO-ATT-003 | 処理済み修正申請への再操作 | ✅ |
| AKO-ATT-004 | 承認/却下/取下げの権限なし（経路の現ステップ承認者 or 管理者。取下げは本人） | ✅ |
| AKO-ATT-005 | 直行/直帰が未承認のため打刻修正を申請できない（0040） | ✅ |
| AKO-LEV-001 | 有給残数不足 | ✅ |
| AKO-LEV-002 | 処理済み申請への再操作（承認/却下は pending のみ） | ✅ |
| AKO-LEV-003 | 休暇申請の承認/却下の権限なし（管理者/人事のみ） | ✅ |
| AKO-LEV-004 | 休暇付与の権限なし（管理者/人事のみ） | ✅ |
| AKO-LEV-005 | 無効な休暇種別への付与・申請 | ✅ |
| AKO-LEV-006 | 付与日数の範囲外（1〜40 日） | ✅ |
| AKO-LEV-007 | 一括付与の対象 0 名 | ✅ |
| AKO-LEV-008 | 法定有給の編集・無効化（不可） | ✅ |
| AKO-DEP-001 | 所属メンバーが残る部署の無効化（不可） | ✅ |
| AKO-DEP-002 | 有効な子部署が残る部署の無効化（不可） | ✅ |
| AKO-DEP-003 | 部署の循環親子指定（自部署・配下を親に不可） | ✅ |
| AKO-REP-001 | 提出済み日報を下書きへ戻す操作（不可。提出済みの本人編集は可 = 監査ログ記録。2026-07-17 オペレーター指示で変更） | ✅ |
| AKO-REP-002 | 提出済み週報の編集（不可 = 記録保護） | ✅ |
| AKO-WFL-001 | 承認権限なし / 対象ステップ不一致 / 操作できない状態（クレーム失敗含む） | ✅ |
| AKO-WFL-002 | 却下・差戻しコメント未入力 | ✅ |
| AKO-WFL-003 | 区分×金額に該当する承認経路なし | ✅ |
| AKO-WFL-004 | 稟議添付の形式・サイズ・件数違反（対応形式外 / 10MB 超 / 5 件超） | ✅ |
| AKO-SFT-001 | シフトバリデーション違反（休憩/深夜/週40h） | ✅ |
| AKO-SFT-002 | 募集期間ステータスの不正遷移（正順のみ） | ✅ |
| AKO-SFT-003 | 受付中以外への希望提出・変更 | ✅ |
| AKO-SFT-004 | 調整中以外での割当変更・解除 | ✅ |
| AKO-SFT-005 | 対象（期間・希望・割当）が見つからない | ✅ |
| AKO-SFT-006 | 確定後変更・本人合意まわりの状態不正 | ✅ |
| AKO-SFT-007 | 期間・日付入力の不正（締切/範囲/期間外） | ✅ |
| AKO-SFT-008 | シフト管理操作の権限なし（管理者のみ） | ✅ |
| AKO-TPL-001 | タスク計画のタスク名未入力 | ✅ |
| AKO-TPL-002 | タスク計画の実施予定日未選択 | ✅ |
| AKO-TPL-003 | 他人の計画への操作（本人のみ） | ✅ |
| AKO-TPL-004 | （廃止）旧: 結果記録済み計画の編集・削除不可。2026-07-21 に done も訂正可へ緩和したためコード上未使用（履歴のため欠番） | ✅ |
| AKO-PRM-002 | 他メンバーの AI業務アシスタント参照の権限なし（F-16-7・?memberId=） | ✅ |
| AKO-TPL-005 | 結果の未入力 | ✅ |
| AKO-CAL-001 | カレンダー同期・Google 反映の失敗 | ✅ |
| AKO-CAL-002 | タスク名未入力 | ✅ |
| AKO-CAL-003 | タスク時刻の不正（開始 >= 終了） | ✅ |
| AKO-CAL-004 | アプリ発以外の予定の Google 反映（不可） | ✅ |
| AKO-CAL-006 | Google 由来の予定の削除（不可。005 は欠番 = 反映済み再実行は no-op + warning） | ✅ |
| AKO-CAL-007 | カレンダー未連携・連携未設定 | ✅ |
| AKO-RAS-001 | ヒアリング回答が空 | ✅ |
| AKO-RAS-002 | 改善のタネが空 | ✅ |
| AKO-RAS-003 | AIで整形の入力上限超過（8000 コードポイント。`POST /v1/assist/format-text`。400。改修依頼 2026-08-20） | ✅ |
| AKO-ESC-001 | クールダウン中の重複起票（no-op 情報） | ✅ |
| AKO-ESC-002 | 無効化されたシグナルの起票 | ✅ |
| AKO-ESC-003 | 解決済みエスカレーションへの再操作 | ✅ |
| AKO-ESC-999 | 起票失敗（主フローは継続 = 非ブロッキング） | ✅ |
| AKO-RTM-001 | 使用中の関係種別の物理削除（不可。未使用のみ削除可・使用中は無効化を案内） | ✅ |
| AKO-CHT-001 | チャットセッションが見つからない・他人のセッションへの操作（404 に統一 = 存在を漏らさない） | ✅ |
| AKO-PRM-001 | 機能の利用権限がない（権限ルールの deny・403） | ✅ |
| AKO-PRM-003 | 指定した項目を更新する権限がない（`<項目>:write` deny / 参照 deny = 参照＞更新。マスタ PATCH の全キーが更新不可のとき 403。一部のみ不可は当該キーを剥がして残りを更新 = 原則4。改修依頼 2026-08-18） | ✅ |
| AKO-DEC-001 | 判断テーマが見つからない | ✅ |
| AKO-DEC-002 | 選択肢が見つからない | ✅ |
| AKO-DEC-003 | 判断理由未入力 | ✅ |
| AKO-DOC-001 | ファイル名未入力 | ✅ |
| AKO-DOC-002 | フォルダ名未入力 | ✅ |
| AKO-DOC-003 | 同名フォルダの重複 | ✅ |
| AKO-DOC-004 | ドキュメントのファイルが空・サイズ超過（10MB） | ✅ |
| AKO-DOC-005 | 親フォルダ不正（不存在・ファイル指定・自分/配下への循環移動） | ✅ |
| AKO-DOC-006 | Google ドライブ連携が未設定・未接続・旧スコープ（要再接続） | ✅ |
| AKO-DOC-007 | ドライブの検索・取込失敗（Google API エラー） | ✅ |
| AKO-DOC-008 | モックモードでファイル本体なし（ダウンロード不可） | モックのみ |
| AKO-STS-001 | 対象サービスが見つからない | ✅ |
| AKO-STS-002 | インシデントのタイトル未入力 | ✅ |
| AKO-STS-003 | インシデントが見つからない | ✅ |
| AKO-STS-004 | インシデントステータスの不正遷移（正順のみ） | ✅ |
| AKO-STS-005 | 状況説明の未入力 | ✅ |
| AKO-STS-006 | 影響度の不正（minor / major / critical 以外。API のみ = モックは UI セレクトで制約） | ✅ |
| AKO-SAL-001 | 月次実績の入力不正（month 形式・projectType・金額） | ✅ |
| AKO-SAL-002 | 顧客(会社)が未登録 | ✅ |
| AKO-SAL-003 | 取込件数の範囲外（rows は 1〜500 件） | ✅ |
| AKO-AKB-001 | AKEBONO 要望の本文未入力 | ✅ |
| AKO-AKB-002 | 既定シード画像セクション（is_seed）の無効化・API からの新規作成は不可（名称変更は可。409） | ✅ |
| AKO-PRD-001 | 商品/SKU の必須項目未入力・価格不正 | ✅ |
| AKO-PRD-002 | 商品コードの重複（同一セグメント × 有効行。409） | ✅ |
| AKO-PRD-003 | SKU マトリクスの軸1未入力 | ✅ |
| AKO-PRD-004 | 商品画像の形式不正（data:image png/jpeg/webp/gif base64 以外・400,000 字超過。API のみ = モックはファイル選択 UI で制約） | ✅ |
| AKO-POR-001 | 発注の必須項目未入力（仕入先・セグメント） | ✅ |
| AKO-POR-002 | 発注明細が 0 行 | ✅ |
| AKO-POR-003 | 発注ステータスの不正遷移（状態機械 = shared PO_STATUS_NEXT。409） | ✅ |
| AKO-MFG-001 | 生産指示の対象 SKU 未指定 | ✅ |
| AKO-MFG-002 | 生産数量・完成数の不正 | ✅ |
| AKO-MFG-003 | 生産ステータスの不正遷移（409） | ✅ |
| AKO-MFG-004 | 指示中/進行中以外への実績登録（409） | ✅ |
| AKO-INB-001 | 入荷先倉庫の未指定 | ✅ |
| AKO-INB-002 | 入荷明細が 0 行 | ✅ |
| AKO-INB-003 | 入荷実績のある予定の取消（409） | ✅ |
| AKO-PCH-001 | 仕入の必須項目未入力（仕入先・セグメント） | ✅ |
| AKO-PCH-002 | 仕入明細が 0 行 | ✅ |
| AKO-PCH-003 | 訂正伝票の再訂正・二重訂正（409） | ✅ |
| AKO-OUT-001 | 出荷の必須項目未入力（出荷先・倉庫・セグメント） | ✅ |
| AKO-OUT-002 | 出荷明細が 0 行 | ✅ |
| AKO-OUT-003 | 出荷実績のある指示の取消（409） | ✅ |
| AKO-OUT-004 | 出荷元の在庫不足（409） | ✅ |
| AKO-OUT-005 | 出荷→売上自動計上の不成立（店舗預けの出荷は計上不可 409・出荷先/セグメント未指定・単価未解決 = Phase D） | ✅ |
| AKO-INV-001 | 在庫操作の SKU・倉庫未指定 | ✅ |
| AKO-INV-002 | 在庫数量・理由・棚卸行の不正 | ✅ |
| AKO-INV-003 | 倉庫間移動の移動元 = 移動先 | ✅ |
| AKO-INV-004 | 移動元の在庫不足（409） | ✅ |
| AKO-SLS-001 | 売上の必須項目未入力・数量/単価不正 | ✅ |
| AKO-SLS-002 | 訂正明細の再訂正・二重訂正（409） | ✅ |
| AKO-SLS-003 | 請求済み明細の訂正（請求側で赤伝を発行。409） | ✅ |
| AKO-BIL-001 | 締め対象の未請求売上なし | ✅ |
| AKO-BIL-002 | 下書き以外の請求発行（409） | ✅ |
| AKO-BIL-003 | 発行済み以外への赤伝発行（409） | ✅ |
| AKO-BIL-004 | 発行済み以外への入金（draft = 未発行・void = 赤伝済みを含む。409） | ✅ |
| AKO-BIL-005 | 入金額の不正 | ✅ |
| AKO-BIL-006 | 委託精算の対象（未精算 店舗売上）なし = 再締めの冪等応答 | ✅ |
| AKO-BIL-007 | 下書き以外の支払通知確定（409） | ✅ |
| AKO-BIL-008 | 委託マージン請求の単独赤伝は不可（精算全体の取消は `consignment/cancel` を使用。409） | ✅ |
| AKO-BIL-009 | 取消済み入金の再取消（409） | ✅ |
| AKO-BIL-010 | 委託精算の取消対象なし = 未実施または既に取消済み（二重取消ガード。409。Phase D） | ✅ |
| AKO-BIL-011 | 入金済み（部分入金含む）マージン請求・確定済み支払通知を含む委託精算の取消拒否（下流確定状態の保護。先に入金取消を案内。409。Phase D レビュー MAJOR-1） | ✅ |
| AKO-HOL-001 | 祝日の公式 CSV 取得失敗（ネットワーク・サイト側障害。CSV アップロードで代替可） | ✅ |
| AKO-HOL-002 | 祝日 CSV の解析結果が 0 件（形式不正） | ✅ |
| AKO-KNW-001 | ドキュメント取込の非対応形式（.md/.txt/.pdf/.docx 以外。旧 .doc は変換を案内） | ✅ |
| AKO-KNW-002 | ドキュメント取込のサイズ超過（10MB） | ✅ |
| AKO-KNW-003 | ドキュメントからテキスト抽出不能（画像のみの PDF・破損ファイル等） | ✅ |
| AKO-AIC-009 | AI タスクの同時操作競合（親子ロックのデッドロック検出 = 再試行可能） | ✅ |
| AKO-AIC-010 | AI タスク添付の非対応形式（.md/.txt/.pdf/.docx/.pptx/.jpg/.png 以外） | ✅ |
| AKO-AIC-011 | AI タスク添付のサイズ・件数超過（10MB / 5 件） | ✅ |
| AKO-AIC-012 | 回答待ちの質問がない | ✅ |
| AKO-AIC-013 | AI タスクの回答権限なし（依頼者本人または管理者のみ） | ✅ |
| AKO-AIC-014 | 依頼者の回答待ち（progress 不可 = 回答で再開） | ✅ |
| AKO-NOTE-001 | ノート取込の非対応形式（.md/.txt/.pdf/.docx 以外。旧 .doc は変換案内） | ✅ |
| AKO-NOTE-002 | ノート取込のサイズ超過（10MB） | ✅ |
| AKO-NOTE-003 | ノートからテキスト抽出不能 | ✅ |
| AKO-NOTE-004 | 議事録 Meet 連携の Drive API 失敗（フォルダ/ファイル一覧・AI メモ export。③b・502） | ✅ |
| AKO-NOTE-005 | 議事録 Meet 連携の保管フォルダ未指定（既定フォルダ未設定 + folderId 省略。③b） | ✅ |
| AKO-CLG-001 | 顧客活動（旧: 顧客ログ）の入力不正（日付・開始/終了時刻・活動目的・活動手段・会社・担当者メモ〔必須〕・FK 未存在） | ✅ |
| AKO-CLG-002 | 顧客活動が対象外・本人以外の操作（編集/取消/復元。403） | ✅ |
| AKO-CLG-003 | 顧客担当者が選択会社に属さない | ✅ |
| AKO-SUP-001 | サポート活動の入力不正（受付日・種別・件名・内容・優先度・ステータス・完了日時・会社・FK 未存在。F-43） | ✅ |
| AKO-SUP-002 | サポート活動が見つからない（404。F-43） | ✅ |
| AKO-SAL-001 | 営業活動の入力不正（商談名・種別・フェーズ・金額/確度の範囲・日付・会社・FK 未存在。F-44） | ✅ |
| AKO-SAL-002 | 営業活動が見つからない（404。F-44） | ✅ |
| AKO-PTN-001 | ビジネスパートナー活動の入力不正（パートナー・テーマ名・区分・ステータス・日付・関連商談の FK 未存在。F-45） | ✅ |
| AKO-PTN-002 | ビジネスパートナー活動が見つからない（404。F-45） | ✅ |
| AKO-IMP-001 | 取込元名の未入力（F-32） | ✅ |
| AKO-IMP-002 | 有効なマッピング定義がない取込実行（先にマッピング保存を案内。409） | ✅ |
| AKO-IMP-003 | 取込マッピングの項目が 0 行（取込元項目・対象項目キーの入力を案内） | ✅ |
| AKO-IMP-004 | 取込内容なし・不正（ファイル未添付 / 空・10MB 超 / 復号不可 / データ行 0） | ✅ |
| AKO-IMP-005 | 無効化された取込元での実行（復元を案内。409） | ✅ |
| AKO-IMP-006 | 取込行数の上限超過（5000 行。分割実行を案内） | ✅ |
| AKO-IMP-007 | API 接続失敗（エンドポイント未設定 = 409 / https 以外・内部アドレス = SSRF ガード・接続エラー・非 2xx = 502） | ✅ |
| AKO-IMP-008 | マッピング定義不備（列を特定できない・対象で使えない項目キー・JSON 構文/パス不正・**突合キー不正・バリアント軸取込の必須項目欠落/重複〔保存時 + 実行時の再防衛。2026-08-07〕**） | ✅ |
| AKO-IMP-010 | 取込行の隔離（マスタ未登録など = 健全行のみ反映。実行履歴の errors に記録。**モックのシミュレート表示のみで使用** = 実取込の隔離は errors の message 本文で理由を返す） | ✅ |
| AKO-AIC-001 | AI 社員が見つからない | ✅ |
| AKO-AIC-002 | AI タスクの件名未入力 | ✅ |
| AKO-AIC-003 | AI タスクが見つからない | ✅ |
| AKO-AIC-004 | 提案中以外のタスク承認 | ✅ |
| AKO-AIC-005 | 実行中以外のタスク進行 | ✅ |
| AKO-AIC-006 | 未完了ステップなし | ✅ |
| AKO-AIC-007 | 実行中/ブロック中以外の状態切替 | ✅ |
| AKO-AIC-008 | 完了・中止済みタスクの中止 | ✅ |
| AKO-MEDIA-001 | メディア設定の対象セグメントなし | モックのみ |
| AKO-MEDIA-002 | GA4 プロパティ ID 未入力（擬似 OAuth） | モックのみ |
| AKO-MEDIA-003 | Google Analytics 未連携（トークンなし・プロパティ未選択を含む） | ✅ |
| AKO-MEDIA-004 | GA 集計の取得失敗（Data API 全滅。設定不備は API 有効化を案内） | ✅ |
| AKO-MEDIA-005 | GA 連携が未設定（GOOGLE_OAUTH_* 未投入 = 機能無効） | ✅ |
| AKO-MEDIA-006 | GA4 プロパティ一覧の取得失敗（Admin API） | ✅ |
| AKO-MEDIA-007 | 対象の記事（インベントリ）が見つからない | ✅ |
| AKO-MEDIA-008 | 記事パスの重複（再送・二重クリックの再登録 = 409。有効な同一パスが残る状態での復元も 409） | ✅ |
| AKO-MEDIA-010 | 記事生成の対象セグメントなし | モックのみ |
| AKO-MEDIA-011 | 記事生成のお題・キーワード未入力 | ✅ |
| AKO-MEDIA-012 | 対象の生成記事が見つからない | ✅ |
| AKO-MEDIA-013 | 生成記事の二重採用（モックのみ。API は no-op + warning = 冪等） | モックのみ |
| AKO-MEDIA-014 | 採用されていない生成記事の採用取消 | ✅ |
| AKO-MEDIA-016 | **欠番**（旧: 統合メトリクスのクライアント合成受領検証。Phase C のサーバー組み立て化で受領を廃止 = 009・015 も欠番） | — |
| AKO-MEDIA-020 | チャンネル名が未入力（作成・編集。2026-08-03 独立チャンネル化） | ✅ |
| AKO-MEDIA-021 | 対象のメディアチャンネルが見つからない（設定・編集・取消/復元・統合） | ✅ |
| AKO-MEDIA-022 | 統合分析には連携する業態（channel.segmentId）が必要（未連携チャンネルで integrated 要求） | ✅ |
| AKO-MEDIA-023 | 外部投稿記事の入力不正（title/body 必須・publishedAt 形式） | ✅ |
| AKO-MEDIA-024 | 対象の外部投稿記事が見つからない（編集・取消/復元） | ✅ |
| AKO-REQ-001 | 改善要望の本文が未入力（F-42・投稿） | ✅ |
| AKO-REQ-002 | 対象の要望／改修単位が見つからない（F-42） | ✅ |
| AKO-REQ-003 | 改修単位の見出しが未入力（F-42・編集） | ✅ |
| AKO-REQ-004 | 改修単位の更新項目がない（F-42・部分更新） | ✅ |
| AKO-REQ-005 | ステータス値が不正（F-42） | ✅ |
| AKO-REQ-006 | 許可されないステータス遷移（F-42・状態機械。409） | ✅ |
| AKO-REQ-007 | 対応予定期間が不正（実在日でない／終了<開始／終了のみ指定。F-42・0058） | ✅ |
| AKO-REQ-008 | 改修単位メモの本文が未入力／上限超過（F-42・0059） | ✅ |
| AKO-REQ-009 | 添付リンクが不正（http(s) 以外／件数・長さ超過。F-42-11・0061） | ✅ |
| AKO-REQ-010 | 添付画像が不正（allowlist 外／件数・サイズ超過。F-42-11・0061） | ✅ |
| AKO-REQ-011 | 要望ステータス値が不正（open/resolved/dismissed 以外。F-42-12・0062） | ✅ |
| AKO-REQ-012 | 要望の選別値が不正（pending/adopted/declined 以外。F-42-14・0063） | ✅ |
| AKO-REQ-013 | 集約済み要望の選別変更（記録保護 = 409。F-42-14・0063） | ✅ |
| AKO-REQ-014 | 生要望コメントの本文が未入力／上限超過（F-42-15・0063） | ✅ |
| AKO-REQ-015 | 取消済み要望の本文編集（先に復元 = 409。F-42-16・0064） | ✅ |
| AKO-REQ-016 | 一括選別の対象未選択（mock/フロント composable のみ。F-42-18・2026-08-18） | ✅ |
| AKO-REQ-017 | 未集約の要望への集約解除（解除は不要 = 409。F-42-19・2026-08-18） | ✅ |
| AKO-REQ-018 | 取消済み要望の集約解除（先に復元 = 409。F-42-19・2026-08-18） | ✅ |
| AKO-REQ-019 | 取消済み要望の選別変更（先に復元 = 409。F-42-18・2026-08-18） | ✅ |
| AKO-REQ-020 | 状態変化の競合（選別変更 = 判定と更新の間／集約解除 = 先読みとロックの間に要望の状態が変化 = 再読み込みを案内。409。F-42-18/19・2026-08-18） | ✅ |
| AKO-REQ-021 | 決着済み（運用対応/解決済み/対応見送り）改修単位からの集約解除（記録保護 = 先に reopen。409。F-42-19・2026-08-18。対応方針語彙 2026-08-20） | ✅ |
| AKO-REQ-022 | 取消済み改修単位からの集約解除（論理削除中のトレース保護 = 先に item を復元。409。F-42-19・2026-08-18） | ✅ |
| AKO-REQ-023 | 継続検討（deferred）への遷移で再検討日（revisitOn）が未指定・不正（400。対応方針 = 改修依頼 2026-08-20。deferred→deferred は再検討日変更として受理し通知デデュープをリセット） | ✅ |
| AKO-NCH-001 | チャネル連携が未設定（テナント資格情報 SLACK_BOT_TOKEN / GOOGLE_CHAT_SA_KEY なし。400。AKEBONO Home 名義化 2026-08-20） | ✅ |
| AKO-NCH-002 | 不正なチャネルサービス指定（slack/google_chat 以外。400） | ✅ |
| AKO-NCH-003 | 未連携チャネルへの操作（テスト送信等。400） | ✅ |
| AKO-NCH-004 | チャネルテスト送信の失敗（外部 API エラー。502。失敗ステップ + 上流応答の診断詳細を併記） | ✅ |
| AKO-NCH-005 | 通知マトリクスの形式不正（400） | ✅ |
| AKO-NCH-006 | 旧方式（個人 OAuth）互換シム: 旧 SPA キャッシュからの `/oauth/url` 呼び出しに再読み込みを案内（409。AKEBONO Home 名義化 2026-08-20） | ✅ |
| AKO-NCH-007 | 連携（宛先解決）の失敗（メール未登録/ワークスペース不一致 = 400・資格情報無効/一時障害 = 502。診断詳細を併記） | ✅ |
| AKO-CTX-001 | 顧客コンテキストの入力不正（定性情報/メモ/リサーチソース。400。改修依頼 2026-08-20） | ✅ |
| AKO-CTX-002 | 顧客コンテキストの対象会社なし（404） | ✅ |
| AKO-CTX-003 | 顧客コンテキストのメモなし（404） | ✅ |
| AKO-CTX-004 | 反映取消の復元データなし（research 以外・payload.before 欠落。400） | ✅ |
| AKO-CTX-090 | 顧客コンテキストのモック保存容量不足（commit 失敗 + ロールバック。モック専用） | — |

**改善要望（F-42。`/v1/improvements`。投稿は認証済み全員可・管理系は `canManageImprovements` = deny-by-default + 管理者常時可）:**

| メソッド・パス | 用途 | 認可 |
|---|---|---|
| `POST /v1/improvements/requests` | 要望の投稿（`body`／`pagePath`〔**登録時に `normalizeImprovementPagePath` で正規化 = アプリ内パス（`/` 始まり・`//`/`/\`/空白含みを除外）以外は `''` として格納**。F-42-20 のリンク化に伴う防御 = 改修依頼 2026-08-18 R1〕／`pageLabel`／**`links`〔URL 配列・最大 5 件・http(s) のみ = AKO-REQ-009〕／`images`〔`{filename,mime,dataUrl}` 配列・最大 4 件・PNG/JPEG/WebP/GIF data URI = AKO-REQ-010。0061〕／`tags`〔任意タグ配列。`brainstorm`〔壁打ち〕/`entrust`〔お任せ〕の allowlist 正規化 = 未知値は落とす〔エラーにしない〕。0065・F-42-17〕／`targetSpot`〔対象箇所 = ページ内のどこか。自由入力・任意・上限 `IMPROVEMENT_TARGET_SPOT_CAP`。0069・改修依頼 2026-08-19 第4弾 → 受付箱の一覧表示・詳細編集 = 2026-08-21〕**。投稿の初期ステータスは `unconfirmed`〔未確認 = 2026-08-21・0080〕） | 認証済み全員 |
| `GET /v1/improvements/requests` | 生要望の一覧（`itemId`／`unclustered`／`includeArchived`）。**添付画像の実体（data URI）は `itemId` または `unclustered=1` 指定時のみ返す**（全件一覧は `images: []` = 転送量削減。フロントはドロワー表示時に遅延ロード・0061／0063）。**改修依頼 2026-08-19 第4弾: 認証済み全員が閲覧できる（全要望を閲覧可）。一般利用者には「有効な全要望 + 自分の取消済み」を返す〔自分の取消は本人が復元できる = 原則9.5。他者の取消済みは非表示〕。`includeArchived=1`〔他者含む取消済みの参照〕は管理権限者のみ有効。旧・選別 adoption・集約解除履歴 excludedItemIds・AI 判定 aiAssessment は管理系のトリアージ状態のため非管理者へは返さない〔R1 監査反映 → 2026-08-21〕。**集約先 item の保存ステータスを `linkedItemStatus`（LEFT JOIN の導出値）として全員へ返す = 一般利用者も自分の要望の「対応済み」を判別し「解決済み」操作へ進める（表示ステータスは shared `improvementInboxStatusOf` で解決 = 原則6・2026-08-21）。同じ絞り込み（`stripTriageFields`）は投稿者本人が呼べる単一行応答（投稿 201・edit・archive・restore・resolve の RETURNING）にも適用 = 一覧で伏せた情報が本人操作の応答から漏れない〔R1 レビュー 2026-08-21〕** | 認証済み全員（自分の取消済み含む / 他者の取消済み・adoption・aiAssessment は管理） |
| `POST /v1/improvements/requests/:id/archive`・`/restore` | 要望の取消／復元 | 投稿者本人 or 管理 |
| `POST /v1/improvements/requests/:id/status` | **受付箱ステータスの変更（改修依頼 2026-08-21・0080 = 選別 + 進捗タグを状態機械へ一本化）。`status` = 基底 6 値（`unconfirmed`/`reviewing`/`planned`/`operational`/`deferred`/`dismissed`）のみ受理〔不正は AKO-REQ-011〕。遷移は `IMPROVEMENT_INBOX_NEXT`（未確認 → 検討中 → 改善対応/運用対応/継続検討/対応見送り。各終端 → 検討中の戻り = 原則9.5）に従い、機械外は AKO-REQ-006〔409〕。ガード順 = 存在 AKO-REQ-002 → 取消済み AKO-REQ-019 → 集約済み〔案件連動のため変更不可 = 先に解除〕AKO-REQ-013 → 解決済み〔先に解決を取消〕AKO-REQ-025 → 遷移（shared `improvementInboxStatusError` = mock と同一判定）。**`operational` は運用案内 `note` 必須〔AKO-REQ-024・上限超過 AKO-REQ-008〕= 「運用案内: 」接頭辞でコメント（improvement_request_comments）へ記録 + 起票者へ全文を通知〔link=/improvements?req=・非ブロッキング = 原則4〕**。**`deferred` は再検討日 `revisitOn` 必須〔AKO-REQ-023〕・deferred → deferred は再検討日の変更として受理し `revisit_notified_on` をリセット〔到来で再通知〕**。一括変更はクライアント逐次呼び（`setRequestStatusBulk` + shared `planInboxStatusBulk`。**deferred/operational は行ごとの入力が必要なため一括対象外 = AKO-REQ-028〔クライアント判定〕**） | 管理 |
| `POST /v1/improvements/requests/:id/resolve` | **解決済みの記録／取消（`resolved` = true/false。改修依頼 2026-08-21・0080）。解決済みは基底ステータスを上書きせず `resolved_at`（オーバーレイ）で表す = 取消（unresolve）で元の表示へ戻る（原則9.5・原則2）。解決済みにできるのは表示ステータスが「運用対応」（運用案内を確認）または「対応済み」（改修完了を確認）のときのみ = AKO-REQ-026〔shared `improvementResolveError`〕。再実行は冪等。旧データの保存値 `status='resolved'` は unresolve 時に `planned`（集約済み）/`reviewing` へ書き替えて新語彙へ合流（唯一の保存値書換 = 旧値には戻り先の情報が無いため）** | 投稿者本人 or 管理 |
| `POST /v1/improvements/requests/:id/assess` | **AI 判定（改修依頼 2026-08-21・0082）。ナレッジベース（shared/domain/kb）を RAG に「既存機能で対応可（existing）/運用の工夫で対応可（workaround）/改修が必要（improvement）/判定不能（unknown）」を判定し、根拠 `reason`・参照 doc `docIds`・`llm`・`assessedAt` を `ai_assessment`（jsonb）へ保管（再判定で上書き = 導出キャッシュ）。Vertex `generateJson`（`IMPROVEMENT_ASSESS_LLM_SCHEMA` → `normalizeAssessment` = verdict allowlist・docIds 実在検証）→ 失敗時は決定的ヒューリスティック `heuristicAssessRequest`（`llm:false`）。取消済みは AKO-REQ-019。判定と推奨アクション（existing/workaround → 運用対応・improvement → 改善対応・unknown → 検討中 = `IMPROVEMENT_ASSESS_META`）は受付箱ドロワーに表示し「推奨アクションを適用」で状態機械の遷移へ接続** | 管理 |
| `POST /v1/improvements/requests/:id/edit` | **要望の編集（`body`〔必須・最大 4,000 字・空/超過は AKO-REQ-001〕+ `tags`/`links`/`images`〔改修依頼 2026-08-19 で追加 = 登録時の全項目を編集可能に〕。検証は投稿と同一の shared 純関数 `improvementRequestEditFields`〔リンク AKO-REQ-009・画像 AKO-REQ-010〕。**部分更新: リクエスト body に実在するキーのみ SET し、送っていない tags/links/images は現行値を保持する〔CLAUDE.md 部分更新の鉄則。本文だけの編集で添付が消えない・空配列を明示送信すれば全削除〕**。取消済みは AKO-REQ-015〔409〕= 先に復元。`edited_at` を記録して「編集済み」を明示 = 再編集で戻せる〔原則9.5〕。**変更前本文は監査ログへ全文記録・FOR UPDATE + 同一トランザクション = 並行編集でも直前本文を喪失しない**。集約済みも編集可 = プロンプト再生成が現行本文を読む。0064・2026-08-18→2026-08-19）** | 投稿者本人 or 管理 |
| （旧）`POST /v1/improvements/requests/:id/adoption` | **廃止（改修依頼 2026-08-21）。**選別（採用/不採用）は受付箱ステータス（`/requests/:id/status` の状態機械）へ一本化した。保存済みの `adoption` 列は残置し、`improvementInboxStatusOf` が読み替える（pending → 未確認・adopted → 改善対応・declined → 対応見送り = 原則7。新規の書込なし）。一括変更もステータス側のクライアント逐次呼びへ移行（部分成功は done/failed で報告 = 原則4・専用一括 API は追加しない = 原則3） | — |
| `POST /v1/improvements/requests/:id/uncluster` | **集約の解除（F-42-19・2026-08-18 → ステータス再編 2026-08-21）。要望を改修単位から外し `status='planned'`（改善対応）へ明示的に戻す = 再度 AI 集約の対象（集約待ち）。`excluded_item_ids`（履歴・蓄積 = クリアしない）へ元 item を追記し、**次回以降の集約でそれらの item へは再追記しない**（同じ単位への往復 + detail 重複・「対象外」メモとの矛盾防止。二重解除でも過去の単位へ戻らない）。item のステータス・本文は不変（原則2）・`source_request_ids` からは除去（原則6）。**元 item には「【集約の解除】…実装対象に含めないこと」の修正メモ（improvement_notes・kind=note）を自動で残す**（detail の旧記載による再実装を防ぐ = プロンプトの担当者メモに載る。文言 = shared `buildUnclusterNoteBody` で mock と同一）。存在しない = AKO-REQ-002〔404〕／未集約 = AKO-REQ-017〔409〕／取消済み = AKO-REQ-018〔409・先に復元〕／**解決済み〔resolvedAt / 旧 status='resolved'〕= AKO-REQ-025〔409・先に解決を取消。解除しても generate の resolved_at IS NULL 条件で再集約対象にならないため = R1 レビュー 2026-08-21〕**／先読みとロックの間の状態変化 = AKO-REQ-020〔409・再読み込み〕／**決着済み（解決済み/対応しない）item の元要望 = AKO-REQ-021〔409・記録保護 = 先に reopen〕／取消済み item の元要望 = AKO-REQ-022〔409・先に item を復元〕**（共有ガード `improvementUnclusterError` = mock と同一判定）。ロック順は generate と同じ item → request（デッドロック回避）+ 同一トランザクション** | 管理 |
| `GET /v1/improvements/request-comments` | **生要望コメントの一覧（`requestId`／`includeArchived`〔管理のみ〕。古い順。0063）。非管理者は「自分の要望」+ `requestId` 指定に限り、運用案内（`kind='ops'` = operational 遷移の自動記録で、起票者へ通知した本文と同一）だけを取得できる（R2 監査 2026-08-21: 運用案内の本人到達を system 通知だけに依存させない = 通知 OFF でも要望ドロワーで読める。判別は kind〔0083・R3 監査〕= 管理者が「運用案内: 」で始まる手動コメント〔草稿のコピペ等〕を書いても本人へ漏れない。管理検討のコメント〔kind='comment'〕は従来どおり管理のみ）** | 管理（運用案内 kind='ops' のみ = 投稿者本人も可） |
| `POST /v1/improvements/requests/:id/comments` | **生要望へのコメント追加（`body`・最大 2,000 字。空/超過は AKO-REQ-014。対応方針検討のやり取りを時系列で記録・0063。運用対応への遷移時の運用案内も「運用案内: 」接頭辞つきでここへ記録される = 2026-08-21）** | 投稿者本人 or 管理 |
| `POST /v1/improvements/request-comments/:id/archive`・`/restore` | **コメントの取消／復元（論理削除・原則9.5。0063）** | 記入者本人 or 管理 |
| `GET /v1/improvements/items` | 改修単位の一覧（`filter` = all/open〔未完了〕/todo/in_progress/done〔保存値は 3 状態視点へ正規化して判定 = 旧語彙にも効く〕／`includeArchived`） | 管理 |
| `POST /v1/improvements/generate` | AI 集約（Vertex → ヒューリスティック。**「改善対応」（`status='planned'`。旧データは `status='open' AND adoption='adopted'` も対象 = 原則7）** かつ未集約・未解決の要望のみ・冪等。追記先候補は未対応（todo 視点）の案件のみ = `isClusterAppendTarget`。新規 item は `status='todo'`。0063 → 0080） | 管理 |
| `POST /v1/improvements/items/:id` | 改修単位の編集（`title`／`summary`／`detail`／`planStart`／`planEnd`〔対応予定期間・0058〕／**`assigneeMemberId`〔担当者の変更・解除。'' = 解除・実在しない/無効メンバーは AKO-REQ-027。担当者名はスナップショット保存 = 2026-08-21〕**の部分更新） | 管理 |
| `POST /v1/improvements/items/:id/status` | **ステータス変更（改修依頼 2026-08-21・0080 = 3 状態へ再編）。`status` = `todo`（未対応）/`in_progress`（対応中）/`done`（対応済）のみ受理〔旧 7 値語彙の投入は AKO-REQ-005 = 受付箱側の状態機械へ移管済み〕。遷移は `IMPROVEMENT_ITEM_NEXT`（未対応 ⇄ 対応中 → 対応済 → 対応中の reopen = 原則9.5）・機械外は AKO-REQ-006。**`in_progress` は任意で `assigneeMemberId`（担当者アサイン）を同時受理**。**`done` は `resolved_at` を記録し、紐づく要望の起票者へ「改善要望が「対応済み」になりました」を通知（link=/improvements?req=・非ブロッキング）**。reopen（done → in_progress）は `resolved_at` をクリア。保存済みの旧語彙（triage/accepted/…）は書き替えず `improvementItemViewOf` で 3 状態へ読み替える（原則7）** | 管理 |
| `POST /v1/improvements/items/:id/archive`・`/restore` | 改修単位の取消／復元 | 管理 |
| `GET /v1/improvements/notes` | 時系列メモの一覧（`itemId`／`includeArchived`。古い順。0059） | 管理 |
| `POST /v1/improvements/items/:id/notes` | メモ追加（`body`／`kind`〔note/reject〕。改修方針・保留/見送り理由。0059） | 管理 |
| `POST /v1/improvements/notes/:id/archive`・`/restore` | メモの取消／復元（論理削除・原則9.5。0059） | 記入者本人 or 管理 |
| `POST /v1/improvements/prompt` | 改修プロンプト出力（**対象の既定 = `todo`〔未対応〕のみ = 改修依頼 2026-08-21〔旧既定 accepted は todo 視点へ正規化され同義に吸収〕。対応中・対応済は含めない。冒頭にナビゲーター定型文 `PROMPT_NAVIGATOR_PREAMBLE` を必ず出力**。`filter` 指定は下位互換で受理（旧語彙の値は `normalizeImprovementFilter` で 3 状態視点へ正規化 = 旧値が 0 件にならない。GET /items の `filter` も同じ。R2 レビュー 2026-08-21）。**時系列メモも加味**・0059。**要望の添付 = 参考リンクの列挙・画像件数の言及も含む**・0061。**要望の受付箱ステータスを加味 = 【解決済み】は再改修しない・【対応見送り】は実装しない旨を明記（`promptRequestTag`）・対象ページに対象箇所〔targetSpot〕を併記**・0062 → 2026-08-21。**受付箱の要望コメント（improvement_request_comments・有効のみ）を各要望のサブ項目に反映**・改修依頼 2026-08-19。**タグ〔壁打ち/お任せ〕は人間運用の意思表示のためプロンプトには含めない**・改修依頼 2026-08-19〔従来の〔壁打ち〕〔お任せ〕明記を撤去〕） | 管理 |
| `POST /jobs/improvement-revisit-reminders` | **継続検討の再検討日リマインド（CRON_SECRET・日次。0073 → 受付箱への移管 2026-08-21）。到来した「継続検討」の**要望**（`improvement_requests.status='deferred'`・link=/improvements?req=）と、旧データの deferred **改修単位**（原則7 = 期日どおり届け続ける）の両方を走査して管理者へ通知。`revisit_notified_on` マーカーで同一期日の再通知を抑止（冪等 = 原則2）・deferred の再設定（リスケジュール）でマーカーはリセット。advisory lock で同時実行の二重通知を防止。実体 = `runImprovementRevisitReminders`（モックは `checkRevisitReminders` が要望 + 旧 item を localStorage デデュープで同等動作）** | CRON |

**設定・監査ログ（`/v1/configs`。改修依頼 2026-08-21 = 設定画面の 3 タブ化に伴う監査ログ参照の拡張）:**

| メソッド・パス | 用途 | 認可 |
|---|---|---|
| `GET /v1/configs` / `PUT /v1/configs/:key` | アプリ設定の参照（全員 = 機能トグルの表示制御）/ upsert 更新（冪等・監査ログ記録） | 参照 = 全員／更新 = 管理者 |
| `GET /v1/configs/audit-logs` | **監査ログの参照（読み取り専用）。設定 > 監査ログタブ用にサーバーページング + フィルタへ拡張（2026-08-21・0081 = at DESC / actor_id インデックス）: `limit`（既定 20・上限 500）／`offset`／`q`（actor_id・entity・entity_id・detail の ILIKE 横断）／`f.actor`・`f.action`・`f.entity`（完全一致）／`f.page`（shared/domain/audit-log のカタログで entity 集合へ展開。`other` = ページ特定可能 entity の否定 = カタログ外の未知 entity も拾う）／`f.at.from`・`f.at.to`（JST 日付キー範囲。不正・非実在日は黙って無視 = 原則4）。レスポンスは `{ data, total }`（total = フィルタ後全件数の兄弟キー）。既存の limit のみ呼び出しは data だけ読むため互換（原則7）。表示語彙（action/entity → ラベル・操作対象ページ）の SoT = `shared/domain/audit-log`（モックの camelCase entity は `normalizeAuditEntity` で同一カタログへ正規化 = 両モードで同じフィルタが効く = 原則6）** | 管理者 |
