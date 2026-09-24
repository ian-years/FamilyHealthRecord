/* ============================================================
   个人健康档案工作台 · 应用主体（本地版）
   ------------------------------------------------------------
   数据源：浏览器本地 IndexedDB（四张表 + 附件 Blob），不向任何服务器上传
   账号：无登录。数据归属由「本机 + 当前浏览器配置文件」界定
   解析：xParse 解析需要联网，由对话或本地启动服务完成；本页不伪造解析调用
   备份：数据只在本机，因此「导出备份」是必需能力，不是可选项
   ============================================================ */
(function () {
'use strict';

var L = window.Logic;

/* ---------------- 0. 基础设施 ---------------- */

function $(id) { return document.getElementById(id); }
function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

// 原文展示必须安全转义，防止 OCR 正文里的 HTML / 脚本被执行
function esc(s) { return L.escapeHtml(s); }
function attr(s) { return esc(s); }
function nz(v) { return (v === null || v === undefined || String(v).trim() === '') ? null : v; }
function dash(v) { var x = nz(v); return x === null ? '<span class="muted">未提供</span>' : esc(x); }
function msg(text) { return '<div class="empty">' + esc(text) + '</div>'; }

/* ---- 家庭成员辅助 ----
   person_id 是整数主键；旧记录没有这个字段时一律视为「未指定」，
   绝不猜它是谁的 —— 猜错比留空危险得多。 */

function personSupported() { return cloud && typeof cloud.hasPersons === 'function' && cloud.hasPersons(); }

function personById(pid) {
  if (pid === '' || pid === null || pid === undefined) return null;
  var id = Number(pid);
  if (!isFinite(id)) return null;
  for (var i = 0; i < S.persons.length; i++) {
    if (Number(S.persons[i].id) === id) return S.persons[i];
  }
  return null;
}

// 显示名。没有归属时返回 null，由调用方决定显示「未指定」还是干脆不显示。
function personNameOf(pid) {
  var p = personById(pid);
  return p ? String(p.name) : null;
}

// 列表 / 卡片上的成员标签。未归属时给灰色「未指定」，让遗漏可见而不是藏起来。
function personBadge(rec) {
  if (!personSupported()) return '';
  var nm = personNameOf(rec && rec.person_id);
  if (nm) return '<span class="tag person-tag">' + esc(nm) + '</span>';
  return '<span class="tag gray">未指定</span>';
}

function personCount(pid) {
  var k = String(Number(pid));
  var m = S.personStats || {};
  return Number(m[k] || 0);
}

/* 一个成员名下的行不止 documents：日常录入也带 person_id。
   删成员时只清档案，那些手动记录就变成"名单外的人"的悬空归属 ——
   既不在任何成员视图里，也不在「未指定」里，只能从「全部」看到，等于消失了。 */
function personOwnedTables(pid) {
  var out = [];
  ['documents', 'manual_records'].forEach(function (t) {
    var b = bucket(t);
    var n = (b.rows || []).filter(function (r) { return L.personMatches(r, pid); }).length;
    if (n > 0) out.push({ table: t, count: n });
  });
  return out;
}

function unassignedCount() {
  return Number((S.personStats || {}).none || 0);
}

// 成员下拉：<select> 的 option 列表。cur 为空表示「全部」，skipAll 用于归档抽屉（必选）。
function personOptions(cur, skipAll) {
  var opts = [];
  if (!skipAll) {
    opts.push('<option value=""' + (cur === '' ? ' selected' : '') + '>全部成员</option>');
  }
  S.persons.forEach(function (p) {
    opts.push('<option value="' + attr(String(p.id)) + '"' +
      (String(cur) === String(p.id) ? ' selected' : '') + '>' +
      esc(p.name) + '</option>');
  });
  if (!skipAll) {
    // 旧数据没有归属，给一个显式入口把它挑出来，避免混在「全部」里看不见
    opts.push('<option value="__none__"' + (cur === '__none__' ? ' selected' : '') +
      '>未指定</option>');
  }
  return opts.join('');
}

// 全局成员视图下拉：与概览切换器同语义（all=全部 / 0=未指定 / id=成员），
// 供健康档案、原始资料档案、药品页复用 —— 三处读写的都是 S.personView，
// 一处选人全站跟随（§11 待办 14）。
// value 约定沿用旧筛选器：''=全部、'__none__'=未指定、id=成员 —— 这样既有调用方
// 与 E2E 自测（还在用 '__none__' 哨兵）都不受影响，映射由 setPersonView 统一做。
function personViewOptions() {
  var opts = '<option value=""' + (L.isAllView(S.personView) ? ' selected' : '') + '>全部成员</option>';
  S.persons.forEach(function (p) {
    opts += '<option value="' + attr(String(p.id)) + '"' +
      (String(S.personView) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  });
  opts += '<option value="__none__"' + (Number(S.personView) === 0 ? ' selected' : '') + '>未指定</option>';
  return opts;
}

// 把筛选下拉的 value 规整成 S.personView 的三态（null=全部 / 0=未指定 / id=成员）。
function personViewFromSelect(v) {
  if (v === '' || v === null || v === undefined || v === 'all') return null;
  if (v === '__none__') return 0;
  return Number(v);
}

// 筛选 predicate：返回 true 表示命中。
// '__none__' 是下拉里那个「未指定」的哨兵值，专门用来把没有归属的老档案挑出来。
function personMatch(rec, filter) {
  if (!filter) return true;
  var pid = rec.person_id;
  var isNone = (pid === '' || pid === null || pid === undefined);
  if (filter === '__none__') return isNone;
  return !isNone && String(pid) === String(filter);
}

// 归档抽屉的默认归属：优先上次选择，其次「我」（role=self），最后第一个成员。
// 没有成员时返回空串 —— 此时允许不带归属写入，并在预览区如实说明。
/* 「必须落到某一个人」的下拉（日常录入等）：成员 + 未指定，
   不给「全部成员」这种视图值 —— 一条记录不能同时记在全家头上。 */
function personOwnerOptions(cur) {
  var opts = S.persons.map(function (p) {
    return '<option value="' + attr(String(p.id)) + '"' +
      (String(cur) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }).join('');
  opts += '<option value="__none__"' + (String(cur) === '__none__' ? ' selected' : '') +
    '>未指定</option>';
  return opts;
}

// 日常录入默认归属：概览正看着某人就用某人，否则沿用归档那套默认（上次选择 → 我 → 第一个）
function dyPersonDefault() {
  if (!L.isAllView(S.personView) && Number(S.personView) !== 0) return String(S.personView);
  return defaultPersonId() || '__none__';
}

function defaultPersonId() {
  if (!personSupported()) return '';
  if (S.pendingPerson) return String(S.pendingPerson);
  for (var i = 0; i < S.persons.length; i++) {
    if (S.persons[i].role === 'self') return String(S.persons[i].id);
  }
  return S.persons.length ? String(S.persons[0].id) : '';
}

// 归档包自带的成员归属要把选择器同步过去，否则用户会以为选了、实际写的是另一个人。
// 只在「包刚加载」时同步一次，之后用户改过的选择不被覆盖（换原始文件不等于换人）。
function syncImportPersonFromPayload() {
  var sel = $('impPerson');
  if (!sel || !IMPORT.payload || IMPORT.payload.parseError) return;
  if (IMPORT.personApplied) return;
  IMPORT.personApplied = true;
  var r0 = (IMPORT.payload.records || [])[0];
  var want = r0 ? r0.person_id : null;
  if (want === null || want === undefined || want === '') return;
  if (!personById(want)) return;                 // 指向不存在的成员时宁可不选，也不猜是谁
  S.pendingPerson = String(want);
  sel.value = String(want);
}

// 页面必须由项目自带的本地服务打开：数据存在服务端的 data/ 目录里，
// 用 file:// 直接打开既读不到数据，也调不到解析接口。给出可执行的指引，而不是白屏。
if (!window.LocalDB) {
  document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card">' +
    '<h1>脚本未加载</h1><p class="sub">localdb.js 没有加载成功。请确认 <code>app</code> 目录下的文件完整，' +
    '然后强制刷新页面（Windows：Ctrl+F5）。</p></div></div>';
  return;
}
if (location.protocol === 'file:') {
  document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card">' +
    '<h1>请从本地服务打开</h1>' +
    '<p class="sub">本页是用 <code>file://</code> 直接打开的。数据存在项目目录的 <code>data\\</code> 里，' +
    '需要通过项目自带的本地服务读写，直接打开网页会取不到任何数据。</p>' +
    '<div class="note" style="text-align:left;margin-top:14px">' +
    'Windows：双击项目根目录的 <code>启动本地工作台.bat</code><br>' +
    'macOS / Linux：在项目根目录执行 <code>./start.sh</code> 或 <code>python3 server.py</code><br>' +
    '启动后浏览器打开它给出的 <code>http://127.0.0.1:端口</code>。这个服务只监听本机，' +
    '局域网内的其他设备访问不到。' +
    '</div></div></div>';
  return;
}

// 数据由本机服务写进项目目录的 data\：
//   health.db   四张表      files\   原始附件      snapshots\   自动快照
// 浏览器里点「清除浏览数据」不会动到这里的任何记录。
var cloud = window.LocalDB.createLocal();
var SERVER = { info: null, error: '' };

var PAGE = 200;
var MAX_PAGES = 100;   // 单表加载上限 20000 条；超限显式报错，不静默截断


/* ---------------- 1. 状态 ---------------- */

var S = {
  local: null,                       // 本地存储统计：附件数量与占用字节
  view: 'overview',
  range: '12',                       // 12 | 3 | all
  tables: {
    documents: { state: 'idle', rows: [], error: null, count: 0 },
    drugs: { state: 'idle', rows: [], error: null, count: 0 },
    indicators: { state: 'idle', rows: [], error: null, count: 0 },
    manual_records: { state: 'idle', rows: [], error: null, count: 0 }
  },
  booted: false,
  filters: { q: '', type: '', hospital: '', person: '' },
  archFilter: { q: '', type: '', person: '' },
  rcFilter: { year: '' },
  // 家庭成员：名单存在服务端 persons 表里，personSupported=false 时界面不显示成员筛选
  persons: [],
  personView: null,                  // 概览与指标按谁展示：null=全部，0=未指定，其余为成员 id
  followNotice: '',                  // 关注设置保存后的一句反馈
  personStats: {},
  personState: 'idle',               // idle | ok | error | unsupported
  personError: '',
  pendingPerson: null,               // 归档抽屉里尚未写入的成员选择
  expanded: {},                      // 'YYYY-MM' -> true
  expandedYears: {},                 // 'YYYY' -> true
  actYears: {},                      // 资料活动展开年份
  scroll: {},                        // view -> 窗口 scrollTop（滚动的是窗口，不是 .main）
  mainScroll: 0,                     // 打开第一个详情层时的窗口位置，关掉后滚回去
  layerStack: [],
  indCtx: null,
  rcScroll: 0,
  drugArchiveTarget: null,
  signedCache: {}                    // storage path -> {url, exp}
};

/* ---------------- 2. 数据访问 ---------------- */

function bucket(name) { return S.tables[name]; }

async function fetchAll(table, orderCol) {
  var out = [], from = 0, guard = 0;
  while (true) {
    var q = cloud.database.from(table).select('*');
    if (orderCol) q = q.order(orderCol, { ascending: false });
    q = q.range(from, from + PAGE - 1);
    var res = await q;
    if (res.error) throw res.error;
    var rows = res.data || [];
    out = out.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
    // 分页上限不是「静默截断」的理由：超过上限必须暴露为读取不完整，
    // 而不是让汇总与来源看起来完整（指令 §23 验收 58）。
    if (++guard >= MAX_PAGES) {
      throw new Error('记录数超过单表加载上限（' + (MAX_PAGES * PAGE) +
        ' 条），本次只取回前 ' + out.length + ' 条。汇总与来源可能不完整，请先归档或清理历史记录。');
    }
  }
  return out;
}

// 四张表分别加载、分别记状态：任何一张失败都不能被成功回调掩盖（指令 §21）
async function loadTable(name, orderCol) {
  var b = bucket(name);
  b.state = 'loading'; b.error = null;
  renderSyncStrip();
  try {
    var rows = await fetchAll(name, orderCol);
    b.rows = rows; b.count = rows.length; b.state = 'ok';
  } catch (e) {
    b.state = 'error';
    b.error = (e && (e.message || e.hint)) ? (e.message || e.hint) : '读取失败';
    b.rows = []; b.count = 0;
  }
  renderSyncStrip();
  return b;
}

/* 家庭成员名单（存在服务端 persons 表里）。
   读失败时降级为 unsupported：界面不再显示成员筛选与成员管理，
   而不是显示一个点下去必然空转的功能。 */
// 数据层不支持成员时把入口藏起来。留一个点进去必然空转的功能，比没有这个功能更糟。
function syncNavPersons() {
  var btn = $('navPersons');
  if (!btn) return;
  btn.style.display = personSupported() ? '' : 'none';
  // 停在成员管理页却不再支持时退回概览，避免白屏
  if (!personSupported() && S.view === 'persons') go('overview');
}

async function loadPersons() {
  syncNavPersons();
  if (!personSupported()) {
    S.personState = 'unsupported';
    S.persons = []; S.personStats = {};
    return;
  }
  try {
    var r = await cloud.persons();
    if (r.supported === false) {
      S.personState = 'unsupported';
      S.persons = []; S.personStats = {};
      S.personError = r.error || '';
      return;
    }
    S.persons = r.persons || [];
    S.personStats = r.stats || {};
    S.personState = 'ok';
    S.personError = '';
    syncNavPersons();
  } catch (e) {
    S.personState = 'error';
    S.personError = (e && e.message) ? e.message : '成员名单读取失败';
  }
}

// 名单与统计一起刷新：改完成员、批量归属、导入之后都要调
async function refreshPersons() {
  await loadPersons();
}

async function loadAll() {
  await Promise.all([
    loadTable('documents', 'primary_date'),
    loadTable('drugs', 'updated_at'),
    loadTable('indicators', 'sort_order'),
    loadTable('manual_records', 'record_date')
  ]);
  await ensureCatalog();
  await loadPersons();
  /* 关注清单的唯一真源是 watched_indicators（按人一份，服务端存）。
     旧版在启动时逐行回写目录行上的 followers —— 那套已随 V1 删掉。 */
  S.booted = true;
}

// 首次登录时初始化预置指标目录（真实写入，失败不伪装成功）
async function ensureCatalog() {
  var b = bucket('indicators');
  if (b.state !== 'ok') return;
  if (b.rows.length > 0) return;
  var payload = L.PRESET_CATALOG.map(function (c) {
    return {
      name: c.name, key: c.key, grp: c.grp, type: c.type, unit: c.unit || null,
      aliases: c.aliases || [], followed: !!c.followed, sort_order: c.order, preset: !!c.preset
    };
  });
  var res = await cloud.database.from('indicators').insert(payload).select();
  if (res.error) { b.error = '初始化指标目录失败：' + res.error.message; renderSyncStrip(); return; }
  await loadTable('indicators', 'sort_order');
}

// 数据库是目录的数据源（名称/分组/单位/关注/排序）；换算规则与 OGTT 归类属于
// 展示层派生元数据，按稳定标准键从逻辑层合并，避免依赖可修改的显示名称。
function mergeCatalogMeta(row) {
  var p = null;
  for (var i = 0; i < L.PRESET_CATALOG.length; i++) {
    if (L.PRESET_CATALOG[i].key === row.key) { p = L.PRESET_CATALOG[i]; break; }
  }
  if (!p) return row;
  var m = Object.assign({}, row);
  if (p.analyze) m.analyze = p.analyze;
  if (p.ogtt) m.ogtt = p.ogtt;
  if (p.needsLipidContext) m.needsLipidContext = true;
  if (p.extraAliases) m.extraAliases = p.extraAliases;
  return m;
}

function catalogSort(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); }
// 定义（名称/单位/别名/换算）全家共用一份，catalogList 不做按人裁剪；
// 按人的「关注」由 V2 的 watched_indicators 维护，不再挂在目录行上。
function catalogList() { return bucket('indicators').rows.map(mergeCatalogMeta).sort(catalogSort); }
function personViewLabel() {
  if (L.isAllView(S.personView)) return '全部';
  var n = personNameOf(S.personView);
  return n || '未指定';
}

function catalogByKey() {
  var m = {};
  catalogList().forEach(function (c) { m[c.key] = c; });
  return m;
}

/* ---------------- 3. 附件 ---------------- */

// 附件对象：文件名 / 存储标识(path) / 可访问地址 / MIME / 大小 / 页序
// 本地版地址是浏览器生成的对象地址（blob:），只在本机会话内有效，不涉及任何网络凭据
async function signedUrl(path) {
  if (!path) return null;
  var c = S.signedCache[path];
  if (c && c.exp > Date.now() + 30000) return c.url;
  try {
    var res = await cloud.storage.createSignedUrl(path, 3600);
    if (res.error || !res.data) return null;
    var url = res.data.signedUrl || res.data.url || res.data;
    S.signedCache[path] = { url: url, exp: Date.now() + 3500 * 1000 };
    return url;
  } catch (e) { return null; }
}

function attachmentsOf(rec) {
  var a = rec && rec.source_attachments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
  return Array.isArray(a) ? a : [];
}

async function uploadOriginal(file) {
  var ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  // 本地版没有多用户目录；userPath 只保留调用签名，路径本身就是本地存储键
  var path = cloud.storage.userPath('local', 'attachments/' + uuid() + '.' + ext);
  var up = await cloud.storage.upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (up.error) throw up.error;
  var url = await signedUrl(path);
  return {
    name: file.name,
    path: path,
    url: url,
    mime_type: file.type || 'application/octet-stream',
    size: file.size,
    page: null
  };
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function sha256Hex(file) {
  if (!(window.crypto && crypto.subtle)) return null;
  try {
    var buf = await file.arrayBuffer();
    var d = await crypto.subtle.digest('SHA-256', buf);
    return Array.prototype.map.call(new Uint8Array(d), function (b) {
      return ('00' + b.toString(16)).slice(-2);
    }).join('');
  } catch (e) { return null; }
}

/* ---------------- 4. 指标数据组装 ---------------- */

/* ---------------- 5. 启动（本地版：无登录） ---------------- */

// 本地版没有账号体系，打开即可用。这里只加载数据并做存储自检，失败如实显示。
async function startApp() {
  console.log('[dbg] startApp enter');
  $('app').classList.remove('hidden');
  var who = $('whoami');
  if (who) who.textContent = '本机磁盘存储 · 无需登录';
  renderSyncStrip();
  await refreshLocalStats();
  // 先确认后端是不是 V2 结构：loadAll 里的旧逻辑要靠它决定让不让路
  if (window.V2) { try { await V2.probe(); } catch (e) { } }
  await checkLegacyMigration();
  await loadAll();
  renderCurrent();
}

// 数据规模与位置来自本机数据服务（项目目录下的 data\），不是浏览器。
async function refreshLocalStats() {
  try {
    var b = await window.LocalDB.serverDriver.probe();
    if (!b.ok) {
      SERVER.info = null;
      SERVER.error = b.reason;
      S.local = { error: b.reason };
      return;
    }
    SERVER.info = b.info;
    SERVER.error = '';
    S.local = { files: b.info.files, fileBytes: b.info.file_bytes };
  } catch (e) {
    SERVER.info = null;
    SERVER.error = (e && e.message) || '读取本机数据服务失败';
    S.local = { error: SERVER.error };
  }
}

/* 一次性把浏览器 IndexedDB 里的旧数据搬到本机磁盘。
   只在「磁盘上还没有任何记录」且「浏览器里确实有旧数据」时才提示，
   且是复制而非删除——浏览器里的原数据保持不动，便于对照与回退。 */
async function checkLegacyMigration() {
  try {
    if (!window.LocalDB.idbDriver) return false;
    if (!SERVER.info || !SERVER.info.counts) return false;
    /* 「磁盘上还没有记录」说的是用户数据（档案 / 药品 / 手填记录）。
       指标目录是归一化出来的派生知识 —— 「清空本机数据」刻意不清它，
       所以不能把 indicators 算进来：算进来之后清空完磁盘仍"不为空"，
       这道门禁永远为假，浏览器里的旧档案再也搬不过来。 */
    var total = (typeof SERVER.info.records === 'number')
      ? SERVER.info.records
      : Object.keys(SERVER.info.counts)
        .filter(function (k) { return k !== 'indicators'; })
        .reduce(function (a, k) { return a + SERVER.info.counts[k]; }, 0);
    if (total > 0) return false;

    var drv = window.LocalDB.idbDriver;
    var counts = {}, oldTotal = 0;
    for (var i = 0; i < window.LocalDB.TABLES.length; i++) {
      var t = window.LocalDB.TABLES[i];
      var rows = [];
      try { rows = await drv.readAll(t); } catch (e) { rows = []; }
      counts[t] = rows.length;
      oldTotal += rows.length;
    }
    if (!oldTotal) return false;

    var desc = Object.keys(counts).map(function (k) {
      return '  · ' + k + '：' + counts[k] + ' 条';
    }).join('\n');
    if (!confirm('检测到浏览器本地数据库里还留着旧数据：\n\n' + desc +
      '\n\n本机磁盘上还没有记录。是否把这些旧数据迁移到磁盘？\n\n' +
      '· 迁移是「复制」，浏览器里的原数据会保持不动，可随时对照；\n' +
      '· 迁移包含原始附件，数据多时可能需要十几秒；\n' +
      '· 迁移完成后，页面读写的就都是磁盘上的数据了。')) return false;

    var old = window.LocalDB.createLocal({ driver: drv });
    var backup = await old.exportBackup();
    var res = await cloud.importBackup(backup);
    if (!res || !res.ok) {
      alert('迁移未完成：' + ((res && res.errors && res.errors.join('；')) || '未知原因') +
        '\n\n磁盘上的数据没有被改动，浏览器里的原数据也没有被删除。');
      return false;
    }
    await refreshLocalStats();
    var written = 0;
    Object.keys(res.counts || {}).forEach(function (k) { written += res.counts[k]; });
    alert('迁移完成。\n\n已写入 ' + written + ' 条记录、' + res.filesWritten +
      ' 个附件到本机磁盘。\n\n浏览器里的旧数据仍然保留；确认磁盘数据无误后，' +
      '你可以在浏览器设置里清理该站点的数据来释放空间。');
    return true;
  } catch (e) {
    alert('迁移未完成：' + ((e && e.message) || '未知错误') +
      '\n\n磁盘上的数据没有被改动，浏览器里的原数据也没有被删除。');
    return false;
  }
}

/* ---------------- 5.1 解析桥（可选，联网调用 xParse） ---------------- */

// 解析本身必须联网，而网页不能直接运行解析工具。项目内的「本地服务」同时提供
// 页面访问与一个本机解析接口：桥在运行时「上传并解析」可用；桥不在时如实显示为
// 不可用，不显示进度条、不假装成功、不在解析失败时写入任何记录。
var BRIDGE = { checked: false, ok: false, reason: '', info: null };

async function probeBridge(force) {
  // 只缓存「成功」的结果：失败不缓存，这样服务起来之后重新进本页就能恢复，
  // 不会因为第一次探测失败就永久显示为不可用。
  if (BRIDGE.checked && BRIDGE.ok && !force) return BRIDGE;
  BRIDGE.checked = true; BRIDGE.ok = false; BRIDGE.reason = ''; BRIDGE.info = null;
  if (location.protocol === 'file:') {
    BRIDGE.reason = '当前是 file:// 打开，无法访问本机解析接口';
    return BRIDGE;
  }
  try {
    var r = await fetch('/api/health', { cache: 'no-store' });
    var j = null;
    try { j = await r.json(); } catch (e2) { j = null; }
    if (!r.ok || !j) { BRIDGE.reason = '本机解析接口返回 ' + r.status; return BRIDGE; }
    BRIDGE.info = j;
    BRIDGE.ok = !!j.ok;
    if (!j.ok) BRIDGE.reason = j.reason || '解析工具未就绪';
  } catch (e) {
    BRIDGE.reason = '本机解析接口未启动';
  }
  return BRIDGE;
}

// 解析只能给出原文，主日期按「出现次数最多的合法日期」推测，状态保持待确认，
// 由人在归档前确认。推测不出来就留空，不编造日期。
function guessDate(text) {
  var m = String(text || '').match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g);
  if (!m || !m.length) return null;
  var tally = {};
  m.forEach(function (s) {
    var p = s.replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-').split('-');
    if (p.length < 3) return;
    var iso = p[0] + '-' + ('0' + p[1]).slice(-2) + '-' + ('0' + p[2]).slice(-2);
    if (!L.isValidDate(iso)) return;
    tally[iso] = (tally[iso] || 0) + 1;
  });
  var best = null, n = 0;
  Object.keys(tally).forEach(function (k) { if (tally[k] > n) { n = tally[k]; best = k; } });
  return best;
}

function setParseMsg(text, isErr) {
  var el = $('parseMsg');
  if (!el) return;
  el.innerHTML = text ? '<div class="' + (isErr ? 'err-bar' : 'note') + '">' + esc(text) + '</div>' : '';
}

async function doParseUpload() {
  var input = $('parseFiles');
  if (!input || !input.files || !input.files.length) return setParseMsg('请先选择要解析的文件。', true);
  var files = Array.prototype.slice.call(input.files);
  var btn = $('btnParseUpload');
  btn.disabled = true; btn.textContent = '解析中…';
  setParseMsg('正在提交解析（' + files.length + ' 个文件；同一份资料的多页请一次选中）…');
  try {
    // 以 JSON + base64 提交：服务端只用标准库即可解析，不依赖 multipart 解析库
    var payload = { files: [] };
    for (var i = 0; i < files.length; i++) {
      payload.files.push({
        name: files[i].name,
        type: files[i].type || '',
        size: files[i].size,
        dataBase64: await window.LocalDB.blobToBase64(files[i])
      });
    }
    var r = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var j = null;
    try { j = await r.json(); } catch (e2) { j = null; }
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && (j.reason || j.message)) || ('解析接口返回 ' + r.status));
    }
    var docs = j.documents || [];
    if (!docs.length) throw new Error('解析服务没有返回任何文档内容');
    var markdown = docs.map(function (d) {
      return '【' + d.name + '】\n\n' + String(d.markdown || '');
    }).join('\n\n---\n\n');
    var guessed = guessDate(markdown);
    openImportDrawer(null, {
      files: files,
      payload: {
        target: 'documents',
        records: [{
          document_type: '其他医疗资料',
          primary_date: guessed,
          /* 解析读到了合法日期就直接按「已确认」归档（用户规则：没日期才需要确认）；
             日期留空才进「待确认」。抽屉里改日期会按新值重新判定。 */
          date_status: guessed ? L.DATE_STATUS.CONFIRMED : L.DATE_STATUS.PENDING,
          title: null,
          key_information: null,
          amount: null,
          source_file: files.map(function (f) { return f.name; }).join('、'),
          source_attachments: [],
          parsed_content: markdown,
          type_specific_data: {
            structured: false,
            parse_note: '本记录由本机解析接口写入原文，检验项、检查所见、收费明细等结构化字段尚未提取。' +
                        '需要结构化时，请把原件提交到对话中由解析与结构化流程处理。',
            guessed_date: guessed || null,
            pages: files.length
          },
          parse_status: '已解析待结构化',
          xparse_task_id: j.task_id || null,
          xparse_run_id: j.run_id || null
        }]
      }
    });
    var chars = 0;
    docs.forEach(function (d) { chars += String(d.markdown || '').length; });
    var head = '解析完成：' + docs.length + ' 个文档、共 ' + chars + ' 字' +
      (j.elapsed !== undefined ? '，耗时 ' + j.elapsed + ' 秒' : '') +
      '（任务 ' + String(j.task_id || '未返回').slice(0, 12) + '）。';
    if (chars < 200) {
      setParseMsg(head + ' 读出的文字很少 —— 常见原因是照片模糊、倾斜、反光或有阴影遮挡，' +
        '请重拍后再试。已生成的内容仍在弹窗里，是否写入由你决定。', true);
    } else {
      setParseMsg(head + ' 请在弹窗里确认类型与日期后再写入；这一步只得到原文，结构化字段仍为空。');
    }
    renderParseLog();
  } catch (e) {
    setParseMsg('解析未完成：' + (e.message || '未知错误') + '。没有写入任何数据。', true);
    renderParseLog();
  }
  btn.disabled = false; btn.textContent = '上传并解析';
}

