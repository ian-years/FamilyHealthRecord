/* ============================================================
   个人健康档案工作台 · 应用主体
   ------------------------------------------------------------
   数据源：平台托管 PostgreSQL（四张 owner-only RLS 表）
   附件：托管对象存储，读取时按需签发短时下载地址
   解析：由对话中的解析连接器完成，本页不伪造解析调用
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

if (!window.WorkBuddyCloud) {
  document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card"><h1>无法初始化</h1>' +
    '<p class="sub">云端 SDK 未加载成功，请检查网络后刷新页面。</p></div></div>';
  return;
}
if (!window.PUBLIC_CONFIG || !window.PUBLIC_CONFIG.endpoint) {
  document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card"><h1>缺少应用配置</h1>' +
    '<p class="sub">config.js 中的 endpoint 未提供，无法连接数据服务。</p></div></div>';
  return;
}

var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: window.PUBLIC_CONFIG.endpoint,
  publishableKey: window.PUBLIC_CONFIG.publishableKey
});

var PAGE = 200;
var MAX_PAGES = 100;   // 单表加载上限 20000 条；超限显式报错，不静默截断

/* ---------------- 1. 状态 ---------------- */

var S = {
  session: null,
  view: 'overview',
  range: '12',                       // 12 | 3 | all
  tables: {
    health_records: { state: 'idle', rows: [], error: null, count: 0 },
    drugs: { state: 'idle', rows: [], error: null, count: 0 },
    indicator_catalog: { state: 'idle', rows: [], error: null, count: 0 },
    daily_indicator_records: { state: 'idle', rows: [], error: null, count: 0 }
  },
  booted: false,
  filters: { q: '', type: '', hospital: '' },
  archFilter: { q: '', type: '' },
  rcFilter: { year: '' },
  expanded: {},                      // 'YYYY-MM' -> true
  expandedYears: {},                 // 'YYYY' -> true
  actYears: {},                      // 资料活动展开年份
  scroll: {},                        // view -> scrollTop
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

async function loadAll() {
  await Promise.all([
    loadTable('health_records', 'primary_date'),
    loadTable('drugs', 'updated_at'),
    loadTable('indicator_catalog', 'sort_order'),
    loadTable('daily_indicator_records', 'record_date')
  ]);
  await ensureCatalog();
  S.booted = true;
}

// 首次登录时初始化预置指标目录（真实写入，失败不伪装成功）
async function ensureCatalog() {
  var b = bucket('indicator_catalog');
  if (b.state !== 'ok') return;
  if (b.rows.length > 0) return;
  var payload = L.PRESET_CATALOG.map(function (c) {
    return {
      name: c.name, key: c.key, grp: c.grp, type: c.type, unit: c.unit || null,
      aliases: c.aliases || [], followed: !!c.followed, sort_order: c.order, preset: !!c.preset
    };
  });
  var res = await cloud.database.from('indicator_catalog').insert(payload).select();
  if (res.error) { b.error = '初始化指标目录失败：' + res.error.message; renderSyncStrip(); return; }
  await loadTable('indicator_catalog', 'sort_order');
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
function catalogList() { return bucket('indicator_catalog').rows.map(mergeCatalogMeta).sort(catalogSort); }
function catalogByKey() {
  var m = {};
  catalogList().forEach(function (c) { m[c.key] = c; });
  return m;
}

/* ---------------- 3. 附件 ---------------- */

// 附件对象：文件名 / 存储标识(path) / 短时授权地址 / MIME / 大小 / 页序
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

async function uploadOriginal(file, uid) {
  var ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  var path = cloud.storage.userPath(uid, 'attachments/' + uuid() + '.' + ext);
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

// 报告派生项 + 日常录入项 汇合，但保留来源区别；不重复生成派生结果
function allIndicatorPoints() {
  var derived = L.deriveIndicatorPoints(bucket('health_records').rows, catalogList());
  var manual = bucket('daily_indicator_records').rows.map(function (r) {
    var c = catalogByKey()[r.indicator_key] || {};
    return {
      indicatorKey: r.indicator_key, name: r.name, condition: r.condition,
      result: r.text_result !== null && r.text_result !== undefined && r.text_result !== ''
        ? r.text_result : (r.value1 !== null && r.value1 !== undefined ? String(r.value1) : ''),
      unit: r.unit, reference: r.reference, flag: L.normalizeFlag(r.flag), flagRaw: r.flag || null,
      value: (r.type === '数值' || r.type === '双数值') ? (r.value1 === null || r.value1 === undefined ? null : Number(r.value1)) : null,
      value2: (r.type === '双数值' && r.value2 !== null && r.value2 !== undefined) ? Number(r.value2) : null,
      date: r.record_date, dateStatus: null,
      source: '手动录入', sourceRecordId: null, sourceTitle: r.note || null,
      dailyRecordId: r.id, review: r.review || '用户录入', analyze: c.analyze || null,
      textResult: r.text_result || null, type: r.type
    };
  });
  var pts = {};
  derived.concat(manual).forEach(function (p) {
    (pts[p.indicatorKey] = pts[p.indicatorKey] || []).push(p);
  });
  return pts;
}

function rangeCutoff() {
  if (S.range === 'all') return null;
  var days = S.range === '3' ? 92 : 366;
  return L.addDaysISO(L.todayISO(), -days);
}

function filterByRange(recs) {
  var cut = rangeCutoff();
  if (!cut) return recs;
  return recs.filter(function (r) {
    var d = L.dateSortKey(r.primary_date);
    return d && d >= cut;
  });
}

function filterPointsByRange(points) {
  var cut = rangeCutoff();
  if (!cut) return points;
  return points.filter(function (p) { var d = L.dateSortKey(p.date); return d && d >= cut; });
}

/* ---------------- 5. 鉴权 ---------------- */

var authMsgEl = null;
function authShow(text, isErr) {
  if (!authMsgEl) authMsgEl = $('authMsg');
  if (!text) { authMsgEl.classList.add('hidden'); return; }
  authMsgEl.textContent = text;
  authMsgEl.classList.remove('hidden');
  authMsgEl.classList.toggle('err', !!isErr);
}
function authErrText(e) {
  if (!e) return '操作失败，请重试。';
  var k = e.kind || '';
  if (k === 'network' || k === 'backend-unavailable') return '网络或服务暂时不可用，请稍后重试。';
  if (k === 'unauthenticated' || k === 'invalid_grant') return '未通过验证，请检查后重试。';
  return '操作未完成，请检查填写内容后重试。';
}

function bindAuth() {
  qsa('#authTabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      qsa('#authTabs button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      ['pw', 'otp', 'signup', 'reset'].forEach(function (t) {
        $('at-' + t).classList.toggle('hidden', t !== b.dataset.at);
      });
      authShow('');
    });
  });

  $('btnPwLogin').onclick = async function () {
    var email = $('pwEmail').value.trim(), pw = $('pwPass').value;
    if (!email || !pw) return authShow('请填写邮箱与密码。', true);
    authShow('正在登录…');
    var r = await cloud.auth.signInWithPassword({ email: email, password: pw });
    if (r.error) return authShow('账号或密码不正确。', true);
    await afterLogin();
  };

  $('btnOtpSend').onclick = async function () {
    var email = $('otpEmail').value.trim();
    if (!email) return authShow('请填写邮箱。', true);
    authShow('正在发送验证码…');
    var r = await cloud.auth.signInWithOtp({ email: email });
    if (r.error) return authShow(authErrText(r.error), true);
    window.__otp = r.data;
    authShow('验证码已发送到邮箱，请在 5 分钟内填写。');
  };
  $('btnOtpVerify').onclick = async function () {
    var code = $('otpCode').value.trim();
    if (!code) return authShow('请填写验证码。', true);
    if (!window.__otp || !window.__otp.verify) return authShow('请先获取验证码。', true);
    authShow('正在验证…');
    var r = await window.__otp.verify({ token: code });
    if (r.error) return authShow('验证码不正确或已过期。', true);
    await afterLogin();
  };

  $('btnSuSend').onclick = async function () {
    var email = $('suEmail').value.trim();
    if (!email) return authShow('请填写邮箱。', true);
    authShow('正在发送验证码…');
    var r = await cloud.auth.sendOtp({ email: email });
    if (r.error) return authShow(authErrText(r.error), true);
    window.__su = r.data;
    authShow('验证码已发送到邮箱，请填写后设置密码完成注册。');
  };
  $('btnSuSubmit').onclick = async function () {
    var code = $('suCode').value.trim(), pw = $('suPass').value;
    if (!window.__su) return authShow('请先获取验证码。', true);
    if (!code) return authShow('请填写验证码。', true);
    if (!pw || pw.length < 6) return authShow('密码至少 6 位。', true);
    authShow('正在完成注册…');
    var r = await cloud.auth.verifyOtp({
      verificationId: window.__su.verificationId, token: code,
      email: $('suEmail').value.trim(), isExistingUser: window.__su.isExistingUser,
      password: window.__su.isExistingUser ? undefined : pw
    });
    if (r.error) return authShow('注册未完成，请检查验证码。', true);
    if (window.__su.isExistingUser) return authShow('该邮箱已可使用，请改用登录。');
    await afterLogin();
  };

  $('btnRsSend').onclick = async function () {
    var email = $('rsEmail').value.trim();
    if (!email) return authShow('请填写邮箱。', true);
    authShow('正在发送验证码…');
    var r = await cloud.auth.resetPasswordForEmail(email);
    if (r.error) return authShow(authErrText(r.error), true);
    window.__rs = r.data;
    authShow('验证码已发送，请填写验证码与新密码。');
  };
  $('btnRsSubmit').onclick = async function () {
    var code = $('rsCode').value.trim(), pw = $('rsPass').value;
    if (!window.__rs || !window.__rs.updateUser) return authShow('请先获取验证码。', true);
    if (!code) return authShow('请填写验证码。', true);
    if (!pw || pw.length < 6) return authShow('新密码至少 6 位。', true);
    authShow('正在重设密码…');
    var r = await window.__rs.updateUser({ nonce: code, password: pw });
    if (r.error) return authShow('重设失败，请检查验证码。', true);
    authShow('密码已重设并已登录。');
    await afterLogin();
  };

  $('btnSignOut').onclick = async function () {
    await cloud.auth.signOut();
    S.session = null;
    $('app').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
    authShow('');
  };
}

