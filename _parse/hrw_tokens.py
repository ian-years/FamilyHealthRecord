# -*- coding: utf-8 -*-
"""身份信息 token 清单的读取入口。

清单本体在 leak_tokens.json —— 那个文件**不进版本库**（.gitignore 里挡着）。

为什么要放外部文件：这些字符串本身就是「交付物里必须杜绝」的身份信息。
以前它们被当成常量写进 _parse 下的入库脚本和 .gitignore，等于一边跑脱敏自检、
一边把身份信息归档进了 git —— 自检越认真，泄漏越彻底。

读不到、或形状不对，一律抛 TokenError 中止。绝不返回空清单继续跑：
「没有清单」会被下游当成「没有泄漏」，自检就成了走过场。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(HERE, 'leak_tokens.json')


class TokenError(Exception):
    """清单缺失或不可用 —— 调用方据此中止，不产出未脱敏的东西。"""


class Tokens(object):
    def __init__(self, paths, redact, leak_check):
        self.paths = paths            # 原件位置等带真名的路径
        self.redact = redact          # 脱敏映射：原文 → 占位
        self.leak_check = leak_check  # 自检关键词：整条记录里都不该再出现

    def path(self, key):
        if key not in self.paths:
            raise TokenError('身份信息清单的 paths 里缺少 %s' % key)
        return self.paths[key]


def load(path=None):
    path = path or DEFAULT_PATH
    if not os.path.exists(path):
        raise TokenError(
            '身份信息清单不存在：%s。脱敏与泄漏自检都依赖它，缺了不能继续 —— '
            '否则会产出一份「看似已通过脱敏」实则没做任何检查的归档包。'
            '请在该位置放一份 leak_tokens.json（含 paths / redact / leak_check 三段），'
            '这个文件不进版本库，也不许复制进任何交付物。' % path)
    try:
        with open(path, encoding='utf-8') as fh:
            obj = json.load(fh)
    except ValueError as e:
        raise TokenError('身份信息清单不是合法 JSON：%s（%s）' % (path, e))
    if not isinstance(obj, dict):
        raise TokenError('身份信息清单整体应是一个对象：%s' % path)
    for key in ('paths', 'redact', 'leak_check'):
        if key not in obj:
            raise TokenError('身份信息清单缺少 %s 这一段：%s' % (key, path))
    if not isinstance(obj['paths'], dict):
        raise TokenError('身份信息清单的 paths 必须是对象：%s' % path)
    if not isinstance(obj['redact'], dict) or not obj['redact']:
        raise TokenError('身份信息清单的 redact 必须是非空对象：%s' % path)
    if not isinstance(obj['leak_check'], list) or not obj['leak_check']:
        raise TokenError('身份信息清单的 leak_check 必须是非空数组（没有它，'
                         '脱敏结果无从验证）：%s' % path)
    return Tokens(obj['paths'], obj['redact'], [str(k) for k in obj['leak_check']])
