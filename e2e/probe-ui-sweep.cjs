/**
 * UI 網羅検査プローブ（UnitI 2026-08-20 で新設した常設回帰ハーネス。CI 非組込・UI 改修時に手動実行）。
 * 全ルートを 375px / 1366px で開き、①横スクロール（scrollWidth 超過）とはみ出し要素
 * ②エラーページ（500 / Internal Server Error の描画）を機械検出し、375px のフルページ
 * スクリーンショットを保存する。検出ありは exit 1（truncate ぶつ切り型は scrollWidth に
 * 現れないため、姉妹プローブ probe-truncate-break.cjs も合わせて実行すること）。
 * 使い方: node probe-ui-sweep.cjs <baseUrl> <outDir> <routesJson>
 *   例: node probe-ui-sweep.cjs http://127.0.0.1:4173 /tmp/sweep-home ui-sweep-routes/home.json
 *   （配信: 対象アプリを npm run generate 後、python3 -m http.server <port> -d .output/public）
 */
const fs = require('fs')
const { chromium } = require('playwright')
const { CHROMIUM_PATH } = require('./lib.cjs')

const [, , baseUrl, outDir, routesJson] = process.argv
if (!baseUrl || !outDir || !routesJson) {
  console.error('usage: node probe-ui-sweep.cjs <baseUrl> <outDir> <routesJson>')
  process.exit(2)
}
const routes = JSON.parse(fs.readFileSync(routesJson, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

const overflowInfo = () => {
  const doc = document.documentElement
  const vw = doc.clientWidth
  const overflowPx = doc.scrollWidth - vw
  const offenders = []
  if (overflowPx > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        // 祖先が既に記録済みならスキップ（最外殻のはみ出し元だけ拾う）
        if (offenders.some(o => o.el.contains(el))) continue
        offenders.push({ el, right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width) })
      }
      if (offenders.length >= 8) break
    }
  }
  const bodyHead = (document.body.innerText || '').trim().slice(0, 120)
  const errorPage = /^\s*(500|404)\b|Internal Server Error/.test(bodyHead)
  return {
    vw, overflowPx, errorPage, bodyHead: errorPage ? bodyHead : undefined,
    offenders: offenders.map((o) => {
      const el = o.el
      const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 6).join('.')
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} right=${o.right} left=${o.left} w=${o.w}`
    }),
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH })
  const results = []
  let findings = 0
  for (const route of routes) {
    const slug = route.replace(/^\//, '').replace(/[/?=&]/g, '_') || 'index'
    const entry = { route }
    for (const [label, vp] of [['m', { width: 375, height: 740 }], ['d', { width: 1366, height: 768 }]]) {
      const page = await browser.newPage({ viewport: vp })
      try {
        await page.goto(`${baseUrl}/#${route}`, { waitUntil: 'networkidle', timeout: 20000 })
        await page.waitForTimeout(900)
        const info = await page.evaluate(overflowInfo)
        entry[label] = info
        if (info.overflowPx > 1 || info.errorPage) findings++
        if (label === 'm' || info.overflowPx > 1) {
          await page.screenshot({ path: `${outDir}/${slug}--${label}.png`, fullPage: label === 'm' })
        }
      } catch (e) {
        entry[label] = { error: String(e).slice(0, 120) }
        findings++
      }
      await page.close()
    }
    results.push(entry)
    const fmt = i => (i.error ? 'ERR' : i.errorPage ? `PAGE_ERROR(${i.bodyHead})` : i.overflowPx)
    console.log(`${route}\tm:${fmt(entry.m)}\td:${fmt(entry.d)}`)
  }
  fs.writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 1))
  await browser.close()
  if (findings > 0) {
    console.log(`\nFINDINGS: ${findings}`)
    process.exit(1)
  }
  console.log('\nCLEAN')
})()
