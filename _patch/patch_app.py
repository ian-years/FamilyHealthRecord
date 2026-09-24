# -*- coding: utf-8 -*-
"""把 app.js 从「云服务 + 登录」改造为「本地 IndexedDB + 无登录」。
每处替换都断言命中，未命中即报错退出，避免静默改错。"""
import io, sys, os

APP = r"E:\08-Codework\FamilyHealth\app\app.js"
src = io.open(APP, encoding="utf-8").read()
orig = src
report = []


def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit("[FAIL] %s：期望命中 1 处，实际 %d 处" % (label, n))
    src = src.replace(old, new, 1)
    report.append("OK  " + label)


def replace_between(start, end, new_middle, label):
    global src
    i = src.find(start)
    j = src.find(end)
    if i < 0 or j < 0 or j <= i:
        raise SystemExit("[FAIL] %s：未找到起止标记" % label)
    src = src[:i] + new_middle + src[j:]
    report.append("OK  " + label)


# ============================================================
# 1. 第 5 节：鉴权 → 启动 + 解析桥 + 备份恢复
# ============================================================

NEW_SEC5 = r"""/* ---------------- 5. 启动（本地版：无登录） ---------------- */

// 本地版没有账号体系，打开即可用。这里只加载数据并做存储自检，失败如实显示。
async function startApp() {
  $('app').classList.remove('hidden');
  var who = $('whoami');
  if (who) who.textContent = '本机存储 · 无需登录';
  renderSyncStrip();
  await loadAll();
  await refreshLocalStats();
  renderCurrent();
}

async function refreshLocalStats() {
  try { S.local = await cloud.stats(); }
  catch (e) { S.local = { error: e.message || '读取本地存储统计失败' }; }
}

/* ---------------- 5.1 解析桥（可选，联网调用 xParse） ---------------- */

// 解析本身必须联网，而网页不能直接运行解析工具。项目内的「本地服务」同时提供
// 页面访问与一个本机解析接口：桥在运行时「上传并解析」可用；桥不在时如实显示为
// 不可用，不显示进度条、不假装成功、不在解析失败时写入任何记录。
var BRIDGE = { checked: false, ok: false, reason: '', info: null };

async function probeBridge(force) {
  if (BRIDGE.checked && !force) return BRIDGE;
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
    var fd = new FormData();
    files.forEach(function (f) { fd.append('files', f, f.name); });
    var r = await fetch('/api/parse', { method: 'POST', body: fd });
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
        target: 'health_records',
        records: [{
          document_type: '其他医疗资料',
          primary_date: guessed,
          date_status: '待确认',
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
    setParseMsg('解析完成（任务 ' + (j.task_id || '未返回') + '）。请在弹窗里确认类型与日期后再写入。');
  } catch (e) {
    setParseMsg('解析未完成：' + (e.message || '未知错误') + '。没有写入任何数据。', true);
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
  var counts = Object.keys(v.tables).map(function (k) { return k + ' ' + v.tables[k].length + ' 条'; }).join('，');
  if (!confirm('恢复会先清空本机现有的四张表与全部附件，再写入备份内容。此操作不可撤销。\n\n' +
               '备份内容：' + counts + '，附件 ' + v.files.length + ' 个。\n\n要继续吗？')) return;

  btn.disabled = true; btn.textContent = '恢复中…';
  try {
    var res = await cloud.importBackup(obj);
    if (!res.ok) throw new Error(res.errors.join('；'));
    cloud.invalidate();
    await loadAll();
    await refreshLocalStats();
    closeDrawers();
    renderCurrent();
    alert('已从备份恢复：四张表共 ' + res.written + ' 条记录，附件 ' + res.filesWritten + ' 个。');
    btn.disabled = false; btn.textContent = '确认恢复';
  } catch (e) {
    setRestoreMsg('恢复失败：' + (e.message || '未知错误') + '。本机数据可能已部分改变，请用导出备份复核。', true);
    btn.disabled = false; btn.textContent = '确认恢复';
  }
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

"""
replace_between("/* ---------------- 5. 鉴权 ---------------- */",
                "/* ---------------- 6. 导航 ---------------- */",
                NEW_SEC5, "第5节：鉴权 → 启动/解析桥/备份")

