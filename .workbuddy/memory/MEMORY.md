# FamilyHealth-V2 · 项目长期记忆

个人健康档案工作台（本机磁盘版）。正式交接文档是仓库根目录的 **`agent.md`**（改代码前先读 §8 限制与 §9 操作手册），本文件只记跨会话必须记住的约定。

## 架构（V2 是唯一真源，V1 已彻底删除）
- 数据模型：`persons` → `document_types` / `documents` → `indicators` → `observations`，外加 `indicator_aliases` / `watched_indicators` / `charge_items` / `manual_records` / `migration_log`（DDL 见 `schema.sql`）。**没有** payload / legacy_payload 列，也没有 V1 四表。
- 后端：`server.py`（HTTP，仅绑 127.0.0.1）+ `hrw_store.py`（SQLite 数据层）+ `hrw_llm.py`（结构化）。数据落 `data\`（`health.db` + `files\` + `snapshots\`）。
- 前端：`app/index.html` → `localdb.js`（数据层门面/serverDriver）→ `logic.js`（纯逻辑）→ `app.js`（主体）→ `v2.js`（V2 概览/指标详情/目录/关注）。
- 趋势与费用由**后端算好**（`/api/trend`、`/api/fees/summary`），前端只渲染，不再前端现算。

## 必须遵守的口径（踩过坑）
- **成员视图三态**：`None`=全部（不过滤）/ `0`=未指定（`person_id IS NULL`）/ 正整数=成员。后端统一走 `Store._norm_person()`；前端 `v2.js curPerson()` 对未指定返回 0。三者互斥且「各成员 + 未指定 == 全部」。
- **「点数」= `COUNT(DISTINCT obs_date)`**（有效日期数），与「记录条数」严格区分。时间范围键后端认 `'12m'/'6m'/'3y'/'5y'/'all'`。
- **`date_status` 唯一判据**：写用 `L.DATE_STATUS`，读用 `L.isDatePending` / `L.hasEffectiveDate`（非「已确认」即待确认）。
- SQLite 的 `PRAGMA foreign_keys` 在本进程是 **OFF**：外键只是声明，一致性全靠 `hrw_store.py` 写路径，别绕过 `Store` 直改库。

## 不要动的代码
- `app/logic.js` 里 **`deriveIndicatorPoints`** 与按人关注一组（`withFollowers`/`followedBy`/`setFollowFor`/`catalogForPerson`/`pruneFollowers`/`inheritFollowers`）已无生产调用方，但被 `app/tests.js` 与 `_selftest/trend_smart_unit.cjs` 覆盖 —— **作为纯逻辑库保留，删了会连带削掉自测**。

## 测试门禁（改代码后按此跑，全绿才算完成）
- `node app/run-tests.js` → 131 项
- `python _patch/check_refs.py` → 静态守卫
- `node _selftest/trend_smart_unit.cjs`（12）、`node _selftest/linechart_ordinal.cjs`
- Python 单测共 **272 项**（含 `test_server_routes.py` 30 项）
- 浏览器 E2E：`_selftest/data` 起 `8799` → `node _selftest/selftest.mjs`（231 条断言，会清空所连数据，**只能连独立数据目录**）
- `_selftest/v2check.mjs` / `fixcheck.mjs` 是**数据依赖诊断脚本**（断言真实库特定指标存在），不是门禁。

## 操作注意
- 本机沙箱会拦截批量删除与 `SystemExit`；删大目录分批，或改写到文件而非删文件（`wipe_all` 就是因此改成清空内容）。
- 写含反斜杠路径的脚本时，注意 bash heredoc + JSON 两层转义会把 `\\t` 变成真制表符 —— 用 `chr(9)/chr(92)` 或 raw string。
- Windows 工作台默认 8765（占用自动 +1，`SO_EXCLUSIVEADDRUSE` 独占绑定）；本机常用 8766。
