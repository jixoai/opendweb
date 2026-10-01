// codex 实现终审 r1 修复回归（store 面——P1-7 公开 data/save 绕过激活门）：
// 唯一落盘写入口 save() 对相对上次落盘基线「将启用」（新增启用/停用→启用翻转）
// 的服务重跑 assertServiceActivatable：
// - 直接 `store.data.services[i].enabled = true; await store.save()` 绕过探针→拒绝
//   （fail-closed 零写入：盘上仍停用、revision 不变）；
// - 直接向 data 塞入带 keyEnv 的启用服务+save→拒绝；
// - 已启用存量不重判（secret 事后移除不毒化无关写路径/不阻碍停用——启用时点
//   已过门）；
// - 高层 setServiceEnabled(true) 正常过门（绑定 secret 在库时放行）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { ProviderStore, StoreError } from "../src/provider/store.mjs";

const SERVICE_INPUT = (over = {}) => ({
  name: "openai",
  upstream: "https://api.openai.com",
  match: [{ type: "suffix", value: ".openai.com" }],
  defaultPort: 4300,
  keyEnv: "ZZ_PROBE_ENV",
  ...over,
});

test("P1-7: 直接 data+save 绕过激活门→拒绝（ambient env 命中；fail-closed 零写入）", async (t) => {
  const home = await tempHome("odai-storefix-bypass-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = (name) => (name === "ZZ_PROBE_ENV" ? "sk-ambient" : undefined);
  const store = await ProviderStore.open(aiDataDir(home), { env, secretsSource: () => true });
  // 停用态加入（激活门跳过 disabled——合法）
  const svc = await store.addService({ ...SERVICE_INPUT(), enabled: false, auth: { secret: "probe-secret" } });
  assert.equal(svc.enabled, false);
  const revBefore = store.revision;
  // 绕过探针：直接改 data+save（终审 r1 复现路径）
  store.data.services[0].enabled = true;
  await assert.rejects(
    () => store.save(),
    (e) => e instanceof StoreError && e.code === "conflict" && /ambient environment variable 'ZZ_PROBE_ENV'/.test(e.message),
  );
  // fail-closed 零写入：盘上仍停用、revision 未动
  store.data.services[0].enabled = false; // 内存复位（盘从未写过启用态）
  assert.equal(store.revision, revBefore, "拒绝路径不落盘（revision 不变）");
  const onDisk = JSON.parse(await readFile(`${aiDataDir(home)}/services.json`, "utf8"));
  assert.equal(onDisk.services[0].enabled, false, "盘上仍停用");
  // 重开（干净 env）：数据一致
  const reopened = await ProviderStore.open(aiDataDir(home), { env: () => undefined, secretsSource: () => true });
  assert.equal(reopened.getService(svc.serviceId).enabled, false);
});

test("P1-7: 绕过探针——未绑定 secret 的停用服务直接启用+save→拒绝（missing/unbound）", async (t) => {
  const home = await tempHome("odai-storefix-bypass2-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await ProviderStore.open(aiDataDir(home), { env: () => undefined, secretsSource: () => false });
  const svc = await store.addService({ ...SERVICE_INPUT(), enabled: false }); // 未绑定 auth
  store.data.services[0].enabled = true;
  await assert.rejects(
    () => store.save(),
    (e) => e instanceof StoreError && e.code === "invalid" && /bind its credential via the \{secret/.test(e.message),
  );
  // 直接塞入带 keyEnv 的启用服务（无任何高层门）→同样拒绝
  store.data.services[0].enabled = false;
  store.data.services.push({ ...SERVICE_INPUT(), name: "injected", serviceId: "injected1", enabled: true });
  await assert.rejects(
    () => store.save(),
    (e) => e instanceof StoreError && e.code === "invalid",
  );
  store.data.services.pop();
  // 对照：绑定在库 secret 后，高层 setServiceEnabled(true) 放行
  const bound = await ProviderStore.open(aiDataDir(home), {
    env: () => undefined,
    secretsSource: (n) => n === "probe-secret",
  });
  await bound.setServiceAuth(svc.serviceId, { secret: "probe-secret" });
  const r = await bound.setServiceEnabled(svc.serviceId, true);
  assert.deepEqual(r, { changed: true });
  assert.equal(bound.getService(svc.serviceId).enabled, true);
});

test("P1-7: 已启用存量不重判——secret 事后移除不毒化无关写路径/不阻碍停用", async (t) => {
  const home = await tempHome("odai-storefix-nopoison-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const secretsOnDisk = new Set(["probe-secret"]);
  const store = await ProviderStore.open(aiDataDir(home), {
    env: () => undefined,
    secretsSource: (n) => secretsOnDisk.has(n),
  });
  const svc = await store.addService({ ...SERVICE_INPUT(), auth: { secret: "probe-secret" } });
  assert.equal(svc.enabled, true, "绑定在库——启用放行");
  // secret 事后从库移除（现实操作：DELETE /secrets）
  secretsOnDisk.delete("probe-secret");
  // 无关写路径（别名）不被毒化
  await store.setAlias("still-alive");
  // 停用方向不被阻（否则死锁：无法自救）
  const r = await store.setServiceEnabled(svc.serviceId, false);
  assert.deepEqual(r, { changed: true });
  // 重新启用（secret 仍缺）→ 拒绝（将启用=过门）
  await assert.rejects(
    () => store.setServiceEnabled(svc.serviceId, true),
    (e) => e instanceof StoreError && e.details?.gate === "missing-secret",
  );
});
