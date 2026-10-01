// claude-code 写手单测（ai-subscription-sharing Phase D / tasks D1）。
// 覆盖：
// 1. compose 纯函数：占位符 token 纪律（恒 sk-aifly-local——真实凭证绝不入
//    settings.json）、surgical 合并（既有字段/env 兄弟键保留）、非对象 JSON
//    拒绝改写。
// 2. anthropic base 推导：anthropic 路由剥尾部 /v1；无路由裸 base。
// 3. 两段式：preview 纯读（diff+sha256 令牌）→ apply 令牌一致落盘（0600）；
//    令牌不符/预览后盘面变化 → stale 拒绝（零字节写入）。
// 4. runtime/mgmt 接线：POST /consumer/writer/{preview,apply}（隔离 writerHome
//    ——绝不触真实 ~/.claude；端点不在监听=409）。
// 凭证纪律断言：钥环真实密钥材料不出现在写盘产物（占位符纪律有测试断言）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempHome, aiDataDir } from "./helpers.mjs";
import {
  CLAUDE_CODE_PLACEHOLDER_TOKEN,
  WriterError,
  anthropicBaseUrl,
  applyClaudeCodeWriter,
  claudeCodeSettingsPath,
  composeClaudeCodeSettings,
  previewClaudeCodeWriter,
  sha256Hex,
} from "../src/consumer/writers/claude-code.mjs";
import { createAiRuntime } from "../src/runtime.mjs";

// ---------------------------------------------------------------------------
// 纯函数面
// ---------------------------------------------------------------------------

