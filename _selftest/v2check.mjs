/* V2 重构自测：真实浏览器里跑一遍，逐条核对四个问题。
   用法：node v2check.mjs  （服务需先起在 8766） */
import { createRequire } from 'module';
// 依赖装在 workbuddy 的 node workspace 里，用绝对路径把它拉进来
const require = createRequire('C:/Users/junlan/.workbuddy/binaries/node/workspace/node_modules/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Users/junlan/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const OUT = process.cwd();

const log = (...a) => console.log(...a);
let fails = 0;
function check(name, ok, extra) {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) fails++;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 2500));

// ---------- 1. 页面加载无报错
check('页面加载无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

// ---------- 2. 关注指标卡被 V2 接管
const v2on = await page.$('#v2BtnFollow');
check('V2 关注卡片已接管（问题A）', !!v2on);

// ---------- 3. 添加关注：可选指标数量（旧版只有 15）
await page.click('#v2BtnFollow');
await new Promise(r => setTimeout(r, 1800));
const pickCount = await page.$$eval('#v2PickList input[data-v2-pick]', els => els.length).catch(() => 0);
check('可添加指标数量 > 15（问题A）', pickCount > 15, `实际 ${pickCount} 项`);
await page.screenshot({ path: OUT + '/v2-01-follow-drawer.png' });

// 勾选前两项并保存
const boxes = await page.$$('#v2PickList input[data-v2-pick]');
if (boxes.length >= 2) { await boxes[0].click(); await boxes[1].click(); }
await page.click('#v2FollowSave');
await new Promise(r => setTimeout(r, 2000));

// ---------- 4. 关注表有数据
const rows = await page.$$eval('#cardFollow tbody tr', els => els.length).catch(() => 0);
check('关注指标表已渲染', rows > 0, `${rows} 行`);
await page.screenshot({ path: OUT + '/v2-02-overview.png' });

// ---------- 5. 指标详情：趋势图（问题B）
await page.click('#cardFollow [data-v2-ind]');
await new Promise(r => setTimeout(r, 2000));
const svgCount = await page.$$eval('#indBody svg', els => els.length).catch(() => 0);
const histCount = await page.$$eval('#indBody .point-list .pr', els => els.length).catch(() => 0);
check('指标详情画出趋势图（问题B）', svgCount > 0, `svg ${svgCount} 个`);
check('历史记录有条目', histCount > 0, `${histCount} 条`);
await page.screenshot({ path: OUT + '/v2-03-indicator.png' });

// ---------- 6. 来源按钮可点（问题C）
const srcBtn = await page.$('#indBody [data-src-doc]');
if (srcBtn) {
  await srcBtn.click();
  await new Promise(r => setTimeout(r, 1500));
  const docVisible = await page.$eval('#docLayer', el => {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { on: el.classList.contains('on'), z: st.zIndex, display: st.display, h: r.height };
  });
  // 关键：文档层不仅开了，还要真的在最上面（没有被指标层盖住）
  const indZ = await page.$eval('#indLayer', el => getComputedStyle(el).zIndex);
  const docTop = await page.evaluate(() => {
    const el = document.getElementById('docLayer');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.width / 2, 40);
    return top ? (top.closest('#docLayer') ? 'doc' : (top.id || top.className)) : 'none';
  });
  check('来源打开文档层且未被遮挡（问题C）',
    docVisible.on && Number(docVisible.z) > Number(indZ) && docTop === 'doc',
    `docLayer.z=${docVisible.z} indLayer.z=${indZ} 命中=${docTop}`);
  await page.screenshot({ path: OUT + '/v2-04-source-doc.png' });
} else {
  check('来源按钮存在', false, '未找到 data-src-doc');
}

// ---------- 7. 费用卡（问题D）
await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 2500));
const feeTxt = await page.$eval('#cardFees', el => el.textContent.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '');
check('费用卡已由后端口径渲染（问题D）', /统计口径/.test(feeTxt), feeTxt.slice(0, 80));
await page.screenshot({ path: OUT + '/v2-05-fees.png' });

// ---------- 8. 指标目录管理
await page.click('#v2BtnManage');
await new Promise(r => setTimeout(r, 1800));
const catCount = await page.$eval('#catCount', el => el.textContent).catch(() => '');
const catRows = await page.$$eval('#catList .pi', els => els.length).catch(() => 0);
check('指标目录管理可打开', catRows > 0, `${catCount} / ${catRows} 项`);
await page.screenshot({ path: OUT + '/v2-06-catalog.png' });

log('\n控制台错误：', errors.length ? errors.slice(0, 5) : '无');
log(`\n结果：${fails === 0 ? '全部通过' : fails + ' 项未通过'}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
