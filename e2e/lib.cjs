// E2E 共通ヘルパー（playwright。chromium は CHROMIUM_PATH > /opt/pw-browsers/chromium > playwright 既定の順で解決）
const fs = require('fs')
const { chromium } = require('playwright')

const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

let passed = 0
let failed = 0
const failures = []

function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}`)
  }
}

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  try {
    await fn(page, context)
  } finally {
    await browser.close()
  }
}

function summary(suite) {
  console.log(`\n${suite}: ${passed} passed / ${failed} failed`)
  if (failed > 0) {
    console.log(failures.map(f => `  FAILED: ${f}`).join('\n'))
    process.exit(1)
  }
}

module.exports = { check, withPage, summary }
