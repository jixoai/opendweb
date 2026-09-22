// target.mjs 守卫矩阵（webui-console A.8 / design §2.3）。
// 覆盖：绝对 http(s)/scheme/credentials/query、raw 路径防线（dot-segment/
// 编码分隔符/反斜杠/空段/路径前缀）、字面 loopback（127/8、::1、
// IPv4-mapped 两种书写）、localhost 全记录校验、混合记录拒、DNS 解析失败
// 拒、rebinding（连接材料冻结为解析 IP + SNI + Host 序列化）、默认端口
// 填充与 Host header 序列化、--allow-insecure 仅放宽加密判断。
import test from "node:test";
import assert from "node:assert/strict";
import { validateTarget } from "../src/target.mjs";
import { fakeDns } from "./helpers.mjs";

const loopbackRecords = [
  { address: "127.0.0.1", family: 4 },
  { address: "::1", family: 6 },
];
const mixedRecords = [
  { address: "127.0.0.1", family: 4 },
  { address: "192.0.2.1", family: 4 },
];
const publicRecords = [{ address: "203.0.113.10", family: 4 }];

test("accepts absolute http(s) with literal loopback hosts (no DNS)", async () => {
  for (const url of [
    "http://127.0.0.1:18787",
    "http://127.202.31.4:80", // 127.0.0.0/8 全段
    "http://[::1]:18787",
    "http://[::ffff:127.0.0.1]:18787", // dotted 映射形
    "http://[::1]",
    "https://127.0.0.1:9443",
  ]) {
    const dns = fakeDns({});
    const r = await validateTarget(url, { dns });
    assert.ok(r.ok, `${url}: ${r.ok ? "" : r.error}`);
    assert.equal(dns.calls.length, 0, "literal IP must not hit DNS");
    if (url.startsWith("http://[::1]") || url.includes("[::ffff:")) {
      assert.ok(r.value.hostHeader.includes("["), "IPv6 host header must be bracketed");
    }
  }
});

test("fills default ports 80/443 and serializes Host header canonically", async () => {
  const a = await validateTarget("http://127.0.0.1");
  assert.ok(a.ok);
  assert.equal(a.value.port, 80);
  assert.equal(a.value.hostHeader, "127.0.0.1"); // 默认端口省略
  const b = await validateTarget("http://127.0.0.1:80");
  assert.ok(b.ok);
  assert.equal(b.value.hostHeader, "127.0.0.1");
  const c = await validateTarget("http://127.0.0.1:18787");
  assert.ok(c.ok);
  assert.equal(c.value.hostHeader, "127.0.0.1:18787");
  const d = await validateTarget("http://[::1]:18787");
  assert.ok(d.ok);
  assert.equal(d.value.hostHeader, "[::1]:18787");
});

test("rejects non-URL, non-http(s), credentials, query, fragment", async () => {
  for (const url of ["", "not a url", "ftp://127.0.0.1", "//127.0.0.1", "127.0.0.1:18787", "/admin"]) {
    const r = await validateTarget(url);
    assert.ok(!r.ok, url);
  }
  assert.ok(!(await validateTarget("http://user:pass@127.0.0.1:18787")).ok, "userinfo rejected");
  assert.ok(!(await validateTarget("http://127.0.0.1:18787?x=1")).ok, "query rejected");
  assert.ok(!(await validateTarget("http://127.0.0.1:18787#frag")).ok, "fragment rejected");
});

test("raw path defenses (dot-segment / encoded separators / backslash / empty segments / prefix)", async () => {
  const cases = [
    ["http://127.0.0.1:18787/..", "dot segment"],
    ["http://127.0.0.1:18787/a/../b", "dot segment"],
    ["http://127.0.0.1:18787/%2e%2e/b", "encoded dot"],
    ["http://127.0.0.1:18787/%2E%2E/b", "encoded dot uppercase"],
    ["http://127.0.0.1:18787/a%2fb", "encoded slash"],
    ["http://127.0.0.1:18787/a%5Cb", "encoded backslash"],
    ["http://127.0.0.1:18787/a\\b", "raw backslash"],
    ["http://127.0.0.1:18787/a//b", "empty segment"],
    ["http://127.0.0.1:18787/admin", "path prefix"],
    ["http://127.0.0.1:18787/admin/", "trailing slash with segments"],
    ["http://127.0.0.1:18787\\x", "backslash in authority position"],
  ];
  for (const [url] of cases) {
    const r = await validateTarget(url);
    assert.ok(!r.ok, `${url} must be rejected (got value)`);
    assert.equal(typeof r.error, "string");
  }
  // 根路径的尾斜杠即根本身（URL 规范化语义）——接受是安全且正确的
  const root = await validateTarget("http://127.0.0.1:18787/");
  assert.ok(root.ok, root.error);
});

test("localhost literal goes through full-record DNS check (all-loopback passes)", async () => {
  const dns = fakeDns({ localhost: ["127.0.0.1", "::1"] });
  const r = await validateTarget("http://localhost:18787", { dns });
  assert.ok(r.ok, r.error);
  assert.equal(dns.calls.length, 1);
  assert.deepEqual(dns.calls[0].opts, { all: true });
  assert.equal(r.value.connectHost, "127.0.0.1", "connects by resolved IP (rebinding freeze)");
});

