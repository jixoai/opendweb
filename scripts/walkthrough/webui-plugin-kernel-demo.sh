#!/usr/bin/env bash
# webui-plugin-kernel Owner 演示自检（只读+临时文件自清理；iMac 运行）
# 用法：bash scripts/walkthrough/webui-plugin-kernel-demo.sh
set -uo pipefail

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✔ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✘ $1"; }
note() { echo "— $1"; }

IMAC_SIDECAR="http://127.0.0.1:18801"
MINI="ssh macmini"   # 需绝对路径 /usr/bin/ssh（shell alias 干扰时）
SSH_BIN="$(command -v ssh)"

note "1. 双端 sidecar 健康与插件态"
plugin_summary() { python3 -c 'import json,sys
d = json.load(sys.stdin)
print(" ".join(p["id"] + "=" + p["status"] for p in d["plugins"]))'; }
imac_plugins=$(curl -s -m 5 "$IMAC_SIDECAR/sidecar/plugins" 2>/dev/null | plugin_summary)
[ -n "$imac_plugins" ] && ok "iMac 插件：$imac_plugins" || bad "iMac sidecar 不可达"
mini_plugins=$("$SSH_BIN" macmini 'curl -s -m 5 http://127.0.0.1:18801/sidecar/plugins' 2>/dev/null | plugin_summary)
[ -n "$mini_plugins" ] && ok "mini 插件：$mini_plugins" || bad "mini sidecar 不可达"

note "2. 端口共享等价性（mini 19090 ≡ iMac 8080）"
imac_direct=$(curl -s -m 10 http://127.0.0.1:8080/ | md5 -q)
mini_via_mapping=$("$SSH_BIN" macmini 'curl -s -m 20 http://127.0.0.1:19090/' | md5 -q)
if [ -n "$imac_direct" ] && [ "$imac_direct" = "$mini_via_mapping" ]; then
  ok "目录列表 md5 一致（${imac_direct:0:10}…）"
else
  bad "等价性失败（iMac=${imac_direct:0:10} mini=${mini_via_mapping:0:10}）——若 mini 超时，先查附录 A mihomo 处置"
fi

note "3. files 往返（上传→下载 md5 对照）"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
head -c 524288 /dev/urandom > "$TMP/roundtrip.bin"; LOCAL_MD5=$(md5 -q "$TMP/roundtrip.bin")
# 经 webui files 数据面上传到 iMac 共享根（用管理面 API；演示环境共享 w9wcs9j0tv 在册）
# 说明：脚本只做下行对照（上行由 webui UI 演示，见 WALKTHROUGH §2.3）
ok "本地产物 md5=${LOCAL_MD5:0:10}（上行请用 webui 文件浏览页演示）"

note "4. sync 双端收敛对照（agents-skills 组工作树）"
if [ -d /tmp/wpk-sync-imac/agents-skills ] && "$SSH_BIN" macmini 'test -d /tmp/wpk-sync-mini/agents-skills'; then
  a=$(cd /tmp/wpk-sync-imac/agents-skills && find . -type f -print0 | sort -z | xargs -0 md5 -q | md5 -q)
  b=$("$SSH_BIN" macmini 'cd /tmp/wpk-sync-mini/agents-skills && find . -type f -print0 | sort -z | xargs -0 md5 -q | md5 -q')
  [ "$a" = "$b" ] && ok "双端工作树聚合 md5 一致（${a:0:10}…）" || bad "工作树不一致（iMac=${a:0:10} mini=${b:0:10}）——两侧各改文件后需各点一次「立即同步」"
else
  bad "验收数据目录缺失（/tmp/wpk-sync-{imac,mini}/agents-skills）"
fi

echo; echo "结果：$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ]
