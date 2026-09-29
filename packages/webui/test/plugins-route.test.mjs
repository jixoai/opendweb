// 插件路由接入协议直测（webui-plugin-kernel Phase 0 / specs/webui delta
// 「插件页路由接入（可达/深链/停用收敛）」Scenario 的纯函数面）。
// 覆盖（r2-B5 四场景 + 协议不变量）：
// 1. 注册表不变量：routeId 全局唯一、形如 #/p/<id>/<id>、与既有路由首段隔离；
// 2. 场景 A 启用可达：命中且（视角可见×服务端 enabled）→ plugin 视图；
// 3. 场景 B 深链刷新：canonicalHashFor(#/p/…)=null（零重写）+ routeFor 注册表
//    重放（纯函数可重入=整页刷新等价）；
// 4. 场景 C 停用后深链：pluginRouteDecision → converge #/overview（不残留死页）；
// 5. 场景 D 未知 #/p/ 收敛 + 既有路由行为零变化（#/overview|#/lease|#/visits|
//    #/online/旧路由收敛/member no-hub/setup 全屏——逐项对齐基线）；
// 6. 视角可见性过滤：admin/member/both 的 routeFor 与导航行；
// 7. SideNav 工具区行：受管插件须服务端 enabled（防死链弹跳）；加载中仅内建面。
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHashFor, routeFor } from "../ui/src/lib/route.ts";
import {
	PLUGIN_ROUTE_REGISTRY,
	findPluginRoute,
	pluginNavRows,
	pluginRouteDecision,
	visibleToRole,
} from "../ui/src/lib/plugin-registry.ts";

/** 服务端投影替身（status 按需）。 */
function pluginsData(statuses) {
	return {
		plugins: Object.entries(statuses).map(([id, status]) => ({
			id,
			webui_api: 1,
			status,
			pages: [],
			config_schema: { type: "object", properties: {}, required: [] },
			config: {},
		})),
		coming_soon: [{ id: "vpn" }],
		external_webui_plugins: { available: false, note: "" },
	};
}

const ALL_ENABLED = pluginsData({ ports: "enabled", files: "enabled", sync: "enabled", host: "enabled" });

// ---- 注册表不变量 -------------------------------------------------------------------