# ============================================================
# 2. 附件层：去掉 uid 与短时授权语义
# ============================================================

rep(
    "// 附件对象：文件名 / 存储标识(path) / 短时授权地址 / MIME / 大小 / 页序\nasync function signedUrl(path) {",
    "// 附件对象：文件名 / 存储标识(path) / 可访问地址 / MIME / 大小 / 页序\n"
    "// 本地版地址是浏览器生成的对象地址（blob:），只在本机会话内有效，不涉及任何网络凭据\n"
    "async function signedUrl(path) {",
    "附件注释：授权地址 → 本地对象地址")

rep(
    "async function uploadOriginal(file, uid) {\n"
    "  var ext = (file.name.split('.').pop() || 'bin').toLowerCase();\n"
    "  var path = cloud.storage.userPath(uid, 'attachments/' + uuid() + '.' + ext);",
    "async function uploadOriginal(file) {\n"
    "  var ext = (file.name.split('.').pop() || 'bin').toLowerCase();\n"
    "  // 本地版没有多用户目录；userPath 只保留调用签名，路径本身就是本地存储键\n"
    "  var path = cloud.storage.userPath('local', 'attachments/' + uuid() + '.' + ext);",
    "uploadOriginal：去掉 uid")

# ============================================================
# 3. doImport：去掉登录前置校验
# ============================================================

rep(
    "  var uid = S.session && S.session.user && S.session.user.id;\n"
    "  if (!uid) return setImportMsg('登录状态已失效，请重新登录后再归档。', true);\n\n"
    "  var tableName = p.target === 'drugs' ? 'drugs' : 'health_records';",
    "  var tableName = p.target === 'drugs' ? 'drugs' : 'health_records';",
    "doImport：去掉登录校验")

rep(
    "      for (var i = 0; i < IMPORT.files.length; i++) uploaded.push(await uploadOriginal(IMPORT.files[i], uid));",
    "      for (var i = 0; i < IMPORT.files.length; i++) uploaded.push(await uploadOriginal(IMPORT.files[i]));",
    "doImport：附件上传调用")

# ============================================================
# 4. 详情层补传附件：去掉 uid
# ============================================================

rep(
    "      var uid = S.session && S.session.user && S.session.user.id;\n"
    "      try {\n"
    "        var added = [];\n"
    "        for (var i = 0; i < files.length; i++) added.push(await uploadOriginal(files[i], uid));",
    "      try {\n"
    "        var added = [];\n"
    "        for (var i = 0; i < files.length; i++) added.push(await uploadOriginal(files[i]));",
    "详情层补传：去掉 uid")

# ============================================================
# 5. 归档抽屉：支持「解析草稿」预填与字段确认
# ============================================================

