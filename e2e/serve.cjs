#!/usr/bin/env node
// 静的配信（SPA フォールバック付き）。usage: node serve.cjs <dir> <port>
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const [dir, port] = [process.argv[2], Number(process.argv[3] || 4174)]
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json',
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(dir, urlPath)
  if (file.endsWith('/')) file = path.join(file, 'index.html')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html')
    if (fs.existsSync(idx)) file = idx
    else {
      // SPA フォールバック（nuxt generate の 200.html → index.html）
      const fallback = ['200.html', 'index.html'].map(f => path.join(dir, f)).find(f => fs.existsSync(f))
      file = fallback || file
    }
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`serve ${dir} on :${port}`))
