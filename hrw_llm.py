# -*- coding: utf-8 -*-
"""
个人健康档案工作台 · 大模型结构化（可选）
================================================================
解析只能把图片/PDF 变成**原文**，不认识「哪个是检验项、哪个是金额」。
本模块把原文交给一个大模型，拆成四张表要的字段。

三条边界：
  1. 只依据原文提取。原文没有的一律留 null，不允许推测、补全、编造。
  2. 调用前先在本机做身份信息脱敏（姓名/证件号/手机号），再出网。
  3. 结果只作为「建议」，必须由人在页面上确认后才写入档案。

对接 OpenAI 兼容协议，因此阿里云百炼、DeepSeek、智谱、本地 Ollama
等都能用，只需填 base_url / api_key / model。
配置存在 data/llm.json，密钥不写进代码、不进版本库。
"""

import json
import os
import re
import urllib.error
import urllib.request

TIMEOUT_SEC = 180

PRESETS = [
    {'id': 'dashscope', 'label': '阿里云百炼（通义千问）',
     'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
     'model': 'qwen-plus'},
    {'id': 'deepseek', 'label': 'DeepSeek',
     'base_url': 'https://api.deepseek.com/v1',
     'model': 'deepseek-chat'},
    {'id': 'zhipu', 'label': '智谱 GLM',
     'base_url': 'https://open.bigmodel.cn/api/paas/v4',
     'model': 'glm-4-plus'},
    {'id': 'ollama', 'label': '本机 Ollama（完全离线）',
     'base_url': 'http://127.0.0.1:11434/v1',
     'model': 'qwen2.5:14b'},
    {'id': 'custom', 'label': '自定义（任意 OpenAI 兼容服务）',
     'base_url': '', 'model': ''},
]

# 必须与 app/logic.js 里的 L.DOC_TYPES 完全一致：
# 费用汇总、类型分布等功能按这些字面值匹配，写错就统计不到。
DOC_TYPES = ['挂号单/就诊单', '检验报告', '检查报告', '体检报告', '处方/用药单',
             '医疗发票/收费单', '其他医疗资料']

SYSTEM_PROMPT = """你是一个医疗文档结构化提取器。任务是把给定的文档原文拆成字段。

【最重要的规则】
1. 只提取原文中**明确出现**的信息。原文没有的，一律填 null。
2. 严禁推测、补全、联想、编造。不要因为「一般报告都有」就填一个值。
3. 不要判断异常/正常。即使原文印了箭头（↑↓）可以原样记为 flag，也不得自己计算得出。
4. 不要输出诊断意见、治疗建议、用药建议——除非原文明确写着，那也只能原样摘录到 diagnosis 字段。
5. 数值保留原文的精度与形态（如 "6.42" 不要写成 6.4；"<5.2" 原样保留）。
6. 单位、参考范围照抄原文文本，不做换算。
7. 不确定的字段宁可为 null，也不要猜。

【日期规则】
- primary_date 取文档中**最主要**的那个业务日期（检验报告取检验/报告日期，收费单取收费日期）。
- 必须能在原文中找到依据，格式化为 YYYY-MM-DD；原文只有部分信息且无法确定整日时填 null。
- 若原文出现多个日期，在 date_candidates 里列出全部（原样 + 归一化）。

【输出】
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。结构：

{
  "document_type": "从这些类型里选一个：%s",
  "primary_date": "YYYY-MM-DD 或 null",
  "primary_date_reason": "该日期取自原文的哪一处，一句话",
  "title": "文档标题，取原文标题或主要事由，或 null",
  "amount": 数字（元）或 null。仅当这是收费/费用类文档且原文有明确总额时填,
  "key_information": "一到三句话的要点摘录，只陈述原文事实，或 null",
  "hospital": "机构名称或 null",
  "department": "科室或 null",
  "doctor": "医生姓名或 null",
  "lab_results": [
    {"name": "检验/检查项目名", "result": "结果值(原文形态)", "unit": "单位或 null",
     "reference": "参考范围或 null", "flag": "原文标注的提示符号或 null",
     "panel": "该项所属的检验分组 / 套餐 / 栏目名，照原文抄（如 生化-肾功、血脂四项），或 null",
     "condition": "测量状态，只能是 空腹 / 餐前 / 餐后几小时 / 服糖后几分钟 / 静息 / 坐位 / 卧位 / 晨起 / 随机 这一类，没有就 null"}
  ],
  "charge_items": [
    {"name": "收费项目", "unit_price": 数字或null, "qty": 数字或null,
     "amount": 数字或null, "insurance_class": "医保类别或 null"}
  ],
  "total_amount": 数字（元）或 null，收费类文档的总额，找不到为 null,
  "insurance_payment": 数字（元）或 null，原文写明的医保支付额,
  "self_payment": 数字（元）或 null，原文写明的个人支付额,
  "diagnosis": ["原文明确写出的诊断，逐条原样摘录"],
  "date_candidates": ["原文中出现的其他日期，YYYY-MM-DD"],
  "extraction_notes": "提取过程中发现的歧义、缺失、疑似识别错误，一到三句；无则 null"
}

lab_results 与 charge_items 没有内容时填空数组 []，不要用 null。
panel 与 condition 是两件事，不要混：报告里的分组标题、套餐名、机构栏目名（生化-肾功、
血脂四项、检验项目：xxx、某某检验）一律写进 panel；condition 只放真正的测量状态
（空腹、餐后几小时、服糖后、静息、坐位、卧位、晨起、随机），原文没写测量状态就填 null，不要猜。
把栏目名写进 condition 会让同一项被拆成好几条互不相连的趋势线。
收费/发票类文档的 document_type 请填「医疗发票/收费单」。""" % '、'.join(DOC_TYPES)