rep(
    "function openImportDrawer(target) {\n"
    "  IMPORT = { payload: null, files: [], label: '' };\n"
    "  S.drugArchiveTarget = target || null;\n"
    "  var body = $('importBody');\n"
    "  body.innerHTML =\n"
    "    '<div class=\"field\"><label>归档包（.json）<span class=\"req\">*</span></label>' +\n"
    "    '<input type=\"file\" id=\"impJson\" accept=\".json,application/json\">' +\n"
    "    '<div class=\"hint\">选择在对话中生成的脱敏归档包。包内含 <code>records</code> 数组时按多条写入。</div></div>' +\n"
    "    '<div class=\"field\"><label>原始文件（可选，可多选）</label>' +\n"
    "    '<input type=\"file\" id=\"impFiles\" multiple>' +\n"
    "    '<div class=\"hint\">PDF / JPG / PNG / BMP / TIFF / WebP。会上传到你的私有目录；同一份报告的多页请一次选中，保持选择顺序。</div></div>' +\n"
    "    '<div id=\"impPreview\"></div>';\n"
    "  $('impJson').onchange = async function () {",
    "function docTypeOptions(selected) {\n"
    "  return (L.DOC_TYPES || []).map(function (t) {\n"
    "    return '<option value=\"' + attr(t) + '\"' + (t === selected ? ' selected' : '') + '>' + esc(t) + '</option>';\n"
    "  }).join('');\n"
    "}\n\n"
    "function openImportDrawer(target, preset) {\n"
    "  IMPORT = { payload: null, files: [], label: '', preset: !!preset };\n"
    "  S.drugArchiveTarget = target || null;\n"
    "  var body = $('importBody');\n"
    "  var head = '';\n"
    "  if (preset) {\n"
    "    head += '<div class=\"note\" style=\"margin-top:0\">来源：<b>本机解析接口</b>。' +\n"
    "      '下方原文来自解析服务，请先确认文档类型与主日期。本次只写入原文，' +\n"
    "      '检验项、检查所见、收费明细等结构化字段尚未提取 —— 需要结构化时，' +\n"
    "      '请把原件提交到对话中由解析与结构化流程处理。</div>';\n"
    "    head += '<div class=\"field\"><label>本次已选原始文件</label><div class=\"minor\" style=\"margin:0\">' +\n"
    "      (preset.files || []).map(function (f) {\n"
    "        return esc(f.name) + '（' + window.LocalDB.formatBytes(f.size) + '）';\n"
    "      }).join('<br>') + '</div></div>';\n"
    "  }\n"
    "  body.innerHTML = head +\n"
    "    '<div class=\"field\"><label>归档包（.json）' + (preset ? '（可选）' : '<span class=\"req\">*</span>') + '</label>' +\n"
    "    '<input type=\"file\" id=\"impJson\" accept=\".json,application/json\">' +\n"
    "    '<div class=\"hint\">选择在对话中生成的脱敏归档包。包内含 <code>records</code> 数组时按多条写入。' +\n"
    "    (preset ? '选择归档包会覆盖当前这条解析草稿。' : '') + '</div></div>' +\n"
    "    '<div class=\"field\"><label>原始文件（可选，可多选）</label>' +\n"
    "    '<input type=\"file\" id=\"impFiles\" multiple>' +\n"
    "    '<div class=\"hint\">PDF / JPG / PNG / BMP / TIFF / WebP。文件只保存在本机浏览器数据库里，不上传到任何服务器；' +\n"
    "    '同一份报告的多页请一次选中，保持选择顺序。</div></div>' +\n"
    "    '<div id=\"impPreview\"></div>';\n"
    "  if (preset) {\n"
    "    IMPORT.payload = preset.payload;\n"
    "    IMPORT.files = preset.files || [];\n"
    "    IMPORT.label = '本机解析结果';\n"
    "  }\n"
    "  $('impJson').onchange = async function () {",
    "归档抽屉：预填支持（上半）")

rep(
    "    } catch (e) {\n"
    "      IMPORT.payload = { target: null, records: [], parseError: '归档包不是合法的 JSON，请检查文件内容。' };\n"
    "      IMPORT.label = f.name;\n"
    "    }\n"
    "    renderImportPreview();\n"
    "  };\n"
    "  $('impFiles').onchange = function () { IMPORT.files = Array.prototype.slice.call($('impFiles').files); renderImportPreview(); };",
    "    } catch (e) {\n"
    "      IMPORT.payload = { target: null, records: [], parseError: '归档包不是合法的 JSON，请检查文件内容。' };\n"
    "      IMPORT.label = f.name;\n"
    "    }\n"
    "    IMPORT.preset = false;   // 手动选择的归档包不再走解析草稿的字段确认\n"
    "    renderImportPreview();\n"
    "  };\n"
    "  $('impFiles').onchange = function () { IMPORT.files = Array.prototype.slice.call($('impFiles').files); renderImportPreview(); };",
    "归档抽屉：预填支持（下半）")

