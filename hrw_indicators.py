# -*- coding: utf-8 -*-
"""
指标归一化模块
================================================================
把报告里千奇百怪的检验项名字，收敛成一份稳定的指标目录。

为什么需要它：
    同一项检查在不同医院、不同年份的体检报告里写法完全不同：
        「PR间期」「PR 间期」                 —— 多了一个空格
        「中性粒细胞数」「中性细胞数」「中性粒细胞数（NEUT #）」  —— 同义异名
        「血清y-谷氨酰基转移酶」              —— y 是 γ 的识别错误
        「红细胞计数（RBC）」                 —— 括号里是英文缩写
    不归一化的话，同一指标会分裂成好几条趋势线，用户永远看不到连续变化。

    反过来的陷阱同样要防：「白细胞（便常规）」和「白细胞」是两回事，
    括号里是中文栏目名时绝不能当成缩写去掉，否则便常规的白细胞会混进血常规。

只用 Python 标准库。
"""

import re
import unicodedata

# ---------------------------------------------------------------- 名字标准化

# 全角空格 → 半角
_FULL_SPACE = u'\u3000'


def to_halfwidth(s):
    """全角字符转半角（ASCII 区间），其余原样保留。"""
    out = []
    for ch in s or '':
        code = ord(ch)
        if code == _FULL_SPACE:
            out.append(' ')
        elif 0xFF01 <= code <= 0xFF5E:          # ！＂＃…～
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    return ''.join(out)


# 识别错误修正：OCR / 解析常把希腊字母认成形近的拉丁字母
_OCR_FIXES = [
    (u'y-谷氨酰', u'γ-谷氨酰'),
    (u'Y-谷氨酰', u'γ-谷氨酰'),
    (u'γ-谷氨酰基转移酶', u'γ-谷氨酰基转移酶'),
]


def fix_ocr(s):
    """修正常见的识别错误。只处理有把握的形近替换。"""
    out = s or ''
    for bad, good in _OCR_FIXES:
        if bad in out:
            out = out.replace(bad, good)
    return out


def standardize(name):
    """把指标名收敛成用于匹配的键：全角转半角、去掉所有空白、修正识别错误。"""
    s = to_halfwidth(name or '')
    s = fix_ocr(s)
    # 去掉所有空白字符（含全角空格已转成的半角空格）
    s = re.sub(r'\s+', '', s)
    s = s.strip()
    return s


# 只有括号里是「英文缩写/数字/符号」时才认为它是可剥离的缩写后缀。
# 中文括号（如「（便常规）」「（镜检）」「（妇科）」）是栏目限定，剥离就会张冠李戴。
_ABBR_PAREN = re.compile(r'\(([A-Za-z0-9#\-\.\s%/+]+)\)')


def standardize_unit(unit):
    """单位归一化。

    同一个单位在不同报告里会写成「U/L」「(U/L)」「u/l」「 mmol / L 」。
    不统一的话，趋势图会把它当成两种单位拆成两条线，一条只剩一个点，
    看着就像「趋势画不出来」。
    """
    if not unit:
        return ''
    s = to_halfwidth(str(unit)).strip()
    s = re.sub(r'\s+', '', s)
    # 去掉整对包裹的括号：「(U/L)」→「U/L」
    for _ in range(2):
        if len(s) >= 2 and ((s[0] == '(' and s[-1] == ')') or (s[0] == u'（' and s[-1] == u'）')):
            s = s[1:-1]
    return s


def unit_group_key(unit):
    """分组用单位键：大小写不敏感。

    同一指标在不同报告里写成「cm」「Cm」，若按原文分组会被拆成两条线，
    每条都不足 2 点，趋势就画不出来。显示仍用 standardize_unit 的原文写法。
    """
    return standardize_unit(unit).lower()


# 定性结果 → 序数值（画趋势用）。阴性 0，弱阳性/± 0.5，阳性 1，几个加号按个数。
_QUAL_TABLE = {
    '阴性': 0.0, '(-)': 0.0, '-': 0.0, '--': 0.0,
    '—': 0.0, '－': 0.0, '一': 0.0, 'negative': 0.0, 'neg': 0.0,
    '弱阳性': 0.5, '±': 0.5, '+-': 0.5, '-+': 0.5,
    '可疑': 0.5, '可疑阳性': 0.5, 'weak': 0.5, 'trace': 0.5,
    '阳性': 1.0, '(+)': 1.0, '+': 1.0, '＋': 1.0,
    'positive': 1.0, 'pos': 1.0,
    '1+': 1.0, '+1': 1.0, '＋1': 1.0,
    '2+': 2.0, '+2': 2.0, '＋2': 2.0, '++': 2.0,
    '3+': 3.0, '+3': 3.0, '＋3': 3.0, '+++': 3.0,
    '4+': 4.0, '+4': 4.0, '＋4': 4.0, '++++': 4.0,
}

# 序数值 → 展示文字（纵轴刻度用）。同一序数可能有多种原文写法，取规范写法。
_ORDINAL_LABELS = {0.0: '阴性', 0.5: '弱阳性', 1.0: '阳性',
                   2.0: '2+', 3.0: '3+', 4.0: '4+'}


