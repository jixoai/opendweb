// 17 预设逐项冒烟（ai-subscription-sharing Phase D / tasks D3）。
// 逐项断言（全部离线——buildUpstreamRequest 纯构造 + fake 密钥源，零网络）：
// 1. presetToServiceInput 展开正确：upstream/defaultPort/keyEnv 提示保留/路由
//    白名单随预设携带。
// 2. 路由白名单：声明的 prefix 路径可构造（映射到 upstreamPrefix）；白名单外
//    路径（/user 个人信息端点形态）拒绝；无路由预设不设白名单。
// 3. auth 绑定后请求头集正确（Bearer secret 值——经同一 ① auth 槽）。
// 4. codex 占位：requires:"ai-codex-oauth" 呈现（curated 列表可见）且 disabled
//    不可展开（presetToServiceInput 拒绝；loadActivatablePresets 排除）。
// 5. keyEnv 未绑定 secret 不可启用（激活门逐预设拒绝）；绑定后可启用；
//    无 keyEnv 本地族（ollama/lmstudio）免绑即可启用。
// 另含 auth 三族解析矩阵（secret/script/literal[含 $secret: 间接]/bearer:false）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import {
  loadActivatablePresets,
  loadCuratedPresets,
  presetToServiceInput,
} from "../src/presets/models-dev.mjs";
import { buildUpstreamRequest, PathNotOfferedError, SecretMissingError } from "../src/provider/rewrite.mjs";
import { ProviderStore, StoreError, routeLocalPrefix } from "../src/provider/store.mjs";

/** 白名单外个人信息端点形态路径。 */
const NOT_OFFERED_PATH = "/user";

test("presets smoke: all 17 activatable presets expand, whitelist, and carry auth", async (t) => {
  const presets = loadActivatablePresets();
  assert.equal(presets.length, 17, "17 项可启用预设（codex 占位不计）");

  for (const preset of presets) {
    const input = presetToServiceInput(preset);
    // ① 展开正确
    assert.equal(input.upstream, preset.baseUrl, `${preset.id}: upstream=baseUrl`);
    assert.equal(input.defaultPort, preset.defaultPort, `${preset.id}: defaultPort`);
    assert.equal(input.name, preset.id, `${preset.id}: name=id`);
    if (preset.keyEnv !== undefined) {
      assert.equal(input.keyEnv, preset.keyEnv, `${preset.id}: keyEnv 提示保留`);
    } else {
      assert.equal(input.keyEnv, undefined, `${preset.id}: 无 keyEnv 不虚构`);
    }
    if (preset.routes !== undefined) {
      assert.equal(input.routes?.length, preset.routes.length, `${preset.id}: 路由白名单随预设携带`);
    }

    // 绑定 secret 后的请求头集（同一 ① auth 槽——Bearer 形态）
    const secretName = `${preset.id}-main`;
    const secretValue = `sk-fake-${preset.id}-value`;
    const bound = { ...input, auth: { secret: secretName } };
    const secrets = (name) => (name === secretName ? secretValue : undefined);

    // ② 路由白名单逐条 + 白名单外拒绝
    if (preset.routes !== undefined && preset.routes.length > 0) {
      for (const route of preset.routes) {
        if ((route.mode ?? "prefix") !== "prefix") continue;
        const local = routeLocalPrefix(route);
        const plan = await buildUpstreamRequest(bound, { method: "GET", path: `${local}/models` }, secrets);
        const expectedUp = `${preset.baseUrl.replace(/\/$/, "")}${(route.upstreamPrefix ?? "").replace(/\/$/, "")}/models`;
        assert.equal(plan.url.toString(), expectedUp, `${preset.id}: ${local}/models → ${expectedUp}`);
        assert.equal(plan.headers["authorization"], `Bearer ${secretValue}`, `${preset.id}: Bearer secret 注入`);
      }
      await assert.rejects(
        () => buildUpstreamRequest(bound, { method: "GET", path: NOT_OFFERED_PATH }, secrets),
        (e) => e instanceof PathNotOfferedError,
        `${preset.id}: 白名单外 ${NOT_OFFERED_PATH} 拒绝`,
      );
    } else {
      // 无路由预设：任意路径映射（裸透传）
      const plan = await buildUpstreamRequest(bound, { method: "GET", path: "/v1/models" }, secrets);
      assert.equal(plan.url.toString(), `${preset.baseUrl.replace(/\/$/, "")}/v1/models`, `${preset.id}: 无路由裸透传`);
      assert.equal(plan.headers["authorization"], `Bearer ${secretValue}`, `${preset.id}: Bearer secret 注入`);
    }
  }
});

