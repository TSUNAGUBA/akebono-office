/**
 * UI 網羅検査プローブ（UnitI・2026-08-20。使い捨て = レビュー対象外）。
 * 全ページを 375px / 1366px で開き、横スクロール（scrollWidth > clientWidth）と
 * ビューポートをはみ出す要素を機械検出し、375px のスクリーンショットを保存する。
 * 使い方: node probe-ui-sweep.cjs <baseUrl> <outDir> <routesJson>
 */
const { chromium } = require('playwright')
const fs = require('fs')

const [, , baseUrl, outDir, routesJson] = process.argv
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
  return {
    vw, overflowPx,
    offenders: offenders.map((o) => {
      const el = o.el
      const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 6).join('.')
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} right=${o.right} left=${o.left} w=${o.w}`
    }),
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const results = []
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
        entry[`${label}_url`] = page.url()
        if (label === 'm' || info.overflowPx > 1) {
          await page.screenshot({ path: `${outDir}/${slug}--${label}.png`, fullPage: label === 'm' })
        }
      } catch (e) {
        entry[label] = { error: String(e).slice(0, 120) }
      }
      await page.close()
    }
    results.push(entry)
    const m = entry.m || {}
    const d = entry.d || {}
    console.log(`${route}\tm:${m.error ? 'ERR' : m.overflowPx}\td:${d.error ? 'ERR' : d.overflowPx}`)
  }
  fs.writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 1))
  await browser.close()
})()
