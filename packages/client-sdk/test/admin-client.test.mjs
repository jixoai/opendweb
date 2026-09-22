// sdk-mgmt-surface task 2.3：AdminClient mock-fetch 单测（node --test）。
// 覆盖：probeEnabled 六路互斥矩阵（200/404/401/502/503/任意非 200/网络/超时）、
// 错误 envelope 解析、全路由成功 wire 直映（snake_case + 未知字段容忍）、
// Bearer 注入 / baseUrl 尾斜杠归一 / 超时信号。
// 回执 canonical 对拍与验签见 admin-receipt.test.mjs（消费 Rust 冻结向量）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  AdminClient,
  AdminError,
} from "../admin/index.mjs";

const BASE = "https://dweb.example";

// ---- mock fetch 基础设施 --------------------------------------------------------

/** 装载形态最简的 Response 替身（text/json/arrayBuffer/ok/status）。 */
function fakeResponse(status, body) {
  const text =
    typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: "",
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** 替换全局 fetch；handler 可为响应工厂 / 抛错 / 挂起（超时用）。 */
function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

const envelope = (code, message) => ({ error: { code, message } });

// ---- probeEnabled：六路互斥矩阵（spec「status 探测矩阵」） ------------------------

test("probeEnabled matrix: 200 resolves true; every other path rejects with a distinct code", async () => {
  const matrix = [
    { label: "200 → resolve true", status: 200, body: { mode: "restricted" }, expect: "resolve-true" },
    { label: "404 (未挂载, 空 body) → admin-not-enabled", status: 404, body: "", expect: "admin-not-enabled" },
    { label: "404 (代理剥 body 后残留非 JSON) → admin-not-enabled", status: 404, body: "gateway", expect: "admin-not-enabled" },
    { label: "401 (envelope) → unauthorized", status: 401, body: envelope("unauthorized", "missing or invalid admin bearer token"), expect: "unauthorized" },
    { label: "502 → http-502", status: 502, body: "", expect: "http-502" },
    { label: "503 → http-503", status: 503, body: "", expect: "http-503" },
    { label: "500 (envelope 但矩阵不折帐) → http-500", status: 500, body: envelope("registry", "owner register failed"), expect: "http-500" },
    { label: "400 → http-400（任意非 200 全走 http-<status>）", status: 400, body: "", expect: "http-400" },
  ];
  for (const c of matrix) {
    const { restore } = stubFetch(() => Promise.resolve(fakeResponse(c.status, c.body)));
    const client = new AdminClient({ baseUrl: BASE, token: "t" });
    try {
      if (c.expect === "resolve-true") {
        assert.equal(await client.probeEnabled(), true, c.label);
      } else {
        await assert.rejects(
          client.probeEnabled(),
          (err) => {
            assert.ok(err instanceof AdminError, `${c.label}: AdminError 实例`);
            assert.equal(err.code, c.expect, `${c.label}: code 互斥判别`);
            assert.equal(typeof err.message, "string");
            assert.ok(err.message.length > 0, `${c.label}: message 非空`);
            assert.equal(err.status, c.status, `${c.label}: status 透传`);
            return true;
          },
          c.label,
        );
      }
    } finally {
      restore();
    }
  }

  // 网络失败 → network（status null）
  {
    const { restore } = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = new AdminClient({ baseUrl: BASE, token: "t" });
    try {
      await assert.rejects(client.probeEnabled(), (err) => {
        assert.ok(err instanceof AdminError);
        assert.equal(err.code, "network");
        assert.equal(err.status, null);
        return true;
      }, "network 路径");
    } finally {
      restore();
    }
  }

  // 超时 → timeout（AbortSignal.timeout 触发的 TimeoutError 归一）
  {
    const { restore } = stubFetch(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
          );
        }),
    );
    const client = new AdminClient({ baseUrl: BASE, token: "t", timeoutMs: 40 });
    try {
      await assert.rejects(client.probeEnabled(), (err) => {
        assert.ok(err instanceof AdminError);
        assert.equal(err.code, "timeout");
        assert.equal(err.status, null);
        return true;
      }, "timeout 路径");
    } finally {
      restore();
    }
  }
});

