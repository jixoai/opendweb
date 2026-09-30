// 插件宿主直测（webui-plugin-kernel Phase 0 / specs/webui delta「插件启停生命
// 周期（drain 与摘牌）」+「安装与运行双账本分离」）。
// 覆盖：
// 1. 契约校验：webuiApi 1 字段集冻结（未知字段拒绝/枚举校验/重复页 id/configSchema
//    子集）；validatePluginConfig（未知键/类型精确/required）；
// 2. 生命周期状态机：registered→enabled、enabled⇄disabled 往返；幂等规则；
//    disable(registered)=invalid-transition；未知 id=unknown-plugin；并发互斥 busy；
// 3. 停用顺序：摘牌（disable 途中 beginActivity 立即稳定拒绝）→ drain 收敛 →
//    dispose（一次）→ 落盘；drain 超时强制 cancel 且不挂死停用收尾；
// 4. 双账本：state.json（0600/形状/重启恢复/配置持久化/registered 不落盘歧义）
//    与安装账本 plugins.json 零接触（字节不变）；
// 5. 数据目录惰性：构造零落盘；enable 创建 0700 目录；未启用插件无目录；
// 6. 运行时钩子通道（runtimes——onEnable/onDispose 生命周期与顺序）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validatePluginConfig, validateWebuiPluginDescriptor } from "../src/core/plugins/contract.mjs";
import { assertDescriptorsValid, builtinWebuiPluginDescriptors } from "../src/core/plugins/registry.mjs";
import { createPluginHost } from "../src/core/plugins/host.mjs";
import { pluginStatePath } from "../src/core/plugins/state.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 最小合法 descriptor（契约测试的基准形态）。 */
function sampleDescriptor(overrides = {}) {
  return {
    id: "sample",
    webuiApi: 1,
    pages: [{ id: "home", title: "样例页", nav: "tools", icon: "puzzle", type: "settings", perspective: "both" }],
    configSchema: { type: "object", properties: {}, required: [] },
    ...overrides,
  };
}

/** 带配置面的 descriptor（config 校验/配置 UI 机制的面）。 */
function configurableDescriptor() {
  return sampleDescriptor({
    id: "cfg",
    configSchema: {
      type: "object",
      properties: { label: { type: "string" }, limit: { type: "number" }, verbose: { type: "boolean" } },
      required: ["label"],
    },
  });
}

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "wpk-host-"));
}

// ---- 契约：descriptor 校验（webuiApi 1 字段集冻结） --------------------------------

test("contract: builtin descriptors pass validation and registry self-check", () => {
  const descriptors = builtinWebuiPluginDescriptors();
  assert.deepEqual(descriptors.map((d) => d.id), ["ports", "files", "sync"]);
  assert.equal(assertDescriptorsValid(descriptors).ok, true);
  for (const d of descriptors) {
    const v = validateWebuiPluginDescriptor(d);
    assert.ok(v.ok, `${d.id}: ${v.ok ? "" : v.error}`);
  }
});

test("contract: field set is frozen — unknown descriptor/page fields rejected", () => {
  assert.equal(validateWebuiPluginDescriptor({ ...sampleDescriptor(), extra: 1 }).ok, false);
  assert.equal(validateWebuiPluginDescriptor({ ...sampleDescriptor(), title: "x" }).ok, false);
  const badPage = sampleDescriptor({ pages: [{ id: "home", title: "t", type: "settings", perspective: "both", bogus: true }] });
  assert.equal(validateWebuiPluginDescriptor(badPage).ok, false);
});

test("contract: id/webuiApi/pages/perspective/type validations", () => {
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ id: "Bad" })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ id: "1x" })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ webuiApi: 2 })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ pages: [] })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ pages: [{ id: "home", type: "settings", perspective: "nope" }] })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ pages: [{ id: "home", type: "widget", perspective: "both" }] })).ok, false);
  const dupPages = sampleDescriptor({ pages: [
    { id: "home", title: "a", type: "settings", perspective: "both" },
    { id: "home", title: "b", type: "settings", perspective: "both" },
  ] });
  assert.equal(validateWebuiPluginDescriptor(dupPages).ok, false);
});

