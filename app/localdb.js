/* ============================================================
   个人健康档案工作台 · 本地数据层（localdb.js）
   ------------------------------------------------------------
   数据全部存放在浏览器的 IndexedDB 里，不上传到任何服务器：
     · 四张表：documents / drugs / indicators / manual_records
     · 附件：原始文件以 Blob 形式存进 files 存储，读取时生成本地对象地址

   结构：
     A. pure      纯逻辑（过滤/排序/分页/主键分配/备份载荷校验），可在 Node 单测
     B. idbDriver IndexedDB 驱动
     C. memoryDriver 内存驱动（同一接口，供自动化测试使用）
     D. createLocal  对外门面，签名与云端 SDK 一致
        因此 app.js 的数据访问代码无需改写，只把 cloud 换成这里的实现。

   解析（xParse）仍需联网，由「对话」或本地服务完成；本页不伪造解析调用。
   ============================================================ */
(function (global) {
'use strict';

var DB_NAME = 'health_records_local';
var DB_VERSION = 1;
var TABLES = ['documents', 'drugs', 'indicators', 'manual_records'];
// 恢复（导入备份）时的落地顺序：指标目录必须先于档案。
// 档案里的检验项要靠「别名 → 指标 id」落到观测值上；目录还没进库时会临时新建一批
// 指标，随后又被备份里的目录覆盖，观测值就挂到了不存在的指标上 —— 详情页整张检验表消失。
var RESTORE_ORDER = ['indicators', 'documents', 'drugs', 'manual_records'];
var FILE_STORE = 'files';
var LOCAL_OWNER = 'local-user';
var BACKUP_SCHEMA = 'health-records-local-backup/v2';

/* ============================================================
   A. 纯逻辑
   ============================================================ */

function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

// 数值按数值比，其余按字符串比；日期为 YYYY-MM-DD，字符串序即时间序
function cmpValue(a, b) {
  var sa = String(a), sb = String(b);
  var na = Number(sa), nb = Number(sb);
  if (sa !== '' && sb !== '' && !isNaN(na) && !isNaN(nb)) {
    return na === nb ? 0 : (na < nb ? -1 : 1);
  }
  return sa === sb ? 0 : (sa < sb ? -1 : 1);
}

// 排序：空值恒排末尾（无论升降序），避免「未提供日期」跑到最新位置
function sortRows(rows, order) {
  var col = order.col, asc = order.ascending !== false;
  return rows.slice().sort(function (a, b) {
    var va = a ? a[col] : null, vb = b ? b[col] : null;
    var ba = isBlank(va), bb = isBlank(vb);
    if (ba && bb) return 0;
    if (ba) return 1;
    if (bb) return -1;
    var c = cmpValue(va, vb);
    return asc ? c : -c;
  });
}

// 等值过滤按字符串比较，避免 '1' 与 1 被判为不相等
function filterRows(rows, filters) {
  if (!filters || !filters.length) return (rows || []).slice();
  return (rows || []).filter(function (r) {
    return filters.every(function (f) { return r && String(r[f.col]) === String(f.val); });
  });
}

function applyQuery(rows, q) {
  var out = filterRows(rows, q && q.filters);
  if (q && q.order) out = sortRows(out, q.order);
  if (q && q.range) out = out.slice(q.range[0], q.range[1] + 1);
  return out;
}

function maxId(rows) {
  var m = 0;
  (rows || []).forEach(function (r) {
    var n = Number(r && r.id);
    if (!isNaN(n) && n > m) m = n;
  });
  return m;
}

// 对齐数据库的 NOT NULL 默认值；本地不做约束校验，但保持字段形态一致
var DEFAULTS = {
  documents: { date_status: '已确认', source_attachments: [], type_specific_data: {}, parse_status: '待解析' },
  drugs: { status: '备用药', history: [], has_conflict: false, source_attachments: [] },
  indicators: { aliases: [], followed: false, sort_order: 0, preset: false },
  manual_records: { source: '手动录入' }
};

// 模拟服务端行为：分配自增主键、补默认值、写时间戳，其余值原样保留
function prepareInsert(table, existingRows, incoming, at) {
  var list = Array.isArray(incoming) ? incoming : [incoming];
  var id = maxId(existingRows);
  var defs = DEFAULTS[table] || {};
  var stamp = at || new Date().toISOString();
  return list.map(function (raw) {
    // 深拷贝：写入的行与调用方持有的对象解耦，避免后续改动互相影响（与云端语义一致）
    var row = clone(raw || {});
    id += 1;
    row.id = id;
    if (isBlank(row.owner_id)) row.owner_id = LOCAL_OWNER;
    Object.keys(defs).forEach(function (k) {
      if (row[k] === undefined || row[k] === null) {
        var d = defs[k];
        row[k] = (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d;
      }
    });
    if (!row.created_at) row.created_at = stamp;
    if (!row.updated_at) row.updated_at = stamp;
    return row;
  });
}

// 就地修改命中的行并返回它们，便于缓存与存储层共用同一份数据
function applyUpdate(rows, patch, filters, at) {
  var stamp = at || new Date().toISOString();
  var changed = [];
  (rows || []).forEach(function (r) {
    var hit = !filters || !filters.length || filters.every(function (f) {
      return r && String(r[f.col]) === String(f.val);
    });
    if (!hit) return;
    Object.assign(r, patch || {});
    r.updated_at = stamp;
    changed.push(r);
  });
  return changed;
}

function applyDelete(rows, filters) {
  var kept = [], removed = [];
  (rows || []).forEach(function (r) {
    var hit = !filters || !filters.length || filters.every(function (f) {
      return r && String(r[f.col]) === String(f.val);
    });
    if (hit) removed.push(r); else kept.push(r);
  });
  return { kept: kept, removed: removed };
}

/* ---------------- 备份载荷 ---------------- */

function buildBackup(tables, files, exportedAt) {
  var t = {}, counts = {};
  TABLES.forEach(function (n) {
    t[n] = (tables && Array.isArray(tables[n])) ? tables[n] : [];
    counts[n] = t[n].length;
  });
  return {
    schema: BACKUP_SCHEMA,
    app: '个人健康档案工作台（本地版）',
    exported_at: exportedAt || new Date().toISOString(),
    note: '本文件包含四张表的全部记录与全部原始附件（附件以 base64 内嵌）。' +
          '它等同于本机的全部健康数据，请按敏感资料保管，不要随意分享或上传。',
    counts: counts,
    file_count: (files || []).length,
    tables: t,
    files: files || []
  };
}

function validateBackup(obj) {
  var errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['文件不是有效的 JSON 对象'], tables: {}, files: [] };
  }
  if (obj.schema !== BACKUP_SCHEMA) {
    errors.push('备份格式不匹配：期望 ' + BACKUP_SCHEMA + '，实际 ' + String(obj.schema || '（缺失）'));
  }
  var tables = {}, files = [];
  TABLES.forEach(function (n) {
    var v = obj.tables ? obj.tables[n] : null;
    if (v === undefined || v === null) { tables[n] = []; return; }
    if (!Array.isArray(v)) { errors.push('表 ' + n + ' 不是数组'); tables[n] = []; return; }
    tables[n] = v;
  });
  if (obj.files !== undefined && obj.files !== null) {
    if (!Array.isArray(obj.files)) errors.push('files 不是数组');
    else {
      obj.files.forEach(function (f, i) {
        if (!f || isBlank(f.path)) { errors.push('附件 #' + (i + 1) + ' 缺少 path'); return; }
        if (isBlank(f.dataBase64)) { errors.push('附件 ' + f.path + ' 缺少数据'); return; }
        files.push(f);
      });
    }
  }
  return { ok: errors.length === 0, errors: errors, tables: tables, files: files };
}

function formatBytes(n) {
  var v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ============================================================
   B. 驱动
   ============================================================ */

function hasIDB() {
  try { return !!(global.indexedDB && global.IDBKeyRange); } catch (e) { return false; }
}

function reqP(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function txDone(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error || new Error('本地数据库事务被中止')); };
  });
}