/* ---------------- 5.2 备份与恢复（数据只在本机，这是必需能力） ---------------- */

async function doExportBackup() {
  var btn = $('btnBackup');
  if (btn) { btn.disabled = true; btn.textContent = '打包中…'; }
  try {
    var b = await cloud.exportBackup();
    var name = '健康档案备份_' + new Date().toISOString().slice(0, 10) + '.json';
    var text = JSON.stringify(b);
    window.LocalDB.download(name, text, 'application/json');
    var total = Object.keys(b.counts).reduce(function (a, k) { return a + b.counts[k]; }, 0);
    alert('备份已导出：' + name + '\n\n' +
      '四张表共 ' + total + ' 条记录，附件 ' + b.file_count + ' 个，文件约 ' +
      window.LocalDB.formatBytes(text.length) + '。\n\n' +
      '这份文件等同于本机的全部健康数据，请放在你自己可控的位置，不要随意分享或上传。');
  } catch (e) {
    alert('导出失败：' + (e.message || '未知错误') + '。本地数据没有改变。');
  }
  if (btn) { btn.disabled = false; btn.textContent = '导出备份'; }
}

function setRestoreMsg(text, isErr) {
  var el = $('restoreMsg');
  if (!el) return;
  el.innerHTML = text ? '<div class="' + (isErr ? 'err-bar' : 'note') + '">' + esc(text) + '</div>' : '';
}

async function doRestoreBackup() {
  var f = $('rsFile') && $('rsFile').files[0];
  if (!f) return setRestoreMsg('请先选择备份文件。', true);
  var obj = null;
  try { obj = JSON.parse(await f.text()); }
  catch (e) { return setRestoreMsg('该文件不是合法的 JSON，无法作为备份恢复。', true); }
  var v = window.LocalDB.pure.validateBackup(obj);
  if (!v.ok) return setRestoreMsg('备份校验未通过：' + v.errors.join('；'), true);

  var btn = $('btnRestoreConfirm');
  var mode = 'replace';
  var modeEl = document.querySelector('input[name="restoreMode"]:checked');
  if (modeEl && modeEl.value === 'merge') mode = 'merge';
  var counts = Object.keys(v.tables).map(function (k) { return k + ' ' + v.tables[k].length + ' 条'; }).join('，');
  var confirmText = (mode === 'merge')
    ? ('将「只合并不覆盖」地恢复：本地已有的记录与附件保留，只补入备份里有、本地缺的部分。\n\n' +
       '备份内容：' + counts + '，附件 ' + v.files.length + ' 个。\n\n要继续吗？')
    : ('恢复会先清空本机现有的四张表与全部附件，再写入备份内容。此操作不可撤销。\n\n' +
       '备份内容：' + counts + '，附件 ' + v.files.length + ' 个。\n\n要继续吗？');
  if (!confirm(confirmText)) return;

  btn.disabled = true; btn.textContent = '恢复中…';
  try {
    var res = await cloud.importBackup(obj, mode);
    if (!res.ok) throw new Error(res.errors.join('；'));
    cloud.invalidate();
    await loadAll();
    await refreshLocalStats();
    closeDrawers();
    renderCurrent();
    if (mode === 'merge') {
      alert('已合并恢复：补入 ' + res.written + ' 条记录、附件 ' + res.filesWritten + ' 个' +
        (res.metaWritten ? '，新增成员 ' + res.metaWritten + ' 位' : '') + '。本地已有内容保持不变。');
    } else {
      alert('已从备份恢复：四张表共 ' + res.written + ' 条记录，附件 ' + res.filesWritten + ' 个' +
        (res.metaWritten ? '，成员名单已一并还原' :
          '。这份备份里没有成员名单（较早期的备份格式），' +
          '成员名单保持原样未改动') + '。');
    }
    btn.disabled = false; btn.textContent = '确认恢复';
  } catch (e) {
    setRestoreMsg('恢复失败：' + (e.message || '未知错误') + '。本机数据可能已部分改变，请用导出备份复核。', true);
    btn.disabled = false; btn.textContent = '确认恢复';
  }
}

// 打开「从备份恢复」抽屉。每次打开都清掉上一次选中的文件与提示，
// 避免用户以为还沿用着上一次选择的备份。
function openRestoreDrawer() {
  var rf = $('rsFile');
  if (rf) rf.value = '';
  setRestoreMsg('');
  openDrawer('drawer-restore');
}

async function doClearLocal() {
  if (!confirm('这会清空本机保存的四张表与全部附件，清空后无法恢复（除非你已有导出备份）。要继续吗？')) return;
  if (!confirm('再次确认：立即清空本机全部健康数据？')) return;
  try {
    await cloud.clearAll();
    cloud.invalidate();
    await loadAll();
    await refreshLocalStats();
    renderCurrent();
    alert('本机数据已清空。');
  } catch (e) {
    alert('清空失败：' + (e.message || '未知错误'));
  }
}

/* ---------------- 5.3 大模型结构化（可选，需自备密钥） ----------------
   解析只把图片/PDF 变成原文，不认识「哪个是检验项、哪个是金额」。
   这一段把原文交给一个 OpenAI 兼容的模型服务，拆成四张表要的字段。
   调用前服务端会先在本机做身份信息脱敏，只把脱敏后的原文发出去。 */

var LLM = { config: null };

function setLlmDrawerMsg(text, isErr) {
  var el = $('llmDrawerMsg');
  if (!el) return;
  el.innerHTML = text ? '<div class="' + (isErr ? 'err-bar' : 'ok-bar') + '">' + esc(text) + '</div>' : '';
}

function llmFieldLabel(t) {
  return '<div style="font-size:12px;color:#5b6b7c;margin:10px 0 4px">' + esc(t) + '</div>';
}

async function loadLlmConfig() {
  try {
    var r = await fetch('/api/llm/config', { cache: 'no-store' });
    var j = await r.json();
    if (j && j.ok) { LLM.config = j.config; return j.config; }
  } catch (e) { /* 保持 null，界面显示未配置 */ }
  return null;
}

async function openLlmDrawer() {
  var cfg = (await loadLlmConfig()) || { presets: [] };
  var opts = (cfg.presets || []).map(function (x) {
    return '<option value="' + attr(x.id) + '"' +
      (cfg.preset === x.id ? ' selected' : '') + '>' + esc(x.label) + '</option>';
  }).join('');
  var inputStyle = 'width:100%;padding:7px 9px;border:1px solid #cfd8e3;border-radius:6px;font-size:13px;box-sizing:border-box';
  var html = '' +
    '<div class="note" style="margin-top:0">解析只给原文，「智能结构化」把原文拆成字段。' +
    '这里填 <b>OpenAI 兼容</b>接口即可 —— 阿里云百炼、DeepSeek、智谱、本机 Ollama 都能用。' +
    '配置只写在本机 <code>data\\llm.json</code>，不进代码、不进备份文件。</div>' +
    llmFieldLabel('服务商（选择后自动填地址与模型名）') +
    '<select id="llmPreset" style="' + inputStyle + '">' + opts + '</select>' +
    llmFieldLabel('接口地址 base_url') +
    '<input id="llmBase" type="text" style="' + inputStyle + '" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" value="' + attr(cfg.base_url || '') + '">' +
    llmFieldLabel('模型名') +
    '<input id="llmModel" type="text" style="' + inputStyle + '" placeholder="qwen-plus" value="' + attr(cfg.model || '') + '">' +
    llmFieldLabel('API Key') +
    '<input id="llmKey" type="password" style="' + inputStyle + '" placeholder="' +
      (cfg.has_key ? '已保存（' + attr(cfg.key_hint) + '），留空表示不改' : '粘贴你的密钥') + '">' +
    '<label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:13px">' +
    '<input type="checkbox" id="llmClearKey"> 清除已保存的密钥</label>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
    '<button class="btn primary" id="btnLlmSave">保存</button>' +
    '<button class="btn" id="btnLlmTest">保存并测试连通</button>' +
    '<button class="btn" id="btnLlmCancel">取消</button>' +
    '</div><div id="llmDrawerMsg"></div>' +
    '<div class="note">安全提示：密钥等同账号凭据。密钥只落在本机 <code>data</code> 目录，' +
    '请不要把 <code>data</code> 目录放进公共网盘或共享目录，也不要在导出备份后把备份文件转发给别人。' +
    '结构化时发给模型的原文会先在本机去掉姓名、证件号、手机号与条码。</div>';
  $('llmBody').innerHTML = html;

  var sel = $('llmPreset');
  if (sel) sel.onchange = function () {
    var hit = null;
    (cfg.presets || []).forEach(function (x) { if (x.id === sel.value) hit = x; });
    if (hit) {
      if (hit.base_url) $('llmBase').value = hit.base_url;
      if (hit.model) $('llmModel').value = hit.model;
    }
  };
  $('btnLlmSave').onclick = function () { doLlmSave(false); };
  $('btnLlmTest').onclick = function () { doLlmSave(true); };
  $('btnLlmCancel').onclick = closeDrawers;
  openDrawer('drawer-llm');
}

async function doLlmSave(andTest) {
  var inputStyle = '';
  var body = {
    config: {
      preset: $('llmPreset') ? $('llmPreset').value : '',
      base_url: $('llmBase') ? $('llmBase').value.trim() : '',
      model: $('llmModel') ? $('llmModel').value.trim() : ''
    }
  };
  var k = $('llmKey') ? $('llmKey').value.trim() : '';
  if (k) body.config.api_key = k;
  if ($('llmClearKey') && $('llmClearKey').checked) body.config.clear_key = true;

  var btn = $('btnLlmSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    var r = await fetch('/api/llm/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.reason) || '保存失败');
    LLM.config = j.config;
    setLlmDrawerMsg('已保存到本机 data\\llm.json。');
    if ($('llmKey')) $('llmKey').value = '';

    if (andTest) {
      setLlmDrawerMsg('已保存，正在测试连通…');
      var r2 = await fetch('/api/llm/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      var j2 = await r2.json();
      if (j2 && j2.ok) {
        setLlmDrawerMsg('连通正常（模型 ' + (j2.model || '') + '）。');
      } else {
        setLlmDrawerMsg('配置已保存，但连通测试失败：' + ((j2 && j2.reason) || '未知原因'), true);
      }
    }
    await refreshLocalStats();
    renderCurrent();
  } catch (e) {
    setLlmDrawerMsg((e && e.message) || '保存失败', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = '保存'; }
}

async function doLlmProbe() {
  var msg = $('llmMsg');
  if (msg) msg.innerHTML = '<div class="note">正在测试连通…</div>';
  try {
    var r = await fetch('/api/llm/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    var j = await r.json();
    if (msg) {
      msg.innerHTML = (j && j.ok)
        ? '<div class="ok-bar">连通正常（模型 ' + esc(j.model || '') + '）。</div>'
        : '<div class="err-bar">连通失败：' + esc((j && j.reason) || '未知原因') + '</div>';
    }
  } catch (e) {
    if (msg) msg.innerHTML = '<div class="err-bar">连通失败：' + esc((e && e.message) || '未知错误') + '</div>';
  }
}

/* ---------------- 5.4 对一条记录做结构化 ---------------- */

var STRUCT = { recordId: null, rec: null, result: null, conflicts: [] };

function findHealthRecord(id) {
  var rows = bucket('documents').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) return rows[i];
  }
  return null;
}

function setStructMsg(text, isErr) {
  var el = $('structMsg');
  if (!el) return;
  el.innerHTML = text ? '<div class="' + (isErr ? 'err-bar' : 'note') + '">' + esc(text) + '</div>' : '';
}

async function openStructDrawer(recId) {
  var rec = findHealthRecord(recId);
  if (!rec) { alert('找不到这条记录，请刷新页面后重试。'); closeDrawers(); return; }
  var text = String(rec.parsed_content || '');
  if (!text.trim()) {
    alert('这条记录没有解析原文，无法结构化。\n\n请先在「上传资料」里选原始文件并解析，' +
      '或在对话里生成归档包后导入。');
    // 不能就这么返回：抽屉里还留着上一份记录的预览和「确认写入」按钮，
    // 用户按提示关掉弹窗后，看见的仍是能点的写入入口。
    closeDrawers();
    return;
  }
  STRUCT = { recordId: recId, rec: rec, result: null, conflicts: [], packHits: null, packChars: 0 };
  var cfg = (await loadLlmConfig()) || {};
  var areaStyle = 'width:100%;padding:8px 9px;border:1px solid #cfd8e3;border-radius:6px;' +
    'font-size:12.5px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace';
  var h = '';
  h += '<div class="note" style="margin-top:0">把这条记录的解析原文交给模型，拆成结构化字段。' +
    '原文 ' + text.length + ' 字' +
    (rec.xparse_task_id ? '，解析任务 ' + esc(String(rec.xparse_task_id).slice(0, 12)) : '') + '。' +
    '<b>模型只依据原文提取，原文没有的一律留空，不推测、不编造。</b>结果由你确认后才写入。</div>';

  /* --- 方式一：直连模型接口（需要配置密钥） --- */
  h += '<div style="border-top:1px solid #eef1f5;margin-top:12px;padding-top:10px">' +
    '<div style="font-size:13px;font-weight:600;color:#22384f">方式一 · 直连模型接口</div>';
  if (!cfg.configured) {
    h += '<div class="note">还没有配置模型服务。这种方式需要填服务商地址与密钥' +
      '（阿里云百炼 / DeepSeek / 本机 Ollama 都行）。' +
      '<b>不想配置密钥，直接用下面的方式二。</b></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn" id="btnStructCfg">去配置模型</button></div>';
  } else {
    h += '<div class="kv" style="grid-template-columns:56px minmax(0,1fr)">' +
      '<dt>模型</dt><dd>' + esc(cfg.model) + '</dd>' +
      '<dt>服务</dt><dd style="word-break:break-all">' + esc(cfg.base_url) + '</dd>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button class="btn primary" id="btnStructRun">开始结构化</button>' +
      '<button class="btn" id="btnStructCfg">模型配置</button>' +
      '</div>';
  }
  h += '</div>';

  /* --- 方式二：手动中转（不依赖任何配置，也不调用任何接口） --- */
  h += '<div style="border-top:1px solid #eef1f5;margin-top:14px;padding-top:10px">' +
    '<div style="font-size:13px;font-weight:600;color:#22384f">方式二 · 手动中转（不需要密钥）</div>' +
    '<div class="note">网页版大模型、手机上的 AI 助手、或任意对话窗口都能用。三步：复制 → 贴给模型 → ' +
    '把返回的 JSON 贴回来。复制出去的内容<b>已在本机去掉姓名、证件号、手机号与条码</b>，医学内容原样保留。</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
    '<button class="btn primary" id="btnStructPack">① 复制提示词 + 原文</button>' +
    '<button class="btn" id="btnStructToggle">查看要复制的内容</button>' +
    '</div>' +
    '<div id="structPackBox" style="display:none;margin-top:8px">' +
    '<textarea id="structPackText" readonly style="' + areaStyle + ';height:120px"></textarea>' +
    '<div class="muted" style="font-size:11.5px;margin-top:4px">' +
    '若浏览器不允许自动复制：点进上面的框，按 Ctrl+A 再按 Ctrl+C。</div>' +
    '</div>' +
    '<div style="margin-top:12px">' +
    llmFieldLabel('② 把模型返回的 JSON 粘到这里') +
    '<textarea id="structPaste" style="' + areaStyle + ';height:104px" ' +
    'placeholder=\'粘贴模型返回的 JSON，例如 {"document_type":"检验报告","primary_date":"2025-12-13"}\'></textarea>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
    '<button class="btn primary" id="btnStructAdopt">③ 解析并预览</button>' +
    '<button class="btn" id="btnStructClear">清空</button>' +
    '</div></div></div>';

  h += '<div id="structMsg"></div><div id="structOut"></div>';
  $('structBody').innerHTML = h;
  var c1 = $('btnStructCfg');
  if (c1) c1.onclick = function () { closeDrawers(); openLlmDrawer(); };
  var c2 = $('btnStructRun');
  if (c2) c2.onclick = doStructRun;
  var p1 = $('btnStructPack');
  if (p1) p1.onclick = doStructPack;
  var p2 = $('btnStructToggle');
  if (p2) p2.onclick = toggleStructPackBox;
  var p3 = $('btnStructAdopt');
  if (p3) p3.onclick = doStructAdopt;
  var p4 = $('btnStructClear');
  if (p4) p4.onclick = function () {
    var ta = $('structPaste'); if (ta) ta.value = '';
    var o = $('structOut'); if (o) o.innerHTML = '';
    STRUCT.result = null;
    setStructMsg('');
  };
  openDrawer('drawer-struct');
}

async function doStructRun() {
  var btn = $('btnStructRun');
  if (btn) { btn.disabled = true; btn.textContent = '结构化中…'; }
  setStructMsg('正在调用模型。原文已在本机做身份信息脱敏（姓名、证件号、手机号、条码），' +
    '医学内容原样保留。这一步通常需要 10～60 秒。');
  try {
    var r = await fetch('/api/llm/structure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: STRUCT.rec.parsed_content || '',
        doc_hint: STRUCT.rec.document_type || null
      })
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.reason) || '结构化失败');
    STRUCT.result = j;
    setStructMsg('');
    renderStructResult();
  } catch (e) {
    setStructMsg('结构化未完成：' + ((e && e.message) || '未知错误') + '。没有修改任何数据。', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = '开始结构化'; }
}

/* --- 手动中转：不调用任何接口、不需要密钥 ---

   ① pack：本机把「任务指令 + 脱敏后的原文」拼成一段文本，用户自己贴给任意大模型；
   ② adopt：把模型返回的 JSON 贴回来，本机解析成字段。
   两个接口都在 127.0.0.1 上，页面本身不向任何外部服务发请求。 */

async function copyPlainText(s) {
  if (!s) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    var box = $('structPackText');
    var wrap = $('structPackBox');
    if (box) {
      if (wrap) wrap.style.display = '';
      box.focus();
      box.select();
      var ok = !!(document.execCommand && document.execCommand('copy'));
      if (ok && wrap) wrap.style.display = 'none';
      return ok;
    }
  } catch (e) { /* 交给调用方提示手动复制 */ }
  return false;
}

function toggleStructPackBox() {
  var b = $('structPackBox');
  if (!b) return;
  var show = b.style.display === 'none';
  b.style.display = show ? '' : 'none';
  var t = $('btnStructToggle');
  if (t) t.textContent = show ? '收起内容' : '查看要复制的内容';
}

async function doStructPack() {
  var btn = $('btnStructPack');
  if (btn) { btn.disabled = true; btn.textContent = '正在准备…'; }
  setStructMsg('正在本机做身份信息脱敏并组装提示词…');
  try {
    var r = await fetch('/api/llm/pack', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: STRUCT.rec.parsed_content || '',
        doc_hint: STRUCT.rec.document_type || null
      })
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.reason) || '组装失败');
    STRUCT.packHits = j.redact_hits || {};
    STRUCT.packChars = j.chars || 0;
    var box = $('structPackText');
    if (box) box.value = j.prompt || '';
    var copied = await copyPlainText(j.prompt || '');
    var hits = Object.keys(STRUCT.packHits).map(function (k) {
      return k + ' ' + STRUCT.packHits[k] + ' 处';
    }).join('，');
    setStructMsg((copied
      ? '已复制到剪贴板'
      : '浏览器不允许自动复制，请点「查看要复制的内容」后手动全选复制') +
      '。脱敏后 ' + STRUCT.packChars + ' 字，' +
      (hits ? '已隐去 ' + hits : '原文中没有发现可识别的身份字段') +
      (j.truncated ? '；原文过长已截断' : '') +
      '。把它贴给任意大模型，再把返回的 JSON 粘到第 ② 步。');
  } catch (e) {
    setStructMsg('准备失败：' + ((e && e.message) || '未知错误') +
      '。没有调用任何模型，也没有改动数据。', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = '① 复制提示词 + 原文'; }
}

async function doStructAdopt() {
  var ta = $('structPaste');
  var raw = ta ? ta.value.trim() : '';
  if (!raw) { setStructMsg('请先把模型返回的 JSON 粘到第 ② 步的框里。', true); return; }
  var btn = $('btnStructAdopt');
  if (btn) { btn.disabled = true; btn.textContent = '解析中…'; }
  setStructMsg('正在解析粘贴的内容…');
  try {
    var r = await fetch('/api/llm/adopt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: raw })
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.reason) || '解析失败');
    // 脱敏发生在「复制」那一刻，这里把命中计数补回来，预览里才能如实说明
    j.redact_hits = STRUCT.packHits || {};
    STRUCT.result = j;
    setStructMsg('');
    renderStructResult();
  } catch (e) {
    setStructMsg('解析失败：' + ((e && e.message) || '未知错误') + '。数据没有被改动。', true);
  }
  if (btn) { btn.disabled = false; btn.textContent = '③ 解析并预览'; }
}

function renderStructResult() {
  var j = STRUCT.result;
  if (!j) return;
  var out = $('structOut');
  if (!out) return;
  var d = j.data || {};
  var hits = j.redact_hits || {};
  var hitText = Object.keys(hits).map(function (k) { return k + ' ' + hits[k] + ' 处'; }).join('，');
  var nz1 = function (v) { return (v === null || v === undefined || String(v).trim() === '') ? '未提供' : String(v); };

  var head;
  if (j.manual) {
    head = '<div class="ok-bar">已解析粘贴的模型输出（' + (j.chars || 0) + ' 字）。' +
      (hitText ? '复制出去之前已在本机脱敏：' + esc(hitText) + '。' : '') +
      '字段只是建议，确认后才会写入。</div>';
  } else {
    head = '<div class="ok-bar">结构化完成（模型 ' + esc(j.model || '') +
      (j.elapsed !== undefined ? '，' + j.elapsed + ' 秒' : '') + '，原文 ' + (j.chars || 0) + ' 字）' +
      (j.truncated ? '；原文过长已截断，结果可能不完整' : '') + '。' +
      (hitText ? '出网前已脱敏：' + esc(hitText) + '。' : '原文中没有发现可识别的身份字段。') +
      '</div>';
  }
  var h = head;

  /* 与人工更正的冲突。结构化结果整片覆盖档案，会把你手工改对的值又改回模型猜的
     —— 类型被覆盖过一次就是这么发生的。所以这里凡「人改过 + 模型又给了不同值」的
     字段一律单独列出来，默认保留人工值，要换模型的得当场点一下。 */
  var rec0 = findHealthRecord(STRUCT.recordId);
  STRUCT.conflicts = rec0 ? L.structConflicts(d, rec0) : [];
  if (STRUCT.conflicts.length) {
    h += '<div id="structConflicts" class="note" style="margin-top:10px">' +
      '<div style="margin-bottom:6px"><b>有 ' + STRUCT.conflicts.length +
      ' 处你人工改过的值与这次的结构化结果不一致</b>。默认保留你改的；' +
      '确实要采用模型值的，逐条改成「用模型的值」。</div>' +
      STRUCT.conflicts.map(function (c) {
        return '<div class="cf-row"><span class="cf-label">' + esc(c.label) + '</span>' +
          '<span class="cf-val">人工 ' + esc(String(c.human)) + '</span>' +
          '<span class="cf-val muted">模型 ' + esc(String(c.model)) + '</span>' +
          '<select data-conflict="' + attr(c.target) + '">' +
          '<option value="human" selected>保留我改的</option>' +
          '<option value="model">用模型的值</option></select></div>';
      }).join('') + '</div>';
  }

  h += '<div class="kv" style="grid-template-columns:88px minmax(0,1fr);margin-top:12px">' +
    '<dt>文档类型</dt><dd>' + esc(nz1(d.document_type)) + '</dd>' +
    '<dt>主日期</dt><dd>' + esc(nz1(d.primary_date)) + '</dd>' +
    '<dt>标题</dt><dd>' + esc(nz1(d.title)) + '</dd>' +
    '<dt>金额</dt><dd>' + (d.amount === null || d.amount === undefined ? '未提供' : esc(String(d.amount)) + ' 元') + '</dd>' +
    '<dt>机构/科室</dt><dd>' + esc([d.hospital, d.department].filter(Boolean).join(' · ') || '未提供') + '</dd>' +
    '</div>';
  if (d.primary_date_reason) h += '<div class="note">日期依据：' + esc(d.primary_date_reason) + '</div>';
  if (d.key_information) h += '<div class="note">要点：' + esc(d.key_information) + '</div>';

  var labs = d.lab_results || [];
  if (labs.length) {
    h += '<div style="font-size:12px;color:#5b6b7c;margin:12px 0 4px">检验/检查项目 ' + labs.length + ' 项</div>' +
      '<div style="max-height:220px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr style="background:#f6f8fb"><th style="text-align:left;padding:4px">项目</th>' +
      '<th style="text-align:left;padding:4px">结果</th><th style="text-align:left;padding:4px">单位</th>' +
      '<th style="text-align:left;padding:4px">参考范围</th><th style="text-align:left;padding:4px">提示</th></tr>' +
      labs.map(function (x) {
        return '<tr><td style="padding:4px">' + esc(x.name || '') + '</td>' +
          '<td style="padding:4px">' + esc(nz1(x.result) === '未提供' ? '' : String(x.result)) + '</td>' +
          '<td style="padding:4px">' + esc(x.unit || '') + '</td>' +
          '<td style="padding:4px">' + esc(x.reference || '') + '</td>' +
          '<td style="padding:4px">' + esc(x.flag || '') + '</td></tr>';
      }).join('') + '</table></div>';
  }

  var ch = d.charge_items || [];
  if (ch.length) {
    var ns = function (v) { return (v === null || v === undefined) ? '' : String(v); };
    h += '<div style="font-size:12px;color:#5b6b7c;margin:12px 0 4px">收费明细 ' + ch.length + ' 项</div>' +
      '<div style="max-height:200px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr style="background:#f6f8fb"><th style="text-align:left;padding:4px">项目</th>' +
      '<th style="text-align:left;padding:4px">单价</th><th style="text-align:left;padding:4px">数量</th>' +
      '<th style="text-align:left;padding:4px">金额</th><th style="text-align:left;padding:4px">医保类别</th></tr>' +
      ch.map(function (x) {
        return '<tr><td style="padding:4px">' + esc(x.name || '') + '</td>' +
          '<td style="padding:4px">' + esc(ns(x.unit_price)) + '</td>' +
          '<td style="padding:4px">' + esc(ns(x.qty)) + '</td>' +
          '<td style="padding:4px">' + esc(ns(x.amount)) + '</td>' +
          '<td style="padding:4px">' + esc(x.insurance_class || '') + '</td></tr>';
      }).join('') + '</table></div>';
  }

  if ((d.diagnosis || []).length) {
    h += '<div style="font-size:12px;color:#5b6b7c;margin:12px 0 4px">原文诊断（原样摘录，非系统判断）</div>' +
      '<div class="note">' + d.diagnosis.map(function (x) { return esc(String(x)); }).join('<br>') + '</div>';
  }
  if (d.extraction_notes) {
    h += '<div class="note" style="margin-top:8px">模型提示：' + esc(d.extraction_notes) + '</div>';
  }

  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
    '<button class="btn primary" id="btnStructApply">确认写入这条档案</button>' +
    '<button class="btn" id="btnStructDiscard">放弃</button>' +
    '</div>' +
    '<div class="note">写入只覆盖这条记录的类型、日期、标题、要点、金额与结构化字段；' +
    '解析原文与原始附件保持不动。写入后解析状态变为「已归档」。</div>';
  out.innerHTML = h;
  var a = $('btnStructApply'); if (a) a.onclick = doStructApply;
  var dd = $('btnStructDiscard'); if (dd) dd.onclick = closeDrawers;
}

