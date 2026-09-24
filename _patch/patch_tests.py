# -*- coding: utf-8 -*-
"""tests.js：加入异步用例支持 + 第 11 节本地数据层用例。"""
import io

T = r"E:\08-Codework\FamilyHealth\app\tests.js"
src = io.open(T, encoding="utf-8").read()
report = []


def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit("[FAIL] %s：期望命中 1 处，实际 %d 处" % (label, n))
    src = src.replace(old, new, 1)
    report.append("OK  " + label)


rep(
    "  function ok(cond, label) { if (!cond) throw new Error(label || '断言失败'); }",
    "  function ok(cond, label) { if (!cond) throw new Error(label || '断言失败'); }\n\n"
    "  // 异步用例：本地数据层要跨 IndexedDB / 内存驱动，必须等 Promise 完成后再汇总\n"
    "  var pendingTests = [];\n"
    "  function testAsync(name, fn) {\n"
    "    pendingTests.push(Promise.resolve().then(fn).then(function () {\n"
    "      results.push({ name: name, ok: true });\n"
    "    }, function (e) {\n"
    "      results.push({ name: name, ok: false, msg: e && e.message ? e.message : String(e) });\n"
    "    }));\n"
    "  }",
    "异步用例支持")

OLD_OUT = r"""  /* ================= 输出 ================= */

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.length - passed;
  var summary = { total: results.length, passed: passed, failed: failed, results: results };

  global.TEST_RESULTS = summary;

  if (typeof document !== 'undefined' && document.getElementById) {
    var host = document.getElementById('out');
    if (host) {
      var cls = failed === 0 ? 'ok' : 'bad';
      var html = '<div class="' + cls + '"><b>共 ' + results.length + ' 项，通过 ' + passed + ' 项' +
        (failed ? '，失败 ' + failed + ' 项' : '，全部通过') + '</b></div><ol>';
      results.forEach(function (r) {
        html += '<li class="' + (r.ok ? 'p' : 'f') + '">' + (r.ok ? 'PASS' : 'FAIL') + '　' + r.name +
          (r.ok ? '' : '<div class="m">' + r.msg + '</div>') + '</li>';
      });
      html += '</ol>';
      host.innerHTML = html;
    }
  } else if (typeof console !== 'undefined') {
    results.forEach(function (r) {
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : ('\n      ' + r.msg)));
    });
    console.log('\n共 ' + results.length + ' 项，通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  }
})(typeof window !== 'undefined' ? window : this);"""

