# -*- coding: utf-8 -*-
"""
旧库 → 新库 无损迁移
================================================================
把文档式（四张 (id, payload JSON) 表）的旧数据，转成 V2 的关系型结构：

    成员 persons → 档案 documents → 指标 indicators → 观测值 observations

设计原则：
    1. 先备份，再动手。任何一步炸了，老库都还在。
    2. 只增不删：旧的四张表原样留着不删，新表独立建。迁移完两边都在，
       随时可以对照；确认无误后再自行决定是否清理旧表。
    3. 附件（files）与成员名单（meta）不重建 —— 它们是独立表，重建会连带
       把磁盘上的附件登记弄丢，风险大于收益。
    4. 每条档案的整条旧 JSON 存进 documents.legacy_payload：既是溯源依据，
       也让前端那些还没改造的旧页面能原样读回旧结构（兼容层的底牌）。

用法：
    python migrate.py                  # 迁移项目自带的 data/health.db
    python migrate.py --source 路径      # 从别处的旧库迁移进来
    python migrate.py --dry-run        # 只报告会做什么，不写库
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import sys

import hrw_indicators as I

HERE = os.path.dirname(os.path.abspath(__file__))

# 旧表（文档式）
LEGACY_TABLES = ['health_records', 'drugs', 'indicator_catalog', 'daily_indicator_records']

# 数据类型预置：旧 payload 里的中文 document_type 直接对号入座
DOCUMENT_TYPES = [
    ('checkup', u'体检报告', 'medical', 1, 0),
    ('invoice', u'医疗发票/收费单', 'financial', 0, 1),
    ('receipt', u'收费票据', 'financial', 0, 1),
    ('prescription', u'处方', 'medical', 0, 1),
    ('lab', u'检验单', 'medical', 1, 0),
    ('exam', u'检查报告', 'medical', 1, 0),
    ('vaccine', u'疫苗接种', 'medical', 0, 0),
    ('other', u'其他', 'other', 0, 0),
]


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


def is_legacy(conn):
    """判断是不是旧格式：有 health_records 且还没有 indicators 表。"""
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    return 'health_records' in names and 'indicators' not in names


def has_new_schema(conn):
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    return 'indicators' in names and 'observations' in names


def backup(src):
    """复制一份带时间戳的备份。返回备份路径。"""
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dst = '%s.bak-%s' % (src, stamp)
    n = 1
    while os.path.exists(dst):
        n += 1
        dst = '%s.bak-%s-%d' % (src, stamp, n)
    shutil.copy2(src, dst)
    return dst


def shelve_legacy_drugs(conn):
    """把旧药品表挪到 legacy_drugs，给新 drugs 表腾名字。

    旧库里 drugs 是 (id, payload) 的文档式表。schema.sql 用的是
    CREATE TABLE IF NOT EXISTS —— 同名表已存在时它会安静地跳过建表，
    后面给新列建索引就会撞上「no such column」。所以先把它改名留着：
    数据一条不丢，新表也能按新结构建起来。
    """
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if 'drugs' not in names:
        return False
    cols = [r[1] for r in conn.execute('PRAGMA table_info(drugs)').fetchall()]
    if not cols or not set(cols) <= {'id', 'payload'}:
        return False          # 已经是新结构，不用动
    if 'legacy_drugs' in names:
        # 上一轮迁移已经挪过了，这里是新表，别再动
        return False
    conn.execute('ALTER TABLE drugs RENAME TO legacy_drugs')
    conn.commit()
    return True


def create_schema(conn):
    with open(os.path.join(HERE, 'schema.sql'), encoding='utf-8') as fh:
        conn.executescript(fh.read())
    conn.commit()


# ---------------------------------------------------------------- 迁移各块

def migrate_persons(conn):
    """成员名单从 meta 表提到 persons 表。id 保持原样 —— 档案靠它归属。"""
    row = conn.execute("SELECT v FROM meta WHERE k='persons'").fetchone()
    if not row:
        return 0
    try:
        persons = json.loads(row['v'])
    except Exception:
        return 0
    if not isinstance(persons, list):
        return 0
    n = 0
    for p in persons:
        if not isinstance(p, dict):
            continue
        try:
            pid = int(p.get('id'))
        except (TypeError, ValueError):
            continue
        cur = conn.execute('SELECT id FROM persons WHERE id=?', (pid,)).fetchone()
        if cur:
            continue
        conn.execute(
            'INSERT INTO persons (id, name, role, note, created_at) VALUES (?,?,?,?,?)',
            (pid, p.get('name') or '', p.get('role') or 'custom',
             p.get('note') or '', p.get('created_at') or now_iso()))
        n += 1
    conn.commit()
    return n


def migrate_document_types(conn):
    n = 0
    for code, name, cat, has_ind, has_fee in DOCUMENT_TYPES:
        cur = conn.execute('SELECT id FROM document_types WHERE code=?', (code,)).fetchone()
        if cur:
            continue
        conn.execute(
            'INSERT INTO document_types (code, name, category, has_indicators, has_fees) '
            'VALUES (?,?,?,?,?)', (code, name, cat, has_ind, has_fee))
        n += 1
    conn.commit()
    return n


def to_cents(value):
    """金额转分。旧库里金额是浮点或字符串，统一成整数分避免误差。"""
    if value is None or value == '':
        return None
    try:
        return int(round(float(str(value).replace(',', '').replace(u'¥', '').strip()) * 100))
    except (TypeError, ValueError):
        return None


def collect_lab_samples(conn):
    """先把所有检验项摊平，喂给归一化器 —— 它需要先看完全部样本再定案。"""
    samples = []          # [(raw_name, value, unit, panel)]
    per_doc = {}          # legacy_id -> [lab_item...]
    rows = conn.execute('SELECT id, payload FROM health_records ORDER BY id').fetchall()
    for r in rows:
        try:
            d = json.loads(r['payload'])
        except Exception:
            continue
        labs = (d.get('type_specific_data') or {}).get('lab_results') or []
        per_doc[r['id']] = labs
        for it in labs:
            if not isinstance(it, dict):
                continue
            name = it.get('name')
            if not name:
                continue
            samples.append((name, it.get('result'), it.get('unit'), it.get('condition')))
    return samples, per_doc


def build_indicators(conn, samples):
    """归一化并落库 indicators / indicator_aliases。返回 {标准化名: indicator_id}。"""
    n = I.Normalizer()
    for name, val, unit, panel in samples:
        n.resolve(name, val, unit, panel)
    n.finalize()

    # 词典里命中过的（只落真实出现过的，避免目录里塞满没数据的项）
    used_keys = set()
    for name, _v, _u, _p in samples:
        d = n.resolve(name)
        if d and d.get('source') == 'preset':
            used_keys.add(d['key'])
    # 常见核心指标即使暂时没数据也保留（用户随时可能想关注）
    for key in ('fbg', 'hba1c', 'bp', 'systolic_bp', 'diastolic_bp', 'tc', 'tg',
                'hdl', 'ldl', 'ua', 'cr', 'weight', 'bmi', 'height', 'heart_rate'):
        used_keys.add(key)

    id_of_key = {}
    id_of_std = {}

    # 预置指标
    for key in sorted(used_keys):
        if key not in I.SYNONYMS:
            continue
        name, cat, unit, aliases = I.SYNONYMS[key]
        cur = conn.execute('SELECT id FROM indicators WHERE key=?', (key,)).fetchone()
        if cur:
            ind_id = cur['id']
        else:
            c = conn.execute(
                'INSERT INTO indicators (key, name, category, unit, is_composite, '
                'is_text, meta, created_at) VALUES (?,?,?,?,?,?,?,?)',
                (key, name, cat, unit,
                 1 if key == 'bp' else 0, 0, json.dumps({'from': 'preset'},
                                                        ensure_ascii=False), now_iso()))
            ind_id = c.lastrowid
        id_of_key[key] = ind_id
        for a in [name] + list(aliases):
            std = I.standardize(a)
            if std:
                id_of_std[std] = ind_id

    # 自动发现的指标
    for info in n.auto_definitions():
        cur = conn.execute('SELECT id FROM indicators WHERE key=?', (info['key'],)).fetchone()
        if cur:
            ind_id = cur['id']
        else:
            c = conn.execute(
                'INSERT INTO indicators (key, name, category, unit, is_composite, '
                'is_text, meta, created_at) VALUES (?,?,?,?,?,?,?,?)',
                (info['key'], info['name'], info['category'], info.get('unit') or '',
                 0, 1 if info.get('is_text') else 0,
                 json.dumps({'from': 'auto', 'raws': sorted(info.get('raws') or [])},
                            ensure_ascii=False), now_iso()))
            ind_id = c.lastrowid
        id_of_key[info['key']] = ind_id
        id_of_std[info['std']] = ind_id
        for raw in sorted(info.get('raws') or []):
            id_of_std[I.standardize(raw)] = ind_id

    # 性别限定：前列腺/妇科等项目只属于一个性别，按名字规则统一回填。
    # 既有行也重刷一遍（名字没变时结果幂等），新库旧库行为一致。
    n_sex = 0
    for row in conn.execute('SELECT id, name, sex FROM indicators').fetchall():
        sex = I.sex_of_name(row['name'])
        if sex and row['sex'] != sex:
            conn.execute('UPDATE indicators SET sex=? WHERE id=?', (sex, row['id']))
            n_sex += 1
    print('性别限定标记：%d 个指标' % n_sex)

    # 别名表：记录每个原始写法属于哪个指标
    seen_alias = set()
    for raw_name, _v, _u, _p in samples:
        std = I.standardize(raw_name)
        ind_id = id_of_std.get(std)
        if not ind_id:
            continue
        key = (ind_id, std)
        if key in seen_alias:
            continue
        seen_alias.add(key)
        conn.execute(
            'INSERT INTO indicator_aliases (indicator_id, alias, raw_alias, is_canonical) '
            'VALUES (?,?,?,?)', (ind_id, std, raw_name, 0))
    conn.commit()
    return id_of_std, n


def resolve_indicator(normalizer, id_of_std, raw_name):
    std = I.standardize(raw_name)
    ind_id = id_of_std.get(std)
    if ind_id:
        return ind_id
    base = I.strip_abbrev(std)
    if base != std:
        return id_of_std.get(base)
    return None


def migrate_documents(conn, per_doc, id_of_std, normalizer):
    """档案 + 观测值。返回 (档案数, 观测值数)。"""
    rows = conn.execute('SELECT id, payload FROM health_records ORDER BY id').fetchall()
    n_doc = n_obs = 0
    for r in rows:
        try:
            d = json.loads(r['payload'])
        except Exception:
            continue
        tsd = d.get('type_specific_data') or {}
        person_id = d.get('person_id')
        try:
            person_id = int(person_id) if person_id not in (None, '') else None
        except (TypeError, ValueError):
            person_id = None

        amount = d.get('amount')
        if amount in (None, ''):
            amount = tsd.get('total_amount')

        cur = conn.execute(
            'INSERT INTO documents (person_id, document_type, title, hospital, department, '
            'doctor, primary_date, date_status, amount_cents, amount_in_words, source_file, '
            'parsed_content, key_information, legacy_payload, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (person_id, d.get('document_type') or u'其他', d.get('title'),
             d.get('hospital'), d.get('department'), d.get('doctor'),
             d.get('primary_date'), d.get('date_status') or u'已确认',
             to_cents(amount), tsd.get('amount_in_words'),
             d.get('source_file'), d.get('parsed_content'),
             d.get('key_information'),
             json.dumps(d, ensure_ascii=False),
             d.get('created_at') or now_iso(), d.get('updated_at') or now_iso()))
        doc_id = cur.lastrowid
        n_doc += 1

        # 收费明细（旧库里通常是空的，有值才写）
        for it in (tsd.get('charge_items') or []):
            if not isinstance(it, dict):
                continue
            conn.execute(
                'INSERT INTO charge_items (document_id, name, amount_cents, category, quantity) '
                'VALUES (?,?,?,?,?)',
                (doc_id, it.get('name'), to_cents(it.get('amount')),
                 it.get('category'), it.get('quantity')))

        # 观测值
        obs_date = d.get('primary_date')
        if not obs_date:
            continue
        for it in per_doc.get(r['id']) or []:
            if not isinstance(it, dict) or not it.get('name'):
                continue
            ind_id = resolve_indicator(normalizer, id_of_std, it['name'])
            if not ind_id:
                # 归一化器都归不出结果的项（空名等），跳过而不是硬塞
                continue
            val = it.get('result')
            conn.execute(
                'INSERT INTO observations (person_id, indicator_id, document_id, obs_date, '
                'value, numeric_value, unit, reference, flag, condition, panel, source, '
                'created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (person_id, ind_id, doc_id, obs_date,
                 '' if val is None else str(val),
                 I.parse_numeric(val), it.get('unit'), it.get('reference'),
                 it.get('flag'), it.get('condition'), it.get('condition'),
                 'report', now_iso()))
            n_obs += 1
    conn.commit()
    return n_doc, n_obs


def migrate_manual_records(conn, id_of_std, normalizer):
    """手动录入的指标 → observations(source='manual')。"""
    try:
        rows = conn.execute(
            'SELECT id, payload FROM daily_indicator_records ORDER BY id').fetchall()
    except sqlite3.OperationalError:
        return 0
    n = 0
    for r in rows:
        try:
            d = json.loads(r['payload'])
        except Exception:
            continue
        key = d.get('indicator_key') or d.get('key') or d.get('name')
        if not key:
            continue
        ind_id = None
        cur = conn.execute('SELECT id FROM indicators WHERE key=?', (key,)).fetchone()
        if cur:
            ind_id = cur['id']
        else:
            ind_id = resolve_indicator(normalizer, id_of_std, key)
        if not ind_id:
            continue
        person_id = d.get('person_id')
        try:
            person_id = int(person_id) if person_id not in (None, '') else None
        except (TypeError, ValueError):
            person_id = None
        val = d.get('value')
        conn.execute(
            'INSERT INTO observations (person_id, indicator_id, document_id, obs_date, '
            'value, numeric_value, unit, reference, flag, condition, panel, source, '
            'created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (person_id, ind_id, d.get('document_id'), d.get('date') or d.get('obs_date'),
             '' if val is None else str(val), I.parse_numeric(val),
             d.get('unit'), d.get('reference'), d.get('flag'),
             d.get('condition'), None, 'manual', d.get('created_at') or now_iso()))
        n += 1
    conn.commit()
    return n


def migrate_drugs(conn):
    """药品：优先从 legacy_drugs（旧表）读，没有再读新表（重复迁移时）。"""
    src = 'legacy_drugs'
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if src not in names:
        src = 'drugs'
    try:
        rows = conn.execute('SELECT id, payload FROM "%s" ORDER BY id' % src).fetchall()
    except sqlite3.OperationalError:
        return 0
    n = 0
    for r in rows:
        try:
            d = json.loads(r['payload'])
        except Exception:
            continue
        person_id = d.get('person_id')
        try:
            person_id = int(person_id) if person_id not in (None, '') else None
        except (TypeError, ValueError):
            person_id = None
        conn.execute(
            'INSERT INTO drugs (person_id, name, spec, dosage, frequency, start_date, '
            'end_date, status, note, legacy_payload, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (person_id, d.get('name'), d.get('spec'), d.get('dosage'),
             d.get('frequency'), d.get('start_date'), d.get('end_date'),
             d.get('status'), d.get('note'), json.dumps(d, ensure_ascii=False),
             d.get('created_at') or now_iso(), d.get('updated_at') or now_iso()))
        n += 1
    conn.commit()
    return n


# ---------------------------------------------------------------- 入口

def run(db_path, dry_run=False, no_backup=False):
    if not os.path.exists(db_path):
        raise SystemExit(u'找不到数据库：%s' % db_path)

    conn = open_db(db_path)
    try:
        if not is_legacy(conn):
            if has_new_schema(conn):
                log(u'该库已是 V2 结构，无需迁移。')
            else:
                log(u'该库既不是旧结构也不含新表，无法迁移：%s' % db_path)
            return 0
    finally:
        conn.close()

    # 干跑：只报告
    probe = open_db(db_path, readonly=True)
    try:
        n_docs = probe.execute('SELECT COUNT(*) FROM health_records').fetchone()[0]
        n_drugs = probe.execute('SELECT COUNT(*) FROM drugs').fetchone()[0]
        n_manual = probe.execute('SELECT COUNT(*) FROM daily_indicator_records').fetchone()[0]
    finally:
        probe.close()

    log(u'=' * 60)
    log(u'旧库：%s' % db_path)
    log(u'待迁移：档案 %d 条 ｜ 药品 %d 条 ｜ 手动录入 %d 条' % (n_docs, n_drugs, n_manual))
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
        if shelve_legacy_drugs(conn):
            log(u'旧药品表已改名为 legacy_drugs（数据保留），新 drugs 表按新结构建立')
        create_schema(conn)

        stats = {}
        stats['persons'] = migrate_persons(conn)
        stats['document_types'] = migrate_document_types(conn)

        samples, per_doc = collect_lab_samples(conn)
        log(u'检验项样本：%d 条（不同写法 %d 种）'
            % (len(samples), len({s[0] for s in samples})))

        id_of_std, normalizer = build_indicators(conn, samples)
        n_ind = conn.execute('SELECT COUNT(*) FROM indicators').fetchone()[0]
        n_auto = conn.execute(
            "SELECT COUNT(*) FROM indicators WHERE key LIKE 'auto_%'").fetchone()[0]
        stats['indicators'] = n_ind
        stats['indicators_auto'] = n_auto
        log(u'指标目录：%d 项（其中自动发现 %d 项）' % (n_ind, n_auto))

        n_doc, n_obs = migrate_documents(conn, per_doc, id_of_std, normalizer)
        stats['documents'] = n_doc
        stats['observations'] = n_obs
        log(u'档案：%d 条 ｜ 观测值：%d 条' % (n_doc, n_obs))

        stats['manual'] = migrate_manual_records(conn, id_of_std, normalizer)
        stats['drugs'] = migrate_drugs(conn)

        conn.execute(
            'INSERT INTO migration_log (source, migrated_at, stats) VALUES (?,?,?)',
            (db_path, now_iso(), json.dumps(stats, ensure_ascii=False)))
        conn.commit()

        log(u'-' * 60)
        log(u'迁移完成。统计：')
        for k, v in stats.items():
            log(u'  %-18s %s' % (k, v))
        if bak:
            log(u'旧库备份保留在：%s' % bak)
        log(u'旧的四张文档式表已保留未删，可随时对照；确认无误后可自行清理。')
        log(u'=' * 60)
        return 0
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description=u'旧库 → V2 关系型结构 无损迁移')
    ap.add_argument('--db', default=os.path.join(HERE, 'data', 'health.db'),
                    help=u'要迁移的数据库路径，默认是项目下的 data/health.db')
    ap.add_argument('--source', default='',
                    help=u'从指定的旧库文件迁移进来（复制后迁移，不动源文件）')
    ap.add_argument('--dry-run', action='store_true', help=u'只报告会做什么，不写库')
    ap.add_argument('--no-backup', action='store_true', help=u'跳过备份（不推荐）')
    args = ap.parse_args()

    db_path = os.path.abspath(args.db)
    if args.source:
        src = os.path.abspath(args.source)
        if not os.path.exists(src):
            raise SystemExit(u'找不到源库：%s' % src)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        if os.path.exists(db_path):
            bak = backup(db_path)
            log(u'目标库已存在，先备份为：%s' % os.path.basename(bak))
        shutil.copy2(src, db_path)
        log(u'已从源库复制：%s' % src)

    return run(db_path, dry_run=args.dry_run, no_backup=args.no_backup)


if __name__ == '__main__':
    sys.exit(main())
