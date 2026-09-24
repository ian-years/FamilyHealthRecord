# -*- coding: utf-8 -*-
"""存量指标目录校准（对照医学知识人工核对后的一次性修正）。

改什么：
  1. 合并   「血清y-谷氨酰基转移酶」(OCR 把 γ 认成 y) → γ-谷氨酰基转移酶(GGT)
  2. 合并   尿常规里的「胆红素」(全部为"阴性"，实为尿胆红素) → 尿胆红素
  3. 拆分   「红细胞分布宽度」→ RDW-SD(fL) 与 RDW-CV(%)，两种不同测量不能混一条线
  4. 换算   红细胞压积 L/L → %（×100）；血红蛋白/MCHC 的 g/DL → g/L（×10）
  5. 规范名 MCH/MCHC/QTc/T-PSA/f-PSA比值 等改成医学规范叫法（旧名留作别名）
  6. 归类   幽门螺杆菌抗体 → 感染免疫；超声/放射文字项 → 影像超声
  7. 值修正 清洁度「IIl°」→「III°」（小写 l 是 1 的识别错误）
  8. 补别名 常用英文缩写与同义写法（WBC/RBC/ALT/AST/CA125…）

怎么保证安全：
  - 开跑前先整库备份到 data/health.db.bak-calibrate-<时间戳>
  - 全部操作包在一个事务里，任何一步抛异常就整体回滚
  - 幂等：已处理过的项会跳过，重复执行无副作用

用法：python calibrate.py            实际执行
      python calibrate.py --dry-run  只看要做什么，不写库
"""
import json
import os
import re
import shutil
import sqlite3
import sys
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, 'data', 'health.db')

sys.path.insert(0, HERE)
import hrw_indicators as I  # noqa: E402

NOW = datetime.datetime.now().isoformat(timespec='seconds')


def std(name):
    return I.standardize(name)


