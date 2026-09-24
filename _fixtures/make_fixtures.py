# -*- coding: utf-8 -*-
"""生成明确标注的虚构测试资料图片（仅用于多图归档链路的真实验证）。
所有内容均为虚构，不含任何真实个人、机构或药品信息。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = r"E:\08-Codework\FamilyHealth\_fixtures"
os.makedirs(OUT, exist_ok=True)

FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
for p in (FONT_REG, FONT_BOLD):
    if not os.path.exists(p):
        raise SystemExit("缺少中文字体: " + p)


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def new_page(w=1000, h=1400):
    img = Image.new("RGB", (w, h), "white")
    return img, ImageDraw.Draw(img)


def watermark(d, w, h):
    d.text((w - 300, h - 46), "虚构测试数据", font=font(20, True), fill=(150, 160, 175))


def banner(d, w, text):
    d.rectangle([0, 0, w, 74], fill=(242, 245, 249))
    d.text((34, 22), text, font=font(28, True), fill=(28, 36, 48))
    d.line([0, 74, w, 74], fill=(205, 213, 223), width=2)


def line(d, x, y, text, size=21, color=(34, 42, 54), bold=False):
    d.text((x, y), text, font=font(size, bold), fill=color)


# ---------- 1. 同一份检验报告的两页图片 ----------

PAGE1 = [
    ("检验项目", "结果", "单位", "参考范围", "提示"),
    ("白细胞计数", "6.42", "10^9/L", "3.5-9.5", ""),
    ("红细胞计数", "4.71", "10^12/L", "4.3-5.8", ""),
    ("血红蛋白", "142", "g/L", "130-175", ""),
    ("血小板计数", "228", "10^9/L", "125-350", ""),
    ("中性粒细胞百分比", "58.2", "%", "40-75", ""),
    ("淋巴细胞百分比", "33.1", "%", "20-50", ""),
    ("空腹血糖", "5.62", "mmol/L", "3.9-6.1", ""),
    ("总胆固醇", "5.41", "mmol/L", "<=5.2", "↑"),
]
PAGE2 = [
    ("检验项目", "结果", "单位", "参考范围", "提示"),
    ("甘油三酯", "1.42", "mmol/L", "<1.7", ""),
    ("高密度脂蛋白胆固醇", "1.35", "mmol/L", ">1.0", ""),
    ("低密度脂蛋白胆固醇", "3.28", "mmol/L", "<3.36", ""),
    ("血清尿酸", "412.60", "umol/L", "208-428", ""),
    ("血清肌酐", "79.20", "umol/L", "57-97", ""),
    ("C反应蛋白", "1.8", "mg/L", "0-8", ""),
    ("尿蛋白", "阴性", "", "阴性", ""),
    ("尿糖", "阴性", "", "阴性", ""),
]
# 第 3 页：口服葡萄糖耐量试验（OGTT）与糖化血红蛋白。
# 时点写进项目名称内，便于验证「同一试验的五个时点」与「葡萄糖 / 胰岛素分开」。
PAGE3 = [
    ("检验项目", "结果", "单位", "参考范围", "提示"),
    ("葡萄糖（空腹）", "5.20", "mmol/L", "3.9-6.1", ""),
    ("葡萄糖（30分钟）", "9.80", "mmol/L", "<11.1", ""),
    ("葡萄糖（60分钟）", "10.60", "mmol/L", "<11.1", ""),
    ("葡萄糖（120分钟）", "7.90", "mmol/L", "<7.8", "↑"),
    ("葡萄糖（180分钟）", "5.40", "mmol/L", "3.9-6.1", ""),
    ("胰岛素（空腹）", "8.20", "uIU/mL", "2.6-24.9", ""),
    ("胰岛素（120分钟）", "56.30", "uIU/mL", "", ""),
    ("糖化血红蛋白", "5.50", "%", "4.0-6.0", ""),
]

REPORT_TOTAL_PAGES = 3


def draw_report_page(idx, rows, note):
    img, d = new_page()
    w, h = img.size
    banner(d, w, "虚构综合门诊部  检验报告单")
    line(d, 34, 100, "姓名：虚构测试人", 20)
    line(d, 340, 100, "性别：男", 20)
    line(d, 520, 100, "年龄：40", 20)
    line(d, 700, 100, "样本号：FICT-%d" % (900 + idx), 20)
    line(d, 34, 134, "检验日期：2024-03-15", 20)
    line(d, 340, 134, "报告日期：2024-03-15", 20)
    line(d, 700, 134, "第 %d 页 / 共 %d 页" % (idx, REPORT_TOTAL_PAGES), 20)

    y = 186
    d.rectangle([30, y - 6, w - 30, y + 42], fill=(240, 244, 249))
    cols = [34, 380, 560, 700, 880]
    for i, c in enumerate(rows[0]):
        line(d, cols[i], y + 4, c, 20, (60, 70, 84), True)
    y += 58
    for r in rows[1:]:
        vals = [r[0], r[1], r[2], r[3], r[4]]
        for i, v in enumerate(vals):
            col = (31, 95, 169) if (i == 4 and v) else (34, 42, 54)
            line(d, cols[i], y, v, 20, col, i == 1)
        d.line([30, y + 34, w - 30, y + 34], fill=(238, 241, 245))
        y += 46

    y += 14
    line(d, 34, y, note, 19, (85, 96, 111))
    y += 40
    line(d, 34, y, "本报告单为虚构测试数据，用于验证多图归档链路；不含任何真实个人信息。", 18, (138, 148, 163))
    watermark(d, w, h)
    p = os.path.join(OUT, "virtual-report-page%d.png" % idx)
    img.save(p)
    return p


# ---------- 2. 同一药品的三张图片 ----------

def draw_drug_box(face, body_lines, bg):
    img = Image.new("RGB", (900, 700), bg)
    d = ImageDraw.Draw(img)
    w, h = img.size
    d.rectangle([14, 14, w - 14, h - 14], outline=(190, 198, 210), width=3)
    line(d, 40, 36, face, 27, (28, 36, 48), True)
    y = 104
    for t, sz, bold in body_lines:
        line(d, 40, y, t, sz, (34, 42, 54), bold)
        y += sz + 14
    d.text((w - 260, h - 44), "虚构测试数据", font=font(19, True), fill=(150, 160, 175))
    return img


def draw_drug_images():
    paths = []
    img = draw_drug_box("药盒正面（虚构）", [
        ("福莫净 片", 44, True),
        ("通用名称：虚构他汀钙片", 24, False),
        ("商品名：福莫净", 24, False),
        ("规格：20mg × 14 片", 24, False),
        ("剂型：薄膜衣片", 24, False),
        ("批准文号：国药准字H00000000（虚构）", 21, False),
        ("生产企业：虚构制药有限公司", 21, False),
        ("生产日期：2024-01-10", 22, False),
        ("有效期至：2026-01-09", 22, True),
    ], (250, 246, 238))
    p = os.path.join(OUT, "virtual-drug-front.png"); img.save(p); paths.append(p)

    img = draw_drug_box("药盒背面（虚构）", [
        ("适应症：用于虚构适应症的描述文本。", 22, False),
        ("用法用量：口服。一次 1 片，一日 1 次。", 22, False),
        ("或遵医嘱。", 22, False),
        ("不良反应、禁忌、注意事项详见说明书。", 21, False),
        ("贮藏：密封，在干燥处保存。", 22, False),
        ("包装：铝塑泡罩包装，14 片 / 盒。", 22, False),
        ("数量：14 片", 22, True),
    ], (246, 249, 243))
    p = os.path.join(OUT, "virtual-drug-back.png"); img.save(p); paths.append(p)

    img = draw_drug_box("说明书摘录（虚构）", [
        ("【药品名称】虚构他汀钙片", 22, False),
        ("【成分】本品主要成分为虚构他汀钙。", 22, False),
        ("【适应症】用于虚构适应症的说明。", 22, False),
        ("【用法用量】口服，一次 1 片，一日 1 次。", 22, False),
        ("【孕妇及哺乳期妇女用药】尚不明确。", 21, False),
        ("【药物相互作用】尚不明确。", 21, False),
        ("【有效期】24 个月。", 22, False),
        ("以上为说明书通用内容，不是个人实际用药方案。", 20, True),
    ], (249, 247, 252))
    p = os.path.join(OUT, "virtual-drug-leaflet.png"); img.save(p); paths.append(p)
    return paths


# ---------- 3. 虚构收费单 ----------

def draw_receipt():
    img, d = new_page(1000, 1200)
    w, h = img.size
    banner(d, w, "虚构社区卫生服务中心  门诊收费单")
    line(d, 34, 100, "收费日期：2024-05-08", 21)
    line(d, 360, 100, "结算时间：2024-05-08 10:24", 21)
    line(d, 34, 134, "票据号：FICT-R-20240508-001", 21)
    line(d, 360, 134, "科室：全科门诊", 21)

    rows = [
        ("收费项目", "单价", "数量", "金额", "医保类别"),
        ("普通门诊诊查费", "10.00", "1", "10.00", "甲类"),
        ("血常规检验", "25.00", "1", "25.00", "甲类"),
        ("血糖测定", "12.00", "1", "12.00", "甲类"),
        ("尿常规检验", "15.00", "1", "15.00", "乙类"),
        ("心电图检查", "30.00", "1", "30.00", "甲类"),
    ]
    y = 194
    cols = [34, 400, 540, 660, 810]
    d.rectangle([30, y - 6, w - 30, y + 42], fill=(240, 244, 249))
    for i, c in enumerate(rows[0]):
        line(d, cols[i], y + 4, c, 20, (60, 70, 84), True)
    y += 58
    for r in rows[1:]:
        for i, v in enumerate(r):
            line(d, cols[i], y, v, 20, (34, 42, 54), i == 3)
        d.line([30, y + 34, w - 30, y + 34], fill=(238, 241, 245))
        y += 46

    y += 24
    line(d, 34, y, "总金额：92.00 元", 26, (28, 36, 48), True); y += 46
    line(d, 34, y, "大写金额：玖拾贰元整", 22); y += 38
    line(d, 34, y, "医保支付：64.00 元", 22); y += 34
    line(d, 34, y, "个人支付：28.00 元", 22); y += 34
    line(d, 34, y, "支付方式：医保个人账户 + 现金", 21); y += 44
    line(d, 34, y, "本收费单为虚构测试数据，仅用于验证票据归档与费用统计链路。", 18, (138, 148, 163))
    watermark(d, w, h)
    p = os.path.join(OUT, "virtual-receipt-2024-05-08.png")
    img.save(p)
    return p


if __name__ == "__main__":
    p1 = draw_report_page(1, PAGE1, "本页为第 1 页，含血常规与血糖、总胆固醇。")
    p2 = draw_report_page(2, PAGE2, "本页为第 2 页，含血脂其余三项、尿酸、肌酐与尿常规。")
    p3 = draw_report_page(3, PAGE3, "本页为第 3 页，含口服葡萄糖耐量试验（5 个时点）与糖化血红蛋白。")
    drugs = draw_drug_images()
    rc = draw_receipt()
    print("报告第1页:", p1)
    print("报告第2页:", p2)
    print("报告第3页:", p3)
    for d in drugs:
        print("药品图:", d)
    print("收费单:", rc)
