import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* 个人健康档案工作台（本机磁盘版）· 浏览器端到端自测
   ------------------------------------------------------------
   前置：另起一个**独立数据目录**的本地服务，避免自测污染真实数据。
   自测开头会清空服务端数据，所以**绝对不能连真实数据目录**：
     HRW_DATA_DIR=<项目>/_selftest/data  python server.py --port 8799 --no-browser
     node _selftest/selftest.mjs
   可用环境变量：HRW_SELFTEST_ROOT / HRW_SELFTEST_OUT / HRW_SELFTEST_PORT / HRW_CHROME
   自测从真实 http 源加载页面，验证「清掉浏览器数据后档案依然在」等核心承诺。 */

/* 路径与浏览器一律「环境变量优先、当前机器值兜底」。
   原来这里硬编码了 E:/08-Codework/FamilyHealth/ 和 Chrome 的绝对路径：换台机器
   或把项目挪个目录就跑不起来，而且报的是 puppeteer 的底层错误，看不出是路径问题。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = (process.env.HRW_SELFTEST_ROOT || path.dirname(HERE))
  .replace(/\\/g, '/').replace(/\/+$/, '') + '/';
const OUT = (process.env.HRW_SELFTEST_OUT || HERE)
  .replace(/\\/g, '/').replace(/\/+$/, '') + '/';
const PORT = Number(process.env.HRW_SELFTEST_PORT || 8799);
const CHROME = process.env.HRW_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:' + PORT + '/';
const ORIGIN = 'http://127.0.0.1:' + PORT;
const W = 1320, H = 900;

if (!fs.existsSync(CHROME)) {
  console.error('找不到 Chrome：' + CHROME);
  console.error('用环境变量指到实际的可执行文件，例如：HRW_CHROME="D:/Tools/chrome.exe" node selftest.mjs');
  process.exit(2);
}
console.log('自测目录：' + ROOT + '　输出：' + OUT + '　服务：' + BASE);

fs.mkdirSync(OUT, { recursive: true });

// 前置阶段的记录单独收集：最后日志是用 log 数组整体覆盖写文件的，
// 这里直接 console.log 的话会被覆盖掉，事后就看不出「这轮有没有真的清干净」。
const prelog = [];

// 前置：清空服务端数据，保证每次自测都从**空库**开始。
// 不这么做的话，上一次自测的残留（尤其是第 11 节故意清空后又迁移进来的 1 条）会让
// 这一轮所有「条数应为 N」的断言整体多 1，连带报出一串假失败。
// ⚠️ 因为会清空数据，脚本必须只连独立数据目录的服务（默认 8799）。
try {
  const r = await fetch(BASE + 'api/db/clear-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  const j = await r.json();
  const s = '前置清空服务端数据：' + JSON.stringify(j) + '（连的是 ' + BASE + '）';
  prelog.push(s); console.log(s);
} catch (e) {
  const s = '前置清空失败（服务没起？）：' + (e && e.message) + '（连的是 ' + BASE + '）';
  prelog.push(s); console.log(s);
}

// 前置：把成员名单重置成预置的 6 人。
// 光清四表不够 —— 成员名单存在 meta 表里，按设计「清空数据不误删名单」，
// 所以上一轮改过的名字、删掉的成员会**跨轮残留**：
// 上一轮把「儿子」改成「仔仔」、删掉了「老婆」，下一轮「改名儿子」「添加老婆」这些
// 用例的前提就不成立了，会报出一串看起来像功能坏了、实际是状态脏了的失败。
const PRESET_PERSONS = [
  { id: 1, name: '我', role: 'self' },
  { id: 2, name: '老婆', role: 'spouse' },
  { id: 3, name: '儿子', role: 'son' },
  { id: 4, name: '爸爸', role: 'father' },
  { id: 5, name: '妈妈', role: 'mother' },
  { id: 6, name: '丈母娘', role: 'mother_in_law' }
];
try {
  const r = await fetch(BASE + 'api/persons', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persons: PRESET_PERSONS })
  });
  const j = await r.json();
  const s = '前置重置成员名单：' +
    (j.persons ? j.persons.map(p => p.name).join('/') : JSON.stringify(j));
  prelog.push(s); console.log(s);
} catch (e) {
  const s = '前置重置成员名单失败：' + (e && e.message);
  prelog.push(s); console.log(s);
}

const log = [];
const say = s => { log.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const errors = [], warns = [];
const fails = [];
function check(name, cond, detail) {
  const line = (cond ? 'PASS  ' : 'FAIL  ') + name + (cond || detail === undefined ? '' : ('  → ' + detail));
  say(line);
  if (!cond) fails.push(name + (detail === undefined ? '' : ' → ' + detail));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--window-size=${W},${H}`]
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });

page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error') errors.push('ERR: ' + m.text());
  else if (m.type() === 'warning') warns.push('WARN: ' + m.text().slice(0, 160));
});
page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url().slice(0, 100)));

// 记录所有 4xx/5xx 响应：用来定位缺失资源（漏引的脚本、favicon 等）
const badResponses = [];
page.on('response', r => {
  if (r.status() >= 400) badResponses.push(r.status() + '  ' + r.url().slice(0, 120));
});
page.on('dialog', d => d.accept().catch(() => { }));

// 追踪主框架导航与渲染进程崩溃：出现「frame detached」时用来判断到底发生了什么
const navs = [];
page.on('framenavigated', f => { if (f === page.mainFrame()) navs.push(f.url().slice(0, 100)); });
page.on('error', e => errors.push('PAGECRASH: ' + (e && e.message)));

// 外部请求计数：本工作台应当零外部依赖
let external = 0;
const externalUrls = [];
await page.setRequestInterception(true);
page.on('request', r => {
  const u = r.url();
  if (/^https?:/i.test(u) && !u.startsWith(ORIGIN)) {
    external++; externalUrls.push(u.slice(0, 120));
    return r.abort().catch(() => { });
  }
  return r.continue().catch(() => { });
});

/* ================= 1. 初始化 ================= */
say('=== 1. 初始化 ===');
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await sleep(3000);

const init = await page.evaluate(() => {
  const d = window.__hrwDebug;
  return {
    hasDebug: !!d,
    hasAuthScreen: !!document.getElementById('authScreen'),
    appVisible: !!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'),
    who: (document.getElementById('whoami') || {}).textContent || '',
    navCount: document.querySelectorAll('#nav button').length,
    summary: d ? d.summary() : null
  };
});
check('页面挂上自测句柄', init.hasDebug);
check('没有登录页', !init.hasAuthScreen);
check('主应用直接可见（无需登录）', init.appVisible);
check('侧栏显示本机磁盘存储而非账号', /本机磁盘存储/.test(init.who), init.who);
// 导航从 5 个变 6 个：新增了「成员管理」
check('六个导航入口齐全（含新增的成员管理）', init.navCount === 6, init.navCount);
check('四张表读取状态正常', init.summary && Object.values(init.summary.tables).every(t => t.state === 'ok'),
  JSON.stringify(init.summary && init.summary.tables));
check('首次进入即写入预置指标目录', init.summary && init.summary.tables.indicators.count >= 15,
  init.summary && init.summary.tables.indicators.count);

/* ================= 2. 零外部依赖 ================= */
check('未发起任何外部网络请求', external === 0, external ? externalUrls.join(' | ') : '0 个');

await page.screenshot({ path: OUT + '01-overview.png' });
say('');

/* ================= 3. 导入归档包 + 附件 ================= */
say('=== 3. 导入归档包与原始附件 ===');
await page.evaluate(() => document.querySelectorAll('#nav button')[2].click());   // 上传资料

// 解析桥要先跑一次 xParse CLI 自检，冷启动约 3~4 秒：轮询到探测出结果为止
// 上限给到 90 秒：实测在某些环境（多服务并发 / 机器繁忙）冷启动会明显超过 25 秒，
// 等待不足会把「环境慢」误报成「应用有 bug」。
let bridgeBox = null, waited = 0;
for (let i = 0; i < 90; i++) {
  await sleep(1000); waited++;
  bridgeBox = await page.evaluate(() => {
    const box = document.getElementById('parseBox');
    const btn = document.getElementById('btnParseUpload');
    return { text: box ? box.textContent.trim().slice(0, 90) : '', disabled: btn ? btn.disabled : null };
  });
  if (bridgeBox.text && bridgeBox.text.indexOf('正在检查') < 0) break;
}
say('解析桥状态（等待 ' + waited + ' 秒）：' + bridgeBox.text);
check('解析桥探测完成', bridgeBox.text.length > 0 && bridgeBox.text.indexOf('正在检查') < 0);
check('解析桥就绪时按钮可用', bridgeBox.disabled === false, String(bridgeBox.disabled));

await page.evaluate(() => document.getElementById('btnOpenImport').click());
await sleep(500);
const jsonInput = await page.$('#impJson');
const fileInput = await page.$('#impFiles');
check('归档抽屉出现文件选择框', !!jsonInput && !!fileInput);
await jsonInput.uploadFile(ROOT + 'archive-package-fixture-report.json');
await sleep(700);
const preview = await page.evaluate(() => (document.getElementById('impPreview') || {}).textContent || '');
check('归档包预览识别为 1 条记录', /共\s*1\s*条记录/.test(preview.replace(/\s+/g, ' ')), preview.slice(0, 90));

await fileInput.uploadFile(
  ROOT + '_fixtures/virtual-report-page1.png',
  ROOT + '_fixtures/virtual-report-page2.png',
  ROOT + '_fixtures/virtual-report-page3.png'
);
await sleep(600);
await page.screenshot({ path: OUT + '02-import-drawer.png' });

await page.evaluate(() => document.getElementById('btnImportSave').click());
await sleep(3500);
const afterImport = await page.evaluate(() => window.__hrwDebug.summary());
check('导入后健康档案 1 条', afterImport.tables.documents.count === 1, afterImport.tables.documents.count);

const rec = await page.evaluate(() => {
  const r = window.__hrwDebug.state.tables.documents.rows[0] || {};
  const a = r.source_attachments || [];
  return {
    type: r.document_type, date: r.primary_date, status: r.date_status, title: r.title,
    labs: ((r.type_specific_data || {}).lab_results || []).length,
    atts: a.length,
    attNames: a.map(x => x.name),
    attHasUrl: a.every(x => typeof x.path === 'string' && x.path.length > 0),
    hash: (r.file_hash || '').slice(0, 12)
  };
});
say('落库记录：' + JSON.stringify(rec));
check('记录类型与日期正确', rec.type === '检验报告' && rec.date === '2024-03-15', rec.type + '/' + rec.date);
check('三页合并为一条档案的三个附件', rec.atts === 3, rec.atts);
check('检验项已结构化（24 项）', rec.labs === 24, rec.labs);
check('每个附件都有本地存储键', rec.attHasUrl);
say('');

/* ================= 4. 刷新后数据仍在 ================= */
say('=== 4. 刷新后仍在（数据写在本机磁盘上）===');
await page.reload({ waitUntil: 'load' });
await sleep(2500);
const afterReload = await page.evaluate(() => window.__hrwDebug.summary());
check('刷新后健康档案仍为 1 条', afterReload.tables.documents.count === 1, afterReload.tables.documents.count);
const attAfterReload = await page.evaluate(() =>
  ((window.__hrwDebug.state.tables.documents.rows[0] || {}).source_attachments || []).length);
check('刷新后附件仍为 3 个', attAfterReload === 3, attAfterReload);
say('');

/* ---- 4.5 本次改造的核心承诺：清掉浏览器数据，档案依然在 ---- */
say('=== 4.5 清掉浏览器全部数据后，档案是否还在 ===');
const beforeWipe = await page.evaluate(async () => {
  const r = await fetch('/api/db/info', { cache: 'no-store' });
  return (await r.json()).info;
});
say('清理前磁盘状态：' + JSON.stringify({ counts: beforeWipe.counts, files: beforeWipe.files }));

// 模拟用户在浏览器设置里点「清除浏览数据」：删掉该站点在浏览器里的一切存储
const wiped = await page.evaluate(async () => {
  try {
    const dbs = (await indexedDB.databases()).map(d => d.name);
    await Promise.all(dbs.map(n => new Promise(res => {
      const req = indexedDB.deleteDatabase(n);
      req.onsuccess = req.onerror = req.onblocked = () => res(n);
    })));
    try { localStorage.clear(); } catch (e) { }
    try { sessionStorage.clear(); } catch (e) { }
    return { deleted: dbs };
  } catch (e) { return { error: e.message }; }
});
say('在浏览器内删除：' + JSON.stringify(wiped));

await page.reload({ waitUntil: 'load' });
await sleep(3200);
const afterWipe = await page.evaluate(() => {
  const s = window.__hrwDebug.summary();
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const withAtt = rows.filter(r => (r.source_attachments || []).length);
  return {
    count: s.tables.documents.count,
    catalog: s.tables.indicators.count,
    attOnRecord: withAtt.length ? withAtt[0].source_attachments.length : 0,
    firstTitle: (rows[0] || {}).title || null
  };
});
say('清完浏览器数据后页面读到的：' + JSON.stringify(afterWipe));
check('清掉浏览器数据后档案条数不变', afterWipe.count === 1, afterWipe.count);
check('清掉浏览器数据后预置指标目录仍在', afterWipe.catalog >= 15, afterWipe.catalog);
check('清掉浏览器数据后附件仍挂在记录上', afterWipe.attOnRecord === 3, afterWipe.attOnRecord);

const attAlive = await page.evaluate(async () => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const withAtt = rows.filter(r => (r.source_attachments || []).length);
  if (!withAtt.length) return { ok: false, why: '没有带附件的记录' };
  const u = await window.__hrwDebug.local.storage.createSignedUrl(withAtt[0].source_attachments[0].path);
  return { ok: !u.error && /^blob:/.test(u.data ? u.data.signedUrl : ''), err: u.error && u.error.message };
});
check('清掉浏览器数据后附件内容仍可读取', attAlive.ok, JSON.stringify(attAlive));

const diskAfterWipe = await page.evaluate(async () => {
  const r = await fetch('/api/db/info', { cache: 'no-store' });
  return (await r.json()).info;
});
check('数据目录位置不变', diskAfterWipe.data_dir === beforeWipe.data_dir, diskAfterWipe.data_dir);
check('磁盘上附件计数不变', diskAfterWipe.files === beforeWipe.files,
  beforeWipe.files + ' → ' + diskAfterWipe.files);
say('');

/* ================= 5. 详情层：附件预览与滚动位置 ================= */
say('=== 5. 详情层 ===');
await page.evaluate(() => document.querySelectorAll('#nav button')[1].click());   // 健康档案
await sleep(900);
await page.evaluate(() => { document.getElementById('main').scrollTop = 240; });
const scrollBefore = await page.evaluate(() => document.getElementById('main').scrollTop);

const opened = await page.evaluate(() => {
  const card = document.querySelector('#s-timeline [data-doc], #s-timeline .doc, #s-timeline .card');
  if (!card) return { clicked: false };
  card.click();
  return { clicked: true };
});
await sleep(2200);
const layer = await page.evaluate(() => {
  const el = document.getElementById('docLayer');
  const stage = document.getElementById('docStage');
  const img = stage ? stage.querySelector('img') : null;
  return {
    on: !!el && el.classList.contains('on'),
    scrollTop: el ? el.scrollTop : null,
    hasImg: !!img,
    imgSrc: img ? img.src.slice(0, 12) : '',
    bodyOverflow: document.body.style.overflow,
    title: (document.getElementById('docTitle') || {}).textContent || ''
  };
});
check('点击档案卡片打开了详情层', opened.clicked && layer.on, JSON.stringify(layer));
check('详情层从顶部开始（未沿用来源页滚动位置）', layer.scrollTop === 0, layer.scrollTop);
check('详情层滚动被锁在容器内', layer.bodyOverflow === 'hidden', layer.bodyOverflow);
check('原始附件以本地对象地址呈现', layer.hasImg && layer.imgSrc === 'blob:http://', layer.imgSrc);

// 切到第 2 张缩略图
await page.evaluate(() => {
  const th = document.querySelectorAll('#docThumbs .th');
  if (th[1]) th[1].click();
});
await sleep(1500);
const second = await page.evaluate(() => {
  const img = document.querySelector('#docStage img');
  return { src: img ? img.src.length : 0, active: document.querySelectorAll('#docThumbs .th.on').length };
});
check('多图可切换到第 2 张且高亮唯一', second.src > 0 && second.active === 1, JSON.stringify(second));
await page.screenshot({ path: OUT + '03-doc-detail.png' });

await page.evaluate(() => document.getElementById('docBack').click());
await sleep(700);
const afterBack = await page.evaluate(() => ({
  on: document.getElementById('docLayer').classList.contains('on'),
  main: document.getElementById('main').scrollTop,
  overflow: document.body.style.overflow
}));
check('返回后详情层关闭且滚动解锁', !afterBack.on && afterBack.overflow === '', JSON.stringify(afterBack));
check('返回后来源页滚动位置已恢复', Math.abs(afterBack.main - scrollBefore) <= 4,
  '前 ' + scrollBefore + ' → 后 ' + afterBack.main);
say('');

