// hash → 路由（server-access-roles specs/webui「三角色管理台信息架构」冻结契约；
// home-hub specs/webui「三视角控制台」增三视角路由）。
// 我的中枢视角四页：#/overview（总览）/ #/tenants（租户管理，邀请码为子区块）/
// #/visitors（访客与门禁）/ #/online（在线连接）。
// 我的租约视角：#/lease（单页台账）；我的到访视角：#/visits（单页台账）。
// 旧路由 MUST 301 式收敛（应用内重定向，不 404）：#/owners→#/tenants、
// #/access→#/visitors、#/online→#/online、#/overview→#/overview、其余未知
// hash→#/overview。setup 态任何 hash 都落引导（v1 基座不变）。member 态访问
// 中枢四页 → no-hub（这台设备没有中枢身份的诚实页，无 admin 概念）。
// webui-plugin-kernel Phase 0（r2-B5 冻结协议）：`#/p/<pluginId>/<pageId>` 前缀
// = 编译期插件路由注册表（plugin-registry.ts）——命中且视角可见 → plugin 视图
// （渲染还需服务端 enabled，裁决在 pluginRouteDecision/App 壳）；命中但不可见
// → overview（member 再映射 no-hub，与中枢四页同拍）；未知/畸形 #/p/* →
// 既有未知 hash 收敛（#/overview）。既有路由行为零变化（零回归门覆盖）。

import { findPluginRoute, visibleToRole } from "./plugin-registry.ts";

export type RouteView =
	| "setup"
	| "overview"
	| "tenants"
	| "visitors"
	| "online"
	| "lease"
	| "visits"
	| "no-hub";

/** 插件页视图（routeId 命中注册表；渲染门控见 plugin-registry.pluginRouteDecision）。 */
export interface PluginRouteView {
	view: "plugin";
	pluginId: string;
	pageId: string;
	routeId: string;
}

export type Route = { view: RouteView } | PluginRouteView;

/** 三视角（home-hub 组 B 命名冻结；切换器的身份锚点）。 */
export type Perspective = "hub" | "lease" | "visits";

/** 各视角的规范 hash（切换器一击切换的落点；hub=总览首屏）。 */
export const PERSPECTIVE_HASH: Record<Perspective, string> = {
	hub: "#/overview",
	lease: "#/lease",
	visits: "#/visits",
};

/** 视角名（组 B 逐字：我的中枢 / 我的租约 / 我的到访）。 */
export const PERSPECTIVE_LABEL: Record<Perspective, string> = {
	hub: "我的中枢",
	lease: "我的租约",
	visits: "我的到访",
};

/** 冻结的收敛映射：hash 首段 → 规范 hash（含全部 v1 旧路由 + 三视角新页）。 */
const CONVERGE: Record<string, string> = {
	"": "#/overview",
	overview: "#/overview",
	status: "#/overview", // v1 状态页 → 总览
	connect: "#/overview", // v1 配对页 → 总览（节点簿面板仍可从顶栏呼出）
	owners: "#/tenants",
	tenants: "#/tenants",
	access: "#/visitors",
	visitors: "#/visitors",
	online: "#/online",
	connections: "#/online", // v1 连接页 → 在线
	lease: "#/lease",
	leases: "#/lease", // 复数形态一并收敛（口语习惯）
	visit: "#/visits",
	visits: "#/visits",
};

/** 我的中枢视角的四个页面视图（member 态访问时收敛为 no-hub）。 */
const HUB_VIEWS = new Set(["overview", "tenants", "visitors", "online"]);