test("writer compose: placeholder token discipline + surgical merge", () => {
  // 全新文件（不存在语义：existing=null）
  const fresh = composeClaudeCodeSettings(null, "http://127.0.0.1:43001");
  const parsed = JSON.parse(fresh);
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43001");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_PLACEHOLDER_TOKEN);
  assert.equal(CLAUDE_CODE_PLACEHOLDER_TOKEN, "sk-aifly-local");
  assert.ok(fresh.endsWith("\n"), "2 空格缩进 + 末尾换行");

  // 既有字段 + env 兄弟键全保留；只覆盖两个键
  const existing = JSON.stringify({ model: "claude-x", env: { FOO: "bar", ANTHROPIC_BASE_URL: "https://old.example" } });
  const merged = JSON.parse(composeClaudeCodeSettings(existing, "http://127.0.0.1:43002"));
  assert.equal(merged.model, "claude-x");
  assert.equal(merged.env.FOO, "bar");
  assert.equal(merged.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43002");
  assert.equal(merged.env.ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_PLACEHOLDER_TOKEN);

  // 真实凭证绝不写入：token 位恒为占位符（compose 无任何凭证入参——占位符
  // 是唯一可能出现的 token 值）
  assert.equal(JSON.parse(composeClaudeCodeSettings(existing, "http://127.0.0.1:1")).env.ANTHROPIC_AUTH_TOKEN, "sk-aifly-local");
});

test("writer compose: refuses non-object settings (no destructive rewrite)", () => {
  assert.throws(() => composeClaudeCodeSettings("[1,2]", "http://127.0.0.1:1"), (e) => e instanceof WriterError && e.code === "invalid_settings");
  assert.throws(() => composeClaudeCodeSettings("\"str\"", "http://127.0.0.1:1"), (e) => e.code === "invalid_settings");
  assert.throws(() => composeClaudeCodeSettings("{ bad json", "http://127.0.0.1:1"), (e) => e.code === "invalid_settings");
  // env 非对象同样拒绝
  assert.throws(() => composeClaudeCodeSettings(JSON.stringify({ env: [1] }), "http://127.0.0.1:1"), (e) => e.code === "invalid_settings");
});

test("writer anthropic base: route-aware /v1 stripping + bare fallback", () => {
  assert.equal(anthropicBaseUrl(4300, []), "http://127.0.0.1:4300");
  // anthropic 路由 /v1 → 剥版本段（client 自带 /v1/messages）
  assert.equal(anthropicBaseUrl(4300, [{ forms: ["anthropic"], localPrefix: "/v1" }]), "http://127.0.0.1:4300");
  // anthropic 路由 /anthropic → 原样
  assert.equal(anthropicBaseUrl(4300, [{ forms: ["anthropic"], localPrefix: "/anthropic" }]), "http://127.0.0.1:4300/anthropic");
  // 只有 openai 路由 → 裸 base
  assert.equal(anthropicBaseUrl(4300, [{ forms: ["openai-chat"], localPrefix: "/v1" }]), "http://127.0.0.1:4300");
});

// ---------------------------------------------------------------------------
// 两段式 preview → apply
// ---------------------------------------------------------------------------

test("writer preview/apply: two-phase with sha256 confirm token; 0600; stale rejection", async (t) => {
  const home = await tempHome("odai-writer-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = { home, port: 43001, routes: [{ forms: ["anthropic"], localPrefix: "/v1" }] };
  const settingsPath = claudeCodeSettingsPath(home);

  // 预览①：文件不存在——exists:false，不写盘
  const p1 = await previewClaudeCodeWriter(target);
  assert.equal(p1.exists, false);
  assert.equal(p1.baseUrl, "http://127.0.0.1:43001");
  assert.match(p1.after, /"ANTHROPIC_BASE_URL": "http:\/\/127\.0\.0\.1:43001"/);
  assert.match(p1.after, new RegExp(`"ANTHROPIC_AUTH_TOKEN": "${CLAUDE_CODE_PLACEHOLDER_TOKEN}"`));
  assert.ok(p1.diff.includes("+++ ") && p1.diff.includes("+  \"env\": {"), "unified diff 含新增行");
  assert.equal(p1.tokenSha256, sha256Hex(p1.diff));
  await assert.rejects(() => stat(settingsPath), (e) => e.code === "ENOENT", "preview 零写盘");

  // 令牌不符 → 拒绝（零字节写入）
  await assert.rejects(() => applyClaudeCodeWriter(target, "deadbeef"), (e) => e instanceof WriterError && e.code === "stale_preview");
  await assert.rejects(() => stat(settingsPath), (e) => e.code === "ENOENT");

  // apply①：正确令牌 → 落盘 0600，内容=after
  const applied = await applyClaudeCodeWriter(target, p1.tokenSha256);
  assert.equal(applied.path, settingsPath);
  const mode = (await stat(settingsPath)).mode & 0o777;
  assert.equal(mode, 0o600, "settings.json 0600（私有文件纪律）");
  assert.equal(await readFile(settingsPath, "utf8"), p1.after);

  // 幂等视图：再预览=无 diff（空 diff 令牌=sha256("")）
  const p2 = await previewClaudeCodeWriter(target);
  assert.equal(p2.exists, true);
  assert.equal(p2.diff, "");
  assert.equal(p2.tokenSha256, sha256Hex(""));

  // 预览后盘面被外部改动 → 旧令牌 stale 拒绝；内容保持外部版本
  const external = `${JSON.stringify({ env: { SOMETHING: "changed" } }, null, 2)}\n`;
  await writeFile(settingsPath, external, "utf8");
  await assert.rejects(() => applyClaudeCodeWriter(target, p2.tokenSha256), (e) => e.code === "stale_preview");
  assert.equal(await readFile(settingsPath, "utf8"), external, "stale 拒绝零写入");
});

// ---------------------------------------------------------------------------
// runtime/mgmt 接线（隔离 writerHome——绝不触真实 ~/.claude）
// ---------------------------------------------------------------------------

/** 最小 fabric 注入面（写手路径不触 fabric——恒不可达也不影响本测）。 */
const inertFabric = {
  fetchHttpImpl: async () => {
    throw new Error("fabric not exercised by writer tests");
  },
  sessionResolver: async () => null,
};

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

/** 预置消费姿态：钥环（含 anthropic 路由服务）+ 端点账本 + 活跃 listener。 */
async function runtimeWithEndpoint(t) {
  const home = await tempHome("odai-writer-rt-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const writerHome = await tempHome("odai-writer-home-");
  t.after(() => rm(writerHome, { recursive: true, force: true }));
  const aiDir = aiDataDir(home);
  await mkdir(aiDir, { recursive: true, mode: 0o700 });
  const peer = "ab".repeat(32);
  await writeFile(
    path.join(aiDir, "keyring.json"),
    JSON.stringify({
      v: 1,
      providers: [
        {
          endpointId: peer,
          alias: "mini-provider",
          relayUrls: [],
          keys: [{ keyId: "k1111111", key: "sk-aifly-REAL-KEY-MATERIAL-never-in-settings", group: "family" }],
          services: [
            {
              serviceId: "svc-anthropic",
              name: "claude",
              defaultPort: 4301,
              detail: { routes: [{ forms: ["anthropic"], localPrefix: "/v1", upstreamPrefix: "/v1" }] },
            },
          ],
        },
      ],
    }, null, 2),
    "utf8",
  );
  const rt = await createAiRuntime({
    home,
    fabric: inertFabric,
    writerHome,
    now: () => Date.now(),
    log: () => {},
  });
  await rt.start();
  t.after(() => rt.stop());
  // 起一个真实本地端点（listener 活跃——写手要求端口可用）
  const port = await freePort();
  const epResp = await rt.mgmt.handle("POST", "/consumer/endpoints", new URLSearchParams(), {
    providerEndpointId: peer,
    serviceId: "svc-anthropic",
    port,
  });
  assert.equal(epResp?.status, 200, JSON.stringify(epResp?.body));
  const endpoint = /** @type {any} */ (/** @type {any} */ (epResp).body).endpoint;
  return { rt, writerHome, endpointId: endpoint.id, port: endpoint.port };
}

test("mgmt writer endpoints: preview → apply over HTTP face; placeholder discipline; not-listening 409", async (t) => {
  const { rt, writerHome, endpointId, port } = await runtimeWithEndpoint(t);

  // preview：隔离 writerHome 下无既有文件 → exists:false + diff + 令牌
  const pv = await rt.mgmt.handle("POST", "/consumer/writer/preview", new URLSearchParams(), { endpointId });
  assert.equal(pv?.status, 200, JSON.stringify(pv?.body));
  const preview = /** @type {any} */ (pv?.body);
  assert.equal(preview.agent, "claude-code");
  assert.equal(preview.endpointId, endpointId);
  assert.equal(preview.baseUrl, `http://127.0.0.1:${port}`, "anthropic 路由剥 /v1 → 裸本地 base");
  assert.match(preview.after, /"ANTHROPIC_AUTH_TOKEN": "sk-aifly-local"/);
  assert.ok(preview.tokenSha256.length === 64);

  // 未知端点 → 404
  const nf = await rt.mgmt.handle("POST", "/consumer/writer/preview", new URLSearchParams(), { endpointId: "nope" });
  assert.equal(nf?.status, 404);

  // apply 令牌错误 → 409 stale-preview；零写入
  const bad = await rt.mgmt.handle("POST", "/consumer/writer/apply", new URLSearchParams(), { endpointId, tokenSha256: "0".repeat(64) });
  assert.equal(bad?.status, 409);
  assert.equal(/** @type {any} */ (bad?.body).error.code, "stale-preview");
  await assert.rejects(() => stat(claudeCodeSettingsPath(writerHome)), (e) => e.code === "ENOENT");

  // apply 正确 → 落盘（隔离 home 内）；**真实钥环密钥材料绝不出现在产物**
  const ok = await rt.mgmt.handle("POST", "/consumer/writer/apply", new URLSearchParams(), { endpointId, tokenSha256: preview.tokenSha256 });
  assert.equal(ok?.status, 200, JSON.stringify(ok?.body));
  const written = await readFile(claudeCodeSettingsPath(writerHome), "utf8");
  assert.ok(!written.includes("sk-aifly-REAL-KEY-MATERIAL"), "占位符纪律：真实凭证不落 settings.json");
  assert.match(written, /"ANTHROPIC_AUTH_TOKEN": "sk-aifly-local"/);

  // 端点不在监听（账本保留、listener 全关——写进配置的端口必须真实可用）→ 409
  await rt.stop();
  const stopped = await rt.mgmt.handle("POST", "/consumer/writer/preview", new URLSearchParams(), { endpointId });
  assert.equal(stopped?.status, 409, JSON.stringify(stopped?.body));

  // 端点从账本移除 → 404
  const del = await rt.mgmt.handle("DELETE", `/consumer/endpoints/${endpointId}`, new URLSearchParams(), undefined);
  assert.equal(del?.status, 200, JSON.stringify(del?.body));
  const removed = await rt.mgmt.handle("POST", "/consumer/writer/preview", new URLSearchParams(), { endpointId });
  assert.equal(removed?.status, 404, JSON.stringify(removed?.body));
});
