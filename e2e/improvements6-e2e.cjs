// 改修依頼「6 改善」のモックモード E2E（改修依頼 2026-08-20）。
// 1) 改善のタネ: ヘッダーの「改善のタネ」押下で遷移せずモーダルが開き投稿できる
// 2) 改善要望フォーム: 本文と画像添付ツールバーが重ならない（ツールバーがテキストエリアの外にある）
// 3) 対象ページ: オートコンプリート（手入力検索）で選べる
// 4) 営業活動: 登録ボタンで実際に登録される
// 5) ヘッダー: 通知アイコンにメニュー名（通知）が併記される
// 6) 改善要望タグ: お任せ/壁打ちが二者択一（トグル）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page, context) => {
    console.log('suite: 6 改善（改修依頼 2026-08-20）')

    // ---- 前提: ヘッダーにクイックアクセス「改善のタネ」を出すため localStorage を設定してから読み込む ----
    await page.goto(`${BASE}/`)
    await page.evaluate(() => {
      localStorage.setItem('ako.header-quick-access.v1', JSON.stringify({ v: 2, ids: ['timecard', 'inbox', 'poipoi'] }))
    })
    await page.goto(`${BASE}/#/improvements`)
    await page.waitForLoadState('networkidle')

    // ---- 5) ヘッダー: 通知にラベル併記 ----
    // 通知ベル（/inbox リンク）にテキスト「通知」が含まれる
    const bell = page.locator('header a[href*="inbox"]').first()
    await bell.waitFor()
    const bellText = (await bell.innerText()).trim()
    check('5 ヘッダー: 通知アイコンにメニュー名「通知」が併記される', bellText.includes('通知'))

    // ---- 1) 改善のタネ: ヘッダーボタン押下で遷移せずモーダル ----
    const beforeUrl = page.url()
    await page.getByRole('button', { name: '改善のタネを投げ込む' }).click()
    await page.getByRole('heading', { name: 'タネを投げ込む' }).waitFor()
    check('1 改善のタネ: ヘッダー押下で遷移せずモーダルが開く', page.url() === beforeUrl)
    // 投稿できる
    await page.getByLabel('タネ本文').fill('E2E: 改善のタネ投稿テスト')
    await page.getByRole('button', { name: '投げ込む', exact: true }).click()
    await page.getByRole('heading', { name: '投げ込みました' }).waitFor()
    check('1 改善のタネ: モーダルから投稿でき、取消導線が出る', await page.getByRole('button', { name: '取り消す' }).isVisible())
    await page.locator('button.btn-primary', { hasText: '閉じる' }).click()

    // ---- 改善要望フォームを開く（ヘッダーの「要望」ボタン） ----
    await page.getByRole('button', { name: 'このページの改善要望を送る' }).click()
    await page.getByRole('heading', { name: '要望を送る' }).waitFor()

    // ---- 6) タグ: お任せ/壁打ちが二者択一（radiogroup。片方選択で他方が外れる） ----
    const tagGroup = page.getByRole('radiogroup', { name: '要望のタグ' })
    await tagGroup.waitFor()
    const entrust = tagGroup.getByRole('radio', { name: 'お任せ' })
    const brainstorm = tagGroup.getByRole('radio', { name: '壁打ち' })
    const entrustChecked = await entrust.getAttribute('aria-checked')
    check('6 タグ: 既定は「お任せ」が選択', entrustChecked === 'true')
    await brainstorm.click()
    const afterB = await brainstorm.getAttribute('aria-checked')
    const afterE = await entrust.getAttribute('aria-checked')
    check('6 タグ: 壁打ちを選ぶとお任せが自動で外れる（二者択一）', afterB === 'true' && afterE === 'false')

    // ---- 3) 対象ページ: オートコンプリート（combobox・手入力検索） ----
    const combo = page.getByRole('combobox', { name: '要望の対象ページ' })
    await combo.waitFor()
    check('3 対象ページ: オートコンプリート入力欄（combobox）になっている', await combo.isVisible())
    await combo.click()
    await combo.fill('営業活動')
    // 候補リストに「営業活動」を含む option が出る
    const opt = page.getByRole('option', { name: /営業活動/ }).first()
    await opt.waitFor()
    await opt.click()
    const comboVal = await combo.inputValue()
    check('3 対象ページ: 手入力検索で候補を選べる', comboVal.includes('営業活動'))

    // ---- 2) 本文＋画像ツールバーが重ならない（ツールバーはテキストエリアの外・下） ----
    // 本文テキストエリアの下端 <= 画像ボタンの上端（重なりなし）を幾何で確認
    const ta = page.getByLabel('要望の内容')
    const imgBtn = page.getByRole('button', { name: '画像を添付' })
    const taBox = await ta.boundingBox()
    const btnBox = await imgBtn.boundingBox()
    check('2 本文と画像添付ボタンが重ならない（ボタンがテキストエリアの下にある）',
      !!taBox && !!btnBox && btnBox.y >= taBox.y + taBox.height - 1)
    // 閉じる
    await page.keyboard.press('Escape')

    // ---- 4) 営業活動: 登録ボタンで登録される（案件ヘッダー + 活動ログ構造 = 改修依頼 2026-08-20 に追随） ----
    await page.goto(`${BASE}/#/sales-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '営業活動' }).waitFor()
    await page.getByRole('button', { name: '案件を登録' }).click()
    await page.getByRole('heading', { name: '営業活動（案件）を登録' }).waitFor()
    await page.getByLabel('商談名', { exact: true }).fill('E2E 営業商談テスト')
    // 顧客（会社）は combobox。既存のシード会社を検索して選ぶ
    const cust = page.getByLabel('顧客（会社）')
    await cust.click()
    // UiCombobox の候補は role="listbox" 内の role="option"（ネイティブ select の option を拾わないよう listbox に限定）
    const custOpt = page.getByRole('listbox').getByRole('option').first()
    await custOpt.waitFor()
    await custOpt.click()
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByText('営業活動（案件）を登録しました').waitFor()
    check('4 営業活動: 登録ボタンで登録され、トーストが出る', true)
    // 登録後は案件詳細ページへ遷移し、登録した商談名がヘッダーに出る
    await page.getByText('E2E 営業商談テスト').first().waitFor()
    check('4 営業活動: 登録した案件が詳細ページに反映される', true)

    // ---- モバイル幅 375px で主要ページが崩れない（横スクロール無し） ----
    await context.clearCookies()
    const mobile = await context.newPage()
    mobile.setDefaultTimeout(15000)
    for (const [path, heading] of [['/#/improvements', '改善要望'], ['/#/sales-activity', '営業活動']]) {
      await mobile.setViewportSize({ width: 375, height: 720 })
      await mobile.goto(`${BASE}${path}`)
      await mobile.getByRole('main').getByRole('heading', { level: 1, name: heading }).waitFor()
      const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      check(`モバイル375px: ${heading} が横方向にはみ出さない`, !overflow)
    }
    await mobile.close()
  })
  summary('6 改善 E2E')
}

main().catch((e) => { console.error(e); process.exit(1) })
