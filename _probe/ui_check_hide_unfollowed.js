/* 概览表「彻底隐藏未关注」验证：概览不应再出现灰色「未关注」标签行 */
'use strict';
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const tags = await page.$$eval('main .tag.gray, #app .tag.gray', els =>
    els.map(e => e.textContent.trim()).filter(t => t.indexOf('未关注') >= 0));
  console.log('概览中「未关注」标签数量:', tags.length);
  const rows = await page.$$eval('table.tbl tbody tr', els => els.length);
  console.log('概览表总行数:', rows);
  // 抽查：行里不应再有无关注标记的指标
  console.log(tags.length === 0 ? 'PASS: 未关注项已彻底隐藏' : 'FAIL: 仍有未关注项平铺');
  await browser.close();
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
