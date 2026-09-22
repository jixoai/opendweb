// UI 纯逻辑直测（webui-console UI 层 Svelte 5 重做）。
// 框架无关逻辑全部位于 ui/src/lib/*.ts（无 Svelte 导入），node --test 经
// Node 类型剥离（type stripping）直测——不依赖浏览器/组件渲染：
// 1. routeFor 两世界 + 旧 hash 收敛（§7.1）；
// 2. apiFetch 归一（envelope 透传 / http-<status> 兜底 / network / timeout /
//    invalid-response）+ 注入面 → 真实 sidecar 链路；
// 3. 失败态文案矩阵（errorCopy 六路 + retry 语义 / healthCopy 四态 /
//    connectErrorCopy 配对面）与断连四态标签（§4.3 C-2）；
// 4. 时间人类可读（无 ISO 8601 原文）与 hex 分层披露（缩写/校验/签名摘要）；
// 5. 术语纪律（§8.3）：文案无「管理员/管理者」、无 generation/policy/mode 裸值。
import test from "node:test";
import assert from "node:assert/strict";
import { fakeUpstream } from "./helpers.mjs";
import { startSidecar } from "../src/sidecar.mjs";
import { routeFor } from "../ui/src/lib/route.ts";
import {
	AdminError,
	fetchSidecarState,
	loadStatus,
	postConnect,
	resetApiFetch,
	setApiFetch,
} from "../ui/src/lib/api.ts";
import { connectErrorCopy, errorCopy, healthCopy } from "../ui/src/lib/copy.ts";
import { fmtClock, formatTime, relativeTime } from "../ui/src/lib/format.ts";
import { shortHex, sigPrefixHex, validateHex64 } from "../ui/src/lib/hex.ts";
import { DISCONNECT_PHASE_LABEL, modeBadge, policyLabel, OP_LABEL } from "../ui/src/lib/terms.ts";

test.afterEach(() => resetApiFetch());

// ---- 路由收敛：两个世界 + 旧 hash 落位（§3.1 / §7.1） ------------------------------

