// 生命周期可往返（webui-plugin-kernel §2.2「enabled⇄disabled 可往返」冻结承诺；
// 真浏览器走查 P1 实证：dispose 曾做成一次性终态——disable→enable 确定性 500，
// ledger=enabled / runtime=disposed / 宿主=disabled 三态分裂，仅重启可复原）。
// 覆盖：
// 1. dispose→enable 往返：onEnable 全量重初始化（目录/staging/共享账本/扫描），
//    往返后 handler 正常服务；
// 2. disposed 窗口内 handler 稳定 503 plugin-disposed（停用语义不因可逆而放宽）；
// 3. 多轮往返稳定（fd 缓存/扫描定时器不泄漏式累积——观测 enabled/disposed 位）。

import test from "node:test";
import assert from "node:assert/strict";
import { createFilesRuntime } from "../src/runtime.mjs";
import { tempFixture } from "./util.mjs";

test("lifecycle: disable→enable round-trips (dispose is reversible, not terminal)", async (t) => {
  const fixture = tempFixture({});
  t.after(() => fixture.cleanup());
  const rt = await createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a" });
  t.after(() => rt.onDispose());

  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({ name: "docs", root: fixture.rootDir, mode: "ro", peers: ["ep-a"] });
  assert.equal(rt.enabled, true);
  const listReq = { sessionId: "s1", method: "GET", path: `/wpk1/files/${share.id}/list?path=` };

  await rt.onDispose();
  assert.equal(rt.disposed, true);
  assert.equal(rt.enabled, false);

  // disposed 窗口：dispatch 入口稳定 503（停用语义不放宽；handler 返回响应对象
  // 而非抛错——wire 测试既有惯例）
  const denied = await rt.handler(listReq);
  assert.equal(denied.status, 503, "disposed window denies at the dispatch guard");

  // 往返：重 enable 成功（不再 "cannot enable a disposed runtime"）
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  assert.equal(rt.disposed, false);
  assert.equal(rt.enabled, true);
  const res = await rt.handler(listReq);
  assert.equal(res.status, 200, "handler serves after re-enable");
});

test("lifecycle: multiple round-trips stay stable", async (t) => {
  const fixture = tempFixture({});
  t.after(() => fixture.cleanup());
  const rt = await createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a" });
  t.after(() => rt.onDispose());
  for (let i = 0; i < 3; i += 1) {
    await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
    assert.equal(rt.enabled, true);
    await rt.onDispose();
    assert.equal(rt.disposed, true);
  }
});
