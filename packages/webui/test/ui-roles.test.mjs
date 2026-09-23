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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
	loadOwners,
	loadVisitors,
	patchOwnerMeta,
	patchVisitorMeta,
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
import {
	aliasByteLength,
	aliasDuplicateWarning,
	aliasEditError,
	aliasEditSubmit,
	aliasTargetKey,
	codeDeniedBadge,
	codeStatus,
	knockReasonLabel,
	maskNodeUrl,
	multiRootFabrics,
	rosterNote,
} from "../ui/src/lib/terms.ts";

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
		patchOwnerMeta(fabric, root, { alias: "李四团队" }),
		patchOwnerMeta(fabric, root, { alias: "" }), // 空串=清除别名
		patchVisitorMeta(endpoint, { alias: "张三的设备" }),
		loadBlocklist(),
		addBlocklist({ kind: "endpoint", id: endpoint }),
		removeBlocklist("endpoint", endpoint),
	]);
	// 业务面：全部 /api/* 且方法属白名单 GET/POST/DELETE/PATCH（PATCH 为 1c 元数据编辑增量）
	assert.ok(paths.length >= 19);
	for (const p of paths) {
		assert.ok(p.path.startsWith("/api/"), `business path must be /api/*: ${p.path}`);
		assert.ok(["GET", "POST", "DELETE", "PATCH"].includes(p.method), `method whitelist: ${p.method}`);
	}
	const expected = [
		"/api/knocks",
		`/api/knocks/${endpoint}/dismiss`,
		`/api/knocks/${endpoint}/undismiss`,
		"/api/visitors",
		"/api/visitors",
		"/api/visitors/from-knock",
		`/api/visitors/${endpoint}`,
		`/api/visitors/${endpoint}`, // PATCH 元数据（与 DELETE 同路径、方法不同）
		"/api/codes",
		"/api/codes",
		`/api/codes/${hash}`,
		"/api/owners",
		`/api/owners/${fabric}/${root}/renew`,
		`/api/owners/${fabric}/${root}/renew`,
		`/api/owners/${fabric}/${root}`, // PATCH 元数据
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

// ---- 别名行内编辑（Phase 1c 接线：PM §4.5 流 E → PATCH owner-meta/visitor-meta） -------

test("aliasByteLength/aliasEditError: UTF-8 byte counting with the frozen 32-byte cap", () => {
	assert.equal(aliasByteLength(""), 0);
	assert.equal(aliasByteLength("abcd"), 4);
	assert.equal(aliasByteLength("李四团队"), 12); // 汉字 3 字节 × 4
	assert.equal(aliasEditError("a".repeat(32)), null); // 32 字节恰好合法
	assert.equal(aliasEditError("李".repeat(10)), null); // 30 字节合法
	assert.equal(aliasEditError("a".repeat(33)) !== null, true); // 33 字节超限
	assert.equal(aliasEditError("李".repeat(11)) !== null, true); // 33 字节（混合文字同理）
	assert.match(aliasEditError("李".repeat(11)), /32 字节（当前 33 字节）/);
	assert.equal(aliasEditError("  "), null); // 首尾空白剥除后计字节（内部 trim）
});

test("aliasEditSubmit: trim-then-save; unchanged=no-op; clearing an existing alias asks first", () => {
	// 常规保存：首尾空白剥除后提交
	assert.deepEqual(aliasEditSubmit("  李四团队  ", ""), { action: "save", value: "李四团队" });
	assert.deepEqual(aliasEditSubmit("张三团队", "李四"), { action: "save", value: "张三团队" });
	assert.deepEqual(aliasEditSubmit("a".repeat(32), ""), { action: "save", value: "a".repeat(32) });
	// 与编辑前等值（含双方皆空白）＝无操作，不发请求
	assert.deepEqual(aliasEditSubmit(" 李四 ", "李四"), { action: "cancel" });
	assert.deepEqual(aliasEditSubmit("", ""), { action: "cancel" });
	assert.deepEqual(aliasEditSubmit("   ", "  "), { action: "cancel" });
	// 清空已有别名＝先二次确认，确认后 PATCH body {"alias":""}（空串=清除）
	assert.deepEqual(aliasEditSubmit("", "李四"), { action: "confirm-clear" });
	assert.deepEqual(aliasEditSubmit("   ", "李四"), { action: "confirm-clear" });
	// 超限＝错误裁决（消息透传给行内错误提示），不发请求
	assert.equal(aliasEditSubmit("a".repeat(33), "").action, "error");
});

test("aliasTargetKey: row matching key (owner=fabric/root pair, visitor=endpoint)", () => {
	assert.equal(aliasTargetKey({ kind: "owner", fabricId: "aa", root: "bb" }), "aa/bb");
	assert.equal(aliasTargetKey({ kind: "visitor", endpointId: "cc" }), "cc");
});

test("alias PATCH wiring: owner/visitor meta via /api/* with JSON body; empty alias string clears", async () => {
	const calls = [];
	setApiFetch(async (path, init) => {
		calls.push({ path, method: init?.method ?? "GET", body: init?.body ?? null });
		return new Response(JSON.stringify({ op: "owner-meta", ts: 1, generation: 2, receipt_sig: "x" }), { status: 200 });
	});
	const fabric = "11".repeat(32);
	const root = "22".repeat(32);
	const endpoint = "33".repeat(32);
	await patchOwnerMeta(fabric, root, { alias: "李四团队" });
	await patchOwnerMeta(fabric, root, { alias: "" }); // 清除
	await patchVisitorMeta(endpoint, { alias: "张三的设备" });
	assert.deepEqual(
		calls.map((c) => `${c.method} ${c.path}`),
		[
			`PATCH /api/owners/${fabric}/${root}`,
			`PATCH /api/owners/${fabric}/${root}`,
			`PATCH /api/visitors/${endpoint}`,
		],
	);
	assert.deepEqual(
		calls.map((c) => JSON.parse(c.body)),
		[{ alias: "李四团队" }, { alias: "" }, { alias: "张三的设备" }],
	);
});

test("alias PATCH failure: envelope error normalizes to AdminError (existing error-state path)", async () => {
	const rejected = (p) =>
		p.then(
			() => {
				throw new Error("expected rejection");
			},
			(e) => e,
		);
	// 超限 400 invalid-request（服务端 roles.rs ALIAS_MAX_BYTES 同源校验）
	setApiFetch(async () => new Response(JSON.stringify({ error: { code: "invalid-request", message: "alias too long" } }), { status: 400 }));
	const tooLong = await rejected(patchVisitorMeta("33".repeat(32), { alias: "x".repeat(33) }));
	assert.ok(tooLong instanceof AdminError);
	assert.equal(tooLong.code, "invalid-request");
	assert.equal(tooLong.status, 400);
	// 目标不在名册 404 no-match（与 disconnect/knock 判定一致的既有语义）
	setApiFetch(async () => new Response(JSON.stringify({ error: { code: "no-match", message: "x" } }), { status: 404 }));
	const noMatch = await rejected(patchOwnerMeta("11".repeat(32), "22".repeat(32), { alias: "" }));
	assert.equal(noMatch.code, "no-match");
	assert.equal(noMatch.status, 404);
});

// ---- 邀请码 denied 投影（Phase 1c：deny-set 运维徽章，与四态并列不占位） ------------------

test("codeDeniedBadge: deny-set ops projection renders 「暂不可兑」 without touching the four states", () => {
	assert.equal(codeDeniedBadge({ denied: false }), null);
	assert.equal(codeDeniedBadge({}), null); // 旧服务端无此字段＝无徽章（未知字段忽略）
	assert.equal(codeDeniedBadge({ denied: null }), null);
	const badge = codeDeniedBadge({ denied: true });
	assert.equal(badge.label, "暂不可兑");
	assert.ok(badge.title.includes("服务端故障保护"));
	// 四态机与 denied 正交：denied+可用仍是「待使用」（徽章并列呈现由组件承担）
	assert.deepEqual(codeStatus({ used_count: 0, max_uses: 1, expires_at: Date.now() + 1_000, denied: true }), {
		status: "available",
		label: "待使用",
	});
	assert.deepEqual(codeStatus({ used_count: 1, max_uses: 1, expires_at: Date.now() + 1_000, revoked: true, denied: true }), {
		status: "revoked",
		label: "已吊销",
	});
});

// ---- 视觉走查修复（P0/P1/P2）：blocklist wire 键 / note 呈现 / 同名警示 / 源级宽度断言 ------

test("blocklist wire: UI reads the server's entries key (roles.rs BlocklistList), not blocklist (P0)", async () => {
	// 与 roles.rs BlocklistList 同拍的真实 wire 形态（generation + entries）
	const wire = {
		generation: 25,
		entries: [
			{ kind: "endpoint", id: "ab".repeat(32), reason: "恶意扫描", ts: 1_750_000_000_000 },
			{ kind: "fabric", id: "cd".repeat(32), ts: 1_750_000_100_000 },
		],
	};
	setApiFetch(async () => new Response(JSON.stringify(wire), { status: 200 }));
	const data = await loadBlocklist();
	assert.ok(Array.isArray(data.entries), "loadBlocklist 必须读服务端实际返回的 entries 键");
	assert.equal(data.entries.length, 2);
	assert.equal(data.entries[0].kind, "endpoint");
	assert.equal(data.entries[0].reason, "恶意扫描");
	assert.equal(data.entries[1].kind, "fabric");
	assert.equal(data.entries[1].reason, undefined, "reason 缺省不落（serde skip_serializing_if）");
	assert.equal(data.generation, 25);
	assert.equal("blocklist" in data, false, "wire 上不存在 blocklist 键——旧读取面已死");
});

test("list wire cross-check: every roster/list endpoint reads the key the server actually sends", async () => {
	// 五个列表端点的容器键逐一与 server handler 对拍（owners/visitors/knocks/codes=同名；
	// blocklist=entries——防同类键名漂移）。fixture 刻意携带诱饵旧键。
	const fabric = "11".repeat(32);
	const root = "22".repeat(32);
	const endpoint = "33".repeat(32);
	const fixtures = {
		"/api/owners": { generation: 3, owners: [{ fabric_id: fabric, root, registered_at: 1 }] },
		"/api/visitors": { generation: 4, visitors: [{ endpoint_id: endpoint, granted_at: 1 }] },
		"/api/knocks": { knocks: [{ endpoint_id: endpoint, seq: 1, first_at: 1, last_at: 1, count: 1, last_reason: "x" }], pending_count: 1 },
		"/api/codes": { generation: 5, codes: [{ code_hash: "cd".repeat(32), max_uses: 1, used_count: 0, expires_at: 9e15, revoked: false }] },
		"/api/blocklist": { generation: 6, entries: [{ kind: "endpoint", id: endpoint, ts: 1 }] },
	};
	setApiFetch(async (p) => new Response(JSON.stringify(fixtures[p]), { status: 200 }));
	const owners = await loadOwners();
	const visitors = await loadVisitors();
	const knocks = await loadKnocks();
	const codes = await loadCodes();
	const blocks = await loadBlocklist();
	assert.equal(owners.owners.length, 1, "owners 键");
	assert.equal(visitors.visitors.length, 1, "visitors 键");
	assert.equal(knocks.knocks.length, 1, "knocks 键");
	assert.equal(knocks.pending_count, 1);
	assert.equal(codes.codes.length, 1, "codes 键");
	assert.equal(blocks.entries.length, 1, "blocklist=entries 键");
});

test("rosterNote: trimmed note or null——空白/null 不渲染名册行 note（P1 note 呈现）", () => {
	assert.equal(rosterNote("长期合作伙伴"), "长期合作伙伴");
	assert.equal(rosterNote("  临时访客  "), "临时访客");
	assert.equal(rosterNote(""), null);
	assert.equal(rosterNote("   "), null);
	assert.equal(rosterNote(null), null);
	assert.equal(rosterNote(undefined), null);
});

test("aliasDuplicateWarning: PM §4.5 步 3 成品文案；空值/唯一/空白别名不警示；不阻止保存", () => {
	// 命中：名册其他行已有同名（trim 对齐）
	const msg = aliasDuplicateWarning(" 李四团队 ", ["王五", "李四团队"], "ab12***cd34");
	assert.match(msg, /名册里已有同名「李四团队」——别名可以重复，身份以缩写为准，请核对 \(ab12\*\*\*cd34\)。/);
	// 不命中：唯一名 / 空输入 / 空白输入 / 其他行别名为空或空白
	assert.equal(aliasDuplicateWarning("王五", ["李四团队"], "ab12***cd34"), null);
	assert.equal(aliasDuplicateWarning("", ["李四团队"], "ab12***cd34"), null);
	assert.equal(aliasDuplicateWarning("   ", ["李四团队"], "ab12***cd34"), null);
	assert.equal(aliasDuplicateWarning("李四团队", [null, undefined, "  "], "ab12***cd34"), null);
	// 同名判定 trim 对齐（其他行别名带首尾空白也算同名）
	assert.notEqual(aliasDuplicateWarning("李四团队", ["  李四团队  "], "ab12***cd34"), null);
	// 警示非错误：不参与提交禁用（aliasEditSubmit 不受其影响——同值/常规保存语义不变）
	assert.deepEqual(aliasEditSubmit("李四团队", ""), { action: "save", value: "李四团队" });
	assert.equal(aliasEditError("李四团队"), null);
});

// 源级回归断言（视觉走查 P1/P2：组件无 DOM 测试面，冻结关键类/结构防回归）

const UI_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "src");

