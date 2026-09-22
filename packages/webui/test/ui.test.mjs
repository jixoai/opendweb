// UI 失败态矩阵 + 视图语义化呈现（webui-console UI 层重做 / PRODUCT-DESIGN §3–§7）。
// 全部经 ui/api.mjs 的 setApiFetch 注入层驱动——不依赖真实 server：
// 1. 六路失败态（not-enabled/unauthorized/http-502/network/timeout/no-match）
//    → 总览/名册/在线各呈现单一语义化横幅（无未捕获异常、无错误风暴）；
//    传输级错误同时驱动顶栏健康灯四态短标签；
// 2. setup 态任何 hash 一律落全屏引导（业务视图不挂载——「未连接」引导由
//    引导本身承担，结构性消灭错误风暴）；
// 3. apiFetch 归一单测（envelope 透传 / http-<status> 兜底 / network / timeout /
//    invalid-response）与配对提交语义（token 不回显、bad-pairing 文案）；
// 4. 回执卡片（op 中文动词+原始 op/本地时间/名册版本/审计签名摘要 + 复制全文）
//    与 hex64 校验；断连四态同视图闭环 + no-match 语义；
// 5. 术语纪律（§5.1/§8.3）：渲染面无 generation/policy/mode/cache_entries 英文
//    裸值、无「管理员/管理者」、无 ISO 8601 原文、hex 只以缩写呈现（title 全文）。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeUpstream, vnodeHtml } from "./helpers.mjs";
import { startSidecar } from "../src/sidecar.mjs";
import { routeFor } from "../ui/app.mjs";
import {
  AdminError,
  fetchSidecarState,
  loadStatus,
  postConnect,
  resetApiFetch,
  setApiFetch,
} from "../ui/api.mjs";
import {
  ConnectionPanel,
  HealthLight,
  InsecureStrip,
  OnlineView,
  OverviewView,
  ReceiptCard,
  RosterView,
  SetupWizard,
  TargetChip,
  errorCopy,
  fmtClock,
  formatTime,
  healthCopy,
  relativeTime,
  sigPrefixHex,
  validateHex64,
} from "../ui/views.mjs";

const READY_STATE = { phase: "ready", server_host_masked: "https://***.example:18787", insecure: false };
const SETUP_STATE = { phase: "setup", server_host_masked: null, insecure: false };
const NOOP = () => {};
const NOOP_TEXT = () => {};

const overviewProps = (over = {}) => ({
  state: READY_STATE,
  data: null,
  error: null,
  // 名册真源默认携带 1 条（vision 复判回归：总览计数不得用 per_owner_connections）
  ownersData: { generation: 1, owners: [{ fabric_id: "3f".repeat(32), root: "c9".repeat(32), registered_at: 1_789_123_456_789 }] },
  lastFailAt: null,
  onRetry: NOOP,
  onGoOnline: NOOP,
  onGoRegister: NOOP,
  ...over,
});

const rosterProps = (over = {}) => ({
  state: READY_STATE,
  data: null,
  error: null,
  form: { fabricId: "", root: "" },
  formError: null,
  busy: false,
  receipt: null,
  confirm: null,
  onInput: NOOP,
  onRegister: NOOP,
  onFocusRegister: NOOP,
  onAskUnregister: NOOP,
  onConfirmUnregister: NOOP,
  onCancelConfirm: NOOP,
  onCopy: NOOP,
  onCopyText: NOOP_TEXT,
  onFilterOnline: NOOP,
  onRetry: NOOP,
  ...over,
});

const onlineProps = (over = {}) => ({
  state: READY_STATE,
  data: null,
  error: null,
  confirm: null,
  disconnect: null,
  filter: null,
  onAskDisconnect: NOOP,
  onConfirmDisconnect: NOOP,
  onCancelConfirm: NOOP,
  onCopy: NOOP,
  onCopyText: NOOP_TEXT,
  onRetry: NOOP,
  onClearFilter: NOOP,
  onDismissDisconnect: NOOP,
  ...over,
});

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

// ---- 路由收敛：两个世界 + 旧 hash 落位（§3.1 / §7.1） ------------------------------

