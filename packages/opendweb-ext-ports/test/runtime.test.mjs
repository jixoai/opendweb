// 运行时面（tasks §2：runtimes 通道消费 + 映射生命周期管理 + 配置通道）。
// 1. descriptor 契约：./opendweb-webui-plugin 导出过宿主
//    validateWebuiPluginDescriptor（契约权威源在 webui 包——跨包 import 为
//    测试依赖，不改宿主）；
// 2. 宿主 runtimes 通道：createPluginHost({runtimes:{ports}}) 的
//    enable→onEnable 起 listener、disable→onDispose 停 listener（drain 收敛）；
// 3. 配置通道：host.setConfig("ports",{maxBodyMiB}) → disable→enable 生效
//    （2MiB 生效 + 128MiB 拒启）；
// 4. 映射管理 API：addMapping（运行中起监听/未运行仅落账）/setMappingEnabled/
//    removeMapping 的 listener 联动。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { createPortsRuntime } from "../src/runtime.mjs";
import { createPortsProxyHandler } from "../src/provider.mjs";
import { descriptor } from "../src/webui-plugin.mjs";
import { addMapping, grantAccess } from "../src/ledger.mjs";
import { createFabricBridge, freePort, request, startUpstream, tempHome, waitFor } from "./helpers.mjs";

// 宿主契约校验器 + 宿主本体（packages/webui Phase 0 产物——测试只读 import，
// 证明 ./opendweb-webui-plugin descriptor 与 runtimes 通道在真实宿主上的契合）
import { validateWebuiPluginDescriptor } from "../../webui/src/core/plugins/contract.mjs";
import { createPluginHost } from "../../webui/src/core/plugins/host.mjs";

/** 拨测某端口是否有 listener（refused=无监听） */
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("error", () => resolve(false));
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
  });
}

test("runtime: descriptor passes host contract validation (webuiApi 1)", () => {
  const v = validateWebuiPluginDescriptor(descriptor);
  assert.ok(v.ok, v.ok ? "" : v.error);
  assert.equal(descriptor.id, "ports");
  assert.equal(descriptor.webuiApi, 1);
  assert.deepEqual(
    descriptor.pages.map((p) => p.id),
    ["mappings"],
  );
  assert.equal(descriptor.configSchema.properties.maxBodyMiB.type, "number");
  assert.deepEqual(descriptor.dataEndpoints, [{ id: "proxy", path: "/wpk1/ports/proxy" }]);
});

test("runtime: host runtimes channel — enable starts listeners, disable drains and stops them", async (t) => {
  const home = await tempHome("wpk-rt-host-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("host-channel-ok");
  });
  t.after(() => upstream.close());
  const bridge = createFabricBridge(createPortsProxyHandler({ home, peer: "peer-b" }));
  await grantAccess(home, "peer-b", upstream.port);

  const localPort = await freePort();
  await addMapping(home, { name: "host 通道", peer: "peer-x", remotePort: upstream.port, localPort, enabled: true });

  const rt = await createPortsRuntime({
    home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: (peer) => (peer === "peer-x" ? { sessionId: "sess-rt" } : null),
    drainTimeoutMs: 800,
  });
  const host = await createPluginHost({ home, descriptors: [descriptor], runtimes: { ports: rt } });
  t.after(() => host.close());

  assert.equal(host.get("ports").status, "registered");
  assert.equal(await probePort(localPort), false, "no listener before enable");

  const enabled = await host.enable("ports");
  assert.equal(enabled.ok, true);
  assert.equal(rt.running, true);
  assert.equal(await probePort(localPort), true, "listener up after host enable (onEnable hook)");
  const viaMapping = await request(localPort, { path: "/hi" });
  assert.equal(viaMapping.status, 200);
  assert.equal(viaMapping.text, "host-channel-ok");

  const disabled = await host.disable("ports");
  assert.equal(disabled.ok, true);
  assert.equal(rt.running, false);
  assert.equal(await probePort(localPort), false, "listener down after host disable (onDispose hook)");
});

test("runtime: config channel via host state ledger — setConfig then disable→enable takes effect", async (t) => {
  const home = await tempHome("wpk-rt-cfg-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  t.after(() => upstream.close());
  const bridge = createFabricBridge(async () => ({ status: 200, bodyChunks: [] }));
  const localPort = await freePort();
  await addMapping(home, { name: "配置通道", peer: "peer-x", remotePort: upstream.port, localPort, enabled: true });

  const rt = await createPortsRuntime({
    home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "s" }),
    drainTimeoutMs: 500,
  });
  const host = await createPluginHost({ home, descriptors: [descriptor], runtimes: { ports: rt } });
  t.after(() => host.close());

  // 越界配置：host.setConfig 按类型面接受（schema 子集无 min/max），运行时在
  // 启动映射时按 1-64MiB 硬域裁决——enable 后映射不启动
  const set128 = await host.setConfig("ports", { maxBodyMiB: 128 });
  assert.equal(set128.ok, true, "schema-level validation passes (number)");
  const enabled = await host.enable("ports");
  assert.equal(enabled.ok, true);
  assert.equal(await probePort(localPort), false, "out-of-range config refuses to start the mapping");
  const rows = await rt.listMappings();
  assert.equal(rows[0].listener, "failed");
  assert.match(rows[0].error ?? "", /\[1, 64\]/);
  assert.equal(host.get("ports").config.maxBodyMiB, 128, "host projection carries the config");

  // 回到界内（2MiB）→ disable→enable 生效（启动时重解析）
  const set2 = await host.setConfig("ports", { maxBodyMiB: 2 });
  assert.equal(set2.ok, true);
  await host.disable("ports");
  const reEnabled = await host.enable("ports");
  assert.equal(reEnabled.ok, true);
  assert.equal(await probePort(localPort), true, "in-range config starts the mapping after re-enable");
  assert.equal(rt.config.maxBodyMiB, 2);
  assert.equal(rt.config.configError, null);
  await host.disable("ports");
});

