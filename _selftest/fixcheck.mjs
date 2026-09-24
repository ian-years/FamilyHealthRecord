/* 本轮三修复的专项自测：
   1. 关注抽屉 UI 保存：新增不覆盖已有关注（含搜索场景）
   2. 待确认档案在详情页可一键确认日期（走 applyRecordEdit 留痕路径）
   3. 指标目录校准结果（GGT 合并、RDW 拆分、规范名、Hp 归类） */
import { createRequire } from 'module';
const require = createRequire('C:/Users/junlan/.workbuddy/binaries/node/workspace/node_modules/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Users/junlan/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8766/';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  → ' + extra : ''));
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message.slice(0, 200)));
p.on('dialog', async d => { await d.accept(); });

await p.goto(BASE, { waitUntil: 'networkidle2' });
await sleep(3500);

const rows = () => p.evaluate(async () =>
  (await (await fetch('/api/db/rows?table=documents')).json()).rows);

/* ---------- 3. 目录校准 ---------- */
const inds = await p.evaluate(async () =>
  (await (await fetch('/api/indicators?include_text=1')).json()).indicators);
const byName = {};
inds.forEach(i => byName[i.name] = i);
check('校准：γ-谷氨酰基转移酶存在', !!byName['γ-谷氨酰基转移酶']);
check('校准：y-谷氨酰 OCR 错误项已合并', !byName['血清y-谷氨酰基转移酶']);
check('校准：RDW 已拆分为 SD/CV',
  !!byName['红细胞分布宽度-SD'] && !!byName['红细胞分布宽度-CV'] && !byName['红细胞分布宽度'],
  'SD obs=' + ((byName['红细胞分布宽度-SD'] || {}).obs_count ?? '-') +
  ' CV obs=' + ((byName['红细胞分布宽度-CV'] || {}).obs_count ?? '-'));
check('校准：MCH 用规范名', !!byName['平均红细胞血红蛋白量'] && !byName['平均血红蛋白量']);
check('校准：QTc 间期规范名', !!byName['QTc间期']);
check('校准：Hp 抗体归入感染免疫', (byName['幽门螺杆菌抗体'] || {}).category === '感染免疫');

/* ---------- 1. 关注保存不覆盖（走真实 UI 保存路径） ---------- */
const watchedBefore = await p.evaluate(async () =>
  (await (await fetch('/api/watched?person=1')).json()).watched.map(w => w.id));
check('前置：成员1已有关注', watchedBefore.length > 0, watchedBefore.length + ' 项');

const allInds = await p.evaluate(async () =>
  (await (await fetch('/api/indicators?person=1')).json()).indicators);
const target = allInds.find(i => !watchedBefore.includes(i.id) && (i.obs_count || 0) > 0);
check('前置：找到可新增的指标', !!target, target && target.name);

if (target) {
  // 打开抽屉
  await p.evaluate(() => { const e = document.getElementById('v2BtnFollow'); if (e) e.click(); });
  await sleep(1500);
  const opened = await p.evaluate(() => ({
    checked: document.querySelectorAll('#v2PickList input[data-v2-pick]:checked').length,
    stat: (document.getElementById('v2FollowStat') || {}).textContent || '',
  }));
  check('修复1：打开抽屉时勾选=当前关注', opened.checked === watchedBefore.length,
    '勾选 ' + opened.checked + ' / 关注 ' + watchedBefore.length);

  // 搜索目标指标并勾上（模拟"搜索里加一个新关注"）
  await p.evaluate((kw) => {
    const s = document.getElementById('v2Search');
    s.value = kw;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, target.name);
  await sleep(400);
  // 搜索把其它已关注项都藏起来了 → 应出现"原样保留"提示
  const statAfterSearch = await p.evaluate(() =>
    (document.getElementById('v2FollowStat') || {}).textContent || '');
  check('修复1：搜索后提示隐藏项保留', statAfterSearch.indexOf('原样保留') >= 0,
    statAfterSearch.slice(0, 70));
  await p.evaluate((id) => {
    const box = document.querySelector('#v2PickList input[data-v2-pick="' + id + '"]');
    if (box && !box.checked) box.click();
  }, target.id);
  await p.evaluate(() => { const e = document.getElementById('v2FollowSave'); if (e) e.click(); });
  await sleep(1800);

  const watchedAfter = await p.evaluate(async () =>
    (await (await fetch('/api/watched?person=1')).json()).watched.map(w => w.id));
  check('修复1：搜索场景新增后旧关注全部保留',
    watchedBefore.every(id => watchedAfter.includes(id)) && watchedAfter.includes(target.id),
    '前 ' + watchedBefore.length + ' → 后 ' + watchedAfter.length);

  // 清理：取消测试关注
  await p.evaluate(async (id) => {
    await fetch('/api/watched/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_id: 1, indicator_id: id }) });
  }, target.id);
}

/* ---------- 2. 一键确认日期 ---------- */
const pendingDoc = (await rows()).find(r => r.date_status && r.date_status !== '已确认' && r.primary_date);
check('前置：存在待确认且有日期的档案', !!pendingDoc,
  pendingDoc && ('#' + pendingDoc.id + ' ' + pendingDoc.primary_date));

if (pendingDoc) {
  await p.evaluate((id) => { window.__hrwDebug.openDoc(String(id), '自测'); }, pendingDoc.id);
  await sleep(1200);
  const btn = await p.evaluate(() => !!document.getElementById('btnConfirmDate'));
  check('修复2：详情页出现「日期无误，确认」按钮', btn);
  if (btn) {
    const before = { date: pendingDoc.primary_date, tsdKeys: Object.keys(pendingDoc.type_specific_data || {}).length };
    await p.click('#btnConfirmDate');
    await sleep(2000);
    const rec = (await rows()).find(x => String(x.id) === String(pendingDoc.id));
    check('修复2：点击后状态变为已确认', rec.date_status === '已确认', rec.date_status);
    check('修复2：日期本身未被改动', rec.primary_date === before.date, rec.primary_date);
    check('修复2：其它字段未受损（lab_results 还在）',
      ((rec.type_specific_data || {}).lab_results || []).length ===
      ((pendingDoc.type_specific_data || {}).lab_results || []).length,
      'lab=' + ((rec.type_specific_data || {}).lab_results || []).length);
    const edits = (rec.manual_edits || []).length;
    check('修复2：确认动作有留痕', edits > 0, edits + ' 条');
  }
}

check('全程无 JS 报错', errors.length === 0, errors.join(' | ').slice(0, 120));

console.log('\n结果：' + (fail ? fail + ' 项失败' : '全部通过') + '（' + pass + ' 通过 / ' + fail + ' 失败）');
await p.screenshot({ path: 'fixcheck.png' });
await b.close();
process.exit(fail ? 1 : 0);