class LlmError(Exception):
    """可预期的调用失败，调用方据此向用户如实说明。"""


# ---------------------------------------------------------------- 配置

def config_path(data_dir):
    return os.path.join(data_dir, 'llm.json')


def load_config(data_dir):
    p = config_path(data_dir)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding='utf-8') as fh:
            obj = json.load(fh)
        return obj if isinstance(obj, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(data_dir, obj):
    p = config_path(data_dir)
    safe = {
        'base_url': str((obj or {}).get('base_url') or '').strip(),
        'api_key': str((obj or {}).get('api_key') or '').strip(),
        'model': str((obj or {}).get('model') or '').strip(),
        'preset': str((obj or {}).get('preset') or '').strip(),
        'max_chars': int((obj or {}).get('max_chars') or 60000),
    }
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(safe, fh, ensure_ascii=False, indent=2)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return safe


def public_config(cfg):
    """给页面用的配置视图：不回传密钥本身，只回传「是否已配置」。"""
    cfg = cfg or {}
    key = cfg.get('api_key') or ''
    return {
        'configured': bool(cfg.get('base_url') and cfg.get('model') and key),
        'has_key': bool(key),
        'key_hint': (key[:4] + '****' + key[-4:]) if len(key) >= 12 else ('****' if key else ''),
        'base_url': cfg.get('base_url') or '',
        'model': cfg.get('model') or '',
        'preset': cfg.get('preset') or '',
        'max_chars': int(cfg.get('max_chars') or 60000),
        'presets': PRESETS,
    }


# ---------------------------------------------------------------- 脱敏

_RE_ID = re.compile(r'\b(\d{4})\d{10}(\d{3}[\dXx])\b')
# 手机号是 11 位：号段 3 位 + 中间 4 位 + 后 4 位，打码成 138****5678。
# 曾经写成 (1[3-9])\d{4}(\d{4})（合计只有 10 位），11 位手机号一个都匹配不上，
# 等于手机号从未被脱敏过。
_RE_PHONE = re.compile(r'\b(1[3-9]\d)\d{4}(\d{4})\b')
_RE_NAME_LABEL = re.compile(
    r'(姓\s*名|患者|病人|受检者|体检人|就诊人)\s*[:：]?\s*([\u4e00-\u9fff]{2,4})')
# 号码组后面不能再跟字母数字或掩码星号：否则会把已经被 _RE_ID 打过码的
# 「1101**********1234」再切一刀，留下「身份证：已隐去**********1234」这种脏输出。
_RE_ID_LABEL = re.compile(
    r'(身份证|证件|社保卡|医保卡)\s*(号)?\s*[:：]?\s*([0-9A-Za-z]{6,20})(?![0-9A-Za-z*])')
_RE_BARCODE = re.compile(r'(条码|样本号|条码号)\s*[:：]?\s*([0-9A-Za-z\-]{8,24})')


def redact(text):
    """出网前的基础脱敏。返回 (脱敏后文本, 替换计数)。

    只做字段级打码：能明确识别为身份标识的内容。医学内容（指标、日期、
    金额、机构）一律保留，否则结构化就没意义了。
    """
    if not text:
        return text, {}
    hits = {}

    def bump(k):
        hits[k] = hits.get(k, 0) + 1

    out = text

    def sub_id(m):
        bump('证件号')
        return m.group(1) + '**********' + m.group(2)

    out = _RE_ID.sub(sub_id, out)

    def sub_phone(m):
        bump('手机号')
        return m.group(1) + '****' + m.group(2)

    out = _RE_PHONE.sub(sub_phone, out)

    def sub_name(m):
        bump('姓名')
        return m.group(1) + '：本人'

    out = _RE_NAME_LABEL.sub(sub_name, out)

    def sub_idlabel(m):
        # group(2) 是可选的「号」字，没写时是 None —— 不能直接参与字符串拼接。
        bump('证件字段')
        return m.group(1) + (m.group(2) or '') + '：已隐去'

    out = _RE_ID_LABEL.sub(sub_idlabel, out)

    def sub_code(m):
        bump('条码')
        return m.group(1) + '：已隐去'

    out = _RE_BARCODE.sub(sub_code, out)
    return out, hits


# ---------------------------------------------------------------- 调用

def _post(url, payload, api_key, timeout=TIMEOUT_SEC):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    req.add_header('Authorization', 'Bearer ' + api_key)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'replace')[:400]
        except Exception:
            pass
        raise LlmError('模型服务返回 HTTP %s：%s' % (e.code, detail or e.reason))
    except urllib.error.URLError as e:
        raise LlmError('连不上模型服务（%s）：%s'
                       % (url, getattr(e, 'reason', e)))
    except Exception as e:
        raise LlmError('调用模型服务失败：%s' % e)