def qualitative_ordinal(value):
    """把「阴性 / 阳性 / ± / 1+~4+」这类定性结果映射成可连线的序数值。

    不在词表内返回 None —— 自由文本（「外痔」「未见明显异常」）不硬画，
    否则趋势图会被无意义的平线占满。
    """
    if value is None:
        return None
    s = to_halfwidth(str(value)).strip()
    s = re.sub(r'\s+', '', s)
    return _QUAL_TABLE.get(s)


def ordinal_label(v):
    """序数值的规范展示文字。"""
    if v is None:
        return None
    return _ORDINAL_LABELS.get(float(v))


def strip_abbrev(std_name):
    """去掉形如「（RBC）」的英文缩写括号，返回主干名。中文括号不动。"""
    if not std_name:
        return std_name
    out = _ABBR_PAREN.sub('', std_name)
    # 括号剥离后若剩空壳，宁可返回原名
    return out if out else std_name


# ---------------------------------------------------------------- 数值解析

def parse_numeric(value):
    """把检验结果转成可画图的数值。

    体检报告里的结果不都是数字：「<0.1」「阴性」「未见异常」「173.0 」「1:80」。
    凡是不能确定成单个数值的，一律返回 None —— 画不出直线的点宁可不画，
    也不要拿一个编出来的数骗人。
    """
    if value is None:
        return None
    s = to_halfwidth(str(value)).strip()
    if not s:
        return None
    # 纯数字（含小数、正负号）
    m = re.match(r'^[+-]?\d+(?:\.\d+)?$', s)
    if m:
        try:
            return float(s)
        except ValueError:
            return None
    # 科学计数法
    m = re.match(r'^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$', s)
    if m:
        try:
            return float(s)
        except ValueError:
            return None
    return None


def is_text_value(value):
    """结果是不是一段描述性文字（而非可度量的数值）。"""
    if value is None:
        return True
    s = to_halfwidth(str(value)).strip()
    if not s:
        return True
    if parse_numeric(s) is not None:
        return False
    # 「<0.1」这类带比较符的仍算有数值含义，不算纯文本
    if re.match(r'^[<>≤≥]=?\s*\d', s):
        return False
    return True


# ---------------------------------------------------------------- 异常方向判定
#
# 需求：异常的指标要和正常的在界面上有明显区分（箭头 / 深浅 / 底纹，不引入新颜色）。
# 判据按「两者结合」的口径：
#   1) 原文箭头优先 —— 报告自己印的 ↑/↓ 是医生给的最可靠信号，直接采信；
#   2) 没有箭头时，再拿数值和参考范围比对（解析「3.9~6.1」「≤5.2」「<3.36」这类文本）。
#
# 这条只做「方向」判定（偏高 / 偏低 / 未知），不擅自下「异常=有病」的结论；
# 它和 hrw_llm.py 里「不要自己判断异常」的约定并不冲突 —— 那边约束的是
# LLM 从文本里「脑补」箭头，这里只是把已存在的数据（flag / reference）翻成
# 界面上的视觉提示，不写回库、不改变任何原始字段。

def parse_reference_range(reference):
    """把参考范围文本解析成 (low, high) 数值边界。

    支持的写法：
        '3.9~6.1' / '3.9-6.1' / '130～175'      → (3.9, 6.1)
        '≤5.2' / '<=5.2' / '<5.2'               → (None, 5.2)
        '≥1.0' / '>1.0'                         → (1.0, None)
        '0-4' / '130-175 g/L'（尾部带单位）       → (0, 4)
        '1:80' / '阴性' / 空 / 纯文本             → None
    解析不了就返回 None，调用方视为「无法判定」，绝不硬猜。
    """
    if reference is None:
        return None
    s = to_halfwidth(str(reference)).strip()
    if not s:
        return None
    # 形如 '<5.2' / '≤5.2' / '>1.0' / '≥1.0'（可带 =）
    m = re.match(r'^([<>])\s*=?\s*([+-]?\d+(?:\.\d+)?)', s)
    if m:
        v = float(m.group(2))
        if m.group(1) == '<':
            return (None, v)
        return (v, None)
    m = re.match(r'^([≤≥])\s*=?\s*([+-]?\d+(?:\.\d+)?)', s)
    if m:
        v = float(m.group(2))
        if m.group(1) == '≤':
            return (None, v)
        return (v, None)
    # 区间写法：两个数用 ~ ～ - — 连接，尾部可能挂着单位/文字。
    # 分隔符允许连续横线（真实库里有「40--75」「0.25--1」这种双横线写法，
    # 若只认单个 -，第二个 - 会被当成负号，解析成 40~-75 再翻转，全盘皆错）。
    m = re.match(r'^\s*([+-]?\d+(?:\.\d+)?)\s*[~～\-—]+\s*'
                 r'([+-]?\d+(?:\.\d+)?)', s)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        if a > b:
            a, b = b, a
        return (a, b)
    return None