class Cal:
    def __init__(self, conn, dry=False):
        self.c = conn
        self.dry = dry
        self.log = []

    def say(self, msg):
        self.log.append(msg)
        print('  ' + msg)

    # ------------------------------------------------------------- 基础操作
    def get_ind(self, iid):
        return self.c.execute('SELECT * FROM indicators WHERE id=?', (iid,)).fetchone()

    def rename(self, iid, name, category=None, unit=None, is_text=None):
        old = self.get_ind(iid)
        sets, args = ['name=?'], [name]
        if category is not None:
            sets.append('category=?'); args.append(category)
        if unit is not None:
            sets.append('unit=?'); args.append(unit)
        if is_text is not None:
            sets.append('is_text=?'); args.append(is_text)
        args.append(iid)
        self.c.execute('UPDATE indicators SET %s WHERE id=?' % ','.join(sets), args)
        self.say('改名 [%s] %s -> %s%s' % (iid, old['name'], name,
                 '（分类→%s）' % category if category else ''))
        # 旧规范名降级为别名，保证旧写法还能匹配回来
        self.add_alias(iid, old['name'])

    def add_alias(self, iid, alias):
        s = std(alias)
        if not s:
            return
        row = self.c.execute('SELECT indicator_id FROM indicator_aliases WHERE alias=?', (s,)).fetchone()
        if row:
            if row['indicator_id'] != iid:
                self.say('  别名冲突：%s 已属于 [%s]，不重复挂到 [%s]' % (alias, row['indicator_id'], iid))
            return
        self.c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias) '
                       'VALUES (?,?,?)', (iid, s, alias))

    def merge(self, src_id, dst_id):
        """把 src 指标整个并进 dst：观测值、关注、别名全部转移后删掉 src。"""
        if not self.get_ind(src_id) or not self.get_ind(dst_id):
            self.say('  跳过合并 %s→%s：有一方已不存在（可能已处理过）' % (src_id, dst_id))
            return
        n_obs = self.c.execute('SELECT COUNT(*) FROM observations WHERE indicator_id=?', (src_id,)).fetchone()[0]
        self.c.execute('UPDATE observations SET indicator_id=? WHERE indicator_id=?', (dst_id, src_id))
        # 关注转移：目标已有则丢弃，没有则搬过去
        for w in self.c.execute('SELECT person_id FROM watched_indicators WHERE indicator_id=?', (src_id,)).fetchall():
            self.c.execute('INSERT OR IGNORE INTO watched_indicators (person_id, indicator_id, created_at) '
                           'VALUES (?,?,?)', (w['person_id'], dst_id, NOW))
        self.c.execute('DELETE FROM watched_indicators WHERE indicator_id=?', (src_id,))
        # 别名转移
        for a in self.c.execute('SELECT alias, raw_alias, is_canonical FROM indicator_aliases '
                                'WHERE indicator_id=?', (src_id,)).fetchall():
            exist = self.c.execute('SELECT 1 FROM indicator_aliases WHERE indicator_id=? AND alias=?',
                                   (dst_id, a['alias'])).fetchone()
            if not exist:
                self.c.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias, is_canonical) '
                               'VALUES (?,?,?,?)', (dst_id, a['alias'], a['raw_alias'], a['is_canonical']))
        self.c.execute('DELETE FROM indicator_aliases WHERE indicator_id=?', (src_id,))
        self.c.execute('DELETE FROM indicators WHERE id=?', (src_id,))
        self.say('合并 [%s] %s -> [%s] %s（转移 %d 条观测）'
                 % (src_id, self._name_of(src_id, gone=True), dst_id, self.get_ind(dst_id)['name'], n_obs))

    def _name_of(self, iid, gone=False):
        r = self.get_ind(iid)
        return r['name'] if r else '(已删除)'

    def convert_units(self, iid, from_unit, factor, to_unit):
        """单位换算：value / numeric_value / unit 同步改。"""
        rows = self.c.execute('SELECT id, value, numeric_value FROM observations '
                              'WHERE indicator_id=? AND unit=?', (iid, from_unit)).fetchall()
        for r in rows:
            new_num = None
            if r['numeric_value'] is not None:
                new_num = round(r['numeric_value'] * factor, 6)
            new_val = None
            if r['value'] is not None:
                m = re.match(r'^\s*[+-]?\d+(?:\.\d+)?\s*$', str(r['value']))
                new_val = str(round(float(str(r['value']).strip()) * factor, 6)).rstrip('0').rstrip('.') \
                    if m else r['value']
            self.c.execute('UPDATE observations SET value=?, numeric_value=?, unit=? WHERE id=?',
                           (new_val, new_num, to_unit, r['id']))
        self.say('单位换算 [%s] %s：%d 条 %s → %s（×%s）'
                 % (iid, self.get_ind(iid)['name'], len(rows), from_unit, to_unit, factor))
        if rows:
            self.c.execute('UPDATE indicators SET unit=? WHERE id=? AND (unit=? OR unit=?)',
                           (to_unit, iid, from_unit, ''))

    def recategorize(self, ids, category):
        n = 0
        for iid in ids:
            r = self.get_ind(iid)
            if r and r['category'] != category:
                self.c.execute('UPDATE indicators SET category=? WHERE id=?', (category, iid))
                n += 1
        if n:
            self.say('归类调整：%d 项 → 「%s」' % (n, category))

    def fix_value(self, iid, bad, good):
        n = self.c.execute('UPDATE observations SET value=? WHERE indicator_id=? AND value=?',
                           (good, iid, bad)).rowcount
        if n:
            self.say('值修正 [%s] %s：%d 条 "%s" → "%s"' % (iid, self.get_ind(iid)['name'], n, bad, good))


