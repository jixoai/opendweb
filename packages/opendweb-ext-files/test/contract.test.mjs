// 契约测试：descriptor 必须过 webui 契约权威校验器（contract.mjs——Phase 0 冻结）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { filesDescriptor } from "../src/plugin.mjs";
// 契约权威源（webui 包，跨包相对 import——本包零依赖，测试期借用权威校验器）
import { validateWebuiPluginDescriptor, WEBUI_PLUGIN_API } from "../../webui/src/core/plugins/contract.mjs";

test("descriptor passes the authoritative webui plugin contract validator", () => {
  const v = validateWebuiPluginDescriptor(filesDescriptor());
  assert.equal(v.ok, true, v.ok ? "" : v.error);
});

test("descriptor shape: webuiApi 1, id files, page browser (typed page, tools nav)", () => {
  const d = filesDescriptor();
  assert.equal(d.webuiApi, WEBUI_PLUGIN_API);
  assert.equal(d.id, "files");
  assert.equal(d.pages.length, 1);
  const page = d.pages[0];
  assert.equal(page.id, "browser");
  assert.equal(page.type, "page"); // 专属 Svelte 组件（FileBrowserPage——宿主编译期绑定）
  assert.equal(page.nav, "tools");
  assert.equal(page.perspective, "both"); // B 机成员姿态可达（浏览远端共享——见接线清单偏差说明）
  assert.equal(page.icon, "folder");
  assert.equal(page.component, undefined); // descriptor 不承载可调用物——宿主绑定
});

test("descriptor declares the versioned wire endpoint", () => {
  const d = filesDescriptor();
  assert.deepEqual(d.dataEndpoints, [{ id: "wire", path: "/wpk1/files/" }]);
});

test("descriptor factory returns fresh objects (no shared mutable state)", () => {
  const a = filesDescriptor();
  const b = filesDescriptor();
  assert.notEqual(a, b);
  assert.notEqual(a.pages[0], b.pages[0]);
  a.pages[0].title = "mutated";
  assert.equal(filesDescriptor().pages[0].title, "文件浏览");
});