/* ================= 6. 窄屏侧栏 ================= */
say('=== 6. 窄屏侧栏 ===');
await page.setViewport({ width: 420, height: 780 });
await sleep(700);
const narrow = await page.evaluate(() => {
  const side = document.querySelector('.sidebar');
  const toggle = document.querySelector('.nav-toggle');
  const r = side.getBoundingClientRect();
  return {
    toggleShown: toggle ? getComputedStyle(toggle).display !== 'none' : false,
    sideLeft: Math.round(r.left), sideRight: Math.round(r.right),
    sideWidth: Math.round(r.width),
    mainWidth: Math.round(document.querySelector('.main').getBoundingClientRect().width)
  };
});
check('窄屏出现导航开关', narrow.toggleShown);
check('窄屏侧栏默认移出视口', narrow.sideRight <= 1, JSON.stringify(narrow));
check('窄屏主区占满宽度（不再被侧栏挤占）', narrow.mainWidth >= 410, narrow.mainWidth);

await page.evaluate(() => document.getElementById('btnSidebar').click());
await sleep(600);
const openedNav = await page.evaluate(() => ({
  open: document.getElementById('app').classList.contains('nav-open'),
  left: Math.round(document.querySelector('.sidebar').getBoundingClientRect().left),
  scrim: getComputedStyle(document.getElementById('scrim')).display
}));
check('点击开关侧栏滑入', openedNav.open && openedNav.left === 0, JSON.stringify(openedNav));
check('侧栏打开时出现遮罩', openedNav.scrim !== 'none', openedNav.scrim);
await page.screenshot({ path: OUT + '04-narrow-nav.png' });

await page.evaluate(() => document.querySelectorAll('#nav button')[0].click());
await sleep(700);
const closedNav = await page.evaluate(() => ({
  open: document.getElementById('app').classList.contains('nav-open'),
  view: window.__hrwDebug.state.view
}));
check('选中导航后侧栏自动收起', !closedNav.open);
check('导航切换生效', closedNav.view === 'overview', closedNav.view);
await page.setViewport({ width: W, height: H });
await sleep(500);
say('');

/* ================= 7. 超过 100 条的分页 ================= */
say('=== 7. 超过 100 条的分页读取 ===');
const bulk = await page.evaluate(async () => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({
      document_type: '检验报告',
      primary_date: '2023-' + String((i % 12) + 1).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0'),
      title: '压测记录 ' + (i + 1),
      parse_status: '已归档',
      source_attachments: [],
      type_specific_data: { lab_results: [], stress: true }
    });
  }
  const res = await window.__hrwDebug.local.database.from('documents').insert(rows).select();
  if (res.error) return { error: res.error.message };
  await window.__hrwDebug.reload();
  return { inserted: res.data.length, count: window.__hrwDebug.summary().tables.documents.count };
});
say('批量写入：' + JSON.stringify(bulk));
check('批量写入 120 条成功', bulk.inserted === 120, JSON.stringify(bulk));
check('分页读回全部 121 条（未在 100 条处截断）', bulk.count === 121, bulk.count);
say('');

/* ================= 8. 备份导出与恢复 ================= */
say('=== 8. 备份导出与恢复 ===');
const backup = await page.evaluate(async () => {
  const b = await window.__hrwDebug.local.exportBackup();
  return {
    schema: b.schema, counts: b.counts, fileCount: b.file_count,
    files: b.files.map(f => ({ n: f.name, size: f.size, b64: f.dataBase64.length })),
    bytes: JSON.stringify(b).length
  };
});
say('备份：' + JSON.stringify({ schema: backup.schema, counts: backup.counts, fileCount: backup.fileCount, bytes: backup.bytes }));
check('备份 schema 正确', backup.schema === 'health-records-local-backup/v2');
check('备份含全部四表计数', backup.counts.documents === 121 && backup.counts.indicators >= 15);
check('备份已内嵌 3 个附件数据', backup.fileCount === 3 && backup.files.every(f => f.b64 > 0));

const restore = await page.evaluate(async () => {
  const backupObj = await window.__hrwDebug.local.exportBackup();
  await window.__hrwDebug.local.clearAll();
  // 清空后要重新加载，页面里缓存的计数才会归零：与应用内「清空本机数据」的流程一致
  await window.__hrwDebug.reload();
  const afterClear = window.__hrwDebug.summary().tables.documents.count;
  const filesAfterClear = (await window.__hrwDebug.local.stats()).files;
  const r = await window.__hrwDebug.local.importBackup(backupObj);
  await window.__hrwDebug.reload();
  const st = await window.__hrwDebug.local.stats();
  return {
    afterClear, filesAfterClear, ok: r.ok, written: r.written, filesWritten: r.filesWritten,
    count: window.__hrwDebug.summary().tables.documents.count,
    files: st.files
  };
});
say('恢复：' + JSON.stringify(restore));
check('清空后四表计数归零', restore.afterClear === 0, restore.afterClear);
check('清空后附件也归零', restore.filesAfterClear === 0, restore.filesAfterClear);
check('恢复成功且条数与附件数一致', restore.ok && restore.count === 121 && restore.files === 3, JSON.stringify(restore));

// 附件在恢复后仍可读取
const restoredAtt = await page.evaluate(async () => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const withAtt = rows.filter(r => (r.source_attachments || []).length);
  if (!withAtt.length) return { n: 0 };
  const path = withAtt[0].source_attachments[0].path;
  const u = await window.__hrwDebug.local.storage.createSignedUrl(path);
  return { n: withAtt.length, url: u.data ? u.data.signedUrl.slice(0, 12) : null, err: u.error && u.error.message };
});
check('恢复后附件仍可读取', restoredAtt.url === 'blob:http://', JSON.stringify(restoredAtt));
say('');

/* ================= 9. 上传页与自检页 ================= */
say('=== 9. 上传页文案与数据落盘 ===');
await page.evaluate(() => document.querySelectorAll('#nav button')[2].click());
await sleep(1200);
const uploadInfo = await page.evaluate(() => {
  const t = document.getElementById('s-upload').textContent;
  return {
    hasDiskWording: t.indexOf('data') >= 0 && t.indexOf('清除浏览数据') >= 0,
    explainsPending: t.indexOf('已解析待结构化') >= 0,
    hasPathA: t.indexOf('本机解析：原始文件') >= 0,
    hasPathB: t.indexOf('结构化：原文') >= 0,
    stillMentionsCloud: t.indexOf('登录') >= 0 || t.indexOf('行级权限') >= 0,
    hasLlmCard: !!document.getElementById('btnLlmCfg'),
    hasParseLog: !!document.getElementById('parseLogBox'),
    dataDirShown: (t.match(/E:\\08-Codework[^\s<]*/) || [])[0] || null,
    dataDirRaw: (t.match(/目录[\s\S]{0,140}/) || [])[0] || null,
    hasApiSelect: !!document.getElementById('parseApi')
  };
});
check('上传页说明数据存在本机磁盘 data 目录', uploadInfo.hasDiskWording);
check('上传页讲清了「解析只出原文、字段还需结构化」', uploadInfo.explainsPending);
check('上传页给出两条录入路径', uploadInfo.hasPathA && uploadInfo.hasPathB);
check('上传页不再出现登录/行级权限表述', !uploadInfo.stillMentionsCloud);
check('上传页有结构化模型配置入口', uploadInfo.hasLlmCard);
check('上传页有解析记录区（可观测）', uploadInfo.hasParseLog);
check('上传页可选择解析通道', uploadInfo.hasApiSelect);
const serverDbg = await page.evaluate(() => {
  const s = window.__hrwDebug.summary();
  return {
    server: s.server ? { data_dir: s.server.data_dir, db_bytes: s.server.db_bytes } : null,
    codes: Array.prototype.slice.call(document.querySelectorAll('#s-upload code')).map(c => c.textContent)
  };
});
say('数据目录诊断：' + JSON.stringify(serverDbg));
check('页面显示出真实数据目录路径', !!uploadInfo.dataDirShown,
  String(uploadInfo.dataDirShown || uploadInfo.dataDirRaw));
await page.screenshot({ path: OUT + '05-upload.png', fullPage: false });

const disk1 = await page.evaluate(async () => {
  const r = await fetch('/api/db/info', { cache: 'no-store' });
  return (await r.json()).info;
});
say('磁盘状态：' + JSON.stringify({ dir: disk1.data_dir, db_bytes: disk1.db_bytes,
  counts: disk1.counts, files: disk1.files }));
check('health.db 已写入真实内容', disk1.db_bytes > 8192, disk1.db_bytes);
const pageCount1 = await page.evaluate(() => window.__hrwDebug.summary().tables.documents.count);
check('磁盘上的记录数与页面一致', disk1.counts.documents === pageCount1 && pageCount1 === 121,
  '磁盘 ' + disk1.counts.documents + ' vs 页面 ' + pageCount1);
check('附件以磁盘文件形式留存', disk1.files === 3, disk1.files);
say('');

/* ================= 10. 在线解析（全app唯一联网环节） ================= */
say('=== 10. 在线解析上传（唯一联网环节）===');
const countBeforeParse = (await page.evaluate(() => window.__hrwDebug.summary())).tables.documents.count;

// 上传页每次渲染都会重新探测本机解析接口，而探测要等一次 xParse CLI 自检（冷启动约 3~4 秒）。
// 按钮在探测出结果前保持禁用：这里先等到按钮真正可用，再去点它。
let puReady = false, puWait = 0;
for (let i = 0; i < 90; i++) {
  await sleep(1000); puWait++;
  puReady = await page.evaluate(() => {
    const b = document.getElementById('btnParseUpload');
    return !!b && b.disabled === false;
  });
  if (puReady) break;
}
check('解析按钮就绪（本机解析接口已探测）', puReady, '等待 ' + puWait + ' 秒');

const parseSel = await page.$('#parseFiles');
check('上传页提供解析文件选择框', !!parseSel);
await parseSel.uploadFile(ROOT + '_fixtures/virtual-receipt-2024-05-08.png');
await sleep(500);
const selectedMsg = await page.evaluate(() => (document.getElementById('parseMsg') || {}).textContent || '');
check('选择文件后给出已选提示', /已选择\s*1\s*个文件/.test(selectedMsg.replace(/\s+/g, ' ')), selectedMsg.slice(0, 80));

await page.evaluate(() => document.getElementById('btnParseUpload').click());

// 解析要真的调一次线上 xParse 并把原文取回来：轮询到归档抽屉弹出为止（最长 150 秒）
let parsed = null;
for (let i = 0; i < 100; i++) {
  await sleep(1500);
  try {
    parsed = await page.evaluate(() => {
      const dr = document.getElementById('drawer-import');
      const msg = document.getElementById('parseMsg');
      const sel = document.getElementById('presetType');
      const body = document.getElementById('importBody');
      return {
        open: !!dr && dr.classList.contains('on'),
        hasPresetSelect: !!sel,
        type: sel ? sel.value : null,
        msg: msg ? msg.textContent.replace(/\s+/g, ' ').slice(0, 160) : '',
        body: body ? body.textContent.replace(/\s+/g, ' ').slice(0, 160) : ''
      };
    });
  } catch (e) {
    say('轮询中断：' + e.message);
    say('  页面已关闭 = ' + page.isClosed() + '；主框架导航记录 = ' + JSON.stringify(navs));
    errors.push('POLLBROKE: ' + e.message);
    break;
  }
  if (parsed.open) break;
}
say('解析结果：' + JSON.stringify(parsed));
check('线上解析返回并弹出归档抽屉', parsed.open, parsed.msg || parsed.body);
check('解析草稿给出可确认的文档类型', parsed.hasPresetSelect, String(parsed.type));

const countDuringDraft = (await page.evaluate(() => window.__hrwDebug.summary())).tables.documents.count;
check('解析结果只进草稿、不自动写档案', countDuringDraft === countBeforeParse,
  countBeforeParse + ' → ' + countDuringDraft);
await page.screenshot({ path: OUT + '07-parse-draft.png' });

// 确认后写入：这条走的是「解析原文 + 原始附件」的完整归档链路
await page.evaluate(() => document.getElementById('btnImportSave').click());
await sleep(4500);
const afterParseSave = await page.evaluate(() => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  // 取主键最大的那条，确保验的是刚写进去的解析记录，而不是前面导入的档案
  const maxId = rows.reduce((a, r) => Math.max(a, r.id || 0), 0);
  const last = rows.filter(r => r.id === maxId)[0] || {};
  return {
    count: window.__hrwDebug.summary().tables.documents.count,
    id: maxId,
    textLen: (last.parsed_content || '').length,
    atts: (last.source_attachments || []).length,
    status: last.parse_status,
    type: last.document_type,
    textHead: (last.parsed_content || '').replace(/\s+/g, ' ').slice(0, 60)
  };
});
say('归档后：' + JSON.stringify(afterParseSave));
check('确认后写入 1 条档案', afterParseSave.count === countBeforeParse + 1,
  countBeforeParse + ' → ' + afterParseSave.count);
check('该条档案带回了线上解析原文', afterParseSave.textLen > 100, afterParseSave.textLen);
check('该条档案挂上了原始附件', afterParseSave.atts >= 1, afterParseSave.atts);
// 解析服务返回的文档名不带扩展名，这里只比对主干部分
check('解析记录的原文来自本次线上解析',
  afterParseSave.textHead.indexOf('virtual-receipt-2024-05-08') >= 0, afterParseSave.textHead);

/* ---- 10.5 解析结果可观测：内容有多少一眼能看到 ---- */
say('=== 10.5 解析记录（「内容偏少」第一次就能被看见）===');
const plog = await page.evaluate(async () => {
  const r = await fetch('/api/parse/log?limit=5', { cache: 'no-store' });
  return (await r.json()).entries;
});
say('解析日志：' + JSON.stringify((plog[0] || {}).files || []) + ' 字数=' + ((plog[0] || {}).total_chars));
check('解析日志已落盘', plog.length >= 1 && plog[0].ok === true, JSON.stringify(plog[0] || {}));
check('日志含文件名与返回字数',
  ((plog[0] || {}).files || []).length >= 1 && typeof (plog[0] || {}).total_chars === 'number',
  JSON.stringify(plog[0] || {}));

const logRendered = await page.evaluate(() => {
  const b = document.getElementById('parseLogBox');
  return b ? b.textContent.replace(/\s+/g, ' ') : null;
});
check('页面上能直接看到这次解析的文件名与字数',
  !!logRendered && logRendered.indexOf('virtual-receipt') >= 0 && /返回\s*\d+\s*字/.test(logRendered),
  String(logRendered).slice(0, 200));

/* ---- 10.6 结构化入口与模型未配置时的表现 ---- */
say('=== 10.6 智能结构化入口 ===');
const structTarget = await page.evaluate(() => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  return rows.reduce((a, r) => Math.max(a, r.id || 0), 0);
});
await page.evaluate((id) => window.__hrwDebug.openDoc(id, '自测'), structTarget);
await sleep(1000);
const structBtn = await page.evaluate(() => {
  const b = document.getElementById('btnStructOpen');
  const layerOn = document.getElementById('docLayer').classList.contains('on');
  return { has: !!b, label: b ? b.textContent.trim() : '', layerOn };
});
check('打开刚解析的档案详情', structBtn.layerOn);
check('详情页对已解析记录给出「智能结构化」入口', structBtn.has && /结构化/.test(structBtn.label),
  JSON.stringify(structBtn));

const structDrawer = await page.evaluate(async () => {
  document.getElementById('btnStructOpen').click();
  await new Promise(r => setTimeout(r, 400));
  const dr = document.getElementById('drawer-struct');
  return {
    open: dr.classList.contains('on'),
    text: dr.textContent.replace(/\s+/g, ' ').slice(0, 240)
  };
});
check('点击后打开结构化抽屉', structDrawer.open, structDrawer.text);
check('未配置模型时，方式一如实说明需要配置（不给假成功）',
  structDrawer.text.indexOf('还没有配置模型服务') >= 0, structDrawer.text);
check('同屏给出替代路径：不配置密钥也能用的方式二',
  structDrawer.text.indexOf('方式二') >= 0, structDrawer.text);
await page.screenshot({ path: OUT + '08-struct.png' });

await page.evaluate(() => {
  const dr = document.getElementById('drawer-struct');
  const b = dr && dr.querySelector('[data-close]');
  if (b) b.click();
});
await sleep(400);
say('');

/* ---- 10.7 手动中转：不配置密钥、不调用任何外部接口 ----
   验证「复制提示词 + 原文 → 贴给外部模型 → 把 JSON 贴回来 → 确认写入」整条链路。
   全程只与 127.0.0.1 通信，模型这一环由脚本用一段模拟 JSON 代替。 */
say('=== 10.7 手动中转结构化（不需要密钥）===');

const handOpen = await page.evaluate(async (id) => {
  window.__hrwDebug.openDoc(id, '自测');
  await new Promise(r => setTimeout(r, 500));
  const b = document.getElementById('btnStructOpen');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 400));
  const dr = document.getElementById('drawer-struct');
  return {
    open: dr.classList.contains('on'),
    hasPack: !!document.getElementById('btnStructPack'),
    hasPaste: !!document.getElementById('structPaste'),
    hasAdopt: !!document.getElementById('btnStructAdopt'),
    text: dr.textContent.replace(/\s+/g, ' ').slice(0, 420)
  };
}, structTarget);
check('未配置模型时，抽屉里仍然给出「手动中转」三个按钮',
  handOpen.open && handOpen.hasPack && handOpen.hasPaste && handOpen.hasAdopt,
  JSON.stringify(handOpen).slice(0, 220));
check('抽屉里写明不需要密钥、且会先在本机脱敏',
  handOpen.text.indexOf('不需要密钥') >= 0 && handOpen.text.indexOf('去掉姓名') >= 0,
  handOpen.text);