test("contract: configSchema subset and dataEndpoints shape", () => {
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ configSchema: { type: "array", properties: {} } })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ configSchema: { type: "object", properties: { a: { type: "blob" } } } })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ configSchema: { type: "object", properties: {}, bogus: 1 } })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ configSchema: { type: "object", properties: {}, required: ["missing"] } })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ dataEndpoints: [{ id: "ok", path: "/wpk1" }] })).ok, true);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ dataEndpoints: [{ id: "bad", path: "no-slash" }] })).ok, false);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ routes: [{ id: "r1" }] })).ok, true);
  // 组件位：对象/函数/null 允许、标量拒绝（宿主编译期绑定，非 wire 契约）
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ pages: [{ id: "home", title: "t", type: "page", perspective: "both", component: () => {} }] })).ok, true);
  assert.equal(validateWebuiPluginDescriptor(sampleDescriptor({ pages: [{ id: "home", title: "t", type: "page", perspective: "both", component: "component-x" }] })).ok, false);
});

test("contract: validatePluginConfig — types exact, unknown keys and missing required rejected", () => {
  const schema = configurableDescriptor().configSchema;
  assert.deepEqual(validatePluginConfig(schema, { label: "a", limit: 5, verbose: false }).value, { label: "a", limit: 5, verbose: false });
  assert.equal(validatePluginConfig(schema, { label: "a", unknown: 1 }).ok, false);
  assert.equal(validatePluginConfig(schema, { label: "a", limit: "5" }).ok, false, "number 不接受数字字符串");
  assert.equal(validatePluginConfig(schema, { label: "a", verbose: "true" }).ok, false);
  assert.equal(validatePluginConfig(schema, { limit: 1 }).ok, false, "缺 required label");
  assert.equal(validatePluginConfig(schema, null).ok, false);
  assert.equal(validatePluginConfig(schema, [1]).ok, false);
});

// ---- 生命周期状态机 ---------------------------------------------------------------

test("lifecycle: transitions and idempotency (explicit)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createPluginHost({ home });
  t.after(() => host.close());

  // disable(registered) = invalid-transition（从未启用，无可 drain）
  const early = await host.disable("files");
  assert.equal(early.ok, false);
  assert.equal(early.code, "invalid-transition");
  // registered → enabled
  const e1 = await host.enable("files");
  assert.equal(e1.ok, true);
  assert.equal(e1.plugin.status, "enabled");
  // enable(enabled) 幂等成功
  const e2 = await host.enable("files");
  assert.equal(e2.ok, true);
  assert.equal(e2.plugin.status, "enabled");
  // enabled → disabled（无在途：立即 drain 完成）
  const d1 = await host.disable("files");
  assert.equal(d1.ok, true);
  assert.equal(d1.plugin.status, "disabled");
  assert.equal(d1.drained, true);
  assert.equal(d1.timedOut, false);
  // disable(disabled) 幂等成功
  const d2 = await host.disable("files");
  assert.equal(d2.ok, true);
  // disabled → enabled（往返闭合）
  const e3 = await host.enable("files");
  assert.equal(e3.ok, true);
  assert.equal(e3.plugin.status, "enabled");
  // 未知 id
  assert.equal((await host.enable("nope")).code, "unknown-plugin");
  assert.equal((await host.disable("nope")).code, "unknown-plugin");
  assert.equal(host.get("nope"), null);
});

test("lifecycle: enable rejects invalid injected descriptors (fail-fast)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(() => createPluginHost({ home, descriptors: [sampleDescriptor({ webuiApi: 2 })] }), /webuiApi/);
  await assert.rejects(() => createPluginHost({ home, descriptors: [sampleDescriptor(), sampleDescriptor()] }), /duplicate/);
});

// ---- 停用顺序：摘牌 → drain → dispose → 落盘 ---------------------------------------

