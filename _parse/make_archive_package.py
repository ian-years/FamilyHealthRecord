# -*- coding: utf-8 -*-
"""把 payload.json（已脱敏的真实体检报告归档数据）打包成网页端可导入的归档包。

归档包 = 应用「导入归档包」功能消费的 JSON 格式：
  { schema, generated_at, target, note, records: [ ... ] }
导入包内 records 会被逐条写入 target 指定的表。

注意：原始 PDF 二进制不在此包内（source_attachments 由网页端上传后回填），
脱敏检查覆盖整条记录（含 source_file / key_information / 结构化数据）。
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hrw_tokens  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAYLOAD = os.path.join(ROOT, "_parse", "payload.json")
OUT = os.path.join(ROOT, "archive-package-health-2025-12-13.json")

# 前端写入时由服务端默认值填充，归档包里不携带
STRIP_KEYS = ("attachment_pending", "attachment_note")

# 泄漏自检的关键词清单在 leak_tokens.json（不进版本库）：这些字符串本身就是
# 要在交付物里杜绝的身份信息，写成常量等于把它们一起提交进 git。
# 清单读不到就中止 —— 宁可不产出归档包，也不产出一个「没查过的说查过了」。
try:
    ID_TOKENS = hrw_tokens.load().leak_check
except hrw_tokens.TokenError as e:
    sys.stderr.write('[中止] %s\n' % e)
    raise SystemExit(2)


def main():
    with open(PAYLOAD, encoding="utf-8") as f:
        rec = json.load(f)
    for k in STRIP_KEYS:
        rec.pop(k, None)
    rec["source_attachments"] = []

    pkg = {
        "schema": "health-records-archive-package/v1",
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "target": "health_records",
        "note": ("真实体检报告的脱敏归档包：正文已完成身份信息脱敏，"
                 "原始解析产物单独私有留存用于溯源。"
                 "原始 PDF 不在包内，请在网页端「原始资料档案」中单独选择上传。"),
        "records": [rec],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)

    whole = json.dumps(pkg, ensure_ascii=False)
    leak = [t for t in ID_TOKENS if t in whole]
    tsd = rec["type_specific_data"]
    print("written        =", OUT)
    print("document_type  =", rec["document_type"], "| primary_date =", rec["primary_date"])
    print("lab_results    =", len(tsd["lab_results"]), "| exams =", len(tsd["exams"]))
    print("source_file    =", rec["source_file"])
    print("file_hash      =", rec["file_hash"][:16])
    print("REDACTION_CHECK =", leak if leak else "NONE (通过)")
    assert not leak, "归档包内残留身份标识：" + ",".join(leak)


if __name__ == "__main__":
    main()