async function doStructApply() {
  var j = STRUCT.result;
  if (!j || !j.data) return;
  var d = j.data;
  var rec = findHealthRecord(STRUCT.recordId);
  var btn = $('btnStructApply');
  if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }

  /* 冲突处理：人工改过而模型又给了不同值的字段，默认保留人工值 ——
     只有在页面上明确选了「用模型的值」的才覆盖，并且那种选择同样要留痕。 */
  var chosen = {};
  qsa('#structConflicts select[data-conflict]').forEach(function (s) {
    chosen[s.getAttribute('data-conflict')] = s.value;
  });
  var all = STRUCT.conflicts || [];
  var keepHuman = all.filter(function (c) { return chosen[c.target] !== 'model'; });
  var takeModel = all.filter(function (c) { return chosen[c.target] === 'model'; });
  var eff = L.keepHumanValues(d, keepHuman);

  var prevTsd = (rec && rec.type_specific_data && typeof rec.type_specific_data === 'object')
    ? rec.type_specific_data : {};
  var modelTsd = eff.type_specific_data || {};
  /* 只在模型真的给了值时才写这一项。原来是无条件整块重建 type_specific_data，
     模型没提到的 exams / general_exam / 结论会被连带抹掉（人刚改过的检查所见也没了）。 */
  var nextTsd = Object.assign({}, prevTsd);
  L.STRUCT_WRITABLE_TABLES.forEach(function (k) {
    if (Array.isArray(modelTsd[k]) && modelTsd[k].length) nextTsd[k] = modelTsd[k];
  });
  if (Array.isArray(modelTsd.diagnosis) && modelTsd.diagnosis.length) nextTsd.diagnosis = modelTsd.diagnosis;
  L.STRUCT_WRITABLE_TS_SCALARS.forEach(function (k) {
    if (modelTsd[k] !== undefined && modelTsd[k] !== null) nextTsd[k] = modelTsd[k];
  });
  nextTsd.structured = true;
  nextTsd.structured_by = j.model || null;
  nextTsd.structured_at = new Date().toISOString();
  nextTsd.structure_notes = d.extraction_notes || null;
  if (d.primary_date_reason) nextTsd.date_reason = d.primary_date_reason;

  /* 日期状态不再无条件打回「待确认」：结构化完成后按最终日期判定 ——
     有合法日期就是「已确认」（解析读到了日期不该让用户再点一次确认），
     没日期才「待确认」。原来这里无条件 PENDING，用户每份报告都得重复确认。 */
  var patch = { parse_status: '已归档', type_specific_data: nextTsd };
  ['document_type', 'primary_date', 'title', 'key_information', 'amount',
    'hospital', 'department', 'doctor'].forEach(function (k) {
      if (!(k in eff) || eff[k] === undefined || eff[k] === null || eff[k] === '') return;
      patch[k] = eff[k];
    });
  /* 最终日期 = 模型给的（若给了），否则沿用档案原有日期。
     有合法日期 → 已确认；没有 → 待确认（等用户补）。 */
  var finalDate = (patch.primary_date !== undefined && patch.primary_date !== null)
    ? patch.primary_date : ((rec && rec.primary_date) || null);
  patch.date_status = (finalDate && L.isValidDate(String(finalDate)))
    ? L.DATE_STATUS.CONFIRMED : L.DATE_STATUS.PENDING;
  if (takeModel.length && rec) {
    patch.manual_edits = L.editsOf(rec).concat(takeModel.map(function (c) {
      return { target: c.target, label: c.label, from: c.human, to: c.model,
               at: new Date().toISOString(), note: '智能结构化确认时选择采用模型值' };
    }));
  }
  try {
    var res = await cloud.database.from('documents').update(patch).eq('id', STRUCT.recordId).select();
    if (res.error) throw res.error;
    if (!res.data || !res.data.length) throw new Error('没有匹配到这条记录，可能已被删除');
    var rid = STRUCT.recordId;
    await loadAll();
    await refreshLocalStats();
    renderCurrent();
    closeDrawers();
    alert('已写入。这条档案的解析状态变为「已归档」，检验项与收费明细可以在详情页查看。');
    openDoc(rid, '档案列表');
  } catch (e) {
    setStructMsg('写入失败：' + ((e && e.message) || '未知错误') + '。数据没有被改动。', true);
    if (btn) { btn.disabled = false; btn.textContent = '确认写入这条档案'; }
  }
}

/* ---------------- 6. 导航 ---------------- */

var VIEWS = { overview: '数据概览', timeline: '健康档案', upload: '上传资料', archive: '原始资料档案', drugs: '药品管理', persons: '成员管理' };