def run(dry=False):
    if not os.path.exists(DB):
        print('找不到数据库：%s' % DB)
        return 1
    if not dry:
        bak = DB + '.bak-calibrate-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        shutil.copy2(DB, bak)
        print('已备份：%s' % bak)

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cal = Cal(conn, dry)
    print('\n=== 开始校准（%s）===' % ('试运行' if dry else '正式执行'))

    try:
        # ---- 1. GGT：血清y-谷氨酰基转移酶 是 γ 的 OCR 识别错误，同一指标
        src = conn.execute("SELECT id FROM indicators WHERE name LIKE '%y-谷氨酰%'").fetchone()
        dst = conn.execute("SELECT id FROM indicators WHERE key='ggt' OR name LIKE '%γ-谷氨酰%'").fetchone()
        if src and dst and src['id'] != dst['id']:
            cal.merge(src['id'], dst['id'])
            cal.add_alias(dst['id'], u'血清y-谷氨酰基转移酶')

        # ---- 2. 尿胆红素：尿常规小节里的「胆红素」全是阴性定性结果
        src = conn.execute("SELECT id FROM indicators WHERE name=? AND category=?",
                           (u'胆红素', u'尿常规')).fetchone()
        dst = conn.execute("SELECT id FROM indicators WHERE name=?", (u'尿胆红素',)).fetchone()
        if src and dst and src['id'] != dst['id']:
            cal.merge(src['id'], dst['id'])
        if dst:
            conn.execute('UPDATE indicators SET is_text=0, category=? WHERE id=?', (u'尿常规', dst['id']))

        # ---- 3. RDW 按 SD/CV 拆分（fL → SD，% → CV）
        rdw = conn.execute("SELECT * FROM indicators WHERE key='rdw' OR "
                           "(name=? AND category=?)", (u'红细胞分布宽度', u'血常规')).fetchone()
        if rdw:
            sd = conn.execute("SELECT id FROM indicators WHERE key='rdw_sd'").fetchone()
            cv = conn.execute("SELECT id FROM indicators WHERE key='rdw_cv'").fetchone()
            if not sd:
                cur = conn.execute(
                    'INSERT INTO indicators (key, name, category, unit, is_text, meta, created_at) '
                    'VALUES (?,?,?,?,0,?,?)',
                    ('rdw_sd', u'红细胞分布宽度-SD', u'血常规', 'fL',
                     json.dumps({'from': 'calibrate'}, ensure_ascii=False), NOW))
                sd = cur.lastrowid
                cal.say('新建 [%s] 红细胞分布宽度-SD（fL）' % sd)
            if not cv:
                cur = conn.execute(
                    'INSERT INTO indicators (key, name, category, unit, is_text, meta, created_at) '
                    'VALUES (?,?,?,?,0,?,?)',
                    ('rdw_cv', u'红细胞分布宽度-CV', u'血常规', '%',
                     json.dumps({'from': 'calibrate'}, ensure_ascii=False), NOW))
                cv = cur.lastrowid
                cal.say('新建 [%s] 红细胞分布宽度-CV（%%）' % cv)
            n_moved = conn.execute('SELECT COUNT(*) FROM observations WHERE indicator_id=? AND '
                                   "LOWER(unit) IN ('fl','fl')", (rdw['id'],)).fetchone()[0]
            conn.execute('UPDATE observations SET indicator_id=? WHERE indicator_id=? AND LOWER(unit)=?',
                         (sd, rdw['id'], 'fl'))
            conn.execute('UPDATE observations SET indicator_id=? WHERE indicator_id=? AND unit=?',
                         (cv, rdw['id'], '%'))
            # 原 rdw 上的关注跟随观测更多的那一支（SD）
            if n_moved:
                for w in conn.execute('SELECT person_id FROM watched_indicators WHERE indicator_id=?',
                                      (rdw['id'],)).fetchall():
                    conn.execute('INSERT OR IGNORE INTO watched_indicators (person_id, indicator_id, created_at) '
                                 'VALUES (?,?,?)', (w['person_id'], sd, NOW))
            conn.execute('DELETE FROM watched_indicators WHERE indicator_id=?', (rdw['id'],))
            for a in conn.execute('SELECT alias, raw_alias FROM indicator_aliases WHERE indicator_id=?',
                                  (rdw['id'],)).fetchall():
                s = a['alias']
                tgt = sd if 'sd' in s.lower() or '标准差' in s else cv
                ex = conn.execute('SELECT 1 FROM indicator_aliases WHERE indicator_id=? AND alias=?',
                                  (tgt, s)).fetchone()
                if not ex:
                    conn.execute('INSERT INTO indicator_aliases (indicator_id, alias, raw_alias) '
                                 'VALUES (?,?,?)', (tgt, s, a['raw_alias']))
            conn.execute('DELETE FROM indicator_aliases WHERE indicator_id=?', (rdw['id'],))
            conn.execute('DELETE FROM indicators WHERE id=?', (rdw['id'],))
            cal.say('拆分 [%s] 红细胞分布宽度：fL %d 条 → RDW-SD[%s]，其余 → RDW-CV[%s]'
                    % (rdw['id'], n_moved, sd, cv))

        # ---- 4. 单位换算
        hct = conn.execute("SELECT id FROM indicators WHERE name IN ('红细胞压积','红细胞比容') "
                           "AND category='血常规'").fetchone()
        if hct:
            cal.convert_units(hct['id'], 'L/L', 100, '%')
            cal.add_alias(hct['id'], '红细胞比容')
            cal.add_alias(hct['id'], 'HCT')
        hgb = conn.execute("SELECT id FROM indicators WHERE name='血红蛋白' AND category='血常规'").fetchone()
        if hgb:
            cal.convert_units(hgb['id'], 'g/DL', 10, 'g/L')
            cal.convert_units(hgb['id'], 'G/DL', 10, 'g/L')
            cal.add_alias(hgb['id'], 'HGB')
        mchc = conn.execute("SELECT id FROM indicators WHERE name IN ('平均血红蛋白浓度','平均红细胞血红蛋白浓度')").fetchone()
        if mchc:
            cal.convert_units(mchc['id'], 'g/DL', 10, 'g/L')

        # ---- 5. 规范名
        renames = [
            (u'平均血红蛋白量', u'平均红细胞血红蛋白量', None, ['MCH', '平均血红蛋白含量']),
            (u'平均血红蛋白浓度', u'平均红细胞血红蛋白浓度', None, ['MCHC']),
            (u'QTC间期', u'QTc间期', None, ['QTc间期']),
            (u'前列腺特异性抗原', u'总前列腺特异性抗原', None, ['T-PSA', 'tPSA', 'PSA']),
            (u'f-PSA/T-PSA', u'游离/总PSA比值', None, ['fPSA/TPSA', '游离/总前列腺特异性抗原比值']),
        ]
        for old_name, new_name, cat, aliases in renames:
            r = conn.execute('SELECT id FROM indicators WHERE name=?', (old_name,)).fetchone()
            if r:
                cal.rename(r['id'], new_name, cat)
                for a in aliases:
                    cal.add_alias(r['id'], a)

        # ---- 6. 归类
        hp = conn.execute("SELECT id FROM indicators WHERE name LIKE '%幽门%杆菌%'").fetchone()
        if hp:
            conn.execute('UPDATE indicators SET category=? WHERE id=?', (u'感染免疫', hp['id']))
            cal.say('归类 [%s] 幽门螺杆菌抗体 → 感染免疫（感染指标，非肿瘤标志物）' % hp['id'])
            cal.add_alias(hp['id'], 'HP抗体')
        imaging_ids = [r['id'] for r in conn.execute(
            "SELECT id FROM indicators WHERE is_text=1 AND ("
            " name LIKE '%彩超%' OR name LIKE '%超声%' OR name LIKE '%X光%' OR name LIKE '%DR%'"
            " OR name LIKE '%放射%' OR name LIKE '%结节大小%' OR name LIKE '%无回声%'"
            " OR name LIKE '%回声结节%' OR name LIKE '%回声团大小%' OR name LIKE '%正位片%')")]
        cal.recategorize(imaging_ids, u'影像超声')

        # ---- 7. 值修正：清洁度 IIl°（l 是 1 的识别错误）
        qcd = conn.execute("SELECT id FROM indicators WHERE name='清洁度'").fetchone()
        if qcd:
            cal.fix_value(qcd['id'], u'IIl°', u'III°')

        # ---- 8. 常用别名批量补齐
        alias_batch = {
            '谷丙转氨酶': ['ALT', '丙氨酸氨基转移酶'],
            '谷草转氨酶': ['AST', '天门冬氨酸氨基转移酶'],
            'γ-谷氨酰基转移酶': ['GGT', 'γ-GT'],
            '碱性磷酸酶': ['ALP', 'AKP'],
            '总胆红素': ['TBIL', 'T-BIL'],
            '直接胆红素': ['DBIL', 'D-BIL', '结合胆红素'],
            '间接胆红素': ['IBIL', '非结合胆红素'],
            '总蛋白': ['TP'],
            '白蛋白': ['ALB'],
            '球蛋白': ['GLB'],
            '白球比': ['A/G', '白球比例'],
            '谷草/谷丙': ['AST/ALT', 'AST/ALT比值'],
            '乳酸脱氢酶': ['LDH', 'LD'],
            '肌酸激酶': ['CK', '肌酸磷酸激酶'],
            '肌酸激酶同工酶': ['CK-MB', '肌酸激酶同工酶MB'],
            '尿素氮': ['BUN', '尿素'],
            '肌酐': ['Cr', '血肌酐'],
            '尿酸': ['UA', '血尿酸'],
            '空腹血糖': ['GLU', '空腹葡萄糖', '血糖'],
            '总胆固醇': ['TC', 'CHO', '胆固醇'],
            '甘油三酯': ['TG', '三酰甘油'],
            '高密度脂蛋白胆固醇': ['HDL-C', 'HDL', '高密度脂蛋白'],
            '低密度脂蛋白胆固醇': ['LDL-C', 'LDL', '低密度脂蛋白'],
            '动脉硬化指数': ['AI', '动脉粥样硬化指数'],
            '甲胎蛋白': ['AFP'],
            '癌胚抗原': ['CEA'],
            '糖类抗原125': ['CA125', 'CA-125'],
            '糖类抗原15-3': ['CA15-3', 'CA153'],
            '糖类抗原19-9': ['CA19-9', 'CA199'],
            '糖类抗原50': ['CA50'],
            '糖类抗原72-4': ['CA72-4', 'CA724'],
            '神经元特异性烯醇化酶': ['NSE'],
            '白细胞': ['WBC'],
            '红细胞': ['RBC'],
            '血小板': ['PLT'],
            '平均红细胞体积': ['MCV'],
            '红细胞分布宽度-SD': ['RDW-SD'],
            '红细胞分布宽度-CV': ['RDW-CV'],
            '平均血小板体积': ['MPV'],
            '血小板压积': ['PCT'],
            '血小板分布宽度': ['PDW'],
            '大血小板比率': ['P-LCR'],
            '中性粒细胞数': ['NEUT#', '中性粒细胞绝对值'],
            '中性粒细胞百分比': ['NEUT%', '中性粒细胞比率'],
            '淋巴细胞数': ['LYMPH#', '淋巴细胞绝对值'],
            '淋巴细胞百分比': ['LYMPH%'],
            '单核细胞数': ['MONO#'],
            '单核细胞百分比': ['MONO%'],
            '嗜酸性粒细胞数': ['EO#'],
            '嗜酸性粒细胞百分比': ['EO%'],
            '嗜碱性粒细胞数': ['BASO#'],
            '嗜碱性粒细胞百分比': ['BASO%'],
            '收缩压': ['高压', 'SBP'],
            '舒张压': ['低压', 'DBP'],
            '心率': ['脉搏', 'HR'],
            'BMI': ['体重指数', '体质指数'],
            '尿酸碱度': ['pH', '尿pH值'],
            '尿比重': ['SG'],
            '尿蛋白': ['PRO', '尿蛋白质'],
            '尿隐血': ['BLD', '潜血'],
            '尿酮体': ['KET'],
            '尿亚硝酸盐': ['NIT'],
            '尿白细胞': ['LEU'],
            '尿胆原': ['UBG', '尿胆素原'],
            '尿维生素C': ['VC', '维生素C'],
            '镜检管型': ['管型'],
            'TCT': ['液基薄层细胞检测', '宫颈刮片'],
            '裸眼视力(右)': ['右裸眼视力'],
            '裸眼视力(左)': ['左裸眼视力'],
            '矫正视力(右)': ['右矫正视力'],
            '矫正视力(左)': ['左矫正视力'],
            '免疫法粪便隐血反应': ['便隐血', '粪便隐血', 'FOB'],
        }
        n_alias = 0
        for name, aliases in alias_batch.items():
            r = conn.execute('SELECT id FROM indicators WHERE name=?', (name,)).fetchone()
            if not r:
                continue
            before = cal.c.execute('SELECT COUNT(*) FROM indicator_aliases WHERE indicator_id=?',
                                   (r['id'],)).fetchone()[0]
            for a in aliases:
                cal.add_alias(r['id'], a)
            after = cal.c.execute('SELECT COUNT(*) FROM indicator_aliases WHERE indicator_id=?',
                                  (r['id'],)).fetchone()[0]
            n_alias += after - before
        cal.say('别名补齐：新增 %d 条' % n_alias)

        # ---- 9. 性别限定：给性别专属指标打 sex 标记 + 给成员分配性别
        # 指标侧：前列腺/PSA → male，白带常规/宫颈/乳腺/TCT → female。
        # 存量库可能没有 sex 列（schema 加列之前的库），先补上再回填。
        cols = [r['name'] for r in conn.execute('PRAGMA table_info(indicators)').fetchall()]
        if 'sex' not in cols:
            conn.execute('ALTER TABLE indicators ADD COLUMN sex TEXT')
            cal.say('indicators 表补建 sex 列')
        n_male = n_female = 0
        for row in conn.execute('SELECT id, name, sex FROM indicators').fetchall():
            sex = I.sex_of_name(row['name'])
            if not sex:
                continue
            if row['sex'] != sex:
                conn.execute('UPDATE indicators SET sex=? WHERE id=?', (sex, row['id']))
                if sex == 'male':
                    n_male += 1
                else:
                    n_female += 1
        cal.say('性别限定标记：男 %d 项 / 女 %d 项（已正确的自动跳过）' % (n_male, n_female))

        # 成员侧：按现有名单的内容分配性别（角色能定的定角色，名字兜底）。
        # 只补空，不覆盖用户手动改过的值 —— 幂等。
        GENDER_BY_ROLE = {'father': u'男', 'mother': u'女', 'mother_in_law': u'女',
                          'father_in_law': u'男', 'son': u'男', 'daughter': u'女'}
        GENDER_BY_NAME = {u'老婆': u'女', u'妻子': u'女', u'丈夫': u'男', u'先生': u'男',
                          u'儿子': u'男', u'女儿': u'女', u'爷爷': u'男', u'奶奶': u'女',
                          u'外公': u'男', u'外婆': u'女', u'岳父': u'男', u'岳母': u'女'}
        mrow = conn.execute("SELECT v FROM meta WHERE k='persons'").fetchone()
        try:
            cur_meta = json.loads(mrow['v']) if mrow else None
        except (ValueError, TypeError):
            cur_meta = None
        if isinstance(cur_meta, list) and cur_meta:
            n_g = 0
            for p in cur_meta:
                if str(p.get('gender') or '').strip() in (u'男', u'女'):
                    continue
                g = GENDER_BY_ROLE.get(str(p.get('role') or '')) \
                    or GENDER_BY_NAME.get(str(p.get('name') or '').strip())
                # 本人（self）：按配偶名字反推 —— 名单里有「老婆/妻子」即男性，有「丈夫/先生」即女性
                if not g and str(p.get('role') or '') == 'self':
                    names = [str(x.get('name') or '').strip() for x in cur_meta]
                    if any(n in (u'老婆', u'妻子') for n in names):
                        g = u'男'
                    elif any(n in (u'丈夫', u'先生') for n in names):
                        g = u'女'
                if g:
                    p['gender'] = g
                    n_g += 1
            conn.execute("UPDATE meta SET v=? WHERE k='persons'",
                         (json.dumps(cur_meta, ensure_ascii=False),))
            cal.say('成员性别分配：%d 人（我=男：名单里有「老婆」）' % n_g)
        else:
            cal.say('成员名单为空，跳过性别分配')

        if dry:
            conn.rollback()
            print('\n（试运行结束，未写库）')
        else:
            conn.commit()
            print('\n校准完成，全部改动已落库。')
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(run(dry='--dry-run' in sys.argv))