test("localhost with mixed records is rejected as non-loopback", async () => {
  const r = await validateTarget("http://localhost:18787", { dns: fakeDns({ localhost: ["127.0.0.1", "192.0.2.1"] }) });
  assert.ok(!r.ok);
  assert.match(r.error, /--allow-insecure/);
});

test("DNS failure rejects (treated as non-loopback)", async () => {
  const r = await validateTarget("http://nosuchhost.invalid:18787", { dns: fakeDns({}, { fail: new Set(["nosuchhost.invalid"]) }) });
  assert.ok(!r.ok);
  assert.match(r.error, /cannot resolve/);
});

test("plaintext public hostname rejected without --allow-insecure, allowed with it (crypto-only relaxation)", async () => {
  const dns = fakeDns({ "attacker.example": ["203.0.113.10"] });
  const rejected = await validateTarget("http://attacker.example:18787", { dns });
  assert.ok(!rejected.ok);
  assert.match(rejected.error, /plaintext http to a non-loopback host/);
  const allowed = await validateTarget("http://attacker.example:18787", { allowInsecure: true, dns });
  assert.ok(allowed.ok);
  assert.equal(allowed.value.insecure, true);
  assert.equal(allowed.value.connectHost, "203.0.113.10", "frozen resolved IP");
  // allow-insecure 不放宽目标/路径校验：坏路径在 flag 下仍拒，且错误是路径语义
  const badPath = await validateTarget("http://attacker.example/../x", { allowInsecure: true, dns: fakeDns({ "attacker.example": ["203.0.113.10"] }) });
  assert.ok(!badPath.ok);
  assert.match(badPath.error, /dot segment/);
  const badScheme = await validateTarget("ftp://attacker.example", { allowInsecure: true, dns });
  assert.ok(!badScheme.ok);
});

test("https has no IP restriction but still freezes resolved IP + SNI", async () => {
  const dns = fakeDns({ "srv.example": ["93.184.216.34", "2001:db8::1"] });
  const r = await validateTarget("https://srv.example:18787", { dns });
  assert.ok(r.ok, r.error);
  assert.equal(r.value.servername, "srv.example", "SNI keeps original hostname");
  assert.equal(r.value.connectHost, "93.184.216.34", "connects by first resolved record");
  assert.equal(r.value.hostHeader, "srv.example:18787");
  assert.equal(r.value.insecure, false);
});

test("literal-IP https target has no SNI (RFC 6066 forbids IP in SNI)", async () => {
  const r = await validateTarget("https://127.0.0.1:9443");
  assert.ok(r.ok);
  assert.equal(r.value.servername, null);
  assert.equal(r.value.connectHost, "127.0.0.1");
});

test("IPv4-mapped loopback in hex form passes; hostname normalization (case, trailing dot)", async () => {
  const mapped = await validateTarget("http://[::ffff:7f00:1]:18787");
  assert.ok(mapped.ok, mapped.error);
  const upper = await validateTarget("http://LOCALHOST:18787", { dns: fakeDns({ localhost: ["127.0.0.1"] }) });
  assert.ok(upper.ok, upper.error); // URL 小写化后命中 localhost 全记录校验
  const dotted = await validateTarget("http://localhost.:18787", { dns: fakeDns({ localhost: ["::1"] }) });
  assert.ok(dotted.ok, dotted.error); // 尾点剥除后判定
});

test("zone-id addresses are rejected", async () => {
  // WHATWG URL 直接拒（Invalid URL）——守卫按「必须绝对 http(s)」口径拒
  const r = await validateTarget("http://[fe80::1%25eth0]:18787");
  assert.ok(!r.ok);
});

test("public literal IP rejected without --allow-insecure (spec scenario wire)", async () => {
  const r = await validateTarget("http://203.0.113.10:18787");
  assert.ok(!r.ok);
  assert.match(r.error, /--allow-insecure/);
  const ok = await validateTarget("http://203.0.113.10:18787", { allowInsecure: true });
  assert.ok(ok.ok);
  assert.equal(ok.value.insecure, true);
});

test("mixed-record DNS for arbitrary hostname rejected (rebinding surface)", async () => {
  const r = await validateTarget("http://mixed.example:18787", { dns: fakeDns({ "mixed.example": ["127.0.0.1", "203.0.113.9"] }) });
  assert.ok(!r.ok);
  assert.match(r.error, /--allow-insecure/);
});

test("error strings stay ASCII and never echo the raw URL", async () => {
  const r = await validateTarget("http://203.0.113.10:18787/..?token=sekret");
  assert.ok(!r.ok);
  assert.ok(!r.error.includes("sekret"), "error must not echo URL content");
  for (const ch of r.error) {
    assert.ok(ch >= "\x20" && ch <= "\x7e", `non-ascii char in error: ${JSON.stringify(ch)}`);
  }
});

test("loopbackRecords helper sanity: full v6 expansion of ::1 accepted via DNS path", async () => {
  // DNS 返回展开形 ::1 记录也须判 loopback
  const r = await validateTarget("http://expanded.example:18787", {
    dns: fakeDns({ "expanded.example": ["0:0:0:0:0:0:0:1"] }),
  });
  assert.ok(r.ok, r.error);
});
