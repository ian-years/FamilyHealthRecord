/* ============================================================
   把存量 `condition` 里的栏目名挪回 `panel`（待办 17 后半）
   ------------------------------------------------------------
   背景：归档与结构化曾经把报告分组名（`生化-肝功`、`肾功三项`、`XX-内科检查`…）
   一并抄进 `condition`。展示层已经在判它（`Logic.conditionIsPanelLabel`），
   但那治的是症状：同一分析物仍要靠"并回未标注条件"才连得上线。
   字段契约已在结构化提示词里立好（阶段 18 加了 `panel`），本脚本负责补另半边 ——
   把存量数据里的栏目名搬到它本该在的字段上。

   拆法**只有 Logic.splitCondition 一个来源**，与展示层同源；脚本自己不再判一遍。
   每条改写前还要验一条不变量：`conditionSeriesKey` 拆分前后必须相同 ——
   也就是说这次回改**只搬字段，绝不动任何一条的连线分组**。

   默认 dry-run 只读；加 --apply 才写库，写库前先打快照。
   输出一律不回显标题；条件原文里可能混着单位名，打印前按 leak_tokens.json 隐去。

   用法：
     node _patch/repanel_condition.mjs                 # 看清单（默认连 8765）
     node _patch/repanel_condition.mjs --port 8799     # 指到别的服务
     node _patch/repanel_condition.mjs --apply         # 真的改（先快照）
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
globalThis.window = globalThis;
createRequire(import.meta.url)('../app/logic.js');
const L = globalThis.Logic;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : Number(process.env.HRW_PORT || 8765);
const BASE = 'http://127.0.0.1:' + PORT;

/* ---------- 身份信息隐去：清单不在就直接中止，绝不"没清单=没泄漏" ---------- */
function loadMask() {
  let j;
  try {
    j = JSON.parse(readFileSync(path.join(ROOT, '_parse', 'leak_tokens.json'), 'utf8'));
  } catch (e) {
    console.error('中止：读不到 _parse\\leak_tokens.json（' + e.message + '）。' +
      '没有清单就没法保证打印出去的字段不含身份信息。');
    process.exit(2);
  }
  const words = [].concat(
    Object.keys(j.redact || {}),
    j.leak_check || [],
    (Object.values(j.paths || {})).map(v => String(v).split(/[\\/]/).pop())
  ).filter(w => typeof w === 'string' && w.length >= 2);
  return function mask(s) {
    let out = String(s === undefined || s === null ? '' : s);
    for (const w of words) out = out.split(w).join('【隐去】');
    return out;
  };
}
const mask = loadMask();

/* ---------- 计划：算出每一条要怎么搬，并验不变量 ---------- */
function plan(rows) {
  const edits = [];         // {id, items:[{i, from, to, panel, kind}]}
  let scanned = 0, hadPanel = 0, unchanged = 0;
  const broken = [];
  for (const row of rows) {
    const lab = ((row.type_specific_data || {}).lab_results) || [];
    const items = [];
    for (let i = 0; i < lab.length; i++) {
      const it = lab[i] || {};
      scanned++;
      const from = it.condition === undefined || it.condition === null ? '' : String(it.condition);
      if (String(it.panel || '').trim()) { hadPanel++; continue; }   // 已经有 panel：不动它
      const s = L.splitCondition(from);
      if (!s.panel) { unchanged++; continue; }
      // 不变量：只搬字段，连线分组键不许变
      if (L.conditionSeriesKey(s.condition) !== L.conditionSeriesKey(from)) {
        broken.push({ id: row.id, i, from, s });
        continue;
      }
      items.push({
        i, from, to: s.condition, panel: s.panel,
        kind: (s.condition ? 'mixed' : 'whole')
      });
    }
    if (items.length) edits.push({ id: row.id, title: row.title, items });
  }
  return { edits, scanned, hadPanel, unchanged, broken };
}