test("source regression: roster table width convergence + sticky action column (P1)", () => {
	const src = readFileSync(path.join(UI_SRC, "components", "TenantsView.svelte"), "utf8");
	// 动作列 sticky 常显——溢出时「续期/注销」仍可见且不参与滚动
	assert.ok(src.includes('class="sticky right-0 z-10 bg-card transition-colors group-hover/row:bg-muted/50"'), "动作列须 sticky 常显并同步 hover 底色");
	assert.ok(src.includes('class="sticky right-0 z-10 bg-card"'), "动作列表头须 sticky 常显");
	// 身份/时间列解除 nowrap 继承——窄屏降级换行而非横向溢出
	assert.ok(src.includes('<Table.Cell class="whitespace-normal">'), "身份/状态列须 whitespace-normal");
	assert.ok(src.includes('<Table.Cell class="whitespace-normal text-muted-foreground">'), "注册时间列须 whitespace-normal");
	// 双格式仍为两段各自 nowrap（日期段 + 相对时段），只是段间可换行
	assert.ok(src.includes("{fmtLocal(o.registered_at)}"));
	assert.ok(src.includes("（{relativeTime(o.registered_at)}）"));
	// note 次要文本：title 全文 + truncate 截断
	assert.ok(src.includes("rosterNote(o.note)"), "租户行须消费 note");
	assert.ok(/class="max-w-md truncate text-xs text-muted-foreground" title=\{note\}/.test(src), "note 呈现须 title 全文+截断");
	// 侧栏表单并排栅格推至 2xl——1280–1535 档名册占满整行不再被挤到 ~600px
	assert.ok(src.includes("2xl:grid-cols-[minmax(0,1fr)_360px]"));
});

