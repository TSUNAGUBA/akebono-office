/**
 * SSRF ガード（lib/safe-fetch）の単体テスト。
 * アドレス判定（isForbiddenAddress）と、接続前に同期的に拒否される経路
 * （スキーム・URL 認証情報・IP リテラル = IPv4/IPv6 の両ファミリ）を検証する。
 * レビュー M-1: IPv6 リテラル（[::1] 等）は URL.hostname が角括弧付き + https.request が
 * lookup を呼ばないためバイパスし得た = 回帰テストで固定する。
 */
import { describe, expect, it } from 'vitest'
import { isForbiddenAddress, safeFetch } from '../../src/lib/safe-fetch'

describe('isForbiddenAddress（内部・特殊レンジ判定）', () => {
  it('IPv4 の内部レンジを遮断する', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true)
    }
  })
  it('公開 IPv4 は許可する', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false)
    }
  })
  it('IPv6 のループバック・ULA・リンクローカル・v4 射影・NAT64 を遮断する', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1',
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true)
    }
  })
  it('公開 IPv6 は許可する', () => {
    expect(isForbiddenAddress('2606:4700:4700::1111')).toBe(false)
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('safeFetch（接続前の同期拒否）', () => {
  it('https 以外・URL 埋め込み認証情報を拒否する', () => {
    expect(() => safeFetch('http://example.com/feed')).toThrow('https')
    expect(() => safeFetch('file:///etc/passwd')).toThrow('https')
    expect(() => safeFetch('https://user:pass@example.com/')).toThrow('認証情報')
    expect(() => safeFetch('not a url')).toThrow('URL')
  })
  it('IPv4 リテラルの内部アドレスを接続前に拒否する', () => {
    expect(() => safeFetch('https://127.0.0.1/feed')).toThrow('内部ネットワーク')
    expect(() => safeFetch('https://169.254.169.254/computeMetadata/v1/')).toThrow('内部ネットワーク')
  })
  it('IPv6 リテラル（角括弧付き）の内部アドレスも接続前に拒否する（レビュー M-1 回帰）', () => {
    expect(() => safeFetch('https://[::1]/feed')).toThrow('内部ネットワーク')
    expect(() => safeFetch('https://[fd00::1]/feed')).toThrow('内部ネットワーク')
    expect(() => safeFetch('https://[::ffff:127.0.0.1]/feed')).toThrow('内部ネットワーク')
    expect(() => safeFetch('https://[fe80::1]/feed')).toThrow('内部ネットワーク')
  })
})