var _dbp = null;
function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise(function (resolve, reject) {
    if (!hasIDB()) {
      return reject(new Error('当前环境不允许使用本地数据库（IndexedDB）：' +
        '若用 file:// 直接打开页面，浏览器会禁用它，请改用项目自带的本地服务从 http://127.0.0.1 打开。'));
    }
    var req;
    try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { return reject(e); }
    req.onupgradeneeded = function (ev) {
      var db = ev.target.result;
      TABLES.forEach(function (t) {
        if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' });
      });
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'path' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('打开本地数据库失败')); };
    req.onblocked = function () {
      reject(new Error('本地数据库被其他标签页占用，请关闭本工作台的其他标签页后重试。'));
    };
  });
  return _dbp;
}

function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

var idbDriver = {
  name: 'indexeddb',

  async readAll(store) {
    var db = await openDB();
    if (!db.objectStoreNames.contains(store)) return [];
    var tx = db.transaction(store, 'readonly');
    var rows = await reqP(tx.objectStore(store).getAll());
    await txDone(tx);
    return rows || [];
  },

  async putRows(store, rows) {
    if (!rows || !rows.length) return;
    var db = await openDB();
    var tx = db.transaction(store, 'readwrite');
    var st = tx.objectStore(store);
    rows.forEach(function (r) { st.put(clone(r)); });
    await txDone(tx);
  },

  async deleteRows(store, ids) {
    if (!ids || !ids.length) return;
    var db = await openDB();
    var tx = db.transaction(store, 'readwrite');
    var st = tx.objectStore(store);
    ids.forEach(function (id) { st.delete(id); });
    await txDone(tx);
  },

  async clearTable(store) {
    var db = await openDB();
    var tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await txDone(tx);
  },

  async clearFiles() {
    var db = await openDB();
    var tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).clear();
    await txDone(tx);
  },

  async clearStores() {
    var db = await openDB();
    var all = TABLES.concat([FILE_STORE]);
    var tx = db.transaction(all, 'readwrite');
    all.forEach(function (n) { tx.objectStore(n).clear(); });
    await txDone(tx);
  },

  async putFileRecord(rec) {
    var db = await openDB();
    var tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put({
      path: rec.path,
      name: rec.name || rec.path,
      mime_type: rec.mime_type || 'application/octet-stream',
      size: rec.size || (rec.blob ? rec.blob.size : 0),
      uploaded_at: rec.uploaded_at || new Date().toISOString(),
      blob: rec.blob
    });
    await txDone(tx);
  },

  async getFileRecord(path) {
    if (!path) return null;
    var db = await openDB();
    var tx = db.transaction(FILE_STORE, 'readonly');
    var rec = await reqP(tx.objectStore(FILE_STORE).get(path));
    await txDone(tx);
    return rec || null;
  },

  // 只取元信息，不把全部 Blob 拉进内存
  async listFileMeta() {
    var db = await openDB();
    var tx = db.transaction(FILE_STORE, 'readonly');
    var out = [];
    var req = tx.objectStore(FILE_STORE).openCursor();
    await new Promise(function (resolve, reject) {
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return resolve();
        var v = cur.value || {};
        out.push({ path: v.path, name: v.name, mime_type: v.mime_type, size: v.size, uploaded_at: v.uploaded_at });
        cur.continue();
      };
      req.onerror = function () { reject(req.error); };
    });
    await txDone(tx);
    return out;
  }
};

