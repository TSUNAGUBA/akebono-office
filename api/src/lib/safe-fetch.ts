/**
 * SSRF 対策付きの外部 HTTP 取得（データ取込 F-32 の API 接続 = 監査指摘 2026-07-30 ①）。
 * - https のみ許可（平文・他スキーム = file:// gopher:// 等を遮断）
 * - 名前解決を自前の lookup で行い、解決先アドレスがプライベート/ループバック/リンクローカル/
 *   メタデータ（169.254.169.254）等の内部レンジなら**接続前に**拒否する。
 *   接続にも同じ lookup を使うため、検証と接続で解決先が変わる DNS リバインディングを防ぐ
 * - リダイレクトは追わない（3xx はエラー = 内部への誘導を防ぐ）
 * - 応答サイズ上限・タイムアウト付き（メモリ・ハング保護）
 */
import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'

/** 内部・特殊レンジの判定（IPv4/IPv6）。取込先として許可しないアドレス */
export function isForbiddenAddress(addr: string): boolean {
  const ip = addr.toLowerCase()
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = [parts[0]!, parts[1]!]
    if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0/8, 10/8, 127/8
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 (CGN)
    if (a === 169 && b === 254) return true // リンクローカル + クラウドメタデータ
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 192 && b === 0 && parts[2] === 0) return true // 192.0.0/24
    if (a >= 224) return true // マルチキャスト・予約
    return false
  }
  // IPv6: ループバック・未指定・ULA・リンクローカル・v4 射影/変換（中身を再検査 or 遮断）
  if (ip === '::1' || ip === '::') return true
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true // fc00::/7
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true // fe80::/10
  if (ip.startsWith('64:ff9b:')) return true // NAT64（64:ff9b::/96 = v4 変換の迂回を遮断）
  if (ip.startsWith('2001:0:') || ip.startsWith('2001::')) return true // Teredo（2001::/32）
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) return isForbiddenAddress(v4[1]!)
  // v4 射影の 16 進表記（URL 正規化は ::ffff:127.0.0.1 を ::ffff:7f00:1 にする）も中身を再検査
  const v4hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v4hex) {
    const hi = parseInt(v4hex[1]!, 16)
    const lo = parseInt(v4hex[2]!, 16)
    return isForbiddenAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  return false
}

export interface SafeFetchResult {
  status: number
  body: Buffer
}

/**
 * ガード付き GET。失敗は Error を throw（メッセージは運用者向けの自己診断可能な内容）。
 * maxBytes 超過・タイムアウト・3xx・内部アドレスはすべて拒否
 */
export function safeFetch(
  rawUrl: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('エンドポイント URL の形式が不正です')
  }
  if (url.protocol !== 'https:') {
    throw new Error('エンドポイントは https:// のみ利用できます')
  }
  if (url.username || url.password) {
    throw new Error('URL 埋め込みの認証情報は利用できません（認証タイプの設定を使ってください）')
  }
  // IP 直指定は解決を待たずに検査する。IPv6 リテラルは URL.hostname が角括弧付き（"[::1]"）で
  // isIP が 0 を返し、かつ https.request は IP リテラルに lookup を呼ばないため、
  // 角括弧を剥がした素のアドレスで**接続前に**必ず判定する（レビュー M-1: IPv6 バイパスの遮断）
  const bareHost = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  if (isIP(bareHost) && isForbiddenAddress(bareHost)) {
    throw new Error('内部ネットワークのアドレスへは接続できません')
  }

  // 検証済みアドレスで**そのまま接続**する lookup（DNS リバインディング防止）
  const guardedLookup: typeof dnsLookup = ((hostname: string, options: unknown, cb: unknown) => {
    const callback = (typeof options === 'function' ? options : cb) as (
      err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number,
    ) => void
    const dnsOpts = typeof options === 'object' && options !== null ? options as Record<string, unknown> : {}
    dnsLookup(hostname, { ...dnsOpts, all: true }, (e, addresses) => {
      if (e) {
        callback(e, '')
        return
      }
      const list = addresses as { address: string; family: number }[]
      const bad = list.find(a => isForbiddenAddress(a.address))
      if (bad || list.length === 0) {
        const errBlocked: NodeJS.ErrnoException = new Error('内部ネットワークのアドレスへは接続できません')
        errBlocked.code = 'EBLOCKED'
        callback(errBlocked, '')
        return
      }
      if (dnsOpts.all) callback(null, list)
      else callback(null, list[0]!.address, list[0]!.family)
    })
  }) as typeof dnsLookup

  return new Promise<SafeFetchResult>((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: opts.headers,
      lookup: guardedLookup,
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        res.resume()
        reject(new Error(`リダイレクト（HTTP ${status}）は追跡しません。最終 URL を直接指定してください`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          req.destroy()
          reject(new Error(`応答が大きすぎます（${Math.round(maxBytes / 1024 / 1024)}MB 以下にしてください）`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy(new Error(`接続がタイムアウトしました（${Math.round(timeoutMs / 1000)} 秒）`))
    })
    req.on('error', reject)
    req.end()
  })
}