# 预览里加「确认归档字段」，并在渲染后绑定
rep(
    "  var p = IMPORT.payload;\n"
    "  var h = '';\n"
    "  if (!p) {\n"
    "    h = '<div class=\"note\">尚未选择归档包。</div>';\n"
    "  } else if (p.parseError) {\n"
    "    h = '<div class=\"err-bar\">' + esc(p.parseError) + '</div>';\n"
    "  } else {\n"
    "    var tbl = p.target === 'drugs' ? '药品表' : '健康档案表';",
    "  var p = IMPORT.payload;\n"
    "  var h = '';\n"
    "  if (!p) {\n"
    "    h = '<div class=\"note\">尚未选择归档包。</div>';\n"
    "  } else if (p.parseError) {\n"
    "    h = '<div class=\"err-bar\">' + esc(p.parseError) + '</div>';\n"
    "  } else {\n"
    "    if (IMPORT.preset && p.records.length && p.target !== 'drugs') {\n"
    "      var r0 = p.records[0];\n"
    "      h += '<div class=\"card\" style=\"margin-bottom:12px\"><div class=\"card-h\"><h3>确认归档字段</h3>' +\n"
    "        '<span class=\"sub\">解析只能给出原文，类型与日期需要你确认</span></div><div class=\"card-b\">' +\n"
    "        '<div class=\"field\"><label>文档类型 <span class=\"req\">*</span></label>' +\n"
    "        '<select id=\"presetType\">' + docTypeOptions(r0.document_type) + '</select></div>' +\n"
    "        '<div class=\"field\"><label>主日期</label>' +\n"
    "        '<input type=\"date\" id=\"presetDate\" value=\"' + attr(L.isValidDate(r0.primary_date) ? r0.primary_date : '') + '\">' +\n"
    "        '<div class=\"hint\">' + (nz(r0.primary_date) ? '这是从原文推测的日期，尚未确认。' : '原文中没有可用的日期。') +\n"
    "        '留空表示日期未确认：记录会保留，但不会参与按日期的汇总与趋势。</div></div>' +\n"
    "        '<div class=\"field\"><label>标题</label>' +\n"
    "        '<input type=\"text\" id=\"presetTitle\" value=\"' + attr(r0.title || '') + '\" placeholder=\"例如：血常规报告单\">' +\n"
    "        '<div class=\"hint\">留空则卡片显示文档类型。</div></div>' +\n"
    "        '</div></div>';\n"
    "    }\n"
    "    var tbl = p.target === 'drugs' ? '药品表' : '健康档案表';",
    "预览：确认归档字段")

rep(
    "  el.innerHTML = h;\n"
    "}\n\n"
    "async function doImport() {",
    "  el.innerHTML = h;\n"
    "  if (IMPORT.preset && IMPORT.payload && !IMPORT.payload.parseError &&\n"
    "      IMPORT.payload.records && IMPORT.payload.records.length && IMPORT.payload.target !== 'drugs') {\n"
    "    bindPresetFields();\n"
    "  }\n"
    "}\n\n"
    "// 草稿字段的编辑直接落到待写入的对象上，避免中间态与显示不一致\n"
    "function bindPresetFields() {\n"
    "  var r0 = IMPORT.payload.records[0];\n"
    "  var sel = $('presetType');\n"
    "  if (sel) sel.onchange = function () { r0.document_type = sel.value; };\n"
    "  var ti = $('presetTitle');\n"
    "  if (ti) ti.oninput = function () { r0.title = ti.value.trim() || null; };\n"
    "  var dt = $('presetDate');\n"
    "  if (dt) dt.onchange = function () {\n"
    "    var v = dt.value;\n"
    "    if (v && !L.isValidDate(v)) {\n"
    "      dt.value = ''; r0.primary_date = null; r0.date_status = '待确认';\n"
    "      return setImportMsg('日期无效，请检查年月日是否存在。', true);\n"
    "    }\n"
    "    r0.primary_date = v || null;\n"
    "    r0.date_status = v ? '已确认' : '待确认';\n"
    "  };\n"
    "}\n\n"
    "async function doImport() {",
    "预览：绑定字段编辑")

# ============================================================
# 6. 详情查看器：去掉 Word / Excel 专分支（已确认不需要）
# ============================================================

