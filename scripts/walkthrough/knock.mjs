#!/usr/bin/env node
// 陌生设备敲门模拟器（server-access-roles 走查用）
//
// 行为：在隔离临时目录创建一个一次性设备 key 的 fabric 节点，无票连接
// 目标 relay —— 服务端 restricted 模式会拒绝并记入敲门台账；你在 webui
// 敲门台放行后，本脚本自动重连进楼；被拉黑则自动下线且不再敲门。
//
// 用法：
//   node scripts/walkthrough/knock.mjs --relay http://39.107.213.167:13340 \
//        [--gateway http://39.107.213.167:18787 --token-file /path/to/admin-token]
//
// --gateway/--token-file 可选：提供后每 2s 轮询在线状态（推荐提供，体验完整）。
//   token 从 0600 文件读取（W11：argv 明文 token 通道移除；云端 demo 可
//   `echo demo-admin-token >/tmp/t && chmod 600 /tmp/t` 后 `--token-file /tmp/t`）。
// --data-dir 可选：固定设备 key 目录（默认每次运行生成一次性 key）。
//   「拉黑」演示需要：Ctrl+C 后用同一 --data-dir 重跑 = 同一台设备再次敲门。
// Ctrl+C 退出（一次性 key 自动清理；固定目录保留）。

import sdk from "../../packages/client-sdk/index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const RELAY = argOf("relay") ?? "http://39.107.213.167:13340";
const GATEWAY = argOf("gateway");
const TOKEN_FILE = argOf("token-file");
const DATA_DIR = argOf("data-dir");
if (argOf("token") !== null) {
  console.error("--token 已移除（W11）：admin token 一律走 0600 文件，用 --token-file <path>");
  process.exit(2);
}
const TOKEN = TOKEN_FILE ? readFileSync(TOKEN_FILE, "utf8").trim() : null;

// iroh NodeId 的 z-base-32 展示 → 64 hex（服务端/管理面口径）
const ZB = "ybndrfg8ejkmcpqxot1uwisza345h769";
function zbase32ToHex(s) {
  let bits = 0, val = 0;
  const bytes = [];
  for (const ch of s) {
    const v = ZB.indexOf(ch);
    if (v < 0) throw new Error(`非 z-base-32 字符: ${ch}`);
    val = (val << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((val >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("hex").slice(0, 64);
}
const shortId = (hex) => `${hex.slice(0, 3)}***${hex.slice(-3)}`;
const ts = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

let fabric = null;
const dataDir = DATA_DIR ?? mkdtempSync(join(tmpdir(), "dweb-knocker-"));
process.on("SIGINT", async () => {
  log("退出中…");
  try { await fabric?.shutdown(); } catch {}
  if (!DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
});

log(`目标 relay: ${RELAY}`);
log(DATA_DIR ? `使用固定设备 key 目录：${DATA_DIR}` : "创建一次性设备 key（隔离临时目录，不碰你本机默认 key）…");
fabric = await sdk.Fabric.createRoot({
  dataDir,
  relay: { mode: "custom", urls: [RELAY] },
});
const myHex = zbase32ToHex(fabric.endpointId);
console.log("");
log("✅ 我是陌生设备，公钥（endpoint_id）：");
console.log(`     ${myHex}`);
console.log(`     缩写：${shortId(myHex)}`);
console.log("");
log("🚪 正在敲门（无通行票连接 relay，服务端会拒绝并记入敲门台账）…");
log("   → 现在去 webui「访客与门禁 → 敲门台」：应该能看到我（缩写 " + shortId(myHex) + "）");
log("   → 在敲门台点「定位为访客」（或拉黑试试），我会在这里实时报告状态变化");
console.log("");

if (!GATEWAY || !TOKEN) {
  log("（未提供 --gateway/--token-file，不做在线轮询；保持运行中，Ctrl+C 退出）");
  for (;;) await sleep(60_000);
}

const headers = { Authorization: `Bearer ${TOKEN}` };
const state = async () => {
  try {
    const r = await fetch(`${GATEWAY}/admin/connections`, { headers });
    const j = await r.json();
    const me = (j.per_visitor ?? []).find((v) => v.endpoint_id === myHex);
    return me ? `在线（relay 连接 ${me.connections} 条）` : "未上线";
  } catch {
    return "查询失败（网络/网关）";
  }
};

let prev = "";
for (;;) {
  await sleep(2000);
  const s = await state();
  if (s !== prev) {
    if (prev === "" && s.startsWith("在线")) log(`🎉 已进楼！当前状态：${s}（定位访客成功，重连即通）`);
    else if (s.startsWith("在线") && !prev.startsWith("在线")) log(`🎉 状态变化：${s}`);
    else if (prev.startsWith("在线") && !s.startsWith("在线")) log(`⛔ 状态变化：${s}（被拉黑或访客资格被移除——新连接被拒；存量连接按语义自然断开）`);
    else log(`状态：${s}`);
    prev = s;
  }
}
