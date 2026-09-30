// TERM 退出门测试的 scratch home 装配（B5 活跃会话用例）：
// 在 <home> 建本地 root fabric + 在 <peerHome> 建远端 member（invite→join→
// addKnownAddr，loopback 固定端口对拨），落 leases.json（sidecar fabric 宿主
// 的身份断言面：fabric_id + root=本端 endpointId 的 hex64 形态）。
// 独立子进程运行：装配自身不建 serveHttp/会话（原生句柄零沾染），自然退出。
// 产出：sidecar enable 数据面插件后 fabric open/start → roster 预绑 serveHttp
// （对端无需在线）——TERM 闩锁的充分条件。
// 泄漏哨兵（2026-10-01）：打印 ok 后若 2s 仍存活，向 stderr 报告事件循环残留
// 句柄指纹（unref 计时器不干扰退出判定本身；不 process.exit 糖盖——进程停泊
// 即泄漏实证，指纹随 fixture 输出进入测试失败消息）。
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";

const home = process.argv[2];
const peerHome = process.argv[3];
if (typeof home !== "string" || typeof peerHome !== "string") {
  process.stderr.write("usage: term-exit-fabric-home.mjs <home> <peerHome>\n");
  process.exit(2);
}

const sdkModule = (await import("@jixo/opendweb-client-sdk")).default ?? (await import("@jixo/opendweb-client-sdk"));
const { Fabric } = sdkModule;
const { z32ToHex } = await import("../../src/core/fabric.mjs");

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.rmSync(peerHome, { recursive: true, force: true });
fs.mkdirSync(peerHome, { recursive: true });

const portA = await reservePort();
const a = await Fabric.createRoot({
  dataDir: home,
  relay: { mode: "disabled" },
  advertiseAddrs: [`127.0.0.1:${portA}`],
  bindAddr: `127.0.0.1:${portA}`,
});
const fabricId = await a.fabricIdHex();
const rootHex = z32ToHex(a.endpointId);
const portB = await reservePort();
const b = await Fabric.attach(
  { dataDir: peerHome, relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
  fabricId,
);
const token = await a.invite(3_600_000, b.endpointId, { allowRelayless: true });
await b.join(token);
await a.addKnownAddr(b.endpointId, `127.0.0.1:${portB}`);
await b.shutdown();
await a.shutdown();

fs.writeFileSync(
  path.join(home, "leases.json"),
  JSON.stringify({
    version: 1,
    leases: [
      {
        id: "termexit001",
        server: "http://127.0.0.1:8787",
        relay_url: "",
        server_id: null,
        fabric_id: fabricId,
        root: rootHex,
        alias: "term-exit-probe",
        label: null,
        registered_at: 1,
        expires_at: 4102444800000,
        receipt: null,
      },
    ],
  }),
);
process.stdout.write(`${JSON.stringify({ ok: true })}\n`);

// 泄漏哨兵：ok 之后仍存活 = 自然退出语义被破坏（残留 ref 句柄）。每 2s 报告
// 一次句柄指纹；unref 保证哨兵自身不构成驻留。
const sentinelStartedAt = Date.now();
const sentinel = setInterval(() => {
  const t = Date.now() - sentinelStartedAt;
  const resources = process.getActiveResourcesInfo();
  const handles = (process._getActiveHandles?.() ?? []).map((h) => h?.constructor?.name);
  process.stderr.write(
    `LEAK-CANDIDATE alive=${t}ms resources=${JSON.stringify(resources)} handles=${JSON.stringify(handles)}\n`,
  );
}, 2_000);
sentinel.unref();