rep(
    "    } else if (/\\.(docx?|xlsx?|pptx?)$/i.test(name)) {\n"
    "      stage.innerHTML = '<div style=\"text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8\">' +\n"
    "        'Word / Excel 类文件无法在浏览器中直接内嵌预览。<br>' +\n"
    "        '<span style=\"font-size:11.5px;color:#93a1b1\">请使用下方「下载原文件」在本机打开；这里不会把它塞进图片标签强行显示。</span></div>';\n"
    "    } else {\n"
    "      stage.innerHTML = '<div style=\"text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8\">' +\n"
    "        '该类型没有可用的内嵌预览。<br><span style=\"font-size:11.5px;color:#93a1b1\">可下载原文件后在本机查看。</span></div>';\n"
    "    }",
    "    } else {\n"
    "      // 解析链路不支持 Word / Excel / PPT，这类文件只能作为原始附件留存\n"
    "      stage.innerHTML = '<div style=\"text-align:center;color:#c8d2de;font-size:12.5px;line-height:1.8\">' +\n"
    "        '该类型没有可用的内嵌预览。<br><span style=\"font-size:11.5px;color:#93a1b1\">' +\n"
    "        'Word / Excel / PPT 类文件请用下方「下载原文件」在本机打开。</span></div>';\n"
    "    }",
    "查看器：合并 Office 分支")

# ============================================================
# 7. 同步状态条措辞（本地读取不再是「同步」）
# ============================================================

rep(
    "    var label = t.state === 'ok' ? ('已同步 ' + t.count + ' 条')\n"
    "      : t.state === 'error' ? '同步失败' : t.state === 'loading' ? '同步中' : '未开始';",
    "    var label = t.state === 'ok' ? ('已载入 ' + t.count + ' 条')\n"
    "      : t.state === 'error' ? '读取失败' : t.state === 'loading' ? '读取中' : '未开始';",
    "状态条：同步 → 读取")

# ============================================================
# 8. 上传页文案与入口
# ============================================================

rep(
    "  h += '<div class=\"page-head\"><h2>上传资料</h2>' +\n"
    "    '<p>资料的解析在对话中完成，归档写入发生在这里。两个动作都留有可追溯的标识，不做假进度、不显示假成功。</p></div>';",
    "  h += '<div class=\"page-head\"><h2>上传资料</h2>' +\n"
    "    '<p>解析需要联网，其余全部在本机完成：档案、附件与指标都存在你当前浏览器里，不上传到任何服务器。' +\n"
    "    '两个动作都留有可追溯的标识，不做假进度、不显示假成功。</p></div>';",
    "上传页：页头文案")

rep(
    "    '<div class=\"up-step\"><div class=\"no\">3</div><div class=\"bd\"><h4>在这里选择归档包与原始文件</h4>' +\n"
    "    '<p>原始文件会上传到你自己的私有附件存储目录，只有登录后的你可以读取；详情页通过短时授权地址访问，授权地址不会长期保存。</p></div></div>' +",
    "    '<div class=\"up-step\"><div class=\"no\">3</div><div class=\"bd\"><h4>在这里选择归档包与原始文件</h4>' +\n"
    "    '<p>原始文件只写入本机浏览器的本地数据库，不经过网络；详情页直接在本机读取它。<b>因此请定期导出备份</b> —— ' +\n"
    "    '清除浏览器数据或更换电脑都会让本机数据消失。</p></div></div>' +",
    "上传页：第三步说明")

rep(
    "    '<div class=\"up-step\"><div class=\"no\">4</div><div class=\"bd\"><h4>写入四张表并回读校验</h4>' +\n"
    "    '<p>写入成功以服务端返回的记录主键为准，随后立刻回读记录数量、关键字段与附件数。部分失败只补写失败项，不会重新写入全部。</p></div></div>' +",
    "    '<div class=\"up-step\"><div class=\"no\">4</div><div class=\"bd\"><h4>写入四张表并回读校验</h4>' +\n"
    "    '<p>写入成功以本地数据库真正返回的记录主键为准，随后立刻回读记录数量、关键字段与附件数。' +\n"
    "    '写入失败会如实报错并保持原状，不会显示成功。</p></div></div>' +",
    "上传页：第四步说明")

