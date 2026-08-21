// 改修依頼 2026-08-21 第 2 弾（4 単位）のモックモード E2E。
// 単位1: 顧客コンテキストの AI 調査候補リンクを新規タブで開ける（target=_blank）
// 単位2: 通知バッジの未読合計（ヘッダーベル + /inbox「すべて」タブ）の回帰固定
//        （2026-08-18 実装済みを確認 = 本ラウンドでは回帰テストとして固定）
// 単位3: 会社検索リスト（コンボボックス）がカード下端でクリップされない（overflow-visible）
// 単位4: 定性情報の「事業メモ」（表示・編集・AI 構築の差分行）
// 既定ユーザー m-03 = 管理者（モックモード配信 :4173）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 改修依頼 2026-08-21 第 2 弾（顧客コンテキスト + 通知バッジ回帰）')

    // ---- 単位2: 通知バッジの未読合計（回帰固定） ----
    await page.goto(`${BASE}/#/inbox`)
    await page.getByRole('tab', { name: /^すべて/ }).waitFor()
    const allTabText = (await page.getByRole('tab', { name: /^すべて/ }).textContent() ?? '').trim()
    check('通知: 「すべて」タブに未読合計バッジが出る', /すべて\s*\d+/.test(allTabText))
    const bellAria = await page.getByRole('link', { name: /^通知/ }).first().getAttribute('aria-label')
    check('通知: ヘッダーの通知ベルに未読合計バッジが出る（aria-label に件数）', /未読 \d+ 件/.test(bellAria ?? ''))

    // ---- 顧客コンテキストを開いて会社を検索・選択（単位3: 候補リストがクリップされない） ----
    await page.goto(`${BASE}/#/customer-context`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '顧客コンテキスト' }).waitFor()
    const combo = page.getByRole('combobox', { name: '対象の顧客(会社)' })
    await combo.click()
    await combo.fill('アケボノ')
    // 候補リストはカードの下端を越えて表示される。クリップ（overflow-hidden）されていると
    // Playwright の可視性・アクション判定で click が失敗する = ここが単位3 の回帰チェック
    const opt = page.getByRole('option', { name: /アケボノ商事/ }).first()
    await opt.waitFor()
    const cardBox = await page.getByRole('combobox', { name: '対象の顧客(会社)' }).boundingBox()
    const optBox = await opt.boundingBox()
    check('会社検索: 候補リストが入力欄の下（カード枠外方向）に表示される',
      !!cardBox && !!optBox && optBox.y > cardBox.y)
    await opt.click()
    check('会社検索: 候補をクリックして選択できる（隠れていない）', true)

    // ---- 単位4: 事業メモの表示（シード）→ 編集・保存 ----
    await page.getByText('定性情報', { exact: true }).first().waitFor()
    await page.getByText('・昨季売上高: 240 億円（デモ）').first().waitFor()
    check('事業メモ: シードの事業メモ（売上高・従業員数等）が定性情報に表示される', true)
    await page.getByRole('button', { name: '定性情報を編集' }).click()
    const bizArea = page.getByLabel('事業メモ')
    await bizArea.waitFor()
    await bizArea.fill('・昨季売上高: 250 億円（E2E 更新）\n・配送センター: 自社 3 拠点')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByText('定性情報を更新しました').first().waitFor()
    await page.getByText('・昨季売上高: 250 億円（E2E 更新）').first().waitFor()
    check('事業メモ: 編集フォームで更新でき、保存後に表示へ反映される', true)

    // ---- 単位1: AI 調査の候補リンクが新規タブで開ける（target=_blank + rel） ----
    await page.getByRole('button', { name: 'AI の Web 調査で定性情報を更新' }).click()
    await page.getByRole('button', { name: /調査開始/ }).click()
    await page.getByRole('checkbox').first().waitFor()
    const links = page.locator('a[aria-label$="を新規タブで開く"]')
    const linkCount = await links.count()
    check('AI 調査: 候補ごとにリンク先を新規タブで開くリンクがある', linkCount >= 3)
    check('AI 調査: リンクは target=_blank + rel=noopener noreferrer',
      await links.first().getAttribute('target') === '_blank'
      && ((await links.first().getAttribute('rel')) ?? '').includes('noopener'))
    // リンクを実クリックして新規タブ（popup）を受け、採用チェックがトグルされないこと（@click.stop）を検証
    // （現在のページは遷移せず、件数表示が 0 件のまま）
    await page.getByText('（0件選択中）').waitFor()
    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      links.first().click(),
    ])
    await popup.close()
    check('AI 調査: リンクをクリックしても採用チェックはトグルされず元ページに留まる（@click.stop + 新規タブ）',
      (await page.getByText('（0件選択中）').count()) === 1)
    // 採用 → 構築 → 差分確認に「事業メモ」行が出る（単位4 の AI 反映経路）
    await page.getByRole('checkbox').first().check()
    await page.getByRole('button', { name: /採用した情報で構築/ }).click()
    await page.getByText('事業メモ（現在）').waitFor()
    check('AI 調査: 差分確認に「事業メモ」行（現在/提案）が出る',
      (await page.getByText(/事業メモ（提案）/).count()) >= 1)
    // 反映せずに閉じる（デモデータを汚さない）。閉じるボタンはヘッダー/フッターで複数あるため
    // ダイアログ内の最後（フッター）に限定する（strict mode 対策 = batch4 と同じ知見）
    const researchDialog = page.getByRole('dialog', { name: /AI で調査/ })
    await researchDialog.getByRole('button', { name: '閉じる', exact: true }).last().click()
    await researchDialog.waitFor({ state: 'hidden' })

    // ---- モバイル 375px: 顧客コンテキストで横スクロールが出ない ----
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${BASE}/#/customer-context?company=c-01`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    await page.getByText('定性情報', { exact: true }).first().waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check('モバイル375px: 顧客コンテキストでページ全体の横スクロールが出ない', overflow <= 1)
  })
  summary('batch5-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