test("source regression: visitors note render / single-alias render / online header / nodebook casing (P0/P2)", () => {
	const visitors = readFileSync(path.join(UI_SRC, "components", "VisitorsView.svelte"), "utf8");
	// 黑名单读 entries（P0 修复面）
	assert.ok(visitors.includes("cs.blocklistData?.entries"), "黑名单必须读 wire 的 entries 键");
	// 访客行 note 呈现 + 别名单一呈现（HexValue 不再重复渲染别名）
	assert.ok(visitors.includes("rosterNote(v.note)"), "访客行须消费 note");
	assert.ok(/<HexValue value=\{v\.endpoint_id\} kind="端点" \/>/.test(visitors), "HexValue 不带 alias——别名只由 AliasInlineEdit 呈现一次");
	assert.ok(/<AliasInlineEdit[\s\S]*?abbr=\{shortHex\(v\.endpoint_id\)\}/.test(visitors), "访客行内编辑须携带缩写（同名警示锚点）");

	const online = readFileSync(path.join(UI_SRC, "components", "OnlineView.svelte"), "utf8");
	assert.ok(online.includes("<h2"), "#/online 须有页头");
	assert.ok(/<p class="py-6 text-sm text-muted-foreground" data-empty="endpoints">/.test(online), "按端点空态为左对齐纯文本（与另两组一致）");

	const nodebook = readFileSync(path.join(UI_SRC, "components", "NodeBook.svelte"), "utf8");
	assert.ok(!nodebook.includes("uppercase"), "节点簿输入不做 CSS 大写化（终端命令大小写敏感）");

	const alias = readFileSync(path.join(UI_SRC, "components", "AliasInlineEdit.svelte"), "utf8");
	assert.ok(alias.includes("data-alias-dup"), "行内编辑须呈现同名警示");
	assert.ok(alias.includes('role="status"'), "警示为非阻断 status（不阻止保存）");
});
