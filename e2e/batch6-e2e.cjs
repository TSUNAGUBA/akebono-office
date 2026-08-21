// 改修依頼 2026-08-21 第 3 弾（2 単位）のモックモード E2E。
// 単位1: 顧客基本情報の電話番号（表示・編集・AI 調査での取得 → 反映 → 取消 = 原則9.5）
//        モックの AI 調査は「調査ヒントに入れた電話番号が会社概要候補の抜粋へ載る → 構築が抽出する」
//        デモ経路（番号の創作はしない）を使う。
// 単位2: 改善要望の「AIで整形」（mock = ルールベース即時。RAG 参照は API + LLM 時のみ = refs 空）
// 既定ユーザー m-03 = 管理者（モックモード配信 :4173）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 改修依頼 2026-08-21 第 3 弾（顧客の電話番号 + AI整形）')

    // ---- 単位1: 基本情報の電話番号（シード表示 → 編集） ----
    await page.goto(`${BASE}/#/customer-context?company=c-01`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '顧客コンテキスト' }).waitFor()
    await page.getByText('基本情報', { exact: true }).first().waitFor()
    await page.getByText('03-0000-0100').first().waitFor()
    check('電話番号: シードの電話番号が基本情報に表示される', true)

    await page.getByRole('button', { name: /基本情報を編集/ }).click()
    const phoneInput = page.getByRole('dialog').getByLabel('電話番号', { exact: true })
    await phoneInput.waitFor()
    await phoneInput.fill('03-0000-0199')
    await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click()
    await page.getByText('基本情報を更新しました').first().waitFor()
    await page.getByText('03-0000-0199').first().waitFor()
    check('電話番号: 基本情報の編集モーダルで更新でき、保存後に表示へ反映される', true)

    // ---- 単位1: AI 調査で取得した電話番号を基本情報へ反映 → 取消 ----
    await page.getByRole('button', { name: 'AI の Web 調査で定性情報を更新' }).click()
    // 調査ヒントに電話番号を入力 → モック候補（会社概要）の抜粋に載る = 創作なしのデモ経路
    await page.getByLabel('電話番号ヒント').fill('03-5555-0123')
    await page.getByRole('button', { name: /調査開始/ }).click()
    await page.getByRole('checkbox', { name: /会社概要・アクセス/ }).waitFor()
    await page.getByRole('checkbox', { name: /会社概要・アクセス/ }).check()
    await page.getByRole('button', { name: /採用した情報で構築/ }).click()
    await page.getByText('電話番号（基本情報）（現在）').waitFor()
    check('AI 調査: 差分確認に「電話番号（基本情報）」行（現在/提案）が出る', true)
    check('AI 調査: 提案値にヒント経由で取得した電話番号が出る（創作ではなく抜粋から抽出）',
      (await page.getByText('03-5555-0123').count()) >= 1)
    await page.getByRole('button', { name: '反映', exact: true }).click()
    await page.getByText('AI リサーチの内容を反映しました', { exact: false }).first().waitFor()
    await page.getByText('03-5555-0123').first().waitFor()
    check('AI 調査: 反映すると基本情報の電話番号が更新される', true)

    // 取消（原則9.5）: 反映直後のバナー → 確認ダイアログ → 電話番号も反映前へ戻る
    await page.getByRole('button', { name: '反映を取り消す' }).first().click()
    await page.getByRole('dialog', { name: '反映の取消' }).getByRole('button', { name: '反映を取り消す' }).click()
    await page.getByText('反映を取り消し、反映前の内容へ戻しました').first().waitFor()
    await page.getByText('03-0000-0199').first().waitFor()
    check('AI 調査: 反映の取消で基本情報の電話番号も反映前へ戻る（原則9.5）',
      (await page.getByText('03-5555-0123').count()) === 0)

    // ---- 単位1: 顧客(会社)マスタ画面にも電話番号が出る ----
    await page.goto(`${BASE}/#/masters/customers`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    await page.getByText('アケボノ商事').first().click()
    await page.getByText('電話番号', { exact: true }).first().waitFor()
    check('マスタ: 顧客(会社)マスタの詳細にも電話番号が表示される', true)

    // ---- 単位2: 改善要望の「AIで整形」（mock = ルールベース。トーストのフィードバック） ----
    await page.goto(`${BASE}/#/improvements`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    await page.getByRole('button', { name: 'このページの改善要望を送る' }).click()
    await page.getByRole('heading', { name: '要望を送る' }).waitFor()
    const body = page.getByLabel('要望の内容')
    await body.fill('要望: 一覧を見やすくしたい\n現状：ごちゃごちゃ\n・強調がない\n・空行が    多い')
    await page.getByRole('button', { name: '本文を AI で整形' }).click()
    await page.getByText(/AIで整形しました/).first().waitFor()
    check('AI整形: 整形が実行されトーストのフィードバックが出る（mock = ルールベース）', true)
    check('AI整形: 節ラベル・箇条書きが整形される',
      ((await body.inputValue()).includes('要望：一覧を見やすくしたい')) && ((await body.inputValue()).includes('- 強調がない')))
    await page.getByRole('button', { name: 'AI 整形前のテキストに戻す' }).click()
    await page.getByText('整形前に戻しました').first().waitFor()
    check('AI整形: 「整形前に戻す」で取り消せる（原則9.5）', true)

    // ---- モバイル 375px: 基本情報（電話番号行）で横スクロールが出ない ----
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${BASE}/#/customer-context?company=c-01`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    await page.getByText('基本情報', { exact: true }).first().waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check('モバイル375px: 顧客コンテキスト（電話番号行あり）で横スクロールが出ない', overflow <= 1)
  })
  summary('batch6-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
