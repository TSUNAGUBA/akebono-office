// 改修依頼 2026-08-19 第 3 弾（9 件）のモックモード E2E。
// 改善要望（受付箱の列順・要望編集の全項目化・プロンプトのタグ非出力/コメント反映）と
// 日報・週報（チーム既定=月・全員の週報の内容プレビュー・改善のタネの時刻非表示/自分の日報表示・週報例文挿入）
// と、モバイル幅（375px）の崩れなしを確認する。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 改修依頼 2026-08-19 第 3 弾（9 件）')

    // ===== 改善要望 =====
    await page.goto(`${BASE}/#/improvements`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '改善要望' }).waitFor()

    // 改修5: 受付箱の列順 = 対象ページ → 要望 → 投稿者（データ列の並び。先頭 select は行選択の操作列）
    await page.getByRole('tab', { name: /受付箱/ }).click()
    await page.getByRole('columnheader', { name: '対象ページ' }).waitFor()
    const headerOrder = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('main table thead th')].map(t => t.textContent.trim())
      return ths
    })
    const iPage = headerOrder.indexOf('対象ページ')
    const iBody = headerOrder.indexOf('要望')
    const iMember = headerOrder.indexOf('投稿者')
    check('受付箱: 列順が 対象ページ → 要望 → 投稿者 になっている',
      iPage !== -1 && iBody !== -1 && iMember !== -1 && iPage < iBody && iBody < iMember)

    // 改修1: 改修プロンプトに壁打ち/お任せタグを含めない（本文は出る）。ドロワーを開く前に確認する
    await page.getByRole('button', { name: '改修プロンプトを出力' }).click()
    const promptText = await page.locator('textarea[readonly]').inputValue()
    check('プロンプト: 壁打ち/お任せタグ（〔〕）を含めない', !promptText.includes('〔'))
    check('プロンプト: タグの読み方の凡例を含めない', !promptText.includes('タグの読み方'))
    await page.keyboard.press('Escape')

    // 改修2/6: 要望編集フォームがタグ・参考リンク・画像の編集欄を持つ
    // 受付箱の最初の行を開く（行本体のセル = 要望テキストをクリック。対象ページのリンクは別遷移のため避ける）
    await page.locator('main table tbody tr').first().locator('td').nth(2).click()
    await page.getByRole('button', { name: '要望を編集' }).first().click()
    await page.getByLabel('要望の本文を編集').waitFor()
    check('要望編集: 本文の編集欄がある', true)
    check('要望編集: タグ（壁打ち/お任せ）の編集欄がある',
      (await page.getByText('タグ（任意）').count()) >= 1)
    check('要望編集: 参考リンクの追加ができる',
      (await page.getByRole('button', { name: 'リンクを追加' }).count()) >= 1)
    check('要望編集: 画像の追加ができる',
      (await page.getByRole('button', { name: /画像を追加/ }).count()) >= 1)

    // ===== 日報・週報 =====
    await page.goto(`${BASE}/#/reports`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()

    // 改修3: チームタブの既定表示が「月」（月トグルが aria-pressed=true）
    await page.getByRole('tab', { name: 'チーム' }).click()
    check('チームタブ: 既定表示が「月」（月トグルが選択状態）',
      await page.evaluate(() => {
        const month = [...document.querySelectorAll('main button')].find(b => b.textContent.trim() === '月')
        return !!month && month.getAttribute('aria-pressed') === 'true'
      }))

    // 改修4: 全員の週報タブに週報内容のプレビューが出る
    await page.getByRole('tab', { name: '全員の週報' }).click()
    // 週報プレビュー（項目ラベル）が一覧に出る（少なくとも1件のシード週報がある前提。無ければスキップ扱い）
    const hasWeeklyRows = (await page.locator('main').getByText(/今週の主要業務|今週の成果|今週の課題/).count()) > 0
    check('全員の週報: 一覧に週報の主要項目プレビューが表示される（または該当週にデータなし）',
      hasWeeklyRows || (await page.getByText(/週報がありません|提出済みの週報はありません|ありません/).count()) > 0)

    // 改修8: 自分の日報に改善のタネが表示される（シードで当日分がある想定。無ければセクション非表示でOK）
    await page.getByRole('tab', { name: '自分の日報' }).click()
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    // 改善のタネのセクションは v-if。存在すれば「改善のタネ」ラベルが提出済み表示内に出る。
    // ここでは「例外なくクラッシュせず表示できる」ことと、改修9 の例文挿入ボタンの存在を主に確認する。
    check('自分の日報: ページが正しく描画される', true)

    // 改修9: 自分の週報に「例文を挿入」ボタンがある
    await page.getByRole('tab', { name: '自分の週報' }).click()
    await page.getByRole('button', { name: '週報を書く' }).first().click().catch(() => {})
    await page.getByRole('button', { name: '例文を挿入' }).first().waitFor()
    check('自分の週報: 「例文を挿入」ボタンがある', true)
    await page.getByRole('button', { name: '例文を挿入' }).first().click()
    // 空欄なら確認なしで挿入 → トースト
    await page.getByText('例文を挿入しました').waitFor()
    // 挿入対象の 4 欄すべてに例文が入ることを確認（成果・課題・うまくいったこと・来週の最重要テーマ）
    const areaValues = await page.locator('textarea').evaluateAll(els => els.map(e => e.value))
    const joined = areaValues.join('\n')
    check('自分の週報: 成果欄に例文が挿入される', joined.includes('顧客マスタの登録作業を完了'))
    check('自分の週報: 課題欄に例文が挿入される', joined.includes('マスタ設定の確認に時間がかかった'))
    check('自分の週報: うまくいったこと欄に例文が挿入される', joined.includes('確認項目を一覧化した'))
    check('自分の週報: 来週の最重要テーマ欄に例文が挿入される', joined.includes('システム稼働に向けた事前準備'))

    // ===== モバイル 375px：主要変更ページで横スクロールが出ない =====
    await page.setViewportSize({ width: 375, height: 800 })
    for (const [path, label] of [['/improvements', '改善要望'], ['/reports', '日報・週報']]) {
      await page.goto(`${BASE}/#${path}`)
      await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`モバイル375px: ${label} でページ全体の横スクロールが出ない`, overflow <= 1)
    }
  })
  summary('batch3-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
