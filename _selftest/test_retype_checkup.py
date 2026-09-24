# -*- coding: utf-8 -*-
"""存量记录回改为「体检报告」的判定单测
================================================================
背景：网页解析归档时类型一律先落在「其他医疗资料」（app.js 的草稿默认值），
新增「体检报告」这一类之后，历史那批体检报告书需要回改。

回改是**改数据**，判定必须窄：只有原文证据指向体检报告、且当前类型确实是
「没分出来」的那几种才动；人已明确分过类的（检验报告 / 检查报告 / 发票 / 药品）一律不碰。

用法：
    python _selftest/test_retype_checkup.py
"""

import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, '_patch'))

import retype_checkup as R  # noqa: E402

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


def row(title=None, source_file=None, atts=(), doc_type='其他医疗资料'):
    return {
        'id': 1, 'title': title, 'source_file': source_file, 'document_type': doc_type,
        'source_attachments': [{'name': n, 'path': 'attachments/' + n} for n in atts],
    }


print('=== 1. 该改的 ===')
r = R.classify(row(title='瑞慈健康体检 体检报告书', doc_type='其他医疗资料'))
check('标题含体检报告 + 当前是兜底类型 → 改', r == '体检报告', str(r))
r = R.classify(row(source_file='某某_体检报告_2025-12-13.pdf'))
check('原始文件名含体检报告 → 改', r == '体检报告', str(r))
r = R.classify(row(atts=['某人_体检报告_2024-05-19.pdf']))
check('只有附件名能看出来 → 也算证据', r == '体检报告', str(r))
r = R.classify(row(title='体检 报 告 书'))
check('中间夹空格照样认（先归一再比）', r == '体检报告', str(r))
r = R.classify(row(title='健康体检报告单', doc_type=''))
check('类型为空 → 视为没分出来，可改', r == '体检报告', str(r))
r = R.classify(row(title='体检报告', doc_type=None))
check('类型为 None → 同上', r == '体检报告', str(r))

print('\n=== 2. 不该动的 ===')
for label, rr in [
    ('检验报告（已明确分类，不擅自改）', row(title='体检报告之血常规', doc_type='检验报告')),
    # 注释早就写了「人已明确分过类不覆盖」，检查报告同样是人选的：
    # 一份「体检报告-胸部CT」被判成检查报告后，脚本不该再改判。
    ('检查报告（同样是人选的类型，不擅自改判）', row(title='体检报告-胸部CT', doc_type='检查报告')),
    ('医疗发票', row(title='体检报告收费票据', doc_type='医疗发票/收费单')),
    ('处方', row(title='体检报告后续用药', doc_type='处方/用药单')),
    ('挂号单', row(title='体检报告取号单', doc_type='挂号单/就诊单')),
    ('药品资料', row(title='体检报告附带的药', doc_type='药品资料')),
]:
    check(label, R.classify(rr) is None, str(R.classify(rr)))

check('已经是体检报告 → 不重复改（幂等）',
      R.classify(row(title='体检报告', doc_type='体检报告')) is None)
check('没有证据 → 不动', R.classify(row(title='门诊病历', source_file='门诊_2024.pdf')) is None)
check('只有医院名提到体检，不算证据',
      R.classify(row(title='门诊发票', source_file='瑞慈健康体检_发票.pdf',
                     doc_type='医疗发票/收费单')) is None)
check('空记录不崩', R.classify({}) is None)
check('None 不崩', R.classify(None) is None)

print('\n=== 3. source_attachments 的各种形态 ===')
r = row(title=None, atts=['a_体检报告.pdf'])
r['source_attachments'] = '[{"name":"b_体检报告.pdf"}]'      # 落库时可能是 JSON 字符串
check('附件是 JSON 字符串时也能取到证据', R.classify(r) == '体检报告', str(R.classify(r)))
r2 = row(title=None)
r2['source_attachments'] = '坏掉的 JSON {'
check('附件字段解析失败时不崩，按无证据处理', R.classify(r2) is None)
r3 = row(title=None)
r3['source_attachments'] = [{'nope': 1}, None, 'x']
check('附件项形状异常时跳过而不崩', R.classify(r3) is None)

print('\n=== 4. 计划与执行分离 ===')
rows = [
    {'id': 1, 'title': '体检报告书', 'document_type': '其他医疗资料', 'source_file': None,
     'source_attachments': []},
    {'id': 4, 'title': '体检报告-胸部CT', 'document_type': '检查报告', 'source_file': None,
     'source_attachments': []},
    {'id': 2, 'title': '其他资料', 'document_type': '其他医疗资料', 'source_file': None,
     'source_attachments': []},
    {'id': 3, 'title': '血常规', 'document_type': '检验报告', 'source_file': None,
     'source_attachments': []},
]
plan = R.plan(rows)
check('只列出真正该改的（检查报告那条不进计划）', [p['id'] for p in plan] == [1], str(plan))
check('计划里带上改前改后，便于人工核对',
      plan[0]['from'] == '其他医疗资料' and plan[0]['to'] == '体检报告', str(plan[0]))
check('plan() 本身不改动传进来的数据',
      rows[0]['document_type'] == '其他医疗资料')

print('\n=== 5. 真的写库时不能丢掉别的字段 ===')
# upsert 会把整行拆进关系列 + detail_json，所以执行必须拿完整行去改：
# 只提交 {id, document_type} 会把标题、解析原文、附件引用、归属成员全部抹平。
import shutil
import tempfile

TMP = tempfile.mkdtemp(prefix='hrw-retype-')
st = R.hrw_store.Store(HERE, data_dir=TMP)
keep = {
    'id': None, 'title': '某某 体检报告书', 'document_type': '其他医疗资料',
    'primary_date': '2025-12-13', 'person_id': 4, 'hospital': '虚构医院',
    'parsed_content': '一大段解析原文，不能丢', 'source_file': 'x_体检报告_2025-12-13.pdf',
    'source_attachments': [{'name': 'x_体检报告_2025-12-13.pdf', 'path': 'attachments/k.pdf'}],
    'type_specific_data': {'lab_results': [{'name': '血红蛋白', 'result': '145'}]},
}
st.upsert('documents', [keep])
target_id = st.read_all('documents')[0]['id']

changed, snap = R.apply(st)
check('执行后返回改了多少条', changed == 1, str(changed))
check('执行前打了快照并报名', bool(snap) and 'retype' in str(snap), str(snap))

after = [r for r in st.read_all('documents') if r['id'] == target_id][0]
check('类型改到了', after['document_type'] == '体检报告', after['document_type'])
for f in ('title', 'primary_date', 'person_id', 'hospital', 'parsed_content',
          'source_file', 'source_attachments'):
    check('字段 %s 原样保留' % f, after.get(f) == keep[f], str(after.get(f))[:60])
# type_specific_data 由观测值重建（检验项名会归一化为规范名、补上单位/条件等键），
# 所以比语义保真而不是逐字节相等：检验项一条不少、名字与结果都在。
_tsd = after.get('type_specific_data') or {}
_labs = _tsd.get('lab_results') or []
check('字段 type_specific_data 的检验项保真',
      len(_labs) == 1 and _labs[0].get('name') == '血红蛋白' and _labs[0].get('result') == '145',
      str(_tsd)[:80])
check('再跑一次不再改动（幂等）', R.apply(st)[0] == 0)

shutil.rmtree(TMP, ignore_errors=True)

print('\n=== 汇总 ===')
print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
if FAIL:
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1)
print('体检报告回改判定全部通过')
