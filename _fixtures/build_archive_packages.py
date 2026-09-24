# -*- coding: utf-8 -*-
"""由已授权的解析产物构建脱敏归档包（虚构测试数据，标题带【虚构】前缀便于识别与清理）。
结构化字段由编写来源数据确定性生成，并与解析出的 Markdown 逐项比对，确保「解析结果 = 结构化结果」。
"""
import hashlib
import json
import os
import re
import datetime

ROOT = r"E:\08-Codework\FamilyHealth"
FX = os.path.join(ROOT, "_fixtures")
PARSE = os.path.join(ROOT, "_parse")


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def group_hash(files):
    """一组来源文件的组合哈希：顺序稳定，用于同一逻辑档案的幂等识别。"""
    h = hashlib.sha256()
    for p in files:
        h.update(os.path.basename(p).encode("utf-8"))
        h.update(sha256_file(p).encode("ascii"))
    return h.hexdigest()


def clean_ref(s):
    """清理 OCR 带出的公式标记（如 $<=5.2$ → <=5.2），不改动数值与语义。"""
    if not s:
        return None
    return re.sub(r"\$", "", s).strip()


# ---------------- 1. 检验报告（两页 → 一个逻辑档案） ----------------

REPORT_TASK = "c683285beb2b491c9f2e15cb509f33ae"
REPORT_RUN = "ba110c037784380f9f1506dcb7d4c14c"
REPORT_FILES = [os.path.join(FX, n) for n in
                ("virtual-report-page1.png", "virtual-report-page2.png", "virtual-report-page3.png")]

# (面板, 项目, 结果, 单位, 参考范围, 原标记, 页码, 条件/时点)
LABS = [
    ("血常规五分类", "白细胞计数", "6.42", "10^9/L", "3.5-9.5", None, 1, None),
    ("血常规五分类", "红细胞计数", "4.71", "10^12/L", "4.3-5.8", None, 1, None),
    ("血常规五分类", "血红蛋白", "142", "g/L", "130-175", None, 1, None),
    ("血常规五分类", "血小板计数", "228", "10^9/L", "125-350", None, 1, None),
    ("血常规五分类", "中性粒细胞百分比", "58.2", "%", "40-75", None, 1, None),
    ("血常规五分类", "淋巴细胞百分比", "33.1", "%", "20-50", None, 1, None),
    ("生化-血糖", "空腹血糖", "5.62", "mmol/L", "3.9-6.1", None, 1, None),
    ("生化-血脂", "总胆固醇", "5.41", "mmol/L", "<=5.2", "↑", 1, None),
    ("生化-血脂", "甘油三酯", "1.42", "mmol/L", "<1.7", None, 2, None),
    ("生化-血脂", "高密度脂蛋白胆固醇", "1.35", "mmol/L", ">1.0", None, 2, None),
    ("生化-血脂", "低密度脂蛋白胆固醇", "3.28", "mmol/L", "<3.36", None, 2, None),
    ("生化-肾功", "血清尿酸", "412.60", "μmol/L", "208-428", None, 2, None),
    ("生化-肾功", "血清肌酐", "79.20", "μmol/L", "57-97", None, 2, None),
    ("生化", "C 反应蛋白", "1.8", "mg/L", "0-8", None, 2, None),
    ("尿常规", "尿蛋白", "阴性", None, "阴性", None, 2, None),
    ("尿常规", "尿糖", "阴性", None, "阴性", None, 2, None),
    # 第 3 页：口服葡萄糖耐量试验（同一次试验的 5 个葡萄糖时点 + 2 个胰岛素时点）
    ("口服葡萄糖耐量试验", "葡萄糖（空腹）", "5.20", "mmol/L", "3.9-6.1", None, 3, "空腹"),
    ("口服葡萄糖耐量试验", "葡萄糖（30 分钟）", "9.80", "mmol/L", "<11.1", None, 3, "30 分钟"),
    ("口服葡萄糖耐量试验", "葡萄糖（60 分钟）", "10.60", "mmol/L", "<11.1", None, 3, "60 分钟"),
    ("口服葡萄糖耐量试验", "葡萄糖（120 分钟）", "7.90", "mmol/L", "<7.8", "↑", 3, "120 分钟"),
    ("口服葡萄糖耐量试验", "葡萄糖（180 分钟）", "5.40", "mmol/L", "3.9-6.1", None, 3, "180 分钟"),
    ("口服葡萄糖耐量试验", "胰岛素（空腹）", "8.20", "μIU/mL", "2.6-24.9", None, 3, "空腹"),
    ("口服葡萄糖耐量试验", "胰岛素（120 分钟）", "56.30", "μIU/mL", None, None, 3, "120 分钟"),
    ("糖化血红蛋白", "糖化血红蛋白", "5.50", "%", "4.0-6.0", None, 3, None),
]
LAB_PANELS = ["血常规五分类", "生化-血糖", "生化-血脂", "生化-肾功", "生化", "尿常规",
              "口服葡萄糖耐量试验", "糖化血红蛋白"]

