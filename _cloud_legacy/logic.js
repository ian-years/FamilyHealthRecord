/* ============================================================
   个人健康档案工作台 · 业务逻辑层（纯函数，可单测）
   ------------------------------------------------------------
   本文件只做「原样记录的整理」，不做任何医学判断：
   - 不生成异常/正常/偏高/偏低标签
   - 不猜箭头、不补单位、不补日期、不把空值变 0
   - 归一化只发生在此处的展示层派生里，原始记录永不被改写
   挂载于 window.Logic。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 0. 输出转义 ---------------- */

  // 原文展示必须安全转义：OCR 正文里可能含 HTML、链接或脚本
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      .replace(/\u0060/g, '&#96;');
  }

  /* ---------------- 1. 日期 ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // 严格日历校验：不存在的日期不被 Date 滚动到下个月（如 2025-02-30）
  function parseDateStrict(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return null;
    var dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d > dim[mo - 1]) return null;
    return { y: y, m: mo, d: d, iso: y + '-' + pad2(mo) + '-' + pad2(d) };
  }

  function isValidDate(raw) { return parseDateStrict(raw) !== null; }

  // 排序键：无效/缺失日期排最后，不参与趋势连线
  function dateSortKey(raw) {
    var p = parseDateStrict(raw);
    return p ? p.iso : null;
  }

  // YYYY.MM —— 趋势横轴必须带年份（指令 §16）
  function fmtYearMonth(raw) {
    var p = parseDateStrict(raw);
    return p ? p.y + '.' + pad2(p.m) : '日期待确认';
  }

  function fmtCN(raw) {
    var p = parseDateStrict(raw);
    if (!p) return '日期待确认';
    return p.y + ' 年 ' + p.m + ' 月 ' + p.d + ' 日';
  }

  function fmtCNShort(raw) {
    var p = parseDateStrict(raw);
    if (!p) return '日期待确认';
    return pad2(p.m) + '-' + pad2(p.d);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDaysISO(iso, days) {
    var p = parseDateStrict(iso);
    if (!p) return null;
    var t = Date.UTC(p.y, p.m - 1, p.d) + days * 86400000;
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function diffDays(aISO, bISO) {
    var a = parseDateStrict(aISO), b = parseDateStrict(bISO);
    if (!a || !b) return null;
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }

  /* ---------------- 2. 数值与定性值 ---------------- */

  // 空值语义：null / 缺字段 / 空串 / 纯空白 / 不可解析 一律为 null，
  // 绝不转换成数值 0；明确的 0 必须保留。
  function isBlank(v) {
    if (v === null || v === undefined) return true;
    return String(v).trim() === '';
  }

  // 严格数字解析：只接受完整的十进制数字（可带正负号与小数点）。
  // 1+ / 2+ / ± / <5 / >10 / 阴性 / 1:40 等定性或带比较符结果一律拒绝，
  // 不允许用宽松 parseFloat 把它们当成精确数值（指令 §08、§16、验收 50）。
  function parseStrictNumber(raw) {
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    var s = raw.trim()
      .replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[\uFF0E\u3002]/g, '.')
      .replace(/[\u2212\u2013\u2014]/g, '-')
      .replace(/\s+/g, '');
    if (!s) return null;
    var cleaned = s.replace(/,/g, '');           // 千分位
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null;
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  // 带比较符/定性符的结果识别（只用于「保留在历史、不连线」的判断）
  var QUALITATIVE_PAT = /(阴性|阳性|弱阳性|未检出|检出|±|＋|\+|＜|<|＞|>|≥|≤|未见|正常|异常|不明确|痕量|微量)/;

  function looksQualitative(raw) {
    if (isBlank(raw)) return false;
    return QUALITATIVE_PAT.test(String(raw));
  }

  // 原报告明确印出的 ↑ / ↓ 标记才算数；识别不清一律不猜（保留 null）
  function normalizeFlag(raw) {
    if (isBlank(raw)) return null;
    var s = String(raw).trim();
    if (s === '↑' || s === 'H' || s === 'h' || s === '高') return '↑';
    if (s === '↓' || s === 'L' || s === 'l' || s === '低') return '↓';
    return null;   // 例如原报告「个」这类识别不清的字符：不推断为箭头
  }

  /* ---------------- 3. 单位 ---------------- */

  var GREEK_MU = /[\u03BC\u00B5\uD835\uDF07]/g;   // μ µ 𝛼

  // 单位符号规范化：只处理大小写、空格、μ/u 等规范写法差异（指令 §17）
  function normUnit(raw) {
    if (isBlank(raw)) return '';
    var s = String(raw).replace(GREEK_MU, 'μ').replace(/\s+/g, '').replace(/[()（）]/g, '').toLowerCase();
    s = s.replace(/^u(?=mol)/, 'μ').replace(/^u(?=iu)/, 'μ').replace(/\u00B5/g, 'μ');
    return s;
  }

  var UNIT_LABELS = {
    'mmol/l': 'mmol/L', 'μmol/l': 'μmol/L', 'mg/dl': 'mg/dL', 'miu/l': 'mIU/L',
    'μiu/ml': 'μIU/mL', 'uiu/ml': 'μIU/mL', 'mmhg': 'mmHg', 'kg': 'kg', 'g/l': 'g/L',
    'ng/ml': 'ng/mL', 'mmol': 'mmol', '%': '%', 'fl': 'fL'
  };

  // 受控换算规则：仅在「同一分析物已确定 + 原单位明确 + 换算关系已核实」时启用。
  // 系数集中维护，不同分析物绝不共享。
  var CONVERSIONS = {
    glucose:  { from: 'mg/dl', to: 'mmol/l', factor: 1 / 18,      label: 'mg/dL ÷ 18 → mmol/L' },
    creatinine: { from: 'mg/dl', to: 'μmol/l', factor: 88.4,       label: 'mg/dL × 88.4 → μmol/L' },
    uric_acid: { from: 'mg/dl', to: 'μmol/l', factor: 59.48,      label: 'mg/dL × 59.48 → μmol/L' },
    cholesterol: { from: 'mg/dl', to: 'mmol/l', factor: 0.02586,  label: 'mg/dL × 0.02586 → mmol/L' },
    triglyceride: { from: 'mg/dl', to: 'mmol/l', factor: 0.01129, label: 'mg/dL × 0.01129 → mmol/L' }
  };

  function decimalsOf(analyte, targetUnit) {
    return /mmol\/l/i.test(targetUnit) ? 2 : 2;
  }

  function round(n, d) {
    var f = Math.pow(10, d);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  /**
   * 展示层归一化。永不修改原始记录，只返回派生信息。
   * @returns {{value:number, unit:string, conversionApplied:boolean,
   *            originalValue:number, originalUnit:string, rule:string|null,
   *            note:string|null}}
   */
  function normalizeForDisplay(analyte, value, unit) {
    var out = {
      value: value, unit: unit, conversionApplied: false,
      originalValue: value, originalUnit: unit, rule: null, note: null
    };
    if (value === null || value === undefined || !isFinite(value)) return out;
    var nu = normUnit(unit);
    if (!nu) { out.note = '原单位未提供，不做任何换算'; return out; }

    // 同单位族的规范写法（大小写/μ-u 差异）不算换算，只统一显示
    var rule = CONVERSIONS[analyte];
    if (!rule) {
      out.unit = canonicalUnitLabel(unit);
      return out;
    }
    if (nu === normUnit(rule.to)) {
      out.unit = canonicalUnitLabel(rule.to);
      return out;
    }
    if (nu === rule.from) {
      var converted = round(value * rule.factor, decimalsOf(analyte, rule.to));
      return {
        value: converted, unit: canonicalUnitLabel(rule.to), conversionApplied: true,
        originalValue: value, originalUnit: canonicalUnitLabel(unit), rule: rule.label,
        note: '展示层换算，原始报告与结构化结果未被改写'
      };
    }
    // 未知单位：不强行换算
    out.unit = canonicalUnitLabel(unit);
    out.note = '该单位未纳入受控换算范围，按原文展示';
    return out;
  }

  function canonicalUnitLabel(u) {
    if (isBlank(u)) return '';
    var nu = normUnit(u);
    return UNIT_LABELS[nu] || String(u).trim();
  }

  /* ---------------- 4. 指标目录与匹配 ---------------- */

  // 预置目录：五组预置关注（血糖/血压/血脂/尿酸/体重）+ 可扩展项。
  // 页面不写死成五行；自定义指标可继续追加。
  var PRESET_CATALOG = [
    { key: 'fbg', name: '空腹血糖', grp: '血糖', type: '数值', unit: 'mmol/L', followed: true, preset: true, order: 10, analyze: 'glucose',
      aliases: ['空腹血糖', '空腹葡萄糖', '葡萄糖(空腹)', 'glu(空腹)', 'fbg'] },
    { key: 'hba1c', name: '糖化血红蛋白', grp: '血糖', type: '数值', unit: '%', followed: false, preset: true, order: 12, analyze: null,
      aliases: ['糖化血红蛋白', '糖化血红蛋白a1c', 'hba1c', 'ghb'] },
    { key: 'bp', name: '血压', grp: '血压', type: '双数值', unit: 'mmHg', followed: true, preset: true, order: 20, analyze: null,
      aliases: ['血压', '收缩压/舒张压', 'bp'] },
    { key: 'lipids', name: '血脂', grp: '血脂', type: '指标组', unit: '', followed: true, preset: true, order: 30, analyze: null,
      aliases: ['血脂', '血脂四项', '血脂全套'] },
    { key: 'tc', name: '总胆固醇', grp: '血脂', type: '数值', unit: 'mmol/L', followed: true, preset: true, order: 31, analyze: 'cholesterol',
      aliases: ['总胆固醇', '胆固醇', 'tc'] },
    { key: 'tg', name: '甘油三酯', grp: '血脂', type: '数值', unit: 'mmol/L', followed: true, preset: true, order: 32, analyze: 'triglyceride',
      aliases: ['甘油三酯'], needsLipidContext: true, extraAliases: ['tg'] },
    { key: 'hdl', name: '高密度脂蛋白胆固醇', grp: '血脂', type: '数值', unit: 'mmol/L', followed: true, preset: true, order: 33, analyze: 'cholesterol',
      aliases: ['高密度脂蛋白胆固醇', '高密度脂蛋白', 'hdl-c', 'hdl'] },
    { key: 'ldl', name: '低密度脂蛋白胆固醇', grp: '血脂', type: '数值', unit: 'mmol/L', followed: true, preset: true, order: 34, analyze: 'cholesterol',
      aliases: ['低密度脂蛋白胆固醇', '低密度脂蛋白', 'ldl-c', 'ldl'] },
    { key: 'ua', name: '血尿酸', grp: '尿酸', type: '数值', unit: 'μmol/L', followed: true, preset: true, order: 40, analyze: 'uric_acid',
      aliases: ['血尿酸', '血清尿酸', '尿酸', 'ua'] },
    { key: 'weight', name: '体重', grp: '体重', type: '数值', unit: 'kg', followed: true, preset: true, order: 50, analyze: null,
      aliases: ['体重'] },
    { key: 'bmi', name: 'BMI', grp: '体重', type: '数值', unit: '', followed: false, preset: true, order: 51, analyze: null,
      aliases: ['bmi', '体重指数'] },
    { key: 'scr', name: '血肌酐', grp: '肾功能', type: '数值', unit: 'μmol/L', followed: false, preset: true, order: 60, analyze: 'creatinine',
      aliases: ['血肌酐', '肌酐', 'crea', 'scr'] },
    { key: 'tsh', name: 'TSH', grp: '甲状腺', type: '数值', unit: 'mIU/L', followed: false, preset: true, order: 70, analyze: null,
      aliases: ['tsh', '促甲状腺激素'] },
    { key: 'ogtt_glu', name: 'OGTT 血糖', grp: '血糖', type: '指标组', unit: 'mmol/L', followed: false, preset: true, order: 80, analyze: 'glucose',
      ogtt: 'glucose', aliases: [] },
    { key: 'ogtt_ins', name: 'OGTT 胰岛素', grp: '胰岛素', type: '指标组', unit: 'mIU/L', followed: false, preset: true, order: 81, analyze: null,
      ogtt: 'insulin', aliases: [] }
  ];

  function normName(s) {
    if (isBlank(s)) return '';
    return String(s)
      .replace(GREEK_MU, 'μ')
      .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/\s+/g, '')
      .replace(/[（）()【】\[\]：:、，,。.]/g, '')
      .toLowerCase();
  }

  // 受控的项目名称匹配：完整名称与有边界的别名，不用过宽的子串匹配。
  // 返回 {key, rule} 或 null。
  function matchLabItem(lab, catalog) {
    if (!lab || isBlank(lab.name)) return null;
    var name = normName(lab.name);
    var panel = normName(lab.panel || '');
    var byKey = {};
    (catalog || PRESET_CATALOG).forEach(function (c) { byKey[c.key] = c; });

    // 上下文判定：只有明确甘油三酯含义时才进入血脂（指令 §15）
    var lipidContext = /血脂|甘油三酯|脂蛋白|胆固醇/.test(panel) || /血脂/.test(name);
    // OGTT 上下文
    var ogttContext = /ogtt|糖耐量|葡萄糖耐量/.test(panel + name) ||
      /空腹|30\s*分钟|60\s*分钟|120\s*分钟|180\s*分钟|半小时|1小时|2小时|3小时|服糖后|餐后/.test(lab.condition || '');

    // 1) OGTT 专项优先（葡萄糖 / 胰岛素分开）
    if (ogttContext) {
      if (/胰岛素/.test(name) && byKey.ogtt_ins) return { key: 'ogtt_ins', rule: 'OGTT 胰岛素（需原文明确时点）' };
      if (/葡萄糖|血糖/.test(name) && byKey.ogtt_glu) return { key: 'ogtt_glu', rule: 'OGTT 血糖（需原文明确时点）' };
    }

    // 2) HDL / LDL 必须先于「胆固醇」判断，避免被总胆固醇吞掉。
    //    优先键写死顺序；其余目录键（含糖化血红蛋白与用户自定义指标）按目录顺序补在其后，
    //    这样新增目录项自动参与「来源提取」，不必再回来改这张表。
    var PRIORITY = ['hdl', 'ldl', 'tg', 'tc', 'fbg', 'ua', 'scr', 'tsh', 'bmi', 'weight', 'bp', 'lipids'];
    var ordered = PRIORITY.filter(function (k) { return byKey[k]; });
    Object.keys(byKey).forEach(function (k) {
      if (ordered.indexOf(k) < 0) ordered.push(k);
    });
    for (var i = 0; i < ordered.length; i++) {
      var key = ordered[i];
      var c = byKey[key];
      if (!c) continue;

      // 尿肌酐等不同分析物不得混入血肌酐
      if (key === 'scr' && /尿/.test(name) && !/血/.test(name)) continue;
      // 尿酸：排除「尿酸碱度」等尿常规语义
      if (key === 'ua' && /酸碱度|ph值|结晶|盐类/.test(name)) continue;

      var hit = false, viaBounded = false;
      var al = (c.aliases || []).concat(c.extraAliases || []);
      for (var j = 0; j < al.length; j++) {
        var a = normName(al[j]);
        if (!a) continue;
        // 缩写型别名（拉丁字母/数字，长度<=4）只在上下文吻合时才接受，避免 TG / TC 误配
        var isAbbrev = /^[a-z0-9\-]{1,4}$/.test(a);
        // 上下文闸门必须在「完全相等」之前生效，否则 TG 这类缩写仍会被直接命中
        if (isAbbrev && c.needsLipidContext && !lipidContext) continue;
        if (name === a) { hit = true; break; }
        if (isAbbrev) {
          if (name.indexOf(a) === 0 || name.indexOf('(' + a) >= 0) { hit = true; viaBounded = true; }
        }
      }
      // 名称包含别名（如「血清尿酸」含「尿酸」）：中文别名长度>=2 即可，仍受上下文闸门约束
      if (!hit) {
        for (var k = 0; k < (c.aliases || []).length; k++) {
          var a2 = normName(c.aliases[k]);
          if (a2.length >= 2 && name.indexOf(a2) >= 0) {
            if (c.needsLipidContext && !lipidContext) break;
            hit = true; viaBounded = true; break;
          }
        }
      }
      if (hit) return { key: key, rule: viaBounded ? '边界别名匹配：' + c.name : '完整名称匹配：' + c.name };
    }
    return null;
  }

  // 从检验报告的结构化结果派生指标点（不复制写入日常指标表）
  function deriveIndicatorPoints(records, catalog) {
    var pts = [];
    (records || []).forEach(function (r) {
      var tsd = r.type_specific_data || {};
      var ge = tsd.general_exam;
      // 一般检查里的体格与血压：同样按「报告提取」派生，条件标注为原文含义
      if (ge && typeof ge === 'object') {
        var geMap = {
          weight: { key: 'weight', field: 'weight_kg', unit: 'kg', condition: null },
          bmi: { key: 'bmi', field: 'bmi', unit: null, condition: null },
          bp: { key: 'bp', field: 'systolic_mmHg', field2: 'diastolic_mmHg', unit: 'mmHg', condition: '静息测量' }
        };
        Object.keys(geMap).forEach(function (k) {
          var g = geMap[k];
          var v1 = parseStrictNumber(ge[g.field]);
          if (v1 === null) return;
          var v2 = g.field2 ? parseStrictNumber(ge[g.field2]) : null;
          pts.push({
            indicatorKey: g.key, matchRule: '一般检查（体格测量）', name: g.key === 'bp' ? '血压' : (g.key === 'bmi' ? '体重指数' : '体重'),
            condition: g.condition, result: String(ge[g.field]), unit: g.unit,
            reference: null, flag: null, flagRaw: null,
            value: v1, value2: v2,
            date: r.primary_date || null, dateStatus: r.date_status || null,
            source: '报告提取', sourceRecordId: r.id, sourceTitle: r.title || null,
            sourceFile: r.source_file || null, sourceType: r.document_type || null,
            review: '已核对',
            analyze: k === 'bmi' ? null : (k === 'weight' ? null : null)
          });
        });
      }
      var labs = Array.isArray(tsd.lab_results) ? tsd.lab_results : [];
      labs.forEach(function (lab, idx) {
        var m = matchLabItem(lab, catalog);
        if (!m) return;
        var num = parseStrictNumber(lab.result);
        pts.push({
          indicatorKey: m.key,
          matchRule: m.rule,
          name: lab.name,
          condition: lab.condition || null,
          result: lab.result,
          unit: lab.unit || null,
          reference: lab.reference || null,
          flag: normalizeFlag(lab.flag),
          flagRaw: isBlank(lab.flag) ? null : String(lab.flag),
          value: num,
          date: r.primary_date || null,
          dateStatus: r.date_status || null,
          source: '报告提取',
          sourceRecordId: r.id,
          sourceTitle: r.title || null,
          sourceFile: r.source_file || null,
          sourceType: r.document_type || null,
          review: (lab.flag && normalizeFlag(lab.flag) === null && String(lab.flag).trim())
            ? '原标记识别不清，保留原始结果待核对' : '已核对',
          analyze: (function () {
            var c = (catalog || PRESET_CATALOG).filter(function (x) { return x.key === m.key; })[0];
            return c ? c.analyze : null;
          })()
        });
      });
    });
    return pts;
  }

  /* ---------------- 5. 趋势组装 ---------------- */

  function cmpDateAsc(a, b) {
    if (a.date && b.date) return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return 0;
  }

  /**
   * 组装单指标趋势。
   * 规则：日期有效才连线；有效性优先取最近有效日期；<2 点不画线；
   * 不同测量条件不串线；未归一化多单位组只连唯一多数单位组，平票不连线。
   */
  function buildTrend(points, opts) {
    opts = opts || {};
    var all = [];
    var undated = [];
    (points || []).forEach(function (p) {
      var rec = {
        date: dateSortKey(p.date),
        rawDate: p.date || null,
        value: p.value,
        value2: (p.value2 === undefined ? null : p.value2),
        unit: p.unit || '',
        condition: p.condition || null,
        source: p.source,
        reference: p.reference || null,
        flag: p.flag || null,
        flagRaw: p.flagRaw || null,
        sourceRecordId: p.sourceRecordId || null,
        sourceTitle: p.sourceTitle || null,
        review: p.review || '已核对',
        analyze: p.analyze || opts.analyze || null,
        name: p.name || null
      };
      if (rec.value === null || rec.value === undefined) { undated.push(rec); rec.excluded = '结果不是精确数值（定性或带比较符）'; return; }
      if (!rec.date) { undated.push(rec); rec.excluded = '日期待确认，不参与连线'; return; }
      var norm = normalizeForDisplay(rec.analyze, rec.value, rec.unit);
      rec.normValue = norm.value;
      rec.normUnit = norm.unit;
      rec.conversion = norm;
      all.push(rec);
    });

    // 条件隔离：不同测量条件不串成同一条线
    var byCondition = {};
    all.forEach(function (r) {
      var c = r.condition ? String(r.condition).trim() : '未标注条件';
      (byCondition[c] = byCondition[c] || []).push(r);
    });
    var conditions = Object.keys(byCondition);

    var result = {
      all: all, undated: undated, conditions: conditions,
      groups: {}, connected: [], lineUnit: null, notes: [], tie: false
    };

    conditions.forEach(function (cond) {
      var list = byCondition[cond].slice().sort(cmpDateAsc);

      // 单位组：按归一化后的单位分组；已知换算已归并，未知单位各自成组
      var unitGroups = {};
      list.forEach(function (r) {
        var u = r.normUnit || '未提供单位';
        (unitGroups[u] = unitGroups[u] || []).push(r);
      });
      var uKeys = Object.keys(unitGroups).sort(function (a, b) {
        return unitGroups[b].length - unitGroups[a].length;
      });
      var chosenKey = null;
      if (uKeys.length === 1) {
        chosenKey = uKeys[0];
      } else if (uKeys.length > 1) {
        if (unitGroups[uKeys[0]].length === unitGroups[uKeys[1]].length) {
          // 最大组平票：不任选一组连线（指令 §16）
          result.tie = true;
          result.notes.push('「' + cond + '」存在 ' + uKeys.length +
            ' 个不可比较的单位组且数量持平，未选择任一组连线；全部 ' + list.length + ' 条保留在历史中。');
        } else {
          chosenKey = uKeys[0];
          var rest = list.length - unitGroups[chosenKey].length;
          result.notes.push('「' + cond + '」存在未归一化的多单位组，仅连接占多数的 ' + chosenKey +
            '（' + unitGroups[chosenKey].length + ' 条），另有 ' + rest + ' 条保留在历史但未连线。');
        }
      }
      result.groups[cond] = { list: list, chosenUnit: chosenKey, unitGroups: unitGroups };
    });

    // 主连线序列：取点数最多且已选定单位组的条件
    var best = null;
    conditions.forEach(function (cond) {
      var g = result.groups[cond];
      if (!g.chosenUnit) return;
      var n = g.unitGroups[g.chosenUnit].length;
      if (!best || n > best.n) best = { cond: cond, n: n, unit: g.chosenUnit, list: g.unitGroups[g.chosenUnit] };
    });
    if (best) {
      result.connected = best.list;
      result.lineUnit = best.unit;
      result.condition = best.cond;
      if (conditions.length > 1) {
        result.notes.push('共 ' + conditions.length + ' 个测量条件，已按条件分开；连线仅取「' +
          best.cond + '」的 ' + best.n + ' 个点。');
      }
    }

    // 同日期多点：同一日期保留全部明细，但只按日期去重统计
    var dates = {};
    result.connected.forEach(function (r) { dates[r.date] = true; });
    result.distinctDates = Object.keys(dates).sort();

    result.latest = result.distinctDates.length
      ? result.connected.filter(function (r) { return r.date === result.distinctDates[result.distinctDates.length - 1]; })
      : [];
    result.enough = result.distinctDates.length >= 2;
    if (!result.enough && result.connected.length) {
      result.notes.push('可比较的有效日期点不足 2 个，未绘制趋势线。');
    }
    if (undated.length) {
      result.notes.push('另有 ' + undated.length + ' 条记录保留在历史中、不参与连线（无有效日期或结果不是精确数值）。');
    }
    if (all.length) {
      result.notes.push('横轴按真实时间顺序排列；两点之间的视觉间距不代表等长的时间间隔。');
    }
    return result;
  }

  // 血压双线：收缩压 / 舒张压同一纵轴范围与图例，不接成一条线
  function buildBPtrend(points) {
    var valid = (points || []).filter(function (p) { return p.date && p.value !== null; })
      .sort(cmpDateAsc);
    var byDate = {};
    valid.forEach(function (p) {
      var k = p.date;
      (byDate[k] = byDate[k] || []).push(p);
    });
    var dates = Object.keys(byDate).sort();
    var sys = [], dia = [];
    dates.forEach(function (d) {
      var l = byDate[d];
      var s = l.filter(function (x) { return x.value !== null; })[0];
      var dd = l.filter(function (x) { return x.value2 !== null && x.value2 !== undefined; })[0];
      if (s) sys.push({ date: d, rawDate: s.date, value: s.value, unit: s.unit, source: s.source, sourceTitle: s.sourceTitle, reference: s.reference, condition: s.condition });
      if (dd) dia.push({ date: d, rawDate: dd.date, value: dd.value2, unit: dd.unit, source: dd.source, sourceTitle: dd.sourceTitle, reference: dd.reference, condition: dd.condition });
    });
    var units = {};
    valid.forEach(function (p) { units[canonicalUnitLabel(p.unit) || '未提供单位'] = true; });
    var all2 = sys.concat(dia);
    var min = null, max = null;
    all2.forEach(function (p) {
      if (min === null || p.value < min) min = p.value;
      if (max === null || p.value > max) max = p.value;
    });
    var compatible = Object.keys(units).length <= 1;
    return {
      dates: dates, systolic: sys, diastolic: dia, min: min, max: max,
      unit: compatible ? Object.keys(units)[0] || 'mmHg' : null,
      unitNote: compatible ? null : ('存在多个不等价单位（' + Object.keys(units).join('、') + '），不合并为同一纵轴。'),
      enough: dates.length >= 2,
      needsDoubleLine: true
    };
  }

  // 血脂：四个分项分别成图；首页次数按有效报告日期去重（「检查次数」）
  function lipidSummary(pointsByKey) {
    var keys = ['tc', 'tg', 'hdl', 'ldl'];
    var dateSet = {};
    keys.forEach(function (k) {
      (pointsByKey[k] || []).forEach(function (p) {
        var d = dateSortKey(p.date);
        if (d) dateSet[d] = true;
      });
    });
    var dates = Object.keys(dateSet).sort();
    return {
      checkCount: dates.length,
      dates: dates,
      label: '检查次数',
      note: '按有效报告日期去重统计，四个分项不是四次检查；同日多份报告的来源仍全部保留。'
    };
  }

  // OGTT：同次试验五点曲线 + 同条件跨年度趋势
  var OGTT_ORDER = [
    { label: '空腹', minutes: 0 },
    { label: '30 分钟', minutes: 30 },
    { label: '60 分钟', minutes: 60 },
    { label: '120 分钟', minutes: 120 },
    { label: '180 分钟', minutes: 180 }
  ];

  // 时点识别：必须按「从大到小」匹配明确数字，否则 "120分钟" 会被 "0分钟" 抢先命中
  function ogttTimepoint(condition, name) {
    var s = String(condition || '') + ' ' + String(name || '');
    if (/180\s*(分钟|min)|3\s*(小时|h\b)|3h/i.test(s)) return 180;
    if (/120\s*(分钟|min)|2\s*(小时|h\b)|2h/i.test(s)) return 120;
    if (/60\s*(分钟|min)|1\s*(小时|h\b)|1h/i.test(s)) return 60;
    if (/30\s*(分钟|min)|0?\.5\s*小时|半小时/i.test(s)) return 30;
    if (/空腹|服糖前|0\s*(分钟|min)|0h|0\s*小时/i.test(s)) return 0;
    return null;
  }

  /**
   * 按日期组织试验；同日多份独立试验必须用来源隔离，不混成一条五点曲线。
   */
  function buildOGTT(points, analyte) {
    var trials = {};
    var undated = [];
    (points || []).forEach(function (p) {
      if (p.analyze !== undefined && analyte && p.analyze !== analyte) return;
      var tp = ogttTimepoint(p.condition, p.name);
      var rec = {
        timepoint: tp, label: (function () {
          var o = OGTT_ORDER.filter(function (x) { return x.minutes === tp; })[0];
          return o ? o.label : '时点未明确';
        })(),
        value: p.value, raw: p.result, unit: p.unit || '', reference: p.reference || null,
        flag: p.flag || null, name: p.name, condition: p.condition,
        source: p.source, sourceRecordId: p.sourceRecordId, sourceTitle: p.sourceTitle,
        review: p.review
      };
      if (!p.date) { undated.push(rec); return; }
      var d = dateSortKey(p.date);
      if (!d) { undated.push(rec); return; }
      var trialKey = d + '#' + (p.sourceRecordId === null || p.sourceRecordId === undefined ? 'unknown' : p.sourceRecordId);
      var t = trials[trialKey];
      if (!t) {
        t = trials[trialKey] = {
          trialKey: trialKey, date: d, sourceRecordId: p.sourceRecordId || null,
          sourceTitle: p.sourceTitle || null, points: [], unit: rec.unit
        };
      }
      if (rec.unit && !t.unit) t.unit = rec.unit;
      t.points.push(rec);
    });

    var list = Object.keys(trials).sort().map(function (k) {
      var t = trials[k];
      t.points.sort(function (a, b) {
        var am = a.timepoint === null ? 9999 : a.timepoint;
        var bm = b.timepoint === null ? 9999 : b.timepoint;
        return am - bm;
      });
      t.curvePoints = t.points.filter(function (p) { return p.timepoint !== null && p.value !== null; });
      t.missing = OGTT_ORDER.filter(function (o) {
        return !t.points.some(function (p) { return p.timepoint === o.minutes && p.value !== null; });
      }).map(function (o) { return o.label; });
      t.enough = t.curvePoints.length >= 2;
      return t;
    });

    // 相同时点跨年度趋势：空腹/30/60/120/180 各自独立比较不同日期结果
    var byTimepoint = {};
    OGTT_ORDER.forEach(function (o) { byTimepoint[o.minutes] = []; });
    list.forEach(function (t) {
      t.curvePoints.forEach(function (p) { byTimepoint[p.timepoint].push({ date: t.date, trialKey: t.trialKey, value: p.value, unit: p.unit, label: p.label, sourceTitle: t.sourceTitle, sourceRecordId: t.sourceRecordId }); });
    });
    OGTT_ORDER.forEach(function (o) {
      byTimepoint[o.minutes].sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    });

    return {
      trials: list, byTimepoint: byTimepoint, order: OGTT_ORDER, undated: undated,
      trialCount: list.filter(function (t) { return t.date; }).length,
      note: list.length ? null : '暂无 OGTT 结果。'
    };
  }

  /* ---------------- 6. 费用 ---------------- */

  // 金额以「分」为单位用整数运算，输出保留两位小数（指令 §19）
  function toCents(raw) {
    // 未知金额：null / 缺失 / 空串 / 纯空白 / 不可解析 —— 不参与合计
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return null;
      return Math.round(raw * 100);
    }
    var s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/[,，\s]/g, '').replace(/[¥￥$元]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100);
  }

  function fmtMoney(cents) {
    if (cents === null || cents === undefined) return '未提供';
    var neg = cents < 0;
    var v = Math.abs(cents);
    return (neg ? '-' : '') + '¥' + Math.floor(v / 100) + '.' + pad2(v % 100);
  }

  // 票据的「明确总金额」：顶层 amount 优先，为空时回落到类型特殊数据中的嵌套总金额，
  // 不因顶层为空而漏计；两者不一致时记录冲突。
  function receiptAmount(r) {
    var top = toCents(r.amount);
    var tsd = r.type_specific_data || {};
    var nestedRaw = (tsd.total_amount !== undefined && tsd.total_amount !== null)
      ? tsd.total_amount
      : (tsd.total !== undefined && tsd.total !== null ? tsd.total
        : (tsd.fee_total !== undefined ? tsd.fee_total : undefined));
    var nested = toCents(nestedRaw);
    var out = { top: top, nested: nested, value: null, conflict: null, source: null };
    if (top !== null && nested !== null) {
      if (top === nested) { out.value = top; out.source = '顶层金额与结构化总金额一致'; }
      else {
        out.value = top; out.source = '取顶层金额';
        out.conflict = '顶层金额 ' + fmtMoney(top) + ' 与结构化总金额 ' + fmtMoney(nested) + ' 不一致，已标记待核对。';
      }
    } else if (top !== null) { out.value = top; out.source = '来源：顶层金额'; }
    else if (nested !== null) { out.value = nested; out.source = '来源：结构化总金额（顶层为空）'; }
    return out;
  }

  // 同一逻辑票据只计一次：按稳定文件哈希 → 解析任务 → 记录主键的优先级取键
  function receiptIdentity(r) {
    if (r.file_hash) return 'hash:' + r.file_hash;
    if (r.xparse_task_id) return 'task:' + r.xparse_task_id + ':' + (r.xparse_run_id || '');
    return 'id:' + r.id;
  }

  /**
   * 费用汇总。只统计医疗发票 / 收费单。
   * 未知金额与明确零金额严格分开。
   */
  function buildFees(records) {
    var receipts = (records || []).filter(function (r) { return r.document_type === '医疗发票/收费单' || r.document_type === '医疗发票 / 收费单'; });
    var seen = {};
    var counts = { total: 0, known: 0, unknown: 0, zero: 0, knownButZeroAmounted: 0 };
    var totalCents = 0, medCents = 0, selfCents = 0;
    var medKnown = 0, selfKnown = 0, medMissing = 0, selfMissing = 0;
    var years = {}, noDate = [];
    var list = [];

    receipts.forEach(function (r) {
      var idk = receiptIdentity(r);
      if (seen[idk]) { counts.duplicateSkipped = (counts.duplicateSkipped || 0) + 1; return; }
      seen[idk] = true;
      counts.total++;

      var amt = receiptAmount(r);
      var tsd = r.type_specific_data || {};
      var row = {
        recordId: r.id, title: r.title, date: r.primary_date || null,
        dateStatus: r.date_status || null, hospital: r.hospital || null,
        department: r.department || null, amountCents: amt.value,
        amountSource: amt.source, conflict: amt.conflict,
        insuranceCents: toCents(tsd.insurance_payment),
        selfCents: toCents(tsd.self_payment),
        items: Array.isArray(tsd.charge_items) ? tsd.charge_items : [],
        record: r
      };
      list.push(row);

      if (amt.value === null) {
        counts.unknown++;
        row.amountState = 'unknown';
      } else {
        counts.known++;
        if (amt.value === 0) { counts.zero++; row.amountState = 'zero'; }
        totalCents += amt.value;
        if (row.insuranceCents !== null) { medCents += row.insuranceCents; medKnown++; } else medMissing++;
        if (row.selfCents !== null) { selfCents += row.selfCents; selfKnown++; } else selfMissing++;

        // 年度：只有日期有效且金额明确的票据进入年度图
        var d = dateSortKey(row.date);
        if (d) {
          var y = d.slice(0, 4);
          years[y] = years[y] || { year: y, cents: 0, count: 0, zeroCount: 0 };
          years[y].cents += amt.value;
          years[y].count++;
          if (amt.value === 0) years[y].zeroCount++;
        } else {
          row.amountState = row.amountState === 'zero' ? 'zero-nodate' : 'known-nodate';
          noDate.push(row);
        }
      }
    });

    var yearList = Object.keys(years).sort().map(function (y) {
      return { year: y, cents: years[y].cents, amount: fmtMoney(years[y].cents), count: years[y].count };
    });
    var datedCents = 0, datedCount = 0;
    yearList.forEach(function (y) { datedCents += y.cents; datedCount += y.count; });

    return {
      list: list, counts: counts, yearList: yearList, noDate: noDate,
      totalCents: totalCents, total: fmtMoney(totalCents),
      datedCents: datedCents, datedTotal: fmtMoney(datedCents), datedCount: datedCount,
      insuranceCents: medKnown ? medCents : null,
      insurance: medKnown ? fmtMoney(medCents) : '未提供',
      insuranceKnown: medKnown, insuranceMissing: medMissing,
      selfCents: selfKnown ? selfCents : null,
      selfPay: selfKnown ? fmtMoney(selfCents) : '未提供',
      selfKnown: selfKnown, selfMissing: selfMissing,
      gapNote: (datedCents !== totalCents || datedCount !== counts.known)
        ? ('有日期票据合计 ' + fmtMoney(datedCents) + '（' + datedCount + ' 张），与全部明确金额总额 ' +
          fmtMoney(totalCents) + '（' + counts.known + ' 张）的差额来自无有效日期的票据，它们仍保留在总额与来源列表中。')
        : null,
      scopeNote: '本模块统计的是「已录入的票据」，不等于你的全部医疗开销，也不做支付、报销或保险结算。'
    };
  }

  /* ---------------- 7. 时间线与资料活动 ---------------- */

  function groupTimeline(records, opts) {
    opts = opts || {};
    var recentDateGroups = opts.recentDateGroups || 10;
    var dated = {}, pending = [];
    (records || []).forEach(function (r) {
      var d = dateSortKey(r.primary_date);
      if (!d || r.date_status === '日期待确认') { pending.push(r); return; }
      (dated[d] = dated[d] || []).push(r);
    });

    var yearMap = {};
    Object.keys(dated).sort().reverse().forEach(function (d) {
      var p = parseDateStrict(d);
      var y = String(p.y), m = pad2(p.m);
      yearMap[y] = yearMap[y] || { year: y, months: {} };
      yearMap[y].months[m] = yearMap[y].months[m] || { month: m, dates: [] };
      yearMap[y].months[m].dates.push({ date: d, records: dated[d] });
    });

    var dateGroups = [];
    var years = Object.keys(yearMap).sort().reverse().map(function (y) {
      var yy = yearMap[y];
      var months = Object.keys(yy.months).sort().reverse().map(function (m) {
        var mm = yy.months[m];
        mm.dates.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        mm.count = mm.dates.reduce(function (s, g) { return s + g.records.length; }, 0);
        mm.dateGroups = mm.dates.length;
        mm.dates.forEach(function (g) { dateGroups.push(g); });
        return mm;
      });
      yy.monthList = months;
      yy.count = months.reduce(function (s, m) { return s + m.count; }, 0);
      return yy;
    });

    dateGroups.forEach(function (g, i) { g.recent = i < recentDateGroups; });
    return { years: years, dateGroups: dateGroups, pending: pending, total: (records || []).length };
  }

  function buildActivity(records) {
    var yearMap = {};
    (records || []).forEach(function (r) {
      var d = dateSortKey(r.primary_date);
      if (!d) return;
      var y = d.slice(0, 4), m = d.slice(5, 7);
      yearMap[y] = yearMap[y] || { year: y, total: 0, months: {} };
      yearMap[y].months[m] = (yearMap[y].months[m] || 0) + 1;
      yearMap[y].total++;
    });
    return Object.keys(yearMap).sort().reverse().map(function (y) {
      var yy = yearMap[y];
      return {
        year: y, total: yy.total,
        months: Object.keys(yy.months).sort().map(function (m) { return { month: +m, count: yy.months[m] }; }),
        maxMonth: Math.max.apply(null, Object.keys(yy.months).map(function (m) { return yy.months[m]; }))
      };
    });
  }

  var DOC_TYPES = ['挂号单/就诊单', '检验报告', '检查报告', '处方/用药单', '医疗发票/收费单', '其他医疗资料'];

  function normalizeDocType(t) { return String(t || '').replace(/\s+/g, ''); }

  function typeDistribution(records) {
    var map = {};
    (records || []).forEach(function (r) {
      var t = normalizeDocType(r.document_type);
      map[t] = (map[t] || 0) + 1;
    });
    var all = DOC_TYPES.concat(Object.keys(map).filter(function (t) { return DOC_TYPES.indexOf(t) < 0; }));
    var uniq = [];
    all.forEach(function (t) { if (uniq.indexOf(t) < 0) uniq.push(t); });
    var total = (records || []).length;
    return uniq.map(function (t) {
      return { type: t, count: map[t] || 0, pct: total ? Math.round((map[t] || 0) / total * 100) : 0 };
    });
  }

  /* ---------------- 8. 药品 ---------------- */

  var EXPIRY_SOON_DAYS = 90;

  function expiryState(drug, todayIso) {
    var today = todayIso || todayISO();
    if (!drug.expiry_date) return { cls: 'exp-unknown', label: '有效期待确认', days: null, expired: false };
    var d = dateSortKey(drug.expiry_date);
    if (!d) return { cls: 'exp-unknown', label: '有效期待确认（原文日期不可解析）', days: null, expired: false };
    var days = diffDays(today, d);
    if (days < 0) return { cls: 'exp-past', label: '已过期 · ' + fmtCN(d), days: days, expired: true };
    if (days <= EXPIRY_SOON_DAYS) return { cls: 'exp-soon', label: '即将到期 · 剩余 ' + days + ' 天', days: days, expired: false };
    return { cls: 'exp-near', label: '有效期至 ' + fmtCN(d), days: days, expired: false };
  }

  function drugStatusGroup(status) {
    if (status === '正在服用') return 'current';
    if (status === '已停用') return 'history';
    return 'reserve';
  }

  function isInUseToday(drug, todayIso) {
    if (drug.status !== '正在服用') return false;
    var today = todayIso || todayISO();
    if (drug.start_date && dateSortKey(drug.start_date) && dateSortKey(drug.start_date) > today) return false;   // 未来开始
    if (drug.planned_end_date && dateSortKey(drug.planned_end_date) && dateSortKey(drug.planned_end_date) < today) return false; // 计划已结束
    return true;
  }

  function applyDrugEvent(drug, ev, todayIso) {
    // 只追加事件，不覆盖历史（指令 §13）
    var history = Array.isArray(drug.history) ? drug.history.slice() : [];
    var from = drug.status, to = drug.status;
    var patch = {};
    if (ev.type === '开始' || ev.type === '再次开始') { to = '正在服用'; patch.start_date = ev.date; }
    else if (ev.type === '暂停') { to = '备用药'; }
    else if (ev.type === '停止') { to = '已停用'; }
    history.push({
      event_type: ev.type, event_date: ev.date, note: ev.note || null,
      from_status: from, to_status: to,
      dose_each_time: ev.dose_each_time || null, frequency: ev.frequency || null,
      timing: ev.timing || null, planned_end_date: ev.planned_end_date || null,
      recorded_at: new Date().toISOString()
    });
    patch.status = to;
    patch.history = history;
    if (ev.type === '开始' || ev.type === '再次开始') {
      if (ev.dose_each_time) patch.dose_each_time = ev.dose_each_time;
      if (ev.frequency) patch.frequency = ev.frequency;
      if (ev.timing) patch.timing = ev.timing;
      if (ev.planned_end_date) patch.planned_end_date = ev.planned_end_date;
    }
    return patch;
  }

  /* ---------------- 9. 导出 ---------------- */

  global.Logic = {
    // escape
    escapeHtml: escapeHtml,
    // date
    parseDateStrict: parseDateStrict, isValidDate: isValidDate, dateSortKey: dateSortKey,
    fmtYearMonth: fmtYearMonth, fmtCN: fmtCN, fmtCNShort: fmtCNShort, todayISO: todayISO,
    addDaysISO: addDaysISO, diffDays: diffDays, pad2: pad2,
    // value
    isBlank: isBlank, parseStrictNumber: parseStrictNumber, looksQualitative: looksQualitative,
    normalizeFlag: normalizeFlag,
    // unit
    normUnit: normUnit, canonicalUnitLabel: canonicalUnitLabel, normalizeForDisplay: normalizeForDisplay,
    CONVERSIONS: CONVERSIONS, round: round,
    // catalog
    PRESET_CATALOG: PRESET_CATALOG, matchLabItem: matchLabItem, normName: normName,
    deriveIndicatorPoints: deriveIndicatorPoints,
    // trend
    buildTrend: buildTrend, buildBPtrend: buildBPtrend, lipidSummary: lipidSummary,
    buildOGTT: buildOGTT, OGTT_ORDER: OGTT_ORDER, ogttTimepoint: ogttTimepoint,
    // fee
    toCents: toCents, fmtMoney: fmtMoney, buildFees: buildFees, receiptAmount: receiptAmount,
    receiptIdentity: receiptIdentity,
    // timeline
    groupTimeline: groupTimeline, buildActivity: buildActivity,
    typeDistribution: typeDistribution, DOC_TYPES: DOC_TYPES, normalizeDocType: normalizeDocType,
    // drug
    expiryState: expiryState, drugStatusGroup: drugStatusGroup, isInUseToday: isInUseToday,
    applyDrugEvent: applyDrugEvent
  };
})(typeof window !== 'undefined' ? window : this);