test("registry: routeIds unique, well-formed, isolated from the existing route space", () => {
	const ids = PLUGIN_ROUTE_REGISTRY.map((e) => e.routeId);
	assert.equal(new Set(ids).size, ids.length, "routeId 全局唯一");
	for (const id of ids) {
		assert.match(id, /^#\/p\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/, "routeId 形状 #/p/<pluginId>/<pageId>");
	}
	// 与既有路由空间隔离：既有首段无 p；注册表不含既有路由
	assert.ok(!["overview", "tenants", "visitors", "online", "lease", "visits", "owners", "access", "status", "connect", "connections"].includes("p"));
	assert.ok(ids.every((id) => !["#/overview", "#/tenants", "#/visitors", "#/online", "#/lease", "#/visits"].includes(id)));
	// 内建面与受管面标记
	const host = findPluginRoute("#/p/host/panel");
	assert.equal(host.managed, false, "宿主面板=内建管理面（不受生命周期门控）");
	assert.equal(findPluginRoute("#/p/files/browser").managed, true);
});

test("findPluginRoute: exact two-segment matching; malformed forms miss", () => {
	assert.notEqual(findPluginRoute("#/p/host/panel"), null);
	assert.notEqual(findPluginRoute("#/p/files/browser"), null);
	for (const h of ["#/p/host", "#/p/host/", "#/p/host/panel/extra", "#/p/Host/panel", "#/p/host/Panel", "#/p//panel", "#/p/host/pan el", "", "#/p/unknown/page", "#/overview"]) {
		assert.equal(findPluginRoute(h), null, `${JSON.stringify(h)} 必须 miss`);
	}
});

// ---- 场景 A：启用可达 ----------------------------------------------------------------

test("scenario A: enabled plugin page routes to the plugin view (admin)", () => {
	assert.deepEqual(routeFor("#/p/files/browser", "ready"), {
		view: "plugin",
		pluginId: "files",
		pageId: "browser",
		routeId: "#/p/files/browser",
	});
	assert.deepEqual(routeFor("#/p/host/panel", "ready", "member"), {
		view: "plugin",
		pluginId: "host",
		pageId: "panel",
		routeId: "#/p/host/panel",
	}, "host 面板 both 可见——member 深链直达（独立壳渲染）");
});

// ---- 场景 B：深链刷新 = 注册表重放 ---------------------------------------------------

test("scenario B: deep link survives refresh — canonical hash untouched, routeFor replays", () => {
	assert.equal(canonicalHashFor("#/p/files/browser"), null, "规范形态零重写（不闪跳）");
	assert.equal(canonicalHashFor("#/p/host/panel"), null);
	// 重放等价：同一 hash 两次求值一致（纯函数=刷新语义）
	assert.deepEqual(routeFor("#/p/files/browser", "ready"), routeFor("#/p/files/browser", "ready"));
	// 渲染裁决同样可重放
	assert.deepEqual(pluginRouteDecision("files", ALL_ENABLED), { action: "render" });
});

// ---- 场景 C：停用后深链 → 基线收敛 ---------------------------------------------------

test("scenario C: disabled or unknown-to-server plugin deep link converges to #/overview", () => {
	const disabled = pluginsData({ ports: "enabled", files: "disabled", sync: "enabled" });
	assert.deepEqual(pluginRouteDecision("files", disabled), { action: "converge", hash: "#/overview" }, "命中但 disabled → 收敛");
	assert.deepEqual(pluginRouteDecision("files", pluginsData({ ports: "enabled" })), { action: "converge", hash: "#/overview" }, "服务端注册表无此插件 → 收敛");
	assert.deepEqual(pluginRouteDecision("files", null), { action: "pending" }, "服务端状态未加载 → 等待（深链首拍不抢收敛）");
	assert.deepEqual(pluginRouteDecision("host", null), { action: "render" }, "内建面不受服务端门控");
	assert.deepEqual(pluginRouteDecision("files", ALL_ENABLED), { action: "render" });
});

// ---- 场景 D：未知 #/p/ 收敛 + 既有路由零变化 ------------------------------------------

test("scenario D: unknown #/p/* converges like unknown hashes; existing routes unchanged", () => {
	assert.deepEqual(routeFor("#/p/unknown/page", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/p/files", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/p/files/browser/x", "ready"), { view: "overview" });
	assert.equal(canonicalHashFor("#/p/unknown/page"), "#/overview", "未知 #/p/ 同既有未知 hash 收敛（301 式重写）");
	assert.equal(canonicalHashFor("#/p/files"), "#/overview");

	// 既有行为逐项对齐基线（零回归锚点——与 ui.test.mjs 同拍）
	assert.deepEqual(routeFor("#/overview", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/lease", "ready"), { view: "lease" });
	assert.deepEqual(routeFor("#/visits", "ready"), { view: "visits" });
	assert.deepEqual(routeFor("#/online", "ready"), { view: "online" });
	assert.deepEqual(routeFor("#/owners", "ready"), { view: "tenants" });
	assert.deepEqual(routeFor("#/xyz", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/access/online", "ready"), { view: "online" });
	assert.deepEqual(routeFor("#/visitors", "ready", "member"), { view: "no-hub" });
	assert.deepEqual(routeFor("#/p/files/browser", "ready", "member"), { view: "no-hub" }, "member 访问 admin-only 插件页 → 与中枢四页同拍收敛");
	assert.deepEqual(routeFor("#/p/anything/else", "setup"), { view: "setup" }, "setup 态任何 hash（含 #/p/*）一律全屏引导");
	assert.deepEqual(routeFor("#/p/host/panel", "setup"), { view: "setup" });
});

// ---- 视角可见性与导航行 ---------------------------------------------------------------

test("visibility: visibleToRole matrix", () => {
	assert.equal(visibleToRole("both", "admin"), true);
	assert.equal(visibleToRole("both", "member"), true);
	assert.equal(visibleToRole("admin", "admin"), true);
	assert.equal(visibleToRole("admin", "member"), false);
	assert.equal(visibleToRole("member", "member"), true);
	assert.equal(visibleToRole("member", "admin"), false);
});

test("nav rows: tools section filtered by role and server-enabled state", () => {
	// 未加载：仅内建面（防死链弹跳——受管行 enabled 未知不出现）
	const loading = pluginNavRows("admin", null, null);
	assert.deepEqual(loading.map((r) => r.hash), ["#/p/host/panel"]);
	// 全 registered：仍仅内建面
	const fresh = pluginNavRows("admin", pluginsData({ ports: "registered", files: "registered", sync: "registered" }), null);
	assert.deepEqual(fresh.map((r) => r.hash), ["#/p/host/panel"]);
	// 部分启用：host + 启用行（受管行按 enabled 过滤）
	const partial = pluginNavRows("admin", pluginsData({ ports: "enabled", files: "disabled", sync: "enabled" }), "#/p/files/browser");
	assert.deepEqual(partial.map((r) => r.hash), ["#/p/host/panel", "#/p/ports/mappings", "#/p/sync/groups"]);
	assert.deepEqual(
		partial.map((r) => r.routeId === r.activeRouteId),
		[false, false, false],
		"files 已停用——其行不出现，active 无从命中（收敛路径接管）");
	const active = pluginNavRows("admin", pluginsData({ ports: "enabled", files: "enabled", sync: "disabled" }), "#/p/files/browser");
	assert.deepEqual(active.map((r) => r.hash), ["#/p/host/panel", "#/p/ports/mappings", "#/p/files/browser"]);
	assert.deepEqual(
		active.map((r) => r.routeId === r.activeRouteId),
		[false, false, true],
	);
	// member：admin-only 行全滤（host=both 保留）
	assert.deepEqual(pluginNavRows("member", ALL_ENABLED, null).map((r) => r.hash), ["#/p/host/panel"]);
	// admin 全启用：四行
	assert.equal(pluginNavRows("admin", ALL_ENABLED, null).length, 4);
});