async function afterLogin() {
  var r = await cloud.auth.getSession();
  S.session = r.data || null;
  if (!S.session) return authShow('登录状态未建立，请重试。', true);
  authShow('');
  $('authScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('whoami').textContent = (S.session.user && (S.session.user.email || S.session.user.id)) || '';
  renderSyncStrip();
  await loadAll();
  renderCurrent();
}

/* ---------------- 6. 导航 ---------------- */

var VIEWS = { overview: '数据概览', timeline: '健康档案', upload: '上传资料', archive: '原始资料档案', drugs: '药品管理' };

function go(view, opts) {
  opts = opts || {};
  if (!opts.keepScroll) {
    var m = $('main');
    if (m) S.scroll[S.view] = m.scrollTop;
  }
  S.view = view;
  qsa('#nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.go === view); });
  qsa('.screen').forEach(function (s) { s.classList.toggle('on', s.id === 's-' + view); });
  renderCurrent();
  var main = $('main');
  if (opts.restore && S.scroll[view]) main.scrollTop = S.scroll[view];
  else main.scrollTop = 0;
}

function renderCurrent() {
  if (!S.booted && !S.tables.health_records.rows.length && S.tables.health_records.state !== 'ok') {
    // 数据尚未就绪时也给出准确状态
  }
  if (S.view === 'overview') renderOverview();
  else if (S.view === 'timeline') renderTimeline();
  else if (S.view === 'upload') renderUpload();
  else if (S.view === 'archive') renderArchive();
  else if (S.view === 'drugs') renderDrugs();
}

function renderSyncStrip() {
  var host = qsa('.sync-host');
  if (!host.length) return;
  var names = { health_records: '健康档案', drugs: '药品', indicator_catalog: '指标目录', daily_indicator_records: '日常指标' };
  var html = Object.keys(S.tables).map(function (k) {
    var t = S.tables[k];
    var cls = t.state === 'ok' ? 'ok' : (t.state === 'error' ? 'fail' : (t.state === 'loading' ? 'load' : ''));
    var label = t.state === 'ok' ? ('已同步 ' + t.count + ' 条')
      : t.state === 'error' ? '同步失败' : t.state === 'loading' ? '同步中' : '未开始';
    return '<span class="it" title="' + attr(t.error || '') + '"><i class="dot ' + cls + '"></i>' +
      names[k] + '：' + label + '</span>';
  }).join('');
  host.forEach(function (h) { h.innerHTML = html; });
}

/* ---------------- 7. 详情层（固定定位独立滚动，不触碰底层页面滚动） ---------------- */

function openLayer(id) {
  var el = $(id);
  el.scrollTop = 0;                 // 打开即从该容器顶部开始：只改容器自身滚动位置，绝不滚动底层页面
  el.classList.add('on');
  document.body.style.overflow = 'hidden';
  S.layerStack.push(id);
}
function closeLayer() {
  var id = S.layerStack.pop();
  if (id) $(id).classList.remove('on');
  if (!S.layerStack.length) document.body.style.overflow = '';
}
function closeAllLayers() {
  while (S.layerStack.length) closeLayer();
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
  for (var g = 0; g <= ticks; g++) {
    var yy = PT + ih - (g * ih / ticks);
    var val = vmin + (vmax - vmin) * g / ticks;
    grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f5"/>' +
      '<text x="' + (PL - 7) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a94a3">' +
      val.toFixed(cfg.decimals === 0 ? 0 : 2) + '</text>';
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

function indicatorStats(key, points, cat) {
  var list = points[key] || [];
  var isLipidGroup = key === 'lipids';
  var isOgtt = key === 'ogtt_glu' || key === 'ogtt_ins';
  var st = { key: key, cat: cat, list: list, count: 0, countLabel: '记录次数', latest: null, latestDate: null, points: list };

  if (isLipidGroup) {
    var byKey = {};
    ['tc', 'tg', 'hdl', 'ldl'].forEach(function (k) { byKey[k] = points[k] || []; });
    var lip = L.lipidSummary(byKey);
    st.count = lip.checkCount; st.countLabel = lip.label; st.lipid = lip; st.compPoints = byKey;
    st.latestDate = lip.dates.length ? lip.dates[lip.dates.length - 1] : null;
    st.latest = ['tc', 'tg', 'hdl', 'ldl'].map(function (k) {
      var c = catalogByKey()[k] || {};
      var cand = byKey[k].filter(function (p) { return L.dateSortKey(p.date) === st.latestDate; });
      return { key: k, name: c.name || k, list: cand };
    });
    return st;
  }
  if (isOgtt) {
    var og = L.buildOGTT(list, cat && cat.ogtt);
    st.ogtt = og; st.count = og.trialCount; st.countLabel = '有有效日期的试验次数';
    var tdates = og.trials.map(function (t) { return t.date; }).sort();
    st.latestDate = tdates.length ? tdates[tdates.length - 1] : null;
    st.trial = st.latestDate ? og.trials.filter(function (t) { return t.date === st.latestDate; })[0] : null;
    return st;
  }
  var trend = L.buildTrend(list, { analyze: cat && cat.analyze });
  st.trend = trend;
  st.count = trend.connected.length ? trend.connected.length : list.length;
  st.countLabel = cat && cat.type === '双数值' ? '记录次数' : '结果记录数';
  st.latestDate = trend.distinctDates.length ? trend.distinctDates[trend.distinctDates.length - 1] : null;
  st.latest = trend.latest;
  return st;
}

function latestCell(st) {
  if (st.key === 'lipids') {
    var parts = (st.latest || []).map(function (c) {
      var v = c.list.filter(function (x) { return x.value !== null; })[0];
      var txt = v ? (v.value + ' ' + (v.unit || '')) : (c.list.length && c.list[0].result ? c.list[0].result : null);
      return c.name + ' ' + (txt === null ? '<span class="muted">本次未提供</span>' : esc(txt));
    });
    return parts.length ? parts.join('　') : '<span class="muted">暂无记录</span>';
  }
  if (st.trial) {
    var mx = st.trial.curvePoints.length;
    return mx ? (mx + ' 个时点（' + esc(st.trial.unit || '') + '）') : '<span class="muted">本次无精确数值点</span>';
  }
  if (!st.latest || !st.latest.length) return '<span class="muted">暂无记录</span>';
  var p = st.latest[0];
  if (st.cat && st.cat.type === '双数值') {
    var v2 = (p.value2 === null || p.value2 === undefined) ? null : p.value2;
    return esc(p.value) + (v2 === null ? '' : ' / ' + esc(v2)) + ' <span class="muted" style="font-size:11.5px">' + esc(p.unit || '') + '</span>';
  }
  var extra = '';
  if (p.conversion && p.conversion.conversionApplied) {
    extra = ' <span class="muted" style="font-size:11px">（原 ' + esc(p.conversion.originalValue + ' ' + p.conversion.originalUnit) + '）</span>';
  }
  return esc(p.value) + ' <span class="muted" style="font-size:11.5px">' + esc(p.normUnit || p.unit || '') + '</span>' + extra;
}

function renderOverview() {
  var host = $('s-overview');
  var recs = bucket('health_records').rows;
  var drugs = bucket('drugs').rows;
  var pts = allIndicatorPoints();
  var cat = catalogList();
  var fees = L.buildFees(recs);
  var tl = L.groupTimeline(recs);
  var activity = L.buildActivity(recs);
  var dist = L.typeDistribution(recs);

  var errRows = Object.keys(S.tables).filter(function (k) { return S.tables[k].state === 'error'; });

  // A. 概览数字
  var datedCount = tl.dateGroups.length;
  var followedCount = cat.filter(function (c) { return c.followed; }).length;

  var html = '';
  html += '<div class="page-head"><h2>健康数据概览</h2>' +
    '<p>关注指标趋势、资料活动与费用统计。本工作台只记录与展示你自己的医疗资料、用药与指标，不做诊断、不做治疗建议、不预测风险。</p></div>';
  html += '<div class="sync-strip sync-host"></div>';

  if (errRows.length) {
    html += '<div class="err-bar"><b>部分数据未同步。</b>' +
      errRows.map(function (k) { return esc(k) + '：' + esc(S.tables[k].error || '读取失败'); }).join('；') +
      '　其余模块仍可正常使用；修复后可点「重新同步」。</div>';
  }

  html += '<div class="kpis">' +
    kpi('档案数量', '<span class="num">' + recs.length + '</span>', '份', '共 6 类资料，含 ' + tl.pending.length + ' 份日期待确认') +
    kpi('覆盖的有效日期', '<span class="num">' + datedCount + '</span>', '个', '仅统计日期有效的资料') +
    kpi('关注指标', '<span class="num">' + followedCount + '</span>', '项', '目录共 ' + cat.length + ' 项，可继续添加') +
    kpi('已记录医疗费用', '<span class="num">' + esc(fees.total.replace('¥', '')) + '</span>', '元',
      '明确金额 ' + fees.counts.known + ' 张；未知金额 ' + fees.counts.unknown + ' 张未计入') +
    '</div>';

  html += '<div class="cols-2">';

  /* ---- 左列 ---- */
  html += '<div class="grid">';

  // B. 关注指标表
  html += '<div class="card"><div class="card-h"><h3>关注指标 <span class="sub">最新结果与趋势概览</span></h3>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<div class="range-tabs" id="rangeTabs">' +
    ['3', '12', 'all'].map(function (r) {
      return '<button data-range="' + r + '" class="' + (S.range === r ? 'on' : '') + '">' +
        (r === '3' ? '近 3 个月' : r === '12' ? '近 12 个月' : '全部') + '</button>';
    }).join('') + '</div>' +
    '<button class="btn sm" id="btnFollowMgr">添加关注</button>' +
    '<button class="btn sm" id="btnCustom">自定义指标</button></div></div>';

  html += '<div class="card-b">';
  html += '<div class="note" style="margin:0 0 11px">时间范围：<b>仅作用于本表的指标结果与趋势统计</b>，不影响下方的资料活动、类型分布与费用统计。</div>';

  if (!cat.length) {
    html += msg(S.tables.indicator_catalog.state === 'error' ? '指标目录未能同步，无法展示关注指标。' : '指标目录为空，正在初始化…');
  } else {
    var shown = cat.filter(function (c) { return c.followed || (pts[c.key] && pts[c.key].length); });
    var extraKeys = Object.keys(pts).filter(function (k) { return !cat.some(function (c) { return c.key === k; }); });
    extraKeys.forEach(function (k) {
      shown.push({ key: k, name: k, grp: '未归类', type: '数值', unit: '', followed: false, unmatched: true });
    });
    if (!shown.length) html += msg('还没有关注指标。点「添加关注」从目录中选择。');

    if (shown.length) {
      html += '<div class="tbl-scroll"><table class="tbl"><thead><tr>' +
        '<th>指标名</th><th>说明</th><th>最新结果</th><th>最新有效日期</th><th class="r">次数</th><th>小趋势</th><th></th>' +
        '</tr></thead><tbody>';
      shown.forEach(function (c) {
        var scoped = filterPointsByRange(pts[c.key] || []);
        var st = indicatorStats(c.key, c.key === 'lipids' ? pointsForLipidScope(pts) : buildScopedMap(pts, scoped, c.key), c);
        var stFull = indicatorStats(c.key, pts, c);
        var note = c.unmatched ? '报告中出现但未进入目录的项目' :
          (c.grp || '') + ' · ' + (c.type || '') + (c.unit ? ' · ' + c.unit : '');
        html += '<tr data-ind="' + attr(c.key) + '">' +
          '<td><b>' + esc(c.name) + '</b>' + (c.followed ? '' : ' <span class="tag gray">未关注</span>') + '</td>' +
          '<td class="muted" style="font-size:12px">' + esc(note) + '</td>' +
          '<td>' + latestCell(st) + '</td>' +
          '<td class="num" style="font-size:12px">' + (st.latestDate ? esc(L.fmtCN(st.latestDate)) : '<span class="muted">—</span>') + '</td>' +
          '<td class="r num">' + stFull.count + '<div class="muted" style="font-size:10.5px">' + esc(stFull.countLabel) + '</div></td>' +
          '<td>' + sparkCell(st) + '</td>' +
          '<td class="r" style="white-space:nowrap">' +
          '<button class="btn sm" data-ind-open="' + attr(c.key) + '">详情</button> ' +
          '<button class="btn sm ghost" data-ind-daily="' + attr(c.key) + '">录入</button></td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<div class="note">次数口径：普通数值指标显示结果记录数；血脂显示按有效报告日期去重的「检查次数」（四个分项不是四次检查）；OGTT 显示有有效日期的试验次数。血尿酸等存在未归一化多单位组时，仅连接唯一占多数的单位组。</div>';
    }
  }
  html += '</div></div>';

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
  html += '<div class="card"><div class="card-h"><h3>资料类型分布 <span class="sub">六类资料数量</span></h3></div><div class="card-b">';
  if (!recs.length) html += msg('暂无资料。归档后这里会显示六类资料的分布。');
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

  /* ---- 右列：费用 ---- */
  html += '<div class="grid">';
  html += '<div class="card"><div class="card-h"><h3>已记录医疗费用</h3></div><div class="card-b">';
  html += '<div class="kv" style="grid-template-columns:118px minmax(0,1fr)">' +
    '<dt>明确金额总额</dt><dd><b class="num" style="font-size:16px">' + esc(fees.total) + '</b>' +
    '<div class="muted" style="font-size:11.5px">来自 ' + fees.counts.known + ' 张已录入票据</div></dd>' +
    '<dt>明确零金额</dt><dd>' + fees.counts.zero + ' 张 <span class="muted" style="font-size:11.5px">（真实 0 元，按有效日期参与年度张数）</span></dd>' +
    '<dt>金额未知</dt><dd>' + fees.counts.unknown + ' 张 <span class="muted" style="font-size:11.5px">（未计入合计，仍保留在总额与来源中）</span></dd>' +
    '<dt>医保支付</dt><dd>' + esc(fees.insurance) + (fees.insuranceMissing ? ' <span class="muted" style="font-size:11.5px">（' + fees.insuranceMissing + ' 张未提供）</span>' : '') + '</dd>' +
    '<dt>个人支付</dt><dd>' + esc(fees.selfPay) + (fees.selfMissing ? ' <span class="muted" style="font-size:11.5px">（' + fees.selfMissing + ' 张未提供）</span>' : '') + '</dd>' +
    '</div>';
  if (fees.gapNote) html += '<div class="note">' + esc(fees.gapNote) + '</div>';
  html += '<div style="margin-top:12px"><button class="btn primary" id="btnAllReceipts">查看全部票据来源</button></div>';
  html += '<div class="note">' + esc(fees.scopeNote) + ' 费用只统计「医疗发票 / 收费单」，不把处方中的金额或收费项目提到的药品重复计费。</div>';
  html += '</div></div>';

  html += '<div class="card"><div class="card-h"><h3>年度费用</h3><span class="sub">按票据主要日期汇总</span></div><div class="card-b">';
  if (!fees.yearList.length) html += msg('暂无可用于年度统计的票据（需要日期有效且金额明确）。');
  else {
    var maxc = Math.max.apply(null, fees.yearList.map(function (y) { return y.cents; })) || 1;
    html += '<div class="bars">' + fees.yearList.map(function (y) {
      var h = Math.max(3, Math.round(y.cents / maxc * 100));
      return '<div class="bar" title="' + attr(y.year + ' 年 · ' + y.amount + ' · ' + y.count + ' 张') + '">' +
        '<span class="amt">' + esc(y.amount) + '</span>' +
        '<span class="fill" style="height:' + h + 'px"></span>' +
        '<span class="lab">' + esc(y.year) + '</span><span class="lab muted">' + y.count + ' 张</span></div>';
    }).join('') + '</div>';
    html += '<div class="note">每年显示年度、合计金额与票据张数。无日期的票据不进入年度图，但仍在总额与来源列表中，因此年度小计与总额可能不同。</div>';
  }
  html += '</div></div>';

  // 药品轻摘要
  var cur = drugs.filter(function (d) { return d.status === '正在服用'; });
  var todayInUse = cur.filter(function (d) { return L.isInUseToday(d); });
  html += '<div class="card"><div class="card-h"><h3>用药概况</h3><button class="btn sm" data-go-btn="drugs">药品管理</button></div><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:100px minmax(0,1fr)">' +
    '<dt>当前用药</dt><dd>' + cur.length + ' 种<div class="muted" style="font-size:11.5px">其中今日在用 ' + todayInUse.length + ' 种</div></dd>' +
    '<dt>备用 / 药箱</dt><dd>' + drugs.filter(function (d) { return d.status === '备用药'; }).length + ' 种</dd>' +
    '<dt>历史用药</dt><dd>' + drugs.filter(function (d) { return d.status === '已停用'; }).length + ' 种</dd>' +
    '</div></div></div>';

  html += '</div>';   // 右列结束
  html += '</div>';   // cols-2 结束

  host.innerHTML = html;
  bindOverview();
}

function buildScopedMap(allPts, scoped, key) {
  var m = {};
  Object.keys(allPts).forEach(function (k) { m[k] = k === key ? scoped : allPts[k]; });
  return m;
}
function pointsForLipidScope(allPts) {
  var cut = rangeCutoff();
  if (!cut) return allPts;
  var m = {};
  Object.keys(allPts).forEach(function (k) { m[k] = filterPointsByRange(allPts[k]); });
  return m;
}
function sparkCell(st) {
  if (st.key === 'lipids' && st.compPoints) {
    var total = (st.compPoints.tc || []).concat(st.compPoints.tg || []);
    var norm = total.filter(function (p) { return p.value !== null; }).sort(function (a, b) {
      return (L.dateSortKey(a.date) || '') < (L.dateSortKey(b.date) || '') ? -1 : 1;
    });
    return sparkline(norm);
  }
  var src = (st.trend && st.trend.connected.length >= 2) ? st.trend.connected : (st.list || []);
  return sparkline(src.sort(function (a, b) {
    return (L.dateSortKey(a.date) || '') < (L.dateSortKey(b.date) || '') ? -1 : 1;
  }));
}

function bindOverview() {
  qsa('#rangeTabs button').forEach(function (b) {
    b.onclick = function () { S.range = b.dataset.range; renderOverview(); };
  });
  qsa('[data-go-btn]').forEach(function (b) { b.onclick = function () { go(b.dataset.goBtn); }; });
  qsa('[data-ind-open]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openIndicator(b.dataset.indOpen, '数据概览'); };
  });
  qsa('[data-ind-daily]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); openDailyDrawer(b.dataset.indDaily, null); };
  });
  qsa('#s-overview tr[data-ind]').forEach(function (tr) {
    tr.onclick = function (e) {
      if (e.target.closest('button')) return;
      openIndicator(tr.dataset.ind, '数据概览');
    };
  });
  var fm = $('btnFollowMgr'); if (fm) fm.onclick = openFollowDrawer;
  var cm = $('btnCustom'); if (cm) cm.onclick = openCustomDrawer;
  var ar = $('btnAllReceipts'); if (ar) ar.onclick = function () { openReceipts(); };
  qsa('[data-act-toggle]').forEach(function (h) {
    h.onclick = function () { S.actYears[h.dataset.actToggle] = !S.actYears[h.dataset.actToggle]; renderOverview(); };
  });
}

/* ---------------- 10. 健康档案时间线 ---------------- */

function docCard(r) {
  var info = nz(r.key_information) ? String(r.key_information).split('\n').filter(function (s) { return s.trim(); }) : [];
  return '<div class="doc-card" data-doc="' + attr(r.id) + '">' +
    '<div class="t"><span class="tt">' + esc(nz(r.title) || '(无标题)') + '</span>' +
    '<span class="tag">' + esc(L.normalizeDocType(r.document_type)) + '</span>' +
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
  var all = bucket('health_records').rows;
  var tl = L.groupTimeline(all);
  var filters = S.filters;

  var hospitals = {};
  all.forEach(function (r) { if (nz(r.hospital)) hospitals[r.hospital] = true; });
  var types = L.DOC_TYPES.slice();
  all.forEach(function (r) { var t = L.normalizeDocType(r.document_type); if (types.indexOf(t) < 0) types.push(t); });

  // 筛选真实作用于全部已加载记录；清空筛选后恢复完整数据
  var filtered = all.filter(function (r) {
    if (filters.type && L.normalizeDocType(r.document_type) !== filters.type) return false;
    if (filters.hospital && r.hospital !== filters.hospital) return false;
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
    '<button class="btn sm" id="tlClear">清空筛选</button>' +
    '<span class="muted" style="font-size:12px">命中 ' + filtered.length + ' / ' + all.length + ' 份</span>' +
    '</div>';

  if (!all.length) {
    html += msg(S.tables.health_records.state === 'error'
      ? '健康档案未能同步：' + (S.tables.health_records.error || '读取失败')
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
  var c = $('tlClear');
  if (c) c.onclick = function () { S.filters = { q: '', type: '', hospital: '' }; renderTimeline(); };
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
  var h = '';
  h += '<div class="page-head"><h2>上传资料</h2>' +
    '<p>资料的解析在对话中完成，归档写入发生在这里。两个动作都留有可追溯的标识，不做假进度、不显示假成功。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

  h += '<div class="cols-2"><div class="grid">';

  h += '<div class="card"><div class="card-h"><h3>处理链路</h3><span class="sub">四步，每步都有真实状态</span></div><div class="card-b">' +
    '<div class="up-steps">' +
    '<div class="up-step"><div class="no">1</div><div class="bd"><h4>在对话中提交原始文件</h4>' +
    '<p>把 PDF、JPG、PNG 或手机拍的纸质报告提交到对话，由解析能力读取。支持单张、多张、多文件；属于同一份报告的多页或多图，请在提交时说明，会按一个逻辑档案处理。微信 PC 端收到的文件可以先保存到本地再拖入对话。</p></div></div>' +
    '<div class="up-step"><div class="no">2</div><div class="bd"><h4>拿到脱敏归档包</h4>' +
    '<p>解析完成后会得到一份归档包（.json）。归档包里的正文已经完成身份信息脱敏，原始解析产物单独私有留存用于溯源。同一份报告的指标从检验结果派生、费用从发票派生，归档包内含全部结构化字段。</p></div></div>' +
    '<div class="up-step"><div class="no">3</div><div class="bd"><h4>在这里选择归档包与原始文件</h4>' +
    '<p>原始文件会上传到你自己的私有附件存储目录，只有登录后的你可以读取；详情页通过短时授权地址访问，授权地址不会长期保存。</p></div></div>' +
    '<div class="up-step"><div class="no">4</div><div class="bd"><h4>写入四张表并回读校验</h4>' +
    '<p>写入成功以服务端返回的记录主键为准，随后立刻回读记录数量、关键字段与附件数。部分失败只补写失败项，不会重新写入全部。</p></div></div>' +
    '</div>';
  h += '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
    '<button class="btn" disabled title="网页不能直接触发连接器解析">网页一键上传（不可用）</button>' +
    '<button class="btn primary" id="btnOpenImport">选择归档包并写入档案</button>' +
    '<a class="btn" href="tests.html" target="_blank" rel="noopener">运行业务逻辑自检</a>' +
    '</div>' +
    '<div class="note">「网页一键上传」保持禁用状态，因为当前没有正式的、可用于网页触发连接器解析的服务端接口。请走上面的对话提交路径，本页不把它包装成网页自动调用，也不显示进度条。</div>';
  h += '</div></div>';

  h += '<div class="card"><div class="card-h"><h3>边界说明</h3></div><div class="card-b">' +
    '<div class="boundary">' +
    '<b>本工作台不做医疗决策。</b>原报告的诊断意见、报告结论、适应症可以原文展示，但会标明来自原资料，不是系统生成的判断。系统不会根据数值与参考范围的大小关系自动生成异常、正常、偏高、偏低标签，不复现原报告未印出的箭头。<br><br>' +
    '<b>不确定就留空。</b>无法确认的字段保存为未知，展示为「未提供」或「待确认」；不会编造日期、医生、单位、结果或剂量，明确的 0 会原样保留。<br><br>' +
    '<b>收费单只说明收费。</b>不据此推断确诊疾病、检查所见、治疗实施或服药事实。<br><br>' +
    '<b>药盒说明书不等于你的用药计划。</b>说明书上的通用用法与适应症不会自动填成个人实际用药计划，需要你确认后才会成为计划。' +
    '</div></div></div>';

  h += '</div><div class="grid">';

  h += '<div class="card"><div class="card-h"><h3>当前数据规模</h3></div><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:110px minmax(0,1fr)">' +
    '<dt>健康档案</dt><dd class="num">' + S.tables.health_records.count + ' 条</dd>' +
    '<dt>药品</dt><dd class="num">' + S.tables.drugs.count + ' 条</dd>' +
    '<dt>指标目录</dt><dd class="num">' + S.tables.indicator_catalog.count + ' 条</dd>' +
    '<dt>日常指标</dt><dd class="num">' + S.tables.daily_indicator_records.count + ' 条</dd>' +
    '</div>' +
    '<div class="note">单页读取上限 200 条，超过时自动分页直到取完，汇总与来源不遗漏任何一页。</div>' +
    '</div></div>';

  h += '<div class="card"><div class="card-h"><h3>隐私与分享边界</h3></div><div class="card-b">' +
    '<div class="note" style="margin:0">' +
    '· 四张表都启用了行级权限，每一行的读写都要求 <code>owner_id</code> 等于当前登录用户，连查询也一样。<br>' +
    '· 原始附件与解析原文按敏感资料管理，默认私有；被遮挡、打码、裁切掉的姓名、证件、条码、票据号不会还原、猜测或补录。<br>' +
    '· 面向页面展示的正文与原始解析产物分层处理；数据概览只使用结构化结果、日期、类型和金额，不扫描完整正文里的指标或身份信息。<br>' +
    '· 附件授权地址是短时有效的凭据，不写进源码、日志或可分享的交付物。<br>' +
    '· 发布界面不等于公开医疗数据。若附件与数据权限不能独立生效，就不公开分享。' +
    '</div></div></div>';

  h += '</div></div>';
  host.innerHTML = h;
  var b = $('btnOpenImport');
  if (b) b.onclick = function () { openImportDrawer(null); };
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
    target = (hasDrug && !hasDoc) ? 'drugs' : 'health_records';
  }
  return { target: target, records: records };
}

var IMPORT = { payload: null, files: [], label: '' };

function openImportDrawer(target) {
  IMPORT = { payload: null, files: [], label: '' };
  S.drugArchiveTarget = target || null;
  var body = $('importBody');
  body.innerHTML =
    '<div class="field"><label>归档包（.json）<span class="req">*</span></label>' +
    '<input type="file" id="impJson" accept=".json,application/json">' +
    '<div class="hint">选择在对话中生成的脱敏归档包。包内含 <code>records</code> 数组时按多条写入。</div></div>' +
    '<div class="field"><label>原始文件（可选，可多选）</label>' +
    '<input type="file" id="impFiles" multiple>' +
    '<div class="hint">PDF / JPG / PNG / BMP / TIFF / WebP。会上传到你的私有目录；同一份报告的多页请一次选中，保持选择顺序。</div></div>' +
    '<div id="impPreview"></div>';
  $('impJson').onchange = async function () {
    var f = $('impJson').files[0];
    if (!f) { IMPORT.payload = null; renderImportPreview(); return; }
    try {
      var text = await f.text();
      var raw = JSON.parse(text);
      IMPORT.payload = normalizeArchivePayload(raw);
      IMPORT.label = f.name;
    } catch (e) {
      IMPORT.payload = { target: null, records: [], parseError: '归档包不是合法的 JSON，请检查文件内容。' };
      IMPORT.label = f.name;
    }
    renderImportPreview();
  };
  $('impFiles').onchange = function () { IMPORT.files = Array.prototype.slice.call($('impFiles').files); renderImportPreview(); };
  renderImportPreview();
  openDrawer('drawer-import');
}

function renderImportPreview() {
  var el = $('impPreview');
  if (!el) return;
  var p = IMPORT.payload;
  var h = '';
  if (!p) {
    h = '<div class="note">尚未选择归档包。</div>';
  } else if (p.parseError) {
    h = '<div class="err-bar">' + esc(p.parseError) + '</div>';
  } else {
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
          ' · ' + esc(nz(r.date_status) || '日期待确认') +
          ' · 检验结果 ' + cnt + ' 项 · 检查 ' + ex + ' 项' +
          ' · 金额 ' + esc(amt.value === null ? '未提供' : L.fmtMoney(amt.value)) +
          ' · 哈希 ' + esc(nz(r.file_hash) ? String(r.file_hash).slice(0, 12) + '…' : '未提供') + '</div></div>';
      }
    });
    if (IMPORT.files.length) {
      h += '<div class="note">将上传 ' + IMPORT.files.length + ' 个原始文件：' +
        IMPORT.files.map(function (f) { return esc(f.name); }).join('、') + '</div>';
    } else {
      h += '<div class="note">未选择原始文件：记录可以写入，但详情页会明确显示「原始文件未留存」，并允许随后补传。</div>';
    }
  }
  el.innerHTML = h;
}

async function doImport() {
  var btn = $('btnImportSave');
  var p = IMPORT.payload;
  if (!p || p.parseError || !p.records.length) {
    return setImportMsg('请先选择一个有效的归档包。', true);
  }
  var uid = S.session && S.session.user && S.session.user.id;
  if (!uid) return setImportMsg('登录状态已失效，请重新登录后再归档。', true);

  var tableName = p.target === 'drugs' ? 'drugs' : 'health_records';
  var rows = [];
  var skipped = [];
  var existing = bucket(tableName).rows;

  // 附件先上传，失败即中止，避免留下指向空文件的记录
  var uploaded = [];
  if (IMPORT.files.length) {
    btn.disabled = true;
    setImportMsg('正在上传原始文件…');
    try {
      for (var i = 0; i < IMPORT.files.length; i++) uploaded.push(await uploadOriginal(IMPORT.files[i], uid));
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

    var dupKey = row.file_hash
      ? existing.some(function (e) { return e.file_hash && e.file_hash === row.file_hash; })
      : (row.xparse_task_id ? existing.some(function (e) { return e.xparse_task_id && e.xparse_task_id === row.xparse_task_id; }) : false);
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
  IMPORT = { payload: null, files: [], label: '' };
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
  var all = bucket('health_records').rows;
  var f = S.archFilter;
  var docs = all.filter(function (r) {
    if (f.type && L.normalizeDocType(r.document_type) !== f.type) return false;
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
    '<div class="s"><div class="k">原始文件</div><div class="v num">' + files + '</div></div>' +
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
    '<button class="btn sm" id="arClear">清空筛选</button></div>';

  if (!docs.length) h += msg(all.length ? '没有符合筛选条件的档案。' : '还没有任何档案条目。');
  else {
    docs.forEach(function (r) {
      var atts = attachmentsOf(r);
      h += '<div class="arch-row" data-doc="' + attr(r.id) + '">' +
        '<span class="fi">' + (atts.length ? 'FILE' : '—') + '</span>' +
        '<span class="nm"><b>' + esc(nz(r.title) || '(无标题)') + '</b>' +
        '<div class="muted" style="font-size:11.5px">' +
        esc(nz(r.source_file) || '原始文件名未提供') + ' · ' +
        esc(nz(r.hospital) || '医院未提供') + ' · ' + esc(nz(r.document_type) || '类型未提供') +
        (r.xparse_task_id ? ' · 解析任务 ' + esc(String(r.xparse_task_id).slice(0, 10)) + '…' : '') +
        '</div></span>' +
        '<span class="mt">' + (nz(r.primary_date) && r.date_status !== '日期待确认' ? esc(L.fmtYearMonth(r.primary_date)) : '日期待确认') +
        ' · ' + atts.length + ' 个附件</span></div>';
    });
  }
  host.innerHTML = h;

  var q = $('arQ');
  if (q) q.oninput = function () { S.archFilter.q = q.value; renderArchive(); var e2 = $('arQ'); if (e2) { e2.focus(); e2.setSelectionRange(e2.value.length, e2.value.length); } };
  var t2 = $('arType'); if (t2) t2.onchange = function () { S.archFilter.type = t2.value; renderArchive(); };
  var c2 = $('arClear'); if (c2) c2.onclick = function () { S.archFilter = { q: '', type: '' }; renderArchive(); };
  qsa('#s-archive [data-doc]').forEach(function (row) {
    row.onclick = function () { openDoc(row.dataset.doc, '原始资料档案'); };
  });
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
    '<span class="tag' + (d.status === '正在服用' ? '' : ' gray') + '">' + esc(d.status || '备用药') + '</span></div>' +
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
  var all = bucket('drugs').rows;
  var cur = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'current'; });
  var res = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'reserve'; });
  var his = all.filter(function (d) { return L.drugStatusGroup(d.status) === 'history'; });
  var todayInUse = cur.filter(function (d) { return L.isInUseToday(d); });

  var h = '';
  h += '<div class="page-head"><h2>药品管理</h2>' +
    '<p>按当前用药、备用 / 药箱、历史用药三组管理。所有状态变更都会真实持久化，并追加到药品的状态事件历史里，不覆盖旧记录。</p></div>';
  h += '<div class="sync-strip sync-host"></div>';

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

function openFollowDrawer() {
  var cat = catalogList();
  var pts = allIndicatorPoints();
  $('followBody').innerHTML = '<div class="pick-list">' + cat.map(function (c) {
    var n = (pts[c.key] || []).length;
    return '<div class="pi"><input type="checkbox" data-follow="' + attr(c.key) + '"' + (c.followed ? ' checked' : '') + '>' +
      '<span class="info"><span class="n">' + esc(c.name) + '</span>' +
      '<span class="m">' + esc((c.grp || '') + ' · ' + (c.type || '') + (c.unit ? ' · ' + c.unit : '')) +
      '　已有 ' + n + ' 条结果</span></span></div>';
  }).join('') + '</div>' +
    '<div class="note">改变关注状态只影响这里的展示：添加关注不会新增检查次数，也不会创建任何结果；取消关注只隐藏关注入口，不删除目录，也不删除历史结果。</div>' +
    '<div class="df" style="border:0;padding:13px 0 0;justify-content:flex-start">' +
    '<button class="btn primary" id="btnFollowSave">保存关注设置</button></div>';

  $('btnFollowSave').onclick = async function () {
    var boxes = qsa('#followBody input[data-follow]');
    var changed = [];
    boxes.forEach(function (b) {
      var c = catalogByKey()[b.dataset.follow];
      if (c && !!c.followed !== b.checked) changed.push({ key: b.dataset.follow, followed: b.checked });
    });
    if (!changed.length) { closeDrawers(); return; }
    var btn = $('btnFollowSave');
    btn.disabled = true; btn.textContent = '保存中…';
    var failed = [];
    for (var i = 0; i < changed.length; i++) {
      var r = await cloud.database.from('indicator_catalog')
        .update({ followed: changed[i].followed }).eq('key', changed[i].key).select();
      if (r.error || !r.data || !r.data.length) failed.push(changed[i].key);
    }
    btn.disabled = false; btn.textContent = '保存关注设置';
    await loadTable('indicator_catalog', 'sort_order');
    if (failed.length) {
      alert('有 ' + failed.length + ' 项未保存成功，页面保持远端真实状态：' + failed.join('、'));
      return;
    }
    closeDrawers();
    renderCurrent();
  };
  openDrawer('drawer-follow');
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
    var res = await cloud.database.from('indicator_catalog').insert({
      name: name, key: key, grp: $('cusGroup').value, type: type,
      unit: unit || null, aliases: aliases, followed: $('cusFollow').value === 'yes',
      sort_order: 900, preset: false
    }).select();
    btn.disabled = false; btn.textContent = '保存指标';
    if (res.error) {
      if (res.error.code === '23505') return alert('该指标名称对应的标准键已存在，请换一个名称或直接使用已有指标。');
      return alert('保存失败：' + res.error.message);
    }
    await loadTable('indicator_catalog', 'sort_order');
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
    var row = {
      indicator_key: useKey, name: useCat.name || useKey, record_date: date, type: type,
      value1: v1, value2: v2, text_result: text, unit: unit || null,
      condition: $('dyCond').value.trim() || null,
      review: $('dyReview').value, note: $('dyNote').value.trim() || null, source: '手动录入'
    };
    var btn = $('btnDailySave');
    btn.disabled = true; btn.textContent = '保存中…';
    var res = await cloud.database.from('daily_indicator_records').insert(row).select();
    if (res.error || !res.data || !res.data.length) {
      btn.disabled = false; btn.textContent = '保存记录';
      return alert('保存失败：' + (res.error ? res.error.message : '服务端没有返回记录') + '。表单内容已保留。');
    }
    var newId = res.data[0].id;
    await loadTable('daily_indicator_records', 'record_date');
    var back = bucket('daily_indicator_records').rows.filter(function (r) { return r.id === newId; });
    btn.disabled = false; btn.textContent = '保存记录';
    if (!back.length) return alert('写入已返回，但回读未命中该记录，请刷新后核对。');
    closeDrawers();
    renderCurrent();
    if (S.layerStack.indexOf('indLayer') >= 0) openIndicator(S.indCtx ? S.indCtx.key : useKey, S.indCtx ? S.indCtx.from : '数据概览', true);
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

function openDoc(id, fromLabel) {
  var rec = bucket('health_records').rows.filter(function (r) { return String(r.id) === String(id); })[0];
  if (!rec) return;
  S.docFrom = fromLabel || '健康档案';
  $('docBackLabel').textContent = '返回' + S.docFrom;
  $('docTitle').textContent = nz(rec.title) || '(无标题)';
  $('docTypeTag').textContent = L.normalizeDocType(rec.document_type);
  renderDocBody(rec);
  openLayer('docLayer');
  pushHistory('docLayer');
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
    '<span class="sub">主键 #' + esc(rec.id) + '</span></div><div class="card-b">' +
    '<dl class="kv">' +
    '<dt>文档类型</dt><dd>' + dash(rec.document_type) + '</dd>' +
    '<dt>主要日期</dt><dd>' + (nz(rec.primary_date) ? esc(L.fmtCN(rec.primary_date)) : '未提供') +
    ' <span class="tag' + (rec.date_status === '已确认' ? '' : ' gray') + '">' + esc(rec.date_status || '日期待确认') + '</span></dd>' +
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
    '</dl></div></div>';

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
      var uid = S.session && S.session.user && S.session.user.id;
      try {
        var added = [];
        for (var i = 0; i < files.length; i++) added.push(await uploadOriginal(files[i], uid));
        var next = attachmentsOf(rec).concat(added);
        var res = await cloud.database.from('health_records')
          .update({ source_attachments: next }).eq('id', rec.id).select();
        if (res.error || !res.data || !res.data.length) throw new Error(res.error ? res.error.message : '该记录不在你的权限范围内');
        await loadTable('health_records', 'primary_date');
        var back = bucket('health_records').rows.filter(function (r) { return String(r.id) === String(rec.id); })[0];
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
    } else if (/\.(docx?|xlsx?|pptx?)$/i.test(name)) {
      stage.innerHTML = '<div style="text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8">' +
        'Word / Excel 类文件无法在浏览器中直接内嵌预览。<br>' +
        '<span style="font-size:11.5px;color:#93a1b1">请使用下方「下载原文件」在本机打开；这里不会把它塞进图片标签强行显示。</span></div>';
    } else {
      stage.innerHTML = '<div style="text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8">' +
        '该类型没有可用的内嵌预览。<br><span style="font-size:11.5px;color:#93a1b1">可下载原文件后在本机查看。</span></div>';
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
    var labels = { height_cm: '身高', weight_kg: '体重', bmi: '体重指数', systolic_mmHg: '收缩压', diastolic_mmHg: '舒张压', pulse_bpm: '脉搏' };
    h += '<div class="card"><div class="card-h"><h3>一般检查</h3><span class="sub">原文照录</span></div><div class="card-b">' +
      '<dl class="kv" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr)">' +
      Object.keys(ge).filter(function (k) { return labels[k] && nz(ge[k]); }).map(function (k) {
        return '<dt>' + esc(labels[k]) + '</dt><dd class="num">' + esc(ge[k]) + '</dd>';
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
          var flag = nz(r.flag);
          var rendered = (flag && /^[\u2191\u2193]$/.test(String(flag).trim())) ? String(flag).trim()
            : (flag ? esc(flag) + ' <span class="muted" style="font-size:11px">（原文标记，识别不清时保留原样）</span>' : '');
          return '<tr><td>' + esc(r.name) + '</td>' +
            '<td class="num"><b>' + esc(r.result === null || r.result === undefined ? '' : r.result) + '</b>' +
            (r.condition ? '<div class="muted" style="font-size:11px">' + esc(r.condition) + '</div>' : '') + '</td>' +
            '<td class="muted">' + esc(r.unit || '未提供') + '</td>' +
            '<td class="ref">' + esc(r.reference || '未提供') + '</td>' +
            '<td class="flag">' + rendered + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    });
    h += '<div class="note">本表按原报告逐项照录。结果与参考范围之间的大小关系不会被系统转成异常 / 正常标签；原报告未印出的箭头不会出现。</div>';
    h += '</div></div>';
  }

  // 检查所见与报告意见
  if (exams.length) {
    h += '<div class="card"><div class="card-h"><h3>检查所见与报告意见</h3><span class="sub">共 ' + exams.length + ' 项</span></div><div class="card-b">';
    exams.forEach(function (e) {
      h += '<div style="margin-bottom:16px"><div class="sec-t">' + esc(e.exam_name || '检查项目') + '</div>' +
        '<dl class="kv" style="grid-template-columns:82px minmax(0,1fr)">' +
        '<dt>检查方法</dt><dd>' + dash(e.exam_method) + '</dd>' +
        '<dt>临床资料</dt><dd>' + dash(e.clinical_info) + '</dd>' +
        '<dt>检查所见</dt><dd>' + (Array.isArray(e.findings) && e.findings.length
          ? e.findings.map(function (f) { return '<div class="src-block">' + esc(f) + '</div>'; }).join('')
          : '<span class="muted">原报告未提供</span>') + '</dd>' +
        '<dt>报告意见</dt><dd>' + (Array.isArray(e.impression) && e.impression.length
          ? e.impression.map(function (f) { return '<div class="src-block">' + esc(f) + '</div>'; }).join('')
          : '<span class="muted">原报告未提供</span>') + '</dd>' +
        (e.source_note ? '<dt></dt><dd class="muted" style="font-size:11.5px">' + esc(e.source_note) + '</dd>' : '') +
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
          return '<tr><td>' + esc(i.name || i.item || '') + '</td>' +
            '<td class="num">' + esc(nz(i.unit_price) || '未提供') + '</td>' +
            '<td class="num">' + esc(nz(i.qty) || '未提供') + '</td>' +
            '<td class="num">' + esc(nz(i.amount) || '未提供') + '</td>' +
            '<td class="muted">' + esc(nz(i.insurance_type) || '未提供') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      h += '<div class="note" style="margin:0">原资料没有逐项收费明细；这不影响保留明确的总额与支付拆分。</div>';
    }
    h += '<dl class="kv" style="grid-template-columns:100px minmax(0,1fr) 100px minmax(0,1fr);margin-top:13px">' +
      '<dt>总金额</dt><dd>' + (function () { var a = L.receiptAmount(rec); return a.value === null ? '<span class="muted">未提供</span>' : L.fmtMoney(a.value); })() + '</dd>' +
      '<dt>医保支付</dt><dd>' + (tsd.insurance_payment === undefined || tsd.insurance_payment === null ? '<span class="muted">未提供</span>' : esc(tsd.insurance_payment)) + '</dd>' +
      '<dt>个人支付</dt><dd>' + (tsd.self_payment === undefined || tsd.self_payment === null ? '<span class="muted">未提供</span>' : esc(tsd.self_payment)) + '</dd>' +
      '<dt>大写金额</dt><dd>' + dash(tsd.amount_in_words) + '</dd>' +
      '<dt>结算时间</dt><dd>' + dash(tsd.settle_time) + '</dd>' +
      '<dt>支付方式</dt><dd>' + dash(tsd.payment_method) + '</dd>' +
      '</dl>';
    h += '<div class="note">收费单只能说明收费项目和金额，不能据此推断确诊疾病、检查所见、治疗实施或服药事实。</div>';
    h += '</div></div>';
  }

  // 原报告结论（原文照录）
  if (Array.isArray(tsd.final_conclusion) && tsd.final_conclusion.length) {
    h += '<div class="card"><div class="card-h"><h3>原报告结论</h3><span class="sub">原文照录，非系统判断</span></div><div class="card-b">' +
      tsd.final_conclusion.map(function (c) { return '<div class="src-block">' + esc(c) + '</div>'; }).join('') +
      (tsd.conclusion_note ? '<div class="note">' + esc(tsd.conclusion_note) + '</div>' : '') +
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
  else { $('drugLayer').classList.add('on'); if (S.layerStack.indexOf('drugLayer') < 0) { S.layerStack.push('drugLayer'); document.body.style.overflow = 'hidden'; } }
}

/* ---------------- 18. 指标详情 ---------------- */

function openIndicator(key, fromLabel, keep) {
  S.indCtx = { key: key, from: fromLabel || '数据概览' };
  $('indBackLabel').textContent = '返回' + S.indCtx.from;
  var c = catalogByKey()[key] || { key: key, name: key, type: '数值', grp: '未归类', unit: '' };
  $('indTitle').textContent = c.name;
  var pts = allIndicatorPoints();
  var list = pts[key] || [];
  var h = '';

  h += '<div class="card" style="margin-bottom:14px"><div class="card-b" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;justify-content:space-between">' +
    '<dl class="kv" style="grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0">' +
    '<dt>所属分组</dt><dd>' + esc(c.grp || '未归类') + '</dd>' +
    '<dt>记录类型</dt><dd>' + esc(c.type || '数值') + '</dd>' +
    '<dt>默认单位</dt><dd>' + (nz(c.unit) ? esc(c.unit) : '<span class="muted">未提供</span>') + '</dd>' +
    '<dt>关注状态</dt><dd>' + (c.followed ? '已关注' : '未关注') + '</dd>' +
    '</dl>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<div class="range-tabs" id="indRange">' + ['3', '12', 'all'].map(function (r) {
      return '<button data-range="' + r + '" class="' + (S.range === r ? 'on' : '') + '">' +
        (r === '3' ? '近 3 个月' : r === '12' ? '近 12 个月' : '全部') + '</button>';
    }).join('') + '</div>' +
    '<button class="btn sm primary" data-ind-daily="' + attr(key) + '">录入日常结果</button>' +
    '</div></div></div>';

  if (!list.length) {
    h += '<div class="card"><div class="card-b">' + msg('暂无记录。这里不会初始化虚构检查值；可以用「录入日常结果」添加你自己的真实测量值。') + '</div></div>';
  } else {
    h += renderIndicatorCharts(key, c, list);
    h += renderPointHistory(key, c, list);
  }
  $('indBody').innerHTML = h;

  qsa('#indRange button').forEach(function (b) {
    b.onclick = function () { S.range = b.dataset.range; openIndicator(key, S.indCtx.from, true); };
  });
  qsa('#indBody [data-ind-daily]').forEach(function (b) {
    b.onclick = function () { openDailyDrawer(b.dataset.indDaily, null); };
  });
  qsa('#indBody [data-src-doc]').forEach(function (b) {
    b.onclick = function () { openDoc(b.dataset.srcDoc, '指标详情'); };
  });

  if (!keep) { openLayer('indLayer'); pushHistory('indLayer'); }
  else { $('indLayer').classList.add('on'); if (S.layerStack.indexOf('indLayer') < 0) { S.layerStack.push('indLayer'); document.body.style.overflow = 'hidden'; } }
}

function renderIndicatorCharts(key, c, list) {
  var scoped = filterPointsByRange(list);
  var h = '';
  var cat = c;

  if (key === 'lipids') {
    var pts = allIndicatorPoints();
    var byKey = { tc: filterPointsByRange(pts.tc || []), tg: filterPointsByRange(pts.tg || []), hdl: filterPointsByRange(pts.hdl || []), ldl: filterPointsByRange(pts.ldl || []) };
    var lip = L.lipidSummary(byKey);
    h += '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>血脂四项</h3>' +
      '<span class="sub">按有效报告日期去重的检查次数：' + lip.checkCount + '</span></div><div class="card-b">' +
      '<div class="note" style="margin:0 0 12px">' + esc(lip.note) + '</div>';
    ['tc', 'tg', 'hdl', 'ldl'].forEach(function (k) {
      var sub = catalogByKey()[k] || { name: k, unit: 'mmol/L', analyze: null };
      var tr = L.buildTrend(byKey[k], { analyze: sub.analyze });
      h += '<div class="sec-t">' + esc(sub.name) + '　<span class="muted" style="font-weight:400">结果记录数 ' + tr.connected.length + '；有效日期 ' + tr.distinctDates.length + ' 个</span></div>';
      h += '<div class="chart-wrap" style="margin-bottom:14px">' +
        (tr.enough
          ? lineChart({
            series: [{ name: sub.name, color: '#2d77c9', points: tr.connected.map(function (p) {
              return { date: p.date, value: p.normValue, unit: p.normUnit, extra: (p.condition || '条件未标注') + ' · ' + p.source };
            }) }],
            decimals: 2
          })
          : msg('可比较的有效日期点不足 2 个，未绘制趋势线。' + (tr.connected.length ? '已有 1 个点，可继续录入或归档新报告。' : '尚无有效数据点。'))) +
        trendNotes(tr) + '</div>';
    });
    h += '<div class="note">四个分项分别成图，不串成同一条线；同一日期的四项结果不会被显示为四次检查。</div>';
    h += '</div></div>';
    return h;
  }

  if (key === 'ogtt_glu' || key === 'ogtt_ins') {
    var og = L.buildOGTT(filterPointsByRange(list), c.ogtt);
    h += '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>OGTT 同次试验曲线</h3>' +
      '<span class="sub">有有效日期的试验次数：' + og.trialCount + '</span></div><div class="card-b">';
    if (!og.trials.length) {
      h += msg('暂无带有效日期的 OGTT 结果。无日期的结果保留在下方历史中，不计正式试验次数、不参与曲线。');
    } else {
      h += '<div class="note" style="margin:0 0 12px">只连接同次试验的有效数值点；缺项不补零、不插值。同日多份独立试验按来源隔离，不会混成一条五点曲线。</div>';
      og.trials.forEach(function (t) {
        h += '<div class="chart-wrap" style="margin-bottom:14px">' +
          '<div class="chart-legend"><span class="lg"><i class="sw"></i>' + esc(t.label || '试验') + '</span>' +
          '<span class="muted" style="font-size:11.5px">来源：' + esc(t.sourceTitle || '已归档记录') +
          '　试验标识 ' + esc(String(t.trialKey)) + '</span>' +
          (nz(t.sourceRecordId) ? ' <button class="btn sm" data-src-doc="' + attr(t.sourceRecordId) + '">查看报告来源</button>' : '') + '</div>' +
          ogttCurve(t) +
          (t.missing.length ? '<div class="chart-tip">缺项时点：' + esc(t.missing.join('、')) + '。缺项不补零。</div>' : '') +
          '</div>';
      });
      // 相同时点跨年度趋势
      h += '<div class="card-h" style="padding:0;border:0;margin:8px 0 10px"><h3>相同时点跨年度趋势</h3></div>';
      og.order.forEach(function (o) {
        var arr = og.byTimepoint[o.minutes] || [];
        h += '<div class="sec-t">' + esc(o.label) + '　<span class="muted" style="font-weight:400">' + arr.length + ' 个日期点</span></div>';
        if (arr.length >= 2) {
          h += '<div class="chart-wrap" style="margin-bottom:14px">' + lineChart({
            series: [{ name: o.label, color: '#2d77c9', points: arr.map(function (p) {
              return { date: p.date, value: p.value, unit: p.unit, extra: p.sourceTitle || '' };
            }) }], decimals: 2
          }) + '</div>';
        } else {
          h += '<div class="note">该时点不足 2 个有效日期点，未绘制趋势线。</div>';
        }
      });
      h += '<div class="note">同次曲线与跨年度趋势是两类不同的图：前者按空腹 → 30 → 60 → 120 → 180 分钟展示单次试验，后者只比较同一时点在不同日期的结果，不把不同条件串在一起。</div>';
    }
    if (og.undated.length) {
      h += '<div class="note">另有 ' + og.undated.length + ' 条无有效日期的 OGTT 结果，保留在下方历史中，不计正式试验次数。</div>';
    }
    h += '</div></div>';
    return h;
  }

  if (c.type === '双数值' || /血压/.test(c.name || '')) {
    var bp = L.buildBPtrend(filterPointsByRange(list));
    h += '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>血压趋势</h3>' +
      '<span class="sub">收缩压 / 舒张压双线，同一纵轴</span></div><div class="card-b">';
    if (!bp.enough) {
      h += msg('可比较的有效日期点不足 2 个，未绘制趋势线。');
    } else if (bp.unitNote) {
      h += '<div class="err-bar">' + esc(bp.unitNote) + '</div>';
    } else {
      h += lineChart({
        series: [
          { name: '收缩压', color: '#1f5fa9', points: bp.systolic.map(function (p) { return { date: p.date, value: p.value, unit: p.unit, extra: p.source + (p.condition ? ' · ' + p.condition : '') }; }) },
          { name: '舒张压', color: '#2d77c9', dash: true, points: bp.diastolic.map(function (p) { return { date: p.date, value: p.value, unit: p.unit, extra: p.source + (p.condition ? ' · ' + p.condition : '') }; }) }
        ],
        decimals: 0, unit: 'mmHg'
      });
      h += '<div class="chart-tip">两条线共用同一个纵轴范围与图例，不会把收缩压与舒张压接成一条线。单位不一致的记录不合并到同一纵轴。</div>';
    }
    h += '</div></div>';
    h += renderPointHistory('bp', c, list);
    return h;
  }

  var tr = L.buildTrend(filterPointsByRange(list), { analyze: c.analyze });
  h += '<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>日期趋势</h3>' +
    '<span class="sub">' + esc(tr.connected.length ? (tr.connected.length + ' 个有效点') : '暂无有效点') + '</span></div><div class="card-b">';
  if (!tr.enough) {
    h += msg(tr.connected.length ? '可比较的有效日期点不足 2 个，未绘制趋势线。已有 ' + tr.connected.length + ' 个点。' : '暂无带有效日期的数值结果。');
  } else if (tr.tie) {
    h += '<div class="err-bar">存在不可比较的单位组且数量持平，未选择任一组连线；全部记录保留在下方历史中。</div>';
  } else {
    h += lineChart({
      series: [{ name: c.name, color: '#2d77c9', points: tr.connected.map(function (p) {
        return { date: p.date, value: p.normValue, unit: p.normUnit, extra: (p.condition ? p.condition + ' · ' : '') + p.source };
      }) }],
      decimals: 2, unit: tr.lineUnit
    });
    if (tr.lineUnit) h += '<div class="chart-tip">连线单位：' + esc(tr.lineUnit) + '。换算只发生在展示层：原值与原始记录未被改写。</div>';
  }
  h += trendNotes(tr) + '</div></div>';
  h += renderPointHistory(key, c, list);
  return h;
}

function ogttCurve(t) {
  var W = 660, H = 200, PL = 52, PR = 18, PT = 14, PB = 34;
  var iw = W - PL - PR, ih = H - PT - PB;
  var order = L.OGTT_ORDER;
  var vals = t.curvePoints.map(function (p) { return p.value; });
  if (!vals.length) return msg('本次试验没有可绘制的精确数值点。');
  var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  var pad = (vmax - vmin) * 0.15; vmin -= pad; vmax += pad;
  function X(i) { return PL + (order.length <= 1 ? iw / 2 : i * iw / (order.length - 1)); }
  function Y(v) { return PT + ih - ((v - vmin) / (vmax - vmin)) * ih; }
  var grid = '';
  for (var g = 0; g <= 4; g++) {
    var yy = PT + ih - (g * ih / 4), val = vmin + (vmax - vmin) * g / 4;
    grid += '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1) + '" stroke="#eef1f5"/>' +
      '<text x="' + (PL - 7) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a94a3">' + val.toFixed(2) + '</text>';
  }
  var seq = t.curvePoints.slice().sort(function (a, b) { return a.timepoint - b.timepoint; });
  var path = seq.map(function (p, i) {
    return (i ? 'L' : 'M') + X(order.findIndex(function (o) { return o.minutes === p.timepoint; })).toFixed(1) + ' ' + Y(p.value).toFixed(1);
  }).join(' ');
  var dots = seq.map(function (p) {
    var idx = order.findIndex(function (o) { return o.minutes === p.timepoint; });
    return '<circle cx="' + X(idx).toFixed(1) + '" cy="' + Y(p.value).toFixed(1) + '" r="4" fill="#fff" stroke="#2d77c9" stroke-width="2">' +
      '<title>' + esc(p.label + ' · ' + p.value + ' ' + (p.unit || '') + '（原结果 ' + (p.raw || '') + '）') + '</title></circle>';
  }).join('');
  var labs = order.map(function (o, i) {
    return '<text x="' + X(i).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="10" fill="#55606f">' + esc(o.label) + '</text>';
  }).join('');
  return '<div class="tbl-scroll"><svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="OGTT 曲线" style="min-width:520px">' +
    grid + '<path d="' + path + '" fill="none" stroke="#2d77c9" stroke-width="2"/>' + dots + labs + '</svg></div>';
}

function trendNotes(tr) {
  if (!tr.notes || !tr.notes.length) return '';
  return '<div class="chart-tip">' + tr.notes.map(esc).join('<br>') + '</div>';
}

function renderPointHistory(key, c, list) {
  var rows = list.slice().sort(function (a, b) {
    var da = L.dateSortKey(a.date), db = L.dateSortKey(b.date);
    if (da && db) return da < db ? 1 : (da > db ? -1 : 0);
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
  var h = '<div class="card"><div class="card-h"><h3>历史记录</h3>' +
    '<span class="sub">共 ' + rows.length + ' 条，含不参与连线的记录</span></div><div class="card-b">';
  if (!rows.length) { h += msg('暂无历史记录。'); h += '</div></div>'; return h; }
  h += '<div class="point-list">' + rows.map(function (p) {
    var d = L.dateSortKey(p.date);
    var norm = (p.value !== null && p.value !== undefined)
      ? L.normalizeForDisplay(c.analyze, p.value, p.unit) : null;
    var valTxt = norm
      ? (norm.value + ' ' + (norm.unit || '') + (norm.conversionApplied
        ? ' <span class="orig">（原值 ' + esc(norm.originalValue + ' ' + norm.originalUnit) + '）</span>' : ''))
      : (nz(p.result) ? esc(p.result) + ' <span class="orig">（定性结果，不绘制普通趋势）</span>' : '未提供');
    return '<div class="pr">' +
      '<span class="dt">' + (d ? esc(L.fmtCN(d)) : '<span class="muted">日期待确认</span>') + '</span>' +
      '<span class="va">' + valTxt + '</span>' +
      '<span class="src-chip' + (p.source === '报告提取' ? ' report' : '') + '">' + esc(p.source) + '</span>' +
      (p.condition ? '<span class="muted" style="font-size:11.5px">条件：' + esc(p.condition) + '</span>' : '') +
      (p.reference ? '<span class="muted" style="font-size:11.5px">原参考范围：' + esc(p.reference) + '</span>' : '') +
      (p.flag ? '<span class="flag" style="color:#1f5fa9;font-weight:640">' + esc(p.flag) + '</span>' : '') +
      (p.review && p.review !== '已核对' ? '<span class="src-chip">' + esc(p.review) + '</span>' : '') +
      (p.sourceRecordId ? '<button class="btn sm ghost" data-src-doc="' + attr(p.sourceRecordId) + '">来源</button>' : '') +
      (!d ? '<span class="muted" style="font-size:11.5px">不参与连线</span>' : '') +
      '</div>';
  }).join('') + '</div>';
  h += '<div class="note">历史记录显示原参考范围与原报告标记；趋势不会重新计算医学异常状态，也不生成异常 / 正常标签。</div>';
  h += '</div></div>';
  return h;
}

/* ---------------- 19. 全部票据来源 ---------------- */

function openReceipts() {
  renderReceipts();
  openLayer('rcLayer');
  pushHistory('rcLayer');
}

function renderReceipts() {
  var fees = L.buildFees(bucket('health_records').rows);
  var h = '';
  h += '<div class="card" style="margin-bottom:14px"><div class="card-b">' +
    '<div class="kv" style="grid-template-columns:118px minmax(0,1fr)">' +
    '<dt>明确金额总额</dt><dd><b class="num">' + esc(fees.total) + '</b>　' + fees.counts.known + ' 张</dd>' +
    '<dt>医保支付</dt><dd>' + esc(fees.insurance) + (fees.insuranceMissing ? ' <span class="muted">（' + fees.insuranceMissing + ' 张未提供）</span>' : '') + '</dd>' +
    '<dt>个人支付</dt><dd>' + esc(fees.selfPay) + (fees.selfMissing ? ' <span class="muted">（' + fees.selfMissing + ' 张未提供）</span>' : '') + '</dd>' +
    '</div>' +
    (fees.gapNote ? '<div class="note">' + esc(fees.gapNote) + '</div>' : '') +
    '<div class="note">未知金额（null、缺失、空串、不可解析）不参与合计；明确零金额是真实数字 0，按有效日期参与年度张数。本列表不是只取第一页，超过单页容量会完整分页读取。</div>' +
    '</div></div>';

  if (!fees.list.length) {
    h += '<div class="card"><div class="card-b">' + msg('还没有医疗发票 / 收费单记录。费用入口会先进入本列表，不会默认打开某一张票据。') + '</div></div>';
    $('rcBody').innerHTML = h;
    return;
  }

  var groups = {};
  var pending = [];
  fees.list.forEach(function (r) {
    var d = L.dateSortKey(r.date);
    if (!d) { pending.push(r); return; }
    var y = d.slice(0, 4);
    (groups[y] = groups[y] || []).push(r);
  });

  Object.keys(groups).sort().reverse().forEach(function (y) {
    var rows = groups[y];
    var cents = rows.reduce(function (s, r) { return s + (r.amountCents === null ? 0 : r.amountCents); }, 0);
    var known = rows.filter(function (r) { return r.amountCents !== null; }).length;
    var unknown = rows.length - known;
    h += '<div class="receipt-grp"><div class="rh"><span class="rl">' + esc(y) + ' 年</span>' +
      '<span class="rr">' + rows.length + ' 张';
    if (unknown) h += '（明确金额 ' + known + ' 张，金额未知 ' + unknown + ' 张未计入）';
    h += '　合计 ' + esc(L.fmtMoney(cents)) + '</span></div>';
    rows.sort(function (a, b) { return (L.dateSortKey(a.date) || '') < (L.dateSortKey(b.date) || '') ? 1 : -1; });
    h += rows.map(receiptRow).join('') + '</div>';
  });

  if (pending.length) {
    h += '<div class="receipt-grp"><div class="rh"><span class="rl">日期待确认</span>' +
      '<span class="rr">' + pending.length + ' 张　金额计入总额但不进入年度图</span></div>';
    h += pending.map(receiptRow).join('') + '</div>';
  }
  h += '<div class="note">点击任意一行进入该张票据的收费明细与原始文件。返回会回到本列表原来的位置，再返回回到数据概览原来的位置。</div>';

  $('rcBody').innerHTML = h;
  qsa('#rcBody [data-rc-doc]').forEach(function (r) {
    r.onclick = function () { openDoc(r.dataset.rcDoc, '票据来源'); };
  });
}

function receiptRow(r) {
  var unknown = r.amountCents === null;
  return '<div class="rc-row" data-rc-doc="' + attr(r.recordId) + '">' +
    '<span class="d">' + (L.dateSortKey(r.date) ? esc(L.fmtCNShort(r.date)) : '日期待确认') + '</span>' +
    '<span class="nm">' + esc(nz(r.title) || '(无标题)') + '</span>' +
    '<span class="hosp">' + esc(nz(r.hospital) || '医院未提供') + '</span>' +
    '<span class="amt num' + (unknown ? ' unknown' : '') + '">' + (unknown ? '金额未知' : esc(L.fmtMoney(r.amountCents))) + '</span></div>';
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
  bindAuth();
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

  try { history.replaceState({ view: 'overview' }, '', location.pathname + location.search); } catch (e) { }

  cloud.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_OUT') {
      S.session = null;
      closeDrawers(); closeAllLayers();
      $('app').classList.add('hidden');
      $('authScreen').classList.remove('hidden');
    }
  });

  cloud.auth.getSession().then(function (r) {
    if (r.data) { afterLogin(); }
    else {
      $('authScreen').classList.remove('hidden');
      $('app').classList.add('hidden');
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
