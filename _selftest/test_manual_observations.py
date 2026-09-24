# -*- coding: utf-8 -*-
"""手填记录 → 观测值打通（V2 趋势数据源）
================================================================
「日常录入」写的是 manual_records，而趋势 / 关注表只读 observations。
两边不打通时，用户自己记的血糖、体重在概览里等于不存在 —— 界面说
「暂无结果」，记录明明就在库里。

覆盖：
  1. 数值手填记录会落成一条 source='manual' 的观测值，趋势查得到；
  2. 定性文字同样能落（值原样保留，不转 0/空）；
  3. 双数值（血压）拆成收缩压 / 舒张压两行，与报告提取用同一批指标；
  4. 同人同指标同一天重复录入只留最新一条；
  5. 改日期不留旧点位；删记录把点位一起带走；
  6. 手填的点按人隔离，且不会串到别人的趋势里。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_manual_observations.py
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


TMP = tempfile.mkdtemp(prefix='hrw-manual-')
DB = os.path.join(TMP, 'health.db')
STORE = S.Store(HERE, data_dir=TMP)
STORE.save_persons([{'id': 1, 'name': u'我'}, {'id': 4, 'name': u'爸爸'}])


def q(sql, args=()):
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def obs_of(indicator_like, pid=None):
    sql = ('SELECT o.*, i.name AS iname FROM observations o JOIN indicators i ON i.id=o.indicator_id '
           'WHERE i.name LIKE ?')
    args = ['%' + indicator_like + '%']
    if pid is not None:
        sql += ' AND o.person_id=?'
        args.append(pid)
    return [dict(r) for r in q(sql + ' ORDER BY o.id', tuple(args))]


def add(rec):
    rec = dict(rec)
    rec.setdefault('record_date', '2025-05-05')
    rec.setdefault('review', u'用户录入')
    rec.setdefault('source', u'手动录入')
    STORE.upsert('manual_records', [rec])
    return STORE.read_all('manual_records')[-1]['id']


# ---------------------------------------------------------------- 1. 数值
rid = add({'person_id': 1, 'indicator_key': 'fbg', 'name': u'空腹血糖', 'type': u'数值',
           'value1': '5.9', 'unit': 'mmol/L', 'reference': '3.9~6.1', 'source': u'手动录入'})
o = obs_of(u'空腹血糖', 1)
check('数值手填记录落成一条观测值', len(o) == 1, str(o))
check('观测值标记为 source=manual（与报告提取区分得开）',
      o and o[0]['source'] == 'manual' and o[0]['document_id'] is None, str(o))
check('观测值带上数值与单位', o and o[0]['value'] == '5.9' and o[0]['unit'] == 'mmol/L', str(o))
check('数值可入图（numeric_value 解析出来）', o and o[0]['numeric_value'] == 5.9, str(o))

# 同一天重复录入：只留最新一条
add({'person_id': 1, 'indicator_key': 'fbg', 'name': u'空腹血糖', 'type': u'数值',
     'value1': '6.4', 'unit': 'mmol/L'})
o = obs_of(u'空腹血糖', 1)
check('同人同指标同一天重复录入只留最新一条',
      len(o) == 1 and o[0]['value'] == '6.4', str(o))

# ---------------------------------------------------------------- 2. 定性文字
add({'person_id': 1, 'indicator_key': 'ua', 'name': u'尿蛋白', 'type': u'定性文字',
     'text_result': u'阴性', 'record_date': '2025-05-06'})
o = obs_of(u'尿蛋白', 1)
check('定性文字也能落成观测值，且原样保留', o and o[0]['value'] == u'阴性', str(o))

# ---------------------------------------------------------------- 3. 双数值（血压）
add({'person_id': 1, 'indicator_key': 'bp', 'name': u'血压', 'type': u'双数值',
     'value1': '128', 'value2': '82', 'unit': 'mmHg', 'record_date': '2025-05-07'})
sys_o, dia_o = obs_of(u'收缩压', 1), obs_of(u'舒张压', 1)
check('双数值拆成收缩压 / 舒张压两行',
      len(sys_o) == 1 and sys_o[0]['value'] == '128'
      and len(dia_o) == 1 and dia_o[0]['value'] == '82',
      str(sys_o) + ' / ' + str(dia_o))
check('收缩压与舒张压落在两个不同的指标上',
      sys_o and dia_o and sys_o[0]['indicator_id'] != dia_o[0]['indicator_id'])

# ---------------------------------------------------------------- 4. 按人隔离
add({'person_id': 4, 'indicator_key': 'fbg', 'name': u'空腹血糖', 'type': u'数值',
     'value1': '4.5', 'unit': 'mmol/L', 'record_date': '2025-05-05'})
mine, dads = obs_of(u'空腹血糖', 1), obs_of(u'空腹血糖', 4)
check('手填的点按人隔离（我的与爸爸的各一条）',
      len(mine) == 1 and len(dads) == 1 and mine[0]['value'] == '6.4' and dads[0]['value'] == '4.5',
      '%s / %s' % (mine, dads))
check('趋势接口只返回指定成员的点',
      all(p['person_id'] == 4 for p in
          (STORE.trend(dads[0]['indicator_id'], 4).get('points') or []))
      if hasattr(STORE, 'trend') else True)

# ---------------------------------------------------------------- 5. 改日期 / 删记录
STORE.upsert('manual_records', [dict(dict(STORE.read_all('manual_records')[0]),
                                     record_date='2025-06-01', value1='7.0')])
o = obs_of(u'空腹血糖', 1)
check('改日期后不留旧点位，只剩新日期那一条',
      len(o) == 1 and o[0]['obs_date'] == '2025-06-01' and o[0]['value'] == '7.0', str(o))

rid = [r for r in STORE.read_all('manual_records')
       if r['person_id'] == 4 and r['indicator_key'] == 'fbg'][0]['id']
STORE.delete('manual_records', [rid])
check('删掉手填记录，它的观测值一起消失（趋势上不留孤儿点）',
      obs_of(u'空腹血糖', 4) == [], str(obs_of(u'空腹血糖', 4)))
check('别人的同指标点位不受影响', len(obs_of(u'空腹血糖', 1)) == 1)

# 清空手填表：手工录入的点位一并清掉，报告提取的点位不受影响
STORE.upsert('documents', [{
    'document_type': u'体检报告', 'title': u'报告来源', 'primary_date': '2025-05-08',
    'person_id': 1, 'type_specific_data': {'lab_results': [
        {'name': u'空腹血糖', 'result': '5.1', 'unit': 'mmol/L'}]}}])
check('报告提取的点位先在库',
      len([p for p in obs_of(u'空腹血糖', 1) if p['source'] == 'report']) == 1)
STORE.clear_table('manual_records')
left = obs_of(u'空腹血糖', 1)
check('清空手填表只清 manual 来源的点',
      all(p['source'] == 'report' for p in left) and len(left) == 1, str(left))

# ---------------------------------------------------------------- 汇总
shutil.rmtree(TMP, ignore_errors=True)
print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('手填记录 → 观测值打通单测全部通过')
