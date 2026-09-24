# -*- coding: utf-8 -*-
"""结构化「手动中转」通道的单测 —— 纯本地，不联网、不需要密钥。

覆盖 pack()（组装提示词 + 脱敏）与 adopt()（解析粘回来的模型输出），
以及 redact() 里几处曾经出过问题的边界。

跑法：
    python _selftest/test_llm_manual.py
退出码 0 表示全部通过。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import hrw_llm as L  # noqa: E402

PASSED = [0]
FAILED = []


def check(name, cond, detail=''):
    if cond:
        PASSED[0] += 1
        print('  PASS  %s' % name)
    else:
        FAILED.append(name)
        print('  FAIL  %s   %s' % (name, detail))


def section(t):
    print('\n=== %s ===' % t)


RAW = (
    '姓名：张三\n'
    '身份证 110101199001011234\n'
    '手机 13812345678\n'
    '样本号：AB1234567890\n'
    '血红蛋白 145 g/L 参考 130-175 ↑\n'
)

# ---------------------------------------------------------------- 脱敏
section('脱敏：redact()')

out, hits = L.redact(RAW)
check('缺「号」字时不再抛异常（历史缺陷）', isinstance(out, str) and bool(out))
check('身份证中间打码、前 4 后 4 保留', '1101**********1234' in out, out)
check('完整身份证号已不可见', '110101199001011234' not in out, out)
check('手机号打码', '138****5678' in out, out)
check('姓名标签替换', '姓名：本人' in out, out)
check('条码被隐去', '样本号：已隐去' in out, out)
check('医学数值与箭头原样保留', '血红蛋白 145 g/L 参考 130-175 ↑' in out, out)
check('命中计数非空', sum(hits.values()) >= 4, str(hits))

# 已被打码的号码不应被二次切割成脏输出
out2, _ = L.redact('身份证号：110101199001011234')
check('已打码文本不再被二次切割', '已隐去****' not in out2, out2)
check('带标签的身份证号仍被处理', '110101199001011234' not in out2, out2)

# 非标准长度的证件号走标签分支
out3, hits3 = L.redact('社保卡号：ABC123456789')
check('非标准证件号按标签隐去', 'ABC123456789' not in out3 and '已隐去' in out3, out3)

check('空文本安全', L.redact('') == ('', {}))
check('None 安全', L.redact(None) == (None, {}))

# ---------------------------------------------------------------- pack
section('组装：pack()')

p = L.pack({}, RAW, '检验报告')
prompt = p['prompt']
check('含完整任务指令', '医疗文档结构化提取器' in prompt)
check('含「只输出 JSON」的收尾要求', '只输出 JSON 对象本身' in prompt)
check('含文档类型提示', '检验报告' in prompt)
check('含脱敏后的原文', '1101**********1234' in prompt)
check('医学内容完整带入', '血红蛋白 145 g/L 参考 130-175 ↑' in prompt)
check('没有把完整身份证号带出去', '110101199001011234' not in prompt)
check('没有把手机号带出去', '13812345678' not in prompt)
check('返回脱敏后的字数', p['chars'] > 0, str(p['chars']))
check('返回组装后的总字数', p['prompt_chars'] > p['chars'], str(p['prompt_chars']))
check('标记为手动通道', p['manual'] is True)
check('脱敏命中计数带回页面', bool(p['redact_hits']), str(p['redact_hits']))

short = L.pack({'max_chars': 20}, 'x' * 200)
check('超长原文按 max_chars 截断', short['truncated'] is True and short['chars'] == 20)

try:
    L.pack({}, '   ')
    check('空原文应被拒绝', False, '竟然通过了')
except L.LlmError:
    check('空原文被拒绝', True)

# ---------------------------------------------------------------- adopt
section('解析：adopt()')

a = L.adopt('{"document_type":"检验报告","primary_date":"2025-12-13",'
            '"amount":"128.50","title":"血常规",'
            '"lab_results":[{"name":"血红蛋白","result":"145"}]}')
check('类型保留在白名单内', a['data']['document_type'] == '检验报告')
check('金额字符串转成数字', a['data']['amount'] == 128.5, str(a['data']['amount']))
check('lab_results 原样保留', len(a['data']['lab_results']) == 1)
check('缺失的 charge_items 兜底成空数组', a['data']['charge_items'] == [])
check('标记为手动通道', a['manual'] is True and a['model'].startswith('手动中转'))

a2 = L.adopt('好的，以下是提取结果：\n```json\n'
             '{"document_type":"随便写的类型","diagnosis":"这是一整条字符串"}'
             '\n```\n希望对你有帮助！')
check('能从带前后缀的聊天式输出里提出 JSON', a2['data'].get('title') is None)
check('越界类型被白名单化', a2['data']['document_type'] == '其他医疗资料')
check('非数组字段被兜底成数组', a2['data']['diagnosis'] == [])

a3 = L.adopt('{"document_type":"医疗发票/收费单","total_amount":"12,345.60",'
             '"self_payment":"￥8.00"}')
check('千分位金额转数字', a3['data']['total_amount'] == 12345.6, str(a3['data']['total_amount']))
check('带货币符号的金额转数字', a3['data']['self_payment'] == 8, str(a3['data']['self_payment']))

a4 = L.adopt('{"document_type":"检验报告","date_candidates":["2025-12-13"]}')
check('date_candidates 是数组时保持原值', a4['data']['date_candidates'] == ['2025-12-13'])

# ---------------------------------------------------------------- 类型白名单
# 后端 DOC_TYPES 与前端 L.DOC_TYPES 是两份手工同步的字面量：费用汇总、类型分布
# 都按这些字符串匹配，任一边写漏就把一类资料统计成 0。这里用测试把「同步」钉住。
import re  # noqa: E402

with open(os.path.join(ROOT, 'app', 'logic.js'), encoding='utf-8') as fh:
    _js = fh.read()
_m = re.search(r'var DOC_TYPES\s*=\s*\[(.*?)\]', _js, re.S)
js_types = re.findall(r"'([^']+)'", _m.group(1)) if _m else None
check('能从 app/logic.js 里读到 DOC_TYPES', bool(js_types), '解析失败，检查那一行的写法')
check('前后端类型清单逐项一致（含顺序）', js_types == L.DOC_TYPES,
      'js=%s py=%s' % (js_types, L.DOC_TYPES))
check('体检报告在类型清单里', '体检报告' in L.DOC_TYPES)
check('兜底类型仍排在最后', L.DOC_TYPES[-1] == '其他医疗资料')

a5 = L.adopt('{"document_type":"体检报告","title":"健康体检报告书"}')
check('体检报告被白名单放行而不是退回其他医疗资料',
      a5['data']['document_type'] == '体检报告', a5['data']['document_type'])

for bad, label in [('   ', '空内容'), ('这里根本没有 JSON', '纯文本'), ('{"broken": ', '括号不闭合')]:
    try:
        L.adopt(bad)
        check('非法输入应被拒绝（%s）' % label, False, '竟然通过了')
    except L.LlmError:
        check('非法输入被拒绝（%s）' % label, True)

# ---------------------------------------------------------------- 分组名与测量条件分开
# condition 一旦被写进「生化-肾功」「肾功三项，华大检验」这类栏目名，展示层就只能靠停用词表
# 去猜（app/logic.js 的 conditionIsPanelLabel）。真正止血的位置是提示词本身：
# 分组名要有 panel 可去，condition 只准放测量状态。
sp = L.SYSTEM_PROMPT
check('结构化提示词里有 panel 字段（报告分组 / 套餐名的去处）', '"panel"' in sp)
check('提示词明确说明分组名不要写进 condition', ('栏目名' in sp or '分组名' in sp) and 'panel' in sp)
check('提示词给出 condition 的合法取值举例', '空腹' in sp and '静息' in sp)
check('提示词要求拿不准时写 null（不许猜）', '不要猜' in sp or '或 null' in sp)

norm = L.normalize({'lab_results': [
    {'name': '血尿酸', 'result': '541.10', 'unit': 'μmol/L',
     'panel': '生化-肾功', 'condition': '空腹'}
]})
row = (norm.get('lab_results') or [{}])[0]
check('normalize 原样保留 panel（丢了界面就永远收不到）', row.get('panel') == '生化-肾功', str(row))
check('normalize 原样保留 condition', row.get('condition') == '空腹', str(row))

# ---------------------------------------------------------------- 汇总
print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASSED[0], len(FAILED)))
if FAILED:
    for f in FAILED:
        print('  - ' + f)
    sys.exit(1)
print('手动中转通道单测全部通过')
