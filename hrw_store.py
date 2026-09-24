# -*- coding: utf-8 -*-
"""
个人健康档案工作台 · 本地数据存储（SQLite）
================================================================
数据落在项目目录下的 data/ 里，全部是本机磁盘上的普通文件：

    data/health.db          四张表（SQLite 单文件）
    data/files/             原始附件（磁盘原文件，可直接双击打开）
    data/snapshots/         自动快照（JSON，含附件，用于误操作回退）
    data/parse-log.jsonl    每次解析的记录（文件名/页数/字数/耗时）

为什么不用浏览器的 IndexedDB：
    浏览器里点一次「清除浏览数据」会把 IndexedDB 一起清掉，而健康档案
    属于要长期留存的资料，不适合放在一个随时可能被整体清除的容器里。
    放进磁盘文件后，复制 data 目录即完成备份，换电脑也能整体搬走。

只用 Python 标准库，不引入任何第三方依赖。
"""

import base64
import datetime
import hashlib
import json
import os
import re
import shutil
import sqlite3
import threading

TABLES = ['health_records', 'drugs', 'indicator_catalog', 'daily_indicator_records']
BACKUP_SCHEMA = 'health-records-local-backup/v1'
SNAPSHOT_KEEP = 20          # 自动快照保留份数
MAX_PARSE_LOG = 500         # 解析记录保留条数

# 家庭成员：首次使用时预置。id 一旦分配就不再复用，删除成员后也不会重排。
# role 是关系标签（固定），name 是显示名（用户可改，比如把「儿子」改成小名）。
DEFAULT_PERSONS = [
    {'id': 1, 'name': '我', 'role': 'self', 'note': '', 'gender': '男'},
    {'id': 2, 'name': '老婆', 'role': 'spouse', 'note': '', 'gender': '女'},
    {'id': 3, 'name': '儿子', 'role': 'son', 'note': '', 'gender': '男'},
    {'id': 4, 'name': '爸爸', 'role': 'father', 'note': '', 'gender': '男'},
    {'id': 5, 'name': '妈妈', 'role': 'mother', 'note': '', 'gender': '女'},
    {'id': 6, 'name': '丈母娘', 'role': 'mother_in_law', 'note': '', 'gender': '女'},
]


class StoreError(Exception):
    """数据层可预期的失败（调用方据此返回失败，不静默吞掉）。"""


def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def safe_name(name):
    """把外部传入的名字收敛成安全的文件名，保留中文与扩展名。"""
    base = os.path.basename(str(name or 'file'))
    base = re.sub(r'[^\w\u4e00-\u9fff.\-]+', '_', base).strip('._')
    return (base or 'file')[:80]