function canonicalFor(hash: string | null | undefined): string {
  const h = String(hash ?? "").replace(/^#\/?/, "");
  const [head, second] = h.split("/");
  // 插件路由空间（r2-B5）：注册表命中=规范形态原样（member 不可见页也保留
  // URL——与 member 访问中枢四页的既有语义同拍）；未知/畸形 #/p/* → 未知 hash
  // 收敛（#/overview，不 404）
  if (head === "p") {
    const full = `#/${h}`;
    return findPluginRoute(full) !== null ? full : "#/overview";
  }
  // v1 深链细分：#/access/online 的「在线」意图保留（父段 access 仍收敛门禁页）
  if (head === "access" && second === "online") return "#/online";
  if (head in CONVERGE) return CONVERGE[head];
  return "#/overview"; // 未知 hash → 总览（不 404）
}

/**
 * hash 是否为规范形态（各视角页面原样）。
 * @returns 规范 hash（非规范/未知输入时给出收敛目标）；已是规范则返回 null。
 */
export function canonicalHashFor(hash: string | null | undefined): string | null {
	const canonical = canonicalFor(hash);
	return String(hash ?? "") === canonical ? null : canonical;
}

/**
 * 规范 hash → 视图。member 态访问中枢四页 → no-hub（这台设备没有中枢身份）。
 * @param role home-hub 2b：sidecar 姿态（缺省 admin——旧调用面不变）
 */
export function routeFor(hash: string | null | undefined, phase: string, role: "admin" | "member" = "admin"): Route {
  if (phase !== "ready") return { view: "setup" };
  // 插件路由（r2-B5）：命中且视角可见 → plugin 视图；命中但不可见 → overview
  // （走下方 member 映射——与中枢四页同拍；URL 不重写）
  const pluginEntry = findPluginRoute(hash);
  if (pluginEntry !== null && visibleToRole(pluginEntry.visibility, role)) {
    return { view: "plugin", pluginId: pluginEntry.pluginId, pageId: pluginEntry.pageId, routeId: pluginEntry.routeId };
  }
  const view = pluginEntry !== null ? "overview" : canonicalFor(hash).slice(2);
  if (role === "member" && HUB_VIEWS.has(view)) return { view: "no-hub" };
  return { view: view as Exclude<RouteView, "setup"> };
}

/** 视图 → 所属视角（切换器高亮与外壳分派的唯一依据）。 */
export function perspectiveFor(view: Route["view"]): Perspective {
  if (view === "lease") return "lease";
  if (view === "visits") return "visits";
  return "hub"; // setup/no-hub/plugin/中枢四页均属中枢视角外壳
}

/**
 * 默认视角自动选择（home-hub spec 冻结顺序：本机 hub.json 存在→中枢；有租约
 * →租约；有到访→到访；全空→中枢引导态）。纯函数——boot 时由 store 消费。
 * @param input.role sidecar 姿态（member 无中枢身份）
 * @param input.hubLocal sidecar 的 hub 本机自动标记（row 2）
 * @param input.hubPresent GET /sidecar/hub 非 404（hub.json 存在）
 * @param input.leases 本机租约条数
 * @param input.visits 本机到访条数
 */
export function defaultPerspective(input: {
	role: "admin" | "member";
	hubLocal: boolean;
	hubPresent: boolean;
	leases: number;
	visits: number;
}): Perspective {
	if (input.hubLocal || input.hubPresent) return "hub";
	if (input.leases > 0) return "lease";
	if (input.visits > 0) return "visits";
	return "hub";
}

/** localStorage 记忆键（最近使用的视角；spec「此后记忆最近使用」）。 */
export const PERSPECTIVE_STORAGE_KEY = "opendweb-webui-perspective";

/** 读取记忆视角（非法/缺失 → null）。 */
export function rememberedPerspective(storage: Storage | null | undefined): Perspective | null {
	try {
		const v = storage?.getItem(PERSPECTIVE_STORAGE_KEY);
		return v === "hub" || v === "lease" || v === "visits" ? v : null;
	} catch {
		return null;
	}
}

/** 写入记忆视角（无权限静默降级）。 */
export function rememberPerspective(storage: Storage | null | undefined, p: Perspective): void {
	try {
		storage?.setItem(PERSPECTIVE_STORAGE_KEY, p);
	} catch {
		// 无 localStorage 权限：视角偏好不持久化（会话内仍生效）
	}
}
