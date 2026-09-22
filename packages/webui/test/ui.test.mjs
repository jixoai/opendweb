// UI 失败态矩阵 + 视图语义化呈现（webui-console A.11 / design §4 r2-P2-4 /
// spec「UI 失败态矩阵呈现」「无目标时的业务面语义」）。
// 全部经 ui/api.mjs 的 setApiFetch 注入层驱动——不依赖真实 server：
// 1. 六路失败态（not-enabled/unauthorized/http-502/network/timeout/no-match）
//    → 各业务视图呈现语义化提示（无未捕获异常、单页单一错误横幅）；
// 2. setup 态业务请求（503 no-target）→「未连接」引导至配对面，无错误风暴；
// 3. apiFetch 归一单测（envelope 透传 / http-<status> 兜底 / network / timeout /
//    invalid-response）与配对面提交语义（token 不回显、bad-pairing 文案）；
// 4. 回执卡片（op/ts/generation/签名前 16 hex + 复制全文）与 hex64 校验。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeUpstream, vnodeHtml } from "./helpers.mjs";
import { startSidecar } from "../src/sidecar.mjs";
import {
  AdminError,
  fetchSidecarState,
  loadStatus,
  postConnect,
  resetApiFetch,
  setApiFetch,
} from "../ui/api.mjs";
import {
  ConnectView,
  ConnectionsView,
  OwnersView,
  ReceiptCard,
  SetupGate,
  StatusView,
  sigPrefixHex,
  validateHex64,
} from "../ui/views.mjs";

const READY_STATE = { phase: "ready", server_host_masked: "https://***.example:18787", insecure: false };
const SETUP_STATE = { phase: "setup", server_host_masked: null, insecure: false };

test.afterEach(() => resetApiFetch());