function go(view, opts) {
  opts = opts || {};
  if (view !== S.view) showGlobalMsg(null);        // 换屏幕就别留着上一条反馈
  // 实际滚动的是窗口（.main 不是滚动容器），原来存 main.scrollTop 永远是 0，恢复形同空转
  if (!opts.keepScroll) S.scroll[S.view] = window.scrollY || 0;
  S.view = view;
  qsa('#nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.go === view); });
  qsa('.screen').forEach(function (s) { s.classList.toggle('on', s.id === 's-' + view); });
  renderCurrent();
  var locked = qsa('.detail-layer.on').length > 0;   // 详情层还开着时底层滚不动，别白做
  if (!locked) window.scrollTo(0, (opts.restore && S.scroll[view]) ? S.scroll[view] : 0);
}

function renderCurrent() {
  if (!S.booted && !S.tables.documents.rows.length && S.tables.documents.state !== 'ok') {
    // 数据尚未就绪时也给出准确状态
  }
  if (S.view === 'overview') renderOverview();
  else if (S.view === 'timeline') renderTimeline();
  else if (S.view === 'upload') renderUpload();
  else if (S.view === 'archive') renderArchive();
  else   if (S.view === 'drugs') renderDrugs();
  else if (S.view === 'persons') renderPersons();
}

function renderSyncStrip() {
  var host = qsa('.sync-host');
  if (!host.length) return;
  var names = { documents: '健康档案', drugs: '药品', indicators: '指标目录', manual_records: '日常指标' };
  var html = Object.keys(S.tables).map(function (k) {
    var t = S.tables[k];
    var cls = t.state === 'ok' ? 'ok' : (t.state === 'error' ? 'fail' : (t.state === 'loading' ? 'load' : ''));
    var label = t.state === 'ok' ? ('已载入 ' + t.count + ' 条')
      : t.state === 'error' ? '读取失败' : t.state === 'loading' ? '读取中' : '未开始';
    return '<span class="it" title="' + attr(t.error || '') + '"><i class="dot ' + cls + '"></i>' +
      names[k] + '：' + label + '</span>';
  }).join('');
  host.forEach(function (h) { h.innerHTML = html; });
}

/* ---------------- 7. 详情层（固定定位独立滚动，不触碰底层页面滚动） ---------------- */

/* 滚动锁按「当前还有没有可见的详情层」推导，不靠栈长度对齐。
   原来只有 closeLayer 里 `if (!stack.length) 解锁`，而同一层重复打开会在栈里
   叠两条：关掉上层时 .on 已经摘了、栈却还剩一条，body 的 overflow 就永久停在
   hidden —— 窗口滚动条消失，用户没法下滑。 */
function syncBodyLock() {
  document.body.style.overflow = qsa('.detail-layer.on').length ? 'hidden' : '';
}

function openLayer(id) {
  var el = $(id);
  if (!el) return;
  el.scrollTop = 0;                 // 打开即从该容器顶部开始：只改容器自身滚动位置，绝不滚动底层页面
  el.classList.add('on');
  if (!S.layerStack.length) S.mainScroll = window.scrollY || 0;   // 第一层记下来源页位置
  var dup = S.layerStack.indexOf(id);
  if (dup >= 0) S.layerStack.splice(dup, 1);   // 同一层重复打开只占一个栈位
  S.layerStack.push(id);
  syncBodyLock();
}
function closeLayer() {
  var id = S.layerStack.pop();
  if (id && $(id)) $(id).classList.remove('on');
  // 退回上一层后，把「置顶」交还给现在最上面那层，否则它的层级会一直压在新开的层上
  liftLayerOnTop(S.layerStack[S.layerStack.length - 1] || null);
  syncBodyLock();
  // 锁必须先按 DOM 现状复原，再滚回来源位置：body 还 hidden 时 scrollTo 会被夹住
  if (!S.layerStack.length && !qsa('.detail-layer.on').length) {
    window.scrollTo(0, S.mainScroll || 0);
  }
}
function closeAllLayers() {
  S.layerStack = [];
  qsa('.detail-layer').forEach(function (el) { el.classList.remove('on'); });
  liftLayerOnTop(null);
  syncBodyLock();
}

/* ---------------- 8. 图表 ---------------- */

function sparkline(points, w, h) {
  w = w || 92; h = h || 26;
  var vals = points.filter(function (p) { return p.value !== null; });
  if (vals.length < 2) return '<span class="muted" style="font-size:11px">不足 2 点</span>';
  var vmin = Math.min.apply(null, vals.map(function (p) { return p.value; }));
  var vmax = Math.max.apply(null, vals.map(function (p) { return p.value; }));
  var span = (vmax - vmin) || 1;
  var step = w / (vals.length - 1);
  var d = vals.map(function (p, i) {
    var x = i * step, y = h - 3 - ((p.value - vmin) / span) * (h - 6);
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="小趋势">' +
    '<path d="' + d + '" fill="none" stroke="#2d77c9" stroke-width="1.5"/></svg>';
}

/**
 * 折线图。横轴标 YYYY.MM（带年份），点可悬停/点击查看完整明细。
 * series: [{name, color, points:[{date,value,unit,extra}]}]
 */
function lineChart(cfg) {
  var series = cfg.series || [];
  var pts = [];
  series.forEach(function (s) { s.points.forEach(function (p) { pts.push(p); }); });
  if (!pts.length) return msg(cfg.emptyText || '暂无可绘制数据');
  var W = 660, H = 240, PL = 52, PR = 18, PT = 16, PB = 46;
  var iw = W - PL - PR, ih = H - PT - PB;
  var vmin = Math.min.apply(null, pts.map(function (p) { return p.value; }));
  var vmax = Math.max.apply(null, pts.map(function (p) { return p.value; }));
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  var pad = (vmax - vmin) * 0.12;
  vmin -= pad; vmax += pad;
  if (cfg.forceMin !== undefined && cfg.forceMin < vmin) vmin = cfg.forceMin;

  // 横轴：按时间升序的并集日期
  var dates = [];
  pts.forEach(function (p) { if (dates.indexOf(p.date) < 0) dates.push(p.date); });
  dates.sort();
  var n = dates.length;
  function X(i) { return n <= 1 ? PL + iw / 2 : PL + (i * iw / (n - 1)); }
  function Y(v) { return PT + ih - ((v - vmin) / (vmax - vmin)) * ih; }

  var grid = '', ticks = 5;
  if (cfg.ordinal) {
    // 定性指标：纵轴按「阴性/阳性/加号」画刻度，不按数值均分
    var yl = cfg.yLabels || [];
    var yvals = [];
    pts.forEach(function (p) { if (yvals.indexOf(p.value) < 0) yvals.push(p.value); });
    yvals.sort(function (a, b) { return a - b; });
    yvals.forEach(function (v) {
      var yy = Y(v), lab = v;
      yl.forEach(function (e) { if (e.v === v) lab = e.label; });
      grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f5"/>' +
        '<text x="' + (PL - 7) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a94a3">' +
        esc(String(lab)) + '</text>';
    });
  } else {
    for (var g = 0; g <= ticks; g++) {
      var yy = PT + ih - (g * ih / ticks);
      var val = vmin + (vmax - vmin) * g / ticks;
      grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f5"/>' +
        '<text x="' + (PL - 7) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a94a3">' +
        val.toFixed(cfg.decimals === 0 ? 0 : 2) + '</text>';
    }
  }
  var xlab = '';
  var labelStep = Math.max(1, Math.ceil(n / 7));
  dates.forEach(function (d, i) {
    if (i % labelStep !== 0 && i !== n - 1) return;
    xlab += '<text x="' + X(i).toFixed(1) + '" y="' + (H - PB + 18) + '" text-anchor="middle" font-size="10" fill="#55606f">' +
      L.fmtYearMonth(d).replace('.', '.') + '</text>';
  });
  xlab += '<text x="' + (PL + iw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="#8a94a3">' +
    '横轴为 YYYY.MM，点按时间升序等间距排列</text>';

  var paths = '', dots = '';
  series.forEach(function (s) {
    var seq = s.points.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (seq.length >= 2) {
      var d2 = seq.map(function (p, i) {
        return (i ? 'L' : 'M') + X(dates.indexOf(p.date)).toFixed(1) + ' ' + Y(p.value).toFixed(1);
      }).join(' ');
      paths += '<path d="' + d2 + '" fill="none" stroke="' + s.color + '" stroke-width="2"' +
        (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
    }
    seq.forEach(function (p) {
      var xi = X(dates.indexOf(p.date)), yi = Y(p.value);
      dots += '<circle class="point-hit" cx="' + xi.toFixed(1) + '" cy="' + yi.toFixed(1) + '" r="4" fill="#fff" stroke="' + s.color + '" stroke-width="2">' +
        '<title>' + esc(s.name + ' · ' + L.fmtCN(p.date) + ' · ' + p.value + ' ' + (p.unit || '') +
          (p.extra ? ' · ' + p.extra : '')) + '</title></circle>';
    });
  });

  var legend = series.filter(function (s) { return s.points.length; }).map(function (s) {
    return '<span class="lg"><i class="sw' + (s.dash ? ' dash' : '') + '" style="background:' + s.color + '"></i>' + esc(s.name) + '</span>';
  }).join('');

  return '<div class="chart-legend">' + legend + '</div>' +
    '<div class="tbl-scroll"><svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="趋势图" style="min-width:520px">' +
    grid + paths + dots + xlab + '</svg></div>';
}

/* ---------------- 9. 数据概览 ---------------- */

function kpi(label, value, unit, detail) {
  return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v num">' + value +
    (unit ? '<span class="u">' + esc(unit) + '</span>' : '') + '</div>' +
    (detail ? '<div class="d">' + detail + '</div>' : '') + '</div>';
}

function renderOverview() {
  var host = $('s-overview');
  // 成员切换：选中某人后，本页 KPI、关注指标表、趋势、资料活动、类型分布、费用
  // 全部只算他的资料；「全部」保持原有行为不变。
  var recs = bucket('documents').rows.filter(function (r) {
    return L.personMatches(r, S.personView);
  });
  var drugs = bucket('drugs').rows.filter(function (d) {
    return L.personMatches(d, S.personView);
  });
  var cat = catalogList();
  var tl = L.groupTimeline(recs);
  var activity = L.buildActivity(recs);
  var dist = L.typeDistribution(recs);

  var errRows = Object.keys(S.tables).filter(function (k) { return S.tables[k].state === 'error'; });

  // A. 概览数字
  var datedCount = tl.dateGroups.length;

  var html = '';
  html += '<div class="page-head"><h2>健康数据概览</h2>' +
    '<p>关注指标趋势、资料活动与费用统计。本工作台只记录与展示你自己的医疗资料、用药与指标，不做诊断、不做治疗建议、不预测风险。</p></div>';
  html += personSwitcherHtml();
  if (S.followNotice) html += '<div class="err-bar" style="margin:0 0 12px">' + esc(S.followNotice) + '</div>';
  html += '<div class="sync-strip sync-host"></div>';

  if (errRows.length) {
    html += '<div class="err-bar"><b>部分数据未同步。</b>' +
      errRows.map(function (k) { return esc(k) + '：' + esc(S.tables[k].error || '读取失败'); }).join('；') +
      '　其余模块仍可正常使用；修复后可点「重新同步」。</div>';
  }

  html += '<div class="kpis">' +
    kpi('档案数量', '<span class="num">' + recs.length + '</span>', '份', '共 ' + L.DOC_TYPES.length + ' 类资料，含 ' + tl.pending.length + ' 份日期待确认') +
    kpi('覆盖的有效日期', '<span class="num">' + datedCount + '</span>', '个', '仅统计日期有效的资料') +
    kpi('关注指标', '<span class="num" id="kpiWatchedCount">—</span>', '项',
      '目录共 ' + cat.length + ' 项，可继续添加') +
    kpi('已记录医疗费用', '<span class="num" id="kpiFees">—</span>', '元',
      '<span id="kpiFeesDetail">按所选成员的档案金额汇总</span>') +
    '</div>';

  html += '<div class="cols-2">';

  /* ---- 左列 ---- */
  html += '<div class="grid">';

  /* B. 关注指标表
     这一格由 V2 接管（app\v2.js 的 renderFollowCard 会整块重写本卡的内容）：
     数据源是后端 /api/watched + /api/indicators，前端只负责画。
     旧版那张读目录行 followers 的表已随 V1 一起删掉。 */
  html += '<div class="card" id="cardFollow"><div class="card-h"><h3>关注指标 ' +
    '<span class="sub">最新结果与趋势概览</span></h3></div><div class="card-b">' +
    msg('正在载入关注指标…') + '</div></div>';

  // E. 跨年度资料活动
  html += '<div class="card"><div class="card-h"><h3>跨年度资料活动 <span class="sub">按年汇总，点击年份展开月份</span></h3></div><div class="card-b">';
  if (!activity.length) html += msg('暂无带有效日期的资料。无日期的资料不计入年度活动。');
  else {
    activity.forEach(function (a) {
      var open = !!S.actYears[a.year];
      html += '<div class="year-grp' + (open ? ' open' : '') + '" data-act-year="' + attr(a.year) + '">' +
        '<div class="year-h" data-act-toggle="' + attr(a.year) + '"><span class="l"><i class="caret"></i><b>' + esc(a.year) + ' 年</b>' +
        '<span class="muted" style="font-size:12px">共 ' + a.total + ' 份资料</span></span>' +
        '<span class="muted" style="font-size:11.5px">' + (open ? '收起' : '展开月份') + '</span></div>' +
        '<div class="months">' + a.months.map(function (m) {
          var w = a.maxMonth ? Math.max(6, Math.round(m.count / a.maxMonth * 120)) : 6;
          return '<div class="mrow"><span class="mn">' + m.month + ' 月</span>' +
            '<span class="mbar" style="width:' + w + 'px"></span><span class="mc">' + m.count + ' 份</span></div>';
        }).join('') + '</div></div>';
    });
  }
  html += '</div></div>';

  // F. 资料类型分布
  html += '<div class="card"><div class="card-h"><h3>资料类型分布 <span class="sub">七类资料数量</span></h3></div><div class="card-b">';
  if (!recs.length) html += msg('暂无资料。归档后这里会显示七类资料的分布。');
  else {
    var maxd = Math.max.apply(null, dist.map(function (d) { return d.count; })) || 1;
    html += '<div class="dist">' + dist.map(function (d) {
      return '<div class="row"><span class="nm" title="' + attr(d.type) + '">' + esc(d.type) + '</span>' +
        '<span class="track"><i class="fillb" style="width:' + Math.round(d.count / maxd * 100) + '%;display:block"></i></span>' +
        '<span class="ct num">' + d.count + '</span></div>';
    }).join('') + '</div>';
  }
  html += '</div></div>';

  html += '</div>';   // 左列结束

  /* ---- 右列：费用 ----
     两张费用卡同样由 V2 接管（renderFeesCards，数据源 /api/fees/summary）。
     旧版按 L.buildFees(recs) 现算的卡片已随 V1 一起删掉 —— 同一件事两个算法
     正是这一版要根除的毛病。这里只留挂载点。 */
  html += '<div class="grid">';
  html += '<div class="card" id="cardFees"><div class="card-h"><h3>已记录医疗费用</h3></div>' +
    '<div class="card-b">' + msg('正在载入费用…') + '</div></div>';

  html += '<div class="card" id="cardFeesYear"><div class="card-h"><h3>年度费用</h3>' +
    '<span class="sub">按档案日期汇总</span></div><div class="card-b">' +
    msg('正在载入年度费用…') + '</div></div>';

  // 药品轻摘要：分组必须走药品页同一个 drugStatusGroup，否则任何非标准 status
  // 会在药品页算进某一组、在这张卡上却谁都不算（同一个事实两处各写一遍的老毛病）。
  var cur = drugs.filter(function (d) { return L.drugStatusGroup(d) === 'current'; });
  var todayInUse = cur.filter(function (d) { return L.isInUseToday(d); });
  html += '<div class="card"><div class="card-h"><h3>用药概况 <span class="sub">按所选成员</span></h3>' +
    '<button class="btn sm" data-go-btn="drugs">药品管理</button></div><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:100px minmax(0,1fr)">' +
    '<dt>当前用药</dt><dd>' + cur.length + ' 种<div class="muted" style="font-size:11.5px">其中今日在用 ' + todayInUse.length + ' 种</div></dd>' +
    '<dt>备用 / 药箱</dt><dd>' + drugs.filter(function (d) { return L.drugStatusGroup(d) === 'reserve'; }).length + ' 种</dd>' +
    '<dt>历史用药</dt><dd>' + drugs.filter(function (d) { return L.drugStatusGroup(d) === 'history'; }).length + ' 种</dd>' +
    '</div></div></div>';

  html += '</div>';   // 右列结束
  html += '</div>';   // cols-2 结束

  host.innerHTML = html;
  bindOverview();
  // V2：关系型数据到位后，用后端算好的指标/费用替换掉这两张卡
  if (window.V2) V2.mountOverview();
}

/* 顶部成员切换器：全部 / 每个成员 / 未指定。
   只影响本页看谁的数据，不落库、不进 URL —— 换页回来还是上次选的人，够了。 */
function personSwitcherHtml() {
  if (!personSupported()) return '';
  var items = [{ v: 'all', label: '全部' }].concat(S.persons.map(function (p) {
    return { v: String(p.id), label: p.name };
  })).concat([{ v: '0', label: '未指定' }]);
  var cur = L.isAllView(S.personView) ? 'all' : String(S.personView);
  return '<div class="person-switch"><span class="ps-cap">按成员看</span>' +
    items.map(function (it) {
      return '<button class="ps' + (it.v === cur ? ' on' : '') + '" data-ps="' + attr(it.v) + '">' +
        esc(it.label) + '</button>';
    }).join('') +
    '<span class="ps-hint">当前：' + esc(personViewLabel()) +
    '（关注指标也是各人一套，切到人就按该成员的关注项展示）</span></div>';
}

async function setPersonView(v) {
  S.personView = personViewFromSelect(v);
  S.followNotice = '';
  // 成员视图是全局筛选态：概览、健康档案、原始资料档案、药品页共用同一个人。
  // 改完按当前页面刷新，让「一处选人全站跟随」成立。
  renderCurrent();
}

function bindOverview() {
  qsa('#s-overview [data-ps]').forEach(function (b) {
    b.onclick = function () { setPersonView(b.dataset.ps); };
  });
  qsa('[data-go-btn]').forEach(function (b) { b.onclick = function () { go(b.dataset.goBtn); }; });
  qsa('[data-act-toggle]').forEach(function (h) {
    h.onclick = function () { S.actYears[h.dataset.actToggle] = !S.actYears[h.dataset.actToggle]; renderOverview(); };
  });
  /* 关注指标表 / 两张费用卡 / 指标详情层都由 V2 接管，它们的按钮与行事件
     在 app\v2.js 里绑（那些 DOM 是 V2 渲染出来的，这里根本抓不到）。 */
}

/* ---------------- 10. 健康档案时间线 ---------------- */

function docCard(r) {
  var info = nz(r.key_information) ? String(r.key_information).split('\n').filter(function (s) { return s.trim(); }) : [];
  return '<div class="doc-card" data-doc="' + attr(r.id) + '">' +
    '<div class="t"><span class="tt">' + esc(nz(r.title) || '(无标题)') + '</span>' +
    '<span class="tag">' + esc(L.normalizeDocType(r.document_type)) + '</span>' +
    personBadge(r) +
    (r.parse_status ? '<span class="tag gray">' + esc(r.parse_status) + '</span>' : '') + '</div>' +
    '<div class="meta">' +
    '<span>' + esc(nz(r.hospital) || '医院未提供') + '</span>' +
    '<span>' + esc(nz(r.department) || '科室未提供') + '</span>' +
    '<span>主键 #' + esc(r.id) + '</span>' +
    (attachmentsOf(r).length ? '<span>' + attachmentsOf(r).length + ' 个附件</span>' : '<span class="muted">原始文件未留存</span>') +
    '</div>' +
    (info.length ? '<ul>' + info.slice(0, 3).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
    '</div>';
}

function renderTimeline() {
  var host = $('s-timeline');
  var all = bucket('documents').rows;
  var tl = L.groupTimeline(all);
  var filters = S.filters;

  var hospitals = {};
  all.forEach(function (r) { if (nz(r.hospital)) hospitals[r.hospital] = true; });
  var types = L.DOC_TYPES.slice();
  all.forEach(function (r) { var t = L.normalizeDocType(r.document_type); if (types.indexOf(t) < 0) types.push(t); });

  // 筛选真实作用于全部已加载记录；清空筛选后恢复完整数据
  // 成员这一维走全局 S.personView（与概览/档案/药品共用同一人，§11 待办 14）。
  var filtered = all.filter(function (r) {
    if (filters.type && L.normalizeDocType(r.document_type) !== filters.type) return false;
    if (filters.hospital && r.hospital !== filters.hospital) return false;
    if (!L.personMatches(r, S.personView)) return false;
    if (filters.q) {
      var hay = [r.title, r.hospital, r.department, r.doctor, r.source_file, r.key_information].join(' ');
      if (hay.toLowerCase().indexOf(filters.q.toLowerCase()) < 0) return false;
    }
    return true;
  });
  var ftl = L.groupTimeline(filtered);

  var latestDate = tl.dateGroups.length ? tl.dateGroups[0].date : null;

  var html = '';
  html += '<div class="page-head"><h2>健康档案</h2>' +
    '<p>按业务日期倒序，年 → 月 → 日分层；同一日期合并为一个日期组，组内是各自独立的医疗资料。</p></div>';
  html += '<div class="sync-strip sync-host"></div>';

  html += '<div class="stats-strip">' +
    '<div class="s"><div class="k">资料总数</div><div class="v num">' + all.length + '</div></div>' +
    '<div class="s"><div class="k">医院数量</div><div class="v num">' + Object.keys(hospitals).length + '</div></div>' +
    '<div class="s"><div class="k">最近一次有明确日期的资料</div><div class="v" style="font-size:14px">' +
    (latestDate ? esc(L.fmtCN(latestDate)) : '暂无') + '</div></div>' +
    '<div class="s"><div class="k">日期待确认</div><div class="v num">' + tl.pending.length + '</div></div>' +
    '</div>';

  html += '<div class="filters">' +
    '<input type="search" id="tlQ" placeholder="搜索标题 / 医院 / 科室 / 文件名 / 摘要" value="' + attr(filters.q) + '">' +
    '<select id="tlType"><option value="">全部类型</option>' + types.map(function (t) {
      return '<option value="' + attr(t) + '"' + (filters.type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('') + '</select>' +
    '<select id="tlHosp"><option value="">全部医院</option>' + Object.keys(hospitals).map(function (h) {
      return '<option value="' + attr(h) + '"' + (filters.hospital === h ? ' selected' : '') + '>' + esc(h) + '</option>';
    }).join('') + '</select>' +
    (personSupported()
      ? '<select id="tlPerson">' + personViewOptions() + '</select>'
      : '') +
    '<button class="btn sm" id="tlClear">清空筛选</button>' +
    '<span class="muted" style="font-size:12px">命中 ' + filtered.length + ' / ' + all.length + ' 份</span>' +
    '</div>';

  if (!all.length) {
    html += msg(S.tables.documents.state === 'error'
      ? '健康档案未能同步：' + (S.tables.documents.error || '读取失败')
      : '还没有任何档案。四张表为空时不展示任何虚构报告、药品、金额或趋势；请先在「上传资料」中归档。');
    host.innerHTML = html;
    bindTimeline();
    return;
  }
  if (!filtered.length) {
    html += msg('没有符合当前筛选条件的资料。清空筛选可恢复完整数据。');
    host.innerHTML = html;
    bindTimeline();
    return;
  }

  // 默认展开最近 10 个「日期组」，更早内容按月份折叠
  var recentShown = 0;
  ftl.years.forEach(function (yy) {
    html += '<div class="year-block"><div class="year-title">' + esc(yy.year) + ' 年<span class="ln"></span>' +
      '<span class="muted" style="font-size:12px;font-weight:400">' + yy.count + ' 份</span></div>';
    yy.monthList.forEach(function (mm) {
      var key = yy.year + '-' + mm.month;
      var dates = mm.dates.slice();
      var recent = [], older = [];
      dates.forEach(function (g) {
        if (recentShown < 10) { recent.push(g); recentShown++; }
        else older.push(g);
      });
      if (recent.length) {
        html += '<div class="month-title">' + Number(mm.month) + ' 月<span class="cnt">' + recent.length + ' 个日期组</span></div>';
        html += recent.map(renderDateGroup).join('');
      }
      if (older.length) {
        var open = !!S.expanded[key];
        if (open) {
          html += '<div class="month-title">' + Number(mm.month) + ' 月 · 更早内容<span class="cnt">' + older.length + ' 个日期组</span></div>';
          html += older.map(renderDateGroup).join('');
          html += '<div class="more-month" data-collapse="' + attr(key) + '">收起 ' + Number(mm.month) + ' 月的更早内容</div>';
        } else {
          html += '<div class="more-month" data-expand="' + attr(key) + '">展开 ' + Number(mm.month) + ' 月的更早内容（另 ' +
            older.length + ' 个日期组、' + older.reduce(function (s, g) { return s + g.records.length; }, 0) + ' 份资料）</div>';
        }
      }
    });
    html += '</div>';
  });

  if (ftl.pending.length) {
    html += '<div class="year-block"><div class="year-title">日期待确认<span class="ln"></span>' +
      '<span class="muted" style="font-size:12px;font-weight:400">' + ftl.pending.length + ' 份</span></div>' +
      '<div class="note">这些资料无有效业务日期，不使用今天、上传日期或猜测年份代替；它们可以查看，但不进入按日期计算的趋势、年度活动与年度费用。</div>' +
      '<div class="date-grp pending"><div class="date-head"><span class="dd muted">日期待确认</span></div>' +
      ftl.pending.map(docCard).join('') + '</div></div>';
  }

  host.innerHTML = html;
  bindTimeline();
}

function renderDateGroup(g) {
  return '<div class="date-grp" data-date="' + attr(g.date) + '">' +
    '<div class="date-head"><span class="dd">' + esc(L.fmtCN(g.date)) + '</span>' +
    '<span class="muted" style="font-size:11.5px">' + g.records.length + ' 份资料</span>' +
    '<span class="muted" style="font-size:11.5px">' + esc(L.fmtYearMonth(g.date)) + '</span></div>' +
    g.records.map(docCard).join('') +
    '</div>';
}

function bindTimeline() {
  var q = $('tlQ');
  if (q) {
    q.oninput = function () { S.filters.q = q.value; renderTimeline(); var el = $('tlQ'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } };
  }
  var t = $('tlType'); if (t) t.onchange = function () { S.filters.type = t.value; renderTimeline(); };
  var h = $('tlHosp'); if (h) h.onchange = function () { S.filters.hospital = h.value; renderTimeline(); };
  var ps = $('tlPerson'); if (ps) ps.onchange = function () { setPersonView(ps.value); };
  var c = $('tlClear');
  if (c) c.onclick = function () { S.filters = { q: '', type: '', hospital: '', person: '' }; renderTimeline(); };
  qsa('[data-expand]').forEach(function (b) {
    b.onclick = function () { S.expanded[b.dataset.expand] = true; renderTimeline(); };
  });
  qsa('[data-collapse]').forEach(function (b) {
    b.onclick = function () { S.expanded[b.dataset.collapse] = false; renderTimeline(); };
  });
  qsa('#s-timeline [data-doc]').forEach(function (card) {
    card.onclick = function () { openDoc(card.dataset.doc, '健康档案'); };
  });
}

/* ---------------- 11. 上传资料与真实归档 ---------------- */

function renderUpload() {
  var host = $('s-upload');
  var info = SERVER.info || {};
  var lo = S.local || {};
  var llm = info.llm || {};
  var h = '';

  h += '<div class="page-head"><h2>上传资料</h2>' +
    '<p>档案、附件、指标都写在本机磁盘的 <code>data</code> 目录里 —— 在浏览器里点「清除浏览数据」不会动到它。' +
    '只有解析这一步需要联网。任何写入都会先进入确认流程，不做假进度、不显示假成功。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

  h += '<div class="cols-2"><div class="grid">';

  /* ---------- 两条路径 ---------- */
  h += '<div class="card"><div class="card-h"><h3>两条录入路径</h3><span class="sub">都不会自动写入</span></div><div class="card-b">' +
    '<div class="up-steps">' +
    '<div class="up-step"><div class="no">A</div><div class="bd"><h4>本机解析：原始文件 → 原文</h4>' +
    '<p>选 PDF / JPG / PNG 等原始文件（同一份报告的多页请一次选中），由本机解析工具联网读出<b>原文</b>，' +
    '确认后写入档案。</p>' +
    '<p style="margin-top:6px;color:#8a6d3b"><b>这一步只出原文，不出字段。</b>' +
    '写入后状态是「已解析待结构化」：正文在，但检验项、金额、日期这些结构化字段还是空的。' +
    '要变成可用字段，用路径 B。</p></div></div>' +
    '<div class="up-step"><div class="no">B</div><div class="bd"><h4>结构化：原文 → 字段</h4>' +
    '<p>在对话里提交原件，由对话完成解析与结构化，产出归档包（.json），在这里导入 —— 字段齐全，状态为「已归档」。</p>' +
    '<p style="margin-top:6px">或者对一条已解析的记录，在<b>档案详情页点「智能结构化」</b>，' +
    '由下面配置的模型把原文拆成字段，你确认后再落库。</p></div></div>' +
    '</div>';
  h += '<div id="parseBox" class="note" style="margin-top:14px">正在检查本机解析接口…</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
    '<label class="btn" style="cursor:pointer">选择文件<input type="file" id="parseFiles" multiple style="display:none"></label>' +
    '<button class="btn" id="btnParseUpload" disabled>上传并解析</button>' +
    '<label class="sub" style="display:inline-flex;align-items:center;gap:4px">通道' +
    '<select id="parseApi" style="padding:3px 6px"><option value="auto">自动</option>' +
    '<option value="free">免费</option><option value="paid">付费</option></select></label>' +
    '<button class="btn primary" id="btnOpenImport">选择归档包并写入档案</button>' +
    '<a class="btn" href="tests.html" target="_blank" rel="noopener">运行业务逻辑自检</a>' +
    '</div>' +
    '<div id="parseMsg"></div>' +
    '<div class="note">通道说明：免费与付费是解析服务的两条计费通道，对清晰的印刷体报告实测输出一致；' +
    '模糊、倾斜、反光、盖章遮挡的照片，两条通道都会读不全 —— 那种情况请重拍，而不是换通道。' +
    '解析工具未就绪时按钮保持禁用并说明原因。</div>';
  h += '</div></div>';

  /* ---------- 边界说明 ---------- */
  h += '<div class="card"><div class="card-h"><h3>边界说明</h3></div><div class="card-b">' +
    '<div class="boundary">' +
    '<b>本工作台不做医疗决策。</b>原报告的诊断意见、报告结论、适应症可以原文展示，但会标明来自原资料，不是系统生成的判断。系统不会根据数值与参考范围的大小关系自动生成异常、正常、偏高、偏低标签，不复现原报告未印出的箭头。<br><br>' +
    '<b>不确定就留空。</b>无法确认的字段保存为未知，展示为「未提供」或「待确认」；不会编造日期、医生、单位、结果或剂量，明确的 0 会原样保留。<br><br>' +
    '<b>收费单只说明收费。</b>不据此推断确诊疾病、检查所见、治疗实施或服药事实。<br><br>' +
    '<b>药盒说明书不等于你的用药计划。</b>说明书上的通用用法与适应症不会自动填成个人实际用药计划，需要你确认后才会成为计划。' +
    '</div></div></div>';

  h += '</div><div class="grid">';

  /* ---------- 数据位置 ---------- */
  var cnt = info.counts || {};
  h += '<div class="card"><div class="card-h"><h3>数据位置与规模</h3><span class="sub">本机磁盘</span></div><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:96px minmax(0,1fr)">' +
    '<dt>目录</dt><dd style="word-break:break-all">' +
      (info.data_dir ? '<code>' + esc(info.data_dir) + '</code>'
                     : '<span class="muted">' + esc(SERVER.error || '未连接本地数据服务') + '</span>') + '</dd>' +
    '<dt>健康档案</dt><dd class="num">' + (cnt.documents !== undefined ? cnt.documents : S.tables.documents.count) + ' 条</dd>' +
    '<dt>药品</dt><dd class="num">' + (cnt.drugs !== undefined ? cnt.drugs : S.tables.drugs.count) + ' 条</dd>' +
    '<dt>指标目录</dt><dd class="num">' + (cnt.indicators !== undefined ? cnt.indicators : S.tables.indicators.count) + ' 条</dd>' +
    '<dt>日常指标</dt><dd class="num">' + (cnt.manual_records !== undefined ? cnt.manual_records : S.tables.manual_records.count) + ' 条</dd>' +
    '<dt>原始附件</dt><dd class="num">' +
      (lo.error ? '<span class="muted">' + esc(lo.error) + '</span>'
                : (lo.files || 0) + ' 个 · ' + window.LocalDB.formatBytes(lo.fileBytes || 0)) + '</dd>' +
    '<dt>自动快照</dt><dd class="num">' + (info.snapshots !== undefined ? info.snapshots + ' 份' : '—') + '</dd>' +
    '</div>' +
    '<div class="note">四张表存在 <code>health.db</code>；原始附件以磁盘原文件存在 <code>files\\</code> 里，' +
    '可以直接双击打开。导入、恢复等批量写入前会自动留一份快照到 <code>snapshots\\</code>。' +
    '<b>备份就是复制整个 <code>data</code> 目录</b>，换电脑时整包搬走即可。</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
    '<button class="btn" id="btnBackup2">导出备份（单文件）</button>' +
    '<button class="btn" id="btnRestore2">从备份恢复</button>' +
    '</div>' +
    '</div></div>';

  /* ---------- 结构化模型 ---------- */
  h += '<div class="card"><div class="card-h"><h3>结构化模型</h3><span class="sub">可选功能</span></div><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:96px minmax(0,1fr)">' +
    '<dt>状态</dt><dd>' + (llm.configured ? '<span class="tag">已配置</span>'
                                           : '<span class="tag gray">未配置</span>') + '</dd>' +
    '<dt>服务</dt><dd style="word-break:break-all">' + (llm.base_url ? esc(llm.base_url) : '<span class="muted">未设置</span>') + '</dd>' +
    '<dt>模型</dt><dd>' + (llm.model ? esc(llm.model) : '<span class="muted">未设置</span>') + '</dd>' +
    '<dt>密钥</dt><dd>' + (llm.has_key ? esc(llm.key_hint) : '<span class="muted">未设置</span>') + '</dd>' +
    '</div>' +
    '<div class="note">解析只给原文；「智能结构化」把原文拆成字段。调用前会先在本机做身份信息脱敏' +
    '（姓名、证件号、手机号、条码），只把脱敏后的原文发给你配置的模型服务。' +
    '医学内容（指标、日期、金额、机构）原样保留。密钥只写在本机 <code>data\\llm.json</code>，不进代码、不进备份。<b>不配置不影响其他任何功能。</b></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
    '<button class="btn" id="btnLlmCfg">配置模型</button>' +
    '<button class="btn" id="btnLlmProbe"' + (llm.configured ? '' : ' disabled') + '>测试连通</button>' +
    '</div><div id="llmMsg"></div>' +
    '</div></div>';

  /* ---------- 解析记录 ---------- */
  h += '<div class="card"><div class="card-h"><h3>最近解析记录</h3><span class="sub">data\\parse-log.jsonl</span></div>' +
    '<div class="card-b"><div id="parseLogBox" class="note">读取中…</div></div></div>';

  /* ---------- 隐私边界 ---------- */
  h += '<div class="card"><div class="card-h"><h3>隐私与分享边界</h3></div><div class="card-b">' +
    '<div class="note" style="margin:0">' +
    '· 没有账号体系：四张表与全部附件都在这台电脑的 <code>data</code> 目录里，页面本身不向任何服务器发送数据。<br>' +
    '· 联网的只有两处：解析（把文件送到解析服务取回文字）与可选的智能结构化（把脱敏后的原文送到你配置的模型）。<br>' +
    '· 代价是「谁能打开这台电脑」约等于「谁能看到这些资料」。共用电脑时请给系统账号设密码。<br>' +
    '· 原始附件与解析原文按敏感资料管理；被遮挡、打码、裁切掉的姓名、证件、条码、票据号不会还原、猜测或补录。<br>' +
    '· 导出备份得到的文件等同于全部健康数据，请按敏感资料保管，不要放进公共网盘或聊天群。<br>' +
    '· 本地版只在本机运行，不适合发布成公开站点：任何人都能打开的页面里放不下「仅自己可见」的医疗数据。' +
    '</div></div></div>';

  h += '</div></div>';
  host.innerHTML = h;

  var b = $('btnOpenImport');
  if (b) b.onclick = function () { openImportDrawer(null); };
  var b2 = $('btnBackup2'); if (b2) b2.onclick = doExportBackup;
  var b3 = $('btnRestore2'); if (b3) b3.onclick = openRestoreDrawer;
  var b4 = $('btnLlmCfg'); if (b4) b4.onclick = openLlmDrawer;
  var b5 = $('btnLlmProbe'); if (b5) b5.onclick = doLlmProbe;
  var pf = $('parseFiles');
  if (pf) pf.onchange = function () {
    var n = pf.files ? pf.files.length : 0;
    setParseMsg(n ? ('已选择 ' + n + ' 个文件：' + Array.prototype.slice.call(pf.files)
      .map(function (f) { return f.name + '（' + window.LocalDB.formatBytes(f.size) + '）'; }).join('、'))
      : '');
  };
  var pu = $('btnParseUpload');
  if (pu) pu.onclick = doParseUpload;
  // 先探测再决定按钮状态：避免先显示可用、随后又变成不可用。
  // 探测要等好几秒，期间页面可能重渲染 —— 按钮必须在回调里重新取，
  // 否则启用的是已分离的旧节点，新按钮会一直停在 disabled（回归套件踩到过）。
  probeBridge().then(function (br) {
    var box = $('parseBox');
    var puNow = $('btnParseUpload');
    if (!box) return;
    if (br.ok) {
      var i = br.info || {};
      var extra = [];
      if (i.cli) extra.push('解析工具 ' + esc(i.cli));
      if (i.daily_pages_remaining !== undefined) extra.push('今日剩余约 ' + esc(String(i.daily_pages_remaining)) + ' 页');
      box.innerHTML = '<div class="ok-bar">本机解析接口已就绪' +
        (extra.length ? '（' + extra.join('，') + '）' : '') +
        '。选择文件后点「上传并解析」，结果会先进入确认流程，不会直接写入档案。</div>';
      if (puNow) puNow.disabled = false;
    } else {
      box.innerHTML = '<div class="err-bar">上传解析不可用：' + esc(br.reason) +
        '。请先启动项目自带的本地服务（' + esc('启动本地工作台.bat') + '），或改用路径 B。</div>';
      if (puNow) puNow.disabled = true;
    }
  });
  renderParseLog();
}

// 把最近几次解析的真实结果摆出来：文件名、页数、字数、耗时。
// 这样「解析出来内容很少」第一次就能被看见，而不是靠猜。
async function renderParseLog() {
  var box = $('parseLogBox');
  if (!box) return;
  var list = [];
  try {
    var r = await fetch('/api/parse/log?limit=12', { cache: 'no-store' });
    var j = await r.json();
    if (j && j.ok) list = j.entries || [];
  } catch (e) {
    box.innerHTML = '<div class="err-bar">读取解析记录失败：' + esc((e && e.message) || '未知错误') + '</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="muted">还没有解析记录。上传并解析一次后，这里会列出文件名、页数、返回字数与耗时。</div>';
    return;
  }
  var rows = list.map(function (e) {
    var names = (e.files || []).map(function (f) { return f.name || '未命名'; }).join('、') || '—';
    var chars = e.total_chars !== undefined ? e.total_chars
      : (e.documents || []).reduce(function (a, d) { return a + (d.chars || 0); }, 0);
    var pages = (e.files || []).length;
    var bad = e.ok && chars < 200;      // 读出来的字太少，多半是原件质量问题
    return '<div style="padding:6px 0;border-bottom:1px solid #eef1f5">' +
      '<div><b>' + esc(names) + '</b> ' +
      (e.ok ? '<span class="tag' + (bad ? '' : ' gray') + '">' + (bad ? '内容偏少' : '成功') + '</span>'
            : '<span class="tag">失败</span>') +
      (e.api && e.api !== 'auto' ? ' <span class="muted">' + esc(e.api) + '</span>' : '') +
      '</div>' +
      '<div class="muted" style="font-size:12px">' +
      esc(String(e.at || '')) + ' · ' + pages + ' 个文件 · 返回 ' + chars + ' 字 · 耗时 ' +
      (e.elapsed !== undefined ? e.elapsed + ' 秒' : '—') +
      (e.task_id ? ' · 任务 ' + esc(String(e.task_id).slice(0, 12)) : '') +
      '</div>' +
      (e.ok ? '' : '<div class="err-bar" style="margin-top:4px">' + esc(e.error || '解析失败') + '</div>') +
      (bad ? '<div class="note" style="margin-top:4px">读出的文字很少。常见原因是照片模糊、倾斜、反光、' +
        '阴影遮挡，或扫描件对比度过低；请正对原件、光线均匀地重拍后再试。</div>' : '') +
      '</div>';
  }).join('');
  var miss = list.filter(function (e) { return e.ok && ((e.total_chars || 0) < 200); }).length;
  box.innerHTML = rows +
    (miss ? '<div class="note" style="margin-top:8px">有 ' + miss + ' 次解析读出的内容偏少。' +
      '如果原件本身清晰，请把该文件发给开发者核对。</div>' : '');
}

/* ---------------- 12. 归档（真实写入） ---------------- */

function normalizeArchivePayload(raw) {
  var target = null, records = [];
  var obj = raw;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (Array.isArray(obj.records)) { records = obj.records; target = obj.target || null; }
    else if (Array.isArray(obj.drugs)) { records = obj.drugs; target = 'drugs'; }
    else records = [obj];
  } else if (Array.isArray(obj)) records = obj;
  records = records.filter(function (r) { return r && typeof r === 'object'; });
  if (!target) {
    var hasDrug = records.some(function (r) { return r.drug_name || r.drug_key; });
    var hasDoc = records.some(function (r) { return r.document_type; });
    target = (hasDrug && !hasDoc) ? 'drugs' : 'documents';
  }
  /* 日期状态按最终日期统一重判（导入兜底）：有合法日期 → 已确认；
     没日期或日期非法 → 待确认。归档包可能由外部按旧规则生成（有日期却标
     「待确认」），不在这里重判的话，"时间明明读到了还要再确认一次"会从
     这条口子再漏回来。原样写入的只有日期文本本身，状态是派生值。 */
  if (target !== 'drugs') {
    records.forEach(function (r) {
      var d = (r.primary_date === null || r.primary_date === undefined) ? '' : String(r.primary_date).trim();
      r.date_status = (d && L.isValidDate(d)) ? L.DATE_STATUS.CONFIRMED : L.DATE_STATUS.PENDING;
    });
  }
  return { target: target, records: records };
}

var IMPORT = { payload: null, files: [], label: '' };

function docTypeOptions(selected) {
  return (L.DOC_TYPES || []).map(function (t) {
    return '<option value="' + attr(t) + '"' + (t === selected ? ' selected' : '') + '>' + esc(t) + '</option>';
  }).join('');
}

function openImportDrawer(target, preset) {
  IMPORT = { payload: null, files: [], label: '', preset: !!preset, personApplied: false };
  S.drugArchiveTarget = target || null;
  S.pendingPerson = null;
  var body = $('importBody');
  var head = '';
  if (preset) {
    head += '<div class="note" style="margin-top:0">来源：<b>本机解析接口</b>。' +
      '下方原文来自解析服务，请先确认文档类型与主日期。本次只写入原文，' +
      '检验项、检查所见、收费明细等结构化字段尚未提取 —— 需要结构化时，' +
      '请把原件提交到对话中由解析与结构化流程处理。</div>';
    head += '<div class="field"><label>本次已选原始文件</label><div class="minor" style="margin:0">' +
      (preset.files || []).map(function (f) {
        return esc(f.name) + '（' + window.LocalDB.formatBytes(f.size) + '）';
      }).join('<br>') + '</div></div>';
  }
  body.innerHTML = head +
    '<div class="field"><label>归档包（.json）' + (preset ? '（可选）' : '<span class="req">*</span>') + '</label>' +
    '<input type="file" id="impJson" accept=".json,application/json">' +
    '<div class="hint">选择在对话中生成的脱敏归档包。包内含 <code>records</code> 数组时按多条写入。' +
    (preset ? '选择归档包会覆盖当前这条解析草稿。' : '') + '</div></div>' +
    '<div class="field"><label>原始文件（可选，可多选）</label>' +
    '<input type="file" id="impFiles" multiple>' +
    '<div class="hint">PDF / JPG / PNG / BMP / TIFF / WebP。文件保存在本机磁盘 data\\files\\ 下，不上传到任何服务器；' +
    '同一份报告的多页请一次选中，保持选择顺序。</div></div>' +
    // 归属成员放在预览区之外：预览会随文件选择重绘，选择器重绘会丢掉用户刚选的人
    (personSupported()
      ? '<div class="field"><label>归属成员<span class="req">*</span></label>' +
        '<select id="impPerson">' + personOptions(defaultPersonId(), true) + '</select>' +
        '<div class="hint">本次写入的全部记录都会归到这位成员。之后可在「健康档案」「原始资料档案」按成员筛选，' +
        '或在「成员管理」里调整。</div></div>'
      : '') +
    '<div id="impPreview"></div>';
  if (preset) {
    IMPORT.payload = preset.payload;
    IMPORT.files = preset.files || [];
    IMPORT.label = '本机解析结果';
  }
  // 抽屉里的成员选择器
  var psSel = $('impPerson');
  if (psSel) psSel.onchange = function () { S.pendingPerson = psSel.value; };
  $('impJson').onchange = async function () {
    var f = $('impJson').files[0];
    if (!f) { IMPORT.payload = null; renderImportPreview(); return; }
    IMPORT.personApplied = false;   // 新包可能自带归属，允许再同步一次
    try {
      var text = await f.text();
      var raw = JSON.parse(text);
      IMPORT.payload = normalizeArchivePayload(raw);
      IMPORT.label = f.name;
    } catch (e) {
      IMPORT.payload = { target: null, records: [], parseError: '归档包不是合法的 JSON，请检查文件内容。' };
      IMPORT.label = f.name;
    }
    IMPORT.preset = false;   // 手动选择的归档包不再走解析草稿的字段确认
    renderImportPreview();
  };
  $('impFiles').onchange = function () { IMPORT.files = Array.prototype.slice.call($('impFiles').files); renderImportPreview(); };
  renderImportPreview();
  openDrawer('drawer-import');
}

function renderImportPreview() {
  var el = $('impPreview');
  if (!el) return;
  syncImportPersonFromPayload();
  var p = IMPORT.payload;
  var h = '';
  if (!p) {
    h = '<div class="note">尚未选择归档包。</div>';
  } else if (p.parseError) {
    h = '<div class="err-bar">' + esc(p.parseError) + '</div>';
  } else {
    if (IMPORT.preset && p.records.length && p.target !== 'drugs') {
      var r0 = p.records[0];
      h += '<div class="card" style="margin-bottom:12px"><div class="card-h"><h3>确认归档字段</h3>' +
        '<span class="sub">类型请核对；日期已从原文读取并自动确认</span></div><div class="card-b">' +
        '<div class="field"><label>文档类型 <span class="req">*</span></label>' +
        '<select id="presetType">' + docTypeOptions(r0.document_type) + '</select></div>' +
        '<div class="field"><label>主日期</label>' +
        '<input type="date" id="presetDate" value="' + attr(L.isValidDate(r0.primary_date) ? r0.primary_date : '') + '">' +
        '<div class="hint">' + (nz(r0.primary_date)
          ? '这是从原文读取的日期，已直接按「已确认」处理，无需再另行确认。'
          : '原文中没有可用的日期。') +
        '留空表示日期未确认：记录会保留，但不会参与按日期的汇总与趋势。</div></div>' +
        '<div class="field"><label>标题</label>' +
        '<input type="text" id="presetTitle" value="' + attr(r0.title || '') + '" placeholder="例如：血常规报告单">' +
        '<div class="hint">留空则卡片显示文档类型。</div></div>' +
        '</div></div>';
    }
    var tbl = p.target === 'drugs' ? '药品表' : '健康档案表';
    h += '<div class="ok-bar">将写入 <b>' + tbl + '</b>，共 <b>' + p.records.length + '</b> 条记录。</div>';
    if (!p.records.length) h += '<div class="err-bar">归档包内没有可写入的记录。</div>';
    p.records.forEach(function (r, i) {
      if (p.target === 'drugs') {
        h += '<div class="minor"><b>' + esc(nz(r.drug_name) || '(无药品名)') + '</b>　' +
          esc(nz(r.strength) || '规格未提供') + '　' + esc(nz(r.dosage_form) || '剂型未提供') +
          '<div class="muted" style="font-size:11.5px">唯一键 ' + esc(nz(r.drug_key) || '未提供') +
          ' · 状态 ' + esc(nz(r.status) || '备用药') + '</div></div>';
      } else {
        var tsd = r.type_specific_data || {};
        var cnt = Array.isArray(tsd.lab_results) ? tsd.lab_results.length : 0;
        var ex = Array.isArray(tsd.exams) ? tsd.exams.length : 0;
        var amt = L.receiptAmount(r);
        h += '<div class="minor"><b>' + esc(nz(r.title) || '(无标题)') + '</b>　' +
          '<span class="tag">' + esc(L.normalizeDocType(r.document_type) || '类型未提供') + '</span>' +
          '<div class="muted" style="font-size:11.5px">日期 ' + esc(nz(r.primary_date) || '待确认') +
          ' · ' + esc(nz(r.date_status) || L.DATE_STATUS.PENDING) +
          ' · 检验结果 ' + cnt + ' 项 · 检查 ' + ex + ' 项' +
          ' · 金额 ' + esc(amt.value === null ? '未提供' : L.fmtMoney(amt.value)) +
          ' · 哈希 ' + esc(nz(r.file_hash) ? String(r.file_hash).slice(0, 12) + '…' : '未提供') + '</div></div>';
      }
    });
    if (IMPORT.files.length) {
      h += '<div class="note">将上传 ' + IMPORT.files.length + ' 个原始文件：' +
        IMPORT.files.map(function (f) { return esc(f.name); }).join('、') + '</div>';
      /* 混多人资料提示（§11 待办 10）：一次选多个文件会被合并进同一批记录、
         只能挂一个归属人。文件多于记录数时，多半是多个文件被并成了一条档案 ——
         如果这些文件其实属于不同成员，按人筛选时其他人会看不到自己的那份。 */
      if (IMPORT.files.length > 1 && p.records.length === 1) {
        h += '<div class="ok-bar" style="border-color:var(--blue)">' +
          '注意：你选了 ' + IMPORT.files.length + ' 个文件，但只生成 <b>1</b> 条记录，' +
          '它们会合并成一条档案、归到同一位成员。若这些文件包含<b>不同成员</b>的报告，' +
          '请<b>按人分批上传</b>（一次只选同一人的文件），否则按成员筛选时其他人会看不到自己的资料。</div>';
      }
    } else {
      h += '<div class="note">未选择原始文件：记录可以写入，但详情页会明确显示「原始文件未留存」，并允许随后补传。</div>';
    }
    if (personSupported()) {
      var pSel2 = $('impPerson');
      var pName = pSel2 && pSel2.value ? personNameOf(pSel2.value) : null;
      h += pName
        ? '<div class="note">本次归档归属：<b>' + esc(pName) + '</b>。</div>'
        : '<div class="err-bar">还没有任何成员，这次写入的档案将「未指定」归属。' +
          '建议先到「成员管理」添加一个成员。</div>';
    }
  }
  el.innerHTML = h;
  if (IMPORT.preset && IMPORT.payload && !IMPORT.payload.parseError &&
      IMPORT.payload.records && IMPORT.payload.records.length && IMPORT.payload.target !== 'drugs') {
    bindPresetFields();
  }
}

// 草稿字段的编辑直接落到待写入的对象上，避免中间态与显示不一致
function bindPresetFields() {
  var r0 = IMPORT.payload.records[0];
  var sel = $('presetType');
  if (sel) sel.onchange = function () { r0.document_type = sel.value; };
  var ti = $('presetTitle');
  if (ti) ti.oninput = function () { r0.title = ti.value.trim() || null; };
  var dt = $('presetDate');
  if (dt) dt.onchange = function () {
    var v = dt.value;
    if (v && !L.isValidDate(v)) {
      dt.value = ''; r0.primary_date = null; r0.date_status = L.DATE_STATUS.PENDING;
      return setImportMsg('日期无效，请检查年月日是否存在。', true);
    }
    r0.primary_date = v || null;
    r0.date_status = v ? L.DATE_STATUS.CONFIRMED : L.DATE_STATUS.PENDING;
  };
}

async function doImport() {
  var btn = $('btnImportSave');
  var p = IMPORT.payload;
  if (!p || p.parseError || !p.records.length) {
    return setImportMsg('请先选择一个有效的归档包。', true);
  }
  var tableName = p.target === 'drugs' ? 'drugs' : 'documents';
  var rows = [];
  var skipped = [];
  var existing = bucket(tableName).rows;

  // 归属成员：抽屉里的选择对本次全部记录生效。
  // 没有任何成员时（用户把六个全删了）才允许不带归属写入，不静默挂给别人。
  var pid = null;
  if (personSupported()) {
    var pSel = $('impPerson');
    if (pSel && pSel.value) pid = Number(pSel.value);
    else if (S.persons.length) {
      return setImportMsg('请为这次归档选择归属成员。', true);
    }
  }

  // 附件先上传，失败即中止，避免留下指向空文件的记录
  var uploaded = [];
  if (IMPORT.files.length) {
    btn.disabled = true;
    setImportMsg('正在上传原始文件…');
    try {
      for (var i = 0; i < IMPORT.files.length; i++) uploaded.push(await uploadOriginal(IMPORT.files[i]));
    } catch (e) {
      btn.disabled = false;
      return setImportMsg('原始文件上传失败：' + (e && e.message ? e.message : '未知错误') + '。未写入任何记录。', true);
    }
  }

  // 幂等：稳定文件哈希优先，其次解析任务标识；不按日期、医院、金额去重
  p.records.forEach(function (rec, idx) {
    var row = Object.assign({}, rec);
    delete row._target; delete row.target; delete row.attachment_pending; delete row.attachment_note;
    delete row.id; delete row.record_id; delete row.owner_id; delete row.created_at; delete row.updated_at;
    if (pid !== null) row.person_id = pid;

    // 单个原始文件时直接挂到该条记录；多文件多记录时按文件名包含关系匹配，匹配不到的全部挂到第一条
    var atts = attachmentsOf(row);
    if (uploaded.length === 1) atts = atts.concat(uploaded);
    else if (uploaded.length > 1) {
      var match = uploaded.filter(function (u) {
        var key = String(row.source_file || '');
        return key && u.name && (u.name === key || key.indexOf(u.name) >= 0 || u.name.indexOf(key) >= 0);
      });
      atts = atts.concat(match.length ? match : (idx === 0 ? uploaded : []));
    }
    if (atts.length) { row.source_attachments = atts; }
    else if (!Array.isArray(row.source_attachments)) { row.source_attachments = []; }

    /* 去重键必须带归属：这是一家人共用的工作台，同一份 PDF（比如一份写满两人的
       家庭体检报告）本来就该能分别归档给不同成员。整表按哈希拦截的话，
       第二个人永远存不进去，界面只说"已存在"，看起来像 bug。 */
    var sameOwner = function (e, r) {
      var blank = function (v) { return (v === null || v === undefined || v === '') ? 0 : Number(v); };
      return blank(e.person_id) === blank(r.person_id);
    };
    var dupKey = row.file_hash
      ? existing.some(function (e) { return e.file_hash && e.file_hash === row.file_hash && sameOwner(e, row); })
      : (row.xparse_task_id ? existing.some(function (e) { return e.xparse_task_id && e.xparse_task_id === row.xparse_task_id && sameOwner(e, row); }) : false);
    if (dupKey) { skipped.push(row.title || row.drug_name || ('第 ' + (idx + 1) + ' 条')); return; }
    rows.push(row);
  });

  if (!rows.length) {
    btn.disabled = false;
    return setImportMsg('全部记录都已存在（按文件哈希或解析任务标识识别），本次没有新增，避免重复入库。' + (skipped.length ? '已跳过：' + skipped.join('、') : ''), true);
  }

  btn.disabled = true;
  setImportMsg('正在写入 ' + rows.length + ' 条记录…');
  var res = await cloud.database.from(tableName).insert(rows).select();
  if (res.error) {
    btn.disabled = false;
    return setImportMsg('写入失败：' + esc(res.error.message) + '。数据库中的状态没有改变，表单内容已保留，可修正后重试。', true);
  }
  var created = res.data || [];
  if (created.length !== rows.length) {
    setImportMsg('写入返回 ' + created.length + ' 条，预期 ' + rows.length + ' 条，正在回读核对…', true);
  }

  // 回读校验
  await loadTable(tableName, tableName === 'drugs' ? 'updated_at' : 'primary_date');
  var ids = created.map(function (r) { return r.id; });
  var back = bucket(tableName).rows.filter(function (r) { return ids.indexOf(r.id) >= 0; });
  var attCount = back.reduce(function (s, r) { return s + attachmentsOf(r).length; }, 0);

  var summary = '写入完成并已回读：' + tableName + ' 新增 ' + created.length + ' 条（回读命中 ' + back.length + ' 条），' +
    '附件 ' + attCount + ' 个。记录主键：' + ids.join('、') + '。';
  if (skipped.length) summary += ' 已跳过重复记录：' + skipped.join('、') + '。';
  btn.disabled = false;
  setImportMsg(summary, back.length !== created.length);
  IMPORT = { payload: null, files: [], label: '', preset: false, personApplied: false };
  renderImportPreview();
  renderCurrent();
}

function setImportMsg(text, isErr) {
  var el = $('impPreview');
  if (!el) return;
  var box = document.createElement('div');
  box.className = isErr ? 'err-bar' : 'ok-bar';
  box.style.marginTop = '11px';
  box.textContent = text;
  el.appendChild(box);
}

/* ---------------- 13. 原始资料档案 ---------------- */

function renderArchive() {
  var host = $('s-archive');
  var all = bucket('documents').rows;
  var f = S.archFilter;
  var docs = all.filter(function (r) {
    if (f.type && L.normalizeDocType(r.document_type) !== f.type) return false;
    if (!L.personMatches(r, S.personView)) return false;
    if (f.q) {
      var hay = [r.title, r.source_file, r.hospital].join(' ');
      if (hay.toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  });
  var withAtt = docs.filter(function (r) { return attachmentsOf(r).length; });
  var files = 0;
  docs.forEach(function (r) { files += attachmentsOf(r).length; });

  var h = '';
  h += '<div class="page-head"><h2>原始资料档案</h2>' +
    '<p>集中展示来源文件与档案条目。这里不改变健康档案的日期归组含义，只做来源层面的检索与下钻。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

  h += '<div class="stats-strip">' +
    '<div class="s"><div class="k">档案条目</div><div class="v num">' + docs.length + '</div></div>' +
    // 这里是"引用数"：同一个文件被两份档案共用会算两次；上传页那个数字才是磁盘上的文件个数。
    '<div class="s"><div class="k" title="按档案累计的文件引用数；同一文件被多份档案共用时会重复计入。磁盘上有多少个文件请看「上传资料」页">原始文件引用</div><div class="v num">' + files + '</div></div>' +
    '<div class="s"><div class="k">已留存原始文件的档案</div><div class="v num">' + withAtt.length + '</div></div>' +
    '<div class="s"><div class="k">原始文件未留存</div><div class="v num">' + (docs.length - withAtt.length) + '</div></div>' +
    '</div>';

  var types = L.DOC_TYPES.slice();
  all.forEach(function (r) { var t = L.normalizeDocType(r.document_type); if (types.indexOf(t) < 0) types.push(t); });
  h += '<div class="filters">' +
    '<input type="search" id="arQ" placeholder="搜索标题 / 原始文件名 / 医院" value="' + attr(f.q) + '">' +
    '<select id="arType"><option value="">全部类型</option>' + types.map(function (t) {
      return '<option value="' + attr(t) + '"' + (f.type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('') + '</select>' +
    (personSupported() ? '<select id="arPerson">' + personViewOptions() + '</select>' : '') +
    '<button class="btn sm" id="arClear">清空筛选</button></div>';

  h += '<div id="arMsg"></div>';

  if (!docs.length) h += msg(all.length ? '没有符合筛选条件的档案。' : '还没有任何档案条目。');
  else {
    docs.forEach(function (r) {
      var atts = attachmentsOf(r);
      h += '<div class="arch-row" data-doc="' + attr(r.id) + '">' +
        '<span class="fi">' + (atts.length ? 'FILE' : '—') + '</span>' +
        '<span class="nm"><b>' + esc(nz(r.title) || '(无标题)') + '</b>' + personBadge(r) +
        '<div class="muted" style="font-size:11.5px">' +
        esc(nz(r.source_file) || '原始文件名未提供') + ' · ' +
        esc(nz(r.hospital) || '医院未提供') + ' · ' + esc(nz(r.document_type) || '类型未提供') +
        (r.xparse_task_id ? ' · 解析任务 ' + esc(String(r.xparse_task_id).slice(0, 10)) + '…' : '') +
        '</div></span>' +
        '<span class="mt">' + (nz(r.primary_date) && !L.isDatePending(r) ? esc(L.fmtYearMonth(r.primary_date)) : L.DATE_STATUS.PENDING) +
        ' · ' + atts.length + ' 个附件</span>' +
        archiveDelCell(r, atts.length) + '</div>';
    });
  }
  host.innerHTML = h;

  var am = $('arMsg');
  if (am && ARCHIVE_UI.msg) {
    am.innerHTML = '<div class="' + (ARCHIVE_UI.isErr ? 'err-bar' : 'ok-bar') +
      '" style="margin:10px 0">' + esc(ARCHIVE_UI.msg) + '</div>';
    ARCHIVE_UI.msg = '';
  }

  var q = $('arQ');
  if (q) q.oninput = function () { S.archFilter.q = q.value; renderArchive(); var e2 = $('arQ'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } };
  var t2 = $('arType'); if (t2) t2.onchange = function () { S.archFilter.type = t2.value; renderArchive(); };
  var ps2 = $('arPerson'); if (ps2) ps2.onchange = function () { setPersonView(ps2.value); };
  var c2 = $('arClear'); if (c2) c2.onclick = function () { S.archFilter = { q: '', type: '', person: '' }; renderArchive(); };
  qsa('#s-archive [data-doc]').forEach(function (row) {
    row.onclick = function (e) {
      // 删除区里的点击不该顺手打开详情
      if (e && e.target && e.target.closest && e.target.closest('.del-cell')) return;
      openDoc(row.dataset.doc, '原始资料档案');
    };
  });
  qsa('#s-archive [data-del]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      ARCHIVE_UI.pendingDel = b.dataset.del;
      renderArchive();
    };
  });
  qsa('#s-archive [data-del-cancel]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      ARCHIVE_UI.pendingDel = null;
      renderArchive();
    };
  });
  qsa('#s-archive [data-del-confirm]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      // 属性是 data-del-confirm，取 dataset 要用 delConfirm；写成 del 会拿到 undefined，
      // 转成 Number 后是 NaN，序列化进 JSON 变成 null —— 自检就是这么逮到第一次的。
      deleteOneRecord(b.dataset.delConfirm, 'archive');
    };
  });
}

/* 删除入口。用「二次点击」而不是原生 confirm —— 原生弹窗在自动化里会被自动取消，
   等于这类不可逆操作永远测不到（与成员页同一套做法）。 */
var ARCHIVE_UI = { pendingDel: null, msg: '', isErr: false };

function archiveDelCell(r, attCount) {
  if (!cloud.hasDeleteRecords()) return '';
  var id = String(r.id);
  if (ARCHIVE_UI.pendingDel === id) {
    return '<span class="del-cell">' +
      '<button class="btn sm danger" data-del-confirm="' + attr(id) + '">确认删除？</button>' +
      '<button class="btn sm ghost" data-del-cancel="' + attr(id) + '">取消</button>' +
      '<span class="muted" style="font-size:11.5px">原件 ' + attCount +
      ' 个会一并从本机移除，删除前自动打快照</span></span>';
  }
  return '<span class="del-cell">' +
    '<button class="btn sm ghost" data-del="' + attr(id) + '">删除</button></span>';
}

async function deleteOneRecord(id, from) {
  var res = await cloud.deleteRecords('documents', [Number(id)]);
  if (!res.ok) {
    ARCHIVE_UI.pendingDel = null;
    if (from === 'doc') { DOC_UI.pendingDel = null; setDocMsg('删除失败：' + res.reason, true); }
    else { ARCHIVE_UI.msg = '删除失败：' + res.reason; ARCHIVE_UI.isErr = true; renderArchive(); }
    return;
  }
  ARCHIVE_UI.pendingDel = null;
  DOC_UI.pendingDel = null;
  // 删除发生在服务端（行 + 磁盘附件），门面缓存不会自己失效，必须 invalidate
  cloud.invalidate();
  await loadTable('documents', 'primary_date');
  await refreshPersons();
  await refreshLocalStats();

  var parts = ['已删除这份档案'];
  if (res.filesRemoved.length) parts.push('回收了 ' + res.filesRemoved.length + ' 个不再被引用的原始文件');
  if (res.keptReferenced.length) parts.push(res.keptReferenced.length + ' 个文件因被其他档案共用而保留');
  if (res.filesFailed.length) {
    parts.push('有文件删不掉（可能被其他程序打开）：' +
      res.filesFailed.map(function (f) { return f.path; }).join('、'));
  }
  if (res.snapshot) parts.push('删除前快照：' + res.snapshot);
  var text = parts.join('；') + '。';

  if (from === 'doc') { closeLayer(); renderCurrent(); showGlobalMsg(text, false); }
  else { ARCHIVE_UI.msg = text; ARCHIVE_UI.isErr = false; renderCurrent(); }
}

function setArchiveMsg(text, isErr) {
  ARCHIVE_UI.msg = text;
  ARCHIVE_UI.isErr = !!isErr;
  renderArchive();
}

/* 跨屏幕的反馈走这里：从健康档案 / 票据来源 / 指标详情进详情页删除时，
   当前屏幕并不是原始资料档案，把反馈写进 #arMsg 等于写进一个 display:none 的容器 ——
   用户点了"确认删除这份档案"之后什么都看不见，包括回退所需的快照文件名。 */
function showGlobalMsg(text, isErr) {
  var m = $('globalMsg');
  if (!m) return;
  if (!text) { m.hidden = true; m.innerHTML = ''; return; }
  m.innerHTML = '<div class="' + (isErr ? 'err-bar' : 'note') + '">' + esc(text) +
    '<button class="btn sm ghost" id="btnGlobalMsgClose" style="margin-left:8px">知道了</button></div>';
  m.hidden = false;
  var c = $('btnGlobalMsgClose');
  if (c) c.onclick = function () { showGlobalMsg(null); };
}

/* ---------------- 13.5 成员管理 ---------------- */

// 删除与批量归属都是不可逆操作。这里用「二次点击」而不是浏览器原生 confirm：
// 原生弹窗在自动化里会被自动取消，等于这类操作永远测不到。
var PERSONS_UI = { pendingDel: null, pendingAssign: null, draft: {}, adding: '' };

function renderPersons() {
  var host = $('s-persons');
  var total = bucket('documents').rows.length;
  var unassigned = unassignedCount();

  var h = '';
  h += '<div class="page-head"><h2>成员管理</h2>' +
    '<p>把家庭里每个人的报告分开归档与筛选。成员名单存在本机 <code>data\\health.db</code> 里，' +
    '跟着备份一起走；成员本身不含任何健康数据，改名字、改顺序都不会动到档案。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

  if (S.personState === 'unsupported') {
    h += msg('当前数据层不支持成员配置（成员名单需要一个可用的本地数据服务）。' +
      '请确认本地服务正常运行后刷新页面。' + (S.personError ? '原因：' + esc(S.personError) : ''));
    host.innerHTML = h;
    return;
  }
  if (S.personState === 'error') {
    h += '<div class="err-bar">成员名单读取失败：' + esc(S.personError) + '</div>' +
      '<div style="margin-top:10px"><button class="btn primary" id="psRetry">重试</button></div>';
    host.innerHTML = h;
    var rt = $('psRetry');
    if (rt) rt.onclick = async function () { await refreshPersons(); renderPersons(); };
    return;
  }

  h += '<div class="stats-strip">' +
    '<div class="s"><div class="k">成员人数</div><div class="v num">' + S.persons.length + '</div></div>' +
    '<div class="s"><div class="k">档案总数</div><div class="v num">' + total + '</div></div>' +
    '<div class="s"><div class="k">已归属</div><div class="v num">' + (total - unassigned) + '</div></div>' +
    '<div class="s"><div class="k">未指定归属</div><div class="v num">' + unassigned + '</div></div>' +
    '</div>';

  h += '<div class="card"><div class="card-h"><h3>成员名单</h3>' +
    '<span class="sub">顺序决定下拉里的排列；改名不改已有档案的归属</span></div><div class="card-b">';

  if (!S.persons.length) {
    h += '<div class="empty">还没有任何成员。先添加一个，才能在归档时选择归属。</div>';
  }

  S.persons.forEach(function (p, i) {
    var cnt = personCount(p.id);
    var draft = PERSONS_UI.draft[String(p.id)];
    var val = (draft === undefined) ? String(p.name) : draft;
    var dirty = (draft !== undefined && draft.trim() !== String(p.name).trim());
    var gOpts = [['', '性别未设'], ['男', '男'], ['女', '女']].map(function (g) {
      return '<option value="' + attr(g[0]) + '"' + ((p.gender || '') === g[0] ? ' selected' : '') +
        '>' + g[1] + '</option>';
    }).join('');
    h += '<div class="person-row">' +
      '<span class="nm"><input type="text" class="inp-sm" data-person-name="' + attr(String(p.id)) +
      '" value="' + attr(val) + '" maxlength="20" aria-label="成员名称"></span>' +
      '<span class="role">' + esc(roleLabel(p.role)) + '</span>' +
      '<span class="mt"><select class="inp-sm" data-person-gender="' + attr(String(p.id)) +
      '" aria-label="成员性别" style="width:96px">' + gOpts + '</select></span>' +
      '<span class="mt num">' + cnt + ' 份</span>' +
      '<span class="acts">' +
      (dirty ? '<button class="btn sm primary" data-person-save="' + attr(String(p.id)) + '">保存改名</button>' : '') +
      '<button class="btn sm ghost" data-person-up="' + attr(String(p.id)) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn sm ghost" data-person-down="' + attr(String(p.id)) + '"' +
      (i === S.persons.length - 1 ? ' disabled' : '') + '>↓</button>' +
      (PERSONS_UI.pendingDel === Number(p.id)
        ? '<button class="btn sm danger" data-person-del-confirm="' + attr(String(p.id)) + '">确认删除？</button>' +
          '<button class="btn sm ghost" data-person-del-cancel="1">取消</button>'
        : '<button class="btn sm ghost" data-person-del="' + attr(String(p.id)) + '">删除</button>') +
      '</span></div>';
    if (PERSONS_UI.pendingDel === Number(p.id)) {
      var ownedRows = personOwnedTables(p.id);
      var ownedN = ownedRows.reduce(function (a, o) { return a + o.count; }, 0);
      h += '<div class="err-bar" style="margin:0 0 8px">' +
        (ownedN > 0
          ? '删除后，这个成员名下的 ' + ownedN + ' 条资料（' +
            ownedRows.map(function (o) {
              return (o.table === 'documents' ? '档案' : '手动记录') + ' ' + o.count;
            }).join('、') + '）会变成「未指定」。资料本身不会被删除，' +
            '重新添加一个成员后再批量归属即可找回。'
          : '这个成员名下没有资料，删除只影响名单。') +
        '继续请点「确认删除」。</div>';
    }
  });

  h += '<div class="person-row" style="border-top:1px solid #eef1f5;margin-top:8px;padding-top:12px">' +
    '<span class="nm"><input type="text" class="inp-sm" id="psNewName" placeholder="新成员名称，例如：女儿" ' +
    'value="' + attr(PERSONS_UI.adding) + '" maxlength="20" aria-label="新成员名称"></span>' +
    '<span class="role muted">新增</span>' +
    '<span class="mt"><select class="inp-sm" id="psNewGender" aria-label="新成员性别" style="width:96px">' +
    '<option value="">性别未设</option><option value="男">男</option><option value="女">女</option>' +
    '</select></span>' +
    '<span class="mt"></span>' +
    '<span class="acts"><button class="btn sm primary" id="psAdd">添加成员</button></span></div>';
  h += '</div></div>';
  h += '<div class="note">性别决定「添加关注」清单里能看到哪些指标：' +
    '前列腺等男性专属项不会出现在女性成员的清单里，白带常规、宫颈等女性专属项同理。' +
    '设为「性别未设」则不过滤、全部可选。</div>';

  // 旧资料迁移：把没有归属的记录一次性挂到某个成员名下
  h += '<div class="card"><div class="card-h"><h3>旧资料归属</h3>' +
    '<span class="sub">这个功能上线前归档的资料没有归属人</span></div><div class="card-b">' +
    (unassigned
      ? '<div class="note" style="margin-top:0">有 <b>' + unassigned + '</b> 份档案尚未指定归属，' +
        '筛选时用「未指定」可以单独挑出来。</div>' +
        '<div class="field"><label>把这些档案归到</label><select id="psAssignTo">' +
        S.persons.map(function (p) {
          return '<option value="' + attr(String(p.id)) + '">' + esc(p.name) + '</option>';
        }).join('') + '</select>' +
        '<div class="hint">只改动「未指定」的档案，已经归属到其他成员的不受影响。' +
        '操作前会自动打一份快照，误操作可以回滚。</div></div>' +
        (PERSONS_UI.pendingAssign
          ? '<div class="err-bar">确定要把全部 ' + unassigned +
            ' 份未指定档案归给这个成员吗？此操作不可撤销（恢复前会自动打快照）。</div>' +
            '<div style="display:flex;gap:8px;margin-top:10px">' +
            '<button class="btn primary" id="psAssignConfirm">确认归属</button>' +
            '<button class="btn ghost" id="psAssignCancel">取消</button></div>'
          : '<button class="btn primary" id="psAssign">批量归属</button>')
      : '<div class="note" style="margin-top:0">没有未指定归属的档案。所有资料都已归到具体成员。</div>') +
    '</div></div>';

  h += '<div class="boundary">成员名单（名字与顺序）会随「导出备份」一起带走，' +
    '用「从备份恢复」可以还原。只删成员不会删档案。</div>';

  host.innerHTML = h;
  bindPersons();
}

function roleLabel(role) {
  var m = { self: '本人', spouse: '配偶', son: '儿子', daughter: '女儿',
    father: '父亲', mother: '母亲', mother_in_law: '母亲（配偶方）',
    father_in_law: '父亲（配偶方）', custom: '自定义' };
  return m[role] || '自定义';
}

function bindPersons() {
  var addBtn = $('psAdd');
  var newInp = $('psNewName');
  if (newInp) newInp.oninput = function () { PERSONS_UI.adding = newInp.value; };
  if (addBtn) addBtn.onclick = doPersonAdd;

  qsa('#s-persons [data-person-name]').forEach(function (inp) {
    inp.oninput = function () { PERSONS_UI.draft[inp.dataset.personName] = inp.value; };
    inp.onchange = function () {
      PERSONS_UI.draft[inp.dataset.personName] = inp.value;
      renderPersons();   // 重绘以出现「保存改名」按钮
    };
  });
  qsa('#s-persons [data-person-save]').forEach(function (b) {
    b.onclick = function () { doPersonRename(Number(b.dataset.personSave)); };
  });
  qsa('#s-persons [data-person-up]').forEach(function (b) {
    b.onclick = function () { doPersonMove(Number(b.dataset.personUp), -1); };
  });
  qsa('#s-persons [data-person-down]').forEach(function (b) {
    b.onclick = function () { doPersonMove(Number(b.dataset.personDown), 1); };
  });
  qsa('#s-persons [data-person-del]').forEach(function (b) {
    b.onclick = function () {
      PERSONS_UI.pendingDel = Number(b.dataset.personDel);
      PERSONS_UI.pendingAssign = false;
      renderPersons();
    };
  });
  qsa('#s-persons [data-person-del-confirm]').forEach(function (b) {
    b.onclick = function () { doPersonDelete(Number(b.dataset.personDelConfirm)); };
  });
  qsa('#s-persons [data-person-del-cancel]').forEach(function (b) {
    b.onclick = function () { PERSONS_UI.pendingDel = null; renderPersons(); };
  });

  qsa('#s-persons [data-person-gender]').forEach(function (sel) {
    sel.onchange = function () { doPersonGender(Number(sel.dataset.personGender), sel.value); };
  });

  var as = $('psAssign');
  if (as) as.onclick = function () { PERSONS_UI.pendingAssign = true; renderPersons(); };
  var ac = $('psAssignCancel');
  if (ac) ac.onclick = function () { PERSONS_UI.pendingAssign = false; renderPersons(); };
  var ak = $('psAssignConfirm');
  if (ak) ak.onclick = doPersonAssign;
}

function setPersonMsg(text, isErr) {
  // 成员页没有固定消息位：插到页首，操作后重新渲染即可消失
  var host = $('s-persons');
  if (!host) return;
  var box = document.createElement('div');
  box.className = isErr ? 'err-bar' : 'ok-bar';
  box.style.margin = '12px 0 0';
  box.textContent = text;
  host.insertBefore(box, host.firstChild);
}

async function doPersonAdd() {
  var inp = $('psNewName');
  var name = (inp ? inp.value : '').trim();
  if (!name) return setPersonMsg('请填写成员名称。', true);
  if (S.persons.some(function (p) { return String(p.name).trim() === name; })) {
    return setPersonMsg('已经有同名成员了：' + name + '。重名会让归档时难以分辨，请换个名字。', true);
  }
  var nid = 1;
  S.persons.forEach(function (p) { if (Number(p.id) >= nid) nid = Number(p.id) + 1; });
  var ng = $('psNewGender');
  var res = await cloud.savePersons(S.persons.concat([
    { id: nid, name: name, role: 'custom', note: '', gender: (ng ? ng.value : '') || '' }
  ]));
  if (!res.ok) return setPersonMsg('添加失败：' + res.reason, true);
  PERSONS_UI.adding = '';
  await refreshPersons();
  renderPersons();
  /* 新成员起步是空白关注清单：关注按人保存在 watched_indicators，
     不凭空继承别人的清单（想让他关注什么，切到他再勾一次即可）。 */
  setPersonMsg('已添加成员「' + name + '」。他的关注清单是空白的，' +
    '在概览顶部切到这个人，点「添加关注」勾选即可。');
}

async function doPersonGender(pid, gender) {
  var p = personById(pid);
  if (!p) return;
  var list = S.persons.map(function (x) {
    return Number(x.id) === pid ? Object.assign({}, x, { gender: gender || '' }) : x;
  });
  var res = await cloud.savePersons(list);
  if (!res.ok) return setPersonMsg('保存性别失败：' + res.reason, true);
  await refreshPersons();
  renderPersons();
  setPersonMsg('已把「' + p.name + '」的性别设为' + (gender ? '「' + gender + '」' : '「未设」') +
    (gender ? '，关注指标清单已按性别过滤。' : '，关注指标不再按性别过滤。'));
}

async function doPersonRename(pid) {
  var draft = String(PERSONS_UI.draft[String(pid)] || '').trim();
  if (!draft) return setPersonMsg('成员名称不能为空。', true);
  if (S.persons.some(function (p) { return p.id !== pid && String(p.name).trim() === draft; })) {
    return setPersonMsg('已经有同名成员了：' + draft + '。', true);
  }
  var list = S.persons.map(function (p) {
    return Number(p.id) === pid ? Object.assign({}, p, { name: draft }) : p;
  });
  var res = await cloud.savePersons(list);
  if (!res.ok) return setPersonMsg('保存失败：' + res.reason, true);
  var was = (personById(pid) || {}).name;
  delete PERSONS_UI.draft[String(pid)];
  await refreshPersons();
  renderPersons();
  // 改名后其他页面的标签要跟着变，否则会显示旧名字
  setPersonMsg('已把「' + (was || '') + '」改名为「' + draft + '」。');
}

async function doPersonMove(pid, delta) {
  var idx = -1;
  for (var i = 0; i < S.persons.length; i++) {
    if (Number(S.persons[i].id) === pid) { idx = i; break; }
  }
  if (idx < 0) return;
  var to = idx + delta;
  if (to < 0 || to >= S.persons.length) return;
  var list = S.persons.slice();
  var tmp = list[idx]; list[idx] = list[to]; list[to] = tmp;
  var res = await cloud.savePersons(list);
  if (!res.ok) return setPersonMsg('调整顺序失败：' + res.reason, true);
  await refreshPersons();
  renderPersons();
}

async function doPersonDelete(pid) {
  var gone = personById(pid);
  var owned = personOwnedTables(pid);
  var ownedTotal = owned.reduce(function (a, o) { return a + o.count; }, 0);

  // 页面文案承诺「名下的资料保留下来，改为「未指定」」，这里必须真的做到：
  // 只删名单的话，行仍挂着这个已经不存在的成员 id，筛选和标签都会显示成空白。
  // 先解除归属再删名单；解除失败就中止删除，避免留下悬空引用。
  if (owned.length) {
    for (var oi = 0; oi < owned.length; oi++) {
      var clr = await cloud.clearPerson(owned[oi].table, pid);
      if (!clr.ok) {
        PERSONS_UI.pendingDel = null;
        renderPersons();
        return setPersonMsg('删除失败：' + clr.reason +
          '。' + owned[oi].table + ' 的归属未改动，成员也还在。', true);
      }
    }
  }

  var list = S.persons.filter(function (p) { return Number(p.id) !== pid; });
  var res = await cloud.savePersons(list);
  if (!res.ok) {
    PERSONS_UI.pendingDel = null;
    return setPersonMsg('删除失败：' + res.reason, true);
  }
  PERSONS_UI.pendingDel = null;
  delete PERSONS_UI.draft[String(pid)];
  await refreshPersons();
  if (owned.length) {
    cloud.invalidate();
    for (var ri = 0; ri < owned.length; ri++) {
      await loadTable(owned[ri].table, owned[ri].table === 'documents' ? 'primary_date' : 'record_date');
    }
  }
  /* 关注行由服务端在 save_persons 里按存活成员清理（删人时连带删 watched_indicators），
     前端不再回写目录行的 followers。 */
  // 概览正停在这个人身上时得退回「全部」，否则切换器会指向一个不存在的成员
  if (Number(S.personView) === Number(pid)) S.personView = null;
  renderPersons();
  setPersonMsg('已删除成员「' + (gone ? gone.name : pid) + '」。' +
    (ownedTotal > 0 ? ownedTotal + ' 条资料（档案与手动记录）保留下来，改为「未指定」。'
      : '名下没有资料，无需处理。'));
}

async function doPersonAssign() {
  var sel = $('psAssignTo');
  if (!sel || !sel.value) return setPersonMsg('请先选择要归属到哪个成员。', true);
  var res = await cloud.assignPerson('documents', Number(sel.value), true);
  PERSONS_UI.pendingAssign = false;
  if (!res.ok) {
    renderPersons();
    return setPersonMsg('归属失败：' + res.reason, true);
  }
  // 档案的 person_id 改了，必须重读，否则列表显示的还是旧归属。
  // 关键点：改写发生在服务端 SQLite，门面层的内存缓存不会自己失效，
  // 不 invalidate 的话 loadTable 直接返回旧缓存，页面上「已归属」数字纹丝不动。
  cloud.invalidate();
  await loadTable('documents', 'primary_date');
  await refreshPersons();
  renderPersons();
  setPersonMsg('已把 ' + res.changed + ' 份档案归到该成员' +
    (res.snapshot ? '（操作前快照：' + res.snapshot + '）' : '') + '。');
}

/* ---------------- 14. 药品管理 ---------------- */

function drugCard(d) {
  var exp = L.expiryState(d);
  var group = L.drugStatusGroup(d.status);
  var acts = '';
  if (group !== 'current' && !exp.expired) acts += '<button class="btn sm primary" data-drug-start="' + attr(d.id) + '">开始用药</button>';
  if (group === 'current') acts += '<button class="btn sm" data-drug-pause="' + attr(d.id) + '">暂停用药</button>' +
    '<button class="btn sm" data-drug-stop="' + attr(d.id) + '">停止用药</button>';
  if (group === 'history') acts += '<button class="btn sm primary" data-drug-start="' + attr(d.id) + '">再次开始</button>';
  if (exp.expired) acts += '<button class="btn sm" data-drug-stop="' + attr(d.id) + '">补记停止</button>';

  return '<div class="drug-card" data-drug="' + attr(d.id) + '">' +
    '<div class="top"><div style="min-width:0"><div class="nm">' + esc(nz(d.drug_name) || '(无药品名)') + '</div>' +
    '<div class="gen">' + esc(nz(d.generic_name) || '通用名未提供') + (nz(d.brand_name) ? ' · ' + esc(d.brand_name) : '') + '</div></div>' +
    '<span class="tag' + (d.status === '正在服用' ? '' : ' gray') + '">' + esc(d.status || '备用药') + '</span>' +
    personBadge(d) + '</div>' +
    '<div class="rows">' +
    '<div class="rr"><span class="lab">规格剂型</span><span>' + esc(nz(d.strength) || '未提供') + ' · ' + esc(nz(d.dosage_form) || '未提供') + '</span></div>' +
    '<div class="rr"><span class="lab">个人用量</span><span>' + esc(nz(d.dose_each_time) || '未确认') + ' · ' + esc(nz(d.frequency) || '未确认') + '</span></div>' +
    '<div class="rr"><span class="lab">开始日期</span><span>' + (nz(d.start_date) ? esc(L.fmtCN(d.start_date)) : '<span class="muted">未提供</span>') + '</span></div>' +
    '<div class="rr"><span class="lab">数量</span><span>' + (nz(d.quantity) ? esc(String(d.quantity)) : '<span class="muted">未知</span>') + '</span></div>' +
    '<div class="rr"><span class="lab">有效期</span><span><span class="exp ' + exp.cls + '">' + esc(exp.label) + '</span></span></div>' +
    '</div>' +
    '<div class="acts">' + acts + '<button class="btn sm ghost" data-drug-open="' + attr(d.id) + '">详情</button></div>' +
    '</div>';
}

function renderDrugs() {
  var host = $('s-drugs');
  var all = bucket('drugs').rows.filter(function (d) {
    return L.personMatches(d, S.personView);
  });
  var cur = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'current'; });
  var res = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'reserve'; });
  var his = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'history'; });
  var todayInUse = cur.filter(function (d) { return L.isInUseToday(d); });

  var h = '';
  h += '<div class="page-head"><h2>药品管理</h2>' +
    '<p>按当前用药、备用 / 药箱、历史用药三组管理。所有状态变更都会真实持久化，并追加到药品的状态事件历史里，不覆盖旧记录。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

  // 成员视图：与概览/档案共用同一个人（§11 待办 9 + 14）
  if (personSupported()) {
    h += '<div class="filters" style="margin-bottom:14px">' +
      '<select id="drugPerson">' + personViewOptions() + '</select>' +
      '<span class="muted" style="font-size:12px">按成员看：当前显示 ' +
      esc(personViewLabel()) + ' 的药品</span></div>';
  }

  h += '<div class="today-bar"><div class="h">今日在用用药' +
    '<span class="tag gray">按已确认的个人计划</span></div>';
  if (!all.length) {
    h += '<div class="note" style="margin:6px 0 0">还没有药品记录。</div>';
  } else if (!todayInUse.length) {
    h += '<div class="list"><span class="pill muted">今日没有已确认的个人用药计划</span></div>' +
      '<div class="note" style="margin:6px 0 0">这里只展示原处方明确或你本人确认过的个人计划；没有计划就显示真实空态，不根据药盒自动安排时间，也不做服药提醒、打卡或库存自动扣减。</div>';
  } else {
    h += '<div class="list">' + todayInUse.map(function (d) {
      return '<span class="pill">' + esc(nz(d.drug_name) || '') + '　' +
        esc(nz(d.dose_each_time) || '用量未确认') + (nz(d.timing) ? '　' + esc(d.timing) : '') + '</span>';
    }).join('') + '</div>';
  }
  h += '</div>';

  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
    '<button class="btn primary" id="btnAddDrug">归档药品资料</button>' +
    '<button class="btn" id="btnDrugPolicy">状态与有效期规则</button></div>';

  h += '<div class="group-head"><h3>当前用药</h3><span class="ct">' + cur.length + ' 种</span><span class="ln"></span></div>';
  h += cur.length ? '<div class="drug-grid">' + cur.map(drugCard).join('') + '</div>'
    : msg('当前没有正在服用的药品。备用药箱里点「开始用药」会要求确认开始日期、个人实际每次用量与个人实际频次。');

  h += '<div class="group-head" style="margin-top:20px"><h3>备用 / 药箱</h3><span class="ct">' + res.length + ' 种</span><span class="ln"></span></div>';
  h += res.length ? '<div class="drug-grid">' + res.map(drugCard).join('') + '</div>'
    : msg('药箱为空。归档药盒、标签、说明书或处方照片后会出现在这里。');

  h += '<div class="group-head" style="margin-top:20px"><h3>历史用药</h3><span class="ct">' + his.length + ' 种</span><span class="ln"></span></div>';
  h += his.length ? '<div class="drug-grid">' + his.map(drugCard).join('') + '</div>'
    : msg('还没有已停用的药品。');

  host.innerHTML = h;

  var dp2 = $('drugPerson'); if (dp2) dp2.onchange = function () { setPersonView(dp2.value); };
  var ad = $('btnAddDrug'); if (ad) ad.onclick = function () { openImportDrawer('drugs'); };
  var dp = $('btnDrugPolicy'); if (dp) dp.onclick = function () {
    openDrawer('drawer-policy');
    $('policyBody').innerHTML =
      '<div class="boundary">' +
      '<b>状态转换。</b>备用药 → 开始用药 → 正在服用；正在服用 → 暂停用药 → 回到备用药（不建立第四种「暂停」状态）；正在服用 → 停止用药 → 已停用；已停用 → 再次开始 → 重新进入正在服用，并建立一条新事件。<br><br>' +
      '<b>历史不被覆盖。</b>每次操作都会把事件类型、操作日期、备注、原状态、新状态，以及当次的个人实际用量、频次、时间追加进事件历史。<br><br>' +
      '<b>有效期只依原文明确日期计算。</b>无日期显示「有效期待确认」；临期、即将到期、过期用蓝色深浅、灰色和描边区分，不使用红黄绿。过期药品不能开始用药，但资料和补记停止记录的操作都保留。<br><br>' +
      '<b>保存失败不改变状态。</b>远端更新失败会提示失败并保持原状态；未保存成功不会显示成功。' +
      '</div>';
    $('btnStopSave').style.display = 'none';
  };
  qsa('#s-drugs [data-drug-open]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openDrug(b.dataset.drugOpen); };
  });
  qsa('#s-drugs [data-drug-start]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openStartDrawer(b.dataset.drugStart); };
  });
  qsa('#s-drugs [data-drug-pause]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openPauseDrawer(b.dataset.drugPause); };
  });
  qsa('#s-drugs [data-drug-stop]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openStopDrawer(b.dataset.drugStop); };
  });
  qsa('#s-drugs .drug-card').forEach(function (c) {
    c.onclick = function () { openDrug(c.dataset.drug); };
  });
}