test("disable order: reject new activities the moment disable starts (摘牌先行)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createPluginHost({ home, drainTimeoutMs: 5_000 });
  t.after(() => host.close());
  await host.enable("ports");

  // 在途活动：永不自行结束（cancel 才释放）
  let cancelled = 0;
  const act = host.beginActivity("ports", { cancel: () => { cancelled += 1; } });
  assert.equal(act.ok, true);

  const disabling = host.disable("ports");
  await delay(30); // disable 已摘牌但仍在 drain
  assert.equal(host.isAccepting("ports"), false, "摘牌后新请求必须立即可拒");
  const rejected = host.beginActivity("ports", { cancel: () => {} });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "plugin-disabled", "稳定拒绝码（不 500/不挂起）");
  // 未启用插件同样稳定拒绝
  assert.equal(host.beginActivity("files", { cancel: () => {} }).code, "plugin-disabled");
  assert.equal(host.beginActivity("ghost", { cancel: () => {} }).code, "unknown-plugin");

  const r = await disabling;
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, true, "挂死活动触发超时");
  assert.equal(cancelled, 1, "超时后强制 cancel 恰一次");
  assert.equal(r.plugin.status, "disabled");
});

test("drain: in-flight activity completes within timeout — no forced cancel", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createPluginHost({ home, drainTimeoutMs: 5_000 });
  t.after(() => host.close());
  await host.enable("ports");

  let cancelled = 0;
  const act = host.beginActivity("ports", {
    cancel: () => {
      cancelled += 1;
    },
  });
  assert.equal(act.ok, true);
  setTimeout(() => act.end(), 80); // 在途 80ms 后自然收敛

  const r = await host.disable("ports");
  assert.equal(r.ok, true);
  assert.equal(r.drained, true, "drain 等到了在途收敛");
  assert.equal(r.timedOut, false);
  assert.equal(cancelled, 0, "未超时不得强制取消");
});

test("drain timeout: force cancel frees the disable call itself (bounded teardown)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  // 50ms drain 超时 + 250ms 取消宽限：disable 必须在有界时间内完成
  const host = await createPluginHost({ home, drainTimeoutMs: 50 });
  t.after(() => host.close());
  await host.enable("ports");

  const act = host.beginActivity("ports", { cancel: () => { /* 恶意：收到 cancel 也不 end */ } });
  assert.equal(act.ok, true);

  const startedAt = Date.now();
  const r = await host.disable("ports");
  const elapsed = Date.now() - startedAt;
  assert.equal(r.ok, true, "强制取消后停用收尾不被挂死句柄阻塞");
  assert.equal(r.timedOut, true);
  assert.equal(r.drained, false);
  assert.ok(elapsed < 2_000, `disable 有界完成（实测 ${elapsed}ms）`);
});

test("runtime hooks: onEnable/onDispose via the runtimes channel; dispose once per enable cycle", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const events = [];
  let releaseEnable;
  const gate = new Promise((resolve) => (releaseEnable = resolve));
  const host = await createPluginHost({
    home,
    descriptors: [sampleDescriptor()],
    runtimes: {
      sample: {
        onEnable: async (ctx) => {
          events.push(["enable", ctx.dataDir]);
          await gate; // 慢装配：互斥窗口
        },
        onDispose: async () => events.push(["dispose"]),
      },
    },
  });
  t.after(() => host.close());

  const enabling = host.enable("sample");
  await delay(20);
  // 慢 onEnable 装配中：同插件第二变更请求 busy 拒绝（互斥）
  assert.equal((await host.setConfig("sample", {})).code, "busy");
  releaseEnable();
  assert.equal((await enabling).ok, true);

  await host.disable("sample");
  await host.disable("sample"); // 幂等：不重放 dispose
  await host.enable("sample");
  await host.disable("sample");
  assert.deepEqual(
    events.map((e) => e[0]),
    ["enable", "dispose", "enable", "dispose"],
  );
  assert.equal(events[0][1], path.join(home, "plugins", "sample"), "onEnable 收到数据目录");
});

