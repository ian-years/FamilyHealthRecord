# -*- coding: utf-8 -*-
"""
V1 → V2 结构收口迁移
================================================================
把「V1 兼容期」的库升级成纯 V2 结构：

    1. 旧文档式表（health_records / indicator_catalog /
       daily_indicator_records / legacy_drugs）里的数据并入 V2 关系表；
    2. documents.legacy_payload（整条旧 JSON）拆成真实列 + detail_json；
    3. 删除 legacy_payload 列与全部旧文档式表。

为什么需要它：V2 重构时把整条旧 JSON 存在 documents.legacy_payload 里当
「兼容层底牌」，前端一直优先读它。V1 代码删除后不再需要兼容层，但那些字段
（source_attachments / manual_edits / parse_status / xparse_* / type_specific_data
的残留键）前端仍在用，所以必须先把它们提升成真实列，再删 legacy_payload。

数据落点：
    documents.legacy_payload  → documents 关系列 + documents.detail_json
    daily_indicator_records   → manual_records
    legacy_drugs              → drugs

用法：
    python migrate.py                 # 迁移项目自带的 data/health.db
    python migrate.py --dry-run       # 只报告会做什么，不写库
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# V1 的文档式表（(id, payload) 结构）。迁移末尾整表删掉。
V1_TABLES = ['health_records', 'indicator_catalog', 'daily_indicator_records',
             'legacy_drugs']

# documents 在 V2 里新增的真实列（从 legacy_payload 提升）。
NEW_DOC_COLUMNS = [
    ('owner_id', 'TEXT'),
    ('parse_status', 'TEXT'),
    ('xparse_task_id', 'TEXT'),
    ('xparse_run_id', 'TEXT'),
    ('source_attachments', 'TEXT'),
    ('manual_edits', 'TEXT'),
    ('detail_json', 'TEXT'),
]

# 从扁平行提升为 documents 真实列的键；其余内容进 detail_json。
PROMOTED_DOC_KEYS = frozenset((
    'id', 'person_id', 'document_type', 'title', 'hospital', 'department', 'doctor',
    'primary_date', 'date_status', 'amount', 'source_file', 'parsed_content',
    'key_information', 'owner_id', 'parse_status', 'xparse_task_id', 'xparse_run_id',
    'source_attachments', 'manual_edits', 'type_specific_data', 'created_at', 'updated_at',
))

MANUAL_RECORD_COLS = ('person_id', 'indicator_key', 'name', 'record_date', 'type',
                      'value1', 'value2', 'text_result', 'unit', 'reference', 'flag',
                      'condition', 'review', 'note', 'source')


def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def log(msg):
    print(msg, flush=True)


def open_db(path, readonly=False):
    if readonly:
        conn = sqlite3.connect('file:%s?mode=ro' % path.replace('\\', '/'), uri=True)
    else:
        conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def table_names(conn):
    return {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}


def column_names(conn, table):
    return {r[1] for r in conn.execute('PRAGMA table_info("%s")' % table).fetchall()}


def is_v2(conn):
    names = table_names(conn)
    return {'documents', 'indicators', 'observations'} <= names


def needs_promotion(conn):
    """库里还有 V1 痕迹（旧文档式表或 legacy_payload 列）才需要迁移。"""
    names = table_names(conn)
    if any(t in names for t in V1_TABLES):
        return True
    for tbl in ('documents', 'drugs'):
        if tbl in names and 'legacy_payload' in column_names(conn, tbl):
            return True
    return False


def backup(src):
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dst = '%s.bak-%s' % (src, stamp)
    n = 1
    while os.path.exists(dst):
        n += 1
        dst = '%s.bak-%s-%d' % (src, stamp, n)
    shutil.copy2(src, dst)
    return dst


def create_schema(conn):
    with open(os.path.join(HERE, 'schema.sql'), encoding='utf-8') as fh:
        conn.executescript(fh.read())
    conn.commit()


def add_columns(conn, table, cols):
    have = column_names(conn, table)
    added = []
    for name, typ in cols:
        if name not in have:
            conn.execute('ALTER TABLE "%s" ADD COLUMN %s %s' % (table, name, typ))
            added.append(name)
    conn.commit()
    return added


def drop_column(conn, table, col):
    if col in column_names(conn, table):
        conn.execute('ALTER TABLE "%s" DROP COLUMN "%s"' % (table, col))
        conn.commit()
        return True
    return False


def promote_documents(conn):
    """legacy_payload → 真实列 + detail_json。幂等：列没了就跳过。"""
    if 'legacy_payload' not in column_names(conn, 'documents'):
        return 0
    add_columns(conn, 'documents', NEW_DOC_COLUMNS)
    n = 0
    for d in conn.execute('SELECT * FROM documents').fetchall():
        raw = d['legacy_payload']
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(obj, dict):
            continue
        tsd = obj.get('type_specific_data') or {}
        residual = {k: v for k, v in obj.items() if k not in PROMOTED_DOC_KEYS}
        residual['type_specific_data'] = tsd
        attaches = obj.get('source_attachments')
        edits = obj.get('manual_edits')
        conn.execute(
            'UPDATE documents SET owner_id=?, parse_status=?, xparse_task_id=?, '
            'xparse_run_id=?, source_attachments=?, manual_edits=?, detail_json=? WHERE id=?',
            (obj.get('owner_id') or 'local-user', obj.get('parse_status'),
             obj.get('xparse_task_id'), obj.get('xparse_run_id'),
             None if attaches is None else json.dumps(attaches, ensure_ascii=False),
             None if edits is None else json.dumps(edits, ensure_ascii=False),
             json.dumps(residual, ensure_ascii=False), d['id']))
        n += 1
    conn.commit()
    return n


def _legacy_rows(conn, table):
    """读一张旧文档式表并逐行解 JSON。非 (id, payload) 结构返回空。"""
    if table not in table_names(conn):
        return []
    if not column_names(conn, table) <= {'id', 'payload'}:
        return []
    out = []
    for r in conn.execute('SELECT * FROM "%s"' % table).fetchall():
        try:
            obj = json.loads(r['payload'])
        except (TypeError, ValueError):
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def promote_manual_records(conn):
    """旧 daily_indicator_records → manual_records。"""
    n = 0
    for obj in _legacy_rows(conn, 'daily_indicator_records'):
        pid = obj.get('person_id')
        try:
            pid = int(pid) if pid not in (None, '') else None
        except (TypeError, ValueError):
            pid = None
        vals = [pid] + [obj.get(k) for k in MANUAL_RECORD_COLS[1:]]
        vals.append(obj.get('created_at') or now_iso())
        vals.append(now_iso())
        cols = ','.join(MANUAL_RECORD_COLS) + ',created_at,updated_at'
        conn.execute('INSERT INTO manual_records (%s) VALUES (%s)'
                     % (cols, ','.join('?' * len(vals))), tuple(vals))
        n += 1
    if n:
        conn.commit()
    return n


def promote_drugs(conn):
    """旧 legacy_drugs → drugs。"""
    n = 0
    for obj in _legacy_rows(conn, 'legacy_drugs'):
        pid = obj.get('person_id')
        try:
            pid = int(pid) if pid not in (None, '') else None
        except (TypeError, ValueError):
            pid = None
        conn.execute(
            'INSERT INTO drugs (person_id, name, spec, dosage, frequency, start_date, '
            'end_date, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (pid, obj.get('name'), obj.get('spec'), obj.get('dosage'), obj.get('frequency'),
             obj.get('start_date'), obj.get('end_date'), obj.get('status'), obj.get('note'),
             obj.get('created_at') or now_iso(), obj.get('updated_at') or now_iso()))
        n += 1
    if n:
        conn.commit()
    return n


PROMOTED_DRUG_KEYS = frozenset((
    'id', 'person_id', 'name', 'spec', 'dosage', 'frequency', 'start_date',
    'end_date', 'status', 'note', 'owner_id', 'created_at', 'updated_at',
))


def promote_drugs_payload(conn):
    """drugs.legacy_payload → drugs.detail_json（history / source_attachments …）。"""
    if 'legacy_payload' not in column_names(conn, 'drugs'):
        return 0
    if 'detail_json' not in column_names(conn, 'drugs'):
        conn.execute('ALTER TABLE drugs ADD COLUMN detail_json TEXT')
        conn.commit()
    n = 0
    for d in conn.execute('SELECT * FROM drugs').fetchall():
        raw = d['legacy_payload']
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(obj, dict):
            continue
        residual = {k: v for k, v in obj.items() if k not in PROMOTED_DRUG_KEYS}
        conn.execute('UPDATE drugs SET detail_json=? WHERE id=?',
                     (json.dumps(residual, ensure_ascii=False), d['id']))
        n += 1
    conn.commit()
    return n


def drop_v1_tables(conn):
    dropped = []
    names = table_names(conn)
    for t in V1_TABLES:
        if t in names:
            conn.execute('DROP TABLE IF EXISTS "%s"' % t)
            dropped.append(t)
    conn.commit()
    return dropped


# ---------------------------------------------------------------- 入口

def run(db_path, dry_run=False, no_backup=False):
    if not os.path.exists(db_path):
        raise SystemExit(u'找不到数据库：%s' % db_path)

    conn = open_db(db_path)
    try:
        if not is_v2(conn):
            log(u'该库不是 V2 结构，无法执行收口迁移：%s' % db_path)
            return 1
        if not needs_promotion(conn):
            log(u'该库已是纯 V2（无 V1 表、无 legacy_payload），无需迁移。')
            return 0
    finally:
        conn.close()

    probe = open_db(db_path, readonly=True)
    try:
        n_docs = probe.execute('SELECT COUNT(*) FROM documents').fetchone()[0]
        n_v1 = [t for t in V1_TABLES if t in table_names(probe)]
        n_has_lp = 'legacy_payload' in column_names(probe, 'documents')
    finally:
        probe.close()

    log(u'=' * 60)
    log(u'库：%s' % db_path)
    log(u'档案 %d 条 ｜ 待清理的 V1 表：%s ｜ documents 含 legacy_payload：%s'
        % (n_docs, (u'、'.join(n_v1) or u'无'), u'是' if n_has_lp else u'否'))
    if dry_run:
        log(u'（--dry-run 模式，不写入任何数据）')
        return 0

    bak = None
    if not no_backup:
        bak = backup(db_path)
        log(u'已备份：%s' % os.path.basename(bak))

    conn = open_db(db_path)
    try:
        conn.execute('PRAGMA foreign_keys=ON')
        create_schema(conn)

        stats = {}
        stats['documents_promoted'] = promote_documents(conn)
        stats['manual_records'] = promote_manual_records(conn)
        stats['drugs'] = promote_drugs(conn)
        stats['drugs_promoted'] = promote_drugs_payload(conn)

        drop_column(conn, 'documents', 'legacy_payload')
        drop_column(conn, 'drugs', 'legacy_payload')
        dropped = drop_v1_tables(conn)

        conn.execute(
            'INSERT INTO migration_log (source, migrated_at, stats) VALUES (?,?,?)',
            (db_path, now_iso(),
             json.dumps({'phase': 'v1-cleanup', 'dropped_tables': dropped, **stats},
                        ensure_ascii=False)))
        conn.commit()

        log(u'-' * 60)
        log(u'迁移完成。统计：')
        for k, v in stats.items():
            log(u'  %-20s %s' % (k, v))
        log(u'  已删除的 V1 表    %s' % (u'、'.join(dropped) or u'无'))
        if bak:
            log(u'迁移前备份保留在：%s' % bak)
        log(u'=' * 60)
        return 0
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=u'V1 → V2 结构收口迁移（彻底删除 V1 兼容层）')
    ap.add_argument('--db', default=os.path.join(HERE, 'data', 'health.db'),
                    help=u'要迁移的数据库路径，默认是项目下的 data/health.db')
    ap.add_argument('--dry-run', action='store_true', help=u'只报告会做什么，不写库')
    ap.add_argument('--no-backup', action='store_true', help=u'跳过备份（不推荐）')
    args = ap.parse_args()
    return run(os.path.abspath(args.db), dry_run=args.dry_run, no_backup=args.no_backup)


if __name__ == '__main__':
    sys.exit(main())