// 与 idbDriver 同接口的内存驱动：让门面逻辑可以脱离浏览器被自动化测试
function memoryDriver() {
  var data = {}, files = {};
  TABLES.forEach(function (t) { data[t] = []; });
  return {
    name: 'memory',
    _data: data,
    _files: files,

    async readAll(store) { return clone(data[store] || []); },

    async putRows(store, rows) {
      var arr = data[store] || (data[store] = []);
      (rows || []).forEach(function (r) {
        var i = -1;
        for (var k = 0; k < arr.length; k++) { if (String(arr[k].id) === String(r.id)) { i = k; break; } }
        var copy = clone(r);
        if (i >= 0) arr[i] = copy; else arr.push(copy);
      });
    },

    async deleteRows(store, ids) {
      var keys = (ids || []).map(String);
      data[store] = (data[store] || []).filter(function (r) { return keys.indexOf(String(r.id)) < 0; });
    },

    async clearTable(store) { data[store] = []; },
    async clearFiles() { Object.keys(files).forEach(function (k) { delete files[k]; }); },
    async clearStores() {
      TABLES.forEach(function (t) { data[t] = []; });
      Object.keys(files).forEach(function (k) { delete files[k]; });
    },

    async putFileRecord(rec) { files[rec.path] = clone(rec); },
    async getFileRecord(path) { return files[path] ? clone(files[path]) : null; },
    async listFileMeta() {
      return Object.keys(files).map(function (k) {
        var f = files[k];
        return { path: f.path, name: f.name, mime_type: f.mime_type, size: f.size, uploaded_at: f.uploaded_at };
      });
    }
  };
}