test("enable atomicity: onEnable failure rolls the ledger back and returns enable-failed (no split state)", async (t) => {
  // 真浏览器走查 P1（docs/walkthrough-vision-…md F2-v）：onEnable 抛错曾留下
  // ledger=enabled / 宿主=disabled 分裂态。回滚 + 结构化 enable-failed 后，
  // 账本与宿主状态一致停在转换前，可重试。
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  let failEnable = true;
  const host = await createPluginHost({
    home,
    descriptors: [sampleDescriptor()],
    runtimes: {
      sample: {
        onEnable: async () => {
          if (failEnable) throw new Error("boom: shares ledger corrupted");
        },
        onDispose: async () => {},
      },
    },
  });
  t.after(() => host.close());

  const bad = await host.enable("sample");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "enable-failed");
  assert.match(bad.message ?? "", /boom/);
  assert.equal(host.list().plugins.find((p) => p.id === "sample").status, "registered", "host status unchanged");
  const persisted = JSON.parse(await readFile(pluginStatePath(home), "utf8"));
  assert.equal(persisted.plugins.sample.status, "registered", "ledger rolled back to the pre-transition status");

  // 故障清除后同一入口可重试成功（可恢复性）
  failEnable = false;
  assert.equal((await host.enable("sample")).ok, true);
  // 已 enabled 后的失败重挂场景：disable 成功 → onEnable 再失败 → 回滚到 disabled
  assert.equal((await host.disable("sample")).ok, true);
  failEnable = true;
  const bad2 = await host.enable("sample");
  assert.equal(bad2.code, "enable-failed");
  assert.equal(host.list().plugins.find((p) => p.id === "sample").status, "disabled");
  const persisted2 = JSON.parse(await readFile(pluginStatePath(home), "utf8"));
  assert.equal(persisted2.plugins.sample.status, "disabled", "ledger rolled back to disabled");
});

// ---- 双账本：state.json 与安装账本分离 ---------------------------------------------

test("dual ledger: state.json 0600 atomic persistence + restart rebuild; plugins.json untouched", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  // 安装账本哨兵（CLI 包锁形状——本模块零读零写的对照物）
  const INSTALL_LEDGER = path.join(home, "plugins.json");
  const sentinel = JSON.stringify({ cf: { package: "@jixo/opendweb-ext-cf", version: "0.3.1" } }, null, 2) + "\n";
  await writeFile(INSTALL_LEDGER, sentinel, "utf8");

  // 构造零落盘（惰性）：state.json 不存在、plugins/ 目录不存在
  const host = await createPluginHost({ home });
  const initialEntries = await readdir(home);
  assert.deepEqual(initialEntries.sort(), ["plugins.json"], "构造期零落盘（state.json 惰性——首变更才写）");
  await host.close();

  // 启用 files → 停用 → 启用 sync：落盘反映
  const host2 = await createPluginHost({ home });
  await host2.enable("files");
  await host2.disable("files");
  await host2.enable("sync");
  await host2.close();

  const statePath = pluginStatePath(home);
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.version, 1);
  assert.equal(state.plugins.files.status, "disabled");
  assert.equal(state.plugins.sync.status, "enabled");
  assert.equal("ports" in state.plugins, false, "registered（从未变更）不落盘——三态无歧义");
  const st = await stat(statePath);
  assert.equal(st.mode & 0o777, 0o600, "0600（运行账本机密纪律同 leases/nodes）");

  // 安装账本零接触（字节不变——不读不写）
  assert.equal(await readFile(INSTALL_LEDGER, "utf8"), sentinel, "plugins.json（安装账本）零接触");
  // 运行账本在 plugins/ 子目录（不与安装账本混用/互不渗透）
  const pluginsDir = await readdir(path.join(home, "plugins"));
  assert.ok(pluginsDir.includes("state.json"));
  assert.ok(!pluginsDir.includes("plugins.json"), "两账本字段/文件互不渗透");

  // 重启恢复：按落盘状态重建（spec Scenario「安装与运行双账本分离」）
  const host3 = await createPluginHost({ home });
  assert.equal(host3.get("files").status, "disabled");
  assert.equal(host3.get("sync").status, "enabled");
  assert.equal(host3.get("ports").status, "registered");
  await host3.close();
  assert.equal(await readFile(INSTALL_LEDGER, "utf8"), sentinel, "重启后安装账本仍零接触");
});

