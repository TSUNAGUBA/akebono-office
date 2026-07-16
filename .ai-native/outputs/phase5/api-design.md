# Phase 5: I/F 設計（composables 契約と将来 API 移行）

- **作成日:** 2026-07-15
- **作成ロール:** コーディングエージェント
- **位置づけ:** モックアップでは REST API を持たない。**composables の公開シグネチャを I/F 契約**とし、本番実装ではその内部（useMockDb 参照）を API 呼び出しへ差し替える。呼び出し側（pages/components）は変更しない。

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
plansOf(memberId, date): TaskPlan[]
upsertPlan(input): Result                // 本人のみ。done は編集不可（AKO-TPL-004）
removePlan(planId): Result               // 本人・planned のみ
aiReview(planId): Result                 // AI コメント生成（再取得で上書きのみ。モックは決定的ヒューリスティック）
recordResult(planId, { outcome, reflection }): Result  // 1 回で確定（記録系）
insights(days?): MemberInsight[]         // 管理者向け集計（計画数・完了率・振り返り記入率）

// useWorkflow
resolveRouteFor(category, amount): WorkflowRouteStep[] | null
   // 職務権限マトリクス解決。純粋関数 resolveRoute(routes, category, amount)
   //（app/utils/approval-route.ts）を内包。該当経路なしは null（AKO-WFL-003）
submit(input: WorkflowInput): Result               // 採番 + routeSnapshot 凍結
act(requestId, action: Exclude<ApprovalAction, 'submit'>, comment?): Result  // 承認/却下/差戻し/取下げ
pendingFor(memberId): WorkflowRequest[]                   // 代理設定を考慮（呼び出し側の computed 内で使用）

// useAiCompany
requestTask(aiEmployeeId, title, description): { ok, id, confidence } // 分解案を決定的モックで生成し proposed で登録（低確信度はエスカレーション起票）
approveTask(taskId): Result             // 承認 → 実行開始（活動ログ生成）
generateDailyReports(date): { created, skipped } // 日次報告を UPSERT 生成（既存分はスキップ = 冪等）
aiReportsOn(date): DailyReport[]        // 指定日の AI 日次報告を参照（useReports が合流表示）

// useEscalations
raise(signal: EscalationSignal): Result // dedupeKey + クールダウンで冪等。失敗しても呼び出し元は継続
resolve(id, type: 'answer'|'ruling'|'no_action', body, reflectToKnowledge?, knowledgeTarget?): Result
   // 裁定のナレッジ還流は resolve 内で非ブロッキング実施（専用の useKnowledge は設けない）。
   // knowledgeTarget = { domain, targetId } で還流先を指定。省略時は自社PJ

// useMasterCrud<T>(collectionName)
list(filter?): ComputedRef<T[]>
save(entity: Partial<T>): Result        // 追加/更新の統一。監査ログ記録
archive(id): Result                     // 論理削除のみ

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
removeTask(eventId): Result                          // アプリ発のみ削除可（google 発は Google 側で変更→同期）

// useReportAssist（F-06-7）
inputMode: ComputedRef<'form'|'assist'|'both'>       // 設定（appConfigs.reportInputMode）
questionsFor(memberId, date): AssistQuestion[]       // 予定 1 件 1 問 + まとめ 3 問（テンプレ+文脈）
recordAnswer(q, answer, date?) / poipoiMemo(text, date?): Result  // 蓄積ログ（追記のみ）。date 省略時は本日（過去日の日報にも対応）
generateDraft(memberId, date): ReportDraft           // 保存しない（フォームへ流し込み→確認・修正→既存 submit）
// 提出済み保護: useReports.reportOn の結果（status='submitted'）で呼び出し側が生成 UI を無効化する

```

## 3. 将来 API 移行マッピング

| composable | 将来のエンドポイント（例） |
|---|---|
| useAttendance.punch | `POST /api/attendance/punches`（冪等キー付き） |
| useWorkflow.act | `POST /api/workflows/{id}/actions`（クレームファースト: 条件付き UPDATE） |
| useCalendar.syncFromGoogle | Google Calendar API（OAuth 2.0 増分認可・calendar.readonly/events スコープ。Webhook push + 手動再同期の両立）。トークンはサーバー側で暗号化保管（C3 相当・クライアントへ出さない）。アプリの連携解除時はトークン破棄 + Google 側 revoke を呼び、Google 側での取消は次回 API 401 で検知して連携状態へ反映する |
| useReportAssist.generateDraft | LLM 構造化出力（responseSchema）+ 失敗時は本ヒューリスティックへフォールバック（ai-manager 方式）。タスク計画の結果（F-14）を含めて生成 |
| useTaskPlans.aiReview | LLM（計画の批評: 目的の具体性・達成条件の検証可能性・段取り分解を観点にした構造化出力）+ 失敗時は本ヒューリスティックへフォールバック |
| useLeave.grant / bulkGrant | `POST /api/leave/grants`（冪等キー: memberId×leaveTypeId×grantDate。権限: admin/hr ロール） |
| useEscalations.resolve | `POST /api/escalations/{id}/resolution`（ai-manager 方式: open→resolved のアトミッククレーム→失敗時補償） |
| useMasterCrud | `GET/POST/PATCH /api/masters/{entity}` |
| 参照系 computed | `GET` + クライアントキャッシュ（表示射影はフロント純粋関数のまま維持） |

## 4. エラーコード起番（モックで使用する分）

| code | 意味 |
|---|---|
| AKO-ATT-001 | 不正な打刻順序（状態機械違反） |
| AKO-ATT-002 | 修正理由未入力 |
| AKO-LEV-001 | 有給残数不足 |
| AKO-WFL-001 | 承認権限なし / 対象ステップ不一致 |
| AKO-WFL-002 | 却下・差戻しコメント未入力 |
| AKO-SFT-001 | シフトバリデーション違反（休憩/深夜/週40h） |
| AKO-ESC-001 | クールダウン中の重複起票（no-op 情報） |
| AKO-GEN-001 | 必須項目未入力 |
| AKO-LEV-004 | 休暇付与の権限なし（管理者/人事のみ） |
| AKO-LEV-005 | 無効な休暇種別への付与 |
| AKO-LEV-006 | 付与日数の範囲外（1〜40 日） |
| AKO-LEV-007 | 一括付与の対象 0 名 |
| AKO-LEV-008 | 法定有給の編集・無効化（不可） |
| AKO-DEP-001 | 所属メンバーが残る部署の無効化（不可） |
| AKO-DEP-002 | 有効な子部署が残る部署の無効化（不可） |
| AKO-TPL-001 | タスク計画のタスク名未入力 |
| AKO-TPL-002 | タスク計画の実施予定日未選択 |
| AKO-TPL-003 | 他人の計画への操作（本人のみ） |
| AKO-TPL-004 | 結果記録済み計画の編集・削除（不可 = 記録保護） |
| AKO-TPL-005 | 結果の未入力 |
| AKO-CAL-001 | カレンダー同期の失敗 |
| AKO-CAL-002 | タスク名未入力 |
| AKO-CAL-003 | タスク時刻の不正（開始 >= 終了） |
| AKO-CAL-004 | google 発予定への反映操作（アプリ発のみ可） |
| AKO-CAL-005 | 欠番（反映済みへの再実行は no-op + warning に変更） |
| AKO-CAL-006 | google 発予定の削除操作（Google 側で変更→同期） |
| AKO-CAL-007 | 未連携での同期・反映操作 |
| AKO-RAS-001 | ヒアリング回答が空 |
| AKO-RAS-002 | ぽいぽいメモが空 |
