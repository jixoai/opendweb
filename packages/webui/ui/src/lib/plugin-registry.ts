// 编译期插件路由注册表（webui-plugin-kernel Phase 0 / design §2.1 r2-B5 冻结的
// UI 路由接入协议）。
// 意图（2026-09-29）：
// 1. routeId 形如 `#/p/<pluginId>/<pageId>`——全局唯一、与既有路由空间隔离
//    （前缀 p/ 与既有首段不冲突）；routeFor/canonicalFor 扩展消费本表。
// 2. 本表是**路由形状权威源**（哪些 #/p/ 路由存在 + 视角可见性 + 导航区 +
//    展示元数据）；插件的启停**状态**真源在服务端（GET /sidecar/plugins）——
//    渲染裁决=本表命中 × 服务端 enabled（pluginRouteDecision）。
//    双源说明（收官收敛）：宿主侧 descriptor 已收敛为各包
//    ./opendweb-webui-plugin 单一事实源（packages/webui/src/core/plugins/
//    registry.mjs）；本表与之对齐（页 id/标题/nav/icon/visibility 与包内
//    descriptor 一致——files browser=both、sync=groups/status/conflicts）。
// 3. managed=false = 宿主内建管理面（插件面板 #/p/host/panel）——不属于插件
//    生命周期（宿主自身恒可渲染，不受启停门控）；内置三插件的页面 managed=true
//    ——命中且服务端 enabled 才渲染，否则按既有未知 hash 收敛语义（#/overview）。
// 4. 本文件零 Svelte 导入（node --test 类型剥离直测的纪律同 route.ts/api.ts）；
//    组件绑定在 ./plugin-pages.ts（仅 App 壳消费）。

import type { PluginsData } from "./api";

/** 页面视角可见性（与宿主契约 perspective 同枚举） */
export type PluginPageVisibility = "admin" | "member" | "both";

/** 编译期路由注册表条目 */
export interface PluginRouteEntry {
	/** 规范形态 `#/p/<pluginId>/<pageId>` */
	routeId: string;
	pluginId: string;
	pageId: string;
	title: string;
	/** 导航区（"tools"=SideNav「工具」区；null=不进导航） */
	nav: "tools" | null;
	/** lucide 图标名（kebab-case；SideNav 侧映射为组件） */
	icon: string | null;
	visibility: PluginPageVisibility;
	/** true=受插件生命周期门控（命中且 enabled 才渲染）；false=宿主内建面 */
	managed: boolean;
}

/**
 * 冻结集（收官接线后与各包 descriptor 对齐——descriptor 单一事实源=
 * packages/opendweb-ext-{ports,files,sync,ai} 的 ./opendweb-webui-plugin）：
 * host 面板（both，member 深链直达）+ ports mappings（admin）+ files browser
 * （**both**——B 机成员姿态是浏览远端共享的核心用例，Phase 2 包 descriptor
 * 裁决）+ sync groups/status/conflicts 三页（admin——同步组管理是本机管理面）
 * + ai provider/consumer（ai-subscription-sharing Phase C：提供方=admin、
 * 消费方=member——design §1 双姿态共存互不排斥，视角仅 UI 呈现过滤）。
 */
export const PLUGIN_ROUTE_REGISTRY: readonly PluginRouteEntry[] = [
	{ routeId: "#/p/host/panel", pluginId: "host", pageId: "panel", title: "插件", nav: "tools", icon: "puzzle", visibility: "both", managed: false },
	{ routeId: "#/p/ports/mappings", pluginId: "ports", pageId: "mappings", title: "端口映射", nav: "tools", icon: "network", visibility: "admin", managed: true },
	{ routeId: "#/p/files/browser", pluginId: "files", pageId: "browser", title: "文件浏览", nav: "tools", icon: "folder", visibility: "both", managed: true },
	{ routeId: "#/p/sync/groups", pluginId: "sync", pageId: "groups", title: "同步组", nav: "tools", icon: "refresh", visibility: "admin", managed: true },
	{ routeId: "#/p/sync/status", pluginId: "sync", pageId: "status", title: "同步状态", nav: "tools", icon: "activity", visibility: "admin", managed: true },
	{ routeId: "#/p/sync/conflicts", pluginId: "sync", pageId: "conflicts", title: "同步冲突", nav: "tools", icon: "triangle-alert", visibility: "admin", managed: true },
	{ routeId: "#/p/ai/provider", pluginId: "ai", pageId: "provider", title: "AI 订阅·提供方", nav: "tools", icon: "sparkles", visibility: "admin", managed: true },
	{ routeId: "#/p/ai/consumer", pluginId: "ai", pageId: "consumer", title: "AI 订阅·消费方", nav: "tools", icon: "bot", visibility: "member", managed: true },
];