test("dual ledger: corrupt state.json fails closed (no silent reset)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "plugins"), { recursive: true });
  await writeFile(pluginStatePath(home), "{not json", "utf8");
  await assert.rejects(() => createPluginHost({ home }), /malformed|invalid/);
});

// ---- 数据目录惰性 ------------------------------------------------------------------

test("data dir: lazy 0700 creation on enable only", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createPluginHost({ home });
  await host.enable("files");
  const dir = path.join(home, "plugins", "files");
  const st = await stat(dir);
  assert.ok(st.isDirectory());
  assert.equal(st.mode & 0o777, 0o700);
  // 未启用插件无数据目录；disable 后目录保留（插件数据不因停用销毁）
  await assert.rejects(() => stat(path.join(home, "plugins", "ports")));
  await host.disable("files");
  assert.equal((await stat(dir)).isDirectory(), true, "停用不删除插件数据目录");
  await host.close();
});

// ---- 配置面 ------------------------------------------------------------------------

test("config: validated against descriptor schema; status preserved for registered plugins", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createPluginHost({ home, descriptors: [configurableDescriptor()] });
  t.after(() => host.close());

  // registered 插件改配置：状态不漂移（registered 不被配置写侧写成 disabled）
  const c1 = await host.setConfig("cfg", { label: "初号机" });
  assert.equal(c1.ok, true);
  assert.deepEqual(c1.config, { label: "初号机" });
  assert.equal(host.get("cfg").status, "registered");

  const bad = await host.setConfig("cfg", { label: "x", limit: "5" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid-config");
  assert.match(bad.error, /limit/);
  assert.equal((await host.setConfig("cfg", { label: "x", rogue: 1 })).code, "invalid-config");
  assert.equal((await host.setConfig("ghost", {})).code, "unknown-plugin");
  assert.equal(host.getConfig("ghost"), null);

  // 持久化 + 重启恢复（同注册集重建——状态与配置都来自账本）
  await host.enable("cfg");
  await host.setConfig("cfg", { label: "贰号机", limit: 9 });
  const host2 = await createPluginHost({ home, descriptors: [configurableDescriptor()] });
  assert.deepEqual(host2.getConfig("cfg"), { label: "贰号机", limit: 9 });
  assert.equal(host2.get("cfg").status, "enabled");
  await host2.close();
});

// ---- F5（2026-09-30）：配置接线钩子 --------------------------------------------------

test("F5: onEnable receives current config; onConfigChange fires after setConfig persists (errors observed, not rolled back)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  /** @type {{ config: Record<string, string | number | boolean> | null }} */
  const seen = { config: null };
  /** @type {Array<Record<string, string | number | boolean>>} */
  const changes = [];
  /** @type {Array<[string, unknown]>} */
  const errors = [];
  const host = await createPluginHost({
    home,
    descriptors: [configurableDescriptor()],
    runtimes: {
      cfg: {
        onEnable: async (ctx) => {
          seen.config = ctx.config;
        },
        onConfigChange: async (values) => {
          if (values.label === "炸") throw new Error("apply failed");
          changes.push(values);
        },
      },
    },
  });
  t.after(() => host.close());
  const r0 = await host.setConfig("cfg", { label: "零号" });
  assert.equal(r0.ok, true);
  await host.enable("cfg");
  assert.deepEqual(seen.config, { label: "零号" }, "onEnable ctx 携带当前落盘配置");
  const r = await host.setConfig("cfg", { label: "壹号", limit: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(
    changes,
    [
      { label: "零号" }, // registered 期的配置写入同样通知（无消费方时 no-op）
      { label: "壹号", limit: 3 },
    ],
    "setConfig 持久化成功后通知运行时",
  );
  // 钩子抛错：配置不回滚、host 观测位收到错误
  host.onConfigChangeError = (id, e) => errors.push([id, e]);
  const r2 = await host.setConfig("cfg", { label: "炸" });
  assert.equal(r2.ok, true, "onConfigChange 抛错不回滚已落盘配置");
  assert.deepEqual(host.getConfig("cfg"), { label: "炸" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "cfg");
  await host.disable("cfg");
});