test("routeFor: ready 态默认落地总览，旧 hash 收敛到正确去处", () => {
	assert.deepEqual(routeFor("#/", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/xyz-unknown", "ready"), { view: "overview" });
	assert.deepEqual(routeFor("#/status", "ready"), { view: "overview" }); // 旧状态页 → 总览
	assert.deepEqual(routeFor("#/connect", "ready"), { view: "overview", panel: true }); // 旧配对页 → 总览+连接详情
	assert.deepEqual(routeFor("#/owners", "ready"), { view: "access", section: "roster" }); // 旧 Owners → 名册
	assert.deepEqual(routeFor("#/connections", "ready"), { view: "access", section: "online" }); // 旧连接页 → 在线
	assert.deepEqual(routeFor("#/access", "ready"), { view: "access", section: "roster" });
	assert.deepEqual(routeFor("#/access/roster", "ready"), { view: "access", section: "roster" });
	assert.deepEqual(routeFor("#/access/online", "ready"), { view: "access", section: "online" });
});

test("routeFor: setup 态任何 hash（含全部旧业务路由）一律落全屏引导", () => {
	for (const h of ["", "#/", "#/connect", "#/status", "#/owners", "#/connections", "#/access/online"]) {
		assert.deepEqual(routeFor(h, "setup"), { view: "setup" }, `hash ${h}`);
	}
});

// ---- apiFetch 归一单测（注入层行为不变） ---------------------------------------------

/** 构造返回 envelope 错误的 transport 替身。 */
function envelopeTransport(status, code, message = "fixture") {
	return async () =>
		new Response(JSON.stringify({ error: { code, message } }), {
			status,
			headers: { "content-type": "application/json" },
		});
}

/** 构造非 JSON 空 body 的 transport 替身（http-<status> 兜底路径）。 */
function bareTransport(status) {
	return async () => new Response("", { status });
}

const rejected = (p) =>
	p.then(
		() => {
			throw new Error("expected rejection");
		},
		(e) => e,
	);

test("apiFetch normalization: envelope code passthrough, http-<status> fallback, ok JSON", async () => {
	setApiFetch(
		async (path) =>
			new Response(JSON.stringify({ pong: path }), { status: 200, headers: { "content-type": "application/json" } }),
	);
	assert.deepEqual(await loadStatus(), { pong: "/api/status" });

	setApiFetch(envelopeTransport(409, "invalid-request"));
	const env = await rejected(loadStatus());
	assert.ok(env instanceof AdminError);
	assert.equal(env.code, "invalid-request");
	assert.equal(env.status, 409);

	setApiFetch(async () => new Response("<html>", { status: 503 }));
	const bare = await rejected(loadStatus());
	assert.equal(bare.code, "http-503");

	setApiFetch(async () => new Response("not json", { status: 200 }));
	const bad = await rejected(loadStatus());
	assert.equal(bad.code, "invalid-response");

	setApiFetch(null); // null 恢复默认（不抛即算通过接线检查）
});

test("apiFetch transport mapping: thrown TypeError → network; TimeoutError → timeout", async () => {
	setApiFetch(async () => {
		throw new TypeError("fetch failed");
	});
	const network = await rejected(loadStatus());
	assert.equal(network.code, "network");
	assert.equal(network.status, null);

	setApiFetch(async () => {
		const e = new Error("signal timed out");
		e.name = "TimeoutError";
		throw e;
	});
	const timeout = await rejected(loadStatus());
	assert.equal(timeout.code, "timeout");
});

test("postConnect normalization: sidecar envelope codes flow through the injectable layer", async () => {
	setApiFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
	assert.deepEqual(await postConnect({ pairing_code: "X", server: "s", token: "t" }), { ok: true });

	setApiFetch(envelopeTransport(400, "bad-target", "target uses plaintext http"));
	const err = await rejected(postConnect({}));
	assert.equal(err.code, "bad-target");
});

// ---- 失败态文案矩阵（六路 + retry 语义；健康灯四态） --------------------------------

const MATRIX = [
	{ name: "not-enabled", code: "admin-not-enabled", copy: "DWEB_ADMIN_TOKEN", where: "detail", retry: true },
	{ name: "unauthorized", code: "unauthorized", copy: "管理凭证无效", where: "title", retry: false },
	{ name: "http-502", code: "http-502", copy: "服务器内部错误", where: "title", retry: true },
	{ name: "network", code: "network", copy: "网络错误", where: "detail", retry: true },
	{ name: "timeout", code: "timeout", copy: "超时", where: "detail", retry: true },
	{ name: "no-match", code: "no-match", copy: "目标不在线", where: "title", retry: true },
];

for (const fixture of MATRIX) {
	test(`failure matrix [${fixture.name}]: errorCopy gives semantic copy with retry=${fixture.retry}`, () => {
		const err = new AdminError(fixture.code, "fixture", null);
		const copy = errorCopy(err);
		assert.ok(
			copy[fixture.where].includes(fixture.copy),
			`${fixture.where} contains "${fixture.copy}"`,
		);
		assert.equal(copy.retry, fixture.retry);
		assert.ok(copy.title.length > 0 && copy.detail.length > 0);
	});
}

test("failure matrix: http-404 upgrade guidance is non-retryable; generic http-4xx is retryable", () => {
	assert.equal(errorCopy(new AdminError("http-404", "x")).retry, false);
	assert.ok(errorCopy(new AdminError("http-404", "x")).detail.includes("旧版本"));
	assert.equal(errorCopy(new AdminError("http-422", "bad nonce")).retry, true);
	assert.ok(errorCopy(new AdminError("http-422", "bad nonce")).detail.includes("bad nonce"));
});

test("sidecar transport-family codes map into semantic equivalents (upstream-* envelopes)", () => {
	const unreachable = errorCopy(new AdminError("upstream-unreachable", "boom"));
	assert.equal(unreachable.title, "连不上服务器");
	const timedOut = errorCopy(new AdminError("upstream-timeout", ""));
	assert.equal(timedOut.title, "连不上服务器");
	assert.ok(timedOut.detail.includes("超时"));
	const tooLarge = errorCopy(new AdminError("upstream-too-large", ""));
	assert.equal(tooLarge.title, "服务器内部错误");
	assert.equal(healthCopy(new AdminError("upstream-unreachable", "")).label, "连不上服务器");
	assert.equal(healthCopy(new AdminError("upstream-timeout", "")).label, "连不上服务器");
	assert.equal(healthCopy(new AdminError("upstream-too-large", "")).label, "服务器内部错误");
});

test("health light: four semantic states from poll result (§4.2 步 1)", () => {
	assert.deepEqual(healthCopy(null), { tone: "ok", label: "管理面连接正常" });
	assert.equal(healthCopy(new AdminError("network", "x")).label, "连不上服务器");
	assert.equal(healthCopy(new AdminError("timeout", "x")).label, "连不上服务器");
	assert.equal(healthCopy(new AdminError("unauthorized", "x")).label, "管理凭证无效");
	assert.equal(healthCopy(new AdminError("admin-not-enabled", "x")).label, "远端未开启管理面");
	assert.equal(healthCopy(new AdminError("http-502", "x")).label, "服务器内部错误");
	assert.equal(healthCopy(null).tone, "ok");
	assert.equal(healthCopy(new AdminError("network", "x")).tone, "bad");
});

// ---- 断连闭环标签（§4.3 C-2：已下发 → 收敛中 → 已收敛 / 超时未确认） -----------------

test("disconnect closed loop: four phase labels present (same-view state machine)", () => {
	assert.equal(DISCONNECT_PHASE_LABEL.dispatched, "已下发");
	assert.equal(DISCONNECT_PHASE_LABEL.converging, "收敛中");
	assert.equal(DISCONNECT_PHASE_LABEL.converged, "已收敛");
	assert.equal(DISCONNECT_PHASE_LABEL.unconfirmed, "超时未确认");
});

// ---- 配对面错误文案（§5.3 成品文案） --------------------------------------------------

test("connect error copy: bad-pairing / target-frozen / invalid-request semantics", () => {
	const badPairing = connectErrorCopy(new AdminError("bad-pairing", "wrong code"));
	assert.equal(badPairing.title, "配对码不对，或已过期");
	assert.ok(badPairing.detail.includes("10 分钟内有效"));
	assert.ok(badPairing.detail.includes("终端"));

	assert.equal(connectErrorCopy(new AdminError("target-frozen", "")).title, "目标已锁定");
	assert.ok(connectErrorCopy(new AdminError("target-frozen", "")).detail.includes("重新运行命令"));
	assert.equal(connectErrorCopy(new AdminError("invalid-request", "")).title, "信息不完整");
	assert.equal(connectErrorCopy(new AdminError("bad-origin-host", "")).title, "来源校验失败");
	assert.ok(connectErrorCopy(new AdminError("bad-target", "not http(s)")).detail.includes("--allow-insecure"));
});

// ---- 时间与 hex 呈现（§5.1/§7.3：人类可读 + 分层披露） -------------------------------

test("formatTime: local time + relative time; never ISO 8601", () => {
	const now = Date.now();
	assert.equal(relativeTime(now - 5_000, now), "刚刚");
	assert.equal(relativeTime(now - 30_000, now), "30 秒前");
	assert.equal(relativeTime(now - 2 * 60_000, now), "2 分钟前");
	assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 小时前");
	assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 天前");
	const s = formatTime(1_789_123_456_789, now);
	assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（.+）$/, "local datetime + relative");
	assert.ok(!s.includes("T"), "no ISO 8601 literal");
	assert.match(fmtClock(1_789_123_456_789), /^\d{2}:\d{2}:\d{2}$/);
});

test("hex display helpers: abbreviation, validation, signature digest prefix", () => {
	const fabric = "ab".repeat(32);
	assert.equal(shortHex(fabric), `${fabric.slice(0, 8)}…`);
	assert.equal(shortHex("abc"), "abc");
	assert.equal(shortHex(null), "-");

	assert.equal(validateHex64(fabric), fabric);
	assert.equal(validateHex64(`  ${"AB".repeat(32)} `), fabric); // trim + 小写归一
	assert.equal(validateHex64("zz".repeat(32)), null);
	assert.equal(validateHex64("ab".repeat(31)), null);
	assert.equal(validateHex64(12345), null);

	const sig = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]), Buffer.alloc(55)]).toString("base64url");
	assert.equal(sigPrefixHex(sig), "deadbeef01234567");
	assert.equal(sigPrefixHex("!!!"), "");
	assert.equal(sigPrefixHex(undefined), "");
});

