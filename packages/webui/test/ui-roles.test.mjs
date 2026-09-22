// 三角色 UI 逻辑直测（server-access-roles Phase 2a：specs/webui 五 requirement 的
// 纯函数面 + 路径契约）。框架无关逻辑位于 ui/src/lib/*.ts（无 Svelte 导入），
// node --test 经 Node 类型剥离直测：
// 1. hash 收敛映射 + canonicalHashFor（301 式收敛，不 404）；
// 2. key 显示规范：缩写首3***尾3、displayKey `别名 (abc***xyz)`、复制语义（全文）；
// 3. 敲门台：原因映射 / 排序契约（以服务端 seq 为准——客户端零重排）；
// 4. 邀请码：4-4-4-4 分组 / 状态徽章 / 一次性全文语义（issue 后列表 fixture 只含哈希）；
// 5. 租期：leaseState 三态 + 到期边界（now>=expires_at 即过期）+ 同 fabric 多 root 警示；
// 6. **业务路径契约**：敲门台/邀请码/访客/黑名单/续期等业务调用只走 /api/*；
//    本地控制面仅 /sidecar/nodes*、/sidecar/connect、/sidecar/state（r2-P1-2）；
// 7. apiFetch 注入矩阵扩展：新端点的 envelope 透传 / http 兜底 / network / timeout。
import test from "node:test";
import assert from "node:assert/strict";
import { routeFor, canonicalHashFor } from "../ui/src/lib/route.ts";
import { AdminError } from "../ui/src/lib/api.ts";
import { displayKey, shortHex } from "../ui/src/lib/hex.ts";
import {
	addBlocklist,
	addSidecarNode,
	dismissKnock,
	fetchSidecarNodes,
	grantVisitor,
	grantVisitorFromKnock,
	issueCode,
	loadBlocklist,
	loadCodes,
	loadKnocks,
	loadVisitors,
	registerOwner,
	renewOwner,
	revokeCode,
	revokeVisitor,
	switchSidecarNode,
	deleteSidecarNode,
	undismissKnock,
	postConnect,
	fetchSidecarState,
	removeBlocklist,
	resetApiFetch,
	setApiFetch,
} from "../ui/src/lib/api.ts";
import { fmtDate, groupInviteCode, leaseState } from "../ui/src/lib/format.ts";
import { codeStatus, knockReasonLabel, multiRootFabrics, maskNodeUrl } from "../ui/src/lib/terms.ts";

test.afterEach(() => resetApiFetch());

// ---- hash 收敛（冻结映射：#/owners→#/tenants、#/access→#/visitors、未知→#/overview） ----

test("canonicalHashFor: 301-style convergence replaces legacy/unknown hashes, canonical stays null", () => {
	assert.equal(canonicalHashFor("#/overview"), null);
	assert.equal(canonicalHashFor("#/tenants"), null);
	assert.equal(canonicalHashFor("#/visitors"), null);
	assert.equal(canonicalHashFor("#/online"), null);
	assert.equal(canonicalHashFor("#/owners"), "#/tenants");
	assert.equal(canonicalHashFor("#/access"), "#/visitors");
	assert.equal(canonicalHashFor("#/access/online"), "#/online");
	assert.equal(canonicalHashFor("#/connections"), "#/online");
	assert.equal(canonicalHashFor("#/status"), "#/overview");
	assert.equal(canonicalHashFor("#/connect"), "#/overview");
	assert.equal(canonicalHashFor("#/"), "#/overview");
	assert.equal(canonicalHashFor(""), "#/overview");
	assert.equal(canonicalHashFor("#/tenants/roster"), "#/tenants"); // 子路径收敛
	assert.equal(canonicalHashFor("#/totally-unknown"), "#/overview"); // 未知不 404
	assert.deepEqual(routeFor("#/owners", "ready"), routeFor("#/tenants", "ready"), "收敛目标与直达一致");
});

// ---- key 显示规范（别名 + 防钓鱼缩写；取代 v1 前 8 位） -------------------------------

