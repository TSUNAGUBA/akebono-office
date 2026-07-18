/**
 * 認証ミドルウェア。
 * - AUTH_MODE=dev: `x-dev-member-id` ヘッダで成りすまし（ローカル・CI テスト専用）
 * - AUTH_MODE=firebase: Firebase Auth の ID トークン（Bearer）を JWKS で検証し、
 *   email で members と突き合わせる（在籍かつ email 一致のみ許可）
 * 認可はロール（admin / hr / member）で行い、ガードは各ルートの責務。
 * エラーコード: AKO-AUTH-001（未認証/トークン不正）, AKO-AUTH-002（メンバー未登録）,
 *              AKO-AUTH-003（権限不足）
 */
import type { Context, MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type pg from 'pg'
import type { MemberRole } from '../../shared/domain/types'
import type { Env } from './env'
import { err } from './lib/errors'

export interface AuthUser {
  id: string
  name: string
  email: string
  role: MemberRole
  /** 役職名（権限ルールの title レイヤ判定に使用。空文字 = 役職なし） */
  title: string
  /** プロフィール画像（data:image/... URI。空文字 = 未設定） */
  avatar: string
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
  }
}

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

async function findMember(pool: pg.Pool, where: string, value: string): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, title, avatar FROM members WHERE ${where} AND active = true LIMIT 1`,
    [value],
  )
  return (rows[0] as AuthUser | undefined) ?? null
}

export function authMiddleware(env: Env, pool: pg.Pool): MiddlewareHandler {
  const jwks = env.authMode === 'firebase' ? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL)) : null
  return async (c, next) => {
    if (env.authMode === 'dev') {
      const devId = c.req.header('x-dev-member-id')
      if (!devId) throw err('AKO-AUTH-001', '認証情報がありません（dev モード: x-dev-member-id ヘッダ）', 401)
      const user = await findMember(pool, 'id = $1', devId)
      if (!user) throw err('AKO-AUTH-002', 'メンバーが登録されていません', 403)
      c.set('user', user)
      return next()
    }
    const bearer = c.req.header('authorization') ?? ''
    const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
    if (!token) throw err('AKO-AUTH-001', '認証情報がありません', 401)
    let email = ''
    try {
      const { payload } = await jwtVerify(token, jwks!, {
        issuer: `https://securetoken.google.com/${env.firebaseProjectId}`,
        audience: env.firebaseProjectId,
      })
      email = String(payload.email ?? '')
    } catch {
      throw err('AKO-AUTH-001', '認証トークンが無効です', 401)
    }
    if (!email) throw err('AKO-AUTH-001', '認証トークンに email がありません', 401)
    const user = await findMember(pool, 'lower(email) = lower($1)', email)
    if (!user) throw err('AKO-AUTH-002', 'この email のメンバーが登録されていません', 403)
    c.set('user', user)
    return next()
  }
}

export function requireAdmin(c: Context): AuthUser {
  const user = c.get('user')
  if (user.role !== 'admin') throw err('AKO-AUTH-003', 'この操作には管理者権限が必要です', 403)
  return user
}

export function requireHrOrAdmin(c: Context): AuthUser {
  const user = c.get('user')
  if (user.role !== 'admin' && user.role !== 'hr') {
    throw err('AKO-AUTH-003', 'この操作には管理者または人事の権限が必要です', 403)
  }
  return user
}
