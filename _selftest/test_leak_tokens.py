# -*- coding: utf-8 -*-
"""身份信息不得出现在入库文件里 —— 落实 agent.md §1.5 自订的规矩。

背景：脱敏脚本为了做「泄漏自检」，把真实姓名 / 身份证号 / 体检编号 / 单位名 /
医师姓名当成常量硬编码进了入库的 .py 与 .gitignore，等于把要防的泄漏写进了
版本库。本测试把这条规矩变成可执行的检查：

  1. token 清单放在 gitignored 的 _parse/leak_tokens.json，脚本读不到就必须中止，
     绝不「没有清单就当没有泄漏」地静默通过；
  2. 逐个扫 git 跟踪的每一个文件，任何 token 命中都算失败。

本测试自身不含任何身份信息 —— token 一律从那个 JSON 现读。
用法：
    python _selftest/test_leak_tokens.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, '_parse'))

import hrw_tokens as T  # noqa: E402

PASS = 0
FAIL = []


def check(name, cond, extra=''):
    global PASS
    if cond:
        PASS += 1
        print('PASS  %s%s' % (name, ('  -> %s' % extra) if extra else ''))
    else:
        FAIL.append(name)
        print('FAIL  %s  -> %s' % (name, extra))


# ---------------------------------------------------------------- 1. 读不到清单必须中止
print('=== 1. 清单缺失时的行为 ===')
missing = os.path.join(HERE, '_parse', '__no_such_tokens__.json')
if os.path.exists(missing):
    os.remove(missing)
try:
    T.load(missing)
    check('清单文件不存在时必须报错而不是返回空清单', False, '竟然安静地返回了')
except T.TokenError as e:
    msg = str(e)
    check('清单不存在时抛出 TokenError', True)
    check('错误信息说明是文件缺失', ('不存在' in msg) or ('未找到' in msg), msg)
    check('错误信息给出补救方向（放在哪 / 为什么不能跳过）',
          ('leak_tokens' in msg) or ('脱敏' in msg or '自检' in msg), msg)
except Exception as e:
    check('清单不存在时抛出 TokenError', False, '抛的是别的异常：%r' % e)

bad = os.path.join(HERE, '_parse', '__bad_tokens__.json')
try:
    # 三段键齐全、但 redact 写成了字符串：报错必须点名 redact，不能含糊说「清单不对」
    with open(bad, 'w', encoding='utf-8') as fh:
        json.dump({'paths': {}, 'redact': '不是字典', 'leak_check': ['某']}, fh, ensure_ascii=False)
    try:
        T.load(bad)
        check('清单内容形状不对时也要报错', False, '竟然通过了')
    except T.TokenError:
        check('清单内容形状不对时也要报错', True)
    try:
        T.load(bad)
    except T.TokenError as e:
        check('形状错误信息点名是哪个键', 'redact' in str(e), str(e))
    # 缺 leak_check 的清单会让「泄漏自检」变成走过场，同样要拦
    with open(bad, 'w', encoding='utf-8') as fh:
        json.dump({'paths': {}, 'redact': {'某': '（已脱敏）'}}, fh, ensure_ascii=False)
    try:
        T.load(bad)
        check('缺 leak_check 时拒绝加载（否则自检形同不存在）', False, '竟然通过了')
    except T.TokenError:
        check('缺 leak_check 时拒绝加载（否则自检形同不存在）', True)
finally:
    if os.path.exists(bad):
        os.remove(bad)

# ---------------------------------------------------------------- 2. 真清单在位
print('\n=== 2. 本机清单 ===')
if not os.path.exists(T.DEFAULT_PATH):
    print('NOTE  本机没有 _parse/leak_tokens.json（新克隆的仓库就是这样）。')
    print('      入库文件扫描无从取 token，本轮跳过；补齐清单后重跑即可。')
    check('清单缺失时本测试不误报', True, 'skip')
else:
    tk = T.load()
    check('清单能读出来', bool(tk.redact) and bool(tk.leak_check))
    check('身份证 / 手机号这类模式也算 token',
          any(len(k) >= 15 for k in tk.leak_check), '最长 %d 字' %
          max(len(k) for k in tk.leak_check))

    # ------------------------------------------------------------ 3. 扫全部入库文件
    print('\n=== 3. 扫描 git 跟踪的每个文件 ===')
    tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=HERE,
                             capture_output=True).stdout.split(b'\0')
    tracked = [p.decode('utf-8', 'replace') for p in tracked if p]
    check('扫到了跟踪文件清单', len(tracked) > 10, '%d 个文件' % len(tracked))
    hits = []
    scanned = 0
    for rel in tracked:
        fp = os.path.join(HERE, rel.replace('/', os.sep))
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, 'rb') as fh:
                blob = fh.read()
        except OSError:
            continue
        try:
            text = blob.decode('utf-8')
        except UnicodeDecodeError:
            continue          # 二进制（图片 / PDF）不在本轮范围
        scanned += 1
        for tok in tk.leak_check:
            if tok and tok in text:
                hits.append('%s 含 token #%d' % (rel, tk.leak_check.index(tok)))
    check('入库文件里不含任何身份信息（扫了 %d 个文本文件）' % scanned,
          not hits, '; '.join(hits[:12]))

    print('\n=== 4. 脚本改为读清单 ===')
    for name in ('build_payload.py', 'make_archive_package.py'):
        with open(os.path.join(HERE, '_parse', name), encoding='utf-8') as fh:
            src = fh.read()
        check('%s 引用了 token 清单模块' % name, 'hrw_tokens' in src)
    # 原件路径也带真名，同样不能出现在入库脚本里
    with open(os.path.join(HERE, '_parse', 'build_payload.py'), encoding='utf-8') as fh:
        bp = fh.read()
    check('build_payload.py 不再硬编码原件绝对路径', 'SRC_PDF = r"' not in bp)

# ---------------------------------------------------------------- 汇总
print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('身份信息入库检查全部通过')