rep(
    "  h += '<div style=\"margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center\">' +\n"
    "    '<button class=\"btn\" disabled title=\"网页不能直接触发连接器解析\">网页一键上传（不可用）</button>' +\n"
    "    '<button class=\"btn primary\" id=\"btnOpenImport\">选择归档包并写入档案</button>' +\n"
    "    '<a class=\"btn\" href=\"tests.html\" target=\"_blank\" rel=\"noopener\">运行业务逻辑自检</a>' +\n"
    "    '</div>' +\n"
    "    '<div class=\"note\">「网页一键上传」保持禁用状态，因为当前没有正式的、可用于网页触发连接器解析的服务端接口。请走上面的对话提交路径，本页不把它包装成网页自动调用，也不显示进度条。</div>';",
    "  h += '<div id=\"parseBox\" class=\"note\" style=\"margin-top:14px\">正在检查本机解析接口…</div>' +\n"
    "    '<div style=\"margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center\">' +\n"
    "    '<label class=\"btn\" style=\"cursor:pointer\">选择文件<input type=\"file\" id=\"parseFiles\" multiple style=\"display:none\"></label>' +\n"
    "    '<button class=\"btn\" id=\"btnParseUpload\" disabled>上传并解析</button>' +\n"
    "    '<button class=\"btn primary\" id=\"btnOpenImport\">选择归档包并写入档案</button>' +\n"
    "    '<a class=\"btn\" href=\"tests.html\" target=\"_blank\" rel=\"noopener\">运行业务逻辑自检</a>' +\n"
    "    '</div>' +\n"
    "    '<div id=\"parseMsg\"></div>' +\n"
    "    '<div class=\"note\">「上传并解析」只在项目自带的本地服务运行时可用：它会调用本机解析工具（需要联网），' +\n"
    "    '返回原文后进入确认流程，不会直接写入。本机解析接口未启动时按钮保持禁用，并说明原因，不显示进度条、不假装成功。</div>';",
    "上传页：操作区")

rep(
    "  h += '<div class=\"card\"><div class=\"card-h\"><h3>当前数据规模</h3></div><div class=\"card-b\">' +\n"
    "    '<div class=\"kv\" style=\"grid-template-columns:110px minmax(0,1fr)\">' +\n"
    "    '<dt>健康档案</dt><dd class=\"num\">' + S.tables.health_records.count + ' 条</dd>' +\n"
    "    '<dt>药品</dt><dd class=\"num\">' + S.tables.drugs.count + ' 条</dd>' +\n"
    "    '<dt>指标目录</dt><dd class=\"num\">' + S.tables.indicator_catalog.count + ' 条</dd>' +\n"
    "    '<dt>日常指标</dt><dd class=\"num\">' + S.tables.daily_indicator_records.count + ' 条</dd>' +\n"
    "    '</div>' +\n"
    "    '<div class=\"note\">单页读取上限 200 条，超过时自动分页直到取完，汇总与来源不遗漏任何一页。</div>' +\n"
    "    '</div></div>';",
    "  var lo = S.local || {};\n"
    "  h += '<div class=\"card\"><div class=\"card-h\"><h3>本机数据规模</h3></div><div class=\"card-b\">' +\n"
    "    '<div class=\"kv\" style=\"grid-template-columns:110px minmax(0,1fr)\">' +\n"
    "    '<dt>健康档案</dt><dd class=\"num\">' + S.tables.health_records.count + ' 条</dd>' +\n"
    "    '<dt>药品</dt><dd class=\"num\">' + S.tables.drugs.count + ' 条</dd>' +\n"
    "    '<dt>指标目录</dt><dd class=\"num\">' + S.tables.indicator_catalog.count + ' 条</dd>' +\n"
    "    '<dt>日常指标</dt><dd class=\"num\">' + S.tables.daily_indicator_records.count + ' 条</dd>' +\n"
    "    '<dt>原始附件</dt><dd class=\"num\">' +\n"
    "      (lo.error ? '<span class=\"muted\">读取失败</span>'\n"
    "                : (lo.files || 0) + ' 个 · ' + window.LocalDB.formatBytes(lo.fileBytes || 0)) + '</dd>' +\n"
    "    '</div>' +\n"
    "    '<div class=\"note\">数据保存在本机浏览器的 IndexedDB 里。浏览器按来源分配存储配额，' +\n"
    "    '通常足够本类用途；接近配额时写入会失败并如实报错。单次读取上限 200 条，超过时自动分页直到取完。</div>' +\n"
    "    '<div style=\"display:flex;gap:8px;flex-wrap:wrap;margin-top:10px\">' +\n"
    "    '<button class=\"btn\" id=\"btnBackup2\">导出备份</button>' +\n"
    "    '<button class=\"btn\" id=\"btnRestore2\">从备份恢复</button>' +\n"
    "    '</div>' +\n"
    "    '<div class=\"note\">换电脑、换浏览器或清理浏览器数据都会让本机数据消失，请定期导出备份。</div>' +\n"
    "    '</div></div>';",
    "上传页：数据规模卡片")