/* ---------------- 浏览器专有的编解码与下载 ---------------- */

function blobToBase64(blob) {
  if (!global.FileReader) return Promise.reject(new Error('当前环境不支持读取本地文件内容'));
  return new Promise(function (resolve, reject) {
    var fr = new global.FileReader();
    fr.onload = function () {
      var s = String(fr.result || '');
      var i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = function () { reject(fr.error || new Error('附件读取失败')); };
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  if (!global.atob || !global.Blob) throw new Error('当前环境不支持还原附件内容');
  var bin = global.atob(b64);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new global.Blob([arr], { type: mime || 'application/octet-stream' });
}

function download(name, blobOrText, mime) {
  var blob = (global.Blob && blobOrText instanceof global.Blob)
    ? blobOrText
    : new global.Blob([blobOrText], { type: mime || 'application/json' });
  var url = global.URL.createObjectURL(blob);
  var a = global.document.createElement('a');
  a.href = url; a.download = name;
  global.document.body.appendChild(a);
  a.click();
  global.document.body.removeChild(a);
  setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);
}

/* ============================================================
   B2. serverDriver 本机 SQLite 驱动
   ------------------------------------------------------------
   数据存在项目目录的 data/ 里（health.db + files/），与浏览器无关：
   在浏览器点「清除浏览数据」不会动到这里的任何记录。
   接口与 idbDriver 完全一致，因此上层业务代码不需要区分。
   ============================================================ */

var serverDriver = {
  name: 'sqlite',
  _meta: null,

  async _req(path, opts) {
    var r;
    try {
      r = await fetch(path, opts);
    } catch (e) {
      throw new Error('连不上本地数据服务（' + path + '）：' + (e && e.message ? e.message : e));
    }
    var j = null;
    try { j = await r.json(); } catch (e2) { j = null; }
    if (!r.ok || !j) throw new Error('本地数据服务返回 ' + r.status + '（' + path + '）');
    if (j.ok === false) throw new Error(j.reason || '本地数据服务拒绝了这次操作');
    return j;
  },

  _post(path, body) {
    return this._req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  },

  async readAll(store) {
    var j = await this._req('/api/db/rows?table=' + encodeURIComponent(store));
    return j.rows || [];
  },

  // opts.insert=true 表示这是「新增」而不是「按 id 覆盖写」：
  // 自增主键归 SQLite 分配，客户端算出来的 id 只是占位。带上去会被服务端
  // 当成"更新这条"（撞上已存在的 id 就静默改写别人的记录），所以先摘掉，
  // 再把服务端真正分配到的 id 交回调用方（返回值）。
  // 修复 / 从备份恢复走 importBackup 直接调本方法且**不带**这个选项，
  // 备份里的 id 必须原样保留。
  async putRows(store, rows, opts) {
    if (!rows || !rows.length) return [];
    var payload = rows;
    if (opts && opts.insert) {
      payload = rows.map(function (r) {
        var out = {};
        Object.keys(r).forEach(function (k) { if (k !== 'id') out[k] = r[k]; });
        return out;
      });
    }
    var j = await this._post('/api/db/put', { table: store, rows: payload });
    return (j && j.ids) || [];
  },

  async deleteRows(store, ids) {
    if (!ids || !ids.length) return;
    await this._post('/api/db/delete', { table: store, ids: ids });
  },

  async clearTable(store) {
    await this._post('/api/db/clear', { table: store });
  },

  async clearFiles() {
    await this._post('/api/files/clear', {});
    this._meta = null;
  },

  // 不带 table 表示清空全部表与全部附件
  async clearStores() {
    await this._post('/api/db/clear', {});
    this._meta = null;
  },

  async putFileRecord(rec) {
    var b64 = await blobToBase64(rec.blob);
    await this._post('/api/files/put', {
      path: rec.path,
      name: rec.name || rec.path,
      mime_type: rec.mime_type || 'application/octet-stream',
      size: rec.size || (rec.blob ? rec.blob.size : 0),
      uploaded_at: rec.uploaded_at,
      dataBase64: b64
    });
    this._meta = null;
  },

  async _metaList() {
    if (!this._meta) {
      var j = await this._req('/api/files/meta');
      this._meta = j.files || [];
    }
    return this._meta;
  },

  async getFileRecord(path) {
    if (!path) return null;
    var list = await this._metaList();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].path === path) { hit = list[i]; break; }
    }
    if (!hit) return null;
    var r;
    try {
      r = await fetch('/api/files/get?path=' + encodeURIComponent(path));
    } catch (e) {
      throw new Error('附件读取失败：' + (e && e.message ? e.message : e));
    }
    if (!r.ok) throw new Error('附件在本机磁盘上不存在：' + path);
    var blob = await r.blob();
    return {
      path: hit.path, name: hit.name, mime_type: hit.mime_type,
      size: hit.size, uploaded_at: hit.uploaded_at, blob: blob
    };
  },

  async listFileMeta() { return (await this._metaList()).slice(); },

  // 供页面启动时判断本地数据服务是否可用
  async probe() {
    try {
      var r = await fetch('/api/db/info', { cache: 'no-store' });
      if (!r.ok) return { ok: false, reason: '本地数据服务返回 ' + r.status };
      var j = await r.json();
      if (!j || !j.ok) return { ok: false, reason: (j && j.reason) || '本地数据服务未就绪' };
      return { ok: true, info: j.info };
    } catch (e) {
      return { ok: false, reason: '连不上本地数据服务：' + (e && e.message ? e.message : e) };
    }
  },

  /* ------ 家庭成员（存在服务端 meta 表里，不在四张数据表内） ------ */

  async persons() {
    var j = await this._req('/api/persons');
    return {
      persons: j.persons || [],
      stats: j.stats || {},
      nextId: j.next_id || 1
    };
  },

  // 整体保存名单（增删改排序都由调用方组装好后一次性提交）
  async savePersons(list) {
    var j = await this._post('/api/persons', { persons: list || [] });
    return { persons: j.persons || [], stats: j.stats || {} };
  },

  // 批量归属：默认只动尚未归属的记录。服务端会先打快照。
  async assignPerson(table, personId, onlyUnassigned) {
    var j = await this._post('/api/persons/assign', {
      table: table || 'documents',
      person_id: personId,
      only_unassigned: onlyUnassigned !== false
    });
    return { changed: j.changed || 0, snapshot: j.snapshot || null };
  },

  // 把某个成员名下的档案改回「未指定」（删成员时用）
  async clearPerson(table, personId) {
    var j = await this._post('/api/persons/clear', {
      table: table || 'documents',
      person_id: personId
    });
    return { changed: j.changed || 0, snapshot: j.snapshot || null };
  },

  /* 删档案。服务端先打快照再删行，并把因此不再被任何记录引用的附件一起删掉。 */
  async deleteRecords(table, ids) {
    var j = await this._post('/api/db/delete-records', {
      table: table || 'documents',
      ids: ids || []
    });
    return {
      deleted: j.deleted || 0,
      filesRemoved: j.files_removed || [],
      filesFailed: j.files_failed || [],
      keptReferenced: j.kept_referenced || [],
      snapshot: j.snapshot || null,
      missing: j.missing || []
    };
  }
};