test("probeEnabled: probes GET /admin/status with Bearer and a timeout signal", async () => {
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200)));
  const client = new AdminClient({ baseUrl: `${BASE}/`, token: "admin-secret" });
  try {
    assert.equal(await client.probeEnabled(), true);
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/admin/status`, "尾斜杠归一 + 探测路径");
  assert.equal(calls[0].init.headers.authorization, "Bearer admin-secret");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "默认 10s 超时信号");
  assert.ok(!calls[0].init.signal.aborted);
});

// ---- 错误归一（envelope 解析 + 兜底） ---------------------------------------------

test("error envelope: 404 no-match parses code+message from the server envelope", async () => {
  const { restore } = stubFetch(() =>
    Promise.resolve(
      fakeResponse(404, envelope("no-match", "no online connection matches endpoint_id 99")),
    ),
  );
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    await assert.rejects(client.disconnect({ endpointId: "99".repeat(32) }), (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, "no-match");
      assert.equal(err.message, "no online connection matches endpoint_id 99");
      assert.equal(err.status, 404);
      return true;
    });
  } finally {
    restore();
  }
});

test("error envelope: 400 invalid-request + 500 registry pass through; unmounted 404 without envelope stays http-404", async () => {
  const cases = [
    { status: 400, body: envelope("invalid-request", "request body must specify exactly one of endpoint_id or fabric_id"), code: "invalid-request" },
    { status: 500, body: envelope("registry", "owner register failed"), code: "registry" },
    { status: 404, body: "", code: "http-404" }, // 未挂载空 body：不得折为 admin-not-enabled（probe-only 规则）
    { status: 502, body: "", code: "http-502" },
  ];
  for (const c of cases) {
    const { restore } = stubFetch(() => Promise.resolve(fakeResponse(c.status, c.body)));
    const client = new AdminClient({ baseUrl: BASE, token: "t" });
    try {
      await assert.rejects(client.listOwners(), (err) => {
        assert.equal(err.code, c.code);
        assert.equal(err.status, c.status);
        return true;
      }, `status ${c.status}`);
    } finally {
      restore();
    }
  }
});

test("network/timeout normalization applies to generic requests too", async () => {
  {
    const { restore } = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = new AdminClient({ baseUrl: BASE, token: "t" });
    try {
      await assert.rejects(client.listOwners(), (err) => {
        assert.equal(err.code, "network");
        assert.equal(err.status, null);
        return true;
      });
    } finally {
      restore();
    }
  }
  {
    const { restore } = stubFetch(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted due to timeout", "TimeoutError")),
          );
        }),
    );
    const client = new AdminClient({ baseUrl: BASE, token: "t", timeoutMs: 40 });
    try {
      await assert.rejects(client.connections(), (err) => {
        assert.equal(err.code, "timeout");
        assert.equal(err.status, null);
        return true;
      });
    } finally {
      restore();
    }
  }
});

test("2xx with a non-JSON body fails loudly (invalid-response)", async () => {
  const { restore } = stubFetch(() => Promise.resolve(fakeResponse(200, "<html>oops</html>")));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    await assert.rejects(client.status(), (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, "invalid-response");
      assert.equal(err.status, 200);
      return true;
    });
  } finally {
    restore();
  }
});

// ---- 成功 wire 直映（snake_case + 未知字段容忍） -----------------------------------

test("status(): snake_case wire passthrough with unknown fields tolerated", async () => {
  const wire = {
    mode: "restricted",
    policy: "static",
    generation: 7,
    max_connections_per_owner: 16,
    active_connections: [
      { endpoint_id: "ab".repeat(32), fabric_id: "cd".repeat(32), connections: 2 },
    ],
    per_owner_connections: [{ fabric_id: "cd".repeat(32), connections: 2 }],
    cache_entries: 3,
    future_field: { nested: true }, // 向前兼容：服务端只增字段不破坏客户端
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, wire)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.status(), wire);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/admin/status`);
  assert.equal(calls[0].init.method ?? "GET", "GET");
});