test("routeFor: ready 态默认落地总览，旧 hash 收敛到正确去处", () => {
  assert.deepEqual(routeFor("#/", "ready"), { view: "overview" });
  assert.deepEqual(routeFor("", "ready"), { view: "overview" });
  assert.deepEqual(routeFor("#/xyz-unknown", "ready"), { view: "overview" });
  assert.deepEqual(routeFor("#/status", "ready"), { view: "overview" }); // 旧状态页 → 总览
  assert.deepEqual(routeFor("#/connect", "ready"), { view: "overview", panel: true }); // 旧配对页 → 总览+连接详情
  assert.deepEqual(routeFor("#/owners", "ready"), { view: "access", section: "roster" }); // 旧 Owners → 名册
  assert.deepEqual(routeFor("#/connections", "ready"), { view: "access", section: "online" }); // 旧连接页 → 在线
  assert.deepEqual(routeFor("#/access", "ready"), { view: "access", section: "roster" });
  assert.deepEqual(routeFor("#/access/roster", "ready"), { view: "access", section: "roster" });
  assert.deepEqual(routeFor("#/access/online", "ready"), { view: "access", section: "online" });
});

test("routeFor: setup 态任何 hash（含全部旧业务路由）一律落全屏引导", () => {
  for (const h of ["", "#/", "#/connect", "#/status", "#/owners", "#/connections", "#/access/online"]) {
    assert.deepEqual(routeFor(h, "setup"), { view: "setup" }, `hash ${h}`);
  }
});

// ---- 六路失败态矩阵（每业务视图单一语义化横幅；健康灯四态） ------------------------

