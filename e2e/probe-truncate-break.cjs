/**
 * truncate 破れの網羅検出（UnitI）。nowrap/truncate 要素が祖先カード境界を超えて
 * はみ出している箇所（min-width:auto 連鎖で ellipsis が死に overflow-hidden でぶつ切りされる型）を検出。
 * 使い方: node probe-truncate-break.cjs <baseUrl> <routesJson> [label]
 */
const { chromium } = require('playwright')
const fs = require('fs')
const [, , baseUrl, routesJson, label] = process.argv
const routes = JSON.parse(fs.readFileSync(routesJson, 'utf8'))

const detect = () => {
  const vw = document.documentElement.clientWidth
  const hits = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.whiteSpace !== 'nowrap') continue
    if (el.closest('[role="tablist"]')) continue // タブ列は内部スクロール設計
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    // 祖先の overflow-x が hidden/auto な要素（カード等）の右端
    let clip = null
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a)
      if (acs.overflowX === 'hidden' || acs.overflowX === 'auto' || acs.overflowX === 'clip') { clip = a; break }
    }
    const limit = clip ? clip.getBoundingClientRect().right : vw
    const scrollable = clip && getComputedStyle(clip).overflowX === 'auto'
    if (scrollable) continue // 意図的な横スクロールコンテナ内は対象外
    if (r.right > limit + 2) {
      if (hits.some(h => h.el.contains(el) || el.contains(h.el))) continue
      hits.push({ el, over: Math.round(r.right - limit), text: (el.textContent || '').trim().slice(0, 40) })
      if (hits.length >= 6) break
    }
  }
  return hits.map(h => `+${h.over}px "${h.text}" <${h.el.tagName.toLowerCase()} class="${(typeof h.el.className === 'string' ? h.el.className : '').slice(0, 70)}">`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await browser.newPage({ viewport: { width: 375, height: 740 } })
  let total = 0
  for (const route of routes) {
    await page.goto(`${baseUrl}/#${route}`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(800)
    const hits = await page.evaluate(detect)
    if (hits.length > 0) {
      total += hits.length
      console.log(`\n[${label || ''}${route}]`)
      hits.forEach(h => console.log('  ', h))
    }
  }
  console.log(`\nTOTAL: ${total}`)
  await browser.close()
})()