/* ---------------- 15. 抽屉 ---------------- */

function openDrawer(id) {
  qsa('.drawer').forEach(function (d) { d.classList.remove('on'); });
  $(id).classList.add('on');
  $('mask').classList.add('on');
}
function closeDrawers() {
  qsa('.drawer').forEach(function (d) { d.classList.remove('on'); });
  $('mask').classList.remove('on');
}

function openCustomDrawer() {
  var groups = {};
  catalogList().forEach(function (c) { if (c.grp) groups[c.grp] = true; });
  var ex = ['血糖', '血压', '血脂', '尿酸', '体重', '肾功能', '甲状腺', '胰岛素', '其他'];
  ex.forEach(function (g) { groups[g] = true; });
  $('cusGroup').innerHTML = Object.keys(groups).map(function (g) {
    return '<option value="' + attr(g) + '">' + esc(g) + '</option>';
  }).join('');
  $('cusName').value = ''; $('cusUnit').value = ''; $('cusAlias').value = '';

  $('btnCusSave').onclick = async function () {
    var name = $('cusName').value.trim();
    if (!name) return alert('请填写指标名称。');
    var type = $('cusType').value;
    var unit = $('cusUnit').value.trim();
    var aliasRaw = $('cusAlias').value.trim();
    var aliases = aliasRaw ? aliasRaw.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var key = 'custom_' + (L.normName(name).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '') || uuid().slice(0, 8));
    var btn = $('btnCusSave');
    btn.disabled = true; btn.textContent = '保存中…';
    var on = $('cusFollow').value === 'yes';
    /* 关注在 V2 是独立的 watched_indicators（人 × 指标）关系表，不再写在目录行的
       followed / followers 上。所以建完指标要单独把人加进关注清单：
       在某成员视图里新增就给这位成员；在「全部」或「未指定」视图里新增则发给每位成员，
       避免出现「加了个指标却没人看得见」。 */
    var who = L.isAllView(S.personView) ? null : Number(S.personView);
    var res = await cloud.database.from('indicators').insert({
      name: name, key: key, grp: $('cusGroup').value, type: type,
      unit: unit || null, aliases: aliases, sort_order: 900, preset: false
    }).select();
    if (res.error) {
      btn.disabled = false; btn.textContent = '保存指标';
      if (res.error.code === '23505') return alert('该指标名称对应的标准键已存在，请换一个名称或直接使用已有指标。');
      return alert('保存失败：' + res.error.message);
    }
    var newId = (res.data && res.data[0] && res.data[0].id) || null;
    if (on && newId !== null && newId !== undefined) {
      var targets = (who === null || who === 0)
        ? S.persons.map(function (p) { return Number(p.id); })
        : [who];
      for (var i = 0; i < targets.length; i++) {
        try {
          await fetch('/api/watched/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: targets[i], indicator_id: newId })
          });
        } catch (e) { /* 单个人加关注失败不阻断指标本身的创建 */ }
      }
    }
    btn.disabled = false; btn.textContent = '保存指标';
    await loadTable('indicators', 'sort_order');
    closeDrawers();
    renderCurrent();
  };
  openDrawer('drawer-custom');
}