/** 六路 fixture：名 → {mk: transport 替身, code: 预期 AdminError.code, copy: 语义化断言子串} */
const MATRIX = [
  { name: "not-enabled", mk: () => envelopeTransport(404, "admin-not-enabled"), code: "admin-not-enabled", copy: "DWEB_ADMIN_TOKEN" },
  { name: "unauthorized", mk: () => envelopeTransport(401, "unauthorized"), code: "unauthorized", copy: "管理凭证无效" },
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
  { name: "no-match", mk: () => envelopeTransport(404, "no-match"), code: "no-match", copy: "目标不在线" },
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
      overview: vnodeHtml(OverviewView(overviewProps({ error: err }))),
      roster: vnodeHtml(RosterView(rosterProps({ error: err }))),
      online: vnodeHtml(OnlineView(onlineProps({ error: err }))),
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

test("failure matrix: unauthorized has no retry (credential is locked); network does", () => {
  const unauthorized = new AdminError("unauthorized", "denied", 401);
  const network = new AdminError("network", "down", null);
  assert.equal(errorCopy(unauthorized).retry, false);
  assert.equal(errorCopy(network).retry, true);
  const noRetryHtml = vnodeHtml(OverviewView(overviewProps({ error: unauthorized })));
  assert.ok(!noRetryHtml.includes(">重试<"), "unauthorized: no retry button");
  const retryHtml = vnodeHtml(OverviewView(overviewProps({ error: network, lastFailAt: Date.now() })));
  assert.ok(retryHtml.includes(">重试<"), "network: retry button present");
  assert.ok(retryHtml.includes("上次失败"), "auto-retry line shows last failure clock");
});

test("health light: four semantic states from poll result (§4.2 步 1)", () => {
  assert.ok(vnodeHtml(HealthLight({ error: null })).includes("管理面连接正常"));
  assert.ok(vnodeHtml(HealthLight({ error: new AdminError("network", "x") })).includes("连不上服务器"));
  assert.ok(vnodeHtml(HealthLight({ error: new AdminError("timeout", "x") })).includes("连不上服务器"));
  assert.ok(vnodeHtml(HealthLight({ error: new AdminError("unauthorized", "x") })).includes("管理凭证无效"));
  assert.ok(vnodeHtml(HealthLight({ error: new AdminError("admin-not-enabled", "x") })).includes("远端未开启管理面"));
  assert.ok(vnodeHtml(HealthLight({ error: new AdminError("http-502", "x") })).includes("服务器内部错误"));
  assert.ok(vnodeHtml(HealthLight({ error: null, loading: true })).includes("正在连接服务器"));
  assert.equal(healthCopy(null).tone, "ok");
  assert.equal(healthCopy(new AdminError("network", "x")).tone, "bad");
});

// ---- 断连闭环（§4.3 C-2：同视图四态 + no-match 语义） -------------------------------

test("disconnect closed loop: dispatched/converging/converged/unconfirmed copy in the same view", () => {
  const id = "ab".repeat(32);
  const base = onlineProps({
    data: { mode: "restricted", relay_enabled: true, quota: {}, per_endpoint: [], per_owner: [] },
  });
  const at = (phase) =>
    vnodeHtml(OnlineView({ ...base, disconnect: { kind: "endpoint", id, phase, receipts: [], error: null } }));
  assert.ok(at("dispatched").includes("已下发"));
  assert.ok(at("converging").includes("收敛中"));
  assert.ok(at("converging").includes("正在确认连接已断开"));
  assert.ok(at("converged").includes("已收敛"));
  assert.ok(at("converged").includes("已从在线表消失"));
  assert.ok(at("converged").includes("回执如下"));
  assert.ok(at("unconfirmed").includes("超时未确认"));
  assert.ok(at("unconfirmed").includes("15 秒内在线表未观察到收敛"));
  assert.ok(at("unconfirmed").includes("尽力而为"));
});

test("failure matrix: disconnect POST no-match surfaces inside the disconnect panel (target already offline)", () => {
  const err = new AdminError("no-match", "no online entries", 404);
  const html = vnodeHtml(
    OnlineView(
      onlineProps({
        data: { mode: "restricted", relay_enabled: true, quota: {}, per_endpoint: [], per_owner: [] },
        disconnect: { kind: "endpoint", id: "ab".repeat(32), phase: "dispatched", receipts: [], error: err },
      }),
    ),
  );
  assert.ok(html.includes("已经不在线了"));
  assert.ok(html.includes("已下发"));
  assert.ok(html.includes("在线表已刷新"));
});

// ---- setup 世界：no-target 不产生错误风暴（引导本身即「未连接」去向） ----------------

test("setup no-target: any hash lands on the wizard; no error storm is possible", async () => {
  setApiFetch(envelopeTransport(503, "no-target"));
  const err = await loadStatus().then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
  assert.equal(err.code, "no-target");
  // 业务视图在 setup 态不挂载（routeFor 收敛）——错误没有呈现面
  assert.deepEqual(routeFor("#/status", "setup"), { view: "setup" });
  const html = vnodeHtml(
    SetupWizard({
      state: SETUP_STATE,
      form: { server: "", token: "", code: "" },
      busy: false,
      result: null,
      onInput: NOOP,
      onSubmit: NOOP,
      onGoOverview: NOOP,
    }),
  );
  assert.ok(html.includes("把控制台接上你的服务器"));
  assert.equal((html.match(/error-banner/g) ?? []).length, 0, "no error banner in the wizard");
});

// ---- apiFetch 归一单测（注入层行为不变） ---------------------------------------------

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

// ---- 配对引导（§4.1 流 A：安全叙事 + 三步 + token 不回显） ---------------------------

const wizardProps = (over = {}) => ({
  state: SETUP_STATE,
  form: { server: "", token: "", code: "" },
  busy: false,
  result: null,
  onInput: NOOP,
  onSubmit: NOOP,
  onGoOverview: NOOP,
  ...over,
});

test("wizard: token input is password/never echoed; success shows masked host only", () => {
  const formHtml = vnodeHtml(
    SetupWizard(
      wizardProps({ form: { server: "https://srv.example:18787", token: "sekret-do-not-echo", code: "ABCD2345" } }),
    ),
  );
  // 输入期为受控 password 框：token 只允许出现在该框的 value 属性里（浏览器
  // 掩码显示），绝不作为可见文本渲染
  assert.ok(formHtml.includes('type="password"'));
  assert.ok(formHtml.includes('autocomplete="off"'));
  const occurrences = formHtml.split("sekret-do-not-echo").length - 1;
  assert.equal(occurrences, 1, "token appears only as the password input's value attribute");
  // 三步编号与锁定语义前置披露（§4.1 步 2-4）
  assert.ok(formHtml.includes("① 服务器地址"));
  assert.ok(formHtml.includes("② 管理凭证"));
  assert.ok(formHtml.includes("③ 配对码"));
  assert.ok(formHtml.includes("连接并锁定"));
  assert.ok(formHtml.includes("不能改指其他服务器"));

  // 提交后（应用层已清空表单 + 状态已刷新）：token 零出现
  const clearedHtml = vnodeHtml(
    SetupWizard(wizardProps({ state: READY_STATE, result: { ok: true } })),
  );
  assert.ok(!clearedHtml.includes("sekret-do-not-echo"), "token cleared after submit, never echoed");

  // 成功确认幕：已连接 + 掩码目标 + 目标已锁定
  assert.ok(clearedHtml.includes("已连接"));
  assert.ok(clearedHtml.includes("正在进入总览"));
  assert.ok(clearedHtml.includes("https://***.example:18787"), "masked host shown");
});

test("wizard: bad-pairing renders the retry/terminal guidance, not a raw code dump", () => {
  const html = vnodeHtml(
    SetupWizard(
      wizardProps({
        form: { server: "https://srv.example:18787", token: "", code: "WRONG" },
        result: { ok: false, error: new AdminError("bad-pairing", "pairing code is wrong") },
      }),
    ),
  );
  assert.ok(html.includes("配对码不对，或已过期"));
  assert.ok(html.includes("终端"));
  assert.ok(html.includes("10 分钟内有效"));
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

// ---- 时间与 hex 呈现（§5.1/§7.3：人类可读 + 分层披露） -------------------------------

test("formatTime: local time + relative time; never ISO 8601", () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 5_000, now), "刚刚");
  assert.equal(relativeTime(now - 30_000, now), "30 秒前");
  assert.equal(relativeTime(now - 2 * 60_000, now), "2 分钟前");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 天前");
  const s = formatTime(1_789_123_456_789, now);
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（.+）$/, "local datetime + relative");
  assert.ok(!s.includes("T"), "no ISO 8601 literal");
  assert.match(fmtClock(1_789_123_456_789), /^\d{2}:\d{2}:\d{2}$/);
});

