/* 找旧版指标详情里的体重，看"不是数字"出现在哪 */
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

  // 枚举顶部导航
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-go-btn], nav button, .nav button')).map(b => b.dataset.goBtn + ':' + b.innerText.trim()));
  console.log('导航:', JSON.stringify(tabs));

  // 切到"我"
  await page.click('.person-switch .ps[data-ps="1"]').catch(() => {});
  await page.waitForTimeout(800);

  // 找所有含"体重"的可点击元素
  const cands = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-ind-open], [data-ind], .ind-card, .kpi').forEach(el => {
      const t = el.innerText || '';
      if (t.includes('体重')) out.push({ tag: el.tagName, cls: el.className, attr: el.dataset.indOpen || el.dataset.ind || '', text: t.slice(0, 80) });
    });
    return out;
  });
  console.log('含体重的可点元素:', JSON.stringify(cands, null, 1).slice(0, 1500));
  await page.screenshot({ path: '_probe/overview.png', fullPage: true });
  console.log('== console errors ==');
  console.log(errors.slice(0, 8).join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