rep(
    "  h += '<div class=\"card\"><div class=\"card-h\"><h3>隐私与分享边界</h3></div><div class=\"card-b\">' +\n"
    "    '<div class=\"note\" style=\"margin:0\">' +\n"
    "    '· 四张表都启用了行级权限，每一行的读写都要求 <code>owner_id</code> 等于当前登录用户，连查询也一样。<br>' +\n"
    "    '· 原始附件与解析原文按敏感资料管理，默认私有；被遮挡、打码、裁切掉的姓名、证件、条码、票据号不会还原、猜测或补录。<br>' +\n"
    "    '· 面向页面展示的正文与原始解析产物分层处理；数据概览只使用结构化结果、日期、类型和金额，不扫描完整正文里的指标或身份信息。<br>' +\n"
    "    '· 附件授权地址是短时有效的凭据，不写进源码、日志或可分享的交付物。<br>' +\n"
    "    '· 发布界面不等于公开医疗数据。若附件与数据权限不能独立生效，就不公开分享。' +\n"
    "    '</div></div></div>';",
    "  h += '<div class=\"card\"><div class=\"card-h\"><h3>隐私与分享边界</h3></div><div class=\"card-b\">' +\n"
    "    '<div class=\"note\" style=\"margin:0\">' +\n"
    "    '· 没有账号体系，也没有服务端数据库：四张表与全部附件都只在你这台电脑的浏览器里，本页不向任何服务器发送数据。<br>' +\n"
    "    '· 代价是「谁能打开这台电脑」就等于「谁能看到这些资料」。共用电脑时请为系统账号设置密码，或在使用后清理本机数据。<br>' +\n"
    "    '· 原始附件与解析原文按敏感资料管理；被遮挡、打码、裁切掉的姓名、证件、条码、票据号不会还原、猜测或补录。<br>' +\n"
    "    '· 面向页面展示的正文与原始解析产物分层处理；数据概览只使用结构化结果、日期、类型和金额，不扫描完整正文里的指标或身份信息。<br>' +\n"
    "    '· 导出备份得到的文件等同于全部健康数据，请按敏感资料保管，不要放进公共网盘或聊天群。<br>' +\n"
    "    '· 本地版只在本机运行，不适合发布成公开站点：任何人都能打开的页面里放不下「仅自己可见」的医疗数据。' +\n"
    "    '</div></div></div>';",
    "上传页：隐私边界卡片")

rep(
    "  host.innerHTML = h;\n"
    "  var b = $('btnOpenImport');\n"
    "  if (b) b.onclick = function () { openImportDrawer(null); };\n"
    "}",
    "  host.innerHTML = h;\n"
    "  var b = $('btnOpenImport');\n"
    "  if (b) b.onclick = function () { openImportDrawer(null); };\n"
    "  var b2 = $('btnBackup2'); if (b2) b2.onclick = doExportBackup;\n"
    "  var b3 = $('btnRestore2'); if (b3) b3.onclick = openRestoreDrawer;\n"
    "  var pf = $('parseFiles');\n"
    "  if (pf) pf.onchange = function () {\n"
    "    var n = pf.files ? pf.files.length : 0;\n"
    "    setParseMsg(n ? ('已选择 ' + n + ' 个文件：' + Array.prototype.slice.call(pf.files)\n"
    "      .map(function (f) { return f.name; }).join('、')) : '');\n"
    "  };\n"
    "  var pu = $('btnParseUpload');\n"
    "  if (pu) pu.onclick = doParseUpload;\n"
    "  // 先探测再决定按钮状态：避免先显示可用、随后又变成不可用\n"
    "  probeBridge().then(function (br) {\n"
    "    var box = $('parseBox');\n"
    "    if (!box) return;\n"
    "    if (br.ok) {\n"
    "      var ver = br.info && br.info.xparse_version ? '（解析工具 ' + esc(br.info.xparse_version) + '）' : '';\n"
    "      box.innerHTML = '<div class=\"ok-bar\">本机解析接口已就绪' + ver +\n"
    "        '。可以选择文件直接解析；解析结果会先进入确认流程，不会直接写入档案。</div>';\n"
    "      if (pu) pu.disabled = false;\n"
    "    } else {\n"
    "      box.innerHTML = '<div class=\"err-bar\">上传解析不可用：' + esc(br.reason) +\n"
    "        '。请改用下面的对话提交路径，或先启动项目自带的本地服务。</div>';\n"
    "      if (pu) pu.disabled = true;\n"
    "    }\n"
    "  });\n"
    "}",
    "上传页：入口绑定与桥探测")