/** 视角可见性判定（SideNav 行过滤与 routeFor 共用）。 */
export function visibleToRole(visibility: PluginPageVisibility, role: "admin" | "member"): boolean {
	return visibility === "both" || visibility === role;
}

/**
 * hash → 注册表条目（精确两段匹配 `#/p/<id>/<id>`；id 字符集与契约一致——
 * 大小写/多段/编码形态一律 miss→调用方按未知 hash 收敛）。
 * @param hash 形如 "#/p/host/panel"（缺 # 前缀也接受——canonicalFor 已剥前缀重建）
 */
export function findPluginRoute(hash: string | null | undefined): PluginRouteEntry | null {
	const h = String(hash ?? "").replace(/^#\/?/, "");
	const match = /^p\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(h);
	if (match === null) return null;
	const routeId = `#/p/${match[1]}/${match[2]}`;
	return PLUGIN_ROUTE_REGISTRY.find((e) => e.routeId === routeId) ?? null;
}

/**
 * 插件页渲染裁决（App 壳分派与收敛 effect 的唯一依据；四场景的纯函数面）：
 * - render：命中且（内建面 或 服务端 enabled）→ 渲染组件；
 * - converge：命中但 disabled/不在服务端注册表 → 按既有未知 hash 收敛（#/overview）；
 * - pending：受管页面且服务端状态未加载（深链首拍）→ 等待（骨架），不抢收敛。
 * @param pluginId 路由条目的 pluginId（须先经 findPluginRoute 命中）
 * @param data GET /sidecar/plugins 投影（null=未加载）
 */
export type PluginRouteDecision = { action: "render" } | { action: "converge"; hash: "#/overview" } | { action: "pending" };

export function pluginRouteDecision(pluginId: string, data: PluginsData | null): PluginRouteDecision {
	const entry = PLUGIN_ROUTE_REGISTRY.find((e) => e.pluginId === pluginId) ?? null;
	if (entry === null || !entry.managed) return { action: "render" }; // 内建面/未知 pluginId（routeFor 已挡）恒渲染
	if (data === null) return { action: "pending" };
	const server = data.plugins.find((p) => p.id === pluginId);
	if (server === undefined || server.status !== "enabled") return { action: "converge", hash: "#/overview" };
	return { action: "render" };
}

/** SideNav「工具」区导航行（本表 tools 行 × 视角可见性 × 服务端 enabled）。 */
export interface PluginNavRow {
	hash: string;
	routeId: string;
	title: string;
	icon: string | null;
	activeRouteId: string | null;
}

/**
 * 工具区导航行（含 active 标记原料；SideNav 渲染）。
 * @param role 当前姿态（视角可见性过滤）
 * @param data 服务端插件投影（null=未加载——受管行不出现，防死链弹跳）
 * @param activeRouteId 当前命中的 routeId（无则 null）
 */
export function pluginNavRows(role: "admin" | "member", data: PluginsData | null, activeRouteId: string | null): PluginNavRow[] {
	const rows: PluginNavRow[] = [];
	for (const entry of PLUGIN_ROUTE_REGISTRY) {
		if (entry.nav !== "tools") continue;
		if (!visibleToRole(entry.visibility, role)) continue;
		if (entry.managed && pluginRouteDecision(entry.pluginId, data).action !== "render") continue;
		rows.push({ hash: entry.routeId, routeId: entry.routeId, title: entry.title, icon: entry.icon, activeRouteId });
	}
	return rows;
}