// ---- 术语投影（§5.1/§8.3） -----------------------------------------------------------

test("term projections: mode badge, policy label, op verbs — no raw engineering terms", () => {
	assert.deepEqual(modeBadge("restricted"), { label: "受限模式", title: "只有名册内的所有者可以接入" });
	assert.deepEqual(modeBadge("open"), { label: "开放模式", title: "未启用身份验证，任何人都能接入" });
	assert.equal(modeBadge(undefined), null);
	assert.equal(policyLabel("static"), "静态名册");
	assert.equal(policyLabel("callback"), "动态回调");
	assert.equal(policyLabel(undefined), "-");
	assert.equal(OP_LABEL.register, "注册");
	assert.equal(OP_LABEL.unregister, "注销");
	assert.equal(OP_LABEL.disconnect, "断开");
});

test("terminology sweep: copy functions never leak 管理员/管理者 or generation/policy/mode raw values", () => {
	const codes = [
		"admin-not-enabled",
		"unauthorized",
		"no-match",
		"timeout",
		"network",
		"http-502",
		"http-404",
		"http-4xx",
		"unknown-code",
	];
	for (const code of codes) {
		for (const copy of [errorCopy(new AdminError(code, "m")).title, errorCopy(new AdminError(code, "m")).detail]) {
			assert.ok(!copy.includes("管理员"), `${code}: no 管理员`);
			assert.ok(!copy.includes("管理者"), `${code}: no 管理者`);
		}
	}
	for (const copy of Object.values(connectErrorCopy(new AdminError("bad-pairing", "")))) {
		assert.ok(!copy.includes("管理员") && !copy.includes("管理者"));
	}
	// 断连文案无 ISO 时间原文
	assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(errorCopy(new AdminError("network", "")).detail));
});

// ---- 注入层 → 真实 sidecar 链路（state + /api/* 代理） -------------------------------

test("integration: injectable layer drives a live sidecar end to end", async (t) => {
	const upstream = await fakeUpstream({
		handler: (req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					mode: "restricted",
					policy: "static",
					generation: 7,
					max_connections_per_owner: 16,
					active_connections: [],
					per_owner_connections: [],
					cache_entries: 0,
				}),
			);
		},
	});
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
		token: "int-layer-token",
	});
	t.after(() => Promise.all([sc.close(), upstream.close()]));
	// 注入层指向真实 sidecar（绝对 URL 同源语义的等价替身）
	setApiFetch(async (path, init) => fetch(sc.origin + path, init));

	const state = await fetchSidecarState();
	assert.equal(state.phase, "ready");
	assert.ok(typeof state.server_host_masked === "string");

	const data = await loadStatus();
	assert.equal(upstream.hits[0].url, "/admin/status");
	assert.equal(upstream.hits[0].headers.authorization, "Bearer int-layer-token");
	assert.equal(data.mode, "restricted");
	assert.equal(data.generation, 7);
});