/* ============================================================
   C. 门面（与云端 SDK 同签名）
   ============================================================ */

function createLocal(opts) {
  // 默认走本机 SQLite（数据在项目目录的 data/ 里，不受浏览器清理影响）；
  // 不传 driver 时若服务不可用，所有读写都会如实报错，不会静默丢数据。
  var D = (opts && opts.driver) || serverDriver;
  var cache = Object.create(null);
  var loaded = Object.create(null);
  var objectUrls = Object.create(null);
  var fileMeta = null;

  async function ensureTable(table) {
    if (!loaded[table]) {
      cache[table] = await D.readAll(table);
      loaded[table] = true;
    }
    return cache[table];
  }

  function err(message) { return { data: null, error: { message: message } }; }

  function Builder(table) {
    this.table = table;
    this.q = { filters: [], order: null, range: null };
    this.mode = 'select';
    this.payload = null;
    this.ret = false;
  }
  Builder.prototype.select = function () { this.ret = true; return this; };
  Builder.prototype.eq = function (col, val) { this.q.filters.push({ col: col, val: val }); return this; };
  Builder.prototype.order = function (col, opt) {
    this.q.order = { col: col, ascending: !(opt && opt.ascending === false) };
    return this;
  };
  Builder.prototype.range = function (a, b) { this.q.range = [a, b]; return this; };
  Builder.prototype.insert = function (rows) { this.mode = 'insert'; this.payload = rows; return this; };
  Builder.prototype.update = function (patch) { this.mode = 'update'; this.payload = patch; return this; };
  Builder.prototype.delete = function () { this.mode = 'delete'; return this; };
  Builder.prototype.then = function (onOk, onErr) { return execute(this).then(onOk, onErr); };
  Builder.prototype.catch = function (onErr) { return execute(this).catch(onErr); };

  async function execute(b) {
    var table = b.table;
    if (TABLES.indexOf(table) < 0) return err('未知的数据表：' + table);
    var rows;
    try { rows = await ensureTable(table); }
    catch (e) { return err(e.message || '读取本地数据失败'); }

    try {
      if (b.mode === 'select') return { data: applyQuery(rows, b.q), error: null };

      if (b.mode === 'insert') {
        var added = prepareInsert(table, rows, b.payload);
        // 驱动若把「服务端分配的真实 id」交回来，必须采用 —— 客户端算出的
        // 只是占位（服务端自增序列可能因为此前的删除而走得更远），
        // 拿着占位 id 去开详情，用户看到的是「找不到这份档案」。
        var assigned = await D.putRows(table, added, { insert: true });
        if (Array.isArray(assigned) && assigned.length === added.length) {
          for (var k = 0; k < added.length; k++) {
            if (assigned[k] !== null && assigned[k] !== undefined) added[k].id = assigned[k];
          }
        }
        cache[table] = rows.concat(added);
        return { data: b.ret ? added : null, error: null };
      }

      if (b.mode === 'update') {
        var changed = applyUpdate(rows, b.payload, b.q.filters);
        if (changed.length) await D.putRows(table, changed);
        return { data: b.ret ? changed : null, error: null };
      }

      if (b.mode === 'delete') {
        var res = applyDelete(rows, b.q.filters);
        if (res.removed.length) await D.deleteRows(table, res.removed.map(function (r) { return r.id; }));
        cache[table] = res.kept;
        return { data: b.ret ? res.removed : null, error: null };
      }
      return err('不支持的本地查询类型');
    } catch (e) {
      // 本地写入失败必须如实返回；调用方据此保持原状，不显示成功
      return err(e.message || '本地数据写入失败');
    }
  }

  var facade = {
    kind: 'local',
    driver: D.name,

    database: { from: function (table) { return new Builder(table); } },

    storage: {
      // 本地没有多用户，userPath 只保留调用签名，路径本身就是存储键
      userPath: function (uid, p) { return p; },

      async upload(path, file, options) {
        try {
          await D.putFileRecord({
            path: path,
            name: file.name,
            mime_type: (options && options.contentType) || file.type || 'application/octet-stream',
            size: file.size,
            blob: file
          });
          fileMeta = null;
          return { data: { path: path }, error: null };
        } catch (e) {
          return err(e.message || '本地附件写入失败（可能是浏览器存储配额不足）');
        }
      },

      // 本地对象地址（blob:），不涉及任何网络凭据；返回结构保持与云端一致
      async createSignedUrl(path) {
        if (objectUrls[path]) return { data: { signedUrl: objectUrls[path] }, error: null };
        try {
          var rec = await D.getFileRecord(path);
          if (!rec || !rec.blob) return err('附件在本机不存在（可能已被清理）：' + path);
          if (!global.URL || !global.URL.createObjectURL) return err('当前环境不支持生成附件预览地址');
          var url = global.URL.createObjectURL(rec.blob);
          objectUrls[path] = url;
          return { data: { signedUrl: url }, error: null };
        } catch (e) {
          return err(e.message || '附件读取失败');
        }
      }
    },

    /* ---- 本地版专有能力 ---- */

    async stats() {
      if (!fileMeta) fileMeta = await D.listFileMeta();
      var bytes = fileMeta.reduce(function (a, f) { return a + (Number(f.size) || 0); }, 0);
      return { files: fileMeta.length, fileBytes: bytes };
    },

    async fileMetaList() {
      if (!fileMeta) fileMeta = await D.listFileMeta();
      return fileMeta.slice();
    },

    async exportBackup() {
      var tables = {};
      for (var i = 0; i < TABLES.length; i++) tables[TABLES[i]] = await ensureTable(TABLES[i]);
      var meta = await D.listFileMeta();
      var files = [];
      for (var j = 0; j < meta.length; j++) {
        var rec = await D.getFileRecord(meta[j].path);
        if (!rec || !rec.blob) continue;
        files.push({
          path: rec.path, name: rec.name, mime_type: rec.mime_type,
          size: rec.size, uploaded_at: rec.uploaded_at,
          dataBase64: await blobToBase64(rec.blob)
        });
      }
      var backup = buildBackup(tables, files);
      // 成员名单存在服务端 meta 表里，不在四张数据表内。
      // 不带上的话会出现「档案恢复了、人却没了」。老备份没有这个键时留空。
      try {
        if (typeof D.persons === 'function') {
          var pr = await D.persons();
          if (pr && pr.persons && pr.persons.length) backup.meta = { persons: pr.persons };
        }
      } catch (e) { /* 成员读不到不该挡住整份备份 */ }
      return backup;
    },

    // 恢复会先清空再写入：调用方必须已经取得用户明确确认
    async importBackup(obj) {
      var v = validateBackup(obj);
      if (!v.ok) return { ok: false, errors: v.errors, written: 0, filesWritten: 0, counts: {} };
      for (var i = 0; i < RESTORE_ORDER.length; i++) {
        var name = RESTORE_ORDER[i];
        var rows = v.tables[name] || [];
        await D.clearTable(name);
        await D.putRows(name, rows);
        cache[name] = rows.slice();
        loaded[name] = true;
      }
      await D.clearFiles();
      var written = 0;
      for (var j = 0; j < v.files.length; j++) {
        var f = v.files[j];
        await D.putFileRecord({
          path: f.path, name: f.name, mime_type: f.mime_type,
          size: f.size, uploaded_at: f.uploaded_at,
          blob: base64ToBlob(f.dataBase64, f.mime_type)
        });
        written += 1;
      }
      fileMeta = null;
      var counts = {};
      TABLES.forEach(function (n) { counts[n] = (v.tables[n] || []).length; });
      // 恢复成员名单（老备份没有 meta 键时跳过，保持现有名单不变）
      var metaWritten = 0;
      try {
        var mp = obj.meta && obj.meta.persons;
        if (mp && typeof D.savePersons === 'function') {
          var plist = typeof mp === 'string' ? JSON.parse(mp) : mp;
          if (Array.isArray(plist) && plist.length) {
            await D.savePersons(plist);
            metaWritten = 1;
          }
        }
      } catch (e) { /* 成员名单恢复失败不回滚已恢复的档案，但要如实计数 */ }
      return { ok: true, errors: [], written: TABLES.reduce(function (a, n) { return a + counts[n]; }, 0), filesWritten: written, metaWritten: metaWritten, counts: counts };
    },

    async clearAll() {
      await D.clearStores();
      TABLES.forEach(function (n) { cache[n] = []; loaded[n] = true; });
      fileMeta = null;
      Object.keys(objectUrls).forEach(function (k) {
        try { global.URL.revokeObjectURL(objectUrls[k]); } catch (e) { }
        delete objectUrls[k];
      });
    },

    /* ---- 家庭成员 ----
       名单存在服务端 meta 表里（不在四张数据表内）。
       idbDriver / memoryDriver 不支持，会用 hasPersons=false 如实告知，
       由上层决定降级——不给「看起来支持、实则空转」的假能力。 */

    hasPersons: function () { return typeof D.persons === 'function'; },

    async persons() {
      if (typeof D.persons !== 'function') {
        return { persons: [], stats: {}, nextId: 1, supported: false };
      }
      try {
        var j = await D.persons();
        return {
          persons: j.persons || [], stats: j.stats || {},
          nextId: j.next_id || j.nextId || 1, supported: true
        };
      } catch (e) {
        return { persons: [], stats: {}, nextId: 1, supported: false, error: e.message || String(e) };
      }
    },

    async savePersons(list) {
      if (typeof D.savePersons !== 'function') {
        return { ok: false, reason: '当前数据驱动不支持成员配置' };
      }
      try {
        var j = await D.savePersons(list || []);
        return { ok: true, persons: j.persons || [], stats: j.stats || {} };
      } catch (e) {
        // 校验失败要原话回给用户（比如「成员名称不能为空」），不要泛化成「保存失败」
        return { ok: false, reason: e.message || String(e) };
      }
    },

    async assignPerson(table, personId, onlyUnassigned) {
      if (typeof D.assignPerson !== 'function') {
        return { ok: false, reason: '当前数据驱动不支持批量归属' };
      }
      try {
        var j = await D.assignPerson(table || 'documents', personId, onlyUnassigned);
        return { ok: true, changed: j.changed || 0, snapshot: j.snapshot || null };
      } catch (e) {
        return { ok: false, reason: e.message || String(e) };
      }
    },

    async clearPerson(table, personId) {
      if (typeof D.clearPerson !== 'function') {
        return { ok: false, reason: '当前数据驱动不支持解除归属' };
      }
      try {
        var j = await D.clearPerson(table || 'documents', personId);
        return { ok: true, changed: j.changed || 0, snapshot: j.snapshot || null };
      } catch (e) {
        return { ok: false, reason: e.message || String(e) };
      }
    },

    /* ---- 删除档案 ----
       只有本机 SQLite 驱动会连带清理附件；别的驱动如实说不支持，
       不给「点了显示成功、文件其实还在」的假能力。 */

    hasDeleteRecords: function () { return typeof D.deleteRecords === 'function'; },

    async deleteRecords(table, ids) {
      if (typeof D.deleteRecords !== 'function') {
        return { ok: false, reason: '当前数据驱动不支持删除档案（只有本机磁盘数据层会连带清理附件）' };
      }
      try {
        var j = await D.deleteRecords(table || 'documents', ids || []);
        return {
          ok: true, deleted: j.deleted || 0,
          filesRemoved: j.filesRemoved || [], filesFailed: j.filesFailed || [],
          keptReferenced: j.keptReferenced || [],
          snapshot: j.snapshot || null, missing: j.missing || []
        };
      } catch (e) {
        return { ok: false, reason: e.message || String(e) };
      }
    },

    // 丢弃内存缓存，强制下次从存储重读（多标签页改动或恢复备份后使用）
    invalidate: function () {
      cache = Object.create(null);
      loaded = Object.create(null);
      fileMeta = null;
    },

    hasIDB: hasIDB,
    openDB: openDB
  };

  return facade;
}

/* ============================================================
   D. 导出
   ============================================================ */

var api = {
  createLocal: createLocal,
  memoryDriver: memoryDriver,
  idbDriver: idbDriver,
  serverDriver: serverDriver,
  hasIDB: hasIDB,
  openDB: openDB,
  DB_NAME: DB_NAME,
  TABLES: TABLES,
  FILE_STORE: FILE_STORE,
  LOCAL_OWNER: LOCAL_OWNER,
  BACKUP_SCHEMA: BACKUP_SCHEMA,
  blobToBase64: blobToBase64,
  base64ToBlob: base64ToBlob,
  download: download,
  formatBytes: formatBytes,
  pure: {
    isBlank: isBlank,
    cmpValue: cmpValue,
    sortRows: sortRows,
    filterRows: filterRows,
    applyQuery: applyQuery,
    maxId: maxId,
    prepareInsert: prepareInsert,
    applyUpdate: applyUpdate,
    applyDelete: applyDelete,
    buildBackup: buildBackup,
    validateBackup: validateBackup,
    formatBytes: formatBytes
  }
};

global.LocalDB = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