test("hex display: browsing surfaces abbreviate; full value only in title attribute", () => {
  const fabric = "ab".repeat(32);
  const html = vnodeHtml(
    RosterView(
      rosterProps({
        data: { generation: 4, owners: [{ fabric_id: fabric, root: "cd".repeat(32), registered_at: 1_789_123_456_789 }] },
      }),
    ),
  );
  assert.ok(html.includes(`${fabric.slice(0, 8)}…`), "abbreviated hex visible");
  assert.ok(!html.includes(`>${fabric}<`), "full hex never a visible text node");
  assert.ok(html.includes(`title="${fabric}"`), "full hex in title (hover)");
});

// ---- 回执与校验（冻结契约：op/时间/名册版本/签名摘要 + 复制全文） ---------------------

const RECEIPT = {
  op: "register",
  fabric_id: "ab".repeat(32),
  root: "cd".repeat(32),
  ts: 1789123456789,
  generation: 4,
  receipt_sig: Buffer.alloc(64, 0).toString("base64url"),
};

test("receipt card: op verb + local time + 名册版本 + audit sig digest + copy-full-text", () => {
  const html = vnodeHtml(ReceiptCard({ receipt: RECEIPT, onCopy: NOOP, onCopyText: NOOP_TEXT }));
  assert.ok(html.includes("注册"), "op rendered as verb badge");
  assert.ok(html.includes('title="op: register"'), "raw op preserved in title");
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（/.test(html), "human-readable local time");
  assert.ok(html.includes("名册版本"));
  assert.ok(html.includes(">v4<"), "generation as v-prefixed roster version");
  assert.ok(html.includes("审计签名"), "audit signature field present");
  assert.ok(html.includes("已含服务端签名"));
  assert.ok(html.includes("复制全文"));
  const kicked = vnodeHtml(
    ReceiptCard({
      receipt: { ...RECEIPT, op: "disconnect", endpoint_id: "ef".repeat(32), kicked_connections: 2 },
      onCopy: NOOP,
      onCopyText: NOOP_TEXT,
    }),
  );
  assert.ok(kicked.includes("一并断开的连接"));
  assert.ok(kicked.includes("2 条"));
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

// ---- 空态即引导（§5.2/§7.4） ---------------------------------------------------------

test("overview empty roster: guidance with register CTA (restricted mode)", () => {
  const html = vnodeHtml(
    OverviewView(
      overviewProps({
        data: { mode: "restricted", policy: "static", generation: 1, max_connections_per_owner: 16, active_connections: [], per_owner_connections: [] },
        ownersData: { generation: 1, owners: [] },
      }),
    ),
  );
  assert.ok(html.includes("还没有任何所有者能使用这台服务器"));
  assert.ok(html.includes("去注册所有者"));
  assert.ok(html.includes("一切正常"), "conclusion still answers the health question");
});

test("overview owner count uses roster, not per-owner online projection (vision regression)", () => {
  // 0 条在线连接（per_owner_connections 空）+ 名册 1 个所有者 → 计数必须是 1
  const html = vnodeHtml(
    OverviewView(
      overviewProps({
        data: { mode: "restricted", policy: "static", generation: 1, active_connections: [], per_owner_connections: [] },
      }),
    ),
  );
  assert.ok(html.includes("1 个所有者"), "count comes from roster owners list");
  assert.ok(!html.includes("0 个所有者"), "must not show 0 from empty online projection");
  // 名册未加载 → 不呈现假 0（…占位 + 结论行省略该半句）
  const loading = vnodeHtml(OverviewView(overviewProps({ data: { mode: "restricted", generation: 1 }, ownersData: null })));
  assert.ok(!loading.includes("0 个所有者"), "no fake zero while roster loading");
});

test("overview open mode: warning line, no roster guidance", () => {
  const html = vnodeHtml(
    OverviewView(
      overviewProps({
        data: { mode: "open", policy: "static", generation: 1, active_connections: [], per_owner_connections: [] },
        ownersData: { generation: 1, owners: [] },
      }),
    ),
  );
  assert.ok(html.includes("开放模式"));
  assert.ok(html.includes("任何人都能接入"));
  assert.ok(!html.includes("去注册所有者"), "open mode has no roster-empty guidance");
});

test("roster empty state: guidance + register action", () => {
  const html = vnodeHtml(RosterView(rosterProps({ data: { generation: 3, owners: [] } })));
  assert.ok(html.includes("名册是空的"));
  assert.ok(html.includes("注册后，对应的 Fabric 才能通过这台服务器组网"));
  assert.ok(html.includes("注册所有者"));
});

test("online empty states: three distinct copies (none / relay off / open mode)", () => {
  const rows = { quota: {}, per_endpoint: [{ endpoint_id: "ab".repeat(32), fabric_id: "cd".repeat(32), connections: 1 }], per_owner: [{ fabric_id: "cd".repeat(32), connections: 1 }] };
  const empty = vnodeHtml(OnlineView(onlineProps({ data: { mode: "restricted", relay_enabled: true, ...rows, per_endpoint: [], per_owner: [] } })));
  assert.ok(empty.includes("当前没有在线连接"));
  const relayOff = vnodeHtml(OnlineView(onlineProps({ data: { mode: "restricted", relay_enabled: false, ...rows } })));
  assert.ok(relayOff.includes("中继（relay）未启用"));
  assert.ok(!relayOff.includes("当前没有在线连接"), "relay-off is not the plain-empty copy");
  const open = vnodeHtml(OnlineView(onlineProps({ data: { mode: "open", relay_enabled: true, ...rows } })));
  assert.ok(open.includes("开放模式下没有在线统计"));
});

// ---- 破坏性动作知情前置（§4.3/§7.5：范围/异步性/恢复路径 + 无压力取消） ----------------

test("disconnect confirm: scope + async semantics disclosed before confirming; 先不了 is the calm option", () => {
  const endpoint = vnodeHtml(
    OnlineView(onlineProps({ confirm: { kind: "endpoint", id: "ab".repeat(32), count: 2 } })),
  );
  assert.ok(endpoint.includes("断开这个端点？"));
  assert.ok(endpoint.includes("2 条连接"));
  assert.ok(endpoint.includes("断开是异步的"));
  assert.ok(endpoint.includes("直到连接从在线表消失"));
  assert.ok(endpoint.includes("确认断开"));
  assert.ok(endpoint.includes("先不了"));
  const fabric = vnodeHtml(
    OnlineView(onlineProps({ confirm: { kind: "fabric", id: "cd".repeat(32), count: 5 } })),
  );
  assert.ok(fabric.includes("断开这个所有者？"));
  assert.ok(fabric.includes("名下的"));
});

test("unregister confirm: scope + recovery path disclosed before confirming", () => {
  const html = vnodeHtml(
    RosterView(rosterProps({ confirm: { fabricId: "ab".repeat(32), root: "cd".repeat(32) } })),
  );
  assert.ok(html.includes("注销这个所有者？"));
  assert.ok(html.includes("新连接立即被拒"));
  assert.ok(html.includes("一并断开"));
  assert.ok(html.includes("重新注册即可"));
  assert.ok(html.includes("确认注销"));
  assert.ok(html.includes("先不了"));
});

// ---- 名册 ⇄ 在线互链（§3.1 裁决 3：fabric 过滤） --------------------------------------

test("roster-to-online interlink: filter chip + filtered tables", () => {
  const fabricA = "ab".repeat(32);
  const fabricB = "cd".repeat(32);
  const data = {
    mode: "restricted",
    relay_enabled: true,
    quota: { configured: true, max_connections_per_owner: 16 },
    per_endpoint: [
      { endpoint_id: "01".repeat(32), fabric_id: fabricA, connections: 1 },
      { endpoint_id: "02".repeat(32), fabric_id: fabricB, connections: 3 },
    ],
    per_owner: [
      { fabric_id: fabricA, connections: 1 },
      { fabric_id: fabricB, connections: 3 },
    ],
  };
  const filtered = vnodeHtml(OnlineView(onlineProps({ data, filter: fabricA })));
  assert.ok(filtered.includes("只看所有者"));
  assert.ok(filtered.includes("清除"));
  assert.ok(filtered.includes(`${fabricA.slice(0, 8)}…`));
  assert.ok(!filtered.includes(`>${fabricB.slice(0, 8)}…<`), "other fabric rows hidden");
});

test("roster rows expose the online interlink action with in-use status", () => {
  const owner = { fabric_id: "ab".repeat(32), root: "cd".repeat(32), registered_at: 1_789_123_456_789 };
  // 未在用（在线快照无该 fabric）→ 灰态「未在用」+ 可点互链
  const idle = vnodeHtml(RosterView(rosterProps({ data: { generation: 4, owners: [owner] } })));
  assert.ok(idle.includes(">未在用<"), "idle status shown, not a bare action label");
  assert.ok(idle.includes("当前没有活跃连接"));
  // 在用（per_owner 含该 fabric）→ 绿态「在用」+ 可点互链
  const active = vnodeHtml(
    RosterView(
      rosterProps({
        data: { generation: 4, owners: [owner] },
        onlineFabrics: new Set([owner.fabric_id]),
      }),
    ),
  );
  assert.ok(active.includes(">在用<"), "in-use status when fabric has live connections");
  assert.ok(active.includes("有活跃连接——点击查看在线连接明细"));
});

// ---- 顶栏：目标徽片 / 连接详情面板 / 明文告警条 ----------------------------------------

test("connection details panel: masked target, security model, restart-to-repoint, insecure note", () => {
  const html = vnodeHtml(
    ConnectionPanel({ state: { ...READY_STATE, insecure: true }, onClose: NOOP }),
  );
  assert.ok(html.includes("https://***.example:18787"));
  assert.ok(html.includes("浏览器不保存、不回显"));
  assert.ok(html.includes("已锁定"));
  assert.ok(html.includes("重新运行启动命令"));
  assert.ok(html.includes("连接未加密"));
  assert.ok(vnodeHtml(TargetChip({ masked: "https://***.example:18787" })).includes("https://***.example:18787"));
});

test("insecure strip: persistent warning tone with allow-insecure explanation", () => {
  const html = vnodeHtml(InsecureStrip());
  assert.ok(html.includes("连接未加密"));
  assert.ok(html.includes("--allow-insecure"));
  assert.ok(html.includes("管理凭证"));
});

// ---- 术语纪律总扫（§5.1/§7.3/§8.3） ---------------------------------------------------

test("terminology sweep: no raw engineering terms, no 管理员/管理者, no ISO time, no cache_entries", () => {
  const richStatus = {
    mode: "restricted",
    policy: "static",
    generation: 7,
    max_connections_per_owner: 16,
    active_connections: [{ endpoint_id: "ab".repeat(32), fabric_id: "cd".repeat(32), connections: 2 }],
    per_owner_connections: [{ fabric_id: "cd".repeat(32), connections: 2 }],
    relay_enabled: true,
    cache_entries: 42,
  };
  const richConnections = {
    mode: "restricted",
    relay_enabled: true,
    quota: { configured: true, max_connections_per_owner: 16 },
    per_endpoint: [{ endpoint_id: "ab".repeat(32), fabric_id: "cd".repeat(32), connections: 2 }],
    per_owner: [{ fabric_id: "cd".repeat(32), connections: 2 }],
  };
  const richOwners = {
    generation: 7,
    owners: [{ fabric_id: "cd".repeat(32), root: "ef".repeat(32), registered_at: 1_789_123_456_789 }],
  };
  const surfaces = {
    overview: vnodeHtml(OverviewView(overviewProps({ data: richStatus }))),
    roster: vnodeHtml(RosterView(rosterProps({ data: richOwners, receipt: RECEIPT }))),
    online: vnodeHtml(
      OnlineView(
        onlineProps({
          data: richConnections,
          disconnect: { kind: "endpoint", id: "ab".repeat(32), phase: "converged", receipts: [{ ...RECEIPT, op: "disconnect", endpoint_id: "ab".repeat(32), kicked_connections: 2 }], error: null },
        }),
      ),
    ),
    wizard: vnodeHtml(SetupWizard(wizardProps({ form: { server: "https://x.example", token: "t", code: "A234567890123B" } }))),
    panel: vnodeHtml(ConnectionPanel({ state: READY_STATE, onClose: NOOP })),
    strip: vnodeHtml(InsecureStrip()),
    receipt: vnodeHtml(ReceiptCard({ receipt: RECEIPT, onCopy: NOOP, onCopyText: NOOP_TEXT })),
  };
  const forbidden = [
    "generation",
    "cache_entries",
    "管理员",
    "管理者",
    "（mode）",
    "（policy）",
    "restricted",
    "static",
    ">Owner",
    "Owner<",
  ];
  for (const [name, html] of Object.entries(surfaces)) {
    for (const bad of forbidden) {
      assert.ok(!html.includes(bad), `${name} must not contain "${bad}"`);
    }
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(html), `${name} has no ISO 8601 timestamp`);
  }
  // 关键术语落位抽查
  assert.ok(surfaces.overview.includes("受限模式"));
  assert.ok(surfaces.overview.includes("静态名册"));
  assert.ok(surfaces.overview.includes("v7"));
  assert.ok(surfaces.overview.includes("每次所有者名册变更后加 1"), "roster version explained");
  assert.ok(surfaces.overview.includes("每所有者连接上限"));
  assert.ok(!surfaces.overview.includes("缓存"), "cache_entries not surfaced anywhere");
});

// ---- 注入层 → 真实 sidecar 链路（state + /api/* 代理 → 视图渲染） ---------------------

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

  const html = vnodeHtml(OverviewView(overviewProps({ state, data })));
  assert.ok(html.includes("受限模式"));
  assert.ok(html.includes(">v7<"), "roster version rendered");
  assert.ok(html.includes("一切正常"), "conclusion present");
  assert.ok(!html.includes("正在连接服务器"), "data present - not stuck loading");
  assert.ok(vnodeHtml(HealthLight({ error: null })).includes("管理面连接正常"));
  resetApiFetch();
});
