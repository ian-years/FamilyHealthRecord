/* ============================================================
   业务逻辑自检
   ------------------------------------------------------------
   全部用例使用隔离的虚构数据，不从任何真实工作台复制。
   覆盖：日期有效性 / 空值语义 / 严格数值 / 单位换算 / 指标匹配
        / 趋势口径 / 费用口径 / 时间线分组 / 药品状态机 / 输出转义
   同一份文件既能在浏览器里跑（tests.html），也能在 Node 里跑。
   ============================================================ */
(function (global) {
  'use strict';

  var L = global.Logic;

  var results = [];
  function test(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, msg: e && e.message ? e.message : String(e) });
    }
  }
  function eq(actual, expected, label) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((label || '断言失败') + '：期望 ' + b + '，实际 ' + a);
  }
  function ok(cond, label) { if (!cond) throw new Error(label || '断言失败'); }

  // 异步用例：本地数据层要跨 IndexedDB / 内存驱动，必须等 Promise 完成后再汇总
  var pendingTests = [];
  function testAsync(name, fn) {
    pendingTests.push(Promise.resolve().then(fn).then(function () {
      results.push({ name: name, ok: true });
    }, function (e) {
      results.push({ name: name, ok: false, msg: e && e.message ? e.message : String(e) });
    }));
  }

  /* ---------- 虚构数据 ---------- */

  function rec(o) {
    var base = {
      id: o.id, document_type: o.document_type || '其他医疗资料', primary_date: o.primary_date || null,
      date_status: o.date_status || (o.primary_date ? '已确认' : '日期待确认'),
      hospital: o.hospital || null, department: o.department || null, doctor: o.doctor || null,
      title: o.title || '虚构测试资料', key_information: o.key_information || null,
      amount: o.amount === undefined ? null : o.amount,
      source_file: o.source_file || 'fixture.pdf', source_attachments: o.source_attachments || [],
      parsed_content: o.parsed_content || null, type_specific_data: o.type_specific_data || {},
      parse_status: '已归档', file_hash: o.file_hash || null,
      xparse_task_id: o.xparse_task_id || null, xparse_run_id: o.xparse_run_id || null,
      updated_at: '2026-01-01T00:00:00Z'
    };
    return base;
  }

  /* ================= 1. 日期 ================= */

  test('日期：不存在的日历日期被判无效，不被滚动到下个月', function () {
    eq(L.isValidDate('2025-02-30'), false, '2025-02-30');
    eq(L.isValidDate('2025-13-01'), false, '2025-13-01');
    eq(L.isValidDate('2026-04-31'), false, '2026-04-31');
    eq(L.isValidDate('2024-02-29'), true, '2024-02-29 闰年');
    eq(L.isValidDate('2025-02-28'), true, '2025-02-28');
    eq(L.isValidDate(''), false, '空串');
    eq(L.isValidDate(null), false, 'null');
    eq(L.isValidDate('2025/12/13'), false, '非标准分隔符不猜');
  });

  test('日期：规范化不跨天跨年，补零稳定', function () {
    eq(L.dateSortKey('2025-1-5'), '2025-01-05');
    eq(L.fmtYearMonth('2025-12-13'), '2025.12');
    eq(L.fmtYearMonth('2024-01-01'), '2024.01');
  });

  test('日期：无效日期在时间线中归入「日期待确认」，不进入年度计算', function () {
    var g = L.groupTimeline([rec({ id: 1, primary_date: null }), rec({ id: 2, primary_date: '2025-02-30' })]);
    eq(g.dateGroups.length, 0, '无有效日期组');
    eq(g.pending.length, 2, '待确认数量');
  });

  /* ================= 2. 空值与数值 ================= */

  test('空值语义：null / 空串 / 纯空白 / 不可解析一律为未知，不变成 0', function () {
    eq(L.parseStrictNumber(null), null);
    eq(L.parseStrictNumber(undefined), null);
    eq(L.parseStrictNumber(''), null);
    eq(L.parseStrictNumber('   '), null);
    eq(L.parseStrictNumber('--'), null);
    eq(L.toCents(null), null);
    eq(L.toCents(''), null);
    eq(L.toCents('  '), null);
    eq(L.toCents('待确认'), null);
  });

  test('明确零保留：数值 0 与 "0" 都是合法的明确零金额', function () {
    eq(L.parseStrictNumber('0'), 0);
    eq(L.parseStrictNumber(0), 0);
    eq(L.toCents(0), 0);
    eq(L.toCents('0.00'), 0);
    eq(L.fmtMoney(0), '¥0.00');
  });

  test('严格数值：定性值与带比较符结果不被当成精确数值', function () {
    eq(L.parseStrictNumber('1+'), null, '1+');
    eq(L.parseStrictNumber('2+'), null, '2+');
    eq(L.parseStrictNumber('±'), null, '±');
    eq(L.parseStrictNumber('<5'), null, '<5');
    eq(L.parseStrictNumber('>10'), null, '>10');
    eq(L.parseStrictNumber('＜3.36'), null, '全角小于号');
    eq(L.parseStrictNumber('阴性'), null, '阴性');
    eq(L.parseStrictNumber('5.2'), 5.2, '正常小数');
    eq(L.parseStrictNumber(' 1,234.5 '), 1234.5, '千分位与空白');
    eq(L.parseStrictNumber('６.５８'), 6.58, '全角数字');
    ok(L.looksQualitative('1+'), '1+ 应被识别为定性');
    ok(L.looksQualitative('阴性'), '阴性 应被识别为定性');
    ok(!L.looksQualitative('5.2'), '5.2 不应被识别为定性');
  });

  test('原报告标记：只复现明确印出的箭头，识别不清不猜', function () {
    eq(L.normalizeFlag('↑'), '↑');
    eq(L.normalizeFlag('H'), '↑');
    eq(L.normalizeFlag('↓'), '↓');
    eq(L.normalizeFlag('个'), null, '识别不清的字符不得推断为箭头');
    eq(L.normalizeFlag(''), null);
  });

  /* 复核批次（阶段 18）：小数逗号与内部空格会被"拼"成一个看似合理的数（27,38 → 2738、
     12,34 元 → ¥1234.00）。指令 §21 要求尺度疑点回到原图核对、不自行移动小数点，
     所以判不准就该留原样待核对，而不是猜一个放大 100 倍的值。 */
  test('数字解析：小数逗号与内部空格一律不当成精确数值', function () {
    eq(L.parseStrictNumber('27,38'), null, '27,38 可能是 27.38 也可能是千分位，不能猜成 2738');
    eq(L.parseStrictNumber('1 2'), null, '中间有空格说明这不是一个完整数字');
    eq(L.parseStrictNumber('1,345.6'), 1345.6, '千分位 + 小数点的写法语义唯一，可以接受');
    eq(L.parseStrictNumber('82.9'), 82.9, '普通小数不受影响');
    eq(L.toCents('12,34'), null, '金额同样不得把逗号当小数点或千分位拼出 ¥1234.00');
    eq(L.toCents('１００'), 10000, '全角数字仍要能读（金额路径与数字解析要一致）');
    ok(!L.looksQualitative('27,38') || L.parseStrictNumber('27,38') === null,
      '要么被识别为定性，要么解析必须失败 —— 不能产出一个放大百倍的数值');
  });

  /* ================= 3. 单位归一化 ================= */

  test('受控换算：系数正确，且原值原单位完整保留', function () {
    var g = L.normalizeForDisplay('glucose', 180, 'mg/dL');
    eq(g.value, 10, '血糖 180 mg/dL');
    eq(g.conversionApplied, true);
    eq(g.originalValue, 180);
    eq(g.originalUnit, 'mg/dL');
    eq(g.unit, 'mmol/L');

    eq(L.normalizeForDisplay('creatinine', 1.0, 'mg/dL').value, 88.4, '肌酐');
    eq(L.normalizeForDisplay('uric_acid', 9.1, 'mg/dL').value, 541.27, '尿酸');
    eq(L.normalizeForDisplay('cholesterol', 254, 'mg/dL').value, 6.57, '总胆固醇');
    eq(L.normalizeForDisplay('triglyceride', 150, 'mg/dL').value, 1.69, '甘油三酯');
  });

  test('不同分析物不共享错误系数', function () {
    var ua = L.normalizeForDisplay('uric_acid', 1, 'mg/dL').value;
    var cr = L.normalizeForDisplay('creatinine', 1, 'mg/dL').value;
    ok(ua !== cr, '尿酸与肌酐系数必须不同');
    eq(ua, 59.48);
    eq(cr, 88.4);
  });

  test('单位已一致时不做换算，只统一规范写法', function () {
    var r = L.normalizeForDisplay('glucose', 5.6, 'mmol/l');
    eq(r.conversionApplied, false);
    eq(r.unit, 'mmol/L');
    eq(r.value, 5.6);
  });

  test('未知单位不强行换算，按原文展示并说明', function () {
    var r = L.normalizeForDisplay('glucose', 100, 'mg/100mL');
    eq(r.conversionApplied, false);
    eq(r.value, 100);
    ok(r.note && r.note.indexOf('未纳入受控换算范围') >= 0, '应给出未换算说明');
  });

  /* ================= 4. 指标匹配 ================= */

  test('TG 的非血脂项目不进入甘油三酯', function () {
    var m = L.matchLabItem({ name: '甲状腺球蛋白', result: '25', unit: 'ng/mL', panel: '免疫发光' });
    ok(!m || m.key !== 'tg', '甲状腺球蛋白不得匹配为甘油三酯');
    var m2 = L.matchLabItem({ name: 'TG', result: '1.2', unit: 'mmol/L', panel: '免疫发光' });
    ok(!m2 || m2.key !== 'tg', '缺少血脂上下文时 TG 缩写不得进入甘油三酯');
    var m3 = L.matchLabItem({ name: '甘油三酯', result: '1.69', unit: 'mmol/L', panel: '生化-血脂' });
    eq(m3.key, 'tg', '明确甘油三酯应进入血脂');
    var m4 = L.matchLabItem({ name: 'TG', result: '1.69', unit: 'mmol/L', panel: '生化-血脂' });
    eq(m4.key, 'tg', '血脂上下文下 TG 缩写可接受');
  });

  test('HDL / LDL 不被总胆固醇吞掉', function () {
    eq(L.matchLabItem({ name: '高密度脂蛋白胆固醇', result: '1.2', unit: 'mmol/L', panel: '生化-血脂' }).key, 'hdl');
    eq(L.matchLabItem({ name: '低密度脂蛋白胆固醇', result: '3.1', unit: 'mmol/L', panel: '生化-血脂' }).key, 'ldl');
    eq(L.matchLabItem({ name: '总胆固醇', result: '5.2', unit: 'mmol/L', panel: '生化-血脂' }).key, 'tc');
    eq(L.matchLabItem({ name: 'HDL-C', result: '1.2', unit: 'mmol/L', panel: '生化-血脂' }).key, 'hdl');
  });

  test('尿肌酐不混入血肌酐；尿酸常规项目不混入血尿酸', function () {
    var m = L.matchLabItem({ name: '尿肌酐', result: '100', unit: 'mg/dL', panel: '尿常规' });
    ok(!m || m.key !== 'scr', '尿肌酐不得匹配为血肌酐');
    eq(L.matchLabItem({ name: '血肌酐', result: '88', unit: 'μmol/L', panel: '生化-肾功' }).key, 'scr');
    var m2 = L.matchLabItem({ name: '尿酸碱度', result: '6.0', unit: '', panel: '尿常规' });
    ok(!m2 || m2.key !== 'ua', '尿酸碱度不得匹配为血尿酸');
    eq(L.matchLabItem({ name: '血清尿酸', result: '541.1', unit: 'μmol/L', panel: '生化-肾功' }).key, 'ua');
  });

  test('非空腹的血糖不无条件混入空腹血糖', function () {
    var m = L.matchLabItem({ name: '葡萄糖', result: '5.6', unit: 'mmol/L', panel: '生化-血糖', condition: '餐后 2 小时' });
    ok(!m || m.key !== 'fbg', '餐后葡萄糖不得匹配为空腹血糖');
    eq(L.matchLabItem({ name: '空腹血糖', result: '5.6', unit: 'mmol/L', panel: '生化-血糖' }).key, 'fbg');
  });

  // 真实数据里的心电图「QTC 间期」与宫颈「TCT」曾被当成总胆固醇：normName 会剥掉括号，
  // 于是「总胆固醇(TC)」与「QTC间期」在别名包含匹配里长得一样。判据只能是词边界。
  test('拉丁缩写别名要词边界：QTC / TCT 不得并入总胆固醇', function () {
    var qtc = L.matchLabItem({ name: 'QTC 间期', result: '404', unit: 'ms', panel: '心电图' });
    ok(!qtc || qtc.key !== 'tc', 'QTC 间期（心电，单位 ms）不得匹配为总胆固醇');
    var qtc2 = L.matchLabItem({ name: 'QTC间期', result: '397', unit: 'ms', panel: '体检' });
    ok(!qtc2 || qtc2.key !== 'tc', '无空格写法的 QTC间期 同样不得匹配');
    var tct = L.matchLabItem({
      name: 'TCT（液基超薄细胞检测）', result: '未见上皮内病变或恶性细胞(NILM)。', unit: '', panel: '妇科'
    });
    ok(!tct || tct.key !== 'tc', 'TCT 宫颈细胞学不得匹配为总胆固醇');
    // 反向：正常写法必须继续命中
    eq(L.matchLabItem({ name: '总胆固醇(TC)', result: '5.2', unit: 'mmol/L', panel: '生化-血脂' }).key, 'tc',
      '带括号的「总胆固醇(TC)」仍要命中总胆固醇');
    eq(L.matchLabItem({ name: 'TC', result: '5.2', unit: 'mmol/L', panel: '生化-血脂' }).key, 'tc',
      '血脂上下文里的 TC 仍要命中');
    eq(L.matchLabItem({ name: 'LDL-C', result: '3.1', unit: 'mmol/L', panel: '生化-血脂' }).key, 'ldl',
      '连字符不算词内字符，LDL-C 照常命中');
  });

  test('一般检查派生血压、体重与 BMI', function () {
    var r = rec({
      id: 9, primary_date: '2025-12-13',
      type_specific_data: { general_exam: { weight_kg: '82.9', bmi: '27.7', systolic_mmHg: '114', diastolic_mmHg: '70' } }
    });
    var pts = L.deriveIndicatorPoints([r], L.PRESET_CATALOG);
    var bp = pts.filter(function (p) { return p.indicatorKey === 'bp'; });
    eq(bp.length, 1, '血压派生一条');
    eq(bp[0].value, 114);
    eq(bp[0].value2, 70);
    eq(pts.filter(function (p) { return p.indicatorKey === 'weight'; }).length, 1, '体重派生一条');
    eq(pts.filter(function (p) { return p.indicatorKey === 'bmi'; }).length, 1, 'BMI 派生一条');
  });

  /* 复核批次（阶段 18）：真实 OCR 行一旦被送错指标，界面显示的就是"看着合理的错数值"，
     比空值更难发现。下面每条都对应真实库里出现过的写法（含被实测送错的 5 条空腹血糖）。 */
  test('OGTT 分支只认原文明确的糖耐量，普通空腹/餐后不得被劫走', function () {
    eq(L.matchLabItem({ name: '空腹血糖', result: '5.4', unit: 'mmol/L', panel: '生化', condition: '空腹' }).key, 'fbg',
      '「空腹血糖 + 条件=空腹」是普通空腹血糖，不是 OGTT 时点');
    var ins = L.matchLabItem({ name: '胰岛素', result: '14.2', unit: 'μIU/mL', panel: '生化', condition: '空腹' });
    ok(!ins || ins.key !== 'ogtt_ins', '空腹胰岛素不得被并进 OGTT 胰岛素曲线');
    eq(L.matchLabItem({ name: '葡萄糖', result: '8.9', unit: 'mmol/L', panel: 'OGTT', condition: '服糖后2小时' }).key, 'ogtt_glu',
      '真 OGTT 行仍要命中（panel 明确写了 OGTT）');
    eq(L.matchLabItem({ name: '空腹血糖', result: '5.2', unit: 'mmol/L', panel: '葡萄糖耐量试验', condition: '空腹' }).key, 'ogtt_glu',
      '葡萄糖耐量试验里的空腹时点属于该试验');
  });

  test('尿肌酐 / 非HDL-C / 甲状腺球蛋白：看 panel 与否定前缀，不看名字里含不含那个字', function () {
    var urine = L.matchLabItem({ name: '肌酐', result: '1.0', unit: 'mg/dL', panel: '尿常规' });
    ok(!urine || urine.key !== 'scr',
      '尿常规里的「肌酐」不得当血肌酐 —— 还会被 mg/dL×88.4 换算成一个落在正常范围的血清值');
    var nhdl = L.matchLabItem({ name: '非HDL-C', result: '5.0', unit: 'mmol/L', panel: '生化-血脂' });
    ok(!nhdl || nhdl.key !== 'hdl', '非HDL-C 是另一个分析物，不得并入高密度脂蛋白');
    var tg = L.matchLabItem({ name: '甲状腺球蛋白（Tg）', result: '25', unit: 'ng/mL', panel: '检验项目：生化-血脂+甲功' });
    ok(!tg || tg.key !== 'tg', '甲功项目不得因为套餐名里带「血脂」两字就被并成甘油三酯');
    eq(L.matchLabItem({ name: '甘油三酯', result: '1.69', unit: 'mmol/L', panel: '生化-血脂' }).key, 'tg',
      '明确写「甘油三酯」的仍要命中');
    eq(L.matchLabItem({ name: '血清肌酐', result: '88', unit: 'μmol/L', panel: '生化-肾功' }).key, 'scr',
      '真血肌酐不受影响');
  });

  test('指标组不参与名称匹配：命中组键等于把这一行的数值丢在任何视图之外', function () {
    var g = L.matchLabItem({ name: '血脂四项', result: '4.20', unit: 'mmol/L', panel: '生化' });
    ok(!g || g.key !== 'lipids', '「血脂四项」这类汇总行不得产出组键派生点');
    var pts = L.deriveIndicatorPoints([rec({
      id: 71, primary_date: '2025-12-13',
      type_specific_data: { lab_results: [{ name: '血脂四项', result: '4.20', unit: 'mmol/L' }] }
    })], L.PRESET_CATALOG);
    var stranded = pts.filter(function (p) { return p.indicatorKey === 'lipids'; });
    eq(stranded.length, 0, 'lipids 组键下的点在表格与详情都没人读（lipidSummary 只读四个分项键）');
  });

  /* ================= 5. 趋势口径 ================= */

  function pt(o) {
    return {
      date: o.date, value: o.value, value2: o.value2 === undefined ? null : o.value2,
      unit: o.unit || '', condition: o.condition || null, source: o.source || '报告提取',
      reference: o.reference || null, flag: o.flag || null, sourceRecordId: o.sourceRecordId || 1,
      sourceTitle: o.sourceTitle || '虚构报告', review: '已核对', analyze: o.analyze || null, name: o.name || null
    };
  }

  test('趋势：无日期与定性结果保留在历史，不参与连线', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 5.2 }),
      pt({ date: null, value: 5.9 }),
      pt({ date: '2024-06-05', value: null })
    ], { analyze: 'glucose' });
    eq(t.connected.length, 1, '仅一个有效数值点进入连线集合');
    eq(t.undated.length, 2, '两条不参与连线');
    eq(t.enough, false, '不足两点不画线');
  });

  test('趋势：少于两个可比较点不画虚假的线', function () {
    var t = L.buildTrend([pt({ date: '2024-01-05', value: 5.2 })], { analyze: 'glucose' });
    eq(t.enough, false);
    ok(t.notes.join('').indexOf('不足 2 个') >= 0, '应提示点不足');
  });

  test('趋势：不同测量条件不串成同一条线', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 5.2, condition: '空腹' }),
      pt({ date: '2024-06-05', value: 5.4, condition: '空腹' }),
      pt({ date: '2024-03-05', value: 8.1, condition: '餐后 2 小时' }),
      pt({ date: '2024-09-05', value: 8.6, condition: '餐后 2 小时' })
    ], { analyze: 'glucose' });
    eq(t.conditions.length, 2, '两个条件');
    eq(t.condition, '空腹', '连线取点数最多的条件');
    eq(t.connected.length, 2);
    ok(t.notes.join('').indexOf('已按条件分开') >= 0, '应说明按条件分开');
  });

  test('趋势：尿酸未归一化多单位组只连唯一多数组', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 400, unit: 'μmol/L' }),
      pt({ date: '2024-03-05', value: 420, unit: 'μmol/L' }),
      pt({ date: '2024-05-05', value: 430, unit: 'μmol/L' }),
      pt({ date: '2024-07-05', value: 7.2, unit: 'mg/L' })
    ], { analyze: 'uric_acid' });
    eq(t.lineUnit, 'μmol/L');
    eq(t.connected.length, 3);
    ok(t.notes.join('').indexOf('未归一化的多单位组') >= 0, '应提示未连线数量');
  });

  test('趋势：最大单位组平票就不任选一组连线', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 400, unit: 'μmol/L' }),
      pt({ date: '2024-03-05', value: 420, unit: 'μmol/L' }),
      pt({ date: '2024-05-05', value: 7.2, unit: 'mg/L' }),
      pt({ date: '2024-07-05', value: 7.4, unit: 'mg/L' })
    ], { analyze: 'uric_acid' });
    eq(t.tie, true, '应记为平票');
    eq(t.connected.length, 0, '平票不连线');
  });

  test('趋势：mg/dL 记录经受控换算后与 mmol/L 归入同一线', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 5.2, unit: 'mmol/L' }),
      pt({ date: '2024-06-05', value: 100, unit: 'mg/dL' })
    ], { analyze: 'glucose' });
    eq(t.lineUnit, 'mmol/L');
    eq(t.connected.length, 2, '换算后归入同一单位组');
    eq(t.connected[1].normValue, 5.56, '100 mg/dL ÷ 18');
  });

  test('趋势：最新结果取有有效日期的最近结果', function () {
    var t = L.buildTrend([
      pt({ date: '2024-01-05', value: 5.2 }),
      pt({ date: '2025-06-05', value: 5.9 }),
      pt({ date: null, value: 9.9 })
    ], { analyze: 'glucose' });
    eq(t.distinctDates[t.distinctDates.length - 1], '2025-06-05', '最新有效日期');
    eq(t.latest[0].value, 5.9, '无日期记录不得当作最新检查');
  });

  test('血压：两条线分别取收缩压与舒张压，共用一个纵轴', function () {
    var bp = L.buildBPtrend([
      pt({ date: '2024-01-05', value: 130, value2: 85, unit: 'mmHg' }),
      pt({ date: '2024-06-05', value: 124, value2: 78, unit: 'mmHg' })
    ]);
    eq(bp.systolic.length, 2);
    eq(bp.diastolic.length, 2);
    eq(bp.systolic[0].value, 130);
    eq(bp.diastolic[0].value, 85);
    eq(bp.unit, 'mmHg');
    eq(bp.enough, true);
  });

  test('血脂：同一日期的四项不显示为四次检查', function () {
    var lip = L.lipidSummary({
      tc: [pt({ date: '2025-12-13', value: 6.58, unit: 'mmol/L' })],
      tg: [pt({ date: '2025-12-13', value: 1.5, unit: 'mmol/L' })],
      hdl: [pt({ date: '2025-12-13', value: 1.1, unit: 'mmol/L' })],
      ldl: [pt({ date: '2025-12-13', value: 4.23, unit: 'mmol/L' })]
    });
    eq(lip.checkCount, 1, '检查次数按日期去重');
    eq(lip.label, '检查次数');
  });

  /* ================= 5.5 测量条件与报告分组名 ================= */

  // 真实库里的 condition 大多是 OCR 抄进来的「分组 / 机构套餐名」，不是测量条件：
  // 肾功三项，华大检验 / 检验项目：生化-肾功 / 慈铭-肾功能3项 / 高密度脂蛋白（2023）。
  // 按字符串分组会把同一分析物切成一串单点序列，趋势连不起来，「最新结果」还会取到几年前的值。
  test('分组名与机构套餐名不算测量条件', function () {
    var labels = ['生化-肾功', '肾功三项，华大检验', '检验项目：生化-肾功', '慈铭-肾功能3项',
      '高密度脂蛋白（2023）', '生化-血脂', '免疫发光', '尿常规'];
    labels.forEach(function (c) {
      ok(L.conditionIsPanelLabel(c), '应当判为分组/套餐名：' + c);
    });
    ['空腹', '餐后 2 小时', '静息', '坐位', '晨起', '随机', '服糖后 2 小时', ''].forEach(function (c) {
      ok(!L.conditionIsPanelLabel(c), '真实测量条件不得被判成标签：' + c);
    });
  });

  test('分组名合并后趋势重新连线，最新结果取真正的最新日期', function () {
    var pts = [
      { date: '2025-12-13', value: 541.1, unit: 'μmol/L', condition: '生化-肾功', source: '报告提取' },
      { date: '2024-12-28', value: 584, unit: 'μmol/L', condition: null, source: '报告提取' },
      { date: '2024-05-19', value: 378.2, unit: 'μmol/L', condition: '检验项目：生化-肾功', source: '报告提取' },
      { date: '2020-07-12', value: 328.1, unit: 'μmol/L', condition: '慈铭-肾功能3项', source: '报告提取' }
    ];
    var t = L.buildTrend(pts, {});
    eq(t.conditions.length, 1, '四条应并入同一个条件组');
    eq(t.connected.length, 4, '四个点应连成一条线');
    eq(t.latest.length && t.latest[0].date, '2025-12-13', '最新结果要取 2025-12-13');
    // 真条件仍必须隔离：不同条件不串线（指令 §16）
    var mixed = pts.concat([
      { date: '2024-06-01', value: 400, unit: 'μmol/L', condition: '餐后 2 小时', source: '手动录入' },
      { date: '2024-06-02', value: 410, unit: 'μmol/L', condition: '空腹', source: '手动录入' }
    ]);
    var m = L.buildTrend(mixed, {});
    eq(m.conditions.length, 3, '空腹 / 餐后 / 未标注 三个条件要分开');
    eq(m.groups['空腹'].list.length, 1, '空腹组只含空腹那条');
    eq(m.groups['餐后 2 小时'].list.length, 1, '餐后者独立成组');
  });

  /* 混合写法才是真实数据的常态：一个 condition 里同时有测量状态和栏目名
     （`空腹，检验项目：生化-血糖`、`肾功三项，华大检验`）。只判"整串是不是栏目名"
     会把空腹与餐后2小时并成同一组，画出一条假上升线 —— 比不连线更糟。 */
  test('混合写法：先剥栏目词，再在剩下的文本里认测量状态', function () {
    eq(L.conditionSeriesKey('空腹，检验项目：生化-血糖'), '空腹', '剥掉栏目词后仍要认出「空腹」');
    eq(L.conditionSeriesKey('体检-空腹'), '空腹', '栏目前缀 + 空腹');
    ok(L.conditionSeriesKey('体检-空腹') !== L.conditionSeriesKey('体检-餐后2小时'),
      '空腹与餐后绝不能并进同一组');
    eq(L.conditionSeriesKey('服糖后 2 小时（生化）'), '服糖后 2 小时', '真时点要完整保留');
    eq(L.conditionSeriesKey('肾功三项，华大检验'), '未标注条件', '纯栏目名仍然并回未标注');
  });

  /* ================= 5.7 只有「一个」有效日期口径 ================= */
  /* 指令 §18：日期待确认的记录可以查看，但不能进入按日期计算的趋势。
     真实库里同时存在 '待确认' 与 '日期待确认' 两种写法（四个写方 vs 两个读方），
     而读方只认后者 —— 于是 8 条档案里 4 条带着 guessDate() 猜出来的日期，
     同时出现在趋势、年度费用与「覆盖的有效日期」里。这里把四个口径钉成同一个谓词。 */
  test('待确认日期：时间线 / 趋势 / 资料活动 / 年度费用 必须同时排除', function () {
    var pend = {
      id: 81, primary_date: '2025-12-13', date_status: '待确认', person_id: 1, document_type: '体检报告',
      type_specific_data: { lab_results: [{ name: '血尿酸', result: '541', unit: 'μmol/L' }] }
    };
    var conf = {
      id: 82, primary_date: '2026-01-05', date_status: '已确认', person_id: 1, document_type: '体检报告',
      type_specific_data: { lab_results: [{ name: '血尿酸', result: '300', unit: 'μmol/L' }] }
    };
    eq(L.hasEffectiveDate(pend), false, '谓词：状态待确认就不算有效日期，哪怕日期字段能解析');
    eq(L.hasEffectiveDate(conf), true, '谓词：已确认 + 日期可解析才算有效');
    eq(L.hasEffectiveDate({ primary_date: '2026-01-05', date_status: '已确认' }), true, '缺字段的旧行不误判');
    var g = L.groupTimeline([pend, conf]);
    eq(g.pending.length, 1, '时间线：两种拼法都要落进 pending 桶');
    var pts = L.deriveIndicatorPoints([pend, conf], L.PRESET_CATALOG);
    var t = L.buildTrend(pts.filter(function (p) { return p.indicatorKey === 'ua'; }), {});
    eq(t.connected.length, 1, '趋势：只有已确认那条参与连线');
    eq(t.latest.length && t.latest[0].rawDate, '2026-01-05', '「最新结果」不得取自待确认那份猜测日期');
    ok(t.notes.join('').indexOf('待确认') >= 0, '要说明为什么被剔除');
    var act = L.buildActivity([pend, conf]);
    eq(act.length, 1, '资料活动：待确认那份不计入月份');
    eq(act[0].total, 1, '年度合计也只含已确认');
    var f = L.buildFees([
      { id: 83, document_type: '医疗发票/收费单', primary_date: '2025-12-13', date_status: '待确认', amount: 100 },
      { id: 84, document_type: '医疗发票/收费单', primary_date: '2026-01-05', date_status: '已确认', amount: 200 }
    ]);
    eq(f.yearList.length, 1, '年度费用：待确认票据不进年度图');
    eq(f.yearList[0].amount, '¥200.00', '年度只含已确认那一张');
    eq(f.total, '¥300.00', '总额仍包含待确认（它只是不参与按日期的统计）');
    var lipPts = {};
    ['tc', 'tg', 'hdl', 'ldl'].forEach(function (k) {
      lipPts[k] = [{ date: '2025-06-06', dateStatus: '待确认', value: 5.9 }];
    });
    eq(L.lipidSummary(lipPts).checkCount, 0, '血脂「检查次数」也不认待确认日期（同一个口径）');
  });

  test('血压双线与 OGTT 同样不认待确认日期', function () {
    var bp = L.buildBPtrend([
      { date: '2025-12-13', dateStatus: '待确认', value: 140, value2: 90, unit: 'mmHg' },
      { date: '2026-01-05', dateStatus: '已确认', value: 118, value2: 76, unit: 'mmHg' }
    ]);
    eq(bp.systolic.length, 1, '血压：待确认那条不参与连线');
    eq(bp.systolic[0].value, 118, '留下的是已确认那条');
  });

  /* ================= 5.8 栏目名与测量状态要能拆回两个字段 ================= */
  /* 待办 17 后半：`panel` / `condition` 的字段契约已在结构化提示词里立好（阶段 18），
     但存量 8 条档案里 900 个 lab 项有 495 项的栏目名仍躺在 `condition` 上（75 种写法）。
     回改需要一个"怎么拆"的判据，而这个判据必须与展示层同源 —— 否则拆完再判，
     分组键会变，趋势线当场就动了。所以拆法单独成函数，并把它与 conditionSeriesKey
     的不变量钉死：**拆分前后，任何一条的连线分组键都不许变**。 */
  test('splitCondition：栏目名与测量状态各归各位', function () {
    eq(JSON.stringify(L.splitCondition('')), '{"panel":"","condition":""}', '空串不进不出');
    eq(JSON.stringify(L.splitCondition('空腹')), '{"panel":"","condition":"空腹"}',
      '纯测量状态：一个字符都不搬');
    eq(JSON.stringify(L.splitCondition('检验项目：生化-肝功')), '{"panel":"生化-肝功","condition":""}',
      '纯栏目名：整串挪去 panel，并剥掉「检验项目：」这类前缀');
    eq(JSON.stringify(L.splitCondition('空腹，检验项目：生化-血糖')),
      '{"panel":"生化-血糖","condition":"空腹"}', '混合写法：各归一位（真实数据的常态）');
    eq(JSON.stringify(L.splitCondition('体检-空腹')), '{"panel":"体检","condition":"空腹"}',
      '连字符写法：留在栏目名一侧的分隔符要收掉');
    eq(L.splitCondition('血常规五分类，检验时间2025-02-15 12:22:41').panel,
      '血常规五分类，检验时间2025-02-15 12:22:41',
      '带检验时间的整串属于栏目名侧，原样保留、不猜测时间');
    eq(JSON.stringify(L.splitCondition('A 模式')), '{"panel":"","condition":"A 模式"}',
      '两头都不像的串原样留在 condition —— 宁可不动，不可销毁');
    eq(L.splitCondition('心肌酶谱3项').condition, '', '判为栏目名时 condition 必须清空');
  });

  test('splitCondition 的不变量：拆完再判，分组键一个都不许变', function () {
    var cases = ['', '空腹', '餐后2小时', '禁食', '检验项目：生化-肝功', '体检-空腹',
      '空腹，检验项目：生化-血糖', '坐位，检查科室：超声诊断', 'A 模式', '静息',
      '生化-肾功（2023）', '服糖后 2 小时，检验项目： OGTT'];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var s = L.splitCondition(c);
      eq(L.conditionSeriesKey(s.condition), L.conditionSeriesKey(c),
        '不变量：' + JSON.stringify(c) + ' → panel=' + JSON.stringify(s.panel));
      // panel 只能是原串里真实出现过的片段（去掉「检验项目：」前缀除外），不得凭空造字
      if (s.panel) ok(L.normName(c).indexOf(L.normName(s.panel)) >= 0 ||
        c.indexOf('：') >= 0 || c.indexOf('-') >= 0,
        'panel 必须来自原串：' + JSON.stringify(c) + ' / ' + JSON.stringify(s.panel));
      // 二次搬运必须稳：把拆出的 condition 再拆一次，不该再掉出任何 panel
      eq(L.splitCondition(s.condition).panel, '', '幂等：拆出的 condition 再拆不出栏目名：' + JSON.stringify(c));
    }
  });

  /* ================= 5.9 与指标自身含义重复的条件不再分裂序列 ================= */
  /* 真实库复核发现的残留（待办 18）：`空腹血糖` 的 6 条里 5 条写着 condition=空腹、1 条为空，
     于是被切成「空腹」5 点与「未标注条件」1 点两组，各自都撑不起一条线。
     「空腹」对这个指标是同义重复 —— 它没有指出第二个测量点。
     判据取"条件短语是否已被指标自己的名字说过"，而不是维护一张指标↔词的搭配表；
     真条件（同一指标的空腹 vs 餐后 2 小时）必须继续隔离，否则会把两个时点连成一条假上升线。 */
  test('conditionEntailedByName：只看"这个名字是否已经说过这个测量状态"', function () {
    eq(L.conditionEntailedByName('空腹', '空腹血糖'), true, '名字已含空腹');
    eq(L.conditionEntailedByName('空腹', '血糖'), false, '名字没提空腹，条件就是唯一信息');
    eq(L.conditionEntailedByName('餐后2小时', '空腹血糖'), false, '另一个时点不算同义');
    eq(L.conditionEntailedByName('空腹', '餐后2小时血糖'), false, '反过来也不该并');
    eq(L.conditionEntailedByName('餐后', '餐后2小时血糖'), true,
      '该指标本就是餐后那个时点，写不写数字是同一个点');
    eq(L.conditionEntailedByName('餐后２小时', '餐后2小时血糖'), true, '全角数字要认得');
    eq(L.conditionEntailedByName('餐后两个小时', '餐后 2 小时血糖'), true, '中文数字与空格要认得');
    eq(L.conditionEntailedByName('餐后半小时', '餐后30分钟血糖'), false,
      '半小时 / 30 分钟写法不同就不猜 —— 宁可分裂，不可误合并');
    eq(L.conditionEntailedByName('静息', '血压'), false, '血压的定义里没写静息');
    eq(L.conditionEntailedByName('', '空腹血糖'), false, '空条件谈不上同义');
  });

  test('同义条件并进同一序列：空腹血糖 6 条不再被切成两组', function () {
    function rec(id, cond, date) {
      return {
        id: id, document_type: '体检报告', primary_date: date, date_status: '已确认', person_id: 1,
        type_specific_data: { lab_results: [{ name: '空腹血糖', condition: cond, result: '5.' + id, unit: 'mmol/L' }] }
      };
    }
    var recs = [rec(201, '空腹', '2021-01-01'), rec(202, '空腹', '2022-01-01'),
      rec(203, '空腹，检验项目：生化-血糖', '2023-01-01'), rec(204, '', '2024-01-01'),
      rec(205, null, '2025-01-01'), rec(206, '空腹', '2025-06-01')];
    var pts = L.deriveIndicatorPoints(recs, L.PRESET_CATALOG)
      .filter(function (p) { return p.indicatorKey === 'fbg'; });
    eq(pts.length, 6, '六条都该落到空腹血糖这个指标上');
    var t = L.buildTrend(pts, {});
    eq(t.conditions.length, 1, '同义条件不再产生第二条线');
    eq(t.connected.length, 6, '六个点全部参与连线');
    var sum = Object.keys(t.groups).reduce(function (a, k) { return a + t.groups[k].list.length; }, 0);
    eq(sum, 6, '点数守恒：合并不能把点弄丢');
    eq(t.latest.length && t.latest[0].rawDate, '2025-06-01', '「最新结果」取到真正最新的那条');
  });

  test('真条件仍然隔离：同一名指标的空腹与餐后 2 小时不得并成一组', function () {
    function rec(id, cond) {
      return {
        id: 220 + id, document_type: '体检报告', primary_date: '2024-0' + (id % 9 + 1) + '-05',
        date_status: '已确认', person_id: 1,
        type_specific_data: { lab_results: [{ name: '空腹血糖', condition: cond, result: '6.0', unit: 'mmol/L' }] }
      };
    }
    var pts = L.deriveIndicatorPoints(
      [rec(1, '空腹'), rec(2, '空腹'), rec(3, '空腹'), rec(4, '餐后2小时'), rec(5, '服糖后2小时')],
      L.PRESET_CATALOG).filter(function (p) { return p.indicatorKey === 'fbg'; });
    var t = L.buildTrend(pts, {});
    eq(t.conditions.length, 3, '空腹（同义→未标注）/ 餐后2小时 / 服糖后2小时 各自一组');
    var sizes = Object.keys(t.groups).map(function (k) { return t.groups[k].list.length; }).sort();
    eq(sizes.join(','), '1,1,3', '空腹那三条合成一组，两个时点各留一组，绝不串线');
    var longest = Object.keys(t.groups).filter(function (k) { return /餐后/.test(k); });
    eq(longest.length, 1, '「餐后2小时」这一组确实存在且独立');
  });

  test('同义判定也可以只来自指标定义（报告上写的是「血糖」）', function () {
    // 报告项目名不含「空腹」，但指标定义是「空腹血糖」—— 这时同义判定要由
    // 派生点带上的 indicatorLabel 提供，否则又会出现"同义条件切第二组"。
    var CAT = [{ key: 'fbg_x', name: '空腹血糖', grp: '血糖', type: '数值', unit: 'mmol/L',
      followed: true, preset: false, order: 1, analyze: 'glucose', aliases: ['血糖'] }];
    function rec(id, cond, date) {
      return {
        id: 260 + id, document_type: '检验报告', primary_date: date, date_status: '已确认', person_id: 1,
        type_specific_data: { lab_results: [{ name: '血糖', condition: cond, result: '5.4', analyze: 'glucose' }] }
      };
    }
    var pts = L.deriveIndicatorPoints([rec(1, '空腹', '2024-03-01'), rec(2, '', '2025-03-01')], CAT)
      .filter(function (p) { return p.indicatorKey === 'fbg_x'; });
    eq(pts.length, 2, '两条都落到这个指标上');
    eq(pts[0].indicatorLabel, '空腹血糖', '派生点要带上指标自己的名字（同义判定的依据）');
    var t = L.buildTrend(pts, {});
    eq(t.conditions.length, 1, '报告名不含空腹时，仍按指标定义判同义');
    eq(t.connected.length, 2, '两点连成一条线');
  });

  /* ================= 6. OGTT ================= */

  test('OGTT：同日两份独立试验按来源隔离，不混成一条曲线', function () {
    var pts = [];
    [0, 30, 60, 120, 180].forEach(function (m) {
      pts.push(pt({ date: '2025-06-01', value: 5.0 + m / 100, unit: 'mmol/L', condition: m + '分钟', sourceRecordId: 101, analyze: 'glucose' }));
      pts.push(pt({ date: '2025-06-01', value: 4.8 + m / 90, unit: 'mmol/L', condition: m + '分钟', sourceRecordId: 202, analyze: 'glucose' }));
    });
    var og = L.buildOGTT(pts, 'glucose');
    eq(og.trials.length, 2, '同日两份试验必须隔离');
    eq(og.trials[0].curvePoints.length, 5);
    eq(og.trials[1].curvePoints.length, 5);
    eq(og.trialCount, 2);
  });

  test('OGTT：缺时点不补零、不插值', function () {
    var pts = [
      pt({ date: '2025-06-01', value: 5.0, unit: 'mmol/L', condition: '空腹', sourceRecordId: 1, analyze: 'glucose' }),
      pt({ date: '2025-06-01', value: 8.1, unit: 'mmol/L', condition: '120分钟', sourceRecordId: 1, analyze: 'glucose' })
    ];
    var og = L.buildOGTT(pts, 'glucose');
    eq(og.trials.length, 1);
    eq(og.trials[0].curvePoints.length, 2, '只有两个实测点');
    eq(og.trials[0].missing.length, 3, '三个缺项时点');
    ok(og.trials[0].missing.indexOf('30 分钟') >= 0, '30 分钟为缺项');
    eq(og.trials[0].points.length, 2, '不生成补零点');
  });

  test('OGTT：葡萄糖与胰岛素分开', function () {
    var pts = [
      pt({ date: '2025-06-01', value: 5.0, unit: 'mmol/L', condition: '空腹', sourceRecordId: 1, analyze: 'glucose' }),
      pt({ date: '2025-06-01', value: 12.0, unit: 'mIU/L', condition: '空腹', sourceRecordId: 1, analyze: null, name: '胰岛素' })
    ];
    var og = L.buildOGTT(pts, 'glucose');
    eq(og.trials[0].points.length, 1, '胰岛素不进入葡萄糖曲线');
  });

  test('OGTT：全部无日期时不报错、不计正式试验', function () {
    var og = L.buildOGTT([
      pt({ date: null, value: 5.0, unit: 'mmol/L', condition: '空腹', analyze: 'glucose' })
    ], 'glucose');
    eq(og.trials.length, 0);
    eq(og.trialCount, 0);
    eq(og.undated.length, 1);
    ok(!!og.note, '应给出空态说明');
    ok(!!og.byTimepoint[0], '时点趋势容器必须存在，避免访问空对象');
  });

  test('OGTT：相同时点跨年度趋势按各自时点独立聚合', function () {
    var pts = [];
    ['2024-06-01', '2025-06-01'].forEach(function (d, i) {
      [0, 30, 60, 120, 180].forEach(function (m) {
        pts.push(pt({ date: d, value: 5 + i + m / 100, unit: 'mmol/L', condition: m + '分钟', sourceRecordId: 10 + i, analyze: 'glucose' }));
      });
    });
    var og = L.buildOGTT(pts, 'glucose');
    eq(og.byTimepoint[0].length, 2, '空腹跨年 2 点');
    eq(og.byTimepoint[180].length, 2, '180 分钟跨年 2 点');
    eq(og.byTimepoint[30][0].date, '2024-06-01', '按时点升序');
  });

  /* ================= 7. 费用 ================= */

  test('费用：验收口径 —— 明确金额 250 元 5 张，有日期年度合计 230 元', function () {
    var recs = [
      rec({ id: 1, document_type: '医疗发票/收费单', primary_date: '2022-03-01', amount: 100, title: '虚构票据 A', file_hash: 'h1' }),
      rec({ id: 2, document_type: '医疗发票/收费单', primary_date: '2022-08-01', amount: 50, title: '虚构票据 B', file_hash: 'h2' }),
      rec({ id: 3, document_type: '医疗发票/收费单', primary_date: '2023-04-01', amount: 80, title: '虚构票据 C', file_hash: 'h3' }),
      rec({ id: 4, document_type: '医疗发票/收费单', primary_date: null, amount: 20, title: '虚构无日期票据', file_hash: 'h4' }),
      rec({ id: 5, document_type: '医疗发票/收费单', primary_date: '2023-05-01', amount: null, title: '虚构金额未知票据', file_hash: 'h5' }),
      rec({ id: 6, document_type: '医疗发票/收费单', primary_date: '2022-12-01', amount: 0, title: '虚构零元票据', file_hash: 'h6' })
    ];
    var f = L.buildFees(recs);
    eq(f.total, '¥250.00', '明确金额总额');
    eq(f.counts.known, 5, '明确金额票据数（含零元）');
    eq(f.counts.unknown, 1, '金额未知张数');
    eq(f.counts.zero, 1, '明确零元张数');
    eq(f.datedTotal, '¥230.00', '有日期年度合计');
    eq(f.yearList.filter(function (y) { return y.year === '2022'; })[0].count, 3, '2022 年张数（含零元）');
    eq(f.yearList.filter(function (y) { return y.year === '2022'; })[0].amount, '¥150.00', '2022 年合计');
    eq(f.yearList.filter(function (y) { return y.year === '2023'; })[0].count, 1, '2023 年仅 1 张明确金额');
    ok(!!f.gapNote, '应解释年度小计与总额的差额来源');
  });

  test('费用：顶层金额为空但结构化总额明确时不漏计', function () {
    var f = L.buildFees([rec({
      id: 1, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: null,
      type_specific_data: { total_amount: 66.5 }, file_hash: 'x1'
    })]);
    eq(f.total, '¥66.50');
    eq(f.counts.known, 1);
  });

  test('费用：顶层与嵌套金额冲突时取顶层并标记待核对', function () {
    var a = L.receiptAmount({ amount: 100, type_specific_data: { total_amount: 120 } });
    eq(a.value, 10000);
    ok(!!a.conflict, '应记录冲突说明');
  });

  test('费用：医保与个人支付全缺失显示未提供，不显示已支付零元', function () {
    var f = L.buildFees([rec({ id: 1, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: 30, file_hash: 'y1' })]);
    eq(f.insurance, '未提供');
    eq(f.selfPay, '未提供');
    eq(f.insuranceMissing, 1);
    ok(f.insurance !== '¥0.00', '未知不得显示为 ¥0.00');
  });

  test('费用：已知拆分只汇总已知部分并暴露覆盖范围', function () {
    var f = L.buildFees([
      rec({ id: 1, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: 30, file_hash: 'z1', type_specific_data: { insurance_payment: 20, self_payment: 10 } }),
      rec({ id: 2, document_type: '医疗发票/收费单', primary_date: '2024-03-01', amount: 50, file_hash: 'z2' })
    ]);
    eq(f.insurance, '¥20.00');
    eq(f.selfPay, '¥10.00');
    eq(f.insuranceMissing, 1, '一张缺失要可见');
    eq(f.selfMissing, 1);
  });

  test('费用：重复上传同一逻辑票据不重复计费', function () {
    var f = L.buildFees([
      rec({ id: 1, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: 30, file_hash: 'same' }),
      rec({ id: 2, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: 30, file_hash: 'same' })
    ]);
    eq(f.total, '¥30.00', '同一逻辑票据只计一次');
    eq(f.counts.known, 1);
    eq(f.counts.duplicateSkipped, 1);
  });

  test('费用：处方金额不进入费用统计', function () {
    var f = L.buildFees([rec({ id: 1, document_type: '处方/用药单', primary_date: '2024-02-01', amount: 88 })]);
    eq(f.total, '¥0.00');
    eq(f.list.length, 0, '处方不进入票据列表');
  });

  test('费用：金额按分用整数运算，输出两位小数', function () {
    var f = L.buildFees([
      rec({ id: 1, document_type: '医疗发票/收费单', primary_date: '2024-02-01', amount: 0.1, file_hash: 'a' }),
      rec({ id: 2, document_type: '医疗发票/收费单', primary_date: '2024-02-02', amount: 0.2, file_hash: 'b' })
    ]);
    eq(f.total, '¥0.30', '避免浮点误差');
  });

  /* ================= 8. 时间线 ================= */

  test('时间线：同日三份资料汇总为一个日期组，仍是三份档案', function () {
    var g = L.groupTimeline([
      rec({ id: 1, primary_date: '2025-12-13', document_type: '检验报告' }),
      rec({ id: 2, primary_date: '2025-12-13', document_type: '检查报告' }),
      rec({ id: 3, primary_date: '2025-12-13', document_type: '医疗发票/收费单' })
    ]);
    eq(g.dateGroups.length, 1, '一个日期组');
    eq(g.dateGroups[0].records.length, 3, '组内三份档案');
  });

  test('时间线：年 → 月 → 日分层且按日期倒序', function () {
    var g = L.groupTimeline([
      rec({ id: 1, primary_date: '2024-01-05' }),
      rec({ id: 2, primary_date: '2025-12-13' }),
      rec({ id: 3, primary_date: '2025-03-02' })
    ]);
    eq(g.years.map(function (y) { return y.year; }), ['2025', '2024'], '年份倒序');
    eq(g.years[0].monthList.map(function (m) { return m.month; }), ['12', '03'], '月份倒序');
    eq(g.dateGroups[0].date, '2025-12-13', '日期倒序');
  });

  test('时间线：默认展开最近 10 个日期组，更早内容按月折叠', function () {
    var recs = [];
    for (var d = 1; d <= 25; d++) {
      recs.push(rec({ id: d, primary_date: '2025-01-' + L.pad2(d) }));
    }
    var g = L.groupTimeline(recs);
    eq(g.dateGroups.length, 25);
    eq(g.dateGroups.filter(function (x) { return x.recent; }).length, 10, '最近 10 个日期组');
    var olderInMonth = g.years[0].monthList[0].dates.filter(function (x) { return !x.recent; }).length;
    eq(olderInMonth, 15, '其余按月折叠');
  });

  test('资料活动：按年汇总并可展开月份', function () {
    var a = L.buildActivity([
      rec({ id: 1, primary_date: '2025-01-05' }),
      rec({ id: 2, primary_date: '2025-01-20' }),
      rec({ id: 3, primary_date: '2025-03-02' }),
      rec({ id: 4, primary_date: '2024-06-01' }),
      rec({ id: 5, primary_date: null })
    ]);
    eq(a.length, 2, '两年');
    eq(a[0].year, '2025');
    eq(a[0].total, 3);
    eq(a[0].months.length, 2, '两个月');
    eq(a[0].months[0].count, 2, '1 月两份');
  });

  test('类型分布：覆盖七类且不遗漏', function () {
    var d = L.typeDistribution([
      rec({ id: 1, document_type: '检验报告' }),
      rec({ id: 2, document_type: '检验报告' }),
      rec({ id: 3, document_type: '检查报告' })
    ]);
    eq(d.length, 7, '七类都要出现');
    eq(d.filter(function (x) { return x.type === '检验报告'; })[0].count, 2);
  });

  test('体检报告是归档类型，且排在其他医疗资料之前', function () {
    var i = L.DOC_TYPES.indexOf('体检报告');
    ok(i >= 0, '体检报告必须在 DOC_TYPES 里，否则归档与筛选都选不到它');
    ok(i < L.DOC_TYPES.indexOf('其他医疗资料'), '兜底类型必须排在最后');
  });

  test('体检报告参与类型分布计数', function () {
    var d = L.typeDistribution([
      rec({ id: 1, document_type: '体检报告' }),
      rec({ id: 2, document_type: '体检 报 告' }),
      rec({ id: 3, document_type: '其他医疗资料' })
    ]);
    var hit = d.filter(function (x) { return x.type === '体检报告'; });
    eq(hit.length, 1, '带空格的写法由 normalizeDocType 归一，不额外产生一个桶');
    eq(hit[0].count, 2);
  });

  /* ================= 9. 药品 ================= */

  test('药品：开始 → 暂停 → 停止 → 再次开始，历史不被覆盖', function () {
    var d = { status: '备用药', history: [] };
    var p1 = L.applyDrugEvent(d, { type: '开始', date: '2025-01-01', dose_each_time: '1 片', frequency: '每日 1 次' });
    eq(p1.status, '正在服用');
    eq(p1.history.length, 1);
    eq(p1.history[0].from_status, '备用药');
    eq(p1.history[0].to_status, '正在服用');
    eq(p1.history[0].dose_each_time, '1 片');

    var d2 = Object.assign({}, d, p1);
    var p2 = L.applyDrugEvent(d2, { type: '暂停', date: '2025-02-01' });
    eq(p2.status, '备用药', '暂停回到备用药，不建立第四种状态');

    var d3 = Object.assign({}, d2, p2);
    var p3 = L.applyDrugEvent(d3, { type: '停止', date: '2025-03-01' });
    eq(p3.status, '已停用');
    eq(p3.history.length, 3);

    var d4 = Object.assign({}, d3, p3);
    var p4 = L.applyDrugEvent(d4, { type: '再次开始', date: '2025-04-01', dose_each_time: '2 片', frequency: '每日 2 次' });
    eq(p4.status, '正在服用');
    eq(p4.history.length, 4, '再次开始追加新事件');
    eq(p4.history[0].dose_each_time, '1 片', '上一次实际用药历史完整保留');
    eq(p4.history[3].dose_each_time, '2 片', '新事件记录新的个人用量');
  });

  test('药品：分组与状态一一对应', function () {
    eq(L.drugStatusGroup('正在服用'), 'current');
    eq(L.drugStatusGroup('备用药'), 'reserve');
    eq(L.drugStatusGroup('已停用'), 'history');
    eq(L.drugStatusGroup(undefined), 'reserve', '未知状态归入药箱而非当前用药');
  });

  test('药品：过期 / 缺日期 / 未来开始不影响分类与今日在用口径', function () {
    var today = '2025-06-15';
    eq(L.expiryState({ expiry_date: null }, today).cls, 'exp-unknown');
    eq(L.expiryState({ expiry_date: '2025-07-01' }, today).cls, 'exp-soon');
    eq(L.expiryState({ expiry_date: '2025-12-01' }, today).cls, 'exp-near');
    eq(L.expiryState({ expiry_date: '2025-05-01' }, today).cls, 'exp-past');
    eq(L.expiryState({ expiry_date: '2025-05-01' }, today).expired, true);
    ok(L.expiryState({ expiry_date: '2025-02-30' }, today).cls === 'exp-unknown', '非法日期按待确认处理');

    eq(L.isInUseToday({ status: '正在服用', start_date: '2025-08-01' }, today), false, '未来开始不计入今日在用');
    eq(L.isInUseToday({ status: '正在服用', start_date: '2025-01-01', planned_end_date: '2025-05-01' }, today), false, '计划已结束不计入');
    eq(L.isInUseToday({ status: '正在服用', start_date: '2025-01-01' }, today), true);
    eq(L.isInUseToday({ status: '备用药' }, today), false, '备用药永不计入今日在用');
    eq(L.isInUseToday({ status: '正在服用' }, today), true, '日期未知时按正在服用计入');
  });

  /* ================= 9.5 目录派生与来源提取 ================= */

  test('指标目录：新增目录项（糖化血红蛋白）自动参与来源提取', function () {
    var rec = {
      id: 1, primary_date: '2025-01-01', document_type: '检验报告',
      type_specific_data: {
        lab_results: [
          { name: '糖化血红蛋白', result: '5.50', unit: '%', reference: '4.0-6.0', panel: '糖化血红蛋白' }
        ]
      }
    };
    var pts = L.deriveIndicatorPoints([rec], L.PRESET_CATALOG);
    eq(pts.length, 1, '应提取到 1 个点');
    eq(pts[0].indicatorKey, 'hba1c');
    eq(pts[0].result, '5.50', '结果按原文保留原样');
    eq(pts[0].unit, '%');
  });

  test('指标目录：自定义指标参与来源提取，且不劫持既有归属', function () {
    var catalog = L.PRESET_CATALOG.concat([
      { key: 'apob', name: '载脂蛋白B', grp: '自定义', type: '数值', unit: 'g/L',
        preset: false, aliases: ['载脂蛋白b', 'apob'] }
    ]);
    var rec = {
      id: 1, primary_date: '2025-01-01', document_type: '检验报告',
      type_specific_data: {
        lab_results: [
          { name: '载脂蛋白B', result: '0.95', unit: 'g/L', panel: '生化-血脂' },
          { name: '低密度脂蛋白胆固醇', result: '3.10', unit: 'mmol/L', panel: '生化-血脂' },
          { name: '总胆固醇', result: '5.00', unit: 'mmol/L', panel: '生化-血脂' }
        ]
      }
    };
    var byKey = {};
    L.deriveIndicatorPoints([rec], catalog).forEach(function (p) {
      (byKey[p.indicatorKey] = byKey[p.indicatorKey] || []).push(p);
    });
    eq((byKey.apob || []).length, 1, '自定义指标应能被提取');
    eq((byKey.ldl || []).length, 1, 'LDL 仍归 LDL，不被自定义项劫持');
    eq((byKey.tc || []).length, 1, '总胆固醇不被 LDL 吞掉');
    eq((byKey.hdl || []).length, 0, '未出现的项目不得凭空产生');
  });

  test('OGTT：五点葡萄糖曲线由同一份报告的原文时点组织，胰岛素不混入', function () {
    var labs = [
      { name: '葡萄糖（空腹）', result: '5.20', unit: 'mmol/L', condition: '空腹', panel: '口服葡萄糖耐量试验' },
      { name: '葡萄糖（30 分钟）', result: '9.80', unit: 'mmol/L', condition: '30 分钟', panel: '口服葡萄糖耐量试验' },
      { name: '葡萄糖（60 分钟）', result: '10.60', unit: 'mmol/L', condition: '60 分钟', panel: '口服葡萄糖耐量试验' },
      { name: '葡萄糖（120 分钟）', result: '7.90', unit: 'mmol/L', condition: '120 分钟', panel: '口服葡萄糖耐量试验' },
      { name: '胰岛素（空腹）', result: '8.20', unit: 'μIU/mL', condition: '空腹', panel: '口服葡萄糖耐量试验' }
    ];
    var rec = {
      id: 7, primary_date: '2024-03-15', document_type: '检验报告',
      title: '【虚构】检验报告单', type_specific_data: { lab_results: labs }
    };
    var pts = L.deriveIndicatorPoints([rec], L.PRESET_CATALOG);
    var glu = pts.filter(function (p) { return p.indicatorKey === 'ogtt_glu'; });
    var ins = pts.filter(function (p) { return p.indicatorKey === 'ogtt_ins'; });
    eq(glu.length, 4, '四个葡萄糖时点进入 OGTT 血糖');
    eq(ins.length, 1, '胰岛素进入 OGTT 胰岛素，不与葡萄糖混合');
    eq(pts.filter(function (p) { return p.indicatorKey === 'fbg'; }).length, 0,
      'OGTT 的空腹时点不得同时混入常规空腹血糖');

    var og = L.buildOGTT(glu, 'glucose');
    eq(og.trialCount, 1, '同一份报告同一天算一次试验');
    eq(og.trials[0].curvePoints.length, 4);
    eq(og.trials[0].missing.length, 1, '缺的 180 分钟时点被记为缺项');
    ok(og.trials[0].missing[0].indexOf('180') >= 0, '缺项应为 180 分钟');
    eq(og.trials[0].points.length, 4, '缺项不补零，点数不增加');
  });

  test('OGTT：原文时点写法带空格仍可识别（30 分钟/60 分钟）', function () {
    eq(L.ogttTimepoint('', '葡萄糖（30 分钟）'), 30);
    eq(L.ogttTimepoint('', '葡萄糖（120分钟）'), 120);
    eq(L.ogttTimepoint('空腹', ''), 0);
    eq(L.ogttTimepoint('', '葡萄糖'), null, '没有明确时点就不归入任何时点');
  });

  /* ================= 10. 输出转义 ================= */

  test('输出转义：OCR 正文中的脚本与 HTML 不会被执行', function () {
    var evil = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    var out = L.escapeHtml(evil);
    ok(out.indexOf('<script') < 0, '不得残留可执行 script 标签');
    ok(out.indexOf('onerror="') < 0, '属性中的引号必须被转义');
    ok(out.indexOf('&lt;script&gt;') >= 0, '应转为实体');
    eq(L.escapeHtml(null), '');
    eq(L.escapeHtml('a & b'), 'a &amp; b');
  });

  /* ================= 10.5 手工编辑与留痕 ================= */
  // 留痕只认一种形状：{ target, label, from, to, at, row_name?, note? }
  // target 是路径串 —— 标量字段写 'hospital'，结构化里的标量写
  // 'type_specific_data.total_amount'，明细单元格写 'lab_results.0.result'。

  function lab(name, result, unit) {
    return { name: name, result: result, unit: unit, reference: '0~10', flag: '' };
  }
  function editable(o) {
    return Object.assign({
      id: 1, title: '体检报告书', document_type: '体检报告', primary_date: '2025-12-13',
      date_status: '已确认', hospital: '瑞慈', department: null, doctor: null, amount: null,
      source_file: 'a.pdf', parse_status: '已归档', key_information: null,
      type_specific_data: {
        lab_results: [lab('血红蛋白', '145', 'g/L'), lab('白细胞', '6.1', 'g/L')],
        total_amount: 200
      }
    }, o || {});
  }
  var AT = '2026-09-22T23:59:00';

  test('diffRecordEdits：只记真正变化的字段，值相同的不产生留痕', function () {
    var prev = editable();
    var e = L.diffRecordEdits(prev, { title: '体检报告书', hospital: '另一家医院' }, { at: AT });
    eq(e.length, 1, '标题没改就不该有标题的留痕');
    eq(e[0].target, 'hospital');
    eq(e[0].from, '瑞慈');
    eq(e[0].to, '另一家医院');
    eq(e[0].at, AT);
  });

  test('diffRecordEdits：null 与空串视为同一个「没填」，不算改动', function () {
    eq(L.diffRecordEdits(editable({ department: null }), { department: '' }, { at: AT }).length, 0,
      '从 null 改成空串不该记');
    eq(L.diffRecordEdits(editable({ department: '' }), { department: null }, { at: AT }).length, 0,
      '反向同理');
    eq(L.diffRecordEdits(editable({ amount: 100 }), { amount: '100' }, { at: AT }).length, 0,
      '数字与同值字符串不该被当成改动');
  });

  test('留痕一律带中文标签，界面上不许出现英文字段名', function () {
    var prev = editable();
    var scalars = ['title', 'document_type', 'primary_date', 'date_status', 'hospital', 'department',
      'doctor', 'amount', 'source_file', 'parse_status', 'key_information', 'person_id'];
    var patch = {};
    scalars.forEach(function (f) { patch[f] = 'v_' + f; });
    var e = L.diffRecordEdits(prev, patch, { at: AT });
    eq(e.length, scalars.length, '这些字段都要可编辑并留痕');
    e.forEach(function (it) {
      ok(it.label && !/^[a-z_.]+$/.test(it.label), it.target + ' 缺中文标签：' + it.label);
    });
    eq(L.editLabel('hospital'), '医院');
    eq(L.editLabel('type_specific_data.total_amount'), '结构化总金额');
    ok(L.editLabel('lab_results.0.result').indexOf('结果') >= 0,
      '单元格也要有标签：' + L.editLabel('lab_results.0.result'));
  });

  test('结构化明细的留痕：单元格用路径，并带上项目名称', function () {
    var prev = editable();
    var next = JSON.parse(JSON.stringify(prev.type_specific_data));
    next.lab_results[0].result = '138';
    next.total_amount = 260;
    var e = L.diffRecordEdits(prev, { type_specific_data: next }, { at: AT });
    eq(e.length, 2, '一个格子 + 一个总金额');
    var cell = e.filter(function (x) { return x.target === 'lab_results.0.result'; })[0];
    ok(cell, '缺单元格留痕：' + JSON.stringify(e));
    eq(cell.from, '145');
    eq(cell.to, '138');
    eq(cell.row_name, '血红蛋白', '下标会变，留痕里得留下当时的项目名才认得出来');
    var money = e.filter(function (x) { return x.target === 'type_specific_data.total_amount'; })[0];
    ok(money, '结构化总金额的改动必须留痕（卡片第二格就写这里）');
    eq(money.from, 200);
    eq(money.to, 260);
  });

  test('明细行数变化时不崩，退化为该表整体一条', function () {
    var prev = editable();
    var next = JSON.parse(JSON.stringify(prev.type_specific_data));
    next.lab_results.push(lab('血小板', '200', 'g/L'));
    var e = L.diffRecordEdits(prev, { type_specific_data: next }, { at: AT });
    eq(e.length, 1);
    eq(e[0].target, 'lab_results', '行数不同无法逐格对齐，退化成整表一条');
    ok(e[0].label.indexOf('检验') >= 0, '标签要说得清是哪张表：' + e[0].label);
  });

  test('tsSetCopy：返回新的 type_specific_data，绝不就地改原对象', function () {
    var prev = editable();
    var before = JSON.stringify(prev);
    var next = L.tsSetCopy(prev.type_specific_data, 'lab_results.0.result', '99');
    eq(JSON.stringify(prev), before, '原对象被就地改了');
    eq(next.lab_results[0].result, '99');
    eq(next.lab_results[1].result, '6.1', '没点到的格子保持原值');
    eq(next.total_amount, 200, '同层别的键原样保留');
  });

  test('tsSetCopy：路径不存在时原样返回拷贝，不凭空造行造列', function () {
    var tsd = editable().type_specific_data;
    eq(L.tsSetCopy(tsd, 'lab_results.9.result', '1').lab_results.length, 2, '越界下标不得拉长数组');
    eq(L.tsSetCopy(tsd, 'no_such.0.x', '1').no_such, undefined, '不存在的键不该被创建');
    eq(L.tsSetCopy(tsd, 'exams.0.finding', 'x').lab_results.length, 2,
      '目标表不存在时其他表不得受影响');
  });

  test('editedCells：给渲染层一张「哪个目标被改过」的表', function () {
    var rec = editable({
      manual_edits: [
        { target: 'lab_results.0.result', label: '检验项结果', row_name: '血红蛋白', from: '145', to: '138', at: AT },
        { target: 'hospital', label: '医院', from: '瑞慈', to: '另一家', at: AT }
      ]
    });
    var m = L.editedCells(rec);
    eq(m['lab_results.0.result'].from, '145', '被改过的检验项要能被查到');
    eq(m['hospital'].to, '另一家', '标量字段也进这张表，界面统一按 target 查');
  });

  test('同一目标改两次：显示取最近一次，原值取最早那次，历史两条都留着', function () {
    var rec = editable({
      manual_edits: [
        { target: 'hospital', label: '医院', from: '瑞慈', to: '甲医院', at: '2026-01-01T00:00:00' },
        { target: 'hospital', label: '医院', from: '甲医院', to: '乙医院', at: '2026-02-01T00:00:00' }
      ]
    });
    eq(L.editOf(rec, 'hospital').to, '乙医院');
    eq(L.originalValue(rec, 'hospital'), '瑞慈', '追溯要能回到原件上的那个值');
    eq(L.editSummary(rec).count, 2, '两次都要保留，不许合并');
  });

  test('editSummary：汇总改了几处、涉及哪些目标、最后一次在何时', function () {
    var rec = editable({
      manual_edits: [
        { target: 'hospital', label: '医院', from: 'a', to: 'b', at: '2026-01-01T00:00:00' },
        { target: 'lab_results.0.result', label: '检验项结果', row_name: '血红蛋白', from: '1', to: '2', at: '2026-03-01T00:00:00' }
      ]
    });
    var s = L.editSummary(rec);
    eq(s.count, 2);
    eq(s.targets.length, 2, '医院与某个检验项算两处');
    eq(s.lastAt, '2026-03-01T00:00:00');
    eq(L.hasEdits(rec), true);
  });

  test('没有留痕的记录返回空汇总，传 null 或坏数据也不崩', function () {
    eq(L.editSummary(editable()).count, 0);
    eq(L.editSummary(null).count, 0);
    eq(L.editSummary({ manual_edits: '坏数据' }).count, 0, '留痕被写坏时要当没有，不能抛');
    eq(L.hasEdits(editable()), false);
    eq(L.originalValue(editable(), 'hospital'), null, '没改过时原值即未知');
  });

  test('structConflicts：档案上已有值就被视为人的决定，哪怕没有留痕记录', function () {
    // 用户是在归档表单里选的「体检报告」，那不算 manual_edits，
    // 但它是人做的决定 —— 只认留痕的话，表单里选的类型照样被模型静默改掉。
    var rec = editable();   // document_type='体检报告'，无 manual_edits
    var c = L.structConflicts({ document_type: '检查报告' }, rec);
    eq(c.length, 1);
    eq(c[0].target, 'document_type');
    eq(c[0].human, '体检报告');
    eq(c[0].edited, false, '没留痕时应标成「档案上已有」而不是「你改过」');
    ok(c[0].label === '文档类型', c[0].label);
  });

  test('structConflicts：档案上为空的字段让模型写，不算冲突', function () {
    var rec = editable({ hospital: null, department: '' });
    eq(L.structConflicts({ hospital: '瑞慈', department: '内分泌' }, rec).length, 0,
      '没有值的格子正是该由结构化填的，拦下来只会添乱');
  });

  test('structConflicts：留痕过的字段标成 edited，界面要能说清是谁的值', function () {
    // 记录上的当前值就该是人工改后的那个值（applyEditWithHistory 写的正是这两样）
    var rec = editable({ hospital: '乙',
      manual_edits: [{ target: 'hospital', label: '医院', from: '甲', to: '乙', at: AT }] });
    var c = L.structConflicts({ hospital: '丙医院' }, rec);
    eq(c.length, 1);
    eq(c[0].human, '乙');
    eq(c[0].edited, true);
    ok(c[0].label.indexOf('医院') >= 0, c[0].label);
  });

  test('structConflicts：明细单元格同样比较，模型没给的那一行不参与', function () {
    var rec = editable();   // lab_results[0].result = '145'
    var c = L.structConflicts({ lab_results: [{ name: '血红蛋白', result: '45' }] }, rec);
    eq(c.length, 1);
    eq(c[0].target, 'lab_results.0.result');
    eq(c[0].human, '145');
    ok(c[0].label.indexOf('血红蛋白') >= 0, '要看得出是哪一项：' + c[0].label);
    // 模型只给了一行，第二行不参与比较
    var c2 = L.structConflicts({ lab_results: [{ name: '血红蛋白', result: '145' },
                                               { name: '白细胞', result: '6.1' }] }, rec);
    eq(c2.length, 0, '逐格一致就不该拦用户');
  });

  test('structConflicts：结构化总金额与两处金额的比较各算一处', function () {
    var rec = editable({ amount: 100 });
    var c = L.structConflicts({ amount: 88, total_amount: 260 }, rec);
    var targets = c.map(function (x) { return x.target; }).sort().join(',');
    eq(targets, 'amount,type_specific_data.total_amount');
  });

  test('structConflicts：无冲突时返回空数组，不返回 undefined', function () {
    eq(L.structConflicts({}, editable()).length, 0);
    eq(L.structConflicts(null, editable()).length, 0);
    eq(L.structConflicts({ document_type: '体检报告' }, null).length, 0, '记录为空时也不该抛');
  });



  test('冲突也能落在明细单元格上，且标签看得出是哪一项', function () {
    // 记录本身带着改后的值（真实情况就是 applyEditWithHistory 出来的），
    // 冲突里的 human 取的是记录当前值，不是留痕里的历史 to。
    var base = editable();
    base.type_specific_data.lab_results[0].result = '138';
    var rec = Object.assign(base, {
      manual_edits: [{ target: 'lab_results.0.result', label: '检验项结果', row_name: '血红蛋白', from: '145', to: '138', at: AT }]
    });
    var model = { type_specific_data: { lab_results: [lab('血红蛋白', '145', 'g/L'), lab('白细胞', '6.1', 'g/L')] } };
    var c = L.structConflicts(model, rec);
    eq(c.length, 1);
    eq(c[0].human, '138');
    eq(c[0].model, '145');
    ok(c[0].label.indexOf('血红蛋白') >= 0, '要让用户看得出改的是哪一项：' + c[0].label);
  });

  test('明细冲突不是删键，而是把人工值填回去（整对象替换会丢数据）', function () {
    var base = editable();
    base.type_specific_data.lab_results[0].result = '138';
    var rec = Object.assign(base, {
      manual_edits: [{ target: 'lab_results.0.result', label: '检验项结果', row_name: '血红蛋白', from: '145', to: '138', at: AT }]
    });
    var model = { type_specific_data: { lab_results: [lab('血红蛋白', '145', 'g/L'), lab('白细胞', '6.1', 'g/L')] } };
    var before = JSON.stringify(model);
    var kept = L.keepHumanValues(model, L.structConflicts(model, rec));
    eq(kept.type_specific_data.lab_results[0].result, '138', '人工值必须留在写出去的数组里，不能整格消失');
    eq(kept.type_specific_data.lab_results[1].result, '6.1', '没冲突的格子照常用模型的');
    eq(JSON.stringify(model), before, '不得就地改传进来的模型结果');
  });

  test('keepHumanValues：选「保留人工值」时把冲突字段从模型结果里剔除', function () {
    var rec = editable({
      manual_edits: [{ target: 'document_type', label: '文档类型', from: '检查报告', to: '体检报告', at: AT }]
    });
    var model = { document_type: '检查报告', hospital: '瑞慈', title: '某报告' };
    var kept = L.keepHumanValues(model, L.structConflicts(model, rec));
    eq(kept.document_type, undefined, '冲突字段不写，库里的人工值才留得下来');
    eq(kept.title, undefined, '标题也是人先定的，同样不许模型覆盖');
    eq(kept.hospital, '瑞慈', '与档案一致的字段照常写入，不列为冲突');
    // 想让模型覆盖标题，得在冲突里显式选「用模型的值」
    var forced = L.keepHumanValues(model, []);
    eq(forced.title, '某报告', '不声明冲突时保持模型结果原样');
  });

  test('applyEditWithHistory：留痕累加而非覆盖，且不得就地改旧记录', function () {
    var prev = editable();
    var r1 = L.applyEditWithHistory(prev, { hospital: '甲医院' }, { at: AT });
    eq(r1.hospital, '甲医院');
    eq(r1.manual_edits.length, 1);
    var r2 = L.applyEditWithHistory(r1, { hospital: '乙医院' }, { at: '2026-02-02T00:00:00' });
    eq(r2.manual_edits.length, 2, '第二次不许覆盖第一次的历史');
    eq(r2.hospital, '乙医院');
    eq(prev.hospital, '瑞慈');
    eq(prev.manual_edits, undefined, 'prev 不该被动过');
  });

  test('applyEditWithHistory：值没变时不追加留痕，否则脏历史会淹掉真记录', function () {
    var prev = editable();
    var r = L.applyEditWithHistory(prev, { hospital: '瑞慈' }, { at: AT });
    eq(r.manual_edits, undefined, '没变化就不该有 manual_edits');
    eq(r.hospital, '瑞慈');
  });

  test('改金额后费用口径立刻反映新值，两处不一致时要标冲突而不是悄悄取一个', function () {
    var prev = editable({ amount: 100 });
    var next = L.applyEditWithHistory(prev, { amount: 88.5 }, { at: AT });
    eq(L.receiptAmount(next).value, 8850, '以「分」比较，改完应立刻是新值');
    var tsd2 = Object.assign({}, next.type_specific_data, { total_amount: 99 });
    var both = L.applyEditWithHistory(next, { type_specific_data: tsd2 }, { at: AT });
    ok(L.receiptAmount(both).conflict, '两处金额不一致时要标出来');
    eq(L.receiptAmount(both).value, 8850, '口径仍是顶层优先，与展示文案一致');
  });

  test('日期改动可带说明，用于告诉用户 date_status 一起变了', function () {
    var prev = editable({ primary_date: null, date_status: '日期待确认' });
    var e = L.diffRecordEdits(prev, { primary_date: '2024-05-19', date_status: '已确认' },
      { at: AT, note: { primary_date: '手填合法日期，日期状态同步置为已确认' } });
    var d = e.filter(function (x) { return x.target === 'primary_date'; })[0];
    ok(d, '日期应有留痕');
    ok(d.note && d.note.indexOf('已确认') >= 0, '说明要写进留痕：' + JSON.stringify(d));
  });

  test('diffRecordEdits：不认识的字段不记留痕（防止把系统字段当成可编辑项）', function () {
    var prev = editable();
    var e = L.diffRecordEdits(prev, { id: 999, owner_id: 'someone', file_hash: 'abc',
                                      xparse_task_id: 't1', updated_at: 'x', manual_edits: [] }, { at: AT });
    eq(e.length, 0, '主键/哈希/任务号/时间戳/留痕本身都不许被当成编辑：' + JSON.stringify(e));
  });
  test('冲突清单只列写得回去的字段（否则是给用户一个假的开关）', function () {
    var prev = rec({
      id: 66, document_type: '检验报告', hospital: '原医院',
      type_specific_data: {
        labs: null,
        lab_results: [{ name: '血红蛋白', result: '145', unit: 'g/L' }],
        exams: [{ exam_name: '腹部超声', findings: '人工核对过的所见' }],
        general_exam: { height_cm: 175 },
        final_conclusion: '人工写的结论',
        total_amount: 50
      }
    });
    var cf = L.structConflicts({
      lab_results: [{ name: '血红蛋白', result: '150', unit: 'g/L' }],
      exams: [{ exam_name: '腹部超声', findings: '模型改写的所见' }],
      general_exam: { height_cm: 180 },
      final_conclusion: '模型改写的结论',
      total_amount: 88
    }, prev);
    var tables = L.STRUCT_WRITABLE_TABLES, scalars = L.STRUCT_WRITABLE_TS_SCALARS;
    cf.forEach(function (c) {
      var t = String(c.target || ''), head = t.split('.')[0];
      var scalar = t.indexOf('type_specific_data.') === 0 ? t.slice(19) : null;
      var allowed = (tables.indexOf(head) >= 0 && head !== 'type_specific_data') ||
        (scalar !== null && scalars.indexOf(scalar) >= 0) ||
        (head !== 'type_specific_data' && scalar === null && head.indexOf('.') < 0);
      ok(allowed, '冲突清单里出现了写回路径不处理的字段：' + t);
    });
    ok(cf.length > 0, '用例本身要有冲突，否则这段断言是空转');
    var listed = cf.map(function (c) { return String(c.target).split('.')[0]; });
    ok(listed.indexOf('exams') < 0 && listed.indexOf('general_exam') < 0,
      'exams / general_exam 不在写回集里，就不该出现在清单里');
    ok(listed.indexOf('final_conclusion') < 0, 'final_conclusion 写不回去，不该给开关');
  });

  /* ================= 10.6 按人的关注指标（定义共享，关注按人） ================= */
  /*
    指标定义（名称/单位/别名/换算规则）全家共用一份，只有「是否关注」按人存：
    indicators 每行带 followers: [person_id…]。未指定归属用 0 作键，
    不用 null —— 对象键会被 JSON 序列化成 "null" 字符串（本项目栽过一次）。
    pid 传 null 或 'all' 表示「全部」视图，沿用行上的全局 followed。
  */
  var PERSONS6 = [{ id: 1, name: '我' }, { id: 2, name: '老婆' }, { id: 4, name: '爸爸' }];

  function cat(key, o) {
    return Object.assign({ key: key, name: key + '名', grp: '血糖', type: '数值',
      unit: 'mmol/L', aliases: ['别名' + key], followed: false, sort_order: 10, preset: true }, o || {});
  }

  test('迁移：老行没有 followers 时按 followed 展开成全体成员 + 未指定', function () {
    var on = L.withFollowers(cat('fbg', { followed: true }), PERSONS6);
    eq(on.followers.slice().sort(), [0, 1, 2, 4], '已关注的老行应落到每个人名下');
    var off = L.withFollowers(cat('tsh'), PERSONS6);
    eq(off.followers, [], '没关注的就是空');
    eq(off.followed, false, '迁移不得顺手改全局 followed');
  });

  test('迁移幂等：已有 followers 的行原样保留，不被全局 followed 覆盖', function () {
    var row = cat('fbg', { followed: true, followers: [2] });
    eq(L.withFollowers(row, PERSONS6).followers, [2],
      '用户已经把某项只留给老婆，重跑迁移不能又发给全家');
    eq(L.withFollowers(L.withFollowers(cat('fbg', { followed: true }), PERSONS6), PERSONS6)
      .followers.slice().sort(), [0, 1, 2, 4], '第二次跑结果不变');
  });

  test('followedBy：按人判定；「全部」视图仍看全局 followed', function () {
    var row = cat('ua', { followed: true, followers: [1, 4] });
    eq(L.followedBy(row, 1), true);
    eq(L.followedBy(row, 4), true);
    eq(L.followedBy(row, 2), false, '老婆没关注过这项');
    eq(L.followedBy(row, 0), false, '未指定视图单独算');
    eq(L.followedBy(row, null), true, '全部视图 = 全局 followed');
    eq(L.followedBy(row, 'all'), true);
  });

  test('setFollowFor：给一个人开关不影响别人，且不就地改原行', function () {
    var row = cat('ua', { followed: false, followers: [1] });
    var on = L.setFollowFor(row, 2, true);
    eq(on.followers.slice().sort(), [1, 2]);
    eq(row.followers, [1], '原行不许被就地改');
    var off = L.setFollowFor(on, 1, false);
    eq(off.followers, [2]);
    eq(on.followers.slice().sort(), [1, 2], '取消爸爸的关注不该把老婆的也带走');
  });

  test('setFollowFor：「全部」视图的开关写全局 followed', function () {
    var row = cat('bmi', { followed: false, followers: [1] });
    eq(L.setFollowFor(row, null, true).followed, true);
    eq(L.setFollowFor(row, null, true).followers, [1], '全局开关不该动按人集合');
  });

  test('catalogForPerson：只换 followed，定义字段一个都不动', function () {
    var rows = [cat('fbg', { followed: true, followers: [1] }), cat('ua', { followed: true, followers: [2] })];
    var mine = L.catalogForPerson(rows, 1);
    eq(mine.map(function (c) { return c.key; }), ['fbg', 'ua'], '条目不能少');
    eq(mine.map(function (c) { return c.followed; }), [true, false], '只看我的关注');
    eq(mine[0].name, 'fbg名');
    eq(mine[0].unit, 'mmol/L');
    eq(mine[0].aliases, ['别名fbg'], '别名关系到来源提取，不能被按人视图改坏');
    eq(mine[0].grp, '血糖');
    eq(L.catalogForPerson(rows, null).map(function (c) { return c.followed; }), [true, true],
      '全部视图保持既有行为');
    eq(rows[1].followed, true, '入参不能被改');
  });

  test('pruneFollowers：删掉的成员从各行 followers 里清干净', function () {
    var rows = [cat('fbg', { followers: [1, 2, 4] }), cat('ua', { followers: [2] })];
    var out = L.pruneFollowers(rows, [{ id: 1 }, { id: 4 }]);
    eq(out[0].followers, [1, 4]);
    eq(out[1].followers, [], '只剩老婆的项被删后应为空');
    eq(rows[0].followers, [1, 2, 4], '入参不改');
    eq(L.pruneFollowers(out, [{ id: 1 }, { id: 4 }])[0].followers, [1, 4], '幂等');
  });

  test('inheritFollowers：新成员默认继承「我」的关注集合，不做空白页', function () {
    var rows = [cat('fbg', { followers: [1, 2] }), cat('ua', { followers: [2] }), cat('bmi', { followers: [] })];
    var out = L.inheritFollowers(rows, 1, 7);
    eq(out[0].followers.slice().sort(), [1, 2, 7], '我关注的，新成员也关注');
    eq(out[1].followers, [2], '我没关注的不要塞给新成员');
    eq(out[2].followers, []);
    eq(rows[0].followers, [1, 2], '入参不改');
  });

  test('deriveIndicatorPoints：传 pid 只收该成员的档案，不传维持原行为', function () {
    function rec(id, pid, name, val) {
      return { id: id, person_id: pid, primary_date: '2025-01-0' + (id % 9 + 1), date_status: '已确认',
        type_specific_data: { lab_results: [{ name: name, result: val, unit: 'mmol/L' }] } };
    }
    var recs = [rec(1, 1, '空腹血糖', '5.1'), rec(2, 2, '空腹血糖', '6.8'), rec(3, null, '空腹血糖', '4.4')];
    var cat2 = [cat('fbg', { name: '空腹血糖', aliases: ['空腹血糖'] })];
    eq(L.deriveIndicatorPoints(recs, cat2).length, 3, '不传 pid 应照旧全收');
    eq(L.deriveIndicatorPoints(recs, cat2, 1).length, 1, '只看我的');
    eq(L.deriveIndicatorPoints(recs, cat2, 2).length, 1);
    eq(L.deriveIndicatorPoints(recs, cat2, 0).length, 1, '未指定视图只收没有归属的');
    eq(L.deriveIndicatorPoints(recs, cat2, null).length, 3, 'null 视为「全部」而不是「未指定」');
    eq(L.deriveIndicatorPoints([], cat2, 1).length, 0);
    eq(L.deriveIndicatorPoints(null, cat2, 1).length, 0, '空入参不崩');
  });

  test('personMatches：0 / null / 空串都算未指定，不能把 0 当假值漏掉', function () {
    eq(L.personMatches({ person_id: null }, 0), true);
    eq(L.personMatches({ person_id: '' }, 0), true);
    eq(L.personMatches({}, 0), true);
    eq(L.personMatches({ person_id: 1 }, 0), false);
    eq(L.personMatches({ person_id: 1 }, 1), true);
    eq(L.personMatches({ person_id: '2' }, 2), true, '字符串 id 与数字 id 要能对上');
    eq(L.personMatches({ person_id: 2 }, 1), false);
  });
  test('指标组的取数入口只有一个：组键 → 该读哪些键', function () {
    eq(L.indicatorComponents('lipids').join(','), 'tc,tg,hdl,ldl', '血脂读四个分项');
    eq(L.indicatorComponents('ua').join(','), 'ua', '普通指标就读自己');
    eq(L.indicatorComponents('ogtt_glu').join(','), 'ogtt_glu',
      'OGTT 两个组键的点有人读（buildOGTT），不能再往下拆');
    eq(L.indicatorComponents(null).join(','), '', '空键不炸');
    // 类级守卫：任何"这条有没有数据"的判断都必须走同一个入口，
    // 否则就会出现表格说有、详情说暂无记录（D37 / M2 的成因）
    var pts = { tc: [{ date: '2025-12-13', value: 5.9 }], tg: [], hdl: [], ldl: [] };
    var has = function (key) {
      return L.indicatorComponents(key).some(function (k) { return (pts[k] || []).length > 0; });
    };
    eq(has('lipids'), true, '组里有一个分项带数据，行就该出现');
    eq(has('ua'), false, '没有数据的指标不该被算作有');
  });

  /* ================= 11. 本地数据层 ================= */

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
      var added = P.prepareInsert('documents', [{ id: 5 }], [{ document_type: '检验报告' }, { document_type: '检查报告' }]);
      eq(added.map(function (r) { return r.id; }), [6, 7]);
    });

    test('本地数据层：写入补 NOT NULL 默认值，且不覆盖调用方给的值', function () {
      var added = P.prepareInsert('documents', [], [
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
      var b = P.buildBackup({ documents: [{ id: 1 }, { id: 2 }], drugs: [{ id: 1 }] }, [{ path: 'p', dataBase64: 'AA==' }], '2026-03-03T00:00:00.000Z');
      eq(b.schema, 'health-records-local-backup/v2');
      eq(b.counts.documents, 2);
      eq(b.counts.drugs, 1);
      eq(b.counts.indicators, 0);
      eq(b.counts.manual_records, 0);
      eq(b.file_count, 1);
      eq(b.tables.manual_records, []);
    });

    test('本地数据层：备份校验放行合法文件、拦下格式不符的文件', function () {
      ok(P.validateBackup(P.buildBackup({ documents: [{ id: 1, document_type: '检验报告' }] }, [])).ok, '合法备份应通过');
      ok(!P.validateBackup({ hello: 'world' }).ok, '缺少 schema 的文件必须被拒');
      ok(!P.validateBackup(null).ok, 'null 必须被拒');
      ok(!P.validateBackup([1, 2, 3]).ok, '数组必须被拒');
    });

    test('本地数据层：附件缺路径或缺数据时整份备份被拒', function () {
      var b = P.buildBackup({ documents: [] }, [{ path: 'a.png', dataBase64: 'AA==' }]);
      b.files.push({ name: '无路径.png', dataBase64: 'AA==' });
      ok(!P.validateBackup(b).ok, '缺 path 的附件必须让整份备份被拒');
      ok(!P.validateBackup(P.buildBackup({ documents: [] }, [{ path: 'b.png' }])).ok, '缺数据的附件必须让整份备份被拒');
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
      var res = await facade.database.from('documents').insert([
        { document_type: '检验报告', primary_date: '2025-01-01', title: '甲' },
        { document_type: '检验报告', primary_date: '2025-02-01', title: '乙' }
      ]).select();
      ok(!res.error, '不应报错：' + (res.error && res.error.message));
      eq(res.data.length, 2);
      eq(res.data.map(function (r) { return r.id; }), [1, 2]);
      eq(res.data[0].date_status, '已确认');

      var page = await facade.database.from('documents').select('*')
        .order('primary_date', { ascending: false }).range(0, 0);
      eq(page.data.length, 1);
      eq(page.data[0].primary_date, '2025-02-01');
      var page2 = await facade.database.from('documents').select('*')
        .order('primary_date', { ascending: false }).range(1, 1);
      eq(page2.data[0].primary_date, '2025-01-01');
    });

    testAsync('本地门面：update().eq().select() 只改命中行且已落库', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      await facade.database.from('documents').insert([
        { document_type: '检验报告', title: '甲' },
        { document_type: '检验报告', title: '乙' }
      ]).select();
      var res = await facade.database.from('documents').update({ title: '乙改' }).eq('id', 2).select();
      eq(res.data.length, 1);
      eq(res.data[0].title, '乙改');
      var other = await facade.database.from('documents').select('*').eq('id', 1);
      eq(other.data[0].title, '甲', '未命中的行不得被改动');
      var back = await facade.database.from('documents').select('*').eq('id', 2);
      eq(back.data[0].title, '乙改', '改动必须已落库');
      var none = await facade.database.from('documents').update({ title: 'x' }).eq('id', 999).select();
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

    testAsync('删除档案：内存驱动不支持时如实说不支持，不假装成功', async function () {
      var facade = DB.createLocal({ driver: DB.memoryDriver() });
      eq(facade.hasDeleteRecords(), false, '能力探测必须是假，界面据此决定给不给删除按钮');
      var res = await facade.deleteRecords('documents', [1]);
      eq(res.ok, false, '不支持绝不能返回 ok:true');
      ok(/不支持/.test(res.reason || ''), '要说清是驱动不支持，而不是泛泛的「删除失败」：' + res.reason);
    });

    testAsync('删除档案：结果原样透传，界面才报得出删了什么、去哪回退', async function () {
      var got = null;
      var facade = DB.createLocal({ driver: {
        deleteRecords: function (t, ids) {
          got = { table: t, ids: ids };
          return Promise.resolve({
            deleted: 2, filesRemoved: ['attachments/a.pdf'], filesFailed: [],
            keptReferenced: ['attachments/b.pdf'],
            snapshot: 'snap-x-before-delete.json', missing: []
          });
        }
      } });
      eq(facade.hasDeleteRecords(), true);
      var res = await facade.deleteRecords('documents', [7, 8]);
      eq(got.ids.join(','), '7,8', 'id 必须原样送到驱动，不能被门面改写或丢掉');
      eq(res.ok, true);
      eq(res.deleted, 2);
      eq(res.filesRemoved, ['attachments/a.pdf']);
      eq(res.keptReferenced, ['attachments/b.pdf'], '被别处引用而保留的附件要能报给界面');
      eq(res.snapshot, 'snap-x-before-delete.json', '快照名要透传，界面靠它告诉用户如何回退');
    });

    testAsync('删除档案：服务端拒绝时以 reason 返回而不是抛异常', async function () {
      var facade = DB.createLocal({ driver: {
        deleteRecords: function () {
          return Promise.reject(new Error('删除前的快照没能写入，已中止删除，数据未改动'));
        }
      } });
      var res = await facade.deleteRecords('documents', [1]);
      eq(res.ok, false);
      ok(/快照/.test(res.reason || ''), '服务端原话要带到界面上：' + res.reason);
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
      await facade.database.from('documents').insert({ document_type: '检验报告' }).select();
      await facade.storage.upload('attachments/a.png', { name: 'a.png', size: 10 }, {});
      await facade.clearAll();
      eq((await facade.database.from('documents').select('*')).data, []);
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
      if (!global.TEST_QUIET) {
        results.forEach(function (r) {
          console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : ('\n      ' + r.msg)));
        });
        console.log('\n共 ' + results.length + ' 项，通过 ' + passed + ' 项，失败 ' + failed + ' 项');
      }
    }
    return summary;
  }

  // 异步用例跑完再汇总；Node 端可等待 global.TEST_DONE
  global.TEST_DONE = Promise.resolve()
    .then(function () { return Promise.all(pendingTests); })
    .then(renderResults);
})(typeof window !== 'undefined' ? window : this);
