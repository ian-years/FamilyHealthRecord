-- 个人健康档案工作台 V2 · 关系型 Schema
-- 组织方式：成员(persons) → 数据类型(document_types) → 档案(documents)
--            → 指标(indicators) → 观测值(observations)
-- 只用 SQLite 标准能力，零第三方依赖。
-- 幂等：全部 IF NOT EXISTS，可重复执行。

-- ---------------------------------------------------------------- 成员
CREATE TABLE IF NOT EXISTS persons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  role         TEXT,                  -- self/spouse/son/father/mother/custom...
  note         TEXT,
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_persons_role ON persons(role);

-- ---------------------------------------------------------------- 数据类型
-- 体检报告 / 医疗发票 / 处方 / 检查单 / 疫苗 ...
CREATE TABLE IF NOT EXISTS document_types (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE NOT NULL,   -- 'checkup' | 'invoice' | ...
  name           TEXT NOT NULL,          -- 中文名（与旧 payload.document_type 对齐）
  category       TEXT,                   -- medical / financial / other
  has_indicators INTEGER DEFAULT 0,      -- 该类型是否产出指标
  has_fees       INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------- 档案
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id       INTEGER REFERENCES persons(id),
  document_type   TEXT NOT NULL,          -- 冗余 code/中文名，方便查询
  title           TEXT,
  hospital        TEXT,
  department      TEXT,
  doctor          TEXT,
  primary_date    TEXT,                   -- 报告/单据日期 YYYY-MM-DD
  date_status     TEXT DEFAULT '已确认',   -- 已确认 / 待确认
  amount_cents    INTEGER,                 -- 金额（单位：分，避免浮点误差）
  amount_in_words TEXT,
  source_file     TEXT,                   -- 关联 files.path
  parsed_content  TEXT,                   -- 解析出的 Markdown 原文
  key_information TEXT,
  legacy_payload  TEXT,                   -- 旧库整条 JSON（溯源/回滚/兼容）
  created_at      TEXT,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_person ON documents(person_id, primary_date);
CREATE INDEX IF NOT EXISTS idx_documents_type   ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_date   ON documents(primary_date);

-- ---------------------------------------------------------------- 指标目录
-- 369 种原始指标名归一化后的结果。全部可作为「关注指标」候选。
CREATE TABLE IF NOT EXISTS indicators (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT UNIQUE NOT NULL,   -- 稳定键，如 'systolic_bp'/'total_cholesterol'
  name         TEXT NOT NULL,          -- 规范显示名
  category     TEXT,                   -- 血液/生化/尿检/影像/体征/文本...
  unit         TEXT,                   -- 首选单位
  is_composite INTEGER DEFAULT 0,      -- 复合指标（如血压含收/舒）
  parent_id    INTEGER REFERENCES indicators(id),  -- 复合指标的父项
  is_text      INTEGER DEFAULT 0,      -- 1=文本/小结类（主诉、个人史），默认不进关注列表
  sex          TEXT,                   -- 'male'/'female' = 性别专属；NULL = 男女通用
  meta         TEXT,                   -- JSON：归一化过程信息
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_indicators_cat   ON indicators(category);
CREATE INDEX IF NOT EXISTS idx_indicators_parent ON indicators(parent_id);

-- ---------------------------------------------------------------- 指标别名
-- 报告里的原始写法 → 规范指标。一义多名。
CREATE TABLE IF NOT EXISTS indicator_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator_id  INTEGER NOT NULL REFERENCES indicators(id),
  alias         TEXT NOT NULL,          -- 归一化后的匹配键（已去空白/全半角）
  raw_alias     TEXT,                   -- 报告里的原始写法（展示用）
  is_canonical  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alias_alias ON indicator_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_alias_ind   ON indicator_aliases(indicator_id);

-- ---------------------------------------------------------------- 观测值
-- 人 + 指标 + 日期 + 数值。趋势图的唯一数据源。
CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id     INTEGER NOT NULL REFERENCES persons(id),
  indicator_id  INTEGER NOT NULL REFERENCES indicators(id),
  document_id   INTEGER REFERENCES documents(id),   -- 来源档案（手动录入为 NULL）
  obs_date      TEXT NOT NULL,
  value         TEXT NOT NULL,          -- 原始值字符串（可含 '<0.1'、'阴性'）
  numeric_value REAL,                   -- 解析后的数值（可入图；非数值为 NULL）
  unit          TEXT,
  reference     TEXT,                   -- 参考范围
  flag          TEXT,                   -- ↑ / ↓ / 正常
  condition     TEXT,                   -- 测量条件（空腹/餐后）
  panel         TEXT,                   -- 所属栏目（血常规、生化...）
  source        TEXT DEFAULT 'report',  -- report / manual
  created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_person ON observations(person_id, indicator_id, obs_date);
CREATE INDEX IF NOT EXISTS idx_obs_doc    ON observations(document_id);
CREATE INDEX IF NOT EXISTS idx_obs_ind    ON observations(indicator_id);

-- ---------------------------------------------------------------- 关注指标
-- 人 × 指标。取代原来「只有 15 项可选」的硬编码目录。
CREATE TABLE IF NOT EXISTS watched_indicators (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    INTEGER NOT NULL REFERENCES persons(id),
  indicator_id INTEGER NOT NULL REFERENCES indicators(id),
  created_at   TEXT,
  UNIQUE(person_id, indicator_id)
);
CREATE INDEX IF NOT EXISTS idx_watched_person ON watched_indicators(person_id);

-- ---------------------------------------------------------------- 药品
CREATE TABLE IF NOT EXISTS drugs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id      INTEGER REFERENCES persons(id),
  name           TEXT,
  spec           TEXT,
  dosage         TEXT,
  frequency      TEXT,
  start_date     TEXT,
  end_date       TEXT,
  status         TEXT,                  -- 在用 / 已停
  note           TEXT,
  legacy_payload TEXT,                  -- 旧 JSON 原文（兼容/溯源）
  created_at     TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_drugs_person ON drugs(person_id);

-- ---------------------------------------------------------------- 收费明细
CREATE TABLE IF NOT EXISTS charge_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  name          TEXT,
  amount_cents  INTEGER,
  category      TEXT,
  quantity      TEXT
);
CREATE INDEX IF NOT EXISTS idx_charge_doc ON charge_items(document_id);

-- ---------------------------------------------------------------- 迁移标记
CREATE TABLE IF NOT EXISTS migration_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT,                      -- 来源库路径
  migrated_at TEXT,
  stats      TEXT                       -- JSON 统计
);
