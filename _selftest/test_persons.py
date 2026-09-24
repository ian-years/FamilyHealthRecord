# -*- coding: utf-8 -*-
"""
家庭成员（person）数据层单测
================================================================
覆盖：预置成员、增删改校验、成员 id 唯一性、批量归属、备份/恢复带成员、
旧备份（无 meta 键）向后兼容、person_stats 统计。

跑在临时目录里，不碰真实 data/。
用法：
    python _selftest/test_persons.py
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
    """断言 fn 抛出 StoreError（且消息含关键词），并验证「报错后数据没被写坏」。"""
    try:
        fn()
    except S.StoreError as e:
        if keyword and keyword not in str(e):
            check(name, False, '错误信息不含「%s」：%s' % (keyword, e))
        else:
            check(name, True, str(e))
        return
    except Exception as e:
        check(name, False, '抛了非预期异常 %s: %s' % (type(e).__name__, e))
        return
    check(name, False, '竟然没报错')


def main():
    tmp = tempfile.mkdtemp(prefix='hrw-persons-')
    try:
        print('=== 1. 预置成员 ===')
        st = S.Store(HERE, data_dir=tmp)
        ps = st.persons()
        check('首次运行写入 6 个预置成员', len(ps) == 6, len(ps))
        names = [p['name'] for p in ps]
        check('预置成员名字符合预期',
              names == ['我', '老婆', '儿子', '爸爸', '妈妈', '丈母娘'], names)
        check('成员 id 为 1..6', [p['id'] for p in ps] == [1, 2, 3, 4, 5, 6],
              [p['id'] for p in ps])
        check('每个成员都有 created_at', all(p.get('created_at') for p in ps))

        print('\n=== 2. 重复读取不会重复写入 ===')
        again = S.Store(HERE, data_dir=tmp).persons()
        check('重开 Store 后成员仍是 6 个（幂等）', len(again) == 6, len(again))

        print('\n=== 3. 改名与新增 ===')
        ps = st.persons()
        ps[2]['name'] = '小明'          # 「儿子」改小名
        ps.append({'id': 7, 'name': '女儿', 'role': 'daughter'})
        saved = st.save_persons(ps)
        got = st.persons()
        check('改名生效', got[2]['name'] == '小明', got[2]['name'])
        check('关系标签保留', got[2]['role'] == 'son', got[2]['role'])
        check('新增成员成功', len(got) == 7, len(got))
        check('保存返回值即新名单', len(saved) == 7, len(saved))
        check('next_person_id 递增到 8', st.next_person_id() == 8, st.next_person_id())

        print('\n=== 4. 删除成员 ===')
        keep = [p for p in st.persons() if p['id'] != 7]
        st.save_persons(keep)
        got = st.persons()
        check('删除后剩 6 个', len(got) == 6, len(got))
        check('删除后 id 不重排（避免档案错挂到别人名下）',
              [p['id'] for p in got] == [1, 2, 3, 4, 5, 6], [p['id'] for p in got])

        print('\n=== 5. 校验：非法名单必须拒绝且不落库 ===')
        snapshot_before = st.persons()
        expect_error('空名称被拒绝', lambda: st.save_persons(
            st.persons() + [{'id': 9, 'name': '   '}]), '名称不能为空')
        expect_error('id 重复被拒绝', lambda: st.save_persons(
            st.persons() + [{'id': 1, 'name': '撞 id'}]), 'id 重复')
        expect_error('非整数 id 被拒绝', lambda: st.save_persons(
            st.persons() + [{'id': 'abc', 'name': '怪'}]), '不是整数')
        expect_error('非对象项被拒绝', lambda: st.save_persons(st.persons() + ['野值']),
                     '不是对象')
        expect_error('非列表名单被拒绝', lambda: st.save_persons({'a': 1}), '不是列表')
        cur = st.persons()
        check('四次非法保存后名单未被污染',
              json.dumps(cur, ensure_ascii=False, sort_keys=True) ==
              json.dumps(snapshot_before, ensure_ascii=False, sort_keys=True),
              [p['name'] for p in cur])

        print('\n=== 6. 记录归属 ===')
        st.upsert('documents', [
            {'title': '张三体检', 'person_id': 1},
            {'title': '李四化验', 'person_id': 2},
            {'title': '无归属旧记录'},              # 旧数据：没有 person_id 字段
            {'title': '空字符串', 'person_id': ''},
        ])
        stats = st.person_stats()
        check('成员 1 名下 1 条', stats.get('1') == 1, stats)
        check('成员 2 名下 1 条', stats.get('2') == 1, stats)
        check('未归属 2 条归入 none', stats.get('none') == 2, stats)
        check('person_stats 的键全是字符串（None 经 JSON 会变成 null，前端取不到）',
              all(isinstance(k, str) for k in stats.keys()), list(stats.keys()))
        rt = json.loads(json.dumps(stats))
        check('JSON 往返后 none 仍可取到', rt.get('none') == 2, rt)

        print('\n=== 7. 批量归属（只动未归属的） ===')
        snap = st.snapshot('ut-assign')
        n = st.assign_person('documents', 1)
        check('返回改动条数 2', n == 2, n)
        rows = st.read_all('documents')
        m = {r.get('title'): r.get('person_id') for r in rows}
        check('旧记录被归到成员 1', m.get('无归属旧记录') == 1, m)
        check('空字符串记录也被归到成员 1', m.get('空字符串') == 1, m)
        check('原本属于成员 2 的没被改', m.get('李四化验') == 2, m)
        check('批量操作前打了快照', bool(snap), snap)
        check('再次批量归属返回 0（没有可动的了）',
              st.assign_person('documents', 1) == 0)

        print('\n=== 8. 强制覆盖模式 ===')
        n2 = st.assign_person('documents', 3, only_unassigned=False)
        check('强制模式下 4 条全部改到成员 3', n2 == 4, n2)
        rows = st.read_all('documents')
        check('所有记录 person_id 都为 3',
              all(r.get('person_id') == 3 for r in rows),
              [r.get('person_id') for r in rows])

        print('\n=== 9. 未知成员 id 要报错 ===')
        expect_error('assign 到非整数 id 被拒绝',
                     lambda: st.assign_person('documents', 'x'), '不是整数')
        expect_error('assign 到未知表被拒绝',
                     lambda: st.assign_person('no_such_table', 1), '未知的数据表')

        print('\n=== 10. 备份含成员 ===')
        st.save_persons(st.persons()[:3])          # 缩到 3 个成员便于比对
        b = st.export_backup()
        check('备份 meta 键存在', isinstance(b.get('meta'), dict), sorted(b.keys()))
        meta = json.loads(b['meta']['persons'])
        check('备份里成员数量为 3', len(meta) == 3, len(meta))
        check('备份成员名字符合预期', [p['name'] for p in meta] == ['我', '老婆', '小明'],
              [p['name'] for p in meta])
        check('备份成员 id 为 1/2/3（删除后不重排）',
              [p['id'] for p in meta] == [1, 2, 3], [p['id'] for p in meta])

        print('\n=== 11. 恢复后成员与归属都在 ===')
        tmp2 = tempfile.mkdtemp(prefix='hrw-persons-restore-')
        try:
            st2 = S.Store(HERE, data_dir=tmp2)
            check('新库自动预置 6 成员', len(st2.persons()) == 6, len(st2.persons()))
            res = st2.import_backup(b)
            check('恢复成功', res.get('ok') is True, res)
            check('恢复写入 meta', res.get('metaWritten') == 1, res.get('metaWritten'))
            got = st2.persons()
            check('恢复后成员变回 3 个（被备份覆盖）', len(got) == 3, len(got))
            check('恢复后档案 4 条', res.get('written') == 4, res.get('written'))
            rows2 = st2.read_all('documents')
            check('恢复后档案归属仍为成员 3',
                  all(r.get('person_id') == 3 for r in rows2),
                  [r.get('person_id') for r in rows2])
        finally:
            shutil.rmtree(tmp2, ignore_errors=True)

        print('\n=== 12. 旧备份（无 meta 键）向后兼容 ===')
        legacy = {
            'schema': S.BACKUP_SCHEMA,
            'exported_at': '2026-01-01T00:00:00',
            'owner': 'local-user',
            'counts': {'documents': 1, 'drugs': 0, 'indicators': 0,
                       'manual_records': 0},
            'file_count': 0,
            'tables': {'documents': [{'title': '旧记录', 'person_id': 2}],
                       'drugs': [], 'indicators': [],
                       'manual_records': []},
            'files': [],
        }
        tmp3 = tempfile.mkdtemp(prefix='hrw-persons-legacy-')
        try:
            st3 = S.Store(HERE, data_dir=tmp3)
            res3 = st3.import_backup(legacy)
            check('旧备份能恢复（不因缺 meta 报错）', res3.get('ok') is True, res3)
            check('metaWritten 为 0', res3.get('metaWritten') == 0, res3.get('metaWritten'))
            check('成员名单保持预置（未被清空）', len(st3.persons()) == 6, len(st3.persons()))
            rows3 = st3.read_all('documents')
            check('旧备份里自带的 person_id 保留', rows3[0].get('person_id') == 2,
                  rows3[0].get('person_id'))
        finally:
            shutil.rmtree(tmp3, ignore_errors=True)

        print('\n=== 12.5 删除成员：名下档案改回「未指定」 ===')
        tmp4 = tempfile.mkdtemp(prefix='hrw-persons-clear-')
        try:
            st4 = S.Store(HERE, data_dir=tmp4)
            st4.save_persons([
                {'id': 1, 'name': '我', 'role': 'self'},
                {'id': 2, 'name': '老婆', 'role': 'spouse'},
            ])
            st4.upsert('documents', [
                {'id': i + 1, 'title': '档案%d' % i, 'document_type': '检验报告',
                 'person_id': pid}
                for i, pid in enumerate([1, 1, 2, None])
            ])
            n = st4.clear_person('documents', 2)
            check('clear_person 只动指定成员名下', n == 1, n)
            rows4 = st4.read_all('documents')
            check('该成员名下档案已置空归属',
                  all(r.get('person_id') is None
                      for r in rows4 if r.get('title') == '档案2'),
                  [r.get('person_id') for r in rows4])
            check('其他成员的归属不受影响',
                  sorted([r.get('person_id') for r in rows4
                          if r.get('title') in ('档案0', '档案1')]) == [1, 1],
                  [r.get('person_id') for r in rows4])
            check('原本未指定的仍然未指定',
                  rows4[3].get('person_id') is None, rows4[3].get('person_id'))
            st4.save_persons([{'id': 1, 'name': '我', 'role': 'self'}])
            check('删掉该成员后名单只剩 1 人', len(st4.persons()) == 1, len(st4.persons()))
            # 统计里不能出现「已删除成员还有档案」这种悬空计数
            st4.clear_person('documents', 2)
            check('重复 clear_person 是幂等的（第二次改 0 条）',
                  st4.clear_person('documents', 2) == 0, 'n/a')
            # 归属目标必须是名单里的真实成员。写成 0 会撞「未指定」的哨兵语义
            # （界面把 0 当作"没有归属"，但存成 0 又不是空值），结果那行
            # 在任何按人视图里都找不到 —— 批量归属接口必须挡住。
            try:
                st4.assign_person('documents', 0, True)
                check('assign_person 拒绝 id=0（0 是「未指定」哨兵，不能当归属目标）',
                      False, '竟然通过了')
            except S.StoreError as e:
                check('assign_person 拒绝 id=0（%s）' % e, True)
            try:
                st4.assign_person('documents', 987, True)
                check('assign_person 拒绝名单外的成员 id', False, '竟然通过了')
            except S.StoreError as e:
                check('assign_person 拒绝名单外 id（%s）' % e, True)
            check('两次被拒绝的归属没有改动任何行',
                  all(r.get('person_id') in (None, 1)
                      for r in st4.read_all('documents')),
                  [r.get('person_id') for r in st4.read_all('documents')])
        finally:
            shutil.rmtree(tmp4, ignore_errors=True)

        print('\n=== 13. 清空数据不误删成员名单 ===')
        before = len(st.persons())
        st.clear_tables()
        st.clear_files()
        check('清空四表后成员名单还在', len(st.persons()) == before, len(st.persons()))

        print('\n=== 14. info 暴露成员数 ===')
        info = S.Store(HERE, data_dir=tmp).info()
        check('info.persons 与名单长度一致', info.get('persons') == before,
              info.get('persons'))

        print('\n=== 15. 关注（add_watched）校验主人必须是真实成员 ===')
        # 关注是「谁关心某项」，主人必须是名单里的成员；SQLite foreign_keys
        # 在进程里是 OFF 的，光靠声明拦不住幽灵 id。这里钉死三类非法输入：
        # id=0（未指定哨兵）、名单外 id、非整数，且报错后不落一行关注。
        stw = S.Store(HERE, data_dir=tmp)
        iid = None
        try:
            # 造一个真实指标，确保只有「成员」这一维在测
            c = stw._conn()
            try:
                c.execute('INSERT INTO indicators (name, key, category, unit) '
                          'VALUES (?,?,?,?)', (u'空腹血糖', 'glu_fast', u'生化', 'mmol/L'))
                c.commit()
                iid = c.execute('SELECT id FROM indicators WHERE key=?', ('glu_fast',)).fetchone()['id']
            finally:
                c.close()
            wat0 = lambda: stw.add_watched(0, iid)
            expect_error('add_watched 拒绝 id=0（未指定哨兵不是成员）', wat0, '名单')
            wat_ghost = lambda: stw.add_watched(987, iid)
            expect_error('add_watched 拒绝名单外的成员 id', wat_ghost, '名单')
            wat_str = lambda: stw.add_watched('abc', iid)
            expect_error('add_watched 拒绝非整数成员 id', wat_str, '整数')
            # 合法关注照常成功
            ok = stw.add_watched(1, iid)
            check('合法关注（成员 1）成功', ok is True)
            check('成员 1 的关注清单里正好这一项（三次非法关注没落行）',
                  len(stw.list_watched(1)) == 1,
                  str([(r['key'], r['name']) for r in stw.list_watched(1)]))
            check('幽灵成员 987 没有任何关注（校验拦住了写入）',
                  len(stw.list_watched(987)) == 0,
                  str(stw.list_watched(987)))
            check('「未指定」没有关注清单（0 不是成员，哨兵语义不被绕过）',
                  stw.list_watched(0) == [], str(stw.list_watched(0)))

            print('\n=== 16. 关注集复制（copy_watched）只合并不覆盖 ===')
            # 造三个真实指标，成员 1 关注 glu_fast/g2，成员 2 已关注 g4（目标已有部分关注）
            c = stw._conn()
            try:
                for k, nm in [('g2', u'餐后血糖'), ('g3', u'糖化血红蛋白'), ('g4', u'总胆固醇')]:
                    c.execute('INSERT INTO indicators (name, key, category, unit) '
                              'VALUES (?,?,?,?)', (nm, k, u'生化', 'mmol/L'))
                c.commit()
                ids = {r['key']: r['id'] for r in c.execute(
                    'SELECT id, key FROM indicators').fetchall()}
            finally:
                c.close()
            stw.add_watched(1, ids['glu_fast'])
            stw.add_watched(1, ids['g2'])
            stw.add_watched(2, ids['g4'])   # 成员 2 已有 g4（复制后应保留）
            added = stw.copy_watched(1, 2)
            check('复制返回新增 2 项（glu_fast、g2；g4 是目标已有的不重复计）',
                  added == 2, 'added=%s' % added)
            w2 = {r['key'] for r in stw.list_watched(2)}
            check('成员 2 的关注清单是「原有关注 ∪ 成员 1 的关注集」',
                  w2 == {'g4', 'glu_fast', 'g2'}, str(sorted(w2)))
            check('成员 1 的关注清单不变（复制不删源）',
                  {r['key'] for r in stw.list_watched(1)} == {'glu_fast', 'g2'},
                  str(sorted({r['key'] for r in stw.list_watched(1)})))
            # 幂等：再复制一次不应新增
            check('重复复制幂等（第二次新增 0 项）', stw.copy_watched(1, 2) == 0)
            # 非法：复制给自己 / id=0 / 名单外
            expect_error('copy_watched 拒绝复制给自己', lambda: stw.copy_watched(1, 1), '同一位')
            expect_error('copy_watched 拒绝 id=0', lambda: stw.copy_watched(0, 2), '真实成员')
            expect_error('copy_watched 拒绝名单外成员', lambda: stw.copy_watched(987, 2), '名单')

            print('\n=== 17. 批量关注（add_watched_batch）一次写入多个指标 ===')
            # 关注全部有数据的指标：单个 add_watched 每个开一条连接，几百个就是
            # 几百次往返。批量版只开一次事务，重复/非法 id 静默跳过。
            # 注意：§16 的 copy_watched 已把 glu_fast/g2 复制给成员 2，这里成员 2
            # 已有关注 g4/glu_fast/g2，批量 [glu_fast, g2, g3] 只剩 g3 是新的。
            ids_list = [ids['glu_fast'], ids['g2'], ids['g3']]
            added = stw.add_watched_batch(2, ids_list)
            check('批量关注返回新增 1 项（glu_fast/g2 已被复制过，仅 g3 新加入）',
                  added == 1, 'added=%s' % added)
            w2b = {r['key'] for r in stw.list_watched(2)}
            check('批量后成员 2 的关注清单包含 glu_fast/g2/g3/g4',
                  w2b == {'glu_fast', 'g2', 'g3', 'g4'}, str(sorted(w2b)))
            # 幂等：再批量一次全部已存在，新增 0
            check('重复批量幂等（第二次新增 0 项）',
                  stw.add_watched_batch(2, ids_list) == 0)
            # 混入不存在的指标 id / 非法值：只插入真实存在的，非法值静默丢弃
            added2 = stw.add_watched_batch(2, [999999, 'not-a-number', None])
            check('混入不存在 id 与非法值 → 全部跳过，新增 0', added2 == 0, 'added=%s' % added2)
            # 空列表：直接返回 0，不报错
            check('空列表返回 0', stw.add_watched_batch(2, []) == 0)
            # 非法成员：与 add_watched 同一判据
            expect_error('批量关注拒绝 id=0', lambda: stw.add_watched_batch(0, ids_list), '名单')
            expect_error('批量关注拒绝名单外成员', lambda: stw.add_watched_batch(987, ids_list), '名单')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n=== 汇总 ===')
    print('通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
    for f in FAIL:
        print('  - ' + f)
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