/** 构造返回 envelope 错误的 transport 替身。 */
function envelopeTransport(status, code, message = "fixture") {
  return async () =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** 构造非 JSON 空 body 的 transport 替身（http-<status> 兜底路径）。 */
function bareTransport(status) {
  return async () => new Response("", { status });
}

// ---- 六路失败态矩阵 ----

/** 六路 fixture：名 → {mk: transport 替身, code: 预期 AdminError.code, copy: 语义化断言子串} */
const MATRIX = [
  {
    name: "not-enabled",
    mk: () => envelopeTransport(404, "admin-not-enabled"),
    code: "admin-not-enabled",
    copy: "DWEB_ADMIN_TOKEN",
  },
  {
    name: "unauthorized",
    mk: () => envelopeTransport(401, "unauthorized"),
    code: "unauthorized",
    copy: "重启 sidecar",
  },
  { name: "http-502", mk: () => bareTransport(502), code: "http-502", copy: "重试" },
  {
    name: "network",
    mk: () => async () => {
      throw new TypeError("fetch failed");
    },
    code: "network",
    copy: "网络错误",
  },
  {
    name: "timeout",
    mk: () => async () => {
      const e = new Error("signal timed out");
      e.name = "TimeoutError";
      throw e;
    },
    code: "timeout",
    copy: "超时",
  },
  { name: "no-match", mk: () => envelopeTransport(404, "no-match"), code: "no-match", copy: "目标不存在" },
];

for (const fixture of MATRIX) {
  test(`failure matrix [${fixture.name}]: loadStatus rejects with ${fixture.code}; every view renders one semantic banner`, async () => {
    setApiFetch(fixture.mk());
    // 归一面：loader 抛 AdminError 且 code 判别正确（无未捕获异常逃逸）
    const err = await loadStatus().then(
      () => {
        throw new Error("expected rejection");
      },
      (e) => e,
    );
    assert.ok(err instanceof AdminError, `AdminError, got ${err?.constructor?.name}`);
    assert.equal(err.code, fixture.code);

    // 各业务视图：单一错误横幅 + 语义化文案（无错误风暴）
    const views = {
      status: vnodeHtml(StatusView({ state: READY_STATE, data: null, error: err, onRetry: () => {} })),
      owners: vnodeHtml(
        OwnersView({
          state: READY_STATE,
          data: null,
          error: err,
          form: { fabricId: "", root: "" },
          formError: null,
          busy: false,
          receipt: null,
          confirm: null,
          onInput: () => {},
          onRegister: () => {},
          onAskUnregister: () => {},
          onConfirmUnregister: () => {},
          onCancelConfirm: () => {},
          onCopy: () => {},
          onRetry: () => {},
        }),
      ),
      connections: vnodeHtml(
        ConnectionsView({
          state: READY_STATE,
          data: null,
          error: err,
          confirm: null,
          disconnect: null,
          onAskDisconnect: () => {},
          onConfirmDisconnect: () => {},
          onCancelConfirm: () => {},
          onCopy: () => {},
          onRetry: () => {},
        }),
      ),
    };
    for (const [name, html] of Object.entries(views)) {
      assert.ok(html.includes(fixture.copy), `${name} view copy contains "${fixture.copy}"`);
      assert.equal(
        (html.match(/error-banner/g) ?? []).length,
        1,
        `${name} view has exactly one error banner`,
      );
    }
  });
}

test("failure matrix: disconnect POST no-match surfaces inside the disconnect panel", async () => {
  const err = new AdminError("no-match", "no online entries", 404);
  const html = vnodeHtml(
    ConnectionsView({
      state: READY_STATE,
      data: { mode: "restricted", per_endpoint: [], per_owner: [], quota: {} },
      error: null,
      confirm: null,
      disconnect: { kind: "endpoint", id: "ab".repeat(32), phase: "dispatched", receipts: [], error: err },
      onAskDisconnect: () => {},
      onConfirmDisconnect: () => {},
      onCancelConfirm: () => {},
      onCopy: () => {},
      onRetry: () => {},
    }),
  );
  assert.ok(html.includes("目标不存在"));
  assert.ok(html.includes("已下发"));
});

// ---- setup no-target：业务面「未连接」引导（无错误风暴） ----

test("setup no-target: business views render the connect guide, not an error storm", async () => {
  setApiFetch(envelopeTransport(503, "no-target"));
  const err = await loadStatus().then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(err.code, "no-target");
  for (const html of [
    vnodeHtml(StatusView({ state: SETUP_STATE, data: null, error: err, onRetry: () => {} })),
    vnodeHtml(SetupGate()),
  ]) {
    assert.ok(html.includes("未连接"));
    assert.ok(html.includes("#/connect"));
    assert.equal((html.match(/error-banner/g) ?? []).length, 0, "no error banner in setup gate");
  }
});

// ---- apiFetch 归一单测 ----

test("apiFetch normalization: envelope code passthrough, http-<status> fallback, ok JSON", async () => {
  setApiFetch(
    async (path) =>
      new Response(JSON.stringify({ pong: path }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.deepEqual(await loadStatus(), { pong: "/api/status" });

  setApiFetch(envelopeTransport(409, "invalid-request"));
  const env = await loadStatus().then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(env.code, "invalid-request");
  assert.equal(env.status, 409);

  setApiFetch(async () => new Response("<html>", { status: 503 }));
  const bare = await loadStatus().then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(bare.code, "http-503");

  setApiFetch(async () => new Response("not json", { status: 200 }));
  const bad = await loadStatus().then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(bad.code, "invalid-response");

  setApiFetch(null); // null 恢复默认（不抛即算通过接线检查）
  resetApiFetch();
});

// ---- 配对面视图 ----

test("connect view: token input is password/never echoed; success freezes the form with masked host only", () => {
  const formHtml = vnodeHtml(
    ConnectView({
      state: SETUP_STATE,
      form: { server: "https://srv.example:18787", token: "sekret-do-not-echo", code: "ABCD2345" },
      busy: false,
      result: null,
      onInput: () => {},
      onSubmit: () => {},
      onGoStatus: () => {},
    }),
  );
  // 输入期为受控 password 框：token 只允许出现在该框的 value 属性里（浏览器
  // 掩码显示），绝不作为可见文本渲染
  assert.ok(formHtml.includes('type="password"'));
  assert.ok(formHtml.includes('autocomplete="off"'));
  const occurrences = formHtml.split("sekret-do-not-echo").length - 1;
  assert.equal(occurrences, 1, "token appears only as the password input's value attribute");

  // 提交后（应用层已清空表单）：token 零出现
  const clearedHtml = vnodeHtml(
    ConnectView({
      state: SETUP_STATE,
      form: { server: "", token: "", code: "" },
      busy: false,
      result: { ok: true },
      onInput: () => {},
      onSubmit: () => {},
      onGoStatus: () => {},
    }),
  );
  assert.ok(!clearedHtml.includes("sekret-do-not-echo"), "token cleared after submit, never echoed");

  const readyHtml = vnodeHtml(
    ConnectView({
      state: READY_STATE,
      form: { server: "", token: "", code: "" },
      busy: false,
      result: { ok: true },
      onInput: () => {},
      onSubmit: () => {},
      onGoStatus: () => {},
    }),
  );
  assert.ok(readyHtml.includes("已连接"));
  assert.ok(readyHtml.includes("目标已冻结"));
  assert.ok(readyHtml.includes("https://***.example:18787"), "masked host shown");
  assert.ok(!readyHtml.includes("sekret-do-not-echo"));
});

test("connect view: bad-pairing renders the retry/terminal guidance, not a raw code dump", () => {
  const html = vnodeHtml(
    ConnectView({
      state: SETUP_STATE,
      form: { server: "https://srv.example:18787", token: "", code: "WRONG" },
      busy: false,
      result: { ok: false, error: new AdminError("bad-pairing", "pairing code is wrong") },
      onInput: () => {},
      onSubmit: () => {},
      onGoStatus: () => {},
    }),
  );
  assert.ok(html.includes("配对码错误"));
  assert.ok(html.includes("终端"));
  assert.equal((html.match(/error-banner/g) ?? []).length, 1);
});

test("postConnect normalization: sidecar envelope codes flow through the injectable layer", async () => {
  setApiFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  assert.deepEqual(await postConnect({ pairing_code: "X", server: "s", token: "t" }), { ok: true });

  setApiFetch(envelopeTransport(400, "bad-target", "target uses plaintext http"));
  const err = await postConnect({}).then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(err.code, "bad-target");
});

// ---- 回执与校验 ----

const RECEIPT = {
  op: "register",
  fabric_id: "ab".repeat(32),
  root: "cd".repeat(32),
  ts: 1789123456789,
  generation: 4,
  receipt_sig: Buffer.alloc(64, 0).toString("base64url"),
};

test("receipt card: op/ts/generation/sig-16hex + copy-full-text button", () => {
  const html = vnodeHtml(ReceiptCard({ receipt: RECEIPT, onCopy: () => {} }));
  assert.ok(html.includes("register"));
  assert.ok(html.includes("2026-"));
  assert.ok(html.includes(">4<"), "generation shown");
  assert.ok(html.includes("复制全文"));
});

test("sigPrefixHex: first 16 hex of the decoded signature; graceful on bad input", () => {
  const sig = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]), Buffer.alloc(55)]).toString("base64url");
  assert.equal(sigPrefixHex(sig), "deadbeef01234567");
  assert.equal(sigPrefixHex("!!!"), "");
  assert.equal(sigPrefixHex(undefined), "");
});

