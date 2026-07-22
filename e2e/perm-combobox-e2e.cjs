/* 権限設定: 項目キーの論理名オートコンプリート（複数選択→一括作成）+ 権限表（階層・常時可否表示）のスモーク */
const { chromium } = require('playwright')

const BASE = process.env.BASE || 'http://127.0.0.1:3123'

let pass = 0, fail = 0
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  ok ? pass++ : fail++
}

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.goto(`${BASE}/#/masters/permissions`)
  await page.waitForLoadState('networkidle')

  // 既定タブ = 権限表（バッチ7m: タブ並びは 権限表 → ルール一覧）
  check('既定タブが権限表（階層ヘッダが表示される）', await page.getByText('ページ / 機能 / 項目').isVisible())

  // ---------- ルール一覧モード ----------
  await page.getByRole('tab', { name: 'ルール一覧' }).or(page.getByRole('button', { name: 'ルール一覧' })).first().click()
  await page.waitForTimeout(300)

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
  // 無変更保存で「マスタ全体」へ拡大しない（リロード後の既定タブは権限表なのでルール一覧へ切替）
  await page.reload()
  await page.waitForTimeout(1500)
  await page.getByRole('tab', { name: 'ルール一覧' }).or(page.getByRole('button', { name: 'ルール一覧' })).first().click()
  await page.waitForTimeout(300)
  await page.locator('table:visible tbody tr').filter({ hasText: '役職' }).first().click()
  const freshChips = await page.locator('[aria-label="制御する項目"]').locator('..').innerText()
  check('R-1: リロード直後の編集でも項目チップが保持される', freshChips.includes('役職'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(400)
  const afterSave = await page.locator('table:visible tbody tr').filter({ hasText: '顧客(人)' }).first().innerText()
  check('R-1: 無変更保存後も項目が「役職」のまま（マスタ全体へ拡大しない）', afterSave.includes('役職'))

  // ---------- 権限表モード（バッチ7m: ページ > 機能 > 項目 の階層 + 常時可否表示 + トグル） ----------
  await page.getByRole('tab', { name: '権限表' }).or(page.getByRole('button', { name: '権限表' })).first().click()
  await page.waitForTimeout(400)
  // 未設定セルは「未設定」ではなく既定値（許可）を表示する
  const chatbotCell = page.getByRole('button', { name: /一般 × AIチャットボット: / })
  check('権限表: 明示ルールが無いセルも既定値（許可）を表示する',
    (await chatbotCell.getAttribute('aria-label')).includes('許可（既定値）'))

  // 階層: マスタメンテナンス > 顧客(人)（マスタ全体） を展開すると項目行が現れる
  await page.getByRole('button', { name: 'マスタメンテナンス の下位項目を開く' }).click()
  await page.getByRole('button', { name: '顧客(人)（マスタ全体） の下位項目を開く' }).click()
  await page.waitForTimeout(200)
  // 既存ルール（ルール一覧モードで作成した 顧客(人) 役職 deny）が権限表にも反映される = 両モード相互運用
  const contactTitleCell = page.getByRole('button', { name: /一般 × 役職: / })
  check('権限表: ルール一覧で作った拒否ルールが明示設定として反映されている',
    (await contactTitleCell.getAttribute('aria-label')).includes('拒否（明示設定）'))

  // 上位（マスタ全体）で設定すると、明示ルールの無い下位項目が一括で従う
  const contactAllCell = page.getByRole('button', { name: /一般 × 顧客\(人\)（マスタ全体）: / })
  await contactAllCell.click()
  await page.waitForTimeout(400)
  check('権限表: マスタ全体のクリックで拒否（明示設定）になる',
    (await contactAllCell.getAttribute('aria-label')).includes('拒否（明示設定）'))
  const contactPhoneCell = page.getByRole('button', { name: /一般 × 電話番号: / })
  check('権限表: 一括設定が明示ルールの無い下位項目に及ぶ（上位の一括設定に従う）',
    (await contactPhoneCell.getAttribute('aria-label')).includes('拒否（上位の一括設定に従う）'))
  check('権限表: 個別の明示ルールは一括設定より優先されたまま',
    (await contactTitleCell.getAttribute('aria-label')).includes('拒否（明示設定）'))
  // 戻す（反転 = 引き継ぎ値と同じ値 → 明示ルール解除で既定値へ）
  await contactAllCell.click()
  await page.waitForTimeout(400)
  check('権限表: 再クリックでマスタ全体が既定値（許可）へ戻る',
    (await contactAllCell.getAttribute('aria-label')).includes('許可（既定値）'))

  // トグル: 既定値（許可）→ 拒否（明示）→ 許可（既定値 = 明示解除）→ 拒否（無効ルールの復元 = 乱立しない）
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: クリックで拒否（明示設定）になる', (await chatbotCell.getAttribute('aria-label')).includes('拒否（明示設定）'))
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: 再クリックで既定値（許可）へ戻る（明示設定の解除）',
    (await chatbotCell.getAttribute('aria-label')).includes('許可（既定値）'))
  await chatbotCell.click()
  await page.waitForTimeout(400)
  check('権限表: 三度目のクリックで再び拒否（明示設定）', (await chatbotCell.getAttribute('aria-label')).includes('拒否（明示設定）'))
  // ルール一覧モードに同じルールが 1 件だけ見えること（無効ルールの復元 = 乱立しない）
  await page.getByRole('tab', { name: 'ルール一覧' }).or(page.getByRole('button', { name: 'ルール一覧' })).first().click()
  await page.waitForTimeout(400)
  const listRows = page.locator('table:visible tbody tr').filter({ hasText: 'AIチャットボット' })
  check('権限表の変更がルール一覧に 1 件だけ現れる（乱立しない）', await listRows.count() === 1)

  // ---------- 参照対象（全メンバー一括 = member:*）の両モード一致 ----------
  await page.getByRole('tab', { name: '権限表' }).or(page.getByRole('button', { name: '権限表' })).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '日報・週報 の下位項目を開く' }).click()
  await page.waitForTimeout(200)
  const reportAllCell = page.getByRole('button', { name: /一般 × 日報・週報の参照対象: 全メンバー（一括）: / })
  check('権限表: 日報・週報の参照対象（全メンバー一括）行がある（既定 = 参照可）',
    (await reportAllCell.getAttribute('aria-label')).includes('参照可（既定値）'))
  await reportAllCell.click()
  await page.waitForTimeout(400)
  check('権限表: 全メンバー一括を参照不可にできる',
    (await reportAllCell.getAttribute('aria-label')).includes('参照不可（明示設定）'))
  // ルール一覧側にも member:* が「全メンバー（一括既定）」として表示される
  await page.getByRole('tab', { name: 'ルール一覧' }).or(page.getByRole('button', { name: 'ルール一覧' })).first().click()
  await page.waitForTimeout(400)
  const wildcardRows = page.locator('table:visible tbody tr').filter({ hasText: '全メンバー（一括既定）' })
  check('ルール一覧: member:* ルールが「全メンバー（一括既定）」として表示される', await wildcardRows.count() === 1)

  // 後片付け = 取消フローの確認: 全メンバー一括を既定（参照可）へ戻す（後続スイートの日報表示へ影響させない）
  await page.getByRole('tab', { name: '権限表' }).or(page.getByRole('button', { name: '権限表' })).first().click()
  await page.waitForTimeout(300)
  await reportAllCell.click()
  await page.waitForTimeout(400)
  check('権限表: 全メンバー一括を既定（参照可）へ戻せる（取消フロー）',
    (await reportAllCell.getAttribute('aria-label')).includes('参照可（既定値）'))

  await browser.close()
  console.log(`perm-combobox-e2e: ${pass} passed / ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