# ============================================================
# 9. init：去掉鉴权初始化，改为直接启动
# ============================================================

rep(
    "function init() {\n"
    "  bindAuth();\n"
    "  $('mask').onclick = closeDrawers;",
    "function init() {\n"
    "  $('mask').onclick = closeDrawers;",
    "init：去掉 bindAuth")

rep(
    "  $('btnImportSave').onclick = doImport;\n\n"
    "  try { history.replaceState({ view: 'overview' }, '', location.pathname + location.search); } catch (e) { }\n\n"
    "  cloud.auth.onAuthStateChange(function (event, session) {\n"
    "    if (event === 'SIGNED_OUT') {\n"
    "      S.session = null;\n"
    "      closeDrawers(); closeAllLayers();\n"
    "      $('app').classList.add('hidden');\n"
    "      $('authScreen').classList.remove('hidden');\n"
    "    }\n"
    "  });\n\n"
    "  cloud.auth.getSession().then(function (r) {\n"
    "    if (r.data) { afterLogin(); }\n"
    "    else {\n"
    "      $('authScreen').classList.remove('hidden');\n"
    "      $('app').classList.add('hidden');\n"
    "    }\n"
    "  });\n"
    "}",
    "  $('btnImportSave').onclick = doImport;\n\n"
    "  // 侧栏底部：备份与清理（本地版没有退出登录）\n"
    "  var bk = $('btnBackup'); if (bk) bk.onclick = doExportBackup;\n"
    "  var rs = $('btnRestore'); if (rs) rs.onclick = openRestoreDrawer;\n"
    "  var cl = $('btnClearLocal'); if (cl) cl.onclick = doClearLocal;\n"
    "  var rc = $('btnRestoreConfirm'); if (rc) rc.onclick = doRestoreBackup;\n"
    "  var rf = $('rsFile'); if (rf) rf.onchange = function () { setRestoreMsg(''); };\n\n"
    "  // 窄屏侧栏开关（宽屏下该按钮不显示）\n"
    "  var sb = $('btnSidebar');\n"
    "  var scrim = $('scrim');\n"
    "  function closeNav() { $('app').classList.remove('nav-open'); }\n"
    "  if (sb) sb.onclick = function () { $('app').classList.toggle('nav-open'); };\n"
    "  if (scrim) scrim.onclick = closeNav;\n"
    "  qsa('#nav button').forEach(function (b) {\n"
    "    var prev = b.onclick;\n"
    "    b.onclick = function () { closeNav(); if (prev) prev(); };\n"
    "  });\n\n"
    "  try { history.replaceState({ view: 'overview' }, '', location.pathname + location.search); } catch (e) { }\n\n"
    "  startApp();\n"
    "}",
    "init：直接启动 + 侧栏开关")

# ============================================================
# 收尾
# ============================================================

if "cloud.auth" in src:
    raise SystemExit("[FAIL] 仍残留 cloud.auth 调用")
if "S.session" in src:
    raise SystemExit("[FAIL] 仍残留 S.session 引用")

io.open(APP, "w", encoding="utf-8", newline="\n").write(src)
print("\n".join(report))
print("-" * 46)
print("原始 %d 字节 → 现在 %d 字节" % (len(orig.encode("utf-8")), len(src.encode("utf-8"))))
print("剩余 cloud.* 调用：%d 处（应仅为 database / storage）" % src.count("cloud."))
