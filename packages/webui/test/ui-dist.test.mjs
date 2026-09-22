// 构建冒烟 + sidecar 静态面集成（webui-console A.11）：dist/index.html 存在；
// sidecar（默认 distDir）ready 态 GET / 返回 200 且含应用根节点标记（真实
// UI 替代占位降级页）；index.html 引用的每个 assets/* 均可取回。
// dist 是提交入库的发布产物（design §1 冻结）——本测试即「产物在库」门禁。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSidecar } from "../src/sidecar.mjs";
import { fakeUpstream, request } from "./helpers.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(PKG_ROOT, "dist");

test("build smoke: dist committed and sidecar serves the real SPA (not the placeholder)", async (t) => {
  assert.ok(
    existsSync(path.join(DIST, "index.html")),
    "dist/index.html missing - run `npm run build` (dist is a committed release artifact)",
  );
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  t.after(() => upstream.close());
  // 不注入 distDir → 默认指向包内真实 dist/（ready 态业务面照常）
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
    token: "smoke-token",
  });
  t.after(() => sc.close());

  const root = await request(sc.port, { path: "/" });
  assert.equal(root.status, 200);
  assert.match(root.headers["content-type"], /^text\/html/);
  assert.match(root.text, /id="app"/, "app root mount node present");
  assert.ok(!root.text.includes("UI is not built"), "placeholder degradation must not trigger when dist exists");
  // SPA fallback：任意深路径同页（hash 路由）
  const deep = await request(sc.port, { path: "/connections" });
  assert.match(deep.text, /id="app"/);

  // index.html 引用的每个 hashed 资产均可 200 取回（JS/CSS）
  const refs = [...root.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.some((r) => r.endsWith(".js")), "at least one JS asset referenced");
  assert.ok(refs.some((r) => r.endsWith(".css")), "at least one CSS asset referenced");
  for (const ref of refs) {
    const asset = await request(sc.port, { path: ref });
    assert.equal(asset.status, 200, ref);
    assert.notEqual(asset.headers["content-type"], "application/octet-stream", `mime for ${ref}`);
  }

  // ready 态业务面与静态面共存：/api/status 仍走代理
  const biz = await request(sc.port, { path: "/api/status" });
  assert.equal(biz.status, 200);
});