# OCR 与原图不一致处：按指令 §09 回到原图核对后更正，并保留记录（不擅自改成「更合理」的数值）
OCR_CORRECTIONS = [
    {"field": "unit", "item": "胰岛素（空腹）/ 胰岛素（120 分钟）",
     "parsed": "ulU/mL", "original_image": "uIU/mL",
     "reason": "OCR 把大写 I 识别成小写 l；回原图核对为 uIU/mL，仅更正单位写法，数值未改。"},
    {"field": "name", "item": "葡萄糖（30 分钟）等",
     "parsed": "葡萄糖（30 分钟）", "original_image": "葡萄糖（30分钟）",
     "reason": "OCR 在数字与「分钟」之间多出空格；项目名称的时点含义不变，保留解析原样，时点识别已兼容空格。"},
]


def collect_md(folder, names):
    out = []
    for n in names:
        p = os.path.join(folder, n)
        with open(p, encoding="utf-8") as f:
            out.append(f.read())
    return "\n\n<!-- 第 %d 页 -->\n\n".join(out) if len(out) > 1 else out[0]


def build_report():
    md = collect_md(os.path.join(PARSE, "fixtures-report3"),
                    ["virtual-report-page1.md", "virtual-report-page2.md",
                     "virtual-report-page3.md"])
    # 断言解析结果与结构化结果一致（逐项回查解析出的 Markdown）
    for _panel, name, res, _unit, _ref, _fl, _pg, _cond in LABS:
        assert name.replace(" ", "") in md.replace(" ", ""), "解析结果缺少项目：" + name
        assert res in md, "解析结果缺少结果值：" + res
    assert "共3页" in md.replace(" ", ""), "解析结果未标注三页"
    body = [
        "【本资料为虚构测试数据，不含任何真实个人信息；用于验证多图（三页）归档链路。】",
        "",
        md,
    ]
    tsd = {
        "report_kind": "lab_report",
        "lab_results": [
            {
                "name": n, "result": r, "unit": u,
                "reference": clean_ref(ref), "flag": fl, "panel": panel,
                "page": pg, "condition": cond, "source_note": "原文照录",
            }
            for (panel, n, r, u, ref, fl, pg, cond) in LABS
        ],
        "lab_panels": LAB_PANELS,
        "specimen": {"sample_no": "FICT-901 / FICT-902 / FICT-903", "report_note": "样本号与页码来自原文"},
        "inner_dates": [
            {"date": "2024-03-15", "meaning": "检验日期与报告日期（原文同一天）"},
        ],
        "multi_page_note": "同一份报告共 3 页，按一个逻辑档案归档，全部页保留在附件中。",
        "flag_note": "「总胆固醇」「葡萄糖（120 分钟）」两项原报告印有 ↑，此处照录；其余项目原报告未印标记。",
        "ocr_corrections": OCR_CORRECTIONS,
        "virtual_data": True,
    }
    return {
        "document_type": "检验报告",
        "primary_date": "2024-03-15",
        "date_status": "已确认",
        "hospital": "虚构综合门诊部",
        "department": "检验科",
        "doctor": None,
        "title": "【虚构】检验报告单（2024-03-15 · 3 页）",
        "key_information": "虚构检验报告，共 3 页、24 项检验结果\n"
                           "含血常规五分类、空腹血糖、血脂四项、血清尿酸、血清肌酐、尿常规，"
                           "以及口服葡萄糖耐量试验（葡萄糖 5 个时点、胰岛素 2 个时点）与糖化血红蛋白\n"
                           "本资料为虚构测试数据，不含任何真实个人信息",
        "amount": None,
        "source_file": "virtual-report-page1.png、virtual-report-page2.png、virtual-report-page3.png",
        "source_attachments": [],
        "parsed_content": "\n".join(body),
        "type_specific_data": tsd,
        "parse_status": "已归档",
        "xparse_task_id": REPORT_TASK,
        "xparse_run_id": REPORT_RUN,
        "file_hash": group_hash(REPORT_FILES),
    }


