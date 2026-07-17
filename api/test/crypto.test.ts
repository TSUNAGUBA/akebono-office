import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../src/lib/crypto'

describe('crypto（トークン暗号化保管）', () => {
  it('暗号化 → 復号のラウンドトリップ。毎回異なる暗号文（IV ランダム）', () => {
    const secret = 'test-encryption-key'
    const a = encryptSecret('ya29.token-value', secret)
    const b = encryptSecret('ya29.token-value', secret)
    expect(a).not.toBe(b)
    expect(decryptSecret(a, secret)).toBe('ya29.token-value')
    expect(decryptSecret(b, secret)).toBe('ya29.token-value')
  })

  it('鍵違い・改ざんは null（例外を投げない = 再連携で回復可能）', () => {
    const enc = encryptSecret('value', 'key-1')
    expect(decryptSecret(enc, 'key-2')).toBeNull()
    const tampered = enc.slice(0, -4) + 'AAAA'
    expect(decryptSecret(tampered, 'key-1')).toBeNull()
    expect(decryptSecret('not-base64!!', 'key-1')).toBeNull()
  })
})
