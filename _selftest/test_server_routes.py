# -*- coding: utf-8 -*-
"""
本地服务路由级单测（server.py 的第一批路由用例）
================================================================
盯的是一类很容易复发的**顺序**错误：先打快照、后校验参数。
快照里带附件正文（真实库实测单份 23~31 MB），所以一个注定被拒的请求
也照样白写一份 —— 用户只是点错了一次下拉框。

参数本身合不合法由 test_persons.py 从数据层那侧覆盖；这里只覆盖
「路由有没有在动手之前先问一句」，那只能从 HTTP 那一侧才看得见。

跑在临时目录里，不碰真实 data/；子进程的 PATH / HOME 也改指到临时目录，
所以它找不到 xparse-cli，不会冷启动解析工具、也不消耗每日额度。
用法：
    python _selftest/test_server_routes.py
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

# Windows 下 print 到管道会落 cp936，中文断言行在日志里全是乱码；统一按 UTF-8 出
try:
    sys.stdout.reconfigure(encoding='utf-8')
except (AttributeError, ValueError):
    pass

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


def free_port():
    s = socket.socket()
    try:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]
    finally:
        s.close()


def opener():
    # 显式不代理：这台机器的代理变量会把 127.0.0.1 一起带走，本机服务必须直连
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(op, port, path, payload=None):
    """返回 (http_code, JSON)。服务端把 StoreError 翻成 200 + ok:false，
    把「未知的数据表」翻成 400 + ok:false；两种都得读得到 reason。"""
    data = None
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path))
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    try:
        with op.open(req, data=data, timeout=20) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'ok': False, 'reason': '响应不是 JSON：%s' % raw[:80]}


def snaps(tmp, reason):
    d = os.path.join(tmp, 'snapshots')
    if not os.path.isdir(d):
        return []
    return [f for f in os.listdir(d) if f.startswith('snap-') and reason in f]


def person_snaps(tmp):
    """与成员归属有关的快照。assign 与 clear 两种前缀都要看：漏一种就等于放行一半。"""
    return snaps(tmp, 'before-person-assign') + snaps(tmp, 'before-person-clear')


def main():
    tmp = tempfile.mkdtemp(prefix='hrw-routes-')
    log_path = os.path.join(tmp, 'server.out')
    proc = None
    try:
        port = free_port()
        env = dict(os.environ)
        env['PATH'] = os.path.dirname(sys.executable)
        env['PYTHONUTF8'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'      # 子进程日志按 UTF-8 落盘，才不会读成乱码
        env['PYTHONUNBUFFERED'] = '1'          # 重定向到文件时默认是块缓冲，横幅会卡在缓冲区里
        for k in ('HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
                  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY'):
            env[k] = tmp if k.startswith('HOME') or k in ('USERPROFILE',) else ''
        log = open(log_path, 'wb')
        proc = subprocess.Popen(
            [sys.executable, 'server.py', '--port', str(port),
             '--no-browser', '--data-dir', tmp],
            cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT)

        op = opener()
        info, deadline = None, time.time() + 90
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                code, j = call(op, port, '/api/db/info')
                if code == 200 and j.get('ok'):
                    info = j['info']
                    break
            except Exception:
                pass
            time.sleep(0.4)

        print('=== 1. 服务起来了，而且连的是临时目录 ===')
        if info is None:
            check('子进程在 90 秒内就绪', False,
                  open(log_path, 'rb').read().decode('utf-8', 'replace')[-300:])
            return finish(proc, tmp)
        check('子进程在 90 秒内就绪', True)
        check('防呆：连的是临时数据目录，绝不是真实 data\\',
              os.path.normcase(os.path.realpath(info['data_dir']))
              == os.path.normcase(os.path.realpath(tmp)), info['data_dir'])
        log_txt = open(log_path, 'rb').read().decode('utf-8', 'replace')
        check('防呆：子进程找不到解析工具（不冷启动 CLI、不消耗每日额度）',
              '未找到 xparse-cli' in log_txt, '日志里没这句话，说明它可能真去调了 CLI')

        print('\n=== 2. 造一条未归属的档案，供后面计数 ===')
        code, j = call(op, port, '/api/db/put',
                       {'table': 'documents',
                        'rows': [{'title': '路由用例档案', 'document_type': '体检报告',
                                  'primary_date': '2025-01-01', 'date_status': '已确认'}]})
        check('写入 1 条', j.get('written') == 1, json.dumps(j, ensure_ascii=False)[:120])
        legal = S.Store(HERE, data_dir=tmp).persons()[0]['id']

        def assign(pid, table='documents'):
            return call(op, port, '/api/persons/assign',
                        {'table': table, 'person_id': pid})

        print('\n=== 3. 被拒绝的请求不得留下任何快照 ===')
        bad = [
            ('归属到 person_id=0（未指定哨兵）', assign(0), '未指定'),
            ('归属到名单外的 id', assign(99999), '不在成员名单里'),
            ('归属到非整数 id', assign('abc'), '不是整数'),
            ('归属但没带 person_id', assign(None), '不是整数'),
            ('归属到未知的表', assign(legal, table='nope'), '未知的数据表'),
        ]
        for label, (code, j), kw in bad:
            reason = j.get('reason') or ''
            check('%s → 报错且文案含「%s」' % (label, kw),
                  j.get('ok') is False and kw in reason, reason[:90])
            check('%s → 一份快照都没写' % label, not person_snaps(tmp),
                  '实际存在：%s' % person_snaps(tmp))
        cleared = call(op, port, '/api/persons/clear', {'table': 'documents'})
        check('解除归属但没带 id → 报错', cleared[1].get('ok') is False,
              json.dumps(cleared[1], ensure_ascii=False)[:90])
        check('解除归属但没带 id → 一份快照都没写', not person_snaps(tmp),
              '实际存在：%s' % person_snaps(tmp))

        print('\n=== 4. 防空转前置：合法请求必须真的在写快照 ===')
        # 第 3 节那六条「零快照」只有在快照机制本身在跑时才有意义，
        # 否则它们会因为「压根没在写快照」而全部空过。
        code, j = assign(legal)
        check('合法归属 → ok 且 changed=1', bool(j.get('ok')) and j.get('changed') == 1,
              json.dumps(j, ensure_ascii=False)[:120])
        check('合法归属 → 确实落了 1 份 before-person-assign 快照',
              len(snaps(tmp, 'before-person-assign')) == 1, snaps(tmp, 'before-person-assign'))
        check('档案上的归属真的改了（回读）',
              [r.get('person_id') for r in
               call(op, port, '/api/db/rows?table=documents')[1]['rows']] == [legal], '')
        n_before = len(person_snaps(tmp))
        assign(0)
        check('合法之后再吃一次非法请求，快照数不涨（%d → 仍 %d）' % (n_before, n_before),
              len(person_snaps(tmp)) == n_before, len(person_snaps(tmp)))

        print('\n=== 5. 校验文案只有一个来源 ===')
        # 路由返回的 reason 必须与数据层抛出的 StoreError 逐字相同，
        # 否则「改了数据层文案、界面还在念旧文案」这种漂移又会悄悄出现。
        st = S.Store(HERE, data_dir=tmp)
        if not hasattr(st, 'check_assign_target'):
            check('数据层暴露 check_assign_target（路由与 assign_person 共用一处判据）',
                  False, '还没有这个函数')
        else:
            for pid in (0, 99999, 'abc'):
                try:
                    st.check_assign_target(pid)
                    msg = None
                except S.StoreError as e:
                    msg = str(e)
                check('id=%r：路由 reason 与数据层抛错文本逐字相同' % pid,
                      msg is not None and assign(pid)[1].get('reason') == msg,
                      '%r vs %r' % (msg, assign(pid)[1].get('reason')))

        print('\n=== 6. 写入后必须回传服务端分配的真实 id ===')
        # 自增主键由 SQLite 分配。路由不回传 id，前端就只能自己猜：
        # 插入后拿猜出来的 id 去开详情必然「找不到这份档案」；更糟的是这个
        # 假 id 一旦撞上已存在的行，服务端把它当成「更新这条」，会静默改写别人的记录。
        # 所以这里把契约钉死：put 必须回传每行的真实 id，且回读得到同一行。
        code, j = call(op, port, '/api/db/put',
                       {'table': 'documents',
                        'rows': [{'title': 'id 契约用例', 'document_type': '检验报告',
                                  'primary_date': '2025-02-02', 'date_status': '已确认'}]})
        ids = j.get('ids') or []
        check('put 回传 1 个 id', len(ids) == 1 and ids[0] is not None, json.dumps(j)[:120])
        rows = call(op, port, '/api/db/rows?table=documents')[1]['rows']
        hit = [r for r in rows if r.get('title') == 'id 契约用例']
        check('回传的 id 就是落库那一行的真实 id',
              len(hit) == 1 and hit[0].get('id') == ids[0],
              'ids=%r 落库=%r' % (ids, [r.get('id') for r in hit]))

        # 自增序列可能因为此前的删除而走在最大 id 前面 —— 前端照着「最大 id + 1」
        # 猜出来的值就会与实际分配值错开。这里删掉刚写的那行再写一行，
        # 模拟同一个场景，要求仍然回传真实 id。
        call(op, port, '/api/db/delete', {'table': 'documents', 'ids': ids})
        code, j2 = call(op, port, '/api/db/put',
                        {'table': 'documents',
                         'rows': [{'title': 'id 契约用例·删后重写', 'document_type': '检验报告',
                                   'primary_date': '2025-02-03', 'date_status': '已确认'}]})
        ids2 = j2.get('ids') or []
        rows2 = call(op, port, '/api/db/rows?table=documents')[1]['rows']
        hit2 = [r for r in rows2 if r.get('title') == 'id 契约用例·删后重写']
        check('删掉最大 id 之后再写：回传的仍是真实 id（不是「最大 id + 1」）',
              len(hit2) == 1 and hit2[0].get('id') == ids2[0],
              'ids=%r 落库=%r' % (ids2, [r.get('id') for r in hit2]))

        # 带一个不存在的 id 写入时，服务端应把它当新增（而不是出错或写空）
        code, j3 = call(op, port, '/api/db/put',
                        {'table': 'documents',
                         'rows': [{'id': 99999999, 'title': '幽灵 id 用例',
                                   'document_type': '检验报告', 'primary_date': '2025-02-04',
                                   'date_status': '已确认'}]})
        ids3 = j3.get('ids') or []
        rows3 = call(op, port, '/api/db/rows?table=documents')[1]['rows']
        check('带名单外的 id 写入 → 当作新增，并回传真实 id',
              len([r for r in rows3 if r.get('title') == '幽灵 id 用例']) == 1
              and ids3 and ids3[0] != 99999999, json.dumps(j3)[:120])

        return finish(proc, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def finish(proc, tmp):
    if proc is not None:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    print('\n路由用例：通过 %d 项，失败 %d 项' % (PASS, len(FAIL)))
    for f in FAIL:
        print('  失败：%s' % f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