# ---------------- 2. 药品（三图 → 一个逻辑药品） ----------------

DRUG_TASK = "cb3d75c6379f4710a72cab4bdd42dad2"
DRUG_RUN = "f692e6649127278b5b07da7e2f4fe5b7"
DRUG_FILES = [os.path.join(FX, n) for n in
              ("virtual-drug-front.png", "virtual-drug-back.png", "virtual-drug-leaflet.png")]


def build_drug():
    md = collect_md(os.path.join(PARSE, "fixtures-drug"),
                    ["virtual-drug-front.md", "virtual-drug-back.md", "virtual-drug-leaflet.md"])
    for kw in ["福莫净", "虚构他汀钙片", "20mg", "薄膜衣片", "2026-01-09", "14 片"]:
        assert kw.replace(" ", "") in md.replace(" ", ""), "药品解析结果缺少：" + kw
    return {
        "drug_key": "虚构他汀钙片|20mg|薄膜衣片",
        "drug_name": "【虚构】福莫净片",
        "generic_name": "虚构他汀钙片",
        "brand_name": "福莫净（虚构）",
        "strength": "20mg",
        "dosage_form": "薄膜衣片",
        "dose_each_time": None,
        "frequency": None,
        "timing": None,
        "route": "口服（原文说明）",
        "start_date": None,
        "planned_end_date": None,
        "expiry_date": "2026-01-09",
        "quantity": 14,
        "doctor": None,
        "hospital": None,
        "purpose_text": "用于虚构适应症的描述文本。（原文照录）",
        "instructions": "口服。一次 1 片，一日 1 次；或遵医嘱。\n贮藏：密封，在干燥处保存。\n包装：铝塑泡罩包装，14 片／盒。\n（以上为药盒与说明书通用内容，不是个人实际用药方案）",
        "source_document": "【虚构】福莫净片药盒正面 / 背面 / 说明书摘录",
        "source_document_record_id": None,
        "source_document_date": None,
        "status": "备用药",
        "history": [],
        "has_conflict": True,
        "conflict_text": "药盒正面标注规格 20mg×14 片、有效期内 2026-01-09；说明书摘录标称有效期 24 个月（自生产日期 2024-01-10 计，两者一致）。此处仅陈述两条来源的表述差异，不判断哪种用药方案更正确。",
        "parsed_content": "【本资料为虚构测试数据。同一药品的 3 张图片按一个逻辑药品归档，全部图片保留。】\n\n" + md,
        "source_attachments": [],
        "xparse_task_id": DRUG_TASK,
        "xparse_run_id": DRUG_RUN,
        "file_hash": group_hash(DRUG_FILES),
    }


# ---------------- 3. 收费单 ----------------

RC_TASK = "400595a48cd140c985e365702e6304e2"
RC_RUN = "13c7f7ae7a53cd965b085e9a2c6d13fb"
RC_FILES = [os.path.join(FX, n) for n in
            ("virtual-receipt-2024-05-08.png", "virtual-receipt-2024-05-08-detail.png")]

