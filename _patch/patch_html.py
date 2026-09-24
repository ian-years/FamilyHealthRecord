# -*- coding: utf-8 -*-
"""index.html：移除登录页与云端 SDK，加入本地版的备份入口、恢复抽屉、窄屏导航开关。"""
import io

HTML = r"E:\08-Codework\FamilyHealth\app\index.html"
src = io.open(HTML, encoding="utf-8").read()
report = []


def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        raise SystemExit("[FAIL] %s：期望命中 1 处，实际 %d 处" % (label, n))
    src = src.replace(old, new, 1)
    report.append("OK  " + label)


# 1. 整块移除登录页
i = src.find("<!-- ================= 登录 ================= -->")
j = src.find("<!-- ================= 主应用 ================= -->")
if i < 0 or j <= i:
    raise SystemExit("[FAIL] 未找到登录页起止标记")
src = src[:i] + "<!-- 本地版没有登录页：打开即用，数据只在本机浏览器内 -->\n\n" + src[j:]
report.append("OK  移除登录页")

# 2. 主应用不再默认隐藏
rep('<div id="app" class="app hidden">', '<div id="app" class="app">', "主应用默认可见")

# 3. 侧栏底部：退出登录 → 备份 / 恢复 / 清空
rep(
    '    <div class="side-foot">\n'
    '      <div class="who" id="whoami"></div>\n'
    '      <button class="btn sm ghost" id="btnSignOut">退出登录</button>\n'
    '    </div>',
    '    <div class="side-foot">\n'
    '      <div class="who" id="whoami"></div>\n'
    '      <button class="btn sm" id="btnBackup" style="width:100%;margin-bottom:6px">导出备份</button>\n'
    '      <button class="btn sm ghost" id="btnRestore" style="width:100%;margin-bottom:6px">从备份恢复</button>\n'
    '      <button class="btn sm ghost" id="btnClearLocal" style="width:100%">清空本机数据</button>\n'
    '      <div style="margin-top:9px;line-height:1.65">数据只保存在本机浏览器，请定期导出备份。</div>\n'
    '    </div>',
    "侧栏底部：备份入口")

# 4. 主区顶部加窄屏导航开关
rep(
    '  <main class="main" id="main">\n'
    '    <section class="screen on" id="s-overview"></section>',
    '  <main class="main" id="main">\n'
    '    <button class="nav-toggle" id="btnSidebar" type="button" aria-label="打开导航">\n'
    '      <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M2 8h12M2 12h12"/></svg>\n'
    '      导航\n'
    '    </button>\n'
    '    <section class="screen on" id="s-overview"></section>',
    "窄屏导航开关")

# 5. 遮罩旁加窄屏侧栏遮罩
rep(
    '<div class="mask" id="mask"></div>',
    '<div class="mask" id="mask"></div>\n<div class="scrim" id="scrim"></div>',
    "窄屏侧栏遮罩")

# 6. 新增恢复抽屉
rep(
    '<div class="drawer" id="drawer-policy">',
    '<div class="drawer" id="drawer-restore">\n'
    '  <div class="dh"><h3>从备份恢复</h3><button class="btn ghost sm" data-close="1">关闭</button></div>\n'
    '  <div class="db">\n'
    '    <div class="field"><label>备份文件（.json）<span class="req">*</span></label>\n'
    '      <input type="file" id="rsFile" accept=".json,application/json">\n'
    '      <div class="hint">选择由「导出备份」生成的文件。会先校验格式，格式不符时不会写入任何内容。</div></div>\n'
    '    <div class="boundary">\n'
    '      <b>恢复会先清空再写入。</b>本机现有的四张表与全部附件都会被替换为备份内容，此操作不可撤销。<br><br>\n'
    '      <b>只合并不覆盖的恢复未实现。</b>所以恢复前请先导出一份当前备份，避免误操作后无处可退。<br><br>\n'
    '      <b>格式不符不写入。</b>只有校验通过（含 schema 标识与四张表结构）的备份才会被执行。\n'
    '    </div>\n'
    '    <div id="restoreMsg"></div>\n'
    '  </div>\n'
    '  <div class="df"><button class="btn" data-close="1">取消</button>'
    '<button class="btn primary" id="btnRestoreConfirm">确认恢复</button></div>\n'
    '</div>\n\n'
    '<div class="drawer" id="drawer-policy">',
    "新增恢复抽屉")

# 7. 脚本：去掉云端 SDK 与 config.js，改加载本地数据层
rep(
    '<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>\n'
    '<!-- 资源带版本参数：托管平台的 CDN 会长期缓存 JS/CSS，而 HTML 每次都取最新。\n'
    '     改完代码必须同步递增下面的版本号，否则用户浏览器会继续执行旧脚本。 -->\n'
    '<script src="config.js?v=20260915-3"></script>\n'
    '<script src="logic.js?v=20260915-3"></script>\n'
    '<script src="app.js?v=20260915-3"></script>',
    '<!-- 本地版不加载任何云端 SDK，也不再有配置文件：数据全部走 localdb.js 的本地存储。\n'
    '     资源仍带版本参数，便于将来换用带缓存的静态服务器时能可靠刷新。 -->\n'
    '<script src="localdb.js?v=20260915-4"></script>\n'
    '<script src="logic.js?v=20260915-4"></script>\n'
    '<script src="app.js?v=20260915-4"></script>',
    "脚本引用")

rep('<link rel="stylesheet" href="styles.css?v=20260915-3">',
    '<link rel="stylesheet" href="styles.css?v=20260915-4">',
    "样式版本号")

io.open(HTML, "w", encoding="utf-8", newline="\n").write(src)
print("\n".join(report))
print("-" * 46)
print("index.html 现在 %d 字节" % len(src.encode("utf-8")))
for kw in ["cloud-sdk", "config.js", "authScreen", "btnSignOut"]:
    print("  残留 %-12s %d" % (kw, src.count(kw)))
