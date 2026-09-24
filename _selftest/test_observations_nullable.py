# -*- coding: utf-8 -*-
"""observations.person_id 可空化（V2 结构修复）
================================================================
「未指定」是档案的合法状态（先导入、后归属）。observations.person_id 早期带 NOT NULL，
会让这类档案的检验项写不进去 —— 界面表现是「导入成功，但检验结果一项都没有」。

覆盖：
  1. 新库：schema.sql 建出来的 person_id 可空；
  2. 未归属档案的检验项能落库、能读回；
  3. 老库（person_id NOT NULL）启动时自动重建，行数与内容不丢、索引与序列恢复正常；
  4. 归属后观测值跟着改人（assign_person / clear_person 的联动）。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_observations_nullable.py
"""

import os
import shutil
import sqlite3
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


def q(db, sql, args=()):
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def notnull_of(db):
    rows = q(db, 'PRAGMA table_info(observations)')
    return {r['name']: r['notnull'] for r in rows}.get('person_id')


def mk_doc(title, pid, val):
    return {
        'document_type': u'体检报告', 'title': title, 'primary_date': '2025-05-05',
        'date_status': u'已确认', 'person_id': pid, 'parsed_content': u'原文 ' + title,
        'type_specific_data': {'lab_results': [
            {'name': u'空腹血糖', 'result': val, 'unit': 'mmol/L', 'panel': u'生化'}]},
    }


def labs(store, title):
    for d in store.read_all('documents'):
        if d['title'] == title:
            return d['type_specific_data'].get('lab_results') or []
    return None


# ---------------------------------------------------------------- 1. 新库：可空
TMP = tempfile.mkdtemp(prefix='hrw-obspid-')
DB = os.path.join(TMP, 'health.db')
STORE = S.Store(HERE, data_dir=TMP)
check('新库 observations.person_id 可空', notnull_of(DB) == 0, str(notnull_of(DB)))

STORE.upsert('documents', [mk_doc(u'未归属用例', None, '4.8')])
got = labs(STORE, u'未归属用例')
check('未归属档案的检验项能落库并读回', len(got) == 1 and got[0]['result'] == '4.8', str(got))
check('观测值的 person_id 为 NULL（不是 0 也不是瞎编的人）',
      [r['person_id'] for r in q(DB, 'SELECT person_id FROM observations')] == [None])

STORE.upsert('documents', [mk_doc(u'归属用例', 1, '5.2')])
check('有归属的档案照旧能读回', labs(STORE, u'归属用例')[0]['result'] == '5.2')

# 归属联动：未指定的档案被认领后，观测值也要跟着走
STORE.assign_person('documents', 3)
pids = {r['document_id']: r['person_id'] for r in
        q(DB, 'SELECT document_id, person_id FROM observations')}
docs = {d['id']: d['person_id'] for d in STORE.read_all('documents')}
check('归属后观测值 person_id 与档案一致',
      all(pids[d] == p for d, p in docs.items()), 'obs=%s docs=%s' % (pids, docs))
assigned_id = [d for d in docs if docs[d] == 3]
solo_id = [d for d in docs if docs[d] == 1]
check('认领前未归属的那条确实被认领了', len(assigned_id) == 1 and len(solo_id) == 1,
      'assigned=%s solo=%s' % (assigned_id, solo_id))
STORE.clear_person('documents', 3)
now = {r['document_id']: r['person_id'] for r in
       q(DB, 'SELECT document_id, person_id FROM observations')}
check('取消归属后该档案的观测值一并回到 NULL',
      now.get(assigned_id[0]) is None, str(now))
check('别人的观测值一点没被牵连',
      now.get(solo_id[0]) == 1, str(now))
STORE.upsert('documents', [mk_doc(u'未归属用例二', None, '7.0')])
check('取消归属之后再导入未归属档案仍然可用',
      (labs(STORE, u'未归属用例二') or [{}])[0].get('result') == '7.0')