/* ---------- 后果：按分析物看条件组数怎么变（这才是回改要买的东西） ---------- */
function groupProfile(rows, applyPlan) {
  const use = applyPlan ? rows.map(rewrite) : rows;
  const byName = {};
  for (const r of use) {
    for (const it of ((r.type_specific_data || {}).lab_results) || []) {
      const n = String(it.name || '').trim();
      if (!n) continue;
      const e = byName[n] = byName[n] || { total: 0, keys: {} };
      e.total++;
      const k = L.conditionSeriesKey(it.condition || '');
      e.keys[k] = (e.keys[k] || 0) + 1;
    }
  }
  const multi = Object.keys(byName).filter(n => byName[n].total >= 2 && Object.keys(byName[n].keys).length > 1);
  return { multi: multi.map(n => [n, byName[n].total, byName[n].keys]) };
}

function rewrite(row) {
  const t = JSON.parse(JSON.stringify(row));
  const lab = ((t.type_specific_data || {}).lab_results) || [];
  for (const it of lab) {
    if (String(it.panel || '').trim()) continue;
    const s = L.splitCondition(it.condition === undefined || it.condition === null ? '' : String(it.condition));
    if (!s.panel) continue;
    it.panel = s.panel;
    it.condition = s.condition;
  }
  return t;
}

