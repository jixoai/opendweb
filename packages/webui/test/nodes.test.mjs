// 节点簿单测（server-access-roles Phase 2b / specs/webui「节点簿与节点切换」）。
// 覆盖冻结 requirement 的全部场景：
// 1. 存储：nodes.json 0600；临时文件+原子 rename（无 .tmp 残留）；symlink 拒绝
//    （读侧拒启 + 写侧拒绝）；损坏 JSON 拒启；
// 2. 添加：配对码（终端打印/成功后轮换/连败 5 次轮换/坏目标不烧码/单飞锁）；
//    validateTarget 全量校验；Host/Origin 守卫；
// 3. 切换：仅接受已存 node_id（任何 URL/host/server 字段 400 且零出站）；
//    unknown node_id 404；切换后 /api/* 即刻指向新节点（进程未重启、同端口）；
//    在途请求按请求开始时的 target 快照完成；当前未入簿目标切走前自动入簿；
// 4. 删除：当前节点 409（先切走）；其他节点删除后从文件消失；
// 5. 披露：一切响应/日志零 token；节点响应只含 {id,name,server_host,added_at,current}；
//    /sidecar/state 形状不变；未启用节点簿时 /sidecar/nodes* 404。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSidecar } from "../src/sidecar.mjs";
import { NodeStore, NodeStoreError, publicNode } from "../src/nodes.mjs";
import { fakeUpstream, postJson, request } from "./helpers.mjs";

/** ready 态 sidecar + 假上游 + 注入 nodesFile */
async function sidecarWithNodes(upstream, nodesFile, { token = "node-token-a", logs = [] } = {}) {
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
    token,
    nodesFile,
    log: (line) => logs.push(line),
  });
  return { sc, logs };
}

function nodeBody(sc, server, overrides = {}) {
  return { pairing_code: sc.nodePairingCode(), server, token: "node-token-b", ...overrides };
}

test.afterEach(async () => {}); // 各用例自管 close（t.after 显式挂）

// ---- 存储纪律 -----------------------------------------------------------------------

test("nodes store: entries persist with 0600 mode via atomic rename (no tmp leftovers)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  t.after(() => upstream.close());
  const file = path.join(dir, "nodes.json");
  const { sc, logs } = await sidecarWithNodes(upstream, file);
  t.after(() => sc.close());

  const add = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url, { name: "家里节点" }));
  assert.equal(add.status, 200, add.text);
  const entry = JSON.parse(add.text).node;
  assert.deepEqual(Object.keys(entry).sort(), ["added_at", "current", "id", "name", "server_host"]);

  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, "nodes.json must be 0600");
  const leftTmp = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftTmp, [], "no temp file leftovers after atomic rename");
  const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.nodes.length, 1);
  assert.equal(persisted.nodes[0].token, "node-token-b", "token persists in the 0600 store (versioned exception)");
  // 成功添加即轮换新码并打印终端（措辞不含 "pairing code: " 前缀）
  assert.ok(logs.some((l) => l.includes("node book add code:")), "rotation printed to terminal");
  assert.ok(!logs.some((l) => /pairing code: [A-Z2-7]{13}/.test(l)), "node-add line must not collide with the setup pairing-code pattern");
});

test("nodes store: symlinked nodes.json refuses to load (no symlink following)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-sym-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "real.json");
  await writeFile(target, JSON.stringify({ version: 1, nodes: [] }));
  const link = path.join(dir, "nodes.json");
  await symlink(target, link);
  await assert.rejects(
    () => startSidecar({ nodesFile: link }),
    (e) => e instanceof NodeStoreError || /symlink/.test(String(e?.message ?? e)),
  );
});

test("nodes store: corrupted JSON refuses to start (fail-fast ledger discipline)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nodes.json");
  await writeFile(file, "{not json");
  await assert.rejects(() => startSidecar({ nodesFile: file }));
});

test("nodes store unit: add/remove/get + publicNode projection never carries token", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-unit-"));
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();
  assert.deepEqual(store.nodes, []);
  const entry = await store.add({ name: "公司", server_host: "https://srv.example:18787", token: "sec", added_at: 1 });
  assert.equal(store.get(entry.id), entry);
  assert.equal(JSON.stringify(publicNode(entry, false)).includes("sec"), false);
  assert.deepEqual(publicNode(entry, true), {
    id: entry.id, name: "公司", server_host: "https://srv.example:18787", added_at: 1, current: true,
  });
  assert.equal(await store.remove(entry.id), entry);
  assert.equal(await store.remove(entry.id), null);
});

// ---- 添加面：配对码纪律 -----------------------------------------------------------------

test("node add: wrong code 5 times rotates the code (fresh code then works)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-burn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const { sc } = await sidecarWithNodes(upstream, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const staleCode = sc.nodePairingCode();
  for (let i = 0; i < 5; i++) {
    const r = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url, { pairing_code: "WRONGWRONGWRON" }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.text).error.code, "bad-pairing");
  }
  assert.notEqual(sc.nodePairingCode(), staleCode, "code rotated after 5 failures");
  const ok = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url));
  assert.equal(ok.status, 200, `fresh code accepted: ${ok.text}`);
});