test("shortHex: first3***last3 across lengths; stable for same key", () => {
	const key = `ab1${"0".repeat(58)}c00`; // 64 hex：首三 ab1、尾三 c00
	assert.equal(key.length, 64);
	assert.equal(shortHex(key), "ab1***c00");
	assert.equal(shortHex(key), shortHex(key.toLowerCase()), "deterministic");
	assert.equal(shortHex("abcdef"), "abcdef"); // ≤6 原样
	assert.equal(shortHex(""), "-");
	assert.equal(shortHex(null), "-");
});

test("displayKey: alias (abc***xyz) composition; whitespace alias falls back to bare abbreviation", () => {
	const key = `ab1${"0".repeat(58)}c00`;
	assert.equal(displayKey(key, "李四团队"), "李四团队 (ab1***c00)");
	assert.equal(displayKey(key, null), "(ab1***c00)");
	assert.equal(displayKey(key, "   "), "(ab1***c00)"); // 空白别名视为无别名
	assert.equal(displayKey(key, undefined), "(ab1***c00)");
	// 复制语义由组件承担：复制的是完整 64 hex（本层提供原文，缩写仅呈现）
	assert.equal(key.length, 64);
});

// ---- 敲门台 ------------------------------------------------------------------------------

test("knockReasonLabel: manager-side reason mapping (PM §4.1)", () => {
	assert.equal(knockReasonLabel("dweb/no-capability"), "陌生设备，无通行票");
	assert.equal(knockReasonLabel("dweb/unknown-owner"), "通行票无效");
	assert.equal(knockReasonLabel("dweb/owner-expired"), "所属租户租期已到");
	assert.equal(knockReasonLabel("dweb/visitor-quota-exceeded"), "访客连接数已达上限");
	assert.equal(knockReasonLabel("dweb/something-new"), "dweb/something-new"); // 未知原文呈现
	assert.equal(knockReasonLabel(null), "-");
});

test("knock list order is the server's (seq-ordered); client performs no re-sorting", async () => {
	// 服务端冻结序：未处置在前、组内 seq 降序——注入层原样透传即 UI 呈现序
	const serverOrder = [
		{ endpoint_id: "aa".repeat(32), seq: 9, first_at: 1, last_at: 5, count: 3, last_reason: "dweb/no-capability" },
		{ endpoint_id: "bb".repeat(32), seq: 7, first_at: 1, last_at: 9, count: 2, last_reason: "dweb/no-capability" }, // last_at 较新但 seq 较旧——仍在后
	];
	setApiFetch(async () => new Response(JSON.stringify({ knocks: serverOrder, pending_count: 2 }), { status: 200 }));
	const data = await loadKnocks();
	assert.deepEqual(data.knocks.map((k) => k.endpoint_id), serverOrder.map((k) => k.endpoint_id));
	assert.equal(data.pending_count, 2);
});

// ---- 邀请码 ------------------------------------------------------------------------------

test("groupInviteCode: dwebc1. + 4-4-4-4 grouping (hyphens normalized)", () => {
	assert.equal(groupInviteCode("dwebc1.ABCDEFGHIJKLMNOP"), "dwebc1.ABCD-EFGH-IJKL-MNOP");
	assert.equal(groupInviteCode("dwebc1.ABCD-EFGH-IJKL-MNOP"), "dwebc1.ABCD-EFGH-IJKL-MNOP"); // 已分组幂等
	assert.equal(groupInviteCode("not-a-code"), "not-a-code");
	assert.equal(groupInviteCode(null), "");
});

test("codeStatus: four states with precedence revoked > expired > exhausted > available", () => {
	const now = 1_000_000;
	assert.deepEqual(codeStatus({ used_count: 0, max_uses: 1, expires_at: now + 1 }, now), { status: "available", label: "待使用" });
	assert.deepEqual(codeStatus({ used_count: 1, max_uses: 1, expires_at: now + 1 }, now), { status: "exhausted", label: "已用尽" });
	assert.deepEqual(codeStatus({ used_count: 0, max_uses: 1, expires_at: now }, now), { status: "expired", label: "已过期" }); // now>=expires_at 等值=过期
	assert.deepEqual(codeStatus({ used_count: 1, max_uses: 1, expires_at: now - 1, revoked: true }, now), { status: "revoked", label: "已吊销" });
});