async function api(p, body) {
  const r = await fetch(BASE + p, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(p + ' 的响应不是 JSON（HTTP ' + r.status + '）');
  if (j.ok === false) throw new Error(p + ' 被拒绝：' + (j.reason || '未知原因'));
  return j;
}

async function main() {
  const info = (await api('/api/db/info')).info;
  console.log('=== 目标服务 ===');
  console.log('  端口 ' + PORT + ' ｜ 数据目录 ' + info.data_dir);
  console.log('  模式 ' + (APPLY ? '*** 写库（--apply）***' : 'dry-run（只读，什么都不改）'));
  if (APPLY && /_selftest/i.test(info.data_dir)) {
    throw new Error('中止：--apply 指向的是自测数据目录，没有回改它的意义，还会污染自测夹具。');
  }

  const rows = (await api('/api/db/rows?table=health_records')).rows || [];
  const before = groupProfile(rows, false);
  const p = plan(rows);

  console.log('\n=== 1. 覆盖范围 ===');
  console.log('  档案 ' + rows.length + ' 条 ｜ lab 项 ' + p.scanned + ' 项');
  console.log('  已有 panel 值、本脚本不碰：' + p.hadPanel + ' 项');
  console.log('  判不出栏目名、原样保留：' + p.unchanged + ' 项');
  console.log('  **将改写：' + p.edits.reduce((a, e) => a + e.items.length, 0) + ' 项，分布在 ' + p.edits.length + ' 条档案**');
  const whole = p.edits.reduce((a, e) => a + e.items.filter(x => x.kind === 'whole').length, 0);
  const mixed = p.edits.reduce((a, e) => a + e.items.filter(x => x.kind === 'mixed').length, 0);
  console.log('    其中「整串都是栏目名」' + whole + ' 项，「测量状态 + 栏目名混写」' + mixed + ' 项');
  const panels = {};
  p.edits.forEach(e => e.items.forEach(x => { panels[x.panel] = (panels[x.panel] || 0) + 1; }));
  console.log('  挪进 panel 的栏目名共 ' + Object.keys(panels).length + ' 种写法');

  console.log('\n=== 2. 不变量：分组键一个都不许变 ===');
  console.log('  ' + (p.broken.length === 0
    ? 'OK：计划里的每一次改写，conditionSeriesKey 前后相同'
    : '!! 有 ' + p.broken.length + ' 项会改变连线分组，必须先看它们'));
  p.broken.slice(0, 10).forEach(b =>
    console.log('     档案 ' + b.id + ' 第 ' + b.i + ' 项：' + mask(b.from) + ' → ' + JSON.stringify(b.s)));
  if (p.broken.length) throw new Error('中止：拆法与展示层不同源，先修 splitCondition');

  console.log('\n=== 3. 回改要买的东西：条件组数与指标归属 ===');
  const after = groupProfile(p.edits.length ? rows.map(r => {
    const e = p.edits.find(x => x.id === r.id);
    if (!e) return r;
    const t = JSON.parse(JSON.stringify(r));
    e.items.forEach(x => {
      const it = t.type_specific_data.lab_results[x.i];
      it.panel = x.panel; it.condition = x.to;
    });
    return t;
  }) : rows, false);
  console.log('  3a. 有 2 点以上却被条件切成多组的分析物：回改前 ' + before.multi.length +
    ' 个 → 回改后 ' + after.multi.length + ' 个');
  before.multi.slice(0, 8).forEach(m => {
    const a = after.multi.find(x => x[0] === m[0]);
    console.log('     ' + mask(m[0]) + '：' + m[1] + ' 点 / ' + Object.keys(m[2]).length + ' 组 → '
      + (a ? Object.keys(a[2]).length + ' 组' : '1 组'));
  });

  /* 3b. panel 一旦有值，阶段 18 那些"看 panel 才生效"的判据（尿肌酐门槛、OGTT 上下文、
     甲状腺语境）第一次会在存量数据上跑起来。所以必须量派生点的归属变化 ——
     这不是"回改的副作用"，这就是回改买的东西本身。 */
  const rewriter = r => {
    const e = p.edits.find(x => x.id === r.id);
    if (!e) return r;
    const t = JSON.parse(JSON.stringify(r));
    e.items.forEach(x => {
      const it = t.type_specific_data.lab_results[x.i];
      it.panel = x.panel; it.condition = x.to;
    });
    return t;
  };
  const sig = pts => {
    const m = {};
    pts.forEach(x => {
      const k = x.indicatorKey + '@' + x.date + '@' + x.value + '@' + (x.name || '');
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  };
  const ruleSig = pts => {
    const m = {};
    pts.forEach(x => {
      const k = (x.name || '') + '@' + x.date + '@' + x.value;
      m[k] = (m[k] || '') + '|' + x.indicatorKey + ':' + x.matchRule;
    });
    return m;
  };
  const cat = L.PRESET_CATALOG;
  const A = sig(L.deriveIndicatorPoints(rows, cat));
  const rA = ruleSig(L.deriveIndicatorPoints(rows, cat));
  const rewritten = rows.map(rewriter);
  const B = sig(L.deriveIndicatorPoints(rewritten, cat));
  const rB = ruleSig(L.deriveIndicatorPoints(rewritten, cat));
  const ruleChanged = Object.keys(rA).filter(k => rA[k] !== rB[k]);
  const gained = Object.keys(B).filter(k => !A[k]);
  const lost = Object.keys(A).filter(k => !B[k]);
  const moveFrom = {}, moveTo = {};
  lost.forEach(k => { moveFrom[k.split('@')[0]] = (moveFrom[k.split('@')[0]] || 0) + 1; });
  gained.forEach(k => { moveTo[k.split('@')[0]] = (moveTo[k.split('@')[0]] || 0) + 1; });
  console.log('  3b. 派生指标点：回改前 ' + Object.keys(A).length + ' 个 → 回改后 ' +
    Object.keys(B).length + ' 个');
  console.log('      消失 ' + lost.length + ' 个 / 新增 ' + gained.length + ' 个' +
    (lost.length || gained.length ? '（即这些点改挂了别的指标或不再被识别）' : '（完全一致）'));
  Object.keys(moveFrom).forEach(k => console.log('      离开 ' + k + '：' + moveFrom[k] + ' 点' +
    (moveTo[k] ? '（同时进入 ' + moveTo[k] + ' 点）' : '')));
  Object.keys(moveTo).filter(k => !moveFrom[k]).forEach(k =>
    console.log('      新进入 ' + k + '：' + moveTo[k] + ' 点'));
  if (lost.length || gained.length) {
    console.log('      逐条（最多 12 条，项目名已按清单隐去）：');
    lost.slice(0, 12).forEach(k => console.log('        离开 ' + k.split('@')[0] + '  ' + mask(k.split('@')[3] || '')));
    gained.slice(0, 12).forEach(k => console.log('        进入 ' + k.split('@')[0] + '  ' + mask(k.split('@')[3] || '')));
  }
  console.log('  3c. 命中规则变化的分析物：' + ruleChanged.length + ' 个（同一个点，panel 有值之后走了不同分支）');
  ruleChanged.slice(0, 12).forEach(k =>
    console.log('      ' + mask(k.split('@')[0]) + '  ' + rA[k].slice(1) + '  →  ' + rB[k].slice(1)));

  console.log('\n=== 4. 改写清单（前 12 项，标题与身份相关信息不回显）===');
  let n = 0;
  for (const e of p.edits) {
    for (const x of e.items) {
      if (n++ >= 12) { console.log('     …（其余 ' +
        (p.edits.reduce((a, y) => a + y.items.length, 0) - 12) + ' 项同类）'); break; }
      console.log('     档案 ' + e.id + ' 第 ' + x.i + ' 项：' + mask(x.from) +
        '  →  condition=' + JSON.stringify(x.to) + ' ｜ panel=' + JSON.stringify(mask(x.panel)));
    }
    if (n > 12) break;
  }

  if (!APPLY) {
    console.log('\ndry-run 结束：什么都没改。要写库加 --apply（会先自动打快照）。');
    return;
  }

  console.log('\n=== 5. 写库 ===');
  const snap = await api('/api/db/snapshot', { reason: 'before-repanel-condition' });
  console.log('  快照：' + (snap.snapshot || snap.name || JSON.stringify(snap)).slice(0, 60));
  const outRows = p.edits.map(e => {
    const row = rows.find(r => r.id === e.id);
    const t = JSON.parse(JSON.stringify(row));
    e.items.forEach(x => {
      const it = t.type_specific_data.lab_results[x.i];
      it.panel = x.panel; it.condition = x.to;
    });
    return t;
  });
  const put = await api('/api/db/put', { table: 'health_records', rows: outRows });
  console.log('  写入：' + put.written + ' 条档案（' + outRows.length + ' 条有改动）');

  console.log('\n=== 6. 回读核对：只该动 panel 与 condition ===');
  const after2 = (await api('/api/db/rows?table=health_records')).rows || [];
  let bad = 0;
  for (const orig of rows) {
    const now = after2.find(r => r.id === orig.id);
    const a = ((orig.type_specific_data || {}).lab_results) || [];
    const b = ((now.type_specific_data || {}).lab_results) || [];
    if (a.length !== b.length) { bad++; console.log('  !! 档案 ' + orig.id + ' lab 项数变了'); continue; }
    for (let i = 0; i < a.length; i++) {
      const want = (p.edits.find(e => e.id === orig.id) || { items: [] }).items.find(x => x.i === i);
      if (!want) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
          bad++; console.log('  !! 档案 ' + orig.id + ' 第 ' + i + ' 项本不该被改');
        }
        continue;
      }
      if (b[i].panel !== want.panel || b[i].condition !== want.to) {
        bad++; console.log('  !! 档案 ' + orig.id + ' 第 ' + i + ' 项没写成计划值');
      }
      for (const k of Object.keys(a[i])) {
        if (k === 'panel' || k === 'condition') continue;
        if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) {
          bad++; console.log('  !! 档案 ' + orig.id + ' 第 ' + i + ' 项字段 ' + k + ' 被顺手改了');
        }
      }
    }
    for (const k of Object.keys(orig)) {
      if (k === 'type_specific_data') continue;
      if (JSON.stringify(orig[k]) !== JSON.stringify(now[k])) {
        bad++; console.log('  !! 档案 ' + orig.id + ' 顶层字段 ' + k + ' 变了');
      }
    }
  }
  const p2 = plan(after2);
  console.log('  回改后再跑一次本脚本的判定：还剩 ' + p2.edits.reduce((a, e) => a + e.items.length, 0) +
    ' 项可搬（应为 0，否则说明拆法不幂等）');
  if (bad === 0) console.log('  OK：除 panel / condition 之外没有任何字段变化');
  else throw new Error('有 ' + bad + ' 处不符合预期，请从上面的快照回退');
}

main().catch(e => { console.error('\n中止：' + e.message); process.exit(1); });
