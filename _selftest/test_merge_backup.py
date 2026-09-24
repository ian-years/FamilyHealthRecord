# -*- coding: utf-8 -*-
"""
备份「只合并不覆盖」单测
================================================================
覆盖 import_backup(obj, mode='merge') 的语义：

  1. 只补本地缺失的记录（同 id 已有 → 跳过，不覆盖本地改动）；
  2. 本地独有的记录不被清掉；
  3. 附件同理：同 path 已有 → 跳过，缺失 → 补入；
  4. 成员名单只补本地没有的成员（按 id 判重），不改已有成员；
  5. replace 模式仍是「先清空再写入」（回归，防止加 mode 参数时改坏）。

对应真实痛点：误删单条档案后，只能整库回退；现在可以「只合并」找回那一条，
不碰恢复之后新存/新改的数据。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_merge_backup.py
"""

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import hrw_store as S  # noqa: E402

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


def doc(title, pid, date='2024-06-01'):
    return {'title': title, 'person_id': pid, 'document_type': u'其他',
            'primary_date': date, 'date_status': u'已确认'}


def main():
    src = tempfile.mkdtemp(prefix='hrw-merge-src-')
    dst = tempfile.mkdtemp(prefix='hrw-merge-dst-')
    try:
        # ---- 造一份备份：3 条档案（id 1/2/3）+ 1 个附件 + 3 成员
        s0 = S.Store(HERE, data_dir=src)
        s0.save_persons([
            {'id': 1, 'name': u'我', 'role': 'self'},
            {'id': 2, 'name': u'老婆', 'role': 'spouse'},
            {'id': 3, 'name': u'儿子', 'role': 'son'},
        ])
        s0.upsert('documents', [doc(u'档案A', 1), doc(u'档案B', 2), doc(u'档案C', 3)])
        s0.put_file('file-1.pdf', u'报告一.pdf', 'application/pdf', b'PDF-ONE')
        backup = s0.export_backup()
        check('备份里 3 条档案', backup['counts']['documents'] == 3, backup['counts'])

        # ---- 目标库：删掉档案A（id=1，模拟误删）、改档案B 标题、新存档案D
        d0 = S.Store(HERE, data_dir=dst)
        d0.import_backup(backup)                      # 先把目标建到与备份一致
        d0.delete('documents', [1])                    # 误删档案A
        # 档案B 改标题（本地在恢复之后又改了东西）
        rows = d0.read_all('documents')
        b_row = [r for r in rows if r.get('id') == 2][0]
        b_row['title'] = u'档案B（本地改过）'
        d0.upsert('documents', [b_row])
        d0.upsert('documents', [doc(u'档案D（本地新增）', 1)])   # 本地独有

        print('\n=== 1. 只合并：误删的回来、本地改动保留、本地新增不丢 ===')
        res = d0.import_backup(backup, mode='merge')
        check('merge 成功', res.get('ok') is True, res)
        check('merge 补入 1 条（只档案A）', res.get('written') == 1, res.get('written'))
        check('合并后档案 4 条（3 备份 + 1 本地新增）',
              len(d0.read_all('documents')) == 4, len(d0.read_all('documents')))
        got = {r.get('id'): r.get('title') for r in d0.read_all('documents')}
        # 误删后原 id=1 已被释放，merge 补入时由 AUTOINCREMENT 分配新 id，内容照旧回来。
        check('误删的档案A 回来了（按标题找，id 已换新）',
              u'档案A' in got.values(), got)
        check('本地改过的档案B 保留本地版本（没被备份覆盖）',
              got.get(2) == u'档案B（本地改过）', got.get(2))
        check('本地新增的档案D 还在', u'档案D（本地新增）' in got.values(), got)

        print('\n=== 2. 附件：缺失的补入、已有的跳过 ===')
        # 备份里有 file-1.pdf，目标删掉它（模拟误删附件），再 merge 应补回
        d0.clear_files()
        check('清掉目标附件后 files 为空', d0.file_meta_list() == [], d0.file_meta_list())
        res2 = d0.import_backup(backup, mode='merge')
        check('merge 补回附件 1 个', res2.get('filesWritten') == 1, res2.get('filesWritten'))
        check('附件回来了', len(d0.file_meta_list()) == 1,
              [m.get('path') for m in d0.file_meta_list()])
        # 已有附件再 merge 一次应跳过（filesWritten=0）
        res3 = d0.import_backup(backup, mode='merge')
        check('已有附件不重复写（filesWritten=0）',
              res3.get('filesWritten') == 0, res3.get('filesWritten'))

        print('\n=== 3. 成员名单：只补不覆盖 ===')
        # 目标改一个成员名字、删一个成员，merge 后应保留本地状态，只补缺失成员
        cur = d0.persons()
        cur[0]['name'] = u'我（本地改名）'
        d0.save_persons(cur[:2])                       # 只留 2 个成员，删掉「儿子」
        res4 = d0.import_backup(backup, mode='merge')
        got4 = d0.persons()
        check('merge 补回被删的成员（儿子）', len(got4) == 3, [p['name'] for p in got4])
        check('本地改名保留（没被备份覆盖）', got4[0]['name'] == u'我（本地改名）',
              got4[0]['name'])

        print('\n=== 4. replace 模式仍是先清空再写入（回归） ===')
        d1 = S.Store(HERE, data_dir=tempfile.mkdtemp(prefix='hrw-merge-replace-'))
        try:
            d1.upsert('documents', [doc(u'独有记录', 1)])
            res5 = d1.import_backup(backup)            # 默认 replace
            check('replace 写入 3 条', res5.get('written') == 3, res5.get('written'))
            check('replace 后本地独有记录被清掉',
                  u'独有记录' not in [r.get('title') for r in d1.read_all('documents')],
                  [r.get('title') for r in d1.read_all('documents')])
            check('replace 返回不带 mode 标记', res5.get('mode') is None, res5.get('mode'))
        finally:
            shutil.rmtree(d1.data_dir, ignore_errors=True)

        print('\n=== 5. 非法 mode 报错 ===')
        try:
            d0.import_backup(backup, mode='nuke')
            check('非法 mode 被拒绝', False, '竟然通过了')
        except S.StoreError as e:
            check('非法 mode 被拒绝（%s）' % e, '未知的恢复模式' in str(e))
    finally:
        shutil.rmtree(src, ignore_errors=True)
        shutil.rmtree(dst, ignore_errors=True)

    print('\n=== 汇总 ===')
    print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