def abnormal_direction(flag, numeric_value, reference):
    """判定一次观测的异常方向：'high' / 'low' / None（正常或无法判定）。

    flag       —— 报告原文的提示符号（如 '↑' / '↓'），优先采信；
    numeric_value —— 数值（parse_numeric 之后），用于和参考范围比对；
    reference  —— 参考范围文本。
    """
    # 1) 原文箭头优先
    if flag:
        f = to_halfwidth(str(flag))
        if '↑' in f or f.strip() in ('H', 'HIGH', 'high', '偏高'):
            return 'high'
        if '↓' in f or f.strip() in ('L', 'LOW', 'low', '偏低'):
            return 'low'
    # 2) 无箭头时按参考范围比对
    if numeric_value is None:
        return None
    rng = parse_reference_range(reference)
    if rng is None:
        return None
    low, high = rng
    if low is not None and numeric_value < low:
        return 'low'
    if high is not None and numeric_value > high:
        return 'high'
    return None


# ---------------------------------------------------------------- 同义词典
# key -> (规范名, 分类, 首选单位, [别名...])
# 别名写的是「人写出来的一切可能形态」，标准化后参与匹配。
# 说明：这份词典覆盖的是体检报告里最常见、且最容易被写歪的项目。

SYNONYMS = {
    # ---- 一般检查 / 体征
    'height':        (u'身高', u'体征', 'cm', [u'身高']),
    'weight':        (u'体重', u'体征', 'kg', [u'体重']),
    'bmi':           (u'BMI', u'体征', '', [u'BMI', u'体重指数', u'体重指数BMI', u'体重指数（18.5-23.9）']),
    'systolic_bp':   (u'收缩压', u'体征', 'mmHg', [u'收缩压']),
    'diastolic_bp':  (u'舒张压', u'体征', 'mmHg', [u'舒张压']),
    'heart_rate':    (u'心率', u'体征', '次/分',
                      [u'心率', u'心率（心电图）', u'心率（静态心电图）', u'脉搏', u'脉搏（次／分）']),

    # ---- 血常规
    'wbc':             (u'白细胞', u'血常规', '10^9/L', [u'白细胞', u'白细胞计数', u'白细胞计数WBC', u'白细胞计数（WBC）']),
    'neutrophil_pct':  (u'中性粒细胞百分比', u'血常规', '%',
                        [u'中性粒细胞百分比', u'中性粒细胞比率', u'中性细胞比率', u'中性粒细胞（NEUT%）', u'中性粒细胞（NEUT %）']),
    'neutrophil_cnt':  (u'中性粒细胞数', u'血常规', '10^9/L',
                        [u'中性粒细胞数', u'中性细胞数', u'中性粒细胞数（NEUT#）', u'中性粒细胞数（NEUT #）']),
    'lymphocyte_pct':  (u'淋巴细胞百分比', u'血常规', '%',
                        [u'淋巴细胞百分比', u'淋巴细胞比率', u'淋巴细胞（LYM%）', u'淋巴细胞（LYM %）']),
    'lymphocyte_cnt':  (u'淋巴细胞数', u'血常规', '10^9/L',
                        [u'淋巴细胞数', u'淋巴细胞数（LYM#）', u'淋巴细胞数（LYM #）']),
    'monocyte_pct':    (u'单核细胞百分比', u'血常规', '%',
                        [u'单核细胞百分比', u'单核细胞比率', u'单核细胞（MO%）', u'单核细胞（MO %）']),
    'monocyte_cnt':    (u'单核细胞数', u'血常规', '10^9/L',
                        [u'单核细胞数', u'单核细胞', u'单核细胞数（MO#）', u'单核细胞数（MO #）']),
    'eosinophil_pct':  (u'嗜酸性粒细胞百分比', u'血常规', '%',
                        [u'嗜酸性粒细胞百分比', u'嗜酸性粒细胞比率', u'嗜酸性粒细胞（EO%）', u'嗜酸性粒细胞（EO %）']),
    'eosinophil_cnt':  (u'嗜酸性粒细胞数', u'血常规', '10^9/L',
                        [u'嗜酸性粒细胞数', u'嗜酸性粒细胞', u'嗜酸性粒细胞数（EO#）', u'嗜酸性粒细胞数（EO #）']),
    'basophil_pct':    (u'嗜碱性粒细胞百分比', u'血常规', '%',
                        [u'嗜碱性粒细胞百分比', u'嗜碱性粒细胞比率', u'嗜碱性粒细胞（BA%）', u'嗜碱性粒细胞（BA %）']),
    'basophil_cnt':    (u'嗜碱性粒细胞数', u'血常规', '10^9/L',
                        [u'嗜碱性粒细胞数', u'嗜碱性粒细胞', u'嗜碱性粒细胞数（BA#）', u'嗜碱性粒细胞数（BA #）']),
    'rbc':             (u'红细胞', u'血常规', '10^12/L',
                        [u'红细胞', u'红细胞计数', u'红细胞计数（RBC）', u'红细胞计数RBC']),
    'hgb':             (u'血红蛋白', u'血常规', 'g/L', [u'血红蛋白', u'血红蛋白（HGB）', u'血红蛋白HGB']),
    'hct':             (u'红细胞压积', u'血常规', '%', [u'红细胞压积', u'红细胞压积（HCT）', u'红细胞压积HCT']),
    'mcv':             (u'平均红细胞体积', u'血常规', 'fL',
                        [u'平均红细胞体积', u'红细胞平均体积', u'平均红细胞体积（MCV）', u'平均红细胞体积MCV']),
    'mch':             (u'平均红细胞血红蛋白量', u'血常规', 'pg',
                        [u'平均血红蛋白量', u'平均血红蛋白含量', u'平均血红蛋白含量（MCH）', u'平均血红蛋白含量MCH', u'MCH']),
    'mchc':            (u'平均红细胞血红蛋白浓度', u'血常规', 'g/L',
                        [u'平均血红蛋白浓度', u'平均血红蛋白浓度（MCHC）', u'平均血红蛋白浓度MCHC', u'MCHC']),
    # RDW 有两种不同测量：RDW-SD 用 fL（红细胞体积分布的标准差），
    # RDW-CV 用 %（变异系数）。合在一起画趋势会把 40+ 的 fL 值和 12 左右的
    # % 值搅成一团，必须按单位拆开。词典里只放明确带后缀的写法，
    # 不带后缀的「红细胞分布宽度」由 resolve() 按单位现场分流。
    'rdw_sd':          (u'红细胞分布宽度-SD', u'血常规', 'fL',
                        [u'红细胞分布宽度-SD', u'红细胞分布宽度（RDW-SD）', u'RDW-SD', u'红细胞分布宽度标准差']),
    'rdw_cv':          (u'红细胞分布宽度-CV', u'血常规', '%',
                        [u'红细胞分布宽度-CV', u'红细胞分布宽度（RDW-CV）', u'RDW-CV', u'红细胞分布宽度变异系数']),
    'plt':             (u'血小板', u'血常规', '10^9/L', [u'血小板', u'血小板（PLT）', u'血小板PLT']),
    'pdw':             (u'血小板分布宽度', u'血常规', '%', [u'血小板分布宽度', u'血小板分布宽度（PDW）', u'血小板分布宽度PDW']),
    'mpv':             (u'平均血小板体积', u'血常规', 'fL',
                        [u'血小板平均体积', u'平均血小板体积', u'平均血小板体积（MPV）', u'平均血小板体积MPV']),
    'pct':             (u'血小板压积', u'血常规', '%', [u'血小板压积', u'血小板压积（PCT）', u'血小板压积PCT']),
    'p_lcr':           (u'大血小板比率', u'血常规', '%', [u'大血小板比率', u'大血小板比率（P-LCR）']),

    # ---- 尿常规
    'u_ubg':        (u'尿胆原', u'尿常规', '', [u'尿胆原', u'尿胆原（UBG）', u'尿胆原UBG']),
    'u_bil':        (u'尿胆红素', u'尿常规', '', [u'尿胆红素', u'尿胆红素（BIL）', u'尿胆红素BIL']),
    'u_ket':        (u'尿酮体', u'尿常规', '', [u'尿酮体', u'尿酮体（KET）', u'尿酮体KET']),
    'u_ery':        (u'尿隐血', u'尿常规', '',
                     [u'隐血', u'尿隐血', u'尿潜血', u'尿隐血（BLD）', u'尿潜血（BLD）', u'尿隐血（RBC）']),
    'u_pro':        (u'尿蛋白', u'尿常规', '',
                     [u'尿蛋白', u'尿蛋白质', u'尿蛋白（Pro）', u'尿蛋白（PRO）', u'尿蛋白质（PRO）']),
    'u_nit':        (u'尿亚硝酸盐', u'尿常规', '', [u'亚硝酸盐', u'尿亚硝酸盐', u'尿亚硝酸盐（NIT）']),
    'u_glu':        (u'尿糖', u'尿常规', '', [u'尿糖', u'尿葡萄糖', u'尿糖（GLU）', u'尿葡萄糖（GLU）']),
    'u_sg':         (u'尿比重', u'尿常规', '', [u'尿比重', u'尿比重（SG）', u'尿比重SG']),
    'u_ph':         (u'尿酸碱度', u'尿常规', '',
                     [u'酸碱度', u'尿酸碱度', u'尿PH值', u'尿PH值（PH）', u'尿酸碱度（PH）']),
    'u_vc':         (u'尿维生素C', u'尿常规', '', [u'维生素C']),
    'u_leu':        (u'尿白细胞', u'尿常规', '',
                     [u'尿白细胞', u'尿白细胞酯酶', u'尿白细胞（LEU）', u'尿白细胞酯酶（LEU）']),
    'u_micro_wbc':  (u'镜检白细胞', u'尿常规', '', [u'镜检白细胞', u'尿白细胞（镜检）', u'尿沉渣白细胞计数']),
    'u_micro_rbc':  (u'镜检红细胞', u'尿常规', '', [u'镜检红细胞', u'尿红细胞（镜检）', u'尿沉渣红细胞计数']),
    'u_cast':       (u'镜检管型', u'尿常规', '', [u'镜检管型', u'尿管型（镜检）', u'病理性管型检查', u'管型计数']),
    'u_crystal':    (u'镜检结晶', u'尿常规', '', [u'镜检结晶', u'尿结晶（镜检）', u'尿沉渣结晶检查']),
    'u_epi':        (u'尿上皮细胞计数', u'尿常规', '', [u'尿上皮细胞计数']),
    'u_yeast':      (u'类酵母菌', u'尿常规', '', [u'类酵母菌']),
    'u_conductivity': (u'尿电导率', u'尿常规', '', [u'电导率']),
    'u_osm':        (u'尿渗透压', u'尿常规', '', [u'渗透压']),
    'u_mucus':      (u'粘液丝', u'尿常规', '', [u'粘液丝']),
    'u_rbc_info':   (u'红细胞形态信息', u'尿常规', '', [u'红细胞形态信息']),

    # ---- 肝功能
    'tbil':  (u'总胆红素', u'肝功能', u'μmol/L', [u'血清总胆红素', u'总胆红素', u'总胆红素（TBIL）']),
    'dbil':  (u'直接胆红素', u'肝功能', u'μmol/L', [u'血清直接胆红素', u'直接胆红素', u'直接胆红素（DBIL）']),
    'ibil':  (u'间接胆红素', u'肝功能', u'μmol/L', [u'血清间接胆红素', u'间接胆红素', u'间接胆红素（IBIL）']),
    'alt':   (u'谷丙转氨酶', u'肝功能', 'U/L',
              [u'血清丙氨酸氨基转移酶', u'谷丙转氨酶', u'谷丙转氨酶（ALT）', u'血清丙氨酸氨基转移酶测定（ALT）']),
    'ast':   (u'谷草转氨酶', u'肝功能', 'U/L', [u'血清天冬氨酸氨基转移酶', u'谷草转氨酶', u'谷草转氨酶（AST）']),
    'ast_alt': (u'谷草/谷丙', u'肝功能', '', [u'谷草／谷丙', u'谷草/谷丙']),
    'alp':   (u'碱性磷酸酶', u'肝功能', 'U/L', [u'血清碱性磷酸酶', u'碱性磷酸酶', u'碱性磷酸酶（ALP）']),
    'ggt':   (u'γ-谷氨酰基转移酶', u'肝功能', 'U/L',
              [u'血清γ-谷氨酰基转移酶', u'血清y-谷氨酰基转移酶', u'谷氨酰转肽酶', u'谷氨酰转肽酶（γ-GT）',
               u'γ-谷氨酰基转移酶', u'γ-谷氨酰转肽酶', u'谷氨酰基转移酶', u'GGT', u'γ-GT']),
    'tp':    (u'总蛋白', u'肝功能', 'g/L', [u'血清总蛋白', u'总蛋白', u'总蛋白（TP）']),
    'alb':   (u'白蛋白', u'肝功能', 'g/L', [u'血清白蛋白', u'白蛋白', u'白蛋白（ALB）']),
    'glob':  (u'球蛋白', u'肝功能', 'g/L', [u'血清球蛋白', u'球蛋白', u'球蛋白（GLB）']),
    'ag':    (u'白球比', u'肝功能', '', [u'白蛋白／球蛋白', u'白／球比值', u'白／球比值（A/G）']),
    'ldh':   (u'乳酸脱氢酶', u'肝功能', 'U/L', [u'乳酸脱氢酶', u'乳酸脱氢酶（LDH）']),

    # ---- 肾功能
    'cr':  (u'肌酐', u'肾功能', u'μmol/L', [u'血清肌酐', u'肌酐', u'肌酐（Cr）']),
    'bun': (u'尿素氮', u'肾功能', 'mmol/L', [u'血清尿素', u'尿素氮', u'尿素氮（BUN）', u'血清尿素测定（Urea）']),
    'ua':  (u'尿酸', u'肾功能', u'μmol/L', [u'血清尿酸', u'尿酸', u'尿酸（UA）']),

    # ---- 血脂
    'tc':  (u'总胆固醇', u'血脂', 'mmol/L', [u'总胆固醇', u'胆固醇', u'胆固醇（TCH）']),
    'tg':  (u'甘油三酯', u'血脂', 'mmol/L', [u'甘油三酯', u'甘油三酯（TG）']),
    'hdl': (u'高密度脂蛋白胆固醇', u'血脂', 'mmol/L',
            [u'高密度脂蛋白胆固醇', u'高密度脂蛋白', u'高密度脂蛋白胆固醇（HDL-C）']),
    'ldl': (u'低密度脂蛋白胆固醇', u'血脂', 'mmol/L',
            [u'低密度脂蛋白胆固醇', u'低密度脂蛋白', u'低密度脂蛋白胆固醇（LDL-C）']),
    'ai':  (u'动脉硬化指数', u'血脂', '', [u'动脉硬化指数', u'动脉硬化指数（AI）', u'动脉硬化指数（AI ）']),

    # ---- 血糖
    'fbg': (u'空腹血糖', u'血糖', 'mmol/L', [u'空腹血糖', u'葡萄糖', u'葡萄糖（GLU）', u'空腹葡萄糖']),

    # ---- 心肌酶
    'ck':   (u'肌酸激酶', u'心肌酶', 'U/L', [u'血清磷酸肌酸激酶', u'肌酸激酶', u'肌酸激酶（CK）']),
    'ckmb': (u'肌酸激酶同工酶', u'心肌酶', 'U/L',
             [u'肌酸激酶同工酶', u'肌酸激酶同工酶（CK-MB）', u'肌酸激酶同工酶（CK -MB ）']),

    # ---- 肿瘤标志物
    'afp':   (u'甲胎蛋白', u'肿瘤标志物', 'ng/mL',
              [u'甲胎蛋白', u'甲胎蛋白（AFP）', u'甲胎蛋白定量（AFP）', u'甲胎蛋白（AFP）（发光法-定量）',
               u'甲胎蛋白（AFP )（发光法-定量）']),
    'cea':   (u'癌胚抗原', u'肿瘤标志物', 'ng/mL',
              [u'癌胚抗原', u'癌胚抗原（CEA）', u'癌胚抗原定量（CEA）', u'癌胚抗原（CEA）（发光法-定量）',
               u'癌胚抗原（CEA )（发光法-定量）']),
    'ca125': (u'糖类抗原125', u'肿瘤标志物', 'U/mL', [u'糖类抗原125', u'糖类抗原125测定（CA125）']),
    'ca153': (u'糖类抗原15-3', u'肿瘤标志物', 'U/mL', [u'糖类抗原15-3', u'糖类抗原15-3测定（CA15-3）']),
    'ca199': (u'糖类抗原19-9', u'肿瘤标志物', 'U/mL',
              [u'糖类抗原19-9', u'糖类抗原199', u'糖类抗原19-9测定（CA19-9）', u'糖类抗原199(CA199）']),
    'ca50':  (u'糖类抗原50', u'肿瘤标志物', 'U/mL', [u'糖类抗原50', u'糖类抗原50测定（CA50）']),
    'ca724': (u'糖类抗原72-4', u'肿瘤标志物', 'U/mL',
              [u'糖类抗原72-4', u'糖类抗原724', u'糖类抗原72-4测定（CA72-4）', u'糖类抗原724(CA724）']),
    'nse':   (u'神经元特异性烯醇化酶', u'肿瘤标志物', 'ng/mL', [u'神经元特异性烯醇化酶']),
    'psa':   (u'总前列腺特异性抗原', u'肿瘤标志物', 'ng/mL',
              [u'前列腺特异性抗原', u'总前列腺特异性抗原', u'总前列腺特异性抗原（TPSA）', u'T-PSA', u'tPSA', u'TPSA']),
    'fpsa':  (u'游离前列腺特异性抗原', u'肿瘤标志物', 'ng/mL', [u'游离前列腺特异性抗原', u'f-PSA', u'fPSA', u'FPSA']),
    'fpsa_tpsa': (u'游离/总PSA比值', u'肿瘤标志物', '', [u'f-PSA/T-PSA', u'fPSA/TPSA', u'游离/总前列腺特异性抗原比值']),
    # 幽门螺杆菌抗体是感染指标（Hp 与胃癌相关但本身不是肿瘤标志物），单列一类
    'hp':    (u'幽门螺杆菌抗体', u'感染免疫', '',
              [u'幽门螺杆菌抗体', u'幽门螺杆菌抗体（定性）', u'幽门螺杆菌抗体（定量）', u'胃幽门螺杆菌（血清法）',
               u'幽门螺旋杆菌抗体', u'HP抗体']),

    # ---- 心电图
    'ecg_pr':       (u'PR间期', u'心电图', 'ms', [u'PR间期', u'PR 间期']),
    'ecg_qrs':      (u'QRS时限', u'心电图', 'ms', [u'QRS时限', u'QRS 时限']),
    'ecg_qt':       (u'QT间期', u'心电图', 'ms', [u'QT间期', u'QT 间期']),
    'ecg_qtc':      (u'QTc间期', u'心电图', 'ms', [u'QTC间期', u'QTC 间期', u'QTc 间期', u'QT/QTc间期']),
    'ecg_p_axis':   (u'P电轴', u'心电图', u'°', [u'P电轴', u'P 电轴']),
    'ecg_qrs_axis': (u'QRS电轴', u'心电图', u'°', [u'QRS电轴', u'QRS 电轴']),
    'ecg_t_axis':   (u'T电轴', u'心电图', u'°', [u'T电轴', u'T 电轴']),
    'ecg_rv5':      (u'RV5', u'心电图', 'mV', [u'RV5']),
    'ecg_sv1':      (u'SV1', u'心电图', 'mV', [u'SV1']),

    # ---- 视力
    'vision_r_raw':   (u'裸眼视力(右)', u'视力', '', [u'裸眼视力右', u'右裸眼视力', u'裸眼视力（右）']),
    'vision_l_raw':   (u'裸眼视力(左)', u'视力', '', [u'裸眼视力左', u'左裸眼视力', u'裸眼视力（左）']),
    'vision_r_corr':  (u'矫正视力(右)', u'视力', '', [u'戴镜视力右', u'矫正视力右', u'矫正视力（右）']),
    'vision_l_corr':  (u'矫正视力(左)', u'视力', '', [u'戴镜视力左', u'矫正视力左', u'矫正视力（左）']),
    'vision_r_near':  (u'近视力(右)', u'视力', '', [u'近视力（右）/30CM']),
    'vision_l_near':  (u'近视力(左)', u'视力', '', [u'近视力（左）/30CM']),
    'color_vision':   (u'辨色能力', u'视力', '', [u'辨色能力', u'色觉']),

    # ---- 妇科
    'gyn_trichomonas': (u'滴虫', u'妇科', '', [u'滴虫']),
    'gyn_fungus':      (u'霉菌', u'妇科', '', [u'霉菌']),
    'gyn_cleanliness': (u'清洁度', u'妇科', '', [u'清洁度']),
    'gyn_leucorrhea':  (u'白带量', u'妇科', '', [u'白带量']),
    'gyn_menstrual':   (u'月经量', u'妇科', '', [u'月经量']),
    'gyn_tct':         (u'TCT', u'妇科', '', [u'TCT', u'TCT（液基超薄细胞检测）', u'宫颈刮片']),

    # ---- 便常规
    'stool_wbc': (u'白细胞(便常规)', u'便常规', '', [u'白细胞（便常规）']),
    'stool_rbc': (u'红细胞(便常规)', u'便常规', '', [u'红细胞（便常规）']),
    'stool_ob':  (u'免疫法粪便隐血反应', u'便常规', '', [u'免疫法粪便隐血反应']),
    'stool_ova': (u'虫卵', u'便常规', '', [u'虫卵']),
}


