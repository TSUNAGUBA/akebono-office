/**
 * truncate 破れの網羅検出（UnitI 2026-08-20 で新設した常設回帰ハーネス。CI 非組込・UI 改修時に手動実行）。
 * nowrap 要素（truncate 文・バッジ・ボタン）が祖先カード（overflow-hidden）境界を超えて
 * ぶつ切りされている箇所 = grid/flex item の min-width:auto 連鎖で ellipsis が死ぬ型を検出する。
 * この型は scrollWidth に現れないため probe-ui-sweep.cjs では検出できない（CONVENTIONS「スタイル規約」参照）。
 * 検出ありは exit 1。
 * 使い方: node probe-truncate-break.cjs <baseUrl> <routesJson> [label]
 *   例: node probe-truncate-break.cjs http://127.0.0.1:4173 ui-sweep-routes/home.json home
 */
const fs = require('fs')
const { chromium } = require('playwright')
const { CHROMIUM_PATH } = require('./lib.cjs')

const [, , baseUrl, routesJson, label] = process.argv
if (!baseUrl || !routesJson) {
  console.error('usage: node probe-truncate-break.cjs <baseUrl> <routesJson> [label]')
  process.exit(2)
}
let routes
try {
  routes = JSON.parse(fs.readFileSync(routesJson, 'utf8'))
} catch (e) {
  console.error(`routesJson を読めません: ${e.message}`)
  process.exit(2)
}

const detect = () => {
  const vw = document.documentElement.clientWidth
  const hits = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.whiteSpace !== 'nowrap') continue
    if (el.closest('[role="tablist"]')) continue // タブ列は内部スクロール設計
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    // 祖先の overflow-x が hidden/auto/clip な要素（カード等）の右端を限界とする
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
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH })
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
  await browser.close()
  if (total > 0) {
    console.log(`\nFINDINGS: ${total}`)
    process.exit(1)
  }
  console.log('\nCLEAN')
})()
