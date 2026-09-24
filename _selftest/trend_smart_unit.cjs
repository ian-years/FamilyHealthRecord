/* buildTrend 智能单位归并自测：漏印单位/未知单位量级一致 → 并线；量级对不上 → 不并 */
'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');

global.window = global;
global.location = { search: '', hash: '', protocol: 'http:' };
global.history = { pushState() {}, replaceState() {} };
global.document = {
  readyState: 'loading',
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { add() {}, remove() {} }, style: {} },
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.LocalDB = { rows: {}, load() {}, save() {} };

(0, eval)(fs.readFileSync(path.join(root, 'app/logic.js'), 'utf8'));
const L = global.Logic;
if (!L || typeof L.buildTrend !== 'function') {
  console.error('FAIL: Logic.buildTrend 不可用，导出键含 buildTrend?', L && Object.keys(L).filter(k => /trend/i.test(k)));
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name); }
}

function pt(date, value, unit, extra) {
  return Object.assign({ date: date, value: value, unit: unit, dateStatus: '已确认', name: '体重' }, extra || {});
}

console.log('== 场景1：5 条 kg + 1 条未标注单位（量级一致）→ 全部连线 ==');
let t = L.buildTrend([
  pt('2020-07-12', 59.9, 'kg'), pt('2023-11-19', 78.7, 'kg'), pt('2024-05-19', 71.3, 'kg'),
  pt('2024-12-28', 81, null), pt('2025-02-15', 65.0, 'kg'), pt('2025-12-13', 82.9, 'kg'),
]);
check('连线 6 条', t.connected.length === 6);
check('连线单位 kg', t.lineUnit === 'kg');
check('出现智能归并备注', t.notes.join('').indexOf('已一并连线') >= 0);
check('不再出现「未归一化的多单位组」', t.notes.join('').indexOf('未归一化的多单位组') < 0);
check('enough=true（可画线）', t.enough === true);

console.log('== 场景2：尿酸 μmol/L 多数组 + mg/dL 少数组（量级差 59 倍）→ 不并 ==');
t = L.buildTrend([
  { date: '2023-01-01', value: 420, unit: 'μmol/L', dateStatus: '已确认', name: '尿酸' },
  { date: '2024-01-01', value: 390, unit: 'μmol/L', dateStatus: '已确认', name: '尿酸' },
  { date: '2025-01-01', value: 7.2, unit: 'mg/dL', dateStatus: '已确认', name: '尿酸' },
]);
check('只连线 2 条（多数组）', t.connected.length === 2);
check('保留未归一化提示', t.notes.join('').indexOf('未归一化的多单位组') >= 0);

console.log('== 场景3：只有一条未标注单位记录也能并（2 点即画线）==');
t = L.buildTrend([
  pt('2024-12-28', 81, null), pt('2025-12-13', 82.9, 'kg'),
]);
check('连线 2 条', t.connected.length === 2);
check('enough=true', t.enough === true);

console.log('== 场景4：量级离谱的未知单位（体重 6500 g？量级×3 之外）→ 不并 ==');
t = L.buildTrend([
  pt('2023-11-19', 78.7, 'kg'), pt('2025-12-13', 82.9, 'kg'), pt('2024-12-28', 6500, 'g'),
]);
check('只连线 2 条', t.connected.length === 2);
check('保留多单位组提示', t.notes.join('').indexOf('仅连接占多数的') >= 0);

console.log('== 场景5：平票仍不任选（1 kg + 1 未标注，量级一致时归并后只剩一组）==');
t = L.buildTrend([pt('2024-12-28', 81, null), pt('2025-12-13', 82.9, 'kg')]);
check('未触发平票', t.tie === false);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
