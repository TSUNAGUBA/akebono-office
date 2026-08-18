// 改修依頼 2026-08-18 第 2 弾（8 件）のモックモード E2E。
// モックモード配信（既定 :4173）に対して、対応中ステータス・プロンプト定型文/対象固定・
// 権限設定の拡張（タブ行/更新行/AIの参照範囲）・稟議区分のカード型選択・受付箱の添付列・
// 日報 placeholder・モバイル幅（375px）の崩れなしを確認する。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 改修依頼 2026-08-18 第 2 弾（8 件）')

    // 1) 改善要望: サマリーカード 6 枚（対応中）+ カンバン「対応中」列 + シードのデモ案件
    await page.goto(`${BASE}/#/improvements`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '改善要望' }).waitFor()
    await page.getByRole('button', { name: /対応中/ }).first().waitFor()
    check('改善要望: サマリーカードに「対応中」が出る', true)
    await page.getByRole('tab', { name: 'カンバン' }).click()
    check('カンバン: 「対応中」列が「対応する」と「解決済み」の間にある', await page.evaluate(() => {
      const heads = [...document.querySelectorAll('main h3, main h4, main [class*="font-semibold"]')]
        .map(el => el.textContent?.trim() ?? '')
      const a = heads.findIndex(t => t.startsWith('対応する'))
      const p = heads.findIndex(t => t.startsWith('対応中'))
      const r = heads.findIndex(t => t.startsWith('解決済み'))
      return a !== -1 && p !== -1 && r !== -1 && a < p && p < r
    }))
    await page.getByText('「シフト表」の確定シフト CSV ダウンロード').first().waitFor()
    check('カンバン: 対応中のデモ案件（imp-0003）が表示される', true)

    // 2) 改修プロンプト: 対象 = 「対応する」のみ + ナビゲーター定型文
    await page.getByRole('button', { name: '改修プロンプトを出力' }).click()
    await page.getByText('「対応する」ステータスの改修単位のみを').waitFor()
    check('プロンプト: 対象が「対応する」のみである説明が出る', true)
    const promptText = await page.locator('textarea[readonly]').inputValue()
    check('プロンプト: 冒頭にナビゲーター定型文が入る',
      promptText.startsWith('あなたはナビゲーターです。')
      && promptText.includes('コードレビューとシステム監査を繰り返してください'))
    check('プロンプト: 未判定の案件（ヘッダーの通知一覧改善）を含まない', !promptText.includes('imp-0002'))
    await page.keyboard.press('Escape')

    // 3) 受付箱: 添付列 + 対象ページのリンク化
    await page.getByRole('tab', { name: /受付箱/ }).click()
    await page.getByRole('columnheader', { name: '添付' }).waitFor()
    check('受付箱: 一覧に「添付」列がある', true)
    // 既定フィルタ = 未選別（imreq-0005 = メンバー管理）。対象ページ列がリンクとして出る
    await page.getByRole('link', { name: '対象ページ（メンバー管理）を開く' }).first().waitFor()
    check('受付箱: 対象ページが当該ページへのリンクになっている', true)

    // 4) 稟議: 区分の説明付きカード型ラジオ選択
    await page.goto(`${BASE}/#/workflow`)
    await page.getByRole('button', { name: '新規申請' }).click()
    await page.getByRole('radiogroup', { name: '区分' }).waitFor()
    check('稟議: 区分が radiogroup（カード型ラジオ）で選択できる', true)
    check('稟議: 全区分の説明文を確認しながら選択できる',
      (await page.getByText('物品・備品・ソフトウェア・SaaS等の購入').count()) >= 1
      && (await page.getByText('交通・宿泊を伴う出張の事前申請').count()) >= 1)
    await page.getByRole('radio', { name: /出張/ }).click()
    check('稟議: 区分カードのクリックで選択が切り替わる',
      await page.getByRole('radio', { name: /出張/ }).getAttribute('aria-checked') === 'true')
    await page.keyboard.press('Escape')

    // 5) 権限設定: 権限表のタブ行・項目の更新行 + 「AIの参照範囲」タブ
    await page.goto(`${BASE}/#/masters/permissions`)
    await page.getByRole('tab', { name: '権限表' }).waitFor()
    await page.getByRole('button', { name: '全て展開' }).click()
    await page.getByText('タブ: 自分の日報').first().waitFor()
    check('権限表: タブ利用可否の行（タブ: 自分の日報 等）が出る', true)
    await page.getByText('氏名の更新').first().waitFor()
    check('権限表: 項目の更新行（氏名の更新 等）が出る', true)
    await page.getByRole('tab', { name: 'AIの参照範囲' }).click()
    // 権限表（v-show 非表示）側の「日報・週報の参照対象: 全メンバー（一括）」と区別するため exact 指定
    await page.getByRole('cell', { name: '全メンバー（一括）', exact: true }).waitFor()
    check('AIの参照範囲: データ種類 × 参照者 × 登録者のマトリクスが出る', true)
    check('AIの参照範囲: データ種類タブ（改善のタネ/勤怠/タスク計画/日報・週報）が出る',
      (await page.getByRole('tab', { name: '改善のタネ' }).count()) >= 1
      && (await page.getByRole('tab', { name: '日報・週報' }).count()) >= 1)
    // セルの三値循環: 既定（−）→ 参照可 → 参照不可 → 既定
    const cell = page.getByRole('button', { name: /一般 × 改善のタネ × 全メンバー（一括）/ })
    check('AIの参照範囲: セルの初期状態は「既定」', (await cell.getAttribute('title'))?.includes('既定') === true)
    await cell.click()
    check('AIの参照範囲: クリックで「参照可（明示設定）」になる',
      await cell.getAttribute('title') === '参照可（明示設定）')
    await cell.click()
    check('AIの参照範囲: 再クリックで「参照不可（明示設定）」になる',
      await cell.getAttribute('title') === '参照不可（明示設定）')
    await cell.click()
    check('AIの参照範囲: もう一度で「既定」へ戻る（取消フロー）',
      (await cell.getAttribute('title'))?.includes('既定') === true)

    // 5b) タブガードのフェイルクローズ: 稟議の全タブを deny → 空状態のみ表示（一覧・経路設定は非描画）
    await page.getByRole('tab', { name: '権限表' }).click()
    const wfTabRows = ['タブ: 自分の申請', 'タブ: 承認待ち', 'タブ: 全件', 'タブ: 経路設定']
    for (const rowLabel of wfTabRows) {
      const cell = page.getByRole('button', { name: new RegExp(`^管理者 × ${rowLabel}:`) })
      await cell.click()
      await page.waitForFunction(
        ([label]) => document.querySelector(`[aria-label^="管理者 × ${label}:"]`)?.getAttribute('title')?.includes('利用不可') ?? false,
        [rowLabel],
      )
    }
    await page.goto(`${BASE}/#/workflow`)
    await page.getByText('利用できるタブがありません').waitFor()
    check('稟議: 全タブ deny で空状態メッセージが出る', true)
    check('稟議: 全タブ deny でどのタブ内容も描画されない（フェイルクローズ）',
      (await page.getByRole('columnheader', { name: '件名' }).count()) === 0
      && (await page.getByText('の承認経路').count()) === 0)
    // 後片付け: 明示 deny を解除（引き継ぎ値へ戻す = 論理削除。以降のチェックへ影響させない）
    await page.goto(`${BASE}/#/masters/permissions`)
    await page.getByRole('button', { name: '全て展開' }).click()
    for (const rowLabel of wfTabRows) {
      const cell = page.getByRole('button', { name: new RegExp(`^管理者 × ${rowLabel}:`) })
      await cell.click()
      await page.waitForFunction(
        ([label]) => document.querySelector(`[aria-label^="管理者 × ${label}:"]`)?.getAttribute('title')?.includes('利用可') ?? false,
        [rowLabel],
      )
    }
    await page.goto(`${BASE}/#/workflow`)
    await page.getByRole('tab', { name: '自分の申請' }).waitFor()
    check('稟議: deny 解除でタブが復帰する（取消フロー）', true)

    // 6) 日報: placeholder 例文（未作成の日は「日報を書く」で入力フォームを開く）
    await page.goto(`${BASE}/#/reports`)
    await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
    await page.getByRole('button', { name: '日報を書く' }).first().click()
    await page.locator('textarea[placeholder*="商品ページの改善を予定通り完了"]').waitFor()
    check('日報: 本日の所感の placeholder が例文になっている', true)
    check('日報: 本日の課題の placeholder が例文になっている',
      (await page.locator('textarea[placeholder*="商品データの更新に手作業が多く"]').count()) >= 1)
    check('日報: 改善のタネの placeholder が例文になっている',
      (await page.locator('textarea[placeholder*="商品データの更新を自動化できると効果的"]').count()) >= 1)

    // 7) モバイル 375px: 主要変更ページで横スクロールが発生しない（body 幅 <= viewport）
    await page.setViewportSize({ width: 375, height: 800 })
    for (const [path, label] of [['/improvements', '改善要望'], ['/workflow', '稟議'], ['/masters/permissions', '権限設定']]) {
      await page.goto(`${BASE}/#${path}`)
      await page.getByRole('main').getByRole('heading', { level: 1 }).waitFor()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`モバイル375px: ${label} でページ全体の横スクロールが出ない`, overflow <= 1)
    }
  })
  summary('batch2-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
