/**
 * 通知の AKEBONO HOME 名義化（2026-08-20）の純ロジック。
 * - サービスアカウント鍵のパース + JWT Bearer アサーションの構築（lib/google-sa。
 *   トークン交換の HTTP は行わない = 「外部 HTTP はテストしない設計」を踏襲し、
 *   署名は Node 標準の createVerify で公開鍵検証する）
 */
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildSaAssertion, parseSaKey } from '../../src/lib/google-sa'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'akebono-home-chat@example.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
})

describe('parseSaKey（サービスアカウント鍵 JSON のパース）', () => {
  it('正当な鍵 JSON から必要フィールドを取り出す', () => {
    const key = parseSaKey(KEY_JSON)
    expect(key?.clientEmail).toBe('akebono-home-chat@example.iam.gserviceaccount.com')
    expect(key?.privateKey).toBe(privateKey)
    expect(key?.tokenUri).toBe('https://oauth2.googleapis.com/token')
  })

  it('token_uri 省略時は Google の既定エンドポイントを補う', () => {
    const key = parseSaKey(JSON.stringify({
      type: 'service_account', client_email: 'a@b', private_key: privateKey,
    }))
    expect(key?.tokenUri).toBe('https://oauth2.googleapis.com/token')
  })

  it('不正な入力は null（JSON でない / SA 以外の鍵 / 必須欠落 = 設定不備として扱う）', () => {
    expect(parseSaKey('{broken')).toBeNull()
    expect(parseSaKey(JSON.stringify({ type: 'authorized_user', client_email: 'a@b', private_key: 'x' }))).toBeNull()
    expect(parseSaKey(JSON.stringify({ type: 'service_account', client_email: 'a@b' }))).toBeNull()
    expect(parseSaKey(JSON.stringify({ type: 'service_account', private_key: 'x' }))).toBeNull()
  })
})

describe('buildSaAssertion（JWT Bearer アサーション = RFC 7523）', () => {
  const SCOPE = 'https://www.googleapis.com/auth/chat.bot'

  it('ヘッダー・クレーム（iss/scope/aud/iat/exp=+3600）が正しく構築される', () => {
    const key = parseSaKey(KEY_JSON)!
    const nowSec = 1_755_648_000 // 固定注入（決定的テスト）
    const jwt = buildSaAssertion(key, SCOPE, nowSec)
    const [h, c] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString('utf8'))).toEqual({
      iss: 'akebono-home-chat@example.iam.gserviceaccount.com',
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    })
  })

  it('署名は SA の公開鍵で検証できる（RS256）', () => {
    const key = parseSaKey(KEY_JSON)!
    const jwt = buildSaAssertion(key, SCOPE, 1_755_648_000)
    const [h, c, sig] = jwt.split('.')
    const verified = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(verified).toBe(true)
  })

  it('壊れた秘密鍵では署名段階で例外になる（saAccessToken は auth + 診断詳細へ変換して設定不備として扱う）', () => {
    expect(() => buildSaAssertion(
      { clientEmail: 'a@b', privateKey: 'not-a-pem', tokenUri: 'https://oauth2.googleapis.com/token' },
      SCOPE, 1_755_648_000,
    )).toThrow()
  })
})
