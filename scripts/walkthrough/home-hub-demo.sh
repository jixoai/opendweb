#!/bin/sh
# home-hub 一键走查脚本（Owner 版）：隔离目录演示「家庭中枢」全故事，clean 一键回收。
#
# 用法: ./scripts/walkthrough/home-hub-demo.sh <命令>
#   hub-init        初始化演示中枢（隔离 DWEB_HOME，--yes）
#   hub-start       启动中枢（后台守护）
#   hub-stop        停止中枢
#   hub-status      中枢状态卡
#   hub-card        重看接入卡片（地址/短码/QR）
#   hub-open        打开中枢管理台（浏览器自动开；admin 凭据不出本机进程）
#   hub-autostart-on/off [--print]   开机自启（真实安装才有意义）
#   member-join <dwebc1邀请码> [别名]  家庭成员加入（隔离成员 DWEB_HOME）
#   member-ui       打开成员控制台（成员视角）
#   clean           停中枢 + 删除两个演示目录
#
# 环境: HUB_HOME（默认 /tmp/hh-demo-hub）/ MEMBER_HOME（默认 /tmp/hh-demo-member）
#       隔离目录只是演示便利；真实安装=去掉 DWEB_HOME 前缀直接用 opendweb hub ...。
# Ctrl+C 退出前台进程（member-ui）。

set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HUB_HOME="${HUB_HOME:-/tmp/hh-demo-hub}"
MEMBER_HOME="${MEMBER_HOME:-/tmp/hh-demo-member}"
CLI="node ${ROOT}/packages/opendweb/bin/opendweb.mjs"
WEBUI="node ${ROOT}/packages/webui/src/cli.mjs"

cmd="${1:-}"; shift 2>/dev/null || true
case "${cmd}" in
  hub-init)
    DWEB_HOME="${HUB_HOME}" ${CLI} hub init --yes "$@"
    ;;
  hub-start)   DWEB_HOME="${HUB_HOME}" ${CLI} hub start "$@" ;;
  hub-stop)    DWEB_HOME="${HUB_HOME}" ${CLI} hub stop --yes "$@" ;;
  hub-status)  DWEB_HOME="${HUB_HOME}" ${CLI} hub status "$@" ;;
  hub-card)    DWEB_HOME="${HUB_HOME}" ${CLI} hub card "$@" ;;
  hub-open)    DWEB_HOME="${HUB_HOME}" ${CLI} hub open "$@" ;;
  hub-autostart-on)  DWEB_HOME="${HUB_HOME}" ${CLI} hub autostart on "$@" ;;
  hub-autostart-off) DWEB_HOME="${HUB_HOME}" ${CLI} hub autostart off "$@" ;;
  member-join)
    [ $# -ge 1 ] || { echo "用法: member-join <dwebc1邀请码> [别名]"; exit 2; }
    CODE="$1"; ALIAS="${2:-}"
    mkdir -p "${MEMBER_HOME}"
    # 接入短码从中枢卡片读（hub card 输出的 dwebh1. 行）
    SHORT="$(DWEB_HOME="${HUB_HOME}" ${CLI} hub card | grep -o 'dwebh1\.[0-9a-z-]*' | head -1)"
    [ -n "${SHORT}" ] || { echo "未从中枢卡片解析到 dwebh1 短码——先 hub-init/hub-card"; exit 2; }
    echo "成员加入：server=${SHORT}（从中枢卡片自动读取） alias=${ALIAS:-(不自报)}"
    # shellcheck disable=SC2086
    DWEB_HOME="${MEMBER_HOME}" ${CLI} join --server "${SHORT}" --code "${CODE}" \
      ${ALIAS:+--alias "${ALIAS}"} --allow-insecure
    ;;
  member-ui)
    exec env DWEB_HOME="${MEMBER_HOME}" ${WEBUI} "$@"
    ;;
  clean)
    DWEB_HOME="${HUB_HOME}" ${CLI} hub stop --yes 2>/dev/null || true
    rm -rf "${HUB_HOME}" "${MEMBER_HOME}"
    echo "已清理 ${HUB_HOME} ${MEMBER_HOME}"
    lsof -ti :8787 :3340 2>/dev/null && echo "注意：8787/3340 仍有进程占用（可能是非演示进程，勿盲杀）" || echo "端口 8787/3340 干净"
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2 ;;
esac