CHARGES = [
    {"name": "普通门诊诊查费", "unit_price": "10.00", "qty": "1", "amount": "10.00", "insurance_type": "甲类"},
    {"name": "血常规检验", "unit_price": "25.00", "qty": "1", "amount": "25.00", "insurance_type": "甲类"},
    {"name": "血糖测定", "unit_price": "12.00", "qty": "1", "amount": "12.00", "insurance_type": "甲类"},
    {"name": "尿常规检验", "unit_price": "15.00", "qty": "1", "amount": "15.00", "insurance_type": "乙类"},
    {"name": "心电图检查", "unit_price": "30.00", "qty": "1", "amount": "30.00", "insurance_type": "甲类"},
]


def build_receipt():
    md = collect_md(os.path.join(PARSE, "fixtures-receipt2"),
                    ["virtual-receipt-2024-05-08.md", "virtual-receipt-2024-05-08-detail.md"])
    for kw in ["92.00", "64.00", "28.00", "心电图检查", "玖拾贰元整",
               "FICT-R-20240508-001", "第2页", "明细合计：92.00元"]:
        assert kw.replace(" ", "") in md.replace(" ", ""), "收费单解析结果缺少：" + kw
    # 票据号在两页中一致 → 判定为同一张票据的多页，合并为一条记录、两个附件
    assert md.count("FICT-R-20240508-001") == 2, "两页票据号不一致，无法判定为同一张票据"
    total = sum(float(c["amount"]) for c in CHARGES)
    assert abs(total - 92.0) < 1e-9, "明细金额合计与总额不符：" + str(total)
    return {
        "document_type": "医疗发票/收费单",
        "primary_date": "2024-05-08",
        "date_status": "已确认",
        "hospital": "虚构社区卫生服务中心",
        "department": "全科门诊",
        "doctor": None,
        "title": "【虚构】门诊收费单（2024-05-08 · 2 页）",
        "key_information": "虚构门诊收费单，共 2 页、收费项目 5 项\n总金额 92.00 元，其中医保支付 64.00 元、个人支付 28.00 元\n两页票据号同为 FICT-R-20240508-001，按同一张票据合并归档\n本资料为虚构测试数据，不含任何真实交易信息",
        "amount": 92.00,
        "source_file": "virtual-receipt-2024-05-08.png、virtual-receipt-2024-05-08-detail.png",
        "source_attachments": [],
        "parsed_content": "【本资料为虚构测试数据，仅用于验证多页票据合并归档与费用统计链路。】\n\n" + md,
        "type_specific_data": {
            "total_amount": 92.00,
            "insurance_payment": 64.00,
            "self_payment": 28.00,
            "amount_in_words": "玖拾贰元整",
            "settle_time": "2024-05-08 10:24",
            "payment_method": "医保个人账户 + 现金",
            "charge_items": CHARGES,
            "invoice_no": "FICT-R-20240508-001",
            "page_count": 2,
            "multi_page_note": "同一票据号 FICT-R-20240508-001 出现在 2 页上，按一张票据归档；第 2 页明细合计 92.00 元与主单总金额一致，作为页间对账凭据。",
            "cross_page_check": {"第一页总金额": 92.00, "第二页明细合计": 92.00, "一致": True},
            "virtual_data": True,
            "scope_note": "收费单只说明收费项目和金额，不据此推断确诊疾病、检查所见、治疗实施或服药事实。",
        },
        "parse_status": "已归档",
        "xparse_task_id": RC_TASK,
        "xparse_run_id": RC_RUN,
        "file_hash": group_hash(RC_FILES),
    }


# ---------------- 4. 第二枚药品（未过期，用于验证状态流转） ----------------

DRUG2_TASK = "fef3bcf213ab4b1bb87953cb30b91609"
DRUG2_RUN = "5436268134eee64229ee484dcd14423b"
DRUG2_FILES = [os.path.join(FX, n) for n in ("virtual-drug2-front.png", "virtual-drug2-back.png")]


