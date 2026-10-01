// 消费方网关错误分族测试（ai-subscription-sharing Phase D 顺手项）。
// 「A 已停用」（provider 停用 ai 插件）→ 内核 wpk 路由 503
// {error:{code:"plugin-disabled"}}（嵌套形态）——两处修：
// 1. sessions：错误体码位提取双形态（平铺 {code} 与内核嵌套 {error:{code}}）——
//    此前嵌套形态取不到码位 → 折叠为 internal。
// 2. gateway：提供方不可用族（plugin-disabled/router-missing/unknown-plugin/
//    internal[传输失败]）→ 本地 502 upstream_unreachable 明确码 + 固定脱敏
//    文案；OpenAI 风格 error JSON 形态不变。
// 常驻进程回收：gateway listener t.after 显式 close（留证）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createConsumerSession, WireError } from "../src/consumer/sessions.mjs";
import { classifyLocalError, createConsumerGateway, localErrorStatus } from "../src/consumer/gateway.mjs";

/** 空闲端口（bind 0→读回→释放）。 */
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

/** 内核 jsonResp 形态（fabric.mjs：嵌套 error 对象）。 */
const KERNEL_DISABLED = { error: { code: "plugin-disabled", message: 'plugin "ai" is not enabled on this device' } };

test("sessions: nested kernel error bodies yield their real code (not internal)", async () => {
  /** @param {number} status @param {unknown} body */
  const fakeFetch = async (init) => ({
    status: 503,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [Buffer.from(JSON.stringify(KERNEL_DISABLED))],
    ...(init.body !== undefined ? {} : {}),
  });
  const session = createConsumerSession({ fetchImpl: fakeFetch });
  await assert.rejects(
    () => session.request({ keyId: "k", serviceId: "s", method: "GET", path: "/v1/x" }),
    (e) => e instanceof WireError && e.code === "plugin-disabled" && e.status === 503,
    "嵌套 {error:{code}} 形态取到真实码位",
  );

  // 平铺形态（ai handler 自有面）不受影响
  const flatFetch = async () => ({
    status: 429,
    headers: [],
    bodyChunks: [Buffer.from(JSON.stringify({ code: "rate_limited", message: "slow down" }))],
  });
  const s2 = createConsumerSession({ fetchImpl: flatFetch });
  await assert.rejects(() => s2.request({ keyId: "k", serviceId: "s", method: "GET", path: "/x" }), (e) => e.code === "rate_limited");
});

test("gateway classification: provider-unavailable family maps to 502 upstream_unreachable (sanitized)", async (t) => {
  // 分族纯函数面
  const c1 = classifyLocalError(new WireError(503, "plugin-disabled", "raw kernel text"));
  assert.deepEqual({ status: c1.status, code: c1.code }, { status: 502, code: "upstream_unreachable" });
  assert.ok(!c1.message.includes("raw kernel text"), "固定脱敏文案——不透传原始错误");
  assert.equal(classifyLocalError(new WireError(503, "router-missing", "x")).code, "upstream_unreachable");
  assert.equal(classifyLocalError(new WireError(404, "unknown-plugin", "x")).code, "upstream_unreachable");
  assert.equal(classifyLocalError(new WireError(502, "internal", "fabric transport boom")).code, "upstream_unreachable");
  assert.equal(localErrorStatus("upstream_unreachable"), 502);
  // 透传码族不受影响
  assert.deepEqual(
    { status: localErrorStatus("rate_limited"), code: "rate_limited" },
    { status: 429, code: "rate_limited" },
  );
  const kept = classifyLocalError(new WireError(403, "key_revoked", "key revoked"));
  assert.deepEqual({ status: kept.status, code: kept.code }, { status: 403, code: "key_revoked" });

  // 真实 listener 面：session 替身（forward 直接 onError(A 已停用)）→ HTTP 502
  const fakeSession = {
    forward: async (_input, handlers) => {
      handlers.onError(new WireError(503, "plugin-disabled", 'plugin "ai" is not enabled on this device'));
    },
    cancel: async () => undefined,
  };
  const gw = createConsumerGateway({ session: /** @type {any} */ (fakeSession) });
  t.after(() => gw.close());
  const port = await freePort();
  const listener = await gw.startService({
    serviceId: "svc",
    name: "svc",
    port,
    routes: [{ localPrefix: "/", upstreamPrefix: "/" }],
    keyId: "k1",
  });
  t.after(() => listener.close());
  const resp = await fetch(`http://127.0.0.1:${listener.port}/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(resp.status, 502, "A 已停用 → 502（不再是 internal 折叠）");
  const body = await resp.json();
  assert.equal(body.error.code, "upstream_unreachable");
  assert.equal(body.error.type, "api_error", "OpenAI 风格 error JSON 形态保持");
  assert.ok(!JSON.stringify(body).includes("not enabled"), "内核原文不入本地响应");
});