# ---------------------------------------------------------------- 性别限定
# 体检项目天然分男女：前列腺/PSA 只进男性清单，白带常规/宫颈/TCT 只进女性清单。
# 用「子串匹配」而不是写死指标 key：auto_N 这种自动发现的 key 每次迁移都可能变，
# 而名字里的性别词（宫颈、前列腺…）是稳定的，对新报告里新出现的同名项目也能命中。
# 匹配顺序：先女后男；都不命中 = 男女通用（绝大多数化验项都属于这类）。
SEX_NAME_HINTS = {
    'female': [
        u'外阴', u'阴道', u'宫颈', u'宫体', u'子宫', u'附件', u'妇科', u'月经',
        u'经期', u'白带', u'滴虫', u'霉菌', u'清洁度', u'内膜', u'乳房', u'卵巢',
        u'妊娠', u'早孕', u'女外科', u'TCT', u'糖类抗原125', u'糖类抗原15-3',
    ],
    'male': [
        u'前列腺', u'外生殖器', u'睾丸', u'精液', u'男外科', u'PSA比值',
    ],
}


def sex_of_name(name):
    """按规范名判断指标的适用性别，返回 'male' / 'female' / None（通用）。"""
    s = str(name or '')
    for sex, hints in SEX_NAME_HINTS.items():
        for h in hints:
            if h in s:
                return sex
    return None


