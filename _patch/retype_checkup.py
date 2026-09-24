# -*- coding: utf-8 -*-
"""把历史那批体检报告书回改为新类型「体检报告」。

为什么要回改：网页解析归档时，草稿的类型一律先落在「其他医疗资料」
（app.js 里 doParseUpload 的默认值），所以本轮新增「体检报告」之前归档的记录
全都堆在兜底类型里，按新类型筛选一条也搜不到。

判定刻意收窄：只有原文证据（标题 / 原始文件名 / 附件名）指向体检报告，
且当前类型确实是「没分出来」的那两种（空 / 其他医疗资料）才改。
已经明确归到检验报告、检查报告、发票、处方、药品的，即便文件名里出现「体检报告」四个字
也不动 —— 那是人已明确表达过的分类，脚本没有理由覆盖它。

默认只 dry-run 打清单，加 --apply 才写库；写库前自动打快照。
输出里不回显标题等字段内容：本项目里它们带着真实姓名。

用法：
    python _patch/retype_checkup.py             # 看清单
    python _patch/retype_checkup.py --apply     # 真的改
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import hrw_store  # noqa: E402

TARGET = '体检报告'
# 只改"没分出来"的那两种。检查报告 / 检验报告 / 发票 / 药品 都是人在归档时选过的类型，
# 脚本没有资格因为标题里出现「体检报告」就改判 —— 一份「体检报告-胸部CT」被分成
# 检查报告是完全合理的，以前把 检查报告 也列进来，与文件自己写的注释相反。
RETYPE_FROM = ('', '其他医疗资料')
EVIDENCE_KEY = '体检报告'


def _norm(v):
    return ('' if v is None else str(v)).replace(' ', '').replace('\u3000', '')


def evidence_in(row):
    """证据出在哪个字段（只报名，不报内容）。"""
    if EVIDENCE_KEY in _norm((row or {}).get('title')):
        return 'title'
    if EVIDENCE_KEY in _norm((row or {}).get('source_file')):
        return 'source_file'
    atts = (row or {}).get('source_attachments')
    if isinstance(atts, str):
        import json
        try:
            atts = json.loads(atts)
        except ValueError:
            atts = []
    if isinstance(atts, list):
        for a in atts:
            if isinstance(a, dict) and EVIDENCE_KEY in _norm(a.get('name')):
                return 'attachments'
    return None


def classify(row):
    """该改成体检报告就返回新类型，否则返回 None（表示不动）。"""
    if not isinstance(row, dict):
        return None
    cur = _norm(row.get('document_type'))
    if cur == TARGET:
        return None                       # 已经是了，保持幂等
    if cur not in [_norm(x) for x in RETYPE_FROM]:
        return None                       # 人已明确分过类，不覆盖
    return TARGET if evidence_in(row) else None


def plan(rows):
    """[{id, from, to, evidence}]，不改动传进来的数据。"""
    out = []
    for r in (rows or []):
        to = classify(r)
        if to:
            out.append({'id': r.get('id'), 'from': r.get('document_type'),
                        'to': to, 'evidence': evidence_in(r)})
    return out


def apply(store):
    """按 plan 回改写库，返回 (改动条数, 快照名)。

    注意 upsert 是「整行 payload 覆盖」而不是字段合并：提交前必须把读出来的
    完整行复制一份再改 document_type。只提交 {id, document_type} 会把解析原文、
    附件引用、归属成员连同标题一起抹平。
    """
    rows = store.read_all('health_records')
    todo = set(p['id'] for p in plan(rows))
    if not todo:
        return 0, None
    snap = store.snapshot('before-retype-checkup')
    if not snap:
        raise hrw_store.StoreError('回改前的快照没能写入，已中止 —— 没退路的事不做。')
    patch = []
    for r in rows:
        if r.get('id') in todo:
            nr = dict(r)
            nr['document_type'] = TARGET
            patch.append(nr)
    return store.upsert('health_records', patch), snap


def main(argv):
    apply_now = '--apply' in argv
    data_dir = None
    for i, a in enumerate(argv):
        if a == '--data-dir' and i + 1 < len(argv):
            data_dir = argv[i + 1]
    store = hrw_store.Store(ROOT, data_dir=data_dir)
    rows = store.read_all('health_records')
    todo = plan(rows)

    print('数据目录：%s' % store.data_dir)
    print('档案总数 %d，待回改 %d' % (len(rows), len(todo)))
    if not todo:
        print('没有需要回改的记录。')
        return 0
    for p in todo:
        print('  #%s  %s → %s   （证据在 %s）' % (p['id'], p['from'] or '(空)', p['to'], p['evidence']))
    if not apply_now:
        print('\n这是预览，没有改动任何数据。确认无误后加 --apply 执行。')
        return 0

    try:
        n, snap = apply(store)
    except hrw_store.StoreError as e:
        sys.stderr.write('%s\n' % e)
        return 2
    print('\n已打快照：%s' % snap)
    print('已回改 %d 条。' % n)
    left = plan(store.read_all('health_records'))
    print('复查：还可回改 %d 条（应为 0）。' % len(left))
    return 0 if not left else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
