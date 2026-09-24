# -*- coding: utf-8 -*-
"""补充虚构测试资料：多页收费单的第 2 页、以及一枚未过期药品的双面图。
全部为虚构数据。
"""
import os
from PIL import Image, ImageDraw, ImageFont

FX = r"E:\08-Codework\FamilyHealth\_fixtures"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def font(s, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, s)


def line(d, x, y, t, size=21, color=(34, 42, 54), bold=False):
    d.text((x, y), t, font=font(size, bold), fill=color)


def banner(d, w, text):
    d.rectangle([0, 0, w, 74], fill=(242, 245, 249))
    d.text((34, 22), text, font=font(28, True), fill=(28, 36, 48))
    d.line([0, 74, w, 74], fill=(205, 213, 223), width=2)


def mark(d, w, h):
    d.text((w - 300, h - 46), "虚构测试数据", font=font(20, True), fill=(150, 160, 175))


# ---------- 收费单第 2 页（费用明细附件） ----------

img = Image.new("RGB", (1000, 1200), "white")
d = ImageDraw.Draw(img)
w, h = img.size
banner(d, w, "虚构社区卫生服务中心  门诊收费单 · 费用明细附件")
line(d, 34, 100, "收费日期：2024-05-08", 21)
line(d, 360, 100, "票据号：FICT-R-20240508-001", 21)
line(d, 34, 134, "第 2 页 / 共 2 页", 21, (60, 70, 84), True)
line(d, 360, 134, "科室：全科门诊", 21)

rows = [
    ("明细序号", "收费项目", "执行科室", "金额", "医保类别"),
    ("1", "普通门诊诊查费", "全科门诊", "10.00", "甲类"),
    ("2", "血常规检验", "检验科", "25.00", "甲类"),
    ("3", "血糖测定", "检验科", "12.00", "甲类"),
    ("4", "尿常规检验", "检验科", "15.00", "乙类"),
    ("5", "心电图检查", "功能科", "30.00", "甲类"),
]
y = 194
cols = [34, 180, 520, 700, 820]
d.rectangle([30, y - 6, w - 30, y + 42], fill=(240, 244, 249))
for i, c in enumerate(rows[0]):
    line(d, cols[i], y + 4, c, 20, (60, 70, 84), True)
y += 58
for r in rows[1:]:
    for i, v in enumerate(r):
        line(d, cols[i], y, v, 20, (34, 42, 54), i == 3)
    d.line([30, y + 34, w - 30, y + 34], fill=(238, 241, 245))
    y += 46

y += 26
line(d, 34, y, "明细合计：92.00 元", 25, (28, 36, 48), True); y += 44
line(d, 34, y, "与收费单主单总金额一致。", 21); y += 40
line(d, 34, y, "本页为虚构测试数据，用于验证多页票据合并归档。", 18, (138, 148, 163))
mark(d, w, h)
p = os.path.join(FX, "virtual-receipt-2024-05-08-detail.png")
img.save(p)
print("收费单第2页:", p)


# ---------- 未过期药品（双面图） ----------

def drug_box(fname, face, body, bg):
    im = Image.new("RGB", (900, 700), bg)
    dd = ImageDraw.Draw(im)
    ww, hh = im.size
    dd.rectangle([14, 14, ww - 14, hh - 14], outline=(190, 198, 210), width=3)
    line(dd, 40, 36, face, 27, (28, 36, 48), True)
    y2 = 104
    for t, sz, bold in body:
        line(dd, 40, y2, t, sz, (34, 42, 54), bold)
        y2 += sz + 14
    dd.text((ww - 260, hh - 44), "虚构测试数据", font=font(19, True), fill=(150, 160, 175))
    pp = os.path.join(FX, fname)
    im.save(pp)
    return pp


p1 = drug_box("virtual-drug2-front.png", "药盒正面（虚构）", [
    ("安舒平 胶囊", 44, True),
    ("通用名称：虚构沙坦钾胶囊", 24, False),
    ("商品名：安舒平", 24, False),
    ("规格：50mg × 30 粒", 24, False),
    ("剂型：硬胶囊", 24, False),
    ("批准文号：国药准字H00000001（虚构）", 21, False),
    ("生产企业：虚构制药有限公司", 21, False),
    ("生产日期：2026-02-01", 22, False),
    ("有效期至：2028-01-31", 22, True),
], (243, 246, 250))

p2 = drug_box("virtual-drug2-back.png", "药盒背面（虚构）", [
    ("适应症：用于虚构适应症的说明文本。", 22, False),
    ("用法用量：口服。一次 1 粒，一日 1 次。", 22, False),
    ("或遵医嘱。", 22, False),
    ("贮藏：密封，在阴凉干燥处保存。", 22, False),
    ("包装：铝塑泡罩包装，30 粒 / 盒。", 22, False),
    ("数量：30 粒", 22, True),
    ("以上为通用说明，不是个人实际用药方案。", 20, True),
], (247, 250, 245))

print("药品2正面:", p1)
print("药品2背面:", p2)