test("node add: bad target does not burn the code; consumed code rotates (each add = new code)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-badtarget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const { sc } = await sidecarWithNodes(upstream, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const first = sc.nodePairingCode();
  const bad = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, "http://203.0.113.10:18787"));
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).error.code, "bad-target");
  assert.equal(sc.nodePairingCode(), first, "code not burned on bad-target");
  const ok = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url));
  assert.equal(ok.status, 200);
  assert.notEqual(sc.nodePairingCode(), first, "code rotated after successful add");
  const replay = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url, { pairing_code: first }));
  assert.equal(replay.status, 400, "consumed code is single-use");
});

test("node add: cross-origin and bad-Host rejected (same guard as connect)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-origin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const { sc } = await sidecarWithNodes(upstream, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const evil = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url), { origin: "http://evil.example" });
  assert.equal(JSON.parse(evil.text).error.code, "bad-origin-host");
  const badHost = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url), { host: "evil.example" });
  assert.equal(JSON.parse(badHost.text).error.code, "bad-origin-host");
  // 守卫先于配对码——正确码未被烧
  const ok = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url));
  assert.equal(ok.status, 200);
});

// ---- 切换：冻结例外语义 -------------------------------------------------------------------

test("switch: accepts stored node_id ONLY - any url/host/server field is 400 with zero outbound", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-switch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const { sc } = await sidecarWithNodes(upstream, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const attacker = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  t.after(() => attacker.close());
  const hostile = [
    { server: attacker.url },
    { url: attacker.url },
    { host: attacker.url },
    { server_host: attacker.url },
    { node_id: "n1", url: attacker.url },
    { node_id: "" },
    "not-an-object",
  ];
  for (const body of hostile) {
    const r = await postJson(sc.port, "/sidecar/nodes/switch", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(JSON.parse(r.text).error.code, "invalid-request");
  }
  assert.equal(attacker.hits.length, 0, "zero outbound connections for rejected switch bodies");
  const unknown = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: "ffffffffffffffff" });
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(unknown.text).error.code, "no-match");
  assert.equal(attacker.hits.length, 0);
});

test("switch: /api/* immediately proxies to node B (same process, no restart)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({
    handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ node: "A" })); },
  });
  const upstreamB = await fakeUpstream({
    handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ node: "B" })); },
  });
  t.after(() => Promise.all([upstreamA.close(), upstreamB.close()]));
  const file = path.join(dir, "nodes.json");
  const { sc } = await sidecarWithNodes(upstreamA, file, { token: "node-token-a" });
  t.after(() => sc.close());
  const portBefore = sc.port;

  const before = await request(sc.port, { path: "/api/status" });
  assert.equal(JSON.parse(before.text).node, "A");
  assert.equal(upstreamA.hits[0].headers.authorization, "Bearer node-token-a");

  // 添加节点 B 并切换
  const add = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstreamB.url, { token: "node-token-b", name: "家里节点" }));
  assert.equal(add.status, 200, add.text);
  const nodeB = JSON.parse(add.text).node;
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: nodeB.id });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(JSON.parse(sw.text).node.current, true);

  const after = await request(sc.port, { path: "/api/status" });
  assert.equal(JSON.parse(after.text).node, "B", "proxy re-points to node B immediately");
  assert.equal(upstreamB.hits[0].url, "/admin/status");
  assert.equal(upstreamB.hits[0].headers.authorization, "Bearer node-token-b");
  assert.equal(sc.mode(), "ready");
  assert.equal(sc.port, portBefore, "process not restarted (same port)");

  // 列表：B 为当前；未入簿的旧目标 A 已被自动入簿（可切回）
  const list = await request(sc.port, { path: "/sidecar/nodes" });
  const nodes = JSON.parse(list.text).nodes;
  assert.equal(nodes.filter((n) => n.current).length, 1);
  assert.equal(nodes.find((n) => n.current).id, nodeB.id);
  const nodeA = nodes.find((n) => n.id !== nodeB.id);
  assert.ok(nodeA !== undefined, "previous (pre-book) target auto-saved on switch-out");
  const back = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: nodeA.id });
  assert.equal(back.status, 200);
  const again = await request(sc.port, { path: "/api/status" });
  assert.equal(JSON.parse(again.text).node, "A", "switch back to the auto-saved node works");
  assert.equal(upstreamA.hits[upstreamA.hits.length - 1].headers.authorization, "Bearer node-token-a");
});