shutil.rmtree(TMP, ignore_errors=True)

# ---------------------------------------------------------------- 2. 老库：自动重建
TMP2 = tempfile.mkdtemp(prefix='hrw-obspid-legacy-')
DB2 = os.path.join(TMP2, 'health.db')
# 造一个「老」库：结构用当前 schema.sql（表与索引都在），只有 observations
# 保持早期那种 person_id NOT NULL 的形状，并且已经存了数据。
_legacy = S.Store(HERE, data_dir=TMP2)
c = sqlite3.connect(DB2)
c.executescript('''
DROP TABLE observations;
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES persons(id),
  indicator_id INTEGER NOT NULL REFERENCES indicators(id),
  document_id INTEGER REFERENCES documents(id), obs_date TEXT NOT NULL,
  value TEXT NOT NULL, numeric_value REAL, unit TEXT, reference TEXT, flag TEXT,
  condition TEXT, panel TEXT, source TEXT DEFAULT 'report', created_at TEXT);
''')
c.execute('INSERT INTO persons (id, name, role) VALUES (1, ?, ?)', (u'我', 'self'))
c.execute('INSERT INTO indicators (id, key, name, category, unit, is_text) '
          'VALUES (1, ?, ?, ?, ?, 0)', (u'glu_fast', u'空腹血糖', u'生化', 'mmol/L'))
c.execute('INSERT INTO observations (person_id, indicator_id, obs_date, value, panel) '
          'VALUES (1, 1, ?, ?, ?)', ('2025-05-05', '5.2', u'生化'))
c.commit()
c.close()
# 重建后索引被 DROP TABLE 带走，这里不补 —— 正好用来验证启动时会补回来
check('老库前置：person_id 是 NOT NULL', notnull_of(DB2) == 1)
check('老库前置：索引是被删掉的', not
      q(DB2, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observations'"))
ROWS_BEFORE = [dict(r) for r in q(DB2, 'SELECT * FROM observations')]

STORE2 = S.Store(HERE, data_dir=TMP2)
check('启动后自动放宽为可空', notnull_of(DB2) == 0)
check('重建后老数据一条不丢（含 id 与各列）',
      [dict(r) for r in q(DB2, 'SELECT * FROM observations')] == ROWS_BEFORE,
      str([dict(r) for r in q(DB2, 'SELECT * FROM observations')]))
check('重建后索引都回来了',
      {r['name'] for r in q(DB2, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observations'")} >=
      {'idx_obs_person', 'idx_obs_doc', 'idx_obs_ind'},
      str(q(DB2, "SELECT name FROM sqlite_master WHERE type='index'")))
check('重建后没有留下临时表', not q(DB2, "SELECT name FROM sqlite_master WHERE name LIKE '%notnull_old%'"))
check('重建后自增序号没有倒退（新行 id 大于已有最大 id）',
      q(DB2, "SELECT seq FROM sqlite_sequence WHERE name='observations'")[0]['seq'] >= 1)

# 重建后的库能接住「未指定」的检验项
STORE2.upsert('documents', [mk_doc(u'老库新导入·未指定', None, '6.1')])
check('老库放宽后也能存未归属的检验项',
      (labs(STORE2, u'老库新导入·未指定') or [{}])[0].get('result') == '6.1')
# 再启动一次：幂等，不该再动表
STORE3 = S.Store(HERE, data_dir=TMP2)
check('重复启动幂等（结构已合规就不再重建）', notnull_of(DB2) == 0)
check('重复启动后数据仍在', len(STORE3.read_all('documents')) == 1)
check('重复启动后观测值仍在',
      q(DB2, 'SELECT COUNT(*) n FROM observations')[0]['n'] == 2,
      str(q(DB2, 'SELECT COUNT(*) n FROM observations')))
shutil.rmtree(TMP2, ignore_errors=True)

print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('observations.person_id 可空化修复全部通过')
