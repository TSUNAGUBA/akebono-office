/* 権限設定: 項目キーの論理名オートコンプリート（複数選択→一括作成）のスモーク */
const { chromium } = require('playwright')

let pass = 0, fail = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  ok ? pass++ : fail++
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.goto('http://127.0.0.1:3123/#/masters/permissions')
  await page.waitForLoadState('networkidle')

  // 追加モーダルを開く
  await page.getByRole('button', { name: 'ルールを追加' }).click()
  // 対象 = ロール: 一般
  await page.getByLabel('対象', { exact: true }).selectOption({ label: '一般' })
  // リソース = マスタ項目: 顧客(人)
  await page.getByLabel('リソース', { exact: true }).selectOption({ label: 'マスタ項目: 顧客(人)' })
  // オートコンプリートが表示される（機能リソースでは非表示）
  const combo = page.getByRole('combobox', { name: '制御する項目' })
  check('項目オートコンプリートが表示される', await combo.isVisible())

  // 「役」で検索 → 論理名「役職」を選択
  await combo.fill('役')
  await page.getByRole('listbox').getByRole('option', { name: /役職/ }).click()
  // 「メモ」を検索して追加選択
  await combo.fill('メモ')
  await page.getByRole('listbox').getByRole('option', { name: /メモ/ }).click()
  const chips = await page.locator('[aria-label="制御する項目"]').locator('..').innerText()
  check('選択チップに論理名が表示される', chips.includes('役職') && chips.includes('メモ'))

  // 保存 → 2 件一括作成
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(400)
  const toast1 = await page.locator('body').innerText()
  check('2 件一括作成のトースト', toast1.includes('2 件追加'))
  const body = await page.locator('main').innerText()
  check('一覧の項目列が論理名（役職）', body.includes('役職'))
  check('一覧の項目列が論理名（メモ）', body.includes('メモ'))

  // 同じ内容で再作成 → 重複スキップ
  await page.getByRole('button', { name: 'ルールを追加' }).click()
  await page.getByLabel('対象', { exact: true }).selectOption({ label: '一般' })
  await page.getByLabel('リソース', { exact: true }).selectOption({ label: 'マスタ項目: 顧客(人)' })
  const combo2 = page.getByRole('combobox', { name: '制御する項目' })
  await combo2.fill('役職')
  await page.getByRole('listbox').getByRole('option', { name: /役職/ }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(400)
  const body2 = await page.locator('body').innerText()
  check('同一ルールはスキップされる', body2.includes('既に存在するため追加しませんでした'))

  // 編集モード = 単一選択（既存行クリック → チップ 1 件）
  await page.locator('table:visible tbody tr').filter({ hasText: '役職' }).first().click()
  const editChips = await page.locator('[aria-label="制御する項目"]').locator('..').innerText()
  check('編集時は既存の項目が単一チップで表示される', editChips.includes('役職'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // M-5: 候補が開いた状態の Esc は候補だけ閉じる（モーダルは開いたまま = 入力途中を破棄しない）
  await page.getByRole('button', { name: 'ルールを追加' }).click()
  await page.getByLabel('リソース', { exact: true }).selectOption({ label: 'マスタ項目: 顧客(人)' })
  const combo3 = page.getByRole('combobox', { name: '制御する項目' })
  await combo3.click()
  await combo3.press('Escape')
  check('M-5: 候補表示中の Esc でモーダルは閉じない', await page.getByRole('button', { name: '保存', exact: true }).isVisible())
  await combo3.press('Escape')
  await page.waitForTimeout(200)
  check('M-5: 候補が閉じた状態の Esc でモーダルが閉じる', !(await page.getByRole('button', { name: '保存', exact: true }).isVisible().catch(() => false)))

  // R-1 回帰: リロード直後（フォーム初期状態から）に既存行を直接編集しても項目が消えない +
  // 無変更保存で「マスタ全体」へ拡大しない
  await page.reload()
  await page.waitForTimeout(1500)
  await page.locator('table:visible tbody tr').filter({ hasText: '役職' }).first().click()
  const freshChips = await page.locator('[aria-label="制御する項目"]').locator('..').innerText()
  check('R-1: リロード直後の編集でも項目チップが保持される', freshChips.includes('役職'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(400)
  const afterSave = await page.locator('table:visible tbody tr').filter({ hasText: '顧客(人)' }).first().innerText()
  check('R-1: 無変更保存後も項目が「役職」のまま（マスタ全体へ拡大しない）', afterSave.includes('役職'))

  // ---------- 権限表モード（オペレーター指示 2026-07-19 #2） ----------
  await page.getByRole('tab', { name: '権限表' }).or(page.getByRole('button', { name: '権限表' })).first().click()
  await page.waitForTimeout(400)
  const chatbotCell = page.getByRole('button', { name: /一般 × 機能（利用可否）\/AIチャットボット/ })
  check('権限表: セルが表示される（未設定）', (await chatbotCell.getAttribute('aria-label')).includes('未設定'))
  // 既存ルール（ルール一覧モードで作成した 顧客(人) 役職 deny）が権限表にも反映される = 両モード相互運用
  const contactTitleCell = page.getByRole('button', { name: /一般 × マスタ項目: 顧客\(人\)\/役職/ })
  check('権限表: ルール一覧で作った拒否ルールが反映されている', (await contactTitleCell.getAttribute('aria-label')).includes('拒否'))
  // クリック循環: 未設定 → 拒否 → 許可 → 未設定
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: クリックで拒否になる', (await chatbotCell.getAttribute('aria-label')).includes('拒否'))
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: 再クリックで許可になる', (await chatbotCell.getAttribute('aria-label')).includes('許可'))
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: 三度目のクリックで未設定へ戻る', (await chatbotCell.getAttribute('aria-label')).includes('未設定'))
  // 再度拒否にして、ルール一覧モードに同じルールが見えること（無効ルールの復元 = 乱立しない）
  await chatbotCell.click()
  await page.waitForTimeout(400)
  await page.getByRole('tab', { name: 'ルール一覧' }).or(page.getByRole('button', { name: 'ルール一覧' })).first().click()
  await page.waitForTimeout(400)
  const listRows = page.locator('table:visible tbody tr').filter({ hasText: 'AIチャットボット' })
  check('権限表の変更がルール一覧に 1 件だけ現れる（乱立しない）', await listRows.count() === 1)

  await browser.close()
  console.log(`perm-combobox-e2e: ${pass} passed / ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