def build_drug2():
    md = collect_md(os.path.join(PARSE, "fixtures-drug2"),
                    ["virtual-drug2-front.md", "virtual-drug2-back.md"])
    for kw in ["安舒平", "虚构沙坦钾胶囊", "50mg", "硬胶囊", "2028-01-31", "30粒"]:
        assert kw.replace(" ", "") in md.replace(" ", ""), "药品解析结果缺少：" + kw
    return {
        "drug_key": "虚构沙坦钾胶囊|50mg|硬胶囊",
        "drug_name": "【虚构】安舒平胶囊",
        "generic_name": "虚构沙坦钾胶囊",
        "brand_name": "安舒平（虚构）",
        "strength": "50mg",
        "dosage_form": "硬胶囊",
        "dose_each_time": None,
        "frequency": None,
        "timing": None,
        "route": "口服（原文说明）",
        "start_date": None,
        "planned_end_date": None,
        "expiry_date": "2028-01-31",
        "quantity": 30,
        "doctor": None,
        "hospital": None,
        "purpose_text": "用于虚构适应症的说明文本。（原文照录）",
        "instructions": "口服。一次 1 粒，一日 1 次；或遵医嘱。\n贮藏：密封，在阴凉干燥处保存。\n包装：铝塑泡罩包装，30 粒／盒。\n（以上为药盒通用内容，不是个人实际用药方案）",
        "source_document": "【虚构】安舒平胶囊药盒正面 / 背面",
        "source_document_record_id": None,
        "source_document_date": None,
        "status": "备用药",
        "history": [],
        "has_conflict": False,
        "conflict_text": None,
        "parsed_content": "【本资料为虚构测试数据。同一药品的 2 张图片按一个逻辑药品归档，全部图片保留。】\n\n" + md,
        "source_attachments": [],
        "xparse_task_id": DRUG2_TASK,
        "xparse_run_id": DRUG2_RUN,
        "file_hash": group_hash(DRUG2_FILES),
    }


def write_pkg(name, target, records, note):
    pkg = {
        "schema": "health-records-archive-package/v1",
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "target": target,
        "note": note,
        "records": records,
    }
    p = os.path.join(ROOT, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
    return p


if __name__ == "__main__":
    r = build_report()
    d = build_drug()
    d2 = build_drug2()
    c = build_receipt()

    print(write_pkg("archive-package-fixture-report.json", "health_records", [r],
                    "虚构测试数据：同一份报告 2 页 → 1 条档案、2 个附件。原始文件需在归档时单独选择。"))
    print(write_pkg("archive-package-fixture-drug.json", "drugs", [d, d2],
                    "虚构测试数据：两枚药品，各自多张图片 → 各 1 条药品。一枚已过有效期、一枚未过期，用于验证状态流转。"))
    print(write_pkg("archive-package-fixture-receipt.json", "health_records", [c],
                    "虚构测试数据：同一票据号 2 页 → 1 条票据、2 个附件，含逐项收费与支付拆分。"))

    print()
    print("报告：检验项 %d 项，组合哈希 %s" % (len(r["type_specific_data"]["lab_results"]), r["file_hash"][:16]))
    print("药品A：drug_key=%s，有效期=%s，冲突已标注=%s，哈希 %s"
          % (d["drug_key"], d["expiry_date"], d["has_conflict"], d["file_hash"][:16]))
    print("药品B：drug_key=%s，有效期=%s，冲突已标注=%s，哈希 %s"
          % (d2["drug_key"], d2["expiry_date"], d2["has_conflict"], d2["file_hash"][:16]))
    print("票据：总额 %.2f，页数 %d，明细 %d 项，医保 %.2f，个人 %.2f，哈希 %s"
          % (c["amount"], c["type_specific_data"]["page_count"], len(c["type_specific_data"]["charge_items"]),
             c["type_specific_data"]["insurance_payment"], c["type_specific_data"]["self_payment"], c["file_hash"][:16]))
