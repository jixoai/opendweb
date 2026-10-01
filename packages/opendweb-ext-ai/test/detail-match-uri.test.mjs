// detail 脱敏单测（ai-fly test/unit/provider/detail.test.ts 矩阵移植）+
// match-pattern / uri-template（同上游矩阵移植）。

import test from "node:test";
import assert from "node:assert/strict";
import { buildServiceDetail, buildServiceEntry, detailDisplayLines } from "../src/provider/detail.mjs";
import { compileMatchPattern, matchRequestPath, normalizeMatchPatternSyntax } from "../src/provider/match-pattern.mjs";
import { expandUriTemplate, validateUriTemplate, UriTemplateError } from "../src/provider/uri-template.mjs";

const MASK = "\u25cf";

test("detail: auth 三族整值掩码（secret 名/script 绑定/literal 值不出网；bearer 可见）", () => {
  const d1 = buildServiceDetail({ upstream: "https://x", match: [{ type: "exact", value: "x" }], auth: { secret: "openai", bearer: false } });
  assert.deepEqual(d1.auth, { secret: MASK, bearer: false });
  const d2 = buildServiceDetail({ upstream: "https://x", match: [{ type: "exact", value: "x" }], auth: { script: "file", args: { path: "~/a.json" } } });
  assert.deepEqual(d2.auth, { script: MASK });
  assert.equal("args" in d2.auth, false);
  const d3 = buildServiceDetail({ upstream: "https://x", match: [{ type: "exact", value: "x" }], auth: { literal: "Bearer sk-1" } });
  assert.deepEqual(d3.auth, { literal: MASK });
});

test("detail: headers.set 引用型值整体掩码、纯字面量原样；脚本/request/response/hooks 位掩码", () => {
  const d = buildServiceDetail({
    upstream: "https://x",
    match: [{ type: "exact", value: "x" }],
    headers: {
      remove: ["x-del"],
      set: { "x-lit": "plain", "x-sec": "$secret:openai", "x-env": "$env:MY_KEY" },
      script: { name: "hdr" },
    },
    request: { script: "req" },
    response: { script: "resp" },
    hooks: { script: "codex" },
  });
  assert.deepEqual(d.headers.set, { "x-lit": "plain", "x-sec": MASK, "x-env": MASK });
  assert.deepEqual(d.headers.remove, ["x-del"]);
  assert.deepEqual(d.headers.script, { name: MASK });
  assert.deepEqual(d.request, { script: MASK });
  assert.deepEqual(d.response, { script: MASK });
  assert.deepEqual(d.hooks, { script: MASK });
});

test("detail: upstream/match/routes/rewrite 原样披露；ServiceEntry 形状", () => {
  const entry = buildServiceEntry({
    serviceId: "abc",
    name: "svc",
    upstream: "https://api.example.com/v1",
    match: [{ type: "suffix", value: ".example.com" }],
    defaultPort: 4300,
    rewrite: { host: "api.example.com", pathPrefixStrip: "/v1" },
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
  });
  assert.deepEqual(Object.keys(entry), ["serviceId", "name", "match", "defaultPort", "detail"]);
  assert.equal(entry.detail.upstream, "https://api.example.com/v1");
  assert.deepEqual(entry.detail.rewrite, { host: "api.example.com", prefix: "strip:/v1" });
  assert.deepEqual(entry.detail.routes, [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }]);
  const lines = detailDisplayLines(entry.detail);
  assert.ok(lines.some((l) => l === "upstream: https://api.example.com/v1"));
  assert.ok(lines.some((l) => l === "route: /v1 -> /v1 (openai-chat)"));
  assert.ok(!JSON.stringify(entry).includes("$secret"));
});

// ---------------------------------------------------------------------------
// match-pattern
// ---------------------------------------------------------------------------

test("match-pattern: {name} 花括号翻译为 :name；捕获组提取", () => {
  assert.equal(normalizeMatchPatternSyntax("/v1/{model}/x"), "/v1/:model/x");
  const pattern = compileMatchPattern("/v1/:model/:thread");
  assert.deepEqual(matchRequestPath(pattern, "/v1/gpt-4/t1", ""), { model: "gpt-4", thread: "t1" });
  assert.equal(matchRequestPath(pattern, "/v2/gpt-4", ""), null);
  // 缓存命中（同实例）
  assert.equal(compileMatchPattern("/v1/:model/:thread"), pattern);
});

test("match-pattern: 查询串参与 exec；非法 pattern 抛 MatchPatternError", () => {
  const pattern = compileMatchPattern("/x/:id");
  assert.deepEqual(matchRequestPath(pattern, "/x/1", "q=2"), { id: "1" });
  assert.throws(() => compileMatchPattern(":"), Error); // URLPattern 语法错误（Ada）
});

// ---------------------------------------------------------------------------
// uri-template（RFC 6570 Level 1-2 子集）
// ---------------------------------------------------------------------------

test("uri-template: 操作符族展开", () => {
  const vars = { id: "a b", tag: "x/y", empty: "", missing: undefined };
  assert.equal(expandUriTemplate("/r/{id}", vars), "/r/a%20b");
  assert.equal(expandUriTemplate("/r/{+tag}", vars), "/r/x/y");
  assert.equal(expandUriTemplate("/r{.id}", vars), "/r.a%20b");
  assert.equal(expandUriTemplate("/r{/tag}", vars), "/r/x%2Fy"); // "/" 非保留集字符仅 {+}/{#} 放行
  assert.equal(expandUriTemplate("/r{?id}", vars), "/r?id=a%20b");
  assert.equal(expandUriTemplate("/r{&tag}", vars), "/r&tag=x%2Fy");
  assert.equal(expandUriTemplate("/r{#tag}", vars), "/r#x/y");
  assert.equal(expandUriTemplate("/r{;id}", vars), "/r;id=a%20b");
  // 未定义/空值变量按规范省略（单值语义——ai-fly 同拍：空串与未定义同跳过）
  assert.equal(expandUriTemplate("/r{?empty}{&missing}", vars), "/r");
  assert.equal(expandUriTemplate("/r/{empty}", vars), "/r/");
});

test("uri-template: 校验——非配对花括号/非法变量名抛错；修饰符剥除", () => {
  assert.throws(() => validateUriTemplate("/r/{"), UriTemplateError);
  assert.throws(() => validateUriTemplate("/r/{bad-name}"), UriTemplateError);
  validateUriTemplate("/r/{id:3}{list*}"); // prefix/explode 修饰符合法（单值语义）
  assert.equal(expandUriTemplate("/r/{id:3}", { id: "abcdef" }), "/r/abcdef"); // prefix 按单值处理
});