class Store(object):
    """四张表 + 附件 + 备份 + 解析日志的唯一入口。线程安全。"""

    def __init__(self, root, data_dir=None):
        self.root = os.path.abspath(root)
        # 允许指定数据目录：自动化测试要跑在临时目录里，不能碰真实数据
        self.data_dir = os.path.abspath(data_dir) if data_dir else os.path.join(self.root, 'data')
        self.db_path = os.path.join(self.data_dir, 'health.db')
        self.files_dir = os.path.join(self.data_dir, 'files')
        self.snap_dir = os.path.join(self.data_dir, 'snapshots')
        self.log_path = os.path.join(self.data_dir, 'parse-log.jsonl')
        self._lock = threading.RLock()
        for d in (self.data_dir, self.files_dir, self.snap_dir):
            os.makedirs(d, exist_ok=True)
        self._init_db()
        # 回收站里超过 7 天的内容顺手清掉；失败不影响启动
        try:
            self.prune_trash()
        except Exception:
            pass
        # 成员名单：首次运行写入预置的六个（我/老婆/儿子/爸爸/妈妈/丈母娘）。
        # 失败不挡住启动 —— 没有成员名单时退化成「不显示成员筛选」，而不是起不来。
        try:
            self.ensure_persons()
        except Exception:
            pass

    # ------------------------------------------------------------ 内部

    def _conn(self):
        c = sqlite3.connect(self.db_path, timeout=15)
        c.row_factory = sqlite3.Row
        return c

    def _init_db(self):
        with self._lock:
            c = self._conn()
            try:
                for t in TABLES:
                    c.execute('CREATE TABLE IF NOT EXISTS "%s" ('
                              'id INTEGER PRIMARY KEY, payload TEXT NOT NULL)' % t)
                c.execute('CREATE TABLE IF NOT EXISTS files ('
                          'path TEXT PRIMARY KEY, disk_name TEXT NOT NULL, name TEXT, '
                          'mime_type TEXT, size INTEGER, uploaded_at TEXT)')
                c.execute('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
                c.commit()
            finally:
                c.close()
        # V2 关系型表只在「已跑过 migrate.py」的库上补建（schema.sql 全是
        # IF NOT EXISTS，迁移后再启动时补上新版本新增的表/索引）。
        # 没迁移过的库（全新库、自测库）保持纯旧表 —— 否则旧界面读 drugs
        # 这类表会撞上没有 payload 列的关系表，直接 500。
        if self._migration_done():
            self._shelve_legacy_drugs()
            self._init_v2_schema()

    def _migration_done(self):
        try:
            with self._lock:
                c = self._conn()
                try:
                    names = {r[0] for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
                    if 'migration_log' not in names:
                        return False
                    return c.execute('SELECT COUNT(*) FROM migration_log').fetchone()[0] > 0
                finally:
                    c.close()
        except Exception:
            return False

    def _shelve_legacy_drugs(self):
        try:
            with self._lock:
                c = self._conn()
                try:
                    names = {r[0] for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
                    if 'drugs' not in names or 'legacy_drugs' in names:
                        return
                    cols = [r[1] for r in c.execute('PRAGMA table_info(drugs)').fetchall()]
                    if not cols or not set(cols) <= {'id', 'payload'}:
                        return
                    c.execute('ALTER TABLE drugs RENAME TO legacy_drugs')
                    c.commit()
                finally:
                    c.close()
        except Exception:
            pass

    def _init_v2_schema(self):
        """建 V2 关系表。schema.sql 全用 IF NOT EXISTS，重复执行无副作用。"""
        path = os.path.join(self.root, 'schema.sql')
        if not os.path.exists(path):
            return
        try:
            with open(path, encoding='utf-8') as fh:
                sql = fh.read()
            with self._lock:
                c = self._conn()
                try:
                    c.executescript(sql)
                    c.commit()
                finally:
                    c.close()
        except Exception:
            # 建表失败不该让整个工作台起不来；旧功能仍可用
            pass

    def _check_table(self, table):
        if table not in TABLES:
            raise StoreError('未知的数据表：%s' % table)

    def _next_id(self, c, table):
        row = c.execute('SELECT MAX(id) FROM "%s"' % table).fetchone()
        return int(row[0] or 0)

    # ------------------------------------------------------------ 四张表

    # ------------------------------------------------------------ V2 兼容层
    #
    # 旧前端到处在读 health_records / drugs 这些「文档式」表。重构后数据是关系型的，
    # 但不必把前端每一处都改掉：这里让旧表名继续可读可写，背后走新表。
    # 读：有 legacy_payload 就直接给（与旧结构逐字段一致），没有则现场组装。
    # 写：拆进关系列，同时把整条 JSON 存成 legacy_payload，保证下一次读得回来。

    def _v2_ready(self):
        """V2 是否真正接管。必须同时满足：
        ① 关系表在；② migration_log 里有已完成的迁移记录。
        只查表存在是不够的 —— _init_db 会在任何库上自动建好空 V2 表，
        没跑过 migrate.py 的库（比如自测用的全新库）应该继续走旧表旧界面。"""
        if getattr(self, '_v2_cache', None) is not None:
            return self._v2_cache
        ok = False
        try:
            c = self._conn()
            try:
                names = {r[0] for r in c.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
                ok = ('documents' in names and 'observations' in names
                      and 'migration_log' in names
                      and c.execute('SELECT COUNT(*) FROM migration_log').fetchone()[0] > 0)
            finally:
                c.close()
        except Exception:
            ok = False
        self._v2_cache = ok
        return ok

    def _documents_as_legacy(self):
        """documents 表 → 旧 health_records 的 payload 列表。"""
        c = self._conn()
        try:
            docs = c.execute('SELECT * FROM documents ORDER BY id').fetchall()
            out = []
            for d in docs:
                if d['legacy_payload']:
                    try:
                        obj = json.loads(d['legacy_payload'])
                        obj['id'] = d['id']
                        out.append(obj)
                        continue
                    except Exception:
                        pass
                out.append(self._build_legacy_payload(c, d))
            return out
        finally:
            c.close()

    @staticmethod
    def _build_legacy_payload(c, d):
        """没有 legacy_payload 时，从关系列现场拼一个旧结构出来。"""
        labs = []
        for o in c.execute(
                'SELECT o.*, i.name AS iname FROM observations o '
                'JOIN indicators i ON i.id=o.indicator_id '
                'WHERE o.document_id=? AND o.source=? ORDER BY o.id', (d['id'], 'report')):
            labs.append({'name': o['iname'], 'result': o['value'], 'unit': o['unit'],
                         'reference': o['reference'], 'flag': o['flag'],
                         'condition': o['condition']})
        charges = [{'name': ch['name'],
                    'amount': None if ch['amount_cents'] is None else ch['amount_cents'] / 100.0,
                    'category': ch['category'], 'quantity': ch['quantity']}
                   for ch in c.execute(
                       'SELECT * FROM charge_items WHERE document_id=? ORDER BY id', (d['id'],))]
        amount = None if d['amount_cents'] is None else d['amount_cents'] / 100.0
        return {
            'id': d['id'], 'person_id': d['person_id'],
            'document_type': d['document_type'], 'title': d['title'],
            'hospital': d['hospital'], 'department': d['department'], 'doctor': d['doctor'],
            'primary_date': d['primary_date'], 'date_status': d['date_status'],
            'amount': amount, 'source_file': d['source_file'],
            'parsed_content': d['parsed_content'], 'key_information': d['key_information'],
            'owner_id': 'local-user',
            'type_specific_data': {
                'lab_results': labs, 'charge_items': charges,
                'total_amount': amount, 'insurance_payment': None, 'self_payment': None,
            },
            'created_at': d['created_at'], 'updated_at': d['updated_at'],
        }

    def _drugs_as_legacy(self):
        c = self._conn()
        try:
            rows = c.execute('SELECT * FROM drugs ORDER BY id').fetchall()
            out = []
            for d in rows:
                if d['legacy_payload']:
                    try:
                        obj = json.loads(d['legacy_payload'])
                        obj['id'] = d['id']
                        out.append(obj)
                        continue
                    except Exception:
                        pass
                out.append({'id': d['id'], 'person_id': d['person_id'], 'name': d['name'],
                            'spec': d['spec'], 'dosage': d['dosage'],
                            'frequency': d['frequency'], 'start_date': d['start_date'],
                            'end_date': d['end_date'], 'status': d['status'],
                            'note': d['note'], 'owner_id': 'local-user',
                            'created_at': d['created_at'], 'updated_at': d['updated_at']})
            return out
        finally:
            c.close()

    def _catalog_as_legacy(self):
        """指标目录：新架构下由 indicators 表生成，不再是一份手写清单。"""
        c = self._conn()
        try:
            rows = c.execute('SELECT * FROM indicators ORDER BY id').fetchall()
            out = []
            for i in rows:
                aliases = [r['alias'] for r in c.execute(
                    'SELECT alias FROM indicator_aliases WHERE indicator_id=?', (i['id'],))]
                out.append({'id': i['id'], 'key': i['key'], 'name': i['name'],
                            'aliases': aliases, 'unit': i['unit'],
                            'category': i['category'], 'is_text': i['is_text']})
            return out
        finally:
            c.close()

    def read_all(self, table):
        self._check_table(table)
        if self._v2_ready():
            if table == 'health_records':
                return self._documents_as_legacy()
            if table == 'drugs':
                return self._drugs_as_legacy()
            if table == 'indicator_catalog':
                return self._catalog_as_legacy()
        c = self._conn()
        try:
            rows = c.execute('SELECT payload FROM "%s" ORDER BY id' % table).fetchall()
            out = []
            for r in rows:
                try:
                    out.append(json.loads(r['payload']))
                except Exception:
                    # 单行损坏不应让整张表读不出来；跳过并继续
                    continue
            return out
        except sqlite3.OperationalError:
            # 物理表不是 (id, payload) 结构（例如被别的工具动过），按空表处理，
            # 不让一次 500 卡死整个旧界面。
            return []
        finally:
            c.close()

    def _indicator_id_for(self, c, raw_name, unit=None, panel=None, value=None):
        """给一个检验项名字找到（或新建）它的指标。新报告进来时会用到。"""
        import hrw_indicators as I
        std = I.standardize(raw_name)
        if not std:
            return None
        # RDW 裸名按单位分流（与 hrw_indicators.resolve 的规则保持一致）：
        # fL 是 RDW-SD，% 是 RDW-CV，混在一起趋势没法看。
        if re.match(u'^红细胞分布宽度(\\((rdw)\\))?$', std, re.IGNORECASE):
            u = I.standardize_unit(unit)
            bare_key = 'rdw_sd' if u.lower() == 'fl' else 'rdw_cv'
            row = c.execute('SELECT id FROM indicators WHERE key=?', (bare_key,)).fetchone()
            if row:
                c.execute('INSERT OR IGNORE INTO indicator_aliases (indicator_id, alias, raw_alias) '
                          'VALUES (?,?,?)', (row['id'], std, raw_name))
                return row['id']
        row = c.execute('SELECT indicator_id FROM indicator_aliases WHERE alias=?',
                        (std,)).fetchone()
        if row:
            return row['indicator_id']
        base = I.strip_abbrev(std)
        if base != std:
            row = c.execute('SELECT indicator_id FROM indicator_aliases WHERE alias=?',
                            (base,)).fetchone()
            if row:
                c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias) '
                          'VALUES (?,?,?)', (row['indicator_id'], std, raw_name))
                return row['indicator_id']
        # 目录里确实没有：登记成一个新指标，下次再遇到就认得
        cat = I.guess_category(std, panel)
        is_text = 1 if I.guess_is_text(std, [value]) else 0
        key = 'auto_%s' % std
        if c.execute('SELECT id FROM indicators WHERE key=?', (key,)).fetchone():
            key = '%s_%d' % (key, abs(hash(std)) % 100000)
        cur = c.execute(
            'INSERT INTO indicators (key, name, category, unit, is_text, meta, created_at) '
            'VALUES (?,?,?,?,?,?,?)',
            (key, std, cat, unit or '', is_text,
             json.dumps({'from': 'runtime'}, ensure_ascii=False), now_iso()))
        ind_id = cur.lastrowid
        c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias, is_canonical) '
                  'VALUES (?,?,?,1)', (ind_id, std, raw_name))
        return ind_id

    def _upsert_documents(self, rows):
        """写档案：拆进 documents 关系列，同时把检验项落成观测值。"""
        n = 0
        with self._lock:
            c = self._conn()
            try:
                for r in (rows or []):
                    if not isinstance(r, dict):
                        continue
                    tsd = r.get('type_specific_data') or {}
                    person_id = r.get('person_id')
                    try:
                        person_id = int(person_id) if person_id not in (None, '') else None
                    except (TypeError, ValueError):
                        person_id = None
                    amount = r.get('amount')
                    if amount in (None, ''):
                        amount = tsd.get('total_amount')
                    cents = None
                    if amount not in (None, ''):
                        try:
                            cents = int(round(float(str(amount).replace(',', '').replace(
                                u'¥', '').strip()) * 100))
                        except (TypeError, ValueError):
                            cents = None
                    payload = json.dumps(r, ensure_ascii=False)
                    rid = r.get('id')
                    fields = (person_id, r.get('document_type') or u'其他', r.get('title'),
                              r.get('hospital'), r.get('department'), r.get('doctor'),
                              r.get('primary_date'), r.get('date_status') or u'已确认',
                              cents, tsd.get('amount_in_words'), r.get('source_file'),
                              r.get('parsed_content'), r.get('key_information'),
                              payload, r.get('created_at') or now_iso(), now_iso())
                    try:
                        rid_int = int(rid) if rid not in (None, '') else None
                    except (TypeError, ValueError):
                        rid_int = None
                    if rid_int and c.execute('SELECT id FROM documents WHERE id=?',
                                             (rid_int,)).fetchone():
                        c.execute('UPDATE documents SET person_id=?, document_type=?, title=?, '
                                  'hospital=?, department=?, doctor=?, primary_date=?, '
                                  'date_status=?, amount_cents=?, amount_in_words=?, '
                                  'source_file=?, parsed_content=?, key_information=?, '
                                  'legacy_payload=?, created_at=?, updated_at=? WHERE id=?',
                                  fields + (rid_int,))
                        doc_id = rid_int
                        # 观测值整份重来：报告可能被编辑过，逐条比对反而容易留残
                        c.execute('DELETE FROM observations WHERE document_id=? AND source=?',
                                  (doc_id, 'report'))
                        c.execute('DELETE FROM charge_items WHERE document_id=?', (doc_id,))
                    else:
                        cur = c.execute(
                            'INSERT INTO documents (person_id, document_type, title, hospital, '
                            'department, doctor, primary_date, date_status, amount_cents, '
                            'amount_in_words, source_file, parsed_content, key_information, '
                            'legacy_payload, created_at, updated_at) '
                            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', fields)
                        doc_id = cur.lastrowid
                        r['id'] = doc_id

                    obs_date = r.get('primary_date')
                    if obs_date:
                        for it in (tsd.get('lab_results') or []):
                            if not isinstance(it, dict) or not it.get('name'):
                                continue
                            ind_id = self._indicator_id_for(
                                c, it.get('name'), it.get('unit'), it.get('condition'),
                                it.get('result'))
                            if not ind_id:
                                continue
                            import hrw_indicators as I
                            val = it.get('result')
                            c.execute(
                                'INSERT INTO observations (person_id, indicator_id, document_id, '
                                'obs_date, value, numeric_value, unit, reference, flag, '
                                'condition, panel, source, created_at) '
                                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                (person_id, ind_id, doc_id, obs_date,
                                 '' if val is None else str(val), I.parse_numeric(val),
                                 I.standardize_unit(it.get('unit')), it.get('reference'),
                                 it.get('flag'), it.get('condition'), it.get('condition'),
                                 'report', now_iso()))
                    for ch in (tsd.get('charge_items') or []):
                        if not isinstance(ch, dict):
                            continue
                        amt = ch.get('amount')
                        ch_cents = None
                        if amt not in (None, ''):
                            try:
                                ch_cents = int(round(float(str(amt).replace(',', '')) * 100))
                            except (TypeError, ValueError):
                                ch_cents = None
                        c.execute('INSERT INTO charge_items (document_id, name, amount_cents, '
                                  'category, quantity) VALUES (?,?,?,?,?)',
                                  (doc_id, ch.get('name'), ch_cents, ch.get('category'),
                                   ch.get('quantity')))
                    n += 1
                c.commit()
            finally:
                c.close()
        return n

    def _upsert_drugs_v2(self, rows):
        n = 0
        with self._lock:
            c = self._conn()
            try:
                for r in (rows or []):
                    if not isinstance(r, dict):
                        continue
                    person_id = r.get('person_id')
                    try:
                        person_id = int(person_id) if person_id not in (None, '') else None
                    except (TypeError, ValueError):
                        person_id = None
                    payload = json.dumps(r, ensure_ascii=False)
                    vals = (person_id, r.get('name'), r.get('spec'), r.get('dosage'),
                            r.get('frequency'), r.get('start_date'), r.get('end_date'),
                            r.get('status'), r.get('note'), payload,
                            r.get('created_at') or now_iso(), now_iso())
                    rid = r.get('id')
                    try:
                        rid_int = int(rid) if rid not in (None, '') else None
                    except (TypeError, ValueError):
                        rid_int = None
                    if rid_int and c.execute('SELECT id FROM drugs WHERE id=?',
                                             (rid_int,)).fetchone():
                        c.execute('UPDATE drugs SET person_id=?, name=?, spec=?, dosage=?, '
                                  'frequency=?, start_date=?, end_date=?, status=?, note=?, '
                                  'legacy_payload=?, created_at=?, updated_at=? WHERE id=?',
                                  vals + (rid_int,))
                    else:
                        cur = c.execute(
                            'INSERT INTO drugs (person_id, name, spec, dosage, frequency, '
                            'start_date, end_date, status, note, legacy_payload, created_at, '
                            'updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', vals)
                        r['id'] = cur.lastrowid
                    n += 1
                c.commit()
            finally:
                c.close()
        return n

    def upsert(self, table, rows):
        """按 id 覆盖写；没有 id 的行由本层分配自增主键。返回写入条数。"""
        self._check_table(table)
        if self._v2_ready():
            if table == 'health_records':
                return self._upsert_documents(rows)
            if table == 'drugs':
                return self._upsert_drugs_v2(rows)
        n = 0
        with self._lock:
            c = self._conn()
            try:
                maxid = self._next_id(c, table)
                for r in (rows or []):
                    if not isinstance(r, dict):
                        continue
                    rid = r.get('id')
                    if rid is None or str(rid).strip() == '':
                        maxid += 1
                        rid = maxid
                        r = dict(r)
                        r['id'] = rid
                    try:
                        rid_int = int(rid)
                    except (TypeError, ValueError):
                        raise StoreError('主键必须可转为整数，收到：%r' % (rid,))
                    c.execute(
                        'INSERT INTO "%s" (id, payload) VALUES (?, ?) '
                        'ON CONFLICT(id) DO UPDATE SET payload=excluded.payload' % table,
                        (rid_int, json.dumps(r, ensure_ascii=False)))
                    n += 1
                c.commit()
            finally:
                c.close()
        return n

    def delete(self, table, ids):
        self._check_table(table)
        key = []
        for i in (ids or []):
            try:
                key.append(int(i))
            except (TypeError, ValueError):
                continue
        if not key:
            return 0
        # 删档案要连观测值一起删，否则会留下查不到主人的孤儿指标点
        if self._v2_ready() and table == 'health_records':
            with self._lock:
                c = self._conn()
                try:
                    marks = ','.join('?' * len(key))
                    c.execute('DELETE FROM observations WHERE document_id IN (%s)' % marks, key)
                    c.execute('DELETE FROM charge_items WHERE document_id IN (%s)' % marks, key)
                    cur = c.execute('DELETE FROM documents WHERE id IN (%s)' % marks, key)
                    c.commit()
                    return cur.rowcount or 0
                finally:
                    c.close()
        if self._v2_ready() and table == 'drugs':
            with self._lock:
                c = self._conn()
                try:
                    marks = ','.join('?' * len(key))
                    cur = c.execute('DELETE FROM drugs WHERE id IN (%s)' % marks, key)
                    c.commit()
                    return cur.rowcount or 0
                finally:
                    c.close()
        with self._lock:
            c = self._conn()
            try:
                q = 'DELETE FROM "%s" WHERE id IN (%s)' % (table, ','.join('?' * len(key)))
                cur = c.execute(q, key)
                c.commit()
                return cur.rowcount or 0
            finally:
                c.close()

    @staticmethod
    def attach_paths(row):
        """一行记录引用的附件路径。前端写在 source_attachments，可能是 JSON 字符串。"""
        a = (row or {}).get('source_attachments')
        if isinstance(a, str):
            try:
                a = json.loads(a)
            except ValueError:
                a = []
        out = []
        for it in (a if isinstance(a, list) else []):
            if isinstance(it, dict) and it.get('path'):
                out.append(str(it['path']))
        return out

    def referenced_file_paths(self):
        """四张表当前仍在引用的附件路径集合（档案与药品共用一个附件池）。"""
        seen = set()
        for t in TABLES:
            for row in self.read_all(t):
                seen.update(self.attach_paths(row))
        return seen

    def _drop_file(self, path):
        """删掉一个附件的磁盘文件与 files 登记。返回 (是否干净删掉, 原因)。

        先删文件、后删登记：反过来的话文件删不掉就变成一条查不到主人的孤儿登记。
        """
        c = self._conn()
        try:
            r = c.execute('SELECT disk_name FROM files WHERE path=?', (path,)).fetchone()
        finally:
            c.close()
        if not r:
            return False, '附件从未登记（可能导入的是残缺备份）'
        disk = os.path.join(self.files_dir, r['disk_name'])
        if os.path.exists(disk):
            if not self._trash_file(disk):
                return False, '文件删不掉，可能被其他程序打开'
        c = self._conn()
        try:
            c.execute('DELETE FROM files WHERE path=?', (path,))
            c.commit()
        finally:
            c.close()
        return True, ''

    def delete_records(self, table, ids):
        """删记录，并顺带清理因此不再被任何记录引用的附件（磁盘文件一并删）。

        动手前一定先打快照：附件是 base64 内嵌在快照里的，物理删掉的文件只有靠
        这份快照才能找回来。快照写不出来就中止——不做没有退路的删除。
        """
        self._check_table(table)
        key = []
        for i in (ids or []):
            try:
                n = int(i)
            except (TypeError, ValueError):
                raise StoreError('记录 id 不合法：%r' % (i,))
            if n not in key:
                key.append(n)
        if not key:
            return {'deleted': 0, 'files_removed': [], 'files_failed': [],
                    'snapshot': None, 'missing': []}

        by_id = {int(r['id']): r for r in self.read_all(table) if r.get('id') is not None}
        missing = [n for n in key if n not in by_id]
        targets = [by_id[n] for n in key if n in by_id]
        if not targets:
            return {'deleted': 0, 'files_removed': [], 'files_failed': [],
                    'snapshot': None, 'missing': missing}

        snap = self.snapshot('before-delete')
        if not snap:
            raise StoreError('删除前的快照没能写入，已中止删除，数据未改动')

        touched = set()
        for r in targets:
            touched.update(self.attach_paths(r))

        deleted = self.delete(table, key)

        # 只有删完之后才知道哪些附件彻底没人引用了：同一张图可能被两条记录共用
        still = self.referenced_file_paths()
        removed, failed = [], []
        for p in sorted(touched):
            if p in still:
                continue
            ok, why = self._drop_file(p)
            if ok:
                removed.append(p)
            else:
                failed.append({'path': p, 'reason': why})
        return {'deleted': deleted, 'files_removed': removed, 'files_failed': failed,
                'kept_referenced': sorted(p for p in touched if p in still),
                'snapshot': snap, 'missing': missing}

    def clear_table(self, table):
        self._check_table(table)
        if self._v2_ready() and table == 'health_records':
            with self._lock:
                c = self._conn()
                try:
                    c.execute('DELETE FROM observations')
                    c.execute('DELETE FROM charge_items')
                    c.execute('DELETE FROM documents')
                    c.commit()
                finally:
                    c.close()
            return
        if self._v2_ready() and table == 'drugs':
            with self._lock:
                c = self._conn()
                try:
                    c.execute('DELETE FROM drugs')
                    c.commit()
                finally:
                    c.close()
            return
        with self._lock:
            c = self._conn()
            try:
                c.execute('DELETE FROM "%s"' % table)
                c.commit()
            finally:
                c.close()

    def clear_tables(self):
        with self._lock:
            c = self._conn()
            try:
                for t in TABLES:
                    c.execute('DELETE FROM "%s"' % t)
                if self._v2_ready():
                    for t in ('observations', 'charge_items', 'documents', 'drugs',
                              'watched_indicators'):
                        c.execute('DELETE FROM "%s"' % t)
                c.commit()
            finally:
                c.close()

    def counts(self):
        out = {}
        with self._lock:
            c = self._conn()
            try:
                for t in TABLES:
                    out[t] = c.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0]
            finally:
                c.close()
        return out

    def is_empty(self):
        return sum(self.counts().values()) == 0

    # ------------------------------------------------------------ 附件

    def put_file(self, path, name, mime_type, blob, uploaded_at=None):
        """写附件。同一个 path 重复写入会覆盖旧文件并清掉旧副本。"""
        if not path:
            raise StoreError('附件路径为空')
        if blob is None:
            raise StoreError('附件内容为空')
        with self._lock:
            c = self._conn()
            try:
                old = c.execute('SELECT disk_name FROM files WHERE path=?', (path,)).fetchone()
                h = hashlib.sha1(str(path).encode('utf-8')).hexdigest()[:16]
                disk_name = h + '_' + safe_name(name or path)
                full = os.path.join(self.files_dir, disk_name)
                try:
                    with open(full, 'wb') as fh:
                        fh.write(blob)
                except OSError as e:
                    raise StoreError('附件写入磁盘失败：%s' % e)
                if old and old['disk_name'] and old['disk_name'] != disk_name:
                    try:
                        os.remove(os.path.join(self.files_dir, old['disk_name']))
                    except OSError:
                        pass
                c.execute(
                    'INSERT INTO files (path, disk_name, name, mime_type, size, uploaded_at) '
                    'VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET '
                    'disk_name=excluded.disk_name, name=excluded.name, '
                    'mime_type=excluded.mime_type, size=excluded.size, '
                    'uploaded_at=excluded.uploaded_at',
                    (path, disk_name, name or path, mime_type or 'application/octet-stream',
                     len(blob), uploaded_at or now_iso()))
                c.commit()
                return {'path': path, 'disk_name': disk_name, 'size': len(blob)}
            finally:
                c.close()

    def get_file(self, path):
        if not path:
            return None
        c = self._conn()
        try:
            r = c.execute('SELECT * FROM files WHERE path=?', (path,)).fetchone()
        finally:
            c.close()
        if not r:
            return None
        full = os.path.join(self.files_dir, r['disk_name'])
        if not os.path.exists(full):
            # 元信息还在但文件被删了：如实返回 None，不返回空内容冒充
            return None
        with open(full, 'rb') as fh:
            blob = fh.read()
        return {
            'path': r['path'], 'name': r['name'], 'mime_type': r['mime_type'],
            'size': r['size'] if r['size'] is not None else len(blob),
            'uploaded_at': r['uploaded_at'], 'blob': blob,
        }

    def file_meta_list(self):
        c = self._conn()
        try:
            rows = c.execute('SELECT path, name, mime_type, size, uploaded_at '
                             'FROM files ORDER BY uploaded_at').fetchall()
            return [dict(r) for r in rows]
        finally:
            c.close()

    def _trash_file(self, path):
        """把文件移进 data/.trash/<时间戳>/ 而不是直接删除。

        「清空」「批量清理」这类一次删几十个文件的操作，直接删没有反悔余地；
        移动到回收站目录之后，误清空的附件还能找回来。回收站由 prune_trash
        在启动时择机清理。返回是否移动成功（文件本来就不存在也算成功）。"""
        try:
            if not os.path.exists(path):
                return True
            stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
            tdir = os.path.join(self.data_dir, '.trash', stamp)
            os.makedirs(tdir, exist_ok=True)
            dst = os.path.join(tdir, os.path.basename(path))
            n = 0
            while os.path.exists(dst):
                n += 1
                dst = os.path.join(tdir, '%d_%s' % (n, os.path.basename(path)))
            os.replace(path, dst)
            return True
        except OSError:
            return False

    def prune_trash(self, max_age_days=7):
        """清理 data/.trash/ 里超过 max_age_days 天的内容。尽力而为：
        单个文件清不掉（被占用）就跳过，绝不因为回收站影响主功能。"""
        troot = os.path.join(self.data_dir, '.trash')
        if not os.path.isdir(troot):
            return 0
        cutoff = datetime.datetime.now() - datetime.timedelta(days=max_age_days)
        removed = 0
        for stamp in os.listdir(troot):
            tdir = os.path.join(troot, stamp)
            try:
                when = datetime.datetime.strptime(stamp, '%Y%m%d-%H%M%S')
            except ValueError:
                continue
            if when >= cutoff:
                continue
            try:
                for name in os.listdir(tdir):
                    try:
                        os.remove(os.path.join(tdir, name))
                        removed += 1
                    except OSError:
                        pass
                os.rmdir(tdir)
            except OSError:
                pass
        return removed

    def clear_files(self):
        with self._lock:
            c = self._conn()
            try:
                rows = c.execute('SELECT disk_name FROM files').fetchall()
                c.execute('DELETE FROM files')
                c.commit()
            finally:
                c.close()
            for r in rows:
                self._trash_file(os.path.join(self.files_dir, r['disk_name']))

    def file_stats(self):
        meta = self.file_meta_list()
        return {'files': len(meta), 'fileBytes': sum(int(m.get('size') or 0) for m in meta)}

    # ------------------------------------------------------------ meta 键值对

    def get_meta(self, k, default=None):
        """读取 meta 表的一个键。行不存在或损坏时返回 default，不抛异常。"""
        c = self._conn()
        try:
            row = c.execute('SELECT v FROM meta WHERE k=?', (k,)).fetchone()
        finally:
            c.close()
        if not row:
            return default
        try:
            return json.loads(row['v'])
        except Exception:
            return default

    def set_meta(self, k, v):
        with self._lock:
            c = self._conn()
            try:
                c.execute('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
                          (k, json.dumps(v, ensure_ascii=False)))
                c.commit()
            finally:
                c.close()
        return v

    def meta_all(self):
        """导出全部 meta（供备份使用）。"""
        c = self._conn()
        try:
            return {r['k']: r['v'] for r in c.execute('SELECT k, v FROM meta').fetchall()}
        finally:
            c.close()

    def replace_meta(self, obj):
        """整表替换 meta（供恢复使用）。非 dict 时拒绝，一个字节都不写。"""
        if not isinstance(obj, dict):
            raise StoreError('meta 内容不是对象')
        with self._lock:
            c = self._conn()
            try:
                c.execute('DELETE FROM meta')
                for k, v in obj.items():
                    c.execute('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
                              (str(k), str(v)))
                c.commit()
            finally:
                c.close()

    # ------------------------------------------------------------ 家庭成员

    def ensure_persons(self):
        """首次使用时写入预置成员。已有则不覆盖用户改过的名单。返回成员列表。"""
        cur = self.get_meta('persons')
        if isinstance(cur, list) and cur:
            return cur
        seed = json.loads(json.dumps(DEFAULT_PERSONS, ensure_ascii=False))
        for p in seed:
            p['created_at'] = now_iso()
        self.set_meta('persons', seed)
        return seed

    def persons(self):
        return self.ensure_persons()

    def save_persons(self, persons):
        """整体保存成员名单。会校验结构，非法时抛 StoreError 且不写入。"""
        if not isinstance(persons, list):
            raise StoreError('成员名单不是列表')
        seen = set()
        out = []
        for p in persons:
            if not isinstance(p, dict):
                raise StoreError('成员项不是对象')
            name = str(p.get('name') or '').strip()
            if not name:
                raise StoreError('成员名称不能为空')
            pid = p.get('id')
            try:
                pid = int(pid)
            except (TypeError, ValueError):
                raise StoreError('成员 id 不是整数：%s' % pid)
            if pid <= 0:
                raise StoreError('成员 id 必须为正整数')
            if pid in seen:
                raise StoreError('成员 id 重复：%s' % pid)
            seen.add(pid)
            # 性别只允许 男/女 或留空：留空 = 不按性别过滤指标（新成员未设置时）
            gender = str(p.get('gender') or '').strip()
            if gender not in (u'男', u'女'):
                gender = ''
            out.append({
                'id': pid,
                'name': name[:20],
                'role': str(p.get('role') or 'custom').strip()[:20],
                'gender': gender,
                'note': str(p.get('note') or '').strip()[:100],
                'created_at': p.get('created_at') or now_iso(),
            })
        self.set_meta('persons', out)
        return out

    def next_person_id(self):
        cur = self.persons()
        return max([int(p.get('id') or 0) for p in cur] or [0]) + 1

    def person_gender(self, person_id):
        """成员的性别（'男'/'女'）；成员不存在或未设置时返回 None，不做过滤。"""
        try:
            pid = int(person_id)
        except (TypeError, ValueError):
            return None
        for p in self.persons():
            try:
                if int(p.get('id') or 0) == pid:
                    g = str(p.get('gender') or '').strip()
                    return g or None
            except (TypeError, ValueError):
                continue
        return None

    @staticmethod
    def check_person_id(person_id):
        """成员 id 只能是整数。路由在打快照之前先问一次，见 check_assign_target 的说明。"""
        try:
            return int(person_id)
        except (TypeError, ValueError):
            raise StoreError('成员 id 不是整数')

    def check_assign_target(self, person_id):
        """批量归属的目标必须真的能归属；合法则返回规范化后的 id。

        单独拆出来是因为快照里带附件正文（真实库实测单份 23~31 MB）：
        先打快照再校验的话，一次点错的下拉框就白写 30 MB。
        0 在界面侧是「未指定」的哨兵，写进 payload 却不等于空值 —— 那样一行既不属于
        任何成员、也不会在「未指定」筛选里出现，等于从所有按人视图消失。名单外 id 同理。
        """
        pid = self.check_person_id(person_id)
        if pid <= 0:
            raise StoreError('归属目标必须是名单里的成员，收到 id=%s（0 代表「未指定」，不能用来归属）' % pid)
        if not any(int(p.get('id') or 0) == pid for p in self.persons()):
            raise StoreError('归属目标不在成员名单里（id=%s）' % pid)
        return pid

    def _resync_legacy_person(self, c, doc_id, pid):
        """改了归属之后，把 legacy_payload 里的 person_id 也同步。

        兼容层是优先读 legacy_payload 的，不同步的话会出现「关系列已经改了、
        页面读出来还是旧归属」这种对不上的情况。
        """
        row = c.execute('SELECT legacy_payload FROM documents WHERE id=?', (doc_id,)).fetchone()
        if not row or not row['legacy_payload']:
            return
        try:
            obj = json.loads(row['legacy_payload'])
        except Exception:
            return
        if not isinstance(obj, dict):
            return
        obj['person_id'] = pid
        c.execute('UPDATE documents SET legacy_payload=? WHERE id=?',
                  (json.dumps(obj, ensure_ascii=False), doc_id))

    def assign_person(self, table, person_id, only_unassigned=True):
        """把某张表的记录批量归属到指定成员。默认只动尚未归属的（不可逆，调用前先打快照）。
        返回实际修改条数。"""
        self._check_table(table)
        pid = self.check_assign_target(person_id)
        if self._v2_ready() and table == 'health_records':
            n = 0
            with self._lock:
                c = self._conn()
                try:
                    rows = c.execute('SELECT id, person_id FROM documents').fetchall()
                    for r in rows:
                        old = r['person_id']
                        if only_unassigned and old is not None and old != '':
                            continue
                        if old == pid:
                            continue
                        c.execute('UPDATE documents SET person_id=? WHERE id=?', (pid, r['id']))
                        c.execute('UPDATE observations SET person_id=? WHERE document_id=?',
                                  (pid, r['id']))
                        self._resync_legacy_person(c, r['id'], pid)
                        n += 1
                    c.commit()
                finally:
                    c.close()
            return n
        n = 0
        with self._lock:
            c = self._conn()
            try:
                rows = c.execute('SELECT id, payload FROM "%s"' % table).fetchall()
                for r in rows:
                    try:
                        obj = json.loads(r['payload'])
                    except Exception:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    old = obj.get('person_id')
                    if only_unassigned and old is not None and old != '':
                        continue
                    if old == pid:
                        continue
                    obj['person_id'] = pid
                    c.execute('UPDATE "%s" SET payload=? WHERE id=?' % table,
                              (json.dumps(obj, ensure_ascii=False), r['id']))
                    n += 1
                c.commit()
            finally:
                c.close()
        return n

    def clear_person(self, table, person_id):
        """把某个成员名下的记录改回「未指定」（删成员时调用，保证文案与结果一致：
        成员删了，档案留着，只是不再挂在任何人名下）。
        返回实际修改条数。"""
        self._check_table(table)
        pid = self.check_person_id(person_id)
        if self._v2_ready() and table == 'health_records':
            n = 0
            with self._lock:
                c = self._conn()
                try:
                    rows = c.execute('SELECT id, person_id FROM documents').fetchall()
                    for r in rows:
                        old = r['person_id']
                        if old is None or old == '':
                            continue
                        try:
                            if int(old) != pid:
                                continue
                        except (TypeError, ValueError):
                            continue
                        c.execute('UPDATE documents SET person_id=NULL WHERE id=?', (r['id'],))
                        c.execute('UPDATE observations SET person_id=NULL WHERE document_id=?',
                                  (r['id'],))
                        self._resync_legacy_person(c, r['id'], None)
                        n += 1
                    c.commit()
                finally:
                    c.close()
            return n
        n = 0
        with self._lock:
            c = self._conn()
            try:
                rows = c.execute('SELECT id, payload FROM "%s"' % table).fetchall()
                for r in rows:
                    try:
                        obj = json.loads(r['payload'])
                    except Exception:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    old = obj.get('person_id')
                    if old is None or old == '':
                        continue
                    try:
                        if int(old) != pid:
                            continue
                    except (TypeError, ValueError):
                        continue
                    obj['person_id'] = None
                    c.execute('UPDATE "%s" SET payload=? WHERE id=?' % table,
                              (json.dumps(obj, ensure_ascii=False), r['id']))
                    n += 1
                c.commit()
            finally:
                c.close()
        return n

    def person_stats(self):
        """统计每个成员名下有多少条档案（health_records）。
        未归属的归到固定键 'none' —— 不能用 None 当键，它经 JSON 序列化
        会变成 "null" 字符串，前端按 none 取就永远取到 0。"""
        out = {}
        for r in self.read_all('health_records'):
            pid = r.get('person_id')
            if pid is None or pid == '':
                key = 'none'
            else:
                try:
                    key = str(int(pid))
                except (TypeError, ValueError):
                    key = 'none'
            out[key] = out.get(key, 0) + 1
        return out

    # ------------------------------------------------------------ 备份

    def export_backup(self):
        tables = {}
        for t in TABLES:
            tables[t] = self.read_all(t)
        files = []
        for m in self.file_meta_list():
            rec = self.get_file(m['path'])
            if not rec:
                continue
            files.append({
                'path': rec['path'], 'name': rec['name'], 'mime_type': rec['mime_type'],
                'size': rec['size'], 'uploaded_at': rec['uploaded_at'],
                'dataBase64': base64.b64encode(rec['blob']).decode('ascii'),
            })
        return {
            'schema': BACKUP_SCHEMA,
            'exported_at': now_iso(),
            'owner': 'local-user',
            'counts': {t: len(tables[t]) for t in TABLES},
            'file_count': len(files),
            'tables': tables,
            'files': files,
            # 成员名单存在 meta 表里。早期备份没有这个键，恢复时会自动跳过。
            'meta': self.meta_all(),
        }

    def import_backup(self, obj):
        """整库替换：先清空再写入。调用方必须已取得用户明确确认。"""
        if not isinstance(obj, dict):
            raise StoreError('备份内容不是对象')
        if obj.get('schema') != BACKUP_SCHEMA:
            raise StoreError('备份格式不匹配（期望 %s，实际 %s）'
                             % (BACKUP_SCHEMA, obj.get('schema')))
        tables = obj.get('tables') or {}
        for t in TABLES:
            if t not in tables:
                raise StoreError('备份缺少数据表：%s' % t)
            if not isinstance(tables[t], list):
                raise StoreError('备份中的 %s 不是列表' % t)

        self.clear_tables()
        self.clear_files()

        written = 0
        for t in TABLES:
            for r in tables[t]:
                if not isinstance(r, dict):
                    raise StoreError('%s 中存在非对象记录' % t)
            self.upsert(t, tables[t])
            written += len(tables[t])

        files_written = 0
        for f in (obj.get('files') or []):
            if not isinstance(f, dict) or not f.get('path'):
                continue
            try:
                blob = base64.b64decode(f.get('dataBase64') or '')
            except Exception:
                raise StoreError('附件 %s 的内容不是合法 base64' % f.get('path'))
            self.put_file(f['path'], f.get('name'), f.get('mime_type'), blob,
                          f.get('uploaded_at'))
            files_written += 1

        # meta（成员名单）不在时一律跳过：旧版备份没有这个键，不能因为缺它就报失败
        meta_written = 0
        if isinstance(obj.get('meta'), dict):
            # 恢复也要带着成员，否则档案回来了、归属的人却没了
            self.replace_meta(obj['meta'])
            meta_written = len(obj['meta'])

        counts = self.counts()
        return {'ok': True, 'errors': [], 'written': written,
                'filesWritten': files_written, 'metaWritten': meta_written,
                'counts': counts}

    def snapshot(self, reason='auto'):
        """写一份 JSON 快照，用于误操作回退。失败不抛出（不能因为快照失败挡住房写入）。"""
        try:
            with self._lock:
                b = self.export_backup()
                base = 'snap-%s-%s' % (
                    datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), safe_name(reason))
                # 时间戳只到秒：连着删几条档案会算出同一个名字，后一份直接盖掉前一份，
                # 「保留 20 份可回退」就变成只剩 1 份。撞名就往后加序号。
                name = base + '.json'
                n = 1
                while os.path.exists(os.path.join(self.snap_dir, name)):
                    n += 1
                    name = '%s-%d.json' % (base, n)
                with open(os.path.join(self.snap_dir, name), 'w', encoding='utf-8') as fh:
                    json.dump(b, fh, ensure_ascii=False)
                snaps = sorted(f for f in os.listdir(self.snap_dir) if f.startswith('snap-'))
                for old in snaps[:-SNAPSHOT_KEEP]:
                    self._trash_file(os.path.join(self.snap_dir, old))
            return name
        except Exception:
            return None

    def snapshot_list(self):
        if not os.path.isdir(self.snap_dir):
            return []
        out = []
        for f in sorted(os.listdir(self.snap_dir), reverse=True):
            if not f.startswith('snap-'):
                continue
            fp = os.path.join(self.snap_dir, f)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            out.append({'name': f, 'size': st.st_size,
                        'mtime': datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')})
        return out

    # ------------------------------------------------------------ 解析记录

    def log_parse(self, rec):
        try:
            rec = dict(rec or {})
            rec.setdefault('at', now_iso())
            with self._lock:
                lines = []
                if os.path.exists(self.log_path):
                    with open(self.log_path, encoding='utf-8', errors='replace') as fh:
                        lines = fh.read().splitlines()
                lines.append(json.dumps(rec, ensure_ascii=False))
                if len(lines) > MAX_PARSE_LOG:
                    lines = lines[-MAX_PARSE_LOG:]
                with open(self.log_path, 'w', encoding='utf-8') as fh:
                    fh.write('\n'.join(lines) + '\n')
        except Exception:
            pass

    def read_parse_log(self, limit=50):
        if not os.path.exists(self.log_path):
            return []
        try:
            with open(self.log_path, encoding='utf-8', errors='replace') as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        except OSError:
            return []
        out = []
        for ln in reversed(lines[-max(1, int(limit)):]):
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
        return out

    # ------------------------------------------------------------ 概览

    def info(self):
        counts = self.counts()
        stats = self.file_stats()
        db_bytes = os.path.getsize(self.db_path) if os.path.exists(self.db_path) else 0
        return {
            'data_dir': self.data_dir,
            'db_path': self.db_path,
            'db_bytes': db_bytes,
            'counts': counts,
            'files': stats['files'],
            'file_bytes': stats['fileBytes'],
            'snapshots': len(self.snapshot_list()),
            'parse_log': len(self.read_parse_log(MAX_PARSE_LOG)),
            'persons': len(self.persons()),
        }

    def wipe_all(self):
        self.clear_tables()
        self.clear_files()
        with self._lock:
            if os.path.exists(self.log_path):
                try:
                    os.remove(self.log_path)
                except OSError:
                    pass

    def reset_files_dir(self):
        """删除附件目录里所有孤儿文件（数据库里已无记录的）。用于维护。"""
        known = set()
        c = self._conn()
        try:
            known = {r['disk_name'] for r in c.execute('SELECT disk_name FROM files').fetchall()}
        finally:
            c.close()
        removed = 0
        for f in os.listdir(self.files_dir):
            if f not in known:
                if self._trash_file(os.path.join(self.files_dir, f)):
                    removed += 1
        return removed

    # ============================================================ V2 · 指标与趋势
    #
    # 这一层是重构的重点。旧实现把这些计算全放在前端 JS 里：
    # 指标目录是一份写死的 15 项清单、趋势靠前端拼、费用只认发票类型。
    # 现在统一在后端算好，前端只管画。

    # ---------------------------------------------------------- 指标目录

    def list_indicators(self, person_id=None, include_text=False, search='',
                        category='', only_with_data=False, gender=None):
        """可关注的指标全列表。这就是「添加关注」抽屉里能选的东西。

        旧版只有 15 项写死的目录；这里是从报告里归一化出来的全部指标。
        gender='男'/'女' 时滤掉异性专属指标（前列腺不进女性清单，白带常规不进男性清单）；
        None 或未设置性别的成员不做过滤。
        """
        c = self._conn()
        try:
            sql = [
                'SELECT i.*,',
                ' (SELECT COUNT(*) FROM observations o WHERE o.indicator_id=i.id',
                '  AND (? IS NULL OR o.person_id=?)) AS obs_count,',
                ' (SELECT COUNT(DISTINCT o.obs_date) FROM observations o',
                '  WHERE o.indicator_id=i.id AND (? IS NULL OR o.person_id=?)) AS date_count,',
                ' (SELECT MAX(o.obs_date) FROM observations o WHERE o.indicator_id=i.id',
                '  AND (? IS NULL OR o.person_id=?)) AS last_date,',
                ' (SELECT o.value FROM observations o WHERE o.indicator_id=i.id',
                '  AND (? IS NULL OR o.person_id=?) ORDER BY o.obs_date DESC, o.id DESC LIMIT 1)'
                '  AS last_value,',
                ' (SELECT o.unit FROM observations o WHERE o.indicator_id=i.id',
                '  AND (? IS NULL OR o.person_id=?) ORDER BY o.obs_date DESC, o.id DESC LIMIT 1)'
                '  AS last_unit,',
                ' EXISTS(SELECT 1 FROM watched_indicators w WHERE w.indicator_id=i.id',
                '  AND w.person_id=?) AS watched',
                'FROM indicators i WHERE 1=1',
            ]
            args = [person_id, person_id, person_id, person_id, person_id, person_id,
                    person_id, person_id, person_id, person_id, person_id]
            if not include_text:
                sql.append(' AND IFNULL(i.is_text,0)=0')
            if category:
                sql.append(' AND i.category=?')
                args.append(category)
            if search:
                sql.append(' AND (i.name LIKE ? OR i.key LIKE ? OR EXISTS('
                           'SELECT 1 FROM indicator_aliases a WHERE a.indicator_id=i.id '
                           'AND a.alias LIKE ?))')
                like = '%%%s%%' % search
                args.extend([like, like, like])
            if only_with_data:
                sql.append(' AND EXISTS(SELECT 1 FROM observations o WHERE o.indicator_id=i.id'
                           ' AND (? IS NULL OR o.person_id=?))')
                args.extend([person_id, person_id])
            sql.append(' ORDER BY i.is_text, i.category, i.name')
            rows = c.execute(' '.join(sql), args).fetchall()
            out = [dict(r) for r in rows]
            if gender == u'男':
                out = [r for r in out if r.get('sex') != 'female']
            elif gender == u'女':
                out = [r for r in out if r.get('sex') != 'male']
            return out
        finally:
            c.close()

    def indicator_categories(self):
        """指标分类清单（供前端筛选用）。"""
        c = self._conn()
        try:
            rows = c.execute(
                'SELECT category, COUNT(*) n FROM indicators '
                'GROUP BY category ORDER BY n DESC').fetchall()
            return [{'category': r['category'] or u'其他', 'count': r['n']} for r in rows]
        finally:
            c.close()

    def get_indicator(self, indicator_id):
        c = self._conn()
        try:
            r = c.execute('SELECT * FROM indicators WHERE id=?', (indicator_id,)).fetchone()
            if not r:
                return None
            out = dict(r)
            out['aliases'] = [x['alias'] for x in c.execute(
                'SELECT alias FROM indicator_aliases WHERE indicator_id=? ORDER BY id',
                (indicator_id,))]
            return out
        finally:
            c.close()

    # ---------------------------------------------------------- 关注指标

    def list_watched(self, person_id):
        """某成员关注的指标，带上最近一次的数值（概览卡片直接显示）。

        person_id 为 None 时表示「全部成员」视图：返回所有人关注过的指标并集，
        数值列留空 —— 不同人的值不能混着看，得切到具体成员才有意义。
        """
        c = self._conn()
        try:
            # 全部视图：不过滤人，按指标去重
            if person_id is None:
                rows = c.execute(
                    'SELECT i.*, MAX(w.created_at) AS watched_at,'
                    ' (SELECT COUNT(DISTINCT w2.person_id) FROM watched_indicators w2'
                    '  WHERE w2.indicator_id=i.id) AS member_count,'
                    ' NULL AS last_value, NULL AS last_unit, NULL AS last_date,'
                    ' NULL AS last_flag, 0 AS date_count, NULL AS last_numeric'
                    ' FROM watched_indicators w JOIN indicators i ON i.id=w.indicator_id'
                    ' GROUP BY i.id ORDER BY i.category, i.name').fetchall()
                out = []
                for r in rows:
                    d = dict(r)
                    d['spark'] = []
                    out.append(d)
                return out
            rows = c.execute(
                'SELECT i.*, w.created_at AS watched_at,'
                ' (SELECT o.value FROM observations o WHERE o.indicator_id=i.id'
                '  AND o.person_id=? ORDER BY o.obs_date DESC, o.id DESC LIMIT 1) AS last_value,'
                ' (SELECT o.unit FROM observations o WHERE o.indicator_id=i.id'
                '  AND o.person_id=? ORDER BY o.obs_date DESC, o.id DESC LIMIT 1) AS last_unit,'
                ' (SELECT o.obs_date FROM observations o WHERE o.indicator_id=i.id'
                '  AND o.person_id=? ORDER BY o.obs_date DESC, o.id DESC LIMIT 1) AS last_date,'
                ' (SELECT o.flag FROM observations o WHERE o.indicator_id=i.id'
                '  AND o.person_id=? ORDER BY o.obs_date DESC, o.id DESC LIMIT 1) AS last_flag,'
                ' (SELECT COUNT(DISTINCT o.obs_date) FROM observations o'
                '  WHERE o.indicator_id=i.id AND o.person_id=?) AS date_count,'
                ' (SELECT o.numeric_value FROM observations o WHERE o.indicator_id=i.id'
                '  AND o.person_id=? AND o.numeric_value IS NOT NULL'
                '  ORDER BY o.obs_date DESC, o.id DESC LIMIT 1) AS last_numeric'
                ' FROM watched_indicators w JOIN indicators i ON i.id=w.indicator_id'
                ' WHERE w.person_id=? ORDER BY w.id',
                (person_id, person_id, person_id, person_id, person_id, person_id,
                 person_id)).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                # 迷你趋势：最近若干个数值点，给概览画 sparkline
                pts = c.execute(
                    'SELECT obs_date, numeric_value, value FROM observations '
                    'WHERE indicator_id=? AND person_id=? AND numeric_value IS NOT NULL '
                    'ORDER BY obs_date, id', (r['id'], person_id)).fetchall()
                d['spark'] = [{'date': p['obs_date'], 'value': p['numeric_value']}
                              for p in pts[-12:]]
                if not d['spark']:
                    # 纯定性指标（阴性/阳性等）：映射成序数后也能画 sparkline。
                    import hrw_indicators as I
                    qual = c.execute(
                        'SELECT obs_date, value FROM observations '
                        'WHERE indicator_id=? AND person_id=? ORDER BY obs_date, id',
                        (r['id'], person_id)).fetchall()
                    mapped = [(p['obs_date'], I.qualitative_ordinal(p['value']))
                              for p in qual]
                    if mapped and all(ov is not None for _d, ov in mapped):
                        d['spark'] = [{'date': dt, 'value': ov}
                                      for dt, ov in mapped[-12:]]
                out.append(d)
            return out
        finally:
            c.close()

    def add_watched(self, person_id, indicator_id):
        c = self._conn()
        try:
            try:
                pid = int(person_id)
                iid = int(indicator_id)
            except (TypeError, ValueError):
                raise StoreError('成员或指标 id 不合法')
            if not c.execute('SELECT id FROM indicators WHERE id=?', (iid,)).fetchone():
                raise StoreError('指标不存在：%s' % iid)
            c.execute('INSERT OR IGNORE INTO watched_indicators '
                      '(person_id, indicator_id, created_at) VALUES (?,?,?)',
                      (pid, iid, now_iso()))
            c.commit()
        finally:
            c.close()
        return True

    def remove_watched(self, person_id, indicator_id):
        """取消关注。person_id 传 'all' 时取消所有成员对这个指标的关注
        （「全部成员」视图里的取消按钮用的是去重并集，没有单一归属人）。"""
        with self._lock:
            c = self._conn()
            try:
                if str(person_id) == 'all':
                    c.execute('DELETE FROM watched_indicators WHERE indicator_id=?',
                              (int(indicator_id),))
                else:
                    c.execute('DELETE FROM watched_indicators WHERE person_id=? AND indicator_id=?',
                              (person_id, indicator_id))
                c.commit()
            finally:
                c.close()
        return True

    # ---------------------------------------------------------- 趋势

    @staticmethod
    def _range_start(range_key):
        """时间范围过滤的起点。默认「全部」——旧版默认近 12 个月，
        结果多数指标只剩一个点，画不出线，看着像坏了。"""
        if not range_key or range_key == 'all':
            return None
        months = {'12m': 12, '6m': 6, '3y': 36, '5y': 60}.get(range_key)
        if not months:
            return None
        dt = datetime.date.today() - datetime.timedelta(days=int(months * 30.44))
        return dt.isoformat()

    def trend(self, person_id, indicator_id, range_key='all'):
        """一个指标的完整趋势数据。

        返回的 series 按单位分组：同一指标若在不同报告里用了不同单位，
        各自成一条线，而不是混在一起连出一条没有意义的折线。

        待确认日期的点照样返回，只打上 pending 标记 —— 旧版把它们整个丢掉，
        导致有些成员名下所有趋势图都是空的。
        """
        c = self._conn()
        try:
            ind = c.execute('SELECT * FROM indicators WHERE id=?', (indicator_id,)).fetchone()
            if not ind:
                return None
            start = self._range_start(range_key)
            # person_id 为 None 是「全部成员」视图：不过滤人，稍后按人分线。
            # （写成 WHERE person_id=? 传 None 会一条都匹配不到 —— 空值不等于空值）
            if person_id is None:
                sql = ('SELECT o.*, d.date_status, d.title AS doc_title, d.document_type, '
                       'p.name AS person_name '
                       'FROM observations o LEFT JOIN documents d ON d.id=o.document_id '
                       'LEFT JOIN persons p ON p.id=o.person_id '
                       'WHERE o.indicator_id=?')
                args = [indicator_id]
            else:
                sql = ('SELECT o.*, d.date_status, d.title AS doc_title, d.document_type, '
                       'p.name AS person_name '
                       'FROM observations o LEFT JOIN documents d ON d.id=o.document_id '
                       'LEFT JOIN persons p ON p.id=o.person_id '
                       'WHERE o.person_id=? AND o.indicator_id=?')
                args = [person_id, indicator_id]
            if start:
                sql += ' AND o.obs_date>=?'
                args.append(start)
            sql += ' ORDER BY o.obs_date, o.id'
            rows = c.execute(sql, args).fetchall()
        finally:
            c.close()

        # 分组键：具体成员视图按单位分；全部成员视图按「人 + 单位」分，
        # 这样一家人的数值各成一条线，不会混成一条没有意义的折线。
        # 单位键大小写不敏感（cm / Cm 是同一种），否则同一指标会被拆成
        # 两条都不足 2 点的线，趋势画不出来。
        import hrw_indicators as I
        groups = {}
        for r in rows:
            gkey = I.unit_group_key(r['unit'])
            key = (r['person_id'], gkey) if person_id is None else gkey
            groups.setdefault(key, []).append(r)

        # 单位留空的点：多半是报告里漏印了单位，几乎必然和同一指标的
        # 其余记录同单位。并进同一成员点数最多的非空单位组 —— 注意「全部成员」
        # 视图里分组键带 person_id，绝不能跨成员并组，否则一家人的数值串线。
        empty_keys = [k for k in groups
                      if (k[1] if person_id is None else k) == '']
        nonempty = [k for k in groups
                    if (k[1] if person_id is None else k) != '']
        if nonempty:
            for ek in empty_keys:
                if person_id is None:
                    candidates = [k for k in nonempty if k[0] == ek[0] and k in groups]
                else:
                    candidates = [k for k in nonempty if k in groups]
                if not candidates:
                    continue
                biggest = max(candidates, key=lambda k: len(groups[k]))
                groups[biggest].extend(groups.pop(ek))

        # 量级智能归并：同成员内若还剩多个非空单位组（如 kg 与漏印换算的未知
        # 单位），少数组整组数值都落在多数组量级区间内（最小值÷3 ~ 最大值×3）
        # 就并入多数组 —— 报告漏印单位/同单位异写不该把一条线拆断。量级对不上
        # 的（如尿酸 μmol/L vs mg/dL）不并，防止串单位画假线。与前端 logic.js
        # buildTrend 同一规则，只并展示层分组，原始记录不改写。
        def _fits_majority(minority_rows, majority_rows):
            maj = [r['numeric_value'] for r in majority_rows if r['numeric_value'] is not None]
            if not maj:
                return False
            lo, hi = min(maj) / 3.0, max(maj) * 3.0
            vals = [r['numeric_value'] for r in minority_rows if r['numeric_value'] is not None]
            return bool(vals) and all(lo <= v <= hi for v in vals)

        for mk in list(groups.keys()):
            if mk not in groups:
                continue
            u_mk = mk[1] if person_id is None else mk
            if not u_mk:
                continue  # 空单位组已按上一条规则并过
            peers = ([k for k in groups if k[0] == mk[0] and k != mk]
                     if person_id is None else [k for k in groups if k != mk])
            if not peers:
                continue
            biggest = max(peers, key=lambda k: len(groups[k]))
            u_bg = biggest[1] if person_id is None else biggest
            if not u_bg or len(groups[biggest]) <= len(groups[mk]):
                continue  # 只往更大的、有单位的组并
            if _fits_majority(groups[mk], groups[biggest]):
                groups[biggest].extend(groups.pop(mk))

        order = sorted(groups.keys(), key=lambda k: -len(groups[k]))

        def display_unit(group_rows):
            """组内展示单位：出现最多的原文写法优先，打平时取全小写那个。"""
            cnt = {}
            for r in group_rows:
                u = I.standardize_unit(r['unit'])
                if u:
                    cnt[u] = cnt.get(u, 0) + 1
            if not cnt:
                return ''
            top = max(cnt.values())
            cands = [u for u, n in cnt.items() if n == top]
            cands.sort(key=lambda s: (0 if s == s.lower() else 1, len(s)))
            return cands[0]

        series = []
        for key in order:
            u = display_unit(groups[key])
            pts = []
            for r in groups[key]:
                pts.append({
                    'id': r['id'],
                    'date': r['obs_date'],
                    'value': r['value'],
                    'numeric': r['numeric_value'],
                    'unit': r['unit'],
                    'reference': r['reference'],
                    'flag': r['flag'],
                    'condition': r['condition'],
                    'pending': 1 if (r['date_status'] or '') != u'已确认' else 0,
                    'document_id': r['document_id'],
                    'document_title': r['doc_title'],
                    'source': r['source'],
                })
            numeric_pts = [p for p in pts if p['numeric'] is not None]
            ordinal = False
            if not numeric_pts and pts:
                # 定性指标（阴性/阳性/±/加号）：映射成序数后照样能连线。
                # 只有整组都在词表内才画 —— 混着自由文本的组不硬画。
                qual = [(p, I.qualitative_ordinal(p['value'])) for p in pts]
                if all(ov is not None for _p, ov in qual):
                    ordinal = True
                    line_pts = [{'date': p['date'], 'value': ov, 'label': p['value'],
                                 'pending': p['pending'], 'id': p['id']}
                                for p, ov in qual]
                    ovals = sorted({ov for _p, ov in qual})
                    ylabels = [{'v': ov, 'label': I.ordinal_label(ov)} for ov in ovals]
            if not ordinal:
                line_pts = [{'date': p['date'], 'value': p['numeric'], 'pending': p['pending'],
                             'id': p['id']} for p in numeric_pts]
                ylabels = None
            line_pts.sort(key=lambda p: (p['date'] or '', p['id']))
            nums_for_stats = [p['value'] for p in line_pts] if ordinal \
                else [p['numeric'] for p in numeric_pts]
            series.append({
                'unit': u,
                'person_id': r['person_id'] if person_id is None else person_id,
                'person_name': r['person_name'] if person_id is None else None,
                'points': pts,
                # 数值点连线；纯定性组按序数连线（ordinal=True，前端换刻度文字）
                'line': line_pts,
                'ordinal': ordinal,
                'ylabels': ylabels,
                'can_draw': len({p['date'] for p in line_pts}) >= 2,
                'stats': {
                    'count': len(pts),
                    'dates': len({p['date'] for p in pts}),
                    'min': min(nums_for_stats) if nums_for_stats else None,
                    'max': max(nums_for_stats) if nums_for_stats else None,
                    'first': nums_for_stats[0] if nums_for_stats else None,
                    'latest': nums_for_stats[-1] if nums_for_stats else None,
                },
            })

        # 历史记录：给「来源」按钮用，每条都带得回档案的 document_id
        history = [{
            'id': r['id'], 'date': r['obs_date'], 'value': r['value'],
            'unit': r['unit'], 'reference': r['reference'], 'flag': r['flag'],
            'condition': r['condition'], 'pending': 1 if (r['date_status'] or '') != u'已确认' else 0,
            'document_id': r['document_id'], 'document_title': r['doc_title'],
            'source': r['source'], 'person_id': r['person_id'],
            'person_name': r['person_name'],
        } for r in rows]

        return {'indicator': dict(ind), 'series': series, 'history': history,
                'range': range_key or 'all'}

    def observations_of_document(self, document_id):
        """一份档案里的全部观测点（文档详情里展示）。"""
        c = self._conn()
        try:
            rows = c.execute(
                'SELECT o.*, i.name AS indicator_name, i.category, i.is_text '
                'FROM observations o JOIN indicators i ON i.id=o.indicator_id '
                'WHERE o.document_id=? ORDER BY i.category, i.name', (document_id,)).fetchall()
            return [dict(r) for r in rows]
        finally:
            c.close()

    def document(self, document_id):
        c = self._conn()
        try:
            r = c.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
            return dict(r) if r else None
        finally:
            c.close()

    # ---------------------------------------------------------- 费用

    def fees_summary(self, person_id=None):
        """医疗费用汇总。

        旧版只统计 document_type='医疗发票/收费单'，于是没有发票档案时
        费用卡永远是 0。这里改成：只要档案有金额、或者有收费明细，就计入。
        """
        c = self._conn()
        try:
            args = []
            sql = ('SELECT d.id, d.title, d.primary_date, d.document_type, d.amount_cents, '
                   'd.person_id, d.date_status,'
                   ' (SELECT IFNULL(SUM(ch.amount_cents),0) FROM charge_items ch '
                   '  WHERE ch.document_id=d.id) AS items_cents'
                   ' FROM documents d WHERE 1=1')
            if person_id is not None:
                sql += ' AND d.person_id=?'
                args.append(person_id)
            rows = c.execute(sql, args).fetchall()

            items = []
            total = 0
            with_amount = 0
            unknown = 0
            by_year = {}
            by_type = {}
            for r in rows:
                cents = r['amount_cents']
                if cents is None and r['items_cents']:
                    cents = r['items_cents']
                if cents is None:
                    unknown += 1
                    continue
                with_amount += 1
                total += int(cents)
                year = (r['primary_date'] or '')[:4] or u'未标注日期'
                by_year[year] = by_year.get(year, 0) + int(cents)
                t = r['document_type'] or u'其他'
                by_type[t] = by_type.get(t, 0) + int(cents)
                items.append({'document_id': r['id'], 'title': r['title'],
                              'date': r['primary_date'], 'document_type': t,
                              'amount_cents': int(cents), 'person_id': r['person_id']})
            items.sort(key=lambda x: (x['date'] or ''), reverse=True)
            return {
                'total_cents': total,
                'count': with_amount,
                'unknown_count': unknown,
                'by_year': [{'year': k, 'amount_cents': v}
                            for k, v in sorted(by_year.items())],
                'by_type': [{'type': k, 'amount_cents': v}
                            for k, v in sorted(by_type.items(), key=lambda x: -x[1])],
                'items': items,
            }
        finally:
            c.close()

    # ---------------------------------------------------------- 指标归一人工维护

    def rename_indicator(self, indicator_id, name):
        with self._lock:
            c = self._conn()
            try:
                c.execute('UPDATE indicators SET name=? WHERE id=?', (name, indicator_id))
                c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias, '
                          'is_canonical) VALUES (?,?,?,1)',
                          (indicator_id, name, name))
                c.commit()
            finally:
                c.close()
        return True

    def set_indicator_text_flag(self, indicator_id, is_text):
        with self._lock:
            c = self._conn()
            try:
                c.execute('UPDATE indicators SET is_text=? WHERE id=?',
                          (1 if is_text else 0, indicator_id))
                c.commit()
            finally:
                c.close()
        return True

    def merge_indicators(self, keep_id, merge_ids):
        """把几个指标合并到 keep_id 名下。用于修正归一化分错的家。

        观测值、别名一并迁过去，重复的别名自动跳过。
        """
        with self._lock:
            c = self._conn()
            try:
                if not c.execute('SELECT id FROM indicators WHERE id=?', (keep_id,)).fetchone():
                    raise StoreError('保留方指标不存在：%s' % keep_id)
                moved_obs = moved_alias = 0
                for mid in (merge_ids or []):
                    if int(mid) == int(keep_id):
                        continue
                    # 观测值：同人同日期已存在的，保留保留方的那条
                    rows = c.execute(
                        'SELECT id, person_id, obs_date FROM observations WHERE indicator_id=?',
                        (mid,)).fetchall()
                    for o in rows:
                        dup = c.execute(
                            'SELECT id FROM observations WHERE indicator_id=? AND person_id IS ?'
                            ' AND obs_date=?', (keep_id, o['person_id'], o['obs_date'])).fetchone()
                        if dup:
                            c.execute('DELETE FROM observations WHERE id=?', (o['id'],))
                        else:
                            c.execute('UPDATE observations SET indicator_id=? WHERE id=?',
                                      (keep_id, o['id']))
                            moved_obs += 1
                    for a in c.execute('SELECT alias FROM indicator_aliases '
                                       'WHERE indicator_id=?', (mid,)).fetchall():
                        ex = c.execute('SELECT id FROM indicator_aliases WHERE alias=?',
                                       (a['alias'],)).fetchone()
                        if ex:
                            continue
                        c.execute('INSERT INTO indicator_aliases (indicator_id, alias) '
                                  'VALUES (?,?)', (keep_id, a['alias']))
                        moved_alias += 1
                    c.execute('DELETE FROM indicator_aliases WHERE indicator_id=?', (mid,))
                    c.execute('DELETE FROM watched_indicators WHERE indicator_id=?', (mid,))
                    c.execute('DELETE FROM indicators WHERE id=?', (mid,))
                c.commit()
                return {'moved_obs': moved_obs, 'moved_alias': moved_alias}
            finally:
                c.close()

    def add_alias(self, indicator_id, alias):
        import hrw_indicators as I
        std = I.standardize(alias)
        if not std:
            raise StoreError('别名为空')
        with self._lock:
            c = self._conn()
            try:
                ex = c.execute('SELECT id, indicator_id FROM indicator_aliases WHERE alias=?',
                               (std,)).fetchone()
                if ex and int(ex['indicator_id']) != int(indicator_id):
                    raise StoreError(u'该写法已属于另一个指标')
                if ex:
                    return True
                c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias) '
                          'VALUES (?,?,?)', (indicator_id, std, alias))
                c.commit()
            finally:
                c.close()
        return True

    def normalize_units(self):
        """把库里已存的单位统一一遍（历史数据补做一次即可）。

        返回实际改写条数。幂等，重复执行不会越改越多。
        """
        import hrw_indicators as I
        n = 0
        with self._lock:
            c = self._conn()
            try:
                for r in c.execute(
                        'SELECT id, unit FROM observations WHERE unit IS NOT NULL').fetchall():
                    new = I.standardize_unit(r['unit'])
                    if new != (r['unit'] or ''):
                        c.execute('UPDATE observations SET unit=? WHERE id=?', (new, r['id']))
                        n += 1
                c.commit()
            finally:
                c.close()
        return n

    def move_orphans(self, subdir='orphan'):
        """把不被引用的附件移到 data/files/orphan/，不直接删除。"""
        known = set()
        c = self._conn()
        try:
            known = {r['disk_name'] for r in c.execute('SELECT disk_name FROM files').fetchall()}
        finally:
            c.close()
        dst_dir = os.path.join(self.files_dir, '..', subdir)
        dst_dir = os.path.abspath(dst_dir)
        os.makedirs(dst_dir, exist_ok=True)
        moved = 0
        for f in os.listdir(self.files_dir):
            if f in known or not os.path.isfile(os.path.join(self.files_dir, f)):
                continue
            try:
                shutil.move(os.path.join(self.files_dir, f), os.path.join(dst_dir, f))
                moved += 1
            except OSError:
                pass
        return moved