def _extract_json(text):
    if not text:
        return None
    s = text.strip()
    if s.startswith('```'):
        s = re.sub(r'^```[a-zA-Z]*\s*', '', s)
        s = re.sub(r'\s*```$', '', s)
    i, j = s.find('{'), s.rfind('}')
    if i < 0 or j <= i:
        return None
    try:
        return json.loads(s[i:j + 1])
    except ValueError:
        return None


def _coerce_num(v):
    if v is None or v == '':
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace(',', '').replace('￥', '').replace('元', '').strip()
    try:
        return float(s) if '.' in s else int(s)
    except ValueError:
        return None


def _extract_json_deep(text):
    """在文本里找第一个括号配对的 JSON 对象。

    比 _extract_json 的「首尾大括号」更稳：用户从聊天窗口复制时常常会带上
    「好的，以下是结果：」这类前后缀，那种情况整体解析必然失败。
    字符串内部的花括号按转义规则跳过，不会被误当成结构。
    """
    s = text or ''
    depth = 0
    start = -1
    in_str = False
    esc_next = False
    for i, ch in enumerate(s):
        if in_str:
            if esc_next:
                esc_next = False
            elif ch == '\\':
                esc_next = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        obj = json.loads(s[start:i + 1])
                    except ValueError:
                        obj = None
                    if isinstance(obj, dict):
                        return obj
                    start = -1
    return None


def normalize(data):
    """把模型给出的字段规整成页面能直接用的形状。

    模型偶尔会漏字段、换个名字、或者把数字写成字符串，这里统一兜底。
    字段名是 lab_results / charge_items —— 必须与 app/logic.js 的
    renderTypeSpecific 一致，写错界面就统计不到。
    """
    if not isinstance(data, dict):
        data = {}
    dt = str(data.get('document_type') or '').strip()
    data['document_type'] = dt if dt in DOC_TYPES else '其他医疗资料'
    for num_key in ('amount', 'total_amount', 'insurance_payment', 'self_payment'):
        data[num_key] = _coerce_num(data.get(num_key))
    for list_key in ('lab_results', 'charge_items', 'diagnosis', 'date_candidates'):
        if not isinstance(data.get(list_key), list):
            data[list_key] = []
    return data


