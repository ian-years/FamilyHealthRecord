/* 测来源按钮的第二轮点击：打开→返回→再打开 */
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

  // 切到"我"
  await page.click('.person-switch .ps[data-ps="1"]');
  await page.waitForTimeout(1200);

  // 打开体重详情
  await page.click('#cardFollow [data-v2-ind="112"]');
  await page.waitForTimeout(800);

  for (let round = 1; round <= 3; round++) {
    // 关闭 doc 层：优先找返回/关闭按钮
    if (round > 1) {
      const closed = await page.evaluate(() => {
        const doc = document.getElementById('docLayer');
        if (!doc || !doc.classList.contains('on')) return 'already-off';
        // 找关闭按钮
        const cands = doc.querySelectorAll('.layer-x, [data-close-layer], .btn-close, #docBack');
        if (cands.length) { cands[0].click(); return 'clicked ' + cands[0].id + '.' + cands[0].className; }
        return 'no-close-btn';
      });
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => {
        const doc = document.getElementById('docLayer');
        return doc.classList.contains('on');
      });
      console.log('round', round, 'close attempt:', closed, '| docOn after:', st);
      if (st) {
        // 强制用应用内历史返回
        await page.evaluate(() => history.back());
        await page.waitForTimeout(500);
        const st2 = await page.evaluate(() => document.getElementById('docLayer').classList.contains('on'));
        console.log('  history.back -> docOn:', st2);
      }
    }
    const btns = await page.$$('#indBody [data-src-doc]');
    if (!btns.length) { console.log('round', round, 'no src buttons (indBody empty?)'); break; }
    await btns[0].click();
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => {
      const doc = document.getElementById('docLayer');
      const ind = document.getElementById('indLayer');
      return { docOn: doc.classList.contains('on'), docTop: doc.classList.contains('layer-top'), indOn: ind.classList.contains('on') };
    });
    console.log('round', round, '点击来源 ->', JSON.stringify(st));
  }
  console.log('== console errors ==');
  console.log(errors.slice(0, 10).join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