const packed = await page.evaluate(async () => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const id = rows.reduce((a, r) => Math.max(a, r.id || 0), 0);
  const rec = rows.find(x => String(x.id) === String(id));
  const raw = String((rec && rec.parsed_content) || '');
  document.getElementById('btnStructPack').click();
  await new Promise(r => setTimeout(r, 1600));
  const box = document.getElementById('structPackText');
  const msg = document.getElementById('structMsg');
  const prompt = box ? box.value : '';
  const flat = prompt.replace(/\s+/g, '');
  const probe = raw.replace(/\s+/g, '').slice(0, 10);
  return {
    len: prompt.length,
    hasInstruction: prompt.indexOf('医疗文档结构化提取器') >= 0,
    hasDocSection: prompt.indexOf('===== 待处理文档 =====') >= 0,
    hasJsonOnly: prompt.indexOf('只输出 JSON') >= 0,
    carriesSource: probe.length >= 6 && flat.indexOf(probe) >= 0,
    probe,
    msg: msg ? msg.textContent.replace(/\s+/g, ' ').slice(0, 260) : ''
  };
});
check('点「复制提示词 + 原文」后生成了可粘贴的完整文本',
  packed.len > 500 && packed.hasInstruction && packed.hasDocSection && packed.hasJsonOnly,
  'len=' + packed.len + ' | ' + JSON.stringify(packed).slice(0, 200));
check('待复制文本里带上了这条记录的解析原文', packed.carriesSource,
  'probe=' + packed.probe + ' len=' + packed.len);
check('页面如实反馈复制结果与脱敏字数',
  /已复制|不允许自动复制/.test(packed.msg) && /脱敏后\s*\d+\s*字/.test(packed.msg), packed.msg);

const adopted = await page.evaluate(async () => {
  const mock = JSON.stringify({
    document_type: '医疗发票/收费单',
    primary_date: '2025-11-08',
    title: '门诊收费单（自测模拟）',
    amount: 128.5,
    hospital: '示例医院',
    key_information: '本条内容由自测脚本注入，用于验证手动中转通道。',
    lab_results: [{ name: '示例项目', result: '12.3', unit: 'mmol/L', reference: '3.9-6.1', flag: null, condition: null }],
    charge_items: [{ name: '诊查费', unit_price: 20, qty: 1, amount: 20, insurance_class: '甲类' }],
    total_amount: 128.5,
    diagnosis: [],
    date_candidates: ['2025-11-08'],
    extraction_notes: null
  });
  document.getElementById('structPaste').value = mock;
  document.getElementById('btnStructAdopt').click();
  await new Promise(r => setTimeout(r, 1400));
  const out = document.getElementById('structOut');
  const t = out ? out.textContent.replace(/\s+/g, ' ') : '';
  return {
    rendered: t.slice(0, 300),
    hasApply: !!document.getElementById('btnStructApply'),
    hasLab: t.indexOf('检验/检查项目 1 项') >= 0,
    hasCharge: t.indexOf('收费明细 1 项') >= 0,
    hasOrigin: t.indexOf('已解析粘贴的模型输出') >= 0
  };
});
check('粘贴模型返回的 JSON 后解析出预览，并给出确认写入按钮', adopted.hasApply, adopted.rendered);
check('预览里列出了检验项', adopted.hasLab, adopted.rendered);
check('预览里列出了收费明细', adopted.hasCharge, adopted.rendered);
check('预览里如实标注来源是粘贴解析（手动中转）', adopted.hasOrigin, adopted.rendered);
await page.screenshot({ path: OUT + '09-manual-bridge.png' });

const applied = await page.evaluate(async () => {
  // 这条档案在解析归档时已经带上过类型与猜测日期，所以模型这次给的值属于冲突：
  // 默认保留档案上已有的值，要采用模型的必须逐条显式选。
  const box = document.getElementById('structConflicts');
  const cf = box ? Array.prototype.map.call(box.querySelectorAll('select[data-conflict]'),
    s => s.getAttribute('data-conflict')) : [];
  const defaultsHuman = box ? Array.prototype.map.call(box.querySelectorAll('select[data-conflict]'),
    s => s.value).every(v => v === 'human') : true;
  if (box) box.querySelectorAll('select[data-conflict]').forEach(s => {
    s.value = 'model'; s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const b = document.getElementById('btnStructApply');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 1800));
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const id = rows.reduce((a, r) => Math.max(a, r.id || 0), 0);
  const rec = rows.find(x => String(x.id) === String(id));
  const tsd = (rec && rec.type_specific_data) || {};
  return {
    status: rec ? rec.parse_status : '',
    type: rec ? rec.document_type : '',
    date: rec ? rec.primary_date : '',
    amount: rec ? rec.amount : null,
    structuredBy: tsd.structured_by || '',
    structured: tsd.structured === true,
    labCount: (tsd.lab_results || []).length,
    chargeCount: (tsd.charge_items || []).length,
    cf: cf, defaultsHuman: defaultsHuman
  };
});
check('手动中转写入时也给出了冲突清单，且默认保留档案上已有的值',
  applied.cf.length >= 1 && applied.defaultsHuman === true, JSON.stringify(applied.cf));
check('确认写入后解析状态变为「已归档」', applied.status === '已归档', JSON.stringify(applied));
check('文档类型与主日期按粘贴内容写入',
  applied.type === '医疗发票/收费单' && applied.date === '2025-11-08', JSON.stringify(applied));
check('检验项与收费明细落到 type_specific_data',
  applied.structured && applied.labCount === 1 && applied.chargeCount === 1, JSON.stringify(applied));
check('结构化来源如实记为「手动中转」', applied.structuredBy.indexOf('手动中转') >= 0, applied.structuredBy);
check('金额写入档案', applied.amount === 128.5, String(applied.amount));
say('');

/* ---- 10.8 成员配置：归档归属 · 列表筛选 · 成员管理 ----
   这是「按人归档和筛选」的核心承诺，必须端到端验出来，不能只验数据层。 */
say('=== 10.8 成员配置（按人归档与筛选）===');

const personsHome = await page.evaluate(async () => {
  const nav = document.getElementById('navPersons');
  const visible = nav && getComputedStyle(nav).display !== 'none';
  window.__hrwDebug.go('persons');
  await new Promise(r => setTimeout(r, 600));
  const box = document.getElementById('s-persons');
  return {
    state: window.__hrwDebug.personState(),
    count: window.__hrwDebug.persons().length,
    names: window.__hrwDebug.persons().map(p => p.name),
    navVisible: visible,
    text: box ? box.textContent.replace(/\s+/g, ' ').slice(0, 300) : ''
  };
});
check('成员名单读取成功且预置 6 人（我/老婆/儿子/爸爸/妈妈/丈母娘）',
  personsHome.state === 'ok' && personsHome.count === 6 &&
  personsHome.names.join('/') === '我/老婆/儿子/爸爸/妈妈/丈母娘', JSON.stringify(personsHome));
check('侧栏出现「成员管理」入口', personsHome.navVisible, personsHome.navVisible);

// 每条记录在处理前先记下待处理数：批量归属要用到
const beforeN = await page.evaluate(() =>
  window.__hrwDebug.state.tables.documents.rows.filter(
    r => r.person_id === null || r.person_id === undefined || r.person_id === '').length);
say('处理前未指定归属的档案数：' + beforeN);
check('页面上如实显示了待归属数量',
  beforeN > 0 && personsHome.text.indexOf(String(beforeN)) >= 0, personsHome.text);

// 改名：改了要真生效，其他页面的标签也要跟着变
const renamed = await page.evaluate(async () => {
  const inp = document.querySelector('[data-person-name="3"]');
  if (!inp) return { ok: false, why: '找不到成员 3 的输入框' };
  inp.value = '仔仔';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const save = document.querySelector('[data-person-save="3"]');
  if (!save) return { ok: false, why: '没有出现「保存改名」按钮' };
  save.click();
  await new Promise(r => setTimeout(r, 1200));
  return {
    ok: true,
    names: window.__hrwDebug.persons().map(p => p.name),
    text: document.getElementById('s-persons').textContent.replace(/\s+/g, ' ').slice(0, 260)
  };
});
check('改名后名单立即生效（儿子 → 仔仔）',
  renamed.ok && renamed.names.indexOf('仔仔') >= 0, JSON.stringify(renamed));
check('改名给出可核对的反馈', renamed.ok && renamed.text.indexOf('仔仔') >= 0, renamed.text);

// 改回来，避免影响后面的断言
await page.evaluate(async () => {
  const inp = document.querySelector('[data-person-name="3"]');
  inp.value = '儿子';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  document.querySelector('[data-person-save="3"]').click();
  await new Promise(r => setTimeout(r, 1000));
});

// 重名必须被拦下：同名会让归档时根本分不清是谁的
const dupName = await page.evaluate(async () => {
  const inp = document.getElementById('psNewName');
  inp.value = '老婆';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('psAdd').click();
  await new Promise(r => setTimeout(r, 1200));
  return {
    count: window.__hrwDebug.persons().length,
    text: document.getElementById('s-persons').textContent.replace(/\s+/g, ' ').slice(0, 300)
  };
});
check('添加同名成员被拒绝，名单没有变多', dupName.count === 6, JSON.stringify(dupName));
check('重名时给出明确原因而不是泛泛说失败',
  dupName.text.indexOf('同名') >= 0, dupName.text);

// 新增 + 二次确认删除
const addDel = await page.evaluate(async () => {
  const inp = document.getElementById('psNewName');
  inp.value = '女儿';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('psAdd').click();
  await new Promise(r => setTimeout(r, 1200));
  const after = window.__hrwDebug.persons().length;
  const newId = window.__hrwDebug.persons().find(p => p.name === '女儿').id;

  // 第一次点击只是进入确认态，不应真的删掉
  document.querySelector('[data-person-del="' + newId + '"]').click();
  await new Promise(r => setTimeout(r, 500));
  const stillThere = window.__hrwDebug.persons().length === after;
  const confirmShown = !!document.querySelector('[data-person-del-confirm="' + newId + '"]');
  const warned = document.getElementById('s-persons').textContent.indexOf('确认删除') >= 0;

  document.querySelector('[data-person-del-confirm="' + newId + '"]').click();
  await new Promise(r => setTimeout(r, 1200));
  return { added: after, stillThere, confirmShown, warned,
    final: window.__hrwDebug.persons().length };
});
check('可以添加新成员', addDel.added === 7, JSON.stringify(addDel));
check('删除要点第二次才生效（不误删）', addDel.stillThere && addDel.confirmShown, JSON.stringify(addDel));
check('删除前把后果说明白', addDel.warned, JSON.stringify(addDel));
check('确认后成员真的被删除', addDel.final === 6, JSON.stringify(addDel));

// 归档时选成员：写入的记录必须真的带上归属
const archivedWithPerson = await page.evaluate(async () => {
  const before = window.__hrwDebug.state.tables.documents.rows.length;
  window.__hrwDebug.openImportDrawer(null, {
    files: [],
    payload: {
      target: 'documents',
      records: [{
        document_type: '检验报告', primary_date: '2026-01-15', date_status: '已确认',
        title: '成员的指定归档（自测）', source_file: 'selftest-person.txt',
        source_attachments: [], type_specific_data: {}, parse_status: null,
        file_hash: 'selftest-person-' + Date.now()
      }]
    }
  });
  await new Promise(r => setTimeout(r, 700));
  const sel = document.getElementById('impPerson');
  const defaultVal = sel ? sel.value : '';
  const options = sel ? Array.from(sel.options).map(o => o.text) : [];
  sel.value = '2';                     // 老婆
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  document.getElementById('btnImportSave').click();
  await new Promise(r => setTimeout(r, 2600));
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const hit = rows.filter(r => String(r.title) === '成员的指定归档（自测）');
  return {
    before, after: rows.length, hit: hit.length,
    personId: hit.length ? hit[0].person_id : null,
    defaultVal, options
  };
});
check('归档抽屉里有「归属成员」选择器',
  archivedWithPerson.options.length === 6, JSON.stringify(archivedWithPerson.options));
check('选择器默认落在「我」', archivedWithPerson.defaultVal === '1', archivedWithPerson.defaultVal);
check('选择老婆后写入成功', archivedWithPerson.after === archivedWithPerson.before + 1,
  JSON.stringify(archivedWithPerson));
check('写入的记录真的带上了 person_id=2（老婆）',
  archivedWithPerson.personId === 2, JSON.stringify(archivedWithPerson));

// 健康档案页：成员标签 + 按成员筛选
const tlFilter = await page.evaluate(async () => {
  window.__hrwDebug.go('timeline');
  await new Promise(r => setTimeout(r, 800));
  const sel = document.getElementById('tlPerson');
  const hasSel = !!sel;
  const opts = sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.text })) : [];
  // ⚠️ 不能用「数 DOM 卡片」来判断筛掉了多少：时间轴默认只展开最近 10 个日期组，
  // 更早的按月折叠，折叠部分根本没有 [data-doc] 节点。筛选前后折叠范围还会变，
  // 于是出现过「未指定 14 条 > 全部 13 条」这种反直觉的假失败。
  // 筛选条里的「命中 X / Y 份」是对全量记录统计的，用它才准。
  const hitCount = () => {
    const el = document.querySelector('#s-timeline .filters .muted');
    if (!el) return -1;
    const m = String(el.textContent).match(/命中\s*(\d+)\s*\/\s*(\d+)/);
    return m ? Number(m[1]) : -1;
  };
  const bodyBefore = hitCount();
  const tagged = document.querySelectorAll('#s-timeline .person-tag').length;

  sel.value = '2';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  const cardsNow = Array.from(document.querySelectorAll('#s-timeline [data-doc]')).length;
  const titlesNow = Array.from(document.querySelectorAll('#s-timeline [data-doc] .tt'))
    .map(e => e.textContent);
  const spouseHit = hitCount();

  // 再看「未指定」，应当把所有没有归属的老档案都挑出来
  sel.value = '__none__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  const noneNow = hitCount();

  return { hasSel, opts, bodyBefore, tagged, cardsNow, titlesNow, noneNow, spouseHit };
});
check('健康档案页出现成员筛选下拉',
  tlFilter.hasSel && tlFilter.opts.some(o => o.t === '老婆'), JSON.stringify(tlFilter.opts));
check('卡片上显示了成员标签', tlFilter.tagged > 0, tlFilter.tagged);
check('按「老婆」筛选后只剩她的档案',
  tlFilter.cardsNow === 1 && tlFilter.titlesNow[0].indexOf('成员的指定归档') >= 0,
  JSON.stringify({ n: tlFilter.cardsNow, titles: tlFilter.titlesNow }));
check('「未指定」能把没有归属的老人档案单独挑出来',
  tlFilter.noneNow > 0 && tlFilter.noneNow < tlFilter.bodyBefore,
  JSON.stringify({ none: tlFilter.noneNow, all: tlFilter.bodyBefore }));
check('筛选命中的是「老婆」那一份（与筛选条数字一致）',
  tlFilter.spouseHit === 1,
  JSON.stringify({ spouseHit: tlFilter.spouseHit, cards: tlFilter.cardsNow }));

// 原始资料档案页同样支持筛选
const arFilter = await page.evaluate(async () => {
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 800));
  const sel = document.getElementById('arPerson');
  if (!sel) return { ok: false };
  sel.value = '2';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  const rows = document.querySelectorAll('#s-archive [data-doc]').length;
  const tagged = document.querySelectorAll('#s-archive .person-tag').length;
  return { ok: true, rows, tagged };
});
check('原始资料档案页也能按成员筛选',
  arFilter.ok && arFilter.rows === 1 && arFilter.tagged === 1, JSON.stringify(arFilter));

// 详情页显示归属成员
const detailPerson = await page.evaluate(async () => {
  const hit = window.__hrwDebug.state.tables.documents.rows
    .find(r => String(r.title) === '成员的指定归档（自测）');
  window.__hrwDebug.openDoc(hit.id, '自测');
  await new Promise(r => setTimeout(r, 700));
  const txt = document.getElementById('docBody').textContent.replace(/\s+/g, ' ');
  return { hasField: txt.indexOf('归属成员') >= 0, name: txt.indexOf('老婆') >= 0, txt: txt.slice(0, 200) };
});
check('详情页给出「归属成员」并有值',
  detailPerson.hasField && detailPerson.name, JSON.stringify(detailPerson));

await page.evaluate(async () => { window.__hrwDebug.go('persons'); });
await sleep(900);
const batch = await page.evaluate(async () => {
  const txtBefore = document.getElementById('s-persons').textContent.replace(/\s+/g, ' ');
  const sel = document.getElementById('psAssignTo');
  const has = !!sel;
  if (!has) return { has };
  sel.value = '1';
  document.getElementById('psAssign').click();
  await new Promise(r => setTimeout(r, 500));
  const confirmShown = !!document.getElementById('psAssignConfirm');
  document.getElementById('psAssignConfirm').click();
  await new Promise(r => setTimeout(r, 2600));
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const unassigned = rows.filter(r => r.person_id === null || r.person_id === undefined || r.person_id === '').length;
  return {
    has, confirmShown, unassigned, total: rows.length,
    byMe: rows.filter(r => Number(r.person_id) === 1).length,
    bySpouse: rows.filter(r => Number(r.person_id) === 2).length,
    txtBefore: txtBefore.slice(0, 220)
  };
});
check('批量归属需要二次确认', batch.has && batch.confirmShown, JSON.stringify(batch));
check('批量归属后没有「未指定」档案了', batch.unassigned === 0, JSON.stringify(batch));
check('原有归属（老婆 1 份）没被批量操作改动', batch.bySpouse === 1, JSON.stringify(batch));
check('其余档案全部归到「我」', batch.byMe === batch.total - 1, JSON.stringify(batch));