test("listOwners(): GET /admin/owners wire passthrough", async () => {
  const wire = {
    generation: 4,
    owners: [{ fabric_id: "11".repeat(32), root: "22".repeat(32), registered_at: 1789012345678 }],
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, wire)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.listOwners(), wire);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/admin/owners`);
});

test("registerOwner(): POST /admin/owners with {fabric_id_hex, root_hex} + receipt passthrough", async () => {
  const receipt = {
    op: "register",
    fabric_id: "11".repeat(32),
    root: "22".repeat(32),
    ts: 1789012345678,
    generation: 5,
    receipt_sig: "AA".repeat(43) + "A",
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, receipt)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.registerOwner("11".repeat(32), "22".repeat(32)), receipt);
  } finally {
    restore();
  }
  const call = calls[0];
  assert.equal(call.url, `${BASE}/admin/owners`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.init.headers.authorization, "Bearer t");
  assert.deepEqual(JSON.parse(call.init.body), {
    fabric_id_hex: "11".repeat(32),
    root_hex: "22".repeat(32),
  });
});

test("registerOwner/unregisterOwner: bad hex fails fast client-side (invalid-request, status null)", async () => {
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, {})));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    for (const p of [
      () => client.registerOwner("zz", "22".repeat(32)),
      () => client.registerOwner("11".repeat(32), ""),
      () => client.unregisterOwner("11".repeat(31), "22".repeat(32)),
    ]) {
      // 前置校验为同步 fail-fast（与 disconnect 同形）——assert.throws 而非 rejects
      assert.throws(p, (err) => {
        assert.ok(err instanceof AdminError);
        assert.equal(err.code, "invalid-request");
        assert.equal(err.status, null);
        return true;
      });
    }
    assert.equal(calls.length, 0, "前置校验失败不发请求");
  } finally {
    restore();
  }
});

test("unregisterOwner(): DELETE /admin/owners/{fabric_id}/{root} + kicked receipt passthrough", async () => {
  const receipt = {
    op: "unregister",
    fabric_id: "11".repeat(32),
    root: "22".repeat(32),
    ts: 1789012400000,
    generation: 6,
    receipt_sig: "BB".repeat(43) + "B",
    kicked_endpoints: 2,
    kicked_connections: 3,
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, receipt)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.unregisterOwner("11".repeat(32), "22".repeat(32)), receipt);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/admin/owners/${"11".repeat(32)}/${"22".repeat(32)}`);
  assert.equal(calls[0].init.method, "DELETE");
});

test("connections(): detailed view wire passthrough (mode/relay_enabled split)", async () => {
  const wire = {
    mode: "restricted",
    policy: "static",
    relay_enabled: false,
    quota: { configured: true, max_connections_per_owner: 16 },
    per_endpoint: [],
    per_owner: [],
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, wire)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.connections(), wire);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/admin/connections`);
});

test("disconnect(): endpoint_id / fabric_id bodies + per-target receipts passthrough", async () => {
  const ep = "f80cccdce4ae1c07ae208a2adf99a310ae4207e0306fa0236110b06827bbb8d0";
  const fabric = "55".repeat(32);
  const wire = {
    disconnected: [{ endpoint_id: ep, fabric_id: fabric, connections: 1 }],
    receipts: [
      {
        op: "disconnect",
        fabric_id: fabric,
        endpoint_id: ep,
        ts: 1789012500000,
        generation: 6,
        receipt_sig: "CC".repeat(43) + "C",
      },
    ],
  };
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, wire)));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    assert.deepEqual(await client.disconnect({ endpointId: ep }), wire);
    assert.deepEqual(await client.disconnect({ fabricId: fabric.toUpperCase() }), wire);
  } finally {
    restore();
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, `${BASE}/admin/connections/disconnect`);
    assert.equal(call.init.method, "POST");
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint_id: ep });
  assert.deepEqual(JSON.parse(calls[1].init.body), { fabric_id: fabric });
});

test("disconnect(): neither/both/bad-hex selectors rejected client-side", async () => {
  const { calls, restore } = stubFetch(() => Promise.resolve(fakeResponse(200, {})));
  const client = new AdminClient({ baseUrl: BASE, token: "t" });
  try {
    for (const sel of [
      {},
      { endpointId: "11".repeat(32), fabricId: "22".repeat(32) },
      { endpointId: "nothex" },
      { fabricId: null },
    ]) {
      assert.throws(() => client.disconnect(sel), (err) => {
        assert.ok(err instanceof AdminError, JSON.stringify(sel));
        assert.equal(err.code, "invalid-request");
        assert.equal(err.status, null);
        return true;
      }, JSON.stringify(sel));
    }
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("constructor: rejects malformed baseUrl/token/timeoutMs", () => {
  assert.throws(() => new AdminClient({ baseUrl: "not a url", token: "t" }), TypeError);
  assert.throws(() => new AdminClient({ baseUrl: "", token: "t" }), TypeError);
  assert.throws(() => new AdminClient({ baseUrl: BASE, token: "" }), TypeError);
  assert.throws(() => new AdminClient({ baseUrl: BASE, token: "t", timeoutMs: 0 }), TypeError);
  assert.throws(() => new AdminClient({ baseUrl: BASE, token: "t", timeoutMs: 50.5 }), TypeError);
});
