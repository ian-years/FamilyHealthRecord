"""静态检查 app.js：① 被当作事件处理器引用却从未定义的标识符；② 计数文案与实际取数不符；
③ 日期状态的字面量绕过统一谓词。

②③ 对应两类反复出现的缺陷：「结果记录数」写着、算的却是趋势连线点数（D33/I3）；
`date_status` 有两种拼法而读方只认一种，导致「日期待确认」的资料照样进趋势（C1）。
这两类都能靠"扫源码"当场逮住，不需要跑浏览器。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "app" / "app.js"
LOGIC = ROOT / "app" / "logic.js"
src = TARGET.read_text(encoding="utf-8")

# 1. 收集所有「定义」：function NAME( / var NAME = / NAME = function / window.NAME =
defined = set()
defined |= set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", src))
defined |= set(re.findall(r"\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=", src))
defined |= set(re.findall(r"\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b", src))
defined |= set(re.findall(r"\bwindow\.([A-Za-z_$][\w$]*)\s*=", src))
defined |= set(re.findall(r"\bfunction\s*([A-Za-z_$][\w$]*)\s*\(", src))
# 函数参数、局部 forEach 回调等：把「形参」也算作定义，避免误报
defined |= set(re.findall(r"function\s*\(([^)]*)\)", src) and [])
for group in re.findall(r"function\s*\(([^)]*)\)", src):
    for part in group.split(","):
        name = part.strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            defined.add(name)
defined |= set(re.findall(r"\(([^)]*)\)\s*=>", src))
defined |= set(re.findall(r"\bfor\s*\(\s*(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s+of\b", src))

BUILTIN = {
    "alert", "confirm", "prompt", "parseInt", "parseFloat", "isNaN", "isFinite",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch",
    "encodeURIComponent", "decodeURIComponent", "print", "open", "close",
    "String", "Number", "Boolean", "Array", "Object", "JSON", "Date", "Math",
    "Promise", "Map", "Set", "Blob", "FileReader", "URL", "TextEncoder",
    "structuredClone", "queueMicrotask", "requestAnimationFrame",
}

# 2. 收集所有「处理器引用」
pattern = re.compile(r"\.(onclick|onchange|onsubmit|oninput|onkeydown|onblur)\s*=\s*([A-Za-z_$][\w$]*)\s*;")
hits = []
for m in pattern.finditer(src):
    name = m.group(2)
    line = src[:m.start()].count("\n") + 1
    hits.append((line, m.group(1), name))

# 3. 计数文案 ↔ 实际取数 必须配对（D33 / I3 的复发守卫）
#    「结果记录数」「记录次数」只能是 list.length 那一类；连线点数的说法是
#    「参与连线 N 点」「N 个有效点」。同一行里混用就等于界面在说谎。
LABELS_STRICT = ("结果记录数", "记录次数")
MEASURE_SRC = ("connected.length", "distinctDates.length")
label_hits = []
for n, line in enumerate(src.split("\n"), 1):
    if any(lab in line for lab in LABELS_STRICT) and any(s in line for s in MEASURE_SRC):
        label_hits.append((n, line.strip()[:110]))

# 4. 日期状态一律走 L.DATE_STATUS / L.isDatePending（C1 的复发守卫）
STATUS_LITERALS = ("'待确认'", "'日期待确认'", "'已确认'")
status_hits = []
for n, line in enumerate(src.split("\n"), 1):
    if "date_status" in line and any(lit in line for lit in STATUS_LITERALS):
        status_hits.append((n, line.strip()[:110]))
logic_src = LOGIC.read_text(encoding="utf-8")
logic_status = []
for n, line in enumerate(logic_src.split("\n"), 1):
    if any(lit in line for lit in STATUS_LITERALS) and "DATE_STATUS = {" not in line:
        if "date_status" in line or "CONFIRMED" in line or "PENDING" in line:
            logic_status.append((n, line.strip()[:110]))

# 5. 报告
missing = []
for line, evt, name in hits:
    if name in defined or name in BUILTIN:
        continue
    missing.append((line, evt, name))

print("扫描文件：%s" % TARGET)
print("处理器赋值共 %d 处，涉及 %d 个不同标识符" % (len(hits), len({h[2] for h in hits})))
print()
bad = False
if missing:
    bad = True
    print("!! 未找到定义的处理器引用（%d 处）：" % len(missing))
    for line, evt, name in missing:
        print("   L%-6d %-10s -> %s" % (line, evt, name))
else:
    print("OK：所有处理器引用都有对应定义。")

if label_hits:
    bad = True
    print("!! 「结果记录数 / 记录次数」与连线点数写在同一行（%d 处）：" % len(label_hits))
    for n, t in label_hits:
        print("   L%-6d %s" % (n, t))
    print("   怎么改：数记录就用 list.length 并保留文案；数连线点请说「参与连线 N 点」。")
else:
    print("OK：计数文案与实际取数没有混用。")

if status_hits or logic_status:
    bad = True
    print("!! 直接比较 / 赋值 date_status 字面量（%d 处），请改用 L.DATE_STATUS 与 L.isDatePending："
          % (len(status_hits) + len(logic_status)))
    for n, t in status_hits:
        print("   app.js  L%-6d %s" % (n, t))
    for n, t in logic_status:
        print("   logic.js L%-5d %s" % (n, t))
else:
    print("OK：日期状态只经 L.DATE_STATUS / L.isDatePending 读写。")

sys.exit(1 if bad else 0)
