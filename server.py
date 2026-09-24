# -*- coding: utf-8 -*-
"""
个人健康档案工作台 · 本地服务
================================================================
只用 Python 标准库，不需要安装任何依赖。做四件事：

  1. 提供页面访问
     服务只监听 127.0.0.1，局域网内的其他设备访问不到。

  2. 提供数据存取接口（/api/db/*、/api/files/*）
     四张表与原始附件都写进本机磁盘的 data/ 目录，与浏览器无关：
     在浏览器里点「清除浏览数据」不会动到这里的任何一条记录。

  3. 提供本机解析接口（/api/parse，需要联网）
     POST /api/parse   接收文件 → 调用本机解析工具 → 返回原文
     GET  /api/health  报告解析工具是否就绪
     解析工具不在时接口如实返回失败，页面也把按钮标为不可用。
     本服务不伪造解析结果，也不在解析失败时返回假成功。

  4. 提供大模型结构化接口（/api/llm/*，可选，需要联网 + 自备密钥）
     解析只给原文；结构化把原文拆成字段。调用前先在本机做身份信息脱敏。

启动：
    python server.py
    python server.py --port 8899 --no-browser
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
try:
    from urllib.parse import urlparse, parse_qs, unquote
except ImportError:                                    # pragma: no cover
    from urlparse import urlparse, parse_qs            # type: ignore
    from urllib import unquote                         # type: ignore

import hrw_llm
import hrw_store
from hrw_store import StoreError

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(HERE, "app")
PROFILE = os.environ.get("XPARSE_PROFILE", "workbuddy")

MAX_FILES_PER_REQUEST = 50      # 解析服务的单请求页数上限
MAX_BODY_BYTES = 80 * 1024 * 1024
POLL_TIMEOUT_SEC = 300
# task run --wait 会一直阻塞到终态，所以进程超时要给得比轮询模式宽
RUN_WAIT_TIMEOUT_SEC = 660
CLI_WAIT_FLAG = "10m"           # 交给 CLI 自己的 --timeout，应小于上面的进程超时

# 数据层在 main() 里创建：这样命令行参数（尤其是自动化测试用的 --data-dir）才真正生效
STORE = None


def make_store(data_dir=None):
    try:
        return hrw_store.Store(HERE, data_dir=data_dir or None)
    except OSError as e:
        raise SystemExit("无法创建数据目录（%s）：%s"
                         % (data_dir or os.path.join(HERE, "data"), e))


class CliError(Exception):
    """解析工具不可用或执行失败。"""


# ---------------------------------------------------------------- 解析工具

def find_cli():
    for name in ("xparse-cli", "xparse-cli.cmd", "xparse-cli.exe", "xparse-cli.bat"):
        p = shutil.which(name)
        if p:
            return p
    # 常见安装位置兜底
    guess = os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "node",
                         "cli-connector-packages", "xparse-cli.cmd")
    if os.path.exists(guess):
        return guess
    return None


def run_cli(args, timeout=180):
    exe = find_cli()
    if not exe:
        raise CliError("未找到解析工具 xparse-cli，请确认它已安装并在 PATH 中")
    cmd = [exe, "--profile", PROFILE] + list(args)
    if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
        cmd = ["cmd.exe", "/c"] + cmd
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise CliError("解析工具执行超时（%d 秒）" % timeout)
    except OSError as e:
        raise CliError("无法启动解析工具：%s" % e)
    out = (proc.stdout or b"").decode("utf-8", "replace").strip()
    err = (proc.stderr or b"").decode("utf-8", "replace").strip()
    return proc.returncode, out, err


def extract_json(text):
    if not text:
        return None
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(text[i:j + 1])
        except Exception:
            return None
    return None


def find_ids(text):
    t = re.search(r'"task_id"\s*:\s*"([^"]+)"', text or "")
    r = re.search(r'"run_id"\s*:\s*"([^"]+)"', text or "")
    return (t.group(1) if t else None, r.group(1) if r else None)


# 解析服务拒绝请求时会返回结构化的 xparse_error.v1，里面有 message（人话原因）
# 和 next_action（下一步该干什么）。直接把整串 JSON 甩给用户等于没说，
# 这里翻成中文并附上可操作建议。
NEXT_ACTION_CN = {
    "CHECK_OR_REPLACE_FILE": "换一个文件或重新导出这份资料再试",
    "FIX_INPUT": "这是提交参数的问题，不是文件本身",
    "RETRY": "可以原样再试一次",
    "RETRY_LATER": "稍后再试",
    "UPGRADE": "需要更高档的通道才能处理",
    "CONTACT_SUPPORT": "需要联系解析服务支持",
}


def cli_error_message(text):
    """把 xparse 的结构化错误翻成人话；不是结构化错误就返回 None。"""
    obj = extract_json(text)
    if not isinstance(obj, dict):
        return None
    if obj.get("schema_version") != "xparse_error.v1":
        return None
    code = obj.get("error_code") or "未知错误"
    msg = obj.get("message") or "解析服务拒绝了这个请求"
    parts = ["%s（%s）" % (msg, code)]
    act = NEXT_ACTION_CN.get(obj.get("next_action") or "")
    if act:
        parts.append(act)
    parts.append("可以再试一次" if obj.get("retryable")
                 else "重试也不会变，需要换文件或换方式")
    return "；".join(parts)


def pdf_has_password(blob):
    """粗略判断 PDF 是否带打开密码。只在报错时用来给用户多一句准话，
    不做严格解析（严格判断需要引入 PDF 库，不值得）。"""
    return blob[:8].startswith(b"%PDF-") and b"/Encrypt" in blob


def status_args(task_id, run_id):
    a = ["task", "status", task_id]
    if run_id:
        a += ["--run-id", run_id]
    return a


def export_args(task_id, run_id, outdir):
    a = ["task", "export", task_id, "--output", outdir]
    if run_id:
        a += ["--run-id", run_id]
    return a


def find_op_id(text):
    """只拿到事件流时（task run 没加 --wait 的典型表现）里面只有 operation_id。
    把它抓出来，至少能让报错说清「任务其实已经提交了，只是没等到结果」，
    而不是笼统地报「未被受理」。"""
    m = re.search(r'"operation_id"\s*:\s*"([^"]+)"', text or "")
    return m.group(1) if m else None


_HEALTH_CACHE = {"ts": 0.0, "info": None}
_HEALTH_TTL = 15.0  # 秒：CLI 冷启动 25~60 秒，短时缓存避免每次打开上传页都等一轮


def health():
    # 短时 TTL 缓存：解析工具的就绪状态/额度不会在 15 秒内变化，
    # 重复打开上传页（每次都会探一次 /api/health）不必反复付 CLI 冷启动的代价。
    now = time.time()
    if _HEALTH_CACHE["info"] is not None and (now - _HEALTH_CACHE["ts"]) < _HEALTH_TTL:
        return _HEALTH_CACHE["info"]
    if not find_cli():
        info = {"ok": False, "reason": "未找到解析工具 xparse-cli"}
        _HEALTH_CACHE.update(ts=now, info=info)
        return info
    code, out, err = run_cli(["version"], timeout=45)
    if code != 0:
        info = {"ok": False, "reason": "解析工具不可用：%s" % ((err or out or ("退出码 %d" % code))[:200])}
        _HEALTH_CACHE.update(ts=now, info=info)
        return info

    info = {"ok": True, "profile": PROFILE, "cli": out.split()[-1] if out else ""}
    try:
        code2, out2, _ = run_cli(["quota", "--output", "json"], timeout=45)
        quota = extract_json(out2)
        if quota:
            if quota.get("authenticated") is False:
                info = {"ok": False, "reason": "解析工具尚未认证，请先在环境中完成登录"}
                _HEALTH_CACHE.update(ts=now, info=info)
                return info
            info["authenticated"] = quota.get("authenticated")
            info["daily_page_limit"] = quota.get("daily_page_limit")
            info["daily_pages_remaining"] = quota.get("daily_pages_remaining")
            info["max_pages_per_request"] = quota.get("max_pages_per_request")
            info["supported_content_types"] = quota.get("supported_content_types")
    except CliError:
        pass
    _HEALTH_CACHE.update(ts=now, info=info)
    return info


def safe_name(name):
    base = os.path.basename(str(name or "file"))
    base = re.sub(r"[^\w\u4e00-\u9fff.\-]+", "_", base).strip("._") or "file"
    return base[:80]


def read_docs(outdir):
    docs = []
    if not os.path.isdir(outdir):
        return docs
    for fn in sorted(os.listdir(outdir)):
        if fn.lower().endswith(".md"):
            path = os.path.join(outdir, fn)
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    docs.append({"name": fn[:-3], "markdown": fh.read()})
            except OSError:
                pass
    return docs


def do_parse(files, api_mode="auto"):
    """接收 base64 文件 → 提交解析 → 轮询 → 导出原文。失败一律如实抛出。"""
    if len(files) > MAX_FILES_PER_REQUEST:
        raise CliError("单次最多 %d 个文件（解析服务的单请求上限）" % MAX_FILES_PER_REQUEST)

    started = time.time()
    meta_in = [{"name": f.get("name"), "size": f.get("size")} for f in files]
    workdir = tempfile.mkdtemp(prefix="hrw_parse_")
    try:
        paths, total = [], 0
        for i, f in enumerate(files):
            raw_data = f.get("dataBase64") or ""
            try:
                blob = base64.b64decode(raw_data)
            except Exception:
                raise CliError("第 %d 个文件内容不是合法的 base64" % (i + 1))
            if not blob:
                raise CliError("第 %d 个文件是空的" % (i + 1))
            total += len(blob)
            if total > MAX_BODY_BYTES:
                raise CliError("本次提交的文件合计过大，请分批解析")
            path = os.path.join(workdir, safe_name(f.get("name")))
            with open(path, "wb") as fh:
                fh.write(blob)
            paths.append(path)

        outdir = os.path.join(workdir, "out")
        os.makedirs(outdir, exist_ok=True)

        # ⚠️ CLI v2.4.3 的 `task run` 默认是**异步**的：不加 --wait 会立刻返回一串
        # NDJSON 事件（operation_started / upload_progress …），里面只有 operation_id、
        # 没有 task_id，后面的 status / export 全都无从下手 —— 页面就报「任务未被受理」。
        # 三件套：--wait 同步等到终态、--output 顺带导出 Markdown、
        # --progress-format none 关掉事件流（否则事件行和最终 JSON 混在一起，
        # extract_json 从第一个 { 取到最后一个 } 会直接解析失败）。
        code, out, err = run_cli(
            ["task", "run", "--files"] + paths + ["--api", api_mode,
             "--wait", "--output", outdir,
             "--progress-format", "none", "--timeout", CLI_WAIT_FLAG],
            timeout=RUN_WAIT_TIMEOUT_SEC)
        task_id, run_id = find_ids(out)
        docs = read_docs(outdir)
        last_status = out

        # 兜底：CLI 万一没导出（版本差异或导出路径问题），退回显式轮询 + 导出
        if not docs and task_id:
            deadline = time.time() + POLL_TIMEOUT_SEC
            while True:
                code2, out2, _ = run_cli(status_args(task_id, run_id), timeout=90)
                last_status = out2
                run_cli(export_args(task_id, run_id, outdir), timeout=180)
                docs = read_docs(outdir)
                if docs:
                    break
                if time.time() >= deadline:
                    break
                time.sleep(2)

        if not task_id:
            # 提交阶段就被拒：多半是文件本身的问题，把解析服务的原话翻出来，
            # 并附上这次提交的文件名 —— 一次传多个时，用户得知道是哪一个出的问题。
            human = cli_error_message(err) or cli_error_message(out)
            names = "、".join(str(m.get("name") or "?") for m in meta_in[:5])
            if human:
                extra = ""
                for m, p in zip(meta_in, paths):
                    if not p.lower().endswith(".pdf"):
                        continue
                    try:
                        with open(p, "rb") as fh:
                            if pdf_has_password(fh.read()):
                                extra = ("；其中「%s」是带打开密码的 PDF，"
                                         "请先解除密码再上传" % (m.get("name") or "PDF"))
                                break
                    except OSError:
                        pass
                raise CliError("%s。本次提交的文件：%s%s" % (human, names, extra))
            op = find_op_id(out)
            raise CliError("解析任务未被受理：%s%s。本次提交的文件：%s"
                           % ((err or out)[:300],
                              "（任务其实已提交，operation %s，但没拿到 task_id —— "
                              "通常是这次调用没等它跑完）" % op if op else "", names))
        # 命令本身失败了就如实报错；命令成功但一个字都没读出来，是资料本身的问题，
        # 交给 empty_hint 提示「换个清晰原图」，不要伪装成解析失败。
        if not docs and code != 0:
            raise CliError("解析未产出内容（命令退出码 %d）：%s"
                           % (code, (err or last_status or "")[:200]))

        status = extract_json(last_status) or {}
        elapsed = round(time.time() - started, 1)
        STORE.log_parse({
            "ok": True, "task_id": task_id, "run_id": run_id, "api": api_mode,
            "elapsed": elapsed,
            "files": meta_in,
            "documents": [{"name": d["name"], "chars": len(d.get("markdown") or "")}
                          for d in docs],
            "total_chars": sum(len(d.get("markdown") or "") for d in docs),
        })
        return {
            "ok": True,
            "task_id": task_id,
            "run_id": run_id,
            "status": status,
            "documents": docs,
            "elapsed": elapsed,
            "empty_hint": ("解析服务没有从这些文件里读出任何文字。"
                           "常见原因是照片模糊、倾斜、反光，或扫描件对比度过低；"
                           "请重新拍摄（正对、光线均匀、避免阴影遮挡）后再试。")
            if all(not (d.get("markdown") or "").strip() for d in docs) else None,
        }
    except CliError as e:
        STORE.log_parse({"ok": False, "api": api_mode, "files": meta_in,
                         "elapsed": round(time.time() - started, 1), "error": str(e)})
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def end_headers(self):
        # 本地服务禁止缓存，避免改了代码浏览器仍在跑旧脚本
        self.send_header("Cache-Control", "no-store, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------------- 输出助手

    def json_out(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            # 浏览器提前断开（刷新页面/切换页面）属正常现象，不当作错误刷屏
            pass

    def bytes_out(self, blob, mime):
        try:
            self.send_response(200)
            self.send_header("Content-Type", mime or "application/octet-stream")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None, (400, {"ok": False, "reason": "请求体为空"})
        if length > MAX_BODY_BYTES:
            return None, (413, {"ok": False, "reason": "请求体过大，请分批提交"})
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")), None
        except Exception:
            return None, (400, {"ok": False, "reason": "请求体不是合法 JSON"})

    # ---------------- 路由

    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)

        try:
            if path == "/api/health":
                return self.json_out(health())
            if path == "/api/db/info":
                info = STORE.info()
                info["llm"] = hrw_llm.public_config(hrw_llm.load_config(STORE.data_dir))
                return self.json_out({"ok": True, "info": info})
            if path == "/api/db/rows":
                table = (q.get("table") or [""])[0]
                return self.json_out({"ok": True, "table": table, "rows": STORE.read_all(table)})
            if path == "/api/db/export":
                return self.json_out(STORE.export_backup())
            if path == "/api/db/snapshots":
                return self.json_out({"ok": True, "snapshots": STORE.snapshot_list()})
            if path == "/api/files/meta":
                return self.json_out({"ok": True, "files": STORE.file_meta_list(),
                                      "stats": STORE.file_stats()})
            if path == "/api/files/get":
                p = unquote((q.get("path") or [""])[0])
                rec = STORE.get_file(p)
                if not rec:
                    return self.json_out({"ok": False, "reason": "附件不存在：%s" % p}, 404)
                return self.bytes_out(rec["blob"], rec["mime_type"])
            if path == "/api/parse/log":
                limit = int((q.get("limit") or ["50"])[0] or 50)
                return self.json_out({"ok": True, "entries": STORE.read_parse_log(limit)})
            if path == "/api/persons":
                return self.json_out({"ok": True, "persons": STORE.persons(),
                                      "stats": STORE.person_stats(),
                                      "next_id": STORE.next_person_id()})
            if path == "/api/llm/config":
                return self.json_out({"ok": True, "config": hrw_llm.public_config(
                    hrw_llm.load_config(STORE.data_dir))})

            # ---- V2 · 指标与趋势
            # 计算都在后端做完，前端只负责画。
            if path == "/api/indicators":
                person = (q.get("person") or [""])[0]
                pid = int(person) if str(person).strip().isdigit() else None
                # 性别过滤跟着成员走：服务端查名单里的 gender，前端不用自己传。
                # gender=all 是目录管理页的逃生口 —— 管理视图必须能看到全部指标。
                gender = STORE.person_gender(pid) if pid is not None else None
                if (q.get("gender") or [""])[0] == "all":
                    gender = None
                return self.json_out({
                    "ok": True,
                    "indicators": STORE.list_indicators(
                        person_id=pid,
                        include_text=(q.get("include_text") or [""])[0] == "1",
                        search=(q.get("search") or [""])[0],
                        category=(q.get("category") or [""])[0],
                        only_with_data=(q.get("only_data") or [""])[0] == "1",
                        gender=gender)})

            if path == "/api/indicators/categories":
                return self.json_out({"ok": True,
                                      "categories": STORE.indicator_categories()})

            if path == "/api/indicators/get":
                key = (q.get("key") or [""])[0]
                iid = int((q.get("id") or ["0"])[0] or 0)
                if key and not iid:
                    iid = STORE.id_for_key(key) or 0
                ind = STORE.get_indicator(iid)
                if not ind:
                    return self.json_out({"ok": False, "reason": "指标不存在"}, 404)
                return self.json_out({"ok": True, "indicator": ind})

            if path == "/api/watched":
                person = (q.get("person") or [""])[0]
                pid = int(person) if str(person).strip().isdigit() else None
                return self.json_out({"ok": True, "watched": STORE.list_watched(pid)})

            if path == "/api/trend":
                person = (q.get("person") or [""])[0]
                iid = (q.get("indicator") or ["0"])[0]
                pid = int(person) if str(person).strip().isdigit() else None
                tr = STORE.trend(pid, int(iid or 0), (q.get("range") or ["all"])[0])
                if not tr:
                    return self.json_out({"ok": False, "reason": "指标不存在"}, 404)
                return self.json_out({"ok": True, "trend": tr})

            if path == "/api/observations":
                did = (q.get("doc") or ["0"])[0]
                return self.json_out({"ok": True,
                                      "observations": STORE.observations_of_document(
                                          int(did or 0))})

            if path == "/api/fees/summary":
                person = (q.get("person") or [""])[0]
                pid = int(person) if str(person).strip().isdigit() else None
                return self.json_out({"ok": True, "fees": STORE.fees_summary(pid)})

            # V2 关系表是唯一的数据结构（保留此端点，前端仍据此启用 V2 界面）
            if path == "/api/v2/status":
                return self.json_out({"ok": True, "v2": True,
                                      "tables": STORE.info().get("counts", {})})

            if path in ("/", ""):
                self.path = "/index.html"
        except (CliError, StoreError) as e:
            return self.json_out({"ok": False, "reason": str(e)})
        except Exception as e:
            return self.json_out({"ok": False, "reason": "服务端错误：%s" % e}, 500)

        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path

        if path == "/api/parse":
            body, bad = self.read_json_body()
            if bad:
                return self.json_out(bad[1], bad[0])
            files = (body or {}).get("files") or []
            if not files:
                return self.json_out({"ok": False, "reason": "没有收到文件"}, 400)
            api_mode = (body or {}).get("api") or "auto"
            if api_mode not in ("auto", "free", "paid"):
                api_mode = "auto"
            try:
                return self.json_out(do_parse(files, api_mode))
            except CliError as e:
                return self.json_out({"ok": False, "reason": str(e)})
            except Exception as e:
                return self.json_out({"ok": False, "reason": "解析失败：%s" % e}, 500)

        if not path.startswith("/api/"):
            return self.json_out({"ok": False, "reason": "未知接口：%s" % path}, 404)

        body, bad = self.read_json_body()
        if bad:
            return self.json_out(bad[1], bad[0])
        body = body or {}

        try:
            # ---- 数据表
            if path == "/api/db/put":
                table = body.get("table")
                rows = body.get("rows")
                if not isinstance(rows, list):
                    rows = [rows] if rows is not None else []
                n = STORE.upsert(table, rows)
                # 回传服务端分配的自增 id（数据层已把真实 id 写回每一行）。
                # 不回传的话，前端只能自己猜 id —— 插入后拿它去开详情必然找不到档案，
                # 撞上已存在的 id 还会被服务端当成"更新这条"而改写别人的记录。
                return self.json_out({
                    "ok": True, "written": n,
                    "ids": [r.get("id") for r in rows if isinstance(r, dict)]})

            if path == "/api/db/delete":
                n = STORE.delete(body.get("table"), body.get("ids") or [])
                return self.json_out({"ok": True, "deleted": n})

            # 删档案：连带清理不再被引用的附件。与上面那条分开，是因为这条会打快照、
            # 会动磁盘文件，而 /api/db/delete 被数据层门面的 delete 模式共用（自检要跑）。
            if path == "/api/db/delete-records":
                res = STORE.delete_records(body.get("table"), body.get("ids") or [])
                return self.json_out({"ok": True, **res})

            if path == "/api/db/clear":
                table = body.get("table")
                if table:
                    STORE.clear_table(table)
                else:
                    STORE.clear_tables()
                    STORE.clear_files()
                return self.json_out({"ok": True})

            if path == "/api/db/clear-all":
                STORE.wipe_all()
                return self.json_out({"ok": True})

            if path == "/api/db/import":
                res = STORE.import_backup(body.get("backup"),
                                          body.get("mode") or "replace")
                return self.json_out(res)

            if path == "/api/db/snapshot":
                name = STORE.snapshot(body.get("reason") or "manual")
                return self.json_out({"ok": bool(name), "name": name,
                                      "reason": None if name else "快照写入失败"})

            if path == "/api/db/restore-snapshot":
                name = hrw_store.safe_name(body.get("name") or "")
                fp = os.path.join(STORE.snap_dir, name)
                if not name or not os.path.exists(fp):
                    return self.json_out({"ok": False, "reason": "快照不存在：%s" % name}, 404)
                with open(fp, encoding="utf-8") as fh:
                    obj = json.load(fh)
                STORE.snapshot("before-restore")
                return self.json_out(STORE.import_backup(obj))

            # ---- 附件
            if path == "/api/files/put":
                p = body.get("path")
                try:
                    blob = base64.b64decode(body.get("dataBase64") or "")
                except Exception:
                    return self.json_out({"ok": False, "reason": "附件内容不是合法 base64"}, 400)
                if not blob:
                    return self.json_out({"ok": False, "reason": "附件内容为空"}, 400)
                info = STORE.put_file(p, body.get("name"), body.get("mime_type"), blob,
                                      body.get("uploaded_at"))
                return self.json_out({"ok": True, "path": info["path"], "size": info["size"]})

            if path == "/api/files/clear":
                STORE.clear_files()
                return self.json_out({"ok": True})

            # ---- 家庭成员
            if path == "/api/persons":
                saved = STORE.save_persons(body.get("persons") or [])
                return self.json_out({"ok": True, "persons": saved,
                                      "stats": STORE.person_stats()})

            if path == "/api/persons/assign":
                table = body.get("table") or "documents"
                if table not in hrw_store.TABLES:
                    return self.json_out({"ok": False, "reason": "未知的数据表：%s" % table}, 400)
                # 校验必须在快照之前：快照带附件正文（实测单份 23~31 MB），
                # 一个注定被拒的请求不该先付这份写盘。数据层里同样会再校验一次。
                STORE.check_assign_target(body.get("person_id"))
                # 批量改写不可逆：动手前先打快照，快照失败也要如实告诉用户
                snap = STORE.snapshot("before-person-assign")
                n = STORE.assign_person(table, body.get("person_id"),
                                        only_unassigned=body.get("only_unassigned", True) is not False)
                return self.json_out({"ok": True, "changed": n, "snapshot": snap})

            if path == "/api/persons/clear":
                table = body.get("table") or "documents"
                if table not in hrw_store.TABLES:
                    return self.json_out({"ok": False, "reason": "未知的数据表：%s" % table}, 400)
                STORE.check_person_id(body.get("person_id"))
                # 删除成员会牵连其名下档案的归属，同样先打快照
                snap = STORE.snapshot("before-person-clear")
                n = STORE.clear_person(table, body.get("person_id"))
                return self.json_out({"ok": True, "changed": n, "snapshot": snap})

            # ---- 大模型
            if path == "/api/llm/config":
                cur = hrw_llm.load_config(STORE.data_dir)
                incoming = body.get("config") or {}
                merged = dict(cur)
                for k in ("base_url", "model", "preset"):
                    if k in incoming:
                        merged[k] = incoming[k]
                if incoming.get("api_key"):
                    merged["api_key"] = incoming["api_key"]
                if incoming.get("clear_key"):
                    merged["api_key"] = ""
                if incoming.get("max_chars"):
                    merged["max_chars"] = incoming["max_chars"]
                saved = hrw_llm.save_config(STORE.data_dir, merged)
                return self.json_out({"ok": True, "config": hrw_llm.public_config(saved)})

            if path == "/api/llm/probe":
                cfg = hrw_llm.load_config(STORE.data_dir)
                if body.get("config"):
                    cfg = dict(cfg)
                    cfg.update(body["config"])
                return self.json_out(hrw_llm.probe(cfg))

            if path == "/api/llm/structure":
                cfg = hrw_llm.load_config(STORE.data_dir)
                try:
                    res = hrw_llm.structure(cfg, body.get("markdown"),
                                            body.get("doc_hint"),
                                            do_redact=body.get("redact", True) is not False)
                except hrw_llm.LlmError as e:
                    return self.json_out({"ok": False, "reason": str(e)})
                res["config"] = hrw_llm.public_config(cfg)
                return self.json_out(res)

            # 手动中转：不调用任何接口、不需要密钥。
            # pack 只在本机组装「提示词 + 脱敏后的原文」，交给用户自己贴；
            # adopt 只解析用户粘回来的模型输出。两个都不出网。
            if path == "/api/llm/pack":
                cfg = hrw_llm.load_config(STORE.data_dir)
                try:
                    res = hrw_llm.pack(cfg, body.get("markdown"),
                                       body.get("doc_hint"),
                                       do_redact=body.get("redact", True) is not False)
                except hrw_llm.LlmError as e:
                    return self.json_out({"ok": False, "reason": str(e)})
                return self.json_out(res)

            if path == "/api/llm/adopt":
                try:
                    res = hrw_llm.adopt(body.get("raw"))
                except hrw_llm.LlmError as e:
                    return self.json_out({"ok": False, "reason": str(e)})
                res["config"] = hrw_llm.public_config(
                    hrw_llm.load_config(STORE.data_dir))
                return self.json_out(res)

            # ---- V2 · 关注指标
            if path == "/api/watched/add":
                STORE.add_watched(body.get("person_id"), body.get("indicator_id"))
                return self.json_out({"ok": True})

            if path == "/api/watched/add-batch":
                added = STORE.add_watched_batch(body.get("person_id"),
                                               body.get("indicator_ids") or [])
                return self.json_out({"ok": True, "added": added})

            if path == "/api/watched/remove":
                STORE.remove_watched(body.get("person_id"), body.get("indicator_id"))
                return self.json_out({"ok": True})

            if path == "/api/watched/copy":
                added = STORE.copy_watched(body.get("from_person_id"),
                                           body.get("to_person_id"))
                return self.json_out({"ok": True, "added": added})

            # ---- V2 · 指标归一的人工修正
            if path == "/api/indicators/rename":
                STORE.rename_indicator(body.get("id"), (body.get("name") or "").strip())
                return self.json_out({"ok": True})

            if path == "/api/indicators/text":
                STORE.set_indicator_text_flag(body.get("id"),
                                              body.get("is_text") is True
                                              or body.get("is_text") == 1)
                return self.json_out({"ok": True})

            if path == "/api/indicators/merge":
                res = STORE.merge_indicators(body.get("keep_id"), body.get("merge_ids") or [])
                return self.json_out({"ok": True, **res})

            if path == "/api/indicators/alias":
                STORE.add_alias(body.get("id"), (body.get("alias") or "").strip())
                return self.json_out({"ok": True})

            # 历史数据补做一次单位归一
            if path == "/api/indicators/normalize-units":
                n = STORE.normalize_units()
                return self.json_out({"ok": True, "changed": n})

        except StoreError as e:
            return self.json_out({"ok": False, "reason": str(e)})
        except Exception as e:
            return self.json_out({"ok": False, "reason": "服务端错误：%s" % e}, 500)

        return self.json_out({"ok": False, "reason": "未知接口：%s" % path}, 404)


def pick_port(start, tries=20):
    import socket
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # Windows 上 SO_REUSEADDR 允许与其它进程**共享**同一端口（后绑定者
            # 抢走连接），会造成两个不同项目的工作台同时挂在 8765 上互相接客。
            # 改用 SO_EXCLUSIVEADDRUSE：端口被占就明确失败，顺延下一个。
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("从 %d 起的 %d 个端口都被占用，请用 --port 指定其他端口" % (start, tries))


def main():
    ap = argparse.ArgumentParser(description="个人健康档案工作台 · 本地服务")
    ap.add_argument("--port", type=int, default=int(os.environ.get("HRW_PORT", "8765")))
    ap.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    ap.add_argument("--data-dir", default=os.environ.get("HRW_DATA_DIR", ""),
                    help="数据目录，默认是项目下的 data\\（自动化测试可指向临时目录）")
    args = ap.parse_args()

    global STORE
    STORE = make_store(args.data_dir or None)

    if not os.path.isdir(APP_DIR):
        raise SystemExit("找不到页面目录：%s" % APP_DIR)

    port = pick_port(args.port)
    url = "http://127.0.0.1:%d/" % port

    info = STORE.info()
    total_rows = sum(info["counts"].values())

    print("=" * 64)
    print("个人健康档案工作台 · 本地服务")
    print("=" * 64)
    print("页面地址：%s" % url)
    print("数据位置：%s" % info["data_dir"])
    print("          health.db %.1f KB ｜ 附件 %d 个 %.1f MB ｜ 快照 %d 份"
          % (info["db_bytes"] / 1024.0, info["files"], info["file_bytes"] / 1048576.0,
             info["snapshots"]))
    print("当前记录：%s" % ("、".join("%s %d 条" % (k, v) for k, v in info["counts"].items())))
    print("          （数据在本机磁盘上，清除浏览器数据不会影响它）")
    print("监听范围：仅 127.0.0.1，局域网内的其他设备访问不到")

    cli = find_cli()
    if cli:
        try:
            h = health()
            if h.get("ok"):
                print("解析接口：已就绪（解析工具 %s，profile %s）"
                      % (h.get("cli") or "?", PROFILE))
                if h.get("daily_pages_remaining") is not None:
                    print("剩余额度：约 %s 页 / 每天" % h["daily_pages_remaining"])
            else:
                print("解析接口：不可用 —— %s" % h.get("reason"))
                print("          页面仍可正常使用，只是「上传并解析」会保持禁用。")
        except Exception as e:
            print("解析接口：不可用 —— %s" % e)
    else:
        print("解析接口：未找到 xparse-cli")

    llm_cfg = hrw_llm.public_config(hrw_llm.load_config(STORE.data_dir))
    if llm_cfg["configured"]:
        print("结构化模型：已配置（%s，密钥 %s）" % (llm_cfg["model"], llm_cfg["key_hint"]))
    else:
        print("结构化模型：未配置（可选功能，需要自备密钥；不配也能正常用）")

    print("-" * 64)
    print("按 Ctrl+C 停止服务")
    print("=" * 64)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
