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
daySummary(memberId, date): AttendanceDaySummary   // 6 バケット集計
monthSummary(memberId, month): MonthSummary        // 月次 + アラート
alerts(memberId): Article36Alert[]                 // 36 協定判定
requestFix(input: FixRequestInput): Result         // 修正申請（理由必須）

// useLeave
balance(memberId): LeaveBalance          // 残数・失効予定・義務進捗
request(input: LeaveRequestInput): Result
decide(requestId, action: 'approved'|'rejected', comment?): Result

// useWorkflow
resolveRoute(category, amount): RouteStep[]        // 職務権限マトリクス解決（純粋関数を内包）
submit(input: WorkflowInput): Result               // 採番 + routeSnapshot 凍結
act(requestId, action: ApprovalAction, comment?): Result  // 承認/却下/差戻し/取下げ
pendingFor(memberId): ComputedRef<WorkflowRequest[]>      // 代理設定を考慮

// useAiCompany
requestTask(aiEmployeeId, description): { taskId, decomposition[] } // 分解案を即時返す（モック生成）
approveTask(taskId): Result             // 承認 → 実行開始（活動ログ生成）
dailyDigest(date): AiDailyReport[]      // 日次報告（useReports が合流表示）

// useEscalations
raise(signal: EscalationSignal): Result // dedupeKey + クールダウンで冪等。失敗しても呼び出し元は継続
resolve(id, action: 'answer'|'ruling'|'no_action', body, reflectToKnowledge?): Result
   // ruling + reflect → useKnowledge.addFromEscalation() を非ブロッキング呼び出し

// useMasterCrud<T>(collectionName)
list(filter?): ComputedRef<T[]>
save(entity: Partial<T>): Result        // 追加/更新の統一。監査ログ記録
archive(id): Result                     // 論理削除のみ

// useCustomFields
defsFor(entity): CustomFieldDef[]
valueOf(entity, id, key): unknown
formSchemaFor(entity): FieldDef[]       // UiSchemaForm に直結
```

## 3. 将来 API 移行マッピング

| composable | 将来のエンドポイント（例） |
|---|---|
| useAttendance.punch | `POST /api/attendance/punches`（冪等キー付き） |
| useWorkflow.act | `POST /api/workflows/{id}/actions`（クレームファースト: 条件付き UPDATE） |
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