def structure(cfg, markdown, doc_hint=None, do_redact=True):
    """把原文结构化。返回 {ok, data, model, redacted, redact_hits, elapsed, ...}"""
    import time
    cfg = cfg or {}
    base = (cfg.get('base_url') or '').rstrip('/')
    key = cfg.get('api_key') or ''
    model = cfg.get('model') or ''
    if not base or not key or not model:
        raise LlmError('还没有配置模型服务（需要在 data/llm.json 或页面里填 base_url / api_key / model）')
    if not markdown or not str(markdown).strip():
        raise LlmError('没有可结构化的原文')

    text = str(markdown)
    max_chars = int(cfg.get('max_chars') or 60000)
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True

    hits = {}
    if do_redact:
        text, hits = redact(text)

    user_msg = text
    if doc_hint:
        user_msg = '文档类型提示（可能不准，以原文为准）：%s\n\n原文：\n%s' % (doc_hint, text)

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': user_msg},
        ],
        'temperature': 0,
        'response_format': {'type': 'json_object'},
    }

    t0 = time.time()
    status, raw = _post(base + '/chat/completions', payload, key)
    if status != 200:
        raise LlmError('模型服务返回状态 %s' % status)
    try:
        outer = json.loads(raw)
    except ValueError:
        raise LlmError('模型服务返回的不是 JSON：%s' % raw[:200])

    if outer.get('error'):
        raise LlmError('模型服务报错：%s' % str(outer['error'])[:300])

    choices = outer.get('choices') or []
    if not choices:
        raise LlmError('模型服务没有返回任何结果')
    content = ((choices[0].get('message') or {}).get('content')) or ''
    data = _extract_json(content)
    if data is None:
        raise LlmError('模型输出无法解析为 JSON：%s' % content[:300])

    # 兜底规整：类型落白名单、金额转数字、列表字段保证是数组
    data = normalize(data)

    return {
        'ok': True,
        'data': data,
        'model': model,
        'elapsed': round(time.time() - t0, 1),
        'chars': len(text),
        'truncated': truncated,
        'redacted': bool(do_redact and hits),
        'redact_hits': hits,
        'usage': outer.get('usage') or {},
    }


def probe(cfg):
    """最小代价探活：发一条极短的请求，确认密钥与模型名可用。"""
    cfg = dict(cfg or {})
    base = (cfg.get('base_url') or '').rstrip('/')
    key = cfg.get('api_key') or ''
    model = cfg.get('model') or ''
    if not base or not key or not model:
        return {'ok': False, 'reason': '配置不完整：需要 base_url、api_key、model 三项'}
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': 'ping'}],
        'max_tokens': 4,
    }
    try:
        status, raw = _post(base + '/chat/completions', payload, key, timeout=45)
    except LlmError as e:
        return {'ok': False, 'reason': str(e)}
    if status != 200:
        return {'ok': False, 'reason': 'HTTP %s' % status}
    try:
        outer = json.loads(raw)
    except ValueError:
        return {'ok': False, 'reason': '返回内容不是 JSON'}
    if outer.get('error'):
        return {'ok': False, 'reason': str(outer['error'])[:300]}
    return {'ok': True, 'model': outer.get('model') or model}


# ------------------------------------------------- 手动中转（不调用任何接口）

PACK_HEAD = ('请严格按照下面的任务指令处理文档，只输出一个 JSON 对象，'
             '不要任何解释文字、不要 markdown 代码块。')


def pack(cfg, markdown, doc_hint=None, do_redact=True):
    """组装一段可直接粘贴给任意大模型的完整请求文本。

    这条通道不调用任何接口、不需要密钥：用户自己把文本贴到大模型里，
    再把返回的 JSON 贴回页面。脱敏仍在文本离开本机之前完成。

    返回 {ok, prompt, chars, prompt_chars, truncated, redacted, redact_hits}
    """
    cfg = cfg or {}
    text = str(markdown or '')
    if not text.strip():
        raise LlmError('没有可结构化的原文')

    max_chars = int(cfg.get('max_chars') or 60000)
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True

    hits = {}
    if do_redact:
        text, hits = redact(text)

    parts = [PACK_HEAD, '', '===== 任务指令 =====', SYSTEM_PROMPT, '',
             '===== 待处理文档 =====']
    if doc_hint:
        parts.append('文档类型提示（可能不准，以原文为准）：%s' % doc_hint)
    parts.append('原文：')
    parts.append(text)
    parts.append('')
    parts.append('===== 结束 =====')
    parts.append('现在只输出 JSON 对象本身。')

    prompt = '\n'.join(parts)
    return {
        'ok': True,
        'prompt': prompt,
        'chars': len(text),
        'prompt_chars': len(prompt),
        'truncated': truncated,
        'redacted': bool(do_redact and hits),
        'redact_hits': hits,
        'manual': True,
    }


def adopt(raw):
    """解析用户粘贴回来的模型输出。

    与 structure() 的区别：完全不联网、不需要任何配置，只做解析与兜底规整。
    结果是「建议」，仍然要人在页面上确认才写入。
    """
    s = str(raw or '')
    if not s.strip():
        raise LlmError('还没有粘贴任何内容')
    data = _extract_json(s) or _extract_json_deep(s)
    if data is None:
        raise LlmError('粘贴的内容里找不到 JSON 对象。请让模型只输出 JSON，'
                       '或把它的完整返回值原样贴进来')
    data = normalize(data)
    return {
        'ok': True,
        'data': data,
        'model': '手动中转（外部模型）',
        'chars': len(s),
        'truncated': False,
        'redacted': False,
        'redact_hits': {},
        'manual': True,
    }