test("switch: in-flight request completes against the request-start target snapshot", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-inflight-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { setTimeout: delay } = await import("node:timers/promises");
  // 上游 A：状态就绪后延迟响应（制造在途窗口）
  const upstreamA = await fakeUpstream({
    handler: async (req, res) => {
      await delay(250);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ node: "A-slow" }));
    },
  });
  const upstreamB = await fakeUpstream({
    handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ node: "B" })); },
  });
  t.after(() => Promise.all([upstreamA.close(), upstreamB.close()]));
  const { sc } = await sidecarWithNodes(upstreamA, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const add = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstreamB.url));
  const nodeB = JSON.parse(add.text).node;

  // 在途请求先出发；请求体已读、上游连接已建立后切换
  const inflight = request(sc.port, { path: "/api/status" });
  await delay(80); // 让 handleApi 抓完快照并进入上游等待
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: nodeB.id });
  assert.equal(sw.status, 200, sw.text);
  const res = await inflight;
  assert.equal(JSON.parse(res.text).node, "A-slow", "in-flight request finishes on its start-time target snapshot");
  const next = await request(sc.port, { path: "/api/status" });
  assert.equal(JSON.parse(next.text).node, "B", "post-switch request hits the new target");
});

// ---- 删除 ---------------------------------------------------------------------------

test("delete: current node is 409 (switch away first); other nodes removed from disk", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-del-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  const upstreamB = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  t.after(() => Promise.all([upstreamA.close(), upstreamB.close()]));
  const file = path.join(dir, "nodes.json");
  const { sc } = await sidecarWithNodes(upstreamA, file);
  t.after(() => sc.close());
  const addB = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstreamB.url, { token: "node-token-b" }));
  const nodeB = JSON.parse(addB.text).node;

  // 当前目标在添加 B 后仍来自启动参数——先切到 B（A 自动入簿），再删 B 应 409
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: nodeB.id });
  assert.equal(sw.status, 200);
  const delCurrent = await request(sc.port, { method: "DELETE", path: `/sidecar/nodes/${nodeB.id}` });
  assert.equal(delCurrent.status, 409);
  assert.equal(JSON.parse(delCurrent.text).error.code, "node-current");

  const list = JSON.parse((await request(sc.port, { path: "/sidecar/nodes" })).text);
  const nodeA = list.nodes.find((n) => n.id !== nodeB.id);
  const delOther = await request(sc.port, { method: "DELETE", path: `/sidecar/nodes/${nodeA.id}` });
  assert.equal(delOther.status, 200);
  const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
  assert.equal(persisted.nodes.some((n) => n.id === nodeA.id), false, "deleted node gone from disk");
  const delUnknown = await request(sc.port, { method: "DELETE", path: "/sidecar/nodes/ffffffffffffffff" });
  assert.equal(delUnknown.status, 404);
});

// ---- 披露与基线面不变 ----------------------------------------------------------------------

test("disclosure: node responses and logs never contain any token; state shape unchanged", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-leak-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  t.after(() => upstream.close());
  const logs = [];
  const file = path.join(dir, "nodes.json");
  const { sc } = await sidecarWithNodes(upstream, file, { token: "node-token-a", logs });
  t.after(() => sc.close());
  const add = await postJson(sc.port, "/sidecar/nodes", nodeBody(sc, upstream.url, { token: "node-token-b-secret" }));
  const list = await request(sc.port, { path: "/sidecar/nodes" });
  const state = await request(sc.port, { path: "/sidecar/state" });
  const nodeB = JSON.parse(add.text).node;
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: nodeB.id });
  const del = await request(sc.port, { method: "DELETE", path: `/sidecar/nodes/${nodeB.id}` }).catch(() => null);
  const surfaces = [add.text, list.text, state.text, sw.text, String(del?.text ?? ""), logs.join("\n")];
  for (const s of surfaces) {
    assert.ok(!s.includes("node-token-b-secret"), `token leaked: ${s}`);
    assert.ok(!s.includes("node-token-a"), `current token leaked: ${s}`);
  }
  // state 形状不因节点簿改变（基座契约）
  const stateBody = JSON.parse(state.text);
  assert.deepEqual(Object.keys(stateBody).sort(), ["insecure", "phase", "server_host_masked"]);
});

test("nodes disabled (no nodesFile): /sidecar/nodes* 404 and connect face unchanged", async (t) => {
  const sc = await startSidecar({});
  t.after(() => sc.close());
  assert.equal(sc.nodePairingCode(), null);
  assert.equal((await request(sc.port, { path: "/sidecar/nodes" })).status, 404);
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: "n1" });
  assert.equal(sw.status, 404);
  // setup 配对面原样可用
  assert.equal((await request(sc.port, { path: "/api/status" })).status, 503);
});

test("nodes enabled but book empty: switch of any id is 404; delete current guard only applies to stored current", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-nodes-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const { sc } = await sidecarWithNodes(upstream, path.join(dir, "nodes.json"));
  t.after(() => sc.close());
  const list = JSON.parse((await request(sc.port, { path: "/sidecar/nodes" })).text);
  assert.deepEqual(list.nodes, []);
  const sw = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: "abc" });
  assert.equal(sw.status, 404);
});
