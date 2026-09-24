# -*- coding: utf-8 -*-
"""指标链接完整性单测（V2 关系型）
================================================================
覆盖「检验项 → 指标 id → 观测值 → 详情页」这条链路最容易断的几处：

  1. 清空指标目录时，别名与关注列表必须一起清 —— 否则留下指向消失 id 的孤儿别名；
  2. 带 id 回灌指标目录（导出备份 → 清空 → 导入备份）后，id 必须保持不变；
  3. 孤儿别名会被自愈清掉，下一次导入拿到的是有效 id；
  4. 观测值的 panel（检验分组）与 condition（测量条件）不串列、不丢失。

这组断言对应一个真实踩过的坑：备份恢复后指标 id 全变了，旧别名还指着老 id，
新导入的检验报告在档案详情里「一项都看不到」——数据在库，只是 JOIN 不出来。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_indicator_links.py
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


TMP = tempfile.mkdtemp(prefix='hrw-ind-')
store = S.Store(HERE, data_dir=TMP)
DB = os.path.join(TMP, 'health.db')


def q(sql, args=()):
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def doc_row(labs):
    return {
        'document_type': u'检验报告', 'title': u'指标链接用例',
        'primary_date': '2024-06-01', 'date_status': u'已确认', 'person_id': 1,
        'parsed_content': u'【用例】血红蛋白 145 g/L；空腹血糖 5.1 mmol/L。',
        'type_specific_data': {'structured': True, 'lab_results': labs},
    }


LABS = [
    {'name': u'血红蛋白', 'result': '145', 'unit': 'g/L', 'reference': '130~175',
     'flag': u'↑', 'panel': u'血常规', 'condition': u'空腹'},
    {'name': u'空腹血糖', 'result': '5.1', 'unit': 'mmol/L', 'reference': '3.9~6.1',
     'flag': '', 'panel': u'生化', 'condition': u'空腹'},
]


def labs_of(idx=0):
    rows = store.read_all('documents')
    return (rows[idx]['type_specific_data'].get('lab_results') or []) if rows else []


# ---------------------------------------------------------------- 1. 基线：导入后检验项可见
store.upsert('documents', [doc_row(LABS)])
back = labs_of()
check('导入后检验项能读回来（观测值 + 指标 JOIN 得到）', len(back) == 2, str(len(back)))
check('检验分组 panel 原样保留', [x.get('panel') for x in back] == [u'血常规', u'生化'],
      str([x.get('panel') for x in back]))
check('测量条件 condition 与 panel 不串列',
      all(x.get('condition') == u'空腹' for x in back), str([x.get('condition') for x in back]))
check('原文标记 flag 保留', back and back[0].get('flag') == u'↑', str(back[0].get('flag') if back else None))

# ---------------------------------------------------------------- 2. 清空目录：别名一起清
alias_before = q('SELECT COUNT(*) n FROM indicator_aliases')[0]['n']
store.clear_table('indicators')
alias_after = q('SELECT COUNT(*) n FROM indicator_aliases')[0]['n']
check('清空指标目录时别名一起清掉', alias_before > 0 and alias_after == 0,
      'before=%s after=%s' % (alias_before, alias_after))
check('没有留下指向消失指标的别名',
      q('SELECT COUNT(*) n FROM indicator_aliases a LEFT JOIN indicators i '
        'ON i.id=a.indicator_id WHERE i.id IS NULL')[0]['n'] == 0)

# ---------------------------------------------------------------- 3. 回灌目录：id 保持不变
snapshot_rows = [
    {'id': 101, 'key': 'hgb', 'name': u'血红蛋白', 'unit': 'g/L', 'category': u'血常规',
     'aliases': [u'血红蛋白', u'hb']},
    {'id': 102, 'key': 'glu_fast', 'name': u'空腹血糖', 'unit': 'mmol/L', 'category': u'生化',
     'aliases': [u'空腹血糖', u'血糖']},
]
store.upsert('indicators', [dict(r) for r in snapshot_rows])
kept = {r['key']: r['id'] for r in q('SELECT id, key FROM indicators')}
check('回灌后指标沿用备份里的 id', kept.get('hgb') == 101 and kept.get('glu_fast') == 102,
      str(kept))
check('别名挂在正确的指标上',
      q('SELECT COUNT(*) n FROM indicator_aliases WHERE indicator_id=101')[0]['n'] == 2,
      str(q('SELECT indicator_id, alias FROM indicator_aliases')))
check('回灌后没有孤儿别名',
      q('SELECT COUNT(*) n FROM indicator_aliases a LEFT JOIN indicators i '
        'ON i.id=a.indicator_id WHERE i.id IS NULL')[0]['n'] == 0)

# ---------------------------------------------------------------- 4. 回灌后再导入：仍然看得见
store.delete('documents', [r['id'] for r in store.read_all('documents')])
store.upsert('documents', [doc_row(LABS)])
again = labs_of()
check('目录重建后新导入的检验项依然可见', len(again) == 2, str(len(again)))
check('新观测值挂在有效指标上',
      q('SELECT COUNT(*) n FROM observations o JOIN indicators i ON i.id=o.indicator_id')[0]['n'] == 2)

# ---------------------------------------------------------------- 5. 孤儿别名自愈
c = sqlite3.connect(DB)
c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias) VALUES (?,?,?)',
          (999999, u'幽灵指标', u'幽灵指标'))
c.commit()
c.close()
check('造出一个孤儿别名', q('SELECT COUNT(*) n FROM indicator_aliases WHERE indicator_id=999999')[0]['n'] == 1)
store.purge_orphan_aliases()
check('purge_orphan_aliases 清掉孤儿别名',
      q('SELECT COUNT(*) n FROM indicator_aliases WHERE indicator_id=999999')[0]['n'] == 0)

# 别名指向的指标被直接删掉（模拟历史脏数据）后，解析要能自愈到有效指标
c = sqlite3.connect(DB)
c.execute('DELETE FROM indicators WHERE id=101')
c.commit()
c.close()
# 直接删指标会让「已经存在」的观测值变成孤儿（这是删数据本身的后果，这里不掩盖）；
# 要保证的是下一次导入不再踩坑：拿到有效 id，并且那条孤儿别名被清掉。
store.upsert('documents', [doc_row([LABS[0]])])
healed = labs_of(-1)
check('别名指向已删指标时自愈：新检验项仍然可见', len(healed) == 1, str(healed))
last = q('SELECT i.id AS iid, i.name AS iname FROM observations o '
         'LEFT JOIN indicators i ON i.id=o.indicator_id ORDER BY o.id DESC LIMIT 1')[0]
check('自愈后新观测值挂在存在的指标上',
      last['iid'] is not None and last['iname'] == u'血红蛋白', str(dict(last)))
check('用到的别名已改挂到有效指标上（不再指向消失的 id）',
      q('SELECT COUNT(*) n FROM indicator_aliases a JOIN indicators i ON i.id=a.indicator_id '
        'WHERE a.alias=?', (u'血红蛋白',))[0]['n'] >= 1
      and q('SELECT COUNT(*) n FROM indicator_aliases WHERE alias=? AND indicator_id=101',
            (u'血红蛋白',))[0]['n'] == 0,
      str([(r['indicator_id'], r['alias']) for r in q('SELECT indicator_id, alias FROM indicator_aliases')]))
store.purge_orphan_aliases()
check('purge_orphan_aliases 一次清掉其余孤儿别名',
      q('SELECT COUNT(*) n FROM indicator_aliases a LEFT JOIN indicators i '
        'ON i.id=a.indicator_id WHERE i.id IS NULL')[0]['n'] == 0)

# ---------------------------------------------------------------- 清理与汇总
shutil.rmtree(TMP, ignore_errors=True)
print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('指标链接完整性单测全部通过')
