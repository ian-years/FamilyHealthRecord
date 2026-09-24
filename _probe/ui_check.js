/* 用真实浏览器检查三个问题：
   1) 体重在界面上哪里显示"不是数字"
   2) 来源按钮点击是否报错
   3) 日期确认流程 */
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

  // 打开成员"我"（第 1 个成员），找到 体重 的关注行或指标
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('== 首页是否含 体重:', bodyText.includes('体重'));

  // 截图首页
  await page.screenshot({ path: '_probe/home.png', fullPage: false });

  // 尝试直接调 JS 打开体重指标详情（找 id=112）
  const opened = await page.evaluate(() => {
    try {
      // 关注列表可能没有体重，直接找"详情"按钮
      const btns = Array.from(document.querySelectorAll('#cardFollow [data-v2-ind]'));
      return btns.map(b => b.getAttribute('data-v2-ind'));
    } catch (e) { return ['ERR ' + e.message]; }
  });
  console.log('关注指标按钮 ids:', JSON.stringify(opened));

  // 若体重(112)在关注列表，点它
  if (opened.includes('112')) {
    await page.click('#cardFollow [data-v2-ind="112"]');
    await page.waitForTimeout(800);
    const indText = await page.evaluate(() => document.getElementById('indBody').innerText);
    console.log('== 体重详情页文本（前1200字）==');
    console.log(indText.slice(0, 1200));
    await page.screenshot({ path: '_probe/weight-ind.png', fullPage: true });

    // 2) 点历史记录里的"来源"按钮
    const srcBtn = await page.$('#indBody [data-src-doc]');
    console.log('来源按钮存在:', !!srcBtn);
    if (srcBtn) {
      await srcBtn.click();
      await page.waitForTimeout(800);
      const docVisible = await page.evaluate(() => {
        const el = document.getElementById('docLayer');
        return el ? el.classList.contains('on') : 'no-docLayer';
      });
      console.log('点击来源后 docLayer.on =', docVisible);
      const docText = await page.evaluate(() => {
        const el = document.getElementById('docBody');
        return el ? el.innerText.slice(0, 800) : '(empty)';
      });
      console.log('== 档案详情文本（前800字）==');
      console.log(docText);
      await page.screenshot({ path: '_probe/src-doc.png', fullPage: false });
    }
  }
  console.log('== console errors ==');
  console.log(errors.slice(0, 10).join('\n') || '(none)');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
