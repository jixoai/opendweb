#!/usr/bin/env bash
# server-access-policy 云端故事一键验证/走查（幂等：云端已部署则跳过部署）
# 用法：
#   scripts/sap-verify.sh                   # 全流程（编译→预铸→部署→验证 S1-S8）
#   scripts/sap-verify.sh --teardown-only   # 只清理云端与本地工作目录
#   SAP_CLOUD_HOST=xxx scripts/sap-verify.sh  # 自定义目标机（默认 gaubee-cloud）
# 依赖：rustup + cargo-zigbuild（x86_64-unknown-linux-musl）、目标机 ssh 免密
set -euo pipefail
cd "$(dirname "$0")/.."

CLOUD_HOST="${SAP_CLOUD_HOST:-gaubee-cloud}"
CLOUD_DIR="/tmp/opendweb-sap-verify"
CLOUD_BIN="/tmp/dweb-server-sap"
GW_PORT="${SAP_GW_PORT:-18787}"
RELAY_PORT="${SAP_RELAY_PORT:-13340}"
SSH="/usr/bin/ssh -o ConnectTimeout=10 $CLOUD_HOST"
SCP="/usr/bin/scp -o ConnectTimeout=10"
# rustup 工具链必须优先于 homebrew rust（musl target 挂在 rustup 侧）
export PATH="$HOME/.cargo/bin:$PATH"

cloud_ip() {
  grep -A5 "^Host $CLOUD_HOST\$" ~/.ssh/config | grep -i hostname | awk '{print $2}' | head -1
}

teardown() {
  echo "== 云端清理（${CLOUD_HOST}）=="
  $SSH "pkill -f dweb-server-sap 2>/dev/null; rm -rf $CLOUD_DIR $CLOUD_BIN; echo cleaned" 2>/dev/null | grep -v -i warning || true
  echo "== 本地工作目录清理 =="
  cargo run --quiet --example cloud_story clean 2>/dev/null || rm -rf .cloud-story
  echo "== 清理完成 =="
}

if [[ "${1:-}" == "--teardown-only" ]]; then teardown; exit 0; fi

IP=$(cloud_ip)
[[ -n "$IP" ]] || { echo "无法从 ~/.ssh/config 解析 $CLOUD_HOST 的 HostName"; exit 2; }
echo "== 目标机 ${CLOUD_HOST}（${IP}） =="

# 1) 本地交叉编译（增量；产物为静态 musl ELF）
echo "== [1/5] 交叉编译 x86_64-musl =="
cargo zigbuild --release -p dweb-server --target x86_64-unknown-linux-musl -q
BIN="/Users/kzf/.cargo-target/dweb/x86_64-unknown-linux-musl/release/dweb-server"
[[ -f "$BIN" ]] || { echo "未找到产物 $BIN"; exit 1; }

# 2) 本地预铸 Owner 身份（幂等：已有名册则复用，fabric_id 稳定）
echo "== [2/5] 预铸 Owner 名册 =="
PREPARE_OUT=$(cargo run --quiet --example cloud_story prepare)
echo "$PREPARE_OUT" | grep -E "fabric_id|pubkey"
FABRIC_ID=$(echo "$PREPARE_OUT" | sed -n 's/^  fabric_id  = \([0-9a-f]*\)$/\1/p')
ROOT_PK=$(echo "$PREPARE_OUT" | sed -n 's/^  root pubkey = \([0-9a-f]*\)$/\1/p')
[[ -n "$FABRIC_ID" && -n "$ROOT_PK" ]] || { echo "prepare 输出解析失败"; exit 1; }

# 3) 云端部署（运行中则跳过；重建先 --teardown-only）
echo "== [3/5] 云端部署（restricted @ $GW_PORT/${RELAY_PORT}，隔离目录 ${CLOUD_DIR}）=="
if curl -s --max-time 5 "http://$IP:$GW_PORT/healthz" >/dev/null 2>&1; then
  echo "云端 server 已在运行（跳过部署；重建请先 --teardown-only）"
else
  # DWEB_ADMIN_TOKEN：走查演示值（WALKTHROUGH admin API 一节的 curl 直接
  # 可用；临时部署 + --teardown-only 即回收，非生产凭证）
  $SCP -q "$BIN" "$CLOUD_HOST:$CLOUD_BIN" 2>/dev/null
  $SSH "chmod +x $CLOUD_BIN && mkdir -p $CLOUD_DIR/data && \
    $CLOUD_BIN owners --data-dir $CLOUD_DIR/data register $FABRIC_ID $ROOT_PK && \
    cd $CLOUD_DIR && DWEB_ACCESS_MODE=restricted DWEB_DATA_DIR=$CLOUD_DIR/data \
    DWEB_ADMIN_TOKEN=sap-verify-admin nohup $CLOUD_BIN --gateway 0.0.0.0:$GW_PORT --relay 0.0.0.0:$RELAY_PORT > server.log 2>&1 & \
    sleep 2; curl -s --max-time 3 http://127.0.0.1:$GW_PORT/healthz" 2>/dev/null | grep -v -i warning
fi

# 4) 公网可达性
echo "== [4/5] 公网可达性 =="
curl -s --max-time 8 "http://$IP:$GW_PORT/healthz" >/dev/null && echo "gateway $IP:$GW_PORT ✓"
echo "relay   $IP:${RELAY_PORT}（WS 面，下一步验证内确认）"

# 5) 故事验证 S1-S8（真实公网：自签→v2 邀请→join→通信→越权→兼容→重启）
echo "== [5/5] 故事验证 S1-S8 =="
SAP_RELAY_URL="http://$IP:$RELAY_PORT" SAP_GATEWAY_URL="http://$IP:$GW_PORT" \
  cargo run --quiet --example cloud_story verify

echo
echo "全部通过 ✅  清理：scripts/sap-verify.sh --teardown-only"
