/**
 * トークンの暗号化保管（AES-256-GCM）。Google OAuth トークン等を DB へ平文で置かないための封筒暗号。
 * 鍵は TOKEN_ENCRYPTION_KEY（任意長の文字列）を SHA-256 で 32 バイト化して使用する。
 * 形式: base64(iv[12] + authTag[16] + ciphertext)。復号失敗は null（再連携で回復可能 = 致命にしない）
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function keyOf(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decryptSecret(encoded: string, secret: string): string | null {
  try {
    const buf = Buffer.from(encoded, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
