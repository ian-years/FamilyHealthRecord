#!/bin/sh
# ============================================================
#  个人健康档案工作台 · 本地启动（macOS / Linux）
#  只需 Python 3，无需安装任何依赖。
# ============================================================
cd "$(dirname "$0")" || exit 1

PY=""
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
fi

if [ -z "$PY" ]; then
  echo "[错误] 没有找到 Python 3。"
  echo "       工作台需要一个本地服务来提供页面访问，因为浏览器会禁止 file:// 页面使用本地数据库。"
  echo "       安装 Python 3 后重新运行本脚本即可。"
  exit 1
fi

exec "$PY" server.py --port 8765
