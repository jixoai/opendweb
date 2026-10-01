// codex 实现终审 r1 修复回归（runtime 面——P2-2 消费 listener 启动后持久化失败
// 不回收句柄）：gw.startService 成功→saveEndpoints 失败→close listener+摘账本
// 条目（不留孤儿端口占用；同端口可重试）。saveEndpoints 失败注入=数据目录临时
// 收写（0500——atomicWrite0600 建 tmp 文件 EACCES）。常驻进程回收：runtime.stop()
// 关全部 listener/gateway（t.after 双保险）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm, chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { createAiRuntime } from "../src/runtime.mjs";
import { openKeyring } from "../src/consumer/keyring.mjs";
import { importLink, SHARE_LINK_PREFIX } from "../src/consumer/join.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

test("P2-2: startService 后 saveEndpoints 失败→close listener+移除账本条目（同端口可重试）", async (t) => {
  const home = await tempHome("odai-rtfix-");
  t.after(() => chmod(aiDataDir(home), 0o700).catch(() => {}));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = aiDataDir(home);

  const rt = await createAiRuntime({
    home,
    writerHome: await mkdtemp(path.join(tmpdir(), "odai-rtfix-wh-")),
    fabric: {
      fetchHttpImpl: async () => {
        throw new Error("fabric transport not needed in this test");
      },
      sessionResolver: async () => null,
      identity: async () => null,
    },
  });
  t.after(() => rt.stop());

  // 钥环导入一个 provider（两个服务——svcA 对照 / svcB 故障注入）
  const keyring = await openKeyring(path.join(dataDir, "keyring.json"));
  const svcA = {
    serviceId: "svc-aaaaaaaa",
    name: "svc-a",
    defaultPort: 4501,
    match: [],
    detail: { routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }] },
  };
  const svcB = {
    serviceId: "svc-bbbbbbbb",
    name: "svc-b",
    defaultPort: 4502,
    match: [],
    detail: { routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }] },
  };
  const link = `${SHARE_LINK_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      invite: "dweb1.rtfixfaketoken0000000000000000000",
      key: "sk-aifly-rtfix0123456789abcdefghij",
      keyId: "rtfixkey1",
      provider: { alias: "rtfix-provider", endpointId: "rtfixep0001aaaaaaaaaaaaaaa", relayUrls: [] },
      group: "alpha",
      services: [svcA, svcB],
    }),
  ).toString("base64url")}`;
  await importLink(link, { keyring, fabric: { fetchImpl: async () => { throw new Error("no wire in setup"); } } }).catch(() => {});
  // importLink 兑换需要 fetch——直接 upsert（宿主 Phase C 真实路径之外的装配捷径）
  keyring.upsertProvider(
    { endpointId: "rtfixep0001aaaaaaaaaaaaaaa", alias: "rtfix-provider", relayUrls: [] },
    { keyId: "rtfixkey1", key: "sk-aifly-rtfix0123456789abcdefghij", group: "alpha" },
    [svcA, svcB],
  );
  await keyring.save();

  const start = (serviceId, port) =>
    rt.mgmt.handle("POST", "/consumer/endpoints", new URLSearchParams(), {
      providerEndpointId: "rtfixep0001aaaaaaaaaaaaaaa",
      serviceId,
      port,
    });
  const listView = async () => {
    const view = await rt.mgmt.handle("GET", "/consumer", new URLSearchParams(), undefined);
    return view.body;
  };

  // ① 对照：正常启动（账本落盘 OK）
  const portA = await freePort();
  const ok = await start(svcA.serviceId, portA);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await listView()).endpoints.length, 1);

  // ② 故障注入：数据目录收写→svcB 启动（listener 已 listen）→saveEndpoints 失败
  const portB = await freePort();
  await chmod(dataDir, 0o500);
  let failed;
  try {
    failed = await start(svcB.serviceId, portB);
  } finally {
    await chmod(dataDir, 0o700);
  }
  assert.notEqual(failed.status, 200, "持久化失败必须上抛（真实报错面）");
  assert.ok(failed.status >= 500 || failed.status === 400, `错误族（实测 ${failed.status}）`);

  // ③ 回收断言：账本条目已移除（无孤儿记录）
  const after = await listView();
  assert.equal(after.endpoints.length, 1, "失败条目不入账本");
  assert.equal(after.endpoints[0].serviceId, svcA.serviceId);

  // ④ 同端口可重试（listener 已 close——端口真实释放）
  const retry = await start(svcB.serviceId, portB);
  assert.equal(retry.status, 200, `同端口 ${portB} 重试成功（回收证据）：${JSON.stringify(retry.body)}`);
  const final = await listView();
  assert.equal(final.endpoints.length, 2);

  // ⑤ 停机回收（显式——常驻进程纪律）
  await rt.stop();
  const stopped = await listView();
  assert.ok(stopped.endpoints.every((e) => e.listener === "stopped"), "stop 后全部 listener 关闭");
});