# ---------------------------------------------------------------- 文本类判定
# 这些是医生写的描述/小结，不是可度量的指标。
# 归到「文本」类后，默认不出现在「可关注指标」列表里，但在档案详情里照样能看到。

TEXT_NAME_PATTERNS = [
    u'小结', u'提示', u'结论', u'所见', u'描述', u'主诉', u'史', u'嗜好', u'体质',
    u'其它', u'其他', u'信息', u'部位', u'名称', u'能力',
]

# 体格检查里「医生看了看/摸了摸」的项目：值是「未见异常」这类描述
PHYSICAL_EXAM_NAMES = {
    u'皮肤', u'皮肤颜色', u'疤痕部位', u'脊柱', u'四肢关节', u'四肢与关节', u'营养', u'面容',
    u'浅表淋巴结', u'淋巴结', u'肛门指诊', u'心律', u'心音', u'心脏杂音', u'肺罗音', u'呼吸音',
    u'腹壁', u'肝大小', u'肝脏质地', u'肝脏压痛', u'肾脏', u'脾脏压痛', u'腹部', u'肺部',
    u'肝脏', u'脾脏', u'甲状腺', u'甲状腺（外科）', u'乳房', u'乳房（外科触诊）', u'外生殖器',
    u'前列腺（外科）', u'咽部', u'鼻部', u'外耳及耳道', u'中耳及内耳', u'口咽', u'耳', u'鼻',
    u'牙周', u'牙体', u'眼睑', u'眼球', u'结膜', u'角膜', u'晶体', u'外眼', u'外眼检查',
    u'裂隙灯', u'裂隙灯检查', u'眼底', u'眼底检查', u'外阴', u'阴道', u'宫颈', u'宫体', u'附件',
    u'心血管系统', u'呼吸系统', u'消化系统', u'泌尿系统', u'代谢性疾病', u'内科其他',
    u'肝（彩超）', u'胆（彩超）', u'胰（彩超）', u'脾（彩超）', u'左肾（彩超）', u'右肾（彩超）',
}


