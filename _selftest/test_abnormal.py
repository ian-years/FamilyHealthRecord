# -*- coding: utf-8 -*-
"""异常方向判定纯函数单测（hrw_indicators.abnormal_direction / parse_reference_range）

覆盖「原文箭头优先 + 无箭头时按参考范围比对」这条口径：
  - 原文印了 ↑/↓（或 H/L、偏高/偏低）→ 直接采信，不看参考范围；
  - 没有箭头 → 解析参考范围文本（区间/单边 ≤、<、>、≥）与数值比对；
  - 解析不了（1:80、阴性、空、纯文本）→ 返回 None（无法判定，绝不硬猜）。

跑法：
    python _selftest/test_abnormal.py
退出码 0 表示全部通过。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import hrw_indicators as I  # noqa: E402

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


a = I.abnormal_direction
p = I.parse_reference_range


# ---------------------------------------------------------------- 范围解析
section('parse_reference_range 范围解析')

check('区间 ~', p('3.9~6.1') == (3.9, 6.1), str(p('3.9~6.1')))
check('区间 -', p('130-175') == (130.0, 175.0), str(p('130-175')))
check('全角 ～', p('130～175') == (130.0, 175.0), str(p('130～175')))
check('区间倒序自动翻转', p('6.1-3.9') == (3.9, 6.1), str(p('6.1-3.9')))
check('双横线区间（真实库写法 40--75）', p('40--75') == (40.0, 75.0), str(p('40--75')))
check('双横线小数（0.25--1）', p('0.25--1') == (0.25, 1.0), str(p('0.25--1')))
check('双横线（3--10）', p('3--10') == (3.0, 10.0), str(p('3--10')))
check('带单位区间', p('130-175 g/L') == (130.0, 175.0), str(p('130-175 g/L')))
check('≤ 单边上限', p('≤5.2') == (None, 5.2), str(p('≤5.2')))
check('< 单边上限', p('<3.36') == (None, 3.36), str(p('<3.36')))
check('>= 单边下限', p('>=1.0') == (1.0, None), str(p('>=1.0')))
check('> 单边下限', p('>1.0') == (1.0, None), str(p('>1.0')))
check('≥ 全角单边下限', p('≥1.0') == (1.0, None), str(p('≥1.0')))
check('比号 1:80 不解析', p('1:80') is None, str(p('1:80')))
check('阴性不解析', p('阴性') is None, str(p('阴性')))
check('空串不解析', p('') is None)
check('None 不解析', p(None) is None)
check('纯文本不解析', p('未见明显异常') is None)


# ---------------------------------------------------------------- 异常方向
section('abnormal_direction 异常方向判定')

check('原文 ↑ 偏高', a('↑', 5.0, '3.9~6.1') == 'high')
check('原文 ↓ 偏低', a('↓', 5.0, '3.9~6.1') == 'low')
check('原文 ↑ 优先于参考范围（值其实在范围内也采信箭头）',
      a('↑', 5.0, '3.9~6.1') == 'high')
check('原文 H 偏高', a('H', 5.0, '') == 'high')
check('原文 L 偏低', a('L', 5.0, '') == 'low')
check('原文「偏高」', a('偏高', 5.0, '') == 'high')
check('原文「偏低」', a('偏低', 5.0, '') == 'low')

check('无箭头·超上限', a('', 7.0, '3.9~6.1') == 'high')
check('无箭头·低于下限', a(None, 3.0, '3.9~6.1') == 'low')
check('无箭头·范围内', a(None, 5.0, '3.9~6.1') is None)
check('无箭头·等于下限', a(None, 3.9, '3.9~6.1') is None)
check('无箭头·等于上限', a(None, 6.1, '3.9~6.1') is None)

check('≤ 上限·越界', a(None, 5.5, '≤5.2') == 'high')
check('≤ 上限·压线', a(None, 5.2, '≤5.2') is None)
check('> 下限·越界', a(None, 0.5, '>1.0') == 'low')
check('> 下限·达标', a(None, 1.0, '>1.0') is None)

check('无参考范围·有数值', a(None, 7.0, '1:80') is None)
check('无参考范围·无数值', a(None, None, '1:80') is None)
check('无箭头无范围', a('', 7.0, None) is None)
check('定性值无 numeric 不误判', a('', None, '3.9~6.1') is None)


# ---------------------------------------------------------------- 汇总
print('\n==============================')
print('通过 %d 项，失败 %d 项' % (PASSED[0], len(FAILED)))
if FAILED:
    print('失败项：%s' % ', '.join(FAILED))
    sys.exit(1)
print('全部通过')