NEW_TAIL = r"""  /* ================= 11. 本地数据层 ================= */

  var DB = global.LocalDB || (typeof require === 'function' ? (function () {
    try { return require('./localdb.js'); } catch (e) { return null; }
  })() : null);

  test('本地数据层：模块已加载并导出纯逻辑与门面', function () {
    ok(!!DB, '未加载 localdb.js');
    ok(!!DB.pure && !!DB.createLocal && !!DB.memoryDriver, '导出不完整');
  });

  if (DB) {
    var P = DB.pure;

    test('本地数据层：等值过滤按字符串比较，不因类型不同而漏配', function () {
      var rows = [{ id: 1, key: 'a' }, { id: 2, key: 2 }, { id: 3, key: 'b' }];
      eq(P.applyQuery(rows, { filters: [{ col: 'key', val: '2' }] }).map(function (r) { return r.id; }), [2]);
      eq(P.applyQuery(rows, { filters: [] }).length, 3);
      eq(P.applyQuery(rows, { filters: [{ col: 'key', val: 'zz' }] }).length, 0);
    });

    test('本地数据层：排序时空值恒排末尾，升序降序都一样', function () {
      var rows = [{ id: 1, d: '2024-01-02' }, { id: 2, d: null }, { id: 3, d: '2024-03-05' }, { id: 4, d: '2023-12-31' }];
      eq(P.applyQuery(rows, { order: { col: 'd', ascending: false } }).map(function (r) { return r.id; }), [3, 1, 4, 2]);
      eq(P.applyQuery(rows, { order: { col: 'd', ascending: true } }).map(function (r) { return r.id; }), [4, 1, 3, 2]);
    });

    test('本地数据层：排序按数值而非字典序（10 不能排在 9 前面）', function () {
      var rows = [{ id: 1, v: 9 }, { id: 2, v: 10 }, { id: 3, v: 2 }];
      eq(P.applyQuery(rows, { order: { col: 'v', ascending: true } }).map(function (r) { return r.v; }), [2, 9, 10]);
    });

    test('本地数据层：区间分页为闭区间，与云端 range 语义一致', function () {
      var rows = [];
      for (var i = 1; i <= 10; i++) rows.push({ id: i });
      eq(P.applyQuery(rows, { order: { col: 'id' }, range: [0, 3] }).map(function (r) { return r.id; }), [1, 2, 3, 4]);
      eq(P.applyQuery(rows, { order: { col: 'id' }, range: [8, 9] }).map(function (r) { return r.id; }), [9, 10]);
      eq(P.applyQuery(rows, { order: { col: 'id' }, range: [20, 25] }).length, 0);
    });

    test('本地数据层：主键跨已有数据继续自增，不从 1 重来', function () {
      eq(P.maxId([{ id: 3 }, { id: 17 }, { id: 'x' }]), 17);
      eq(P.maxId([]), 0);
      var added = P.prepareInsert('health_records', [{ id: 5 }], [{ document_type: '检验报告' }, { document_type: '检查报告' }]);
      eq(added.map(function (r) { return r.id; }), [6, 7]);
    });

    test('本地数据层：写入补 NOT NULL 默认值，且不覆盖调用方给的值', function () {
      var added = P.prepareInsert('health_records', [], [
        { document_type: '检验报告' },
        { document_type: '检验报告', date_status: '待确认', source_attachments: [{ name: 'a.png' }], type_specific_data: { k: 1 }, parse_status: '已归档' }
      ], '2026-01-01T00:00:00.000Z');
      eq(added[0].date_status, '已确认');
      eq(added[0].parse_status, '待解析');
      eq(added[0].source_attachments, []);
      eq(added[0].type_specific_data, {});
      eq(added[0].owner_id, 'local-user');
      eq(added[0].created_at, '2026-01-01T00:00:00.000Z');
      eq(added[1].date_status, '待确认');
      eq(added[1].parse_status, '已归档');
      eq(added[1].source_attachments, [{ name: 'a.png' }]);
      eq(added[1].type_specific_data, { k: 1 });
    });

    test('本地数据层：写入的行与调用方对象解耦，改动不会互相串', function () {
      var input = { drug_name: '甲' };
      var added = P.prepareInsert('drugs', [], [input], '2026-01-01T00:00:00.000Z');
      added[0].history.push({ event: '开始' });
      eq(input.history === undefined || input.history.length === 0, true, '调用方对象不得被写入结果改动');
      var two = P.prepareInsert('drugs', [], [{ drug_name: 'A' }, { drug_name: 'B' }]);
      two[0].history.push({ event: '开始' });
      eq(two[1].history, [], '两条记录的 history 必须是各自独立的数组');
    });

    test('本地数据层：更新只作用于命中的行，并写 updated_at', function () {
      var rows = [{ id: 1, key: 'a', followed: false }, { id: 2, key: 'b', followed: false }];
      var changed = P.applyUpdate(rows, { followed: true }, [{ col: 'key', val: 'b' }], '2026-02-02T00:00:00.000Z');
      eq(changed.map(function (r) { return r.id; }), [2]);
      eq(rows[0].followed, false);
      eq(rows[1].followed, true);
      eq(rows[1].updated_at, '2026-02-02T00:00:00.000Z');
    });

    test('本地数据层：删除返回保留项与移除项，不混淆', function () {
      var rows = [{ id: 1, key: 'a' }, { id: 2, key: 'b' }, { id: 3, key: 'a' }];
      var r = P.applyDelete(rows, [{ col: 'key', val: 'a' }]);
      eq(r.kept.map(function (x) { return x.id; }), [2]);
      eq(r.removed.map(function (x) { return x.id; }), [1, 3]);
    });

    test('本地数据层：备份载荷结构与四表计数正确', function () {
      var b = P.buildBackup({ health_records: [{ id: 1 }, { id: 2 }], drugs: [{ id: 1 }] }, [{ path: 'p', dataBase64: 'AA==' }], '2026-03-03T00:00:00.000Z');
      eq(b.schema, 'health-records-local-backup/v1');
      eq(b.counts.health_records, 2);
      eq(b.counts.drugs, 1);
      eq(b.counts.indicator_catalog, 0);
      eq(b.counts.daily_indicator_records, 0);
      eq(b.file_count, 1);
      eq(b.tables.daily_indicator_records, []);
    });

    test('本地数据层：备份校验放行合法文件、拦下格式不符的文件', function () {
      ok(P.validateBackup(P.buildBackup({ health_records: [{ id: 1, document_type: '检验报告' }] }, [])).ok, '合法备份应通过');
      ok(!P.validateBackup({ hello: 'world' }).ok, '缺少 schema 的文件必须被拒');
      ok(!P.validateBackup(null).ok, 'null 必须被拒');
      ok(!P.validateBackup([1, 2, 3]).ok, '数组必须被拒');
    });

    test('本地数据层：附件缺路径或缺数据时整份备份被拒', function () {
      var b = P.buildBackup({ health_records: [] }, [{ path: 'a.png', dataBase64: 'AA==' }]);
      b.files.push({ name: '无路径.png', dataBase64: 'AA==' });
      ok(!P.validateBackup(b).ok, '缺 path 的附件必须让整份备份被拒');
      ok(!P.validateBackup(P.buildBackup({ health_records: [] }, [{ path: 'b.png' }])).ok, '缺数据的附件必须让整份备份被拒');
    });

    test('本地数据层：表字段不是数组时被拒，并指明是哪张表', function () {
      var b = P.buildBackup({}, []);
      b.tables.drugs = { nope: true };
      var v = P.validateBackup(b);
      ok(!v.ok);
      ok(v.errors.join('|').indexOf('drugs') >= 0, '错误信息应指明出问题的表');
    });

    test('本地数据层：字节格式化按 1024 进制且不出现负数', function () {
      eq(P.formatBytes(0), '0 B');
      eq(P.formatBytes(900), '900 B');
      eq(P.formatBytes(2048), '2.0 KB');
      eq(P.formatBytes(5 * 1024 * 1024), '5.0 MB');
      eq(P.formatBytes(null), '0 B');
    });

    /* ---- 门面：用内存驱动跑，验证与云端相同签名的行为 ---- */

    testAsync('本地门面：insert().select() 返回带主键的记录数组', async function () {
      var mem = DB.memoryDriver();
      var facade = DB.createLocal({ driver: mem });
      var res = await facade.database.from('health_records').insert([
        { document_type: '检验报告', primary_date: '2025-01-01', title: '甲' },
        { document_type: '检验报告', primary_date: '2025-02-01', title: '乙' }
      ]).select();
      ok(!res.error, '不应报错：' + (res.error && res.error.message));
      eq(res.data.length, 2);
      eq(res.data.map(function (r) { return r.id; }), [1, 2]);
      eq(res.data[0].date_status, '已确认');

      var page = await facade.database.from('health_records').select('*')
        .order('primary_date', { ascending: false }).range(0, 0);
      eq(page.data.length, 1);
      eq(page.data[0].primary_date, '2025-02-01');
      var page2 = await facade.database.from('health_records').select('*')
        .order('primary_date', { ascending: false }).range(1, 1);
      eq(page2.data[0].primary_date, '2025-01-01');
    });

    testAsync('本地门面：update().eq().select() 只改命中行且已落库', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      await facade.database.from('health_records').insert([
        { document_type: '检验报告', title: '甲' },
        { document_type: '检验报告', title: '乙' }
      ]).select();
      var res = await facade.database.from('health_records').update({ title: '乙改' }).eq('id', 2).select();
      eq(res.data.length, 1);
      eq(res.data[0].title, '乙改');
      var other = await facade.database.from('health_records').select('*').eq('id', 1);
      eq(other.data[0].title, '甲', '未命中的行不得被改动');
      var back = await facade.database.from('health_records').select('*').eq('id', 2);
      eq(back.data[0].title, '乙改', '改动必须已落库');
      var none = await facade.database.from('health_records').update({ title: 'x' }).eq('id', 999).select();
      ok(!none.error, '命中 0 行不是错误');
      eq(none.data, []);
    });

    testAsync('本地门面：写入失败以 error 返回而不是抛异常', async function () {
      var broken = DB.createLocal({ driver: {
        name: 'broken',
        readAll: async function () { return []; },
        putRows: async function () { throw new Error('浏览器存储配额不足'); },
        deleteRows: async function () { }, clearTable: async function () { },
        clearFiles: async function () { }, clearStores: async function () { },
        putFileRecord: async function () { }, getFileRecord: async function () { return null; },
        listFileMeta: async function () { return []; }
      } });
      var res = await broken.database.from('drugs').insert({ drug_name: '甲' }).select();
      ok(!!res.error, '必须返回 error，否则调用方会以为写入成功');
      ok(res.error.message.indexOf('配额') >= 0, '错误信息应可读');
      eq(res.data, null);
    });

    testAsync('本地门面：未知表名被拒绝', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      var res = await facade.database.from('nope').select('*');
      ok(!!res.error);
    });

    testAsync('本地门面：附件写入与本机占用统计', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      var up = await facade.storage.upload('attachments/a.png', { name: 'a.png', type: 'image/png', size: 1234 }, { contentType: 'image/png' });
      ok(!up.error, '附件写入应成功');
      var st = await facade.stats();
      eq(st.files, 1);
      eq(st.fileBytes, 1234);
      eq(facade.storage.userPath('任意', 'attachments/b.pdf'), 'attachments/b.pdf', '本地路径即存储键，不做用户前缀');
      var missing = await facade.storage.createSignedUrl('attachments/none.png');
      ok(!!missing.error, '不存在的附件必须报错，不能返回空地址');
    });

    testAsync('本地门面：清空后四表与附件都归零，读取不再返回旧数据', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      await facade.database.from('health_records').insert({ document_type: '检验报告' }).select();
      await facade.storage.upload('attachments/a.png', { name: 'a.png', size: 10 }, {});
      await facade.clearAll();
      eq((await facade.database.from('health_records').select('*')).data, []);
      eq((await facade.stats()).files, 0);
    });

    testAsync('本地门面：备份校验不通过时不改动现有数据，通过时替换而非追加', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      await facade.database.from('drugs').insert([{ drug_name: '旧药' }]).select();
      var rejected = await facade.importBackup({ schema: 'wrong' });
      ok(!rejected.ok, '格式不符必须拒绝');
      eq((await facade.database.from('drugs').select('*')).data.length, 1, '被拒的恢复不得改动现有数据');

      var backup = DB.pure.buildBackup({
        drugs: [{ id: 7, drug_name: '备份药', status: '当前用药', owner_id: 'local-user' }]
      }, []);
      var r = await facade.importBackup(backup);
      ok(r.ok, '合法备份应恢复成功');
      eq((await facade.database.from('drugs').select('*')).data.map(function (x) { return x.drug_name; }), ['备份药']);
      eq(r.written, 1);
      eq(r.filesWritten, 0);
    });
  }

  /* ================= 输出 ================= */

  function renderResults() {
    var passed = results.filter(function (r) { return r.ok; }).length;
    var failed = results.length - passed;
    var summary = { total: results.length, passed: passed, failed: failed, results: results };
    global.TEST_RESULTS = summary;

    if (typeof document !== 'undefined' && document.getElementById) {
      var host = document.getElementById('out');
      if (host) {
        var cls = failed === 0 ? 'ok' : 'bad';
        var html = '<div class="' + cls + '"><b>共 ' + results.length + ' 项，通过 ' + passed + ' 项' +
          (failed ? '，失败 ' + failed + ' 项' : '，全部通过') + '</b></div><ol>';
        results.forEach(function (r) {
          html += '<li class="' + (r.ok ? 'p' : 'f') + '">' + (r.ok ? 'PASS' : 'FAIL') + '　' + r.name +
            (r.ok ? '' : '<div class="m">' + r.msg + '</div>') + '</li>';
        });
        html += '</ol>';
        host.innerHTML = html;
      }
    } else if (typeof console !== 'undefined') {
      results.forEach(function (r) {
        console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : ('\n      ' + r.msg)));
      });
      console.log('\n共 ' + results.length + ' 项，通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    }
    return summary;
  }

  // 异步用例跑完再汇总；Node 端可等待 global.TEST_DONE
  global.TEST_DONE = Promise.resolve()
    .then(function () { return Promise.all(pendingTests); })
    .then(renderResults);
})(typeof window !== 'undefined' ? window : this);"""

rep(OLD_OUT, NEW_TAIL, "输出段：支持异步用例")

io.open(T, "w", encoding="utf-8", newline="\n").write(src)
print("\n".join(report))
print("-" * 46)
print("tests.js 现在 %d 字节" % len(src.encode("utf-8")))