def guess_is_text(std_name, values_seen):
    """判断一个指标是不是「文本/描述类」。

    两个信号任一成立即判为文本：
      1. 名字里有小结/提示/结论这类词，或属于体格检查描述项
      2. 出现过的所有结果值都不是数值
    """
    for p in TEXT_NAME_PATTERNS:
        if p in std_name:
            return True
    if std_name in PHYSICAL_EXAM_NAMES:
        return True
    if values_seen and all(is_text_value(v) for v in values_seen):
        return True
    return False


# ---------------------------------------------------------------- 分类推断
# 词典没覆盖时，靠栏目名和关键词猜一个分类，便于用户在列表里筛选。

CATEGORY_HINTS = [
    (u'尿', u'尿常规'), (u'便', u'便常规'), (u'血常规', u'血常规'), (u'血液常规', u'血常规'),
    (u'肝', u'肝功能'), (u'肾', u'肾功能'), (u'脂', u'血脂'), (u'糖', u'血糖'),
    (u'心电', u'心电图'), (u'彩超', u'超声'), (u'超声', u'超声'), (u'放射', u'影像'),
    (u'DR', u'影像'), (u'X光', u'影像'), (u'视力', u'视力'), (u'眼', u'视力'),
    (u'妇科', u'妇科'), (u'肿瘤', u'肿瘤标志物'), (u'一般检查', u'体征'),
]