test("code full text exists only in the issue response fixture; list carries hashes only", async () => {
	const FULL = "dwebc1.ABCDEFGHIJKLMNOP";
	let issued = null;
	setApiFetch(async (path, init) => {
		if (path === "/api/codes" && init?.method === "POST") {
			issued = { code: FULL, op: "code-issue", ts: 1, generation: 3, receipt_sig: "x" };
			return new Response(JSON.stringify(issued), { status: 200 });
		}
		// 列表只含 code_hash/used/max/状态——绝无码全文
		return new Response(
			JSON.stringify({ codes: [{ code_hash: "cd".repeat(32), max_uses: 1, used_count: 1, expires_at: 9e15, revoked: false }] }),
			{ status: 200 },
		);
	});
	const res = await issueCode({ max_uses: 1 });
	assert.equal(res.code, FULL); // 仅此一次
	const list = await loadCodes();
	assert.equal(JSON.stringify(list).includes(FULL), false, "list must never carry the code text");
});

// ---- 租期 -------------------------------------------------------------------------------

test("leaseState: permanent/active/expiring/expired with frozen boundary (now>=expires_at is expired)", () => {
	const now = 1_000_000_000_000;
	assert.deepEqual(leaseState(undefined, now), { state: "permanent", daysLeft: null, label: "在租 · 永久" });
	assert.deepEqual(leaseState(null, now), { state: "permanent", daysLeft: null, label: "在租 · 永久" });
	assert.equal(leaseState(now, now).state, "expired"); // 等值=过期
	assert.equal(leaseState(now - 1, now).state, "expired");
	const five = leaseState(now + 5 * 86_400_000, now);
	assert.equal(five.state, "expiring");
	assert.equal(five.label, "临期 · 剩 5 天");
	const twenty = leaseState(now + 23 * 86_400_000, now);
	assert.equal(twenty.state, "active");
	assert.equal(twenty.label, "在租 · 剩 23 天");
	assert.equal(leaseState(now + 7 * 86_400_000, now).state, "expiring"); // 7 天含边界
	assert.equal(leaseState(now + 8 * 86_400_000, now).state, "active"); // 8 天不含
});

test("multiRootFabrics: same fabric with multiple roots is flagged (phishing warning source)", () => {
	const f1 = "11".repeat(32);
	const f2 = "22".repeat(32);
	const flagged = multiRootFabrics([
		{ fabric_id: f1, root: "aa".repeat(32) },
		{ fabric_id: f1, root: "bb".repeat(32) }, // 同 fabric 多 root
		{ fabric_id: f2, root: "cc".repeat(32) },
	]);
	assert.equal(flagged.has(f1), true);
	assert.equal(flagged.has(f2), false);
	assert.equal(flagged.size, 1);
});

test("maskNodeUrl: same masking rule as sidecar maskTarget", () => {
	assert.equal(maskNodeUrl("https://srv.example.com:18787"), "https://***.example.com:18787");
	assert.equal(maskNodeUrl("http://127.0.0.1:8080"), "http://127.0.0.***:8080");
	assert.equal(maskNodeUrl("https://a.example:443"), "https://***.example"); // 默认端口省略
	assert.equal(maskNodeUrl("not a url"), "not a url");
	assert.equal(maskNodeUrl(null), "-");
});

test("fmtDate: local YYYY-MM-DD", () => {
	const d = new Date(2026, 8, 23, 10, 0, 0); // 9 月 23 日本地
	assert.equal(fmtDate(d.getTime()), "2026-09-23");
	assert.equal(fmtDate(NaN), "-");
});

// ---- 业务路径契约（r2-P1-2：业务仅 /api/*；本地控制面仅 /sidecar/{state,connect,nodes*}） ----

