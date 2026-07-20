// チームタブ表示メンバー設定の E2E（バッチ7k + オペレーター報告 2026-07-20 の回帰）。
// 前提: run-batch6b-stack.sh のスタック（API :8788・dev 認証 m-e2e=admin・静的配信 = BASE）
// - 取締役・外注を候補から選択 → 保存 → マトリクス反映・リロード維持
// - モバイルビューポートで候補リストが上方向に開き画面内で選択できる（ボトムシートのクリッピング回帰）
const { chromium } = require('playwright')
const { check, withPage, summary, CHROMIUM_PATH } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'
const API = 'http://127.0.0.1:8788'
const RUN = Date.now().toString(36).slice(-4)

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-dev-member-id': 'm-e2e', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function main() {
  console.log('suite: チームタブ表示メンバー（取締役・外注の有効化）')
  const mk = (name, employmentType) => api('POST', '/v1/masters/members', {
    name, email: `${name}-${RUN}@example.com`, employmentType,
    departmentId: '', title: '', role: 'member', weeklyDays: 5, weeklyHours: 40, punchRequired: true,
  })
  for (const [name, type] of [
    [`社員一郎${RUN}`, 'employee'], [`社員二郎${RUN}`, 'contract'],
    [`取締役太郎${RUN}`, 'director'], [`外注花子${RUN}`, 'outsource'],
  ]) {
    const r = await mk(name, type)
    if (r.status !== 201) throw new Error(`メンバー作成に失敗: ${name} HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
  }
  const cfg = await api('PUT', '/v1/configs/teamVisibleMemberIds', { value: '' })
  if (cfg.status !== 200) throw new Error(`設定リセットに失敗: HTTP ${cfg.status}`)

  // ---------- デスクトップ: 候補選択 → 保存 → 反映 ----------
  await withPage(async (page) => {
    await page.goto(`${BASE}/#/reports`)
    await page.getByRole('tab', { name: 'チーム' }).click()
    await page.waitForTimeout(1500)
    check('既定: 社員がマトリクスに表示される', await page.getByText(`社員一郎${RUN}`).first().isVisible().catch(() => false))
    check('既定: 取締役はマトリクスに出ない', !(await page.getByText(`取締役太郎${RUN}`).first().isVisible().catch(() => false)))

    await page.getByRole('button', { name: /表示メンバー/ }).click()
    const combo = page.getByRole('combobox', { name: '表示メンバーを選択' })
    await combo.fill(`取締役太郎${RUN}`)
    await page.waitForTimeout(300)
    const dirOpt = page.getByRole('option', { name: new RegExp(`取締役太郎${RUN}`) })
    check('候補に取締役が出る（雇用区分バッジ付き）', await dirOpt.first().isVisible().catch(() => false))
    await dirOpt.first().click()
    await combo.fill(`外注花子${RUN}`)
    await page.waitForTimeout(300)
    await page.getByRole('option', { name: new RegExp(`外注花子${RUN}`) }).first().click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForTimeout(1200)

    check('保存後: 取締役がマトリクスに表示される', await page.getByText(`取締役太郎${RUN}`).first().isVisible().catch(() => false))
    check('保存後: 外注がマトリクスに表示される', await page.getByText(`外注花子${RUN}`).first().isVisible().catch(() => false))
    check('保存後: 未選択の社員はマトリクスから消える',
      !(await page.locator('table').getByText(`社員二郎${RUN}`).first().isVisible().catch(() => false)))

    await page.reload()
    await page.getByRole('tab', { name: 'チーム' }).click()
    await page.waitForTimeout(1500)
    check('リロード後も取締役が表示される', await page.getByText(`取締役太郎${RUN}`).first().isVisible().catch(() => false))
  })

  // ---------- モバイル: 候補リストが上方向に開き画面内で操作できる ----------
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  try {
    await api('PUT', '/v1/configs/teamVisibleMemberIds', { value: '' })
    await page.goto(`${BASE}/#/reports`)
    await page.getByRole('tab', { name: 'チーム' }).click()
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: /表示メンバー/ }).click()
    const combo = page.getByRole('combobox', { name: '表示メンバーを選択' })
    await combo.click()
    await page.waitForTimeout(500)
    const optBox = await page.getByRole('option').first().boundingBox()
    const comboBox = await combo.boundingBox()
    check('モバイル: 候補リストが入力欄の上に開く（ボトムシートで隠れない）',
      Boolean(optBox && comboBox && optBox.y + optBox.height <= comboBox.y + 4))
    check('モバイル: 候補がビューポート内に収まる',
      Boolean(optBox && optBox.y >= 0 && optBox.y + optBox.height <= 844))
    // 先頭候補が実際に「見えて押せる」こと（boundingBox だけではクリップ・重なりを検出できない。
    // PR #63 R1 ニット4: elementFromPoint で最前面が候補リスト内の要素であることを確認）
    const firstVisible = Boolean(optBox) && await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return Boolean(el && el.closest('[role="listbox"]'))
    }, [optBox.x + optBox.width / 2, optBox.y + Math.min(16, optBox.height / 2)])
    check('モバイル: 先頭候補が実可視（クリップ・重なりなし）', firstVisible)
    await combo.fill(`取締役太郎${RUN}`)
    await page.waitForTimeout(300)
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForTimeout(1200)
    check('モバイル: 保存後に取締役がマトリクスへ反映される',
      await page.getByText(new RegExp(`取締役太郎${RUN}`)).first().isVisible().catch(() => false))
  } finally {
    await browser.close()
    await api('PUT', '/v1/configs/teamVisibleMemberIds', { value: '' })
  }

  summary('team-visibility-e2e')
}

main().catch((e) => { console.error(e); process.exit(1) })