// 备份必须带上成员名单，否则档案回来了、人却没了
const backupWithPersons = await page.evaluate(async () => {
  const b = await window.__hrwDebug.local.exportBackup();
  return {
    hasMeta: !!(b.meta && b.meta.persons),
    personCount: (b.meta && b.meta.persons) ? b.meta.persons.length : 0,
    names: (b.meta && b.meta.persons) ? b.meta.persons.map(p => p.name) : []
  };
});
check('导出的备份里带上成员名单',
  backupWithPersons.hasMeta && backupWithPersons.personCount === 6,
  JSON.stringify(backupWithPersons));

// 删除成员必须兑现页面文案的承诺：名下档案留下来、改为「未指定」。
// 只删名单不解除归属的话，档案会挂着一个已不存在的成员 id，标签与筛选都会空白。
const delCascade = await page.evaluate(async () => {
  const before = window.__hrwDebug.state.tables.documents.rows;
  const beforeMine = before.filter(r => Number(r.person_id) === 2).length;
  window.__hrwDebug.go('persons');
  await new Promise(r => setTimeout(r, 800));
  const btn = document.querySelector('#s-persons [data-person-del="2"]');
  if (!btn) return { ok: false, why: 'no-del-btn' };
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  const cf = document.querySelector('#s-persons [data-person-del-confirm="2"]');
  if (!cf) return { ok: false, why: 'no-confirm-btn' };
  cf.click();
  await new Promise(r => setTimeout(r, 2600));
  const rows = window.__hrwDebug.state.tables.documents.rows;
  return {
    ok: true, beforeMine,
    stillMine: rows.filter(r => Number(r.person_id) === 2).length,
    unassigned: rows.filter(r => r.person_id === null || r.person_id === undefined || r.person_id === '').length,
    personsNow: (window.__hrwDebug.state.persons || []).length
  };
});
check('删除成员后，名下档案改为「未指定」而不是悬空引用',
  delCascade.ok && delCascade.beforeMine === 1 &&
  delCascade.stillMine === 0 && delCascade.unassigned === 1,
  JSON.stringify(delCascade));
await page.screenshot({ path: OUT + '10-persons.png' });
say('');

/* ---- 10.9 删除原始资料档案 ----
   删除是唯一会动磁盘上原件的操作，两条红线：
   ① 删之前必须有快照（快照内嵌附件 base64，是唯一的回退路径）；
   ② 只回收「不再被任何记录引用」的附件 —— 同一张图可能被两条档案共用。 */
say('=== 10.9 删除原始资料档案（含附件回收）===');

// 服务端文件的真相只能问服务端：404 = 登记与文件都没了，200 = 还在
const fileGone = async p => {
  try {
    const r = await fetch(BASE + 'api/files/get?path=' + encodeURIComponent(p));
    return r.status === 404;
  } catch (e) { return false; }
};
const serverRows = async () => {
  const r = await fetch(BASE + 'api/db/rows?table=documents');
  return (await r.json()).rows || [];
};

const delCase = await page.evaluate(async () => {
  try {
    const D = window.__hrwDebug.local;
    const mkFile = (p, n) => new File(['fixture-' + p], n, { type: 'application/pdf' });
    for (const p of [['attachments/solo.pdf', 'solo.pdf'], ['attachments/shared.pdf', 'shared.pdf']]) {
      const up = await D.storage.upload(p[0], mkFile(p[0], p[1]), { contentType: 'application/pdf' });
      if (up.error) return { ok: false, why: 'upload: ' + up.error.message };
    }
    const ins = async (title, paths) => {
      const r = await D.database.from('documents').insert({
        document_type: '体检报告', title: title, primary_date: '2024-01-05',
        date_status: '已确认', person_id: 1, hospital: '虚构医院',
        source_attachments: paths.map(p => ({
          name: p.split('/').pop(), path: p, mime_type: 'application/pdf', size: 12
        }))
      }).select();
      if (r.error) throw new Error('insert: ' + r.error.message);
      return r.data[0].id;
    };
    const solo = await ins('删除用例·独占附件', ['attachments/solo.pdf']);
    const sh1 = await ins('删除用例·共用附件甲', ['attachments/shared.pdf']);
    const sh2 = await ins('删除用例·共用附件乙', ['attachments/shared.pdf']);
    // 门面的 insert 只更新数据层缓存；页面渲染读的是 S.tables，
    // 真实导入流程末尾会 loadTable，夹具同样得走这一步才有可比对的 DOM。
    // id 一律按标题回读服务端真正存进去的那个，不拿本地预分配的号去比。
    await window.__hrwDebug.reload();
    const rows = window.__hrwDebug.state.tables.documents.rows;
    const byTitle = t => { const r = rows.find(x => x.title === t); return r ? r.id : null; };
    return {
      ok: true, solo: byTitle('删除用例·独占附件'),
      sh1: byTitle('删除用例·共用附件甲'), sh2: byTitle('删除用例·共用附件乙')
    };
  } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
});
check('夹具就位：3 条受控档案 + 2 个附件', delCase.ok === true, delCase.why);
check('夹具附件确实落到了服务端', !!(await fileGone('attachments/solo.pdf') === false
  && await fileGone('attachments/shared.pdf') === false));

await page.evaluate(async () => {
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 800));
  // 10.8 的筛选用例把「按成员筛选」留在了「老婆」上，不清掉会把本节的夹具全过滤掉。
  // 走真实的清空按钮，顺带验证它确实能用。
  const c = document.getElementById('arClear');
  if (c) c.click();
  await new Promise(r => setTimeout(r, 700));
});
const delUi = await page.evaluate(id => ({
  hasBtn: !!document.querySelector('#s-archive [data-del="' + id + '"]'),
  rowBefore: !!document.querySelector('#s-archive [data-doc="' + id + '"]')
}), delCase.solo);
check('原始资料档案的每行给出删除入口', delUi.hasBtn && delUi.rowBefore, JSON.stringify(delUi));

// 第一次点击只进入确认态，绝不能直接删
const firstClick = await page.evaluate(async id => {
  const b = document.querySelector('#s-archive [data-del="' + id + '"]');
  if (!b) return { ok: false, why: 'no-btn' };
  b.click();
  await new Promise(r => setTimeout(r, 500));
  return {
    ok: true,
    confirmShown: !!document.querySelector('#s-archive [data-del-confirm="' + id + '"]'),
    stillThere: !!document.querySelector('#s-archive [data-doc="' + id + '"]'),
    warn: (document.getElementById('s-archive').textContent.match(/快照|原件/g) || []).length
  };
}, delCase.solo);
check('第一次点击不删，只出现「确认删除」',
  firstClick.ok && firstClick.confirmShown && firstClick.stillThere, JSON.stringify(firstClick));
check('确认提示里讲清后果（原件与快照）', firstClick.warn >= 1, JSON.stringify(firstClick));

const secondClick = await page.evaluate(async id => {
  const rowsBefore = document.querySelectorAll('#s-archive [data-doc]').length;
  const c = document.querySelector('#s-archive [data-del-confirm="' + id + '"]');
  if (!c) return { ok: false, why: 'no-confirm' };
  c.click();
  await new Promise(r => setTimeout(r, 2600));
  return {
    ok: true, rowsBefore, rowsAfter: document.querySelectorAll('#s-archive [data-doc]').length,
    gone: !document.querySelector('#s-archive [data-doc="' + id + '"]'),
    msg: (document.getElementById('arMsg') || {}).textContent || ''
  };
}, delCase.solo);
check('确认后该行从列表消失，且条数 -1',
  secondClick.ok && secondClick.gone && secondClick.rowsAfter === secondClick.rowsBefore - 1,
  JSON.stringify(secondClick));
check('删除反馈里报出快照名，用户才知道删错了去哪回退',
  String(secondClick.msg).indexOf('snap-') >= 0, JSON.stringify(secondClick.msg));

const afterSolo = await serverRows();
check('服务端 SQLite 里也真的删掉了（不是只改了页面缓存）',
  !afterSolo.some(r => Number(r.id) === Number(delCase.solo)));
check('共用附件的两条档案没被牵连',
  afterSolo.filter(r => r.title && r.title.indexOf('共用附件') >= 0).length === 2, String(afterSolo.length));
check('独占附件的文件被回收了', await fileGone('attachments/solo.pdf'));

const snaps = await (await fetch(BASE + 'api/db/snapshots')).json();
check('删除前自动打了 before-delete 快照',
  (snaps.snapshots || []).some(s => String(s.name || s).indexOf('delete') >= 0),
  JSON.stringify((snaps.snapshots || []).slice(-3)));

// 共用附件：删掉甲，乙还引用着，文件必须留下
const delById = async id => page.evaluate(async i => {
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 700));
  const b = document.querySelector('#s-archive [data-del="' + i + '"]');
  if (!b) return { ok: false, why: 'no-btn' };
  b.click();
  await new Promise(r => setTimeout(r, 400));
  const c = document.querySelector('#s-archive [data-del-confirm="' + i + '"]');
  if (!c) return { ok: false, why: 'no-confirm' };
  c.click();
  await new Promise(r => setTimeout(r, 2600));
  return {
    ok: true, gone: !document.querySelector('#s-archive [data-doc="' + i + '"]'),
    msg: (document.getElementById('arMsg') || {}).textContent || ''
  };
}, id);

const shOne = await delById(delCase.sh1);
check('删除共用附件的第一条（行真的消失了，且没报失败）',
  shOne.ok === true && shOne.gone === true && shOne.msg.indexOf('失败') < 0, JSON.stringify(shOne));
check('另一条还在引用，附件文件必须保留', !await fileGone('attachments/shared.pdf'));
check('页面上如实说明了文件因共用而保留',
  shOne.msg.indexOf('共用') >= 0 || shOne.msg.indexOf('引用') >= 0, shOne.msg);

const shTwo = await delById(delCase.sh2);
const metaAfter = await (await fetch(BASE + 'api/files/meta')).json();
check('删除共用附件的第二条',
  shTwo.ok === true && shTwo.gone === true && shTwo.msg.indexOf('失败') < 0, JSON.stringify(shTwo));
check('最后一个引用也删掉后附件才被回收',
  shTwo.ok === true && await fileGone('attachments/shared.pdf'), JSON.stringify(shTwo));
check('files 登记与磁盘保持一致（没留下孤儿登记）',
  (metaAfter.files || []).every(f => !String(f.path).startsWith('attachments/solo')
    && !String(f.path).startsWith('attachments/shared')),
  JSON.stringify((metaAfter.files || []).map(f => f.path).filter(p => p.indexOf('attach') >= 0).slice(0, 8)));
await page.screenshot({ path: OUT + '11-delete.png' });
say('');

/* ---- 10.10 单个改派成员 ----
   批量归属只动「未指定」的档案；已经归错人的只能逐条改，这之前没有入口。 */
say('=== 10.10 健康档案重新分配成员 ===');

const reassign = await page.evaluate(async () => {
  // 10.9 把三条受控档案都删干净了，这里另起一条只用于改派，两节互不依赖
  // cloud = 数据层门面（读写存储）；__hrwDebug = 页面调试句柄（状态与视图动作）。
  // 这两者别混用：门面上没有 state / openDoc。
  const cloud = window.__hrwDebug.local;
  const dbg = window.__hrwDebug;
  const ins = await cloud.database.from('documents').insert({
    document_type: '体检报告', title: '改派用例', primary_date: '2024-02-02',
    date_status: '已确认', person_id: 1, source_attachments: []
  }).select();
  if (ins.error) return { ok: false, why: 'insert: ' + ins.error.message };
  await dbg.reload();
  const rows = dbg.state.tables.documents.rows;
  const mine = rows.filter(r => r.title === '改派用例');
  if (!mine.length) return { ok: false, why: '回读不到刚插入的改派夹具' };
  const id = mine[0].id;
  await dbg.openDoc(id, '健康档案');
  await new Promise(r => setTimeout(r, 1200));
  const sel = document.querySelector('#docLayer select[data-role="person"]');
  if (!sel) return { ok: false, why: '详情页没有可编辑的归属成员下拉' };
  const before = sel.value;
  sel.value = '3';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2200));
  const rec = dbg.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return {
    ok: true, id, before,
    personName: (dbg.persons().find(p => Number(p.id) === 3) || {}).name,
    after: rec ? rec.person_id : null,
    stats: dbg.personStats(),
    msg: (document.querySelector('#docMsg,#docLayer .msg-bar') || {}).textContent || ''
  };
});
check('详情页「归属成员」可直接改派', reassign.ok === true, reassign.why);
check('改派后记录上的 person_id 真的变了',
  reassign.ok && Number(reassign.after) === 3, JSON.stringify(reassign));

const rsServer = await serverRows();
const rsRow = rsServer.find(r => Number(r.id) === Number(reassign.id));
check('改派写到了磁盘（重读服务端仍是新归属，排除缓存假象）',
  !!rsRow && Number(rsRow.person_id) === 3, JSON.stringify(rsRow && rsRow.person_id));

check('成员页统计随之更新（改派到的人名下多出一份）',
  reassign.ok && Number(reassign.stats['3'] || 0) >= 1, JSON.stringify(reassign.stats));
check('改派反馈写明归属给了谁',
  !!reassign.personName && String(reassign.msg).indexOf(reassign.personName) >= 0,
  JSON.stringify(reassign.msg));

const filtered = await page.evaluate(async id => {
  window.__hrwDebug.closeDrawers && window.__hrwDebug.closeDrawers();
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 700));
  const c0 = document.getElementById('arClear');
  if (c0) c0.click();
  await new Promise(r => setTimeout(r, 500));
  const sel = document.getElementById('arPerson');
  if (!sel) return { ok: false, why: 'no-filter' };
  const hit = async v => {
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    return Array.prototype.map.call(document.querySelectorAll('#s-archive [data-doc]'),
      n => n.getAttribute('data-doc'));
  };
  const atThree = await hit('3');
  const atOne = await hit('1');
  await hit('');
  const mine = String(id);
  return { ok: true, inThree: atThree.indexOf(mine) >= 0, inOne: atOne.indexOf(mine) >= 0 };
}, reassign.id);
// 此刻档案归在 3 号名下，所以筛 3 命中、筛回原来的 1 号不该命中。
// 这个检查必须排在「改回未指定」之前，改回去之后再筛 3 自然是空的。
check('改派结果立刻能在「按人筛选」里查到（在未指定时反而查不到）',
  filtered.ok && filtered.inThree === true && filtered.inOne === false, JSON.stringify(filtered));

const backToNone = await page.evaluate(async id => {
  const sel = document.querySelector('#docLayer select[data-role="person"]');
  if (!sel) return { ok: false, why: 'no-select' };
  sel.value = '';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return { ok: true, after: rec ? rec.person_id : 'gone' };
}, reassign.id);
check('也能改回「未指定」', backToNone.ok &&
  (backToNone.after === null || backToNone.after === undefined || backToNone.after === ''),
  JSON.stringify(backToNone));
await page.screenshot({ path: OUT + '12-reassign.png' });
say('');

/* ---- 10.11 七类归档：新增「体检报告」 ---- */
say('=== 10.11 归档类型新增体检报告 ===');
const typeUi = await page.evaluate(async () => {
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 700));
  const arTypes = Array.prototype.map.call(
    document.querySelectorAll('#arType option'), o => o.value);
  window.__hrwDebug.go('overview');
  await new Promise(r => setTimeout(r, 900));
  const ov = document.getElementById('s-overview').textContent.replace(/\s+/g, ' ');
  return {
    arTypes,
    seven: /七类资料数量/.test(ov),
    dist: ov.indexOf('体检报告') >= 0,
    kpiN: (ov.match(/共 (\d+) 类资料/) || [])[1] || null,
    docLen: window.Logic.DOC_TYPES.length
  };
});
check('归档类型清单里有体检报告', typeUi.arTypes.indexOf('体检报告') >= 0,
  JSON.stringify(typeUi.arTypes));
check('兜底类型仍排在最后', typeUi.arTypes[typeUi.arTypes.length - 1] === '其他医疗资料',
  JSON.stringify(typeUi.arTypes.slice(-2)));
check('资料类型分布卡片已改为七类口径', typeUi.seven === true);
check('体检报告出现在类型分布里', typeUi.dist === true);
// D31：类型扩到七类后 KPI 副标题仍写死「共 6 类资料」。数量必须从 DOC_TYPES 取。
check('概览 KPI 的资料类数跟着 DOC_TYPES 走，不是写死的',
  typeUi.kpiN === String(typeUi.docLen) && typeUi.docLen === 7,
  JSON.stringify({ kpiN: typeUi.kpiN, docLen: typeUi.docLen }));

