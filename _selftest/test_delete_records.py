# -*- coding: utf-8 -*-
"""档案删除的数据层单测
================================================================
覆盖 Store.delete_records()：删行、独占附件物理删除、被别处引用的附件保留、
files 登记与磁盘保持一致、删除前快照、以及「从快照回退能把删掉的文件找回来」。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_delete_records.py
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


def expect_error(name, fn, keyword=None):
    try:
        fn()
    except S.StoreError as e:
        if keyword and keyword not in str(e):
            check(name, False, '错误信息不含「%s」：%s' % (keyword, e))
        else:
            check(name, True, str(e))
        return
    except Exception as e:  # noqa: BLE001
        check(name, False, '抛的是别的异常：%r' % e)
        return
    check(name, False, '竟然没报错')


# ---------------------------------------------------------------- 夹具
#
#   r1 ─ a.pdf      a 只有 r1 引用  → 删 r1 时该被物理删掉
#   r2 ─ b.pdf      b 由 r2 / r3 / 药品 d1 共用 → 删谁都要留着
#   r3 ─ b.pdf, c.pdf
#   d1（药品）─ c.pdf   c 由 r3 和药品共用 → 删 r3 后要留着
#   r4 ─ d.pdf      d 登记在 files 表里，磁盘文件却不存在（脏数据）

TMP = tempfile.mkdtemp(prefix='hrw-del-')
store = S.Store(HERE, data_dir=TMP)


def add(table, atts, extra=None):
    row = {'id': None, 'title': table, 'source_attachments': atts}
    row['person_id'] = 1
    if table == 'documents':
        row['document_type'] = '体检报告'
    if extra:
        row.update(extra)
    store.upsert(table, [row])
    rows = store.read_all(table)
    return rows[-1]['id']


def att(path, name=None):
    """把附件真正写进磁盘 + 登记，返回记录里要放的那一项。"""
    blob = ('内容 of ' + path).encode('utf-8')
    info = store.put_file(path, name or os.path.basename(path), 'application/pdf', blob)
    return {'name': os.path.basename(path), 'path': path,
            'mime_type': 'application/pdf', 'size': len(blob), 'disk_name': info['disk_name']}


def on_disk(path):
    """该附件路径在 data/files/ 下是否还留着文件。"""
    c = store._conn()
    try:
        r = c.execute('SELECT disk_name FROM files WHERE path=?', (path,)).fetchone()
    finally:
        c.close()
    if not r:
        return False
    return os.path.exists(os.path.join(store.files_dir, r['disk_name']))


def registered(path):
    c = store._conn()
    try:
        return c.execute('SELECT 1 FROM files WHERE path=?', (path,)).fetchone() is not None
    finally:
        c.close()


A, B, C = 'attachments/a.pdf', 'attachments/b.pdf', 'attachments/c.pdf'
D = 'attachments/d.pdf'

r1 = add('documents', [att(A)])
r2 = add('documents', [att(B)])
r3 = add('documents', [att(B), att(C)])
_d = att(D)
os.remove(os.path.join(store.files_dir, _d['disk_name']))  # 抹掉文件，留下登记
r4 = add('documents', [_d])
d1 = add('drugs', [att(C)], extra={'status': '正在服用', 'drug_name': '虚构药'})

print('=== 夹具就位 ===')
check('四条档案 + 一枚药品', store.counts()['documents'] == 4
      and store.counts()['drugs'] == 1, str(store.counts()))
check('四个附件都已落盘', all(on_disk(p) for p in (A, B, C)),
      '%s %s %s' % (on_disk(A), on_disk(B), on_disk(C)))

# ---------------------------------------------------------------- 1. 删掉独占附件的档案
print('\n=== 1. 删除只被自己引用的附件 ===')
res = store.delete_records('documents', [r1])
check('返回里报出删了几行', res['deleted'] == 1, str(res.get('deleted')))
check('该行真的不在了', r1 not in [x['id'] for x in store.read_all('documents')])
check('别的档案没被牵连', len(store.read_all('documents')) == 3)
check('独占附件的磁盘文件被删掉', not on_disk(A))
check('独占附件的 files 登记也被清掉', not registered(A))
check('返回里报出清理了哪个附件', res['files_removed'] == [A], str(res.get('files_removed')))

# ---------------------------------------------------------------- 2. 共享附件必须留着
print('\n=== 2. 被别处引用的附件不能删 ===')
store.delete_records('documents', [r2])
check('r2 删掉了', r2 not in [x['id'] for x in store.read_all('documents')])
check('b.pdf 仍被 r3 引用，文件留着', on_disk(B))
check('b.pdf 的 files 登记留着', registered(B))

# ---------------------------------------------------------------- 3. 跨表引用
print('\n=== 3. 药品也在用的附件不能删 ===')
store.delete_records('documents', [r3])
check('r3 删掉了', r3 not in [x['id'] for x in store.read_all('documents')])
check('c.pdf 仍被药品 d1 引用，文件留着', on_disk(C))
# 现在把药品也删掉，c.pdf 才应该走
store.delete_records('drugs', [d1])
check('药品删掉后 c.pdf 才真正被清理', not on_disk(C) and not registered(C))

# ---------------------------------------------------------------- 4. 脏登记不致命
print('\n=== 4. 附件登记与磁盘不一致时 ===')
check('夹具里 d.pdf 有登记但没有文件', registered(D) and not on_disk(D))
res4 = store.delete_records('documents', [r4])
check('脏附件不影响删除档案本身', res4['deleted'] == 1)
check('脏登记被清理', not registered(D))
check('documents 已清空', store.counts()['documents'] == 0)

# ---------------------------------------------------------------- 5. 快照与回退
print('\n=== 5. 删除前的快照必须能把它救回来 ===')
store.upsert('documents', [{'id': None, 'title': 'X', 'document_type': '体检报告',
                                 'source_attachments': []}])
keep = att('attachments/keep.pdf')
kid = store.read_all('documents')[0]['id']
store.upsert('documents', [{'id': None, 'title': 'Y', 'document_type': '体检报告',
                                 'source_attachments': [keep]}])
yid = [x['id'] for x in store.read_all('documents') if x['title'] == 'Y'][0]

snaps_before = len(store.snapshot_list())
r5 = store.delete_records('documents', [yid])
check('删除前自动打了快照', len(store.snapshot_list()) == snaps_before + 1,
      '%d → %d' % (snaps_before, len(store.snapshot_list())))
# 快照名只到秒。同一秒内连着打两份会撞名，后一份盖掉前一份，回退点就凭空少一个。
n1 = store.snapshot('撞名测试')
n2 = store.snapshot('撞名测试')
check('同一秒内的两份快照不会互相覆盖', n1 and n2 and n1 != n2, '%s / %s' % (n1, n2))
check('快照名字标了原因', str(r5.get('snapshot')).find('delete') >= 0, str(r5.get('snapshot')))
check('附件已被物理删掉', not on_disk('attachments/keep.pdf'))

snap_path = os.path.join(store.snap_dir, r5['snapshot'])
with open(snap_path, encoding='utf-8') as fh:
    snap_obj = json.load(fh)
blob_b64 = [f.get('dataBase64') for f in snap_obj['files'] if f.get('path') == 'attachments/keep.pdf']
check('快照里带着被删附件的二进制', bool(blob_b64) and bool(blob_b64[0]))

back = store.import_backup(snap_obj)
check('从快照回退后档案回来了', back['written'] == 2, str(back.get('written')))
check('从快照回退后物理文件也回来了', on_disk('attachments/keep.pdf'))

# ---------------------------------------------------------------- 6. 边界
print('\n=== 6. 边界与拒绝 ===')
ids_before = [x['id'] for x in store.read_all('documents')]
r6 = store.delete_records('documents', [999999])
check('不存在的 id：deleted=0', r6['deleted'] == 0, str(r6.get('deleted')))
check('不存在的 id：什么都没删', [x['id'] for x in store.read_all('documents')] == ids_before)

r7 = store.delete_records('documents', [])
check('空列表不删任何行', r7['deleted'] == 0)
check('空列表也不会白打一份快照', r7.get('snapshot') is None, str(r7.get('snapshot')))

expect_error('未知表名被拒绝', lambda: store.delete_records('secrets', [1]), '未知')

expect_error('非整数的 id 被拒绝', lambda: store.delete_records('documents', ['abc']), '合法')

# 快照失败时必须中止：不可逆操作不能没有退路
_real_snapshot = store.snapshot
store.snapshot = lambda reason='auto': None
before = [x['id'] for x in store.read_all('documents')]
try:
    expect_error('快照写不出来时中止删除',
                 lambda: store.delete_records('documents', before[:1]), '快照')
    check('中止后档案还在', [x['id'] for x in store.read_all('documents')] == before)
finally:
    store.snapshot = _real_snapshot

# ---------------------------------------------------------------- 清理与汇总
shutil.rmtree(TMP, ignore_errors=True)
print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('档案删除数据层单测全部通过')