test("validateHex64 matrix", () => {
  assert.equal(validateHex64("ab".repeat(32)), "ab".repeat(32));
  assert.equal(validateHex64(`  ${"AB".repeat(32)} `), "ab".repeat(32)); // trim + 小写归一
  assert.equal(validateHex64("zz".repeat(32)), null);
  assert.equal(validateHex64("ab".repeat(31)), null);
  assert.equal(validateHex64(12345), null);
});

// ---- 注入层 → 真实 sidecar 链路（state + /api/* 代理 → 视图渲染） ----

test("integration: injectable layer drives a live sidecar end to end", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          mode: "restricted",
          policy: "static",
          generation: 7,
          max_connections_per_owner: 16,
          active_connections: [],
          per_owner_connections: [],
          cache_entries: 0,
        }),
      );
    },
  });
  const sc = await startSidecar({
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port: upstream.port,
      hostHeader: `127.0.0.1:${upstream.port}`,
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token: "int-layer-token",
  });
  t.after(() => Promise.all([sc.close(), upstream.close()]));
  // 注入层指向真实 sidecar（绝对 URL 同源语义的等价替身）
  setApiFetch(async (path, init) => fetch(sc.origin + path, init));

  const state = await fetchSidecarState();
  assert.equal(state.phase, "ready");
  assert.ok(typeof state.server_host_masked === "string");

  const data = await loadStatus();
  assert.equal(upstream.hits[0].url, "/admin/status");
  assert.equal(upstream.hits[0].headers.authorization, "Bearer int-layer-token");

  const html = vnodeHtml(StatusView({ state, data, error: null, onRetry: () => {} }));
  assert.ok(html.includes("restricted"));
  assert.ok(html.includes(">7<"), "generation rendered");
  assert.ok(html.includes("加载中") === false, "data present - not stuck loading");
  resetApiFetch();
});