test("path contract: every business call goes through /api/* only", async () => {
	const paths = [];
	setApiFetch(async (path, init) => {
		paths.push({ path, method: init?.method ?? "GET" });
		return new Response(JSON.stringify({ knocks: [], pending_count: 0, visitors: [], codes: [], blocklist: [], owners: [], generation: 1 }), { status: 200 });
	});
	const fabric = "11".repeat(32);
	const root = "22".repeat(32);
	const endpoint = "33".repeat(32);
	const hash = "cd".repeat(32);
	await Promise.all([
		loadKnocks(),
		dismissKnock(endpoint),
		undismissKnock(endpoint),
		loadVisitors(),
		grantVisitor({ endpoint_id: endpoint }),
		grantVisitorFromKnock({ endpoint_id: endpoint }),
		revokeVisitor(endpoint),
		loadCodes(),
		issueCode({}),
		revokeCode(hash),
		registerOwner(fabric, root),
		renewOwner(fabric, root, { expires_in_days: 30 }),
		renewOwner(fabric, root, { permanent: true }),
		loadBlocklist(),
		addBlocklist({ kind: "endpoint", id: endpoint }),
		removeBlocklist("endpoint", endpoint),
	]);
	// 业务面：全部 /api/* 且方法属白名单 GET/POST/DELETE
	assert.ok(paths.length >= 16);
	for (const p of paths) {
		assert.ok(p.path.startsWith("/api/"), `business path must be /api/*: ${p.path}`);
		assert.ok(["GET", "POST", "DELETE"].includes(p.method), `method whitelist: ${p.method}`);
	}
	const expected = [
		"/api/knocks",
		`/api/knocks/${endpoint}/dismiss`,
		`/api/knocks/${endpoint}/undismiss`,
		"/api/visitors",
		"/api/visitors",
		"/api/visitors/from-knock",
		`/api/visitors/${endpoint}`,
		"/api/codes",
		"/api/codes",
		`/api/codes/${hash}`,
		"/api/owners",
		`/api/owners/${fabric}/${root}/renew`,
		`/api/owners/${fabric}/${root}/renew`,
		"/api/blocklist",
		"/api/blocklist",
		`/api/blocklist/endpoint/${endpoint}`,
	];
	for (const p of expected) {
		assert.ok(paths.some((x) => x.path === p), `missing expected call ${p}`);
	}
});

test("path contract: local control plane stays on /sidecar/{state,connect,nodes*}", async () => {
	const paths = [];
	setApiFetch(async (path, init) => {
		paths.push(path);
		return new Response(JSON.stringify({ phase: "ready", nodes: [], ok: true, node: {} }), { status: 200 });
	});
	await Promise.all([
		fetchSidecarState(),
		postConnect({ pairing_code: "X", server: "s", token: "t" }),
		fetchSidecarNodes(),
		addSidecarNode({ pairing_code: "X", server: "s", token: "t" }),
		switchSidecarNode("n1"),
		deleteSidecarNode("n1"),
	]);
	for (const p of paths) {
		assert.ok(
			p === "/sidecar/state" || p === "/sidecar/connect" || p === "/sidecar/nodes" || p.startsWith("/sidecar/nodes/"),
			`control plane path out of contract: ${p}`,
		);
	}
	assert.ok(paths.includes("/sidecar/nodes/switch"));
	assert.equal(paths.length, 6);
});

// ---- apiFetch 注入矩阵扩展（新端点错误语义与既有六路同构） ------------------------------

test("apiFetch matrix: knock/code errors flow through the injectable layer unchanged", async () => {
	const rejected = (p) =>
		p.then(
			() => {
				throw new Error("expected rejection");
			},
			(e) => e,
		);
	setApiFetch(async () => new Response(JSON.stringify({ error: { code: "code-exhausted", message: "x" } }), { status: 409 }));
	const exhausted = await rejected(loadCodes());
	assert.ok(exhausted instanceof AdminError);
	assert.equal(exhausted.code, "code-exhausted");
	assert.equal(exhausted.status, 409);

	setApiFetch(async () => new Response(JSON.stringify({ error: { code: "no-match", message: "x" } }), { status: 404 }));
	const noMatch = await rejected(dismissKnock("ff".repeat(32)));
	assert.equal(noMatch.code, "no-match");

	setApiFetch(async () => new Response("", { status: 502 }));
	const bare = await rejected(loadKnocks());
	assert.equal(bare.code, "http-502");

	setApiFetch(async () => {
		throw new TypeError("fetch failed");
	});
	const network = await rejected(loadVisitors());
	assert.equal(network.code, "network");
});
