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

  /* 日期状态只有两个字面量，但历史数据里出现过两种拼法（'待确认' 与 '日期待确认'），
     而读方只认其中一种 —— 结果是指令 §18 明令排除的「日期待确认记录」照样进了趋势、
     年度费用与「覆盖的有效日期」。统一成：写方只用 DATE_STATUS，读方一律走 isDatePending
     （**非「已确认」即视为待确认**，不再做字符串等值比较），旧数据不改写也不会漏。
     字段为空按「没有这个状态」处理，不凭空怀疑成待确认。 */
  var DATE_STATUS = { CONFIRMED: '已确认', PENDING: '日期待确认' };

  function isDatePending(o) {
    var r = o || {};
    // 同一条事实有两种字段名：SQLite 行用列名 date_status，派生点用 camelCase dateStatus。
    // 只读一种就会让"谓词已经加了"变成假象 —— 趋势层正是这样漏掉的。
    var s = r.date_status === undefined ? r.dateStatus : r.date_status;
    if (s === null || s === undefined) return false;
    s = String(s).trim();
    if (!s) return false;
    return s !== DATE_STATUS.CONFIRMED;
  }

  // 「有效日期」= 日期本身可解析 且 状态不是待确认。时间线、趋势、资料活动、年度费用
  // 必须共用这一条判据，否则同一份资料在一个视图里算数、在另一个视图里不算。
  function hasEffectiveDate(rec) {
    if (isDatePending(rec)) return false;
    return !!dateSortKey((rec || {}).primary_date);
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
      .replace(/[\u2212\u2013\u2014]/g, '-');
    if (!s) return null;
    // 数字中间夹空格说明这不是一个完整数字（OCR 串行常见），拼起来就是一个假的放大值
    if (/[\d]\s+[\d]/.test(s)) return null;
    s = s.replace(/\s+/g, '');
    // 逗号只有在"千分位"这一种语义唯一时才允许：1,345.6 可以，27,38 不行
    // （27,38 可能是 27.38，也可能是千分位；猜错就是把 27.38 变成 2738）。
    if (s.indexOf(',') >= 0) {
      if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) return null;
      s = s.replace(/,/g, '');
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
    var n = parseFloat(s);
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

  /* 拉丁缩写别名必须独立成词：命中位置的左右都不能紧贴字母或数字。
     normName 会把括号和空格一并剥掉，于是「总胆固醇(TC)」归一成 总胆固醇tc、
     心电图的「QTC间期」归一成 qtc间期 —— 两者都"含有 tc"，只有边界能区分：
     前者左侧是汉字，左侧是字母 q 的那个才是别的缩写。 */
  /* 「血脂」这类展示用聚合组不参与名称匹配：没有任何视图读 pts['lipids']，
     命中它等于让这条数值从所有界面消失。OGTT 两个组键不在此列 —— 它们的点由 buildOGTT 读。 */
  var NON_MATCHABLE_GROUP_KEYS = ['lipids'];

  // 纯拉丁形状的别名（含 hdl-c / hba1c 这类带连字符或超过 4 位的）一律按缩写对待：
  // 只认全等或带词边界的出现，不参与"包含即命中"。
  function isLatinAlias(a) { return /^[a-z][a-z0-9\-\.]*$/.test(a); }

  /* 缩写出现位置的左侧若是否定/派生前缀，那是另一个分析物：
     「非HDL-C」不是高密度脂蛋白，汉字「非」在归一化后不构成字母边界，
     光靠"两侧不是字母数字"拦不住。 */
  var _RE_NEG_PREFIX = /(非|抗|脱|重)$/;

  function hasBoundedAbbr(s, a) {
    var at = s.indexOf(a);
    while (at >= 0) {
      var before = at > 0 ? s.charAt(at - 1) : '';
      var after = at + a.length < s.length ? s.charAt(at + a.length) : '';
      if (!/^[a-z0-9]$/.test(before) && !/^[a-z0-9]$/.test(after) &&
          !_RE_NEG_PREFIX.test(s.slice(0, at))) return true;
      at = s.indexOf(a, at + 1);
    }
    return false;
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
    /* OGTT 上下文只能来自"这确实是糖耐量试验"的原文证据（panel 或项目名）。
       以前还额外认 condition 里的「空腹 / 2小时 / 餐后」—— 而 condition 在真实数据里
       经常是栏目名或测量状态，于是普通「空腹血糖」被整批判进 OGTT：
       真实库 6 条空腹血糖有 5 条因此永远进不了它自己的指标。时点归属另有
       ogttTimepoint() 负责，它读的是条件与项目名，不需要在这里抢着判。 */
    var ogttContext = /ogtt|糖耐量|葡萄糖耐量|服糖后/.test(panel + name);
    // 甲功项目的缩写（Tg / TG）与血脂缩写撞字，指令 §15 点名的就是这个混淆
    var thyroidWord = /甲状腺|球蛋白|抗tpo/i.test(name);
    var urineWord = /尿/.test(name) || /尿/.test(panel);

    // 1) OGTT 专项优先（葡萄糖 / 胰岛素分开）
    if (ogttContext) {
      if (/胰岛素/.test(name) && byKey.ogtt_ins) return { key: 'ogtt_ins', rule: 'OGTT 胰岛素（需原文明确时点）' };
      if (/葡萄糖|血糖/.test(name) && byKey.ogtt_glu) return { key: 'ogtt_glu', rule: 'OGTT 血糖（需原文明确时点）' };
    }

    // 2) HDL / LDL 必须先于「胆固醇」判断，避免被总胆固醇吞掉。
    //    优先键写死顺序；其余目录键（含糖化血红蛋白与用户自定义指标）按目录顺序补在其后，
    //    这样新增目录项自动参与「来源提取」，不必再回来改这张表。
    var PRIORITY = ['hdl', 'ldl', 'tg', 'tc', 'fbg', 'ua', 'scr', 'tsh', 'bmi', 'weight', 'bp'];
    var ordered = PRIORITY.filter(function (k) { return byKey[k]; });
    Object.keys(byKey).forEach(function (k) {
      if (ordered.indexOf(k) < 0) ordered.push(k);
    });
    for (var i = 0; i < ordered.length; i++) {
      var key = ordered[i];
      var c = byKey[key];
      if (!c) continue;
      /* 「血脂」是展示用的指标组：数值挂在 tc/tg/hdl/ldl 四个分项键上，任何视图都不读
         pts['lipids']。让原名就是「血脂四项」的那种汇总行命中它，等于把这一条数值丢在
         所有视图之外 —— 静默消失比显示错值更难被发现。OGTT 两个组键不同：它们的点有人读。 */
      if (NON_MATCHABLE_GROUP_KEYS.indexOf(key) >= 0) continue;

      // 尿肌酐等不同分析物不得混入血肌酐（panel 里带「尿」同样算尿液标本）
      if (key === 'scr' && urineWord && !/血/.test(name)) continue;
      // 尿酸：排除「尿酸碱度」「尿酸盐」「尿常规(UA)」「尿酸/肌酐比值」等尿常规语义
      if (key === 'ua' && /酸碱度|ph值|结晶|盐|比值|清除率/i.test(name)) continue;
      if (key === 'ua' && urineWord && !/血/.test(name)) continue;
      // 甲状腺球蛋白等甲功项目不得因为缩写撞字进血脂（指令 §15）
      if (thyroidWord && (key === 'tg' || key === 'tc' || key === 'hdl' || key === 'ldl')) continue;

      var hit = false, viaBounded = false;
      var al = (c.aliases || []).concat(c.extraAliases || []);
      for (var j = 0; j < al.length; j++) {
        var a = normName(al[j]);
        if (!a) continue;
        // 缩写型别名（纯拉丁形状，不限长度）只在上下文吻合时才接受，避免 TG / TC 误配
        var isAbbrev = isLatinAlias(a);
        // 上下文闸门必须在「完全相等」之前生效，否则 TG 这类缩写仍会被直接命中
        if (isAbbrev && c.needsLipidContext && !lipidContext) continue;
        if (name === a) { hit = true; break; }
        if (isAbbrev) {
          if (hasBoundedAbbr(name, a)) { hit = true; viaBounded = true; }
        }
      }
      // 名称包含别名（如「血清尿酸」含「尿酸」）：只对中文别名放开，仍受上下文闸门约束。
      // 拉丁缩写不参与包含匹配 —— 它们在上一轮已经按词边界判过，再放开就会把 QTC 吞成 TC。
      if (!hit) {
        for (var k = 0; k < (c.aliases || []).length; k++) {
          var a2 = normName(c.aliases[k]);
          if (isLatinAlias(a2)) continue;
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

  /* 报告分组名 / 机构套餐名 ≠ 测量条件。
     OCR 常把「生化-肾功」「肾功三项，华大检验」「慈铭-肾功能3项」这类栏目名抄进
     condition 字段。若按字符串原样分组，同一分析物会被切成一串单点序列：趋势连不成线，
     「最新结果」还会从某个单点分组里取到几年前的值。真测量条件（空腹 / 餐后 2 小时 /
     静息）必须继续隔离 —— 指令 §16「不同测量条件不串成同一条线」。 */
  /* 混合写法才是真实数据的常态（`空腹，检验项目：生化-血糖`、`体检-空腹`），所以判据是
     "先从整串里找出测量短语"，而不是判"整串像不像栏目名"—— 后者会把空腹与餐后 2 小时
     并成同一组，画出一条根本不存在的血糖上升线，比不连线更糟。 */
  var _RE_PANEL_LABEL = /生化|免疫|发色|常规|肾功|肝功|甲功|甲状腺|血脂|血糖|尿酸|肌酐|胆红素|脂蛋白|胆固醇|甘油三酯|激素|肿瘤|标志物|酶谱|项|套餐|组合|检验|检测|分析|筛查|门诊|病房|体检|中心|医院|公司|机构|华大|慈铭|美年|爱康|瑞慈|迪安|金域|艾迪康|\d{4}/;
  var _RE_MEASURE_PHRASE = /(空腹|禁食|餐前|餐后\s*(?:半|一|两|二|三|\d+)?\s*(?:小时|个小时|h)?|服糖后\s*\d+\s*(?:小时|分钟|h|min)|静息|坐位|卧位|平卧|侧卧|立位|晨起|夜间|睡前|随机|吸氧|用药后|运动后|清醒|睡眠状态|发热后|上午|下午)/;

  // 找出串里的测量状态短语（保留原写法，只把连续空白压成一个空格）
  function measurePhrase(cond) {
    var raw = cond === null || cond === undefined ? '' : String(cond);
    var m = raw.match(_RE_MEASURE_PHRASE);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }

  function conditionIsPanelLabel(cond) {
    var raw = cond === null || cond === undefined ? '' : String(cond).trim();
    if (!raw) return false;
    if (measurePhrase(raw)) return false;        // 认得出测量状态，就不是栏目名
    return _RE_PANEL_LABEL.test(normName(raw));
  }

  /* 「这条测量状态，是不是把指标自己的名字又念了一遍？」
     空腹血糖的 6 条里 5 条写着 condition=空腹、1 条为空，于是被切成两组，
     每组都撑不起一条线 —— 而「空腹」对这个指标并没有指出第二个测量点。
     判据不维护"指标↔词"的搭配表，只看名字的规范化写法里是否已经出现这个短语：
     名字里带时点的，条件必须写同一个时点才算同义（餐后2小时的指标上，
     忽然冒出来的「空腹」是真冲突，必须继续单独成组）。 */
  function canonCondText(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase()
      .replace(/[０-９]/g, function (d) { return String(d.charCodeAt(0) - 0xFF10); })
      .replace(/两|二/g, '2').replace(/一/g, '1').replace(/三/g, '3')
      .replace(/四/g, '4').replace(/五/g, '5').replace(/六/g, '6')
      .replace(/七/g, '7').replace(/八/g, '8').replace(/九/g, '9')
      .replace(/半(?=个?小时)/g, '0.5')
      .replace(/(\d)个小时/g, '$1小时')
      .replace(/(\d)h(?![a-z])/g, '$1小时')
      .replace(/\s+/g, '');
  }

  function conditionEntailedByName(phrase, label) {
    var p = canonCondText(phrase), n = canonCondText(label);
    if (!p || !n) return false;
    return n.indexOf(p) >= 0;
  }

  /* 连线分组用的键：认得出测量状态就用它（顺带丢掉混在里面的栏目词），
     否则一律并回「未标注条件」。方向刻意选成"宁可合并、不误分裂"？不 —— 这里恰恰相反：
     测量状态认出来就分开，认不出才合并。误合并会串线（看得见），误分裂只是少几个点。
     传第二个参数（指标自己的名字 / 别名）时，与它同义的测量状态不再分裂序列。 */
  function conditionSeriesKey(cond, label) {
    var raw = cond === null || cond === undefined ? '' : String(cond).trim();
    if (!raw) return '未标注条件';
    var phrase = measurePhrase(raw);
    if (!phrase) return '未标注条件';
    if (label && conditionEntailedByName(phrase, label)) return '未标注条件';
    return phrase;
  }

  /* 把 `condition` 里混写的两件事拆回两个字段：测量状态留在 condition，栏目名挪去 panel。
     判据刻意全部复用上面那三个（measurePhrase / _RE_PANEL_LABEL / conditionIsPanelLabel）：
     存量回改（待办 17 后半）与展示层分组必须同一套话，否则"改完数据再判"会把连线分组改掉。
     两头都不像的串原样留在 condition —— 宁可不动，不可销毁。 */
  var _RE_COND_LABEL_PREFIX = /^\s*(?:检验项目|项目名称|项目|检查科室|科室|栏目|组套|套餐)\s*[:：]\s*/;
  function splitCondition(cond) {
    var raw = cond === null || cond === undefined ? '' : String(cond).trim();
    if (!raw) return { panel: '', condition: '' };
    var phrase = measurePhrase(raw);
    if (phrase) {
      var rest = raw.replace(_RE_MEASURE_PHRASE, '')
        .replace(/^[\s，,、；;：\-]+/, '')
        .replace(/[\s，,、；;：\-]+$/, '')
        .replace(_RE_COND_LABEL_PREFIX, '')
        .trim();
      return { panel: rest, condition: phrase };
    }
    if (conditionIsPanelLabel(raw)) {
      return { panel: raw.replace(_RE_COND_LABEL_PREFIX, '').trim(), condition: '' };
    }
    return { panel: '', condition: raw };
  }

  // 从检验报告的结构化结果派生指标点（不复制写入日常指标表）
  /* 展示用聚合组 → 真正存着数值的键。只有这一个地方知道「血脂由哪四项组成」，
     表格判断有无数据、详情取数、连线次数都从这里读。
     以前这句话抄在四处（indicatorStats / lipidSummary / sparkCell / openIndicator），
     少抄一处就出现"表格说有 3 次、点进去暂无记录"。 */
  var GROUP_COMPONENTS = { lipids: ['tc', 'tg', 'hdl', 'ldl'] };

  function indicatorComponents(key) {
    if (!key) return [];
    return GROUP_COMPONENTS[key] || [key];
  }

  /* ---------------- 6.5 按人的关注指标 ----------------
     指标定义（名称 / 单位 / 别名 / 换算规则）全家共用一份；只有「是否关注」
     按人存在每行的 followers 里。分成两份定义的话，别名匹配和受控换算迟早会分叉。
     未指定归属用 0 作键，不用 null —— 对象键经 JSON 会变成字符串 "null"。 */

  var UNASSIGNED = 0;

  function isAllView(pid) {
    return pid === undefined || pid === null || pid === 'all';
  }

  // 记录属于谁：0 / null / 空串都算「未指定」，不能拿真值判断把 0 当成假值漏掉
  function personMatches(row, pid) {
    var mine = (row || {}).person_id;
    var blank = (mine === null || mine === undefined || mine === '');
    var want = isAllView(pid) ? null : Number(pid);
    if (want === null) return true;
    if (want === 0) return blank;
    return !blank && Number(mine) === want;
  }

  // 老数据没有 followers：按全局 followed 展开给全体（含未指定）。已有就不动。
  function withFollowers(row, persons) {
    var r = Object.assign({}, row || {});
    if (Array.isArray(r.followers)) return r;
    var ids = (persons || []).map(function (p) { return Number(p.id); });
    ids.push(UNASSIGNED);
    r.followers = r.followed ? ids : [];
    return r;
  }

  function followedBy(row, pid) {
    if (!row) return false;
    if (isAllView(pid)) return !!row.followed;
    var list = Array.isArray(row.followers) ? row.followers : [];
    return list.map(Number).indexOf(Number(pid)) >= 0;
  }

  function setFollowFor(row, pid, on) {
    var r = Object.assign({}, row || {});
    if (isAllView(pid)) { r.followed = !!on; return r; }
    var want = Number(pid);
    var list = (Array.isArray(r.followers) ? r.followers : []).map(Number);
    var at = list.indexOf(want);
    if (on && at < 0) list.push(want);
    if (!on && at >= 0) list.splice(at, 1);
    r.followers = list;
    return r;
  }

  // 按人视图：换掉 followed，其余字段原样透出（来源提取靠别名与键，不能被动）
  function catalogForPerson(rows, pid) {
    return (rows || []).map(function (c) {
      var o = Object.assign({}, c);
      o.followed = followedBy(c, pid);
      return o;
    });
  }

  // 成员被删掉后，其 id 不该继续留在关注集合里
  function pruneFollowers(rows, persons) {
    var keep = (persons || []).map(function (p) { return Number(p.id); });
    keep.push(UNASSIGNED);
    return (rows || []).map(function (c) {
      var o = Object.assign({}, c);
      if (Array.isArray(o.followers)) {
        o.followers = o.followers.map(Number).filter(function (x) { return keep.indexOf(x) >= 0; });
      }
      return o;
    });
  }

  // 新增成员默认继承「我」的关注集合，否则点进去是一张空白目录
  function inheritFollowers(rows, fromPid, toPid) {
    var from = Number(fromPid), to = Number(toPid);
    return (rows || []).map(function (c) {
      var list = Array.isArray(c.followers) ? c.followers.map(Number) : null;
      if (!list || list.indexOf(from) < 0 || list.indexOf(to) >= 0) return Object.assign({}, c);
      return Object.assign({}, c, { followers: list.concat([to]) });
    });
  }

  function deriveIndicatorPoints(records, catalog, pid) {
    var pts = [];
    var list = (records || []).filter(function (r) { return personMatches(r, pid); });
    list.forEach(function (r) {
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
        var cent = (catalog || PRESET_CATALOG).filter(function (x) { return x.key === m.key; })[0];
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
          analyze: cent ? cent.analyze : null,
          // 指标自己的显示名：趋势分组要用它判断"条件是否同义重复"（见 conditionSeriesKey）
          indicatorLabel: cent ? cent.name : null
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
   * 不同测量条件不串线；多单位组先按量级智能归并（漏印单位/未知单位且数值量级
   * 与多数组一致 → 并入连线；量级对不上才只连唯一多数单位组，平票不连线）。
   */
  function buildTrend(points, opts) {
    opts = opts || {};
    var all = [];
    var undated = [];
    var pendingStatus = 0;
    (points || []).forEach(function (p) {
      var rec = {
        date: dateSortKey(p.date),
        rawDate: p.date || null,
        dateStatus: p.dateStatus || null,
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
        name: p.name || null,
        indicatorLabel: p.indicatorLabel || null
      };
      if (rec.value === null || rec.value === undefined) { undated.push(rec); rec.excluded = '结果不是精确数值（定性或带比较符）'; return; }
      if (!rec.date) { undated.push(rec); rec.excluded = '无可解析的日期，不参与连线'; return; }
      // 指令 §18：日期状态待确认的资料可以查看，但不能进入按日期计算的趋势。
      // 光看日期能不能解析不够 —— 归档时 guessDate() 猜出来的日期照样能解析。
      if (isDatePending(rec)) {
        undated.push(rec); rec.excluded = '日期状态待确认，不参与连线'; pendingStatus++; return;
      }
      var norm = normalizeForDisplay(rec.analyze, rec.value, rec.unit);
      rec.normValue = norm.value;
      rec.normUnit = norm.unit;
      rec.conversion = norm;
      all.push(rec);
    });

    // 条件隔离：不同测量条件不串成同一条线
    var byCondition = {};
    all.forEach(function (r) {
      // 带上指标自己的名字：与它同义的测量状态（空腹血糖上的「空腹」）不再分裂序列
      var c = conditionSeriesKey(r.condition, ((r.name || '') + ' ' + (r.indicatorLabel || '')));
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
        // 智能归并（对 §16 的放宽）：剩下的少数组要么「未提供单位」，要么是未纳入
        // 受控换算的未知单位 —— 若整组数值都落在多数组的量级区间内（最小值÷3 ~
        // 最大值×3），视为报告漏印单位/同单位异写，并入多数组连线；原值不改写，
        // 仅在备注说明。量级对不上的（如尿酸 μmol/L vs mg/dL 换算缺失）依然不并，
        // 防止把两种单位串成一条假线。
        var majKey = uKeys[0];
        var majVals = unitGroups[majKey].map(function (r) { return r.normValue; });
        var lo = Math.min.apply(null, majVals) / 3, hi = Math.max.apply(null, majVals) * 3;
        var mergedDescs = [];
        uKeys.slice(1).forEach(function (k) {
          var fits = unitGroups[k].every(function (r) {
            return isFinite(r.normValue) && r.normValue >= lo && r.normValue <= hi;
          });
          if (fits) {
            mergedDescs.push((k === '未提供单位' ? '未标注单位' : '单位「' + k + '」') +
              '×' + unitGroups[k].length);
            unitGroups[majKey] = unitGroups[majKey].concat(unitGroups[k]);
            delete unitGroups[k];
          }
        });
        if (mergedDescs.length) {
          result.notes.push('「' + cond + '」的 ' + mergedDescs.join('、') +
            ' 记录，数值量级与 ' + majKey + ' 组一致，已一并连线（仅展示层归并，原值未改写）。');
        }
        uKeys = Object.keys(unitGroups).sort(function (a, b) {
          return unitGroups[b].length - unitGroups[a].length;
        });
        if (uKeys.length === 1) {
          chosenKey = uKeys[0];
        } else if (unitGroups[uKeys[0]].length === unitGroups[uKeys[1]].length) {
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
    if (pendingStatus) {
      result.notes.push('另有 ' + pendingStatus + ' 条结果的日期状态是「待确认」，按规则不进入趋势（仍保留在历史记录里）；' +
        '在「记录信息」里把主要日期确认为真实日期后，它们就会参与连线。');
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
    var valid = (points || []).filter(function (p) { return p.date && p.value !== null && !isDatePending(p); })
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
    var keys = GROUP_COMPONENTS.lipids;
    var dateSet = {};
    keys.forEach(function (k) {
      (pointsByKey[k] || []).forEach(function (p) {
        var d = dateSortKey(p.date);
        if (d && !isDatePending(p)) dateSet[d] = true;   // 与趋势同一口径：待确认日期不算一次检查
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
      if (!p.date || isDatePending(p)) { undated.push(rec); return; }
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
    var s = String(raw).trim().replace(/[¥￥$元\s]/g, '');
    if (!s) return null;
    // 数字判据必须和 parseStrictNumber 同一套：否则 '12,34' 在这里被剥成 1234（¥1234.00），
    // 而指标那边对同样的写法选择不猜。全角数字也走这条路，两边口径才一致。
    var n = parseStrictNumber(s);
    if (n === null) return null;
    return Math.round(n * 100);
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
    var counts = { total: 0, known: 0, unknown: 0, zero: 0 };
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

        // 年度：日期有效（可解析且状态不是待确认）且金额明确的票据才进年度图
        var d = isDatePending(r) ? null : dateSortKey(row.date);
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
      if (!d || isDatePending(r)) { pending.push(r); return; }
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
      var d = hasEffectiveDate(r) ? dateSortKey(r.primary_date) : null;
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

  var DOC_TYPES = ['挂号单/就诊单', '检验报告', '检查报告', '体检报告', '处方/用药单', '医疗发票/收费单', '其他医疗资料'];

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

  /* ---------------- 8.7 手工编辑与留痕 ---------------- */
  /*
    留痕只认一种形状：{ target, label, from, to, at, row_name?, note? }
    target 是一条路径串，三种写法：
      'hospital'                         记录上的标量字段
      'type_specific_data.total_amount'  结构化数据里的标量
      'lab_results.0.result'             明细表的某个单元格
    明细记到单元格级而不是整表存一份旧数组，是因为「血红蛋白被我改过」这件事
    只有落到格子上才追得回去，也才谈得上跟模型结果比冲突。
  */

  var EDIT_LABELS = {
    title: '标题', document_type: '文档类型', primary_date: '主要日期', date_status: '日期状态',
    hospital: '医院', department: '科室', doctor: '医生', amount: '金额',
    source_file: '原始文件名', parse_status: '解析状态', key_information: '关键原文信息',
    person_id: '归属成员'
  };

  // 表名与列名必须与 app.js 里 renderTypeSpecific 读的键一致，
  // 否则编辑框会铺到不存在的列上，改完页面看着没变。
  var EDIT_TABLES = {
    lab_results: { label: '检验结果', list: true, cols: {
      name: '检验项名称', result: '检验项结果', unit: '单位', reference: '参考范围',
      flag: '原报告提示', panel: '所属检验项目', condition: '测量条件' } },
    exams: { label: '检查报告', list: true, cols: {
      exam_name: '检查项目', findings: '检查所见', impression: '检查意见', exam_method: '检查方法',
      clinical_info: '临床信息', date: '检查日期', source_note: '来源说明' } },
    charge_items: { label: '收费明细', list: true, cols: {
      item: '项目名称', name: '项目名称', amount: '金额', qty: '数量',
      unit_price: '单价', insurance_type: '医保类别' } },
    general_exam: { label: '一般检查', list: false, cols: {
      height_cm: '身高', weight_kg: '体重', bmi: '体重指数', systolic_mmHg: '收缩压',
      diastolic_mmHg: '舒张压', pulse_bpm: '脉搏' } }
  };
  var EDIT_TS_SCALARS = {
    total_amount: '结构化总金额', total: '结构化总金额', fee_total: '结构化总金额',
    insurance_payment: '医保支付', self_payment: '个人支付', payment_method: '支付方式',
    settle_time: '结算时间', amount_in_words: '金额大写', final_conclusion: '最终结论',
    conclusion_note: '结论说明'
  };

  function editBlank(v) { return (v === undefined || v === null || v === '') ? null : v; }

  // 「没填」有好几种写法，统一成 null 再比，否则每次保存都会冒出一条假留痕
  function sameEditValue(a, b) {
    a = editBlank(a); b = editBlank(b);
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    var na = Number(a), nb = Number(b);
    if (isFinite(na) && isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
    return String(a) === String(b);
  }

  // target → 内部定位描述
  function parseEditTarget(target) {
    var p = String(target || '').split('.');
    if (p.length === 1) return EDIT_LABELS[p[0]] ? { kind: 'field', name: p[0] } : null;
    if (p[0] === 'type_specific_data' && p.length === 2) {
      return EDIT_TS_SCALARS[p[1]] ? { kind: 'tsScalar', name: p[1] } : null;
    }
    var tab = EDIT_TABLES[p[0]];
    if (!tab) return null;
    if (tab.list && p.length === 3) {
      var i = Number(p[1]);
      return EDIT_TABLES[p[0]].cols[p[2]] ? { kind: 'cell', table: p[0], index: i, col: p[2] } : null;
    }
    if (!tab.list && p.length === 2) {
      return tab.cols[p[1]] ? { kind: 'objCell', table: p[0], col: p[1] } : null;
    }
    if (p.length === 1) return { kind: 'table', table: p[0] };
    return null;
  }

  function editLabel(target) {
    var t = parseEditTarget(target);
    if (!t) return null;
    if (t.kind === 'field') return EDIT_LABELS[t.name];
    if (t.kind === 'tsScalar') return EDIT_TS_SCALARS[t.name];
    if (t.kind === 'table') return EDIT_TABLES[t.table].label + '（整表变更）';
    if (t.kind === 'objCell') return EDIT_TABLES[t.table].cols[t.col];
    return EDIT_TABLES[t.table].cols[t.col];
  }

  // 从一条记录（或一份模型结果）上读出 target 当前的值
  function editValueAt(obj, t) {
    if (!obj) return undefined;
    if (t.kind === 'field') return obj[t.name] === undefined ? null : obj[t.name];
    var tsd = obj.type_specific_data;
    if (typeof tsd === 'string') { try { tsd = JSON.parse(tsd); } catch (e) { tsd = null; } }
    if (!tsd || typeof tsd !== 'object') return undefined;
    if (t.kind === 'tsScalar') return tsd[t.name] === undefined ? null : tsd[t.name];
    var holder = tsd[t.table];
    if (t.kind === 'cell') {
      if (!Array.isArray(holder)) return undefined;
      var row = holder[t.index];
      return (row && typeof row === 'object') ? (row[t.col] === undefined ? null : row[t.col]) : undefined;
    }
    if (t.kind === 'objCell') {
      if (!holder || typeof holder !== 'object') return undefined;
      return holder[t.col] === undefined ? null : holder[t.col];
    }
    return undefined;
  }

  function cloneTs(tsd) {
    if (!tsd || typeof tsd !== 'object') return {};
    try { return JSON.parse(JSON.stringify(tsd)); } catch (e) { return {}; }
  }

  // 返回一份新的 type_specific_data；路径不存在时原样返回拷贝，绝不凭空造行造列
  function tsSetCopy(tsd, target, value) {
    var out = cloneTs(tsd);
    var t = parseEditTarget(target);
    if (!t || (t.kind !== 'cell' && t.kind !== 'objCell' && t.kind !== 'tsScalar')) return out;
    if (t.kind === 'tsScalar') { out[t.name] = value; return out; }
    if (t.kind === 'cell') {
      var arr = out[t.table];
      if (!Array.isArray(arr) || !arr[t.index] || typeof arr[t.index] !== 'object') return out;
      arr[t.index][t.col] = value;
      return out;
    }
    var obj = out[t.table];
    if (!obj || typeof obj !== 'object') return out;
    obj[t.col] = value;
    return out;
  }

  function rowLabelOf(rowObj) {
    if (!rowObj || typeof rowObj !== 'object') return '';
    var v = rowObj.name || rowObj.item || rowObj.exam_name || '';
    return String(v).trim();
  }

  function diffListEdits(table, prevRows, nextRows, at, out) {
    if (prevRows.length !== nextRows.length) {
      out.push({ target: table, label: EDIT_TABLES[table].label + '（整表变更）',
                 from: prevRows.length + ' 行', to: nextRows.length + ' 行', at: at });
      return;
    }
    for (var i = 0; i < nextRows.length; i++) {
      var a = prevRows[i] || {}, b = nextRows[i] || {};
      var cols = Object.keys(EDIT_TABLES[table].cols);
      Object.keys(a).concat(Object.keys(b)).forEach(function (c) {
        if (cols.indexOf(c) < 0) cols.push(c);
      });
      cols.forEach(function (c) {
        if (sameEditValue(a[c], b[c])) return;
        out.push({
          target: table + '.' + i + '.' + c,
          label: EDIT_TABLES[table].cols[c] || (EDIT_TABLES[table].label + '·' + c),
          row_name: rowLabelOf(a) || rowLabelOf(b), from: a[c] === undefined ? null : a[c],
          to: b[c] === undefined ? null : b[c], at: at
        });
      });
    }
  }

  function diffTsEdits(prevTsd, nextTsd, at) {
    prevTsd = prevTsd && typeof prevTsd === 'object' ? prevTsd : {};
    nextTsd = nextTsd && typeof nextTsd === 'object' ? nextTsd : {};
    var out = [];
    Object.keys(nextTsd).forEach(function (k) {
      if (EDIT_TABLES[k] && EDIT_TABLES[k].list) {
        diffListEdits(k, Array.isArray(prevTsd[k]) ? prevTsd[k] : [],
                      Array.isArray(nextTsd[k]) ? nextTsd[k] : [], at, out);
        return;
      }
      if (EDIT_TABLES[k]) {
        var a = prevTsd[k] && typeof prevTsd[k] === 'object' ? prevTsd[k] : {};
        var b = nextTsd[k] && typeof nextTsd[k] === 'object' ? nextTsd[k] : {};
        Object.keys(b).forEach(function (c) {
          if (!EDIT_TABLES[k].cols[c] || sameEditValue(a[c], b[c])) return;
          out.push({ target: k + '.' + c, label: EDIT_TABLES[k].cols[c],
                     row_name: EDIT_TABLES[k].label, from: a[c] === undefined ? null : a[c],
                     to: b[c] === undefined ? null : b[c], at: at });
        });
        return;
      }
      if (EDIT_TS_SCALARS[k] && !sameEditValue(prevTsd[k], nextTsd[k])) {
        out.push({ target: 'type_specific_data.' + k, label: EDIT_TS_SCALARS[k],
                   from: prevTsd[k] === undefined ? null : prevTsd[k],
                   to: nextTsd[k] === undefined ? null : nextTsd[k], at: at });
      }
    });
    return out;
  }

  function diffRecordEdits(prev, patch, opts) {
    prev = prev || {}; patch = patch || {}; opts = opts || {};
    var at = opts.at || new Date().toISOString();
    var notes = opts.note || {};
    var out = [];
    Object.keys(patch).forEach(function (f) {
      if (f === 'type_specific_data' || !EDIT_LABELS[f]) return;   // 认不出的字段一律不记
      if (sameEditValue(prev[f], patch[f])) return;
      var e = { target: f, label: EDIT_LABELS[f], from: prev[f] === undefined ? null : prev[f],
                to: patch[f], at: at };
      if (notes[f]) e.note = notes[f];
      out.push(e);
    });
    if ('type_specific_data' in patch) out = out.concat(diffTsEdits(prev.type_specific_data, patch.type_specific_data, at));
    return out;
  }

  function editsOf(rec) {
    var m = (rec || {}).manual_edits;
    return Array.isArray(m) ? m.filter(function (e) { return e && e.target; }) : [];
  }
  function hasEdits(rec) { return editsOf(rec).length > 0; }

  // target → 该目标最后一条留痕（渲染时按 target 查，一格一个标记）
  function editedCells(rec) {
    var map = {};
    editsOf(rec).forEach(function (e) { map[e.target] = e; });
    return map;
  }
  function editOf(rec, target) { return editedCells(rec)[target] || null; }

  // 原件上的那个值 = 最早一条留痕的 from
  function originalValue(rec, target) {
    var list = editsOf(rec).filter(function (e) { return e.target === target; });
    return list.length ? list[0].from : null;
  }

  function editSummary(rec) {
    var list = editsOf(rec), targets = [];
    list.forEach(function (e) { if (targets.indexOf(e.target) < 0) targets.push(e.target); });
    var lastAt = null;
    list.forEach(function (e) { if (e.at && (!lastAt || e.at > lastAt)) lastAt = e.at; });
    return { count: list.length, targets: targets, lastAt: lastAt };
  }

  // 结构化写入前的冲突清单。
  // 判据是「档案上已经有值，而模型给了不同的值」—— 不只认 manual_edits：
  // 用户在归档表单里亲手选的类型、导入时带的医院，都是人做的决定却没有留痕，
  // 只认留痕的话这些会被模型静默改掉（本项目真就这么丢过一次类型）。
  // 档案上为空的格子不算冲突：那正是结构化该填的，拦下来只会添乱。
  function structView(model) {
    var src = (model && typeof model === 'object') ? model : {};
    var tsd = (src.type_specific_data && typeof src.type_specific_data === 'object') ? src.type_specific_data : src;
    var view = Object.assign({}, src, { type_specific_data: tsd });
    return { view: view, tsd: tsd };
  }

  function conflictLabel(target, rec, tsRow) {
    var base = editLabel(target) || target;
    var name = (tsRow && (tsRow.name || tsRow.item || tsRow.exam_name)) || '';
    if (name && base.indexOf(name) < 0) base += '（' + name + '）';
    if (!name) {
      var e = editedCells(rec)[target];
      if (e && e.row_name && base.indexOf(e.row_name) < 0) base += '（' + e.row_name + '）';
    }
    return base;
  }

  function pushConflict(out, rec, target, modelVal) {
    var t = parseEditTarget(target);
    if (!t) return;
    if (modelVal === undefined || modelVal === null || modelVal === '') return;
    var human = editValueAt(rec, t);
    if (human === undefined || human === null || human === '') return;   // 空着就让模型填
    if (Array.isArray(human) && !human.length) return;
    if (sameEditValue(modelVal, human)) return;
    var edits = editedCells(rec);
    out.push({
      target: target, label: conflictLabel(target, rec, null),
      human: human, model: modelVal, edited: !!edits[target]
    });
  }

  /* 结构化确认时"真的会写回去"的目标，只有下面这些。
     冲突清单以前把 exams.*、general_exam.*、final_conclusion 等也列出来，
     给了用户一个「用模型的值」的开关，而写回路径根本不处理它们 ——
     选了等于没选，比不列更糟。写回侧（app.js doStructApply）现在共用这两个常量。 */
  var STRUCT_WRITABLE_TABLES = ['lab_results', 'charge_items'];
  var STRUCT_WRITABLE_TS_SCALARS = ['total_amount', 'insurance_payment', 'self_payment'];

  function structConflicts(model, rec) {
    if (!rec || typeof rec !== 'object') return [];
    var v = structView(model);
    var out = [];
    Object.keys(EDIT_LABELS).forEach(function (f) {
      if (f in v.view) pushConflict(out, rec, f, v.view[f]);
    });
    Object.keys(EDIT_TS_SCALARS).forEach(function (k) {
      if (STRUCT_WRITABLE_TS_SCALARS.indexOf(k) < 0) return;
      if (k in v.tsd) pushConflict(out, rec, 'type_specific_data.' + k, v.tsd[k]);
    });
    Object.keys(EDIT_TABLES).forEach(function (tb) {
      if (STRUCT_WRITABLE_TABLES.indexOf(tb) < 0) return;
      var conf = EDIT_TABLES[tb], prevRows = v.tsd[tb], recRows = null;
      var recTsd = rec.type_specific_data;
      if (typeof recTsd === 'string') { try { recTsd = JSON.parse(recTsd); } catch (e) { recTsd = null; } }
      if (!Array.isArray(prevRows)) {
        if (!conf.list && prevRows && typeof prevRows === 'object') {
          Object.keys(conf.cols).forEach(function (c) {
            pushConflict(out, rec, tb + '.' + c, prevRows[c]);
          });
        }
        return;
      }
      recRows = (recTsd && Array.isArray(recTsd[tb])) ? recTsd[tb] : [];
      prevRows.forEach(function (row, i) {
        if (!row || typeof row !== 'object') return;
        Object.keys(conf.cols).forEach(function (c) {
          if (!(c in row)) return;
          var t = parseEditTarget(tb + '.' + i + '.' + c);
          var mv = row[c];
          if (mv === undefined || mv === null || mv === '') return;
          var human = t ? editValueAt(rec, t) : undefined;
          if (human === undefined || human === null || human === '') return;
          if (Array.isArray(human) && !human.length) return;
          if (sameEditValue(mv, human)) return;
          out.push({
            target: tb + '.' + i + '.' + c,
            label: (conf.cols[c] || c) + '（' + (rowLabelOf(row) || rowLabelOf(recRows[i]) || ('第' + (i + 1) + '行')) + '）',
            human: human, model: mv, edited: !!editedCells(rec)[tb + '.' + i + '.' + c]
          });
        });
      });
    });
    return out;
  }

  // 标量冲突 = 从写入补丁里去掉这个键（门面 update 按键合并，不写就是不动）。
  // 明细冲突 = 把人工值填回模型对象：type_specific_data 是整块替换，
  // 删键会让那一格从数组里凭空消失，等于丢数据。
  function keepHumanValues(model, conflicts) {
    var v = structView(model);
    var out = Object.assign({}, v.view);
    delete out.type_specific_data;
    var tsd = cloneTs(v.tsd);
    var touchedTsd = false;
    (conflicts || []).forEach(function (c) {
      var t = parseEditTarget(c.target);
      if (!t) return;
      if (t.kind === 'field') { delete out[t.name]; return; }
      if (t.kind === 'tsScalar') { tsd[t.name] = c.human; }
      else if (t.kind === 'cell') {
        if (Array.isArray(tsd[t.table]) && tsd[t.table][t.index]) tsd[t.table][t.index][t.col] = c.human;
      } else if (t.kind === 'objCell') {
        if (tsd[t.table] && typeof tsd[t.table] === 'object') tsd[t.table][t.col] = c.human;
      }
      touchedTsd = true;
    });
    out.type_specific_data = tsd;
    if (!touchedTsd) out.type_specific_data = v.tsd;
    return out;
  }

  // 编辑的落地形态：把 patch 应用到一个新副本上，并把本次变化追加进留痕
  function applyEditWithHistory(prev, patch, opts) {
    prev = prev || {};
    var edits = diffRecordEdits(prev, patch, opts);
    var out = Object.assign({}, prev);
    Object.keys(patch || {}).forEach(function (k) { out[k] = patch[k]; });
    if (!edits.length) {
      if (!Array.isArray(prev.manual_edits)) delete out.manual_edits;
      return out;
    }
    out.manual_edits = editsOf(prev).concat(edits);
    return out;
  }

  /* ---------------- 9. 导出 ---------------- */

  global.Logic = {
    // escape
    escapeHtml: escapeHtml,
    // date
    parseDateStrict: parseDateStrict, isValidDate: isValidDate, dateSortKey: dateSortKey,
    DATE_STATUS: DATE_STATUS, isDatePending: isDatePending, hasEffectiveDate: hasEffectiveDate,
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
    // 按人的关注指标
    UNASSIGNED: UNASSIGNED, isAllView: isAllView, personMatches: personMatches,
    withFollowers: withFollowers, followedBy: followedBy, setFollowFor: setFollowFor,
    catalogForPerson: catalogForPerson, pruneFollowers: pruneFollowers,
    indicatorComponents: indicatorComponents, GROUP_COMPONENTS: GROUP_COMPONENTS,
    inheritFollowers: inheritFollowers,
    // trend
    buildTrend: buildTrend, buildBPtrend: buildBPtrend, lipidSummary: lipidSummary,
    buildOGTT: buildOGTT, OGTT_ORDER: OGTT_ORDER, ogttTimepoint: ogttTimepoint,
    conditionIsPanelLabel: conditionIsPanelLabel, conditionSeriesKey: conditionSeriesKey,
    conditionEntailedByName: conditionEntailedByName, canonCondText: canonCondText,
    splitCondition: splitCondition, measurePhrase: measurePhrase,
    // fee
    toCents: toCents, fmtMoney: fmtMoney, buildFees: buildFees, receiptAmount: receiptAmount,
    receiptIdentity: receiptIdentity,
    // timeline
    groupTimeline: groupTimeline, buildActivity: buildActivity,
    typeDistribution: typeDistribution, DOC_TYPES: DOC_TYPES, normalizeDocType: normalizeDocType,
    // drug
    expiryState: expiryState, drugStatusGroup: drugStatusGroup, isInUseToday: isInUseToday,
    applyDrugEvent: applyDrugEvent,
    // 手工编辑与留痕
    EDIT_LABELS: EDIT_LABELS, EDIT_TABLES: EDIT_TABLES, EDIT_TS_SCALARS: EDIT_TS_SCALARS,
    sameEditValue: sameEditValue, editLabel: editLabel, parseEditTarget: parseEditTarget,
    editValueAt: editValueAt, tsSetCopy: tsSetCopy,
    diffRecordEdits: diffRecordEdits, applyEditWithHistory: applyEditWithHistory,
    editsOf: editsOf, hasEdits: hasEdits, editedCells: editedCells,
    STRUCT_WRITABLE_TABLES: STRUCT_WRITABLE_TABLES,
    STRUCT_WRITABLE_TS_SCALARS: STRUCT_WRITABLE_TS_SCALARS, editOf: editOf,
    originalValue: originalValue, editSummary: editSummary,
    structConflicts: structConflicts, keepHumanValues: keepHumanValues
  };
})(typeof window !== 'undefined' ? window : this);
