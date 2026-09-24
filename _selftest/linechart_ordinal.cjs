/* lineChart 渲染自测：数值模式与定性序数模式
   运行：node _selftest/linechart_ordinal.cjs */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* 最小 DOM stub：logic.js 与 app.js 载入期够用即可。
   readyState='loading' 让 app.js 末尾的 init() 不被触发。 */
global.window = global;
global.addEventListener = function () {};   /* window.addEventListener */
global.location = { search: '', hash: '', protocol: 'http:' };
global.history = { pushState() {} };
global.LocalDB = {};   /* app.js 开头会检查 LocalDB，缺失则直接 return */
global.document = {
  readyState: 'loading',
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { add() {}, remove() {} }, style: {} },
};

(0, eval)(fs.readFileSync(path.join(root, 'app/localdb.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(root, 'app/logic.js'), 'utf8'));
/* app.js 是 IIFE：把导出行注入到末尾「})();」之前，才能拿到内部函数 */
const appSrc = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
/* 只认文件末尾的「})();」——中间可能有嵌套 IIFE 的同名闭合 */
const tail = appSrc.slice(-40);
const cut = appSrc.lastIndexOf('})();');
if (cut < appSrc.length - 40) throw new Error('app.js 末尾结构不是预期的 })();');
console.error('tail= ' + JSON.stringify(tail));
(0, eval)(appSrc.slice(0, cut) + ';window.__lineChart = lineChart;\n' + appSrc.slice(cut));

const lineChart = global.__lineChart;
let ok = true;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) ok = false;
}

/* 数值模式：行为不变 —— 6 条网格线、3 个点、两位小数刻度 */
const num = lineChart({ series: [{ name: 'height', color: '#2d77c9',
  points: [{ date: '2023-11-19', value: 171 }, { date: '2024-12-28', value: 172 },
           { date: '2025-12-13', value: 173 }] }] });
check('numeric grid ticks = 6', (num.match(/stroke="#eef1f5"/g) || []).length === 6);
check('numeric dots = 3', (num.match(/<circle/g) || []).length === 3);
check('numeric decimal tick present', /\d+\.\d{2}</.test(num));

/* 定性模式：纵轴刻度是「阴性/阳性」文字，不是小数 */
const ord = lineChart({ ordinal: true, yLabels: [{ v: 0, label: '阴性' }, { v: 1, label: '阳性' }],
  series: [{ name: 'urine', color: '#2d77c9',
  points: [{ date: '2023-11-19', value: 0 }, { date: '2024-12-28', value: 1 },
           { date: '2025-12-13', value: 0 }] }] });
check('ordinal 阴性 label rendered', ord.indexOf('阴性') >= 0);
check('ordinal 阳性 label rendered', ord.indexOf('阳性') >= 0);
check('ordinal grid lines = 2', (ord.match(/stroke="#eef1f5"/g) || []).length === 2);
check('ordinal no decimal ticks', ord.indexOf('>0.50<') < 0 && ord.indexOf('-0.12') < 0);
check('ordinal path drawn', ord.indexOf('<path d="M') >= 0);
check('ordinal dots = 3', (ord.match(/<circle/g) || []).length === 3);

process.exit(ok ? 0 : 1);
