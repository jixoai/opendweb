// .opendweb-ignore 行 glob 测试（提供侧语义冻结——见 src/ignore.mjs 模块头）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { isIgnored, parseIgnoreRules } from "../src/ignore.mjs";

/** 便捷：文本 → 是否忽略 */
function ignored(text, comps, entry) {
  return isIgnored(parseIgnoreRules(text), comps, entry);
}

test("empty lines and # comments are skipped", () => {
  assert.deepEqual(parseIgnoreRules("\n\n  \n# comment\n"), []);
  assert.equal(ignored("# nothing\n", ["a"]), false);
});

test("bare name pattern matches at any depth (gitignore-like)", () => {
  const rules = parseIgnoreRules("node_modules\n");
  assert.equal(ignored("node_modules\n", ["node_modules"], { isDir: true }), true);
  assert.equal(ignored("node_modules\n", ["docs", "node_modules"], { isDir: true }), true);
  assert.equal(ignored("node_modules\n", ["docs", "node_modules", "x.txt"]), true, "目录命中即忽略其内容");
  assert.equal(ignored("node_modules\n", ["docs"]), false);
});

test("anchored (slash-containing) patterns match from root only", () => {
  assert.equal(ignored("/secret.txt\n", ["secret.txt"]), true);
  assert.equal(ignored("docs/private\n", ["docs", "private"], { isDir: true }), true);
  assert.equal(ignored("docs/private\n", ["nested", "docs", "private"], { isDir: true }), false, "锚定模式不匹配深层同名");
});

test("trailing slash = directory-only pattern", () => {
  const rules = "build/\n";
  assert.equal(ignored(rules, ["build"], { isDir: true }), true);
  assert.equal(ignored(rules, ["build"], { isDir: false }), false, "同名文件不命中 dirOnly 规则");
  // 祖先目录命中（目录在祖先段按目录处理）→ 内容忽略
  assert.equal(ignored(rules, ["build", "out.txt"]), true);
});

test("globs: * within segment, ? single char, ** across segments", () => {
  assert.equal(ignored("*.log\n", ["a", "app.log"]), true);
  assert.equal(ignored("*.log\n", ["a", "app.log.gz"]), false, "* 不跨 .gz 之外的段");
  assert.equal(ignored("file?.txt\n", ["file1.txt"]), true);
  assert.equal(ignored("file?.txt\n", ["file12.txt"]), false);
  assert.equal(ignored("docs/**/deep.txt\n", ["docs", "a", "b", "deep.txt"]), true);
  assert.equal(ignored("docs/**/deep.txt\n", ["docs", "deep.txt"]), true, "** 允许零段");
  assert.equal(ignored("docs/**/deep.txt\n", ["other", "deep.txt"]), false);
});

test("multiple rules: any hit ignores", () => {
  const text = "*.tmp\nlogs/\n/only-root.txt\n";
  assert.equal(ignored(text, ["x.tmp"]), true);
  assert.equal(ignored(text, ["logs", "a"]), true);
  assert.equal(ignored(text, ["only-root.txt"]), true);
  assert.equal(ignored(text, ["keep.md"]), false);
  assert.equal(ignored(text, ["nested", "only-root.txt"]), false, "/only-root.txt 锚定不命中深层");
});

test("regex metacharacters in patterns are literal", () => {
  assert.equal(ignored("a.b+c.txt\n", ["a.b+c.txt"]), true);
  assert.equal(ignored("a.b+c.txt\n", ["axbxc.txt"]), false);
});
