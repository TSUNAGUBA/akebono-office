/**
 * 環境変数（起動時に一括検証。設定漏れは早期に落とす = フェイルファスト）
 * デプロイ手順: .ai-native/outputs/phase7/deploy-guide.md
 */

export interface Env {
  /** postgresql://user:pass@host:5432/db 形式。RDS の場合は ?sslmode 相当を DB_SSL で指定 */
  databaseUrl: string
  /** disable = ローカル / require = 暗号化のみ / verify = CA 検証（本番推奨。DB_SSL_CA と併用） */
  dbSsl: 'disable' | 'require' | 'verify'
  /** verify 時の CA 証明書 PEM（RDS グローバルバンドル）。パスではなく内容 */
  dbSslCa: string
  port: number
  /** dev = x-dev-member-id ヘッダ（ローカル・テスト用） / firebase = Firebase Auth ID トークン検証 */
  authMode: 'dev' | 'firebase'
  /** firebase モードの検証対象プロジェクト ID（aud / iss） */
  firebaseProjectId: string
  /** CORS 許可オリジン（カンマ区切り） */
  corsOrigins: string[]
  /** 起動時にマイグレーションを適用するか（既定 true。CI テストでは個別制御） */
  migrateOnStart: boolean
  /** Vertex AI の対象プロジェクト（空 = LLM 無効。全 AI 機能はヒューリスティックへフォールバック） */
  vertexProjectId: string
  /** Vertex AI ロケーション（既定 global = リージョン非依存エンドポイント） */
  vertexLocation: string
  /** 生成モデル ID（既定 gemini-2.5-flash） */
  vertexModel: string
  /** Google OAuth クライアント ID（カレンダー連携。空 = 連携無効） */
  googleOauthClientId: string
  /** Google OAuth クライアントシークレット（Secret Manager 経由） */
  googleOauthClientSecret: string
  /** トークン暗号化鍵（Secret Manager 経由。空 = 連携無効） */
  tokenEncryptionKey: string
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL ?? ''
  if (!databaseUrl) throw new Error('DATABASE_URL が未設定です')
  const authMode = (process.env.AUTH_MODE ?? 'firebase') as Env['authMode']
  if (authMode !== 'dev' && authMode !== 'firebase') throw new Error(`AUTH_MODE が不正です: ${authMode}`)
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID ?? ''
  if (authMode === 'firebase' && !firebaseProjectId) {
    throw new Error('AUTH_MODE=firebase では FIREBASE_PROJECT_ID が必要です')
  }
  const dbSsl = (process.env.DB_SSL ?? 'disable') as Env['dbSsl']
  if (!['disable', 'require', 'verify'].includes(dbSsl)) throw new Error(`DB_SSL が不正です: ${dbSsl}`)
  const dbSslCa = process.env.DB_SSL_CA ?? ''
  if (dbSsl === 'verify' && !dbSslCa) throw new Error('DB_SSL=verify では DB_SSL_CA（CA 証明書 PEM）が必要です')
  return {
    databaseUrl,
    dbSsl,
    dbSslCa,
    port: Number(process.env.PORT ?? 8080),
    authMode,
    firebaseProjectId,
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    migrateOnStart: (process.env.MIGRATE_ON_START ?? '1') !== '0',
    vertexProjectId: process.env.VERTEX_PROJECT_ID ?? '',
    vertexLocation: process.env.VERTEX_LOCATION ?? 'global',
    vertexModel: process.env.VERTEX_MODEL ?? 'gemini-2.5-flash',
    googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? '',
  }
}
