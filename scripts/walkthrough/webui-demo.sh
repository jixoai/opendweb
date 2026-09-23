#!/bin/sh
# 一键启动 opendweb 本地管理台（webui sidecar），默认指向云端 demo。
#
# 注意：webui 不是服务器托管的页面——它是你本机的 sidecar 进程，
# admin token 只存在于这个进程内存里，不进浏览器、不落盘。
# （打开 http://<server>:18787 看到的是服务清单页，那不是管理台。）
#
# 用法：
#   ./scripts/walkthrough/webui-demo.sh                    # 默认云端 demo
#   SERVER=http://127.0.0.1:8787 TOKEN=xxx ./scripts/walkthrough/webui-demo.sh
# 可用环境变量：SERVER / TOKEN / PORT（默认 18950）/ 不带 --allow-insecure=NO_INSECURE
# Ctrl+C 退出。

set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="${SERVER:-http://39.107.213.167:18787}"
TOKEN="${TOKEN:-demo-admin-token}"
PORT="${PORT:-18950}"
EXTRA="--allow-insecure"
[ "${NO_INSECURE:-}" = "1" ] && EXTRA=""

echo "──────────────────────────────────────────────────────"
echo " opendweb 管理台（本地 sidecar）"
echo "   目标服务器 : ${SERVER}"
echo "   管理台地址 : http://127.0.0.1:${PORT}   ← 在浏览器打开这个"
echo "   token     : 只注入本进程，不出现在浏览器/日志"
echo "   明文告警  : demo 为 http 公网地址，属预期（自建 https 服务可去掉 --allow-insecure）"
echo "──────────────────────────────────────────────────────"

( sleep 1.5; command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${PORT}" || true ) &

cd "${ROOT}/packages/webui"
exec node src/cli.mjs --server "${SERVER}" --token "${TOKEN}" --port "${PORT}" ${EXTRA}