function openDailyDrawer(key, presetDate) {
  var c = catalogByKey()[key] || {};
  var type = c.type || '数值';
  var h = '<div class="field"><label>指标</label><input type="text" value="' + attr(c.name || key) + '" disabled></div>' +
    '<div class="field"><label>记录日期 <span class="req">*</span></label>' +
    '<input type="date" id="dyDate" value="' + attr(presetDate || L.todayISO()) + '">' +
    '<div class="hint">日期必须真实有效；日期无效的记录会保留但不会参与趋势连线。</div></div>';

  if (type === '双数值') {
    h += '<div class="field"><label>数值一（如收缩压）<span class="req">*</span></label><input type="number" step="any" id="dyV1"></div>' +
      '<div class="field"><label>数值二（如舒张压）</label><input type="number" step="any" id="dyV2"></div>';
  } else if (type === '定性文字' || type === '指标组') {
    h += '<div class="field"><label>文本结果 <span class="req">*</span></label>' +
      '<input type="text" id="dyText" placeholder="例如：阴性 / 1+ / 未见异常">' +
      '<div class="hint">定性结果不会被当成精确数值绘制普通趋势。</div></div>';
  } else {
    h += '<div class="field"><label>结果 <span class="req">*</span></label><input type="number" step="any" id="dyV1"></div>';
  }

  h += '<div class="field"><label>归属成员 <span class="req">*</span></label>' +
    '<select id="dyPerson">' + personOwnerOptions(dyPersonDefault()) + '</select>' +
    '<div class="hint">手动记录也要分人，否则概览切到某人时会混进一家人的数据。' +
    '默认取概览当前选中的成员；「未指定」表示暂时不确定是谁。</div></div>';
  h += '<div class="field"><label>单位</label><input type="text" id="dyUnit" value="' + attr(c.unit || '') + '">' +
    '<div class="hint">留空即未知；未知单位不会与已知单位强行合并比较。</div></div>' +
    '<div class="field"><label>测量条件</label><input type="text" id="dyCond" placeholder="例如：空腹 / 餐后 2 小时">' +
    '<div class="hint">条件不同的结果不会串成同一条趋势线。</div></div>' +
    '<div class="field"><label>核对状态</label><select id="dyReview">' +
    '<option value="用户录入">用户录入</option><option value="待核对">待核对</option></select></div>' +
    '<div class="field"><label>备注</label><input type="text" id="dyNote"></div>' +
    '<div class="note">来源类型固定为「手动录入」。用户填写一次结果才会新增一条记录。</div>';
  $('dailyBody').innerHTML = h;

  $('btnDailySave').onclick = async function () {
    var date = $('dyDate').value;
    if (!L.isValidDate(date)) return alert('日期无效，请检查年月日是否存在。');
    var useKey = key, useCat = c;
    if ($('dySub') && $('dySub').value) {
      useKey = $('dySub').value;
      useCat = catalogByKey()[useKey] || c;
      type = useCat.type || '数值';
    }
    var v1 = null, v2 = null, text = null;
    if (type === '双数值') {
      var a = $('dyV1').value, b = $('dyV2').value;
      if (a === '') return alert('请填写数值一。');
      v1 = Number(a); v2 = b === '' ? null : Number(b);
    } else if (type === '定性文字' || type === '指标组') {
      text = $('dyText').value.trim();
      if (!text) return alert('请填写文本结果。');
    } else {
      var v = $('dyV1').value;
      if (v === '') return alert('请填写结果。');
      v1 = Number(v);
    }
    var unit = $('dyUnit').value.trim();
    var pv = $('dyPerson') ? $('dyPerson').value : '';
    var row = {
      person_id: (pv === '' || pv === '__none__') ? null : Number(pv),
      indicator_key: useKey, name: useCat.name || useKey, record_date: date, type: type,
      value1: v1, value2: v2, text_result: text, unit: unit || null,
      condition: $('dyCond').value.trim() || null,
      review: $('dyReview').value, note: $('dyNote').value.trim() || null, source: '手动录入'
    };
    var btn = $('btnDailySave');
    btn.disabled = true; btn.textContent = '保存中…';
    var res = await cloud.database.from('manual_records').insert(row).select();
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false; btn.textContent = '保存记录';
      return alert('保存失败：' + (res.error ? res.error.message : '服务端没有返回记录') + '。表单内容已保留。');
    }
    var newId = res.data[0].id;
    await loadTable('manual_records', 'record_date');
    var back = bucket('manual_records').rows.filter(function (r) { return r.id === newId; });
    btn.disabled = false; btn.textContent = '保存记录';
    if (!back.length) return alert('写入已返回，但回读未命中该记录，请刷新后核对。');
    closeDrawers();
    renderCurrent();
    if (S.layerStack.indexOf('indLayer') >= 0) {
      // 详情层由 V2 渲染（同一个 #indBody）。走 key → id 再打开，
      // 别去调旧实现，否则两套渲染器会抢着写同一块 DOM。
      if (window.V2) V2.openIndicatorByKey(S.indCtx ? S.indCtx.key : useKey,
        S.indCtx ? S.indCtx.from : '数据概览');
    }
  };
  openDrawer('drawer-daily');
}

function drugById(id) {
  return bucket('drugs').rows.filter(function (d) { return String(d.id) === String(id); })[0];
}

function openStartDrawer(id) {
  var d = drugById(id);
  if (!d) return;
  var exp = L.expiryState(d);
  if (exp.expired) return alert('该药品已过期，不能开始用药。资料与必要的停止记录操作仍然保留。');
  var group = L.drugStatusGroup(d.status);
  $('startBody').innerHTML =
    '<div class="boundary" style="margin-bottom:13px">药品：<b>' + esc(nz(d.drug_name) || '') + '</b>　' +
    esc(nz(d.strength) || '规格未提供') + '　' + esc(nz(d.dosage_form) || '剂型未提供') +
    '<br>当前状态：' + esc(d.status || '备用药') + '　→　开始用药后进入「正在服用」。</div>' +
    '<div class="field"><label>开始日期 <span class="req">*</span></label><input type="date" id="stDate" value="' + attr(L.todayISO()) + '"></div>' +
    '<div class="field"><label>个人实际每次用量 <span class="req">*</span></label>' +
    '<input type="text" id="stDose" placeholder="例如：1 片 / 5mg"><div class="hint">必须由你确认；说明书上的通用剂量不会被自动当成个人方案。</div></div>' +
    '<div class="field"><label>个人实际频次 <span class="req">*</span></label>' +
    '<input type="text" id="stFreq" value="' + attr(nz(d.frequency) || '') + '" placeholder="例如：每日 1 次"></div>' +
    '<div class="field"><label>服用时间（选填）</label><input type="text" id="stTiming" value="' + attr(nz(d.timing) || '') + '" placeholder="例如：早餐后"></div>' +
    '<div class="field"><label>计划结束日期（选填）</label><input type="date" id="stEnd">' +
    '<div class="hint">计划结束不能早于开始日期。</div></div>' +
    '<div class="field"><label>备注（选填）</label><input type="text" id="stNote"></div>' +
    '<div class="note">' + (group === 'history' ? '这是「再次开始」，会建立一条新事件，不改写上次的实际用药历史。' : '开始后会进入「当前用药」，并追加一条状态事件。') + '</div>';

  $('btnStartSave').onclick = async function () {
    var date = $('stDate').value, dose = $('stDose').value.trim(), freq = $('stFreq').value.trim();
    var end = $('stEnd').value;
    if (!L.isValidDate(date)) return alert('开始日期无效。');
    if (!dose) return alert('请填写个人实际每次用量。');
    if (!freq) return alert('请填写个人实际频次。');
    if (end && !L.isValidDate(end)) return alert('计划结束日期无效。');
    if (end && end < date) return alert('计划结束日期不能早于开始日期。');
    var patch = L.applyDrugEvent(d, {
      type: group === 'history' ? '再次开始' : '开始', date: date, note: $('stNote').value.trim() || null,
      dose_each_time: dose, frequency: freq, timing: $('stTiming').value.trim() || null,
      planned_end_date: end || null
    }, L.todayISO());
    await saveDrugPatch(d, patch, 'btnStartSave', '确认并开始');
  };
  openDrawer('drawer-start');
}

function openPauseDrawer(id) {
  var d = drugById(id);
  if (!d) return;
  $('pauseBody').innerHTML =
    '<div class="boundary" style="margin-bottom:13px">药品：<b>' + esc(nz(d.drug_name) || '') + '</b><br>' +
    '暂停后回到「备用药」，不建立第四种状态；原药品、原处方和全部历史事件都会保留。</div>' +
    '<div class="field"><label>暂停日期 <span class="req">*</span></label><input type="date" id="psDate" value="' + attr(L.todayISO()) + '"></div>' +
    '<div class="field"><label>备注</label><input type="text" id="psNote"></div>';
  $('btnPauseSave').onclick = async function () {
    var date = $('psDate').value;
    if (!L.isValidDate(date)) return alert('日期无效。');
    var patch = L.applyDrugEvent(d, { type: '暂停', date: date, note: $('psNote').value.trim() || null }, L.todayISO());
    await saveDrugPatch(d, patch, 'btnPauseSave', '确认暂停');
  };
  openDrawer('drawer-pause');
}

function openStopDrawer(id) {
  var d = drugById(id);
  if (!d) return;
  $('stopBody').innerHTML =
    '<div class="boundary" style="margin-bottom:13px">药品：<b>' + esc(nz(d.drug_name) || '') + '</b><br>' +
    '停止后进入「历史用药」。实际停止日期至少写入一条停止事件；原始计划日期历史不会被抹掉。</div>' +
    '<div class="field"><label>停止日期 <span class="req">*</span></label><input type="date" id="spDate" value="' + attr(L.todayISO()) + '"></div>' +
    '<div class="field"><label>是否沿用计划结束日期作为兼容字段</label>' +
    '<select id="spCompat"><option value="keep">保留原计划结束日期（推荐）</option><option value="set">同时把计划结束日期写为停止日期</option></select></div>' +
    '<div class="field"><label>备注</label><input type="text" id="spNote"></div>';
  $('btnStopSave').onclick = async function () {
    var date = $('spDate').value;
    if (!L.isValidDate(date)) return alert('日期无效。');
    var patch = L.applyDrugEvent(d, { type: '停止', date: date, note: $('spNote').value.trim() || null }, L.todayISO());
    if ($('spCompat').value === 'set') patch.planned_end_date = date;
    await saveDrugPatch(d, patch, 'btnStopSave', '确认停止');
  };
  openDrawer('drawer-stop');
}

async function saveDrugPatch(d, patch, btnId, label) {
  var btn = $(btnId);
  btn.disabled = true; btn.textContent = '保存中…';
  var res = await cloud.database.from('drugs').update(patch).eq('id', d.id).select();
  btn.disabled = false; btn.textContent = label;
  if (res.error || !res.data || !res.data.length) {
    return alert('状态未保存成功：' + (res.error ? res.error.message : '该记录不在你的权限范围内') +
      '。远端状态没有改变，页面也不会显示成功。');
  }
  await loadTable('drugs', 'updated_at');
  var back = drugById(d.id);
  if (!back || back.status !== patch.status) {
    return alert('写入已返回，但回读的状态与预期不一致，请刷新后核对。');
  }
  closeDrawers();
  renderCurrent();
  if (S.layerStack.indexOf('drugLayer') >= 0) openDrug(d.id, true);
}

/* ---------------- 16. 医疗文档详情 ---------------- */

async function openDoc(id, fromLabel) {
  var find = function () {
    return bucket('documents').rows.filter(function (r) { return String(r.id) === String(id); })[0] || null;
  };
  var rec = find();
  if (!rec && SERVER.info) {
    /* 刚解析/导入的新档案可能还没进本页缓存（比如在别的窗口操作的）。
       拉一次最新数据再试，别让用户对着一颗点了没反应的「来源」按钮发呆。 */
    try { await loadAll(); rec = find(); } catch (e) { /* 保持下方「找不到」提示 */ }
  }
  if (!rec) {
    // 原来这里是静默 return，点「来源」没反应时用户完全不知道发生了什么
    showGlobalMsg('找不到这份档案（可能已被删除）：' + id, true);
    return;
  }
  S.docFrom = fromLabel || '健康档案';
  $('docBackLabel').textContent = '返回' + S.docFrom;
  $('docTitle').textContent = nz(rec.title) || '(无标题)';
  $('docTypeTag').textContent = L.normalizeDocType(rec.document_type);
  renderDocBody(rec);
  // 从指标/药品/票据详情里点「来源」过来时，把文档层抬到最上面。
  // 否则它虽然打开了，却被还开着的来源层挡着，看上去就是点了没反应。
  liftLayerOnTop('docLayer');
  openLayer('docLayer');
  pushHistory('docLayer');
}

/** 把某个详情层抬到最上层；同层的其他层让位。 */
function liftLayerOnTop(layerId) {
  ['docLayer', 'drugLayer', 'indLayer', 'rcLayer'].forEach(function (id) {
    var el = $(id);
    if (el) el.classList.toggle('layer-top', id === layerId);
  });
}