const draftType = await page.evaluate(async () => {
  await window.__hrwDebug.openImportDrawer(null, {
    files: [],
    payload: {
      target: 'documents',
      records: [{
        document_type: '其他医疗资料', primary_date: null, date_status: '日期待确认',
        title: null, source_file: '类型用例.pdf', source_attachments: [],
        parsed_content: '原文', type_specific_data: {}, parse_status: '已解析待结构化'
      }]
    }
  });
  await new Promise(r => setTimeout(r, 1000));
  const sel = document.getElementById('presetType');
  const opts = sel ? Array.prototype.map.call(sel.options, o => o.value) : [];
  let picked = null;
  if (sel) {
    sel.value = '体检报告';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    picked = sel.value;
  }
  await new Promise(r => setTimeout(r, 500));
  return { opts, picked, opened: !!sel };
});
check('上传草稿里能把类型改成体检报告',
  draftType.opened && draftType.opts.indexOf('体检报告') >= 0 && draftType.picked === '体检报告',
  JSON.stringify(draftType));
await page.evaluate(() => { window.__hrwDebug.closeDrawers(); });
say('');

/* ---- 10.12 手工编辑与留痕 ----
   有些字段原件上就没有、或 OCR 读错了，必须能在界面上改；改过的要能追回到原值；
   而且不能下一次「智能结构化」确认时被人改的值悄悄冲掉。 */
say('=== 10.12 手工编辑记录信息与留痕 ===');

const editCase = await page.evaluate(async () => {
  try {
    const D = window.__hrwDebug.local;
    const ins = await D.database.from('documents').insert({
      document_type: '体检报告', title: '编辑用例·体检报告书', primary_date: '2024-06-01',
      date_status: '已确认', hospital: '瑞慈体检中心', department: '总检', doctor: '张医生',
      amount: 300, source_file: 'edit-case.pdf', parse_status: '已归档', person_id: 1,
      key_information: '原始关键信息第一行',
      // 结构化入口要求有解析原文，缺了 openStructDrawer 会直接拒开
      parsed_content: '【编辑用例】血红蛋白 145 g/L；空腹血糖 5.1 mmol/L。腹部超声未见异常。',
      type_specific_data: {
        structured: true, total_amount: 300,
        lab_results: [
          { name: '血红蛋白', result: '145', unit: 'g/L', reference: '130~175', flag: '', panel: '血常规' },
          { name: '空腹血糖', result: '5.1', unit: 'mmol/L', reference: '3.9~6.1', flag: '', panel: '生化' }
        ],
        exams: [{ exam_name: '腹部超声', findings: '未见异常', impression: '无' }]
      }
    }).select();
    if (ins.error) return { ok: false, why: 'insert: ' + ins.error.message };
    await window.__hrwDebug.reload();
    const rows = window.__hrwDebug.state.tables.documents.rows;
    const mine = rows.filter(r => r.title === '编辑用例·体检报告书');
    if (!mine.length) return { ok: false, why: '回读不到编辑夹具' };
    return { ok: true, id: mine[0].id };
  } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
});
check('编辑夹具就位（带检验项与检查明细的档案）', editCase.ok === true, editCase.why);

await page.evaluate(async id => {
  await window.__hrwDebug.openDoc(id, '健康档案');
  await new Promise(r => setTimeout(r, 1200));
}, editCase.id);

/* --- A. 卡片字段编辑 --- */
const editDrawer = await page.evaluate(async id => {
  const btn = document.getElementById('btnRecEdit');
  if (!btn) return { ok: false, why: '记录信息卡片上没有「编辑」按钮' };
  btn.click();
  await new Promise(r => setTimeout(r, 700));
  const v = i => { const el = document.getElementById(i); return el ? el.value : null; };
  const filled = {
    title: v('reTitle'), type: v('reType'), date: v('reDate'), hospital: v('reHospital'),
    dept: v('reDept'), doctor: v('reDoctor'), amount: v('reAmount'), tsAmount: v('reTsAmount'),
    parseStatus: v('reParseStatus')
  };
  const ro = document.getElementById('reKeyInfo') ? 'editable' : 'missing';
  return { ok: true, open: !!document.querySelector('#drawer-recedit.on'), filled: filled, keyInfo: ro };
}, editCase.id);
check('卡片上有编辑入口，点开后各字段预填当前值',
  editDrawer.ok && editDrawer.open && editDrawer.filled.hospital === '瑞慈体检中心'
  && editDrawer.filled.type === '体检报告' && editDrawer.filled.date === '2024-06-01',
  JSON.stringify(editDrawer));
check('关键原文信息也在编辑表单里', editDrawer.keyInfo === 'editable', editDrawer.keyInfo);

const readonlyGuard = await page.evaluate(() => {
  const body = document.getElementById('receditBody');
  const txt = body ? body.textContent.replace(/\s+/g, ' ') : '';
  const ids = ['reTaskId', 'reRunId', 'reFileHash', 'reUpdatedAt', 'reId'];
  const present = ids.filter(i => document.getElementById(i));
  return { present: present, mentions: /不可修改|只读|不能改/.test(txt) };
});
check('主键 / 哈希 / 解析任务号没有做成输入框（它们是幂等与溯源依据）',
  readonlyGuard.present.length === 0 && readonlyGuard.mentions,
  JSON.stringify(readonlyGuard));

const saved = await page.evaluate(async id => {
  document.getElementById('reHospital').value = '第一体检中心';
  document.getElementById('reDoctor').value = '李医生';
  document.getElementById('btnRecEditSave').click();
  await new Promise(r => setTimeout(r, 2400));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return {
    hospital: rec ? rec.hospital : null, doctor: rec ? rec.doctor : null,
    title: rec ? rec.title : null, amount: rec ? rec.amount : null,
    dept: rec ? rec.department : null, date: rec ? rec.primary_date : null,
    badge: (document.getElementById('recEditBadge') || {}).textContent || '',
    msg: (document.getElementById('docMsg') || {}).textContent || ''
  };
}, editCase.id);
check('改完保存后，卡片立刻显示新值（不是只改了表单）',
  saved.hospital === '第一体检中心' && saved.doctor === '李医生', JSON.stringify(saved));
check('没动的字段一个都没丢（整行覆盖防护）',
  saved.title === '编辑用例·体检报告书' && saved.dept === '总检'
  && Number(saved.amount) === 300 && saved.date === '2024-06-01', JSON.stringify(saved));
check('卡片出现「已人工更正」徽标并计数',
  /2/.test(saved.badge), JSON.stringify(saved.badge));

const srvAfterScalar = await serverRows();
const rowAfterScalar = srvAfterScalar.find(r => Number(r.id) === Number(editCase.id));
check('服务端磁盘上的记录确实是新值（排除门面缓存假象）',
  rowAfterScalar && rowAfterScalar.hospital === '第一体检中心'
  && rowAfterScalar.doctor === '李医生', JSON.stringify(rowAfterScalar && rowAfterScalar.hospital));
check('留痕写进了记录本身，并带原值与时间',
  Array.isArray(rowAfterScalar.manual_edits) && rowAfterScalar.manual_edits.length === 2
  && rowAfterScalar.manual_edits[0].from === '瑞慈体检中心',
  JSON.stringify(rowAfterScalar.manual_edits));

const historyShown = await page.evaluate(async id => {
  const b = document.getElementById('recEditBadge');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 500));
  const el = document.getElementById('recEditHistory');
  return el ? el.textContent.replace(/\s+/g, ' ') : '';
}, editCase.id);
check('点开徽标能看到「原来是什么、什么时候改的」',
  historyShown.indexOf('瑞慈体检中心') >= 0 && historyShown.indexOf('医院') >= 0,
  JSON.stringify(historyShown.slice(0, 160)));

