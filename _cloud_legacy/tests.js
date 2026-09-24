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

  test('类型分布：覆盖六类且不遗漏', function () {
    var d = L.typeDistribution([
      rec({ id: 1, document_type: '检验报告' }),
      rec({ id: 2, document_type: '检验报告' }),
      rec({ id: 3, document_type: '检查报告' })
    ]);
    eq(d.length, 6, '六类都要出现');
    eq(d.filter(function (x) { return x.type === '检验报告'; })[0].count, 2);
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

  /* ================= 输出 ================= */

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
})(typeof window !== 'undefined' ? window : this);