def guess_category(std_name, panel):
    src = u'%s %s' % (std_name, panel or '')
    for kw, cat in CATEGORY_HINTS:
        if kw in src:
            return cat
    return u'其他'


# ---------------------------------------------------------------- 归一化器

class Normalizer(object):
    """把原始指标名映射成规范指标。

    用法：
        n = Normalizer()
        n.learn([('身高', '173.0', 'cm', '一般检查'), ...])   # 先把全部样本喂进去
        ind_id = n.resolve('身高')                            # 再逐个查归属
    """

    def __init__(self):
        # 标准化别名 → 词典 key
        self._alias_to_key = {}
        for key, (name, cat, unit, aliases) in SYNONYMS.items():
            forms = set([name] + list(aliases))
            for a in forms:
                std = standardize(a)
                if std:
                    self._alias_to_key[std] = key
                base = strip_abbrev(std)
                if base and base != std:
                    self._alias_to_key.setdefault(base, key)
        # 自动发现的新指标
        self._auto = {}        # 标准化名 -> 自动指标信息 dict
        self._auto_seq = 0
        self._samples = {}     # 自动指标名 -> 见过的 (值, 单位, 栏目) 样本

    def resolve(self, raw_name, value=None, unit=None, panel=None):
        """返回一个指标定义 dict（不落库，落库由调用方负责）。"""
        std = standardize(raw_name)
        if not std:
            return None

        # 0) RDW 裸名按单位分流：RDW-SD 的单位是 fL，RDW-CV 的单位是 %。
        #    报告里两种都常见，不看清单位就归并，会把 40+ 的 fL 值和
        #    12 左右的 % 值搅成一条线。
        if re.match(u'^红细胞分布宽度(\\((rdw)\\))?$', std, re.IGNORECASE):
            u = standardize_unit(unit)
            key = 'rdw_sd' if u.lower() == 'fl' else 'rdw_cv'
            name, cat, def_unit, _a = SYNONYMS[key]
            return {'key': key, 'name': name, 'category': cat,
                    'unit': u or def_unit, 'is_text': 0,
                    'raw': raw_name, 'std': std, 'source': 'preset'}

        # 1) 完整名命中词典
        key = self._alias_to_key.get(std)
        if not key:
            # 2) 剥掉英文缩写括号后再试（中文括号不会走到这里）
            base = strip_abbrev(std)
            if base != std:
                key = self._alias_to_key.get(base)
        if not key:
            # 3) 词典外的，作为新指标自动发现
            return self._auto_define(std, raw_name, value, unit, panel)

        name, cat, def_unit, _aliases = SYNONYMS[key]
        return {'key': key, 'name': name, 'category': cat,
                'unit': unit or def_unit or '', 'is_text': 0,
                'raw': raw_name, 'std': std, 'source': 'preset'}

    def _auto_define(self, std, raw_name, value, unit, panel):
        info = self._auto.get(std)
        if info is None:
            self._auto_seq += 1
            info = {'key': 'auto_%d' % self._auto_seq, 'name': std,
                    'category': guess_category(std, panel),
                    'unit': unit or '', 'is_text': 0,
                    'std': std, 'source': 'auto', 'raws': set()}
            self._auto[std] = info
            self._samples[std] = []
        info['raws'].add(raw_name)
        self._samples[std].append((value, unit, panel))
        if not info.get('unit') and unit:
            info['unit'] = unit
        return dict(info, raw=raw_name)

    def finalize(self):
        """样本喂完后统一判定文本类：只看名字容易漏，再看一遍值。"""
        for std, info in self._auto.items():
            vals = [v for (v, _u, _p) in self._samples.get(std, [])]
            if guess_is_text(std, vals):
                info['is_text'] = 1
                if info['category'] in (u'其他', u'超声', u'影像'):
                    info['category'] = u'文本描述'
        return list(self._auto.values())

    def auto_definitions(self):
        """拿到全部自动发现的指标定义（供落库）。"""
        return list(self._auto.values())

    def preset_definitions(self):
        """词典里已定义且确实出现过别名的，不必全部落库 —— 由调用方按需落库。"""
        out = []
        for key, (name, cat, unit, aliases) in SYNONYMS.items():
            out.append({'key': key, 'name': name, 'category': cat,
                        'unit': unit or '', 'is_text': 0, 'source': 'preset',
                        'aliases': list(aliases)})
        return out