function renderDocBody(rec) {
  var body = $('docBody');
  var atts = attachmentsOf(rec);
  var h = '<div class="split">';

  /* 左：原始文件优先 */
  h += '<div><div class="viewer" id="docViewer">' + viewerHtml(rec, atts) + '</div></div>';

  /* 右：结构化结果 */
  h += '<div class="grid">';
  h += '<div class="card"><div class="card-h"><h3>记录信息</h3>' +
    '<span class="sub">主键 #' + esc(rec.id) + '</span>' + recEditEntryHtml(rec) +
    '</div><div class="card-b">' +
    '<dl class="kv">' +
    (personSupported()
      ? '<dt>归属成员</dt><dd>' + personEditHtml(rec) + '</dd>'
      : '') +
    '<dt>文档类型</dt><dd>' + dash(rec.document_type) + '</dd>' +
    '<dt>主要日期</dt><dd>' + (nz(rec.primary_date) ? esc(L.fmtCN(rec.primary_date)) : '未提供') +
    ' <span class="tag' + (!L.isDatePending(rec) ? '' : ' gray') + '">' + esc(rec.date_status || L.DATE_STATUS.PENDING) + '</span>' +
    (L.isDatePending(rec) && nz(rec.primary_date)
      ? ' <button class="btn sm" id="btnConfirmDate" title="核对无误后一键确认，这份档案开始参与趋势与年度统计">日期无误，确认</button>'
      : '') + '</dd>' +
    '<dt>医院</dt><dd>' + dash(rec.hospital) + '</dd>' +
    '<dt>科室</dt><dd>' + dash(rec.department) + '</dd>' +
    '<dt>医生</dt><dd>' + dash(rec.doctor) + '</dd>' +
    '<dt>金额</dt><dd>' + (function () {
      var a = L.receiptAmount(rec);
      return a.value === null ? '<span class="muted">未提供</span>' : '<span class="num">' + esc(L.fmtMoney(a.value)) + '</span>' +
        '<div class="muted" style="font-size:11px">' + esc(a.source || '') + (a.conflict ? '　' + esc(a.conflict) : '') + '</div>';
    })() + '</dd>' +
    '<dt>原始文件名</dt><dd>' + dash(rec.source_file) + '</dd>' +
    '<dt>解析状态</dt><dd>' + dash(rec.parse_status) + '</dd>' +
    '<dt>内容更新时间</dt><dd class="num">' + dash(rec.updated_at ? String(rec.updated_at).replace('T', ' ').slice(0, 19) : null) + '</dd>' +
    '<dt>追踪标识</dt><dd class="muted" style="font-size:11.5px;word-break:break-all">' +
    '解析任务 ' + dash(rec.xparse_task_id) + '<br>解析运行 ' + dash(rec.xparse_run_id) + '<br>文件哈希 ' + dash(rec.file_hash) + '</dd>' +
    '</dl><div id="docMsg"></div>' + recHistoryHtml(rec) +
    structActionHtml(rec) + docDangerHtml(rec) + '</div></div>';

  var info = nz(rec.key_information) ? String(rec.key_information).split('\n').filter(function (s) { return s.trim(); }) : [];
  if (info.length) {
    h += '<div class="card"><div class="card-h"><h3>关键原文信息</h3><span class="sub">保留原文含义</span></div><div class="card-b">' +
      info.map(function (s) { return '<div class="src-block">' + esc(s) + '</div>'; }).join('') + '</div></div>';
  }

  h += renderTypeSpecific(rec);
  h += '</div></div>';
  body.innerHTML = h;

  bindDocViewer(rec);
  qsa('#docBody [data-src-doc]').forEach(function (b) {
    b.onclick = function () { openDoc(b.dataset.srcDoc, S.indCtx ? '指标详情' : S.docFrom); };
  });
  var so = $('btnStructOpen');
  if (so) so.onclick = function () { openStructDrawer(rec.id); };

  var pe = qsa('#docBody select[data-role="person"]')[0];
  if (pe) pe.onchange = function () { reassignOne(rec.id, pe.value); };
  /* 一键确认日期：只把日期状态抬成「已确认」，日期与其它字段一概不动。
     解析器猜出来的日期 + 待确认，用户核对无误后点这里就行，
     不用再进编辑抽屉把日期重新敲一遍。 */
  var cd = $('btnConfirmDate');
  if (cd) cd.onclick = async function () {
    cd.disabled = true;
    var res = await applyRecordEdit(rec.id, { date_status: L.DATE_STATUS.CONFIRMED },
      { note: { date_status: '在档案详情页一键确认了报告日期，这份档案开始参与指标趋势与年度统计' } });
    if (!res.ok) setDocMsg('确认失败：' + res.reason, true);
  };
  var re = $('btnRecEdit');
  if (re) re.onclick = function () { openRecEditDrawer(findHealthRecord(rec.id) || rec); };
  var rb = $('recEditBadge');
  if (rb) rb.onclick = function () {
    DOC_UI.showHistory = !DOC_UI.showHistory;
    renderDocBody(findHealthRecord(rec.id) || rec);
  };
  bindCellEditing(rec);
  var dd = $('btnDocDel');
  if (dd) dd.onclick = function () { DOC_UI.pendingDel = String(rec.id); renderDocBody(rec); };
  var dc = $('btnDocDelCancel');
  if (dc) dc.onclick = function () { DOC_UI.pendingDel = null; renderDocBody(rec); };
  var df = $('btnDocDelConfirm');
  if (df) df.onclick = function () { deleteOneRecord(rec.id, 'doc'); };
}

/* 详情页的归属成员：可以直接改派。
   成员管理页的批量归属只动「未指定」的档案，已经归错人的此前没有入口。 */
function personEditHtml(rec) {
  var cur = (rec.person_id === null || rec.person_id === undefined || rec.person_id === '')
    ? '' : String(rec.person_id);
  var opts = '<option value="">未指定</option>' + S.persons.map(function (p) {
    return '<option value="' + attr(String(p.id)) + '"' + (String(p.id) === cur ? ' selected' : '') +
      '>' + esc(p.name) + '</option>';
  }).join('');
  // 名单里查不到这个 id（成员被删过）时把原值留着，不静默改成「未指定」掩盖掉
  if (cur && !S.persons.some(function (p) { return String(p.id) === cur; })) {
    opts = '<option value="' + attr(cur) + '" selected>' + esc('成员 #' + cur + '（已不在名单）') +
      '</option>' + opts;
  }
  return '<select data-role="person">' + opts + '</select>' +
    '<div class="muted" style="font-size:11px;margin-top:4px">改派只动这一份档案，改完立即生效，可以随时改回去。</div>';
}

var DOC_UI = { pendingDel: null, showHistory: false, editing: null, cellMsg: '' };

// 删除按钮。数据驱动不支持连带清理附件时干脆不给入口，不给「点了说成功、文件还在」的假能力。
function docDangerHtml(rec) {
  if (!cloud.hasDeleteRecords()) return '';
  var id = String(rec.id);
  var n = attachmentsOf(rec).length;
  var h = '<div style="border-top:1px solid #eef1f5;margin-top:12px;padding-top:10px">';
  if (DOC_UI.pendingDel === id) {
    h += '<div class="err-bar" style="margin:8px 0">删除会把这份档案连同它名下的 ' + n +
      ' 个原始文件一起从本机移除；被其他档案共用的文件会保留。' +
      '删除前自动打快照，删错了可以在「上传资料」页用快照整库回退。</div>' +
      '<button class="btn sm danger" id="btnDocDelConfirm">确认删除这份档案</button>' +
      '<button class="btn sm ghost" id="btnDocDelCancel">取消</button>';
  } else {
    h += '<button class="btn sm danger" id="btnDocDel">删除此档案</button>';
  }
  return h + '</div>';
}

function setDocMsg(text, isErr) {
  var m = $('docMsg');
  if (!m) return;
  m.innerHTML = text
    ? '<div class="' + (isErr ? 'err-bar' : 'note') + '" style="margin:8px 0 0">' + esc(text) + '</div>'
    : '';
}

/* ---------------- 15.5 手工编辑与留痕 ---------------- */

/* 单条档案的所有人工修改都从这一个入口出去：算留痕 → 写库 → 回读 → 刷新。
   多一条旁路就多一处会漏留痕、漏 invalidate 的地方（D14 就是这么来的）。 */
async function applyRecordEdit(id, patch, opts) {
  opts = opts || {};
  var prev = findHealthRecord(id);
  if (!prev) return { ok: false, reason: '没找到这条记录，可能已被删除' };
  var next = L.applyEditWithHistory(prev, patch, {
    at: opts.at || new Date().toISOString(), note: opts.note
  });
  var body = {};
  Object.keys(patch).forEach(function (k) { body[k] = next[k]; });
  if (next.manual_edits) body.manual_edits = next.manual_edits;
  if (!Object.keys(body).length) return { ok: true, changed: 0, record: prev };

  var res = await cloud.database.from('documents').update(body).eq('id', Number(id)).select();
  if (res.error || !res.data || !res.data.length) {
    return { ok: false, reason: res.error ? res.error.message : '写入没有命中任何记录，数据没有改变' };
  }
  var added = L.editsOf(next).length - L.editsOf(prev).length;
  await loadTable('documents', 'primary_date');
  await refreshPersons();
  await refreshLocalStats();
  var back = findHealthRecord(id);
  if (!back) return { ok: false, reason: '写入已返回，但回读不到这条记录，请刷新后核对' };
  if (!opts.quiet) {
    renderCurrent();
    if (S.layerStack.indexOf('docLayer') >= 0) renderDocBody(back);
  }
  return { ok: true, changed: added, record: back };
}

// 卡片头部：编辑入口 + 「改过几处」徽标
function recEditEntryHtml(rec) {
  var s = L.editSummary(rec);
  var h = '<span class="card-acts"><button class="btn sm ghost" id="btnRecEdit">编辑</button>';
  if (s.count) h += '<button class="badge-edit" id="recEditBadge">已人工更正 ' + s.count + ' 处</button>';
  return h + '</span>';
}

