/* 深测来源按钮：切到"我"，打开体重详情，反复开关来源 */
'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 切换到具体成员：找成员切换控件
  const sel = await page.$('#personSel, select#person, [data-role=person]');
  console.log('成员选择器存在:', !!sel);
  if (sel) {
    const opts = await page.evaluate(el => Array.from(el.options).map(o => o.value + ':' + o.text), sel);
    console.log('选项:', opts.join(' | '));
    await page.selectOption(sel, opts.find(o => !o.startsWith('all')).split(':')[0] || opts[1].split(':')[0]);
    await page.waitForTimeout(1200);
  }

  // 打开体重详情
  const has = await page.$('#cardFollow [data-v2-ind="112"]');
  console.log('体重详情按钮:', !!has);
  if (has) {
    await page.click('#cardFollow [data-v2-ind="112"]');
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => document.getElementById('indBody').innerText.slice(0, 400));
    console.log('== 体重详情(单成员) ==\n' + t);
  }

  // 连续 3 次：点第一条来源 → 关闭 → 再点下一条
  for (let i = 0; i < 3; i++) {
    const btns = await page.$$('#indBody [data-src-doc]');
    if (!btns[i]) { console.log('no more src buttons at', i); break; }
    const docId = await btns[i].getAttribute('data-src-doc');
    await btns[i].click();
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => {
      const doc = document.getElementById('docLayer');
      const ind = document.getElementById('indLayer');
      return { docOn: doc.classList.contains('on'), docTop: doc.classList.contains('layer-top'),
               indOn: ind.classList.contains('on'), indTop: ind.classList.contains('layer-top') };
    });
    console.log('round', i, 'docId=' + docId, JSON.stringify(state));
    // 关闭 doc 层（找关闭按钮或按 Esc）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  console.log('== console errors ==');
  console.log(errors.slice(0, 10).join('\n') || '(none)');
  await page.screenshot({ path: '_probe/final.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
