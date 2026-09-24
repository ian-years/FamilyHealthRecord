/* 单成员视图 + 来源按钮深测 */
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

  // 点"按成员看"里的具体成员（第一个非 all 的按钮）
  const psBtns = await page.$$('.person-switch .ps');
  console.log('成员按钮数:', psBtns.length);
  let picked = null;
  for (const b of psBtns) {
    const v = await b.getAttribute('data-ps');
    const t = (await b.innerText()).trim();
    console.log('  ps button', v, t);
    if (v !== 'all' && v !== '0' && !picked) picked = b;
  }
  if (picked) { await picked.click(); await page.waitForTimeout(1200); }

  // 打开体重详情（单成员视图）
  const w = await page.$('#cardFollow [data-v2-ind="112"]');
  console.log('单成员视图有体重详情按钮:', !!w);
  if (!w) {
    // 单成员视图可能没关注体重，直接调 V2 打开
    await page.evaluate(() => { document.querySelector('#cardFollow [data-v2-ind="50"]')?.click(); });
    await page.waitForTimeout(600);
    // 关闭后用身高详情里的逻辑不行，直接打开体重：通过历史记录不行，换个方式——
    // 用页面上任一指标详情，检查来源按钮
  }
  // 打开任一指标详情（有历史记录和来源按钮的）
  const anyInd = (await page.$$('#cardFollow [data-v2-ind]'))[0];
  if (anyInd) {
    await anyInd.click();
    await page.waitForTimeout(800);
    const btns = await page.$$('#indBody [data-src-doc]');
    console.log('来源按钮数量:', btns.length);
    if (btns.length) {
      await btns[0].click();
      await page.waitForTimeout(700);
      const st = await page.evaluate(() => {
        const doc = document.getElementById('docLayer');
        return { docOn: doc && doc.classList.contains('on'),
                 docTop: doc && doc.classList.contains('layer-top'),
                 toast: (document.querySelector('.toast, #globalMsg') || {}).textContent || null };
      });
      console.log('单成员视图点来源:', JSON.stringify(st));
      await page.screenshot({ path: '_probe/single-src.png' });
      // 关闭 doc 层，返回指标层再点第二个来源
      const closeBtn = await page.$('#docLayer .layer-x, #docLayer [data-close], #docLayer .close');
      if (closeBtn) { await closeBtn.click(); await page.waitForTimeout(400); }
      else { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
      const st2 = await page.evaluate(() => {
        const doc = document.getElementById('docLayer');
        const ind = document.getElementById('indLayer');
        return { docOn: doc.classList.contains('on'), indOn: ind.classList.contains('on') };
      });
      console.log('关闭后:', JSON.stringify(st2));
      // 再点一次来源（第二轮）
      const btns2 = await page.$$('#indBody [data-src-doc]');
      if (btns2[1]) {
        await btns2[1].click();
        await page.waitForTimeout(700);
        const st3 = await page.evaluate(() => {
          const doc = document.getElementById('docLayer');
          return { docOn: doc.classList.contains('on'), docTop: doc.classList.contains('layer-top') };
        });
        console.log('第二轮点来源:', JSON.stringify(st3));
      }
    }
  }
  console.log('== console errors ==');
  console.log(errors.slice(0, 10).join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