function recHistoryHtml(rec) {
  var list = L.editsOf(rec);
  if (!list.length || !DOC_UI.showHistory) return '';
  var rows = list.map(function (e) {
    var label = e.label || L.editLabel(e.target) || e.target;
    if (e.row_name && label.indexOf(e.row_name) < 0) label += '（' + e.row_name + '）';
    return '<tr><td>' + esc(label) + '</td><td>' + dash(e.from) + '</td><td>' + dash(e.to) +
      '</td><td class="muted" style="font-size:11px">' +
      esc(String(e.at || '').replace('T', ' ').slice(0, 16)) + '</td></tr>' +
      (e.note ? '<tr><td colspan="4" class="muted" style="font-size:11px">' + esc(e.note) + '</td></tr>' : '');
  }).join('');
  return '<div id="recEditHistory" style="margin-top:10px">' +
    '<div class="note" style="margin:0 0 6px">下面这些值是人工改的，不是从原件解析出来的。' +
    '「原件上的值」一列保留改动前的内容，便于日后核对为什么与报告不一致。</div>' +
    '<table class="tbl"><thead><tr><th>字段</th><th>原件上的值</th><th>改成</th><th>时间</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

function recEditField(id, label, input, hint) {
  return '<div class="field"><label>' + esc(label) + '</label>' + input +
    (hint ? '<div class="hint" id="' + id + 'Hint">' + hint + '</div>' : '') + '</div>';
}

function openRecEditDrawer(rec) {
  var tsd = (rec.type_specific_data && typeof rec.type_specific_data === 'object') ? rec.type_specific_data : {};
  var num = function (v) { return (v === null || v === undefined) ? '' : String(v); };
  var h = '<div class="note">这里改的是这一条档案本身。改过的地方会留下「原来是什么、什么时候改的」，' +
    '在详情页点「已人工更正」就能核对；原始文件与解析原文不受影响。</div>';
  h += recEditField('reTitle', '标题', '<input type="text" id="reTitle" value="' + attr(nz(rec.title)) + '">');
  h += '<div class="field"><label>文档类型</label><select id="reType">' + docTypeOptions(rec.document_type) +
    '</select><div class="hint">类型决定它出现在哪个筛选下，也决定资料类型分布里计到哪一档。</div></div>';
  h += recEditField('reDate', '主要日期',
    '<input type="date" id="reDate" value="' + attr(nz(rec.primary_date)) + '">',
    '填一个真实存在的日期，这份档案就会进入指标趋势、年度活动与年度费用统计；' +
    '不确定就留空 —— 留空的归到「日期待确认」，只看得见、不参与连线。');
  h += '<div class="field"><label>日期状态</label>' +
    '<label style="display:flex;gap:8px;align-items:center;font-size:13px">' +
    '<input type="checkbox" id="reDateConfirmed"' + (L.isDatePending(rec) ? '' : ' checked') + '>' +
    '日期已核实，按「已确认」处理</label>' +
    '<div class="hint">解析读到了日期会直接按「已确认」处理，不需要再手动确认。' +
    '只有原文没有日期（或你手动清掉日期）的档案才是「待确认」——补上日期并核对无误就勾上。</div></div>';
  h += recEditField('reHospital', '医院', '<input type="text" id="reHospital" value="' + attr(nz(rec.hospital)) + '">');
  h += recEditField('reDept', '科室', '<input type="text" id="reDept" value="' + attr(nz(rec.department)) + '">');
  h += recEditField('reDoctor', '医生', '<input type="text" id="reDoctor" value="' + attr(nz(rec.doctor)) + '">');
  h += recEditField('reAmount', '金额（元）',
    '<input type="number" step="0.01" id="reAmount" value="' + attr(num(rec.amount)) + '">',
    '这条档案的金额。下一格是票据结构化结果里的总额，两处不一致时详情页会标「待核对」，不替你选一个。');
  h += recEditField('reTsAmount', '结构化总金额（元）',
    '<input type="number" step="0.01" id="reTsAmount" value="' + attr(num(tsd.total_amount)) + '">');
  h += recEditField('reSourceFile', '原始文件名',
    '<input type="text" id="reSourceFile" value="' + attr(nz(rec.source_file)) + '">',
    '改的只是档案上记的那个名字，不会动磁盘上的原始文件。');
  h += '<div class="field"><label>解析状态</label><select id="reParseStatus">' +
    ['已归档', '已解析待结构化'].map(function (s) {
      return '<option value="' + attr(s) + '"' + (rec.parse_status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('') + '</select><div class="hint">这是个状态标签：改成「已归档」不会替你补出检验项与收费明细，' +
    '字段还得自己填或走智能结构化。</div></div>';
  h += recEditField('reKeyInfo', '关键原文信息',
    '<textarea id="reKeyInfo" rows="4">' + esc(nz(rec.key_information)) + '</textarea>',
    '一行一条，保留原文说法，不做归一化。');
  h += '<div class="note">主键、文件哈希、解析任务号 / 运行号与更新时间<b>只读、不可修改</b>：' +
    '哈希用来识别同一份原件被重复归档，任务号是解析溯源，时间戳由系统在每次写入时自己记。</div>';
  $('receditBody').innerHTML = h;
  openDrawer('drawer-recedit');
  $('btnRecEditSave').onclick = function () { doRecEditSave(rec); };
}

async function doRecEditSave(rec) {
  var id = rec.id;
  var prev = findHealthRecord(id) || rec;
  var tsdPrev = (prev.type_specific_data && typeof prev.type_specific_data === 'object') ? prev.type_specific_data : {};
  var v = function (i) { var e = $(i); return e ? e.value.trim() : ''; };
  var patch = {
    title: v('reTitle') || null,
    document_type: v('reType') || '其他医疗资料',
    hospital: v('reHospital') || null,
    department: v('reDept') || null,
    doctor: v('reDoctor') || null,
    amount: v('reAmount') === '' ? null : v('reAmount'),
    source_file: v('reSourceFile') || null,
    parse_status: v('reParseStatus') || null,
    key_information: v('reKeyInfo') || null
  };
  var date = v('reDate');
  patch.primary_date = date || null;
  var note = {};
  /* 日期状态的升降级只在这三种情况发生：
     ① 清空 / 填坏日期 → 降级待确认；② 日期本身被改成新的合法值 → 升级已确认；
     ③ 用户显式动了「日期已核实」勾选框 → 按勾选结果走。
     日期没变、勾选也没动时原样保留 —— 既不提拔也不降级，
     否则"重新敲一遍相同的日期想确认"会静默失败（以前就是这样）。 */
  var wasConfirmed = !L.isDatePending(prev);
  var confirmedBox = $('reDateConfirmed') ? $('reDateConfirmed').checked : wasConfirmed;
  var dateChanged = (nz(prev.primary_date) || '') !== (date || '');
  if (!date) {
    patch.date_status = L.DATE_STATUS.PENDING;
    note.primary_date = '清空了日期，这份档案归入「日期待确认」，不再参与趋势与年度统计';
  } else if (date && !L.isValidDate(date)) {
    patch.date_status = L.DATE_STATUS.PENDING;
    note.primary_date = '填的日期不存在或不合法，按「日期待确认」处理，不参与趋势连线';
  } else if (dateChanged) {
    patch.date_status = L.DATE_STATUS.CONFIRMED;
    note.primary_date = '人工填写了合法日期，日期状态同步置为「已确认」，这份档案开始参与趋势与年度统计';
  } else if (confirmedBox !== wasConfirmed) {
    patch.date_status = confirmedBox ? L.DATE_STATUS.CONFIRMED : L.DATE_STATUS.PENDING;
    note.date_status = confirmedBox
      ? '人工确认了报告日期，这份档案开始参与趋势与年度统计'
      : '取消了日期确认，这份档案回到「日期待确认」，趋势里会重新打上待确认标记';
  }
  // 日期没变、勾选状态也没变 → 不写 date_status，保持现状
  var tsAmt = v('reTsAmount') === '' ? null : v('reTsAmount');
  if (!L.sameEditValue(tsAmt, tsdPrev.total_amount)) {
    patch.type_specific_data = L.tsSetCopy(tsdPrev, 'type_specific_data.total_amount', tsAmt);
  }

  var res = await applyRecordEdit(id, patch, { note: note });
  closeDrawers();
  if (!res.ok) { setDocMsg('保存失败：' + res.reason, true); return; }
  setDocMsg(res.changed ? '已保存，本次记录 ' + res.changed + ' 处人工修改（点「已人工更正」可核对原值）。'
    : '已保存。这次没有字段发生变化，没有新增留痕。');
}

// 数字列才用 number 输入框，其余一律 text：结果这一列本来就容得下定性文字
// （「阴性」「未见异常」），套 number 会把它们吞成空，等于制造新的读不出来。
var TS_NUMBER_COLS = { amount: 1, qty: 1, unit_price: 1, height_cm: 1, weight_kg: 1, bmi: 1,
  systolic_mmHg: 1, diastolic_mmHg: 1, pulse_bpm: 1 };
// 这几列在数据里是「一行一项」的数组，不能用单行 input 压成字符串：
// 渲染处按数组判断，写成字符串会被认成「原报告未提供」。
var TS_ARRAY_COLS = { findings: 1, impression: 1, final_conclusion: 1 };

function tsColOf(target) { return String(target).split('.').pop(); }

function tsCellValue(rec, target) {
  var t = L.parseEditTarget(target);
  var v = t ? L.editValueAt(rec, t) : undefined;
  if (v === undefined || v === null) return '';
  return Array.isArray(v) ? v.join('\n') : String(v);
}

function tsMarkHtml(rec, target) {
  var e = L.editedCells(rec)[target];
  if (!e) return '';
  var flat = function (v) { return Array.isArray(v) ? v.join(' / ') : v; };
  var from = (e.from === null || e.from === undefined || e.from === '') ? '空' : flat(e.from);
  var tip = '人工更正：原件上是 ' + from + '，' + String(e.at || '').slice(0, 10) + ' 改成 ' + flat(e.to);
  // title 只有悬停才读得到 —— 触屏与读屏需要 aria-label 才不丢这条"这里被人工改过"的事实
  return ' <span class="ts-mark" data-ts-target="' + attr(target) + '" aria-label="' + attr(tip) +
    '" title="' + attr(tip) + '">改</span>';
}

// 编辑器外壳三处共用（单元格 / 数组列 / 结论）。输入框本身交回调用方拼，
// 值一律预填当前内容 —— 空框会让人以为原件就没有这一项。
function tsEditorTail() {
  return '<button class="btn sm primary" id="tsInputSave">保存</button>' +
    '<button class="btn sm ghost" id="tsInputCancel">取消</button>' +
    '<div id="tsInputMsg" class="muted" style="font-size:11px;margin-top:4px"></div>';
}

function tsEditorHtml(rec, target) {
  return '<input type="' + (TS_NUMBER_COLS[tsColOf(target)] ? 'number' : 'text') +
    '" step="any" id="tsInput" class="ts-input" value="' + attr(tsCellValue(rec, target)) + '">' +
    tsEditorTail();
}

function tsCell(rec, target, value, opts) {
  opts = opts || {};
  var editing = DOC_UI.editing === target;
  // opts.html：值已经是转义好的片段（箭头标记、加粗），不能再 esc 一遍
  var shown = opts.html
    ? (value || '<span class="muted">未提供</span>')
    : (value === '' || value === null || value === undefined
        ? '<span class="muted">未提供</span>' : esc(String(value)));
  return '<td class="ts-cell' + (editing ? ' editing' : '') + (opts.cls ? ' ' + opts.cls : '') + '">' +
    (editing ? tsEditorHtml(rec, target)
      : shown + tsMarkHtml(rec, target) +
        (opts.noEdit ? '' : ' <button class="ts-edit" data-ts-open="' + attr(target) + '">改此格</button>')) +
    '</td>';
}

// 明细里的标量值：空值统一显示成「未提供」，且仍可编辑（不让人没有地方补录）
function tsdScalarHtml(v) {
  return (v === undefined || v === null || v === '') ? '<span class="muted">未提供</span>' : esc(String(v));
}

// 表格里之外的位置（检查所见这种 <dd>、收费单的 <dl>、结论列表）也一律走它：
// 正在编辑时换成输入控件，否则显示原值 + 留痕标记 + 编辑入口。
function tsInline(rec, target, valueHtml, label) {
  if (DOC_UI.editing === target) {
    return TS_ARRAY_COLS[tsColOf(target)]
      ? '<textarea id="tsInput" class="ts-input" rows="4">' + esc(tsCellValue(rec, target)) + '</textarea>' + tsEditorTail()
      : tsEditorHtml(rec, target);
  }
  return valueHtml + tsMarkHtml(rec, target) +
    ' <button class="ts-edit" data-ts-open="' + attr(target) + '">' + esc('改' + (label || '内容')) + '</button>';
}

async function saveCellEdit(rec, target, raw) {
  var tsd = (rec.type_specific_data && typeof rec.type_specific_data === 'object') ? rec.type_specific_data : {};
  var col = tsColOf(target);
  var value;
  if (TS_ARRAY_COLS[col]) {
    value = String(raw).split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  } else {
    var v2 = String(raw).trim();
    value = v2 === '' ? null : v2;
  }
  DOC_UI.editing = null;
  var res = await applyRecordEdit(rec.id, { type_specific_data: L.tsSetCopy(tsd, target, value) });
  if (!res.ok) DOC_UI.cellMsg = '保存失败：' + res.reason;
}

function bindCellEditing(rec) {
  qsa('#docBody [data-ts-open]').forEach(function (b) {
    b.onclick = function () {
      DOC_UI.editing = b.dataset.tsOpen;
      DOC_UI.cellMsg = '';
      renderDocBody(findHealthRecord(rec.id) || rec);
      var el = $('tsInput');
      if (el) el.focus();
    };
  });
  var save = $('tsInputSave'), cancel = $('tsInputCancel'), inp = $('tsInput'), msg = $('tsInputMsg');
  if (save) save.onclick = function () {
    if (!inp) return;
    if (TS_NUMBER_COLS[tsColOf(DOC_UI.editing)] && inp.value.trim() !== '' && !isFinite(Number(inp.value))) {
      if (msg) msg.textContent = '这一列要的是数字；要写文字请清空后换到结果或说明那列。';
      return;
    }
    saveCellEdit(rec, DOC_UI.editing, inp.value);
  };
  if (cancel) cancel.onclick = function () {
    DOC_UI.editing = null;
    renderDocBody(findHealthRecord(rec.id) || rec);
  };
  if (inp) inp.onkeydown = function (e) {
    if (e.key === 'Escape') { e.preventDefault(); if (cancel) cancel.click(); }
    // 多行框里回车是换行，只有单行输入框才把回车当保存
    if (e.key === 'Enter' && inp.tagName !== 'TEXTAREA') { e.preventDefault(); if (save) save.click(); }
  };
  if (msg && DOC_UI.cellMsg) { msg.textContent = DOC_UI.cellMsg; DOC_UI.cellMsg = ''; }
}
async function reassignOne(id, value) {
  var pid = value === '' ? null : Number(value);
  var res = await applyRecordEdit(id, { person_id: pid });
  if (!res.ok) { setDocMsg('改派失败：' + res.reason, true); return; }
  setDocMsg(pid === null ? '已把这份档案改回「未指定」。'
    : '这份档案现在归给「' + (personNameOf(pid) || pid) + '」。');
  if (S.view === 'archive') renderArchive();
  else if (S.view === 'persons') renderPersons();
}

// 详情页的结构化入口。只有真的存在解析原文时才出现，
// 不给一个点下去必然失败的按钮。
function structActionHtml(rec) {
  var text = String(rec.parsed_content || '');
  if (!text.trim()) {
    if (rec.parse_status === '已解析待结构化') {
      return '<div class="err-bar" style="margin:12px 0 0">解析状态是「已解析待结构化」，' +
        '但正文是空的。请重新上传原件解析一次。</div>';
    }
    return '';
  }
  var tsd = rec.type_specific_data || {};
  var done = !!tsd.structured;
  return '<div style="border-top:1px solid #eef1f5;margin-top:12px;padding-top:10px">' +
    '<div class="note" style="margin:0 0 8px">解析原文 ' + text.length + ' 字' +
    (done ? '，已结构化（' + esc(String(tsd.structured_by || '未知')) + '）' : '，尚未结构化') + '。</div>' +
    '<button class="btn' + (done ? '' : ' primary') + '" id="btnStructOpen">' +
    (done ? '重新结构化' : '智能结构化') + '</button>' +
    '<div class="muted" style="font-size:11.5px;margin-top:6px;line-height:1.7">' +
    '由模型把原文拆成检验项、收费明细等字段。原文没有的字段留空，不推测；结果需你确认后才写入。' +
    '没配置密钥也能用 —— 抽屉里可以复制提示词给任意大模型，再把返回的 JSON 贴回来。</div></div>';
}

function viewerHtml(rec, atts, pfx) {
  pfx = pfx || 'doc';
  if (!atts.length) {
    return '<div class="stage"><div style="text-align:center">' +
      '<div style="color:#c8d2de;font-size:12.5px">原始文件未留存</div>' +
      '<div style="font-size:11.5px;margin-top:7px;color:#93a1b1;line-height:1.7">' +
      '这条记录写入时没有附带原始文件。<br>可以在这里补传，补传后同一份档案的附件与正文会一起更新，不会新增重复档案。</div>' +
      '<div style="margin-top:12px"><label class="btn sm" style="cursor:pointer">选择原始文件' +
      '<input type="file" id="' + pfx + 'Attach" multiple style="display:none"></label></div>' +
      '<div id="' + pfx + 'AttachMsg" style="font-size:11.5px;margin-top:9px;color:#93a1b1"></div>' +
      '</div></div>';
  }
  return '<div class="stage" id="' + pfx + 'Stage"><div style="text-align:center;color:#93a1b1;font-size:12.5px">正在取得短时授权地址…</div></div>' +
    '<div class="thumbs" id="' + pfx + 'Thumbs">' + atts.map(function (a, i) {
      return '<button class="th' + (i === 0 ? ' on' : '') + '" data-att="' + i + '" title="' + attr(a.name) + '">' +
        '<span class="num">' + (i + 1) + '</span></button>';
    }).join('') + '</div>' +
    '<div class="viewer-bar">' +
    '<button class="btn sm" id="' + pfx + 'OpenNew">新窗口查看原文件</button>' +
    '<button class="btn sm" id="' + pfx + 'Download">下载原文件</button>' +
    '<span class="muted" id="' + pfx + 'AttName" style="font-size:11.5px;align-self:center"></span></div>';
}

// 附件读写统一走 pfx，避免多个详情层同时存在时 ID 冲突
async function bindDocViewer(rec, pfx) {
  pfx = pfx || 'doc';
  var atts = attachmentsOf(rec);
  var attachInput = $(pfx + 'Attach');
  if (attachInput && rec.document_type && rec.document_type !== '药品资料') {
    attachInput.onchange = async function () {
      var files = Array.prototype.slice.call(attachInput.files);
      if (!files.length) return;
      var m = $(pfx + 'AttachMsg');
      m.textContent = '正在上传…';
      try {
        var added = [];
        for (var i = 0; i < files.length; i++) added.push(await uploadOriginal(files[i]));
        var next = attachmentsOf(rec).concat(added);
        var res = await cloud.database.from('documents')
          .update({ source_attachments: next }).eq('id', rec.id).select();
        if (res.error || !res.data || !res.data.length) throw new Error(res.error ? res.error.message : '该记录不在你的权限范围内');
        await loadTable('documents', 'primary_date');
        var back = bucket('documents').rows.filter(function (r) { return String(r.id) === String(rec.id); })[0];
        m.textContent = '已补传 ' + (back ? attachmentsOf(back).length : next.length) + ' 个附件，同一份档案已更新，未新增重复记录。';
        if (back) { renderDocBody(back); bindDocViewer(back, 'doc'); }
      } catch (e) {
        m.textContent = '补传失败：' + (e.message || '未知错误') + '。原状态未改变。';
      }
    };
  }
  if (!atts.length) return;

  async function show(i) {
    var a = atts[i];
    var stage = $(pfx + 'Stage');
    if (!stage) return;
    qsa('#' + pfx + 'Thumbs .th').forEach(function (t, ti) { t.classList.toggle('on', ti === i); });
    var nameEl = $(pfx + 'AttName');
    if (nameEl) nameEl.textContent = a.name || '';
    stage.innerHTML = '<div style="text-align:center;color:#93a1b1;font-size:12.5px">正在取得短时授权地址…</div>';
    var url = await signedUrl(a.path);
    if (!url) {
      stage.innerHTML = '<div style="text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8">' +
        '无法取得该附件的授权地址。<br><span style="font-size:11.5px;color:#93a1b1">' +
        '文件可能已被清理，或当前登录用户不是它的所有者。授权地址是短时凭据，过期后重新点击缩略图即可再取得。<br>' +
        '记录里的结构化结果不受影响，仍可正常查看。</span></div>';
      return;
    }
    var mime = String(a.mime_type || '');
    var name = String(a.name || '');
    if (/^image\//.test(mime) || /\.(jpe?g|png|bmp|tiff?|webp)$/i.test(name)) {
      stage.innerHTML = '<img alt="' + attr(a.name || '原始文件') + '" src="' + attr(url) + '">';
      var img = stage.querySelector('img');
      img.onerror = function () {
        stage.innerHTML = '<div style="text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8">图片加载失败。' +
          '<br><span style="font-size:11.5px;color:#93a1b1">可能是授权地址已过期或文件已被移除。可重新点击缩略图再取得地址。</span></div>';
      };
    } else if (/pdf/i.test(mime) || /\.pdf$/i.test(name)) {
      stage.innerHTML = '<iframe title="PDF 原始文件" src="' + attr(url) + '#view=FitH"></iframe>' +
        '<div class="note" style="color:#93a1b1;margin-top:8px;font-size:11.5px">PDF 按浏览器实际能力预览；若上方空白，请使用「新窗口查看原文件」。</div>';
    } else {
      // 解析链路不支持 Word / Excel / PPT，这类文件只能作为原始附件留存
      stage.innerHTML = '<div style="text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8">' +
        '该类型没有可用的内嵌预览。<br><span style="font-size:11.5px;color:#93a1b1">' +
        'Word / Excel / PPT 类文件请用下方「下载原文件」在本机打开。</span></div>';
    }
    var on = $(pfx + 'OpenNew');
    if (on) on.onclick = function () { window.open(url, '_blank', 'noopener'); };
    var dl = $(pfx + 'Download');
    if (dl) dl.onclick = function () { var a2 = document.createElement('a'); a2.href = url; a2.download = a.name || 'attachment'; a2.click(); };
  }

  qsa('#' + pfx + 'Thumbs .th').forEach(function (t) {
    t.onclick = function () { show(+t.dataset.att); };
  });
  show(0);
}

function renderTypeSpecific(rec) {
  var tsd = rec.type_specific_data || {};
  if (typeof tsd === 'string') { try { tsd = JSON.parse(tsd); } catch (e) { tsd = {}; } }
  var t = L.normalizeDocType(rec.document_type);
  var h = '';

  var labs = Array.isArray(tsd.lab_results) ? tsd.lab_results : [];
  var exams = Array.isArray(tsd.exams) ? tsd.exams : [];

  // 一般检查（体检报告等复合结构）
  if (tsd.general_exam && typeof tsd.general_exam === 'object') {
    var ge = tsd.general_exam;
    var geCols = L.EDIT_TABLES.general_exam.cols;
    // 空值也列出来：原件上没印出来不等于这条档案不该有这个字段，
    // 隐藏起来会让人没有地方补录。
    var geKeys = Object.keys(geCols).filter(function (k) {
      return ge[k] !== undefined && ge[k] !== null;
    });
    h += '<div class="card"><div class="card-h"><h3>一般检查</h3><span class="sub">原文照录，可逐项更正</span></div><div class="card-b">' +
      '<dl class="kv" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr)">' +
      geKeys.map(function (k) {
        return '<dt>' + esc(geCols[k]) + '</dt><dd>' +
          tsInline(rec, 'general_exam.' + k,
            nz(ge[k]) ? '<span class="num">' + esc(ge[k]) + '</span>' : '<span class="muted">未提供</span>', geCols[k]) +
          '</dd>';
      }).join('') + '</dl></div></div>';
  }

  // 检验结果：主体必须是逐项表格
  if (labs.length) {
    var panels = {};
    labs.forEach(function (r) { var p = r.panel || '未分组'; (panels[p] = panels[p] || []).push(r); });
    h += '<div class="card"><div class="card-h"><h3>检验结果 <span class="sub">共 ' + labs.length + ' 项</span></h3>' +
      '<span class="sub">项目｜结果｜单位｜原参考范围｜原报告提示</span></div><div class="card-b">';
    Object.keys(panels).forEach(function (p) {
      h += '<div class="sec-t">' + esc(p) + '</div><div class="tbl-scroll"><table class="res-tbl"><thead><tr>' +
        '<th>项目</th><th>结果</th><th>单位</th><th>原参考范围</th><th>原报告提示</th></tr></thead><tbody>' +
        panels[p].map(function (r) {
          // 表格按分组重排过，留痕与编辑必须认原始下标，否则改的是另一行
          var i = labs.indexOf(r);
          var flag = nz(r.flag);
          var rendered = (flag && /^[\u2191\u2193]$/.test(String(flag).trim())) ? String(flag).trim()
            : (flag ? esc(flag) + ' <span class="muted" style="font-size:11px">（原文标记，识别不清时保留原样）</span>' : '');
          return '<tr>' + tsCell(rec, 'lab_results.' + i + '.name', r.name) +
            tsCell(rec, 'lab_results.' + i + '.result',
              (r.result === null || r.result === undefined || r.result === '')
                ? null : '<b>' + esc(r.result) + '</b>', { cls: 'num', html: true }) +
            (r.condition ? '<td class="muted" style="font-size:11px">' +
              tsInline(rec, 'lab_results.' + i + '.condition', esc(r.condition), '测量条件') + '</td>' : '') +
            tsCell(rec, 'lab_results.' + i + '.unit', r.unit || '', { cls: 'muted' }) +
            tsCell(rec, 'lab_results.' + i + '.reference', r.reference || '', { cls: 'ref' }) +
            tsCell(rec, 'lab_results.' + i + '.flag', rendered || null, { cls: 'flag', html: true }) + '</tr>';
        }).join('') + '</tbody></table></div>';
    });
    h += '<div class="note">本表按原报告逐项照录。结果与参考范围之间的大小关系不会被系统转成异常 / 正常标签；原报告未印出的箭头不会出现。' +
      '读错了的可以直接改这一格，改过的会留下原件上的原值。</div>';
    h += '</div></div>';
  }

  // 检查所见与报告意见
  if (exams.length) {
    h += '<div class="card"><div class="card-h"><h3>检查所见与报告意见</h3><span class="sub">共 ' + exams.length + ' 项</span></div><div class="card-b">';
    exams.forEach(function (e) {
      var xi = exams.indexOf(e);
      var blocks = function (arr) {
        return Array.isArray(arr) && arr.length
          ? arr.map(function (f) { return '<div class="src-block">' + esc(f) + '</div>'; }).join('')
          : '<span class="muted">原报告未提供</span>';
      };
      h += '<div style="margin-bottom:16px"><div class="sec-t">' +
        tsInline(rec, 'exams.' + xi + '.exam_name', esc(e.exam_name || '检查项目'), '名称') + '</div>' +
        '<dl class="kv" style="grid-template-columns:82px minmax(0,1fr)">' +
        '<dt>检查方法</dt><dd>' + tsInline(rec, 'exams.' + xi + '.exam_method', dash(e.exam_method), '检查方法') + '</dd>' +
        '<dt>临床资料</dt><dd>' + tsInline(rec, 'exams.' + xi + '.clinical_info', dash(e.clinical_info), '临床资料') + '</dd>' +
        '<dt>检查所见</dt><dd>' + tsInline(rec, 'exams.' + xi + '.findings', blocks(e.findings), '检查所见') + '</dd>' +
        '<dt>报告意见</dt><dd>' + tsInline(rec, 'exams.' + xi + '.impression', blocks(e.impression), '报告意见') + '</dd>' +
        (e.source_note ? '<dt></dt><dd class="muted" style="font-size:11.5px">' +
          tsInline(rec, 'exams.' + xi + '.source_note', esc(e.source_note), '来源说明') + '</dd>' : '') +
        '</dl></div>';
    });
    h += '</div></div>';
  }

  // 收费明细
  var items = Array.isArray(tsd.charge_items) ? tsd.charge_items : [];
  if (t === '医疗发票/收费单' || items.length || tsd.total_amount !== undefined) {
    h += '<div class="card"><div class="card-h"><h3>收费明细</h3><span class="sub">仅录入原文明确存在的内容</span></div><div class="card-b">';
    if (items.length) {
      h += '<div class="tbl-scroll"><table class="res-tbl"><thead><tr>' +
        '<th>收费项目</th><th>单价</th><th>数量</th><th>金额</th><th>医保类别</th></tr></thead><tbody>' +
        items.map(function (i) {
          var ii = items.indexOf(i);
          return '<tr>' + tsCell(rec, 'charge_items.' + ii + '.name', i.name || i.item || '') +
            tsCell(rec, 'charge_items.' + ii + '.unit_price', i.unit_price, { cls: 'num' }) +
            tsCell(rec, 'charge_items.' + ii + '.qty', i.qty, { cls: 'num' }) +
            tsCell(rec, 'charge_items.' + ii + '.amount', i.amount, { cls: 'num' }) +
            tsCell(rec, 'charge_items.' + ii + '.insurance_type', i.insurance_type, { cls: 'muted' }) + '</tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      h += '<div class="note" style="margin:0">原资料没有逐项收费明细；这不影响保留明确的总额与支付拆分。</div>';
    }
    h += '<dl class="kv" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr);margin-top:13px">' +
      '<dt>总金额</dt><dd>' + (function () { var a = L.receiptAmount(rec); return a.value === null ? '<span class="muted">未提供</span>' : L.fmtMoney(a.value); })() + '</dd>' +
      '<dt>医保支付</dt><dd>' + tsInline(rec, 'type_specific_data.insurance_payment',
        tsdScalarHtml(tsd.insurance_payment), '医保支付') + '</dd>' +
      '<dt>个人支付</dt><dd>' + tsInline(rec, 'type_specific_data.self_payment',
        tsdScalarHtml(tsd.self_payment), '个人支付') + '</dd>' +
      '<dt>大写金额</dt><dd>' + tsInline(rec, 'type_specific_data.amount_in_words',
        dash(tsd.amount_in_words), '大写金额') + '</dd>' +
      '<dt>结算时间</dt><dd>' + tsInline(rec, 'type_specific_data.settle_time',
        dash(tsd.settle_time), '结算时间') + '</dd>' +
      '<dt>支付方式</dt><dd>' + tsInline(rec, 'type_specific_data.payment_method',
        dash(tsd.payment_method), '支付方式') + '</dd>' +
      '</dl>';
    h += '<div class="note">收费单只能说明收费项目和金额，不能据此推断确诊疾病、检查所见、治疗实施或服药事实。</div>';
    h += '</div></div>';
  }

  // 原报告结论（原文照录）
  if (Array.isArray(tsd.final_conclusion) && tsd.final_conclusion.length) {
    h += '<div class="card"><div class="card-h"><h3>原报告结论</h3><span class="sub">原文照录，非系统判断</span></div><div class="card-b">' +
      tsInline(rec, 'type_specific_data.final_conclusion',
        tsd.final_conclusion.map(function (c) { return '<div class="src-block">' + esc(c) + '</div>'; }).join(''),
        '结论') +
      (tsd.conclusion_note ? '<div class="note">' +
        tsInline(rec, 'type_specific_data.conclusion_note', esc(tsd.conclusion_note), '结论说明') + '</div>' : '') +
      '</div></div>';
  }

  // 次要信息
  var minorBits = [];
  if (Array.isArray(tsd.inner_dates) && tsd.inner_dates.length) {
    minorBits.push('<dt>原文其他日期</dt><dd>' + tsd.inner_dates.map(function (d) {
      return esc(d.date) + '（' + esc(d.meaning) + '）';
    }).join('<br>') + '</dd>');
  }
  if (Array.isArray(tsd.lab_panels) && tsd.lab_panels.length) {
    minorBits.push('<dt>检验分组</dt><dd>' + tsd.lab_panels.map(esc).join('、') + '</dd>');
  }
  if (tsd.history_column_note) minorBits.push('<dt>历史列说明</dt><dd>' + esc(tsd.history_column_note) + '</dd>');
  if (Array.isArray(tsd.ocr_notes) && tsd.ocr_notes.length) {
    minorBits.push('<dt>识别注意</dt><dd>' + tsd.ocr_notes.map(esc).join('<br>') + '</dd>');
  }
  if (tsd.redaction && tsd.redaction.applied) {
    minorBits.push('<dt>脱敏说明</dt><dd>' + esc(tsd.redaction.reason || '') +
      (Array.isArray(tsd.redaction.removed_fields) ? '<br>已移除：' + tsd.redaction.removed_fields.map(esc).join('、') : '') +
      (Array.isArray(tsd.redaction.kept_fields) ? '<br>已保留：' + tsd.redaction.kept_fields.map(esc).join('、') : '') +
      (tsd.redaction.note ? '<br>' + esc(tsd.redaction.note) : '') + '</dd>');
  }
  if (minorBits.length) {
    h += '<div class="minor"><div class="sec-t">次要信息</div><dl class="kv" style="grid-template-columns:100px minmax(0,1fr)">' +
      minorBits.join('') + '</dl></div>';
  }

  // 完整可展示正文
  if (nz(rec.parsed_content)) {
    h += '<div class="card"><div class="card-h"><h3>完整解析内容</h3><span class="sub">已脱敏的可展示正文</span></div><div class="card-b">' +
      '<details class="fold-json"><summary>展开完整正文（' + String(rec.parsed_content).length + ' 字）</summary>' +
      '<div class="src-block" style="max-height:460px;overflow:auto;white-space:pre-wrap;margin-top:9px">' +
      esc(rec.parsed_content) + '</div></details>' +
      '<div class="note">原始解析产物单独私有留存用于溯源；此处为脱敏后可直接展示的正文，检验结果、检查所见、原报告意见与收费明细都完整保留。</div>' +
      '</div></div>';
  }

  // 结构化数据（辅助、可折叠，不作为主详情）
  h += '<div class="card"><div class="card-h"><h3>结构化数据</h3><span class="sub">辅助信息，主详情以上方结果表为准</span></div><div class="card-b">' +
    '<details class="fold-json"><summary>展开原始 JSON</summary><pre>' + esc(JSON.stringify(tsd, null, 2)) + '</pre></details>' +
    '</div></div>';

  return h;
}

/* ---------------- 17. 药品详情 ---------------- */

function openDrug(id, keep) {
  var d = drugById(id);
  if (!d) return;
  $('drugTitle').textContent = nz(d.drug_name) || '(无药品名)';
  $('drugStatus').textContent = d.status || '备用药';
  var exp = L.expiryState(d);
  var atts = attachmentsOf(d);
  var history = Array.isArray(d.history) ? d.history : [];
  if (typeof history === 'string') { try { history = JSON.parse(history); } catch (e) { history = []; } }

  var h = '<div class="split">';
  h += '<div><div class="viewer" id="docViewer"><div class="stage" id="docStage">' +
    (atts.length ? '<div style="text-align:center;color:#93a1b1;font-size:12.5px">正在取得短时授权地址…</div>'
      : '<div style="text-align:center;color:#c8d2de;font-size:12.5px">原始文件未留存</div>') + '</div>' +
    (atts.length ? '<div class="thumbs" id="docThumbs">' + atts.map(function (a, i) {
      return '<button class="th' + (i === 0 ? ' on' : '') + '" data-att="' + i + '" title="' + attr(a.name) + '">' +
        '<span class="num">' + (i + 1) + '</span></button>';
    }).join('') + '</div><div class="viewer-bar"><button class="btn sm" id="docOpenNew">新窗口查看原文件</button>' +
      '<button class="btn sm" id="docDownload">下载原文件</button><span class="muted" id="docAttName" style="font-size:11.5px;align-self:center"></span></div>' : '') +
    '</div></div>';

  h += '<div class="grid">';
  h += '<div class="card"><div class="card-h"><h3>药品资料</h3>' +
    (exp.expired ? '<span class="tag outline">已过期，不能开始用药</span>' : '<span class="exp ' + exp.cls + '">' + esc(exp.label) + '</span>') +
    '</div><div class="card-b"><dl class="kv">' +
    '<dt>药品名称</dt><dd>' + dash(d.drug_name) + '</dd>' +
    '<dt>通用名称</dt><dd>' + dash(d.generic_name) + '</dd>' +
    '<dt>商品名</dt><dd>' + dash(d.brand_name) + '</dd>' +
    '<dt>规格 / 剂型</dt><dd>' + dash(d.strength) + ' · ' + dash(d.dosage_form) + '</dd>' +
    '<dt>给药途径</dt><dd>' + dash(d.route) + '</dd>' +
    '<dt>有效期</dt><dd>' + (nz(d.expiry_date) ? esc(L.fmtCN(d.expiry_date)) : '<span class="muted">有效期待确认</span>') + '</dd>' +
    '<dt>当前数量</dt><dd class="num">' + (nz(d.quantity) ? esc(String(d.quantity)) : '<span class="muted">未知</span>') + '</dd>' +
    '<dt>来源医院</dt><dd>' + dash(d.hospital) + '</dd>' +
    '<dt>医生</dt><dd>' + dash(d.doctor) + '</dd>' +
    '<dt>来源文档</dt><dd>' + dash(d.source_document) +
    (nz(d.source_document_record_id) ? ' <button class="btn sm" data-src-doc="' + attr(d.source_document_record_id) + '">查看关联档案</button>' : '') +
    (nz(d.source_document_date) ? '<div class="muted" style="font-size:11.5px">' + esc(L.fmtCN(d.source_document_date)) + '</div>' : '') + '</dd>' +
    '</dl></div></div>';

  h += '<div class="card"><div class="card-h"><h3>个人用药方案</h3><span class="sub">与原文说明分开记录</span></div><div class="card-b">' +
    '<dl class="kv">' +
    '<dt>每次用量</dt><dd>' + dash(d.dose_each_time) + '</dd>' +
    '<dt>频次</dt><dd>' + dash(d.frequency) + '</dd>' +
    '<dt>服用时间</dt><dd>' + dash(d.timing) + '</dd>' +
    '<dt>开始日期</dt><dd>' + (nz(d.start_date) ? esc(L.fmtCN(d.start_date)) : '<span class="muted">未提供</span>') + '</dd>' +
    '<dt>计划结束</dt><dd>' + (nz(d.planned_end_date) ? esc(L.fmtCN(d.planned_end_date)) : '<span class="muted">未提供</span>') + '</dd>' +
    '<dt>原文适应症</dt><dd>' + (nz(d.purpose_text) ? '<div class="src-block">' + esc(d.purpose_text) + '</div>' : '<span class="muted">未提供</span>') + '</dd>' +
    '<dt>原文用药说明</dt><dd>' + (nz(d.instructions) ? '<div class="src-block">' + esc(d.instructions) + '</div>' : '<span class="muted">未提供</span>') + '</dd>' +
    '</dl>' +
    '<div class="note">原文的用法与适应症来自药盒或说明书，是通用信息；个人实际用量需要在状态操作里单独确认，系统不会自动套用。</div>' +
    '</div></div>';

  if (d.has_conflict) {
    h += '<div class="card"><div class="card-h"><h3>记录冲突</h3></div><div class="card-b">' +
      '<div class="boundary">' + esc(nz(d.conflict_text) || '多条来源记录之间存在不一致。') +
      '<br>此处只陈述差异，不判断哪种方案更正确。建议回到原图核对规格、批次、有效期或给药途径。</div></div></div>';
  }

  h += '<div class="card"><div class="card-h"><h3>状态事件历史</h3><span class="sub">共 ' + history.length + ' 条，最新状态不覆盖历史</span></div><div class="card-b">';
  if (!history.length) h += '<div class="note" style="margin:0">还没有状态事件。开始、暂停、停止、再次开始都会在这里追加记录。</div>';
  else {
    h += '<div class="tbl-scroll"><table class="res-tbl"><thead><tr>' +
      '<th>事件</th><th>操作日期</th><th>状态变化</th><th>当次用量 / 频次</th><th>备注</th></tr></thead><tbody>' +
      history.slice().reverse().map(function (e) {
        return '<tr><td>' + esc(e.event_type || '') + '</td>' +
          '<td class="num">' + (nz(e.event_date) ? esc(L.fmtCN(e.event_date)) : '<span class="muted">未提供</span>') + '</td>' +
          '<td>' + esc(nz(e.from_status) || '—') + ' → ' + esc(nz(e.to_status) || '—') + '</td>' +
          '<td>' + esc([nz(e.dose_each_time), nz(e.frequency), nz(e.timing)].filter(Boolean).join(' · ') || '未提供') + '</td>' +
          '<td class="muted">' + esc(nz(e.note) || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  h += '</div></div>';

  h += '<div class="card"><div class="card-h"><h3>操作</h3></div><div class="card-b" style="display:flex;gap:8px;flex-wrap:wrap">' +
    (L.drugStatusGroup(d.status) !== 'current' && !exp.expired ? '<button class="btn primary" data-d-start="' + attr(d.id) + '">' +
      (L.drugStatusGroup(d.status) === 'history' ? '再次开始用药' : '开始用药') + '</button>' : '') +
    (L.drugStatusGroup(d.status) === 'current' ? '<button class="btn" data-d-pause="' + attr(d.id) + '">暂停用药</button>' +
      '<button class="btn" data-d-stop="' + attr(d.id) + '">停止用药</button>' : '') +
    (exp.expired && L.drugStatusGroup(d.status) !== 'history' ? '<button class="btn" data-d-stop="' + attr(d.id) + '">补记停止记录</button>' : '') +
    '</div></div>';

  if (nz(d.parsed_content)) {
    h += '<div class="card"><div class="card-h"><h3>完整解析内容</h3></div><div class="card-b">' +
      '<details class="fold-json"><summary>展开完整正文</summary>' +
      '<div class="src-block" style="max-height:420px;overflow:auto;white-space:pre-wrap;margin-top:9px">' + esc(d.parsed_content) + '</div></details></div></div>';
  }
  h += '</div></div>';

  $('drugBody').innerHTML = h;
  if (atts.length) bindDocViewer({ id: d.id, source_attachments: atts, document_type: '药品资料' }, 'drug');
  qsa('#drugBody [data-src-doc]').forEach(function (b) {
    b.onclick = function () { openDoc(b.dataset.srcDoc, '药品详情'); };
  });
  qsa('#drugBody [data-d-start]').forEach(function (b) { b.onclick = function () { openStartDrawer(b.dataset.dStart); }; });
  qsa('#drugBody [data-d-pause]').forEach(function (b) { b.onclick = function () { openPauseDrawer(b.dataset.dPause); }; });
  qsa('#drugBody [data-d-stop]').forEach(function (b) { b.onclick = function () { openStopDrawer(b.dataset.dStop); }; });

  if (!keep) { openLayer('drugLayer'); pushHistory('drugLayer'); }
  else { $('drugLayer').classList.add('on'); if (S.layerStack.indexOf('drugLayer') < 0) S.layerStack.push('drugLayer'); syncBodyLock(); }
}

/* ---------------- 20. 历史与初始化 ---------------- */

function pushHistory(name) {
  try { history.pushState({ layer: name, stack: S.layerStack.length }, '', '#' + name); } catch (e) { }
}

window.addEventListener('popstate', function () {
  if (S.layerStack.length) { closeLayer(); return; }
  if (S.view !== 'overview') { go('overview'); }
});

function init() {
  /* V2 是独立脚本且排在后面加载，到这里它才存在 —— 依赖注入必须放在 init 里，
     放在 IIFE 末尾的话 v2.js 还没执行，V2 是 undefined，注入会静默跳过。 */
  if (window.V2) {
    V2.init({
      S: S, L: L, $: $, qsa: qsa, esc: esc, attr: attr, msg: msg,
      notify: showGlobalMsg,
      openLayer: openLayer, closeLayer: closeLayer, pushHistory: pushHistory,
      liftLayerOnTop: liftLayerOnTop,
      openDoc: openDoc, openDrawer: openDrawer, closeDrawers: closeDrawers,
      lineChart: lineChart, sparkline: sparkline,
      renderCurrent: renderCurrent, personViewLabel: personViewLabel
    });
  }

  $('mask').onclick = closeDrawers;
  qsa('[data-close]').forEach(function (b) { b.onclick = closeDrawers; });

  qsa('#nav button').forEach(function (b) {
    b.onclick = function () { closeAllLayers(); go(b.dataset.go); };
  });
  $('docBack').onclick = closeLayer;
  $('drugBack').onclick = closeLayer;
  $('indBack').onclick = closeLayer;
  $('rcBack').onclick = closeLayer;
  $('indDailyEntry').onclick = function () { if (S.indCtx) openDailyDrawer(S.indCtx.key, null); };
  $('btnImportSave').onclick = doImport;

  // 侧栏底部：备份与清理（本地版没有退出登录）
  var bk = $('btnBackup'); if (bk) bk.onclick = doExportBackup;
  var rs = $('btnRestore'); if (rs) rs.onclick = openRestoreDrawer;
  var cl = $('btnClearLocal'); if (cl) cl.onclick = doClearLocal;
  var rc = $('btnRestoreConfirm'); if (rc) rc.onclick = doRestoreBackup;
  var rf = $('rsFile'); if (rf) rf.onchange = function () { setRestoreMsg(''); };

  // 窄屏侧栏开关（宽屏下该按钮不显示）
  var sb = $('btnSidebar');
  var scrim = $('scrim');
  function closeNav() { $('app').classList.remove('nav-open'); }
  if (sb) sb.onclick = function () { $('app').classList.toggle('nav-open'); };
  if (scrim) scrim.onclick = closeNav;
  qsa('#nav button').forEach(function (b) {
    var prev = b.onclick;
    b.onclick = function () { closeNav(); if (prev) prev(); };
  });

  try { history.replaceState({ view: 'overview' }, '', location.pathname + location.search); } catch (e) { }

  startApp();
}

/* ---------------- 13. 自动化自测句柄 ----------------
   只用于本机自动化测试读取内部状态：不参与界面渲染，也不新增任何数据出口，
   读到的就是本页自己本来就有的数据。删除它不影响任何功能。 */
window.__hrwDebug = {
  state: S,
  local: cloud,
  bridge: BRIDGE,
  server: SERVER,
  guessDate: guessDate,
  reload: function () { cloud.invalidate(); return loadAll(); },
  openDoc: function (id, from) { return openDoc(id, from); },
  openStructDrawer: function (id) { return openStructDrawer(id); },
  openDailyDrawer: function (key, presetDate) { return openDailyDrawer(key, presetDate); },
  openImportDrawer: function (target, preset) { return openImportDrawer(target, preset); },
  closeDrawers: function () { return closeDrawers(); },
  openLayer: function (id) { return openLayer(id); },
  closeLayer: function () { return closeLayer(); },
  closeAllLayers: function () { return closeAllLayers(); },
  bodyLocked: function () { return document.body.style.overflow === 'hidden'; },
  tables: function () { return window.LocalDB.TABLES.slice(); },
  persons: function () { return S.persons.slice(); },
  personStats: function () { return Object.assign({}, S.personStats); },
  personState: function () { return S.personState; },
  go: function (v) { return go(v); },
  summary: function () {
    var out = { view: S.view, layers: S.layerStack.slice(), local: S.local, server: SERVER.info, tables: {},
      persons: S.persons.length, personState: S.personState };
    Object.keys(S.tables).forEach(function (k) {
      out.tables[k] = { state: S.tables[k].state, count: S.tables[k].count, error: S.tables[k].error };
    });
    return out;
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