/* --- B. 日期联动 --- */
const dateEdit = await page.evaluate(async id => {
  document.getElementById('btnRecEdit').click();
  await new Promise(r => setTimeout(r, 600));
  const hint = document.getElementById('reDateHint');
  const hintText = hint ? hint.textContent : '';
  document.getElementById('reDate').value = '2023-03-07';
  document.getElementById('btnRecEditSave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return { hintText: hintText, date: rec.primary_date, status: rec.date_status };
}, editCase.id);
check('改日期前界面就说明了它会影响统计口径',
  /趋势|统计/.test(dateEdit.hintText), JSON.stringify(dateEdit.hintText.slice(0, 120)));
check('手填合法日期后日期状态保持已确认',
  dateEdit.date === '2023-03-07' && dateEdit.status === '已确认', JSON.stringify(dateEdit));

/* --- C. 明细行内编辑 --- */
const cellEdit = await page.evaluate(async id => {
  const cell = document.querySelector('#docBody [data-ts-open="lab_results.0.result"]');
  if (!cell) return { ok: false, why: '检验项「结果」这一格没有编辑入口' };
  cell.click();
  await new Promise(r => setTimeout(r, 400));
  const inp = document.getElementById('tsInput');
  if (!inp) return { ok: false, why: '原位没有出现输入框' };
  const old = inp.value;
  inp.value = '138';
  document.getElementById('tsInputSave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  const row = rec.type_specific_data.lab_results[0];
  return {
    ok: true, old: old, result: row.result, name: row.name, unit: row.unit,
    marked: !!document.querySelector('#docBody [data-ts-target="lab_results.0.result"]'),
    markTip: (document.querySelector('#docBody .ts-mark') || {}).title || '',
    edits: (rec.manual_edits || []).length,
    otherIntact: rec.type_specific_data.lab_results[1].result === '5.1' && !!row.unit
  };
}, editCase.id);
check('明细表格逐格可编辑，改完读到新值', cellEdit.ok && cellEdit.result === '138',
  JSON.stringify(cellEdit));
check('只改一格，同行别的列与别的行都不受影响', cellEdit.otherIntact === true, JSON.stringify(cellEdit));
check('改过的格子留下可见标记，提示里带原值',
  cellEdit.marked === true && cellEdit.markTip.indexOf('145') >= 0, JSON.stringify(cellEdit));
check('明细改动计入留痕（共 4 处）', cellEdit.edits === 4, String(cellEdit.edits));

const qualEdit = await page.evaluate(async id => {
  const cell = document.querySelector('#docBody [data-ts-open="lab_results.1.result"]');
  cell.click();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('tsInput').value = '未见异常';
  document.getElementById('tsInputSave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  const row = rec.type_specific_data.lab_results[1];
  const pts = (window.__hrwDebug.indicatorPointsFor ? window.__hrwDebug.indicatorPointsFor('血糖') : null);
  return { result: row.result, flag: row.flag, note: row.review || row.note || '', pts: pts };
}, editCase.id);
check('数值格里填定性文字：原样保留，不静默转成 0 或空',
  qualEdit.result === '未见异常', JSON.stringify(qualEdit));

const examEdit = await page.evaluate(async id => {
  const cell = document.querySelector('#docBody [data-ts-open="exams.0.findings"]');
  if (!cell) return { ok: false, why: '检查所见没有编辑入口' };
  cell.click();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('tsInput').value = '肝、胆、脾、胰、肾未见明显异常';
  document.getElementById('tsInputSave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return { ok: true, findings: rec.type_specific_data.exams[0].findings };
}, editCase.id);
// findings 在数据里是「一行一项」的数组，改完必须仍是数组（写成字符串渲染处会显示"原报告未提供"）
check('检查报告明细同样可改（检查所见仍是数组）',
  examEdit.ok && String([].concat(examEdit.findings).join('|')) === '肝、胆、脾、胰、肾未见明显异常'
  && Array.isArray(examEdit.findings), JSON.stringify(examEdit));

/* --- D. 金额两处都能改，且冲突仍如实标出 --- */
const moneyEdit = await page.evaluate(async id => {
  document.getElementById('btnRecEdit').click();
  await new Promise(r => setTimeout(r, 600));
  document.getElementById('reTsAmount').value = '260';
  document.getElementById('btnRecEditSave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  const card = document.getElementById('docBody').textContent.replace(/\s+/g, ' ');
  return { amount: rec.amount, ts: rec.type_specific_data.total_amount, conflict: /不一致|待核对/.test(card) };
}, editCase.id);
check('结构化总金额能单独改（顶层金额不受牵连）',
  Number(moneyEdit.ts) === 260 && Number(moneyEdit.amount) === 300, JSON.stringify(moneyEdit));
check('两处金额不一致时仍然如实标出，不悄悄取一个', moneyEdit.conflict === true,
  JSON.stringify(moneyEdit));

/* --- E0. 没有解析原文的记录不得留下可点的写入抽屉 --- */
const staleGuard = await page.evaluate(async () => {
  const cloud = window.__hrwDebug.local;
  const ins = await cloud.database.from('documents').insert({
    document_type: '体检报告', title: '无原文夹具', primary_date: '2024-04-04',
    date_status: '已确认', person_id: 1, parse_status: '已归档', source_attachments: []
  }).select();
  if (ins.error) return { ok: false, why: ins.error.message };
  await window.__hrwDebug.reload();
  const id = window.__hrwDebug.state.tables.documents.rows
    .filter(r => r.title === '无原文夹具')[0].id;
  // 先正常打开一次，制造「已有预览留在抽屉里」的前提
  window.__hrwDebug.openDoc(id, '健康档案');
  await new Promise(r => setTimeout(r, 600));
  return { ok: true, id: id, hasContent: false };
});
const noSourceGuard = await page.evaluate(async () => {
  document.getElementById('drawer-struct').classList.add('on');
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const noText = rows.filter(r => !String(r.parsed_content || '').trim())[0];
  if (!noText) return { ok: false, why: '找不到一条没有解析原文的记录' };
  await window.__hrwDebug.openStructDrawer(noText.id);
  await new Promise(r => setTimeout(r, 800));
  return {
    ok: true,
    stillOpen: document.getElementById('drawer-struct').classList.contains('on')
  };
});
check('记录没有解析原文时，结构化抽屉不得停在「可点确认写入」的状态',
  noSourceGuard.ok && noSourceGuard.stillOpen === false, JSON.stringify(noSourceGuard));
check('无原文夹具就位', staleGuard.ok === true, staleGuard.why);

/* --- E. 与智能结构化的冲突处理（用免密钥的手动中转走完整链路）--- */
await page.evaluate(async id => {
  await window.__hrwDebug.openStructDrawer(id);
  await new Promise(r => setTimeout(r, 900));
}, editCase.id);

const conflictUi = await page.evaluate(() => {
  const box = document.getElementById('structConflicts');
  if (!box) return { ok: false, why: '预览里没有冲突区块（可能还没粘模型结果）' };
  return { ok: true };
});
const pasted = await page.evaluate(async () => {
  const ta = document.getElementById('structPaste');
  ta.value = JSON.stringify({
    document_type: '检查报告', title: '编辑用例·体检报告书', hospital: '第一体检中心',
    lab_results: [
      { name: '血红蛋白', result: '145', unit: 'g/L', reference: '130~175', flag: '', panel: '血常规' },
      { name: '空腹血糖', result: '5.1', unit: 'mmol/L', reference: '3.9~6.1', flag: '', panel: '生化' }
    ]
  });
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('btnStructAdopt').click();
  await new Promise(r => setTimeout(r, 2600));
  const rows = Array.prototype.map.call(
    document.querySelectorAll('#structConflicts [data-conflict]'),
    s => s.getAttribute('data-conflict') + ':' + (s.value || ''));
  const defaults = Array.prototype.map.call(
    document.querySelectorAll('#structConflicts select'), s => s.value);
  return { rows: rows, allHuman: defaults.length > 0 && defaults.every(v => v === 'human'),
           text: (document.getElementById('structConflicts') || {}).textContent || '' };
});
check('粘回来的模型结果与人工值不一致时，逐字段列出冲突',
  pasted.rows.length >= 2, JSON.stringify(pasted));
check('冲突默认选「保留我改的值」',
  pasted.allHuman === true, JSON.stringify(pasted));
check('冲突里点名了是哪个字段（不是笼统一句「有差异」）',
  /文档类型|结果|血红蛋白/.test(pasted.text), JSON.stringify(pasted.text.slice(0, 200)));

const appliedKeepHuman = await page.evaluate(async id => {
  document.getElementById('btnStructApply').click();
  await new Promise(r => setTimeout(r, 3000));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  return { type: rec.document_type, lab0: rec.type_specific_data.lab_results[0].result,
           findings: (rec.type_specific_data.exams[0] || {}).findings };
}, editCase.id);
check('按默认「保留人工值」确认后：类型没被模型改回检查报告',
  appliedKeepHuman.type === '体检报告', JSON.stringify(appliedKeepHuman));
check('人工改过的检验值也没被模型原值覆盖',
  appliedKeepHuman.lab0 === '138', JSON.stringify(appliedKeepHuman));
// 模型这次没提 exams，但结构化写入不得把已有明细整块抹掉
check('结构化确认写入不会丢掉模型没提到的明细表（手改的检查所见仍在）',
  [].concat(appliedKeepHuman.findings || []).join('|') === '肝、胆、脾、胰、肾未见明显异常',
  JSON.stringify(appliedKeepHuman));

const appliedTakeModel = await page.evaluate(async (id) => {
  await window.__hrwDebug.openStructDrawer(id);
  await new Promise(r => setTimeout(r, 800));
  const ta = document.getElementById('structPaste');
  ta.value = JSON.stringify({ document_type: '检验报告', title: '编辑用例·体检报告书' });
  document.getElementById('btnStructAdopt').click();
  await new Promise(r => setTimeout(r, 2400));
  const sel = document.querySelector('#structConflicts [data-conflict="document_type"]');
  if (!sel) return { ok: false, why: '没有该字段的冲突项' };
  sel.value = 'model';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('btnStructApply').click();
  await new Promise(r => setTimeout(r, 3000));
  const rec = window.__hrwDebug.state.tables.documents.rows.find(r => Number(r.id) === Number(id));
  const last = (rec.manual_edits || []).slice(-1)[0] || {};
  return { ok: true, type: rec.document_type, lastFrom: last.from };
}, editCase.id);
check('显式改选「用模型值」后确实采用模型的，并同样留下留痕',
  appliedTakeModel.ok && appliedTakeModel.type === '检验报告'
  && appliedTakeModel.lastFrom === '体检报告', JSON.stringify(appliedTakeModel));

await page.evaluate(() => { window.__hrwDebug.closeDrawers(); });
const srvFinal = await serverRows();
const finalRow = srvFinal.find(r => Number(r.id) === Number(editCase.id));
check('所有编辑都落到了磁盘（最终态与服务端一致）',
  finalRow && finalRow.document_type === '检验报告' && finalRow.hospital === '第一体检中心'
  && finalRow.type_specific_data.lab_results[0].result === '138',
  JSON.stringify(finalRow && { t: finalRow.document_type, h: finalRow.hospital }));
// 逐项可推：医院+医生(2) → 日期(1) → 血红蛋白结果(1) → 血糖结果(1)
// → 检查所见(1) → 结构化总额(1) → 结构化确认时改用模型类型(1) = 8
check('留痕总条数与逐项改动次数精确吻合（8 处）',
  (finalRow.manual_edits || []).length === 8,
  String((finalRow.manual_edits || []).length) + ' :: '
  + (finalRow.manual_edits || []).map(e => e.target).join(','));
await page.screenshot({ path: OUT + '13-edit.png' });
say('');

/* ---- 10.13 窗口滚动条与滚动位置恢复 ----
   健康档案页「概率性没有滚动条」的根因是详情层的锁没复原：同一层被重复入栈，
   关一层时把 .on 摘了却留下栈残留，body.overflow 永久停在 hidden。
   这里既钉复现路径，也钉反向不变量（还有层开着时不许提前放开）。 */
say('=== 10.13 窗口滚动条与滚动位置恢复 ===');

const scrollerShape = await page.evaluate(() => {
  const m = document.querySelector('.main');
  const cs = m ? getComputedStyle(m) : null;
  return {
    mainIsScroller: !!(cs && cs.overflowY !== 'visible' && m.scrollHeight > m.clientHeight),
    winScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    hasDebugLayerApi: typeof window.__hrwDebug.openLayer === 'function'
      && typeof window.__hrwDebug.closeLayer === 'function'
  };
});
check('滚动的是窗口而不是 .main（决定了锁 body 会不会吞掉滚动条）',
  scrollerShape.mainIsScroller === false && scrollerShape.winScrollable === true,
  JSON.stringify(scrollerShape));
check('自测句柄暴露层的开合（这两个函数就是缺陷本体，必须可直接驱动）',
  scrollerShape.hasDebugLayerApi === true, JSON.stringify(scrollerShape));

// 反向不变量：两层叠着时关掉上层，底层还在 → 锁必须保留
const twoLayers = await page.evaluate(async () => {
 try {
  const st = window.__hrwDebug.state;
  const before = { stack: st.layerStack.slice(), overflow: document.body.style.overflow };
  window.__hrwDebug.openLayer('docLayer');
  window.__hrwDebug.openLayer('rcLayer');
  await new Promise(r => setTimeout(r, 250));
  const bothOn = [...document.querySelectorAll('.detail-layer.on')].map(e => e.id).sort();
  const lockedBoth = document.body.style.overflow;
  window.__hrwDebug.closeLayer();                    // 只关最上面那层
  await new Promise(r => setTimeout(r, 250));
  const afterOne = {
    onLayers: [...document.querySelectorAll('.detail-layer.on')].map(e => e.id),
    overflow: document.body.style.overflow
  };
  window.__hrwDebug.closeLayer();                    // 关到没有层为止
  await new Promise(r => setTimeout(r, 250));
  const afterAll = {
    onLayers: [...document.querySelectorAll('.detail-layer.on')].map(e => e.id),
    overflow: document.body.style.overflow || '(空)',
    stack: st.layerStack.slice()
  };
  window.__hrwDebug.closeAllLayers();
  return { before, bothOn, lockedBoth, afterOne, afterAll };
 } catch (e) { return { crashed: String(e && e.message || e) }; }
});
check('两层都开着时是锁住的', twoLayers.lockedBoth === 'hidden' && twoLayers.bothOn.length === 2,
  JSON.stringify(twoLayers) + (twoLayers.crashed ? ' CRASH:' + twoLayers.crashed : ''));
check('关掉上层、底层还在 → 不许提前放开滚动锁',
  twoLayers.afterOne.onLayers.length === 1 && twoLayers.afterOne.overflow === 'hidden',
  JSON.stringify(twoLayers.afterOne));
check('全部关掉后滚动锁必须复原',
  twoLayers.afterAll.onLayers.length === 0 && twoLayers.afterAll.overflow !== 'hidden',
  JSON.stringify(twoLayers.afterAll));

// 正向复现：详情层内再打开一条记录（下钻），返回后不该留下锁残留
const drill = await page.evaluate(async () => {
 try {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  if (rows.length < 2) return { ok: false, why: '至少需要两条档案才能测下钻' };
  // 用原始资料档案页：它把命中行全列出来，高度可控；时间轴默认只展开最近 10 个
  // 日期组，数据少时整页不足一屏，滚不动就等于测不到恢复（别拿它当夹具）。
  window.__hrwDebug.go('archive');
  await new Promise(r => setTimeout(r, 900));
  window.scrollTo(0, 400);
  await new Promise(r => setTimeout(r, 250));
  const top = window.scrollY;
  if (top < 40) {
    return { ok: false, why: '页面不够高，测不了滚动恢复：scrollY=' + top
      + ' scrollHeight=' + document.documentElement.scrollHeight
      + ' clientHeight=' + document.documentElement.clientHeight };
  }
  window.__hrwDebug.openDoc(rows[0].id, '健康档案');
  await new Promise(r => setTimeout(r, 900));
  window.__hrwDebug.openDoc(rows[1].id, '健康档案');     // 详情里点关联记录 = 同一层再开一次
  await new Promise(r => setTimeout(r, 900));
  const stackDeep = window.__hrwDebug.state.layerStack.slice();
  document.getElementById('docBack').click();
  await new Promise(r => setTimeout(r, 1000));
  const after = {
    onLayers: [...document.querySelectorAll('.detail-layer.on')].map(e => e.id),
    overflow: document.body.style.overflow || '(空)',
    stack: window.__hrwDebug.state.layerStack.slice()
  };
  return { ok: true, top, stackDeep, after, yBack: window.scrollY };
 } catch (e) { return { ok: false, why: 'THROW: ' + (e && e.message || e) }; }
});
check('下钻不会让同一层在栈里叠两条', drill.ok && (drill.stackDeep || [])
  .filter(x => x === 'docLayer').length === 1, JSON.stringify(drill));
check('下钻后点返回，滚动条必须回来（这就是原来的故障现场）',
  drill.ok && drill.after.onLayers.length === 0 && drill.after.overflow !== 'hidden',
  JSON.stringify(drill.after));
check('返回来源页时滚动位置真的恢复（此前 main.scrollTop 是空转的）',
  drill.ok && Math.abs(Number(drill.yBack) - Number(drill.top)) <= 4 && drill.top > 100,
  JSON.stringify({ top: drill.top, yBack: drill.yBack }));
await page.screenshot({ path: OUT + '14-scroll.png' });
say('');

/* ---- 10.14 按成员看数据与各自的关注指标 ----
   指标定义全家共用一份，只有「是否关注」按人；概览切到人之后
   KPI / 趋势 / 费用 / 活动都必须只算他一个人的。 */
say('=== 10.14 按成员展示与按人关注指标 ===');

const ovCase = await page.evaluate(async () => {
  try {
    const cloud = window.__hrwDebug.local;
    const mk = async (title, pid, date, val) => {
      const r = await cloud.database.from('documents').insert({
        document_type: '体检报告', title: title, primary_date: date, date_status: '已确认',
        person_id: pid, amount: pid === 1 ? 200 : (pid === 2 ? 300 : null),
        source_attachments: [], parsed_content: '原文 ' + title,
        type_specific_data: { lab_results: [{ name: '空腹血糖', result: val, unit: 'mmol/L' }] }
      }).select();
      if (r.error) throw new Error(r.error.message);
    };
    await mk('按人用例·我', 1, '2025-05-05', '5.2');
    // 10.8 的成员级联用例会删掉「老婆」，本节只能用还存在的成员，
    // 否则切换器里没有这个标签，测的是夹具而不是功能。
    await mk('按人用例·妈妈', 5, '2025-05-06', '6.0');
    await mk('按人用例·无归属', null, '2025-05-07', '4.8');
    await window.__hrwDebug.reload();
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
});
check('按人用例夹具就位（我 / 妈妈 / 无归属 各一条）', ovCase.ok === true, ovCase.why);

const switcher = await page.evaluate(async () => {
  window.__hrwDebug.go('overview');
  await new Promise(r => setTimeout(r, 900));
  const box = document.querySelector('.person-switch');
  return {
    exists: !!box,
    labels: box ? [...box.querySelectorAll('[data-ps]')].map(b => b.textContent) : [],
    active: box ? (box.querySelector('.ps.on') || {}).textContent : null,
    kpiAll: document.getElementById('s-overview').textContent.replace(/\s+/g, ' ').slice(0, 60)
  };
});
check('概览顶部有成员切换器', switcher.exists === true, JSON.stringify(switcher).slice(0, 160));
check('切换器含「全部」「未指定」和每个成员',
  switcher.labels.indexOf('全部') >= 0 && switcher.labels.indexOf('未指定') >= 0
  && switcher.labels.indexOf('妈妈') >= 0, JSON.stringify(switcher.labels));
check('默认停在「全部」', String(switcher.active).trim() === '全部', String(switcher.active));

const kpiOf = async label => page.evaluate(async l => {
  const btn = [...document.querySelectorAll('#s-overview [data-ps]')]
    .find(b => b.textContent.trim() === l);
  if (!btn) return { n: null, fee: null, active: '', hint: '', missing: l };
  btn.click();
  await new Promise(r => setTimeout(r, 1100));
  const txt = document.getElementById('s-overview').textContent.replace(/\s+/g, ' ');
  const m = txt.match(/档案数量\s*(\d+)\s*份/);
  const fee = txt.match(/已记录医疗费用\s*([\d.]+)\s*元/);
  return {
    n: m ? Number(m[1]) : null, fee: fee ? Number(fee[1]) : null,
    active: (document.querySelector('#s-overview .ps.on') || {}).textContent,
    hint: (document.querySelector('#s-overview .ps-hint') || {}).textContent || ''
  };
}, label);

const mine = await kpiOf('我');
const spouse = await kpiOf('妈妈');
const none = await kpiOf('未指定');
const all = await kpiOf('全部');
// 名字不要超过它真正检查的东西：费用的按人等式在 10.16 的分区求和里断言，这里只断 KPI 与提示。
check('切到「我」：档案数 KPI 跟着变，切换器与提示都指向同一个人',
  mine.n !== null && mine.n <= all.n && mine.active.trim() === '我'
  && /我/.test(mine.hint), JSON.stringify(mine));
check('切到「妈妈」与切到「我」是两批数据',
  spouse.n !== null && spouse.active.trim() === '妈妈' && !spouse.missing,
  JSON.stringify(spouse));
check('「未指定」只收没有归属的档案',
  none.n !== null && none.n >= 1 && none.n < all.n,
  JSON.stringify({ none: none.n, all: all.n }));
check('切回「全部」档案数不小于任何单人视图',
  all.n !== null && all.n >= mine.n && all.n >= spouse.n && all.n >= none.n,
  JSON.stringify({ all: all.n, mine: mine.n, spouse: spouse.n, none: none.n }));

const srvCounts = await page.evaluate(async () => {
  const rows = window.__hrwDebug.state.tables.documents.rows;
  const cnt = pid => rows.filter(r => (pid === 0
    ? (r.person_id === null || r.person_id === undefined || r.person_id === '')
    : Number(r.person_id) === pid)).length;
  return { p1: cnt(1), p5: cnt(5), none: cnt(0), total: rows.length };
});
check('切换器显示的条数与服务端真实归属一致（不是页面自己算的）',
  mine.n === srvCounts.p1 && spouse.n === srvCounts.p5 && none.n === srvCounts.none,
  JSON.stringify({ ui: [mine.n, spouse.n, none.n], srv: srvCounts }));

// 关注指标按人：给「我」加一项，切到妈妈不该被勾上。
// V2 起关注落在 watched_indicators（每人一份），入口在「关注指标」卡片上；
// 旧的「全家共用 followers」入口已随 V1 一起下线。
const followPerPerson = await page.evaluate(async () => {
  const setView = async v => {
    const b = [...document.querySelectorAll('#s-overview [data-ps]')].find(x => x.textContent.trim() === v);
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1300));
  };
  const watchedIds = async pid =>
    ((await (await fetch('/api/watched?person=' + pid)).json()).watched || [])
      .map(w => Number(w.id));
  await setView('我');
  const openBtn = document.getElementById('v2BtnFollow');
  if (!openBtn) return { ok: false, why: '关注卡片上没有「添加关注」入口' };
  openBtn.click();
  await new Promise(r => setTimeout(r, 1400));
  const head = document.getElementById('followBody').textContent.replace(/\s+/g, ' ');
  const boxes = [...document.querySelectorAll('#followBody input[data-v2-pick]')];
  if (!boxes.length) return { ok: false, why: '关注抽屉里没有可勾选的指标' };
  const target = boxes.find(b => !b.checked);
  if (!target) return { ok: false, why: '找不到一个未勾选项' };
  const id = Number(target.getAttribute('data-v2-pick'));
  target.checked = true;
  document.getElementById('v2FollowSave').click();
  await new Promise(r => setTimeout(r, 2400));
  const mineIds = await watchedIds(1);

  await setView('妈妈');
  const btn2 = document.getElementById('v2BtnFollow');
  if (!btn2) return { ok: false, why: '切成员后「添加关注」入口消失' };
  btn2.click();
  await new Promise(r => setTimeout(r, 1500));
  const sBox = document.querySelector('#followBody input[data-v2-pick="' + id + '"]');
  const spouseChecked = sBox ? sBox.checked : 'missing';
  const note = document.getElementById('followBody').textContent.replace(/\s+/g, ' ');
  const spouseIds = await watchedIds(5);
  window.__hrwDebug.closeDrawers();
  await setView('全部');
  await new Promise(r => setTimeout(r, 900));
  const cardButtons = [...document.querySelectorAll('#cardFollow button')].map(b => b.id);
  return {
    ok: true, id, mineIds, spouseIds, spouseChecked,
    headMentionsWho: /我/.test(head), spouseNote: /妈妈/.test(note), cardButtons
  };
});
check('关注入口是 V2 的按人关注卡（旧的全家关注入口已下线）',
  followPerPerson.ok && followPerPerson.cardButtons.indexOf('v2BtnFollow') >= 0
  && followPerPerson.cardButtons.indexOf('btnFollowMgr') < 0,
  JSON.stringify(followPerPerson).slice(0, 240));
check('给「我」勾选的关注写进 watched_indicators（服务端查得到）',
  followPerPerson.ok && followPerPerson.mineIds.indexOf(followPerPerson.id) >= 0,
  JSON.stringify(followPerPerson).slice(0, 240));
check('同一项在「妈妈」的关注里没被勾上（不串人）',
  followPerPerson.ok && followPerPerson.spouseChecked === false
  && followPerPerson.spouseIds.indexOf(followPerPerson.id) < 0,
  JSON.stringify(followPerPerson).slice(0, 240));
check('关注抽屉说明当前在编辑谁的清单',
  followPerPerson.ok && followPerPerson.headMentionsWho && followPerPerson.spouseNote,
  JSON.stringify(followPerPerson).slice(0, 220));

// 日常录入必须带归属。
// V2 化之后概览的关注表由 /api/watched 驱动（每人一份关注清单），所以「按人隔离」
// 要在两处同时成立：① 记录本身写进 manual_records.person_id；② 它同步出来的观测值
// 只会出现在那个人的关注卡上。旧写法只盯 overview 整页文本，V2 用关注卡判定。
const daily = await page.evaluate(async () => {
  const setView = async v => {
    const b = [...document.querySelectorAll('#s-overview [data-ps]')].find(x => x.textContent.trim() === v);
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1000));
  };
  const cardRows = () => [...document.querySelectorAll('#cardFollow tbody tr')].map(tr => {
    const td = tr.querySelectorAll('td');
    return {
      name: td[0] ? td[0].textContent.replace(/\s+/g, ' ').trim() : '',
      latest: td[2] ? td[2].textContent.replace(/\s+/g, ' ').trim() : ''
    };
  });
  await setView('爸爸');
  // V2 的目录行按 is_text 区分数值 / 文本（旧版是 type: '数值'）
  const cat = window.__hrwDebug.state.tables.indicators.rows.find(c => c.key && !c.is_text);
  if (!cat) return { ok: false, why: '目录里没有可录入的数值型指标' };
  window.__hrwDebug.openDailyDrawer(cat.key, new Date().toISOString().slice(0, 10));
  await new Promise(r => setTimeout(r, 900));
  const sel = document.getElementById('dyPerson');
  if (!sel) return { ok: false, why: '录入抽屉没有归属成员下拉' };
  const def = sel.value;
  document.getElementById('dyV1').value = '5.9';
  document.getElementById('btnDailySave').click();
  await new Promise(r => setTimeout(r, 2200));
  const rows = window.__hrwDebug.state.tables.manual_records.rows;
  const saved = rows[rows.length - 1] || {};
  // 手填的点要进趋势/关注表，先把这个指标关注到录入时选的那个人身上
  await fetch('/api/watched/add', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: Number(saved.person_id), indicator_id: Number(cat.id) })
  });
  await setView('爸爸');
  const dadRows = cardRows();
  await setView('妈妈');
  const momRows = cardRows();
  return {
    ok: true, def, savedPerson: saved.person_id, key: saved.indicator_key,
    indName: cat.name,
    dadHas: dadRows.some(r => r.name === cat.name && r.latest.indexOf('5.9') >= 0),
    momHas: momRows.some(r => r.name === cat.name)
  };
});
check('日常录入有归属下拉，且默认取概览当前成员',
  daily.ok && String(daily.def) === String(daily.savedPerson) && Number(daily.savedPerson) > 0,
  JSON.stringify(daily).slice(0, 220));