test("presets smoke: codex placeholder is presented but not expandable", () => {
  const curated = loadCuratedPresets();
  const codex = curated.find((p) => p.id === "codex");
  assert.ok(codex !== undefined, "curated 列表呈现 codex 占位");
  assert.equal(codex.requires, "ai-codex-oauth", "承接 change 名冻结");
  assert.equal(codex.disabled, true);
  assert.ok(!loadActivatablePresets().some((p) => p.id === "codex"), "可启用清单排除 codex");
  assert.throws(() => presetToServiceInput(codex), /ai-codex-oauth/, "disabled 预设不可展开");
});

test("presets smoke: keyEnv gate per preset (unbound rejected; bound enabled; local family free)", async (t) => {
  const home = await tempHome("odai-preset-gate-");
  t.after(() => rm(home, { recursive: true, force: true }));
  /** @type {(over?: { secrets?: Record<string,string> }) => Promise<ProviderStore>} */
  const openStore = async (over = {}) =>
    ProviderStore.open(aiDataDir(home), {
      env: () => undefined,
      secretsSource: (name) => over.secrets?.[name] !== undefined,
    });

  for (const preset of loadActivatablePresets()) {
    const input = presetToServiceInput(preset);
    if (preset.keyEnv === undefined) {
      // 本地族（ollama/lmstudio）：无 keyEnv——免绑即可启用
      const store = await openStore();
      const svc = await store.addService(input);
      assert.equal(svc.enabled, true, `${preset.id}: 本地族免绑启用`);
      continue;
    }
    // 未绑定 secret：激活门拒绝
    const bare = await openStore();
    await assert.rejects(
      () => bare.addService(input),
      (e) => e instanceof StoreError && /bind its credential via the \{secret/.test(e.message),
      `${preset.id}: keyEnv 未绑定不可启用`,
    );
    // 绑定 secret（在库）：可启用
    const boundStore = await openStore({ secrets: { [`${preset.id}-main`]: "sk-bound" } });
    const ok = await boundStore.addService({ ...input, auth: { secret: `${preset.id}-main` } });
    assert.equal(ok.enabled, true, `${preset.id}: 绑定后启用`);
  }
});

test("auth three-family resolution matrix (secret / script / literal / bearer off)", async () => {
  const preset = loadActivatablePresets().find((p) => p.id === "openai");
  assert.ok(preset !== undefined);
  const base = presetToServiceInput(preset);
  const secrets = (name) => (name === "in-store" ? "sk-store-value" : undefined);
  const req = { method: "GET", path: "/v1/models" };

  // ① secret 族：密钥库原样值 + Bearer 前缀
  const secretPlan = await buildUpstreamRequest({ ...base, auth: { secret: "in-store" } }, req, secrets);
  assert.equal(secretPlan.headers["authorization"], "Bearer sk-store-value");

  // secret 缺失 → secret_missing（不回退空值）
  await assert.rejects(
    () => buildUpstreamRequest({ ...base, auth: { secret: "gone" } }, req, secrets),
    (e) => e instanceof SecretMissingError,
  );

  // ② script 族：内建 secret hook（args.name 指定密钥——进程内 hook 管线）
  const scriptPlan = await buildUpstreamRequest({ ...base, auth: { script: "secret", args: { name: "in-store" } } }, req, secrets);
  assert.equal(scriptPlan.headers["authorization"], "Bearer sk-store-value");

  // ③ literal 族：$secret: 间接引用解析
  const refPlan = await buildUpstreamRequest({ ...base, auth: { literal: "$secret:in-store" } }, req, secrets);
  assert.equal(refPlan.headers["authorization"], "Bearer sk-store-value");

  // literal 裸字面量：原样 + bearer:false 不拼前缀
  const rawPlan = await buildUpstreamRequest({ ...base, auth: { literal: "tok-raw", bearer: false } }, req, secrets);
  assert.equal(rawPlan.headers["authorization"], "tok-raw");
});