test("runtime: mapping management — add/toggle/remove drive listener lifecycle", async (t) => {
  const home = await tempHome("wpk-rt-mgmt-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bridge = createFabricBridge(async () => ({ status: 200, bodyChunks: [] }));
  const rt = await createPortsRuntime({
    home: home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "s" }),
    drainTimeoutMs: 500,
  });
  await rt.start();
  t.after(() => rt.stop());

  // 未运行态 → 运行态：add 即起监听
  const port1 = await freePort();
  const port2 = await freePort();
  const added = await rt.addMapping({ name: "m1", peer: "peer-a", remotePort: 8080, localPort: port1 });
  assert.equal(added.ok, true);
  assert.equal(/** @type {any} */ (added).listener, "listening");
  assert.equal(await probePort(port1), true);

  // 停用：listener 落、账本 enabled=false
  const id = /** @type {any} */ (added).mapping.id;
  const off = await rt.setMappingEnabled(id, false);
  assert.equal(off.ok, true);
  assert.equal(await probePort(port1), false);
  let rows = await rt.listMappings();
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].listener, "stopped");

  // 启用：listener 回
  const on = await rt.setMappingEnabled(id, true);
  assert.equal(/** @type {any} */ (on).listener, "listening");
  assert.equal(await probePort(port1), true);

  // 删除：listener 落 + 账本移除
  const removed = await rt.removeMapping(id);
  assert.equal(removed.ok, true);
  assert.equal(await probePort(port1), false);
  rows = await rt.listMappings();
  assert.equal(rows.length, 0);

  // 未运行态新增：仅落账（listener=stopped），start 后补起
  const rt2 = await createPortsRuntime({
    home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "s" }),
    drainTimeoutMs: 500,
  });
  t.after(() => rt2.stop());
  const added2 = await rt2.addMapping({ name: "m2", peer: "peer-a", remotePort: 8080, localPort: port2 });
  assert.equal(/** @type {any} */ (added2).listener, "stopped", "not running: ledger only");
  assert.equal(await probePort(port2), false);
  await rt2.start();
  assert.equal(await probePort(port2), true, "start() brings enabled mappings up");
});

test("runtime: peer without session → 502 with a clear error, zero fetch", async (t) => {
  const home = await tempHome("wpk-rt-nosess-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bridge = createFabricBridge(async () => ({ status: 200, bodyChunks: [] }));
  const localPort = await freePort();
  const rt = await createPortsRuntime({
    home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => null, // 无会话
    drainTimeoutMs: 500,
  });
  await addMapping(home, { name: "无会话", peer: "peer-gone", remotePort: 8080, localPort, enabled: true });
  await rt.start();
  t.after(() => rt.stop());
  const res = await request(localPort, { path: "/x" });
  assert.equal(res.status, 502);
  assert.match(res.text, /no active fabric session to peer peer-gone/);
  assert.equal(bridge.fetchCalls.length, 0);
});

test("runtime: start is idempotent; stop converges in-flight (bounded)", async (t) => {
  const home = await tempHome("wpk-rt-idem-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const upstream = await startUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end("late");
    }, 300);
  });
  t.after(() => upstream.close());
  await grantAccess(home, "peer-b", upstream.port);
  const bridge = createFabricBridge(createPortsProxyHandler({ home, peer: "peer-b" }));
  const localPort = await freePort();
  const rt = await createPortsRuntime({
    home,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: (peer) => (peer === "peer-a" ? { sessionId: "s" } : null),
    drainTimeoutMs: 600,
  });
  await addMapping(home, { name: "idem", peer: "peer-a", remotePort: upstream.port, localPort, enabled: true });
  await rt.start();
  await rt.start(); // 幂等：不重复起 listener
  const rows = await rt.listMappings();
  assert.equal(rows.length, 1);

  // 在途请求中 stop：drain 有界等待（300ms 响应 < 600ms 预算 → 正常收敛）
  const pending = request(localPort, { path: "/late" });
  await waitFor(() => rt.budget.inFlight === 1, 2000, "request in flight");
  await rt.stop();
  assert.equal(rt.budget.inFlight, 0, "stop drains in-flight within the bounded window");
  const res = await pending.catch((e) => ({ status: 0, error: e }));
  assert.ok(res.status === 200 || res.status === 0, "in-flight request settles (completed or torn down by force-cancel)");
});