check('手动记录按人隔离：爸爸的关注卡看得到自己那条，妈妈那边没有这一行',
  daily.ok && daily.dadHas === true && daily.momHas === false, JSON.stringify(daily).slice(0, 220));

// 新增成员 / 删除成员与关注清单的关系（V2 每人一份，存在 watched_indicators）
const memberFollow = await page.evaluate(async () => {
  const mineBefore = (await (await fetch('/api/watched?person=1')).json()).watched || [];
  window.__hrwDebug.go('persons');
  await new Promise(r => setTimeout(r, 800));
  const inp = document.getElementById('psNewName');
  inp.value = '爷爷';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('psAdd').click();
  await new Promise(r => setTimeout(r, 2600));
  const persons = window.__hrwDebug.persons();
  const gid = (persons.find(p => p.name === '爷爷') || {}).id;
  // 新成员起步是空白清单：关注按人保存，不会凭空继承别人的
  const gidWatched = (await (await fetch('/api/watched?person=' + gid)).json()).watched || [];
  // 先给新成员挂一项关注，再删掉他，看服务端有没有留下孤儿关注行
  if (gidWatched.length === 0 && mineBefore.length) {
    await fetch('/api/watched/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_id: gid, indicator_id: mineBefore[0].id })
    });
  }
  const del = document.querySelector('#s-persons [data-person-del="' + gid + '"]');
  del.click();
  await new Promise(r => setTimeout(r, 600));
  document.querySelector('#s-persons [data-person-del-confirm="' + gid + '"]').click();
  await new Promise(r => setTimeout(r, 2800));
  const residue = ((await (await fetch('/api/watched?person=' + gid)).json()).watched || []).length;
  window.__hrwDebug.go('overview');
  await new Promise(r => setTimeout(r, 700));
  return {
    mineCount: mineBefore.length, gid, newMemberWatched: gidWatched.length, residue,
    stillListed: window.__hrwDebug.persons().some(p => p.id === gid)
  };
});
check('新成员起步是空白关注清单（按人保存，不凭空继承别人的）',
  memberFollow.mineCount > 0 && memberFollow.newMemberWatched === 0,
  JSON.stringify(memberFollow));
check('删除成员后服务端不留该成员的关注行（id 复用时不会被继承）',
  memberFollow.residue === 0 && memberFollow.stillListed === false,
  JSON.stringify(memberFollow));

const noLeak = await page.evaluate(async () => {
  // V2 起目录行不再携带 followers（那是 V1 的「全家共用」写法），
  // 关注关系只有 watched_indicators 一份真源。
  const rows = window.__hrwDebug.state.tables.indicators.rows || [];
  const withLegacyFollowers = rows.filter(r => Array.isArray(r.followers)).length;
  const sample = rows[0] || {};
  return { total: rows.length, withLegacyFollowers, fields: Object.keys(sample).sort() };
});
check('目录行不再谎报 followers（关注只有 watched_indicators 一份真源）',
  noLeak.total > 0 && noLeak.withLegacyFollowers === 0, JSON.stringify(noLeak).slice(0, 220));
await page.screenshot({ path: OUT + '15-person-view.png' });
say('');

/* ---- 10.15 概览数字与显示的对应关系 ----
   V2 化之后，概览关注表由后端 /api/watched 驱动（列：指标名/分类/最新结果/最新日期/点数/小趋势），
   指标详情由 /api/trend 驱动。这一节盯四件事：① 详情里「历史记录」只出现一次；
   ② 「点数」列报的是服务端的有效日期数，不是连线点数、也不等于记录条数；
   ③ 详情点数吃时间范围（切「近 12 个月」会变小）；④ 血脂四项各自成行，不把四个分项值挤进一格。
   夹具特意造「同一天两份报告」：库内 4 条观测、3 个有效日期，两种口径必须给出不同的数字，
   否则新旧说法同值，断言就白写了。 */
say('=== 10.15 概览次数口径 · 血脂行 · 详情历史卡片 ===');

const countCase = await page.evaluate(async () => {
  const D = window.__hrwDebug.local;
  const p2 = n => String(n).padStart(2, '0');
  const iso = offset => {
    const d = new Date(); d.setDate(d.getDate() - offset);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  };
  const mk = (title, date, labs) => D.database.from('documents').insert({
    document_type: '体检报告', title, primary_date: date, date_status: '已确认',
    hospital: '口径用例体检中心', source_file: 'count-case.pdf', parse_status: '已归档',
    person_id: 1, parsed_content: '【口径用例】', type_specific_data: { structured: true, lab_results: labs }
  }).select();
  const A = v => ({ name: '口径用例甲', result: v, unit: 'U/L', reference: '0~10', flag: '', panel: '生化-肝功' });
  const lipids = [
    { name: '总胆固醇', result: '5.90', unit: 'mmol/L', reference: '0~5.2', flag: '', panel: '生化-血脂' },
    { name: '甘油三酯', result: '1.20', unit: 'mmol/L', reference: '0~1.7', flag: '', panel: '生化-血脂' },
    { name: '高密度脂蛋白胆固醇', result: '1.40', unit: 'mmol/L', reference: '>1.0', flag: '', panel: '生化-血脂' },
    { name: '低密度脂蛋白胆固醇', result: '3.30', unit: 'mmol/L', reference: '0~3.4', flag: '', panel: '生化-血脂' },
    // 心电图的 QTC 间期：归一化后含 "tc"，旧别名规则会把它并进总胆固醇
    { name: 'QTC间期', result: '404', unit: 'ms', reference: '', flag: '', panel: '心电图' }
  ];
  const a = await mk('口径用例·近期', iso(10), [A('1.1')].concat(lipids));
  const b = await mk('口径用例·同日', iso(10), [A('1.2')]);       // 与 a 同一天：点数要少算一个
  const c = await mk('口径用例·近期二', iso(20), [A('1.3')]);
  const d = await mk('口径用例·一年半前', iso(550), [A('1.4')]);
  const err = a.error || b.error || c.error || d.error;
  if (err) return { ok: false, why: 'insert: ' + err.message };
  await window.__hrwDebug.reload();
  const got = window.__hrwDebug.state.tables.documents.rows
    .filter(r => /^口径用例/.test(r.title || '')).length;
  // V2 概览只显示「已关注」的指标，夹具这几项得先关注到 person 1 才看得见
  const need = ['口径用例甲', '总胆固醇', '甘油三酯', 'QTC间期'];
  const look = await (await fetch('/api/indicators?person=1&include_text=1&gender=all')).json();
  const byName = {};
  (look.indicators || []).forEach(i => { byName[i.name] = i; });
  const missing = [];
  for (const n of need) {
    if (!byName[n]) { missing.push(n); continue; }
    await fetch('/api/watched/add', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person_id: 1, indicator_id: byName[n].id })
    });
  }
  const w = await (await fetch('/api/watched?person=1')).json();
  const wmap = {};
  (w.watched || []).forEach(x => {
    wmap[x.name] = { id: x.id, date_count: x.date_count, last_value: x.last_value };
  });
  return { ok: got === 4, got, missing, wmap };
});
check('口径夹具就位（4 条档案：同日两份 + 一近期 + 一年半前）', countCase.ok === true,
  JSON.stringify(countCase).slice(0, 240));
check('夹具指标已进入「我」的关注卡（同名归一后落在同一指标上）',
  !!(countCase.wmap && countCase.wmap['口径用例甲'] && countCase.wmap['总胆固醇']),
  JSON.stringify(countCase.wmap || {}).slice(0, 240));

/* 读 V2 关注卡：列序 = 指标名 / 分类 / 最新结果 / 最新日期 / 点数 / 小趋势 / 操作 */
async function followCard(personLabel) {
  await page.evaluate(async lbl => {
    window.__hrwDebug.go('overview');
    await new Promise(x => setTimeout(x, 700));
    const b = [...document.querySelectorAll('#s-overview [data-ps]')]
      .find(x => x.textContent.trim() === lbl);
    if (b) b.click();
    await new Promise(x => setTimeout(x, 1000));
  }, personLabel);
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#cardFollow tbody tr').forEach(tr => {
      const td = tr.querySelectorAll('td');
      const btn = tr.querySelector('[data-v2-ind]');
      const name = td[0] ? td[0].textContent.replace(/\s+/g, ' ').trim() : '';
      out[name] = {
        id: btn ? Number(btn.getAttribute('data-v2-ind')) : null,
        latest: td[2] ? td[2].textContent.replace(/\s+/g, ' ').trim() : '',
        count: td[4] ? parseInt(td[4].textContent, 10) : NaN,
        countText: td[4] ? td[4].textContent.replace(/\s+/g, ' ').trim() : ''
      };
    });
    return out;
  });
}

const card = await followCard('我');
const A_ID = countCase.wmap && countCase.wmap['口径用例甲'] ? countCase.wmap['口径用例甲'].id : null;
const aRow = card['口径用例甲'] || null;

check('关注卡的「点数」列 = 服务端的有效日期数（同日两份报告只算一个点）',
  !!aRow && aRow.count === countCase.wmap['口径用例甲'].date_count
  && countCase.wmap['口径用例甲'].date_count === 3,
  JSON.stringify({ cell: aRow && aRow.count, server: countCase.wmap['口径用例甲'].date_count }));
check('「点数」报的是有效日期数、不是记录条数（库内 4 条观测 / 3 个日期，两种口径必须分开）',
  !!aRow && aRow.count === 3, JSON.stringify(aRow));

/* 详情：从关注卡里的 id 打开（V2 的入口是 [data-v2-ind]）；range 用后端认识的写法 */
async function openDetailById(id, range) {
  const rng = range || 'all';
  return page.evaluate(async ([iid, want]) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    window.__hrwDebug.closeAllLayers();
    await wait(300);
    const btn = document.querySelector('#cardFollow [data-v2-ind="' + iid + '"]');
    if (!btn) return { err: '关注卡里没有 id=' + iid };
    btn.click();
    await wait(1100);
    const rb = document.querySelector('#v2IndRange button[data-range="' + want + '"]');
    if (rb && !rb.classList.contains('on')) { rb.click(); await wait(1100); }
    const heads = [...document.querySelectorAll('#indBody .card-h h3')].map(h => h.textContent.trim());
    const rows = [...document.querySelectorAll('#indBody .point-list .pr')].map(x =>
      x.textContent.replace(/\s+/g, ' ').trim());
    let pts = null;
    document.querySelectorAll('#indBody dl.kv dd').forEach(dd => {
      if (/条观测/.test(dd.textContent)) pts = parseInt(dd.textContent, 10);
    });
    return { heads, rows, pts,
             hasRange: !!document.querySelector('#v2IndRange'),
             has12m: !!document.querySelector('#v2IndRange button[data-range="12m"]'),
             srcBtns: document.querySelectorAll('#indBody [data-src-doc]').length };
  }, [id, rng]);
}

const aAll = await openDetailById(A_ID, 'all');
check('指标详情的「历史记录」卡片只出现一次（此前整块渲染两遍）',
  aAll.heads.filter(h => h === '历史记录').length === 1, JSON.stringify(aAll.heads));
check('详情历史列出全部记录条数（4 条：同日两份各占一条），多于关注卡的有效日期数 3',
  aAll.rows.length === 4 && aAll.rows.length > aRow.count,
  JSON.stringify({ rows: aAll.rows.length, cardCount: aRow.count }));
check('详情顶部「点数」与历史行数同源（同一份 tr.history，不再两处各算一遍）',
  aAll.pts === aAll.rows.length, JSON.stringify({ pts: aAll.pts, rows: aAll.rows.length }));
check('范围按钮发的是后端认识的写法（data-range=12m，而不是 12 —— 早前后端只认 12m，这个按钮是空转的）',
  aAll.has12m === true, JSON.stringify({ hasRange: aAll.hasRange, has12m: aAll.has12m }));

const a12 = await openDetailById(A_ID, '12m');
check('详情点数吃时间范围：切到「近 12 个月」后一年半前那条被滤掉（4 → 3）',
  a12.rows.length === 3 && a12.rows.length < aAll.rows.length,
  JSON.stringify({ all: aAll.rows.length, m12: a12.rows.length }));

check('血脂行不再把四个分项值挤进一格（总胆固醇 / 甘油三酯各占一行，值互不串）',
  !!card['总胆固醇'] && !!card['甘油三酯']
  && /5\.9/.test(card['总胆固醇'].latest) && !/甘油三酯|低密度|高密度/.test(card['总胆固醇'].latest)
  && /1\.2/.test(card['甘油三酯'].latest),
  JSON.stringify({ tc: card['总胆固醇'], tg: card['甘油三酯'] }));

const tcId = card['总胆固醇'] ? card['总胆固醇'].id : null;
const tcDetail = tcId ? await openDetailById(tcId, 'all') : { rows: [], srcBtns: 0 };
check('总胆固醇详情的历史里没有心电图 QTC（404 ms）',
  !tcDetail.rows.some(t => /404/.test(t) || /\bms\b/.test(t)), JSON.stringify(tcDetail.rows));
check('总胆固醇详情的历史逐条带回来源档案',
  tcDetail.rows.length > 0 && tcDetail.srcBtns >= tcDetail.rows.length,
  JSON.stringify({ rows: tcDetail.rows.length, srcBtns: tcDetail.srcBtns }));

await page.evaluate(() => { window.__hrwDebug.closeAllLayers(); });
await page.screenshot({ path: OUT + '16-overview-counts.png' });
say('');

/* ---- 10.16 分区、抽屉同源、组行一致、锁不变量、删除反馈可见 ----
   评审点名的一类问题不是"某个数字算错"，而是"同一件事有两个算法"。所以这里的断言
   全部写成跨视图/跨分区的等式，而不是某个具体值：这类断言对夹具残留数据免疫，
   而且将来任何人再把某个口径单独改动，它会立刻红。 */
say('=== 10.16 分区求和 · 抽屉与卡片同源 · 组行口径 · 滚动锁不变量 ===');

const partCase = await page.evaluate(async () => {
  const dbg = window.__hrwDebug, L = window.Logic;
  // 血脂四项只有一份"日期待确认"的报告：按 §18 它们不该进任何按日期算的口径
  const ins = await dbg.local.database.from('documents').insert({
    document_type: '体检报告', title: '分区用例·血脂待确认', primary_date: '2025-06-06',
    date_status: '待确认', person_id: 1, source_file: 'part-case.pdf', parse_status: '已归档',
    parsed_content: '【分区用例】', type_specific_data: { structured: true, lab_results: [
      { name: '总胆固醇', result: '5.90', unit: 'mmol/L' },
      { name: '甘油三酯', result: '1.20', unit: 'mmol/L' },
      { name: '高密度脂蛋白胆固醇', result: '1.40', unit: 'mmol/L' },
      { name: '低密度脂蛋白胆固醇', result: '3.30', unit: 'mmol/L' }
    ] }
  }).select();
  if (ins.error) return { err: ins.error.message };
  await dbg.reload();
  return { ok: true };
});
check('分区夹具就位（只有日期待确认的血脂四项）', partCase.ok === true, JSON.stringify(partCase));

async function kpisUnder(label) {
  await page.evaluate(l => {
    const b = [...document.querySelectorAll('#s-overview .person-switch .ps')].find(x => x.textContent.trim() === l);
    if (b) b.click();
  }, label);
  await new Promise(r => setTimeout(r, 800));
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#s-overview .kpis .kpi').forEach(k => {
      const name = (k.querySelector('.k') || {}).textContent;
      const v = (k.querySelector('.v') || {}).textContent;
      if (name) out[name.trim()] = (v || '').replace(/\s+/g, '').trim();
    });
    // 关注表的行改在下面按 V2 的 #cardFollow 采样（旧的 tr[data-ind] 已随 V1 下线）
    return { kpis: out };
  });
}

const labels = await page.evaluate(() => {
  window.__hrwDebug.go('overview');
  return [...document.querySelectorAll('#s-overview .person-switch .ps')].map(b => b.textContent.trim());
});
await new Promise(r => setTimeout(r, 700));
const parts = {};
for (const lb of labels) parts[lb] = await kpisUnder(lb);

const sumKey = key => labels.filter(l => l !== '全部')
  .reduce((a, l) => a + (parseFloat(((parts[l] && parts[l].kpis[key]) || '0').replace(/[^\d.]/g, '')) || 0), 0);
const allDocs = parseInt((parts['全部'].kpis['档案数量'] || '0').replace(/[^\d]/g, ''), 10);
const sumDocs = sumKey('档案数量');
check('分区求和：各成员 + 未指定 的档案数之和 == 全部（悬空归属会立刻少一条）',
  sumDocs === allDocs, JSON.stringify({ all: allDocs, sum: sumDocs, per: labels.map(l => [l, parts[l].kpis['档案数量']]) }));
const allFee = parseFloat((parts['全部'].kpis['已记录医疗费用'] || '0').replace(/[^\d.]/g, ''));
const sumFee = sumKey('已记录医疗费用');
check('分区求和：费用也满足同样的等式', Math.abs(allFee - sumFee) < 0.005,
  JSON.stringify({ all: allFee, sum: sumFee }));

// 每一行都要自洽：点数为 0 的行不能显示任何"有结果"的字样。
// V2 的「点数」列来自 /api/watched 的 date_count，所以要采到 0 点的行，
// 得先有一个「对『我』完全没有数据」的指标 —— 造一份只属于妈妈的报告，
// 再把它关注到「我」名下，这样这行的点数必然是 0（否则这条断言会空转）。
const zeroRows = await page.evaluate(async () => {
  const dbg = window.__hrwDebug;
  const iso = offset => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };
  const ins = await dbg.local.database.from('documents').insert({
    document_type: '检验报告', title: '零点用例（妈妈）', primary_date: iso(30), date_status: '已确认',
    person_id: 5, source_file: 'zero-case.pdf', parse_status: '已归档',
    type_specific_data: { structured: true, lab_results: [
      { name: '零点用例指标', result: '1.0', unit: 'U/L', reference: '', flag: '', panel: '生化-肝功' }
    ] }
  }).select();
  if (ins.error) return { err: ins.error.message };
  await dbg.reload();
  const look = await (await fetch('/api/indicators?person=1&gender=all')).json();
  const blank = (look.indicators || []).find(i => i.name === '零点用例指标');
  if (!blank) return { err: '零点用例指标没进目录' };
  if (blank.obs_count) return { err: '零点指标对「我」竟然已有数据', n: blank.obs_count };
  await fetch('/api/watched/add', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: 1, indicator_id: blank.id })
  });
  dbg.go('overview');
  await new Promise(r => setTimeout(r, 500));
  const me = [...document.querySelectorAll('#s-overview [data-ps]')].find(x => x.textContent.trim() === '我');
  if (me) me.click();
  await new Promise(r => setTimeout(r, 1100));
  const rows = [...document.querySelectorAll('#cardFollow tbody tr')].map(tr => {
    const td = tr.querySelectorAll('td');
    return {
      name: td[0] ? td[0].textContent.replace(/\s+/g, ' ').trim() : '',
      latest: td[2] ? td[2].textContent.replace(/\s+/g, ' ').trim() : '',
      count: td[4] ? parseInt(td[4].textContent, 10) : NaN
    };
  });
  return { blankName: blank.name, rows, zeros: rows.filter(r => r.count === 0) };
});
check('采样里确实存在点数为 0 的行（保证下一条断言不是空转）',
  !zeroRows.err && (zeroRows.zeros || []).length > 0,
  JSON.stringify({ err: zeroRows.err, total: (zeroRows.rows || []).length,
    zeros: (zeroRows.zeros || []).length }));
check('每一行都自洽：点数为 0 的行不得显示任何「有结果」的字样',
  (zeroRows.zeros || []).every(r => /暂无|—|未提供/.test(r.latest)),
  JSON.stringify((zeroRows.zeros || []).filter(r => !/暂无|—|未提供/.test(r.latest))));

// 卡片与它背后的口径必须同源。
// V2 的费用卡由后端 /api/fees/summary 驱动（旧的「查看全部票据来源」抽屉随 V1 下线），
// 所以这里改成「卡片上的数字 == 服务端同成员的汇总」—— 仍是同一条不变量：
// 同一件事不许有两个算法。前置条件照旧靠夹具造出两位成员金额不同，避免两边都是 0 时空转通过。
const drawer = await page.evaluate(async () => {
  const dbg = window.__hrwDebug;
  const iso = offset => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };
  const mk = (title, pid, amount) => dbg.local.database.from('documents').insert({
    document_type: '医疗发票/收费单', title, primary_date: iso(5), date_status: '已确认',
    person_id: pid, amount, source_file: title + '.pdf', parse_status: '已归档',
    type_specific_data: {}
  }).select();
  await mk('同源用例·我的票据', 1, 11.11);
  await mk('同源用例·妈妈的票据', 5, 22.22);
  await dbg.reload();

  const srv = async pid => {
    const j = await (await fetch('/api/fees/summary?person=' + pid)).json();
    return ((j.fees || {}).total_cents || 0) / 100;
  };
  const srvMe = await srv(1);
  const srvMom = await srv(5);

  async function feeCard(label) {
    dbg.go('overview');
    await new Promise(r => setTimeout(r, 500));
    const b = [...document.querySelectorAll('#s-overview [data-ps]')].find(x => x.textContent.trim() === label);
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1500));
    const on = document.querySelector('#s-overview [data-ps].on');
    const v = document.querySelector('#cardFees .kv dd b');
    return {
      num: parseFloat((v ? v.textContent : '').replace(/[^\d.]/g, '')),
      active: on ? on.textContent.trim() : null
    };
  }
  const meC = await feeCard('我');
  const momC = await feeCard('妈妈');
  return { meNum: meC.num, motherNum: momC.num, srvMe, srvMom,
           meActive: meC.active, momActive: momC.active };
});
check('夹具让两位成员的费用确实不同（否则下一条断言会空转）',
  drawer.srvMe > 0 && Math.abs(drawer.srvMe - drawer.srvMom) > 0.005,
  JSON.stringify(drawer));
check('费用卡按成员取数（卡片数字 == 服务端 /api/fees/summary 同成员的汇总，不各算一遍）',
  Math.abs(drawer.meNum - drawer.srvMe) < 0.005
  && Math.abs(drawer.motherNum - drawer.srvMom) < 0.005, JSON.stringify(drawer));

// 滚动锁不变量：每一次层转换后都必须与 DOM 现状一致
const lockCheck = await page.evaluate(async () => {
  const d = window.__hrwDebug, bad = [];
  const snap = tag => {
    const on = document.querySelectorAll('.detail-layer.on').length;
    if (d.bodyLocked() !== (on > 0)) bad.push(tag + '（on=' + on + '，locked=' + d.bodyLocked() + '）');
  };
  d.closeAllLayers(); snap('全关');
  d.openLayer('docLayer'); snap('开一层');
  d.openLayer('docLayer'); snap('同一层再开一次');
  d.openLayer('indLayer'); snap('叠第二层');
  d.closeLayer(); snap('关一层');
  d.closeLayer(); snap('再关一层');
  d.closeAllLayers(); snap('全清');
  d.openLayer('drugLayer'); snap('开药品层');
  d.openLayer('drugLayer'); d.openLayer('drugLayer'); snap('药品层连开三次');
  d.closeAllLayers(); snap('收尾');
  return { bad };
});
check('滚动锁不变量：每一次层转换后，锁都等于「还有没有可见层」',
  lockCheck.bad.length === 0, JSON.stringify(lockCheck));

// 从健康档案进详情删除：反馈（含快照文件名）必须落在看得见的地方
const delVisible = await page.evaluate(async () => {
  const dbg = window.__hrwDebug;
  const ins = await dbg.local.database.from('documents').insert({
    document_type: '其他医疗资料', title: '删除反馈用例', primary_date: null,
    date_status: '日期待确认', person_id: 1, source_file: 'del-feedback.pdf',
    parse_status: '已归档', type_specific_data: {}
  }).select();
  if (ins.error || !ins.data || !ins.data.length) return { err: 'insert' };
  const id = ins.data[0].id;
  dbg.go('timeline');
  await new Promise(r => setTimeout(r, 900));
  dbg.openDoc(id, '健康档案');
  await new Promise(r => setTimeout(r, 900));
  const first = document.getElementById('btnDocDel');
  if (!first) return { err: '详情页没有删除入口' };
  first.click();                                   // 第一下只进入确认态
  await new Promise(r => setTimeout(r, 500));
  const confirm = document.getElementById('btnDocDelConfirm');
  if (!confirm) return { err: '第一下没进入确认态' };
  confirm.click();                                 // 第二下才真删
  await new Promise(r => setTimeout(r, 1600));
  const hits = [...document.querySelectorAll('body *')].filter(e =>
    e.offsetParent !== null && (e.textContent || '').indexOf('快照') >= 0 &&
    ['div', 'p', 'span'].indexOf(e.tagName.toLowerCase()) >= 0 && e.childElementCount <= 3)
    .map(e => {
      const sc = e.closest('.screen'), ly = e.closest('.detail-layer');
      const inside = (sc && sc.classList.contains('on') ? '屏幕:' + sc.id : '') +
        (ly && ly.classList.contains('on') ? '层:' + ly.id : '');
      // #globalMsg 是跨屏幕反馈槽，本来就放在所有 .screen 之外
      return (e.id ? '#' + e.id : e.tagName.toLowerCase()) + ' ← ' + (inside || (e.id === 'globalMsg' ? '跨屏反馈槽' : '不在可见处'));
    });
  return {
    view: dbg.state.view,
    // 反馈必须落在"用户此刻看得见"的地方：可见屏幕内，或专门的跨屏反馈槽
    inVisibleScreen: hits.some(h => /屏幕:|层:|跨屏反馈槽/.test(h)),
    hits
  };
});
check('从健康档案进详情删除：反馈里必须看得见快照说明（不能写进隐藏屏幕）',
  !delVisible.err && delVisible.view !== 'archive' && delVisible.inVisibleScreen === true,
  JSON.stringify(delVisible));

// 归属必须总是落在名单里：删成员时漏清任何一张表，那条记录就会从所有按人视图消失
const dangling = await page.evaluate(() => {
  const st = window.__hrwDebug.state;
  const ids = (window.__hrwDebug.state.persons || []).map(p => Number(p.id));
  const bad = [];
  ['documents', 'manual_records', 'drugs'].forEach(t => {
    ((st.tables[t] || {}).rows || []).forEach(r => {
      const p = r.person_id;
      if (p === null || p === undefined || p === '') return;
      if (ids.indexOf(Number(p)) < 0) bad.push(t + '#' + r.id + '→' + p);
    });
  });
  return { bad, roster: ids, counts: ['documents', 'manual_records']
    .map(t => t + '=' + ((st.tables[t] || {}).rows || []).length).join(' ') };
});
check('四张表里没有悬空归属：person_id 要么为空，要么在名单里',
  dangling.bad.length === 0, JSON.stringify(dangling));

// M10：改一个跟日期无关的字段，不该把"猜出来的日期"提拔成已确认
const dateStatusHold = await page.evaluate(async () => {
  const dbg = window.__hrwDebug, cloud = dbg.local;
  const ins = await cloud.database.from('documents').insert({
    document_type: '检验报告', title: '日期状态保持用例', primary_date: '2023-04-04',
    date_status: '待确认', person_id: 1, hospital: '原医院', source_file: 'keep-status.pdf',
    parse_status: '已归档', type_specific_data: {}
  }).select();
  if (!ins.data || !ins.data.length) return { err: 'insert' };
  const id = ins.data[0].id;
  await dbg.reload();          // 应用缓存里没有这条，openDoc 会静默返回，整条编辑路径就不跑了
  await new Promise(r => setTimeout(r, 500));
  const inState = (dbg.state.tables.documents.rows || [])
    .some(r => Number(r.id) === Number(id));
  // 上一节留下的详情层还端着自己的 DOM（含编辑入口）：不先收干净，
  // 「点编辑」就会点到上一条档案的抽屉上，这条断言其实在测别的记录。
  dbg.closeDrawers(); dbg.closeAllLayers();
  await new Promise(r => setTimeout(r, 400));
  dbg.openDoc(id, '健康档案');
  await new Promise(r => setTimeout(r, 1000));
  const edit = document.getElementById('btnRecEdit');
  if (!edit) return { err: '没有编辑入口', inState };
  edit.click();
  await new Promise(r => setTimeout(r, 700));
  const hosp = document.getElementById('reHospital');
  if (!hosp) return { err: '编辑抽屉没打开', inState };
  // 详情层会留着上一次渲染的 DOM —— 不校验抽屉属于哪条，就会"编辑了另一条档案"却以为改了这条
  const editing = document.getElementById('reTitle') ? document.getElementById('reTitle').value : null;
  if (editing !== '日期状态保持用例') return { err: '抽屉开在了别的记录上', editing, inState };
  hosp.value = '改过的医院';                       // 只动医院，日期一格不碰
  document.getElementById('btnRecEditSave').click();
  await new Promise(r => setTimeout(r, 1200));
  dbg.closeDrawers(); dbg.closeAllLayers();
  const back = await cloud.database.from('documents').select().eq('id', id).select();
  const row = (back.data || [])[0] || {};
  const rows = await fetch('/api/db/rows?table=documents').then(r => r.json());
  const srv = (rows.rows || []).filter(r => Number(r.id) === Number(id))[0] || {};
  return { hospital: srv.hospital, status: srv.date_status, date: srv.primary_date, ui: row.date_status, inState };
});
check('只改医院不会把「待确认」日期提拔成「已确认」（无关编辑不改统计口径）',
  !dateStatusHold.err && dateStatusHold.hospital === '改过的医院' &&
  dateStatusHold.status === '待确认' && dateStatusHold.date === '2023-04-04',
  JSON.stringify(dateStatusHold));
say('');

/* ================= 11. 旧数据迁移（浏览器 → 磁盘） ================= */
say('=== 11. 旧数据迁移（浏览器 IndexedDB → 本机磁盘）===');

// 先造一条「改造前遗留在浏览器里」的档案
const seeded = await page.evaluate(async () => {
  try {
    const drv = window.LocalDB.idbDriver;
    await drv.putRows('documents', [{
      id: 1, document_type: '检验报告', primary_date: '2023-06-01',
      title: '浏览器里的旧记录', parse_status: '已解析待结构化',
      source_attachments: [], type_specific_data: {}
    }]);
    const back = await drv.readAll('documents');
    return { ok: true, n: back.length };
  } catch (e) { return { ok: false, err: e.message }; }
});
say('浏览器内造的旧数据：' + JSON.stringify(seeded));
check('已在浏览器 IndexedDB 里造出旧数据', seeded.ok && seeded.n === 1, JSON.stringify(seeded));

// 清空磁盘，制造「磁盘为空 + 浏览器有旧数据」的真实升级场景
await page.evaluate(async () => {
  await fetch('/api/db/clear-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
});

// 刷新页面：应当弹出迁移确认（自测里 dialog 自动接受）
await page.reload({ waitUntil: 'load' });

let migrated = { rows: [] };
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  migrated = await page.evaluate(async () => {
    const r = await fetch('/api/db/rows?table=documents', { cache: 'no-store' });
    const j = await r.json();
    return { rows: j.rows.map(x => ({ id: x.id, title: x.title })) };
  });
  if (migrated.rows.length) break;
}
say('迁移后磁盘上的数据：' + JSON.stringify(migrated));
check('旧数据已迁移到磁盘', migrated.rows.length === 1 && migrated.rows[0].title === '浏览器里的旧记录',
  JSON.stringify(migrated));

const stillInIdb = await page.evaluate(async () => {
  const back = await window.LocalDB.idbDriver.readAll('documents');
  return back.length;
});
check('迁移是复制：浏览器里的原数据未被删除（可对照回退）', stillInIdb === 1, stillInIdb);
await page.screenshot({ path: OUT + '09-migrated.png' });
say('');

await page.goto(BASE + 'tests.html', { waitUntil: 'load' });
await sleep(2500);
const testPage = await page.evaluate(() => {
  const R = window.TEST_RESULTS;
  const bad = Array.prototype.slice.call(document.querySelectorAll('#out li.f'))
    .map(li => li.textContent.replace(/\s+/g, ' ').slice(0, 130));
  return { total: R ? R.total : 0, passed: R ? R.passed : 0, failed: R ? R.failed : 0, bad };
});
say('自检页：' + JSON.stringify({ total: testPage.total, passed: testPage.passed, failed: testPage.failed }));
testPage.bad.forEach(b => say('  失败用例：' + b));
check('浏览器内自检全部通过', testPage.failed === 0 && testPage.total >= 73, JSON.stringify(testPage));
await page.screenshot({ path: OUT + '06-tests.png' });
say('');

/* ================= 汇总 ================= */
say('=== 外部请求 ===');
say(external === 0 ? '0 个（页面完全本地化）' : (external + ' 个：' + externalUrls.join(' | ')));
say('=== 4xx/5xx 响应 (' + badResponses.length + ') ===');
badResponses.forEach(b => say('  ' + b));
say('=== 控制台错误 (' + errors.length + ') ===');
errors.slice(0, 30).forEach(e => say(e));
say('=== 控制台警告 (' + warns.length + ') ===');
warns.slice(0, 8).forEach(w => say(w));
say('=== 断言失败 (' + fails.length + ') ===');
fails.forEach(f => say(f));
say('');
say(fails.length === 0 && errors.length === 0
  ? '自测结论：全部断言通过，控制台无错误'
  : '自测结论：存在失败项，需要修复');

await browser.close();
fs.writeFileSync(OUT + 'selftest.log.txt', prelog.concat(log).join('\n'), 'utf8');
process.exit(fails.length === 0 && errors.length === 0 ? 0 : 1);
